/**
 * DeepSeek 模型配置
 *
 * 上游已于 2026-09 合并模型能力，不再区分 flash/pro 两档：
 *   - /api/v0/client/settings 中 normal_* 与 r1_* 的 token 上限已收敛为同一值
 *   - 请求体的 model_type 仅保留单一取值 'default'
 * 因此对外只暴露一个模型 ID。
 */

import { normalizeRequestedModelName } from '../../utils/response-utils.js';
import { getConfig } from '../../services/config-store.js';

/** 对外公开的唯一模型 ID。 */
export const DEEPSEEK_MODEL = 'deepseek-flash';

/** 上游 model_type 取值（合并后仅此一种）。 */
export const DEEPSEEK_MODEL_TYPE = 'default';

export const DEEPSEEK_MODEL_MAP = {
  [DEEPSEEK_MODEL]: DEEPSEEK_MODEL_TYPE,
};

/**
 * 组装 OpenAI 风格的模型对象，并补齐上下文长度等能力元数据。
 *
 * 背景：OpenAI 官方 Model 对象不含上下文长度字段，各厂商与客户端自行扩展，
 * 键名并无统一标准。客户端在自动识别上下文长度时，会依次探测
 * context_length / context_window / max_context_tokens / max_model_len 等
 * 不同名称，因此这里一并给出多种常见别名，确保不同客户端都能识别。
 *
 * 默认数值取 DeepSeek 官方 1M 规范（1M 上下文），可通过
 * deepseek.contextLength / deepseek.maxOutputTokens 配置调整。
 */
export function toOpenAIModel(id, { created = 1718000000, ownedBy = 'deepseek' } = {}) {
  const { contextLength, maxOutputTokens } = getConfig().deepseek;
  return {
    id,
    object: 'model',
    created,
    owned_by: ownedBy,
    // —— 上下文窗口：不同客户端的探测键名，全部给出以确保兼容 ——
    context_length: contextLength,
    context_window: contextLength,
    max_context_length: contextLength,
    max_context_tokens: contextLength,
    max_model_len: contextLength,
    max_input_tokens: contextLength,
    // —— 输出上限（与上下文窗口区分，勿混用）——
    max_output_tokens: maxOutputTokens,
    max_completion_tokens: maxOutputTokens,
    // —— 能力声明 ——
    //
    // 客户端判定"是否支持图片"读取的字段名并无统一标准：有的看
    // capabilities.vision，有的看顶层 supports_vision，有的从 modalities
    // 数组里找 "image"（OpenRouter 风格）。这些字段并无官方规范，只能按
    // 已知先例一并给出，避免因字段名不匹配被误判为"当前模型不支持图片"。
    capabilities: {
      text: true,
      thinking: true,
      document: true,
      vision: true,
      tool_calls: true,
      streaming: true,
    },
    supports_vision: true,
    // 模态列表（OpenRouter / LiteLLM 风格）
    modalities: ['text', 'image'],
    input_modalities: ['text', 'image'],
    // OpenRouter 风格：部分客户端从此嵌套结构读取
    top_provider: {
      context_length: contextLength,
      max_completion_tokens: maxOutputTokens,
    },
  };
}

/**
 * 映射请求模型名到上游 model_type。
 * 仅接受公开模型表中的名称；归一化只剥离客户端附加的 [1m] 等后缀。
 */
export function mapModel(model) {
  const normalized = normalizeRequestedModelName(model);
  if (!normalized) throw new Error(`Invalid model: ${model}`);

  const mapped = DEEPSEEK_MODEL_MAP[normalized];
  if (mapped) return mapped;

  throw new Error(
    `Unknown model: ${model}. Available: ${Object.keys(DEEPSEEK_MODEL_MAP).join(', ')}`
  );
}
