import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptPlan } from '../kernel/core/prompt-strategy.js';

/**
 * 首轮提示词里的"大文件写入必须分段"规则。
 *
 * 真实故障（2026-11-03 DSH）：模型把整份 18,811 字符的 data.js 塞进 write
 * 的 content 参数，撞上上游输出上限被截断（末尾带 INCOMPLETE），整条工具
 * 调用作废。两次重试都失败。
 *
 * 根因不是"重试不够强"，而是**首轮提示词里根本没有这条规则**——它只说了
 * "读大文件要分段"，从没说过"写大文件要分段"。模型没有理由自己想到。
 *
 * 这组测试锁住三件事：
 *   1. 有写入工具时，首轮就必须注入分段规则；
 *   2. 阈值必须是**具体数字**（"太长"对模型没有可操作性）；
 *   3. 没有 edit 工具时要有可行的降级方案，而不是给一条走不通的路。
 */

const WRITE = {
  type: 'function',
  function: {
    name: 'write',
    description: '写文件',
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } },
  },
};
const EDIT = {
  type: 'function',
  function: {
    name: 'edit',
    description: '改文件',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
    },
  },
};
const READ = {
  type: 'function',
  function: { name: 'read', description: '读文件', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
};

function instructionsFor(tools) {
  const plan = createPromptPlan({
    req: { messages: [{ role: 'user', content: '写个文件' }], model: 'deepseek-flash' },
    tools,
    toolChoice: 'auto',
  });
  return plan.toolInstructions;
}

test('有写入工具时，首轮就注入分段规则', () => {
  const text = instructionsFor([WRITE, EDIT]);
  assert.match(text, /大文件写入：必须分段/, '首轮必须有这条规则，不能等截断后再补');
});

test('阈值是具体数字，不是"太长"', () => {
  const text = instructionsFor([WRITE, EDIT]);
  const match = text.match(/控制在 (\d+) 字符以内/);
  assert.ok(match, '必须给出具体字符数');
  const budget = Number(match[1]);
  // 实测上游单次输出在 18,811 / 19,069 字符处被截断，阈值必须留足余量。
  assert.ok(budget > 0 && budget <= 15000, `预算 ${budget} 应显著低于实测上限 19000`);
});

test('要求动手前估算，而不是写完才发现', () => {
  const text = instructionsFor([WRITE, EDIT]);
  assert.match(text, /动手前先估算/, '必须在写之前判断体量');
  assert.match(text, /超过 \d+ 字符.*必须拆成多次调用/s, '超过阈值要给明确动作');
});

test('明确禁止"试试看能不能一次写完"', () => {
  // 这是模型最容易犯的：它倾向于一次输出完整内容，觉得"应该能塞下"。
  const text = instructionsFor([WRITE, EDIT]);
  assert.match(text, /不要抱着.*一次写完/s);
});

test('给出可执行的分段写法：首段 write、后续 edit 追加', () => {
  const text = instructionsFor([WRITE, EDIT]);
  assert.match(text, /第 1 次 write/, '要有第一段的具体动作');
  assert.match(text, /第 2 次起用 edit/, '要有后续段的具体动作');
  assert.match(text, /锚点/, '要说明如何在文件里定位追加位置');
});

test('提醒 JSON 转义会让占用变大', () => {
  // 换行要写成字面的反斜杠 + n（两个字符），不提醒就会算错预算。
  const text = instructionsFor([WRITE, EDIT]);
  assert.match(text, /换行要写成 \\n/, '应提醒换行要转义');
  assert.match(text, /1\.3 倍/, '应给出转义放大的经验系数');
});

test('没有 edit 工具时，给出可行的降级方案', () => {
  const text = instructionsFor([WRITE, READ]);
  assert.match(text, /大文件写入：必须分段/, '仍要有规则');
  // 不能推荐不存在的工具
  assert.doesNotMatch(text, /第 2 次起用 edit/, '不得推荐未提供的工具');
  // write 是整文件覆盖，必须说清"只能再追加 1 次"，否则第二段就会超限
  assert.match(text, /只能再追加 1 次/);
  assert.match(text, /拆分到多个文件/, '超限时要给出真正的出路');
});

test('没有写入工具时，不注入这条规则', () => {
  const text = instructionsFor([READ]);
  assert.doesNotMatch(text, /大文件写入：必须分段/, '只读场景不该出现写入规则');
});

test('规则里引用的工具名都真实存在', () => {
  const text = instructionsFor([WRITE, EDIT]);
  // 分段规则只允许提到实际提供的 write / edit
  const section = text.slice(text.indexOf('大文件写入：必须分段'));
  assert.doesNotMatch(section, /\bwrite_file\b/, '不得提到未提供的工具');
});
