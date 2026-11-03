import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_MODE, MODES, MODE_ASK, MODE_AGENT, normalizeMode, resolveMode } from '../kernel/core/mode.js';

/**
 * 对话模式默认值的一致性。
 *
 * 真实隐患（2026-11-03）：默认值散落在 5 处——内核配置、归一化、适配器
 * 回落、路由读取、前端初始态。每处的"缺省语义"还互相打架（有的缺省
 * ask，有的缺省 agent）。任何一处漏改，用户看到的界面和实际生效的
 * 行为就对不上，而且**没有任何报错**：界面显示 Ask，模型照样收到了
 * 全部工具声明。
 *
 * 这类缺陷无法靠功能测试发现——功能测试只会覆盖被显式写出的那条路径。
 * 必须从"来源唯一"这一结构约束上锁住。
 */

const ROOT = new URL('../', import.meta.url);

test('默认是 ask（原生对话）', () => {
  assert.equal(DEFAULT_MODE, MODE_ASK);
  assert.equal(MODES.length, 2);
  assert.deepEqual(MODES.sort(), ['agent', 'ask']);
});

test('归一化：合法值原样保留', () => {
  assert.equal(normalizeMode('ask'), 'ask');
  assert.equal(normalizeMode('agent'), 'agent');
  assert.equal(normalizeMode('ASK'), 'ask', '应大小写不敏感');
  assert.equal(normalizeMode('  ask  '), 'ask', '应容忍空白');
});

test('归一化：非法值落到默认值，不落到某个"看起来合理"的兜底', () => {
  // 兜底值不同正是这类不一致的根源：非法配置时，各处若各自兜底到
  // 不同值，用户拿到的行为取决于"哪条代码路径先读到"。
  for (const bad of ['', '   ', null, undefined, 'hacker', 'native', 0, {}, []]) {
    assert.equal(normalizeMode(bad), DEFAULT_MODE, `${JSON.stringify(bad)} 应归一化为默认值`);
  }
});

test('归一化后可直接用常量比较', () => {
  // 归一化的保证是：返回值必是合法取值，因此调用方可以直接与常量比较，
  // 不必再判空或再兜底。
  assert.equal(normalizeMode('ask'), MODE_ASK);
  assert.equal(normalizeMode('agent'), MODE_AGENT);
});

/**
 * 结构约束：默认值只能出现在一处。
 *
 * 这条断言是本文件的核心。改默认值时如果只改了内核、忘了适配器或路由，
 * 这里会直接失败——而不是等到用户反馈"开关没作用"。
 */
test('默认值只有一个来源，各处不得写死', () => {
  const files = [
    'kernel/services/config-store.js',
    'kernel/core/mode.js',
    'lib/adapter.js',
    'lib/routes.js',
  ];

  for (const file of files) {
    const source = readFileSync(new URL(file, ROOT), 'utf8');
    // 只允许出现字符串 'ask' / 'agent'（作为合法取值列举），
    // 不允许出现三元表达式里的字面量默认值。
    const hardcodedFallback = /mode\s*===\s*['"]ask['"]\s*\?\s*['"]ask['"]\s*:\s*['"]agent['"]/;
    assert.doesNotMatch(
      source,
      hardcodedFallback,
      `${file} 不得内联"缺省回落到 agent"的判断，应改用 normalizeMode()`,
    );
  }
});

test('配置存储的默认值引用统一常量', () => {
  const source = readFileSync(new URL('kernel/services/config-store.js', ROOT), 'utf8');
  // DEFAULT_CONFIG.runtime.mode 必须引用常量，不能是字面量。
  assert.match(source, /mode:\s*DEFAULT_MODE/, '默认配置应引用 DEFAULT_MODE');
  assert.doesNotMatch(source, /mode:\s*['"](ask|agent)['"]/, '不应把默认值写成字面量');
});

test('适配器与路由都走归一化，不再各自判断', () => {
  const adapter = readFileSync(new URL('lib/adapter.js', ROOT), 'utf8');
  const routes = readFileSync(new URL('lib/routes.js', ROOT), 'utf8');

  assert.match(adapter, /resolveMode\(config\?\.runtime\)/, '适配器应走 resolveMode');
  assert.match(routes, /mode:\s*resolveMode\(runtime\)/, '路由应走 resolveMode');
});

test('前端初始态与服务端默认值一致', () => {
  // 客户端是预打包模块，只能 require('react')，引不进内核常量——
  // 所以这里必须用测试守住两边不漂移。
  const client = readFileSync(new URL('client/client.js', ROOT), 'utf8');
  const match = client.match(/useState\(['"](ask|agent)['"]\)/);
  assert.ok(match, '应能定位前端 mode 初始态');
  assert.equal(match[1], DEFAULT_MODE, '前端初始态必须与服务端默认值一致');
});

// ---------------------------------------------------------------------------
// 迁移语义：默认改了，老用户怎么办？
//
// 难点在于配置写盘时会被整体物化——saveConfig 落盘的是归一化后的完整
// 配置，所以"从没碰过开关"和"明确选了 Agent"在磁盘上逐字节相同。
// 若只按 mode 字段判断，改默认值就会把明确选过的用户一起翻掉。
//
// resolveMode 用 modeExplicit 区分这两种情况。
// ---------------------------------------------------------------------------

test('没有显式标记的历史配置跟随默认值', () => {
  // 老安装：磁盘上写着 mode:'agent'，但那只是当年默认值的物化。
  assert.equal(resolveMode({ mode: 'agent' }), DEFAULT_MODE);
  assert.equal(resolveMode({ mode: 'agent', modeExplicit: false }), DEFAULT_MODE);
});

test('明确选择过的用户不受默认值变更影响', () => {
  // 用户明确选了 Agent，默认值改成 ask 之后仍应保持 Agent。
  assert.equal(resolveMode({ mode: 'agent', modeExplicit: true }), 'agent');
  assert.equal(resolveMode({ mode: 'ask', modeExplicit: true }), 'ask');
});

test('显式标记但值非法时归一化，不落到"读取失败"', () => {
  assert.equal(resolveMode({ mode: 'garbage', modeExplicit: true }), DEFAULT_MODE);
});

test('缺省配置跟随默认值', () => {
  assert.equal(resolveMode({}), DEFAULT_MODE);
  assert.equal(resolveMode(undefined), DEFAULT_MODE);
});

test('设置页切换模式时会写入显式标记', () => {
  const routes = readFileSync(new URL('lib/routes.js', ROOT), 'utf8');
  assert.match(routes, /modeExplicit\s*=\s*true/, '切换模式必须标记为显式选择');
});
