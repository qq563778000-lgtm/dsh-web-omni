import { getConfig } from '../../services/config-store.js';
import { completion, parseSSEStream } from '../../utils/sse.js';
import { resolveUploadableToRefId } from '../../services/upload.js';
import { enqueueRequest, dispatchQueued } from '../../services/queue.js';
import { getConversationBinding, getRecentToolCallIndex, getResponseToolCallIndex, resolveConversation, recordResponseMessageId } from '../../services/conversation.js';
import {
  buildLatestPrompt,
  buildPromptFromMessages,
  latestDeltaStartIndex,
} from '../../utils/response-utils.js';
import { createPromptPlan } from '../../core/prompt-strategy.js';
import {
  attemptToolParseWithRetry,
  getMissingToolCallRetryPrompt,
  getReasoningOnlyRetryPrompt,
  isEmptyAssistantReply,
  isMissingToolCallIntent,
} from '../../core/tool-retry.js';
import { preprocessMessagesForToolify } from '../../core/toolify-format.js';
import { collectParsedStreamContent } from '../common-internal-runner.js';
import { collectUploadableParts, hasUploadableParts } from '../../utils/message-files.js';
import { mapModel } from './models.js';
import {
  CREDENTIAL_DISABLE_DEFAULT_MS,
  disableToken,
  getIpThrottleRemainingMs,
  isIpThrottled,
  noteEmptyReply,
  noteSuccessfulReply,
  reportTokenError,
  reportTokenRateLimited,
} from '../../services/auth.js';
import { recordUsage } from '../../middleware/metrics.js';
import { InternalAPIError } from '../../core/errors.js';
import {
  createMessageDone,
  createMessageStarted,
  createReasoningDelta,
  createReasoningDone,
  createRunCompleted,
  createRunStarted,
  createTextDelta,
  createTextDone,
  createToolCallArgumentsDelta,
  createToolCallDone,
  createToolCallStarted,
  createUsageUpdated,
} from '../../core/internal-events.js';
import {
  createInternalId,
  internalMessagesToOpenAI,
  internalToolChoiceToOpenAI,
  internalToolsToOpenAI,
} from '../../core/internal-request.js';

async function extractUploads(messages, token) {
  const refFileIds = [];
  for (const file of collectUploadableParts(messages)) {
    try {
      const fileId = await resolveUploadableToRefId(file, token);
      refFileIds.push(fileId);
    } catch (err) {
      console.error('File upload failed:', err.message);
    }
  }
  return refFileIds;
}

function promptWithToolInstructions(messages, toolInstructions) {
  return (buildPromptFromMessages(messages).trim() + (toolInstructions || '')).trim();
}

function latestPromptWithToolInstructions(messages, toolInstructions) {
  return (buildLatestPrompt(messages).trim() + (toolInstructions || '')).trim();
}

function openAIMessagesFromInternal(internalRequest) {
  const messages = [];
  if (internalRequest.instructions?.system) {
    messages.push({ role: 'system', content: internalRequest.instructions.system });
  }
  if (internalRequest.instructions?.developer) {
    messages.push({ role: 'system', content: internalRequest.instructions.developer });
  }
  messages.push(...internalMessagesToOpenAI(internalRequest.messages));
  return messages;
}

function getRequestLike(internalRequest, context) {
  return context?.req || {
    body: internalRequest.raw?.body || {},
    headers: internalRequest.metadata?.headers || {},
    omni: {
      promptInjectionEnabled: internalRequest.metadata?.promptInjectionEnabled,
      rawRequestJsonText: internalRequest.raw?.rawJsonText,
    },
  };
}

function usageOutputTokens(usage) {
  if (typeof usage === 'number') return usage;
  return usage?.output_tokens ?? usage?.completion_tokens ?? usage?.total_tokens ?? 0;
}

function emitToolCallEvents({ requestId, responseId, messageId, toolCalls }) {
  const events = [];
  for (let index = 0; index < toolCalls.length; index++) {
    const call = toolCalls[index];
    const id = call.id || createInternalId('call');
    const name = call.function?.name || call.name;
    const args = call.function?.arguments ?? call.arguments ?? '{}';
    events.push(createToolCallStarted({ requestId, responseId, messageId, toolCallId: id, index, name }));
    if (args) events.push(createToolCallArgumentsDelta({ requestId, responseId, messageId, toolCallId: id, index, delta: args }));
    events.push(createToolCallDone({ requestId, responseId, messageId, toolCallId: id, index, name, arguments: args || '{}' }));
  }
  return events;
}

function prefixBeforeBufferedToolText(processed) {
  const delta = processed?.delta || '';
  const buffered = processed?.bufferedToolText || '';
  if (!delta || !buffered) return delta;
  return delta.endsWith(buffered) ? delta.slice(0, delta.length - buffered.length) : delta;
}

export async function* runDeepSeek(internalRequest, context = {}) {
  const req = getRequestLike(internalRequest, context);
  const requestedModel = internalRequest.model?.normalized || internalRequest.model?.requested;
  const modelType = mapModel(requestedModel);
  const requestId = internalRequest.id;
  const responseId = context.responseId || createInternalId('resp');
  const messageId = createInternalId('msg');

  // IP 级限流冷却期：快速失败并明确报 429，不再打上游。
  // 实测该限制与账号/凭据无关（3 个不同账号同时受限、14 分钟未恢复），
  // 继续请求只会加重限流；明确报错让客户端自行退避。
  if (isIpThrottled()) {
    const remainingSec = Math.ceil(getIpThrottleRemainingMs() / 1000);
    throw new InternalAPIError(
      `上游对当前出口 IP 限流（消息发送过于频繁），约 ${remainingSec} 秒后解除。`
      + `该限制与账号凭据无关，更换凭据无效；如需立即恢复请更换出口 IP（配置 HTTPS_PROXY）。`,
      { status: 429, type: 'rate_limit_error', code: 'ip_rate_limited', retryable: true },
    );
  }

  const openAIMessages = openAIMessagesFromInternal(internalRequest);
  const promptPlan = createPromptPlan({
    req,
    tools: internalToolsToOpenAI(internalRequest.tools),
    toolChoice: internalToolChoiceToOpenAI(internalRequest.toolChoice),
  });
  const {
    promptInjectionDisabled,
    disabledPrompt,
    toolCallingEnabled,
    toolInstructions,
    triggerSignal,
  } = promptPlan;
  const toolResultIds = openAIMessages
    .filter(message => message?.role === 'tool')
    .map(message => message.tool_call_id || message.toolCallId)
    .filter(Boolean);
  const previousToolCalls = new Map([
    ...getResponseToolCallIndex(internalRequest.conversation?.previousResponseId),
    ...getRecentToolCallIndex(toolResultIds),
  ]);
  const promptMessages = promptInjectionDisabled
    ? openAIMessages
    : preprocessMessagesForToolify(openAIMessages, triggerSignal, previousToolCalls);

  // 最后一条 user 文本：用于"只思考未作答"恢复时向模型重述原始请求。
  const lastUserText = (() => {
    for (let i = openAIMessages.length - 1; i >= 0; i--) {
      const message = openAIMessages[i];
      if (message?.role !== 'user') continue;
      const content = message.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n');
      }
    }
    return '';
  })();

  const fullPrompt = promptInjectionDisabled
    ? disabledPrompt
    : promptWithToolInstructions(promptMessages, toolInstructions);

  const binding = getConversationBinding(req, openAIMessages);
  const explicitConversationId = internalRequest.conversation?.id
    || (getConfig().runtime.enableConversationAffinity ? internalRequest.conversation?.previousResponseId : null);
  const conversationId = explicitConversationId || binding.conversationId;
  // 显式指定会话 ID 时增量范围未知，退回启发式截取（最后一条 assistant 之后）。
  const matchedPrefixLength = explicitConversationId ? -1 : binding.matchedPrefixLength;

  // preprocessMessagesForToolify 逐条 1:1 映射，openAIMessages 的前缀匹配
  // 下标可以直接用于 promptMessages。
  const deltaStart = promptInjectionDisabled ? null : latestDeltaStartIndex(promptMessages, matchedPrefixLength);
  const latestPrompt = promptInjectionDisabled
    ? fullPrompt
    : deltaStart != null
      ? promptWithToolInstructions(promptMessages.slice(deltaStart), toolInstructions)
      : latestPromptWithToolInstructions(promptMessages, toolInstructions);

  const thinkingEnabled = internalRequest.generation?.reasoning?.enabled ?? req.body?.thinking_enabled ?? true;
  // DeepSeek Web search may return planning/thinking without a final answer;
  // default it off for API determinism unless the caller explicitly opts in.
  const searchEnabled = req.body?.search_enabled ?? false;
  const requestStart = Date.now();

  let streamBody;
  let slot;
  let clientGone = false;
  const abortController = new AbortController();
  let onClose = null;
  const responseStream = context?.res;
  if (responseStream?.on) {
    onClose = () => {
      clientGone = true;
      abortController.abort();
      try { streamBody?.cancel(); } catch {}
    };
    responseStream.on('close', onClose);
  }

  // 模型合并后唯一模型即具备视觉能力，上传型内容直接走视觉 slot。
  //
  // 关键：上传与补全必须用同一个凭据。上游的 file_id 绑定账号，若上传用
  // A 而补全取到 B，会报 "invalid ref file id"。因此这里不释放 slot，
  // 而是把它交给 completion 继续使用（用完由 completion 负责释放）。
  let refFileIds = [];
  let uploadSlot = null;
  if (hasUploadableParts(openAIMessages)) {
    uploadSlot = await enqueueRequest(true);
    try {
      refFileIds = await extractUploads(openAIMessages, uploadSlot.token);
    } catch (err) {
      uploadSlot.release();
      dispatchQueued();
      uploadSlot = null;
      throw err;
    }
  }

  try {
    const makeResolveSession = (activeModelType) => conversationId
      ? async (token) => {
          const resolved = await resolveConversation({ conversationId, modelType: activeModelType, token });
          // fresh/轮换的会话（promptMode 'full'）没有历史，必须按全量模式发送，
          // 因此只有既有会话续传时才把 affinity 报告为 true（getPrompt 据此选增量）。
          return {
            sessionId: resolved.sessionId,
            parentMessageId: resolved.parentMessageId,
            affinity: resolved.affinity && resolved.promptMode === 'latest',
          };
        }
      : null;
    const getPrompt = (affinity) => (promptInjectionDisabled || affinity) ? latestPrompt : fullPrompt;

    const completionResult = await completion({
      modelType,
      prompt: fullPrompt,
      thinkingEnabled,
      searchEnabled,
      refFileIds,
      preferVision: true,
      resolveSession: makeResolveSession(modelType),
      getPrompt,
      signal: abortController.signal,
      // 有附件时沿用上传用的凭据，保证 file_id 归属一致。
      initialSlot: uploadSlot,
    });
    // completion 已接管该 slot 的释放（见 sse.js），此处不再持有。
    uploadSlot = null;

    streamBody = completionResult.body;
    slot = completionResult.slot;
    if (clientGone || abortController.signal.aborted) {
      try { streamBody.cancel(); } catch {}
      return;
    }

    const responseModel = requestedModel;
    yield createRunStarted({ requestId, responseId, model: responseModel, protocol: internalRequest.protocol });

    const detector = toolCallingEnabled ? promptPlan.createStreamDetector() : null;
    let rawContent = '';
    let visibleContent = '';
    let reasoningContent = '';
    let usage = 0;
    let emittedText = false;
    let messageStarted = false;
    let detectedToolCalls = null;
    let pendingToolFailureText = '';
    let pendingToolFailureResult = null;

    const ensureMessageStarted = function* () {
      if (messageStarted) return;
      messageStarted = true;
      yield createMessageStarted({ requestId, responseId, messageId, role: 'assistant' });
    };

    const emitText = function* (delta) {
      if (!delta) return;
      for (const event of ensureMessageStarted()) yield event;
      visibleContent += delta;
      emittedText = true;
      yield createTextDelta({ requestId, responseId, messageId, delta });
    };

    for await (const event of parseSSEStream(streamBody, { signal: abortController.signal })) {
      if (clientGone) break;
      if (event.type === 'error') {
        try { await streamBody?.cancel?.(); } catch {}
        // 流中途才报限流：数据已开始下发，本次无法更换凭据，但要让该
        // 凭据进入冷却，避免后续请求继续撞它。
        const isRateLimited = event.code === 429 || event.code === 40301;
        // 上游原始报文（流内已解析出 code 与 message）随事件落盘，便于事后归因。
        const upstream = { code: event.code ?? null, msg: event.message ?? null, phase: 'stream' };
        if (slot && isRateLimited) {
          reportTokenRateLimited(slot.token, upstream);
        }
        // 流中途才暴露的终态失败（封禁/失效/禁言）同样要处置凭据：数据虽已
        // 下发，但该凭据已不可用，禁用后由其它凭据接管，并保留待恢复。
        if (slot) {
          if (event.code === 40004) {
            disableToken(slot.token, { reason: '账号被封禁 (40004)', disabledUntil: Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS, source: 'auto', detail: upstream, eventType: 'banned' });
          } else if (event.code === 40003) {
            reportTokenError(slot.token);
          } else if (event.code === 5) {
            disableToken(slot.token, { reason: '账号被禁言 (biz_code=5)', disabledUntil: Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS, source: 'auto', detail: upstream, eventType: 'muted' });
          }
        }
        throw new InternalAPIError(event.message || `DeepSeek error ${event.code}`, {
          // 限流应回报 429 rate_limit_error，客户端据此退避重试；
          // 其它上游错误按 502 api_error 处理。
          status: isRateLimited ? 429 : 502,
          type: isRateLimited ? 'rate_limit_error' : 'api_error',
          code: event.code || null,
          retryable: isRateLimited,
        });
      }
      if (event.messageIds?.responseMessageId) {
        recordResponseMessageId(conversationId, event.messageIds.responseMessageId);
      }

      if (event.type === 'content') {
        rawContent += event.content;
        if (detector) {
          const processed = detector.process(event.content);
          if (processed.parseFailure) {
            pendingToolFailureText += processed.bufferedToolText || '';
            pendingToolFailureResult = processed.failureResult || pendingToolFailureResult;
            for (const textEvent of emitText(prefixBeforeBufferedToolText(processed))) yield textEvent;
          } else if (pendingToolFailureText) {
            pendingToolFailureText += processed.delta || '';
          } else {
            for (const textEvent of emitText(processed.delta)) yield textEvent;
          }
          if (processed.completed && processed.toolCalls?.length) {
            detectedToolCalls = processed.toolCalls;
            break;
          }
        } else {
          for (const textEvent of emitText(event.content)) yield textEvent;
        }
      } else if (event.type === 'thinking') {
        reasoningContent += event.content;
        yield createReasoningDelta({ requestId, responseId, messageId, delta: event.content });
      } else if (event.type === 'usage') {
        usage = event.usage;
        yield createUsageUpdated({ requestId, responseId, usage: { outputTokens: usageOutputTokens(usage) } });
      } else if (event.type === 'done') {
        break;
      }
    }

    if (detectedToolCalls?.length) {
      try { await streamBody?.cancel?.(); } catch {}
    }

    if (detector && !detectedToolCalls) {
      const finished = detector.finish();
      if (finished.parseFailure) {
        pendingToolFailureText += finished.bufferedToolText || '';
        pendingToolFailureResult = finished.failureResult || pendingToolFailureResult;
        for (const textEvent of emitText(prefixBeforeBufferedToolText(finished))) yield textEvent;
      } else if (pendingToolFailureText) {
        pendingToolFailureText += finished.delta || '';
      } else {
        for (const textEvent of emitText(finished.delta)) yield textEvent;
      }
      if (finished.completed && finished.toolCalls?.length) {
        detectedToolCalls = finished.toolCalls;
      }
    }

    const releaseSlot = () => {
      if (slot) {
        slot.release();
        dispatchQueued();
        slot = null;
      }
    };
    const retryToolRequest = async ({ retryPrompt, currentContent, messages: retryMessages, signal }) => {
      const retryMessagesWithPrompt = [
        ...retryMessages,
        { role: 'assistant', content: [{ type: 'text', text: currentContent || '' }] },
        { role: 'user', content: [{ type: 'text', text: retryPrompt }] },
      ];
      const retryFullPrompt = promptWithToolInstructions(retryMessagesWithPrompt, toolInstructions);
      const retryResult = await completion({
        modelType,
        prompt: retryFullPrompt,
        thinkingEnabled,
        searchEnabled: false,
        refFileIds: [],
        preferVision: true,
        signal: signal || abortController.signal,
      });
      const retrySlot = retryResult.slot;
      try {
        return await collectParsedStreamContent(retryResult.body, (body) => parseSSEStream(body, { signal: signal || abortController.signal }));
      } finally {
        retrySlot?.release?.();
        dispatchQueued();
      }
    };

    // "只思考未作答"恢复：上游偶发只发 thinking 就 stop。这里带上一轮思考
    // 内容与原始请求续写一次，把结论要成正文。沿用同一会话（conversationId）
    // 让上游保有上下文；关闭 thinking 强制直接产出正文，避免再次只思考。
    const retryReasoningOnly = async ({ retryPrompt, currentContent, messages: retryMessages, signal }) => {
      const retryMessagesWithPrompt = [
        ...retryMessages,
        { role: 'assistant', content: [{ type: 'text', text: currentContent || '' }] },
        { role: 'user', content: [{ type: 'text', text: retryPrompt }] },
      ];
      const retryFullPrompt = promptWithToolInstructions(retryMessagesWithPrompt, '');
      const retryResult = await completion({
        modelType,
        prompt: retryFullPrompt,
        // 关键：续写阶段关闭 thinking，否则模型可能再次只输出思考。
        thinkingEnabled: false,
        searchEnabled: false,
        refFileIds: [],
        preferVision: true,
        signal: signal || abortController.signal,
      });
      const retrySlot = retryResult.slot;
      try {
        return await collectParsedStreamContent(retryResult.body, (body) => parseSSEStream(body, { signal: signal || abortController.signal }));
      } finally {
        retrySlot?.release?.();
        dispatchQueued();
      }
    };

    if (pendingToolFailureText && !detectedToolCalls) {
      releaseSlot();
      let retryResult = null;
      try {
        retryResult = await attemptToolParseWithRetry({
          content: pendingToolFailureText,
          messages: promptMessages,
          promptPlan,
          retryToolRequest,
          signal: abortController.signal,
        });
      } catch (err) {
        console.warn(`[DeepSeek] Tool retry failed, falling back to original buffered content: ${err.message}`);
      }
      if (retryResult?.toolCalls?.length) {
        detectedToolCalls = retryResult.toolCalls;
      } else {
        for (const textEvent of emitText(pendingToolFailureText)) yield textEvent;
      }
    }

    // 收尾兜底：模型用 `工具名({...})` 伪代码文本表示调用时，流式检测器
    // 不会拦截（无 XML 标记），文本已流出无法撤回；此处仍解析/纠错重试
    // 把 tool_calls 救回来，避免客户端收到一段"宣称调用"的文本后任务死锁。
    if (!detectedToolCalls && !pendingToolFailureText && toolCallingEnabled && rawContent && promptPlan.parseToolCallsDetailed) {
      const lateResult = promptPlan.parseToolCallsDetailed(rawContent);
      if (lateResult?.toolCalls?.length) {
        detectedToolCalls = lateResult.toolCalls;
        // late recovery 命中时，rawContent 里通常包含非标准工具文本
        // （如 <ApplyPatch> 或 ToolName({...})）。最终聚合 content 只保留
        // 工具调用前的说明文本，避免把 patch/伪调用主体当正文返回。
        visibleContent = lateResult.content || '';
        emittedText = !!visibleContent;
      } else if (lateResult?.failureType && lateResult.failureType !== 'no_fc') {
        releaseSlot();
        try {
          const lateRetry = await attemptToolParseWithRetry({
            content: rawContent,
            messages: promptMessages,
            promptPlan,
            retryToolRequest,
            signal: abortController.signal,
          });
          if (lateRetry?.toolCalls?.length) detectedToolCalls = lateRetry.toolCalls;
        } catch (err) {
          console.warn(`[DeepSeek] Late tool recovery failed: ${err.message}`);
        }
      } else if (lateResult?.failureType === 'no_fc' && isMissingToolCallIntent(rawContent, promptPlan.tools)) {
        releaseSlot();
        try {
          const retryContent = await retryToolRequest({
            retryPrompt: getMissingToolCallRetryPrompt(rawContent, promptPlan.triggerSignal, promptPlan.tools),
            currentContent: rawContent,
            messages: promptMessages,
            signal: abortController.signal,
            failureType: 'missing_tool_call',
          });
          const missingRetry = promptPlan.parseToolCallsDetailed(retryContent);
          if (missingRetry?.toolCalls?.length) detectedToolCalls = missingRetry.toolCalls;
        } catch (err) {
          console.warn(`[DeepSeek] Missing tool-call recovery failed: ${err.message}`);
        }
      }
    }

    // 空回复恢复：上游偶发"只思考、不输出正文"（finishReason=stop 但流里
    // 没有任何 RESPONSE 分片）。客户端只看到思考、拿不到答案，任务中断。
    // 这不是解析问题——上游确实没发正文，只能在代理层续写一次要回正文。
    // 恢复失败则保持原样，绝不伪造正文。
    if (!detectedToolCalls && !pendingToolFailureText && isEmptyAssistantReply({ visibleContent, reasoningContent })) {
      // 完全空流（无思考无正文）发生在两种情形：
      //   ① 该凭据被静默限制 → 记错误让池子累积并淘汰它
      //   ② IP 级限流 → 连续空流由 noteEmptyReply 累积判定，
      //      达阈值后开启全局冷却（该限制与凭据无关，换凭据无法规避）
      const completelyEmpty = !String(reasoningContent || '').trim();
      // slot 在 releaseSlot() 后会被置空，所以先记录凭据引用。
      const failedToken = slot?.token || null;
      if (completelyEmpty && failedToken) {
        reportTokenError(failedToken);
        noteEmptyReply();
        console.warn('[DeepSeek] 上游返回完全空流，已记该凭据一次错误');
      }
      releaseSlot();
      try {
        const recovered = await retryReasoningOnly({
          retryPrompt: getReasoningOnlyRetryPrompt(lastUserText, reasoningContent),
          currentContent: reasoningContent,
          messages: promptMessages,
          signal: abortController.signal,
        });
        const recoveredText = String(recovered || '').trim();
        if (recoveredText) {
          for (const deltaEvent of emitText(recoveredText)) yield deltaEvent;
        } else {
          console.warn('[DeepSeek] Reasoning-only recovery returned empty; leaving reply as-is');
        }
      } catch (err) {
        console.warn(`[DeepSeek] Reasoning-only recovery failed: ${err.message}`);
      }
    }

    // 注意：不要在流结束后把已流式发出的 message 文本"回填"成 reasoning。
    // 那样做无法流式（必须等到检测到 tool_call 才知道），会导致 Codex 端
    // 思考内容在末尾一次性出现。真正的思考来自上游 thinking 通道，已逐字流式；
    // 工具调用前的说明文本保持为 message 文本，同样逐字流式。
    if (reasoningContent) yield createReasoningDone({ requestId, responseId, messageId, text: reasoningContent });
    if (emittedText || visibleContent) {
      for (const event of ensureMessageStarted()) yield event;
      yield createTextDone({ requestId, responseId, messageId, text: visibleContent });
    }

    if (detectedToolCalls?.length) {
      for (const event of ensureMessageStarted()) yield event;
      for (const toolEvent of emitToolCallEvents({ requestId, responseId, messageId, toolCalls: detectedToolCalls })) {
        yield toolEvent;
      }
    }

    if (messageStarted || emittedText || visibleContent || detectedToolCalls?.length) {
      for (const event of ensureMessageStarted()) yield event;
      yield createMessageDone({ requestId, responseId, messageId, status: 'completed' });
    }
    // usage 说明：上游 Web 接口只提供输出 token 数（accumulated_token_usage），
    // 不提供输入 token、思考 token 与缓存命中统计。以下均为本地估算
    // （思考按约 4 字符/token），供客户端展示，非计费依据。
    //
    // 关于 completion_tokens 的口径（实测确认）：它对应**正文**而非总量。
    // 同样的问题下 thinking=true 得 134、thinking=false 得 102，正文长度几乎
    // 一致而思考量相差数百 token——若 completion_tokens 含思考，差值应与思考
    // 量同阶，实际只有 32。因此不能把它当作「含思考的总量」再按比例拆分，
    // 否则会把正文的量错算成思考，并让正文 token 趋近 0。客户端一旦用
    // 「正文 token ÷ 正文跨度」计算，分母是上游瞬发正文的极短时窗
    // （实测 208ms 出 53 个分片），就会得出 3589 这类夸张的 tok/s。
    const estimatedInputTokens = Math.max(0, Math.round(String(fullPrompt || '').length / 4));
    const visibleChars = visibleContent.length;
    const reasoningChars = reasoningContent.length;
    // 正文 token：优先用上游值；缺失时按字符估算。
    const visibleTokens = usageOutputTokens(usage) || Math.round(visibleChars / 4);
    // 思考 token：上游不计入，按字符量单独估算。
    const estimatedReasoningTokens = Math.round(reasoningChars / 4);
    const outputTokensFinal = visibleTokens + estimatedReasoningTokens;

    // 上报本次用量供 tok/s 统计。
    // 顺序很关键：渲染器收到 run.completed 后会立即 end() 响应，进而触发
    // 日志中间件的 res.finish 写记录；若在 yield 之后再上报，记录早已写定，
    // token 数就永远关联不上（这正是此前 tok/s 恒为 0 的原因之一）。
    //
    // 口径：输出 tokens ÷ 总耗时（含首字节等待），与 OpenAI 官方一致。
    // 不用"生成期"做分母的原因（实测）：上游是"先跑完思考、再瞬发正文"，
    // 思考阶段约 1745ms、正文阶段仅约 79ms；剔除首字节等待会让分母小到
    // 毫秒级，算出虚高数倍的速度。
    recordUsage(context?.res, {
      outputTokens: outputTokensFinal,
      durationMs: Date.now() - requestStart,
    });

    yield createRunCompleted({
      requestId,
      responseId,
      finishReason: detectedToolCalls?.length ? 'tool_calls' : 'stop',
      usage: {
        inputTokens: estimatedInputTokens,
        outputTokens: outputTokensFinal,
        reasoningTokens: estimatedReasoningTokens,
      },
    });

    // 有正文产出即视为上游正常，清除 IP 限流判定与空流计数。
    if (String(visibleContent || '').trim()) noteSuccessfulReply();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (err instanceof InternalAPIError) throw err;
    try { await streamBody?.cancel?.(); } catch {}
    throw new InternalAPIError(err.message || 'DeepSeek upstream error', {
      // 保留上游错误携带的 HTTP 语义（如限流 429），缺失时才回落 502。
      status: err.status || 502,
      type: err.type || 'api_error',
      retryable: err.retryable || false,
      cause: err,
    });
  } finally {
    if (responseStream?.off && onClose) responseStream.off('close', onClose);
    if (slot) {
      slot.release();
      dispatchQueued();
    }
    // 附件上传的 slot 若因异常未被 completion 接管，在此兜底释放，
    // 避免并发额度泄漏（表现为后续请求排队等待）。
    if (uploadSlot) {
      uploadSlot.release();
      dispatchQueued();
    }
  }
}
