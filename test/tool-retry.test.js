import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TOOL_RETRIES,
  attemptToolParseWithRetry,
  getToolContinuationPrompt,
  isLargeFileWriteTruncation,
  stripUpstreamTruncationMarker,
} from '../kernel/core/tool-retry.js';

/**
 * 工具调用格式失败后的重试机制。
 *
 * 需求（2026-11-03 用户）：上游输出无法被解析时，把上游输出重新发给上游，
 * 让它校验并给出正确的输出，最多 2 次。
 *
 * 这套机制本来就有，但**一直没有测试覆盖**，因此藏着两个真实缺陷：
 *
 *   1. 配置"重试 2 次"，实际只重新请求了 1 次，却上报 attempts=2；
 *   2. 大文件写入截断时，首轮与次轮发的是同一份提示词，模型重复同样的
 *      "想一次写完"，必然再次截断。
 *
 * 这组测试把两处都锁住。
 */

/** 构造一个最小的 promptPlan 桩：永远解析失败，失败类型可控。 */
function makePlan({ failureType = 'truncated', tools = [] } = {}) {
  return {
    toolCallingEnabled: true,
    promptInjectionDisabled: false,
    triggerSignal: '<Function_Start/>',
    tools,
    parseToolCallsDetailed: () => ({ toolCalls: null, failureType }),
  };
}

const WRITE_TOOLS = [
  { type: 'function', function: { name: 'write', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'edit', parameters: { type: 'object' } } },
];

/**
 * 造一段"写大文件被截断"的原文：超长 + **停在 JSON 字符串中间**。
 *
 * 关键是末尾不能再有闭合引号——真实截断就发生在参数值写到一半时，
 * 所以 `"content":"` 开头的那个引号没有对应的结束引号。引号总数为奇数，
 * 才能让 isLargeFileWriteTruncation 判定为"正在写某个参数的值"。
 */
function makeTruncatedWrite() {
  return '<Function_Start/>\n<function_calls>\n<function_call>\n<tool>write</tool>\n'
    + '<args_json><![CDATA[{"file_path":"a.js","content":"'
    + 'x'.repeat(12000);
}

test('maxAttempts 的语义是"实际重新请求上游的次数"', async () => {
  // 真实缺陷（2026-11-03）：循环用 `attempt >= maxAttempts - 1` 提前放弃，
  // maxAttempts=2 时只调了 1 次上游，却回报 attempts=2。
  let upstreamCalls = 0;
  const result = await attemptToolParseWithRetry({
    content: makeTruncatedWrite(),
    messages: [],
    promptPlan: makePlan({ tools: WRITE_TOOLS }),
    retryToolRequest: async () => { upstreamCalls += 1; return 'still broken'; },
    retryEnabled: true,
    maxAttempts: 2,
  });

  assert.equal(upstreamCalls, 2, 'maxAttempts=2 必须真的重新请求 2 次上游');
  assert.equal(result.attempts, 2, '上报的重试次数必须与实际调用一致');
  assert.equal(result.toolCalls, null);
});

test('maxAttempts=1 时只重新请求一次', async () => {
  let upstreamCalls = 0;
  await attemptToolParseWithRetry({
    content: makeTruncatedWrite(),
    messages: [],
    promptPlan: makePlan({ tools: WRITE_TOOLS }),
    retryToolRequest: async () => { upstreamCalls += 1; return 'still broken'; },
    retryEnabled: true,
    maxAttempts: 1,
  });
  assert.equal(upstreamCalls, 1);
});

test('重试成功后不再继续请求', async () => {
  let upstreamCalls = 0;
  const plan = makePlan({ tools: WRITE_TOOLS });
  // 第一次解析失败，重试一次后解析成功。
  let parseCount = 0;
  plan.parseToolCallsDetailed = () => {
    parseCount += 1;
    return parseCount >= 2
      ? { toolCalls: [{ name: 'write', arguments: '{}' }] }
      : { toolCalls: null, failureType: 'truncated' };
  };

  const result = await attemptToolParseWithRetry({
    content: makeTruncatedWrite(),
    messages: [],
    promptPlan: plan,
    retryToolRequest: async () => { upstreamCalls += 1; return 'fixed'; },
    retryEnabled: true,
    maxAttempts: 2,
  });

  assert.equal(upstreamCalls, 1, '成功之后不应再浪费一次上游调用');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.attempts, 1);
});

test('重试被禁用时不调用上游', async () => {
  let upstreamCalls = 0;
  const result = await attemptToolParseWithRetry({
    content: makeTruncatedWrite(),
    messages: [],
    promptPlan: makePlan({ tools: WRITE_TOOLS }),
    retryToolRequest: async () => { upstreamCalls += 1; return 'x'; },
    retryEnabled: false,
    maxAttempts: 2,
  });
  assert.equal(upstreamCalls, 0);
  assert.equal(result.attempts, 0);
});

// ---------------------------------------------------------------------------
// 大文件写入截断：从"建议分段"升级为"硬性上限"
// ---------------------------------------------------------------------------

test('识别出大文件写入截断', () => {
  assert.equal(isLargeFileWriteTruncation(makeTruncatedWrite(), WRITE_TOOLS), true);
  // 没有写入工具 → 不是这类场景
  assert.equal(isLargeFileWriteTruncation(makeTruncatedWrite(), []), false);
  // 太短 → 更像格式问题
  assert.equal(isLargeFileWriteTruncation('x'.repeat(100), WRITE_TOOLS), false);
});

test('第 1 次重试用 4000 字符预算，不做升级施压', () => {
  const prompt = getToolContinuationPrompt(makeTruncatedWrite(), 'err', WRITE_TOOLS, { attempt: 1 });
  assert.match(prompt, /分段写入/, '应走分段写入策略');
  assert.match(prompt, /4000 字符以内/, '首轮预算 4000');
  assert.doesNotMatch(prompt, /已经是第/, '首轮不该有"又失败了"的施压');
});

test('第 2 次重试收紧到 1500 字符，并明确告知已失败过', () => {
  // 为什么必须升级：真实故障（2026-11-03）里模型把整份 18,811 字符的
  // data.js 塞进一次调用。同一份提示词再发一遍，它仍会"想一次写完"。
  const prompt = getToolContinuationPrompt(makeTruncatedWrite(), 'err', WRITE_TOOLS, { attempt: 2 });
  assert.match(prompt, /1500 字符以内/, '次轮必须收紧预算');
  assert.match(prompt, /已经是第 2 次重试/, '必须点明这是又一次失败');
  assert.match(prompt, /硬性上限/, '预算必须是硬约束而非建议');
  assert.doesNotMatch(prompt, /4000 字符以内/, '不得再出现更宽松的旧预算');
});

test('不传 attempt 时按首轮处理（向后兼容）', () => {
  const prompt = getToolContinuationPrompt(makeTruncatedWrite(), 'err', WRITE_TOOLS);
  assert.match(prompt, /4000 字符以内/);
});

// ---------------------------------------------------------------------------
// 上游截断标记必须剥离
// ---------------------------------------------------------------------------

test('剥掉上游追加的 INCOMPLETE 标记', () => {
  // 上游在撞上输出上限时会在末尾追加这个词（2026-11-03 实测原文末尾：
  // `return list.sort((a, b) => (a.dateINCOMPLETE`）。
  assert.equal(
    stripUpstreamTruncationMarker('const a = [1,2].sort((x,y) => x-yINCOMPLETE'),
    'const a = [1,2].sort((x,y) => x-y',
  );
  assert.equal(stripUpstreamTruncationMarker('abc INCOMPLETE  '), 'abc');
});

test('正文中间正常出现的 INCOMPLETE 不受影响', () => {
  const text = 'const status = "INCOMPLETE"; // 这是业务词汇，不是截断标记';
  assert.equal(stripUpstreamTruncationMarker(text), text);
});

test('提示词里不留上游截断标记', () => {
  const truncated = makeTruncatedWrite().replace(/"\}]$/, 'INCOMPLETE');
  const prompt = getToolContinuationPrompt(truncated, 'err', WRITE_TOOLS, { attempt: 1 });
  assert.doesNotMatch(prompt, /INCOMPLETE/, '标记进入提示词会让模型误以为那是自己写的代码');
});

test('默认重试次数为 2', () => {
  assert.equal(MAX_TOOL_RETRIES, 2, '用户要求最多重试 2 次');
});
