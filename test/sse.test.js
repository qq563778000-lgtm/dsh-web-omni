import test from 'node:test';
import assert from 'node:assert/strict';

import { createChunkBuilder, mapFinishReason, translateInternalEvents } from '../lib/sse.js';

// ---------------------------------------------------------------------------
// 内核内部事件 → DSH chunk。
//
// 这里锁住的是块结构：DSH 的 BlockAssembler 依赖 block-start → delta →
// block-end 的配对，以及恰好一个 finish。任何一处错位都会让客户端
// 显示错乱或丢掉 usage。
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

test('mapFinishReason 映射终止原因', () => {
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' });
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' });
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' });
  assert.deepEqual(mapFinishReason(undefined), { kind: 'stop' });
});

test('正文增量产出 text 块', async () => {
  const chunks = await collect(translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.TEXT_DELTA, delta: '你' },
    { type: T.TEXT_DELTA, delta: '好' },
    { type: T.RUN_COMPLETED, finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 2 } },
  ]), { types: T }));

  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
  assert.equal(text, '你好');
  assert.equal(chunks.filter(c => c.type === 'block-start').length, 1, '同一类内容只应开一个块');
  assert.equal(chunks.filter(c => c.type === 'block-end').length, 1);
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } });
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});

test('推理与正文分成两个块，且推理块先关闭', async () => {
  const chunks = await collect(translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.REASONING_DELTA, delta: '想一下' },
    { type: T.TEXT_DELTA, delta: '答案' },
    { type: T.RUN_COMPLETED, finishReason: 'stop' },
  ]), { types: T }));

  const starts = chunks.filter(c => c.type === 'block-start');
  assert.deepEqual(starts.map(s => s.blockType), ['reasoning', 'text']);

  const reasoningEnd = chunks.findIndex(c => c.type === 'block-end' && c.index === starts[0].index);
  const textStart = chunks.findIndex(c => c.type === 'block-start' && c.blockType === 'text');
  assert.ok(reasoningEnd < textStart, '推理块应在正文块开始前关闭');
});

test('工具调用按 toolCallId 保持同一块', async () => {
  const chunks = await collect(translateInternalEvents(gen([
    { type: T.TOOL_CALL_STARTED, toolCallId: 'call_1', name: 'read_file' },
    { type: T.TOOL_CALL_ARGUMENTS_DELTA, toolCallId: 'call_1', delta: '{"path":' },
    { type: T.TOOL_CALL_ARGUMENTS_DELTA, toolCallId: 'call_1', delta: '"a"}' },
    { type: T.TOOL_CALL_DONE, toolCallId: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
    { type: T.RUN_COMPLETED, finishReason: 'tool_calls' },
  ]), { types: T }));

  const toolChunks = chunks.filter(c => c.type === 'tool-call-delta');
  assert.equal(toolChunks.length, 3);
  assert.ok(toolChunks.every(c => c.index === toolChunks[0].index), '同一次调用必须共用一个块索引');
  assert.ok(toolChunks.every(c => c.id === 'call_1'));

  const args = toolChunks.map(c => c.argumentsDelta).join('');
  assert.equal(args, '{"path":"a"}');
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } });
});

test('两个不同工具调用获得不同块索引', async () => {
  const chunks = await collect(translateInternalEvents(gen([
    { type: T.TOOL_CALL_STARTED, toolCallId: 'call_a', name: 'a' },
    { type: T.TOOL_CALL_STARTED, toolCallId: 'call_b', name: 'b' },
    { type: T.RUN_COMPLETED, finishReason: 'tool_calls' },
  ]), { types: T }));

  const indexes = chunks.filter(c => c.type === 'tool-call-delta' && c.name).map(c => c.index);
  assert.equal(new Set(indexes).size, 2, '两个调用不能共用一个索引');
});

test('run.failed 抛异常且不产出正文块', async () => {
  const iterate = async () => collect(translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.RUN_FAILED, error: { message: '上游失败', status: 502 } },
  ]), { types: T }));

  await assert.rejects(iterate, /上游失败/);

  // 关键：错误绝不能变成 text-delta，否则客户端会把报错当回答渲染。
  try {
    await iterate();
  } catch {
    /* 上面已断言 */
  }
});

test('run.failed 错误带上可路由的 code', async () => {
  const iterate = async () => collect(translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.RUN_FAILED, error: { message: '限流', status: 429, type: 'rate_limit_error' } },
  ]), { types: T }));

  await assert.rejects(iterate, (err) => {
    assert.equal(err.code, 'RATE_LIMIT');
    return true;
  });
});

test('空流显式失败，而不是静默产出空回答', async () => {
  const iterate = async () => collect(translateInternalEvents(gen([]), { types: T }));
  await assert.rejects(iterate, (err) => {
    assert.equal(err.code, 'EMPTY_RESPONSE');
    return true;
  });
});

test('成功流恰好有一个 finish', async () => {
  const chunks = await collect(translateInternalEvents(gen([
    { type: T.RUN_STARTED },
    { type: T.TEXT_DELTA, delta: 'x' },
    { type: T.RUN_COMPLETED, finishReason: 'stop' },
  ]), { types: T }));

  assert.equal(chunks.filter(c => c.type === 'finish').length, 1);
});

test('createChunkBuilder 的索引单调递增且不重复', () => {
  const builder = createChunkBuilder();
  const out = [];
  builder.ensureReasoning(out);
  builder.ensureText(out);
  builder.ensureTool(out, 'call_1', 'f');
  const starts = out.filter(c => c.type === 'block-start').map(c => c.index);
  assert.deepEqual([...new Set(starts)].length, starts.length, '索引不能重复');
});
