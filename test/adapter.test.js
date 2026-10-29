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
