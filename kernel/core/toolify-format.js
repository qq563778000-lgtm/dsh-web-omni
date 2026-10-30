import { InternalAPIError } from './errors.js';
import { normalizeToolArguments } from './internal-request.js';
import { textFromContent } from '../utils/response-utils.js';

function wrapCdata(text) {
  const safe = String(text || '').replace(/]]>/g, ']]]]><![CDATA[>');
  return `<![CDATA[${safe}]]>`;
}

function parseArgumentsObject(argumentsValue, toolName = 'tool') {
  if (argumentsValue == null || argumentsValue === '') return {};
  if (argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)) return argumentsValue;
  if (typeof argumentsValue === 'string') {
    try {
      const parsed = JSON.parse(argumentsValue || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (err) {
      throw new InternalAPIError(`Invalid assistant.tool_calls arguments for tool '${toolName}': ${err.message}`, {
        status: 400,
        type: 'invalid_request_error',
        code: 'invalid_tool_arguments',
      });
    }
  }
  throw new InternalAPIError(`Invalid assistant.tool_calls arguments for tool '${toolName}': arguments must be a JSON object`, {
    status: 400,
    type: 'invalid_request_error',
    code: 'invalid_tool_arguments',
  });
}

function toolCallName(call) {
  return call?.function?.name || call?.name || '';
}

function toolCallArguments(call) {
  return call?.function?.arguments ?? call?.arguments ?? '{}';
}

export function buildToolCallIndexFromMessages(messages = [], seedIndex = null) {
  const index = new Map(seedIndex instanceof Map ? seedIndex : []);
  for (const message of messages || []) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const id = call?.id;
      const name = toolCallName(call);
      if (!id || !name) continue;
      const argsObject = parseArgumentsObject(toolCallArguments(call), name);
      index.set(id, {
        name,
        arguments: JSON.stringify(argsObject),
      });
    }
  }
  return index;
}

export function formatAssistantToolCallsForAI(toolCalls = [], triggerSignal) {
  if (!triggerSignal || !Array.isArray(toolCalls) || toolCalls.length === 0) return '';

  const xmlCalls = toolCalls.map(call => {
    const name = toolCallName(call);
    if (!name) {
      throw new InternalAPIError('Invalid assistant.tool_calls entry: missing tool name', {
        status: 400,
        type: 'invalid_request_error',
        code: 'invalid_tool_call',
      });
    }
    const argsObject = parseArgumentsObject(toolCallArguments(call), name);
    const argsJson = JSON.stringify(argsObject);
    return `<function_call>\n<tool>${name}</tool>\n<args_json>${wrapCdata(argsJson)}</args_json>\n</function_call>`;
  }).join('\n');

  return `${triggerSignal}\n<function_calls>\n${xmlCalls}\n</function_calls>`;
}

// 参数回显用于帮模型把结果对应回调用（并行调用时靠它区分），原样回显不做截断。
function argsEcho(toolArguments) {
  return String(toolArguments || '{}');
}

// Read 类工具结果返回后，是模型决定"接下来怎么修改这个文件"的时刻——
// 真实场景中模型在此最容易错选写入工具整文件重写。这里没有 tools 上下文，
// 措辞保持通用（不点名工具），具体工具名由系统提示词的硬规则给出，
// 避免向未暴露编辑工具的客户端推荐不存在的工具名。
const READ_LIKE_TOOL_RX = /^(?:read|read_file|readfile|read_files|read_many_files|view|view_file|open_file|cat|cat_file|notebook_?read|read_notebook)$/i;

function editFirstNudge(toolName) {
  if (!READ_LIKE_TOOL_RX.test(String(toolName || '').trim())) return '';
  return '\n提醒：若下一步要修改刚读取的这个文件——它是已存在文件，必须用编辑类工具做精确替换、只提交需要变更的片段；禁止用写入类工具整文件重写覆盖，任何没有原样复述进参数的内容都会被删除。';
}

export function formatToolResultForAI(toolName, toolArguments, resultContent) {
  return `[系统通知] 以下是你调用的工具 \`${toolName}\` 的执行结果。

工具名称：${toolName}
调用参数：${argsEcho(toolArguments)}
执行结果：
<tool_result>
${wrapCdata(resultContent ?? '')}
</tool_result>

请基于以上结果判断任务进度：未完成则按工具调用格式继续调用所需工具（修改后重新 Read 验证、重新运行测试都是正当调用）；全部完成则直接用自然语言总结回复用户，禁止空回复。不要用完全相同的参数重复这一次已返回结果的调用。${editFirstNudge(toolName)}`;
}

export function preprocessMessagesForToolify(messages = [], triggerSignal, seedToolCallIndex = null) {
  if (!triggerSignal) return messages || [];
  const toolCallIndex = buildToolCallIndexFromMessages(messages, seedToolCallIndex);
  const processed = [];

  for (const message of messages || []) {
    if (!message || typeof message !== 'object') {
      processed.push(message);
      continue;
    }

    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const originalText = textFromContent(message.content);
      const xml = formatAssistantToolCallsForAI(message.tool_calls, triggerSignal);
      const finalText = [originalText, xml].filter(Boolean).join('\n');
      const { tool_calls: _toolCalls, ...rest } = message;
      processed.push({
        ...rest,
        role: 'assistant',
        content: [{ type: 'text', text: finalText }],
      });
      continue;
    }

    if (message.role === 'tool') {
      const toolCallId = message.tool_call_id || message.toolCallId;
      if (!toolCallId) {
        throw new InternalAPIError('Tool message missing tool_call_id', {
          status: 400,
          type: 'invalid_request_error',
          code: 'invalid_tool_message',
        });
      }
      const toolInfo = toolCallIndex.get(toolCallId);
      if (!toolInfo) {
        throw new InternalAPIError(
          `tool_call_id=${toolCallId} not found in conversation history. Ensure the assistant message with this tool_call is included in the messages array.`,
          { status: 400, type: 'invalid_request_error', code: 'invalid_tool_message' },
        );
      }
      processed.push({
        role: 'user',
        content: [{
          type: 'text',
          text: formatToolResultForAI(toolInfo.name, toolInfo.arguments || normalizeToolArguments({}), textFromContent(message.content)),
        }],
      });
      continue;
    }

    processed.push(message);
  }

  return processed;
}

// ---------------------------------------------------------------------------
// 历史压缩：控制上行上下文规模
//
// 真实故障（2026-10-30 DSH）：同一会话 turn 1 的上行约 187K 字符时成功，
// turn 2 涨到 228K 字符后上游返回**完全空流**。上游的上下文上限就在这两个
// 值之间（约 80K tokens），超过后不是报错，而是静默返回空——最难排查的一种。
//
// 工具结果是唯一的膨胀源：一次 get_my_tasks 就能带来 5 万字符，多轮累积后
// 历史里 80% 是已经被消费掉的旧结果。它们对后续推理的价值远低于最近一轮。
//
// 压缩策略（保守）：
//   - 只动 role==='tool' 的消息内容，不碰 user / assistant / system
//   - 最近 K 条工具结果原样保留——模型当前正在用它们
//   - 更早的替换为「占位说明」，保留工具名与原始长度，便于模型判断是否要
//     重新调用工具（比无声丢弃安全：模型知道这里曾有数据）
//   - 幂等：已压缩过的内容再次压缩结果不变，避免每轮改写导致前缀哈希漂移
// ---------------------------------------------------------------------------

/** 压缩占位的统一前缀，用于幂等判断。 */
const COMPACT_MARKER = '[历史工具结果已压缩]';

/**
 * 估算一组消息的上下文字符数。
 *
 * 与代理实际上行规模口径一致：把每条消息的内容序列化后求长度。
 * 不做精确 token 估算——上限是经验值，量级对得上就够了。
 */
export function estimateContextChars(messages = []) {
  let total = 0;
  for (const m of messages || []) {
    const c = m?.content;
    if (typeof c === 'string') total += c.length;
    else if (c != null) {
      try { total += JSON.stringify(c).length; } catch { /* 循环引用等异常忽略 */ }
    }
    if (Array.isArray(m?.tool_calls)) {
      try { total += JSON.stringify(m.tool_calls).length; } catch { /* 同上 */ }
    }
  }
  return total;
}

/**
 * 压缩超长历史中的旧工具结果，使总量回到 maxChars 以内。
 *
 * 返回新的消息数组（不修改入参），调用方可直接用于构建 prompt。
 * 若总量本来就没超限，原样返回入参。
 */
export function compactToolResults(messages = [], { maxChars = 150000, keepRecent = 2 } = {}) {
  if (!Array.isArray(messages) || !messages.length) return messages;
  if (estimateContextChars(messages) <= maxChars) return messages;

  // 收集所有工具结果消息的下标，从后往前保留 keepRecent 条。
  const toolIdx = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'tool') toolIdx.push(i);
  }
  if (toolIdx.length <= keepRecent) {
    // 工具结果太少，压缩它们也救不回规模；交给调用方决定（例如重开会话）。
    return messages;
  }

  const out = messages.slice();
  const protecedFrom = toolIdx.length - keepRecent;
  let total = estimateContextChars(messages);

  // 从最旧的开始压缩，直到回到阈值以内。
  for (let n = 0; n < protecedFrom && total > maxChars; n++) {
    const idx = toolIdx[n];
    const msg = out[idx];
    const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
    // 已经压缩过：跳过（幂等，避免重复改写导致前缀哈希漂移）
    if (raw.startsWith(COMPACT_MARKER)) continue;

    const placeholder = `${COMPACT_MARKER}（原始 ${raw.length} 字符已省略，本轮对话早期获取。`
      + `如果后续推理确实需要这些数据，请重新调用对应工具获取最新结果。）`;
    total -= raw.length - placeholder.length;
    out[idx] = { ...msg, content: placeholder };
  }

  return out;
}
