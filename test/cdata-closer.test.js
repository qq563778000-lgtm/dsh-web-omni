import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptPlan } from '../kernel/core/prompt-strategy.js';

/**
 * CDATA 闭合符写错时的容错。
 *
 * 真实故障（2026-11-02 DSH，tool-failures-2026-11-02.jsonl 原文）：
 *
 *   <args_json><![CDATA[{"description":"…","command":"…"}]}></args_json>
 *                                                    ↑ 这里少一个 ]
 *
 * 模型把闭合符写成 `]}>`（`]` 与 `>` 之间误插了一个 `}`），随后又补上
 * 正确的 `]]>`，于是整段内容变成：
 *
 *   {"description":"…","command":"…"}]}>
 *
 * JSON 因此非法。解析器两次重试全部失败，报
 * 「工具调用格式无法解析（syntax_error，已重试 2 次）」，整轮对话终止。
 *
 * 关键点：`/\]\]>/` 能匹配到末尾那对 `]]>`，所以**被误写的 `}]}>` 会被
 * 当成参数内容吞掉**——只在"完全匹配失败"的兜底分支里清理是没用的，
 * 标准分支同样是必经之路。
 */

const TOOLS = [{
  type: 'function',
  function: {
    name: 'pwsh',
    description: '执行命令',
    parameters: {
      type: 'object',
      properties: { description: { type: 'string' }, command: { type: 'string' } },
    },
  },
}];

function plan() {
  return createPromptPlan({
    req: { messages: [{ role: 'user', content: 'hi' }], model: 'deepseek-flash' },
    tools: TOOLS,
    toolChoice: 'auto',
  });
}

function wrap(argsJsonBody) {
  return `<Function_Start/>
<function_calls>
  <function_call>
    <tool>pwsh</tool>
    <args_json>${argsJsonBody}</args_json>
  </function_call>
</function_calls>`;
}

/** 实机原文（`]}>` 之后又补了 `]]>`）。 */
const REAL_BODY = '<![CDATA[{"description":"列出工作目录内容并检查 git 状态",'
  + '"command":"Get-ChildItem -Force | Format-Table -AutoSize"}]}>]]>';

test('实机形态：CDATA 写成 ]}>]]> 仍能解析', () => {
  const result = plan().parseToolCallsDetailed(wrap(REAL_BODY));

  assert.equal(result.failureType, null, `不应判为失败：${result.errorDetails}`);
  assert.equal(result.toolCalls.length, 1);

  const args = JSON.parse(result.toolCalls[0].function.arguments);
  assert.equal(args.description, '列出工作目录内容并检查 git 状态');
  assert.match(args.command, /Get-ChildItem/);
});

test('各种闭合符写法都能解析出相同参数', () => {
  const body = '{"description":"d","command":"c"}';
  const variants = {
    '正确 ]]>': `<![CDATA[${body}]]>`,
    '少一个 ] 变成 ]}>]]>': `<![CDATA[${body}]}>]]>`,
    '只有 ]}>': `<![CDATA[${body}]}>`,
    '多余 ]]]>': `<![CDATA[${body}]]]>`,
    '没有 CDATA': body,
  };

  for (const [label, text] of Object.entries(variants)) {
    const result = plan().parseToolCallsDetailed(wrap(text));
    assert.equal(result.failureType, null, `${label}：解析失败 ${result.errorDetails}`);
    assert.equal(result.toolCalls.length, 1, `${label}：调用数不对`);
    assert.deepEqual(
      JSON.parse(result.toolCalls[0].function.arguments),
      { description: 'd', command: 'c' },
      `${label}：参数被污染`,
    );
  }
});

test('修复不会吃掉参数里真实存在的 ] 和 }', () => {
  // 命令里带 PowerShell 数组下标与哈希表，尾部字符必须是内容的一部分。
  const args = { description: '测试', command: '$a[0]; if($x){$y}' };
  const text = wrap(`<![CDATA[${JSON.stringify(args)}]]>`);
  const result = plan().parseToolCallsDetailed(text);

  assert.equal(result.failureType, null, `解析失败：${result.errorDetails}`);
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), args);
});

test('多调用批次中每条都独立修复', () => {
  const text = `<Function_Start/>
<function_calls>
  <function_call>
    <tool>pwsh</tool>
    <args_json><![CDATA[{"command":"a"}]}>]]></args_json>
  </function_call>
  <function_call>
    <tool>pwsh</tool>
    <args_json><![CDATA[{"command":"b"}]]></args_json>
  </function_call>
</function_calls>`;

  const result = plan().parseToolCallsDetailed(text);
  assert.equal(result.failureType, null, `解析失败：${result.errorDetails}`);
  assert.equal(result.toolCalls.length, 2);
  assert.deepEqual(
    result.toolCalls.map(c => JSON.parse(c.function.arguments).command),
    ['a', 'b'],
  );
});
