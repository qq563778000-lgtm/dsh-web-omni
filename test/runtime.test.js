import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 运行时引导：这些用例锁住的是"配置目录必须唯一"这条不变量。
//
// 开发过程中踩到的真实缺陷：插件的 import 链会提前把内核拉起来，
// 而内核在模块顶层读取 ZHI2API_DATA_DIR 并固化配置路径。一旦那一步
// 发生在环境隔离之前，内核就去读默认路径——表现为"设置页存了凭据、
// 池里始终 0 条"，且不报任何错。
// ---------------------------------------------------------------------------

async function freshRuntime() {
  // 每个用例都要重新求值模块，才能模拟"冷启动"；用查询串绕过缓存。
  const runtime = await import(`../lib/runtime.js?t=${Date.now()}${Math.random()}`);
  runtime.__resetKernelState();
  return runtime;
}

function tempDir(prefix = 'omni-rt-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('resolveDataDir 优先使用入参', async () => {
  const rt = await freshRuntime();
  const dir = tempDir();
  try {
    assert.equal(rt.resolveDataDir({ dataDir: dir }), dir.replace(/\//g, '\\').replace(/\\\\/g, '\\'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveDataDir 在入参为空时沿用已记录的配置', async () => {
  const rt = await freshRuntime();
  const dir = tempDir();
  try {
    rt.configure({ dataDir: dir });
    // 适配器在对话时会以 {} 调用；若此时算出默认路径，就读不到刚保存的凭据。
    assert.equal(rt.resolveDataDir({}), dir.replace(/\//g, '\\').replace(/\\\\/g, '\\'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isolateEnvironment 写入隔离的环境变量与最小 .env', async () => {
  const rt = await freshRuntime();
  const dir = tempDir();
  try {
    const { envPath } = rt.isolateEnvironment(dir);

    assert.equal(process.env.ZHI2API_DATA_DIR, dir);
    assert.equal(process.env.ZHI2API_ENV_PATH, envPath);
    assert.ok(existsSync(envPath), '.env 应该被创建');

    const content = readFileSync(envPath, 'utf8');
    // 这个文件只负责路径，绝不能包含凭据——凭据在 config.json 里。
    assert.doesNotMatch(content, /DS_TOKEN|password|token=/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readKernelConfig / writeKernelConfig 读写同一路径', async () => {
  const rt = await freshRuntime();
  const dir = tempDir();
  try {
    rt.isolateEnvironment(dir);
    await rt.writeKernelConfig({ deepseek: { tokens: ['a'] } });
    const back = await rt.readKernelConfig();
    assert.deepEqual(back.deepseek.tokens, ['a']);
    assert.equal(rt.configPath(), join(dir, 'config.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readKernelConfig 对损坏文件返回空对象而不是抛出', async () => {
  const rt = await freshRuntime();
  const dir = tempDir();
  try {
    rt.isolateEnvironment(dir);
    writeFileSync(join(dir, 'config.json'), '{ 不是 JSON', 'utf8');
    // 设置页读到损坏文件时应展示"未配置"，而不是整个页面报错。
    assert.deepEqual(await rt.readKernelConfig(), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isolateEnvironment 会创建不存在的目录', async () => {
  const rt = await freshRuntime();
  const base = tempDir();
  const nested = join(base, 'a', 'b', 'c');
  try {
    rt.isolateEnvironment(nested);
    assert.ok(existsSync(nested));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('kernelStatus 在未初始化时如实报告', async () => {
  const rt = await freshRuntime();
  const status = rt.kernelStatus();
  assert.equal(status.ready, false);
  assert.equal(status.started, false);
  assert.equal(status.error, null);
});
