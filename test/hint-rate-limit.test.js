import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSSEStream } from '../kernel/utils/sse.js';

/**
 * 上游 `event: hint` 事件的解析。
 *
 * 真实故障（2026-11-02 DSH，session-df8e50bf）：上游对「消息发送过于频繁」
 * 返回的是这样一段**只有 281 字节**的流：
 *
 *   event: ready
 *   data: {"request_message_id":3,"response_message_id":4,"model_type":"default"}
 *
 *   event: hint
 *   data: {"type":"error","content":"消息发送过于频繁，请稍后重试",
 *          "clear_response":true,"finish_reason":"rate_limit_reached"}
 *
 *   event: close
 *   data: {"click_behavior":"retry","auto_resume":false}
 *
 * 旧实现只认 `event: close`，把 `event: hint` 整行跳过。于是这条流
 * "什么内容都没产出"——runner 判为空流，报「上游返回空响应」，并把该
 * 凭据记一次错误。用户看到的是一个与真实原因毫不相干的报错，任务当场
 * 终止，只能手动重发。
 *
 * 这组测试锁住：hint 必须被识别成 error，并且带上限流语义。
 */

/** 把文本包成一个 ReadableStream，供 parseSSEStream 消费。 */
function bodyOf(text, chunkSize = null) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      if (!chunkSize) {
        controller.enqueue(bytes);
        controller.close();
        return;
      }
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

async function collect(text, chunkSize = null) {
  const events = [];
  for await (const event of parseSSEStream(bodyOf(text, chunkSize), {})) {
    events.push(event);
    // done / error 之后流即结束，不再继续读。
    if (event.type === 'done' || event.type === 'error') break;
  }
  return events;
}

/** 实机抓到的限流响应原文。 */
const RATE_LIMIT_STREAM = [
  'event: ready',
  'data: {"request_message_id":3,"response_message_id":4,"model_type":"default"}',
  '',
  'event: hint',
  'data: {"type":"error","content":"消息发送过于频繁，请稍后重试","clear_response":true,"finish_reason":"rate_limit_reached"}',
  '',
  'event: close',
  'data: {"click_behavior":"retry","auto_resume":false}',
  '',
].join('\n');

/** 正常响应原文。 */
const NORMAL_STREAM = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"好"}]}}}',
  '',
  'data: {"p":"status","o":"SET","v":"FINISHED"}',
  '',
].join('\n');

test('event: hint 限流被识别为 error 并带 429 语义', async () => {
  const events = await collect(RATE_LIMIT_STREAM);
  const errors = events.filter(e => e.type === 'error');

  assert.equal(errors.length, 1, '必须产出一个 error 事件，而不是被当成空流');
  assert.equal(errors[0].code, 429, '限流应归到 429，上层才能走退避/换凭据');
  assert.equal(errors[0].fromHint, true);
  assert.match(errors[0].message, /频繁/);
});

test('event: hint 分片到达同样能识别', async () => {
  // 上游按网络分片下发，event 与 data 可能被切在不同块里。
  for (const size of [1, 3, 7, 40]) {
    const events = await collect(RATE_LIMIT_STREAM, size);
    const error = events.find(e => e.type === 'error');
    assert.ok(error, `分片 ${size}：hint 未被识别`);
    assert.equal(error.code, 429, `分片 ${size}：code 应为 429`);
  }
});

test('hint 里的非限流错误不强行标成 429', async () => {
  const text = [
    'event: hint',
    'data: {"type":"error","content":"内容涉及敏感信息","finish_reason":"content_filtered"}',
    '',
    'event: close',
    'data: {}',
    '',
  ].join('\n');
  const events = await collect(text);
  const error = events.find(e => e.type === 'error');

  assert.ok(error, 'hint 错误必须被识别');
  assert.notEqual(error.code, 429, '非限流错误不应被当成限流');
  assert.equal(error.fromHint, true);
});

test('正常响应不受 hint 处理影响', async () => {
  const events = await collect(NORMAL_STREAM);
  const content = events.filter(e => e.type === 'content').map(e => e.content).join('');

  assert.equal(content, '好');
  assert.equal(events.filter(e => e.type === 'error').length, 0, '正常响应不应产出 error');
  assert.ok(events.some(e => e.type === 'done'), '正常响应应正常结束');
});

test('event: close 仍然终止解析，不产出多余事件', async () => {
  const text = [
    'event: close',
    'data: {"click_behavior":"retry"}',
    '',
    'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"这段不该出现"}]}}}',
    '',
  ].join('\n');
  const events = await collect(text);
  const content = events.filter(e => e.type === 'content').map(e => e.content).join('');

  assert.equal(content, '');
});
