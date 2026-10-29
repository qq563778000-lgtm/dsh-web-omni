/**
 * OmniAPI 的 DSH provider 适配器
 *
 * 职责：把 DSH 的 provider-neutral 消息/流词汇，翻译成 OmniAPI 的
 * OpenAI Chat Completions 线格式，再把响应翻译回来。
 *
 * 为什么不用 dsh-llm-pi-ai 的 openai-completions 网关配置直接接：
 * pi-ai 能连上，但会忽略 OmniAPI 在 /v1/models 上给出的一批能力字段
 * （context_length 的多种别名、capabilities.thinking、input_modalities），
 * 也不会把 reasoning_content 映射成 DSH 的 reasoning 块——思考内容会
 * 直接消失或混进正文。这两个差异对代码 Agent 场景是硬伤，因此这里显式适配。
 *
 * 本文件不读取也不持有任何上游凭据：OmniAPI 的 API Key 通过
 * 环境变量引用（apiKeyEnv）按请求解析，插件只做转发。
 */

import { translateOmniStream } from './sse.js';

/** 与 DSH 运行时对齐的默认值；均可由配置覆盖。 */
const DEFAULTS = {
  baseURL: 'http://127.0.0.1:8080',
  providerId: 'omni',
  providerName: 'OmniAPI',
  apiKeyEnv: 'OMNI_API_KEY',
  timeoutMs: 300000,
};

export class OmniAdapter {
  #config;
  #modelCache = null;
  #modelCacheAt = 0;

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
   * 返回 undefined 表示沿用 DSH 的默认策略（normal / 5 次）。OmniAPI 自身
   * 已在池内做过凭据级故障转移，这里再叠加一层激进重试只会放大上游压力；
   * 默认策略是更保守的选择。
   *
   * 注意：这是 DSH 的 LlmAdapter 契约中**必须存在**的方法——
   * LlmRuntime.prepareRoutes 会直接调用它，缺失会让整条路由注册失败。
   */
  providerRetryPolicy(_provider) {
    return undefined;
  }

  /**
   * 单张请求图片的定价信息；本路由不声明，由 DSH 使用中立估算。
   * 同样属于契约方法，必须存在且同步返回。
   */
  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  /**
   * 列出可用模型。
   *
   * 直接消费 OmniAPI 的丰富元数据，而不是只取 id：上下文长度与能力声明
   * 决定了 DSH 会不会把图片、工具调用发给这个模型。
   */
  async listModels(provider) {
    const route = provider ?? this.providerId;
    const models = await this.#fetchModels();
    return models.map(model => toCatalogModel(model, route)).filter(Boolean);
  }

  async resolveModel(provider, model) {
    const route = provider ?? this.providerId;
    const list = await this.#fetchModels();
    const found = list.find(item => item?.id === model);
    const meta = found ? toDshModel(found) : null;
    // DSH 的 normalizeModelInfo 会校验 provider 必须等于注册路由、id 必须等于
    // 请求 model、name 非空，且 context 必须是 { contextWindow }。
    // 任一不符即抛 INVALID_MODEL_INFO，整个调用失败——因此这里按契约回填。
    return { ...(meta ?? {}), provider: route, id: model, name: meta?.name ?? model };
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    };
  }

  /** 主入口：发出一次流式补全。 */
  async *stream(options) {
    const { messages, model, tools, system, signal } = options ?? {};
    if (!model) throw makeError('OmniAPI request is missing a model', 'INVALID_ARGS');
    if (!Array.isArray(messages) || messages.length === 0) {
      throw makeError('OmniAPI request is missing messages', 'INVALID_ARGS');
    }

    const apiKey = this.#resolveApiKey();
    const url = `${trimSlash(this.#config.baseURL)}/v1/chat/completions`;
    const body = buildRequestBody({ messages, model, tools, system });

    const timeout = createTimeout(this.#config.timeoutMs);
    const combinedSignal = combineSignals([signal, timeout.signal]);

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });
    } catch (err) {
      timeout.clear();
      if (signal?.aborted) throw makeError('OmniAPI request aborted', 'ABORTED', err);
      if (timeout.signal.aborted) throw makeError('OmniAPI request timed out', 'TIMEOUT', err);
      throw makeError('OmniAPI transport failed', 'TRANSPORT', err);
    }

    if (!response.ok) {
      timeout.clear();
      const detail = await safeReadText(response);
      throw makeError(
        `OmniAPI responded ${response.status}${detail ? `: ${truncate(detail, 300)}` : ''}`,
        mapStatusToCode(response.status),
        undefined,
        response.status,
      );
    }

    try {
      for await (const chunk of translateOmniStream(response.body, { signal: combinedSignal })) {
        yield chunk;
      }
    } catch (err) {
      if (signal?.aborted) throw makeError('OmniAPI request aborted', 'ABORTED', err);
      if (timeout.signal.aborted) throw makeError('OmniAPI stream idle out', 'TIMEOUT', err);
      if (err?.code === 'ABORTED') throw makeError('OmniAPI request aborted', 'ABORTED', err);
      // 流内错误对象（本项目修复后的失败形态）已带 code，透传它。
      if (err?.code && typeof err.code === 'string' && /^[A-Z_]+$/.test(err.code)) {
        throw makeError(err.message || 'OmniAPI upstream error', err.code, err);
      }
      throw makeError(err?.message || 'OmniAPI stream failed', 'UPSTREAM_ERROR', err);
    } finally {
      timeout.clear();
    }
  }

  #resolveApiKey() {
    const ref = this.#config.apiKey;
    if (typeof ref === 'string' && ref.length > 0) return ref;
    const envName = this.#config.apiKeyEnv;
    if (!envName) return undefined;
    const value = process.env[envName];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  async #fetchModels() {
    const now = Date.now();
    // 模型目录变化很慢，缓存一分钟足以避免每次调用都打一次 HTTP。
    if (this.#modelCache && now - this.#modelCacheAt < 60_000) return this.#modelCache;

    const apiKey = this.#resolveApiKey();
    const url = `${trimSlash(this.#config.baseURL)}/v1/models`;

    let response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      });
    } catch (err) {
      throw makeError(`无法连接 OmniAPI（${url}）：${err?.message || err}`, 'TRANSPORT', err);
    }

    if (!response.ok) {
      throw makeError(`OmniAPI /v1/models 返回 ${response.status}`, mapStatusToCode(response.status), undefined, response.status);
    }

    const payload = await response.json();
    const list = Array.isArray(payload?.data) ? payload.data : [];
    // 缓存原始条目而非转换结果：catalog（listModels）与 exact（resolveModel）
    // 两种输出形状不同，转换各自负责，避免一份缓存被两处消费后互相污染。
    this.#modelCache = list;
    this.#modelCacheAt = now;
    return list;
  }
}

/**
 * OmniAPI 模型元数据 → DSH 模型描述。
 *
 * 字段名按 OmniAPI 实际输出读取（见 /v1/models）。上下文长度取第一个
 * 存在的别名：上游为兼容不同客户端同时给出了 6 种拼写。
 */
export function toDshModel(raw) {
  if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) return null;

  const contextWindow = firstNumber(
    raw.context_length,
    raw.context_window,
    raw.max_context_length,
    raw.max_context_tokens,
    raw.max_model_len,
    raw.max_input_tokens,
    raw.top_provider?.context_length,
  );

  const maxTokens = firstNumber(
    raw.max_output_tokens,
    raw.max_completion_tokens,
    raw.top_provider?.max_completion_tokens,
  );

  const inputModalities = Array.isArray(raw.input_modalities)
    ? raw.input_modalities.filter(item => typeof item === 'string')
    : ['text'];

  // 字段形状受 DSH 的 normalizeModelInfo 约束：
  //   provider 由注册时的路由决定（此处不填，由 resolveModel 回填）
  //   context 必须是 { contextWindow }，不是顶层 contextWindow
  //   defaultMaxTokens 而非 maxTokens
  //   reasoning 必须是 { efforts: [{ id, name }] } 结构
  const model = {
    id: raw.id,
    name: raw.name || raw.id,
    inputModalities,
  };
  if (contextWindow !== undefined) model.context = { contextWindow };
  if (maxTokens !== undefined) model.defaultMaxTokens = maxTokens;

  // 只有上游明确声明支持思考时才开放推理档位，避免强加给普通模型。
  if (raw.capabilities?.thinking === true) {
    model.reasoning = {
      efforts: [
        { id: 'off', name: 'Off' },
        { id: 'high', name: 'High' },
      ],
    };
  }

  return model;
}

/**
 * listModels 的输出形状。
 *
 * DSH 的 listModels 校验（见 LlmRuntime.listModels）要求 provider 必须
 * 等于注册的路由 id，且 id 不可重复；inputModalities 只保留这一项，
 * 其余能力字段在目录层会被忽略。
 *
 * @param {object} raw OmniAPI 的模型条目
 * @param {string} provider 注册时的路由名
 */
export function toCatalogModel(raw, provider) {
  const model = toDshModel(raw);
  if (!model) return null;
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: model.inputModalities,
  };
}

/**
 * DSH 消息 → OpenAI Chat Completions messages。
 *
 * 关键映射：
 *   - role=developer 在 OpenAI 里没有对应角色，折叠进 system；
 *     DSH 用它承载"本回合的附加指令"，语义上与 system 最近。
 *   - tool 消息必须带 tool_call_id，否则上游会拒绝整条请求。
 *   - assistant 的 tool-call 块要还原为 tool_calls 数组，
 *     否则多轮工具调用会被上游当成纯文本历史。
 */
export function buildMessages(messages, system) {
  const out = [];
  const systemParts = [];

  if (typeof system === 'string' && system.trim().length > 0) {
    systemParts.push(system);
  }

  for (const message of messages) {
    const role = message?.role;
    const blocks = Array.isArray(message?.content) ? message.content : [];

    if (role === 'system' || role === 'developer') {
      const text = blocksToText(blocks);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId || message.source?.callId || '',
        content: blocksToText(blocks),
      });
      continue;
    }

    const text = blocksToText(blocks);
    const toolCalls = blocks.filter(block => block?.type === 'tool-call');

    if (role === 'assistant' && toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments || '{}' },
        })),
      });
      continue;
    }

    out.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content: buildContent(blocks, text),
    });
  }

  if (systemParts.length > 0) {
    out.unshift({ role: 'system', content: systemParts.join('\n\n') });
  }
  return out;
}

/**
 * 组装请求体。
 *
 * 始终 stream=true：OmniAPI 拒绝非流式请求（见 src/routes/api.js 的强制流式中间件）。
 */
export function buildRequestBody({ messages, model, tools, system }) {
  const body = {
    model,
    stream: true,
    messages: buildMessages(messages, system),
  };

  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      },
    }));
  }

  return body;
}

/** 拼接文本块；工具调用块不参与文本。 */
function blocksToText(blocks) {
  return blocks
    .filter(block => block?.type === 'text')
    .map(block => block.text || '')
    .join('');
}

/**
 * 有图片时返回多模态数组，否则返回纯字符串。
 * 纯文本走字符串能让上游少一层解析，也避免部分客户端对数组格式的兼容问题。
 */
function buildContent(blocks, text) {
  const images = blocks.filter(block => block?.type === 'image');
  if (images.length === 0) return text;

  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const image of images) {
    const url = imageToDataUrl(image);
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts.length > 0 ? parts : text;
}

function imageToDataUrl(image) {
  if (typeof image.url === 'string' && image.url.length > 0) return image.url;
  if (typeof image.data === 'string' && image.data.length > 0) {
    const mime = image.mimeType || 'image/png';
    return `data:${mime};base64,${image.data}`;
  }
  // 图片以本地文件引用形式给出时，需要宿主提供附件服务才能内联；
  // 这里不自行读盘（插件不该拥有文件系统权限）。
  return null;
}

function makeError(message, code, cause, status) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = code;
  if (typeof status === 'number') err.status = status;
  return err;
}

function mapStatusToCode(status) {
  if (status === 401 || status === 403) return 'INVALID_CREDENTIAL';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return 'INVALID_ARGS';
}

function firstNumber(...values) {
  for (const value of values) {
    const num = typeof value === 'string' ? Number(value) : value;
    if (typeof num === 'number' && Number.isFinite(num) && num > 0) return num;
  }
  return undefined;
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function truncate(text, limit) {
  const str = String(text);
  return str.length <= limit ? str : `${str.slice(0, limit)}…`;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * 请求级超时。
 *
 * 用 AbortController 而非 Promise.race：后者不会真正取消底层连接，
 * 长流场景下会留下悬挂的 socket。
 */
function createTimeout(ms) {
  const controller = new AbortController();
  if (!Number.isFinite(ms) || ms <= 0) {
    return { signal: controller.signal, clear() {} };
  }
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return {
    signal: controller.signal,
    clear() { clearTimeout(timer); },
  };
}

/** 合并多个取消信号（Node 20+ 有 AbortSignal.any，这里做兼容兜底）。 */
function combineSignals(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid);

  const controller = new AbortController();
  for (const signal of valid) {
    if (signal.aborted) { controller.abort(); break; }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}
