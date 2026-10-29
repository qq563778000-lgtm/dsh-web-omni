import { createInternalId } from './internal-request.js';
import { validateParsedTools } from './tool-validation.js';
import {
  getRawJsonPromptForRequest,
  isPromptInjectionDisabledForRequest,
  normalizeTools,
} from '../utils/response-utils.js';

const TRIGGER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function generateTriggerSignal(length = 4) {
  let suffix = '';
  for (let i = 0; i < length; i++) {
    suffix += TRIGGER_CHARS[Math.floor(Math.random() * TRIGGER_CHARS.length)];
  }
  return `<Function_${suffix}_Start/>`;
}

function forcedToolName(toolChoice) {
  return toolChoice?.function?.name || toolChoice?.name || undefined;
}

function isNoneToolChoice(toolChoice) {
  return toolChoice === 'none' || toolChoice?.type === 'none';
}

function schemaTypeName(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  const type = schema.type;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.filter(t => typeof t === 'string').join(' | ') || 'any';
  if (schema.properties || schema.required || schema.additionalProperties !== undefined) return 'object';
  if (schema.items) return 'array';
  if (Array.isArray(schema.anyOf)) return 'anyOf';
  if (Array.isArray(schema.oneOf)) return 'oneOf';
  if (Array.isArray(schema.allOf)) return 'allOf';
  return 'any';
}

function dumpPromptValue(value) {
  try { return JSON.stringify(value, null, 0); } catch { return String(value); }
}

function appendSchemaSummary(lines, schema, isRequired, indentLevel, depth = 0) {
  const schemaObj = schema && typeof schema === 'object' ? schema : {};
  const indent = '  '.repeat(indentLevel);

  if (depth > 6) {
    lines.push(`${indent}- note: nested schema omitted after depth 6`);
    return;
  }

  lines.push(`${indent}- type: ${schemaTypeName(schemaObj)}`);
  if (isRequired != null) lines.push(`${indent}- required: ${isRequired ? 'Yes' : 'No'}`);
  if (schemaObj.description) lines.push(`${indent}- description: ${schemaObj.description}`);
  if (schemaObj.enum) lines.push(`${indent}- enum: ${dumpPromptValue(schemaObj.enum)}`);
  if (schemaObj.default !== undefined) lines.push(`${indent}- default: ${dumpPromptValue(schemaObj.default)}`);

  const constraints = {};
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems']) {
    if (schemaObj[key] !== undefined) constraints[key] = schemaObj[key];
  }
  if (Object.keys(constraints).length) lines.push(`${indent}- constraints: ${dumpPromptValue(constraints)}`);

  const props = schemaObj.properties && typeof schemaObj.properties === 'object' ? schemaObj.properties : null;
  const required = Array.isArray(schemaObj.required) ? schemaObj.required.filter(k => typeof k === 'string') : [];
  if (props && Object.keys(props).length) {
    lines.push(`${indent}- properties:`);
    for (const [name, child] of Object.entries(props)) {
      lines.push(`${'  '.repeat(indentLevel + 1)}- ${name}:`);
      appendSchemaSummary(lines, child, required.includes(name), indentLevel + 2, depth + 1);
    }
  }

  if (schemaObj.items && typeof schemaObj.items === 'object') {
    lines.push(`${indent}- items:`);
    appendSchemaSummary(lines, schemaObj.items, null, indentLevel + 1, depth + 1);
  }
}

// 已知的编辑类/写入类工具名（跨客户端变体）。名称用精确匹配而非子串，
// 避免 dispatch 这类名字被误判为 patch 工具。
const EDIT_TOOL_NAME_RX = /^(?:multi_?edit|edit(?:_file|_files|_notebook)?|notebook_?edit|str_replace(?:_editor|_based_edit_tool)?|apply_?patch|replace(?:_in_file)?|search_(?:and_)?replace|patch_file)$/;
const WRITE_TOOL_NAME_RX = /^(?:write|write_?file|write_to_file|create_?file|save_?file)$/;

/**
 * 识别工具集中"精确编辑类"与"整文件写入类"工具的实际名称。
 * 编辑类：带 old_string/old_str 参数，或名称命中已知编辑工具变体；
 * 写入类：名称命中已知写入工具变体，或同时带 content 与 file_path/path 参数。
 * 真实场景中模型在编辑意图下常错选写入工具整文件重写——只有两类工具
 * 同时存在时才有混淆风险，提示词按此条件注入 Edit 优先硬规则。
 */
export function detectFileMutationTools(tools = []) {
  const editNames = [];
  const writeNames = [];
  for (const tool of normalizeTools(tools)) {
    const fn = tool.function || tool;
    const name = String(fn.name || '');
    if (!name) continue;
    const lower = name.toLowerCase();
    const props = Object.keys(fn.parameters?.properties || {});
    if (props.includes('old_string') || props.includes('old_str') || EDIT_TOOL_NAME_RX.test(lower)) {
      editNames.push(name);
    } else if (
      WRITE_TOOL_NAME_RX.test(lower)
      || (props.includes('content') && (props.includes('file_path') || props.includes('path')))
    ) {
      writeNames.push(name);
    }
  }
  return { editNames, writeNames };
}

function renderToolList(tools) {
  return tools.map((tool, index) => {
    const fn = tool.function || tool;
    const parameters = fn.parameters ?? { type: 'object', properties: {} };
    const props = parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : {};
    const required = Array.isArray(parameters.required) ? parameters.required.filter(k => typeof k === 'string') : [];
    const summary = Object.entries(props)
      .map(([name, schema]) => `${name} (${schemaTypeName(schema)})`)
      .join(', ') || 'None';

    const detailLines = [];
    for (const [name, schema] of Object.entries(props)) {
      detailLines.push(`- ${name}:`);
      appendSchemaSummary(detailLines, schema, required.includes(name), 1);
    }

    return `${index + 1}. <tool name="${fn.name}">
   Description:
\`\`\`
${fn.description || ''}
\`\`\`
   Parameters summary: ${summary}
   Required parameters: ${required.length ? required.join(', ') : 'None'}
   Parameter details:
${detailLines.length ? detailLines.join('\n') : '(no parameter details)'}`;
  }).join('\n\n');
}

export function buildXmlToolInstructions({ tools = [], toolChoice = 'auto', triggerSignal } = {}) {
  const normalized = normalizeTools(tools);
  if (!triggerSignal || !normalized.length || isNoneToolChoice(toolChoice)) return '';

  const constraints = [];
  if (toolChoice === 'required') {
    constraints.push('本轮对话中，如果尚未调用任何工具，则必须调用至少一个工具；如果已有工具结果返回，直接基于结果回复即可');
  }
  const forced = forcedToolName(toolChoice);
  if (forced) {
    constraints.push(`只能调用 \`${forced}\` 这一个工具，不得调用其他工具`);
  }

  const firstTool = normalized[0]?.function?.name || 'tool_name';
  const constraintText = constraints.length
    ? `\n\n工具选择约束：\n${constraints.map(line => `- ${line}`).join('\n')}`
    : '';

  // 检测是否为编程类工具集，注入专用规则
  const isCodingToolset = tools.some(tool => {
    const fn = tool.function || tool;
    const props = Object.keys(fn.parameters?.properties || {});
    return props.includes('file_path') || props.includes('command')
      || props.includes('old_string') || props.includes('pattern');
  });

  // 检测是否有交互/提问类工具（AskUserQuestion 等），注入专用规则
  // 模型经常在思考中说"让我们使用 AskUserQuestion"但最终输出纯文本问题——客户端只识别工具调用格式的提问，纯文本会直接断开。
  const interactiveToolNames = normalized
    .map(t => (t.function?.name || t.name || '').toLowerCase())
    .filter(name => ['askuserquestion', 'ask_user', 'askuser', 'askq', 'question'].includes(name));
  const interactiveGuide = interactiveToolNames.length ? `
### 交互/询问工具规则

- 当你需要向用户提问、收集选项、确认操作时，必须调用交互工具（如 AskUserQuestion）输出结构化提问，禁止用纯文本替代
- **客户端只识别工具调用格式的提问——如果你在思考中说"让我们使用 AskUserQuestion"但最终只输出纯文本问题，客户端会直接断开，任务失败**
- 需要用户输入的任何场景（选择方案、确认参数、补充需求），一律通过工具调用 XML 完成，不得在正文里直接提问
- **AskUserQuestion 参数硬约束（违反会导致 schema 校验失败、整条调用被丢弃）**：
  - 每个 question 的 options 数量必须在 2–4 个之间（含），绝对不要输出 5 个或更多选项
  - header 尽量短（建议 ≤12 个字符）
  - label 尽量短（建议 ≤30 个字符）
  - options 的每个元素只允许 label 和 description 字段，禁止额外字段
  - multiSelect 必须是布尔值 true/false
  - questions 数组至少 1 项；需要多问就放在同一个 questions 数组里，不要拆成多次调用` : '';

  // 真实场景痛点：编辑意图下模型倾向选写入工具整文件重写。检测实际存在的
  // 编辑类/写入类工具名，两者并存时注入"已存在文件必须精确替换"硬规则；
  // 只引用工具集中真实存在的名称，避免向客户端推荐不存在的工具。
  const { editNames, writeNames } = detectFileMutationTools(normalized);
  const notebookEditNames = editNames.filter(name => /notebook/i.test(name));
  const textEditNames = editNames.filter(name => !/notebook/i.test(name));
  const effectiveEditNames = textEditNames.length ? textEditNames : editNames;
  const editList = effectiveEditNames.join('/');
  const writeList = writeNames.join('/');
  const primaryEdit = effectiveEditNames[0] || '';
  const primaryWrite = writeNames[0] || '';
  const hasOldStringParam = normalized.some(t => {
    const props = Object.keys((t.function || t).parameters?.properties || {});
    return props.includes('old_string') || props.includes('old_str');
  });

  let fileMutationGuide = '';
  if (editList && writeList) {
    fileMutationGuide = `

#### 文件修改工具选择（硬规则：编辑意图下 ${editList} 永远是第一选择）

- **目标文件已存在 → 必须用 ${editList} 做精确替换，禁止用 ${writeList} 整文件重写。** 修改/编辑/调整/优化/修复/重构已有文件的任何一部分，都属于编辑意图；只要你 Read 过该文件、或它出现在 Grep/Glob/目录结果里、或上下文表明它已存在，它就是"已存在文件"
- ${writeList} 仅限两种场景，其余一律禁用：
  ① 创建一个当前不存在的新文件
  ② 用户明确要求"整个文件推倒重写/清空重来"，且你已 Read 过该文件当前的完整内容
- 为什么这是硬规则：${writeList} 会用你提供的内容**整体替换**目标文件——凡是没有被你原样复述进参数的部分（没读到的、记不全的、以为"没改动就不用写"的）都会被静默删除
- 同一文件要改多处：逐处精确替换，${primaryEdit} 调用可同块并行；禁止因为"改动多"就整文件重写
- 不要因为担心精确匹配失败而退回 ${writeList}：匹配失败就重新 Read 相关区段取回准确原文再改；只有精确替换反复失败、且你已 Read 当前完整文件时，才允许整文件重写作为最后手段
- 调用 ${writeList} 前自检两问：目标文件已存在吗？我只是想改其中一部分吗？——任一答案为"是"，立即换用 ${editList}${notebookEditNames.length ? `
- Notebook(.ipynb) 文件的修改用 ${notebookEditNames.join('/')}` : ''}

| 场景 | ❌ 错误选择 | ✅ 正确选择 |
|---|---|---|
| 修改已有文件中的几行 | ${primaryWrite} 重写整个文件 | ${primaryEdit} 只替换那几行 |
| 同一文件修改多处 | ${primaryWrite} 全量重写 | 多个 ${primaryEdit} 分批执行 |
| 创建全新文件 | — | ${primaryWrite} |
| 用户明确要求整文件重写 | 没读过原文就直接 ${primaryWrite} | 先 Read 完整原文，再 ${primaryWrite} |`;
  } else if (editList) {
    fileMutationGuide = `
- 修改文件一律用 ${editList} 做精确修改，只提交需要变更的片段，不要重写整个文件`;
  } else if (writeList) {
    fileMutationGuide = `
- 用 ${writeList} 覆盖已有文件前必须先 Read 其完整内容，重写时必须原样保留所有未改动部分，任何遗漏都会破坏文件`;
  }

  const codingGuide = isCodingToolset ? `
### 编程场景专用规则

- 先读后改：修改文件前必须 Read 目标文件确认内容，再做精确修改
- Read 大文件时分段读取：先用 limit 控制读取量，继续时用 offset 接续${hasOldStringParam ? `
- 精确替换的 old_string 必须与文件内容逐字符匹配（含缩进和空白），不确定时重新 Read 确认` : ''}
- 文件修改参数中的多行内容必须用 \\n 表示换行，不得在 JSON 字符串里直接换行
- 修改完成后主动验证：重新 Read 关键改动处确认生效，能运行测试/构建时运行确认无回归
- 搜索文件名用 Glob，搜索内容用 Grep；不要用 Bash 替代这些专用工具
- Bash 仅用于测试、构建、包管理、git 等需要命令行执行的场景
- Windows 路径使用完整绝对路径和反斜杠${fileMutationGuide}` : '';

  // 优先挑一个有典型参数的工具做正确示例，避免示例总是 Read 而实际任务是 shell_command
  const exampleTool = normalized.find(t => {
    const name = (t.function?.name || t.name || '').toLowerCase();
    return ['read', 'glob', 'grep', 'bash', 'shell_command', 'shell', 'askuserquestion'].includes(name);
  }) || normalized[0];
  const exampleToolName = exampleTool?.function?.name || exampleTool?.name || firstTool;
  const exampleArgs = (() => {
    const n = String(exampleToolName).toLowerCase();
    if (n.includes('glob')) return '{"pattern":"**/*","path":"D:\\\\project"}';
    if (n.includes('grep')) return '{"pattern":"TODO","path":"D:\\\\project"}';
    if (n.includes('bash') || n.includes('shell')) return '{"command":"Get-ChildItem -Force"}';
    if (n.includes('askuser') || n.includes('question')) {
      return '{"questions":[{"question":"选择一个方案","header":"方案","options":[{"label":"方案A","description":"保守"},{"label":"方案B","description":"激进"}],"multiSelect":false}]}';
    }
    return '{"file_path":"D:\\\\project\\\\README.md"}';
  })();

  return `\n\n## 可用工具

${renderToolList(normalized)}

## 工具调用决策（强制）

1. 能直接回答的问题 → 只输出自然语言 Markdown，不要输出任何 XML
2. 需要工具才能推进的任务 → **同一次回复必须同时包含**：
   - 可选的一句简短说明（可省略）
   - 触发信号（独占一行）：\`${triggerSignal}\`
   - 紧跟的完整 \`<function_calls>...</function_calls>\` 块
3. **硬规则：说了要做，就必须当场调用。** 只要正文出现以下任一意图词，却没有输出完整 XML，回复视为无效：
   - 中文：读取/查看/搜索/探索/分析/获取/打开/列出/运行/执行/修改/编辑/写入/创建/检查/扫描/梳理/了解/提问/确认/选择
   - 英文：read/inspect/check/search/grep/list/scan/open/run/execute/edit/modify/write/create/explore/analyze/ask
4. 禁止只输出计划句就结束，例如：
   - "我先读取…" / "接下来我会查看…" / "我来分析…" / "我们先获取…" / "我先确认一下…"
   - 这些句子后面必须立刻跟上触发信号 + function_calls，否则任务死锁
${interactiveGuide}
- 工具执行结果返回后（以"[系统通知]"开头的消息），先判断任务是否全部完成：未完成就继续调用下一个所需工具——修改文件后重新 Read 验证、修复后重新运行测试、根据搜索结果继续读取文件，都是正当且推荐的再次调用
- 任务全部完成后，才用自然语言总结本轮做了什么、结果如何；禁止以空内容结束
- 不要用完全相同的参数重复紧邻的上一次调用（它的结果已经在上面给出）
- 多个独立的工具调用应在同一次回复中并行发出，不要分步串行；把当前需要完成的调用一次发齐，收到结果后继续
${codingGuide}
## 输出格式（唯一合法格式）

调用工具时**必须**严格按以下 XML 格式输出，一个字符都不能少：

\`\`\`
${triggerSignal}
<function_calls>
  <function_call>
    <tool>${exampleToolName}</tool>
    <args_json><![CDATA[${exampleArgs}]]></args_json>
  </function_call>
</function_calls>
\`\`\`

### 正确完整示例

\`\`\`
好的，我先读取 README。

${triggerSignal}
<function_calls>
  <function_call>
    <tool>${exampleToolName}</tool>
    <args_json><![CDATA[${exampleArgs}]]></args_json>
  </function_call>
</function_calls>
\`\`\`

### 发送前自检清单（每条都必须通过，缺一即丢弃）

1. 是否输出了触发信号 \`${triggerSignal}\`（独占一行、只出现一次、与示例完全一致）？
2. 触发信号后是否立刻是 \`<function_calls>\`，最后是否有 \`</function_calls>\`？
3. 每个 \`<function_call>\` 内是否同时有 \`<tool>\` 和 \`<args_json>\`？
4. \`<args_json>\` 是否用 \`<![CDATA[ ... ]]>\` 包裹（结束必须是 **两个**右方括号 \`]]>\`，不是 \`]>\`）？
5. CDATA 内是否是完整 JSON 对象：以 \`{\` 开头、以 \`}\` 结尾，引号/括号成对？
6. 参数名是否都在工具定义里？有没有多余字段（description/comment/note/justification）？
7. 若调用 AskUserQuestion：每个 question 的 options 是否只有 2–4 项？header/label 是否过长？
8. 中文叙述引号是否用了「」或‘’，而不是在 JSON 字符串值里再嵌未转义的 ASCII "？
9. \`</function_calls>\` 之后是否没有任何文字？

## 🚫 致命错误示范（真实踩坑，整条调用会被丢弃）

### A. 只写计划、不输出 XML（最常见，任务直接死锁）

| ❌ 错误 | 原因 |
|---|---|
| \`好的，我先读取项目的关键文档和目录结构，来为你整理一份分析报告。\` | 说了"读取"但没有输出 XML |
| \`我来帮你全面分析这个项目。我会先并行探索项目的结构、技术栈、主要功能模块和架构设计。\` | 说了"探索/分析"但没有输出 XML |
| \`好的，我们先获取设置页完整代码中关于"默认书源"的部分，以便进行针对性优化。\` | 说了"获取"但没有输出 XML |
| \`我来读取设置页面主代码和主题相关文件，了解当前实现后再做优化。\` | 说了"读取"但没有输出 XML |
| \`我先看看项目结构再决定怎么做。\` | 说了"看看"但没有输出 XML |
| \`我会先并行读取相关源文件，以确保修改时与现有设计系统保持一致。\` | 说了“读取源文件”，但没有输出 XML |
| \`我先确认一下优化范围。\` | 说了"确认"但没有输出 XML（应改用 AskUserQuestion 或直接给方案） |
| \`先定位到目标页面/组件再继续。\` | 说了“定位到”，但没有输出 XML |

### B. 结构残缺 / 标签错误

| ❌ 错误片段 | 原因 |
|---|---|
| 只有 \`<tool>shell_command</tool>\` 重复多次 | 缺 function_calls / args_json，裸标签不会被执行 |
| CDATA 结束写成 \`]>\` | 必须是 \`]]>\`，少一个右方括号会让整块 XML 无法闭合 |
| JSON 写到一半插入 \`]]\` 或 \`]]>\` 再接着写参数，如 \`..."}]], "replace_all": false}}\` | CDATA 被提前闭合、JSON 被切成两半；\`]]>\` 只能在参数 JSON 完整结束后出现一次 |
| JSON 末尾漏 \`}\`，如 \`{"command":"...ui\\\\"\` | 对象未闭合，args_json 解析失败 |
| 中文叙述里用 ASCII 双引号夹词：\`"是否允许为"优化样式"创建"\` | 破坏 JSON 字符串边界；叙述引号请用「」或‘’ |
| 触发信号写错 / 漏写 / 写在 think 块里 | 触发信号必须在 think 外、独占一行、与示例完全一致 |
| \`</function_calls>\` 后还有解释文字 | 闭合标签后不得有任何文字 |

### C. 参数 / schema 越界

| ❌ 错误 | 原因 |
|---|---|
| AskUserQuestion 的 options 写了 5 个选项 | 常见 maxItems=4，第 5 项会导致校验失败 |
| header / label 过长 | 常见 maxLength 限制 |
| args 里多了 description / comment / note / justification | 工具定义未声明的字段会导致校验失败 |
| shell/terminal/execute 等别名 | 工具名必须与可用工具列表完全一致（除非客户端本身暴露该名） |
| Bash 的 command 写成数组 | command 必须是字符串 |

### ✅ 同一意图的正确写法

\`\`\`
我来读取设置页面主代码。

${triggerSignal}
<function_calls>
  <function_call>
    <tool>${exampleToolName}</tool>
    <args_json><![CDATA[${exampleArgs}]]></args_json>
  </function_call>
</function_calls>
\`\`\`

**一句话铁律：只要说了要调用工具，同一轮回复必须输出“触发信号 + <function_calls>”。只写计划 = 任务死锁。**${editList && writeList ? `

**编辑铁律：已存在文件的修改必须用 ${editList} 精确替换；${writeList} 只用于创建新文件，或用户明确要求且你已读过全文的整文件重写。**` : ''}

## 必须遵守的规则

- 不需要工具时，直接回复文本，不要输出任何 XML
- 收到工具结果后：任务未完成则按同样格式继续输出下一批工具调用；全部完成则只输出自然语言总结，不再输出任何 XML
- 调用工具时必须先输出触发信号（独占一行、与示例完全一致、只出现一次）。不输出触发信号直接输出 <function_calls> 不会被即时识别，必须等整段内容全部到达后才能解析，大幅增加延迟,容易导致客户端超时断开
- 上述"触发信号 + XML"是唯一有效的调用方式；禁止用 工具名({"参数":...}) 伪代码、[调用 工具名] {"参数":...}、[Call Tool] {...}、Action/Action Input、Tool/Input、<ApplyPatch>...</ApplyPatch>、纯 JSON 或自然语言宣称调用——这些格式一律不会被执行
- **只要你在正文里表达了"我来/我会/接下来/先"去"查看/读取/搜索/探索/分析/运行/修改…项目/文件/目录/代码…"这类意图，就必须在同一次回复里立即输出完整的"触发信号 + <function_calls>"块把它执行掉；禁止只写一句计划或说明然后停下，那样任务会直接死锁**
- 触发信号后紧跟 <function_calls>（中间可有空白）
- 所有调用放在一个 <function_calls> 块内，每个工具一个 <function_call>
- **<tool> 只能出现在 <function_call> 内部，且必须与配套的 <args_json> 一起出现；禁止输出孤立的 <tool>名称</tool>**
- <tool> 的值必须与上方可用工具列表中的名称完全一致
- <args_json> 内是一个合法且完整的 JSON 对象（{ 开头、} 结尾），参数名和类型匹配工具定义，字符串值内不得出现字面换行
- CDATA 开始必须是 <![CDATA[，结束必须是 ]]>；禁止写成 ]> 或 ]]]>
- JSON 字符串内的换行必须写成 \\n，反斜杠必须双写（Windows 路径 "D:\\\\repo\\\\a.js"）；路径以反斜杠结尾时同样双写
- 中文叙述引号优先用「」或‘’，不要在 JSON 字符串值里再嵌一套未转义的 ASCII "
- **<args_json> 内只能包含该工具定义里列出的参数——禁止添加工具定义里没有的字段（如 description、comment、note、justification 等）**
- </function_calls> 之后不得有任何文字${constraintText}`;
}

function isTitleGenerationRequest(req) {
  try {
    const body = req?.body || {};
    const system = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(p => p?.text || '').join('\n')
        : '';
    if (!system) return false;
    const lowerSystem = system.toLowerCase();
    return lowerSystem.includes('concise title')
      && (lowerSystem.includes('{"title"') || lowerSystem.includes('coding session'));
  } catch { return false; }
}

export function createPromptPlan({ req, tools = [], toolChoice = 'auto' } = {}) {
  const promptInjectionDisabled = isPromptInjectionDisabledForRequest(req);
  const isTitleGen = !promptInjectionDisabled && isTitleGenerationRequest(req);
  if (promptInjectionDisabled || isTitleGen) {
    const disabledPrompt = promptInjectionDisabled ? getRawJsonPromptForRequest(req) : null;
    return {
      promptInjectionDisabled: promptInjectionDisabled || isTitleGen,
      disabledPrompt,
      tools: [],
      toolChoice: 'none',
      toolCallingEnabled: false,
      triggerSignal: null,
      toolInstructions: '',
      parseToolCalls: () => null,
      parseToolCallsDetailed: () => ({ toolCalls: null, failureType: 'no_fc', errorDetails: isTitleGen ? 'Title generation is not tool-capable' : 'Prompt injection is disabled' }),
      createStreamDetector: () => null,
    };
  }

  const normalizedTools = normalizeTools(tools);
  const effectiveToolChoice = toolChoice ?? 'auto';
  const toolCallingEnabled = normalizedTools.length > 0 && !isNoneToolChoice(effectiveToolChoice);
  const triggerSignal = toolCallingEnabled ? generateTriggerSignal() : null;
  const toolInstructions = toolCallingEnabled
    ? buildXmlToolInstructions({ tools: normalizedTools, toolChoice: effectiveToolChoice, triggerSignal })
    : '';

  const parseToolCallsDetailed = (text) => parseXmlToolCallsDetailed(text, {
    triggerSignal,
    tools: normalizedTools,
    toolChoice: effectiveToolChoice,
  });
  const parseToolCalls = (text) => {
    const result = parseToolCallsDetailed(text);
    return result?.toolCalls?.length ? result : null;
  };

  return {
    promptInjectionDisabled: false,
    disabledPrompt: null,
    tools: normalizedTools,
    toolChoice: toolCallingEnabled ? effectiveToolChoice : 'none',
    toolCallingEnabled,
    triggerSignal,
    toolInstructions,
    parseToolCalls,
    parseToolCallsDetailed,
    createStreamDetector: () => toolCallingEnabled
      ? createXmlToolCallDetector({ triggerSignal, parseToolCalls, parseToolCallsDetailed })
      : null,
  };
}

function tagOpenAt(text, index, tag) {
  const match = String(text || '').slice(index).match(new RegExp(`^<${tag}\\b[^>]*>`, 'i'));
  return match ? { start: index, end: index + match[0].length, text: match[0] } : null;
}

function tagCloseAt(text, index, tag) {
  const match = String(text || '').slice(index).match(new RegExp(`^</${tag}\\s*>`, 'i'));
  return match ? { start: index, end: index + match[0].length, text: match[0] } : null;
}

function skipCdata(text, index) {
  if (!String(text || '').startsWith('<![CDATA[', index)) return null;
  const end = text.indexOf(']]>', index + '<![CDATA['.length);
  return end < 0 ? { truncated: true, end: text.length } : { truncated: false, end: end + ']]>'.length };
}

function findClosingTag(text, tag, fromIndex, skipTags = []) {
  const source = String(text || '');
  outer: for (let i = fromIndex; i < source.length; i++) {
    const cdata = skipCdata(source, i);
    if (cdata) {
      if (cdata.truncated) return null;
      i = cdata.end - 1;
      continue;
    }

    for (const skipTag of skipTags) {
      const skipOpen = tagOpenAt(source, i, skipTag);
      if (!skipOpen) continue;
      const skipClose = findClosingTag(source, skipTag, skipOpen.end, []);
      if (!skipClose) return null;
      i = skipClose.end - 1;
      continue outer;
    }

    const close = tagCloseAt(source, i, tag);
    if (close) return close;
  }
  return null;
}

function extractLeadingTagBlock(text, tag, skipTags = []) {
  const source = String(text || '');
  const open = tagOpenAt(source, 0, tag);
  if (!open) return null;
  const close = findClosingTag(source, tag, open.end, skipTags);
  if (!close) return { truncated: true, open, inner: source.slice(open.end), fullText: source };
  return {
    truncated: false,
    open,
    close,
    inner: source.slice(open.end, close.start),
    fullText: source.slice(0, close.end),
    end: close.end,
  };
}

function extractSequentialTagBlocks(text, tag, skipTags = []) {
  const source = String(text || '');
  const blocks = [];
  let i = 0;
  while (i < source.length) {
    while (i < source.length && /\s/.test(source[i])) i++;
    if (i >= source.length) break;
    const open = tagOpenAt(source, i, tag);
    if (!open) return null;
    const close = findClosingTag(source, tag, open.end, skipTags);
    if (!close) return null;
    blocks.push(source.slice(open.end, close.start));
    i = close.end;
  }
  return blocks;
}

function findTriggerSignalsOutsideThink(text, triggerSignal) {
  if (!text || !triggerSignal) return [];
  const positions = [];
  let thinkDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const cdata = skipCdata(text, i);
    if (cdata) {
      if (cdata.truncated) break;
      i = cdata.end - 1;
      continue;
    }

    const argsOpen = tagOpenAt(text, i, 'args_json');
    if (argsOpen) {
      const argsClose = findClosingTag(text, 'args_json', argsOpen.end, []);
      if (argsClose) {
        i = argsClose.end - 1;
        continue;
      }
    }

    const thinkOpen = tagOpenAt(text, i, 'think');
    if (thinkOpen) {
      thinkDepth += 1;
      i = thinkOpen.end - 1;
      continue;
    }
    const thinkClose = tagCloseAt(text, i, 'think');
    if (thinkClose) {
      thinkDepth = Math.max(0, thinkDepth - 1);
      i = thinkClose.end - 1;
      continue;
    }
    if (thinkDepth === 0 && text.startsWith(triggerSignal, i)) {
      positions.push(i);
      i += triggerSignal.length - 1;
    }
  }
  return positions;
}

export function findLastTriggerSignalOutsideThink(text, triggerSignal) {
  const positions = findTriggerSignalsOutsideThink(text, triggerSignal);
  return positions.length ? positions[positions.length - 1] : -1;
}

function findProtocolTriggerSignal(text, triggerSignal) {
  const positions = findTriggerSignalsOutsideThink(text, triggerSignal);
  for (let i = positions.length - 1; i >= 0; i--) {
    const afterSignal = text.slice(positions[i] + triggerSignal.length).replace(/^\s*/, '');
    if (tagOpenAt(afterSignal, 0, 'function_calls')) return positions[i];
  }
  return positions.length ? positions[positions.length - 1] : -1;
}

/**
 * 找到最后一个位于 <think> 块和 CDATA/args_json 之外的裸 <function_calls> 开标签位置。
 * 用于模型漏输出触发信号、直接给出 <function_calls> 块时的兜底解析。
 */
function findBareFunctionCallsStart(text) {
  if (!text) return -1;
  let last = -1;
  let thinkDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const cdata = skipCdata(text, i);
    if (cdata) {
      if (cdata.truncated) break;
      i = cdata.end - 1;
      continue;
    }

    const argsOpen = tagOpenAt(text, i, 'args_json');
    if (argsOpen) {
      const argsClose = findClosingTag(text, 'args_json', argsOpen.end, []);
      if (argsClose) {
        i = argsClose.end - 1;
        continue;
      }
    }

    const thinkOpen = tagOpenAt(text, i, 'think');
    if (thinkOpen) {
      thinkDepth += 1;
      i = thinkOpen.end - 1;
      continue;
    }
    const thinkClose = tagCloseAt(text, i, 'think');
    if (thinkClose) {
      thinkDepth = Math.max(0, thinkDepth - 1);
      i = thinkClose.end - 1;
      continue;
    }

    if (thinkDepth === 0) {
      const open = tagOpenAt(text, i, 'function_calls');
      if (open) {
        last = i;
        i = open.end - 1;
      }
    }
  }
  return last;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractCdata(raw) {
  const text = String(raw || '');
  const cdataRx = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  const matches = [...text.matchAll(cdataRx)];
  if (matches.length) {
    const outside = text.replace(cdataRx, '').trim();
    if (outside) return null;
    return matches.map(match => match[1]).join('');
  }
  return decodeXmlEntities(text).trim();
}

function extractTagBody(block, tag) {
  const source = String(block || '');
  for (let i = 0; i < source.length; i++) {
    const open = tagOpenAt(source, i, tag);
    if (!open) continue;
    const close = findClosingTag(source, tag, open.end, tag === 'args_json' ? [] : ['args_json']);
    return close ? source.slice(open.end, close.start) : null;
  }
  return null;
}

/**
 * 保守修复 JSON 字符串字面量内的常见非法内容：
 * - 字面换行/制表符/其他控制字符 → \n、\t、\uXXXX（模型输出 Edit/Write
 *   的多行内容时经常直接换行，JSON 不允许）
 * - 非法转义序列（如 Windows 路径 "C:\Users"）→ 反斜杠双写
 * 只在严格 JSON.parse 失败后作为兜底使用。
 */
function isCJ(unsigned) {
  return (unsigned >= 0x2E80 && unsigned <= 0x2EFF)   // CJK Radicals Supplement
      || (unsigned >= 0x2F00 && unsigned <= 0x2FDF)   // Kangxi Radicals
      || (unsigned >= 0x3000 && unsigned <= 0x303F)   // CJK Symbols and Punctuation
      || (unsigned >= 0x3200 && unsigned <= 0x32FF)   // Enclosed CJK Letters
      || (unsigned >= 0x3400 && unsigned <= 0x4DBF)   // CJK Unified Ext-A
      || (unsigned >= 0x4E00 && unsigned <= 0x9FFF)   // CJK Unified
      || (unsigned >= 0xF900 && unsigned <= 0xFAFF)   // CJK Compatibility
      || (unsigned >= 0xFF00 && unsigned <= 0xFFEF)   // Halfwidth/Fullwidth forms
      || (unsigned >= 0x20000 && unsigned <= 0x2FFFF); // SIP
}

function repairJsonStringLiterals(text, opts = {}) {
  const { forceLiteral } = opts;
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }
    if (char === '\\') {
      if (forceLiteral) {
        const next = text[i + 1];
        if (next === '"' || next === '\\' || next === 'n') {
          out += char + next;
          i++;
        } else {
          out += '\\\\';
        }
        continue;
      }
      const next = text[i + 1];
      if (next && '"\\/bfnrtu'.includes(next)) {
        out += char + next;
        i++;
      } else {
        out += '\\\\';
      }
      continue;
    }
    // 模型经常在JSON字符串值内用ASCII " 当作文中文引号（如 "是否允许为"优化设置页面样式"创建…"），
    // 破坏了JSON字符串边界。当 " 前后都是CJK字符时，必定是中文引号而非JSON结构边界——
    // JSON的 " 至少有一侧是逗号、冒号、花括号、方括号或空白。
    // 把这类引号替换为Unicode “，避免截断字符串导致JSON解析失败。
    if (char === '"') {
      const prevCJK = i > 0 && isCJ(text.charCodeAt(i - 1));
      const nextCJK = i + 1 < text.length && isCJ(text.charCodeAt(i + 1));
      if (prevCJK && nextCJK) {
        out += '\\u201c';
        // 不要退出字符串——这不是JSON结构边界，CJK引号内文本仍在当前字符串值中
        continue;
      }
      inString = false;
      out += char;
      continue;
    }
    if (char === '\n') { out += '\\n'; continue; }
    if (char === '\r') { out += '\\r'; continue; }
    if (char === '\t') { out += '\\t'; continue; }
    const code = char.charCodeAt(0);
    if (code < 0x20) { out += `\\u${code.toString(16).padStart(4, '0')}`; continue; }
    out += char;
  }
  return out;
}

/**
 * 修复"CDATA 提前闭合幻觉"导致的 JSON 结构破坏。真实案例：模型写完
 * new_string 后误输出 `"}]]`（对象闭合 + CDATA 闭合片段），随后想起还有
 * 参数没写，接着输出 `, "replace_all": false}}` 才真正闭合。提取出的文本
 * 形如 `{...}]], "k": v}}`，三处破坏一起修：
 * - 字符串外、无匹配 `[` 的游离 `]` 连串（含紧跟的 `>`）→ 删除
 * - 顶层对象已闭合却紧跟 `,` 继续写成员 → 撤销那个提前的 `}` 重新打开对象
 * - 收尾多余的未匹配 `}` → 删除
 * 全程感知字符串与转义，合法 JSON（含嵌套数组）不会命中任何分支。
 * 无改动时返回 null，只作为严格解析失败后的兜底候选。
 */
function repairStrayClosersInJson(text) {
  const source = String(text || '');
  const out = [];
  const stack = [];
  let inString = false;
  let changed = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      out.push(char);
      if (char === '\\') {
        i++;
        if (i < source.length) out.push(source[i]);
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; out.push(char); continue; }
    if (char === '{' || char === '[') { stack.push(char); out.push(char); continue; }
    if (char === '}') {
      if (stack[stack.length - 1] === '{') { stack.pop(); out.push(char); }
      else changed = true; // 无匹配的 }，丢弃
      continue;
    }
    if (char === ']') {
      if (stack[stack.length - 1] === '[') { stack.pop(); out.push(char); continue; }
      // 游离 ] 连串（CDATA 闭合片段），连同紧跟的 > 一起丢弃
      let j = i;
      while (j < source.length && source[j] === ']') j++;
      if (j < source.length && source[j] === '>') j++;
      changed = true;
      i = j - 1;
      continue;
    }
    if (char === ',' && !stack.length) {
      // 顶层已闭合却继续写成员：撤销最近的提前闭合，重新打开对象/数组
      let m = out.length - 1;
      while (m >= 0 && /\s/.test(out[m])) m--;
      if (m >= 0 && (out[m] === '}' || out[m] === ']')) {
        stack.push(out[m] === '}' ? '{' : '[');
        out.splice(m, 1);
        changed = true;
      }
      out.push(char);
      continue;
    }
    out.push(char);
  }
  return changed ? out.join('') : null;
}

function parseArgsJson(raw) {
  if (raw == null) return null;
  let extracted = extractCdata(raw);
  if (extracted == null) {
    // CDATA 标记把内容切开了（典型：模型在 JSON 中途输出 ]]> 提前闭合
    // CDATA，剩余参数泄漏到 CDATA 外）。剥掉全部标记、内外合并为一份
    // 候选文本，交给下面的修复流程。
    const merged = String(raw).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    if (!merged) return null;
    extracted = merged;
  }
  const text = extracted.trim();
  if (!text) return null;

  // 按优先级尝试一组候选修复：CDATA 内容优先当作字面文本解析
  // （Windows 路径里的 \t \n 不能按 JSON 转义处理）；随后回退标准修复、
  // 去掉尾部多余 `}`、补齐缺失的结尾 `}`（模型常漏写闭合花括号）、
  // 清理 JSON 中途游离的 CDATA 闭合片段（`}]], "k": v}}` 形态）。
  const forceLiteral = repairJsonStringLiterals(text, { forceLiteral: true });
  const candidates = [forceLiteral, repairJsonStringLiterals(text)];
  const trimmed = trimExtraClosingBraces(text);
  if (trimmed) candidates.push(repairJsonStringLiterals(trimmed));
  const balanced = balanceJsonBraces(text);
  if (balanced) {
    candidates.push(repairJsonStringLiterals(balanced, { forceLiteral: true }));
    candidates.push(repairJsonStringLiterals(balanced));
  }
  const strayFixed = repairStrayClosersInJson(text);
  if (strayFixed) {
    candidates.push(repairJsonStringLiterals(strayFixed, { forceLiteral: true }));
    candidates.push(repairJsonStringLiterals(strayFixed));
    const strayBalanced = balanceJsonBraces(strayFixed);
    if (strayBalanced) {
      candidates.push(repairJsonStringLiterals(strayBalanced, { forceLiteral: true }));
      candidates.push(repairJsonStringLiterals(strayBalanced));
    }
  }
  candidates.push(repairJsonStringLiterals(forceLiteral));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* 尝试下一个候选 */ }
  }
  return null;
}

// 补齐缺失的结尾 `}`：模型经常写完最后一个字符串值就漏掉对象闭合花括号。
// 逐字符扫描并感知字符串与转义，统计未闭合的 `{` 数量后补齐。
// 字符串未闭合（截断在引号内）或括号已平衡/过闭合时返回 null，交给其它修复。
function balanceJsonBraces(text) {
  if (typeof text !== 'string' || !text.trim() || text[0] !== '{') return null;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (char === '\\') { i++; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') depth--;
  }
  if (inString || depth <= 0) return null;
  return text + '}'.repeat(depth);
}

function trimExtraClosingBraces(text) {
  if (typeof text !== 'string' || !text.endsWith('}')) return null;
  // 从末尾往前数连续闭合花括号，全部可能的多余量都试一遍。
  let trailingCloseCount = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === '}'; i--) trailingCloseCount++;
  if (trailingCloseCount <= 1) return null;
  // 尝试从去掉 1 个到去掉 (trailingCloseCount-1) 个尾部 }
  for (let trim = 1; trim < trailingCloseCount; trim++) {
    const candidate = text.slice(0, text.length - trim);
    // 快速平衡检查
    let depth = 0;
    for (let i = 0; i < candidate.length; i++) {
      if (candidate[i] === '{') depth++;
      else if (candidate[i] === '}') depth--;
    }
    if (depth === 0 && candidate.endsWith('}')) return candidate;
  }
  return null;
}

const TOOL_NAME_ALIASES = new Map([
  ['shell', 'Bash'],
  ['shell_command', 'Bash'],
  ['terminal', 'Bash'],
  ['execute', 'Bash'],
  ['cmd', 'Bash'],
]);

function resolveToolName(rawName, availableTools = []) {
  const lower = String(rawName || '').toLowerCase();
  const known = new Map(
    availableTools.map(t => [String(t?.function?.name || t?.name || '').toLowerCase(), t?.function?.name || t?.name])
  );

  // 优先尊重客户端实际暴露的工具名。Codex 类客户端会直接提供
  // shell_command 工具；如果先把它硬映射为 Bash，会在校验阶段变成
  // unknown tool，最终导致原始 <function_calls> XML 被当作普通文本透传。
  const exact = known.get(lower);
  if (exact) return exact;

  const alias = TOOL_NAME_ALIASES.get(lower);
  if (alias) return known.get(alias.toLowerCase()) || alias;
  return rawName;
}

function getToolParameters(tool) {
  return tool?.function?.parameters ?? tool?.parameters ?? null;
}

// 模型常见 schema 越界：AskUserQuestion 的 options 超过 maxItems=4、
// header 超过 maxLength=12 等。这些都是“多写了”而不是“写错了”——
// 截断到 schema 允许范围后仍可安全执行，避免整条工具调用被丢弃、
// XML 原文泄漏给客户端。
function coerceValueToSchema(value, schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 8) return value;

  // allOf: apply each subschema in order
  if (Array.isArray(schema.allOf)) {
    let current = value;
    for (const sub of schema.allOf) current = coerceValueToSchema(current, sub ?? {}, depth + 1);
    return current;
  }

  // anyOf/oneOf: try first subschema that can accept the value shape; best-effort
  for (const key of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[key]) || !schema[key].length) continue;
    // Prefer the first object/array subschema that matches value type
    for (const sub of schema[key]) {
      if (!sub || typeof sub !== 'object') continue;
      const types = Array.isArray(sub.type) ? sub.type : (sub.type ? [sub.type] : []);
      if (!types.length) return coerceValueToSchema(value, sub, depth + 1);
      if (types.includes('array') && Array.isArray(value)) return coerceValueToSchema(value, sub, depth + 1);
      if (types.includes('object') && value && typeof value === 'object' && !Array.isArray(value)) {
        return coerceValueToSchema(value, sub, depth + 1);
      }
      if (types.includes('string') && typeof value === 'string') return coerceValueToSchema(value, sub, depth + 1);
    }
  }

  if (Array.isArray(value)) {
    let arr = value;
    if (Number.isInteger(schema.maxItems) && arr.length > schema.maxItems) {
      arr = arr.slice(0, schema.maxItems);
    }
    if (Object.prototype.hasOwnProperty.call(schema, 'items')) {
      arr = arr.map(item => coerceValueToSchema(item, schema.items, depth + 1));
    }
    return arr;
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      return value.slice(0, schema.maxLength);
    }
    return value;
  }

  if (value && typeof value === 'object') {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
    const additional = schema.additionalProperties;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (props && Object.prototype.hasOwnProperty.call(props, key)) {
        out[key] = coerceValueToSchema(child, props[key] ?? {}, depth + 1);
      } else if (additional === false) {
        // strip unexpected properties
        continue;
      } else if (additional && typeof additional === 'object') {
        out[key] = coerceValueToSchema(child, additional, depth + 1);
      } else {
        out[key] = child;
      }
    }
    return out;
  }

  return value;
}

function coerceParsedToolsToSchema(parsedTools = [], tools = []) {
  const byName = new Map(
    (tools || []).map(t => [t?.function?.name || t?.name, getToolParameters(t)])
  );
  for (const tool of parsedTools) {
    if (!tool || !tool.args || typeof tool.args !== 'object' || Array.isArray(tool.args)) continue;
    const schema = byName.get(tool.name);
    if (!schema) continue;
    tool.args = coerceValueToSchema(tool.args, schema);
  }
  return parsedTools;
}

function parseFunctionCallsBlockAt(text, { blockStart, rawStart, prefix, tools = [], toolChoice = 'auto' }) {
  const blockSource = text.slice(blockStart);
  const callsBlock = extractLeadingTagBlock(blockSource, 'function_calls', ['args_json']);
  if (!callsBlock || callsBlock.truncated) {
    const failureType = tagOpenAt(blockSource, 0, 'function_calls') ? 'truncated' : 'syntax_error';
    return { toolCalls: null, content: prefix || null, failureType, errorDetails: 'Missing complete <function_calls>...</function_calls> block after trigger', triggerIndex: rawStart };
  }
  if (blockSource.slice(callsBlock.end).trim()) {
    return { toolCalls: null, content: prefix || null, failureType: 'syntax_error', errorDetails: 'Unexpected text after </function_calls>', triggerIndex: rawStart };
  }

  const callBlocks = extractSequentialTagBlocks(callsBlock.inner, 'function_call', ['args_json']);
  if (!callBlocks || !callBlocks.length) {
    return { toolCalls: null, content: prefix || null, failureType: 'syntax_error', errorDetails: callBlocks ? 'No <function_call> blocks found inside <function_calls>' : 'Malformed content inside <function_calls>; expected only complete <function_call> blocks', triggerIndex: rawStart };
  }

  const parsedTools = [];
  for (let i = 0; i < callBlocks.length; i++) {
    const block = callBlocks[i];
    const rawName = decodeXmlEntities(extractTagBody(block, 'tool') || '').trim();
    if (!rawName) {
      return { toolCalls: null, content: prefix || null, failureType: 'syntax_error', errorDetails: `Tool call #${i + 1}: missing <tool> value`, triggerIndex: rawStart };
    }
    // 模型可能输出 shell/terminal/execute 等别名，映射回客户端实际工具名
    const name = resolveToolName(rawName, tools);

    const argsBody = extractTagBody(block, 'args_json');
    const args = parseArgsJson(argsBody);
    if (args == null) {
      return { toolCalls: null, content: prefix || null, failureType: 'syntax_error', errorDetails: `Tool call #${i + 1} '${name}': <args_json> must contain a valid JSON object`, triggerIndex: rawStart };
    }

    parsedTools.push({ name, args });
  }

  // 批调用里个别工具参数冗余（如 Bash 多了 description）不应导致整批失败。
  // 先按工具定义剥离不在参数列表中的字段，再走校验。
  const toolsByName = new Map(
    tools.map(t => [t?.function?.name || t?.name, t?.function?.parameters?.properties ? Object.keys(t.function.parameters.properties) : null])
  );
  for (const tool of parsedTools) {
    const allowedKeys = toolsByName.get(tool.name);
    if (allowedKeys && tool.args && typeof tool.args === 'object' && !Array.isArray(tool.args)) {
      for (const key of Object.keys(tool.args)) {
        if (!allowedKeys.includes(key)) delete tool.args[key];
      }
      // 修复参数类型错误：command 必须是字符串，模型偶尔输出数组
      const commandVal = tool.args.command;
      if (commandVal !== undefined && tool.name === 'Bash' && Array.isArray(commandVal)) {
        tool.args.command = String(commandVal.join(' '));
      }
    }
  }

  // 软修复 schema 越界（maxItems/maxLength/additionalProperties），避免
  // AskUserQuestion 因 options 多 1 项就被整条丢弃。
  coerceParsedToolsToSchema(parsedTools, tools);

  const validationError = validateParsedTools(parsedTools, tools, toolChoice);
  if (validationError) {
    return { toolCalls: null, content: prefix || null, failureType: 'schema_error', errorDetails: validationError, parsedTools, triggerIndex: rawStart };
  }

  const toolCalls = parsedTools.map((tool) => ({
    id: createInternalId('call'),
    type: 'function',
    function: {
      name: tool.name,
      arguments: JSON.stringify(tool.args || {}),
    },
  }));

  return {
    toolCalls,
    content: prefix || null,
    rawToolText: text.slice(rawStart, blockStart + callsBlock.fullText.length),
    triggerIndex: rawStart,
    failureType: null,
    errorDetails: null,
  };
}

function normalizeToolNameKey(name) {
  return String(name || '').toLowerCase().replace(/[\s_-]/g, '');
}

function findToolByNormalizedName(tools = [], normalizedNames = []) {
  const wanted = new Set(normalizedNames.map(normalizeToolNameKey));
  for (const tool of tools || []) {
    const name = tool?.function?.name || tool?.name;
    if (wanted.has(normalizeToolNameKey(name))) return tool;
  }
  return null;
}

function findApplyPatchStart(text) {
  if (!text) return -1;
  let last = -1;
  let thinkDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const cdata = skipCdata(text, i);
    if (cdata) {
      if (cdata.truncated) break;
      i = cdata.end - 1;
      continue;
    }

    const thinkOpen = tagOpenAt(text, i, 'think');
    if (thinkOpen) {
      thinkDepth += 1;
      i = thinkOpen.end - 1;
      continue;
    }
    const thinkClose = tagCloseAt(text, i, 'think');
    if (thinkClose) {
      thinkDepth = Math.max(0, thinkDepth - 1);
      i = thinkClose.end - 1;
      continue;
    }

    if (thinkDepth === 0) {
      const open = tagOpenAt(text, i, 'ApplyPatch');
      if (open) {
        last = i;
        i = open.end - 1;
      }
    }
  }
  return last;
}

function buildApplyPatchArgs(tool, patch) {
  const props = tool?.function?.parameters?.properties || tool?.parameters?.properties || {};
  for (const key of ['patch', 'input', 'content', 'text']) {
    if (Object.prototype.hasOwnProperty.call(props, key)) return { [key]: patch };
  }
  return { patch };
}

function parseApplyPatchXml(text, { tools = [], toolChoice = 'auto' } = {}) {
  const start = findApplyPatchStart(text);
  if (start < 0) return null;

  const prefix = text.slice(0, start).trimEnd();
  const source = text.slice(start);
  const block = extractLeadingTagBlock(source, 'ApplyPatch', ['patch']);
  if (!block || block.truncated) {
    return {
      toolCalls: null,
      content: prefix || null,
      failureType: 'truncated',
      errorDetails: 'Detected <ApplyPatch> output but the block is incomplete. Use the required trigger signal + <function_calls> XML format instead.',
      triggerIndex: start,
    };
  }
  if (source.slice(block.end).trim()) {
    return {
      toolCalls: null,
      content: prefix || null,
      failureType: 'syntax_error',
      errorDetails: 'Unexpected text after </ApplyPatch>. Use the required trigger signal + <function_calls> XML format instead.',
      triggerIndex: start,
    };
  }

  const patchBody = extractTagBody(block.inner, 'patch');
  const patch = patchBody != null ? extractCdata(patchBody) : extractCdata(block.inner);
  if (!patch || !String(patch).trim()) {
    return {
      toolCalls: null,
      content: prefix || null,
      failureType: 'syntax_error',
      errorDetails: 'Detected <ApplyPatch> output but no patch content was found. Use the required trigger signal + <function_calls> XML format instead.',
      triggerIndex: start,
    };
  }

  const tool = findToolByNormalizedName(tools, ['ApplyPatch', 'apply_patch', 'applypatch']);
  if (!tool) {
    return {
      toolCalls: null,
      content: prefix || null,
      failureType: 'schema_error',
      errorDetails: 'Detected non-standard <ApplyPatch> output, but no ApplyPatch/apply_patch tool is available. Retry using one of the available tools in the required trigger signal + <function_calls> XML format.',
      triggerIndex: start,
    };
  }

  const name = tool.function?.name || tool.name;
  const args = buildApplyPatchArgs(tool, patch);
  const validationError = validateParsedTools([{ name, args }], tools, toolChoice);
  if (validationError) {
    return {
      toolCalls: null,
      content: prefix || null,
      failureType: 'schema_error',
      errorDetails: `Detected non-standard <ApplyPatch> output. Retry using the required trigger signal + <function_calls> XML format. ${validationError}`,
      parsedTools: [{ name, args }],
      triggerIndex: start,
    };
  }

  return {
    toolCalls: [{
      id: createInternalId('call'),
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }],
    content: prefix || null,
    rawToolText: text.slice(start, start + block.fullText.length),
    triggerIndex: start,
    failureType: null,
    errorDetails: null,
  };
}

// 模型常把 CDATA 结束标记 `]]>` 写成 `]>`（少一个 `]`）或 `]]]>`（多一个）。
// 只有紧跟 </args_json> 或 </patch> 闭合标签时才规范化，避免误改参数值里
// 恰好出现的 `]>` 字面量。修好后 skipCdata / extractCdata 才能正确解析，
// 否则整个 <function_calls> 块会被判定为未闭合而失败，最终只剩裸 <tool> 泄漏。
export function repairMalformedCdataClose(text) {
  if (typeof text !== 'string' || text.indexOf('<![CDATA[') < 0) return text;
  return text.replace(/\]{1,3}>(\s*<\/(?:args_json|patch)\s*>)/gi, ']]>$1');
}

export function parseXmlToolCallsDetailed(rawText, { triggerSignal, tools = [], toolChoice = 'auto' } = {}) {
  const text = repairMalformedCdataClose(rawText);
  if (!text || !triggerSignal) {
    return { toolCalls: null, content: null, failureType: 'no_fc', errorDetails: 'No trigger signal configured or content is empty' };
  }
  const signalPos = findProtocolTriggerSignal(text, triggerSignal);
  if (signalPos < 0) {
    // 兜底：模型有时漏掉触发信号，直接输出裸 <function_calls> 块。
    // 此时仍按协议解析该块，避免整段工具调用 XML 被当作普通文本透传给客户端。
    const bareStart = findBareFunctionCallsStart(text);
    if (bareStart < 0) {
      // 兜底 2：模型用 <ApplyPatch> 专用伪 XML 直接输出补丁。
      // 有对应工具则转成 tool_call；没有则触发纠错重试，不把 patch 当正文泄漏。
      const applyPatch = parseApplyPatchXml(text, { tools, toolChoice });
      if (applyPatch) return applyPatch;
      // 兜底 3：模型复读 OpenAI/Responses 转录项，如 [User]: {"type":"function_call",...}。
      // 这表示明确工具调用意图，必须转成真实 tool_call，不能把转录文本透传给客户端。
      const transcriptCalls = parseTranscriptFunctionCallItems(text, { tools, toolChoice });
      if (transcriptCalls) return transcriptCalls;
      // 兜底 4：模型用 `[调用 Tool] {...}` / `[Call Tool] {...}` 日志式文本表示调用。
      // 这类格式经常来自中文 Agent 轨迹模仿；必须转成真实 tool_call 或触发纠错，不能透传给客户端。
      const bracketPseudo = parseBracketPseudoToolCalls(text, { tools, toolChoice });
      if (bracketPseudo) return bracketPseudo;
      // 兜底 5：模型用 `工具名({...})` 伪代码文本表示调用（无信号无 XML）。
      // 能解析且校验通过则直接执行；表达了调用意图但不合规则报 schema_error
      // 触发纠错重试，而不是当纯文本透传导致任务死锁。
      const pseudo = parsePseudoToolCalls(text, { tools, toolChoice });
      if (pseudo) return pseudo;
      return { toolCalls: null, content: String(text || '') || null, failureType: 'no_fc', errorDetails: `Trigger signal '${triggerSignal}' not found outside <think> blocks` };
    }
    return parseFunctionCallsBlockAt(text, {
      blockStart: bareStart,
      rawStart: bareStart,
      prefix: text.slice(0, bareStart).trimEnd(),
      tools,
      toolChoice,
    });
  }

  const prefix = text.slice(0, signalPos).trimEnd();
  const signalEnd = signalPos + triggerSignal.length;
  const leadingWs = text.slice(signalEnd).match(/^\s*/)?.[0]?.length || 0;
  return parseFunctionCallsBlockAt(text, {
    blockStart: signalEnd + leadingWs,
    rawStart: signalPos,
    prefix,
    tools,
    toolChoice,
  });
}

// 深度计数提取从 start（必须是 '{'）开始的平衡 JSON 对象文本。
function extractBalancedJsonObject(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (char === '\\') { escape = true; continue; }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return { jsonText: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}

function toolNameIndex(tools = []) {
  const index = new Map();
  for (const tool of tools) {
    const name = tool?.function?.name || tool?.name;
    if (name) index.set(normalizeToolNameKey(name), name);
  }
  return index;
}

function parseJsonObjectText(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch {
    try {
      return JSON.parse(repairJsonStringLiterals(jsonText));
    } catch {
      return null;
    }
  }
}

/**
 * 识别 `[调用 Glob] { ... }` / `[Call Tool] { ... }` 形状的日志式伪工具调用。
 * 这类输出不是标准协议，但表达了明确工具调用意图：能校验通过则转成
 * tool_call；工具名/参数不合规则触发 retry，避免伪调用文本泄漏给客户端。
 */
function parseTranscriptFunctionCallItems(text, { tools = [], toolChoice = 'auto' } = {}) {
  if (!text) return null;
  const parsedTools = [];
  let firstStart = -1;
  let lastEnd = -1;
  let sawFunctionCall = false;
  const rx = /(?:^|\n)[ \t]*\[(?:User|Assistant)\]:[ \t]*(\{)/gi;
  let match;
  while ((match = rx.exec(text)) !== null) {
    const labelStart = match.index + match[0].indexOf('[');
    const jsonStart = match.index + match[0].length - 1;
    const balanced = extractBalancedJsonObject(text, jsonStart);
    if (!balanced) continue;
    const item = parseJsonObjectText(balanced.jsonText);
    if (!item || item.type !== 'function_call') {
      rx.lastIndex = balanced.end;
      continue;
    }
    sawFunctionCall = true;
    if (firstStart < 0) firstStart = labelStart;
    const rawArgs = item.arguments ?? {};
    const args = typeof rawArgs === 'string' ? parseJsonObjectText(rawArgs || '{}') : rawArgs;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return {
        toolCalls: null,
        content: text.slice(0, firstStart).trimEnd() || null,
        failureType: 'syntax_error',
        errorDetails: '检测到 [User]: {"type":"function_call"...} 转录式工具调用，但 arguments 不是合法 JSON 对象。必须使用"触发信号 + <function_calls> XML"格式重新输出。',
        triggerIndex: firstStart,
      };
    }
    parsedTools.push({ id: item.call_id || item.id || null, name: resolveToolName(item.name, tools), args });
    lastEnd = balanced.end;
    rx.lastIndex = balanced.end;
  }

  if (!sawFunctionCall) return null;
  const prefix = text.slice(0, firstStart).trimEnd();
  const validationError = validateParsedTools(parsedTools, tools, toolChoice);
  if (validationError) {
    return {
      toolCalls: null,
      content: prefix || null,
      failureType: 'schema_error',
      errorDetails: `检测到 [User]: {"type":"function_call"...} 转录式工具调用，该格式无效，必须使用"触发信号 + <function_calls> XML"格式重新输出。${validationError}`,
      parsedTools,
      triggerIndex: firstStart,
    };
  }

  return {
    toolCalls: parsedTools.map(tool => ({
      id: tool.id || createInternalId('call'),
      type: 'function',
      function: {
        name: tool.name,
        arguments: JSON.stringify(tool.args || {}),
      },
    })),
    content: prefix || null,
    rawToolText: text.slice(firstStart, lastEnd > firstStart ? lastEnd : undefined),
    triggerIndex: firstStart,
    failureType: null,
    errorDetails: null,
  };
}

function parseBracketPseudoToolCalls(text, { tools = [], toolChoice = 'auto' } = {}) {
  const nameIndex = toolNameIndex(tools);
  if (!nameIndex.size || !text) return null;

  const parsedTools = [];
  let firstStart = -1;
  let lastEnd = -1;
  let sawPseudoCall = false;
  const rx = /(?:^|\n)[ \t]*\[(?:调用工具|调用|使用工具|使用|Call|Tool|Use)\s+([A-Za-z_][A-Za-z0-9_.-]*)\][ \t]*(\{)/gi;
  let match;
  while ((match = rx.exec(text)) !== null) {
    sawPseudoCall = true;
    const rawName = match[1];
    const nameStart = match.index + match[0].indexOf('[');
    const jsonStart = match.index + match[0].length - 1;
    if (firstStart < 0) firstStart = nameStart;

    const balanced = extractBalancedJsonObject(text, jsonStart);
    if (!balanced) {
      return {
        toolCalls: null,
        content: text.slice(0, firstStart).trimEnd() || null,
        failureType: 'truncated',
        errorDetails: `检测到 [调用 ${rawName}] {...} 日志式工具调用，但 JSON 参数不完整。必须使用"触发信号 + <function_calls> XML"格式重新输出。`,
        triggerIndex: firstStart,
      };
    }

    const args = parseJsonObjectText(balanced.jsonText);
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return {
        toolCalls: null,
        content: text.slice(0, firstStart).trimEnd() || null,
        failureType: 'syntax_error',
        errorDetails: `检测到 [调用 ${rawName}] {...} 日志式工具调用，但参数不是合法 JSON 对象。必须使用"触发信号 + <function_calls> XML"格式重新输出。`,
        triggerIndex: firstStart,
      };
    }

    const officialName = nameIndex.get(normalizeToolNameKey(rawName));
    parsedTools.push({ name: officialName || rawName, args });
    lastEnd = balanced.end;
    rx.lastIndex = balanced.end;
  }

  if (!sawPseudoCall) return null;
  const prefix = text.slice(0, firstStart).trimEnd();
  if (!parsedTools.length) {
    return {
      toolCalls: null,
      content: prefix || null,
      failureType: 'schema_error',
      errorDetails: '检测到日志式工具调用，但没有可执行的工具参数。必须使用"触发信号 + <function_calls> XML"格式重新输出。',
      triggerIndex: firstStart,
    };
  }

  const validationError = validateParsedTools(parsedTools, tools, toolChoice);
  if (validationError) {
    return {
      toolCalls: null,
      content: prefix || null,
      failureType: 'schema_error',
      errorDetails: `检测到 [调用 Tool] {...} / [Call Tool] {...} 日志式工具调用，该格式无效，必须使用"触发信号 + <function_calls> XML"格式重新输出。${validationError}`,
      parsedTools,
      triggerIndex: firstStart,
    };
  }

  const toolCalls = parsedTools.map((tool) => ({
    id: createInternalId('call'),
    type: 'function',
    function: {
      name: tool.name,
      arguments: JSON.stringify(tool.args || {}),
    },
  }));

  return {
    toolCalls,
    content: prefix || null,
    rawToolText: text.slice(firstStart, lastEnd > firstStart ? lastEnd : undefined),
    triggerIndex: firstStart,
    failureType: null,
    errorDetails: null,
  };
}

/**
 * 识别 `工具名({...})` 形状的伪代码调用（模型幻觉出的函数调用语法）。
 * 保守激活条件，避免把普通文本/代码示例误判成调用：
 * - 必须位于行首（可有缩进），函数名后紧跟 ({...}) 且参数是可解析的 JSON 对象
 * - 至少一个函数名与已定义工具命中（大小写不敏感）才认为存在调用意图
 * 命中已定义工具的名字会规范化为官方大小写；未知名保留原样，交给
 * validateParsedTools 报 unknown tool → schema_error → 触发纠错重试。
 */
function parsePseudoToolCalls(text, { tools = [], toolChoice = 'auto' } = {}) {
  const nameIndex = new Map();
  for (const tool of tools) {
    const name = tool?.function?.name || tool?.name;
    if (name) nameIndex.set(String(name).toLowerCase(), name);
  }
  if (!nameIndex.size) return null;

  const parsedTools = [];
  let anyKnown = false;
  let firstStart = -1;
  const rx = /(?:^|\n)[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/g;
  let match;
  while ((match = rx.exec(text)) !== null) {
    const rawName = match[1];
    const nameStart = match.index + match[0].indexOf(rawName);
    let cursor = match.index + match[0].length;
    while (cursor < text.length && /[ \t\r\n]/.test(text[cursor])) cursor++;
    const obj = extractBalancedJsonObject(text, cursor);
    if (!obj) continue;
    const closing = text.slice(obj.end).match(/^[ \t\r\n]*\)/);
    if (!closing) continue;

    let args;
    try {
      args = JSON.parse(obj.jsonText);
    } catch {
      try {
        args = JSON.parse(repairJsonStringLiterals(obj.jsonText));
      } catch {
        continue;
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;

    const officialName = nameIndex.get(rawName.toLowerCase());
    if (officialName) anyKnown = true;
    if (firstStart < 0) firstStart = nameStart;
    parsedTools.push({ name: officialName || rawName, args });
    rx.lastIndex = obj.end + closing[0].length;
  }

  if (!parsedTools.length || !anyKnown) return null;

  const prefix = text.slice(0, firstStart).trimEnd();
  const validationError = validateParsedTools(parsedTools, tools, toolChoice);
  if (validationError) {
    return {
      toolCalls: null,
      content: prefix || null,
      failureType: 'schema_error',
      errorDetails: `检测到 工具名({...}) 伪代码格式的调用，该格式无效，必须使用"触发信号 + <function_calls> XML"格式重新输出。${validationError}`,
      parsedTools,
      triggerIndex: firstStart,
    };
  }

  const toolCalls = parsedTools.map((tool) => ({
    id: createInternalId('call'),
    type: 'function',
    function: {
      name: tool.name,
      arguments: JSON.stringify(tool.args || {}),
    },
  }));

  return {
    toolCalls,
    content: prefix || null,
    rawToolText: text.slice(firstStart),
    triggerIndex: firstStart,
    failureType: null,
    errorDetails: null,
  };
}

export function parseXmlToolCallsFromText(text, opts = {}) {
  const result = parseXmlToolCallsDetailed(text, opts);
  return result?.toolCalls?.length ? result : null;
}

function bracketPseudoCallOpenAt(text, index) {
  const source = String(text || '').slice(index);
  const match = source.match(/^\[(?:调用工具|调用|使用工具|使用|Call|Tool|Use)\s+[A-Za-z_][A-Za-z0-9_.-]*\][ \t]*(?:\{|$)/i);
  return match ? { start: index, end: index + match[0].length, text: match[0] } : null;
}

function isPartialBracketPseudoAtEnd(text) {
  const rest = String(text || '');
  if (!rest.startsWith('[')) return false;
  return /^\[(?:调(?:用(?:工(?:具)?)?)?|使(?:用(?:工(?:具)?)?)?|C(?:a(?:l(?:l)?)?)?|T(?:o(?:o(?:l)?)?)?|U(?:s(?:e)?)?)(?:\s+[A-Za-z_][A-Za-z0-9_.-]*)?(?:\]?[ \t]*)?$/i.test(rest);
}

function isPartialPatternAtEnd(buffer, index, patterns) {
  const rest = buffer.slice(index);
  if (patterns.some(pattern => rest.length < pattern.length && pattern.startsWith(rest))) return true;
  if (isPartialBracketPseudoAtEnd(rest)) return true;
  const lower = rest.toLowerCase();
  if ('<think'.startsWith(lower) || '</think'.startsWith(lower)) return true;
  if (/^<think\b[^>]*$/i.test(rest) || /^<\/think\s*$/i.test(rest)) return true;
  if ('<function_calls'.startsWith(lower)) return true;
  if (/^<function_calls\b[^>]*$/i.test(rest)) return true;
  if ('<applypatch'.startsWith(lower)) return true;
  if (/^<applypatch\b[^>]*$/i.test(rest)) return true;
  return false;
}

export function createXmlToolCallDetector({ triggerSignal, parseToolCalls, parseToolCallsDetailed = null }) {
  const patterns = [triggerSignal, '<think>', '</think>'].filter(Boolean);
  let state = 'detecting';
  let scanBuffer = '';
  let toolBuffer = '';
  let thinkDepth = 0;
  let completed = false;

  function buildParseFailure(base = {}, failureResult = null) {
    const bufferedToolText = toolBuffer;
    const result = failureResult || (parseToolCallsDetailed ? parseToolCallsDetailed(bufferedToolText) : null);
    state = 'passthrough';
    toolBuffer = '';
    return {
      ...base,
      delta: `${base.delta || ''}${bufferedToolText}`,
      parseFailure: true,
      bufferedToolText,
      failureType: result?.failureType || 'syntax_error',
      errorDetails: result?.errorDetails || 'Function-call XML could not be parsed',
      failureResult: result,
    };
  }

  function parseBufferedToolText(base = {}) {
    if (parseToolCallsDetailed) {
      const detailed = parseToolCallsDetailed(toolBuffer);
      if (detailed?.toolCalls?.length) {
        completed = true;
        return { ...base, completed: true, toolCalls: detailed.toolCalls, content: detailed.content || null };
      }
      if (detailed?.failureType === 'truncated') return base;
      if (detailed?.failureType === 'no_fc') return base;
      // 信号模式下缓冲区以触发信号开头；裸块兜底模式下直接以 <function_calls 开头，
      // 此时用整个缓冲区判断"块是否仍在续传"，避免语法错误被永久缓冲。
      const afterTrigger = triggerSignal && toolBuffer.startsWith(triggerSignal)
        ? toolBuffer.slice(triggerSignal.length)
        : toolBuffer;
      const afterTriggerTrimmed = afterTrigger.trimStart();
      const afterTriggerLower = afterTriggerTrimmed.toLowerCase();
      if (
        /^\s*$/.test(afterTrigger)
        || '<function_calls'.startsWith(afterTriggerLower)
        || /^<function_calls\b[^>]*$/i.test(afterTriggerTrimmed)
      ) return base;
      return buildParseFailure(base, detailed);
    }

    if (!/<\/function_calls\s*>/i.test(toolBuffer)) return base;
    const parsed = parseToolCalls(toolBuffer);
    if (parsed?.toolCalls?.length) {
      completed = true;
      return { ...base, completed: true, toolCalls: parsed.toolCalls, content: parsed.content || null };
    }
    state = 'passthrough';
    completed = true;
    return { ...base, delta: `${base.delta || ''}${toolBuffer}` };
  }

  return {
    process(chunk) {
      if (!chunk) return { delta: '' };
      if (completed) return { delta: '' };
      if (state === 'passthrough') return { delta: chunk };
      if (state === 'tool_parsing') {
        toolBuffer += chunk;
        return parseBufferedToolText({ delta: '' });
      }

      scanBuffer += chunk;
      let delta = '';
      let i = 0;

      while (i < scanBuffer.length) {
        const remaining = scanBuffer.slice(i);

        const thinkOpen = tagOpenAt(scanBuffer, i, 'think');
        if (thinkOpen) {
          thinkDepth += 1;
          delta += thinkOpen.text;
          i = thinkOpen.end;
          continue;
        }
        const thinkClose = tagCloseAt(scanBuffer, i, 'think');
        if (thinkClose) {
          thinkDepth = Math.max(0, thinkDepth - 1);
          delta += thinkClose.text;
          i = thinkClose.end;
          continue;
        }

        if (thinkDepth === 0 && triggerSignal && remaining.startsWith(triggerSignal)) {
          state = 'tool_parsing';
          toolBuffer = scanBuffer.slice(i);
          scanBuffer = '';
          return parseBufferedToolText({ delta });
        }

        // 兜底：模型漏掉触发信号、直接输出裸 <function_calls> 块时也进入工具缓冲，
        // 否则整段工具调用 XML 会以文本增量透传给客户端。
        if (thinkDepth === 0 && tagOpenAt(scanBuffer, i, 'function_calls')) {
          state = 'tool_parsing';
          toolBuffer = scanBuffer.slice(i);
          scanBuffer = '';
          return parseBufferedToolText({ delta });
        }

        // 兼容/拦截非标准 <ApplyPatch> 伪 XML：尽早缓冲，避免大 patch 作为
        // 文本 delta 泄漏；后续由 parseXmlToolCallsDetailed 转 tool_call 或触发重试。
        if (thinkDepth === 0 && tagOpenAt(scanBuffer, i, 'ApplyPatch')) {
          state = 'tool_parsing';
          toolBuffer = scanBuffer.slice(i);
          scanBuffer = '';
          return parseBufferedToolText({ delta });
        }

        // 兼容/拦截 `[调用 Glob] {...}` / `[Call Tool] {...}` 日志式伪调用。
        // 在 `[` 起始处就进入缓冲，防止伪工具文本先以正文流给客户端。
        if (thinkDepth === 0 && bracketPseudoCallOpenAt(scanBuffer, i)) {
          state = 'tool_parsing';
          toolBuffer = scanBuffer.slice(i);
          scanBuffer = '';
          return parseBufferedToolText({ delta });
        }

        if (isPartialPatternAtEnd(scanBuffer, i, patterns)) break;

        delta += scanBuffer[i];
        i += 1;
      }

      scanBuffer = scanBuffer.slice(i);
      return { delta };
    },

    finish() {
      if (completed) return { delta: '' };
      if (state === 'tool_parsing') {
        const parsed = parseToolCalls(toolBuffer);
        if (parsed?.toolCalls?.length) {
          completed = true;
          return { delta: '', completed: true, toolCalls: parsed.toolCalls, content: parsed.content || null };
        }
        if (parseToolCallsDetailed) {
          completed = true;
          return buildParseFailure({ delta: '' });
        }
        completed = true;
        return { delta: toolBuffer };
      }
      const tail = scanBuffer;
      scanBuffer = '';
      return { delta: tail };
    },
  };
}
