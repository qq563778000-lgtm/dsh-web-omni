/**
 * OmniAPI (OpenAI Chat Completions) SSE → DSH StreamChunk 映射
 *
 * 为什么单独成模块并做成纯函数生成器：
 * 协议映射的每一处偏差都会表现为"模型答非所问"或"用不了工具"，
 * 是最需要单测覆盖的部分。把它与网络请求分离，测试就不需要起服务。
 *
 * DSH 的 chunk 契约（见 @deepseek-ai/dsh-llm 的 BlockAssembler）：
 *   block-start { index, blockType }
 *   text-delta / reasoning-delta { index, text }
 *   tool-call-delta { index, id, name?, argumentsDelta }
 *   block-end { index, block }
 *   usage { usage: { inputTokens, outputTokens } }
 *   finish { reason: { kind }, replayState? }
 *
 * 成功流必须恰好以一个 finish 结束，否则 DSH 侧不会结算用量。
 */

/** 把 finish_reason 映射为 DSH 的终止原因。 */
export function mapFinishReason(reason) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' };
    case 'length':
      return { kind: 'max-tokens' };
    default:
      return { kind: 'stop' };
  }
}

/**
 * 按 SSE 协议切分缓冲区。
 *
 * 只按空行切分（SSE 的事件分隔符），不能按单个 `data:` 切：
 * 一个事件可能跨多个 TCP 分片，也可能一次到达多个事件。
 *
 * @param {string} buffer 累积缓冲
 * @returns {{ events: string[], rest: string }} 完整事件的 data 负载与残余缓冲
 */
export function splitSseBuffer(buffer) {
  // SSE 事件以空行分隔；\r\n 与 \n 都要支持（不同代理会改写换行）。
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';

  const events = [];
  for (const part of parts) {
    const dataLines = part
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart());
    if (dataLines.length === 0) continue;
    events.push(dataLines.join('\n'));
  }
  return { events, rest };
}

/**
 * 判断一个 data 负载是否是结束标记。
 * 各家实现写法不一（`[DONE]`、`[DONE]\n\n` 等），统一去空白比较。
 */
export function isDoneMarker(payload) {
  return String(payload).trim() === '[DONE]';
}

/**
 * 把单个 OmniAPI chunk 翻译为若干 DSH chunk。
 *
 * 设计取舍：这里用"累积状态"而非无状态转换，原因有三：
 *   1. DSH 要求 block-start 先于任何 delta，而 OpenAI 的 content 与
 *      reasoning_content 是混在同一个 delta 里的，谁先出现不确定；
 *   2. 一个 OpenAI chunk 可能同时含 reasoning 与 content，需要拆成两个块；
 *   3. usage 只出现在最后一个 chunk，finish 必须在它之后发出。
 *
 * @returns {object} 持有内部状态、暴露 push 与 finish 的转换器
 */
export function createChunkTranslator() {
  let nextIndex = 0;
  let textIndex = null;       // 当前打开的文本块
  let reasoningIndex = null;  // 当前打开的推理块
  // OpenAI tool_calls 的 index → 块状态。用它而非 id 作主键，原因见 push()。
  const toolStates = new Map();
  let usage = null;
  let finishReason = null;
  let sawAnyChunk = false;

  const closeText = (out) => {
    if (textIndex === null) return;
    out.push({ type: 'block-end', index: textIndex, block: { type: 'text', text: '' } });
    textIndex = null;
  };
  const closeReasoning = (out) => {
    if (reasoningIndex === null) return;
    out.push({ type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: '' } });
    reasoningIndex = null;
  };

  return {
    /** 处理一个已解析的 OpenAI chunk。 */
    push(chunk) {
      const out = [];
      if (!chunk || typeof chunk !== 'object') return out;
      sawAnyChunk = true;

      // 流内错误：本项目的 /v1/chat/completions 在失败时下发
      // 不带 choices 的 {"error":{...}}。这里必须抛出而非当作文本，
      // 否则用户会看到一段报错被当成模型回答。
      if (chunk.error) {
        const err = new Error(chunk.error.message || 'OmniAPI upstream error');
        err.code = chunk.error.code || chunk.error.type || 'UPSTREAM_ERROR';
        throw err;
      }

      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      const delta = choice?.delta || {};

      // 推理内容先于正文：DeepSeek 先输出思考再输出答案。
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        if (reasoningIndex === null) {
          reasoningIndex = nextIndex++;
          out.push({ type: 'block-start', index: reasoningIndex, blockType: 'reasoning' });
        }
        out.push({ type: 'reasoning-delta', index: reasoningIndex, text: delta.reasoning_content });
      }

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        // 推理结束进入正文时先关闭推理块，保证 DSH 侧的块顺序与真实输出一致。
        closeReasoning(out);
        if (textIndex === null) {
          textIndex = nextIndex++;
          out.push({ type: 'block-start', index: textIndex, blockType: 'text' });
        }
        out.push({ type: 'text-delta', index: textIndex, text: delta.content });
      }

      if (Array.isArray(delta.tool_calls)) {
        closeReasoning(out);
        closeText(out);
        for (const call of delta.tool_calls) {
          // 主键必须用 OpenAI 的 index，不能用 id。
          //
          // 只有首个分片带 id/name，后续分片只带 arguments 增量与 index；
          // 若以 id 为主键，后续增量会因为"没有 id"而被当成一次新调用，
          // 结果是工具被拆成两个、参数全部丢失（实测到此）。
          const key = call.index ?? 0;
          let state = toolStates.get(key);
          const isNew = state === undefined;
          if (isNew) {
            state = { index: nextIndex++, id: null, name: null };
            toolStates.set(key, state);
          }
          if (typeof call.id === 'string' && call.id.length > 0) state.id = call.id;
          if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
            state.name = call.function.name;
          }
          // 部分实现不给 id，用块序号兜底，保证 DSH 侧每次都能拿到稳定 id。
          if (!state.id) state.id = `tool_${state.index}`;

          const argsDelta = call.function?.arguments;
          const hasArgs = typeof argsDelta === 'string' && argsDelta.length > 0;

          // 新块必须先声明 id/name，DSH 才能建立调用与参数增量的关联；
          // 之后只传参数增量，避免重复声明造成 name 被清空。
          if (isNew) {
            out.push({
              type: 'tool-call-delta',
              index: state.index,
              id: state.id,
              name: state.name || '',
              argumentsDelta: '',
            });
          }
          if (hasArgs) {
            out.push({
              type: 'tool-call-delta',
              index: state.index,
              id: state.id,
              argumentsDelta: argsDelta,
            });
          }
        }
      }

      if (chunk.usage) {
        usage = {
          inputTokens: Number(chunk.usage.prompt_tokens) || 0,
          outputTokens: Number(chunk.usage.completion_tokens) || 0,
        };
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }

      return out;
    },

    /**
     * 结束流：关闭未闭合的块并产出 usage / finish。
     * @returns {object[]} 收尾 chunk
     */
    finish() {
      const out = [];
      closeReasoning(out);
      closeText(out);

      if (usage) out.push({ type: 'usage', usage });
      out.push({ type: 'finish', reason: mapFinishReason(finishReason) });
      return out;
    },

    /** 流是否收到过任何有效 chunk（用于识别上游空流）。 */
    get sawChunk() {
      return sawAnyChunk;
    },
  };
}

/**
 * 把一个可读的 SSE 字节流转换为 DSH chunk 生成器。
 *
 * @param {ReadableStream<Uint8Array>} body 上游响应体
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {AsyncGenerator<object>}
 */
export async function* translateOmniStream(body, { signal } = {}) {
  const translator = createChunkTranslator();
  const decoder = new TextDecoder();
  let buffer = '';

  const reader = body.getReader();
  try {
    while (true) {
      if (signal?.aborted) {
        const err = new Error('OmniAPI request aborted');
        err.code = 'ABORTED';
        throw err;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = splitSseBuffer(buffer);
      buffer = rest;

      for (const payload of events) {
        if (isDoneMarker(payload)) {
          for (const chunk of translator.finish()) yield chunk;
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          // 单帧解析失败不应中断整个流：上游偶发会插入空行或注释帧。
          continue;
        }
        for (const chunk of translator.push(parsed)) yield chunk;
      }
    }

    // 流自然结束却没有 [DONE]：仍要收尾，否则 DSH 侧不会结算用量。
    if (translator.sawChunk) {
      for (const chunk of translator.finish()) yield chunk;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* 已被取消时释放会抛，忽略 */ }
  }
}
