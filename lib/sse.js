/**
 * 内核内部事件 → DSH StreamChunk
 *
 * 与上一版的差别：输入源从"HTTP SSE 文本"变为内核直接产出的
 * 内部事件异步生成器。省掉一层序列化与解析，也避免了 SSE 分帧
 * 边界问题（此前需要自己处理跨分片的 buffer）。
 *
 * DSH 的 chunk 契约（见 @deepseek-ai/dsh-llm 的 BlockAssembler）：
 *   block-start { index, blockType }
 *   text-delta / reasoning-delta { index, text }
 *   tool-call-delta { index, id, name?, argumentsDelta }
 *   block-end { index, block }
 *   usage { usage: { inputTokens, outputTokens } }
 *   finish { reason: { kind } }
 *
 * 成功流必须恰好以一个 finish 结束，否则 DSH 侧不会结算用量。
 */

/**
 * 事件类型常量。
 *
 * 刻意不在模块顶层 import kernel/core/internal-events.js：
 * 那条静态链会在模块求值阶段就把内核拉起来，而内核在顶层读取
 * ZHI2API_DATA_DIR 并固化配置路径。一旦插件入口被 import 时环境尚未
 * 隔离，内核就会去读错误目录，表现为"设置页存了凭据、池里始终 0 条"。
 *
 * 这里改成运行时由调用方注入（translateInternalEvents 的 options.types），
 * 由已完成隔离的 runtime.loadKernel() 提供。
 */
const FALLBACK_TYPES = Object.freeze({
  RUN_STARTED: 'run.started',
  MESSAGE_STARTED: 'message.started',
  TEXT_DELTA: 'content.text.delta',
  REASONING_DELTA: 'reasoning.delta',
  TOOL_CALL_STARTED: 'tool_call.started',
  TOOL_CALL_ARGUMENTS_DELTA: 'tool_call.arguments.delta',
  TOOL_CALL_DONE: 'tool_call.done',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
});

/** 把内核的 finishReason 映射为 DSH 的终止原因。 */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'tool_calls':
    case 'tool-calls':
      return { kind: 'tool-calls' };
    case 'length':
    case 'max-tokens':
      return { kind: 'max-tokens' };
    default:
      return { kind: 'stop' };
  }
}

/**
 * 有状态的块索引分配器。
 *
 * 为什么需要状态：内核的 text / reasoning / tool_call 是三类独立事件流，
 * 而 DSH 要求每个块先声明 block-start、结束时 block-end。索引必须连续
 * 且不与已关闭的块冲突。
 */
export function createChunkBuilder() {
  let nextIndex = 0;
  let textIndex = null;
  let reasoningIndex = null;
  const toolIndexes = new Map(); // toolCallId → 块索引

  const close = (out, index, type) => {
    if (index === null) return;
    out.push({ type: 'block-end', index, block: { type, text: '' } });
  };

  return {
    closeText(out) { close(out, textIndex, 'text'); textIndex = null; },
    closeReasoning(out) { close(out, reasoningIndex, 'reasoning'); reasoningIndex = null; },

    ensureText(out) {
      if (textIndex !== null) return textIndex;
      // 进入正文意味着思考阶段结束，先关推理块以保持与真实输出的块顺序一致。
      this.closeReasoning(out);
      textIndex = nextIndex++;
      out.push({ type: 'block-start', index: textIndex, blockType: 'text' });
      return textIndex;
    },

    ensureReasoning(out) {
      if (reasoningIndex !== null) return reasoningIndex;
      reasoningIndex = nextIndex++;
      out.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' });
      return reasoningIndex;
    },

    ensureTool(out, toolCallId, name) {
      let index = toolIndexes.get(toolCallId);
      if (index !== undefined) return index;
      this.closeReasoning(out);
      this.closeText(out);
      index = nextIndex++;
      toolIndexes.set(toolCallId, index);
      out.push({
        type: 'tool-call-delta',
        index,
        id: toolCallId,
        name: name || '',
        argumentsDelta: '',
      });
      return index;
    },
  };
}

/**
 * 把内核事件生成器转换为 DSH chunk 生成器。
 *
 * @param {AsyncIterable<object>} events 内核内部事件
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function* translateInternalEvents(events, { signal, types } = {}) {
  const T = types || FALLBACK_TYPES;
  const builder = createChunkBuilder();
  let finishReason = null;
  let usage = null;
  let sawAny = false;

  for await (const event of events) {
    if (signal?.aborted) {
      const err = new Error('请求已取消');
      err.code = 'ABORTED';
      throw err;
    }

    const out = [];
    switch (event.type) {
      case T.RUN_STARTED:
      case T.MESSAGE_STARTED:
        sawAny = true;
        break;

      case T.REASONING_DELTA: {
        sawAny = true;
        if (event.delta) {
          const index = builder.ensureReasoning(out);
          out.push({ type: 'reasoning-delta', index, text: event.delta });
        }
        break;
      }

      case T.TEXT_DELTA: {
        sawAny = true;
        if (event.delta) {
          const index = builder.ensureText(out);
          out.push({ type: 'text-delta', index, text: event.delta });
        }
        break;
      }

      case T.TOOL_CALL_STARTED: {
        sawAny = true;
        const index = builder.ensureTool(out, event.toolCallId, event.name);
        // 首片必须带 id/name，DSH 才能把后续参数增量关联到这次调用。
        break;
      }

      case T.TOOL_CALL_ARGUMENTS_DELTA: {
        if (event.delta) {
          const index = builder.ensureTool(out, event.toolCallId, event.name);
          out.push({
            type: 'tool-call-delta',
            index,
            id: event.toolCallId,
            argumentsDelta: event.delta,
          });
        }
        break;
      }

      case T.TOOL_CALL_DONE:
        // 参数已通过增量送完；done 只用于确认，无需额外 chunk。
        break;

      case T.RUN_COMPLETED: {
        finishReason = event.finishReason ?? 'stop';
        if (event.usage) {
          usage = {
            inputTokens: Number(event.usage.inputTokens) || 0,
            outputTokens: Number(event.usage.outputTokens) || 0,
          };
        }
        break;
      }

      case T.RUN_FAILED: {
        builder.closeReasoning(out);
        builder.closeText(out);
        for (const chunk of out) yield chunk;
        // 错误必须以异常形式离开本生成器，绝不能产出一个 text 块——
        // 否则客户端会把报错当模型回答渲染并写进会话历史。
        throw makeUpstreamError(event.error);
      }

      default:
        break;
    }

    for (const chunk of out) yield chunk;
  }

  const tail = [];
  builder.closeReasoning(tail);
  builder.closeText(tail);
  for (const chunk of tail) yield chunk;

  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: mapFinishReason(finishReason) };

  // 空流（上游既无正文也无错误）应显式失败，避免 DSH 认为"模型回答了空内容"。
  if (!sawAny) {
    const err = new Error('上游未返回任何内容');
    err.code = 'EMPTY_RESPONSE';
    throw err;
  }
}

function makeUpstreamError(error) {
  const err = new Error(error?.message || '上游请求失败');
  err.code = mapErrorCode(error);
  if (error?.status) err.status = error.status;
  return err;
}

function mapErrorCode(error) {
  const type = String(error?.type || '');
  const status = Number(error?.status);
  if (status === 429 || type === 'rate_limit_error') return 'RATE_LIMIT';
  if (status === 401 || status === 403) return 'INVALID_CREDENTIAL';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return error?.code ? String(error.code) : 'UPSTREAM_ERROR';
}
