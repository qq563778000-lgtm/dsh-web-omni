/**
 * 凭据管理
 *
 * 设置页的所有凭据读写都经过这里，目的是把"内核怎么存凭据"与
 * "设置页怎么展示"隔开：内核存明文（它要拿去登录上游），
 * 设置页只能看到掩码。
 *
 * 安全约束：
 *   - 返回值一律经过 maskToken，不把明文送到 UI
 *   - 不使用 console 打印任何凭据
 *   - 删除走内核的 disableToken 语义（可恢复），不物理删除
 */

import {
  readKernelConfig,
  writeKernelConfig,
  loadKernel,
  initializeKernel,
  isolateEnvironment,
  resolveDataDir,
  configure,
} from './runtime.js';

/**
 * 确保数据目录已确定。
 *
 * 设置页可能在插件初始化之前就调用这里（用户一打开设置页就可能保存）。
 * 若此时数据目录还没定，读写会落到默认路径，与后续 initializeKernel
 * 使用的目录不一致 —— 表现为"刚保存的凭据在列表里，但池里没有"。
 */
function ensureDataDir() {
  isolateEnvironment(resolveDataDir(configure({})));
}

/** 掩码：保留前 6 位与后 4 位，与内核日志的截断口径一致。 */
export function maskToken(token) {
  const value = String(token || '');
  if (value.length <= 10) return value ? `${value.slice(0, 2)}***` : '';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/** 从内核配置读取凭据（脱敏）。 */
export async function listCredentials() {
  ensureDataDir();
  const config = await readKernelConfig();
  const deepseek = config.deepseek || {};
  const accounts = Array.isArray(deepseek.accounts) ? deepseek.accounts : [];
  const tokens = Array.isArray(deepseek.tokens) ? deepseek.tokens : [];
  const states = deepseek.credentialStates || {};

  // 运行时状态（禁用/原因/剩余）只有池初始化后才准确；
  // 未就绪时退化为配置里的静态信息，避免设置页报错。
  let runtime = null;
  try {
    const kernel = await loadKernel();
    runtime = kernel.auth.getPoolInfo();
  } catch {
    runtime = null;
  }

  const items = [];

  for (const account of accounts) {
    const email = String(account.email || '');
    const entry = runtime?.find(item => item.email === email);
    items.push({
      id: `account:${email}`,
      kind: 'account',
      label: email || '(未命名账号)',
      hasPassword: Boolean(account.password),
      disabled: entry?.disabled ?? false,
      disabledReason: entry?.disabledReason ?? null,
      disabledRemainingMs: entry?.disabledRemainingMs ?? 0,
      errorCount: entry?.errorCount ?? 0,
      activeRequests: entry?.activeRequests ?? 0,
      visionCapable: entry?.visionCapable ?? null,
    });
  }

  for (const token of tokens) {
    const raw = String(token || '');
    const masked = maskToken(raw);
    const entry = runtime?.find(item => masked.startsWith(item.token.replace('...', '').slice(0, 6)))
      || runtime?.find(item => String(item.token || '').replace('...', '') === raw.slice(0, raw.length));
    items.push({
      id: `token:${masked}`,
      kind: 'token',
      label: masked,
      hasPassword: false,
      disabled: entry?.disabled ?? false,
      disabledReason: entry?.disabledReason ?? null,
      disabledRemainingMs: entry?.disabledRemainingMs ?? 0,
      errorCount: entry?.errorCount ?? 0,
      activeRequests: entry?.activeRequests ?? 0,
      visionCapable: entry?.visionCapable ?? null,
    });
  }

  const disabledCount = items.filter(item => item.disabled).length;
  return {
    items,
    summary: {
      total: items.length,
      available: items.length - disabledCount,
      disabled: disabledCount,
    },
    // 池未初始化时给出提示，避免 UI 把"0 可用"误解为凭据全坏。
    stateCountsKnown: Boolean(runtime),
  };
}

/** 添加账号（邮箱 + 密码），内核会在下一次初始化时登录换取 token。
 *
 * 注意：设置页**不再提供**这个入口（2026-10-30 起）。
 *
 * 原因：上游登录接口被 AWS WAF 拦截，从非浏览器网络直接登录常返回 202
 * 空响应，成功率取决于出口 IP，用户看到的是"填了密码却说登录失败"。
 * 相比"从浏览器复制一个 token"，账号方式既不可靠也更危险（密码落盘）。
 *
 * 保留此函数供脚本化配置使用；界面只走 Token。
 */
export async function addAccount({ email, password }) {
  const address = String(email || '').trim();
  const secret = String(password || '');
  if (!address || !secret) throw new Error('邮箱与密码都必须填写');

  ensureDataDir();
  const config = await readKernelConfig();
  const deepseek = { ...(config.deepseek || {}) };
  const accounts = Array.isArray(deepseek.accounts) ? [...deepseek.accounts] : [];

  if (accounts.some(item => String(item.email || '') === address)) {
    throw new Error(`账号 ${address} 已存在`);
  }
  accounts.push({ email: address, password: secret });
  deepseek.accounts = accounts;

  await writeKernelConfig({ ...config, deepseek });
  await reloadKernel();
  return { ok: true };
}

/**
 * 清洗用户粘贴的 token。
 *
 * 用户复制 token 时几乎总会带上包装：从 DevTools 复制的是
 * `"eyJhbGci…"`（带引号），从 Network 面板复制的可能是
 * `Bearer eyJhbGci…`，从某些工具复制会带换行。这些都不是 token 本身，
 * 直接存进去会被上游判为无效，而错误信息只会说"token 无效"，用户很难
 * 想到是自己多复制了几个字符。
 *
 * 这里做保守清洗：去掉首尾空白、引号、Bearer 前缀与换行。
 */
function normalizeTokenInput(raw) {
  let value = String(raw ?? '').trim();
  // 去掉成对的引号（"…" / '…' / `…`）
  value = value.replace(/^["'`]|["'`]$/g, '').trim();
  // 去掉 Bearer 前缀（大小写不敏感）
  value = value.replace(/^bearer\s+/i, '').trim();
  // 去掉中间混入的换行与制表符
  value = value.replace(/[\r\n\t]+/g, '');
  return value.trim();
}

/** 添加 token（直接给上游 token）。 */
export async function addToken({ token }) {
  const value = normalizeTokenInput(token);
  if (!value) throw new Error('Token 不能为空');

  ensureDataDir();
  const config = await readKernelConfig();
  const deepseek = { ...(config.deepseek || {}) };
  const tokens = Array.isArray(deepseek.tokens) ? [...deepseek.tokens] : [];

  if (tokens.includes(value)) throw new Error('该 Token 已存在');
  tokens.push(value);
  deepseek.tokens = tokens;

  await writeKernelConfig({ ...config, deepseek });
  await reloadKernel();
  return { ok: true };
}

/**
 * 移除凭据。
 *
 * 账号与 token 都从配置里删掉；运行中的池条目由内核在重新同步时移除。
 * 这里不做"禁用"，因为这是用户在设置页主动删除，语义与自动风控禁用不同。
 */
export async function removeCredential({ kind, value }) {
  ensureDataDir();
  const config = await readKernelConfig();
  const deepseek = { ...(config.deepseek || {}) };

  if (kind === 'account') {
    const accounts = (deepseek.accounts || []).filter(item => String(item.email || '') !== String(value));
    deepseek.accounts = accounts;
  } else {
    const tokens = (deepseek.tokens || []).filter(item => maskToken(item) !== String(value));
    deepseek.tokens = tokens;
  }

  await writeKernelConfig({ ...config, deepseek });
  await reloadKernel();
  return { ok: true };
}

/** 测试全部凭据有效性（逐个打上游）。 */
export async function testAllCredentials() {
  ensureDataDir();
  const kernel = await loadKernel();
  const config = await readKernelConfig();
  const deepseek = config.deepseek || {};
  const results = [];

  for (const token of deepseek.tokens || []) {
    try {
      const result = await kernel.auth.testDeepSeekToken(String(token));
      results.push({
        kind: 'token',
        label: maskToken(token),
        valid: Boolean(result?.valid),
        visionCapable: result?.visionCapable ?? null,
      });
    } catch (err) {
      results.push({ kind: 'token', label: maskToken(token), valid: false, error: String(err?.message || err) });
    }
  }

  for (const account of deepseek.accounts || []) {
    const email = String(account.email || '');
    try {
      // 账号型凭据当前 token 可能在池里；没有就返回"待登录"。
      const info = kernel.auth.getPoolInfo().find(item => item.email === email);
      if (!info?.token) {
        results.push({ kind: 'account', label: email, valid: false, error: '尚未登录（下次初始化时自动登录）' });
        continue;
      }
      const result = await kernel.auth.testDeepSeekToken(info.token.replace('...', ''));
      results.push({
        kind: 'account',
        label: email,
        valid: Boolean(result?.valid),
        visionCapable: result?.visionCapable ?? null,
      });
    } catch (err) {
      results.push({ kind: 'account', label: email, valid: false, error: String(err?.message || err) });
    }
  }

  return { results, tested: results.length };
}

/**
 * 重新初始化内核，使设置页的改动立即生效。
 *
 * 内核的 initTokenPool 是幂等的（会把新配置同步进池），因此不需要
 * 重启 DSH——这正是"改完就能用"的关键。
 */
async function reloadKernel() {
  const kernel = await loadKernel();
  try {
    kernel.configStore.loadConfig({ force: true });
    kernel.configStore.applyConfigToProcessEnv();
    kernel.auth.syncTokenPoolFromConfig();
    await kernel.auth.initTokenPool();
  } catch {
    // 登录失败不应让设置页保存失败：配置已落盘，下次启动会重试。
  }
}

export { initializeKernel };
