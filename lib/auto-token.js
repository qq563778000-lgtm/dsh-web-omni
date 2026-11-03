/**
 * 首次对话时的浏览器 Token 自动获取。
 *
 * 场景：用户装完插件，**还没去设置页填 Token** 就直接开始对话。
 * 之前的表现是内核抛 "No tokens available in pool"——一句话，用户既不知道
 * 缺什么，也不知道下一步该做什么。
 *
 * 这里改成：首次对话发现没有可用凭据时，自动去本机浏览器把登录态读出来，
 * 验证通过就入库，然后继续这次对话。用户什么都不用做。
 *
 * 三条设计约束：
 *
 *   1. **只在没有可用凭据时触发**。已配置的用户完全不受影响——
 *      否则浏览器的登录态一变，插件的行为就跟着变，反而不可预期。
 *
 *   2. **失败后冷却期内不重试**。扫描要 1.5~4 秒，若每轮对话都试一次，
 *      用户会反复经历"首句特别慢"。
 *
 *      为什么不能"只试一次"（2026-11-03 真实故障）：用户在浏览器退出
 *      DeepSeek 登录，上游立即作废已入库的 token（40003 Authorization
 *      Failed），凭据被禁用 3 天。下一轮对话"没有可用凭据"成立，但
 *      attempted 标志在首次成功后永久为 true——用户在浏览器重新登录后，
 *      插件永远拿不到新 token，除非重启 DSH。"成功"不是终态：凭据会死。
 *
 *      因此改为按时间冷却：上次尝试在冷却窗口内时直接复用结论；窗口
 *      过了就允许再扫。窗口取 5 分钟——足够挡住"每轮对话都扫一遍"，
 *      又不会让"重新登录后马上说话"的用户等一个进程生命周期。
 *
 *   3. **失败要说清楚为什么**。四种失败原因对应四种不同处置：
 *      没登录 / 已登录但数据没落盘 / 读到的是过期记录 / 扫描本身出错。
 *      笼统说"请添加 Token"会让用户反复做无用功。
 */

import { findBrowserToken } from './browser-token.js';
import { addToken, listCredentials, maskToken, removeCredential } from './credentials.js';
import { loadKernel, readKernelConfig } from './runtime.js';
import { isTokenUsable } from './credential-validate.js';

/**
 * 两次自动获取之间的最小间隔（毫秒）。
 *
 * 5 分钟的取舍：扫描本身 1.5~4 秒（worker 里跑，不卡界面），真正的代价
 * 是验证环节——每个候选要向上游建一次会话（3~4 秒/个，已并发）。若没有
 * 间隔，"没有可用凭据 + 浏览器里也没有登录态"的用户每次发消息都要白等
 * 这一段。5 分钟足够把这种重复消耗挡掉，又不会让刚在浏览器重新登录的
 * 用户等上半天。
 */
export const AUTOFETCH_COOLDOWN_MS = 5 * 60 * 1000;

/** 上次尝试的时刻（0 表示从未尝试）。 */
let lastAttemptAt = 0;

/**
 * 尝试结果缓存。
 *
 * 为什么缓存：失败原因要用于生成错误提示，而重新扫描一次要 1.5~4 秒。
 * 冷却期内的后续对话直接复用结论。
 */
let lastAttempt = null;

/**
 * 当前是否还有可用凭据。
 *
 * 判据用内核的运行时状态（未禁用且有 token），而不是配置文件里的条数——
 * 池里的凭据可能已被上游判定失效并禁用，那种情况下配置里有、实际不可用，
 * 与"完全没配置"对用户是同一件事：发不出请求。
 */
export function hasUsableCredential(kernel) {
  try {
    const alive = kernel.auth.getAliveTokens();
    return Array.isArray(alive) && alive.length > 0;
  } catch {
    // 内核接口不可用时，退回看配置：宁可多试一次，也不要漏掉自动获取。
    return false;
  }
}

/**
 * 从浏览器自动获取并入库 Token。
 *
 * @param {{ validate?: (token: string) => Promise<boolean> }} [options]
 * @returns {Promise<{ added: number, reason?: string, browser?: string,
 *                     tried?: Array, message?: string }>}
 *   added > 0 表示成功入库了凭据；否则 reason 说明失败原因。
 */
export async function autoFetchBrowserTokens({
  validate = null,
  now = Date.now(),
  force = false,
  // 扫描入口可注入：测试用它精确计数，不必真跑 1.5~4 秒的磁盘扫描。
  // 生产路径不传，走默认的 findBrowserToken。
  scan = findBrowserToken,
} = {}) {
  // 冷却期内直接复用上次结论。
  //
  // 注意缓存的是**结论**而不是"成功"：上次失败的 reason 同样在冷却期内
  // 有效——浏览器里没有登录态这个事实不会在两分钟内自己改变，重扫一遍
  // 只是把同样的失败再慢速重放一次。
  //
  // force=true 用于用户显式点击"重新获取"：这时必须跳过冷却立即执行，
  // 否则用户点了却什么都没发生。
  if (!force && lastAttempt && (now - lastAttemptAt) < AUTOFETCH_COOLDOWN_MS) {
    return lastAttempt;
  }
  lastAttemptAt = now;

  let result;
  try {
    result = await scan({ validate });
  } catch (err) {
    lastAttempt = {
      added: 0,
      reason: 'scan-failed',
      message: String(err?.message || err),
    };
    return lastAttempt;
  }

  if (!result.ok) {
    lastAttempt = {
      added: 0,
      reason: result.reason || 'not-found',
      browser: result.browser || null,
      tried: result.tried || [],
    };
    return lastAttempt;
  }

  // 把所有通过验证的 token 都入库（用户可能多个账号都登录过）。
  const list = result.tokens?.length
    ? result.tokens
    : [{ token: result.token, browser: result.browser, profile: result.profile }];

  // 先把**已入库但已失效**的凭据清掉，再入新的。
  //
  // 为什么必须清（2026-11-03 用户要求）：浏览器退出登录后，旧 token 被
  // 上游作废（40003）。它们仍留在配置里，设置页会显示一串失效项，
  // 而且池里的凭据数虚高——用户看到"总数 4、可用 0"却不知道该怎么办。
  //
  // 清掉还有个副作用是好的：旧 token 再次被扫到时（浏览器里还留着那条
  // 记录），addToken 会因"已存在"而跳过；清掉之后它会被当作新凭据重新
  // 入库——而此时它若真的有效（用户重新登录过），正是我们要的。
  const removed = await pruneInvalidCredentials();

  let added = 0;
  for (const item of list) {
    try {
      await addToken({ token: item.token });
      added += 1;
    } catch (err) {
      // "已存在"不算失败——它意味着这条凭据本来就在池里。
      if (!/已存在/.test(String(err?.message || ''))) throw err;
    }
  }

  lastAttempt = {
    added,
    removed,
    count: list.length,
    // 来源取第一个成功入库的凭据——result.browser 只在"只有一个候选"时
    // 才有值，多候选时是空的，用户看到"从 null 获取"毫无意义。
    browser: list[0]?.browser || null,
    profile: list[0]?.profile || null,
  };
  return lastAttempt;
}

/**
 * 清掉已入库但**确认失效**的凭据。
 *
 * 触发时机：自动获取被触发时（也就是池里已经没有可用凭据了）。
 * 这时对每条已配置凭据做一次真实校验，失效的就删掉。
 *
 * 为什么用真实校验而不是看禁用态：内核把 40003 的凭据禁用 3 天，
 * 但那是"保守隔离"——它并不知道这个 token 是否在用户重新登录后恢复。
 * 而我们此刻正要向浏览器要新 token，如果旧的那条其实还能用（比如
 * 只是另一个账号退出了登录），删掉它就是白白丢失一个可用凭据。
 *
 * 代价：每条凭据一次上游会话（3~4 秒），且已并发。凭据通常只有一两条，
 * 且这个函数只在"池里没有可用凭据"时才跑，不影响正常对话路径。
 *
 * @returns {Promise<number>} 删除的条数
 */
export async function pruneInvalidCredentials({ validate = null } = {}) {
  const check = validate || isTokenUsable;
  let removed = 0;

  try {
    const config = await readKernelConfig();
    const tokens = Array.isArray(config.deepseek?.tokens) ? config.deepseek.tokens : [];
    if (!tokens.length) return 0;

    // 并发校验：串行的话两条凭据就要 8 秒。
    const verdicts = await Promise.all(tokens.map(async (token) => {
      try {
        return { token, valid: Boolean(await check(token)) };
      } catch {
        // 校验本身出错（网络问题）时**不删**——宁可留着一条可能有效的
        // 凭据，也不要因为一次网络抖动把用户的登录态清空。
        return { token, valid: true };
      }
    }));

    for (const { token, valid } of verdicts) {
      if (valid) continue;
      try {
        await removeCredential({ kind: 'token', value: maskToken(token) });
        removed += 1;
      } catch {
        // 单条删除失败不影响其它
      }
    }
  } catch {
    // 读配置失败就不清理：不动用户已有的凭据比清理更安全。
  }

  return removed;
}

/**
 * 生成给用户的失败提示。
 *
 * 每种原因对应一种处置，照直说能让用户一次就做对。
 */
export function describeAutoFetchFailure(attempt) {
  switch (attempt?.reason) {
    case 'not-flushed':
      return '浏览器里已登录 DeepSeek，但数据还没落盘。'
        + '把 chat.deepseek.com 那个标签页关掉（Ctrl+W）再重试一次。';
    case 'stale':
      return '浏览器里读到的是已失效的登录记录。请重新登录 chat.deepseek.com，'
        + '关掉该标签页后再试。';
    case 'scan-failed':
      return `读取浏览器登录态时出错：${attempt.message || '未知错误'}。`
        + '可到设置页手动添加 Token。';
    case 'not-found':
    default:
      return '本机浏览器里没有找到 DeepSeek 的登录态。'
        + '请先在浏览器登录 chat.deepseek.com，或到设置页手动添加 Token。';
  }
}

/**
 * 供测试用：重置自动获取的状态。
 */
export function __resetAutoFetchState() {
  lastAttemptAt = 0;
  lastAttempt = null;
}

/**
 * 供路由/适配器查询：是否还有可用凭据。
 *
 * 单独导出而不是让调用方自己判断，是为了把"可用"的定义收在一处——
 * 内核的运行时状态是唯一权威。
 */
export async function hasUsableCredentials() {
  try {
    const kernel = await loadKernel();
    return hasUsableCredential(kernel);
  } catch {
    return false;
  }
}

/** 当前凭据池快照（供错误提示与调试用，不含明文）。 */
export async function credentialSnapshot() {
  try {
    return await listCredentials();
  } catch {
    return { items: [], summary: { total: 0, available: 0, disabled: 0 } };
  }
}
