import { detectFileMutationTools, findLastTriggerSignalOutsideThink } from './prompt-strategy.js';
import { getConfig } from '../services/config-store.js';

export function isFcErrorRetryEnabled() {
  return getConfig().runtime.enableFcErrorRetry;
}

// 纠错重试上限。
//
// 从 25 降到 2 的依据（2026-10 实测）：
//   1. 每次重试都带完整工具说明。188 工具时单次提示词约 245K 字符，
//      25 次就是数百万字符的上游调用，用户侧表现为"转很久最后什么也没有"。
//   2. 真实会话日志里，模型格式错误几乎都在第 1 次纠错内解决；
//      需要第 3 次以上的情况没有观察到。
//   3. 与其无限重试，不如快速失败让客户端提示重试——后者成本可控且用户可感知。
export const MAX_TOOL_RETRIES = 2;

// 兼容旧引用：仍有调用方按这个名字取默认值。
const RETRY_LOOP_GUARD = MAX_TOOL_RETRIES;

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

/**
 * 从诊断信息里提取失败调用涉及的工具。
 *
 * schema_error 的 errorDetails 形如：
 *   Tool call #1 'create_issue': schema validation failed: missing required property 'project_id'
 * 只带名字不够——模型必须看到参数结构才知道怎么改。
 */
function toolsMentionedIn(errorDetails, tools = []) {
  const text = String(errorDetails || '');
  return tools.filter((tool) => {
    const name = String(tool.function?.name || tool.name || '');
    return name && text.includes(`'${name}'`);
  });
}

/**
 * 渲染若干工具的参数 schema（只给这几个，不是全部）。
 *
 * 为什么必须给：重试提示词第 4 条要求「参数必须与工具列表里声明的 schema
 * 匹配」，但此前的实现只列工具名。对 schema_error 来说，模型看不到字段名
 * 与类型只能盲猜，两次重试必然再次失败——2026-10-30 DSH 日志正是此形态。
 */
function renderToolSchemas(tools = []) {
  return tools.map((tool) => {
    const fn = tool.function || tool;
    let params = '{}';
    try { params = JSON.stringify(fn.parameters ?? {}); } catch { /* 循环引用等异常降级为空 */ }
    return `- ${fn.name}: ${params}`;
  }).join('\n');
}

export function getToolErrorRetryPrompt(originalResponse, errorDetails, triggerSignal, tools = []) {
  // schema_error 时附上出错工具的完整参数定义；纯格式错误不需要。
  const mentioned = toolsMentionedIn(errorDetails, tools);
  const schemaText = mentioned.length
    ? `\n\n出错工具的参数定义（必须严格按此传参）：\n${renderToolSchemas(mentioned)}`
    : '';

  const toolListText = tools.length
    ? `\n可用工具列表：\n${tools.map(t => `- ${t.function?.name || t.name}`).join('\n')}`
    : '';

  return `你上一次尝试调用工具，但格式无效无法解析。

你的原始输出：
\`\`\`
${originalResponse}
\`\`\`

错误详情：
${errorDetails}${schemaText}${toolListText}

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
  // 目标对象词表：除代码/文件类名词外，还要覆盖"数据类"对象。
  //
  // 真实故障（2026-10-30）：模型说「我把完整结果落盘读出来，筛出未完成的
  // 在办任务」——「结果」「任务」「列表」都是要操作的目标，但原词表只收
  // 代码/文件类名词，短句因此判定 false。
  const hasCodingTarget = /(项目|代码|文件|目录|结构|文档|README|package|测试|命令|日志|配置|技术栈|模块|架构|内容|页面|设置|界面|布局|样式|功能|逻辑|实现|源码|源代码|工程|仓库|组件|类|函数|方法|脚本|配置文件|源文件|设计系统|主题|主题色|排版|间距|视觉|结果|数据|列表|任务|记录|条目|返回值|响应)/i.test(text)
    || SOURCE_FILE_EXT.test(text)
    || /[A-Za-z][\w.-]*\.(?:[jt]sx?|kt|kts|java|go|rs|py|json|md|xml|gradle)\b/.test(text)
    || PATH_LIKE.test(text)
    || CODE_SYMBOL.test(text);

  // 动作主体：覆盖“我们来/我会先/先并行读取/定位到”等
  // 意图动词表。
  //
  // 必须覆盖真实口语表述，不能只收书面动词（读取/查看/打开）。
  // 真实故障（2026-10-30 DSH 日志）：模型写「我把完整结果落盘读出来，
  // 筛出未完成的在办任务」后直接 stop——「读出来」「筛出」「落盘」都不在
  // 词表里，isMissingToolCallIntent 判定 false，no_fc 直接返回不重试，
  // 任务终结。
  const chineseIntent = /(我|先|现在|接下来|马上|准备|开始|需要|将|会|为你|我们来|我们先|我先|我会先|我现在|我准备|并行|去).{0,48}(读取|读出来|读一下|读一遍|读出|查看|看下|看一下|看看|搜索|检索|检查|打开|列出|列出来|列一下|扫描|运行|执行|修改|编辑|写入|创建|探索|分析|梳理|了解|浏览|定位|遍历|获取|查找|找出|筛出|筛选|筛一下|筛一遍|过滤|过滤出|统计|统计出|汇总|汇总出|整理|整理出|解析|解析出|查询|查查|调查|抓取|提取|调取|拉取|取得|取出|翻看|翻阅|定位到|导航到|进入|实施|落盘|读回)/i.test(text)
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

/**
 * 判定这次截断是不是「往工具参数里塞大段文件内容」造成的。
 *
 * 为什么单独识别：这类截断的重试策略与普通格式错误完全不同。
 *
 * 真实故障（2026-10-30 DSH 日志）：用户要一个完整 HTML 插画，模型把整个
 * 20,866 字符的 SVG 写进 write 工具的 content 参数，写到
 * `opacity="0` 被硬截断——触发信号和 <tool> 都在更靠前的位置，是完整的
 * 工具调用，只是参数写不完。
 *
 * 这种场景下「从截断点精确续写」的要求无法完成：模型必须精确接上
 * `opacity="0` 这种位置继续写几千行 SVG，实测续写返回的是一段无关文本
 * （日志里尾部出现游离的 "INCOMPLETE"），两次重试全部失败。
 *
 * 判据（三条同时满足）：
 *   1. 存在路径类工具集（write 或 edit），否则不是文件写入场景
 *   2. 截断内容足够长——短输出被截断通常是格式问题，不是体量问题
 *   3. 截断点位于 JSON 字符串内部——即正在写某个参数的值，而不是标签之间
 *
 * 第 3 条用「最后一个未闭合的引号」判断：截断内容里转义引号数为奇数，
 * 说明停在一个字符串参数内部。
 */
export function isLargeFileWriteTruncation(truncatedContent, tools = []) {
  const text = String(truncatedContent || '');
  if (!text) return false;

  const { editNames, writeNames } = detectFileMutationTools(tools);
  if (!editNames.length && !writeNames.length) return false;

  // 阈值取 8000 字符：普通工具调用参数极少到这个量级，而模型写整页
  // HTML/SVG 时会轻松越过。低于此值的截断更可能是结构问题。
  if (text.length < 8000) return false;

  // 数转义引号（\"）与裸引号，判断是否停在字符串中间。
  // 只数最外层的 "：在 JSON 里它们成对出现，奇数说明未闭合。
  let quotes = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') quotes++;
  }
  return quotes % 2 === 1;
}

export function getToolContinuationPrompt(truncatedContent, errorDetails, tools = []) {
  const tail = String(truncatedContent || '').slice(-1500);

  // 大文件写入场景走完全不同的策略：不是"精确续写"，而是"分段写"。
  //
  // 原因见 isLargeFileWriteTruncation 的注释：要求模型从 `opacity="0`
  // 这种位置精确续写整页 SVG，实测两次重试全部失败，续写回来的是一段
  // 与上下文无关的文本。真正可行的是让它改变写入方式本身。
  if (isLargeFileWriteTruncation(truncatedContent, tools)) {
    const { editNames, writeNames } = detectFileMutationTools(tools);
    // 不替模型挑"第一个"写入工具。
    //
    // 2026-10-30 实测：188 工具集下 writeNames[0] 是
    // mcp__gitlab-mcp__create_or_update_file（gitlab 的远程建文件），
    // 模型照抄后去创建**远端仓库文件**，而不是写本地工作区。真正的 write
    // 排在数组第二位。
    //
    // 正确做法是把候选按"本地文件优先"排序后全部列出，由模型按语义选：
    // 它知道用户说的是本地文件，不该由我们猜。
    const localFirst = (names) => [...names].sort((a, b) => {
      const isMcp = n => /^mcp__/i.test(n) || /^[a-z0-9]+_mcp_/i.test(n);
      if (isMcp(a) && !isMcp(b)) return 1;
      if (!isMcp(a) && isMcp(b)) return -1;
      return a.length - b.length;  // 短名通常是原生工具（write/edit），长名多为 MCP
    });
    const writeCandidates = localFirst(writeNames);
    const editCandidates = localFirst(editNames);
    const writeTool = writeCandidates[0] || 'write';
    const editTool = editCandidates[0] || 'edit';
    const writeList = writeCandidates.length ? writeCandidates.join(' / ') : writeTool;
    const editList = editCandidates.length ? editCandidates.join(' / ') : editTool;
    // 触发信号从调用方传入的协议里取。这里没有 triggerSignal 参数，
    // 从截断内容开头提取——重试提示若不重申信号与标签名，模型会退回
    // 它自己熟悉的 <invoke>/<parameter> 格式（2026-10-30 实测：整段返回
    // Anthropic 风格 invoke 块，解析器完全不认，等于白重试一次）。
    const signal = (String(truncatedContent || '').match(/^\s*(<[A-Za-z_][\w]*_Start\/>)/) || [])[1] || '';
    const signalLine = signal
      ? `1. 触发信号独占一行，精确为：${signal}`
      : '1. 触发信号独占一行';
    return `你上一次的工具调用因为**参数内容太长**被截断了——不是格式问题，是把整份文件内容塞进一次调用装不下。

被截断的位置（尾部）：
\`\`\`
${tail}
\`\`\`

不要试图从这里精确续写——你无法可靠地接上被切断的字符，上一次重试就是这样失败的。

改用**分段写入**，分多次调用完成同一个文件：

第 1 步：只写文件的开头部分（例如前 200 行），内容必须在这一步就完整闭合、可正常打开。
第 2 步起：在该文件里定位一个**唯一且已存在的锚点**（如上一段结尾的标签），把新一段内容替换进去，保持文件始终完整。
重复第 2 步，直到整个文件写完。

写文件可用的工具（从下列中选择**本地工作区**的那个，不要选 gitlab 等远程仓库类工具）：
- 创建文件：${writeList}
- 追改文件：${editList}

关键要求：
- **每一次调用的参数必须控制在 4000 字符以内**。上限就是上一次失败的原因，宁可分 10 次也不要写满一次
- 每一步写进去的片段都必须是**完整可用的代码**，不要留下半截标签
- 不要重复已经写进文件的段落

输出格式（必须严格遵守，不要用 <invoke>/<parameter> 等其它格式）：
${signalLine}
2. 紧跟 <function_calls> 块，内含一个 <function_call>
3. <function_call> 里依次是 <tool>工具名</tool> 与 <args_json><![CDATA[...]]></args_json>
4. </function_calls> 之后不得有任何文字

示例（第 1 步，注意参数体量）：
${signal}
<function_calls>
  <function_call>
    <tool>写文件用的工具名</tool>
    <args_json><![CDATA[{"file_path":"目标文件路径","content":"文件开头部分"}]></args_json>
  </function_call>
</function_calls>

现在只输出第 1 步的工具调用，内容控制在 4000 字符以内，不要解释。`;
  }

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
  // 重试模式的粘滞状态：一旦因"只写计划句"进入 missing_tool_call，
  // 后续轮次沿用同一模式，避免失败类型在两次判定间漂移。
  let retryMode = null;

  for (let attempt = 0; attempt < safeMaxAttempts; attempt++) {
    lastResult = promptPlan.parseToolCallsDetailed
      ? promptPlan.parseToolCallsDetailed(currentContent)
      : (promptPlan.parseToolCalls(currentContent) || { toolCalls: null });

    if (lastResult?.toolCalls?.length) {
      return { ...lastResult, attempts: attempt + 1, originalContent: content, finalContent: currentContent };
    }

    let failureType = classifyToolFailure(currentContent, promptPlan.triggerSignal, lastResult);

    // no_fc 不等于"放弃"。
    //
    // 真实故障（2026-10-29 DSH 日志）：模型输出「我来生成一个…先创建文件，
    // 再把完整实现写进去」，随后直接 stop——完全没有触发信号与 XML。
    // 首次判定为 no_fc 时旧实现立即返回，runner 便抛出 TOOL_FORMAT_FAILED。
    //
    // 但这类"只写计划句"恰恰是最容易救回的：只要明确要求它当场输出调用即可。
    // isMissingToolCallIntent 已存在且在此场景返回 true，只是从未在流内
    // 路径被调用过（只在流结束后的 late recovery 分支用）。
    //
    // 因此这里把它提升为可重试的 failureType，走 missing_tool_call 提示词。
    //
    // 已经进入 missing_tool_call 重试后，失败类型必须保持粘滞：重试回来的
    // 内容可能仍是纯文本（模型再次拒绝调用），此时 isMissingToolCallIntent
    // 未必再为 true，若重新判定就会退回 no_fc，让上层收到与首次不一致的
    // failureType——排查时会被误导成"第一次是格式问题、第二次不是"。
    if (failureType === 'no_fc' && (retryMode === 'missing_tool_call' || isMissingToolCallIntent(currentContent, promptPlan.tools))) {
      failureType = 'missing_tool_call';
      retryMode = 'missing_tool_call';
    } else if (failureType === 'no_fc') {
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
    // 按失败类型选提示词：truncated 要续写，missing_tool_call 要"把计划变成
    // 调用"，其余才是"修正格式"。混用会让重试无效——用"修正格式"去纠正一个
    // 根本没有格式的回复，模型只会再输出一次计划（实测两次重试均失败）。
    let retryPrompt;
    if (failureType === 'truncated') {
      retryPrompt = getToolContinuationPrompt(currentContent, errorDetails, promptPlan.tools);
    } else if (failureType === 'missing_tool_call') {
      retryPrompt = getMissingToolCallRetryPrompt(currentContent, promptPlan.triggerSignal, promptPlan.tools);
    } else {
      retryPrompt = getToolErrorRetryPrompt(currentContent, errorDetails, promptPlan.triggerSignal, promptPlan.tools);
    }

    // 大文件写入截断走"重新分段写入"，回来的是一条**完整的新调用**
    // （不是续写片段）。若按续写逻辑把它拼到截断内容后面，会得到
    // 「半个巨型参数 + 一个完整调用」的混合体，必然再次解析失败。
    const largeFileMode = failureType === 'truncated'
      && isLargeFileWriteTruncation(currentContent, promptPlan.tools);

    const retryContent = await retryToolRequest({
      retryPrompt,
      currentContent,
      messages,
      signal,
      failureType,
      errorDetails,
      attempt: attempt + 1,
    });

    if (largeFileMode) {
      // 整段替换：丢弃写不完的原文，只保留模型这次重新给出的分段调用。
      currentContent = String(retryContent || '');
    } else if (failureType === 'truncated' && isContinuationResponse(retryContent, promptPlan.triggerSignal)) {
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
