/**
 * DSH 插件兼容性评估。
 *
 * 逐项核对插件与宿主之间的契约面：凡是宿主会读、调用、或按名字引用的
 * 地方，改动都可能造成"别的 DSH 版本加载即失败"。这里把契约显式列出来，
 * 配合测试作为发布前的闸门。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { OmniAdapter, toGeneration, toInternalMessages, buildInstructions, toInternalTools } from '../lib/adapter.js';
import { mapFinishReason, translateInternalEvents } from '../lib/sse.js';

const indexSrc = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const adapterSrc = readFileSync(new URL('../lib/adapter.js', import.meta.url), 'utf8');
const sseSrc = readFileSync(new URL('../lib/sse.js', import.meta.url), 'utf8');

test('插件入口导出面完整', () => {
  // DSH 通过插件的具名导出加载。少一个就是加载失败。
  assert.match(indexSrc, /export const name\s*=/, '需导出 name');
  assert.match(indexSrc, /export const inject\s*=/, '需导出 inject');
  assert.match(indexSrc, /export function apply\s*\(/, '需导出 apply');
  assert.match(indexSrc, /export \{ OmniAdapter \}/, '需导出 OmniAdapter');
});

test('适配器实现 DSH 要求的全部契约方法', () => {
  const adapter = new OmniAdapter({});
  // 这几个方法 DSH 的 LlmRuntime 会直接调用，缺一个整条路由注册就失败。
  for (const method of [
    'providerInfo', 'providerRetryPolicy', 'imageRequestPricing',
    'listModels', 'resolveModel', 'prepareCall', 'stream',
  ]) {
    assert.equal(typeof adapter[method], 'function', `缺少契约方法 ${method}`);
  }
});

test('listModels 满足 DSH 目录校验', async () => {
  const adapter = new OmniAdapter({ providerId: 'dsh-web-omni' });
  const models = await adapter.listModels('dsh-web-omni');

  assert.ok(Array.isArray(models) && models.length > 0, '应返回至少一个模型');
  for (const model of models) {
    assert.equal(model.provider, 'dsh-web-omni', 'provider 必须等于注册路由');
    assert.equal(typeof model.id, 'string');
    assert.equal(typeof model.name, 'string');
    assert.ok(model.name.length > 0, 'name 不得为空');
    assert.ok(Array.isArray(model.inputModalities), 'inputModalities 必须是数组');
  }
});

test('resolveModel 满足 normalizeModelInfo 校验', async () => {
  const adapter = new OmniAdapter({ providerId: 'dsh-web-omni' });
  const info = await adapter.resolveModel('dsh-web-omni', 'deepseek-flash');

  assert.equal(info.provider, 'dsh-web-omni');
  assert.equal(info.id, 'deepseek-flash');
  assert.ok(info.name && info.name.length > 0, 'name 不得为空');
  assert.ok(info.context && typeof info.context.contextWindow === 'number', 'context.contextWindow 必须是数字');
  assert.ok(typeof info.defaultMaxTokens === 'number', 'defaultMaxTokens 必须是数字');
  assert.ok(Array.isArray(info.reasoning.efforts), 'reasoning.efforts 必须是数组');
  assert.ok(info.reasoning.efforts.length > 0, 'efforts 为空会抛 INVALID_MODEL_REASONING');
  for (const effort of info.reasoning.efforts) {
    assert.ok(effort.id && typeof effort.id === 'string', '档位 id 必须是字符串');
    assert.ok(effort.name && effort.name.length > 0, '档位 name 不得为空');
  }
  const ids = info.reasoning.efforts.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, '档位 id 不得重复');
});

test('思考档位只有关闭与深度思考', async () => {
  const adapter = new OmniAdapter({ providerId: 'dsh-web-omni' });
  const info = await adapter.resolveModel('dsh-web-omni', 'deepseek-flash');

  assert.deepEqual(info.reasoning.efforts.map(e => e.id), ['off', 'high']);
  assert.deepEqual(info.reasoning.efforts.map(e => e.name), ['关闭思考', '深度思考']);
});

test('未知档位不会被当成关闭思考', () => {
  // DSH 不校验 ReasoningEffortId 取值，客户端缓存里的旧档位（medium /
  // xhigh / max）可能仍会被送来。这些必须仍视为"开启思考"，
  // 否则用户选了思考却得到一个基于残缺上下文的回答。
  for (const id of ['medium', 'xhigh', 'max', 'unknown', 'HIGH']) {
    assert.equal(toGeneration(id).reasoning.enabled, true, `${id} 应视为开启思考`);
  }
  assert.equal(toGeneration('off').reasoning.enabled, false);
});

test('消息转换保持既有形态', () => {
  const converted = toInternalMessages([
    { role: 'system', content: [{ type: 'text', text: 'sys' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
  ]);
  assert.equal(converted.length, 2, 'system 不进 messages');
  assert.equal(converted[0].content, 'hi');
  assert.equal(converted[1].content, 'yo');
});

test('tool-call 块还原为 toolCalls', () => {
  const converted = toInternalMessages([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '跑一下' },
        { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' },
      ],
    },
  ]);
  assert.equal(converted[0].toolCalls.length, 1);
  assert.equal(converted[0].toolCalls[0].name, 'read');
});

test('tool 消息保留 toolCallId', () => {
  const converted = toInternalMessages([
    { role: 'tool', content: [{ type: 'text', text: '结果' }], toolCallId: 'c1' },
  ]);
  assert.equal(converted[0].toolCallId, 'c1');
});

test('instructions 承载 system 与 developer', () => {
  const instructions = buildInstructions('顶层 system', [
    { role: 'developer', content: [{ type: 'text', text: '开发者指令' }] },
    { role: 'user', content: [{ type: 'text', text: '问题' }] },
  ]);
  assert.match(instructions.developer, /顶层 system/);
  assert.match(instructions.developer, /开发者指令/);
  assert.doesNotMatch(instructions.developer, /问题/, '用户消息不应进 instructions');
});

test('工具声明保持 OpenAI 形态', () => {
  const tools = toInternalTools([
    { name: 'read', description: '读文件', parameters: { type: 'object', properties: {} } },
  ]);
  assert.equal(tools[0].type, 'function');
  assert.equal(tools[0].function.name, 'read');
  assert.equal(tools[0].function.description, '读文件');
});

test('终止原因映射覆盖 DSH 期望的取值', () => {
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' });
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' });
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' });
});

test('chunk 结构满足 DSH BlockAssembler 契约', async () => {
  // DSH 用 BlockAssembler 增量组装：block-start → delta → block-end，
  // 且恰好一个 finish。结构错了界面会显示空白。
  async function* events() {
    yield { type: 'content.text.delta', delta: 'hello' };
    yield { type: 'run.completed', usage: { inputTokens: 1, outputTokens: 2 } };
  }
  const T = {
    RUN_STARTED: 'run.started', MESSAGE_STARTED: 'message.started',
    TEXT_DELTA: 'content.text.delta', REASONING_DELTA: 'reasoning.delta',
    TOOL_CALL_STARTED: 'tool_call.started', TOOL_CALL_ARGUMENTS_DELTA: 'tool_call.arguments.delta',
    TOOL_CALL_DONE: 'tool_call.done', RUN_COMPLETED: 'run.completed', RUN_FAILED: 'run.failed',
  };

  const chunks = [];
  for await (const chunk of translateInternalEvents(events(), { types: T })) chunks.push(chunk);

  const finishes = chunks.filter(c => c.type === 'finish');
  assert.equal(finishes.length, 1, '必须恰好一个 finish');
  assert.ok(chunks.some(c => c.type === 'block-start'), '应有 block-start');
  assert.ok(chunks.some(c => c.type === 'block-end'), '应有 block-end');
  const end = chunks.find(c => c.type === 'block-end');
  assert.equal(end.block.text, 'hello', 'block-end 必须带上完整文本（DSH 会用它替换累积值）');
});

test('run.failed 以异常结束且不产出正文块', async () => {
  async function* events() {
    yield { type: 'run.failed', error: { message: '上游挂了', type: 'api_error', code: 'X' } };
  }
  const T = {
    RUN_STARTED: 'run.started', MESSAGE_STARTED: 'message.started',
    TEXT_DELTA: 'content.text.delta', REASONING_DELTA: 'reasoning.delta',
    TOOL_CALL_STARTED: 'tool_call.started', TOOL_CALL_ARGUMENTS_DELTA: 'tool_call.arguments.delta',
    TOOL_CALL_DONE: 'tool_call.done', RUN_COMPLETED: 'run.completed', RUN_FAILED: 'run.failed',
  };

  const chunks = [];
  await assert.rejects(async () => {
    for await (const chunk of translateInternalEvents(events(), { types: T })) chunks.push(chunk);
  });
  assert.equal(chunks.filter(c => c.type === 'text-delta').length, 0, '失败时不应产出正文');
});

test('插件不依赖 DSH 未公开的内部接口', () => {
  // 只用 ctx.llm.registerAdapter / ctx.inject / ctx.logger 这些稳定入口。
  assert.doesNotMatch(indexSrc, /require\(['"]@deepseek-ai\/dsh-(?!llm)/, '不应直接依赖其它内部包');
  assert.doesNotMatch(adapterSrc, /from '\.\.\/kernel\/.*internal/, '不应越过 lib/ 直接依赖内核内部路径');
});
