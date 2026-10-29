import test from 'node:test';
import assert from 'node:assert/strict';

import { createChunkBuilder, translateInternalEvents } from '../lib/sse.js';
import { normalizeOutputTokens } from '../lib/adapter.js';

// ---------------------------------------------------------------------------
// 块内容完整性 + usage 口径
//
// 这里锁住两个只在实机才暴露的缺陷：
//   1. block-end 不带内容 → DSH 的 BlockAssembler 会用空串覆盖累积文本，
//      表现为"流一直在走，但客户端不显示正文"。
//   2. outputTokens 口径与 DSH 的 decodeMs 不匹配 → tok/s 虚高。
// ---------------------------------------------------------------------------

const T = {
  RUN_STARTED: 'run.started',
  MESSAGE_STARTED: 'message.started',
  TEXT_DELTA: 'content.text.delta',
  REASONING_DELTA: 'reasoning.delta',
  TOOL_CALL_STARTED: 'tool_call.started',
  TOOL_CALL_ARGUMENTS_DELTA: 'tool_call.arguments.delta',
  TOOL_CALL_DONE: 'tool_call.done',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
};

async function* gen(items) {
  for (const item of items) yield item;
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('block-end 必须携带累积的正文，而不是空串', async () => {
  const chunks = await collect(translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.TEXT_DELTA, delta: '你好' },
    { type: T.TEXT_DELTA, delta: '世界' },
    { type: T.RUN_COMPLETED, finishReason: 'stop' },
  ]), { types: T }));

  const end = chunks.find(c => c.type === 'block-end' && c.block.type === 'text');
  assert.ok(end, '应存在 text 块的 block-end');
  // DSH 的 BlockAssembler 收到 block-end 时会用 chunk.block 整体替换累积内容，
  // 这里必须是完整文本，否则客户端拿到的正文为空。
  assert.equal(end.block.text, '你好世界');
});

test('block-end 携带累积的推理内容', async () => {
  const chunks = await collect(translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.REASONING_DELTA, delta: '想' },
    { type: T.REASONING_DELTA, delta: '一下' },
    { type: T.RUN_COMPLETED, finishReason: 'stop' },
  ]), { types: T }));

  const end = chunks.find(c => c.type === 'block-end' && c.block.type === 'reasoning');
  assert.ok(end);
  assert.equal(end.block.text, '想一下');
});

test('工具块 block-end 携带完整 id/name/arguments', async () => {
  const chunks = await collect(translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.TOOL_CALL_STARTED, toolCallId: 'call_1', name: 'read_file' },
    { type: T.TOOL_CALL_ARGUMENTS_DELTA, toolCallId: 'call_1', delta: '{"path":' },
    { type: T.TOOL_CALL_ARGUMENTS_DELTA, toolCallId: 'call_1', delta: '"a.js"}' },
    { type: T.TOOL_CALL_DONE, toolCallId: 'call_1', name: 'read_file', arguments: '{"path":"a.js"}' },
    { type: T.RUN_COMPLETED, finishReason: 'tool_calls' },
  ]), { types: T }));

  const end = chunks.find(c => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.ok(end, '工具块必须有 block-end，否则 DSH 视为未闭合');
  assert.equal(end.block.id, 'call_1');
  assert.equal(end.block.name, 'read_file');
  assert.equal(end.block.arguments, '{"path":"a.js"}');
});

test('推理与正文同时存在时，两个块各自带上自己的内容', async () => {
  const chunks = await collect(translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.REASONING_DELTA, delta: '推理内容' },
    { type: T.TEXT_DELTA, delta: '正文内容' },
    { type: T.RUN_COMPLETED, finishReason: 'stop' },
  ]), { types: T }));

  const ends = chunks.filter(c => c.type === 'block-end');
  const reasoning = ends.find(e => e.block.type === 'reasoning');
  const text = ends.find(e => e.block.type === 'text');

  assert.equal(reasoning?.block.text, '推理内容');
  assert.equal(text?.block.text, '正文内容');
});

test('失败路径先发出已累积的块，再抛错', async () => {
  const chunks = [];
  let thrown = null;
  try {
    for await (const c of translateInternalEvents(gen([
      { type: T.RUN_STARTED },
      { type: T.TEXT_DELTA, delta: '部分输出' },
      { type: T.RUN_FAILED, error: { message: '中断' } },
    ]), { types: T })) chunks.push(c);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, '失败必须抛错而不是静默结束');
  const end = chunks.find(c => c.type === 'block-end' && c.block.type === 'text');
  assert.equal(end?.block.text, '部分输出', '已产出的内容仍应完整交给客户端');
});

test('normalizeOutputTokens 在口径正常时不改动', () => {
  // 500 字 ≈ 312 token，上报 280 属于正常范围
  const out = normalizeOutputTokens({ inputTokens: 10, outputTokens: 280 }, 500);
  assert.equal(out.outputTokens, 280);
  assert.equal(out.inputTokens, 10);
});

test('normalizeOutputTokens 收敛明显偏大的上报值', () => {
  // 100 字最多约 62 token，上报 500 明显失真
  const out = normalizeOutputTokens({ inputTokens: 10, outputTokens: 500 }, 100);
  assert.equal(out.outputTokens, 63);
});

test('normalizeOutputTokens 在无产出时保留原值', () => {
  const out = normalizeOutputTokens({ inputTokens: 5, outputTokens: 99 }, 0);
  assert.equal(out.outputTokens, 99);
});

test('translateInternalEvents 通过 normalizeUsage 校正 usage', async () => {
  const chunks = await collect(translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.TEXT_DELTA, delta: '短' },
    { type: T.RUN_COMPLETED, finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 900 } },
  ]), {
    types: T,
    normalizeUsage: (usage, chars) => normalizeOutputTokens(usage, chars),
  }));

  const usage = chunks.find(c => c.type === 'usage')?.usage;
  assert.ok(usage, '必须有 usage 块');
  assert.ok(usage.outputTokens < 100, `应被收敛到合理范围，实际 ${usage.outputTokens}`);
});

test('createChunkBuilder 累积内容独立于块索引', () => {
  const b = createChunkBuilder();
  const out = [];
  b.ensureText(out);
  b.appendText('abc');
  b.closeText(out);
  b.ensureReasoning(out);
  b.appendReasoning('xyz');
  b.closeReasoning(out);

  const ends = out.filter(c => c.type === 'block-end');
  assert.equal(ends[0].block.text, 'abc');
  assert.equal(ends[1].block.text, 'xyz');
  // 关闭后应清空缓冲，避免下一个块继承旧内容
  assert.equal(ends[0].index !== ends[1].index, true);
});

// ---------------------------------------------------------------------------
// 用 DSH 真实的 BlockAssembler 验证端到端组装结果。
//
// 这一层是之前缺失的：单元测试只检查"我发了什么 chunk"，
// 而 DSH 真正消费的是"组装后得到什么块"。block-end 覆盖内容的缺陷
// 正是在这一层才暴露——chunk 全对，组装结果却是空的。
// ---------------------------------------------------------------------------

let BlockAssembler = null;
try {
  ({ BlockAssembler } = await import('@deepseek-ai/dsh-llm'));
} catch {
  BlockAssembler = null;
}

const skipAssembler = BlockAssembler === null ? '未安装 @deepseek-ai/dsh-llm' : false;

test('DSH BlockAssembler 能组装出完整正文', { skip: skipAssembler }, async () => {
  const asm = new BlockAssembler();
  for await (const chunk of translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.TEXT_DELTA, delta: '你好' },
    { type: T.TEXT_DELTA, delta: '世界' },
    { type: T.RUN_COMPLETED, finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } },
  ]), { types: T })) {
    asm.push(chunk);
  }

  const blocks = asm.blocks();
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], { type: 'text', text: '你好世界' });
  assert.deepEqual(asm.usage, { inputTokens: 10, outputTokens: 5 });
  assert.deepEqual(asm.finish, { kind: 'stop' });
});

test('DSH BlockAssembler 能区分推理与正文', { skip: skipAssembler }, async () => {
  const asm = new BlockAssembler();
  for await (const chunk of translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.REASONING_DELTA, delta: '思考' },
    { type: T.TEXT_DELTA, delta: '答案' },
    { type: T.RUN_COMPLETED, finishReason: 'stop' },
  ]), { types: T })) {
    asm.push(chunk);
  }

  const blocks = asm.blocks();
  assert.deepEqual(blocks, [
    { type: 'reasoning', text: '思考' },
    { type: 'text', text: '答案' },
  ]);
});

test('DSH BlockAssembler 能还原完整工具调用', { skip: skipAssembler }, async () => {
  const asm = new BlockAssembler();
  for await (const chunk of translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.TOOL_CALL_STARTED, toolCallId: 'call_1', name: 'read_file' },
    { type: T.TOOL_CALL_ARGUMENTS_DELTA, toolCallId: 'call_1', delta: '{"path":"a.js"}' },
    { type: T.TOOL_CALL_DONE, toolCallId: 'call_1', name: 'read_file', arguments: '{"path":"a.js"}' },
    { type: T.RUN_COMPLETED, finishReason: 'tool_calls' },
  ]), { types: T })) {
    asm.push(chunk);
  }

  const blocks = asm.blocks();
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'tool-call');
  assert.equal(blocks[0].id, 'call_1');
  assert.equal(blocks[0].name, 'read_file');
  assert.equal(blocks[0].arguments, '{"path":"a.js"}');
  assert.deepEqual(asm.finish, { kind: 'tool-calls' });
});
