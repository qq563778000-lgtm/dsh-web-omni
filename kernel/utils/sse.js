import {
  setRequestToken,
  reportTokenError,
  reportTokenSuccess,
  reportTokenRateLimited,
  hasAlternativeToken,
  disableToken,
  getPoolInfo,
  getAliveTokens,
  CREDENTIAL_DISABLE_DEFAULT_MS,
} from '../services/auth.js';
import { solvePowChallengeWithToken } from './pow.js';
import { classifyUpstreamCode } from './upstream-errors.js';
import { getSession, invalidateTokenSessions } from '../services/session.js';
import { invalidateByTokenPrefix } from '../services/conversation.js';
import { streamHeaders, proxiedFetch } from './headers.js';
import { enqueueRequest, dispatchQueued } from '../services/queue.js';

const BASE_URL = 'https://chat.deepseek.com';

// 单次请求最多尝试的凭据数。避免池很大时把每个凭据都撞一遍。
const CREDENTIAL_FAILOVER_LIMIT = 3;

/**
 * 判定一个上游错误是否"换一个凭据就可能成功"。
 *
 * 集中判定而非逐个函数打标记，避免遗漏：凭据失效（40003 无效、账号封禁、
 * 会话创建被拒）与凭据被临时限制（429 限流、biz_code=5 禁言、40301 会话限流）
 * 都属于此类；而参数错误、模型不支持等换了凭据也无用，不应触发转移。
 *
 * 判定顺序是"结构化标记优先，文案正则兜底"。
 *
 * 为什么必须优先看结构化标记：旧实现只有正则，而 PoW 阶段抛出的错误文案
 * （'PoW challenge failed: no challenge returned'）不含任何关键词，于是
 * 明确失效的凭据被判定为"换凭据无用"，请求直接失败——即使池里还有可用凭据。
 * 现在 pow.js 会带上 credentialFailover / credentialInvalid / upstreamCode，
 * 结构化路径不依赖文案措辞。正则保留给尚未接入 upstream-errors 的历史错误源。
 */
export function isCredentialRelatedError(err) {
  if (!err) return false;
  if (err.credentialFailover === true || err.credentialInvalid === true) return true;

  const code = err.upstreamCode;
  if (code !== null && code !== undefined) {
    const semantics = classifyUpstreamCode(code);
    if (semantics.credentialFailover) return true;
  }

  const message = String(err.message || '');
  return /token invalid|40003|account banned|40004|banned|requires verification|session create failed/i.test(message)
    || /rate limit|429|muted|biz_code=5|40301/i.test(message);
}

function deepSeekErrorMessage(json, fallback = 'DeepSeek error') {
  const biz = json?.data;
  const code = json?.code ?? biz?.biz_code;
  const msg = json?.msg || biz?.biz_msg || fallback;
  return { code, message: msg };
}

export function isInvalidChatSessionError(code, message) {
  return String(code) === '0' && /invalid chat session id/i.test(String(message || ''));
}

async function invalidateTokenRuntimeState(token) {
  const tokenPrefix = token.slice(0, 12);
  invalidateTokenSessions(tokenPrefix);
  invalidateByTokenPrefix(tokenPrefix);
}

/**
 * 禁言类不可用：禁用**而非删除**，并清掉该 token 的会话缓存。
 * 以前这里直接置死（随后被人删除），导致风控结束后无从恢复。
 */
async function markTokenUnavailable(token, options = {}) {
  disableToken(token, {
    reason: options.reason || '上游禁言',
    disabledUntil: options.disabledUntil || Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS,
    source: 'auto',
    detail: options.upstream || null,
    eventType: options.eventType || 'credential_disabled',
  });
  await invalidateTokenRuntimeState(token);
}

function isDeepSeekJsonError(json) {
  return json?.code !== undefined || json?.data?.biz_code !== undefined || json?.data?.biz_msg;
}

/**
 * 归一化上游的 mute_until 为毫秒时间戳。上游可能给秒级、毫秒级或字符串，
 * 也可能给已过去的时刻（此时返回 0，由调用方回落到默认禁期）。
 */
function normalizeMuteUntil(value) {
  if (value == null || value === '') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  // 秒级时间戳（约 1e9~1e10）换算为毫秒；已是毫秒级则原样使用。
  const ms = parsed < 1e12 ? parsed * 1000 : parsed;
  return ms > Date.now() ? ms : 0;
}

async function throwDeepSeekErrorFromJson(json, slot) {
  const { code, message } = deepSeekErrorMessage(json);

  if (!isDeepSeekJsonError(json)) return;

  // 上游原始报文的精简快照，随事件落盘供事后归因。
  // 只取关键字段而非整个 json：避免把无关内容（甚至对话片段）写进日志。
  const upstream = {
    code: code ?? null,
    bizCode: json?.data?.biz_code ?? null,
    bizMsg: json?.data?.biz_msg ?? null,
    msg: json?.msg ?? null,
    muteUntil: json?.data?.biz_data?.mute_until ?? null,
  };

  if (code === 40003) {
    // token 失效：先让它累计错误（保留原有"多次失败才淘汰"的语义），
    // 达到阈值由 reportTokenError 统一转禁用；这里不再直接置死。
    reportTokenError(slot.token);
    throw new Error('Token invalid (40003)');
  }
  if (code === 40004) {
    const entry = getPoolInfo().find(t => slot.token.startsWith(t.token.replace('...', '')));
    console.error(`Account BANNED during completion: ${entry?.email || slot.token.slice(0, 12)}...`);
    await markTokenUnavailable(slot.token, { reason: '账号被封禁 (40004)', upstream, eventType: 'banned' });
    throw new Error('Account banned (40004)');
  }
  if (code === 40301) {
    await invalidateTokenRuntimeState(slot.token);
    // 上游会话级限流：换一个凭据（新会话）可能即可绕过，标记可故障转移。
    // 注意与"禁言"的区别：40301 是会话级临时限制，凭据本身仍可用，故不禁用。
    const err = new Error('Session rate limited (40301) — sessions rotated');
    err.credentialFailover = true;
    throw err;
  }
  if (isInvalidChatSessionError(code, message)) {
    await invalidateTokenRuntimeState(slot.token);
    const err = new Error('DeepSeek invalid chat session id — session cache invalidated');
    err.retryableInvalidSession = true;
    throw err;
  }
  if (code === 429) {
    // 上游限流：给该凭据设置冷却窗口并换其它凭据重试。
    reportTokenRateLimited(slot.token, upstream);
    const err = new Error('Rate limited (429)');
    err.credentialFailover = true;
    throw err;
  }
  if (code === 5 || json?.data?.biz_code === 5) {
    // 禁言：上游通常给出 mute_until（秒或毫秒时间戳），优先按它设置禁期；
    // 缺失时回落到默认 3 天。禁期内不再重登该账号，避免加重风控。
    const rawUntil = json?.data?.biz_data?.mute_until;
    const muteUntilMs = normalizeMuteUntil(rawUntil);
    await markTokenUnavailable(slot.token, {
      reason: `账号被禁言${rawUntil ? `（至 ${rawUntil}）` : ''}`,
      disabledUntil: muteUntilMs || Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS,
      upstream,
      eventType: 'muted',
    });
    const err = new Error(`DeepSeek user muted (biz_code=5)${rawUntil ? ` until ${rawUntil}` : ''}: ${message}`);
    err.credentialFailover = true;
    throw err;
  }

  throw new Error(`DeepSeek error${code != null ? ` ${code}` : ''}: ${message}`);
}

// resolveSession(token): optional async hook. When provided (conversation-affinity
// mode), it is called AFTER the token slot is acquired and must return
// { sessionId, parentMessageId, affinity }. When omitted, a session is
// acquired/rotated via getSession and parentMessageId defaults to null (legacy
// behaviour).
// getPrompt(affinity): optional sync hook returning the prompt string to send,
// chosen based on whether affinity engaged. When omitted, the `prompt` arg is
// used as-is. This keeps prompt selection sequenced after session resolution.
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  throw err;
}

/**
 * 当前池中可参与调度的凭据数。
 *
 * 用 getAliveTokens（未禁用且有 token）而不是 getPoolInfo：后者含禁用条目，
 * 会高估上限；而被本次请求禁用的凭据在下一次计算时已不在此集合内，
 * 这正是"上限随失效逐步收敛"所需要的。
 */
function countAvailableTokens() {
  try {
    return getAliveTokens().length;
  } catch {
    return 0;
  }
}

export async function completion({ modelType, prompt, thinkingEnabled = false, searchEnabled = false, parentMessageId = null, refFileIds = [], preferVision = false, resolveSession = null, getPrompt = null, signal = null, initialSlot = null, preferredTokenPrefix = null }) {
  throwIfAborted(signal);

  // 凭据级故障转移：一个凭据被限流/失效时，换池中其它凭据重试，
  // 而不是把错误直接抛给客户端。多配凭据的价值正在于此。
  //
  // 上限取 max(CREDENTIAL_FAILOVER_LIMIT, 池中可用凭据数)。
  //
  // 为什么不能固定用 CREDENTIAL_FAILOVER_LIMIT：实测 9 个凭据里前 8 个
  // 已失效时，固定上限 3 会导致第 4 次之后就放弃，**唯一可用的那个凭据
  // 永远轮不到**——用户看到的是"配了 9 个账号却一个都用不了"。
  // 失效凭据会被本次请求就地禁用，因此按当前可用数取上限不会造成
  // 无限循环：每轮要么成功，要么把该轮凭据移出可用集。
  const attemptLimit = Math.max(CREDENTIAL_FAILOVER_LIMIT, countAvailableTokens());
  const attemptedTokens = new Set();
  let lastErr = null;

  for (let credentialAttempt = 0; credentialAttempt < attemptLimit; credentialAttempt++) {
    throwIfAborted(signal);

    // Step 1: Acquire token slot first — PoW and completion must use the same token
    let slot;
    if (initialSlot) {
      // 调用方已持有 slot（例如附件上传已用该凭据取得 file_id）。
      // 上游的 file_id 与账号绑定，上传与补全必须同一凭据，否则报
      // "invalid ref file id"。这里只消费一次，后续轮次正常取池。
      slot = initialSlot;
      initialSlot = null;
    } else {
      try {
        // 偏好凭据只在首次尝试生效。
        //
        // 后续的 credentialAttempt 是故障转移轮——上一轮刚因限流/失效失败，
        // 此时再传偏好会把同一个凭据重新选回来（它可能仍"可用"但已被限流），
        // 转移也就失去意义。回退到普通调度，由轮转挑一个不同的凭据。
        slot = await enqueueRequest(
          preferVision,
          undefined,
          credentialAttempt === 0 ? preferredTokenPrefix : null,
        );
      } catch (err) {
        // 池中已无可分配凭据：若之前有失败记录，把原因一并抛出便于排查。
        if (lastErr) {
          throw new Error(`${lastErr.message}（池中已无其它可用凭据）`);
        }
        throw err;
      }
    }

    // 选到的凭据本轮已试过（池中可用凭据少于尝试上限）——不再重复试。
    if (attemptedTokens.has(slot.token)) {
      slot.release();
      dispatchQueued();
      break;
    }
    attemptedTokens.add(slot.token);

    try {
      const result = await completionWithToken(slot, {
        modelType, prompt, thinkingEnabled, searchEnabled, parentMessageId,
        refFileIds, preferVision, resolveSession, getPrompt, signal,
      });
      return result;
    } catch (err) {
      slot.release();
      dispatchQueued();

      // 凭据已被上游确定为不可用（40003/40004）：立即禁用，避免后续请求
      // 继续命中它。旧实现只在补全阶段识别这类错误，PoW 阶段抛出的错误
      // 到达这里时已经丢掉了 40003，坏凭据会一直被分配——实测池中 8/9
      // 失效却仍参与调度。
      //
      // 用 disableToken 而非删除：与既有的"禁用可恢复"语义一致，
      // 到期由 healthCheck 探测恢复，后台可见、可手动启用。
      if (err?.credentialInvalid === true) {
        disableToken(slot.token, {
          reason: `上游判定凭据失效（${err.upstreamCode ?? 'unknown'}）`,
          disabledUntil: Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS,
          source: 'auto',
          detail: err.upstream ?? null,
        });
      }

      // 仅"换凭据可能解决"的错误才继续；其它错误（参数错误、模型不支持等）
      // 换了凭据也无用，直接抛出。判定集中在 isCredentialRelatedError，
      // 避免某个错误分支漏打标记导致明明还有可用凭据却直接失败。
      if (isCredentialRelatedError(err) && hasAlternativeToken(slot.token)) {
        lastErr = err;
        console.warn(
          `[DeepSeek] 凭据 ${slot.token.slice(0, 12)}... 不可用（${err.message}），`
          + `切换到其它凭据重试（第 ${credentialAttempt + 2} 次）`,
        );
        continue;
      }
      throw err;
    }
  }

  // 所有可用凭据都试过或都在冷却中。给最终错误带上正确的 HTTP 语义，
  // 便于客户端区分"限流稍后重试"(429) 与"上游故障"(502)。
  if (lastErr) {
    if (!lastErr.status) {
      const limited = /rate limit|429|muted|biz_code=5/i.test(lastErr.message || '');
      lastErr.status = limited ? 429 : 502;
      lastErr.type = limited ? 'rate_limit_error' : 'api_error';
      lastErr.retryable = limited;
    }
    throw lastErr;
  }
  throw new Error('No usable credential available');
}

/**
 * 用单个已获取的 slot 完成一次补全请求。
 * 内部保留原有的"会话失效重试一次"逻辑（同一凭据内）。
 * 限流类错误会带上 credentialFailover 标记，交由外层换凭据。
 */
async function completionWithToken(slot, { modelType, prompt, thinkingEnabled, searchEnabled, parentMessageId, refFileIds, preferVision, resolveSession, getPrompt, signal }) {
  try {
    throwIfAborted(signal);
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Step 2: Solve PoW using the same token. Retry attempts resolve a new
        // session after the stale one has been invalidated.
        throwIfAborted(signal);
        const { powResponse } = await solvePowChallengeWithToken(slot.token);
        throwIfAborted(signal);

        let sessionIdFinal;
        let parentMessageIdFinal = parentMessageId;
        let affinity = false;
        if (resolveSession) {
          // Affinity mode: the caller decides which session + parent to use,
          // bound to the token that was just acquired.
          const resolved = await resolveSession(slot.token);
          throwIfAborted(signal);
          sessionIdFinal = resolved.sessionId;
          parentMessageIdFinal = resolved.parentMessageId;
          affinity = !!resolved.affinity;
        } else {
          setRequestToken(slot.token);
          try {
            const session = await getSession(slot.token, modelType);
            throwIfAborted(signal);
            sessionIdFinal = session.id;
          } finally {
            setRequestToken(null);
          }
        }

        throwIfAborted(signal);
        const promptFinal = getPrompt ? getPrompt(affinity) : prompt;

        const body = {
          chat_session_id: sessionIdFinal,
          parent_message_id: parentMessageIdFinal,
          model_type: modelType,
          prompt: promptFinal,
          ref_file_ids: refFileIds,
          thinking_enabled: thinkingEnabled,
          search_enabled: searchEnabled,
          action: null,
          preempt: false,
        };

        const headers = await streamHeaders(slot.token, powResponse);
        throwIfAborted(signal);
        const res = await proxiedFetch(`${BASE_URL}/api/v0/chat/completion`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const text = await res.text();
          try {
            await throwDeepSeekErrorFromJson(JSON.parse(text), slot);
          } catch (err) {
            if (err instanceof SyntaxError) throw new Error(`Completion request returned invalid JSON: ${text}`);
            throw err;
          }
        }

        if (!res.ok) {
          const text = await res.text();
          // Check for specific DeepSeek error codes
          try {
            await throwDeepSeekErrorFromJson(JSON.parse(text), slot);
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) {
              throw new Error(`Completion request failed: ${res.status} ${text}`);
            }
            throw parseErr;
          }
        }

        // DeepSeek sometimes returns HTTP 200 + text/event-stream but the body is a plain JSON error,
        // e.g. {"code":0,"data":{"biz_code":5,"biz_msg":"user is muted"}}.
        // Probe the first chunk so those errors are surfaced instead of being parsed as an empty SSE stream.
        throwIfAborted(signal);
        const reader = res.body.getReader();
        const first = await reader.read();
        if (first.done) {
          reader.releaseLock();
          // 空流必须可故障转移。
          //
          // 真实故障（2026-10-30 DSH 日志）：长对话第 5 步上游返回空流，
          // 凭据池里还有可用凭据，但该错误被判为"换凭据也没用"，
          // 于是只做一次续写就抛 EMPTY_RESPONSE，整个任务终结。
          //
          // 而 runner 侧的注释明确写着空流的第一种成因是"该凭据被静默限制"
          // ——这正是换凭据能解决的。实测同一账号池中常有部分凭据被静默限流、
          // 其它正常，因此必须进入故障转移。
          //
          // 若真是 IP 级限流，换凭据也无用，但那种情况由 noteEmptyReply 的
          // 连续计数在 runner 侧判定并全局冷却，不依赖此处的放弃。
          const emptyErr = new Error('Completion stream ended before any data');
          emptyErr.credentialFailover = true;
          throw emptyErr;
        }

        const firstText = new TextDecoder().decode(first.value, { stream: true }).trim();
        if (firstText.startsWith('{')) {
          try {
            await throwDeepSeekErrorFromJson(JSON.parse(firstText), slot);
          } catch (err) {
            if (!(err instanceof SyntaxError)) {
              try { await reader.cancel(); } catch {}
              try { reader.releaseLock(); } catch {}
              throw err;
            }
          }
        }

        const bodyWithFirstChunk = new ReadableStream({
          start(controller) {
            controller.enqueue(first.value);
            const pump = () => reader.read().then(({ done, value }) => {
              if (done) {
                reader.releaseLock();
                controller.close();
                return;
              }
              controller.enqueue(value);
              return pump();
            }).catch(err => {
              try { reader.releaseLock(); } catch {}
              controller.error(err);
            });
            return pump();
          },
          cancel(reason) {
            return reader.cancel(reason).finally(() => {
              try { reader.releaseLock(); } catch {}
            });
          },
        });

        reportTokenSuccess(slot.token);
        return { body: bodyWithFirstChunk, slot };
      } catch (err) {
        setRequestToken(null);
        lastErr = err;
        if (err?.retryableInvalidSession && attempt === 0) {
          console.warn(`[DeepSeek] Invalid chat session for ${slot.token.slice(0, 12)}..., refreshing session and retrying once`);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  } catch (err) {
    setRequestToken(null);
    // slot 由外层持有并负责释放，这里只清理请求态。
    throw err;
  }
}

export async function* parseSSEStream(body, { signal = null } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let messageIds = {};
  let currentFragmentType = null;
  const fragmentTypes = new Map();
  let nextFragmentIndex = 0;

  function rememberFragmentType(index, type) {
    if (index == null || !type) return;
    fragmentTypes.set(index, type);
    if (index >= nextFragmentIndex) nextFragmentIndex = index + 1;
    currentFragmentType = type;
  }

  function lastKnownFragmentType() {
    if (!fragmentTypes.size) return currentFragmentType;
    const lastIndex = Math.max(...fragmentTypes.keys());
    return fragmentTypes.get(lastIndex) || currentFragmentType;
  }

  function fragmentTypeForPath(path) {
    const match = String(path || '').match(/^(?:response\/)?fragments\/(-?\d+)\/(?:content|status)$/);
    if (!match) return currentFragmentType;
    const rawIndex = Number(match[1]);
    const index = rawIndex < 0 ? Math.max(...fragmentTypes.keys(), 0) : rawIndex;
    const known = fragmentTypes.get(index);
    if (known) return known;

    // DeepSeek often streams the RESPONSE fragment content as
    // response/fragments/1/content immediately after a THINK-only prelude,
    // without first sending a fragment metadata APPEND for index 1. If we keep
    // using the previous global THINK state, the first answer delta is emitted as
    // reasoning and disappears from clients that only display text content.
    if (index > 0 && currentFragmentType === 'THINK') {
      rememberFragmentType(index, 'RESPONSE');
      return 'RESPONSE';
    }

    return currentFragmentType;
  }
  const abortReader = () => {
    try { reader.cancel(new Error('aborted')); } catch {}
  };
  if (signal?.aborted) abortReader();
  else if (signal?.addEventListener) signal.addEventListener('abort', abortReader, { once: true });

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        const leftover = buffer.trim();
        if (leftover.startsWith('{')) {
          try {
            const parsed = JSON.parse(leftover);
            const { code, message } = deepSeekErrorMessage(parsed);
            yield { type: 'error', code, message };
          } catch {}
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          if (line.slice(6).trim() === 'close') return;
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);

          // Check for error codes mid-stream
          if (parsed.code === 40003) {
            yield { type: 'error', code: 40003, message: 'Token invalid' };
            return;
          }
          if (parsed.code === 40004) {
            yield { type: 'error', code: 40004, message: 'Account banned' };
            return;
          }
          if (parsed.code === 40301) {
            yield { type: 'error', code: 40301, message: 'Session rate limited' };
            return;
          }
          if (parsed.data?.biz_code) {
            yield { type: 'error', code: parsed.data.biz_code, message: parsed.data.biz_msg || 'DeepSeek biz error' };
            return;
          }

          if (parsed.request_message_id != null) {
            messageIds.requestMessageId = parsed.request_message_id;
            messageIds.responseMessageId = parsed.response_message_id;
          }

          let emitted = false;

          if (parsed.v?.response?.fragments) {
            for (const [index, frag] of parsed.v.response.fragments.entries()) {
              if (frag.type === 'THINK') {
                rememberFragmentType(index, 'THINK');
                if (frag.content) {
                  yield { type: 'thinking', content: frag.content, messageIds };
                  emitted = true;
                }
              } else if (frag.type === 'RESPONSE') {
                rememberFragmentType(index, 'RESPONSE');
                if (frag.content) {
                  yield { type: 'content', content: frag.content, messageIds };
                  emitted = true;
                }
              }
            }
            if (parsed.v.response.accumulated_token_usage != null) {
              yield { type: 'usage', usage: parsed.v.response.accumulated_token_usage, messageIds };
            }
          }

          const contentPathRx = /^(?:response\/)?fragments\/-?\d+\/content$/;
          const statusPathRx = /^(?:response\/)?fragments\/-?\d+\/status$/;

          if (parsed.p && parsed.o) {
            if (contentPathRx.test(parsed.p) && typeof parsed.v === 'string') {
              const fragmentType = fragmentTypeForPath(parsed.p);
              yield { type: fragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
              emitted = true;
            } else if (/^(?:response\/)?status$/.test(parsed.p) && parsed.v === 'FINISHED') {
              yield { type: 'done', messageIds };
            } else if (statusPathRx.test(parsed.p) && parsed.v === 'FINISHED') {
              yield { type: 'done', messageIds };
            } else if (/^response$/.test(parsed.p) && parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
              for (const item of parsed.v) {
                if (item.p === 'accumulated_token_usage') {
                  yield { type: 'usage', usage: item.v, messageIds };
                }
              }
            } else if (/^(?:response\/)?fragments$/.test(parsed.p) && parsed.o === 'APPEND' && Array.isArray(parsed.v)) {
              for (const frag of parsed.v) {
                const index = nextFragmentIndex;
                if (frag.type === 'RESPONSE') {
                  rememberFragmentType(index, 'RESPONSE');
                  if (frag.content) {
                    yield { type: 'content', content: frag.content, messageIds };
                    emitted = true;
                  }
                } else if (frag.type === 'THINK') {
                  rememberFragmentType(index, 'THINK');
                  if (frag.content) {
                    yield { type: 'thinking', content: frag.content, messageIds };
                    emitted = true;
                  }
                }
              }
            }
            // Catch-all inside p&&o: if v is a non-control string that didn't
            // match known paths, yield it as content. This handles alternative
            // path formats that different model types may use.
            if (!emitted && typeof parsed.v === 'string' && !/^(FINISHED|SEARCH|BATCH|CANCEL|DONE)$/i.test(parsed.v)) {
              yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
              emitted = true;
            }
            continue;
          }

          // Content deltas with p set but o missing/falsy.
          if (contentPathRx.test(parsed.p) && typeof parsed.v === 'string') {
            const fragmentType = fragmentTypeForPath(parsed.p);
            yield { type: fragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
            emitted = true;
          }

          // FINISHED without o field — flexible path matching.
          if (/^(?:response\/)?status$/.test(parsed.p) && parsed.v === 'FINISHED') {
            yield { type: 'done', messageIds };
          }
          if (statusPathRx.test(parsed.p) && parsed.v === 'FINISHED') {
            yield { type: 'done', messageIds };
          }

          // Content deltas with NO `p` field are plain text chunks.
          // If a direct `type` field is present (e.g. {"v":"text","type":"THINK"}),
          // use it to set currentFragmentType. Otherwise rely on the tracked state.
          if (typeof parsed.v === 'string' && !parsed.p) {
            const inlineType = parsed.type === 'THINK' ? 'THINK' : parsed.type === 'RESPONSE' ? 'RESPONSE' : null;
            if (inlineType) currentFragmentType = inlineType;
            yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
            emitted = true;
          }

          if (Array.isArray(parsed.v)) {
            for (const item of parsed.v) {
              if (item.p === 'accumulated_token_usage') {
                yield { type: 'usage', usage: item.v, messageIds };
              }
            }
          }

          // OpenAI-style delta format (some model types return this directly):
          // {"choices":[{"delta":{"content":"..."}}]}
          // {"choices":[{"delta":{"reasoning_content":"..."}}]}
          if (Array.isArray(parsed.choices) && parsed.choices[0]?.delta) {
            const delta = parsed.choices[0].delta;
            if (typeof delta.reasoning_content === 'string') {
              currentFragmentType = 'THINK';
              yield { type: 'thinking', content: delta.reasoning_content, messageIds };
              emitted = true;
            } else if (typeof delta.content === 'string') {
              currentFragmentType = 'RESPONSE';
              yield { type: 'content', content: delta.content, messageIds };
              emitted = true;
            }
            if (parsed.choices[0].finish_reason === 'stop') {
              yield { type: 'done', messageIds };
            }
            if (parsed.choices[0].finish_reason === 'tool_calls') {
              yield { type: 'done', messageIds };
            }
          }

          // Direct finish_reason at top level (alternative format).
          if (parsed.finish_reason === 'stop' || parsed.finish_reason === 'tool_calls') {
            yield { type: 'done', messageIds };
          }

          // === Universal content fallback ===
          // If v is a plain string that reached here (no path matched, no p field,
          // not handled by any format-specific branch above), emit it generically.
          // This catches format variations across model types.
          if (!emitted && typeof parsed.v === 'string' && parsed.v.length > 0 && !/^(FINISHED|SEARCH|BATCH|CANCEL|DONE|stop)$/i.test(parsed.v)) {
            yield { type: currentFragmentType === 'THINK' ? 'thinking' : 'content', content: parsed.v, messageIds };
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  } finally {
    if (signal?.removeEventListener) signal.removeEventListener('abort', abortReader);
    reader.releaseLock();
  }
}
