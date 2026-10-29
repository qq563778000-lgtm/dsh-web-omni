/**
 * dsh-llm-omni — 把本地 OmniAPI 注册为 DSH 的 LLM 路由
 *
 * 装载后 DSH 的模型选择器里会多出一个 `omni` 来源，模型列表直接取自
 * OmniAPI 的 /v1/models（含上下文长度与能力声明）。
 *
 * 本插件不持有任何上游凭据：只转发到本地 OmniAPI，鉴权用的 API Key
 * 由 apiKeyEnv 指向的环境变量在请求时解析。
 */

import { OmniAdapter } from './adapter.js';

export const name = 'dsh-llm-omni';

/** 依赖 DSH 的 llm 服务；未装载时不注册任何路由。 */
export const inject = ['llm'];

export { OmniAdapter };

/**
 * 插件入口。
 *
 * 与 dsh-llm-pi-ai 的差异（为什么不复用它）：见 adapter.js 顶部说明。
 *
 * 注册失败不抛出：未配置或 OmniAPI 未启动时，插件应当安静地不提供路由，
 * 而不是让整个 DSH profile 加载失败——那会让用户连别的模型也用不了。
 */
export function apply(ctx, config = {}) {
  const adapter = new OmniAdapter(config);
  const providerId = adapter.providerId;

  try {
    ctx.llm.registerAdapter([providerId], adapter);
  } catch (err) {
    ctx.logger?.warn?.(`dsh-llm-omni: 无法注册 provider "${providerId}"：${err?.message || err}`);
    return;
  }

  ctx.logger?.info?.(`dsh-llm-omni: 已注册 provider "${providerId}"`);
}
