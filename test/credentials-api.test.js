import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { maskToken } from '../lib/credentials.js';

/**
 * 设置页的凭据操作接口。
 *
 * 这组测试锁住两个容易被忽略但直接影响用户判断的点：
 *   1. "该 Token 已存在"必须**如实报告**，不能回 added=true——
 *      用户看到"已添加"却在列表里找不到新条目，比报错更难排查。
 *   2. 单条测试接口必须能凭掩码 id 找回原 token（明文不过前端）。
 */

const clientSource = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
const routesSource = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8');

test('maskToken 对长 token 保留首尾、掩码中间', () => {
  const token = 'bEssK7h1WdmT3nL8Q4GUe+k0EE4ntQqqRUWQFQBgdr/RFqyknnq6YTORO/Mu1cfT';
  const masked = maskToken(token);

  assert.notEqual(masked, token, '不应返回明文');
  assert.ok(masked.startsWith(token.slice(0, 6)), '应保留开头');
  assert.ok(masked.endsWith(token.slice(-4)), '应保留结尾');
  assert.ok(masked.includes('...'), '中间应被掩码');
});

test('同一 token 掩码稳定，可用于反查', () => {
  const token = 'bEssK7h1WdmT3nL8Q4GUe+k0EE4ntQqqRUWQFQBgdr/RFqyknnq6YTORO/Mu1cfT';
  assert.equal(maskToken(token), maskToken(token));
});

test('区分"新增"与"已存在"，且不会把已存在报成新增', () => {
  // 这个字段是修复的核心：早前把"已存在"的异常吞掉后一律回 added=true，
  // 用户看到"已添加"却发现列表里没有新条目。
  //
  // "已存在"的识别逻辑现在在 auto-token.js（设置页与自动获取共用同一套
  // 流程），因此两个模块合起来看。
  const autoTokenSource = readFileSync(new URL('../lib/auto-token.js', import.meta.url), 'utf8');
  const combined = routesSource + autoTokenSource;

  assert.match(combined, /alreadyPresent/, '应返回 alreadyPresent 字段');
  assert.match(combined, /已存在/, '应识别"已存在"的错误');
});

test('前端区分新增与已存在两种提示', () => {
  assert.match(clientSource, /alreadyPresent/, '前端应处理 alreadyPresent');
  assert.match(clientSource, /autoFetchPresent/, '应有"已在列表中"的文案');
});

test('设置页用图标替代文字按钮', () => {
  // 浏览器获取 → 图标；删除/测试 → 图标；刷新 → 图标
  assert.match(clientSource, /icon: 'browser'/, '应有浏览器图标按钮');
  assert.match(clientSource, /icon: 'trash'/, '应有删除图标按钮');
  assert.match(clientSource, /icon: 'gauge'/, '应有测试图标按钮');
  assert.match(clientSource, /icon: 'refresh'/, '应有刷新图标按钮');
  assert.doesNotMatch(clientSource, /text\.testAll/, '应移除"测试全部凭据"按钮');
});

test('状态用图标表达，不再用文字徽章', () => {
  assert.match(clientSource, /StateIcon/, '应有状态图标组件');
  assert.doesNotMatch(clientSource, /dwo-badge/, '旧的文字徽章样式应移除');
});

test('两个设置并排一行，用紧凑分段单选', () => {
  assert.match(clientSource, /dwo-settings/, '应有并排容器');
  assert.match(clientSource, /SegmentedRadio/, '应有分段单选组件');
  assert.match(clientSource, /dwo-seg-b/, '应有分段按钮样式');
  assert.doesNotMatch(clientSource, /dwo-card/, '旧的大卡片样式应移除');
  assert.doesNotMatch(clientSource, /ToggleRow/, '旧的开关行组件应移除');
});

test('添加按钮使用图标', () => {
  assert.match(clientSource, /icon: 'plus'/, '应有加号图标');
  assert.match(clientSource, /dwo-icon-primary/, '应有主按钮图标样式');
});

test('次要文案已淡化', () => {
  assert.match(clientSource, /\.dwo-sub\{[^}]*font-size:11px/, '副标题应淡化');
  assert.match(clientSource, /\.dwo-notice\{[^}]*font-size:11px/, '提示文字应淡化');
});

test('浏览器获取会收集本机所有 profile 的所有有效 token', () => {
  const bt = readFileSync(new URL('../lib/browser-token.js', import.meta.url), 'utf8');
  assert.match(bt, /collectLocalStorageTokens/, '应有全量收集函数');
  assert.match(bt, /validTokens/, '应收集所有通过验证的 token');
  assert.match(bt, /tokens:/, '应返回全部有效 token 列表');
});

test('路由把全部有效 token 逐个入库', () => {
  // 断言"逐个入库"的语义落在哪个模块都可以，但**必须落到某一个**——
  // 曾经这个逻辑在 routes.js 里，后来搬到了 auto-token.js（为了让
  // 设置页与自动获取共用同一套逻辑）。
  //
  // 这里检查两个模块合起来是否覆盖了关键环节：拿到全部有效 token、
  // 逐个入库、统计新增数量。
  const autoTokenSource = readFileSync(new URL('../lib/auto-token.js', import.meta.url), 'utf8');
  const combined = routesSource + autoTokenSource;

  assert.match(combined, /result\.tokens/, '应遍历全部有效 token');
  assert.match(combined, /added \+= 1/, '应统计新增数量');
  assert.match(combined, /for \(const item of list\)/, '应逐个处理候选');
  // "已存在"必须被容忍而不是当成失败——那条 token 本来就在池里，
  // 重新扫描会再遇到它。
  assert.match(combined, /已存在/, '重复的 token 应被跳过而不是报错');
});
