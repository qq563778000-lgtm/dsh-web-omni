import { loadEnvironment } from '../utils/env.js';
import { clearCredentialState, getConfig, secretId, setCredentialState, updateChannelConfig } from './config-store.js';
import { recordUpstreamEvent } from '../middleware/logger.js';
import { invalidateByTokenPrefix } from './conversation.js';
import { invalidateTokenSessions as invalidateSessionCache } from './session.js';

loadEnvironment();

const BASE_URL = 'https://chat.deepseek.com';

function maxConcurrentPerToken() {
  return getConfig().deepseek.maxConcurrentPerToken;
}

function tokenDeadThreshold() {
  return getConfig().deepseek.tokenDeadThreshold;
}

// Multi-token support: DS_TOKENS=token1,token2,token3 (comma-separated)
// Fallback: DS_TOKEN=single_token
// Account support: DS_ACCOUNTS=email1:pass1,email2:pass2 (auto-login to refresh tokens)
export function loadTokens() {
  const tokensStr = process.env.DS_TOKENS?.trim();
  if (tokensStr) {
    return tokensStr.split(',').map(t => t.trim()).filter(Boolean);
  }
  const single = process.env.DS_TOKEN?.trim();
  if (single) return [single];
  return [];
}

export function loadAccounts() {
  const accountsStr = process.env.DS_ACCOUNTS?.trim();
  if (!accountsStr) return [];
  return accountsStr.split(',').map(entry => {
    const [email, ...passParts] = entry.trim().split(':');
    const password = passParts.join(':');
    return email && password ? { email, password } : null;
  }).filter(Boolean);
}

const tokens = loadTokens();
const accounts = loadAccounts();

function generateDeviceId() {
  const bytes = new Uint8Array(48);
  for (let i = 0; i < 48; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Buffer.from(bytes).toString('base64').replace(/=/g, '') + '==';
}

// DS_ACCOUNTS_EXTENDED=email:password:token_prefix — links existing tokens to accounts
function loadAccountTokens() {
  const extStr = process.env.DS_ACCOUNTS_EXTENDED?.trim();
  if (!extStr) return [];
  return extStr.split(',').map(entry => {
    const [email, ...rest] = entry.trim().split(':');
    if (rest.length >= 2) {
      const tokenPrefix = rest.pop();
      const password = rest.join(':');
      return email && password && tokenPrefix ? { email, password, tokenPrefix } : null;
    }
    return null;
  }).filter(Boolean);
}

const accountTokenMap = loadAccountTokens();

// Token metadata: { token, email, password, visionCapable, lastUsed, errorCount,
//                   activeRequests, cooldownUntil, rateLimitHits, disabled, ... }
//
// 三态区分（务必不要混淆）：
//   - 可用：正常参与分配
//   - cooldownUntil（临时限流）：仍是"可用凭据"，只是这段时间不参与分配，
//     到期自动恢复，不上报 429 之外的语义。见 reportTokenRateLimited。
//   - disabled（禁用）：终态失败（封禁/禁言/token 失效/连续错误超阈值）。
//     不参与分配，且**保留在池中并持久化**，便于后台展示与到期恢复。
//     以前这里是直接删除条目，导致风控结束后无法恢复、后台也看不到。
const tokenPool = tokens.map(t => ({
  token: t,
  email: null,
  password: null,
  visionCapable: null,
  lastUsed: 0,
  errorCount: 0,
  activeRequests: 0,
  cooldownUntil: 0,
  rateLimitHits: 0,
  ...emptyDisabledState(),
}));

// Link existing tokens to accounts via token prefix
for (const entry of tokenPool) {
  if (!entry.token) continue;
  const prefix = entry.token.slice(0, 12);
  const match = accountTokenMap.find(a => a.tokenPrefix === prefix);
  if (match) {
    entry.email = match.email;
    entry.password = match.password;
  }
}

// 禁用态的默认（未禁用）字段组。集中一处避免各构造点漏字段。
function emptyDisabledState() {
  return {
    disabled: false,
    disabledReason: null,
    disabledUntil: 0,
    disabledAt: 0,
    disabledSource: null,
  };
}

/**
 * 凭据的稳定身份，用于与 config.json 的 credentialStates / 前端行 id 对齐。
 *
 * 与 config-store 的 publicSecrets / publicAccounts 保持同一算法：
 * 有账号密码按 `email:password`，否则按 token 本体。
 */
export function credentialIdOf(entry) {
  if (!entry) return null;
  if (entry.email && entry.password) return secretId(`${entry.email}:${entry.password}`);
  if (entry.token) return secretId(entry.token);
  return null;
}

// Create pool entries for accounts without matching tokens (will login on init)
for (const acct of accounts) {
  const alreadyLinked = tokenPool.some(t => t.email === acct.email);
  if (!alreadyLinked) {
    tokenPool.push({
      token: null,
      email: acct.email,
      password: acct.password,
      visionCapable: null,
      lastUsed: 0,
      errorCount: 0,
      activeRequests: 0,
      cooldownUntil: 0,
      rateLimitHits: 0,
      ...emptyDisabledState(),
    });
  }
}

function createTokenEntry({ token = null, email = null, password = null, visionCapable = null } = {}) {
  return {
    token,
    email,
    password,
    visionCapable,
    lastUsed: 0,
    errorCount: 0,
    activeRequests: 0,
    ...emptyDisabledState(),
    // 限流冷却：cooldownUntil 为绝对时间戳（0 = 可用）
    cooldownUntil: 0,
    rateLimitHits: 0,
  };
}

export function syncTokenPoolFromConfig() {
  const { deepseek } = getConfig();
  const previous = new Map(tokenPool.filter(entry => entry.token).map(entry => [entry.token, entry]));
  tokenPool.splice(0, tokenPool.length);

  for (const token of deepseek.tokens) {
    const prior = previous.get(token);
    tokenPool.push(prior ? { ...prior, activeRequests: 0 } : createTokenEntry({ token }));
  }

  for (const account of deepseek.accounts) {
    const alreadyLinked = tokenPool.some(entry => entry.email === account.email);
    if (!alreadyLinked) {
      tokenPool.push(createTokenEntry({ email: account.email, password: account.password }));
    }
  }

  // 从持久化的 credentialStates 回填禁用态。
  //
  // 放在这里而不是 initTokenPool：admin 增删凭据后走 applyChannelRuntime →
  // syncTokenPoolFromConfig 重建池，若不在此回填，禁用态会在一次后台操作后丢失。
  applyPersistedCredentialStates(deepseek.credentialStates || {});
}

/** 把 config 里的禁用态套用到当前池条目上。 */
function applyPersistedCredentialStates(states = {}) {
  for (const entry of tokenPool) {
    const id = credentialIdOf(entry);
    const state = id ? states[id] : null;
    if (state?.disabled) {
      entry.disabled = true;
      entry.disabledReason = state.reason || entry.disabledReason || '已禁用';
      entry.disabledUntil = state.until || 0;
      entry.disabledAt = state.at || 0;
      entry.disabledSource = state.source || 'auto';
    } else {
      Object.assign(entry, emptyDisabledState());
    }
  }
}

import { loginHeaders, getHeaders, getDeviceIdForToken, proxiedFetch } from '../utils/headers.js';

async function login(email, password) {
  // Use a fresh deviceId for login — real browser gets it from portal101.cn device fingerprint
  const loginDeviceId = 'B' + generateDeviceId();

  const res = await proxiedFetch(`${BASE_URL}/api/v0/users/login`, {
    method: 'POST',
    headers: loginHeaders(),
    body: JSON.stringify({ email, mobile: '', password, area_code: '', device_id: loginDeviceId, os: 'web' }),
  });

  // AWS WAF returns 202 with empty body — can't login from this IP
  if (res.status === 202) {
    throw new Error(
      `WAF challenge (202) — DeepSeek 登录被防火墙拦截。\n`
      + `请通过浏览器登录 chat.deepseek.com，从浏览器开发者工具 Application → Local Storage 或 Network 请求中获取 token，`
      + `然后 ① 配置到 DS_TOKENS 环境变量 或 ② 在后台"上游凭据"页面以 Token 方式添加 DeepSeek 凭据。\n`
      + `如果必须使用账号自动登录，可尝试设置 HTTPS_PROXY 更换出口 IP。`
    );
  }

  const text = await res.text();
  if (!text) throw new Error('Empty response from login endpoint');

  const json = JSON.parse(text);
  if (json.code !== 0) {
    console.warn(`[DeepSeek] Login failed for ${email}: code=${json.code} msg=${json.msg || 'no msg'} body=${text.slice(0, 400)}`);
    throw new Error(`Login failed for ${email}: ${json.msg || JSON.stringify(json)}`);
  }

  const bizCode = json.data?.biz_code;
  if (bizCode === 10) {
    throw new Error(`Account banned: ${email}`);
  }
  if (bizCode === 11) {
    throw new Error(`Account requires verification: ${email}`);
  }

  // DeepSeek 的 token 可能是多种格式：JWT（eyJ...）、sk-、纯 hex 等。
  // 优先从已知路径提取，如果都不命中则遍历整个 JSON 搜索 token-like 字符串。
  const token =
    json.data?.biz_data?.user?.token
    || json.data?.biz_data?.token
    || json.data?.token
    || json.data?.user?.token;

  if (!token) {
    // Fallback: deep-scan the entire parsed response for a plausible bearer token.
    // This handles upstream API response-format changes without code changes.
    const jsonStr = JSON.stringify(json);
    // Try common alternative field names
    const tokenCandidates = [
      json.data?.biz_data?.user,
      json.data?.biz_data?.access_token,
      json.data?.biz_data?.session_token,
      json.data?.biz_data?.jwt,
      json.data?.user_id,
      json.data?.biz_data?.token,
      // Some responses put user/token at root level
      typeof json.data === 'string' ? json.data : null,
      typeof json.data?.user === 'string' ? json.data.user : null,
    ];
    const found = tokenCandidates.find(c => c && typeof c === 'string' && c.length > 20);
    if (found) {
      console.log(`[DeepSeek] Login token extracted via alternate field for ${email}`);
      return found;
    }
    // Last resort: try multiple regex patterns to find any token-like value in the response.
    // Patterns cover: JWT (with dots), sk- prefixed tokens, base64, hex strings.
    const regexes = [
      /"(?:sk-|)[A-Za-z0-9_.-]{36,}"/,        // JWT and sk- tokens (quoted)
      /"(?:(?:sk-)?[A-Za-z0-9+/]{40,}(?:=|))"/, // base64 with possible padding
      /"(?:sk-|)[A-Za-z0-9_-]{36,}"/,           // alphanumeric only (no dots)
    ];
    for (const re of regexes) {
      const m2 = jsonStr.match(re);
      if (m2) {
        console.log(`[DeepSeek] Login token extracted via regex (${re.source}) for ${email}`);
        return m2[0].replace(/"/g, '');
      }
    }
    const responseSample = jsonStr.slice(0, 600);
    console.warn(`[DeepSeek] Login response for ${email}: sample=${responseSample}`);
    throw new Error(`Login succeeded but no token found in response. Check server logs for response structure.`);
  }
  return token;
}

async function checkVisionCapability(token) {
  try {
    // did 必须按 token 派生：传进程级共享值会让上游把整池账号识别为同一设备，
    // 这在风控视角下是明确的关联信号（详见 headers.js 的说明）。
    const res = await proxiedFetch(`${BASE_URL}/api/v0/client/settings?did=${getDeviceIdForToken(token)}&scope=model`, {
      headers: await getHeaders(token),
    });
    const json = await res.json();
    const configs = json.data?.biz_data?.settings?.model_configs?.value || [];
    const visionConfig = configs.find(c => c.model_type === 'vision');
    if (visionConfig) {
      return visionConfig.switchable === true;
    }
    return false;
  } catch {
    return null;
  }
}

// Check if a token is still valid — uses /users/current which actually validates the token
// (unlike /client/settings which returns code:0 even for invalid tokens)
async function validateToken(token) {
  try {
    const res = await proxiedFetch(`${BASE_URL}/api/v0/users/current`, {
      headers: await getHeaders(token),
    });
    const json = await res.json();
    return json.code === 0;
  } catch {
    return false;
  }
}

/**
 * 重新登录换取新 token（仅账号型条目可用）。
 *
 * force=false（默认）时**禁用中的条目直接跳过**：风控期内反复登录会使旧 token
 * 失效、并要求上游重新校验账号，只会加重风控。只有"禁用期已到"的恢复探测
 * （healthCheck）与管理员手动启用才会传 force=true。
 */
async function refreshToken(entry, { force = false } = {}) {
  if (!entry.password) return false;
  if (entry.disabled && !force) return false;
  try {
    const newToken = await login(entry.email, entry.password);
    entry.token = newToken;
    entry.errorCount = 0;
    const vision = await checkVisionCapability(newToken);
    entry.visionCapable = vision;
    console.log(`  Refreshed token for ${entry.email}: ${newToken.slice(0, 12)}... vision=${vision}`);
    return true;
  } catch (err) {
    console.warn(`  Refresh failed for ${entry.email}: ${err.message}`);
    // 这里是"恢复探测"失败：不在此处判定禁用（由调用方决定是否顺延冷却）。
    return false;
  }
}

/**
 * 把池中「无归属」的 token 归到对应账号名下，避免同一账号重复占用池位。
 *
 * 背景：config.json 可以同时存有 tokens 与 accounts。同步时 tokens 先建成
 * 无 email 的条目，accounts 再建成无 token 的条目，两者各占一个池位；
 * 启动时账号登录又会产出新 token，于是同一账号出现两条（旧 token + 新
 * token），旧的那条必然报错，既浪费并发额度也让池统计虚高。
 *
 * 做法：登录前先向 /users/current 查证每个无归属 token 的真实邮箱，
 * 若能对应到某个尚未持有 token 的账号，就把 token 并到该账号条目上并
 * 删掉多余条目。查不到归属的 token 保持原样（宁可留着也不误删）。
 *
 * 返回被合并掉的条目数。
 */
async function linkUnownedTokensToAccounts() {
  let merged = 0;
  // 倒序遍历：合并过程中会删除条目，避免索引错位。
  for (let i = tokenPool.length - 1; i >= 0; i--) {
    const tokenEntry = tokenPool[i];
    if (!tokenEntry.token || tokenEntry.email) continue;

    let owner = null;
    try {
      const res = await proxiedFetch(`${BASE_URL}/api/v0/users/current`, {
        headers: await getHeaders(tokenEntry.token),
      });
      const json = await res.json();
      if (json.code === 0 && json.data?.biz_code === 0) {
        owner = json.data?.biz_data?.email || null;
      }
    } catch { /* 网络异常：保持原样，不误删 */ }

    if (!owner) continue;

    const accountEntry = tokenPool.find(
      t => t !== tokenEntry && t.email && t.email === owner && !t.token,
    );
    if (accountEntry) {
      // 账号条目接管该 token 及其元数据，多余的 token 条目移除。
      accountEntry.token = tokenEntry.token;
      accountEntry.visionCapable = tokenEntry.visionCapable;
      accountEntry.errorCount = tokenEntry.errorCount;
      tokenPool.splice(i, 1);
      merged++;
      console.log(`  Linked existing token ${tokenEntry.token.slice(0, 12)}... to ${owner}`);
    } else {
      // 没有对应账号条目：至少记下归属，让它不再是"孤儿"。
      tokenEntry.email = owner;
    }
  }
  return merged;
}

export async function initTokenPool() {
  syncTokenPoolFromConfig();
  const config = getConfig().deepseek;
  console.log(`Token pool: ${tokenPool.length} entries (${config.tokens.length} tokens + ${config.accounts.length} accounts), max ${maxConcurrentPerToken()} concurrent each`);
  if (config.tokens.length === 0 && config.accounts.length === 0) {
    console.warn('No DeepSeek credentials configured; requests will fail until configured from the admin UI or config file.');
  }

  // 先把池中无归属的 token 归到对应账号，再决定哪些账号需要登录。
  // 顺序很关键：若先登录，账号会各自换出新 token，与旧 token 并列为两条，
  // 造成同一账号重复占用池位（实测 9 个账号出现 17 条池记录）。
  const merged = await linkUnownedTokensToAccounts();
  if (merged > 0) {
    console.log(`  Deduplicated ${merged} token(s) already linked to accounts`);
  }

  // Always log in accounts that have no token yet — startup must produce usable tokens.
  // 禁用中的账号跳过登录（风控期内重登会加重处罚），其禁用态由
  // syncTokenPoolFromConfig 从 credentialStates 回填，等 healthCheck 到期探测。
  for (const entry of tokenPool) {
    if (entry.token || !entry.password) continue;
    if (entry.disabled) {
      console.log(`  Skipping login for ${entry.email}: disabled (${entry.disabledReason || 'unknown'})`);
      continue;
    }
    console.log(`  Logging in ${entry.email}...`);
    const ok = await refreshToken(entry);
    if (!ok) {
      // 不再删除条目——禁用后保留，便于后台可见、风控结束后恢复。
      disableToken(entry, { reason: '账号登录失败', source: 'auto' });
      console.log(`  Disabled account entry for ${entry.email} (login failed); kept in pool for recovery`);
    }
  }

  // Remove stale entries that have neither token nor password (shouldn't happen but guard).
  for (let i = tokenPool.length - 1; i >= 0; i--) {
    if (!tokenPool[i].token && !tokenPool[i].password) {
      console.log(`  Removing stale NONE entry at index ${i}`);
      tokenPool.splice(i, 1);
    }
  }

  if (!config.validateOnStartup) {
    console.log('DeepSeek startup validation skipped; accounts already logged in above. Use the admin test button to validate individual tokens.');
    for (const entry of tokenPool) {
      if (entry.token && !entry.disabled) {
        const vision = await checkVisionCapability(entry.token);
        entry.visionCapable = vision;
      }
    }
    logPoolReady();
    return;
  }

  // Validate existing tokens, disable failed ones (auto-refresh if account linked)
  for (const entry of tokenPool) {
    if (entry.token && !entry.disabled) {
      const valid = await validateToken(entry.token);
      if (!valid) {
        console.log(`  ${entry.token.slice(0, 12)}... INVALID — ${entry.password ? 'attempting refresh' : 'no account to refresh'}`);
        if (entry.password) {
          const ok = await refreshToken(entry);
          if (ok) {
            const dupIdx = tokenPool.findIndex(t => t !== entry && t.email === entry.email && !t.token);
            if (dupIdx !== -1) {
              console.log(`  Removing duplicate account entry for ${entry.email}`);
              tokenPool.splice(dupIdx, 1);
            }
          }
        } else {
          // 无账号可重登：禁用而非删除，保留凭据等人工处理。
          disableToken(entry, { reason: 'Token 无效（启动校验）', source: 'auto' });
        }
      }
    }
  }

  for (const entry of tokenPool) {
    if (entry.token && !entry.disabled) {
      const vision = await checkVisionCapability(entry.token);
      entry.visionCapable = vision;
      const label = vision === true ? 'vision=YES' : vision === false ? 'vision=NO' : 'vision=UNKNOWN';
      console.log(`  ${entry.token.slice(0, 12)}... ${label} ${entry.email ? `(${entry.email})` : ''}`);
    }
  }

  logPoolReady();
  persistTokensToConfig();
}

/** 统一输出池状态：可用 / 总数，并单独提示禁用数便于排查。 */
function logPoolReady() {
  const alive = tokenPool.filter(t => !t.disabled && t.token).length;
  const disabled = tokenPool.filter(t => t.disabled).length;
  console.log(`Pool ready: ${alive}/${tokenPool.length} tokens alive${disabled ? ` (${disabled} disabled)` : ''}`);
}

export function acquireToken(preferVision = false) {
  const now = Date.now();
  // 冷却/禁用中的 token 不参与分配。冷却到期自动恢复可用（无需外部清理）。
  const liveCandidates = tokenPool.filter(t =>
    !t.disabled
    && t.token
    && t.activeRequests < maxConcurrentPerToken()
    && (t.cooldownUntil || 0) <= now,
  );
  if (liveCandidates.length === 0) return null;

  let candidates = liveCandidates;
  if (preferVision) {
    const visionTokens = liveCandidates.filter(t => t.visionCapable === true);
    if (visionTokens.length > 0) candidates = visionTokens;
  } else {
    const nonVisionTokens = liveCandidates.filter(t => t.visionCapable !== true);
    if (nonVisionTokens.length > 0) candidates = nonVisionTokens;
  }
  // If the preferred subset is empty, fall back to liveCandidates (don't block
  // a vision request when only non-vision tokens are free, and vice versa).

  // 先按并发数（负载）排序；并发相同的按 lastUsed 升序轮转（最近最少使用优先）。
  // 只按 activeRequests 排会在并发未打满时永远选中数组第一个凭据，使多凭据
  // 退化为"只用第一个"——第一个被限流时整个服务受影响。加入 lastUsed 轮转后，
  // 请求会均匀分散到各凭据，既降低单凭据被限流的概率，也让限流影响面更小。
  candidates.sort((a, b) =>
    (a.activeRequests - b.activeRequests) || ((a.lastUsed || 0) - (b.lastUsed || 0)),
  );
  const chosen = candidates[0];
  chosen.activeRequests++;
  chosen.lastUsed = Date.now();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    chosen.activeRequests = Math.max(0, chosen.activeRequests - 1);
  };

  return { token: chosen.token, account: chosen, release };
}

export function reportTokenError(token) {
  const entry = tokenPool.find(t => t.token === token);
  if (!entry) return;
  entry.errorCount++;

  if (entry.errorCount >= tokenDeadThreshold()) {
    disableToken(entry, {
      reason: `连续错误达阈值（${entry.errorCount}）`,
      disabledUntil: Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS,
      source: 'auto',
    });
  }
}

/**
 * 禁用期限（毫秒）。
 *
 * 默认 3 天：实测上游风控禁言即约 3 天。上游若在响应里给出 mute_until 则优先
 * 采用该时刻（见 sse.js），否则回落到这个默认值，避免在风控期内反复无效探测
 * 而加重处罚。
 */
export const CREDENTIAL_DISABLE_DEFAULT_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * 禁用一个凭据（终态失败：封禁/禁言/token 失效/连续错误超阈值）。
 *
 * 与 reportTokenRateLimited 的区别：限流是**临时**状态，用冷却窗口即可，
 * 到期自动恢复、语义上仍是"可用凭据"。禁用则是**终态**，凭据退出调度但
 * 保留在池中并持久化：后台可见、到期可探测恢复、也可人工启用。
 *
 * 以前这里是直接删除条目，导致风控结束后永久丢失且后台毫无痕迹。
 *
 * @param {string|object} tokenOrEntry
 * @param {{ reason?: string, disabledUntil?: number, source?: 'auto'|'manual' }} options
 *   disabledUntil 为绝对时间戳；省略或 0 表示手动禁用（不自动恢复）。
 */
export function disableToken(tokenOrEntry, { reason = '', disabledUntil = 0, source = 'auto', detail = null, eventType = 'credential_disabled' } = {}) {
  const entry = typeof tokenOrEntry === 'string'
    ? tokenPool.find(t => t.token === tokenOrEntry)
    : tokenOrEntry;
  if (!entry || entry.disabled) return false;

  entry.disabled = true;
  entry.disabledReason = reason || '已禁用';
  entry.disabledUntil = Number.isFinite(disabledUntil) && disabledUntil > 0 ? disabledUntil : 0;
  entry.disabledAt = Date.now();
  entry.disabledSource = source === 'manual' ? 'manual' : 'auto';

  const id = credentialIdOf(entry);
  if (id) {
    try {
      setCredentialState('deepseek', id, {
        disabled: true,
        reason: entry.disabledReason,
        until: entry.disabledUntil,
        at: entry.disabledAt,
        source: entry.disabledSource,
      });
    } catch (err) {
      console.warn(`[DeepSeek] 持久化禁用态失败（${id}）：${err.message}`);
    }
  }

  const label = entry.email || (entry.token ? `${entry.token.slice(0, 12)}...` : id || 'unknown');
  const untilText = entry.disabledUntil
    ? `，约 ${Math.ceil((entry.disabledUntil - Date.now()) / 3600000)} 小时后自动探测恢复`
    : '（手动禁用，不自动恢复）';
  console.warn(`[DeepSeek] 凭据 ${label} 已禁用：${entry.disabledReason}${untilText}`);

  // 落盘存档：console.warn 会随容器重启丢失，而风控类事件恰恰是事后
  // 归因时最需要的证据（"那一刻上游到底返回了什么"）。
  recordUpstreamEvent({
    type: eventType,
    token: entry.token,
    email: entry.email,
    detail: {
      reason: entry.disabledReason,
      source: entry.disabledSource,
      until: entry.disabledUntil || null,
      ...(detail ? { upstream: detail } : {}),
    },
  });
  return true;
}

/** 解除禁用并立即恢复为可用（人工启用，或到期探测成功后调用）。 */
export function enableToken(tokenOrEntry) {
  const entry = typeof tokenOrEntry === 'string'
    ? tokenPool.find(t => t.token === tokenOrEntry)
    : tokenOrEntry;
  if (!entry) return false;

  Object.assign(entry, emptyDisabledState());
  entry.errorCount = 0;

  const id = credentialIdOf(entry);
  if (id) {
    try {
      clearCredentialState('deepseek', id);
    } catch (err) {
      console.warn(`[DeepSeek] 清除禁用态失败（${id}）：${err.message}`);
    }
  }
  const label = entry.email || (entry.token ? `${entry.token.slice(0, 12)}...` : 'unknown');
  console.log(`[DeepSeek] 凭据 ${label} 已启用`);
  return true;
}

// 限流冷却基础时长（秒）。命中后 token 暂时退出分配，到期自动恢复；
// 连续命中则按次数递增（指数退避，上限 1 小时），避免持续撞限流。
const RATE_LIMIT_BASE_COOLDOWN_SECONDS = 60;
const RATE_LIMIT_MAX_COOLDOWN_SECONDS = 3600;

/**
 * 上报一次限流命中（HTTP 429 / 上游限流语义）。
 *
 * 与 reportTokenError 的区别：限流是**临时**状态，不应累计成"死 token"，
 * 否则短暂限流会把好凭据永久剔除。这里改为设置冷却窗口——冷却期内该
 * token 不参与分配，其他凭据接管；到期自动恢复。
 */
export function reportTokenRateLimited(token, detail = null) {
  const entry = tokenPool.find(t => t.token === token);
  if (!entry) return { cooldownSeconds: 0 };
  entry.rateLimitHits = (entry.rateLimitHits || 0) + 1;
  const cooldownSeconds = Math.min(
    RATE_LIMIT_BASE_COOLDOWN_SECONDS * 2 ** (entry.rateLimitHits - 1),
    RATE_LIMIT_MAX_COOLDOWN_SECONDS,
  );
  entry.cooldownUntil = Date.now() + cooldownSeconds * 1000;
  console.warn(
    `[DeepSeek] Token ${String(entry.token).slice(0, 12)}... 命中限流，冷却 ${cooldownSeconds}s `
    + `(第 ${entry.rateLimitHits} 次)`,
  );
  // 限流是风控的早期信号：连续命中往往先于封禁/禁言出现。落盘后可据此
  // 回溯"什么时候开始不对劲"，这是 console 日志给不了的。
  recordUpstreamEvent({
    type: 'rate_limited',
    token: entry.token,
    email: entry.email,
    detail: {
      cooldownSeconds,
      hitCount: entry.rateLimitHits,
      ...(detail ? { upstream: detail } : {}),
    },
  });
  return { cooldownSeconds, rateLimitHits: entry.rateLimitHits };
}

/** 上报一次成功，清除限流冷却与计数。 */
export function clearTokenRateLimit(token) {
  const entry = tokenPool.find(t => t.token === token);
  if (!entry) return;
  entry.rateLimitHits = 0;
  entry.cooldownUntil = 0;
}

// ============================================================
// IP 级限流追踪
//
// 实测（2026-09-14）：连续长内容生成累计约 1.8MB 后，上游对「出口 IP」
// 限流，表现为 HTTP 200 + 281 字节空流（仅 role 与 finish_reason），
// 无任何错误码。对照实验证实与账号/凭据/会话无关——3 个不同账号的凭据
// 同时被限制，等待 14 分钟仍未恢复。
//
// 因此凭据轮换无法规避，继续重试只会加重限流。这里按「短窗口内连续
// 多次空流」判定为 IP 级限制，进入全局冷却：期间快速失败并明确报 429，
// 让客户端自行退避，而不是反复无效打上游。
//
// 判据只数「连续空流次数」而不要求「不同凭据」：单一凭据场景同样会遭遇
// IP 限流，若强制要求不同凭据则永远无法识别（实测池中只配一个凭据时
// 即是如此）。成功一次即清零，因此正常波动不会误判。
// ============================================================

// 触发判定所需的连续空流次数。单次空流可由续写恢复；连续 3 次说明
// 并非偶发，而是上游整体不可用（IP 限流或上游故障）。
const IP_THROTTLE_EMPTY_THRESHOLD = 3;
// 观测窗口：超过该时长的历史空流不再计入（避免跨时段误累计）。
const IP_THROTTLE_WINDOW_MS = 5 * 60 * 1000;
// 冷却时长。实测 14 分钟未恢复，故取较保守值。
const IP_THROTTLE_COOLDOWN_MS = 15 * 60 * 1000;

/** @type {number[]} 最近若干次空流的时间戳 */
let recentEmptyReplies = [];
let ipThrottledUntil = 0;

/**
 * 记录一次「上游返回空流」。短窗口内连续多次则判定为 IP 级限流
 * 并开启全局冷却（期间请求快速失败，不再打上游）。
 */
export function noteEmptyReply() {
  const now = Date.now();
  recentEmptyReplies = recentEmptyReplies.filter(at => now - at <= IP_THROTTLE_WINDOW_MS);
  recentEmptyReplies.push(now);

  if (recentEmptyReplies.length >= IP_THROTTLE_EMPTY_THRESHOLD && !isIpThrottled()) {
    ipThrottledUntil = now + IP_THROTTLE_COOLDOWN_MS;
    console.warn(
      `[DeepSeek] 连续 ${recentEmptyReplies.length} 次空回复 → 判定为 IP 级限流，`
      + `全局冷却 ${Math.round(IP_THROTTLE_COOLDOWN_MS / 60000)} 分钟。`
      + `（该限制与账号凭据无关，换凭据无效；如需立即恢复请更换出口 IP，或等待冷却结束）`,
    );
  }
}

/** 记录一次成功响应：清除 IP 限流状态与空流计数。 */
export function noteSuccessfulReply() {
  recentEmptyReplies = [];
  if (ipThrottledUntil) {
    console.log('[DeepSeek] 上游已恢复，清除 IP 限流冷却');
    ipThrottledUntil = 0;
  }
}

export function isIpThrottled() {
  return Date.now() < ipThrottledUntil;
}

export function getIpThrottleRemainingMs() {
  return Math.max(0, ipThrottledUntil - Date.now());
}

/** 仅供测试与人工干预使用。 */
export function resetIpThrottleState() {
  recentEmptyReplies = [];
  ipThrottledUntil = 0;
}

/**
 * 兼容封装：强制禁用某凭据，忽略其当前 errorCount。
 *
 * 历史用法是"上游明确封禁/禁言时立即置死"（biz_code=5、40004）。现在语义
 * 统一为禁用（见 disableToken），不再删除、也不再立刻重登（风控期内重登
 * 会加重处罚）。新代码请直接调 disableToken 以便带上准确 reason 与 mute_until。
 *
 * 这里用 source:'auto' + 默认期限而非 manual：万一有遗漏的调用点，auto 能
 * 自行到期恢复，而 manual 会永久停用，与本次修复的初衷相悖。
 */
export function markTokenDead(tokenOrEntry, options = {}) {
  const entry = typeof tokenOrEntry === 'string'
    ? tokenPool.find(t => t.token === tokenOrEntry)
    : tokenOrEntry;
  if (!entry) return false;
  entry.errorCount = tokenDeadThreshold();
  return disableToken(entry, {
    reason: options.reason || '上游封禁/禁言',
    disabledUntil: options.disabledUntil || Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS,
    source: options.source || 'auto',
  });
}

export function reportTokenSuccess(token) {
  const entry = tokenPool.find(t => t.token === token);
  if (!entry) return;
  entry.errorCount = 0;
  entry.lastUsed = Date.now();
  // 成功即视为限流已解除：清冷却与计数，避免残留让 token 长时间闲置。
  entry.rateLimitHits = 0;
  entry.cooldownUntil = 0;
  // 自动禁用可被一次成功复活；手动禁用必须由管理员显式启用，不能被
  // 一次偶然成功悄悄解除（否则人工下线的凭据会自己回到调度里）。
  if (entry.disabled && entry.disabledSource === 'auto') {
    enableToken(entry);
    console.log(`Token ${token.slice(0, 12)}... revived (was disabled, now working)`);
  }
}

// Invalidate cached sessions for a token (after refresh)
function invalidateTokenSessions(token) {
  const prefix = token.slice(0, 12);
  invalidateSessionCache(prefix);
  // Also drop conversation-affinity bindings pointing at this token's sessions,
  // so chained turns don't keep targeting a now-stale session id.
  invalidateByTokenPrefix(prefix);
}

/**
 * 运行时状态快照，按凭据 id 索引。
 *
 * 存在的意义：后台的「渠道概览」取自运行时池，「凭据面板」取自配置
 * （config.deepseek.tokens/accounts）。两者对"可用"的定义原本不同——
 * 概览要求"有 token 且未禁用"，面板只要求"未禁用"，于是"已配置但尚未
 * 拿到 token"（待登录 / 被封禁）的账号在两个地方被算成了不同的结果，
 * 数量自然对不上。这里把运行时的关键事实（是否有 token）暴露给配置侧，
 * 让两处能按同一口径统计。
 */
export function getCredentialRuntimeStatus() {
  const out = {};
  for (const entry of tokenPool) {
    const id = credentialIdOf(entry);
    if (!id) continue;
    out[id] = {
      hasToken: Boolean(entry.token),
      disabled: Boolean(entry.disabled),
      // 已配置但尚无 token，且未被禁用 —— 即"等待登录"
      pending: !entry.token && !entry.disabled,
    };
  }
  return out;
}

// Legacy: pickToken returns just the token string
let tokenIndex = 0;
export function pickToken(preferVision = false) {
  let candidates = tokenPool.filter(t => !t.disabled && t.token);

  if (preferVision) {
    const visionTokens = candidates.filter(t => t.visionCapable === true);
    if (visionTokens.length > 0) candidates = visionTokens;
  } else {
    const nonVisionTokens = candidates.filter(t => t.visionCapable !== true);
    if (nonVisionTokens.length > 0) candidates = nonVisionTokens;
  }

  if (candidates.length === 0) {
    // Absolute fallback — use any token with a token string
    candidates = tokenPool.filter(t => t.token);
    if (candidates.length === 0) throw new Error('No tokens available in pool');
  }

  const idx = tokenIndex % candidates.length;
  const chosen = candidates[idx];
  tokenIndex++;
  return chosen.token;
}

// Legacy: sticky per-request token
let currentRequestToken = null;

export function setRequestToken(token) {
  currentRequestToken = token;
}

export function getRequestToken() {
  return currentRequestToken;
}

export async function getToken(preferVision = false) {
  if (currentRequestToken) return currentRequestToken;
  return pickToken(preferVision);
}

// Legacy: email/password login (adds to pool dynamically)
/**
 * 登录并把 token 归入池中该账号的条目（不新增条目）。
 *
 * 关键约束：**同一账号在池中只能占一个条目**。
 *
 * 旧实现先按「email 匹配且无 token」查找，找不到再按「新 token」查找。
 * 这个顺序有致命缺陷：DeepSeek **每次登录都会轮换 token**，所以对已有
 * token 的账号再登录一次时——第一次查找因"已有 token"落空，第二次查找
 * 因"新 token 与旧的不同"也落空——于是 push 出一个重复条目。
 *
 * 实测后果：5 个被封禁账号使测试接口的 needsLogin 恒为 true，每次点
 * 「测试渠道」都会为全部账号重登，健康账号被反复复制（15 条 = 10 账号 + 5 重复），
 * 池统计虚高、并发额度被重复计入。
 *
 * 现在改为**只按 email 定位**：账号是稳定身份，token 只是它的可变属性。
 */
export async function loginAndAddToken(email, password) {
  const token = await login(email, password);
  const entry = tokenPool.find(t => t.email === email);
  if (entry) {
    const previousToken = entry.token;
    entry.token = token;
    if (password) entry.password = password;
    entry.errorCount = 0;
    // 人工触发的登录成功即视为可用，清掉禁用态（含手动禁用的显式启用场景）。
    Object.assign(entry, emptyDisabledState());
    const vision = await checkVisionCapability(token);
    entry.visionCapable = vision;
    // 上游轮换后旧 token 立即失效，其会话/对话亲和缓存必须一并作废，
    // 否则后续请求会拿着过期 sessionId 去打上游。
    if (previousToken && previousToken !== token) invalidateTokenSessions(previousToken);
    persistTokensToConfig();
    return token;
  }

  const existing = tokenPool.find(t => t.token === token);
  if (!existing) {
    const vision = await checkVisionCapability(token);
    tokenPool.push(createTokenEntry({ token, email, password, visionCapable: vision }));
    persistTokensToConfig();
  }
  return token;
}

export function buildPersistedTokenEnv(pool) {
  const seenTokens = new Set();
  const dsTokens = [];
  const dsAccountsExtended = [];
  const seenAccountLinks = new Set();

  for (const entry of pool) {
    const token = entry.token?.trim();
    // 注意：这里**不**按 disabled 过滤。禁用是临时状态，凭据本体必须保留，
    // 否则重启后禁用记录会因失去对应凭据而被剪掉，风控结束也无从恢复。
    if (!token || seenTokens.has(token)) continue;
    seenTokens.add(token);
    dsTokens.push(token);

    if (entry.email && entry.password) {
      const tokenPrefix = token.slice(0, 12);
      const linkKey = `${entry.email}:${tokenPrefix}`;
      if (!seenAccountLinks.has(linkKey)) {
        seenAccountLinks.add(linkKey);
        dsAccountsExtended.push(`${entry.email}:${entry.password}:${tokenPrefix}`);
      }
    }
  }

  return { dsTokens, dsAccountsExtended };
}

function persistTokensToConfig() {
  const { dsTokens } = buildPersistedTokenEnv(tokenPool);
  // 只持久化「无账号归属」的 token。
  //
  // 有账号归属的 token 不需要单独存：accounts 会在下次启动时重新登录取得
  // 新 token（上游每次登录都会轮换）。若把它们也写进 tokens，下次启动就
  // 会同时存在「旧 token 条目」与「账号登录产出的新 token 条目」，
  // 同一账号占据两个池位、旧的那个必然报错，且随每次重启不断累积
  // （实测 9 个账号一度涨到 17 条池记录）。
  const accounts = tokenPool
    .filter(entry => entry.email && entry.password)
    .map(entry => ({ email: entry.email, password: entry.password }));
  const accountEmails = new Set(accounts.map(a => a.email));
  const orphanTokens = dsTokens.filter(token => {
    const entry = tokenPool.find(t => t.token === token);
    // 保留两类：无账号归属的 token，以及「有账号但该账号没有密码」的 token
    // （后者无法靠重新登录取回，若丢弃就永久失去这份凭据）。
    return !entry?.email || !accountEmails.has(entry.email);
  });

  updateChannelConfig('deepseek', {
    ...getConfig().deepseek,
    tokens: orphanTokens,
    accounts,
  });
}

export async function addTokenToPool(tokenStr) {
  const trimmed = tokenStr.trim();
  const existing = tokenPool.find(t => t.token === trimmed);
  if (existing) return existing;
  const entry = createTokenEntry({ token: trimmed });
  tokenPool.push(entry);
  persistTokensToConfig();
  return entry;
}

export function removeTokenFromPool(tokenPrefix) {
  const prefix = String(tokenPrefix || '').replace(/\.+$/, '').trim();
  if (!prefix || prefix === 'NONE') return false;

  const index = tokenPool.findIndex(entry => entry.token && entry.token.startsWith(prefix));
  if (index === -1) return false;

  const [removed] = tokenPool.splice(index, 1);
  invalidateTokenSessions(removed.token);
  persistTokensToConfig();
  return true;
}

// Periodic health check — validate alive tokens and detect banned accounts early
// Only checks tokens that haven't been used recently (idle tokens) to reduce request volume
function healthCheckIntervalMs() {
  return getConfig().deepseek.healthCheckIntervalSeconds * 1000;
}

function idleThresholdMs() {
  return getConfig().deepseek.idleThresholdSeconds * 1000;
}

/**
 * 执行一次健康检查（含禁期已到凭据的恢复探测）。
 * 导出以便测试与人工触发；常规运行由 startHealthCheck 定时调用。
 */
export async function healthCheck() {
  const now = Date.now();
  const idleThreshold = idleThresholdMs();

  // 1) 到期恢复探测：自动禁用的凭据过了禁期就试一次，成功即恢复。
  //    手动禁用（until=0）不在此列，必须由管理员显式启用。
  await probeRecoverableCredentials(now);

  // 2) 常规健康检查：只查闲置 token（近期用过的视为有效）。
  const idle = tokenPool.filter(t => !t.disabled && t.token && (now - t.lastUsed) > idleThreshold);
  if (idle.length === 0) return;

  console.log(`Health check: ${idle.length} idle tokens (of ${tokenPool.filter(t => !t.disabled).length} active)`);

  for (const entry of idle) {
    const valid = await validateToken(entry.token);
    if (!valid) {
      console.log(`Health check: ${entry.token.slice(0, 12)}... INVALID — ${entry.password ? 'refreshing' : 'disabling'}`);
      if (entry.password) {
        // 注意：refreshToken 对禁用条目会直接返回 false，所以这里能走到说明未禁用。
        const ok = await refreshToken(entry);
        if (!ok) {
          disableToken(entry, {
            reason: '健康检查失败（账号重登未成功）',
            disabledUntil: Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS,
            source: 'auto',
          });
        }
      } else {
        disableToken(entry, {
          reason: '健康检查失败（token 无效）',
          disabledUntil: Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS,
          source: 'auto',
        });
      }
    } else {
      entry.lastUsed = now; // reset idle timer on successful check
    }
  }
}

/**
 * 对"禁期已到"的自动禁用凭据做一次恢复探测。
 *
 * 账号型走 force 重登（禁用期已过，此时登录不再加重风控）；token 型直接
 * 校验原 token 是否重新可用。探测失败则把禁期顺延一个默认周期，避免每个
 * 健康检查周期都去打上游。
 */
async function probeRecoverableCredentials(now = Date.now()) {
  const due = tokenPool.filter(t =>
    t.disabled
    && t.disabledSource === 'auto'
    && t.disabledUntil > 0
    && now >= t.disabledUntil,
  );
  if (due.length === 0) return;

  console.log(`Health check: 探测 ${due.length} 个禁期已到的凭据`);

  for (const entry of due) {
    let ok = false;
    if (entry.password) {
      ok = await refreshToken(entry, { force: true });
      if (ok) invalidateTokenSessions(entry.token);
    } else if (entry.token) {
      ok = await validateToken(entry.token);
    }

    if (ok) {
      enableToken(entry);
    } else {
      // 顺延一个周期，等下次健康检查再试。
      entry.disabledUntil = Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS;
      const id = credentialIdOf(entry);
      if (id) {
        try {
          setCredentialState('deepseek', id, {
            disabled: true,
            reason: entry.disabledReason || '恢复探测失败',
            until: entry.disabledUntil,
            at: entry.disabledAt || Date.now(),
            source: 'auto',
          });
        } catch { /* 持久化失败不影响运行态 */ }
      }
      const label = entry.email || (entry.token ? `${entry.token.slice(0, 12)}...` : 'unknown');
      console.log(`Health check: ${label} 仍未恢复，禁期顺延约 3 天`);
    }
  }
}

let healthCheckTimer = null;

export function startHealthCheck() {
  if (healthCheckTimer) return;
  const interval = healthCheckIntervalMs();
  healthCheckTimer = setInterval(healthCheck, interval);
  // 不阻止进程退出：健康检查是后台维护任务，不应因为它的定时器而让
  // 进程（尤其是测试进程）无法结束。
  healthCheckTimer.unref?.();
  console.log(`Health check enabled: every ${interval / 1000}s`);
}

export function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

/**
 * 池状态（含禁用条目 —— 这是刻意的）。
 *
 * 以前这里 filter 掉 dead 条目，导致被风控淘汰的凭据在后台完全不可见，
 * 管理员看不到"发生过什么"。现在禁用凭据也返回，并带 disabled 字段与
 * 原因/剩余时间，由前端决定如何呈现（可用项与禁用项本就该都看得到）。
 */
export function getPoolInfo() {
  const now = Date.now();
  return tokenPool.map(t => ({
    token: t.token ? t.token.slice(0, 12) + '...' : 'NONE',
    email: t.email || null,
    visionCapable: t.visionCapable,
    errorCount: t.errorCount,
    activeRequests: t.activeRequests,
    disabled: Boolean(t.disabled),
    disabledReason: t.disabledReason || null,
    disabledSource: t.disabledSource || null,
    disabledRemainingMs: t.disabled && t.disabledUntil > 0 ? Math.max(0, t.disabledUntil - now) : 0,
    maxConcurrent: maxConcurrentPerToken(),
    // 限流冷却剩余时间（毫秒），0 表示可用
    cooldownRemainingMs: Math.max(0, (t.cooldownUntil || 0) - now),
    rateLimitHits: t.rateLimitHits || 0,
  }));
}

/**
 * 是否还有其它可用凭据（用于决定限流后要不要换 token 重试）。
 * excludeToken 传当前失败的 token，避免"换"成同一个。
 */
export function hasAlternativeToken(excludeToken = null) {
  const now = Date.now();
  return tokenPool.some(t =>
    !t.disabled
    && t.token
    && t.token !== excludeToken
    && (t.cooldownUntil || 0) <= now,
  );
}

export function getAliveTokens() {
  return tokenPool.filter(t => !t.disabled && t.token).map(t => t.token);
}

export function getTotalCapacity() {
  return tokenPool.filter(t => !t.disabled && t.token).length * maxConcurrentPerToken();
}

export async function testDeepSeekToken(token) {
  const valid = await validateToken(token);
  const visionCapable = valid ? await checkVisionCapability(token) : null;
  return { valid, visionCapable };
}

export function getDeepSeekTestToken() {
  const entry = tokenPool.find(t => !t.disabled && t.token);
  return entry?.token || null;
}

/**
 * 池条目（含禁用项）。与 getPoolInfo 一样刻意不过滤禁用条目——
 * admin 的测试接口需要看到它们才能判断"是禁用还是真没有"。
 */
export function getDeepSeekPoolEntries() {
  return tokenPool.map(t => ({
    token: t.token,
    email: t.email || null,
    visionCapable: t.visionCapable,
    disabled: Boolean(t.disabled),
    disabledReason: t.disabledReason || null,
    disabledUntil: t.disabledUntil || 0,
    disabledSource: t.disabledSource || null,
  }));
}

/**
 * 按凭据 id 启用/禁用（供 admin API 调用）。
 * 返回受影响条目的一份快照（含 token，供调用方做启用后探测），找不到返回 null。
 */
export function setCredentialDisabledById(id, disabled, reason = '') {
  const entry = tokenPool.find(t => credentialIdOf(t) === id);
  if (!entry) return null;
  if (disabled) {
    disableToken(entry, { reason: reason || '管理员手动禁用', source: 'manual', disabledUntil: 0 });
  } else {
    enableToken(entry);
  }
  return { token: entry.token, email: entry.email, disabled: Boolean(entry.disabled) };
}

/** 后台「测试」入口：把校验失败的凭据禁用（而非按旧逻辑删除）。 */
export function disableTokenByTokenString(token, reason) {
  const entry = tokenPool.find(t => t.token === token);
  if (!entry) return false;
  return disableToken(entry, {
    reason,
    disabledUntil: Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS,
    source: 'auto',
  });
}

/**
 * 按邮箱禁用账号型凭据（用于登录时明确返回"账号被封禁"的场景）。
 *
 * 为什么要单独处理：账号型凭据在拿到 token 前无法参与调度，若一直停留在
 * "启用但无 token"的状态，后台会显示为"等待自动登录"——而封禁是不可自愈的，
 * 这个措辞会误导用户以为迟早会好。标记为禁用后，原因与恢复预期才准确。
 */
export function disableAccountByEmail(email, reason, eventType = 'banned') {
  const entry = tokenPool.find(t => t.email === email && t.password);
  if (!entry) return false;
  return disableToken(entry, {
    reason,
    disabledUntil: Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS,
    source: 'auto',
    eventType,
  });
}
