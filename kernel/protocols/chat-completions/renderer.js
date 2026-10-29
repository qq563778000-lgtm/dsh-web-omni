import { aggregateInternalEvents, collectInternalEvents, INTERNAL_EVENT_TYPES, nowSeconds, resolveCachedTokens } from '../../core/internal-events.js';
import { errorToResponseError } from '../../core/errors.js';
import { getConfig } from '../../services/config-store.js';
import { recordResponseToolCalls } from '../../services/conversation.js';
import { flushSSE, safeEnd, writeSSE } from '../../utils/response-utils.js';

function systemFingerprint() {
  return getConfig().server.systemFingerprint;
}

function chatId(id) {
  if (!id) return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return id.startsWith('chatcmpl-') ? id : `chatcmpl-${id.replace(/^resp_?/, '')}`;
}

function mapFinishReason(reason) {
  if (reason === 'tool_calls') return 'tool_calls';
  if (reason === 'length') return 'length';
  if (reason === 'error') return 'stop';
  return 'stop';
}

/**
 * 把内部错误整理成流内错误对象。
 *
 * 只保留客户端可用于决策的字段：message 供人读，type/code 供程序分支，
 * 不透传 cause / upstream 等可能含上游报文细节的内部字段。
 */
function toWireError(error = {}) {
  const wire = {
    message: error?.message || 'Internal Server Error',
    type: error?.type || 'api_error',
  };
  if (error?.code !== null && error?.code !== undefined) wire.code = error.code;
  return wire;
}

function usageToOpenAI(usage = {}) {
  const promptTokens = usage.inputTokens || 0;
  const completionTokens = usage.outputTokens || 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.totalTokens || promptTokens + completionTokens,
    // cached_tokens 为展示值：上游 Web 接口不提供缓存统计，
    // 按配置命中率对输入 token 折算（见 resolveCachedTokens 说明）。
    prompt_tokens_details: {
      cached_tokens: resolveCachedTokens(
        promptTokens,
        getConfig().deepseek.reportedCacheHitRate,
        usage.cachedTokens,
      ),
    },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens || 0 },
  };
}

function toOpenAIToolCalls(toolCalls = []) {
  return toolCalls.map(call => ({
    id: call.id,
    type: 'function',
    function: {
      name: call.name,
      arguments: call.arguments || '{}',
    },
  }));
}

export function writeChatError(res, err) {
  const { status, error } = errorToResponseError(err);
  return res.status(status).json({ error });
}

export async function renderChatCompletions(res, events, { model, stream = true } = {}) {
  if (stream) return renderChatCompletionsStream(res, events, { model });
  return renderChatCompletionsJSON(res, events, { model });
}

export async function renderChatCompletionsJSON(res, events, { model } = {}) {
  const collected = await collectInternalEvents(events);
  const failed = collected.find(event => event.type === INTERNAL_EVENT_TYPES.RUN_FAILED);
  if (failed) return res.status(failed.error?.status || 500).json({ error: failed.error });

  const aggregated = aggregateInternalEvents(collected);
  const toolCalls = toOpenAIToolCalls(aggregated.toolCalls);
  recordResponseToolCalls(aggregated.responseId, toolCalls);
  const message = {
    role: 'assistant',
    content: toolCalls.length ? (aggregated.text || null) : aggregated.text,
    refusal: null,
  };
  if (aggregated.reasoning) message.reasoning_content = aggregated.reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return res.json({
    id: chatId(aggregated.responseId),
    object: 'chat.completion',
    created: aggregated.created || nowSeconds(),
    model: aggregated.model || model,
    system_fingerprint: systemFingerprint(),
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: mapFinishReason(aggregated.finishReason),
    }],
    usage: usageToOpenAI(aggregated.usage),
  });
}

export async function renderChatCompletionsStream(res, events, { model } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let id = null;
  let currentModel = model;
  let created = nowSeconds();
  let roleSent = false;
  const toolCallIndexes = new Map();
  const toolCallRecords = new Map();

  const base = () => ({ id, object: 'chat.completion.chunk', created, model: currentModel, system_fingerprint: systemFingerprint() });
  const ensureStarted = (event = {}) => {
    if (!id) id = chatId(event.responseId);
    currentModel = event.model || currentModel;
    created = event.created || created;
    if (!roleSent) {
      roleSent = true;
      writeSSE(res, { ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    }
  };

  try {
    for await (const event of events) {
      if (res.writableEnded) break;
      switch (event.type) {
        case INTERNAL_EVENT_TYPES.RUN_STARTED:
        case INTERNAL_EVENT_TYPES.MESSAGE_STARTED:
          ensureStarted(event);
          break;
        case INTERNAL_EVENT_TYPES.TEXT_DELTA:
          ensureStarted(event);
          if (event.delta) writeSSE(res, { ...base(), choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] });
          break;
        case INTERNAL_EVENT_TYPES.REASONING_DELTA:
          ensureStarted(event);
          if (event.delta) writeSSE(res, { ...base(), choices: [{ index: 0, delta: { reasoning_content: event.delta }, finish_reason: null }] });
          break;
        case INTERNAL_EVENT_TYPES.TOOL_CALL_STARTED: {
          ensureStarted(event);
          const index = event.index ?? toolCallIndexes.size;
          toolCallIndexes.set(event.toolCallId, index);
          toolCallRecords.set(event.toolCallId, { id: event.toolCallId, type: 'function', function: { name: event.name, arguments: event.arguments || '' } });
          writeSSE(res, { ...base(), choices: [{ index: 0, delta: { tool_calls: [{ index, id: event.toolCallId, type: 'function', function: { name: event.name, arguments: '' } }] }, finish_reason: null }] });
          if (event.arguments) writeSSE(res, { ...base(), choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.arguments } }] }, finish_reason: null }] });
          break;
        }
        case INTERNAL_EVENT_TYPES.TOOL_CALL_ARGUMENTS_DELTA: {
          ensureStarted(event);
          const index = toolCallIndexes.get(event.toolCallId) ?? event.index ?? 0;
          const record = toolCallRecords.get(event.toolCallId) || { id: event.toolCallId, type: 'function', function: { name: event.name, arguments: '' } };
          record.function.arguments += event.delta || '';
          toolCallRecords.set(event.toolCallId, record);
          writeSSE(res, { ...base(), choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.delta || '' } }] }, finish_reason: null }] });
          break;
        }
        case INTERNAL_EVENT_TYPES.TOOL_CALL_DONE: {
          ensureStarted(event);
          const record = toolCallRecords.get(event.toolCallId) || { id: event.toolCallId, type: 'function', function: { name: event.name, arguments: '' } };
          record.function.name = event.name || record.function.name;
          record.function.arguments = event.arguments ?? record.function.arguments ?? '{}';
          toolCallRecords.set(event.toolCallId, record);
          recordResponseToolCalls(event.responseId, [record]);
          break;
        }
        case INTERNAL_EVENT_TYPES.RUN_FAILED:
          // 流式响应头已经发出（200），无法再改状态码；此时必须让客户端
          // 能区分"模型输出"与"上游失败"。
          //
          // 旧实现把错误文本写进 delta.content，客户端会把它当成模型回答
          // 渲染、甚至写进会话历史——用户看到的是一段英文报错，却以为
          // 是模型在回答。OpenAI 兼容生态对流内错误的事实约定是发送一个
          // 不带 choices 的 {"error": {...}} 对象，这里照此处理。
          writeSSE(res, { error: toWireError(event.error) });
          res.write('data: [DONE]\n\n');
          flushSSE(res);
          safeEnd(res);
          return;
        case INTERNAL_EVENT_TYPES.RUN_COMPLETED:
          ensureStarted(event);
          writeSSE(res, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: mapFinishReason(event.finishReason) }] });
          // OpenAI 规范：流式在 [DONE] 前发一个带 usage 的 chunk（choices 为空数组）。
          // 客户端据此显示 token 用量、tok/s 等指标；缺失会导致客户端认为"无有效用量"。
          writeSSE(res, { ...base(), choices: [], usage: usageToOpenAI(event.usage) });
          res.write('data: [DONE]\n\n');
          flushSSE(res);
          safeEnd(res);
          return;
      }
    }

    if (!res.writableEnded) {
      ensureStarted({});
      writeSSE(res, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      writeSSE(res, { ...base(), choices: [], usage: usageToOpenAI({}) });
      res.write('data: [DONE]\n\n');
      flushSSE(res);
      safeEnd(res);
    }
  } catch (err) {
    if (!res.headersSent) return writeChatError(res, err);
    writeSSE(res, { ...base(), choices: [{ index: 0, delta: { content: err.message || 'Internal Server Error' }, finish_reason: null }] });
    writeSSE(res, { ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    res.write('data: [DONE]\n\n');
    safeEnd(res);
  }
}
