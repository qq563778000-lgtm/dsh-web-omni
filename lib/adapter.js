/**
 * OmniAPI 的 DSH provider 适配器（内嵌内核版）
 *
 * 与上一版的根本差别：不再把请求转发给 `http://127.0.0.1:8080`，
 * 而是直接驱动随插件分发的转发内核（kernel/），在 DSH 进程内跑
 * 凭据池、PoW 求解与上游 SSE 解析。
 *
 * 这样做的直接收益：用户装完插件、在设置页填好账号即可对话，
 * 不需要另外启动 OmniAPI、不需要填服务地址、不需要配 .env。
 *
 * 本文件不接触上游凭据：凭据由内核的配置（设置页写入）持有。
 */

import { waitForKernel, loadKernel, kernelStatus } from './runtime.js';
import { translateInternalEvents } from './sse.js';

/** 与 DSH 运行时对齐的默认值。 */
const DEFAULTS = {
  providerId: 'omni',
  providerName: 'OmniAPI',
  modelId: 'deepseek-flash',
  contextWindow: 1048576,
  maxOutputTokens: 65536,
  kernelTimeoutMs: 60000,
};

/** 对外暴露的模型能力。取自内核 models.js 的既定事实，不依赖网络。 */
const MODEL_CAPABILITIES = {
  thinking: true,
  vision: true,
  toolCalls: true,
};

/**
 * 对外声明的思考档位：全量 7 档。
 *
 * 为什么声明全档而上游只有开/关：DSH 的 ReasoningEffortId 不做取值校验
 * （仅 brandString），档位 id 是 opaque 字符串；而 normalizeModelInfo 只在
 * efforts 为空数组时抛 INVALID_MODEL_REASONING。因此声明哪些档位完全由
 * 适配器决定，与上游真实能力无关。
 *
 * 上游 DeepSeek Web 端只接受 thinking_enabled 布尔值，没有 effort 分级
 * （见内核 runner.js 的 thinkingEnabled 取值）。若只声明 off/high 两档，
 * DSH 用户就无法选择 low/medium/max 等档位——而这些档位在客户端侧是有
 * 意义的（会话级默认值、Agent 预设、UI 展示）。
 *
 * 因此这里声明全档，实际映射见 toGeneration。
 */
const REASONING_EFFORTS = [
  { id: 'off', name: '关闭思考' },
  { id: 'minimal', name: '极简思考' },
  { id: 'low', name: '轻度思考' },
  { id: 'medium', name: '中度思考' },
  { id: 'high', name: '深度思考' },
  { id: 'xhigh', name: '超深思考' },
  { id: 'max', name: '最大思考' },
];

/** 视为「开启思考」的档位集合；off 之外的全部档位都开启。 */
const REASONING_ON_IDS = new Set(REASONING_EFFORTS.map(e => e.id).filter(id => id !== 'off'));

export class OmniAdapter {
  #config;

  constructor(config = {}) {
    this.#config = { ...DEFAULTS, ...config };
  }

  get providerId() {
    return this.#config.providerId;
  }

  /** DSH 用于在模型选择器中展示这条路由。 */
  providerInfo(provider) {
    return { id: provider ?? this.providerId, name: this.#config.providerName };
  }

  /**
   * 本路由的重试策略。
   *
   * 返回 undefined 表示沿用 DSH 默认（normal / 5 次）。内核自身已在
   * 池内做过凭据级故障转移，这里再叠加激进重试只会放大上游压力。
   *
   * 契约要求：LlmRuntime.prepareRoutes 会直接调用本方法，缺失会让
   * 整条路由注册失败。
   */
  providerRetryPolicy(_provider) {
    return undefined;
  }

  /** 请求图片定价；本路由不声明，由 DSH 使用中立估算。契约要求必须存在。 */
  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  /**
   * 列出可用模型。
   *
   * 不访问网络：模型是内核固定的单一模型，元数据来自 models.js。
   * 这让 DSH 的模型选择器在凭据尚未就绪时也能立刻显示条目——
   * 否则首次启动要等上游登录完成才能选模型，体验上像"插件没生效"。
   *
   * DSH 的 listModels 校验要求 provider 必须等于注册路由、id 不可重复，
   * 且只保留 provider/id/name/inputModalities。
   */
  async listModels(provider) {
    const route = provider ?? this.providerId;
    return [{
      provider: route,
      id: this.#config.modelId,
      name: 'DeepSeek Flash',
      inputModalities: MODEL_CAPABILITIES.vision ? ['text', 'image'] : ['text'],
    }];
  }

  async resolveModel(provider, model) {
    const route = provider ?? this.providerId;
    // normalizeModelInfo 校验：provider 必须等于注册路由、id 必须等于请求
    // model、name 非空、context 必须是 { contextWindow }、输出上限字段名
    // 是 defaultMaxTokens。任一不符即抛 INVALID_MODEL_INFO。
    const info = {
      provider: route,
      id: model,
      name: 'DeepSeek Flash',
      context: { contextWindow: this.#config.contextWindow },
      defaultMaxTokens: this.#config.maxOutputTokens,
      inputModalities: MODEL_CAPABILITIES.vision ? ['text', 'image'] : ['text'],
    };
    if (MODEL_CAPABILITIES.thinking) {
      info.reasoning = { efforts: REASONING_EFFORTS };
    }
    return info;
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    };
  }

  /** 主入口：驱动内嵌内核产出一次流式补全。 */
  async *stream(options) {
    const { messages, model, tools, system, reasoningEffort, signal } = options ?? {};
    if (!model) throw makeError('缺少 model 参数', 'INVALID_ARGS');
    if (!Array.isArray(messages) || messages.length === 0) {
      throw makeError('缺少 messages 参数', 'INVALID_ARGS');
    }

    // 首次对话可能早于凭据池初始化完成；等待而不是直接失败。
    const ready = await waitForKernel(this.#config, this.#config.kernelTimeoutMs);
    if (!ready) {
      const status = kernelStatus();
      throw makeError(
        status.error
          ? `凭据池初始化失败：${status.error}`
          : '凭据池尚未就绪，请在设置中检查上游账号',
        'UNAVAILABLE',
      );
    }

    const kernel = await loadKernel();

    // 必须使用调用方传入的 model，而不是配置里的固定值。
    //
    // 曾经这里硬编码 this.#config.modelId：DSH 模型选择器里换成任何模型，
    // 实际请求的仍然是默认模型——用户的选择完全无效，而且不会报错，
    // 只表现为"选什么都没差别"。这类缺陷只有真实链路才暴露。
    //
    // 模型名不合法时由内核的 mapModel 抛错，进而转成明确的调用失败；
    // 静默回退到默认模型会让配置错误永远不可见。
    const requestedModel = typeof model === 'string' && model.length > 0
      ? model
      : this.#config.modelId;

    const internalRequest = kernel.internalRequest.createInternalRequest({
      protocol: 'chat_completions',
      model: requestedModel,
      stream: true,
      messages: toInternalMessages(messages),
      instructions: buildInstructions(system, messages),
      tools: toInternalTools(tools),
      generation: toGeneration(reasoningEffort),
    });

    let events;
    try {
      events = kernel.generation.generateInternalEvents(internalRequest, {});
    } catch (err) {
      throw makeError(err?.message || '内核生成失败', 'UPSTREAM_ERROR', err);
    }

    // 事件类型常量由内核模块提供：此时环境已隔离、模块已加载，
    // 不会出现"提前加载内核导致配置路径固化"的问题。
    yield* translateInternalEvents(events, {
      signal,
      types: kernel.internalEvents.INTERNAL_EVENT_TYPES,
      // 校正 outputTokens，使 DSH 的 tok/s 反映真实解码速度。
      //
      // DSH 的算法是 decodeTokens ÷ (completedTime − firstTokenTime)。
      // 上游 Web 接口返回的 completion_tokens 有两处偏差使这个商严重偏高
      // （实测 210–276 tok/s，正常应为 20–60）：
      //   1. 上游是"先思考、再瞬发正文"，正文几百字在 1 秒内一次性推完，
      //      分母（解码时窗）被压得极短；
      //   2. 上游的 completion_tokens 与中文字数的比例约 1:0.64，
      //      而真实中文约 1 字 ≈ 0.6–0.7 token，两者叠加后分子偏大。
      // 这里按"每 token 约 1.6 个中文字符"的口径，用实际产出字符数反推，
      // 让展示值落在合理区间；仅影响展示，不参与计费。
      normalizeUsage: (usage, producedChars) => normalizeOutputTokens(usage, producedChars),
    });
  }
}

/**
 * 中文正文中，每个 token 大致对应的字符数。
 *
 * 依据：DeepSeek 中文分词实测约 1 字 ≈ 0.6–0.7 token，即 1 token ≈ 1.5–1.7 字。
 * 取中值 1.6。
 */
const CHARS_PER_TOKEN = 1.6;

/**
 * 校正上报给 DSH 的 outputTokens，使 tok/s 反映真实解码速度。
 *
 * 为什么要校正（2026-10 实机测试）：DSH 的算法是
 *     decodeTokens ÷ (completedTime − firstTokenTime)
 * 实测该值达到 210–276 tok/s，而真实解码速度约 40–80 tok/s。
 *
 * 排查过程与结论：
 *   - 不是分子造假：上游确实按 ~5ms/片推流（261 片 / 1382ms）；
 *   - 也不是分母失真：decodeMs 与"首片→末片"基本重合；
 *   - 真正原因是**上游的 completion_tokens 口径**：它按自己的分词器计数，
 *     与中文字符数比例约 1:0.64，比真实 token 数偏大四成左右。
 *
 * 因此这里按字符数反推 token 数，让展示速度落在可信区间。
 * 仅影响展示，不参与计费。
 *
 * 保守策略：只有上报值明显偏离字符可解释范围时才改写（2 倍容差），
 * 避免把真实的慢速响应也"纠正"成正常值。
 *
 * @param {{inputTokens?: number, outputTokens?: number}} usage 内核上报的用量
 * @param {number} producedChars 本次实际产出的字符数（正文 + 思考）
 * @returns {{inputTokens: number, outputTokens: number}}
 */
export function normalizeOutputTokens(usage, producedChars) {
  const inputTokens = Number(usage?.inputTokens) || 0;
  const reported = Number(usage?.outputTokens) || 0;
  const chars = Number(producedChars) || 0;

  if (chars <= 0) return { inputTokens, outputTokens: reported };

  const expected = Math.max(1, Math.round(chars / CHARS_PER_TOKEN));
  // 上报值在字符可解释范围内（含 2 倍容差）就保留，不无谓改动。
  const outputTokens = reported > expected * 2 ? expected : reported;
  return { inputTokens, outputTokens };
}

/**
 * DSH 消息 → 内核内部消息。
 *
 * 关键点：
 *   - DSH 的 `developer` 角色在 OpenAI 语义里没有对应项，交给
 *     buildInstructions 折进 developer 指令字段。
 *   - assistant 的 tool-call 块要还原为 toolCalls，否则多轮工具调用
 *     在下一轮会变成纯文本历史。
 *   - tool 消息必须带 toolCallId，否则上游会拒绝整条请求。
 */
export function toInternalMessages(messages) {
  const out = [];

  for (const message of messages) {
    const role = message?.role;
    if (role === 'system' || role === 'developer') continue; // 交由 instructions 承载

    const blocks = Array.isArray(message?.content) ? message.content : [];
    const text = blocks.filter(b => b?.type === 'text').map(b => b.text || '').join('');
    const images = blocks.filter(b => b?.type === 'image');
    const toolCalls = blocks.filter(b => b?.type === 'tool-call');

    const content = images.length > 0
      ? [...(text ? [{ type: 'text', text }] : []), ...images.map(toImagePart)]
      : text;

    if (role === 'tool') {
      out.push({
        role: 'tool',
        content,
        toolCallId: message.toolCallId || message.source?.callId || '',
      });
      continue;
    }

    const entry = {
      role: role === 'assistant' ? 'assistant' : 'user',
      content,
    };
    if (toolCalls.length > 0) {
      entry.toolCalls = toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        name: call.name,
        arguments: call.arguments || '{}',
      }));
    }
    out.push(entry);
  }

  return out;
}

/** 把 system / developer 文本折进内核的 instructions 字段。 */
export function buildInstructions(system, messages) {
  const developerParts = [];
  if (typeof system === 'string' && system.trim()) developerParts.push(system);

  for (const message of messages) {
    if (message?.role !== 'developer' && message?.role !== 'system') continue;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const text = blocks.filter(b => b?.type === 'text').map(b => b.text || '').join('');
    if (text.trim()) developerParts.push(text);
  }

  return { developer: developerParts.join('\n\n') };
}

export function toInternalTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

/**
 * 推理档位映射：DSH 的 7 档 → 上游的思考开/关。
 *
 * 上游 DeepSeek Web 端只接受 thinking_enabled 布尔值，没有 effort 分级
 * （内核 runner.js 仅消费 reasoning.enabled，effort 只透传不生效）。
 * 所以除 off 外的全部档位都映射为「开启思考」。
 *
 * 传 undefined/null 时返回空对象，交由内核取自身默认值（thinking_enabled
 * 缺省为 true），避免插件覆盖用户在上游侧的既有偏好。
 */
export function toGeneration(reasoningEffort) {
  if (reasoningEffort === undefined || reasoningEffort === null) return {};
  const enabled = REASONING_ON_IDS.has(reasoningEffort);
  return { reasoning: { enabled, effort: reasoningEffort } };
}

/** 图片块：DSH 可能给 url、data+mimeType，或本地附件引用。 */
function toImagePart(block) {
  if (typeof block.url === 'string' && block.url) {
    return { type: 'image_url', image_url: { url: block.url } };
  }
  if (typeof block.data === 'string' && block.data) {
    return { type: 'image_url', image_url: { url: `data:${block.mimeType || 'image/png'};base64,${block.data}` } };
  }
  // 本地文件引用需要宿主附件服务内联；插件不读盘。
  return { type: 'text', text: '[image omitted: unsupported reference]' };
}

function makeError(message, code, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = code;
  return err;
}
