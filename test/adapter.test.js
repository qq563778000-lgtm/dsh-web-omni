import test from 'node:test';
import assert from 'node:assert/strict';

import { OmniAdapter, buildMessages, buildRequestBody, toDshModel } from '../lib/adapter.js';

// ---------------------------------------------------------------------------
// 消息与请求组装：这些映射错一处，模型就会"看不到上下文"或"用不了工具"。
// ---------------------------------------------------------------------------

test('toDshModel 从 OmniAPI 元数据读取上下文窗口（多别名）', () => {
  const model = toDshModel({
    id: 'deepseek-flash',
    owned_by: 'deepseek',
    context_length: 1048576,
    max_output_tokens: 65536,
    input_modalities: ['text', 'image'],
    capabilities: { thinking: true },
  });

  assert.equal(model.id, 'deepseek-flash');
  // 字段形状受 DSH 契约约束：上下文是嵌套的 context.contextWindow，
  // 输出上限叫 defaultMaxTokens（见 normalizeModelInfo）。
  assert.deepEqual(model.context, { contextWindow: 1048576 });
  assert.equal(model.defaultMaxTokens, 65536);
  assert.deepEqual(model.inputModalities, ['text', 'image']);
  assert.ok(model.reasoning?.efforts?.length > 0, '声明了 thinking 才应开启推理档位');
});

test('toDshModel 回落到 top_provider 与其它别名', () => {
  const model = toDshModel({
    id: 'x',
    top_provider: { context_length: 128000, max_completion_tokens: 8192 },
  });
  assert.deepEqual(model.context, { contextWindow: 128000 });
  assert.equal(model.defaultMaxTokens, 8192);
  assert.equal(model.reasoning, undefined, '未声明思考能力时不应强加推理档位');
});

test('toDshModel 拒绝无 id 的条目', () => {
  assert.equal(toDshModel({}), null);
  assert.equal(toDshModel(null), null);
});

test('buildMessages 把 system 与 developer 折叠为一条 system', () => {
  const messages = buildMessages(
    [
      { role: 'system', content: [{ type: 'text', text: '规则A' }] },
      { role: 'developer', content: [{ type: 'text', text: '本回合指令' }] },
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
    ],
    '显式 system',
  );

  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /显式 system/);
  assert.match(messages[0].content, /规则A/);
  assert.match(messages[0].content, /本回合指令/);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[1], { role: 'user', content: '你好' });
});

test('buildMessages 保留 tool 消息的 tool_call_id', () => {
  const messages = buildMessages([
    { role: 'user', content: [{ type: 'text', text: '读文件' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }],
    },
    {
      role: 'tool',
      toolCallId: 'call_1',
      content: [{ type: 'text', text: '内容' }],
    },
  ]);

  const assistant = messages.find(message => message.role === 'assistant');
  assert.deepEqual(assistant.tool_calls, [{
    id: 'call_1',
    type: 'function',
    function: { name: 'read_file', arguments: '{"path":"a"}' },
  }]);

  const tool = messages.find(message => message.role === 'tool');
  assert.equal(tool.tool_call_id, 'call_1', '缺 tool_call_id 会被上游拒绝整条请求');
  assert.equal(tool.content, '内容');
});

test('buildMessages 对有图片的消息产出多模态数组', () => {
  const messages = buildMessages([{
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  }]);

  const content = messages[0].content;
  assert.ok(Array.isArray(content), '含图片时应为数组');
  assert.deepEqual(content[0], { type: 'text', text: '看图' });
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('buildRequestBody 始终开启流式并携带工具声明', () => {
  const body = buildRequestBody({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: {} } }],
  });

  assert.equal(body.stream, true, 'OmniAPI 拒绝非流式请求');
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[0].function.name, 'read_file');
});

test('providerInfo 与 providerId 可被配置覆盖', () => {
  const adapter = new OmniAdapter({ providerId: 'local', providerName: '本地代理' });
  assert.equal(adapter.providerId, 'local');
  assert.deepEqual(adapter.providerInfo(undefined), { id: 'local', name: '本地代理' });
});

test('stream 在缺少 model 时立即报错而不是发出坏请求', async () => {
  const adapter = new OmniAdapter({ baseURL: 'http://127.0.0.1:1' });
  const iterate = async () => {
    for await (const _ of adapter.stream({ messages: [{ role: 'user', content: [] }] })) { /* 不应产出 */ }
  };
  await assert.rejects(iterate, /missing a model/);
});

test('stream 在连接失败时给出可读错误', async () => {
  const adapter = new OmniAdapter({ baseURL: 'http://127.0.0.1:1', timeoutMs: 2000 });
  const iterate = async () => {
    for await (const _ of adapter.stream({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) { /* 不应产出 */ }
  };
  await assert.rejects(iterate, /transport failed|无法连接/i);
});
