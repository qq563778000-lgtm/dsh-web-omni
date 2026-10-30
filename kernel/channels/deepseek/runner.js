import { getConfig } from '../../services/config-store.js';
import { completion, parseSSEStream } from '../../utils/sse.js';
import { resolveUploadableToRefId } from '../../services/upload.js';
import { enqueueRequest, dispatchQueued } from '../../services/queue.js';
import { getConversationBinding, getRecentToolCallIndex, getResponseToolCallIndex, invalidateConversation, resolveConversation, recordResponseMessageId } from '../../services/conversation.js';
import {
  buildLatestPrompt,
  buildPromptFromMessages,
  latestDeltaStartIndex,
} from '../../utils/response-utils.js';
import { createPromptPlan } from '../../core/prompt-strategy.js';
import {
  attemptToolParseWithRetry,
  getMissingToolCallRetryPrompt,
  getReasoningOnlyRetryPrompt,
  isEmptyAssistantReply,
  isLargeFileWriteTruncation,
  isMissingToolCallIntent,
} from '../../core/tool-retry.js';
import { preprocessMessagesForToolify, estimateContextChars, compactToolResults } from '../../core/toolify-format.js';
import { collectParsedStreamContent } from '../common-internal-runner.js';
import { collectUploadableParts, hasUploadableParts } from '../../utils/message-files.js';
import { mapModel } from './models.js';
import {
  CREDENTIAL_DISABLE_DEFAULT_MS,
  disableToken,
  getIpThrottleRemainingMs,
  isIpThrottled,
  noteEmptyReply,
  noteSuccessfulReply,
  reportTokenError,
  reportTokenRateLimited,
} from '../../services/auth.js';
import { recordUsage } from '../../middleware/metrics.js';
import { recordToolFailure, recordRequestPlan } from '../../middleware/logger.js';
import { InternalAPIError } from '../../core/errors.js';
import {
  createMessageDone,
  createMessageStarted,
  createReasoningDelta,
  createReasoningDone,
  createRunCompleted,
  createRunStarted,
  createTextDelta,
  createTextDone,
  createToolCallArgumentsDelta,
  createToolCallDone,
  createToolCallStarted,
  createUsageUpdated,
} from '../../core/internal-events.js';
import {
  createInternalId,
  internalMessagesToOpenAI,
  internalToolChoiceToOpenAI,
  internalToolsToOpenAI,
} from '../../core/internal-request.js';

/**
 * 上下文压缩阈值（字符）。
 *
 * 实测依据（2026-10-30 DSH 同一会话）：上行约 187K 字符时成功，
 * 228K 字符时上游返回完全空流。取 150K 留出余量——工具结果本身有波动，
 * 贴着边界跑迟早再撞。
 */
const CONTEXT_COMPACT_THRESHOLD_CHARS = 150000;

async function extractUploads(messages, token) {
  const refFileIds = [];
  for (const file of collectUploadableParts(messages)) {
    try {
      const fileId = await resolveUploadableToRefId(file, token);
      refFileIds.push(fileId);
    } catch (err) {
      console.error('File upload failed:', err.message);
    }
  }
  return refFileIds;
}

/**
 * 重试轮使用的轻量格式提示。
 *
 * 为什么不重发完整工具说明：首轮那 245K 字符仍在同一会话上下文里，
 * 重复发送只会放大成本。这里只重申"唯一合法格式"，让模型把注意力
 * 放回结构上——真实故障正是结构写坏了，不是不知道该用哪个工具。
 *
 * @param {string|null} triggerSignal 首轮使用的触发信号
 */
function buildRetryFormatHint(triggerSignal) {
  const signal = triggerSignal || '<Function_Start/>';
  return `

## 重试：请严格按以下格式重新输出

上一次的工具调用格式无法解析。工具清单见上文，无需重复确认；请只修正结构：

\`\`\`
${signal}
<function_calls>
  <function_call>
    <tool>工具名</tool>
    <args_json><![CDATA[{"参数":"值"}]]></args_json>
  </function_call>
</function_calls>
\`\`\`

要点：
- 触发信号独占一行、只出现一次
- \`<args_json>\` 内必须是完整 JSON 对象，以 \`{\` 开头、\`}\` 结尾
- CDATA 结束必须是两个右方括号 \`]]>\`
- \`</function_calls>\` 后不得有任何文字

请直接输出修正后的调用，不要再解释。`;
}

function promptWithToolInstructions(messages, toolInstructions) {
  return (buildPromptFromMessages(messages).trim() + (toolInstructions || '')).trim();
}

function latestPromptWithToolInstructions(messages, toolInstructions) {
  return (buildLatestPrompt(messages).trim() + (toolInstructions || '')).trim();
}

function openAIMessagesFromInternal(internalRequest) {
  const messages = [];
  if (internalRequest.instructions?.system) {
    messages.push({ role: 'system', content: internalRequest.instructions.system });
  }
  if (internalRequest.instructions?.developer) {
    messages.push({ role: 'system', content: internalRequest.instructions.developer });
  }
  messages.push(...internalMessagesToOpenAI(internalRequest.messages));
  return messages;
}

function getRequestLike(internalRequest, context) {
  return context?.req || {
    body: internalRequest.raw?.body || {},
    headers: internalRequest.metadata?.headers || {},
    omni: {
      promptInjectionEnabled: internalRequest.metadata?.promptInjectionEnabled,
      rawRequestJsonText: internalRequest.raw?.rawJsonText,
    },
  };
}

function usageOutputTokens(usage) {
  if (typeof usage === 'number') return usage;
  return usage?.output_tokens ?? usage?.completion_tokens ?? usage?.total_tokens ?? 0;
}

function emitToolCallEvents({ requestId, responseId, messageId, toolCalls }) {
  const events = [];
  for (let index = 0; index < toolCalls.length; index++) {
    const call = toolCalls[index];
    const id = call.id || createInternalId('call');
    const name = call.function?.name || call.name;
    const args = call.function?.arguments ?? call.arguments ?? '{}';
    events.push(createToolCallStarted({ requestId, responseId, messageId, toolCallId: id, index, name }));
    if (args) events.push(createToolCallArgumentsDelta({ requestId, responseId, messageId, toolCallId: id, index, delta: args }));
    events.push(createToolCallDone({ requestId, responseId, messageId, toolCallId: id, index, name, arguments: args || '{}' }));
  }
  return events;
}

function prefixBeforeBufferedToolText(processed) {
  const delta = processed?.delta || '';
  const buffered = processed?.bufferedToolText || '';
  if (!delta || !buffered) return delta;
  return delta.endsWith(buffered) ? delta.slice(0, delta.length - buffered.length) : delta;
}

export async function* runDeepSeek(internalRequest, context = {}) {
  const req = getRequestLike(internalRequest, context);
  const requestedModel = internalRequest.model?.normalized || internalRequest.model?.requested;
  const modelType = mapModel(requestedModel);
  const requestId = internalRequest.id;
  const responseId = context.responseId || createInternalId('resp');
  const messageId = createInternalId('msg');

  // IP 级限流冷却期：快速失败并明确报 429，不再打上游。
  // 实测该限制与账号/凭据无关（3 个不同账号同时受限、14 分钟未恢复），
  // 继续请求只会加重限流；明确报错让客户端自行退避。
  if (isIpThrottled()) {
    const remainingSec = Math.ceil(getIpThrottleRemainingMs() / 1000);
    throw new InternalAPIError(
      `上游对当前出口 IP 限流（消息发送过于频繁），约 ${remainingSec} 秒后解除。`
      + `该限制与账号凭据无关，更换凭据无效；如需立即恢复请更换出口 IP（配置 HTTPS_PROXY）。`,
      { status: 429, type: 'rate_limit_error', code: 'ip_rate_limited', retryable: true },
    );
  }

  const rawOpenAIMessages = openAIMessagesFromInternal(internalRequest);
  // 长上下文自动压缩历史工具结果。
  //
  // 实测上限（2026-10-30 DSH）：同一会话 turn 1 上行约 187K 字符时成功，
  // turn 2 涨到 228K 后上游返回**完全空流**——超过上限不是报错，是静默
  // 返回空，最难排查的一种。
  //
  // 压缩在绑定会话之前做，让前缀哈希基于压缩后的内容计算；压缩后还要
  // 强制换新会话（见下面的 compactedForcesFresh），否则上游会话仍持有
  // 未压缩的大历史，压缩白做。
  const contextCharsBefore = estimateContextChars(rawOpenAIMessages);
  const openAIMessages = compactToolResults(rawOpenAIMessages, {
    maxChars: CONTEXT_COMPACT_THRESHOLD_CHARS,
    keepRecent: 2,
  });
  const compacted = openAIMessages !== rawOpenAIMessages;
  const contextChars = estimateContextChars(openAIMessages);
  if (compacted) {
    console.log(
      `[DeepSeek] 上下文 ${contextCharsBefore} → ${contextChars} 字符（已压缩旧的工具结果），`
      + '本次将使用新会话以避免上游继续持有未压缩的历史',
    );
  }
  const promptPlan = createPromptPlan({
    req,
    tools: internalToolsToOpenAI(internalRequest.tools),
    toolChoice: internalToolChoiceToOpenAI(internalRequest.toolChoice),
  });
  const {
    promptInjectionDisabled,
    disabledPrompt,
    toolCallingEnabled,
    toolInstructions,
    triggerSignal,
  } = promptPlan;
  const toolResultIds = openAIMessages
    .filter(message => message?.role === 'tool')
    .map(message => message.tool_call_id || message.toolCallId)
    .filter(Boolean);
  const previousToolCalls = new Map([
    ...getResponseToolCallIndex(internalRequest.conversation?.previousResponseId),
    ...getRecentToolCallIndex(toolResultIds),
  ]);
  const promptMessages = promptInjectionDisabled
    ? openAIMessages
    : preprocessMessagesForToolify(openAIMessages, triggerSignal, previousToolCalls);

  // 最后一条 user 文本：用于"只思考未作答"恢复时向模型重述原始请求。
  const lastUserText = (() => {
    for (let i = openAIMessages.length - 1; i >= 0; i--) {
      const message = openAIMessages[i];
      if (message?.role !== 'user') continue;
      const content = message.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n');
      }
    }
    return '';
  })();

  const fullPrompt = promptInjectionDisabled
    ? disabledPrompt
    : promptWithToolInstructions(promptMessages, toolInstructions);

  const binding = getConversationBinding(req, openAIMessages);
  const explicitConversationId = internalRequest.conversation?.id
    || (getConfig().runtime.enableConversationAffinity ? internalRequest.conversation?.previousResponseId : null);
  const conversationId = explicitConversationId || binding.conversationId;

  // 压缩过历史时必须换新会话。
  //
  // 上游会话持有的是**未压缩**的旧历史。若继续续传，压缩只改了本次发送的
  // 增量内容，上游上下文里那段巨大的旧工具结果依然在——总量仍然超限，
  // 压缩等于没做。清掉会话绑定后 resolveConversation 会判为 fresh，
  // 新建会话并要求全量播种（promptMode='full'），压缩后的内容才会真正
  // 成为上游的新上下文。
  //
  // 代价：新会话没有历史，本次必须全量发送。但这正是压缩生效的必要条件；
  // 不压缩则整轮失败，代价更大。
  if (compacted && conversationId) {
    invalidateConversation(conversationId);
  }

  // 显式指定会话 ID 时增量范围未知，退回启发式截取（最后一条 assistant 之后）。
  // 压缩场景同理：换了新会话就没有可续传的历史，必须全量。
  const matchedPrefixLength = (explicitConversationId || compacted) ? -1 : binding.matchedPrefixLength;

  // preprocessMessagesForToolify 逐条 1:1 映射，openAIMessages 的前缀匹配
  // 下标可以直接用于 promptMessages。
  const deltaStart = promptInjectionDisabled ? null : latestDeltaStartIndex(promptMessages, matchedPrefixLength);
  const latestPrompt = promptInjectionDisabled
    ? fullPrompt
    : deltaStart != null
      ? promptWithToolInstructions(promptMessages.slice(deltaStart), toolInstructions)
      : latestPromptWithToolInstructions(promptMessages, toolInstructions);

  // 续传轮（上游会话已持有前文）的 prompt。
  //
  // 与 latestPrompt 的唯一差别：**不附工具说明**。
  //
  // 为什么必须区分：播种轮已经把工具说明发过一遍，它作为普通文本存在于
  // 上游会话历史里。续传轮若再拼一次，同一份 19K 说明会在会话中出现 N 次
  // ——模型会以"最新贴的这份"为基准，而不是会话里累积的上下文，且每次
  // 白白多付 19K 字符的输入成本。这正是 affinity 要解决的问题本身。
  //
  // 安全性：resolveConversation 只在既有会话命中时返回 promptMode='latest'
  // （affinity=true）；新建或换凭据轮换出的会话返回 promptMode='full'
  // （affinity=false），走 fullPrompt 全量播种，工具说明随全量一起发送。
  // 因此不存在"续传轮里模型从未见过工具说明"的情形。
  const continuationPrompt = promptInjectionDisabled
    ? fullPrompt
    : (deltaStart != null
      ? promptWithToolInstructions(promptMessages.slice(deltaStart), '')
      : latestPromptWithToolInstructions(promptMessages, ''));

  // 长上下文时自动关闭思考。
  //
  // 真实故障（2026-10-30 DSH）：会话已累积 228,192 字符（约 91K tokens），
  // 用户选了 reasoningEffort=max（上游只有开/关布尔，max 与 medium 无异）。
  // 模型先在这段长上下文里思考、再输出，耗尽输出预算后返回**完全空流**，
  // 报「上游返回空响应，且续写未取得正文」。
  //
  // 阈值取 150,000 字符（约 60K tokens）：超过它，思考本身就要吃掉大量
  // 预算，而这一步往往只是"基于已有数据写个总结"。数据收集交给思考，
  // 汇总阶段不需要——关掉后失败率显著下降，且不改变结论质量。
  // 压缩后仍超阈值说明压缩救不回来（例如工具结果太少、单条就巨大），
  // 此时放弃思考，把有限的输出预算全留给正文。
  const contextTooLong = fullPrompt.length > CONTEXT_COMPACT_THRESHOLD_CHARS;
  const thinkingEnabled = contextTooLong
    ? false
    : (internalRequest.generation?.reasoning?.enabled ?? req.body?.thinking_enabled ?? true);
  if (contextTooLong) {
    // 只写 console 在 DSH 桌面端读不到，这一条随 request-plans 一起落盘
    // （见 getPrompt 里的 recordRequestPlan，thinkingEnabled 字段即是结果）。
    console.log(
      `[DeepSeek] 上下文 ${fullPrompt.length} 字符超过 ${CONTEXT_COMPACT_THRESHOLD_CHARS}，本轮自动关闭思考`
      + `（避免长上下文思考耗尽输出预算导致空流）`,
    );
  }
  // DeepSeek Web search may return planning/thinking without a final answer;
  // default it off for API determinism unless the caller explicitly opts in.
  const searchEnabled = req.body?.search_enabled ?? false;
  const requestStart = Date.now();

  let streamBody;
  let slot;
  let clientGone = false;
  const abortController = new AbortController();
  let onClose = null;
  const responseStream = context?.res;
  if (responseStream?.on) {
    onClose = () => {
      clientGone = true;
      abortController.abort();
      try { streamBody?.cancel(); } catch {}
    };
    responseStream.on('close', onClose);
  }

  // 模型合并后唯一模型即具备视觉能力，上传型内容直接走视觉 slot。
  //
  // 关键：上传与补全必须用同一个凭据。上游的 file_id 绑定账号，若上传用
  // A 而补全取到 B，会报 "invalid ref file id"。因此这里不释放 slot，
  // 而是把它交给 completion 继续使用（用完由 completion 负责释放）。
  let refFileIds = [];
  let uploadSlot = null;
  if (hasUploadableParts(openAIMessages)) {
    uploadSlot = await enqueueRequest(true);
    try {
      refFileIds = await extractUploads(openAIMessages, uploadSlot.token);
    } catch (err) {
      uploadSlot.release();
      dispatchQueued();
      uploadSlot = null;
      throw err;
    }
  }

  try {
    const makeResolveSession = (activeModelType) => conversationId
      ? async (token) => {
          const resolved = await resolveConversation({ conversationId, modelType: activeModelType, token });
          // fresh/轮换的会话（promptMode 'full'）没有历史，必须按全量模式发送，
          // 因此只有既有会话续传时才把 affinity 报告为 true（getPrompt 据此选增量）。
          return {
            sessionId: resolved.sessionId,
            parentMessageId: resolved.parentMessageId,
            affinity: resolved.affinity && resolved.promptMode === 'latest',
          };
        }
      : null;
    // affinity 为 true 表示上游会话已持有前文，只需发送增量且不带工具说明；
    // 否则全量播种（含工具说明）。
    const getPrompt = (affinity) => {
      if (promptInjectionDisabled) return latestPrompt;
      const chosen = affinity ? continuationPrompt : fullPrompt;
      // 诊断落盘：记录本次实际上行的规模与模式。
      //
      // 为什么必须落盘：会话亲和"是否生效"无法从 DSH 会话日志推断（那里只有
      // 消息累积量，看不出代理发了什么），而插件跑在 DSH 桌面端进程里、
      // stdout 没有可读落点。2026-10-30 排查"长会话上游返回空流"时，只能
      // 假设亲和已生效，却拿不到证据——若它其实没生效，会一直查错方向。
      recordRequestPlan({
        conversationId,
        affinity,
        mode: affinity ? 'continuation' : 'full',
        promptChars: chosen.length,
        fullChars: fullPrompt.length,
        continuationChars: continuationPrompt.length,
        contextChars: fullPrompt.length,
        historyMessages: promptMessages.length,
        thinkingEnabled,
        reasoningEffort: internalRequest.generation?.reasoning?.effort ?? null,
      });
      return chosen;
    };

    const completionResult = await completion({
      modelType,
      prompt: fullPrompt,
      thinkingEnabled,
      searchEnabled,
      refFileIds,
      preferVision: true,
      resolveSession: makeResolveSession(modelType),
      getPrompt,
      signal: abortController.signal,
      // 有附件时沿用上传用的凭据，保证 file_id 归属一致。
      initialSlot: uploadSlot,
    });
    // completion 已接管该 slot 的释放（见 sse.js），此处不再持有。
    uploadSlot = null;

    streamBody = completionResult.body;
    slot = completionResult.slot;
    if (clientGone || abortController.signal.aborted) {
      try { streamBody.cancel(); } catch {}
      return;
    }

    const responseModel = requestedModel;
    yield createRunStarted({ requestId, responseId, model: responseModel, protocol: internalRequest.protocol });

    const detector = toolCallingEnabled ? promptPlan.createStreamDetector() : null;
    let rawContent = '';
    let visibleContent = '';
    let reasoningContent = '';
    let usage = 0;
    let emittedText = false;
    let messageStarted = false;
    let detectedToolCalls = null;
    let pendingToolFailureText = '';
    let pendingToolFailureResult = null;

    const ensureMessageStarted = function* () {
      if (messageStarted) return;
      messageStarted = true;
      yield createMessageStarted({ requestId, responseId, messageId, role: 'assistant' });
    };

    // 纯空白正文暂存，不立即推给客户端。
    //
    // 真实故障（2026-10-30 DSH）：模型计划"并行获取几个项目的 states"，
    // 但只输出了 "\n\n"，既没有触发信号也没有工具调用。这两个换行被
    // emitText 立刻流式推送，DSH 把它们当成正文显示出来——用户看到的是
    // 一段"上游原生输出"的空白，而随后代理层判为空回复、开始续写或报错。
    //
    // 空白既不是答案，也不是有效的中间说明，推出去只会污染界面。因此先
    // 暂存；一旦出现实质内容，再把暂存的空白一起补发（保持文本连续性）；
    // 整轮都只有空白时，它会随 visibleContent 一起被判为空回复。
    let pendingWhitespace = '';

    const emitText = function* (delta) {
      if (!delta) return;
      // 还在排队空白时，先判断这段是否也全是空白
      if (pendingWhitespace !== '' || !String(delta).trim()) {
        const combined = pendingWhitespace + delta;
        if (!combined.trim()) {
          pendingWhitespace = combined;
          visibleContent += delta;
          return;
        }
        // 出现实质内容：把暂存的空白连同本段一起发出去
        pendingWhitespace = '';
        for (const event of ensureMessageStarted()) yield event;
        visibleContent += combined;
        emittedText = true;
        yield createTextDelta({ requestId, responseId, messageId, delta: combined });
        return;
      }
      for (const event of ensureMessageStarted()) yield event;
      visibleContent += delta;
      emittedText = true;
      yield createTextDelta({ requestId, responseId, messageId, delta });
    };

    // 收尾时把仍然暂存的空白丢弃：它们没有伴随任何实质内容，
    // 推送出去就是用户看到的"空白正文"。
    const discardPendingWhitespace = () => {
      if (!pendingWhitespace) return;
      // visibleContent 里已经累加过，这里只清掉待发缓冲；
      // 若整轮无实质内容，isEmptyAssistantReply 会据 visibleContent
      // 的 trim 结果判为空，走续写恢复而不是把空白当答案。
      pendingWhitespace = '';
    };

    for await (const event of parseSSEStream(streamBody, { signal: abortController.signal })) {
      if (clientGone) break;
      if (event.type === 'error') {
        try { await streamBody?.cancel?.(); } catch {}
        // 流中途才报限流：数据已开始下发，本次无法更换凭据，但要让该
        // 凭据进入冷却，避免后续请求继续撞它。
        const isRateLimited = event.code === 429 || event.code === 40301;
        // 上游原始报文（流内已解析出 code 与 message）随事件落盘，便于事后归因。
        const upstream = { code: event.code ?? null, msg: event.message ?? null, phase: 'stream' };
        if (slot && isRateLimited) {
          reportTokenRateLimited(slot.token, upstream);
        }
        // 流中途才暴露的终态失败（封禁/失效/禁言）同样要处置凭据：数据虽已
        // 下发，但该凭据已不可用，禁用后由其它凭据接管，并保留待恢复。
        if (slot) {
          if (event.code === 40004) {
            disableToken(slot.token, { reason: '账号被封禁 (40004)', disabledUntil: Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS, source: 'auto', detail: upstream, eventType: 'banned' });
          } else if (event.code === 40003) {
            reportTokenError(slot.token);
          } else if (event.code === 5) {
            disableToken(slot.token, { reason: '账号被禁言 (biz_code=5)', disabledUntil: Date.now() + CREDENTIAL_DISABLE_DEFAULT_MS, source: 'auto', detail: upstream, eventType: 'muted' });
          }
        }
        throw new InternalAPIError(event.message || `DeepSeek error ${event.code}`, {
          // 限流应回报 429 rate_limit_error，客户端据此退避重试；
          // 其它上游错误按 502 api_error 处理。
          status: isRateLimited ? 429 : 502,
          type: isRateLimited ? 'rate_limit_error' : 'api_error',
          code: event.code || null,
          retryable: isRateLimited,
        });
      }
      if (event.messageIds?.responseMessageId) {
        recordResponseMessageId(conversationId, event.messageIds.responseMessageId);
      }

      if (event.type === 'content') {
        rawContent += event.content;
        if (detector) {
          const processed = detector.process(event.content);
          if (processed.parseFailure) {
            pendingToolFailureText += processed.bufferedToolText || '';
            pendingToolFailureResult = processed.failureResult || pendingToolFailureResult;
            for (const textEvent of emitText(prefixBeforeBufferedToolText(processed))) yield textEvent;
          } else if (pendingToolFailureText) {
            pendingToolFailureText += processed.delta || '';
          } else {
            for (const textEvent of emitText(processed.delta)) yield textEvent;
          }
          if (processed.completed && processed.toolCalls?.length) {
            detectedToolCalls = processed.toolCalls;
            break;
          }
        } else {
          for (const textEvent of emitText(event.content)) yield textEvent;
        }
      } else if (event.type === 'thinking') {
        reasoningContent += event.content;
        yield createReasoningDelta({ requestId, responseId, messageId, delta: event.content });
      } else if (event.type === 'usage') {
        usage = event.usage;
        yield createUsageUpdated({ requestId, responseId, usage: { outputTokens: usageOutputTokens(usage) } });
      } else if (event.type === 'done') {
        break;
      }
    }

    if (detectedToolCalls?.length) {
      try { await streamBody?.cancel?.(); } catch {}
    }

    if (detector && !detectedToolCalls) {
      const finished = detector.finish();
      if (finished.parseFailure) {
        pendingToolFailureText += finished.bufferedToolText || '';
        pendingToolFailureResult = finished.failureResult || pendingToolFailureResult;
        for (const textEvent of emitText(prefixBeforeBufferedToolText(finished))) yield textEvent;
      } else if (pendingToolFailureText) {
        pendingToolFailureText += finished.delta || '';
      } else {
        for (const textEvent of emitText(finished.delta)) yield textEvent;
      }
      if (finished.completed && finished.toolCalls?.length) {
        detectedToolCalls = finished.toolCalls;
      }
    }

    // 流已结束：仍未发出的纯空白不再推送。
    // 它若不伴随任何实质内容，推出去就是用户看到的"空白正文"。
    discardPendingWhitespace();

    const releaseSlot = () => {
      if (slot) {
        slot.release();
        dispatchQueued();
        slot = null;
      }
    };
    const retryToolRequest = async ({ retryPrompt, currentContent, messages: retryMessages, signal }) => {
      // 大文件截断时不回放原文。
      //
      // 2026-10-30 实测：把 20,570 字的截断原文作为 assistant 消息重发，
      // 模型看到的上下文变成「我刚写了这么多 → 让我接着写完」，它继续往
      // 那个写不完的参数里灌内容，再次截断。两次重试全废。
      //
      // 分段写入要的是"换一种写法"，前提是先忘掉那个巨型参数。因此这里
      // 只留一小段尾部作为定位锚点（提示词里本来也带了），整体不回放。
      const largeFile = isLargeFileWriteTruncation(currentContent, promptPlan.tools);
      const assistantEcho = largeFile
        ? { role: 'assistant', content: [{ type: 'text', text: '（上一次输出因内容过长被截断，原文已省略）' }] }
        : { role: 'assistant', content: [{ type: 'text', text: currentContent || '' }] };

      const retryMessagesWithPrompt = [
        ...retryMessages,
        assistantEcho,
        { role: 'user', content: [{ type: 'text', text: retryPrompt }] },
      ];
      // 重试不再重复携带工具说明。
      //
      // 首轮已经把完整工具列表（188 工具时约 245K 字符）发给模型，它仍在
      // 同一会话的上下文里；再发一遍既浪费又可能强化"格式很难"的印象。
      // 重试轮只补一段轻量的格式纠错说明。
      //
      // 大文件截断场景不附这段：它写的是"重新输出完整调用"，与分段写入
      // "只写开头"直接矛盾，模型会按更强的"重新输出"执行。
      const retryHint = largeFile ? '' : buildRetryFormatHint(triggerSignal);
      const retryFullPrompt = promptWithToolInstructions(retryMessagesWithPrompt, retryHint);
      const retryResult = await completion({
        modelType,
        prompt: retryFullPrompt,
        // 重试必须关闭 thinking。
        //
        // 真实故障（2026-10-30 DSH 日志）：首轮思考 111 秒后只输出两个换行
        // 就截断，两次重试同样继承 thinkingEnabled=true（用户选了 max 档），
        // 每次都重新思考上百秒，再次耗尽输出预算，三次全部 truncated。
        //
        // 与 retryReasoningOnly 同理：思考已经做过一遍，重试阶段要的是
        // "把结论按格式写出来"，再思考一遍只会重复消耗。
        thinkingEnabled: false,
        searchEnabled: false,
        refFileIds: [],
        preferVision: true,
        signal: signal || abortController.signal,
      });
      const retrySlot = retryResult.slot;
      try {
        return await collectParsedStreamContent(retryResult.body, (body) => parseSSEStream(body, { signal: signal || abortController.signal }));
      } finally {
        retrySlot?.release?.();
        dispatchQueued();
      }
    };

    // "只思考未作答"恢复：上游偶发只发 thinking 就 stop。这里带上一轮思考
    // 内容与原始请求续写一次，把结论要成正文。沿用同一会话（conversationId）
    // 让上游保有上下文；关闭 thinking 强制直接产出正文，避免再次只思考。
    const retryReasoningOnly = async ({ retryPrompt, currentContent, messages: retryMessages, signal }) => {
      const retryMessagesWithPrompt = [
        ...retryMessages,
        { role: 'assistant', content: [{ type: 'text', text: currentContent || '' }] },
        { role: 'user', content: [{ type: 'text', text: retryPrompt }] },
      ];
      const retryFullPrompt = promptWithToolInstructions(retryMessagesWithPrompt, '');
      const retryResult = await completion({
        modelType,
        prompt: retryFullPrompt,
        // 关键：续写阶段关闭 thinking，否则模型可能再次只输出思考。
        thinkingEnabled: false,
        searchEnabled: false,
        refFileIds: [],
        preferVision: true,
        signal: signal || abortController.signal,
      });
      const retrySlot = retryResult.slot;
      try {
        return await collectParsedStreamContent(retryResult.body, (body) => parseSSEStream(body, { signal: signal || abortController.signal }));
      } finally {
        retrySlot?.release?.();
        dispatchQueued();
      }
    };

    if (pendingToolFailureText && !detectedToolCalls) {
      releaseSlot();
      let retryResult = null;
      try {
        retryResult = await attemptToolParseWithRetry({
          content: pendingToolFailureText,
          messages: promptMessages,
          promptPlan,
          retryToolRequest,
          signal: abortController.signal,
        });
      } catch (err) {
        console.warn(`[DeepSeek] Tool retry failed, falling back to original buffered content: ${err.message}`);
      }
      if (retryResult?.toolCalls?.length) {
        detectedToolCalls = retryResult.toolCalls;
      } else {
        // 旧实现把 pendingToolFailureText（原文通常是一段残缺的 XML）当正文
        // 发给客户端。客户端无法区分"模型回答"与"解析失败的残留"，
        // 表现就是"转了很久，最后吐出一段乱七八糟的东西"。
        //
        // 改为明确失败：客户端能据此提示重试，而不是把残片当答案用掉。
        const failureType = retryResult?.failureType || 'syntax_error';
        // 落盘原文：DSH 侧只留错误消息，不留模型输出。没有这份记录，
        // 事后只能从推理文本猜失败原因——2026-10-30 连续三轮都是这么跑偏的。
        recordToolFailure({
          phase: 'stream',
          failureType,
          errorDetails: retryResult?.errorDetails,
          content: retryResult?.finalContent ?? pendingToolFailureText,
          attempts: retryResult?.attempts,
        });
        throw new InternalAPIError(
          `工具调用格式无法解析（${failureType}，已重试 ${retryResult?.attempts ?? 0} 次）`,
          { status: 502, type: 'api_error', code: 'TOOL_FORMAT_FAILED', retryable: true, cause: retryResult },
        );
      }
    }

    // 收尾兜底：模型用 `工具名({...})` 伪代码文本表示调用时，流式检测器
    // 不会拦截（无 XML 标记），文本已流出无法撤回；此处仍解析/纠错重试
    // 把 tool_calls 救回来，避免客户端收到一段"宣称调用"的文本后任务死锁。
    if (!detectedToolCalls && !pendingToolFailureText && toolCallingEnabled && rawContent && promptPlan.parseToolCallsDetailed) {
      const lateResult = promptPlan.parseToolCallsDetailed(rawContent);
      if (lateResult?.toolCalls?.length) {
        detectedToolCalls = lateResult.toolCalls;
        // late recovery 命中时，rawContent 里通常包含非标准工具文本
        // （如 <ApplyPatch> 或 ToolName({...})）。最终聚合 content 只保留
        // 工具调用前的说明文本，避免把 patch/伪调用主体当正文返回。
        visibleContent = lateResult.content || '';
        emittedText = !!visibleContent;
      } else if (lateResult?.failureType && lateResult.failureType !== 'no_fc') {
        releaseSlot();
        try {
          const lateRetry = await attemptToolParseWithRetry({
            content: rawContent,
            messages: promptMessages,
            promptPlan,
            retryToolRequest,
            signal: abortController.signal,
          });
          if (lateRetry?.toolCalls?.length) {
            detectedToolCalls = lateRetry.toolCalls;
          } else {
            // late 路径失败同样要落盘。
            //
            // 2026-10-30：这条分支以前只 catch 异常、不记录失败，导致
            // 「工具调用格式无法解析（schema_error）」在 DSH 侧有报错、
            // tool-failures 里却查不到任何原文——排查时无据可依。
            recordToolFailure({
              phase: 'late',
              failureType: lateRetry?.failureType || lateResult.failureType,
              errorDetails: lateRetry?.errorDetails || lateResult.errorDetails,
              content: lateRetry?.finalContent ?? rawContent,
              attempts: lateRetry?.attempts,
            });
          }
        } catch (err) {
          recordToolFailure({
            phase: 'late',
            failureType: lateResult.failureType,
            errorDetails: `late retry threw: ${err.message}`,
            content: rawContent,
          });
          console.warn(`[DeepSeek] Late tool recovery failed: ${err.message}`);
        }
      } else if (lateResult?.failureType === 'no_fc' && isMissingToolCallIntent(rawContent, promptPlan.tools)) {
        releaseSlot();
        try {
          const retryContent = await retryToolRequest({
            retryPrompt: getMissingToolCallRetryPrompt(rawContent, promptPlan.triggerSignal, promptPlan.tools),
            currentContent: rawContent,
            messages: promptMessages,
            signal: abortController.signal,
            failureType: 'missing_tool_call',
          });
          const missingRetry = promptPlan.parseToolCallsDetailed(retryContent);
          if (missingRetry?.toolCalls?.length) {
            detectedToolCalls = missingRetry.toolCalls;
          } else {
            // 与 late 路径同理：恢复失败也要留原文，否则事后无从归因。
            recordToolFailure({
              phase: 'late',
              failureType: missingRetry?.failureType || 'missing_tool_call',
              errorDetails: missingRetry?.errorDetails,
              content: retryContent || rawContent,
            });
          }
        } catch (err) {
          recordToolFailure({
            phase: 'late',
            failureType: 'missing_tool_call',
            errorDetails: `missing tool-call retry threw: ${err.message}`,
            content: rawContent,
          });
          console.warn(`[DeepSeek] Missing tool-call recovery failed: ${err.message}`);
        }
      }
    }

    // 空回复恢复：上游偶发"只思考、不输出正文"（finishReason=stop 但流里
    // 没有任何 RESPONSE 分片）。客户端只看到思考、拿不到答案，任务中断。
    // 这不是解析问题——上游确实没发正文，只能在代理层续写一次要回正文。
    // 恢复失败则保持原样，绝不伪造正文。
    if (!detectedToolCalls && !pendingToolFailureText && isEmptyAssistantReply({ visibleContent, reasoningContent })) {
      // 完全空流（无思考无正文）发生在两种情形：
      //   ① 该凭据被静默限制 → 记错误让池子累积并淘汰它
      //   ② IP 级限流 → 连续空流由 noteEmptyReply 累积判定，
      //      达阈值后开启全局冷却（该限制与凭据无关，换凭据无法规避）
      const completelyEmpty = !String(reasoningContent || '').trim();
      // slot 在 releaseSlot() 后会被置空，所以先记录凭据引用。
      const failedToken = slot?.token || null;
      if (completelyEmpty && failedToken) {
        reportTokenError(failedToken);
        noteEmptyReply();
        console.warn('[DeepSeek] 上游返回完全空流，已记该凭据一次错误');
      }
      releaseSlot();
      let recoveredText = '';
      let recoveryError = null;
      try {
        const recovered = await retryReasoningOnly({
          retryPrompt: getReasoningOnlyRetryPrompt(lastUserText, reasoningContent),
          currentContent: reasoningContent,
          messages: promptMessages,
          signal: abortController.signal,
        });
        recoveredText = String(recovered || '').trim();
      } catch (err) {
        recoveryError = err;
      }

      if (recoveredText) {
        for (const deltaEvent of emitText(recoveredText)) yield deltaEvent;
      } else {
        // 旧实现在这里只打一条 warn 就结束：客户端收到 200 + 空内容，
        // 无法区分"模型没话说"和"代理层放弃了"，表现就是任务卡住。
        // 续写也失败时必须显式报错，让客户端能提示重试。
        throw new InternalAPIError(
          completelyEmpty
            ? '上游返回空响应，且续写未取得正文'
            : '上游只返回了思考内容，续写未取得正文',
          {
            status: 502,
            type: 'api_error',
            code: 'EMPTY_RESPONSE',
            retryable: true,
            cause: recoveryError || undefined,
          },
        );
      }
    }

    // 注意：不要在流结束后把已流式发出的 message 文本"回填"成 reasoning。
    // 那样做无法流式（必须等到检测到 tool_call 才知道），会导致 Codex 端
    // 思考内容在末尾一次性出现。真正的思考来自上游 thinking 通道，已逐字流式；
    // 工具调用前的说明文本保持为 message 文本，同样逐字流式。
    if (reasoningContent) yield createReasoningDone({ requestId, responseId, messageId, text: reasoningContent });
    // 只有实质正文才发 text-done。
    //
    // 旧判据是 `emittedText || visibleContent`，而 visibleContent 可能是
    // 纯空白（模型只写了 "\n\n"）。那是真值，会走这个分支把空白作为正文
    // 收尾事件推给客户端——用户看到一条内容为空白的助手消息。
    // 用 trim 后的长度判断，空白不再算正文。
    if (String(visibleContent || '').trim()) {
      for (const event of ensureMessageStarted()) yield event;
      yield createTextDone({ requestId, responseId, messageId, text: visibleContent });
    }

    if (detectedToolCalls?.length) {
      for (const event of ensureMessageStarted()) yield event;
      for (const toolEvent of emitToolCallEvents({ requestId, responseId, messageId, toolCalls: detectedToolCalls })) {
        yield toolEvent;
      }
    }

    if (messageStarted || emittedText || visibleContent || detectedToolCalls?.length) {
      for (const event of ensureMessageStarted()) yield event;
      yield createMessageDone({ requestId, responseId, messageId, status: 'completed' });
    }
    // usage 说明：上游 Web 接口只提供输出 token 数（accumulated_token_usage），
    // 不提供输入 token、思考 token 与缓存命中统计。以下均为本地估算
    // （思考按约 4 字符/token），供客户端展示，非计费依据。
    //
    // 关于 completion_tokens 的口径（实测确认）：它对应**正文**而非总量。
    // 同样的问题下 thinking=true 得 134、thinking=false 得 102，正文长度几乎
    // 一致而思考量相差数百 token——若 completion_tokens 含思考，差值应与思考
    // 量同阶，实际只有 32。因此不能把它当作「含思考的总量」再按比例拆分，
    // 否则会把正文的量错算成思考，并让正文 token 趋近 0。客户端一旦用
    // 「正文 token ÷ 正文跨度」计算，分母是上游瞬发正文的极短时窗
    // （实测 208ms 出 53 个分片），就会得出 3589 这类夸张的 tok/s。
    const estimatedInputTokens = Math.max(0, Math.round(String(fullPrompt || '').length / 4));
    const visibleChars = visibleContent.length;
    const reasoningChars = reasoningContent.length;
    // 正文 token：优先用上游值；缺失时按字符估算。
    const visibleTokens = usageOutputTokens(usage) || Math.round(visibleChars / 4);
    // 思考 token：上游不计入，按字符量单独估算。
    const estimatedReasoningTokens = Math.round(reasoningChars / 4);
    const outputTokensFinal = visibleTokens + estimatedReasoningTokens;

    // 上报本次用量供 tok/s 统计。
    // 顺序很关键：渲染器收到 run.completed 后会立即 end() 响应，进而触发
    // 日志中间件的 res.finish 写记录；若在 yield 之后再上报，记录早已写定，
    // token 数就永远关联不上（这正是此前 tok/s 恒为 0 的原因之一）。
    //
    // 口径：输出 tokens ÷ 总耗时（含首字节等待），与 OpenAI 官方一致。
    // 不用"生成期"做分母的原因（实测）：上游是"先跑完思考、再瞬发正文"，
    // 思考阶段约 1745ms、正文阶段仅约 79ms；剔除首字节等待会让分母小到
    // 毫秒级，算出虚高数倍的速度。
    recordUsage(context?.res, {
      outputTokens: outputTokensFinal,
      durationMs: Date.now() - requestStart,
    });

    yield createRunCompleted({
      requestId,
      responseId,
      finishReason: detectedToolCalls?.length ? 'tool_calls' : 'stop',
      usage: {
        inputTokens: estimatedInputTokens,
        outputTokens: outputTokensFinal,
        reasoningTokens: estimatedReasoningTokens,
      },
    });

    // 有正文产出即视为上游正常，清除 IP 限流判定与空流计数。
    if (String(visibleContent || '').trim()) noteSuccessfulReply();
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (err instanceof InternalAPIError) throw err;
    try { await streamBody?.cancel?.(); } catch {}
    throw new InternalAPIError(err.message || 'DeepSeek upstream error', {
      // 保留上游错误携带的 HTTP 语义（如限流 429），缺失时才回落 502。
      status: err.status || 502,
      type: err.type || 'api_error',
      retryable: err.retryable || false,
      cause: err,
    });
  } finally {
    if (responseStream?.off && onClose) responseStream.off('close', onClose);
    if (slot) {
      slot.release();
      dispatchQueued();
    }
    // 附件上传的 slot 若因异常未被 completion 接管，在此兜底释放，
    // 避免并发额度泄漏（表现为后续请求排队等待）。
    if (uploadSlot) {
      uploadSlot.release();
      dispatchQueued();
    }
  }
}
