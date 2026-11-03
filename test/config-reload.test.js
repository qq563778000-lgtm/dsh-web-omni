import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 配置文件的外部改动能被感知。
 *
 * 真实故障（2026-11-02 DSH）：设置页把 `runtime.mode` 从 agent 切到 ask
 * 并成功写盘，但适配器仍按 agent 处理——它读到的是进程启动时缓存的那份
 * 配置。表现是「开关切了完全没作用」：模型照样收到 188 个工具声明，
 * 照样发起工具调用。
 *
 * 根因：loadConfig 用 `if (loaded && !force) return config` 做一次性缓存，
 * 只认第一次读盘的结果。配置文件是可以被**插件之外**的写入者改动的
 * （设置页的 HTTP 端点、用户手改），这种改动在旧实现里永远不可见。
 *
 * 修复后按文件 mtime 判断：没变就复用内存，变了就重读。
 */

const dataDir = mkdtempSync(join(tmpdir(), 'dwo-cfg-'));
process.env.ZHI2API_DATA_DIR = dataDir;
process.env.ZHI2API_ENV_PATH = join(dataDir, '.env');

const store = await import('../kernel/services/config-store.js');
const { DEFAULT_MODE } = await import('../kernel/core/mode.js');

const CONFIG_PATH = join(dataDir, 'config.json');

function writeConfig(mode, modeExplicit = true) {
  writeFileSync(CONFIG_PATH, `${JSON.stringify({ runtime: { mode, modeExplicit } }, null, 2)}\n`);
}

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

test('首次读取返回磁盘内容', () => {
  writeConfig('ask');
  assert.equal(store.loadConfig({ force: true }).runtime.mode, 'ask');
});

test('外部改动文件后，getConfig 能读到新值', () => {
  writeConfig('agent');
  // 这里模拟"另一个写入者"（设置页端点）改了文件。
  // 关键：不调用 force，验证的是自动感知。
  assert.equal(store.getConfig().runtime.mode, 'agent', '应感知到 agent');

  writeConfig('ask');
  assert.equal(store.getConfig().runtime.mode, 'ask', '应感知到切回 ask');
});

test('外部改动文件后，无显式标记的配置跟随默认值', () => {
  // 没有 modeExplicit 说明用户从没碰过这个开关，磁盘上的值只是当年
  // 默认值的物化——应当跟随当前默认值，而不是被当作显式选择。
  writeConfig('agent', false);
  assert.equal(store.getConfig().runtime.mode, DEFAULT_MODE, '应跟随默认值');
});

test('文件未改动时不重复解析（结果稳定）', () => {
  writeConfig('ask');
  const first = store.getConfig();
  const second = store.getConfig();
  // 内容应一致；这里主要确保多次调用不会因为 mtime 判断出错而抖动
  assert.equal(first.runtime.mode, second.runtime.mode);
});

test('非法 mode 归一化为默认值', () => {
  writeConfig('hacker');
  assert.equal(store.getConfig().runtime.mode, DEFAULT_MODE);
  assert.equal(DEFAULT_MODE, 'ask', '默认应为 ask（原生对话）');
});

test('通过 saveConfig 写入后，内存与磁盘一致', () => {
  store.saveConfig({ runtime: { mode: 'ask' } });
  assert.equal(store.getConfig().runtime.mode, 'ask');
  assert.equal(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).runtime.mode, 'ask');
});
