import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OmniAdapter,
  buildInstructions,
  toGeneration,
  toInternalMessages,
  toInternalTools,
} from '../lib/adapter.js';

// ---------------------------------------------------------------------------
// 消息与请求组装：这些映射错一处，模型就会"看不到上下文"或"用不了工具"。
// ---------------------------------------------------------------------------

test('system 与 developer 折进 instructions，不留在 messages 里', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: '规则A' }] },
    { role: 'developer', content: [{ type: 'text', text: '本回合指令' }] },
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
  ];

  const instructions = buildInstructions('显式 system', messages);
  assert.match(instructions.developer, /显式 system/);
  assert.match(instructions.developer, /规则A/);
  assert.match(instructions.developer, /本回合指令/);

  const converted = toInternalMessages(messages);
  assert.equal(converted.length, 1, 'system/developer 不应出现在 messages');
  assert.deepEqual(converted[0], { role: 'user', content: '你好' });
});

test('tool 消息保留 toolCallId', () => {
  const converted = toInternalMessages([
    { role: 'user', content: [{ type: 'text', text: '读文件' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '内容' }] },
  ]);

  const assistant = converted.find(m => m.role === 'assistant');
  assert.deepEqual(assistant.toolCalls, [{
    id: 'call_1',
    type: 'function',
    name: 'read_file',
    arguments: '{"path":"a"}',
  }], 'assistant 的工具调用必须还原，否则下一轮会退化成纯文本历史');

  const tool = converted.find(m => m.role === 'tool');
  assert.equal(tool.toolCallId, 'call_1', '缺 toolCallId 会被上游拒绝整条请求');
  assert.equal(tool.content, '内容');
});

test('含图片的消息产出多模态内容数组', () => {
  const converted = toInternalMessages([{
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  }]);

  const content = converted[0].content;
  assert.ok(Array.isArray(content));
  assert.deepEqual(content[0], { type: 'text', text: '看图' });
  assert.equal(content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('纯文本消息保持字符串形式', () => {
  const converted = toInternalMessages([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  assert.equal(converted[0].content, 'hi', '纯文本用字符串可少一层解析');
});

test('toInternalTools 映射为 OpenAI 工具声明', () => {
  const tools = toInternalTools([{ name: 'read_file', description: '读文件', parameters: { type: 'object' } }]);
  assert.deepEqual(tools[0], {
    type: 'function',
    function: { name: 'read_file', description: '读文件', parameters: { type: 'object' } },
  });
  assert.deepEqual(toInternalTools(undefined), []);
});

test('toGeneration 把 off 映射为关闭思考', () => {
  assert.deepEqual(toGeneration('off'), { reasoning: { enabled: false, effort: 'off' } });
  assert.deepEqual(toGeneration('high'), { reasoning: { enabled: true, effort: 'high' } });
  assert.deepEqual(toGeneration(undefined), {});
});

test('listModels 不访问网络，且满足 DSH 目录契约', async () => {
  const adapter = new OmniAdapter({ providerId: 'omni' });
  const models = await adapter.listModels('omni');

  assert.equal(models.length, 1);
  assert.equal(models[0].provider, 'omni', 'provider 必须等于注册路由');
  assert.equal(models[0].id, 'deepseek-flash');
  assert.deepEqual(models[0].inputModalities, ['text', 'image']);
});

test('resolveModel 满足 DSH 的 normalizeModelInfo 字段要求', async () => {
  const adapter = new OmniAdapter({ providerId: 'omni', contextWindow: 1048576, maxOutputTokens: 65536 });
  const info = await adapter.resolveModel('omni', 'deepseek-flash');

  assert.equal(info.provider, 'omni');
  assert.equal(info.id, 'deepseek-flash');
  assert.ok(info.name);
  // 上下文必须是嵌套结构；输出上限字段名是 defaultMaxTokens。
  assert.deepEqual(info.context, { contextWindow: 1048576 });
  assert.equal(info.defaultMaxTokens, 65536);
  assert.ok(info.reasoning.efforts.length > 0);
});

test('契约方法 providerRetryPolicy / imageRequestPricing 必须存在', () => {
  const adapter = new OmniAdapter();
  // LlmRuntime.prepareRoutes 会直接调用它们，缺失会让整条路由注册失败。
  assert.equal(typeof adapter.providerRetryPolicy, 'function');
  assert.equal(typeof adapter.imageRequestPricing, 'function');
  assert.equal(adapter.providerRetryPolicy('omni'), undefined);
  assert.equal(adapter.imageRequestPricing('omni', 'm'), undefined);
});

test('stream 在缺少 model 时立即报错', async () => {
  const adapter = new OmniAdapter();
  const iterate = async () => {
    for await (const _ of adapter.stream({ messages: [{ role: 'user', content: [] }] })) { /* 不应产出 */ }
  };
  await assert.rejects(iterate, /缺少 model/);
});

test('stream 在缺少 messages 时立即报错', async () => {
  const adapter = new OmniAdapter();
  const iterate = async () => {
    for await (const _ of adapter.stream({ model: 'deepseek-flash', messages: [] })) { /* 不应产出 */ }
  };
  await assert.rejects(iterate, /缺少 messages/);
});

test('stream 必须使用调用方传入的 model，而不是配置里的固定值', async () => {
  // 真实缺陷（2026-10 实机测试发现）：曾经硬编码 config.modelId，
  // DSH 模型选择器里换成任何模型，实际请求的都是默认模型——用户的选择
  // 完全无效，且不报错，表现为"选什么都没差别"。
  //
  // 行为验证：用一个必然不被内核识别的模型名，若仍走配置值就会成功，
  // 正确实现则应在内层抛错。
  const adapter = new OmniAdapter({ modelId: 'deepseek-flash' });

  const iterate = async () => {
    for await (const _ of adapter.stream({
      model: 'definitely-not-a-real-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) { /* 不应产出 */ }
  };

  await assert.rejects(
    iterate,
    (err) => {
      // 无论哪一层包装，错误信息都应体现模型名，而不是静默用默认模型作答
      assert.match(String(err.message), /not-a-real-model|未知模型|Unknown model/i);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 思考档位：声明全量 7 档，内部映射到上游的开/关
//
// 背景（2026-10）：上游 DeepSeek Web 端只接受 thinking_enabled 布尔值，
// 没有 effort 分级。此前只声明 off/high 两档，导致 DSH 用户无法选择
// low/medium/max 等档位。
//
// DSH 的 ReasoningEffortId 不做取值校验（仅 brandString），efforts 为空
// 数组才抛 INVALID_MODEL_REASONING，所以声明哪些档位由适配器决定。
// ---------------------------------------------------------------------------

test('resolveModel 声明 3 档思考（与主流客户端一致）', async () => {
  const adapter = new OmniAdapter({ providerId: 'omni' });
  const info = await adapter.resolveModel('omni', 'deepseek-flash');

  assert.ok(info.reasoning, '应声明 reasoning');
  // 上游只有 thinking 开/关一个布尔，档位多于实际差异就是虚假的可选性。
  // 保留 off / medium / high 覆盖"不思考 / 常规 / 深度"三种真实选择。
  assert.equal(info.reasoning.efforts.length, 3, '应声明 3 档');
  assert.deepEqual(
    info.reasoning.efforts.map(e => e.id),
    ['off', 'medium', 'high'],
  );
  // 每档都必须有非空 name，否则 DSH 的 normalizeModelInfo 抛 INVALID_MODEL_REASONING
  for (const e of info.reasoning.efforts) {
    assert.ok(typeof e.name === 'string' && e.name.length > 0, `档位 ${e.id} 缺少 name`);
  }
  // id 不得重复（DSH 校验）
  const ids = info.reasoning.efforts.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, '档位 id 不得重复');
});

test('toGeneration 把非 off 档全部映射为开启思考', async () => {
  const { toGeneration } = await import('../lib/adapter.js');

  assert.deepEqual(toGeneration('off'), { reasoning: { enabled: false, effort: 'off' } });
  for (const level of ['medium', 'high']) {
    const g = toGeneration(level);
    assert.equal(g.reasoning.enabled, true, `${level} 应映射为开启思考`);
    assert.equal(g.reasoning.effort, level, 'effort 应原样透传');
  }
});

test('toGeneration 在未指定档位时返回空对象，不覆盖上游默认值', async () => {
  const { toGeneration } = await import('../lib/adapter.js');
  assert.deepEqual(toGeneration(undefined), {});
  assert.deepEqual(toGeneration(null), {});
});
