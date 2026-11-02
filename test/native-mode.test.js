import test from 'node:test';
import assert from 'node:assert/strict';

import { isHostInjection, toNativeConversation } from '../lib/adapter.js';
import { createPromptPlan } from '../kernel/core/prompt-strategy.js';
import { buildNativePrompt } from '../kernel/utils/response-utils.js';

/**
 * ask 模式 = 原生对话。
 *
 * 需求（2026-11-02 用户澄清）：「ask 就是原生的，仅仅只把用户 [User] 对话
 * 发送给上游即可，不带 [System] 等其他内容」。
 *
 * 这与"禁用工具"是两回事。DSH 实际会在请求里夹带大量非对话内容，
 * 实测合计约 25K 字符：
 *
 *   system 消息            约 5.7K  —— 编码助手身份 + 工具使用规则
 *   <system-reminder>      约 7.7K  —— 技能清单
 *   <hindsight_knowledge>  约 7.1K  —— 知识库注入
 *   Current runtime context 约 0.7K —— 工作目录、文件策略
 *   Time sampled …         约 0.3K  —— 时间戳
 *
 * ask 模式下这些必须全部不发。判据不能只看 role：上面后四项都挂在
 * **user 角色**下，只过滤 system 是不够的。
 */

const NOISE_MESSAGES = [
  { role: 'system', content: [{ type: 'text', text: 'You are a coding assistant. Use the read tool.' }] },
  { role: 'user', content: [{ type: 'text', text: 'Current runtime context. Working directory: C:\\test.' }] },
  { role: 'user', content: [{ type: 'text', text: '<system-reminder>Available skills: tdd</system-reminder>' }] },
  { role: 'user', content: [{ type: 'text', text: '<hindsight_knowledge>Repo knowledge base</hindsight_knowledge>' }] },
  { role: 'user', content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-02' }] },
  { role: 'user', content: [{ type: 'text', text: '<hindsight_knowledge_refresh>Reminder</hindsight_knowledge_refresh>' }] },
];

test('识别宿主注入：各类前缀都算', () => {
  for (const prefix of [
    '<system-reminder>',
    '<hindsight_knowledge>',
    '<hindsight_knowledge_refresh>',
    '<available_skills>',
    'Current runtime context.',
    'Time sampled while preparing turn',
  ]) {
    assert.equal(isHostInjection(`${prefix} 内容`), true, `${prefix} 应判为注入`);
  }
  assert.equal(isHostInjection('你好，帮我写个函数'), false);
  assert.equal(isHostInjection(''), false);
});

test('净化后只剩用户真实对话', () => {
  const messages = [
    ...NOISE_MESSAGES,
    { role: 'user', content: [{ type: 'text', text: '生成一个本地text文件' }] },
  ];

  const native = toNativeConversation(messages);

  assert.equal(native.length, 1, '6 条注入 + 1 条真实输入，应只剩 1 条');
  assert.equal(native[0].role, 'user');
  assert.match(native[0].content, /生成一个本地text文件/);
});

test('assistant 历史保留，这是真实对话内容', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '你好！有什么可以帮你？' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ];

  const native = toNativeConversation(messages);
  assert.equal(native.length, 3);
  assert.deepEqual(native.map(m => m.role), ['user', 'assistant', 'user']);
});

test('注入块夹在正文中间时剥掉，只留正文', () => {
  const messages = [{
    role: 'user',
    content: [{
      type: 'text',
      text: '帮我看看这段代码\n\n<system-reminder>技能清单</system-reminder>\n\n有没有问题',
    }],
  }];

  const native = toNativeConversation(messages);
  assert.equal(native.length, 1);
  assert.match(native[0].content, /帮我看看这段代码/);
  assert.match(native[0].content, /有没有问题/);
  assert.doesNotMatch(native[0].content, /system-reminder/);
  assert.doesNotMatch(native[0].content, /技能清单/);
});

test('原生 prompt 不带 [User]: 这类角色前缀', () => {
  const prompt = buildNativePrompt([
    { role: 'user', content: [{ type: 'text', text: '第一个问题' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第一个回答' }] },
    { role: 'user', content: [{ type: 'text', text: '第二个问题' }] },
  ]);

  assert.equal(prompt, '第一个问题\n\n第一个回答\n\n第二个问题');
  assert.doesNotMatch(prompt, /\[User\]|\[Assistant\]/);
});

test('nativePrompt 计划：无工具、无说明、无触发信号', () => {
  const plan = createPromptPlan({
    req: { nativePrompt: true, messages: [], model: 'x' },
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
  });

  assert.equal(plan.nativePrompt, true);
  assert.equal(plan.toolCallingEnabled, false);
  assert.deepEqual(plan.tools, []);
  assert.equal(plan.triggerSignal, null);
  assert.equal(plan.toolInstructions, '');
  assert.equal(plan.createStreamDetector(), null);
});

test('普通模式不受影响：nativePrompt 默认为 false', () => {
  const plan = createPromptPlan({ req: { messages: [], model: 'x' }, tools: [] });
  assert.equal(plan.nativePrompt, false);
});
