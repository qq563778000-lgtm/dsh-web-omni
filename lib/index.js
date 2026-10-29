/**
 * dsh-llm-omni — 把 OmniAPI 的转发能力内嵌进 DSH
 *
 * 装完即用：安装后在 DSH 设置页填入上游 DeepSeek 账号（或 Token），
 * 模型选择器里就能选到 `omni`。不需要另外启动 OmniAPI、不需要填服务地址。
 *
 * 本插件不把上游凭据透出到 DSH 配置或日志：
 * 凭据只存在于插件自己的数据目录（<DSH_HOME>/plugin-data/dsh-llm-omni）。
 */

import { OmniAdapter } from './adapter.js';
import { configure, initializeKernel, kernelStatus } from './runtime.js';
import { ROUTES } from './routes.js';

export const name = 'dsh-llm-omni';

/** 依赖 DSH 的 llm 服务。 */
export const inject = ['llm'];

export { OmniAdapter };

/**
 * 插件入口。
 *
 * 时序很重要：先注册路由，再在后台初始化凭据池。
 *
 * 为什么不能让 apply() 等待初始化：initTokenPool 会登录上游，耗时数秒到
 * 数十秒。若在 apply 中 await，DSH 的整个插件加载会被阻塞，表现为
 * "启动卡住"。而模型目录不依赖网络（模型是内核固定项），所以注册可以
 * 立刻完成——用户打开模型选择器就能看到 omni，首次对话时再等池就绪。
 */
export function apply(ctx, config = {}) {
  // 先记录配置：适配器构造与内核加载都可能早于 initializeKernel，
  // 它们都需要知道数据目录，三条路径必须共用同一份来源。
  configure(config);

  const adapter = new OmniAdapter(config);
  const providerId = adapter.providerId;

  try {
    ctx.llm.registerAdapter([providerId], adapter);
  } catch (err) {
    ctx.logger?.warn?.(`dsh-llm-omni: 无法注册 provider "${providerId}"：${err?.message || err}`);
    return;
  }

  ctx.logger?.info?.(`dsh-llm-omni: 已注册 provider "${providerId}"`);

  // 后台初始化，不阻塞插件加载。
  initializeKernel(config).then((result) => {
    if (result.ok) {
      ctx.logger?.info?.('dsh-llm-omni: 凭据池已就绪');
    } else {
      ctx.logger?.warn?.(`dsh-llm-omni: 凭据池初始化未完成（${result.error?.message || result.error}），请在设置中检查账号`);
    }
  });

  // 设置页需要的运行时状态（凭据可用性/禁用原因）不在配置里，
  // 只能通过本机 HTTP 端点提供。dsh-proxy 等插件也是这个做法。
  ctx.inject?.(['webServer'], (serverCtx) => {
    serverCtx.effect?.(
      () => ROUTES.map(route => serverCtx.webServer.register(route)),
      'dsh-llm-omni: settings endpoints',
    );
  });

  return { adapter, status: kernelStatus };
}
