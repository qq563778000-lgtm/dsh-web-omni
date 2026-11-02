import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptPlan } from '../kernel/core/prompt-strategy.js';

/**
 * ask / agent 两种对话模式的提示词行为。
 *
 * 需求：ask 模式"仅支持问答，不支持工具调用；agent 模式可用全部工具"。
 *
 * 实现选择：ask 模式**不向上游声明任何工具**，而不是"声明了但禁止调用"。
 *
 * 为什么不做成后者：DeepSeek Web 端只要收到工具声明，就会按工具协议组织
 * 输出，模型仍可能写出一段调用标记。那种"禁止"只能在解析层丢弃——token
 * 已经花在拼调用上了，作答质量反而下降。完全不声明，模型才真正进入
 * 纯对话状态。
 *
 * 这组测试锁住的就是这条边界：ask 模式下 tools 为空、triggerSignal 为
 * null、toolInstructions 为空、流式检测器不启用。
 */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read',
      description: '读文件',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pwsh',
      description: '执行命令',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  },
];

function planFor(tools) {
  return createPromptPlan({
    req: { messages: [{ role: 'user', content: '你好' }], model: 'deepseek-flash' },
    tools,
    toolChoice: 'auto',
  });
}

test('agent 模式：工具全部声明，并注入工具说明与触发信号', () => {
  const plan = planFor(TOOLS);

  assert.equal(plan.toolCallingEnabled, true);
  assert.equal(plan.tools.length, 2);
  assert.ok(plan.triggerSignal, 'agent 模式应有触发信号');
  assert.ok(plan.toolInstructions.length > 0, 'agent 模式应注入工具说明');
  assert.ok(plan.createStreamDetector(), 'agent 模式应启用流式工具检测');
});

test('ask 模式（tools 置空）：不声明工具、不注入说明、不启用检测器', () => {
  // 适配器在 ask 模式下传入的就是空数组。
  const plan = planFor([]);

  assert.equal(plan.toolCallingEnabled, false);
  assert.deepEqual(plan.tools, []);
  assert.equal(plan.triggerSignal, null, 'ask 模式不应有触发信号');
  assert.equal(plan.toolInstructions, '', 'ask 模式不应注入工具说明');
  assert.equal(plan.createStreamDetector(), null, 'ask 模式不应启用流式工具检测');
});

test('ask 模式下模型输出的调用标记不会被当成工具调用', () => {
  // 即便模型"习惯性"吐了一段调用，也不能被执行——ask 是纯对话。
  const plan = planFor([]);
  const text = '<Function_Start/>\n<function_calls><function_call>'
    + '<tool>read</tool><args_json>{"path":"a"}</args_json>'
    + '</function_call></function_calls>';

  const result = plan.parseToolCallsDetailed(text);
  assert.equal(result.toolCalls, null, 'ask 模式不应产出任何工具调用');
});

test('ask 模式下工具说明不会出现在提示词里', () => {
  const plan = planFor([]);
  // toolInstructions 为空是唯一入口：runner 用它拼完整 prompt。
  assert.equal(plan.toolInstructions, '');

  const agentPlan = planFor(TOOLS);
  assert.notEqual(agentPlan.toolInstructions, '', '对照：agent 模式必须有说明');
});
