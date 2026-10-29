import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { appRootPath } from '../utils/runtime-paths.js';

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  server: {
    apiKey: '',
    apiKeys: [],
    mergeThinking: false,
    enablePromptInjection: true,
    // 客户端调试日志默认关闭：它会记录完整请求/响应正文（含用户对话内容），
    // 是磁盘与内存增长最快的部分（实测单日可达 37MB）。仅在排障时临时开启。
    clientDebugLog: false,
    clientDebugLogDir: '',
    // 单字段记录上限。默认 64KB（原 200KB）：配合 logger 的整文件 20MB 上限，
    // 避免单条记录就把内存/磁盘吃掉一大块。
    clientDebugLogMaxChars: 65536,
    systemFingerprint: 'fp_omni_v1',
  },
  runtime: {
    sessionTtlSeconds: 1800,
    enableConversationAffinity: false,
    conversationTtlMs: 1800000,
    maxConversations: 500,
    enableFcErrorRetry: true,
    logDir: '',
  },
  deepseek: {
    tokens: [],
    accounts: [],
    // 凭据禁用态表：{ [secretId]: { disabled, reason, until, at, source } }。
    //
    // 为什么要单独存一张表而不是直接删掉凭据：上游风控（禁言/封禁）是**临时**的，
    // 删除会让凭据永久丢失、且后台完全看不到发生过什么。这里只记录"禁用"，
    // 凭据本身仍留在 tokens/accounts 里，到期可自动恢复，也可人工启用。
    // 具体语义见 src/services/auth.js 的 disableToken/enableToken。
    credentialStates: {},
    maxConcurrentPerToken: 2,
    tokenDeadThreshold: 5,
    healthCheckIntervalSeconds: 600,
    idleThresholdSeconds: 1800,
    validateOnStartup: false,
    prewarmSessions: false,
    // 上报给客户端的缓存命中率（0–100）。上游 Web 接口不提供 prompt cache
    // 统计，该值仅用于客户端展示，不影响实际计费。
    reportedCacheHitRate: 98.5,
    // 对外上报的上下文窗口与输出上限（tokens），客户端据此自动识别模型能力。
    // 按 DeepSeek 官方 1M 规范：上下文 1M（1048576 tokens）。
    // 上游 Web 端实测的历史+文件累计上限为 890880，与 1M 量级一致。
    contextLength: 1048576,
    maxOutputTokens: 65536,
  },
});

let loaded = false;
let config = clone(DEFAULT_CONFIG);
let configPath = null;
let configLoadError = null;

// 由环境变量（.env）提供的凭据 id 集合。用途有二：
//   1. 持久化时剔除——不把来自 .env 的机密复制一份写进 config.json；
//   2. 禁用态剪枝时视为有效凭据——否则 env 凭据的禁用态会在重启后被误剪。
let envCredentialIds = new Set();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, patch) {
  const result = clone(base);
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else if (Array.isArray(value)) {
      result[key] = clone(value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function parseBool(value, fallback) {
  if (value == null || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseIntValue(value, fallback, min = 0) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

function parseFloatValue(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function parseAccounts(value) {
  return splitList(value).map(item => {
    const [email, ...passwordParts] = item.split(':');
    const password = passwordParts.join(':');
    return email && password ? { email, password } : null;
  }).filter(Boolean);
}

function uniqueStrings(values = []) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

/**
 * 合并「环境变量来源」与「磁盘配置来源」的凭据，取并集去重。
 *
 * 语义（与其它配置项的"磁盘覆盖 env"刻意不同）：
 *   - 凭据是**累加**语义：env 与磁盘里各自配置的凭据都应当生效，谁都不丢；
 *   - env 来源排在前面（更接近"显式声明"，且便于排查）；
 *   - 精确字符串去重。DeepSeek 的 token 是 64 字符无结构的 base64 随机串
 *     （实测解码为 48 字节随机数据，非 JWT、无分隔符、无共享前缀），因此
 *     **无法提取任何标识做语义去重**，只能按字符串全等比较；
 *   - 账号按 `email:password` 去重，与 secretId 的口径一致。
 *
 * @param {string[]} envTokens  来自 DS_TOKENS / DS_TOKEN
 * @param {string[]} diskTokens 来自 config.json 的 deepseek.tokens
 * @param {object[]} envAccounts
 * @param {object[]} diskAccounts
 */
function mergeCredentials(envTokens, diskTokens, envAccounts, diskAccounts) {
  const tokens = uniqueStrings([...(envTokens || []), ...(diskTokens || [])]);

  const seen = new Set();
  const accounts = [];
  for (const account of [...(envAccounts || []), ...(diskAccounts || [])]) {
    const email = String(account?.email || '').trim();
    const password = String(account?.password || '').trim();
    if (!email || !password) continue;
    const key = `${email}:${password}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accounts.push({ email, password });
  }

  return { tokens, accounts };
}

function normalizeAccounts(accounts = []) {
  const seen = new Set();
  const normalized = [];
  for (const account of accounts || []) {
    const email = String(account?.email || '').trim();
    const password = String(account?.password || '').trim();
    if (!email || !password) continue;
    const key = `${email}\n${password}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ email, password });
  }
  return normalized;
}

/**
 * 归一化凭据禁用态表。
 *
 * 只保留 disabled===true 的条目——"未禁用"是默认态，写进配置只会让文件膨胀。
 * 同时剪掉已不对应任何现存凭据的 key（校验逻辑见 pruneCredentialStates），
 * 避免反复增删凭据后表无限增长。
 */
function normalizeCredentialStates(states, tokens = [], accounts = []) {
  const source = isPlainObject(states) ? states : {};
  const validIds = new Set([
    ...tokens.map(value => secretId(value)),
    ...accounts.map(account => secretId(`${account.email}:${account.password}`)),
    // 环境变量提供的凭据也算有效：它们不落盘，但禁用态需要保留，
    // 否则重启后 .env 凭据的禁用记录会被当 stale key 剪掉而"复活"。
    ...envCredentialIds,
  ]);

  const normalized = {};
  for (const [id, raw] of Object.entries(source)) {
    if (!isPlainObject(raw) || raw.disabled !== true) continue;
    if (!validIds.has(id)) continue;
    const until = Number(raw.until);
    const at = Number(raw.at);
    normalized[id] = {
      disabled: true,
      reason: String(raw.reason || '').trim(),
      // until 为绝对时间戳；0 表示手动禁用（不自动恢复）。
      until: Number.isFinite(until) && until > 0 ? until : 0,
      at: Number.isFinite(at) && at > 0 ? at : 0,
      source: raw.source === 'manual' ? 'manual' : 'auto',
    };
  }
  return normalized;
}

function normalizeApiKeys(apiKeys = []) {
  const seen = new Set();
  const normalized = [];
  for (const item of apiKeys || []) {
    const key = String(typeof item === 'string' ? item : item?.key || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      name: String(typeof item === 'string' ? 'External API Key' : item?.name || 'External API Key').trim() || 'External API Key',
      key,
      createdAt: typeof item === 'object' && item?.createdAt ? String(item.createdAt) : '',
    });
  }
  return normalized;
}

function normalizeConfig(input) {
  const merged = deepMerge(DEFAULT_CONFIG, input || {});
  merged.version = 1;

  merged.server.apiKey = String(merged.server.apiKey || '').trim();
  merged.server.apiKeys = normalizeApiKeys(merged.server.apiKeys);
  merged.server.mergeThinking = Boolean(merged.server.mergeThinking);
  merged.server.enablePromptInjection = merged.server.enablePromptInjection !== false;
  merged.server.clientDebugLog = Boolean(merged.server.clientDebugLog);
  merged.server.clientDebugLogDir = String(merged.server.clientDebugLogDir || '').trim();
  merged.server.clientDebugLogMaxChars = parseIntValue(
    merged.server.clientDebugLogMaxChars,
    DEFAULT_CONFIG.server.clientDebugLogMaxChars,
    1000,
  );
  merged.server.systemFingerprint = String(merged.server.systemFingerprint || 'fp_omni_v1').trim() || 'fp_omni_v1';

  merged.runtime.sessionTtlSeconds = parseIntValue(merged.runtime.sessionTtlSeconds, 1800, 1);
  merged.runtime.enableConversationAffinity = Boolean(merged.runtime.enableConversationAffinity);
  merged.runtime.conversationTtlMs = parseIntValue(merged.runtime.conversationTtlMs, 1800000, 1000);
  merged.runtime.maxConversations = parseIntValue(merged.runtime.maxConversations, 500, 1);
  merged.runtime.enableFcErrorRetry = merged.runtime.enableFcErrorRetry !== false;
  merged.runtime.logDir = String(merged.runtime.logDir || '').trim();

  merged.deepseek.tokens = uniqueStrings(merged.deepseek.tokens);
  merged.deepseek.accounts = normalizeAccounts(merged.deepseek.accounts);
  // 禁用态表依赖已归一化的 tokens/accounts（据此计算合法 id 并剪除 stale key）。
  merged.deepseek.credentialStates = normalizeCredentialStates(
    merged.deepseek.credentialStates,
    merged.deepseek.tokens,
    merged.deepseek.accounts,
  );
  merged.deepseek.maxConcurrentPerToken = parseIntValue(merged.deepseek.maxConcurrentPerToken, 2, 1);
  merged.deepseek.tokenDeadThreshold = parseIntValue(merged.deepseek.tokenDeadThreshold, 5, 1);
  merged.deepseek.healthCheckIntervalSeconds = parseIntValue(merged.deepseek.healthCheckIntervalSeconds, 600, 1);
  merged.deepseek.idleThresholdSeconds = parseIntValue(merged.deepseek.idleThresholdSeconds, 1800, 1);
  merged.deepseek.validateOnStartup = Boolean(merged.deepseek.validateOnStartup);
  merged.deepseek.prewarmSessions = Boolean(merged.deepseek.prewarmSessions);
  // 缓存命中率展示值：限制在 0–100，避免配置失误产生无意义数值。
  merged.deepseek.reportedCacheHitRate = Math.min(
    100,
    Math.max(0, Number.isFinite(Number(merged.deepseek.reportedCacheHitRate))
      ? Number(merged.deepseek.reportedCacheHitRate)
      : DEFAULT_CONFIG.deepseek.reportedCacheHitRate),
  );
  merged.deepseek.contextLength = parseIntValue(
    merged.deepseek.contextLength,
    DEFAULT_CONFIG.deepseek.contextLength,
    1,
  );
  merged.deepseek.maxOutputTokens = parseIntValue(
    merged.deepseek.maxOutputTokens,
    DEFAULT_CONFIG.deepseek.maxOutputTokens,
    1,
  );

  return merged;
}

function envConfig() {
  const singleDeepSeekToken = process.env.DS_TOKEN ? [process.env.DS_TOKEN] : [];
  const deepseekTokens = process.env.DS_TOKENS ? splitList(process.env.DS_TOKENS) : singleDeepSeekToken;

  return normalizeConfig({
    server: {
      apiKey: process.env.API_KEY || '',
      apiKeys: splitList(process.env.API_KEYS),
      mergeThinking: parseBool(process.env.MERGE_THINKING, DEFAULT_CONFIG.server.mergeThinking),
      enablePromptInjection: parseBool(process.env.ENABLE_PROMPT_INJECTION, DEFAULT_CONFIG.server.enablePromptInjection),
      clientDebugLog: parseBool(process.env.CLIENT_DEBUG_LOG, DEFAULT_CONFIG.server.clientDebugLog),
      clientDebugLogDir: process.env.CLIENT_DEBUG_LOG_DIR || '',
      clientDebugLogMaxChars: parseIntValue(process.env.CLIENT_DEBUG_LOG_MAX_CHARS, DEFAULT_CONFIG.server.clientDebugLogMaxChars, 1000),
      systemFingerprint: process.env.SYSTEM_FINGERPRINT || DEFAULT_CONFIG.server.systemFingerprint,
    },
    runtime: {
      sessionTtlSeconds: parseIntValue(process.env.SESSION_TTL, DEFAULT_CONFIG.runtime.sessionTtlSeconds, 1),
      enableConversationAffinity: parseBool(process.env.ENABLE_CONVERSATION_AFFINITY, DEFAULT_CONFIG.runtime.enableConversationAffinity),
      conversationTtlMs: parseIntValue(process.env.CONVERSATION_TTL_MS, DEFAULT_CONFIG.runtime.conversationTtlMs, 1000),
      maxConversations: parseIntValue(process.env.MAX_CONVERSATIONS, DEFAULT_CONFIG.runtime.maxConversations, 1),
      enableFcErrorRetry: parseBool(process.env.ENABLE_FC_ERROR_RETRY, DEFAULT_CONFIG.runtime.enableFcErrorRetry),
      logDir: process.env.LOG_DIR || '',
    },
    deepseek: {
      tokens: deepseekTokens,
      accounts: parseAccounts(process.env.DS_ACCOUNTS),
      maxConcurrentPerToken: parseIntValue(process.env.MAX_CONCURRENT_PER_TOKEN, DEFAULT_CONFIG.deepseek.maxConcurrentPerToken, 1),
      tokenDeadThreshold: parseIntValue(process.env.TOKEN_DEAD_THRESHOLD, DEFAULT_CONFIG.deepseek.tokenDeadThreshold, 1),
      healthCheckIntervalSeconds: parseIntValue(process.env.HEALTH_CHECK_INTERVAL, DEFAULT_CONFIG.deepseek.healthCheckIntervalSeconds, 1),
      idleThresholdSeconds: parseIntValue(process.env.IDLE_THRESHOLD, DEFAULT_CONFIG.deepseek.idleThresholdSeconds, 1),
      validateOnStartup: parseBool(process.env.DEEPSEEK_VALIDATE_ON_STARTUP, DEFAULT_CONFIG.deepseek.validateOnStartup),
      prewarmSessions: parseBool(process.env.DEEPSEEK_PREWARM_SESSIONS, DEFAULT_CONFIG.deepseek.prewarmSessions),
      reportedCacheHitRate: parseFloatValue(process.env.DEEPSEEK_REPORTED_CACHE_HIT_RATE, DEFAULT_CONFIG.deepseek.reportedCacheHitRate),
      contextLength: parseIntValue(process.env.DEEPSEEK_CONTEXT_LENGTH, DEFAULT_CONFIG.deepseek.contextLength, 1),
      maxOutputTokens: parseIntValue(process.env.DEEPSEEK_MAX_OUTPUT_TOKENS, DEFAULT_CONFIG.deepseek.maxOutputTokens, 1),
    },
  });
}

function resolveConfigPath() {
  if (process.env.ZHI2API_CONFIG_PATH) return resolve(process.env.ZHI2API_CONFIG_PATH);
  if (process.env.ZHI2API_DATA_DIR) return resolve(process.env.ZHI2API_DATA_DIR, 'config.json');
  return appRootPath('config.json');
}

function readDiskConfig(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw || '{}');
}

export function loadConfig({ force = false } = {}) {
  if (loaded && !force) return config;

  configPath = resolveConfigPath();
  configLoadError = null;
  let disk = {};
  let diskCorrupted = false;
  try {
    disk = readDiskConfig(configPath);
  } catch (error) {
    configLoadError = error.message;
    diskCorrupted = true;
    console.warn(
      `Failed to load config ${configPath}: ${error.message}\n`
      + '  → 已跳过该文件（不会用空配置覆盖内存中的既有配置）。'
      + '请修复或删除该文件后重启。',
    );
  }

  const fromEnv = envConfig();

  // 磁盘配置损坏时，绝不能用空对象继续 —— 那会把已有的凭据/设置静默清空
  // （历史上表现为"凭据莫名其妙全没了"）。已加载过则保留内存里那份，
  // 并让后续 saveConfig 有机会把修复后的配置写回。
  if (diskCorrupted && loaded) return config;

  const merged = deepMerge(fromEnv, disk);

  // 凭据取并集而非"磁盘覆盖 env"：见 mergeCredentials 的说明。
  // 先记录 env 来源（用于持久化时剔除与禁用态剪枝），再覆盖合并结果。
  envCredentialIds = new Set([
    ...(fromEnv.deepseek?.tokens || []).map(value => secretId(value)),
    ...(fromEnv.deepseek?.accounts || []).map(a => secretId(`${a.email}:${a.password}`)),
  ]);
  merged.deepseek = merged.deepseek || {};
  const credentials = mergeCredentials(
    fromEnv.deepseek?.tokens,
    disk.deepseek?.tokens,
    fromEnv.deepseek?.accounts,
    disk.deepseek?.accounts,
  );
  merged.deepseek.tokens = credentials.tokens;
  merged.deepseek.accounts = credentials.accounts;

  config = normalizeConfig(merged);
  loaded = true;
  return config;
}

function setEnv(name, value) {
  if (value == null || value === '') {
    delete process.env[name];
  } else {
    process.env[name] = String(value);
  }
}

export function applyConfigToProcessEnv() {
  const current = loadConfig();
  setEnv('API_KEY', current.server.apiKey);
  setEnv('API_KEYS', current.server.apiKeys.map(item => item.key).join(','));
  setEnv('MERGE_THINKING', current.server.mergeThinking ? 'true' : 'false');
  setEnv('ENABLE_PROMPT_INJECTION', current.server.enablePromptInjection ? 'true' : 'false');
  setEnv('CLIENT_DEBUG_LOG', current.server.clientDebugLog ? 'true' : 'false');
  setEnv('CLIENT_DEBUG_LOG_DIR', current.server.clientDebugLogDir);
  setEnv('CLIENT_DEBUG_LOG_MAX_CHARS', current.server.clientDebugLogMaxChars);
  setEnv('SYSTEM_FINGERPRINT', current.server.systemFingerprint);

  setEnv('SESSION_TTL', current.runtime.sessionTtlSeconds);
  setEnv('ENABLE_CONVERSATION_AFFINITY', current.runtime.enableConversationAffinity ? 'true' : 'false');
  setEnv('CONVERSATION_TTL_MS', current.runtime.conversationTtlMs);
  setEnv('MAX_CONVERSATIONS', current.runtime.maxConversations);
  setEnv('ENABLE_FC_ERROR_RETRY', current.runtime.enableFcErrorRetry ? 'true' : 'false');
  setEnv('LOG_DIR', current.runtime.logDir);

  // 刻意**不**回写 DS_TOKENS / DS_ACCOUNTS。
  //
  // 回写会让两边互相覆盖、来源不可追溯：后台保存一次配置，config 的值就被
  // 塞回 process.env，之后 .env 再怎么改都被这个"内存里的值"盖住，
  // 且与"凭据取并集"的语义冲突。凭据的唯一来源是 getConfig()。
  // 其它 DS_* 调优项（并发、阈值等）仍回写，保持既有行为。
  setEnv('MAX_CONCURRENT_PER_TOKEN', current.deepseek.maxConcurrentPerToken);
  setEnv('TOKEN_DEAD_THRESHOLD', current.deepseek.tokenDeadThreshold);
  setEnv('HEALTH_CHECK_INTERVAL', current.deepseek.healthCheckIntervalSeconds);
  setEnv('IDLE_THRESHOLD', current.deepseek.idleThresholdSeconds);
  setEnv('DEEPSEEK_VALIDATE_ON_STARTUP', current.deepseek.validateOnStartup ? 'true' : 'false');
  setEnv('DEEPSEEK_PREWARM_SESSIONS', current.deepseek.prewarmSessions ? 'true' : 'false');
}

export function getConfig() {
  return loadConfig();
}

export function getConfigPath() {
  loadConfig();
  return configPath;
}

export function getConfigLoadError() {
  loadConfig();
  return configLoadError;
}

export function getDataDir() {
  return process.env.ZHI2API_DATA_DIR || dirname(getConfigPath());
}

export function getLogDir() {
  return getConfig().runtime.logDir || resolve(getDataDir(), 'logs');
}

/**
 * 生成写入磁盘的配置副本：剔除来自环境变量的凭据。
 *
 * 为什么剔除：env 是凭据的**外部权威来源**，把它复制进 config.json 会造成
 * ①机密在磁盘多一份副本；②来源不可追溯（分不清某个 token 是 env 给的还是
 * 后台加的，之后改 .env 会被磁盘里的旧副本压住——这正是本次要修的问题）。
 * 内存中的 config 仍保留并集，因此运行时行为不受影响。
 */
function stripEnvCredentials(source) {
  if (envCredentialIds.size === 0) return source;
  const next = clone(source);
  if (!next.deepseek) return next;
  next.deepseek.tokens = (next.deepseek.tokens || [])
    .filter(token => !envCredentialIds.has(secretId(token)));
  next.deepseek.accounts = (next.deepseek.accounts || [])
    .filter(account => !envCredentialIds.has(secretId(`${account.email}:${account.password}`)));
  return next;
}

export function saveConfig(nextConfig = config) {
  const normalized = normalizeConfig(nextConfig);
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });

  // 原子写：先写同目录临时文件再 rename。直接覆盖时若进程被杀/磁盘满，
  // 会留下被截断的 JSON，下次启动解析失败并回落成空配置（凭据全丢）。
  // 同目录 rename 在 POSIX 与 Windows 上都是原子替换。
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(stripEnvCredentials(normalized), null, 2)}\n`);
  renameSync(tmpPath, path);

  // 内存态持有完整并集（含 env 凭据），运行时与后台展示都以它为准。
  config = normalized;
  loaded = true;
  applyConfigToProcessEnv();
  return config;
}

export function updateConfig(patch) {
  return saveConfig(deepMerge(getConfig(), patch));
}

export function updateChannelConfig(channel, payload) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, channel)) {
    throw new Error(`Unsupported channel: ${channel}`);
  }
  return updateConfig({ [channel]: payload });
}

export function secretId(secret) {
  return createHash('sha256').update(String(secret || '')).digest('hex').slice(0, 16);
}

function maskSecret(secret) {
  const text = String(secret || '');
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}***`;
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function publicSecrets(values = [], states = {}) {
  return values.map(value => ({ id: secretId(value), label: maskSecret(value), configured: true, ...publicStateOf(states, secretId(value)) }));
}

function publicApiKeys(values = []) {
  return values.map(value => ({
    id: secretId(value.key),
    name: value.name,
    label: maskSecret(value.key),
    createdAt: value.createdAt || '',
    configured: true,
  }));
}

function publicAccounts(accounts = [], states = {}) {
  return accounts.map(account => ({
    id: secretId(`${account.email}:${account.password}`),
    email: account.email,
    hasPassword: Boolean(account.password),
    ...publicStateOf(states, secretId(`${account.email}:${account.password}`)),
  }));
}

/**
 * 把禁用态剪成前端可用的扁平字段。未禁用的凭据只带 disabled:false，
 * 不额外塞 null 字段，保持既有响应形状尽量稳定。
 */
function publicStateOf(states, id) {
  const state = states?.[id];
  if (!state?.disabled) return { disabled: false };
  return {
    disabled: true,
    disabledReason: state.reason || '',
    disabledUntil: state.until || 0,
    disabledAt: state.at || 0,
    disabledSource: state.source || 'auto',
    disabledRemainingMs: state.until > 0 ? Math.max(0, state.until - Date.now()) : 0,
  };
}

export function getPublicConfig() {
  const current = getConfig();
  return {
    version: current.version,
    paths: {
      config: getConfigPath(),
      dataDir: getDataDir(),
      logDir: getLogDir(),
      clientDebugLogDir: current.server.clientDebugLogDir || resolve(getDataDir(), 'logs-debug'),
    },
    loadError: getConfigLoadError(),
    server: {
      apiKeyConfigured: Boolean(current.server.apiKey),
      apiKey: current.server.apiKey ? maskSecret(current.server.apiKey) : '',
      apiKeys: publicApiKeys(current.server.apiKeys),
      externalApiKeyCount: current.server.apiKeys.length + (current.server.apiKey ? 1 : 0),
      adminKeyAcceptedForApi: Boolean(current.server.apiKey),
      mergeThinking: current.server.mergeThinking,
      enablePromptInjection: current.server.enablePromptInjection,
      clientDebugLog: current.server.clientDebugLog,
      clientDebugLogDir: current.server.clientDebugLogDir,
      clientDebugLogMaxChars: current.server.clientDebugLogMaxChars,
      systemFingerprint: current.server.systemFingerprint,
    },
    runtime: {
      sessionTtlSeconds: current.runtime.sessionTtlSeconds,
      enableConversationAffinity: current.runtime.enableConversationAffinity,
      conversationTtlMs: current.runtime.conversationTtlMs,
      maxConversations: current.runtime.maxConversations,
      enableFcErrorRetry: current.runtime.enableFcErrorRetry,
      logDir: current.runtime.logDir,
    },
    deepseek: {
      authMode: current.deepseek.accounts.length > 0 ? 'account-pool' : 'token-pool',
      tokenCount: current.deepseek.tokens.length,
      tokens: current.deepseek.accounts.length > 0 ? [] : publicSecrets(current.deepseek.tokens, current.deepseek.credentialStates),
      accounts: publicAccounts(current.deepseek.accounts, current.deepseek.credentialStates),
      // 禁用凭据数（含 token 与账号），供前端提示"可用 N / 共 M"。
      disabledCount: Object.keys(current.deepseek.credentialStates || {}).length,
      maxConcurrentPerToken: current.deepseek.maxConcurrentPerToken,
      tokenDeadThreshold: current.deepseek.tokenDeadThreshold,
      healthCheckIntervalSeconds: current.deepseek.healthCheckIntervalSeconds,
      idleThresholdSeconds: current.deepseek.idleThresholdSeconds,
      validateOnStartup: current.deepseek.validateOnStartup,
      prewarmSessions: current.deepseek.prewarmSessions,
      reportedCacheHitRate: current.deepseek.reportedCacheHitRate,
      contextLength: current.deepseek.contextLength,
      maxOutputTokens: current.deepseek.maxOutputTokens,
    },
  };
}

export function getPublicChannelConfig(channel) {
  const publicConfig = getPublicConfig();
  if (!Object.prototype.hasOwnProperty.call(publicConfig, channel)) {
    throw new Error(`Unsupported channel: ${channel}`);
  }
  return publicConfig[channel];
}

function generateApiKey() {
  return `sk-omni-${randomBytes(24).toString('hex')}`;
}

export function addServerApiKey(payload = {}) {
  const key = String(payload.key || '').trim() || generateApiKey();
  const name = String(payload.name || 'External API Key').trim() || 'External API Key';
  const current = getConfig();
  const next = clone(current);
  next.server.apiKeys.push({
    name,
    key,
    createdAt: new Date().toISOString(),
  });
  saveConfig(next);
  return { key, config: getPublicConfig().server };
}

export function removeServerApiKey(id) {
  const current = getConfig();
  const before = current.server.apiKeys.length;
  const next = clone(current);
  next.server.apiKeys = next.server.apiKeys.filter(item => secretId(item.key) !== id);
  if (next.server.apiKeys.length === before) return false;
  saveConfig(next);
  return true;
}

function safeEqualSecret(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 内置放行的 Key。
 *
 * 无论后面配置了哪些 Key，这个值始终可通过鉴权（/v1 与 /admin 均适用）。
 * 用于固定客户端/调试场景：客户端只配置了这一个 Key 时，管理员在后台
 * 改动 server.apiKey 或增删外部 API Key，都不会把该客户端锁死。
 */
export const BUILTIN_API_KEY = 'sk-zhi';

export function getAcceptedApiKeys() {
  const current = getConfig();
  return uniqueStrings([
    BUILTIN_API_KEY,
    current.server.apiKey,
    ...current.server.apiKeys.map(item => item.key),
  ]);
}

export function isAcceptedApiKey(value) {
  const keys = getAcceptedApiKeys();
  if (!keys.length) return true;
  return keys.some(key => safeEqualSecret(value, key));
}

export function addChannelCredential(channel, payload = {}) {
  const current = getConfig();
  const next = clone(current);
  if (channel === 'deepseek') {
    if (payload.type === 'account') {
      next.deepseek.accounts.push({ email: payload.email, password: payload.password });
    } else {
      next.deepseek.tokens.push(payload.token);
    }
  } else {
    throw new Error(`Unsupported channel: ${channel}`);
  }
  return saveConfig(next);
}

export function removeChannelCredential(channel, id) {
  const current = getConfig();
  const next = clone(current);
  let removed = false;

  function removeSecret(list) {
    const before = list.length;
    const filtered = list.filter(value => secretId(value) !== id);
    removed = removed || filtered.length !== before;
    return filtered;
  }

  function removeAccount(list) {
    const before = list.length;
    const filtered = list.filter(account => secretId(`${account.email}:${account.password}`) !== id);
    removed = removed || filtered.length !== before;
    return filtered;
  }

  if (channel === 'deepseek') {
    next.deepseek.tokens = removeSecret(next.deepseek.tokens);
    next.deepseek.accounts = removeAccount(next.deepseek.accounts);
  } else {
    throw new Error(`Unsupported channel: ${channel}`);
  }

  if (!removed) return false;
  // 凭据本体已删除，禁用态记录也随之作废，一并清理避免残留脏 key。
  if (next.deepseek.credentialStates?.[id]) {
    delete next.deepseek.credentialStates[id];
  }
  saveConfig(next);
  return true;
}

/** 读取某渠道的凭据禁用态表（返回副本，调用方不应直接改）。 */
export function getCredentialStates(channel) {
  ensureChannelKey(channel);
  return clone(getConfig()[channel].credentialStates || {});
}

/**
 * 写入/合并一条禁用态。patch 只需给出要改的字段。
 * 传 `{ disabled: false }` 等价于 clearCredentialState。
 */
export function setCredentialState(channel, id, patch = {}) {
  ensureChannelKey(channel);
  if (!id) throw new Error('credential id required');
  const next = clone(getConfig());
  const states = next[channel].credentialStates || (next[channel].credentialStates = {});
  if (patch.disabled === false) {
    delete states[id];
  } else {
    states[id] = { ...(states[id] || {}), ...patch, disabled: true };
  }
  saveConfig(next);
  return clone(states[id] || { disabled: false });
}

/** 清除禁用态（恢复为默认可用）。 */
export function clearCredentialState(channel, id) {
  return setCredentialState(channel, id, { disabled: false });
}

function ensureChannelKey(channel) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, channel)) {
    throw new Error(`Unsupported channel: ${channel}`);
  }
}
