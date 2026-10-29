import { detectFileMutationTools, findLastTriggerSignalOutsideThink } from './prompt-strategy.js';
import { getConfig } from '../services/config-store.js';

export function isFcErrorRetryEnabled() {
  return getConfig().runtime.enableFcErrorRetry;
}

// 上游能力放开后不再限制纠错重试次数，只保留一个防御性上限：
// 防止模型在永远无法产出合法 XML 时把重试循环变成无限上游调用。
// 这是防跑飞的循环护栏，不是对上游能力的限制。
const RETRY_LOOP_GUARD = 25;

/**
 * 判定"没有产出任何用户可见内容"的空回复，两种真实形态：
 *
 * 1. 只思考、无正文（2026-09-14 线上日志）：deepseek-flash 在多轮工具
 *    调用后只输出 thinking 就 finishReason=stop，客户端看得到思考、
 *    拿不到答案。
 * 2. 完全空流（2026-09-14 实测）：上游返回 200 + 仅 role 与
 *    finish_reason 的空流（约 281 字节 / 170ms），思考与正文皆无。
 *    池中受静默限制的凭据会这样响应。
 *
 * 两种都表现为"客户端拿不到有效回复"，都应交由上层续写恢复。
 * 调用方均以 !detectedToolCalls && !pendingToolFailureText 守卫，
 * 因此工具调用轮不会误触发。
 */
export function isEmptyAssistantReply({ visibleContent = '', reasoningContent = '' } = {}) {
  const hasVisible = String(visibleContent || '').trim().length > 0;
  // 判据只看"有没有给用户可见的正文"：无论是"只有思考"还是"完全空流"，
  // 客户端都拿不到有效回复，都需要恢复。思考内容存在与否不影响判定。
  return !hasVisible;
}

/**
 * 构造"只思考未作答"的续写提示。
 *
 * 关键约束：必须明确禁止再思考并直接要正文。若措辞含糊，模型会重复
 * 思考一遍仍不输出正文，白白消耗一次上游调用。
 */
export function getReasoningOnlyRetryPrompt(userRequest = '', reasoning = '') {
  const request = String(userRequest || '').trim();
  const thought = String(reasoning || '').trim();
  const requestBlock = request ? `\n用户的原始请求：\n\`\`\`\n${request.slice(-1500)}\n\`\`\`\n` : '';
  const thoughtBlock = thought ? `\n你已经完成的思考（仅供你参考，不要再复述）：\n\`\`\`\n${thought.slice(-2000)}\n\`\`\`\n` : '';

  return `你上一次的回复只输出了思考内容，没有输出任何面向用户的正文，因此任务无法完成。
${requestBlock}${thoughtBlock}
现在请直接输出最终回答正文：
- 不要再输出思考过程或 <think> 标签，也不要重复上述思考内容
- 直接给出结论、结果或答复本身
- 保持原有格式要求（列表、表格、章节等）
- 不要输出任何工具调用

请立即输出正文。`;
}

export function classifyToolFailure(content, triggerSignal, parseResult = null) {
  if (parseResult?.failureType) return parseResult.failureType;
  if (findLastTriggerSignalOutsideThink(content, triggerSignal) === -1) return 'no_fc';
  const afterTrigger = content.slice(findLastTriggerSignalOutsideThink(content, triggerSignal) + triggerSignal.length);
  if (/<function_calls\b/i.test(afterTrigger) && !/<\/function_calls\s*>/i.test(afterTrigger)) return 'truncated';
  return 'syntax_error';
}

export function diagnoseToolParseError(content, triggerSignal, parseResult = null) {
  if (parseResult?.errorDetails) return parseResult.errorDetails;
  if (!content || findLastTriggerSignalOutsideThink(content, triggerSignal) === -1) {
    return `Trigger signal '${triggerSignal}' not found outside <think> blocks`;
  }
  const cleaned = content.slice(findLastTriggerSignalOutsideThink(content, triggerSignal));
  const errors = [];
  if (!/<function_calls\b/i.test(cleaned)) errors.push('Missing <function_calls> tag after trigger signal');
  if (!/<\/function_calls\s*>/i.test(cleaned)) errors.push('Missing closing </function_calls> tag');
  if (!/<function_call\b/i.test(cleaned)) errors.push('No <function_call> blocks found inside <function_calls>');
  if (!/<tool\b/i.test(cleaned)) errors.push('Missing <tool> tag inside function_call');
  if (!/<args_json\b/i.test(cleaned)) errors.push('Missing <args_json> tag inside function_call');
  return errors.join('; ') || 'XML structure appears malformed or arguments failed validation';
}

// 格式纠错/意图重试时的 Edit 优先引导：真实场景中模型在编辑工具格式失败后
// 常"降级"改用写入工具整文件重写来绕开精确匹配，这比格式错误更危险。
// 只有编辑类与写入类工具同时存在时才注入，且只引用真实存在的工具名。
function editFirstRetryNote(tools = []) {
  const { editNames, writeNames } = detectFileMutationTools(tools);
  if (!editNames.length || !writeNames.length) return '';
  return `\n\n工具选择提醒：如果这次操作是在修改一个已存在的文件，修正格式后必须继续用 ${editNames.join('/')} 完成同一处精确替换；禁止为了绕开格式错误或精确匹配失败而改用 ${writeNames.join('/')} 整文件重写——那会删除所有未复述进参数的内容。${writeNames.join('/')} 只用于创建新文件，或用户明确要求且你已读过全文的整文件重写。`;
}

export function getToolErrorRetryPrompt(originalResponse, errorDetails, triggerSignal, tools = []) {
  const toolListText = tools.length
    ? `\n可用工具列表：\n${tools.map(t => `- ${t.function?.name || t.name}`).join('\n')}`
    : '';

  return `你上一次尝试调用工具，但格式无效无法解析。

你的原始输出：
\`\`\`
${originalResponse}
\`\`\`

错误详情：
${errorDetails}${toolListText}

请重试，严格按以下 XML 格式输出工具调用：
1. 触发信号独占一行，精确为：${triggerSignal}
2. 紧跟 <function_calls> XML 块
3. <args_json> 内必须是合法的 JSON 对象
4. 参数必须与上方工具列表中声明的 schema 匹配
5. </function_calls> 之后不得有任何文字${editFirstRetryNote(tools)}

现在请输出修正后的工具调用，不要输出任何其他内容。`;
}

function toolNamesText(tools = []) {
  return tools.map(t => t.function?.name || t.name).filter(Boolean).join('\n- ');
}

// 源码/资源文件扩展名：模型常直接点名 Xxx.kt / main.ts
const SOURCE_FILE_EXT =
  /\.(?:[jt]sx?|mjs|cjs|json|ya?ml|toml|md|txt|kt|kts|java|go|rs|py|rb|php|swift|cs|cpp|cc|cxx|h|hpp|vue|svelte|css|scss|less|html?|xml|gradle|properties|ini|env|sh|bash|ps1|bat|cmd|sql|proto|graphql|tf|hcl)\b/i;

// 路径片段：D:\repo\... 或 src/main/java/...
const PATH_LIKE =
  /(?:[A-Za-z]:\\|\\\\|\/)?(?:[\w.-]+[\\/]){1,}[\w.-]+/;

// 类/组件符号：LoginFragment、SettingsScreen、MainActivity
const CODE_SYMBOL =
  /\b[A-Z][A-Za-z0-9]*(?:Screen|Activity|Fragment|View|ViewModel|Controller|Service|Repository|Adapter|Helper|Utils|Manager|Provider|Factory|Module|Component|Page|Dialog|Sheet|Composable|Router|Handler|Interceptor|Config|Theme|Type|Style)\b/;

function toolNameSet(tools = []) {
  return new Set((tools || []).map(t => String(t.function?.name || t.name || '').toLowerCase()));
}

function hasAnyTool(toolNames, needles) {
  return needles.some(name => [...toolNames].some(tool => tool === name || tool.includes(name)));
}

export function isMissingToolCallIntent(content, tools = []) {
  const text = String(content || '').trim();
  if (!text) return false;
  if (/<function_calls\b|<function_call\b/i.test(text)) return false;
  const lower = text.toLowerCase();
  const toolNames = toolNameSet(tools);

  const hasCodingTools = hasAnyTool(toolNames, [
    'read', 'glob', 'grep', 'bash', 'edit', 'write', 'ls', 'list', 'shell',
    'applypatch', 'apply_patch', 'notebookedit', 'multiedit', 'search',
  ]);
  const hasInteractiveTools = hasAnyTool(toolNames, [
    'askuserquestion', 'ask_user', 'askuser', 'askq', 'question',
  ]);
  if (!hasCodingTools && !hasInteractiveTools) return false;

  // 目标对象：抽象词 + 扩展名 + 路径 + 代码符号
  const hasCodingTarget = /(项目|代码|文件|目录|结构|文档|README|package|测试|命令|日志|配置|技术栈|模块|架构|内容|页面|设置|界面|布局|样式|功能|逻辑|实现|源码|源代码|工程|仓库|组件|类|函数|方法|脚本|配置文件|源文件|设计系统|主题|主题色|排版|间距|视觉)/i.test(text)
    || SOURCE_FILE_EXT.test(text)
    || /[A-Za-z][\w.-]*\.(?:[jt]sx?|kt|kts|java|go|rs|py|json|md|xml|gradle)\b/.test(text)
    || PATH_LIKE.test(text)
    || CODE_SYMBOL.test(text);

  // 动作主体：覆盖“我们来/我会先/先并行读取/定位到”等
  const chineseIntent = /(我|先|现在|接下来|马上|准备|开始|需要|将|会|为你|我们来|我们先|我先|我会先|我现在|我准备|并行|去).{0,48}(读取|查看|搜索|检索|检查|打开|列出|扫描|运行|执行|修改|编辑|写入|创建|探索|分析|梳理|了解|浏览|定位|遍历|获取|查找|找出|看看|查询|查查|调查|抓取|提取|调取|拉取|取得|取出|翻看|翻阅|定位到|导航到|进入|实施)/i.test(text)
    && hasCodingTarget;

  // 结构性兜底："我们先X，以便Y" / "我来X来帮你Y" / "我会先X，以确保Y"
  const structuralIntent = /(我们先|我们来|我来|我先|我会先|我准备|我现在|接下来).{2,80}(以便|为了|从而|来帮你|来给|来为|来快速|来高效|来准确|来系统|来完整|来深入|来全面|以确保|好确保|保证|方便|用于|与现有|以便进行|再开始|再继续|再改)/i.test(text)
    && hasCodingTarget;

  // "先定位到 XxxFragment 再继续" —— 动词与目标粘在一起、主语可省略
  const locateSymbolIntent = /(先|接下来|现在|马上)?(定位到|导航到|打开|检查|查看|读取)\s*[A-Z][A-Za-z0-9_]*(?:Screen|Activity|Fragment|View|ViewModel|Controller|Service|Repository|Adapter|Page|Dialog|Component|Module)?/i.test(text);

  const englishIntent = /\b(i|i'll|i will|let me|first|now|next|we will|we'll)\b.{0,80}\b(read|inspect|check|search|grep|list|scan|open|run|execute|edit|modify|write|create|explore|analyze|examine|browse|review|fetch|retrieve|find|look up|locate|navigate|grab|pull)\b/i.test(lower)
    && (/\b(project|code|file|directory|repo|repository|readme|package|test|command|log|config|structure|module|architecture|content|page|setting|layout|style|function|logic|implementation|source|component|class)\b/i.test(lower)
      || SOURCE_FILE_EXT.test(text)
      || PATH_LIKE.test(text)
      || CODE_SYMBOL.test(text));

  const englishStructural = /\b(i'll|i will|let me|first let me|now let me|we'll|we will)\b.{5,80}\b(to|and then|in order to|so (?:that|i|we)|to ensure|to keep)\b/i.test(lower)
    && (/\b(file|code|project|repo|directory|content|page|component)\b/i.test(lower)
      || SOURCE_FILE_EXT.test(text)
      || PATH_LIKE.test(text)
      || CODE_SYMBOL.test(text));

  // 交互工具意图：确认/选择/提问但未输出工具 XML
  const interactiveIntent = hasInteractiveTools && (
    /(我|先|现在|接下来|准备|需要|想|会).{0,24}(确认|询问|提问|问一下|征求|选择|让你选|请你选|请确认|请选择)/i.test(text)
    || /(是否允许|是否同意|要不要|可不可以|哪个方案|哪种方案)/i.test(text)
  );

  if (!hasCodingTools) return interactiveIntent;
  return chineseIntent || structuralIntent || locateSymbolIntent || englishIntent || englishStructural || interactiveIntent;
}

export function getMissingToolCallRetryPrompt(originalResponse, triggerSignal, tools = []) {
  const names = toolNamesText(tools);
  const toolListText = names ? `\n可用工具列表：\n- ${names}` : '';
  return `你上一次的回复表示要执行工具操作，但没有输出任何可执行的工具调用结构。

你的原始输出：
\`\`\`
${originalResponse}
\`\`\`
${toolListText}

如果你确实需要读取/搜索/运行/修改项目内容，或需要向用户提问确认，请立即重试，只输出工具调用 XML：
1. 触发信号独占一行，精确为：${triggerSignal}
2. 紧跟 <function_calls> XML 块
3. <args_json> 内必须是合法 JSON 对象，并用 <![CDATA[...]]> 包裹
4. 参数必须与工具 schema 匹配
5. </function_calls> 之后不得有任何文字${editFirstRetryNote(tools)}

不要再输出计划、说明或道歉；现在只输出要执行的工具调用。`;
}

export function getToolContinuationPrompt(truncatedContent, errorDetails, tools = []) {
  const tail = String(truncatedContent || '').slice(-1500);
  return `你上一次的输出在工具调用 XML 完成前被截断了。

被截断的输出：
\`\`\`
${tail}
\`\`\`

发生了什么：
${errorDetails}

你有两种选择：

选项 A（推荐 — 续写）：
仅输出从截断点开始的精确续写内容。规则：
- 从截断点的下一个字符精确开始——不要重复任何已输出的文字。
- 如果截断发生在词中间，从该词的下一个字符开始。
- 不要再次输出触发信号或任何已经存在的开标签。
- 以正确的闭合标签（</function_call>、</function_calls>）结束。
- 不要添加任何前后解释文字。

选项 B（仅当你认为之前的输出有错误时）：
从头开始，输出完整的函数调用。先输出触发信号独占一行，然后完整输出 function_calls 块。

请选择选项 A，除非你确信之前的输出包含需要纠正的错误。`;
}

export function isContinuationResponse(retryContent, triggerSignal) {
  const cleaned = String(retryContent || '').trimStart();
  if (!cleaned) return true;
  if (triggerSignal && cleaned.includes(triggerSignal)) return false;
  if (cleaned.startsWith('<function_calls')) return false;
  return true;
}

export function mergeTruncatedAndContinuation(truncated, continuation) {
  return String(truncated || '') + String(continuation || '');
}

export async function attemptToolParseWithRetry({
  content,
  messages = [],
  promptPlan,
  retryToolRequest,
  signal,
  retryEnabled = isFcErrorRetryEnabled(),
  maxAttempts = RETRY_LOOP_GUARD,
} = {}) {
  if (!promptPlan?.toolCallingEnabled || promptPlan.promptInjectionDisabled) {
    return { toolCalls: null, content: null, failureType: 'disabled', attempts: 1, originalContent: content };
  }

  const safeMaxAttempts = Math.max(1, Number.parseInt(maxAttempts, 10) || RETRY_LOOP_GUARD);
  let currentContent = String(content || '');
  let lastResult = null;

  for (let attempt = 0; attempt < safeMaxAttempts; attempt++) {
    lastResult = promptPlan.parseToolCallsDetailed
      ? promptPlan.parseToolCallsDetailed(currentContent)
      : (promptPlan.parseToolCalls(currentContent) || { toolCalls: null });

    if (lastResult?.toolCalls?.length) {
      return { ...lastResult, attempts: attempt + 1, originalContent: content, finalContent: currentContent };
    }

    const failureType = classifyToolFailure(currentContent, promptPlan.triggerSignal, lastResult);
    if (failureType === 'no_fc') {
      return { toolCalls: null, content: lastResult?.content ?? (currentContent || null), failureType, attempts: attempt + 1, originalContent: content, finalContent: currentContent };
    }

    if (!retryEnabled || !retryToolRequest || attempt >= safeMaxAttempts - 1) {
      return {
        toolCalls: null,
        content: lastResult?.content ?? null,
        failureType,
        errorDetails: diagnoseToolParseError(currentContent, promptPlan.triggerSignal, lastResult),
        attempts: attempt + 1,
        originalContent: content,
        finalContent: currentContent,
      };
    }

    const errorDetails = diagnoseToolParseError(currentContent, promptPlan.triggerSignal, lastResult);
    const retryPrompt = failureType === 'truncated'
      ? getToolContinuationPrompt(currentContent, errorDetails, promptPlan.tools)
      : getToolErrorRetryPrompt(currentContent, errorDetails, promptPlan.triggerSignal, promptPlan.tools);

    const retryContent = await retryToolRequest({
      retryPrompt,
      currentContent,
      messages,
      signal,
      failureType,
      errorDetails,
      attempt: attempt + 1,
    });

    if (failureType === 'truncated' && isContinuationResponse(retryContent, promptPlan.triggerSignal)) {
      currentContent = mergeTruncatedAndContinuation(currentContent, retryContent);
    } else {
      currentContent = String(retryContent || '');
    }
  }

  return {
    toolCalls: null,
    content: lastResult?.content ?? null,
    failureType: lastResult?.failureType || 'syntax_error',
    errorDetails: diagnoseToolParseError(currentContent, promptPlan.triggerSignal, lastResult),
    attempts: safeMaxAttempts,
    originalContent: content,
    finalContent: currentContent,
  };
}
