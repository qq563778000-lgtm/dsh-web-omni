import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createChunkTranslator,
  isDoneMarker,
  mapFinishReason,
  splitSseBuffer,
  translateOmniStream,
} from '../lib/sse.js';

// ---------------------------------------------------------------------------
// SSE 协议映射：每处偏差都会表现为"模型答非所问"或"用不了工具"，
// 因此逐条锁住。
// ---------------------------------------------------------------------------

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('splitSseBuffer 只按空行切分，保留跨分片残余', () => {
  const { events, rest } = splitSseBuffer('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c"');
  assert.deepEqual(events, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, 'data: {"c"');
});

test('splitSseBuffer 兼容 CRLF 换行', () => {
  const { events } = splitSseBuffer('data: {"a":1}\r\n\r\n');
  assert.deepEqual(events, ['{"a":1}']);
});

test('splitSseBuffer 忽略注释与空事件', () => {
  const { events } = splitSseBuffer(': keep-alive\n\ndata: {"a":1}\n\n');
  assert.deepEqual(events, ['{"a":1}']);
});

test('isDoneMarker 识别结束标记', () => {
  assert.equal(isDoneMarker('[DONE]'), true);
  assert.equal(isDoneMarker(' [DONE] '), true);
  assert.equal(isDoneMarker('{"a":1}'), false);
});

test('mapFinishReason 映射终止原因', () => {
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' });
  assert.deepEqual(mapFinishReason('length'), { kind: 'max-tokens' });
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' });
  assert.deepEqual(mapFinishReason(undefined), { kind: 'stop' });
});

test('正文增量映射为 text-delta，并先开块', () => {
  const t = createChunkTranslator();
  const first = t.push({ choices: [{ delta: { content: '你' } }] });
  assert.deepEqual(first, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你' },
  ]);

  const second = t.push({ choices: [{ delta: { content: '好' } }] });
  assert.deepEqual(second, [{ type: 'text-delta', index: 0, text: '好' }], '同块内不应重复 block-start');
});

test('推理内容映射为 reasoning 块，进入正文时关闭推理块', () => {
  const t = createChunkTranslator();
  const reasoning = t.push({ choices: [{ delta: { reasoning_content: '想一想' } }] });
  assert.deepEqual(reasoning, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '想一想' },
  ]);

  const text = t.push({ choices: [{ delta: { content: '答案' } }] });
  assert.deepEqual(text, [
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '答案' },
  ]);
});

test('同一 chunk 内推理与正文并存时按顺序拆成两个块', () => {
  const t = createChunkTranslator();
  const out = t.push({ choices: [{ delta: { reasoning_content: 'R', content: 'T' } }] });
  assert.deepEqual(out, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'R' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: '' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'T' },
  ]);
});

test('工具调用首片带 id/name，后续片只带参数增量', () => {
  const t = createChunkTranslator();
  const start = t.push({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }] } }],
  });
  assert.deepEqual(start, [
    { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read_file', argumentsDelta: '' },
  ]);

  const more = t.push({
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] } }],
  });
  assert.deepEqual(more, [
    { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: '{"path":"a"}' },
  ]);
});

test('usage 与 finish 在收尾时产出，且顺序固定', () => {
  const t = createChunkTranslator();
  t.push({ choices: [{ delta: { content: 'hi' } }] });
  t.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

  const tail = t.finish();
  assert.deepEqual(tail, [
    { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
});

test('流内错误对象被抛出而非当作文本', () => {
  const t = createChunkTranslator();
  assert.throws(
    () => t.push({ error: { message: 'Pool exhausted', type: 'api_error' } }),
    /Pool exhausted/,
  );
});

test('translateOmniStream 端到端产出完整块序列', async () => {
  const body = streamOf([
    'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"答"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ]);

  const chunks = await collect(translateOmniStream(body));
  const types = chunks.map(chunk => chunk.type);

  assert.deepEqual(types, [
    'block-start', 'reasoning-delta',
    'block-end', 'block-start', 'text-delta',
    'block-end',
    'usage', 'finish',
  ]);
  assert.deepEqual(chunks.at(-2), { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } });
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } });
});

test('translateOmniStream 在缺 [DONE] 时仍收尾', async () => {
  const body = streamOf([
    'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
  ]);
  const chunks = await collect(translateOmniStream(body));
  assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1, '缺 [DONE] 也必须产出 finish');
});

test('translateOmniStream 跳过无法解析的帧而不中断', async () => {
  const body = streamOf([
    'data: not-json\n\n',
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const chunks = await collect(translateOmniStream(body));
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'ok'));
});
