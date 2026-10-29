/**
 * 模型路由器
 *
 * 根据模型名称路由到对应的渠道处理器，并自动剥离 [1m] 等客户端附加后缀
 * （源自 Claude Code）。
 *
 * 当前仅支持 DeepSeek 渠道：GLM 渠道因上游策略调整已移除。
 */

import { DEEPSEEK_MODEL_MAP } from '../channels/deepseek/models.js';
import { normalizeRequestedModelName } from './response-utils.js';

/**
 * 路由模型到正确的渠道
 * @param {string} modelName - 模型名称
 * @returns {{channel: string, model: string}} 渠道和模型信息
 * @throws {Error} 未知模型时抛出错误
 */
export function routeModel(modelName) {
  // 输入验证 + 归一化（剥离 [1m] 等）
  const normalized = normalizeRequestedModelName(modelName);
  if (!normalized) {
    throw new Error('模型名称是必需的');
  }

  // DeepSeek 模型（精确匹配公开模型表）
  if (Object.prototype.hasOwnProperty.call(DEEPSEEK_MODEL_MAP, normalized)) {
    return { channel: 'deepseek', model: normalized };
  }

  // 未知模型
  throw new Error(
    `未知模型: ${normalized}。可用模型: ${Object.keys(DEEPSEEK_MODEL_MAP).join(', ')}`
  );
}
