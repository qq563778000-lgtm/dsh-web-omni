import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptPlan, dsmlCallsOpenAt } from '../kernel/core/prompt-strategy.js';

/**
 * DeepSeek 原生 DSML 工具调用标记的解析。
 *
 * 这组测试锁住的是**两种语法混用**时的行为。上游模型经常把两套标记拼在
 * 一起：外层用官方 DSML 的 `<｜｜DSML｜｜ calls>`，内层却退回本项目的
 * `<function_call><tool>…</tool><args_json>…`。
 *
 * 2026-11-02 实机故障：解析器只认 DSML 形态的闭合标签，遇到
 * `</function_calls>` 就判定"仍在续传"，把整段标记一直缓冲；流结束时
 * 缓冲未被认领，最终作为正文发给用户——界面上出现的就是那堆尖括号，
 * 而工具调用丢失、任务卡死。
 */

const TOOLS = [{
  type: 'function',
  function: {
    name: 'skill',
    description: '加载技能',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
}];

function plan(tools = TOOLS) {
  return createPromptPlan({
    req: { messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-flash' },
    tools,
    toolChoice: 'auto',
  });
}

/** 实机原样输出（会话 session-36f30075，step 7）。 */
const MIXED_DIALECT = [
  '环境齐备（Node 24 / Python 3.13 / pnpm）。接下来按规范用真实浏览器做可行性验证。',
  '',
  '<｜｜DSML｜｜ calls>',
  '  <function_call>',
  '    <tool>skill</tool>',
  '    <args_json><![CDATA[{"name":"web-access"}]]></args_json>',
  '  </function_call>',
  '</function_calls>',
].join('\n');

const NATIVE_DIALECT = [
  '<｜｜DSML｜｜ calls>',
  '<｜｜DSML｜｜ invoke name="skill">',
  '<｜｜DSML｜｜ parameter name="name" string="true">web-access</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜ invoke>',
  '</｜｜DSML｜｜ calls>',
].join('\n');

test('混合方言：DSML 外壳 + 标准 function_call 内层可解析', () => {
  const result = plan().parseToolCallsDetailed(MIXED_DIALECT);

  assert.equal(result.failureType, null, `不应判为失败：${result.errorDetails}`);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].function.name, 'skill');
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { name: 'web-access' });
  // 工具块之前的说明文字仍然保留，作为正文展示。
  assert.match(result.content, /可行性验证/);
});

test('原生方言：invoke/parameter 保持可用', () => {
  const result = plan().parseToolCallsDetailed(NATIVE_DIALECT);

  assert.equal(result.failureType, null, `不应判为失败：${result.errorDetails}`);
  assert.equal(result.toolCalls.length, 1);
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { name: 'web-access' });
});

test('两种内层写法并存时全部解析，不静默丢调用', () => {
  const text = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="skill">',
    '<｜｜DSML｜｜ parameter name="name" string="true">a</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '<function_call><tool>skill</tool><args_json><![CDATA[{"name":"b"}]]></args_json></function_call>',
    '</｜｜DSML｜｜ calls>',
  ].join('\n');

  const result = plan().parseToolCallsDetailed(text);

  assert.equal(result.failureType, null, `不应判为失败：${result.errorDetails}`);
  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(
    result.toolCalls.map(call => JSON.parse(call.function.arguments).name),
    ['a', 'b'],
    '调用顺序应与输出顺序一致',
  );
});

test('流式中途仍是 truncated，不得提前判定为格式错误', () => {
  // 未闭合时若返回 syntax_error，检测器会立刻把已缓冲的原文当正文推出。
  const partials = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ calls>\n  <function_call>',
    '<｜｜DSML｜｜ calls>\n  <function_call>\n    <tool>skill</tool>',
    MIXED_DIALECT.replace(/\n<\/function_calls>$/, ''),
  ];
  for (const text of partials) {
    const result = plan().parseToolCallsDetailed(text);
    assert.equal(result.failureType, 'truncated', `未闭合却被判为 ${result.failureType}：${JSON.stringify(text)}`);
    assert.equal(result.toolCalls, null);
  }
});

test('流式检测器拦下标记，正文不泄漏尖括号', () => {
  for (const size of [1, 2, 3, 7, 40, 150]) {
    const detector = plan().createStreamDetector();
    let emitted = '';
    let toolCalls = [];

    for (let i = 0; i < MIXED_DIALECT.length; i += size) {
      const result = detector.process(MIXED_DIALECT.slice(i, i + size));
      assert.ok(!result.parseFailure, `分片 ${size} 在 offset ${i} 误判失败：${result.errorDetails}`);
      emitted += result.delta || '';
      if (result.toolCalls?.length) toolCalls = result.toolCalls;
    }
    const finished = detector.finish();
    emitted += finished.delta || '';
    if (finished.toolCalls?.length) toolCalls = finished.toolCalls;

    assert.ok(!emitted.includes('DSML'), `分片 ${size}：标记泄漏到正文`);
    assert.ok(!emitted.includes('｜｜'), `分片 ${size}：标记泄漏到正文`);
    assert.equal(toolCalls.length, 1, `分片 ${size}：工具调用丢失`);
    assert.match(emitted, /可行性验证/, `分片 ${size}：说明文字应保留`);
  }
});

test('dsmlCallsOpenAt 只在开标签完整时命中', () => {
  assert.equal(dsmlCallsOpenAt('<｜｜DSML｜｜ calls>', 0), true);
  assert.equal(dsmlCallsOpenAt('|<|DSML|>', 0), false);
  // 分片中途：半截标签不能判命中，否则后续半截会漏过拦截。
  assert.equal(dsmlCallsOpenAt('<｜｜DSML｜｜ call', 0), false);
});
