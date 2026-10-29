// Conversation affinity: keep one DeepSeek session per logical conversation and
// chain turns via parent_message_id, so the proxy sends only the latest user
// turn instead of flattening the whole history (which caused role confusion).
//
// A conversation is identified by:
//   1. explicit request header  X-Conversation-Id   (preferred — your agent sets it)
//   2. fallback: hash of the full messages array     (auto, keeps multi-turn clients working)
//
// State is in-memory only and evicted by TTL / size. It maps:
//   conversationId -> { sessionId, parentMessageId, tokenPrefix, createdAt, lastSeen, turns }
//
// All functions are no-ops when ENABLE_CONVERSATION_AFFINITY is not "true", so
// legacy clients that don't send an id and don't want affinity are unaffected.

import { createHash } from 'crypto';
import { createSession } from './session.js';
import { getConfig } from './config-store.js';

function settings() {
  return getConfig().runtime;
}

const store = new Map(); // conversationId -> entry
const responseToolCallStore = new Map(); // responseId -> { lastSeen, toolCalls: Map<callId, {name, arguments}> }
const recentToolCallStore = new Map(); // callId -> { lastSeen, name, arguments }

function hashUpdateMessage(h, m) {
  h.update(String(m?.role || ''));
  h.update('\0');
  const c = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content || '');
  h.update(c);
  h.update('\0');
  // 区分只有 tool_calls / tool_call_id 不同的消息，避免不同对话的前缀误碰撞
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length) {
    h.update(JSON.stringify(m.tool_calls));
    h.update('\0');
  }
  if (m?.tool_call_id) {
    h.update(String(m.tool_call_id));
    h.update('\0');
  }
}

function hashMessages(messages) {
  // Stable hash of the message sequence. Includes roles so two different
  // conversations with identical concatenated text don't collide.
  const h = createHash('sha1');
  for (const m of messages) hashUpdateMessage(h, m);
  return h.digest('hex').slice(0, 24);
}

// 累积计算每个消息前缀的哈希：prefixHashes[i] = hash(messages[0..i])。
// 多轮客户端每轮重发"上一轮全量 + 新增消息"，因此上一轮的全量哈希
// 必然等于本轮某个前缀的哈希——用它找回既有会话。
function prefixMessageHashes(messages) {
  const hashes = [];
  const h = createHash('sha1');
  for (const m of messages) {
    hashUpdateMessage(h, m);
    hashes.push(h.copy().digest('hex').slice(0, 24));
  }
  return hashes;
}

function now() { return Date.now(); }

function evictExpired() {
  const cutoff = now() - settings().conversationTtlMs;
  for (const [id, e] of store) {
    if (e.lastSeen < cutoff) store.delete(id);
  }
  for (const [id, e] of responseToolCallStore) {
    if (e.lastSeen < cutoff) responseToolCallStore.delete(id);
  }
  for (const [id, e] of recentToolCallStore) {
    if (e.lastSeen < cutoff) recentToolCallStore.delete(id);
  }
}

function enforceCapacity() {
  const maxConversations = settings().maxConversations;
  if (store.size <= maxConversations) return;
  // Drop the oldest-seen entries first.
  const entries = [...store.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
  const drop = store.size - maxConversations;
  for (let i = 0; i < drop; i++) store.delete(entries[i][0]);
}

// Resolve the conversation binding for an incoming request.
// Returns { conversationId, matchedPrefixLength }:
//   conversationId       null when affinity is disabled or underivable
//   matchedPrefixLength  -1  explicit id（增量范围未知，调用方用启发式截取）
//                         0  未匹配到既有对话（本轮应发送完整历史）
//                        >0  命中既有对话，前 N 条消息上游已见过，增量从 N 起
export function getConversationBinding(req, messages) {
  if (!settings().enableConversationAffinity) return { conversationId: null, matchedPrefixLength: 0 };
  const explicit = req.headers['x-conversation-id'];
  if (explicit && typeof explicit === 'string' && explicit.trim()) {
    return { conversationId: explicit.trim(), matchedPrefixLength: -1 };
  }
  if (!Array.isArray(messages) || !messages.length) return { conversationId: null, matchedPrefixLength: 0 };

  const hashes = prefixMessageHashes(messages);
  const fullId = 'auto:' + hashes[hashes.length - 1];

  // 从最长前缀向短扫描：上一轮的全量数组是本轮的某个前缀，其哈希在
  // store 中登记过。命中后把条目迁移到本轮的全量哈希键下，供下一轮匹配。
  for (let i = hashes.length; i >= 1; i--) {
    const candidateId = 'auto:' + hashes[i - 1];
    const entry = store.get(candidateId);
    if (!entry) continue;
    if (candidateId !== fullId) {
      store.delete(candidateId);
      store.set(fullId, entry);
    }
    entry.lastSeen = now();
    return { conversationId: fullId, matchedPrefixLength: i };
  }

  return { conversationId: fullId, matchedPrefixLength: 0 };
}

// Legacy helper: resolve just the conversation id. Returns null when
// affinity is disabled or no id can be derived (e.g. empty messages).
export function getConversationId(req, messages) {
  return getConversationBinding(req, messages).conversationId;
}

// Decide whether this request should run in affinity mode, and if so return the
// continuation parameters (sessionId + parentMessageId). Creates/rotates the
// DeepSeek session lazily on first sight or when limits are hit.
//
//   modelType: the DeepSeek model_type for this request
//   token:     the DeepSeek bearer token acquired for THIS request (sessions are
//              per-token, so we must create/lookup with the same token)
//
// Returns { affinity: bool, sessionId, parentMessageId, promptMode }
//   promptMode 'latest'  -> caller sends only the new turn delta
//   promptMode 'full'    -> caller sends the full history（新建/轮换的会话没有
//                           任何历史，必须整体播种，否则上游丢失全部上下文）
export async function resolveConversation({ conversationId, modelType, token, createSessionFn = createSession }) {
  const current = settings();
  if (!current.enableConversationAffinity || !conversationId) {
    return { affinity: false, sessionId: null, parentMessageId: null, promptMode: 'full' };
  }

  evictExpired();
  enforceCapacity();

  const tokenPrefix = token.slice(0, 12);
  const existing = store.get(conversationId);
  const fresh = !existing
    || existing.tokenPrefix !== tokenPrefix;  // landed on a different token -> new session

  if (fresh) {
    // Lazily create a DeepSeek session bound to this token. Failure bubbles up
    // to the caller, which should fall back to full-history mode.
    const session = await createSessionFn(token, modelType);
    const entry = {
      sessionId: session.id,
      parentMessageId: null,
      tokenPrefix,
      modelType,
      createdAt: now(),
      lastSeen: now(),
      turns: 0,
    };
    store.set(conversationId, entry);
    // 新会话上游没有任何历史：本轮必须发送完整历史播种，下一轮再走增量。
    return { affinity: true, sessionId: entry.sessionId, parentMessageId: null, promptMode: 'full' };
  }

  existing.lastSeen = now();
  return { affinity: true, sessionId: existing.sessionId, parentMessageId: existing.parentMessageId, promptMode: 'latest' };
}

// Record the response_message_id emitted by the upstream stream so the NEXT
// turn can chain off it. Called from the SSE loop in openai.js.
export function recordResponseMessageId(conversationId, responseMessageId) {
  if (!settings().enableConversationAffinity || !conversationId || responseMessageId == null) return;
  const entry = store.get(conversationId);
  if (!entry) return;
  entry.parentMessageId = responseMessageId;
  entry.turns = (entry.turns || 0) + 1;
  entry.lastSeen = now();
}

export function recordResponseToolCalls(responseId, toolCalls = []) {
  if (!responseId || !Array.isArray(toolCalls) || toolCalls.length === 0) return;
  evictExpired();
  const existing = responseToolCallStore.get(responseId);
  const index = new Map(existing?.toolCalls instanceof Map ? existing.toolCalls : []);
  let recorded = false;
  for (const call of toolCalls) {
    const id = call?.id || call?.call_id;
    const name = call?.name || call?.function?.name;
    const args = call?.arguments ?? call?.function?.arguments ?? '{}';
    if (!id || !name) continue;
    const info = {
      name,
      arguments: typeof args === 'string' ? (args || '{}') : JSON.stringify(args ?? {}),
    };
    index.set(id, info);
    recentToolCallStore.set(id, { lastSeen: now(), ...info });
    recorded = true;
  }
  if (recorded) responseToolCallStore.set(responseId, { lastSeen: now(), toolCalls: index });
}

export function getResponseToolCallIndex(responseId) {
  if (!responseId) return new Map();
  evictExpired();
  const entry = responseToolCallStore.get(responseId);
  if (!entry) return new Map();
  entry.lastSeen = now();
  return new Map(entry.toolCalls);
}

export function getRecentToolCallIndex(toolCallIds = []) {
  evictExpired();
  const index = new Map();
  for (const id of toolCallIds || []) {
    if (!id) continue;
    const entry = recentToolCallStore.get(id);
    if (!entry) continue;
    entry.lastSeen = now();
    index.set(id, { name: entry.name, arguments: entry.arguments });
  }
  return index;
}

// Invalidate a conversation (e.g. when its token gets disabled/refreshed).
export function invalidateConversation(conversationId) {
  if (conversationId) store.delete(conversationId);
}

// Invalidate all conversations bound to a token prefix (used after token refresh).
export function invalidateByTokenPrefix(tokenPrefix) {
  if (!tokenPrefix) return;
  for (const [id, e] of store) {
    if (e.tokenPrefix === tokenPrefix) store.delete(id);
  }
}

export function getConversationInfo() {
  const current = settings();
  if (!current.enableConversationAffinity) return { enabled: false };
  let oldest = Infinity;
  for (const e of store.values()) oldest = Math.min(oldest, e.lastSeen);
  return {
    enabled: true,
    active: store.size,
    maxConversations: current.maxConversations,
    ttlMs: current.conversationTtlMs,
  };
}
