import { aggregateInternalEvents, collectInternalEvents, INTERNAL_EVENT_TYPES } from '../../core/internal-events.js';
import { errorToResponseError } from '../../core/errors.js';
import { flushSSE, safeEnd, writeClaudeSSE } from '../../utils/response-utils.js';

function claudeId(id) {
  if (!id) return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return id.startsWith('msg_') ? id : `msg_${id.replace(/^resp_?/, '')}`;
}

function mapStopReason(reason) {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

function usageToClaude(usage = {}) {
  return {
    input_tokens: usage.inputTokens || 0,
    output_tokens: usage.outputTokens || 0,
  };
}

function parseToolInput(args) {
  try { return JSON.parse(args || '{}'); } catch { return {}; }
}

function toolBlocks(toolCalls = []) {
  return toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: parseToolInput(call.arguments) }));
}

export function writeClaudeProtocolError(res, err) {
  const { status, error } = errorToResponseError(err);
  return res.status(status).json({ type: 'error', error: { type: error.type, message: error.message } });
}

export async function renderClaudeMessages(res, events, { model, stream = true } = {}) {
  if (stream) return renderClaudeMessagesStream(res, events, { model });
  return renderClaudeMessagesJSON(res, events, { model });
}

export async function renderClaudeMessagesJSON(res, events, { model } = {}) {
  const collected = await collectInternalEvents(events);
  const failed = collected.find(event => event.type === INTERNAL_EVENT_TYPES.RUN_FAILED);
  if (failed) return writeClaudeProtocolError(res, failed.error);

  const aggregated = aggregateInternalEvents(collected);
  const content = [];
  if (aggregated.reasoning) content.push({ type: 'thinking', thinking: aggregated.reasoning });
  if (aggregated.text) content.push({ type: 'text', text: aggregated.text });
  content.push(...toolBlocks(aggregated.toolCalls));
  return res.json({
    id: claudeId(aggregated.responseId),
    type: 'message',
    role: 'assistant',
    content,
    model: aggregated.model || model,
    stop_reason: mapStopReason(aggregated.finishReason),
    stop_sequence: null,
    usage: usageToClaude(aggregated.usage),
  });
}

export async function renderClaudeMessagesStream(res, events, { model } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let id = null;
  let currentModel = model;
  let messageStarted = false;
  let activeBlockType = null;
  let activeBlockIndex = null;
  let blockIndex = 0;
  const toolBlockIndexes = new Map();

  const ensureMessageStarted = (event = {}) => {
    if (!id) id = claudeId(event.responseId);
    currentModel = event.model || currentModel;
    if (!messageStarted) {
      messageStarted = true;
      writeClaudeSSE(res, {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          content: [],
          model: currentModel,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
  };

  const closeActiveBlock = () => {
    if (activeBlockType == null || activeBlockIndex == null) return;
    writeClaudeSSE(res, { type: 'content_block_stop', index: activeBlockIndex });
    activeBlockType = null;
    activeBlockIndex = null;
    blockIndex++;
  };

  const ensureTextBlockStarted = (event = {}) => {
    ensureMessageStarted(event);
    if (activeBlockType === 'text') return;
    closeActiveBlock();
    activeBlockType = 'text';
    activeBlockIndex = blockIndex;
    writeClaudeSSE(res, { type: 'content_block_start', index: activeBlockIndex, content_block: { type: 'text', text: '' } });
  };

  const ensureThinkingBlockStarted = (event = {}) => {
    ensureMessageStarted(event);
    if (activeBlockType === 'thinking') return;
    closeActiveBlock();
    activeBlockType = 'thinking';
    activeBlockIndex = blockIndex;
    writeClaudeSSE(res, { type: 'content_block_start', index: activeBlockIndex, content_block: { type: 'thinking', thinking: '' } });
  };

  try {
    for await (const event of events) {
      if (res.writableEnded) break;
      switch (event.type) {
        case INTERNAL_EVENT_TYPES.RUN_STARTED:
        case INTERNAL_EVENT_TYPES.MESSAGE_STARTED:
          ensureMessageStarted(event);
          break;
        case INTERNAL_EVENT_TYPES.TEXT_DELTA:
          ensureTextBlockStarted(event);
          if (event.delta) writeClaudeSSE(res, { type: 'content_block_delta', index: activeBlockIndex, delta: { type: 'text_delta', text: event.delta } });
          break;
        case INTERNAL_EVENT_TYPES.TEXT_DONE:
          if (activeBlockType === 'text') closeActiveBlock();
          break;
        case INTERNAL_EVENT_TYPES.REASONING_DELTA:
          ensureThinkingBlockStarted(event);
          if (event.delta) writeClaudeSSE(res, { type: 'content_block_delta', index: activeBlockIndex, delta: { type: 'thinking_delta', thinking: event.delta } });
          break;
        case INTERNAL_EVENT_TYPES.REASONING_DONE:
          if (activeBlockType === 'thinking') closeActiveBlock();
          break;
        case INTERNAL_EVENT_TYPES.TOOL_CALL_STARTED: {
          closeActiveBlock();
          ensureMessageStarted(event);
          const index = blockIndex++;
          toolBlockIndexes.set(event.toolCallId, index);
          writeClaudeSSE(res, { type: 'content_block_start', index, content_block: { type: 'tool_use', id: event.toolCallId, name: event.name, input: {} } });
          if (event.arguments) writeClaudeSSE(res, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: event.arguments } });
          break;
        }
        case INTERNAL_EVENT_TYPES.TOOL_CALL_ARGUMENTS_DELTA: {
          const index = toolBlockIndexes.get(event.toolCallId) ?? blockIndex;
          writeClaudeSSE(res, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: event.delta || '' } });
          break;
        }
        case INTERNAL_EVENT_TYPES.TOOL_CALL_DONE: {
          const index = toolBlockIndexes.get(event.toolCallId);
          if (index != null) writeClaudeSSE(res, { type: 'content_block_stop', index });
          break;
        }
        case INTERNAL_EVENT_TYPES.RUN_FAILED:
          // 与 chat 端点同理：错误不能被写进正文块，否则客户端会把上游报错
          // 当成模型回答。Claude 的流内错误约定是发送 `type: error` 事件，
          // 未收尾的内容块按协议先关闭，保证客户端解析状态机不悬空。
          closeActiveBlock();
          writeClaudeSSE(res, {
            type: 'error',
            error: {
              type: event.error?.type || 'api_error',
              message: event.error?.message || 'Internal Server Error',
            },
          });
          safeEnd(res);
          return;
        case INTERNAL_EVENT_TYPES.RUN_COMPLETED:
          closeActiveBlock();
          // message_start 时尚未产生用量，故此处补报 input_tokens 与 output_tokens，
          // 使客户端能显示完整用量（流式场景下这是最后一次可写 usage 的机会）。
          writeClaudeSSE(res, {
            type: 'message_delta',
            delta: { stop_reason: mapStopReason(event.finishReason), stop_sequence: null },
            usage: {
              input_tokens: event.usage?.inputTokens || 0,
              output_tokens: event.usage?.outputTokens || 0,
            },
          });
          writeClaudeSSE(res, { type: 'message_stop' });
          flushSSE(res);
          safeEnd(res);
          return;
      }
    }

    if (!res.writableEnded) {
      ensureMessageStarted({});
      closeActiveBlock();
      writeClaudeSSE(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 } });
      writeClaudeSSE(res, { type: 'message_stop' });
      safeEnd(res);
    }
  } catch (err) {
    if (!res.headersSent) return writeClaudeProtocolError(res, err);
    ensureTextBlockStarted({});
    writeClaudeSSE(res, { type: 'content_block_delta', index: activeBlockIndex, delta: { type: 'text_delta', text: err.message || 'Internal Server Error' } });
    closeActiveBlock();
    writeClaudeSSE(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 0, output_tokens: 0 } });
    writeClaudeSSE(res, { type: 'message_stop' });
    safeEnd(res);
  }
}
