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
 *   2. **整个进程只尝试一次**。扫描要 1.5~4 秒，若每轮对话都试一次，
 *      用户会反复经历"首句特别慢"。失败后不再重试，把提示交给用户。
 *
 *   3. **失败要说清楚为什么**。四种失败原因对应四种不同处置：
 *      没登录 / 已登录但数据没落盘 / 读到的是过期记录 / 扫描本身出错。
 *      笼统说"请添加 Token"会让用户反复做无用功。
 */

import { findBrowserToken } from './browser-token.js';
import { addToken, listCredentials } from './credentials.js';
import { loadKernel } from './runtime.js';
import { isTokenUsable } from './credential-validate.js';

/** 本进程是否已经尝试过自动获取。 */
let attempted = false;

/**
 * 尝试结果缓存。
 *
 * 为什么缓存：失败原因要用于生成错误提示，而重新扫描一次要 1.5~4 秒。
 * 缓存让后续对话直接复用结论。
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
export async function autoFetchBrowserTokens({ validate = null } = {}) {
  if (attempted) {
    return lastAttempt || { added: 0, reason: 'not-found' };
  }
  attempted = true;

  let result;
  try {
    result = await findBrowserToken({ validate });
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
    count: list.length,
    // 来源取第一个成功入库的凭据——result.browser 只在"只有一个候选"时
    // 才有值，多候选时是空的，用户看到"从 null 获取"毫无意义。
    browser: list[0]?.browser || null,
    profile: list[0]?.profile || null,
  };
  return lastAttempt;
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
 * 供测试用：重置"是否已尝试过"的状态。
 */
export function __resetAutoFetchState() {
  attempted = false;
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
