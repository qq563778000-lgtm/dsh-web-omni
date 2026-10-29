import { getPoolInfo, reportTokenError, reportTokenSuccess } from './auth.js';
import { getConfig } from './config-store.js';
import { apiHeaders, proxiedFetch } from '../utils/headers.js';
import { recordSessionHit } from '../middleware/metrics.js';

const BASE_URL = 'https://chat.deepseek.com';

// SESSION_TTL controls how long a cached session is reused before creating a new one.
function sessionTtlSeconds() {
  return getConfig().runtime.sessionTtlSeconds;
}

const SESSIONS_PER_TOKEN_PER_MODEL = 2; // match MAX_CONCURRENT_PER_TOKEN

const sessionPool = new Map(); // key: token:model_type:slot, value: { id, model_type, createdAt, token, requestCount }

export async function createSession(token, modelType = 'default') {
  const res = await proxiedFetch(`${BASE_URL}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: await apiHeaders(token),
    body: JSON.stringify({}),
  });
  const json = await res.json();

  // Token invalid — report error so auth.js can disable it
  if (json.code === 40003) {
    reportTokenError(token);
    throw new Error('Token invalid (40003)');
  }

  const session = json.data?.biz_data?.chat_session;
  if (!session) {
    reportTokenError(token);
    throw new Error(`Session create failed: ${json.msg || JSON.stringify(json)}`);
  }

  reportTokenSuccess(token);
  return session;
}

export async function getSession(token, modelType) {
  const tokenPrefix = token.slice(0, 12);
  const now = Date.now() / 1000;

  const ttl = sessionTtlSeconds();

  // Find an available session slot for this token+modelType
  for (let slot = 0; slot < SESSIONS_PER_TOKEN_PER_MODEL; slot++) {
    const cacheKey = `${tokenPrefix}:${modelType}:${slot}`;
    const cached = sessionPool.get(cacheKey);

    if (cached && (now - cached.createdAt) < ttl) {
      cached.requestCount = (cached.requestCount || 0) + 1;
      recordSessionHit(true);
      return cached;
    }
  }

  // No free slot with valid session — create a new one, find first empty/expired slot
  const session = await createSession(token, modelType);
  recordSessionHit(false);
  session.createdAt = now;
  session.token = token;
  session.requestCount = 1;

  // Find first available slot (expired or empty)
  let placed = false;
  for (let slot = 0; slot < SESSIONS_PER_TOKEN_PER_MODEL; slot++) {
    const cacheKey = `${tokenPrefix}:${modelType}:${slot}`;
    const cached = sessionPool.get(cacheKey);
    if (!cached || (now - cached.createdAt) >= ttl) {
      sessionPool.set(cacheKey, session);
      placed = true;
      break;
    }
  }
  // Fallback: overwrite slot 0 if all are still fresh (shouldn't normally happen)
  if (!placed) {
    sessionPool.set(`${tokenPrefix}:${modelType}:0`, session);
  }

  return session;
}

// Remove cached sessions for a specific token prefix (used after token refresh)
export function invalidateTokenSessions(tokenPrefix) {
  for (const key of sessionPool.keys()) {
    if (key.startsWith(tokenPrefix + ':')) {
      sessionPool.delete(key);
    }
  }
}

export function getSessionInfo() {
  const now = Date.now() / 1000;
  const ttl = sessionTtlSeconds();
  const entries = [];
  for (const [key, val] of sessionPool) {
    const age = now - val.createdAt;
    entries.push({
      key,
      modelType: val.model_type,
      ageSeconds: Math.floor(age),
      ttlRemainingSeconds: Math.max(0, Math.floor(ttl - age)),
      requestCount: val.requestCount || 0,
    });
  }
  return { count: sessionPool.size, ttl, sessions: entries };
}

export async function prewarmSessions(tokens, modelTypes = ['default']) {
  const poolInfo = getPoolInfo();
  const alivePrefixes = poolInfo.filter(t => !t.disabled && t.token !== 'NONE').map(t => t.token.replace('...', ''));

  console.log(`Pre-warming sessions for ${alivePrefixes.length} alive tokens × ${SESSIONS_PER_TOKEN_PER_MODEL} slots × ${modelTypes.length} model types...`);
  const promises = [];
  for (const token of tokens) {
    const prefix = token.slice(0, 12);
    if (!alivePrefixes.includes(prefix)) continue;
    for (const modelType of modelTypes) {
      for (let slot = 0; slot < SESSIONS_PER_TOKEN_PER_MODEL; slot++) {
        const cacheKey = `${prefix}:${modelType}:${slot}`;
        if (!sessionPool.has(cacheKey)) {
          promises.push(
            getSession(token, modelType).catch(() => {})
          );
        }
      }
    }
    if (promises.length >= 6) {
      await Promise.allSettled(promises.splice(0));
    }
  }
  if (promises.length > 0) {
    await Promise.allSettled(promises);
  }
  console.log(`Session pool: ${sessionPool.size} cached sessions`);
}
