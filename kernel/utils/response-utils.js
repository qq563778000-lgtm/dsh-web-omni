/**
 * 共享响应工具函数
 *
 * 提供 SSE 写入、文本提取、工具调用解析等跨渠道共享工具
 *
 * ============ 高可用设计要点 ============
 * 1. 安全写入：所有 res.write() 调用前检查 writableEnded
 * 2. 缓冲上限：contentBuffer 最大 256KB，超出后降级为实时输出
 * 3. 客户端断开：正确清理所有资源，避免未处理 rejection
 * 4. 工具解析鲁棒性：深度JSON提取 + XML提取 + 多形式兼容
 *
 * ============ Python 桥提升点 ============
 * 1. _extract_first_json_object: 深度计数提取嵌套JSON
 * 2. _extract_code_block: 提取code fence内内容
 * 3. normalizeRequestedModelName: 剥离[1m]后缀
 * 4. hasToolHistory: 从历史消息检测工具行为
 * 5. 分层异常 + 状态码传播
 */

import { fileLabelForContentPart } from './message-files.js';
import { isPromptInjectionEnabled } from './env.js';

// ============================================================
// 安全 SSE 写入
// ============================================================

function isWritable(res) {
  return res && !res.writableEnded && !res.destroyed;
}

export function flushSSE(res) {
  try {
    if (!isWritable(res)) return;
    if (res.flush) res.flush();
    else if (res._flush) res._flush();
    const socket = res.socket || res._socket;
    if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
  } catch { /* 静默 */ }
}

export function writeSSE(res, payload) {
  if (!isWritable(res)) return false;
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    flushSSE(res);
    return true;
  } catch { return false; }
}

export function writeClaudeSSE(res, event) {
  if (!isWritable(res)) return false;
  try {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    flushSSE(res);
    return true;
  } catch { return false; }
}

export function safeEnd(res) {
  if (isWritable(res)) {
    try { res.end(); } catch { /* 忽略 */ }
  }
}

export function setTCPNoDelay(req) {
  const socket = req.socket || req.connection;
  if (socket && typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
}

export function isPromptInjectionDisabledForRequest(req) {
  if (typeof req?.omni?.promptInjectionEnabled === 'boolean') {
    return !req.omni.promptInjectionEnabled;
  }
  return !isPromptInjectionEnabled();
}

export function getRawJsonPromptForRequest(req) {
  if (typeof req?.omni?.rawRequestJsonText === 'string') return req.omni.rawRequestJsonText;
  if (Buffer.isBuffer(req?.rawBody)) return req.rawBody.toString('utf8');
  if (req?.rawBody != null) return String(req.rawBody);
  return JSON.stringify(req?.body ?? {}, null, 2);
}

/**
 * When prompt injection is disabled, send the complete raw client request JSON
 * body as the Web prompt. Do not extract, relabel, or concatenate messages.
 */
export function buildDisabledPrompt(req) {
  return getRawJsonPromptForRequest(req);
}

export function captureRawJsonPromptMetadata(req) {
  req.omni = {
    ...(req.omni || {}),
    promptInjectionEnabled: isPromptInjectionEnabled(),
    rawRequestJsonText: getRawJsonPromptForRequest(req),
  };
  return req.omni;
}

// ============================================================
// 客户端断开监听
// ============================================================

export function setupClientDisconnect(req, streamBody) {
  let clientGone = false;
  let cancelling = false;

  const onClose = async () => {
    clientGone = true;
    if (streamBody && !cancelling) {
      cancelling = true;
      try { await streamBody.cancel(); } catch { /* 静默 */ }
    }
  };

  req.on('close', onClose);

  const cleanup = () => {
    req.off('close', onClose);
  };

  return { clientGone, cleanup };
}

// ============================================================
// contentBuffer 安全上限
// ============================================================

const MAX_BUFFER_SIZE = 256 * 1024;

export function safeAppendToBuffer(buffer, content) {
  if (!content) return { buffer, truncated: false };
  if (buffer.length + content.length > MAX_BUFFER_SIZE) {
    const remaining = MAX_BUFFER_SIZE - buffer.length;
    if (remaining <= 0) return { buffer, truncated: true };
    return { buffer: buffer + content.slice(0, remaining), truncated: true };
  }
  return { buffer: buffer + content, truncated: false };
}

// ============================================================
// 文本内容提取
// ============================================================

const AT_PATH_MENTION_RE = /(^|[\s([{"'“‘<，。：；、])@(?=(?:[A-Za-z]:[\\/]|\/(?:Users|home|Volumes|Applications|tmp|var|private|opt|etc|usr|bin|sbin|lib|System|Library)(?:[\\/]|$)))/g;

/**
 * 过滤 Claude Code 等客户端注入的 @路径 引用前缀。
 * 仅移除绝对路径前的 @，避免误伤邮箱、社交账号或普通 @ 文本。
 */
export function sanitizePathMentions(text) {
  if (typeof text !== 'string' || !text.includes('@')) return text || '';
  return text.replace(AT_PATH_MENTION_RE, '$1');
}

export function normalizeJsonEscapedText(value) {
  if (typeof value !== 'string') return value == null ? '' : String(value);

  let text = value;
  for (let i = 0; i < 3; i++) {
    const trimmed = text.trim();
    let decoded = null;

    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'string') decoded = parsed;
      } catch { /* keep original */ }
    } else if (/\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/.test(text)) {
      try {
        const parsed = JSON.parse(`"${text}"`);
        if (typeof parsed === 'string') decoded = parsed;
      } catch { /* keep original */ }
    }

    if (decoded == null || decoded === text) break;
    text = decoded;
  }

  return text;
}

export function textFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return sanitizePathMentions(normalizeJsonEscapedText(content));
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part.type === 'text') return sanitizePathMentions(normalizeJsonEscapedText(part.text || ''));
      if (part.type === 'image_url') return '[Image]';
      if (part.type === 'image_source') return '[Image]';
      if (part.type === 'file' || part.type === 'input_file') return fileLabelForContentPart(part);
      return sanitizePathMentions(JSON.stringify(part));
    }).filter(Boolean).join('\n');
  }
  if (content.type === 'text' && typeof content.text === 'string') {
    return sanitizePathMentions(normalizeJsonEscapedText(content.text));
  }
  return sanitizePathMentions(JSON.stringify(content));
}

// ============================================================
// Python桥提升1: 模型名称归一化
// ============================================================

/**
 * 归一化请求的模型名称
 * - 剥离 `[1m]` 后缀（Claude Code 附加的上下文窗口提示）
 * - 去除首尾空格
 *
 * 源自 python _normalize_requested_model_name
 */
export function normalizeRequestedModelName(value) {
  if (!value || typeof value !== 'string') return '';
  let normalized = value.trim();
  // Claude Code can append local context-window hints such as "[1m]".
  while (normalized.endsWith('[1m]')) {
    normalized = normalized.slice(0, -4).trimEnd();
  }
  return normalized;
}

// ============================================================
// 工具调用规范化（API 输出端点友好层）
// ============================================================

export function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(tool => tool?.type === 'function' && tool.function?.name)
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: Object.prototype.hasOwnProperty.call(tool.function, 'parameters') ? tool.function.parameters : { type: 'object', properties: {} },
      },
    }));
}

const CODING_TOOL_NAMES = new Set([
  'read', 'edit', 'write', 'multiedit', 'notebookedit',
  'bash', 'glob', 'grep', 'ls', 'webfetch', 'websearch',
  'apply_patch', 'applypatch', 'todowrite', 'task',
]);

function isCodingToolName(name) {
  return CODING_TOOL_NAMES.has(String(name || '').toLowerCase().replace(/[\s-]/g, ''));
}

function isCodingToolset(tools) {
  return tools.some(tool => {
    const fn = tool.function || {};
    const props = Object.keys(fn.parameters?.properties || {}).map(k => k.toLowerCase());
    return isCodingToolName(fn.name)
      || props.includes('file_path')
      || props.includes('command')
      || props.includes('old_string')
      || props.includes('new_string')
      || props.includes('pattern');
  });
}

function summarizeDescription(description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (text.length <= 180) return text;
  return `${text.slice(0, 177)}...`;
}

function simplifyParameters(parameters, compact = false) {
  if (!compact || !parameters?.properties) return parameters ?? { type: 'object', properties: {} };
  const simplified = {
    type: parameters.type || 'object',
    properties: {},
  };
  if (Array.isArray(parameters.required) && parameters.required.length) {
    simplified.required = parameters.required;
  }
  for (const [key, value] of Object.entries(parameters.properties || {})) {
    simplified.properties[key] = {
      type: value?.type || (value?.enum ? 'string' : 'object'),
    };
    if (value?.description) simplified.properties[key].description = summarizeDescription(value.description);
    if (value?.enum) simplified.properties[key].enum = value.enum;
    if (value?.items?.type) simplified.properties[key].items = { type: value.items.type };
  }
  return simplified;
}

function forcedToolName(toolChoice) {
  return toolChoice?.function?.name || toolChoice?.name || undefined;
}

export function buildToolInstructions(tools, toolChoice = 'auto', customPrefix = null) {
  if (!isPromptInjectionEnabled()) return '';

  const normalized = normalizeTools(tools);
  if (!normalized.length || toolChoice === 'none') return '';

  const codingProfile = isCodingToolset(normalized);

  // Build simplified tool list for display (name + description + parameters)
  const toolList = normalized.map(t => ({
    name: t.function.name,
    description: summarizeDescription(t.function.description || ''),
    parameters: simplifyParameters(t.function.parameters, codingProfile),
  }));

  // Build an example tool-call object using the first tool (if any)
  let exampleToolCall = '';
  if (toolList.length > 0) {
    const firstTool = toolList[0];
    const firstPropKeys = Object.keys(firstTool.parameters?.properties || {});
    const exampleArgs = {};
    for (const key of firstPropKeys) {
      exampleArgs[key] = 'value';
    }
    exampleToolCall = `{"assistant_response": null, "tool_calls": [{"name": "${firstTool.name}", "arguments": ${JSON.stringify(exampleArgs)}}]}`;
  }

  // Build dynamic tool_choice instruction (appended to rules)
  const choiceLines = [];
  const forcedName = forcedToolName(toolChoice);
  if (toolChoice === 'required') {
    choiceLines.push('你必须调用至少一个工具。');
  } else if (forcedName && normalized.some(t => t.function.name === forcedName)) {
    choiceLines.push(`你必须调用工具 \`${forcedName}\`，不要调用其他工具。`);
  }
  const choiceSection = choiceLines.length > 0 ? `\n\n工具选择约束：\n${choiceLines.join('\n')}` : '';

  // Default preamble
  const preamble = customPrefix || '你是全栈开发与运维专家。编程时重视代码正确性和可读性；办公场景给出自动化方法；运维场景给出安全最佳实践；日常问题经过思考后认真回答（禁止输出知识截止信息）。必须严格遵循后续 JSON 输出规范。';

  const codingGuide = codingProfile ? `

Vibe coding 工具使用规则：
- 你正在为 Claude Code / Codex 这类编程客户端选择内置工具，目标是推进真实软件开发任务。
- 查看文件优先使用 Read；搜索文件名优先 Glob；搜索内容优先 Grep；不要用 Bash 执行 cat/grep/find 来替代这些专用工具。
- Read 大文件必须分段读取：优先使用 limit 控制单次读取量，继续阅读时使用 offset 接续；不要一次性读取明显很大的日志、构建产物、锁文件或压缩后的长文件。
- 只需要定位符号/文本时先用 Grep/Glob 缩小范围，再 Read 相关片段；不要为了找一处代码读取整仓或整份大文件。
- 修改已有文件前必须先 Read 目标文件；只要目标文件已存在且含有内容，必须使用 Edit/MultiEdit 做精确修改，禁止直接用 Write 覆盖已有内容；只有创建新文件或目标文件确认为空时才使用 Write；Notebook 文件使用 NotebookEdit。
- Edit/MultiEdit 必须使用从 Read 结果确认过的精确 old_string；不确定上下文时先再次分段 Read，而不是猜测替换内容。
- Bash 只用于测试、构建、git、包管理、运行脚本或没有专用工具覆盖的命令；长输出命令应优先加过滤、分页或定向检查，避免把大量日志塞回上下文。
- Windows 路径必须使用完整绝对路径和反斜杠，例如 C:\\path\\to\\project\\src\\file.js。
- 工具返回后基于真实返回继续下一步，不要假设尚未读取的文件内容，不要虚构测试结果。
- 工具调用完成后必须反馈：如果无需继续调用工具，assistant_response 必须说明已完成的操作、关键结果、修改/验证情况或下一步建议，禁止以空内容结束多轮任务。` : '';

  const largeResultGuide = `

大结果工具调用规则：
- 调用工具前先对比可用工具及其参数，优先选择支持分页、过滤、字段选择、范围限制或按名称/ID 查询的工具；不要优先选择会返回全量数据的工具。
- 如果参数中存在 limit、offset、page、pageSize、cursor、nextCursor、take、skip、top、count、fields、columns、table、tableName、include、exclude 等字段，必须优先使用它们缩小单次返回范围。
- 不要一次性请求全量数据库 schema、全量日志、全量文件列表、全量搜索结果或全量业务记录；先获取数量、概要、表名、文件名或第一批结果，再按用户目标继续下一批。
- 对数据库/schema 类任务，优先先获取表名、数量或概要；只有用户需要具体结构时，再按表名分批查询字段和索引。
- 对列表/搜索类任务，先请求较小批次，例如 20、50 或 100 条；如果工具结果包含 nextCursor、hasMore、total、page、offset 等分页信息，后续调用必须基于这些信息继续。
- 每次工具返回后先判断信息是否已经足够回答用户；足够时必须输出 assistant_response 总结结果，禁止为了追求完整性继续拉取无关批次。
- 如果工具没有分页/过滤参数且预期返回很大，应先选择更窄范围的工具；没有更窄工具时，应请求用户限定范围，而不是盲目拉取全量。`;

  return `\n\n${preamble}${codingGuide}${largeResultGuide}

可用工具列表（以 JSON 格式呈现）：
${toolList.length > 0 ? JSON.stringify(toolList, null, 2) : '（无可用工具）'}

当可以直接回答用户时，输出以下格式的原始 JSON：
{"assistant_response": "输出Markdown风格（详细版）", "tool_calls": []}

当需要调用工具时（工具调用要慎重），必须输出以下格式的原始 JSON（不要包含任何 Markdown 代码块）：
${exampleToolCall || '{"assistant_response": null, "tool_calls": []}'}

规则：
- 只输出原始 JSON，不得包含 Markdown 围栏或额外文本。
- tool_calls 必须是数组（即使为空）。
- arguments 必须是 JSON 对象。
- 禁止编造不存在的工具名称。
- 工具名称必须完全等于可用工具列表中的 name。
- 当上文已有工具执行结果且不需要继续调用工具时，assistant_response 必须给出面向用户的完成说明/结果总结，tool_calls 必须为空数组；禁止返回空回复或只结束任务。${choiceSection}`;
}


/**
 * 【缺口8修复】构建持久化工具定义
 *
 * 当请求中没有显式 tools 参数，但对话历史中有工具调用记录时，
 * 重新注入工具定义到 system prompt，防止模型在后续轮次「忘记」
 * 还能调用工具。
 *
 * @param {Array} messages - 消息列表
 * @param {Array} tools - 当前请求的 tools
 * @param {Array} knownToolDefs - 从历史中持久化的工具定义缓存
 * @returns {string} 持久化工具指令（如有必要）
 */
export function buildPersistentToolDefs(messages, tools, knownToolDefs = []) {
  if (Array.isArray(tools) && tools.length > 0) return '';
  if (!hasToolHistory(messages)) return '';
  if (knownToolDefs.length > 0) {
    const toolList = knownToolDefs.map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || '',
      parameters: t.function?.parameters ?? t.parameters ?? { type: 'object', properties: {} },
    }));
    return `\n\n[持久化工具定义 — 以下工具仍然可用]：
${JSON.stringify(toolList, null, 2)}

如需调用工具（工具调用要慎重），使用以下 JSON 格式：
{"assistant_response": null, "tool_calls": [{"name": "${toolList[0].name}", "arguments": {"key": "value"}}]}

当不需要调用工具时：
{"assistant_response": "输出Markdown风格", "tool_calls": []}`;
  }
  return '';
}

// ============================================================
// 【缺口1修复】tool_choice 后处理校验
// ============================================================

/**
 * 对已解析的工具调用施加 tool_choice 约束。
 * 纯 prompt 软提示无法保证模型遵守 tool_choice，此处做硬性后处理。
 */
export function validateToolChoice(toolCalls, toolChoice, definedTools = []) {
  if (!toolCalls?.length && toolChoice === 'required') {
    return { toolCalls: null, content: null, warning: '[Tool choice was "required" but model returned no tool calls]' };
  }
  if (!toolCalls?.length) {
    return { toolCalls: null, content: null, warning: null };
  }
  if (toolChoice === 'none') {
    return { toolCalls: null, content: null, warning: '[Model returned tool calls despite tool_choice="none" — stripped]' };
  }
  const forcedName = toolChoice?.function?.name;
  if (forcedName) {
    const filtered = toolCalls.filter(tc => tc.function?.name === forcedName);
    if (filtered.length !== toolCalls.length) {
      return { toolCalls: filtered.length > 0 ? filtered : null, content: null, warning: `[${toolCalls.length - filtered.length} call(s) removed: only "${forcedName}" allowed]` };
    }
    return { toolCalls: filtered, content: null, warning: null };
  }
  return { toolCalls, content: null, warning: null };
}

/**
 * 【缺口3修复】工具名称白名单校验
 */
export function validateToolNames(toolCalls, definedTools = []) {
  if (!toolCalls?.length || !definedTools.length) return { toolCalls, filtered: 0 };
  const validNames = new Set(definedTools.map(t => t.function?.name).filter(Boolean));
  if (validNames.size === 0) return { toolCalls, filtered: 0 };
  const filtered = toolCalls.filter(tc => validNames.has(tc.function?.name));
  const removed = toolCalls.length - filtered.length;
  if (removed > 0) {
    const names = toolCalls.filter(tc => !validNames.has(tc.function?.name)).map(tc => tc.function?.name).filter(Boolean);
    console.warn(`[Tool validation] Removed ${removed} hallucinated tool(s): ${names.join(', ')}`);
  }
  return { toolCalls: filtered.length > 0 ? filtered : null, filtered: removed };
}

/**
 * 【缺口2修复】检测静默解析失败
 */
export function detectFailedToolParse(content, toolCallingEnabled) {
  if (!content || !toolCallingEnabled) return null;
  const lower = content.toLowerCase();
  if (lower.includes('<tool_calls')) return 'Content has <tool_calls> markup but failed to parse';
  if (lower.includes('<_calls')) return 'Content has <_calls> markup but failed to parse';
  if (/^\s*\{\s*"[^"]*"\s*:\s*/.test(lower) && /tool_calls/.test(lower)) return 'Content appears to have JSON tool calls but failed to parse';
  if (lower.includes('tool calling instructions') || lower.includes('available tools:')) return 'Content echoes tool-calling prompt instructions';
  return null;
}

// ============================================================
// 【防幻觉】内容消毒 — 剥离所有 prompt 泄漏和污染
// ============================================================

/**
 * 剥离模型输出中可能泄漏的系统 prompt 残留。
 * text-prompt 模式下，模型可能「复读」指令而不是执行。
 *
 * 覆盖的泄漏模式：
 *   - [System]: ...  — system prompt 头泄漏
 *   - [User]: ...    — 用户消息泄漏
 *   - [Assistant]: ... — 助手消息泄漏
 *   - [Tool result ...] — 工具结果泄漏
 *   - x-anthropic-billing-header: ... — 客户端元数据泄漏
 *   - Tool calling instructions — 工具定义复读
 *   - Available tools: — 工具列表复读
 *   - You have access to these tools: — 工具权限声明复读
 *   - [Assistant tool calls]: ... — 历史工具调用泄漏
 *
 * @param {string} text - 模型原始输出
 * @returns {string} 消毒后的文本
 */
export function sanitizeModelOutput(text) {
  if (!text) return text;

  // 剥离 [System]: 块（可能包含客户端的 system prompt）
  let result = text
    // [System]: x-anthropic-* 这类客户端元数据头
    .replace(/\[System\]:\s*x-anthropic-[^\n]*\n?/gi, '')
    // 整个 [System]: ... 块（直到下一个标记或结束）
    .replace(/\[System\]:[\s\S]*?(?=\[User\]|\[Assistant\]|$)/gi, '')
    // [User]: ... 块
    .replace(/\[User\]:[\s\S]*?(?=\[Assistant\]|\[Tool|$)/gi, '')
    // [Assistant tool calls]: ...
    .replace(/\[Assistant tool calls\]:[\s\S]*?(?=\n\[|\n*$)/gi, '')
    // [Tool result ...]: ... 块
    .replace(/\[Tool result[^\]]*\]:[\s\S]*?(?=\n\[|\n*$)/gi, '')
    // 孤立的 x-anthropic-* header
    .replace(/x-anthropic-[a-z-]+:\s*[^\n]+\n?/gi, '')
    // 工具指令复读
    .replace(/\[Tool calling instructions\][\s\S]*?(?=\[|\n\n|$)/g, '')
    // 工具列表复读
    .replace(/Available tools:\s*[\s\S]*?(?=\[|\n\n|$)/g, '')
    // You have access to/You are behind/You are an 这类指令残片
    .replace(/You (have access to|are behind|are an|must call|can answer)[^.]*\.\s*/gi, '')
    // 多余空行压缩
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return result;
}

/**
 * 【缺口4修复】参数消毒
 */
export function sanitizeToolArguments(toolCalls) {
  if (!toolCalls?.length) return toolCalls || [];
  return toolCalls.map(tc => {
    const fn = tc.function;
    if (!fn) return tc;
    const fnArgs = getObjectField(fn, 'arguments');
    if (typeof fnArgs === 'string') {
      try {
        const parsed = JSON.parse(fnArgs);
        if (parsed !== null && typeof parsed === 'object') return { ...tc, function: { ...fn, arguments: JSON.stringify(parsed) } };
      } catch {
        console.warn(`[Tool args] Invalid JSON in "${fn.name}": ${fnArgs.slice(0, 80)}`);
        return { ...tc, function: { ...fn, arguments: '{}' } };
      }
    }
    return tc;
  });
}

/**
 * 综合校验流水线：tool_choice → 白名单 → 参数消毒
 */
export function validateToolCallsPipeline(rawToolCalls, toolChoice, definedTools) {
  if (!rawToolCalls?.length) {
    const r = validateToolChoice(null, toolChoice, definedTools);
    return { toolCalls: null, warning: r.warning };
  }
  let calls = [...rawToolCalls];
  let warnings = [];
  const r1 = validateToolChoice(calls, toolChoice, definedTools);
  calls = r1.toolCalls;
  if (r1.warning) warnings.push(r1.warning);
  if (!calls?.length) return { toolCalls: null, warning: warnings.join('; ') || null };
  const r2 = validateToolNames(calls, definedTools);
  calls = r2.toolCalls;
  if (r2.filtered > 0) warnings.push(`Filtered ${r2.filtered} hallucinated tool(s)`);
  if (!calls?.length) return { toolCalls: null, warning: warnings.join('; ') || null };
  calls = sanitizeToolArguments(calls);
  if (warnings.length > 0) console.warn(`[Tool pipeline] ${warnings.join(' | ')}`);
  return { toolCalls: calls, warning: warnings.join('; ') || null };
}

// ============================================================
// 工具调用解析 — 鲁棒封装层
// ============================================================

function normalizeJsonQuotes(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

function escapeInvalidJsonBackslashes(value) {
  if (typeof value !== 'string' || !value.includes('\\')) return value;
  // DeepSeek sometimes emits Windows paths in JSON strings with single
  // backslashes, e.g. "C:\Users\...". JSON only allows a small set of escape
  // sequences, so double any backslash that is not starting a valid JSON escape.
  return value.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
}

function tryParseJson(value) {
  try { return JSON.parse(value); } catch {
    const normalized = normalizeJsonQuotes(value);
    try { return JSON.parse(normalized); } catch {
      try { return JSON.parse(escapeInvalidJsonBackslashes(normalized)); } catch { return null; }
    }
  }
}

function decodeJsonStringEscape(esc, source, index) {
  switch (esc) {
    case '"': return { text: '"', index };
    case '\\': return { text: '\\', index };
    case '/': return { text: '/', index };
    case 'b': return { text: '\b', index };
    case 'f': return { text: '\f', index };
    case 'n': return { text: '\n', index };
    case 'r': return { text: '\r', index };
    case 't': return { text: '\t', index };
    case 'u': {
      const hex = source.slice(index + 1, index + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { text: String.fromCharCode(parseInt(hex, 16)), index: index + 4 };
      }
      return { text: 'u', index };
    }
    default: return { text: esc, index };
  }
}

function extractRelaxedJsonStringField(text, field) {
  const key = new RegExp(`["“”]${field}["“”]\\s*:\\s*`, 'i');
  const match = key.exec(text);
  if (!match) return { found: false, value: null };

  let i = match.index + match[0].length;
  while (i < text.length && /\s/.test(text[i])) i++;

  if (/^null\b/i.test(text.slice(i))) return { found: true, value: null };
  if (text[i] !== '"') return { found: false, value: null };
  i++;

  let value = '';
  let escape = false;
  for (; i < text.length; i++) {
    const char = text[i];
    if (escape) {
      escape = false;
      const decoded = decodeJsonStringEscape(char, text, i);
      value += decoded.text;
      i = decoded.index;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      const rest = text.slice(i + 1);
      if (/^\s*(?:,|})/.test(rest)) {
        return { found: true, value };
      }
    }
    value += char;
  }

  return { found: false, value: null };
}

function parseRelaxedEmptyToolWrapper(text) {
  if (!/["“”]assistant_response["“”]\s*:/i.test(text)) return null;
  if (!/["“”]tool_calls["“”]\s*:\s*\[\s*\]/i.test(text)) return null;

  const assistantResponse = extractRelaxedJsonStringField(text, 'assistant_response');
  if (!assistantResponse.found) return null;

  return {
    toolCalls: null,
    content: typeof assistantResponse.value === 'string' ? assistantResponse.value.trim() : null,
  };
}

function extractXmlAttribute(attrs, name) {
  if (!attrs || !name) return null;
  const rx = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|([^\\s>]+))`, 'i');
  const match = attrs.match(rx);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function parseToolCallArgumentBody(body) {
  const trimmed = String(body || '').trim();
  if (!trimmed) return {};
  const parsed = tryParseJson(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  if (parsed.arguments !== undefined && Object.keys(parsed).length <= 2) return parsed.arguments;
  return parsed;
}

function parseXmlAttributeToolCalls(text) {
  if (!text) return null;
  const calls = [];
  const rx = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call\s*>/gi;
  let match;
  while ((match = rx.exec(text)) !== null) {
    const name = extractXmlAttribute(match[1], 'name');
    if (!name) continue;
    calls.push({ name, arguments: parseToolCallArgumentBody(match[2]) });
  }
  const toolCalls = toOpenAIToolCalls(calls);
  if (!toolCalls.length) return null;
  const content = stripToolBlocks(text);
  return { toolCalls, content: content || null };
}

/**
 * Python桥提升2: 提取 code fence 中的内容
 * 例如：```json\n{"key": "value"}\n``` → {"key": "value"}
 *
 * 源自 python _extract_code_block
 */
export function extractCodeBlock(text) {
  const match = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  return match ? match[1].trim() : null;
}

/**
 * Python桥提升3: 深度计数提取第一个 JSON 对象
 *
 * 通过计数 {} 嵌套深度找到完整 JSON 对象。
 * 即使被 markdown、自然语言等包裹也能提取。
 *
 * 源自 python _extract_first_json_object
 *
 * 例如:
 *   "Sure!\n```json\n{"tool_calls":[...]}\n```" → 提取完整 JSON
 *   "Let me check. {"assistant_response": null, "tool_calls": [...]}" → 同样提取
 */
export function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"') { inString = false; continue; }
      continue;
    }

    if (char === '"') { inString = true; continue; }
    if (char === '{') { depth++; continue; }
    if (char === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * 提取最后一个 <tag>...</tag> 块中的内容
 * 支持标签后跟属性、代码块包裹
 */
export function extractJsonBlock(text, tag) {
  const cleanText = text.replace(/```(?:json|xml|)\s*/gi, '').replace(/```\s*$/gm, '');
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const lowerText = cleanText.toLowerCase();
  const lastClose = lowerText.lastIndexOf(close);
  if (lastClose === -1) return null;
  const lastOpen = lowerText.lastIndexOf(open, lastClose);
  if (lastOpen === -1) return null;
  const inner = cleanText.slice(lastOpen + open.length, lastClose);
  const gt = inner.indexOf('>');
  const body = gt === -1 ? inner : inner.slice(gt + 1);
  const trimmed = body.trim();
  return trimmed || null;
}

/**
 * 从文本中移除工具调用标签
 * 支持不闭合的标签（防模型死循环）
 */
function stripTrailingCodeLanguageMarker(text) {
  return (text || '')
    .replace(/^\s*```(?:json|xml)?\s*/i, '')
    .replace(/(?:^|\n)\s*(?:json|xml)\s*$/i, '')
    .trim();
}

export function stripToolBlocks(text) {
  let result = text
    .replace(/```(?:json|xml|)\s*[\s\S]*?```/gi, '')
    // 完整的 <tool_calls>...</tool_calls> 对（含变体 tool_call_calls）
    .replace(/<tool_calls\b[^>]*>[\s\S]*?<\/tool_calls\s*>/gi, '')
    .replace(/<tool_call_calls[^>]*>[\s\S]*?<\/tool_call_calls\s*>/gi, '')
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi, '')
    // DeepSeek 原生 <_calls> 标签（v4-pro 在续轮中使用）
    .replace(/<_calls\b[^>]*>[\s\S]*?<\/_calls\s*>/gi, '')
    // <_calls> 包裹 JSON 数组（无关闭标签时匹配到 ] 数组结束）
    .replace(/<_calls\b[^>]*>\s*\[[\s\S]*?\]/gi, '')
    // <_calls> 立即后跟 [（属于标签+数组语法的一部分，但 ] 已被解析消耗）
    .replace(/<_calls\b[^>]*>\s*\[/gi, '')
    // 孤立的 <tool_calls> / <tool_call_calls> / <tool_call> / <_calls> 开头标签
    .replace(/<tool_calls\b[^>]*>/gi, '')
    .replace(/<tool_call_calls[^>]*>/gi, '')
    .replace(/<tool_call\b[^>]*>/gi, '')
    .replace(/<_calls\b[^>]*>/gi, '')
    // 孤立的 </tool_calls> / </tool_call_calls> / </tool_call> / </_calls> 结尾标签
    .replace(/<\/tool_calls\s*>/gi, '')
    .replace(/<\/tool_call_calls\s*>/gi, '')
    .replace(/<\/tool_call\s*>/gi, '')
    .replace(/<\/_calls\s*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return result;
}

/**
 * 标准化工具参数
 */
export function normalizeToolArguments(args) {
  if (args == null) return '{}';
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return '{}';
    const parsed = tryParseJson(trimmed);
    return parsed === null ? trimmed : JSON.stringify(parsed);
  }
  try { return JSON.stringify(args); } catch { return '{}'; }
}

function getObjectField(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  return value[key];
}

/**
 * 转换为 OpenAI 格式的 tool_calls
 */
export function toOpenAIToolCalls(calls) {
  return calls
    .map((call, index) => {
      const fn = call.function && typeof call.function === 'object' ? call.function : call;
      const name = fn.name;
      if (!name || typeof name !== 'string') return null;
      const args = getObjectField(fn, 'arguments') ?? getObjectField(call, 'arguments') ?? {};
      return {
        id: call.id || `call_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function',
        function: {
          name,
          arguments: normalizeToolArguments(args),
        },
      };
    })
    .filter(Boolean);
}

/**
 * Python桥提升4: 解析虚拟工具调用的 JSON 输出
 *
 * 当模型以 JSON 格式输出工具调用时（TOOL_FORMAT=json）：
 *   {"assistant_response": "思考过程", "tool_calls": [{"name":"x","arguments":{}}]}
 *
 * 解析策略（逐级降级）:
 *   1. 直接解析 text 整体
 *   2. 提取 code block 后解析
 *   3. 深度计数提取第一个 JSON 对象
 *
 * 源自 python _parse_virtual_tool_output
 */
export function parseVirtualToolJSON(text) {
  if (!text) return null;

  const stripped = text.trim();

  // 先找出第一个 JSON 对象的位置，提取前缀
  const firstJson = extractFirstJsonObject(stripped);
  const firstJsonIndex = firstJson ? stripped.indexOf(firstJson) : -1;
  const prefixText = firstJsonIndex > 0
    ? stripTrailingCodeLanguageMarker(stripped.slice(0, firstJsonIndex))
    : '';

  const candidates = [];

  // 1. 整体
  if (stripped) candidates.push(stripped);

  // 2. code block 包裹
  const codeBlock = extractCodeBlock(stripped);
  if (codeBlock && !candidates.includes(codeBlock)) candidates.push(codeBlock);

  // 3. 第一个 JSON 对象（深度计数）
  if (firstJson && !candidates.includes(firstJson)) candidates.push(firstJson);

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (!parsed || typeof parsed !== 'object') continue;

    let rawToolCalls = parsed.tool_calls;
    // 兼容 {name, arguments} 直接在外层的情况
    if (rawToolCalls === undefined && parsed.name) {
      // 如果前缀文本包含 XML 工具调用标签，说明这是旧 XML 格式，
      // 不应由 JSON 解析器处理，跳过此候选。
      if (prefixText && /<tool_calls|<tool_call|<_calls/i.test(prefixText)) {
        continue;
      }
      rawToolCalls = [parsed];
    }

    // 兼容 {function:"func_name", args:{...}} 格式
    if (rawToolCalls === undefined && typeof parsed.function === 'string') {
      rawToolCalls = [{
        name: parsed.function,
        arguments: parsed.args !== undefined ? parsed.args : parsed.arguments,
      }];
    }

    // 兼容 {function:{name,arguments}} 格式（OpenAI tool_call 格式）
    // 例如: {"id":"call_xxx","type":"function","function":{"name":"Read","arguments":"{\"path\":\"/tmp\"}"}}
    if (rawToolCalls === undefined && parsed.function && typeof parsed.function === 'object' && parsed.function.name) {
      rawToolCalls = [parsed];
    }

    // 兼容 {dialog:"text", actions:[{function:"x", args:{...}}]} 格式
    if (rawToolCalls === undefined && Array.isArray(parsed.actions)) {
      rawToolCalls = parsed.actions.map(a => ({
        name: a.function || a.name || a.tool,
        arguments: a.args || a.arguments || a.parameters || a.params,
      }));
    }

    const toolCalls = [];
    if (Array.isArray(rawToolCalls)) {
      for (const raw of rawToolCalls) {
        if (!raw || typeof raw !== 'object') continue;
        let name = raw.name;
        // 尝试从 function 子对象获取 name
        if (!name && raw.function) name = raw.function.name;
        if (!name || typeof name !== 'string' || !name.trim()) continue;

        const functionArgs = getObjectField(raw.function, 'arguments');
        const args = raw.arguments !== undefined ? raw.arguments
          : (functionArgs !== undefined ? functionArgs : raw.args);

        toolCalls.push({
          name: name.trim(),
          arguments: typeof args === 'object' && args !== null && !Array.isArray(args)
            ? JSON.stringify(args) : normalizeToolArguments(args),
        });
      }
    }

    const assistantResponse = parsed.assistant_response
      ?? parsed.content ?? parsed.response ?? parsed.answer
      ?? parsed.dialog ?? parsed.text ?? null;

    if (toolCalls.length > 0 || typeof assistantResponse === 'string') {
      const mergedContent = [prefixText, assistantResponse]
        .filter(Boolean)
        .map(s => s.trim())
        .join(String.fromCharCode(10, 10)) || null;

      return {
        toolCalls: toolCalls.length > 0 ? toolCalls.map((tc, i) => ({
          id: `call_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })) : null,
        content: mergedContent,
      };
    }
  }

  const relaxed = parseRelaxedEmptyToolWrapper(stripped);
  if (relaxed) return relaxed;

  return null;
}

/**
 * 从模型输出文本中解析工具调用 — 核心鲁棒解析器
 *
 * 解析优先级：
 *   1. JSON 虚拟工具调用格式（默认 JSON prompt 格式）：
 *      {"assistant_response": "...", "tool_calls": [...]}
 *   2. <tool_calls> / <tool_call> XML 块（向后兼容）
 *   3. 裸 JSON 兜底
 */
export function parseToolCallsFromText(text) {
  if (!text || !isPromptInjectionEnabled()) return null;

  // 策略0: XML 属性格式（向后兼容 DeepSeek 旧输出）。
  // <tool_call name="Read">{"file_path":"..."}</tool_call>
  const xmlAttributeResult = parseXmlAttributeToolCalls(text);
  if (xmlAttributeResult?.toolCalls?.length) return xmlAttributeResult;

  // 策略1: JSON 虚拟工具调用格式（新模板格式，最高优先级）
  // 格式: {"assistant_response": "...", "tool_calls": [{"name":"...","arguments":{}}]}
  const jsonResult = parseVirtualToolJSON(text);
  if (jsonResult) {
    // 有工具调用 → 返回带工具调用的结果
    if (jsonResult.toolCalls?.length) {
      if (jsonResult.content) {
        jsonResult.content = stripToolBlocks(jsonResult.content);
      }
      return jsonResult;
    }
    // 无工具调用但含有 assistant_response → 返回纯文本
    if (jsonResult.content) {
      return { toolCalls: null, content: jsonResult.content };
    }
  }

  // 策略2: XML 标签格式（向后兼容旧 prompt 格式）
  const blocks = [
    extractJsonBlock(text, 'tool_calls'),
    extractJsonBlock(text, 'tool_call'),
    extractJsonBlock(text, '_calls'),         // DeepSeek v4-pro 原生格式
  ].filter(Boolean);

  for (const block of blocks) {
    const parsed = tryParseJson(block);
    if (!parsed) continue;
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    const toolCalls = toOpenAIToolCalls(calls);
    if (toolCalls.length) {
      const content = stripToolBlocks(text);
      return { toolCalls, content: content || null };
    }
  }

  // 策略3: 裸 JSON 兜底
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const parsed = tryParseJson(trimmed);
  if (parsed) {
    const rawCalls = parsed.tool_calls || parsed.tools || parsed.calls || parsed.function_call || parsed;
    const calls = Array.isArray(rawCalls) ? rawCalls : [rawCalls];
    const toolCalls = toOpenAIToolCalls(calls);
    if (toolCalls.length) return { toolCalls, content: '' };
  }

  // 策略4: 深度扫描兜底 — 全文扫描所有 {…} 对象
  const recoveryResult = recoverToolCallsFromText(text);
  if (recoveryResult?.toolCalls?.length) {
    return recoveryResult;
  }

  // 策略5: 【防死循环】检测到工具调用标签但解析全部失败
  // 不返回 null，而是返回剥离后的纯内容（避免原始标签泄漏到客户端）
  if (/<tool_calls\b/i.test(text) || /<tool_call\b/i.test(text) || /<tool_call_calls/i.test(text) || /<_calls\b/i.test(text)) {
    const cleaned = stripToolBlocks(text);
    const sanitized = sanitizeModelOutput(cleaned);
    console.warn(`[Tool abort] Stripped malformed <tool_calls> from output (${text.length - cleaned.length} chars removed). Returning as text.`);
    return {
      toolCalls: null,
      content: sanitized || '[The model attempted to use tools but the output was malformed and has been cleaned up]',
    };
  }

  // 策略6: 【防泄漏】检测 content 包含系统 prompt 泄漏
  // 即使没有工具调用标记，也要防止 prompt 残片泄漏到客户端
  const sanitized = sanitizeModelOutput(text);
  if (sanitized !== text) {
    console.warn(`[Content sanitize] Stripped ${text.length - sanitized.length} chars of leaked prompt artifacts`);
    return {
      toolCalls: null,
      content: sanitized || null,
    };
  }

  return null;
}

// ============================================================
// 【缺口修复】正则兜底提取
// ============================================================

/**
 * 正则兜底提取 — 当标准 JSON/XML 解析均失败时使用
 *
 * 使用深度计数提取文本中所有 JSON 对象，逐一检查是否包含工具调用。
 * 比 extractFirstJsonObject 更全面——扫描全文而非只找第一个。
 *
 * 覆盖场景：
 *   1. 嵌套/空 XML 标签：<tool_calls>\n<tool_calls>\n\n</tool_calls>
 *   2. JSON 字符串作为 tool_calls 值（非数组）
 *   3. 工具调用参数被转义为字符串
 *   4. 多个 JSON 对象散落在文本中
 */
export function recoverToolCallsFromText(text) {
  if (!text) return null;

  const results = [];

  // 深度计数提取所有 {…} 对象
  let searchStart = 0;
  while (searchStart < text.length) {
    const start = text.indexOf('{', searchStart);
    if (start < 0) break;

    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (char === '\\') { escape = true; continue; }
        if (char === '"') { inString = false; continue; }
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === '{') { depth++; continue; }
      if (char === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }

    if (end < 0) break; // 无闭合对象，退出

    const candidate = text.slice(start, end);
    searchStart = end;

    // 尝试解析
    const parsed = tryParseJson(candidate);
    if (!parsed || typeof parsed !== 'object') continue;

    // 1. tool_calls 是数组
    let raw = parsed.tool_calls || parsed.tools || parsed.calls;
    if (Array.isArray(raw)) {
      const calls = toOpenAIToolCalls(raw);
      if (calls.length) results.push(...calls);
    }
    // 2. tool_calls 是字符串（被序列化）
    if (typeof raw === 'string') {
      const unescaped = raw.replace(/\\"/g, '"').replace(/\\n/g, '');
      const innerParsed = tryParseJson(unescaped);
      if (Array.isArray(innerParsed)) {
        const calls = toOpenAIToolCalls(innerParsed);
        if (calls.length) results.push(...calls);
      }
    }
    // 3. 顶层 name + arguments 作为单工具调用
    if (results.length === 0 && parsed.name && typeof parsed.name === 'string') {
      const call = { name: parsed.name, arguments: parsed.arguments ?? parsed.args ?? {} };
      const calls = toOpenAIToolCalls([call]);
      if (calls.length) results.push(...calls);
    }
    // 4. OpenAI 格式：{function:{name,arguments}}（无顶层 name）
    // 例如: {"id":"call_xxx","type":"function","function":{"name":"Read","arguments":"{\"path\":\"/tmp\"}"}}
    if (results.length === 0 && parsed.function && typeof parsed.function === 'object' && parsed.function.name) {
      const call = { name: parsed.function.name, arguments: getObjectField(parsed.function, 'arguments') ?? {} };
      const calls = toOpenAIToolCalls([call]);
      if (calls.length) results.push(...calls);
    }
  }

  // 去重（同名 + 同参数视为重复）
  const seen = new Set();
  const unique = results.filter(tc => {
    const key = `${tc.function.name}:${getObjectField(tc.function, 'arguments')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length > 0) {
    console.warn(`[Tool recovery] Recovered ${unique.length} tool call(s) via depth-scan fallback`);
    return {
      toolCalls: unique,
      content: stripToolBlocks(text) || null,
    };
  }

  return null;
}

// ============================================================
// OpenAI 流式工具调用增量输出
// ============================================================

const ARGS_CHUNK_SIZE = 24;

export function streamToolCallsIncremental(res, writeOpts, toolCalls) {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (!writeSSE(res, {
      ...writeOpts,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: i, id: tc.id, type: 'function',
            function: { name: tc.function.name, arguments: '' },
          }],
        },
        finish_reason: null,
      }],
    })) return;

    const args = getObjectField(tc.function, 'arguments') || '';
    for (let j = 0; j < args.length; j += ARGS_CHUNK_SIZE) {
      if (!writeSSE(res, {
        ...writeOpts,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: i, function: { arguments: args.slice(j, j + ARGS_CHUNK_SIZE) } }],
          },
          finish_reason: null,
        }],
      })) return;
    }
  }
}

// ============================================================
// Python桥提升5: 工具历史检测
//
// 检查消息列表中是否包含工具调用历史。
// 即使当前请求没有 tools 参数，如果历史中有工具调用，
// 模型仍可能继续输出工具调用。
// ============================================================

/**
 * 检测消息中是否有工具调用历史
 * 检查 tool 角色消息或 assistant 消息中的 tool_calls
 *
 * 源自 python _has_tool_history
 */
export function hasToolHistory(messages) {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = (msg.role || '').toLowerCase();
    if (role === 'tool') return true;
    if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) return true;
  }
  return false;
}

// ============================================================
// Prompt 构建工具
// ============================================================

function buildPromptInner(messages, startIdx, endIdx) {
  let prompt = '';
  for (let i = startIdx; i < endIdx; i++) {
    const msg = messages[i];
    if (msg.role === 'system') {
      prompt += `[System]: ${textFromContent(msg.content)}\n\n`;
    } else if (msg.role === 'user') {
      prompt += `[User]: ${textFromContent(msg.content)}\n\n`;
    } else if (msg.role === 'assistant') {
      const content = textFromContent(msg.content);
      if (content) prompt += `[Assistant]: ${content}\n\n`;
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        prompt += `[Assistant tool calls]: ${JSON.stringify(msg.tool_calls)}\n\n`;
      }
    } else if (msg.role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'tool';
      prompt += `[Tool result ${name}]: ${textFromContent(msg.content)}\n\n`;
    } else if (msg.role === 'function') {
      prompt += `[Function result ${msg.name || 'function'}]: ${textFromContent(msg.content)}\n\n`;
    }
  }
  return prompt.trim();
}

export function buildPromptFromMessages(messages) {
  return buildPromptInner(messages, 0, messages.length);
}

export function buildLatestPrompt(messages) {
  // 从最后一条 assistant 消息之后开始截取：并行工具调用的多条结果会被
  // toolify 拆成多条连续 user 消息，只取"最后一条 user"会丢掉前面的结果。
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
  }
  const start = lastAssistantIdx + 1;
  if (start > 0 && start < messages.length) {
    return buildPromptInner(messages, start, messages.length);
  }
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return buildPromptFromMessages(messages);
  return buildPromptInner(messages, lastUserIdx, messages.length);
}

/**
 * 亲和增量模式：根据前缀匹配结果计算本轮新增消息的起始下标。
 * 跳过增量开头的 assistant 消息——那是上游会话自己生成的上一轮回复，
 * 通过 parent_message_id 已经链上，重发会在上游上下文里出现两份。
 * 返回 null 表示无法确定精确增量（调用方回退到启发式截取或完整历史）。
 */
export function latestDeltaStartIndex(messages, matchedPrefixLength) {
  if (!Array.isArray(messages)) return null;
  if (!Number.isInteger(matchedPrefixLength) || matchedPrefixLength <= 0) return null;
  if (matchedPrefixLength >= messages.length) return null;
  let start = matchedPrefixLength;
  while (start < messages.length && messages[start]?.role === 'assistant') start++;
  return start < messages.length ? start : null;
}

/**
 * 从模型输出的 JSON 格式文本中提取 assistant_response 内容
 *
 * 模型按照新模板输出格式：
 *   {"assistant_response": "文本内容", "tool_calls": [...]}
 *
 * 此函数解析 JSON，提取 assistant_response 作为对外输出的文本内容，
 * 同时返回 tool_calls 供工具调用处理。
 *
 * 使用 tryParseJson 处理模型常见的 JSON 格式错误（如 Windows 路径单反斜杠）。
 *
 * @param {string} text - 模型原始输出文本
 * @returns {{ content: string|null, toolCalls: Array|null }} 提取结果
 */
export function extractAssistantResponse(text) {
  if (!text) return { content: null, toolCalls: null };

  // Use the same tolerant parser as tool-call extraction so streamed handlers can
  // still recover the final正文 when the model wraps JSON in code fences, omits
  // spaces, or emits a short prefix before the JSON object.
  const virtual = parseVirtualToolJSON(text);
  if (virtual) {
    return {
      content: virtual.content ?? null,
      toolCalls: virtual.toolCalls ?? null,
    };
  }

  const trimmed = text.trim();
  // 使用 tryParseJson 替代 JSON.parse，容错处理 Windows 路径等非法转义
  const parsed = tryParseJson(trimmed);
  if (!parsed || typeof parsed !== 'object') {
    const sanitized = sanitizeModelOutput(text);
    return { content: sanitized || text, toolCalls: null };
  }

  const assistantResponse = parsed.assistant_response;
  const content = (assistantResponse !== null && assistantResponse !== undefined)
    ? String(assistantResponse)
    : null;

  let toolCalls = null;
  if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
    toolCalls = parsed.tool_calls.map((tc, i) => {
      const name = tc.name;
      if (!name || typeof name !== 'string') return null;
      return {
        id: tc.id || `call_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function',
        function: {
          name,
          arguments: normalizeToolArguments(tc.arguments ?? {}),
        },
      };
    }).filter(Boolean);
  }

  return { content, toolCalls };
}

/**
 * 检测模型输出是否包含「复读 prompt」等畸形工具调用内容
 *
 * 当模型输出类似以下格式时表示输出畸形：
 *   [Assistant tool calls]: [{...}]
 *   [Tool result ...]: ...
 *
 * @param {string} text - 模型原始输出
 * @returns {boolean} 是否为畸形工具输出
 */
export function looksLikeMalformedToolOutput(text) {
  if (!text) return false;
  // 模型复读 prompt 格式
  if (/\[(Assistant tool calls|Tool result|Function result)/i.test(text)) return true;
  // 有工具调用关键词但非标准 JSON 格式
  if (/tool_calls|"name"\s*:\s*"/i.test(text)) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return true;
    try {
      JSON.parse(trimmed);
      return false; // 合法 JSON，非畸形
    } catch {
      return true; // JSON 解析失败，视为畸形
    }
  }
  return false;
}

/**
 * 构建重试提示词，追加在对话末尾纠正模型输出格式
 *
 * @param {string} previousResponse - 模型上一次不合规的输出
 * @returns {string} 重试指令
 */
export function buildToolRetryPrompt(previousResponse) {
  return `\n\n你上一个输出格式不正确。请重新回答，必须严格按照以下格式输出原始 JSON（不要包含任何 Markdown 围栏）：

当需要调用工具时：
{"assistant_response": null, "tool_calls": [{"name": "工具名", "arguments": {参数对象}}]}

当可以直接回答时：
{"assistant_response": "你的回答内容（输出Markdown风格（详细版））", "tool_calls": []}

规则：
- 只输出原始 JSON，不得包含额外文本或注释。
- tool_calls 必须是数组（即使为空）。
- arguments 必须是 JSON 对象。

你上一个不合规的输出开头是：${String(previousResponse).slice(0, 150)}`;
}

/**
 * 创建增量 JSON 内容提取器
 *
 * 用于流式场景：逐 chunk 处理模型输出的 JSON 格式文本
 *   {"assistant_response": "文本内容", "tool_calls": [...]}
 *
 * 一旦检测到 assistant_response 值开始，立即提取并返回内容增量，
 * 实现接近实时的流式输出，无需等待完整 JSON 到达。
 *
 * 用法：
 *   const extractor = createJsonContentExtractor();
 *   for (const chunk of chunks) {
 *     const delta = extractor.process(chunk);
 *     if (delta) stream(delta);
 *   }
 */
export function createJsonContentExtractor() {
  let phase = 'waiting_key'; // waiting_key | waiting_colon | waiting_value | in_string | value_done
  let keyMatchPos = 0;
  let pendingEscape = false;
  let unicodeEscape = null;
  const KEY = '"assistant_response"';

  function resetKeySearch(char) {
    keyMatchPos = char === KEY[0] ? 1 : 0;
  }

  function hexValue(char) {
    return /^[0-9a-fA-F]$/.test(char) ? char : null;
  }

  function decodeSimpleEscape(esc) {
    switch (esc) {
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return esc;
    }
  }

  return {
    /**
     * 处理一个内容 chunk，返回应流式输出的内容增量。
     * 支持 `"assistant_response":"..."`、`"assistant_response" : "..."`
     * 以及标记被拆分到多个 chunk 的情况；旧实现只匹配带固定空格的
     * `"assistant_response": "`，导致模型输出紧凑 JSON 时对外没有正文增量。
     * @param {string} chunk - 模型输出的内容片段
     * @returns {string} 应流式输出的文本增量
     */
    process(chunk) {
      if (phase === 'value_done' || !chunk) return '';

      let delta = '';

      for (let i = 0; i < chunk.length; i++) {
        const char = chunk[i];

        if (phase === 'waiting_key') {
          if (char === KEY[keyMatchPos]) {
            keyMatchPos++;
            if (keyMatchPos === KEY.length) phase = 'waiting_colon';
          } else {
            resetKeySearch(char);
          }
          continue;
        }

        if (phase === 'waiting_colon') {
          if (/\s/.test(char)) continue;
          if (char === ':') phase = 'waiting_value';
          else {
            phase = 'waiting_key';
            resetKeySearch(char);
          }
          continue;
        }

        if (phase === 'waiting_value') {
          if (/\s/.test(char)) continue;
          if (char === '"') phase = 'in_string';
          else if (/^n/i.test(char)) phase = 'value_done'; // assistant_response: null
          else {
            phase = 'waiting_key';
            resetKeySearch(char);
          }
          continue;
        }

        if (phase === 'in_string') {
          if (unicodeEscape) {
            const hex = hexValue(char);
            if (hex) {
              unicodeEscape.hex += hex;
              if (unicodeEscape.hex.length === 4) {
                delta += String.fromCharCode(parseInt(unicodeEscape.hex, 16));
                unicodeEscape = null;
                pendingEscape = false;
              }
              continue;
            }
            delta += 'u' + unicodeEscape.hex + char;
            unicodeEscape = null;
            pendingEscape = false;
            continue;
          }

          if (pendingEscape) {
            if (char === 'u') {
              unicodeEscape = { hex: '' };
              continue;
            }
            delta += decodeSimpleEscape(char);
            pendingEscape = false;
            continue;
          }

          if (char === '\\') {
            pendingEscape = true;
            continue;
          }
          if (char === '"') {
            phase = 'value_done';
            break;
          }
          delta += char;
        }
      }

      return delta;
    },

    /** 是否已检测到 assistant_response 标记 */
    isFound() { return phase !== 'waiting_key'; },

    /** assistant_response 值是否已完整提取 */
    isDone() { return phase === 'value_done'; },
  };
}

// ============================================================
// 全局未处理 rejection 防护
// ============================================================

export function setupUnhandledRejectionHandler() {
  process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || String(reason || 'unknown');
    if (msg.includes('cancel') || msg.includes('abort') || msg.includes('pipe')) return;
    console.error(`[HA] Unhandled Rejection: ${msg}`);
  });
}
