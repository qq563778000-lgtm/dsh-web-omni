import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInstructions, toInternalMessages } from '../lib/adapter.js';

/**
 * ask 模式下压制工具行为的指令，以及消息转换的健壮性。
 *
 * 背景（2026-11-02 DSH 实机）：
 * DSH 在每个请求里注入一段 system prompt，里面逐条写死了工具使用规则
 * （"Use the read tool…"、"Use the glob tool…"）。这段 system 由宿主注入，
 * 插件既不能删也不能改。
 *
 * 只把 tools 清空并不够——实测模型仍会罗列 188 个工具的分类清单，随后
 * 吐出一段 DSML 调用。因此在 ask 模式下额外追加一段反向指令。
 *
 * 同时修掉一个通用缺陷：content 为字符串时会被转成空消息。
 */

test('字符串 content 不会被丢弃', () => {
  const converted = toInternalMessages([
    { role: 'user', content: 'Python 里 list 和 tuple 的区别？' },
  ]);

  assert.equal(converted.length, 1);
  assert.equal(converted[0].content, 'Python 里 list 和 tuple 的区别？',
    'content 为字符串时必须原样保留，不能变成空串');
});

test('块数组形式的 content 行为不变', () => {
  const converted = toInternalMessages([
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
  ]);

  assert.equal(converted[0].content, '你好');
});

test('system/developer 的字符串 content 也会折进 instructions', () => {
  const instructions = buildInstructions('顶层 system', [
    { role: 'developer', content: '字符串形式的开发者指令' },
    { role: 'user', content: '问题' },
  ]);

  assert.match(instructions.developer, /顶层 system/);
  assert.match(instructions.developer, /字符串形式的开发者指令/);
});

test('工具的 args_json 等块不会被误当成正文', () => {
  const converted = toInternalMessages([
    { role: 'user', content: [{ type: 'text', text: '执行' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我来执行' },
        { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{"command":"ls"}' },
      ],
    },
  ]);

  assert.equal(converted[0].content, '执行');
  assert.equal(converted[1].content, '我来执行');
  assert.equal(converted[1].toolCalls.length, 1);
  assert.equal(converted[1].toolCalls[0].name, 'pwsh');
});
