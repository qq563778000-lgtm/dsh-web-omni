import { createPromptPlan } from '../core/prompt-strategy.js';
import {
  attemptToolParseWithRetry,
  getMissingToolCallRetryPrompt,
  getReasoningOnlyRetryPrompt,
  isEmptyAssistantReply,
  isMissingToolCallIntent,
} from '../core/tool-retry.js';
import { preprocessMessagesForToolify } from '../core/toolify-format.js';
import { getRecentToolCallIndex, getResponseToolCallIndex } from '../services/conversation.js';
import {
  createInternalId,
  internalMessagesToOpenAI,
  internalToolChoiceToOpenAI,
  internalToolsToOpenAI,
} from '../core/internal-request.js';
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
} from '../core/internal-events.js';
import { InternalAPIError } from '../core/errors.js';

export function requestLikeFromInternal(internalRequest, context = {}) {
  return context?.req || {
    body: internalRequest.raw?.body || {},
    headers: internalRequest.metadata?.headers || {},
    omni: {
      promptInjectionEnabled: internalRequest.metadata?.promptInjectionEnabled,
      rawRequestJsonText: internalRequest.raw?.rawJsonText,
    },
  };
}

export function usageOutputTokens(usage) {
  if (typeof usage === 'number') return usage;
  return usage?.outputTokens ?? usage?.output_tokens ?? usage?.completion_tokens ?? usage?.total_tokens ?? 0;
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

function normalizeToolCallArguments(value) {
  if (typeof value === 'string') return value || '{}';
  try { return JSON.stringify(value ?? {}); } catch { return '{}'; }
}

function emitToolCallEvents({ requestId, responseId, messageId, toolCalls }) {
  const events = [];
  for (let index = 0; index < toolCalls.length; index++) {
    const call = toolCalls[index];
    const id = call.id || createInternalId('call');
    const name = call.function?.name || call.name;
    const args = normalizeToolCallArguments(call.function?.arguments ?? call.arguments ?? '{}');
    events.push(createToolCallStarted({ requestId, responseId, messageId, toolCallId: id, index, name }));
    if (args) events.push(createToolCallArgumentsDelta({ requestId, responseId, messageId, toolCallId: id, index, delta: args }));
    events.push(createToolCallDone({ requestId, responseId, messageId, toolCallId: id, index, name, arguments: args || '{}' }));
  }
  return events;
}

export async function collectParsedStreamContent(streamBody, parseStream) {
  let content = '';
  for await (const event of parseStream(streamBody)) {
    if (event.type === 'error') throw new Error(event.message || 'Retry stream returned an error');
    if (event.type === 'content' || event.type === 'image') {
      content += event.content || event.imageUrl || '';
    } else if (event.type === 'done') {
      break;
    }
  }
  return content;
}

function prefixBeforeBufferedToolText(processed) {
  const delta = processed?.delta || '';
  const buffered = processed?.bufferedToolText || '';
  if (!delta || !buffered) return delta;
  return delta.endsWith(buffered) ? delta.slice(0, delta.length - buffered.length) : delta;
}

export async function* runParsedStreamChannel(internalRequest, context = {}, options = {}) {
  const {
    channelName,
    startStream,
    parseStream,
    responseModel = internalRequest.model?.normalized || internalRequest.model?.requested,
    statusForError = () => 502,
  } = options;

  const req = requestLikeFromInternal(internalRequest, context);
  const requestId = internalRequest.id;
  const responseId = context.responseId || createInternalId('resp');
  const messageId = createInternalId('msg');

  const openAIMessages = openAIMessagesFromInternal(internalRequest);
  const promptPlan = createPromptPlan({
    req,
    tools: internalToolsToOpenAI(internalRequest.tools),
    toolChoice: internalToolChoiceToOpenAI(internalRequest.toolChoice),
  });
  const {
    promptInjectionDisabled,
    disabledPrompt,
    tools,
    toolChoice,
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

  const abortController = new AbortController();
  let streamBody = null;
  let cleanup = null;
  let clientGone = false;
  let onClose = null;
  const responseStream = context?.res;
  if (responseStream?.on) {
    onClose = () => {
      clientGone = true;
      abortController.abort();
      try { streamBody?.cancel?.(); } catch {}
    };
    responseStream.on('close', onClose);
  }

  try {
    const started = await startStream({
      internalRequest,
      req,
      messages: promptMessages,
      tools,
      toolChoice,
      toolCallingEnabled,
      promptInjectionDisabled,
      disabledPrompt,
      toolInstructions,
      triggerSignal,
      promptPlan,
      signal: abortController.signal,
    });
    streamBody = started?.streamBody || started;
    cleanup = started?.cleanup || null;
    const retryToolRequest = started?.retryToolRequest || null;
    // 上游空回复恢复回调：由各渠道在自己的 startStream 里提供。
    // 未提供时该恢复路径自动跳过（不影响既有行为）。
    const retryReasoningOnly = started?.retryReasoningOnly || null;
    // 取最后一条 user 文本，作为"只思考未作答"续写时的原始请求上下文。
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

    if (clientGone || abortController.signal.aborted) {
      try { streamBody?.cancel?.(); } catch {}
      return;
    }

    yield createRunStarted({ requestId, responseId, model: responseModel, protocol: internalRequest.protocol });

    const detector = toolCallingEnabled ? promptPlan.createStreamDetector() : null;
    let rawContent = '';
    let visibleContent = '';
    let reasoningContent = '';
    let usage = null;
    let emittedText = false;
    let messageStarted = false;
    let upstreamError = null;
    let detectedToolCalls = null;
    let pendingToolFailureText = '';
    let pendingToolFailureResult = null;

    const ensureMessageStarted = function* () {
      if (messageStarted) return;
      messageStarted = true;
      yield createMessageStarted({ requestId, responseId, messageId, role: 'assistant' });
    };

    const emitDelta = function* (delta) {
      if (!delta) return;
      for (const event of ensureMessageStarted()) yield event;
      visibleContent += delta;
      emittedText = true;
      yield createTextDelta({ requestId, responseId, messageId, delta });
    };

    for await (const event of parseStream(streamBody)) {
      if (clientGone || abortController.signal.aborted) break;
      if (event.type === 'error') {
        upstreamError = event.message || `${channelName} upstream returned an error`;
        try { await streamBody?.cancel?.(); } catch {}
        break;
      }
      if (event.type === 'content' || event.type === 'image') {
        const content = event.content || event.imageUrl || '';
        rawContent += content;
        if (detector) {
          const processed = detector.process(content);
          if (processed.parseFailure) {
            pendingToolFailureText += processed.bufferedToolText || '';
            pendingToolFailureResult = processed.failureResult || pendingToolFailureResult;
            for (const deltaEvent of emitDelta(prefixBeforeBufferedToolText(processed))) yield deltaEvent;
          } else if (pendingToolFailureText) {
            pendingToolFailureText += processed.delta || '';
          } else {
            for (const deltaEvent of emitDelta(processed.delta)) yield deltaEvent;
          }
          if (processed.completed && processed.toolCalls?.length) {
            detectedToolCalls = processed.toolCalls;
            break;
          }
        } else {
          for (const deltaEvent of emitDelta(content)) yield deltaEvent;
        }
        if (event.usage) {
          usage = event.usage;
          yield createUsageUpdated({ requestId, responseId, usage: { outputTokens: usageOutputTokens(usage) } });
        }
      } else if (event.type === 'tool_calls') {
        if (event.toolCalls?.length) {
          detectedToolCalls = event.toolCalls;
          break;
        }
      } else if (event.type === 'thinking' || event.type === 'research') {
        const content = event.content || '';
        reasoningContent += content;
        yield createReasoningDelta({ requestId, responseId, messageId, delta: content });
        if (event.usage) {
          usage = event.usage;
          yield createUsageUpdated({ requestId, responseId, usage: { outputTokens: usageOutputTokens(usage) } });
        }
      } else if (event.type === 'usage') {
        usage = event.usage;
        yield createUsageUpdated({ requestId, responseId, usage: { outputTokens: usageOutputTokens(usage) } });
      } else if (event.type === 'done') {
        if (event.usage) usage = event.usage;
        break;
      }
    }

    if (detectedToolCalls?.length) {
      try { await streamBody?.cancel?.(); } catch {}
    }

    if (upstreamError) {
      throw new InternalAPIError(upstreamError, { status: 502, type: 'api_error' });
    }

    if (detector && !detectedToolCalls) {
      const finished = detector.finish();
      if (finished.parseFailure) {
        pendingToolFailureText += finished.bufferedToolText || '';
        pendingToolFailureResult = finished.failureResult || pendingToolFailureResult;
        for (const deltaEvent of emitDelta(prefixBeforeBufferedToolText(finished))) yield deltaEvent;
      } else if (pendingToolFailureText) {
        pendingToolFailureText += finished.delta || '';
      } else {
        for (const deltaEvent of emitDelta(finished.delta)) yield deltaEvent;
      }
      if (finished.completed && finished.toolCalls?.length) {
        detectedToolCalls = finished.toolCalls;
      }
    }

    if (pendingToolFailureText && !detectedToolCalls) {
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
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
        console.warn(`[${channelName}] Tool retry failed, falling back to original buffered content: ${err.message}`);
      }
      if (retryResult?.toolCalls?.length) {
        detectedToolCalls = retryResult.toolCalls;
      } else {
        for (const deltaEvent of emitDelta(pendingToolFailureText)) yield deltaEvent;
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
        if (cleanup) {
          cleanup();
          cleanup = null;
        }
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
          console.warn(`[${channelName}] Late tool recovery failed: ${err.message}`);
        }
      } else if (lateResult?.failureType === 'no_fc' && isMissingToolCallIntent(rawContent, promptPlan.tools)) {
        if (cleanup) {
          cleanup();
          cleanup = null;
        }
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
          console.warn(`[${channelName}] Missing tool-call recovery failed: ${err.message}`);
        }
      }
    }

    // 空回复恢复：上游偶发"只思考、不输出正文"（finishReason=stop 但流里
    // 没有任何 RESPONSE 分片）。此时客户端只看到思考、拿不到答案，任务中断。
    // 这不是解析问题——上游确实没发正文，只能在代理层用已积累的思考内容
    // 续写一次，把结论要成正文。恢复失败则保持原样，绝不伪造正文。
    if (
      !detectedToolCalls
      && !pendingToolFailureText
      && isEmptyAssistantReply({ visibleContent, reasoningContent })
      && typeof retryReasoningOnly === 'function'
    ) {
      if (cleanup) {
        cleanup();
        cleanup = null;
      }
      try {
        const recovered = await retryReasoningOnly({
          retryPrompt: getReasoningOnlyRetryPrompt(lastUserText, reasoningContent),
          currentContent: reasoningContent,
          messages: promptMessages,
          signal: abortController.signal,
        });
        const recoveredText = String(recovered || '').trim();
        if (recoveredText) {
          for (const deltaEvent of emitDelta(recoveredText)) yield deltaEvent;
        } else {
          console.warn(`[${channelName}] Reasoning-only recovery returned empty; leaving reply as-is`);
        }
      } catch (err) {
        console.warn(`[${channelName}] Reasoning-only recovery failed: ${err.message}`);
      }
    }

    // 注意：不要在流结束后把已流式发出的 message 文本"回填"成 reasoning。
    // 那样做无法流式（必须等到检测到 tool_call 才知道），会导致客户端
    // 思考内容在末尾一次性出现。真正的思考来自上游 thinking/research 通道，
    // 已逐字流式；工具调用前的说明文本保持为 message 文本，同样逐字流式。
    if (reasoningContent) yield createReasoningDone({ requestId, responseId, messageId, text: reasoningContent });
    if (emittedText || visibleContent) {
      for (const event of ensureMessageStarted()) yield event;
      yield createTextDone({ requestId, responseId, messageId, text: visibleContent });
    }

    if (detectedToolCalls?.length) {
      for (const event of ensureMessageStarted()) yield event;
      for (const toolEvent of emitToolCallEvents({ requestId, responseId, messageId, toolCalls: detectedToolCalls })) yield toolEvent;
    }

    if (messageStarted || emittedText || visibleContent || detectedToolCalls?.length) {
      for (const event of ensureMessageStarted()) yield event;
      yield createMessageDone({ requestId, responseId, messageId, status: 'completed' });
    }
    yield createRunCompleted({
      requestId,
      responseId,
      finishReason: detectedToolCalls?.length ? 'tool_calls' : 'stop',
      usage: { outputTokens: usageOutputTokens(usage) || Math.round((visibleContent.length + reasoningContent.length) / 4) },
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (err instanceof InternalAPIError) throw err;
    throw new InternalAPIError(err.message || `${channelName} upstream error`, {
      status: statusForError(err),
      type: 'api_error',
      cause: err,
    });
  } finally {
    if (responseStream?.off && onClose) responseStream.off('close', onClose);
    if (cleanup) cleanup();
  }
}
