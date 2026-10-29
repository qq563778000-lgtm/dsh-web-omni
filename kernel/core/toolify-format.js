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
