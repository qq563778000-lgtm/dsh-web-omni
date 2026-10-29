import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * DSH 契约验证。
 *
 * 为什么值得单列：DSH 的 LlmRuntime 对 adapter 返回值有一整套运行时校验
 * （provider 必须等于注册路由、id 必须等于请求 model、context 必须是
 * { contextWindow }、listModels 的 provider 必须匹配……），任何一项不符
 * 都会抛 INVALID_MODEL_INFO / INVALID_CATALOG 让整次调用失败。这些约束
 * 只存在于 dsh-llm 的实现里，不写测试就只能等真实启动时才炸。
 *
 * 若 DSH 未安装（例如 CI），整组跳过而不是失败。
 */

let dsh = null;
let cordis = null;
try {
  dsh = await import('@deepseek-ai/dsh-llm');
  cordis = await import('@deepseek-ai/cordis');
} catch {
  dsh = null;
  cordis = null;
}

const skip = dsh === null ? '未安装 @deepseek-ai/dsh-llm' : false;

import { OmniAdapter } from '../lib/adapter.js';

/**
 * 用真实的 cordis Context 装载 LlmRuntime。
 *
 * 为什么不用手写 fake ctx：cordis 的 Service 构造会读取 ctx.registry 等
 * 内部结构，手写桩很容易"看起来像"却缺字段。真实 Context 能让这里校验
 * 的正是 DSH 实际会执行的路径。
 */
function makeRuntime() {
  const ctx = new cordis.Context();
  const Runtime = dsh.LlmRuntime;
  const runtime = new Runtime(ctx);
  return { ctx, runtime };
}

test('DSH LlmRuntime 能注册本适配器并通过模型发现校验', { skip }, async () => {
  const { runtime } = makeRuntime();
  const adapter = new OmniAdapter({ providerId: 'omni', providerName: 'OmniAPI' });

  // 覆盖网络：直接给适配器喂一份真实形状的 /v1/models 数据。
  // 内嵌版的 listModels 不访问网络，直接使用真实实现。

  runtime.registerAdapter(['omni'], adapter);

  const models = await runtime.listModels('omni');
  assert.equal(models.length, 1);
  assert.equal(models[0].provider, 'omni');
  assert.equal(models[0].id, 'deepseek-flash');
  assert.deepEqual(models[0].inputModalities, ['text', 'image']);
});

test('DSH LlmRuntime 接受本适配器的 resolveModel 结果', { skip }, async () => {
  const { runtime } = makeRuntime();
  const adapter = new OmniAdapter({ providerId: 'omni' });

  adapter.resolveModel = async (provider, model) => ({
    provider: provider ?? 'omni',
    id: model,
    name: 'DeepSeek Flash',
    context: { contextWindow: 1048576 },
    defaultMaxTokens: 65536,
    inputModalities: ['text'],
  });

  runtime.registerAdapter(['omni'], adapter);

  const info = await runtime.resolveModelInfo('omni', 'deepseek-flash');
  assert.equal(info.provider, 'omni');
  assert.equal(info.id, 'deepseek-flash');
  assert.equal(info.context.contextWindow, 1048576);
});

test('providerInfo 的 id 必须与注册路由一致（否则 DSH 拒绝装载）', { skip }, async () => {
  const { runtime } = makeRuntime();
  const adapter = new OmniAdapter({ providerId: 'omni' });

  // 故意返回一个不匹配的 id，DSH 应抛 INVALID_ADAPTER。
  adapter.providerInfo = () => ({ id: 'mismatch', name: 'x' });

  assert.throws(
    () => runtime.registerAdapter(['omni'], adapter),
    /INVALID_ADAPTER|adapter metadata/i,
  );
});
