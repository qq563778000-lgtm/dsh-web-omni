import { errorToResponseError } from '../../core/errors.js';
import { aggregateInternalEvents, collectInternalEvents, INTERNAL_EVENT_TYPES, nowSeconds } from '../../core/internal-events.js';
import { recordResponseToolCalls } from '../../services/conversation.js';
import { flushSSE, safeEnd } from '../../utils/response-utils.js';

function responseIdFrom(event, fallback) {
  return event.responseId || fallback || `resp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function messageIdFrom(event, fallback) {
  return event.messageId || fallback || `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function baseResponse({ id, model, status = 'in_progress', output = [], outputText = '', usage = null, createdAt = nowSeconds(), error = null } = {}) {
  const response = {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output,
    output_text: outputText,
    usage: usage ? {
      input_tokens: usage.inputTokens || 0,
      output_tokens: usage.outputTokens || 0,
      total_tokens: usage.totalTokens || ((usage.inputTokens || 0) + (usage.outputTokens || 0)),
    } : null,
  };
  if (error) response.error = error;
  return response;
}

function outputMessage({ id, status = 'in_progress', text = '', contentStatus = 'in_progress' } = {}) {
  return {
    id,
    type: 'message',
    status,
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], status: contentStatus }],
  };
}

function outputToolCall(call) {
  return {
    id: call.id,
    type: 'function_call',
    status: 'completed',
    call_id: call.id,
    name: call.name,
    arguments: call.arguments || '{}',
  };
}

function outputReasoning({ id, status = 'completed', text = '' } = {}) {
  return {
    id,
    type: 'reasoning',
    status,
    summary: text ? [{ type: 'summary_text', text }] : [],
  };
}

function writeResponseEvent(res, eventName, data) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify({ type: eventName, ...data })}\n\n`);
  flushSSE(res);
  return true;
}

export function writeResponsesError(res, err) {
  const { status, error } = errorToResponseError(err);
  return res.status(status).json({ error });
}

export async function renderResponses(res, events, { model, stream = true } = {}) {
  if (stream) return renderResponsesStream(res, events, { model });
  return renderResponsesJSON(res, events, { model });
}

export async function renderResponsesJSON(res, events, { model } = {}) {
  const collected = await collectInternalEvents(events);
  const aggregated = aggregateInternalEvents(collected);
  const failed = collected.find(event => event.type === INTERNAL_EVENT_TYPES.RUN_FAILED);

  if (failed) {
    const responseId = aggregated.responseId || failed.responseId || `resp_${Date.now().toString(36)}`;
    return res.status(failed.error?.status || 500).json(baseResponse({
      id: responseId,
      model: aggregated.model || model,
      status: 'failed',
      output: [],
      outputText: '',
      usage: aggregated.usage,
      error: failed.error,
    }));
  }

  const responseId = aggregated.responseId || `resp_${Date.now().toString(36)}`;
  const messageId = aggregated.messageId || `msg_${Date.now().toString(36)}`;
  const output = [];
  if (aggregated.reasoning) output.push(outputReasoning({ id: `rs_${messageId.replace(/^msg_?/, '')}`, text: aggregated.reasoning }));
  output.push(outputMessage({ id: messageId, status: 'completed', text: aggregated.text, contentStatus: 'completed' }));
  for (const call of aggregated.toolCalls) output.push(outputToolCall(call));
  recordResponseToolCalls(responseId, aggregated.toolCalls);

  return res.json(baseResponse({
    id: responseId,
    model: aggregated.model || model,
    status: 'completed',
    output,
    outputText: aggregated.text,
    usage: aggregated.usage,
    createdAt: aggregated.created,
  }));
}

export async function renderResponsesStream(res, events, { model } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let responseId = null;
  let messageId = null;
  let currentModel = model;
  let createdAt = nowSeconds();
  let outputText = '';
  let reasoningId = null;
  let reasoningText = '';
  let reasoningStarted = false;
  let reasoningPartStarted = false;
  let reasoningPartDone = false;
  let contentPartStarted = false;
  let contentPartDone = false;
  let messageStarted = false;
  let messageOutputIndex = null;
  let lastUsage = null;
  const outputItems = [];
  const toolCalls = new Map();
  const toolCallOutputIndexes = new Map();

  const ensureResponseStarted = (event = {}) => {
    if (responseId) return;
    responseId = responseIdFrom(event);
    currentModel = event.model || currentModel;
    createdAt = event.created || createdAt;
    writeResponseEvent(res, 'response.created', {
      response: baseResponse({ id: responseId, model: currentModel, status: 'in_progress', output: [], outputText: '', createdAt }),
    });
  };

  const ensureMessageStarted = (event = {}) => {
    ensureResponseStarted(event);
    if (!messageId) messageId = messageIdFrom(event);
    if (!messageStarted) {
      messageStarted = true;
      const item = outputMessage({ id: messageId });
      messageOutputIndex = outputItems.length;
      outputItems.push(item);
      writeResponseEvent(res, 'response.output_item.added', { output_index: messageOutputIndex, item });
    }
    if (!contentPartStarted) {
      contentPartStarted = true;
      writeResponseEvent(res, 'response.content_part.added', {
        item_id: messageId,
        output_index: messageOutputIndex ?? 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
  };

  const ensureReasoningStarted = (event = {}) => {
    ensureResponseStarted(event);
    if (!reasoningId) reasoningId = `rs_${(messageIdFrom(event, messageId) || 'reasoning').replace(/^msg_?/, '')}`;
    if (!reasoningStarted) {
      reasoningStarted = true;
      const item = outputReasoning({ id: reasoningId, status: 'in_progress', text: '' });
      outputItems.push(item);
      writeResponseEvent(res, 'response.output_item.added', { output_index: outputItems.length - 1, item });
    }
    if (!reasoningPartStarted) {
      reasoningPartStarted = true;
      writeResponseEvent(res, 'response.reasoning_summary_part.added', {
        item_id: reasoningId,
        output_index: outputItems.findIndex(item => item?.id === reasoningId),
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
    }
  };

  const closeReasoningPart = () => {
    if (!reasoningStarted || reasoningPartDone) return;
    const outputIndex = outputItems.findIndex(item => item?.id === reasoningId);
    writeResponseEvent(res, 'response.reasoning_summary_text.done', {
      item_id: reasoningId,
      output_index: outputIndex,
      summary_index: 0,
      text: reasoningText,
    });
    writeResponseEvent(res, 'response.reasoning_summary_part.done', {
      item_id: reasoningId,
      output_index: outputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: reasoningText },
    });
    reasoningPartDone = true;
  };

  const completeReasoningItem = () => {
    if (!reasoningStarted) return;
    closeReasoningPart();
    const outputIndex = outputItems.findIndex(item => item?.id === reasoningId);
    const item = outputReasoning({ id: reasoningId, status: 'completed', text: reasoningText });
    if (outputIndex >= 0) outputItems[outputIndex] = item;
    writeResponseEvent(res, 'response.output_item.done', { output_index: outputIndex, item });
  };

  const ensureToolCallItem = (event = {}) => {
    ensureResponseStarted(event);
    let call = toolCalls.get(event.toolCallId);
    if (!call) {
      call = { id: event.toolCallId, type: 'function_call', status: 'in_progress', call_id: event.toolCallId, name: event.name, arguments: event.arguments || '' };
      toolCalls.set(event.toolCallId, call);
    }
    if (!toolCallOutputIndexes.has(event.toolCallId)) {
      const outputIndex = outputItems.length;
      outputItems.push(call);
      toolCallOutputIndexes.set(event.toolCallId, outputIndex);
      writeResponseEvent(res, 'response.output_item.added', { output_index: outputIndex, item: call });
    }
    return call;
  };

  const closeContentPart = () => {
    if (!contentPartStarted || contentPartDone) return;
    const outputIndex = messageOutputIndex ?? 0;
    writeResponseEvent(res, 'response.output_text.done', { item_id: messageId, output_index: outputIndex, content_index: 0, text: outputText });
    writeResponseEvent(res, 'response.content_part.done', { item_id: messageId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: outputText, annotations: [] } });
    contentPartDone = true;
  };

  const completeMessageItem = () => {
    if (!messageStarted) return;
    closeContentPart();
    const outputIndex = messageOutputIndex ?? 0;
    const item = outputMessage({ id: messageId, status: 'completed', text: outputText, contentStatus: 'completed' });
    if (outputItems[outputIndex]?.type === 'message') outputItems[outputIndex] = item;
    writeResponseEvent(res, 'response.output_item.done', { output_index: outputIndex, item });
  };

  try {
    for await (const event of events) {
      if (res.writableEnded) break;
      switch (event.type) {
        case INTERNAL_EVENT_TYPES.RUN_STARTED:
          ensureResponseStarted(event);
          break;
        case INTERNAL_EVENT_TYPES.MESSAGE_STARTED:
          ensureMessageStarted(event);
          break;
        case INTERNAL_EVENT_TYPES.TEXT_DELTA:
          ensureMessageStarted(event);
          outputText += event.delta || '';
          writeResponseEvent(res, 'response.output_text.delta', {
            item_id: messageId,
            output_index: messageOutputIndex ?? event.outputIndex ?? 0,
            content_index: event.contentIndex ?? 0,
            delta: event.delta || '',
          });
          break;
        case INTERNAL_EVENT_TYPES.TEXT_DONE:
          ensureMessageStarted(event);
          outputText = event.text ?? outputText;
          if (outputItems[messageOutputIndex ?? 0]?.type === 'message') {
            outputItems[messageOutputIndex ?? 0] = outputMessage({ id: messageId, status: 'in_progress', text: outputText, contentStatus: 'completed' });
          }
          writeResponseEvent(res, 'response.output_text.done', {
            item_id: messageId,
            output_index: messageOutputIndex ?? event.outputIndex ?? 0,
            content_index: event.contentIndex ?? 0,
            text: outputText,
          });
          writeResponseEvent(res, 'response.content_part.done', {
            item_id: messageId,
            output_index: messageOutputIndex ?? event.outputIndex ?? 0,
            content_index: event.contentIndex ?? 0,
            part: { type: 'output_text', text: outputText, annotations: [] },
          });
          contentPartDone = true;
          break;
        case INTERNAL_EVENT_TYPES.REASONING_DELTA: {
          ensureReasoningStarted(event);
          reasoningText += event.delta || '';
          const outputIndex = outputItems.findIndex(item => item?.id === reasoningId);
          if (event.delta) writeResponseEvent(res, 'response.reasoning_summary_text.delta', {
            item_id: reasoningId,
            output_index: outputIndex,
            summary_index: 0,
            delta: event.delta || '',
          });
          break;
        }
        case INTERNAL_EVENT_TYPES.REASONING_DONE: {
          ensureReasoningStarted(event);
          reasoningText = event.text ?? reasoningText;
          completeReasoningItem();
          break;
        }
        case INTERNAL_EVENT_TYPES.TOOL_CALL_STARTED: {
          const call = ensureToolCallItem(event);
          call.name = event.name || call.name;
          call.arguments = event.arguments || call.arguments || '';
          break;
        }
        case INTERNAL_EVENT_TYPES.TOOL_CALL_ARGUMENTS_DELTA: {
          const call = ensureToolCallItem(event);
          call.arguments += event.delta || '';
          const outputIndex = toolCallOutputIndexes.get(event.toolCallId);
          writeResponseEvent(res, 'response.function_call_arguments.delta', {
            item_id: event.toolCallId,
            output_index: outputIndex,
            delta: event.delta || '',
          });
          break;
        }
        case INTERNAL_EVENT_TYPES.TOOL_CALL_DONE: {
          const call = ensureToolCallItem(event);
          call.status = 'completed';
          call.name = event.name || call.name;
          call.arguments = event.arguments ?? call.arguments ?? '{}';
          recordResponseToolCalls(responseId, [call]);
          const outputIndex = toolCallOutputIndexes.get(event.toolCallId);
          writeResponseEvent(res, 'response.function_call_arguments.done', {
            item_id: event.toolCallId,
            output_index: outputIndex,
            arguments: call.arguments,
          });
          writeResponseEvent(res, 'response.output_item.done', { output_index: outputIndex, item: call });
          break;
        }
        case INTERNAL_EVENT_TYPES.MESSAGE_DONE:
          completeMessageItem();
          break;
        case INTERNAL_EVENT_TYPES.USAGE_UPDATED:
          lastUsage = event.usage;
          break;
        case INTERNAL_EVENT_TYPES.RUN_FAILED:
          ensureResponseStarted(event);
          writeResponseEvent(res, 'response.failed', {
            response: baseResponse({ id: responseId, model: currentModel, status: 'failed', output: outputItems, outputText, usage: lastUsage, createdAt, error: event.error }),
          });
          safeEnd(res);
          return;
        case INTERNAL_EVENT_TYPES.RUN_COMPLETED:
          ensureResponseStarted(event);
          lastUsage = event.usage || lastUsage;
          if (reasoningStarted && outputItems.find(item => item?.id === reasoningId)?.status !== 'completed') completeReasoningItem();
          if (messageStarted && outputItems[messageOutputIndex ?? 0]?.status !== 'completed') completeMessageItem();
          recordResponseToolCalls(responseId, outputItems.filter(item => item?.type === 'function_call'));
          writeResponseEvent(res, 'response.completed', {
            response: baseResponse({ id: responseId, model: currentModel, status: 'completed', output: outputItems.length ? outputItems : [outputMessage({ id: messageId || `msg_${Date.now().toString(36)}`, status: 'completed', text: outputText, contentStatus: 'completed' })], outputText, usage: lastUsage, createdAt }),
          });
          safeEnd(res);
          return;
      }
    }

    if (!res.writableEnded) {
      ensureResponseStarted({});
      if (reasoningStarted && outputItems.find(item => item?.id === reasoningId)?.status !== 'completed') completeReasoningItem();
      if (messageStarted && outputItems[messageOutputIndex ?? 0]?.status !== 'completed') completeMessageItem();
      writeResponseEvent(res, 'response.completed', {
        response: baseResponse({ id: responseId, model: currentModel, status: 'completed', output: outputItems, outputText, usage: lastUsage, createdAt }),
      });
      safeEnd(res);
    }
  } catch (err) {
    if (!res.headersSent) return writeResponsesError(res, err);
    const { error } = errorToResponseError(err);
    writeResponseEvent(res, 'response.failed', {
      response: baseResponse({ id: responseId || `resp_${Date.now().toString(36)}`, model: currentModel, status: 'failed', output: outputItems, outputText, usage: lastUsage, createdAt, error }),
    });
    safeEnd(res);
  }
}
