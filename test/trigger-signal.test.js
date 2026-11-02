import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptPlan, FIXED_TRIGGER_SIGNAL } from '../kernel/core/prompt-strategy.js';

/**
 * 触发信号的容错匹配。
 *
 * 协议里的信号是 `<Function_Start/>`，但模型实际输出会走样。2026-11-02
 * 实机样本（session-7085899a，turn 1 step 7）整条正文就是：
 *
 *     "\n\n<function_Start/>\n"
 *
 * 只差一个字母的大小写。旧的严格 `startsWith` 因此判为"没有触发信号"，
 * 这几个字符被当作正文推给客户端并写进会话历史；工具调用虽然事后被
 * late recovery 救回，标记却已经留在上下文里，后续每轮都被模型看到。
 *
 * 这里锁住三件事：大小写、斜杠前的空白、分片切断。
 */

const TOOLS = [{
  type: 'function',
  function: {
    name: 'pwsh',
    description: '执行命令',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
}];

const CALL_BLOCK = '<function_calls><function_call><tool>pwsh</tool>'
  + '<args_json><![CDATA[{"command":"echo hi"}]]></args_json>'
  + '</function_call></function_calls>';

function plan() {
  return createPromptPlan({
    req: { messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-flash' },
    tools: TOOLS,
    toolChoice: 'auto',
  });
}

/** 复刻 runner 的消费方式：parseFailure 时只发出缓冲前的部分。 */
function consume(text, chunkSize) {
  const detector = plan().createStreamDetector();
  let visible = '';
  let toolCalls = [];

  const prefixBefore = (processed) => {
    const delta = processed?.delta || '';
    const buffered = processed?.bufferedToolText || '';
    if (!delta || !buffered) return delta;
    return delta.endsWith(buffered) ? delta.slice(0, delta.length - buffered.length) : delta;
  };

  for (let i = 0; i < text.length; i += chunkSize) {
    const result = detector.process(text.slice(i, i + chunkSize));
    visible += result.parseFailure ? prefixBefore(result) : (result.delta || '');
    if (result.toolCalls?.length) toolCalls = result.toolCalls;
  }
  const finished = detector.finish();
  visible += finished.parseFailure ? prefixBefore(finished) : (finished.delta || '');
  if (finished.toolCalls?.length) toolCalls = finished.toolCalls;

  return { visible, toolCalls };
}

test('协议里的信号原样可用', () => {
  const { visible, toolCalls } = consume(`说明文字。\n\n${FIXED_TRIGGER_SIGNAL}\n${CALL_BLOCK}`, 1);
  assert.equal(toolCalls.length, 1);
  assert.equal(visible, '说明文字。\n\n');
});

test('大小写走样（实机形态）不再泄漏进正文', () => {
  // 实机原文大小写：function_Start
  const text = `说明文字。\n\n<function_Start/>\n${CALL_BLOCK}`;
  for (const size of [1, 3, 4, 7, 150]) {
    const { visible, toolCalls } = consume(text, size);
    assert.equal(toolCalls.length, 1, `分片 ${size}：工具调用丢失`);
    assert.ok(!/function_Start/i.test(visible), `分片 ${size}：信号泄漏到正文 ${JSON.stringify(visible)}`);
    assert.equal(visible, '说明文字。\n\n', `分片 ${size}：正文内容不符`);
  }
});

test('斜杠前带空白的信号同样被识别', () => {
  for (const signal of ['<Function_Start />', '<Function_Start\t/>', '<Function_Start   />']) {
    for (const size of [1, 3, 4, 150]) {
      const { visible, toolCalls } = consume(`说明。\n\n${signal}\n${CALL_BLOCK}`, size);
      assert.equal(toolCalls.length, 1, `${signal} 分片 ${size}：工具调用丢失`);
      assert.equal(visible, '说明。\n\n', `${signal} 分片 ${size}：正文含多余字符 ${JSON.stringify(visible)}`);
    }
  }
});

test('全大写信号也能识别', () => {
  const { visible, toolCalls } = consume(`说明。\n\n<FUNCTION_START/>\n${CALL_BLOCK}`, 1);
  assert.equal(toolCalls.length, 1);
  assert.equal(visible, '说明。\n\n');
});

test('分片把信号切成两段时先缓冲，不抢先输出', () => {
  // 逐字符分片是最严苛的情形：每个前缀都会单独过一次判定。
  const text = `说明。\n\n<Function_Start/>\n${CALL_BLOCK}`;
  for (let cut = 1; cut < FIXED_TRIGGER_SIGNAL.length; cut++) {
    const { visible } = consume(text, 1);
    assert.ok(!visible.includes('<'), `逐字符分片在信号第 ${cut} 处泄漏：${JSON.stringify(visible)}`);
  }
});

test('正文里恰好出现的相似字符串不被误判为工具调用', () => {
  // 不是信号、也没有调用块：应当原样作为正文。
  const text = '函数 Function_Start 只是一个词，不是标记。';
  const { visible, toolCalls } = consume(text, 4);
  assert.equal(toolCalls.length, 0);
  assert.equal(visible, text);
});
