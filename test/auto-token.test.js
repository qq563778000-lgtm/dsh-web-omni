import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  autoFetchBrowserTokens,
  describeAutoFetchFailure,
  hasUsableCredential,
  AUTOFETCH_COOLDOWN_MS,
  __resetAutoFetchState,
} from '../lib/auto-token.js';

/**
 * 首次对话时自动获取浏览器 Token。
 *
 * 需求（2026-11-03）：用户安装后第一次对话，如果没有 token 可用，
 * 应自动从浏览器获取，而不是让用户去设置页手动粘贴。
 *
 * 这组测试锁住三件事：
 *   1. 触发条件严格——只在"一个可用凭据都没有"时触发；
 *   2. 只尝试一次——扫描要 1.5~4 秒，反复尝试会让每轮对话都变慢；
 *   3. 失败提示要说清楚原因——四种原因对应四种不同处置。
 */

test('有可用凭据时不触发自动获取', () => {
  __resetAutoFetchState();
  // 内核接口不可用时应回落到"没有可用凭据"——保守方向是多试一次，
  // 而不是漏掉自动获取。
  assert.equal(hasUsableCredential({}), false);
  assert.equal(hasUsableCredential({ auth: {} }), false);
});

test('有可用凭据时判定为 true', () => {
  __resetAutoFetchState();
  const kernel = { auth: { getAliveTokens: () => ['a', 'b'] } };
  assert.equal(hasUsableCredential(kernel), true);
});

test('凭据全部被禁用时判定为 false', () => {
  __resetAutoFetchState();
  const kernel = { auth: { getAliveTokens: () => [] } };
  assert.equal(hasUsableCredential(kernel), false);
});

test('冷却期内复用上次结论，不重复扫描', async () => {
  __resetAutoFetchState();

  // 注入扫描入口来精确计数。用真实扫描的话，一次要 1.5~4 秒（读盘解压），
  // 而 validate 还会对每个候选打一次上游（3~4 秒/个）——测试会慢到没法跑。
  let scans = 0;
  const fakeScan = async () => {
    scans += 1;
    return { ok: false, reason: 'not-found', tried: [] };
  };

  const first = await autoFetchBrowserTokens({ scan: fakeScan, now: 1000 });
  const second = await autoFetchBrowserTokens({ scan: fakeScan, now: 1000 + AUTOFETCH_COOLDOWN_MS - 1 });

  assert.deepEqual(second, first, '冷却期内应返回与第一次相同的结果');
  assert.equal(scans, 1, '冷却期内不得再次扫描');
});

test('冷却期过后允许重新扫描', async () => {
  __resetAutoFetchState();

  let scans = 0;
  const fakeScan = async () => {
    scans += 1;
    return { ok: false, reason: 'not-found', tried: [] };
  };

  await autoFetchBrowserTokens({ scan: fakeScan, now: 1000 });
  await autoFetchBrowserTokens({ scan: fakeScan, now: 1000 + AUTOFETCH_COOLDOWN_MS });

  assert.equal(scans, 2, '冷却期过了必须允许再扫——浏览器登录态可能已经变了');
});

test('force 跳过冷却，立即执行', async () => {
  __resetAutoFetchState();

  // 用户显式点"重新获取"时必须立刻生效，不能因为还在冷却期就什么都不做。
  let scans = 0;
  const fakeScan = async () => {
    scans += 1;
    return { ok: false, reason: 'not-found', tried: [] };
  };

  await autoFetchBrowserTokens({ scan: fakeScan, now: 1000 });
  await autoFetchBrowserTokens({ scan: fakeScan, now: 1001, force: true });

  assert.equal(scans, 2, 'force 必须跳过冷却');
});

test('冷却期的意义：凭据会死，成功不是终态', () => {
  // 真实故障（2026-11-03）：用户在浏览器退出登录 → 上游作废 token（40003）
  // → 凭据禁用 3 天。旧实现"整个进程只试一次"，用户在浏览器重新登录后
  // 插件永远拿不到新 token，除非重启 DSH。
  //
  // 这个测试不做行为断言（上面的冷却期测试已覆盖），在这里记录设计依据，
  // 防止将来有人把冷却改回"一次性"标志。
  assert.ok(AUTOFETCH_COOLDOWN_MS > 60 * 1000, '冷却窗口必须足够长，挡住每轮对话都扫一遍');
  assert.ok(AUTOFETCH_COOLDOWN_MS < 60 * 60 * 1000, '冷却窗口必须足够短，重新登录后不用等太久');
});

test('失败提示按原因分流，给出对应的处置', () => {
  const cases = [
    ['not-flushed', /关掉.*标签页|Ctrl\+W/s],
    ['stale', /重新登录/],
    ['not-found', /没有找到/],
    ['scan-failed', /出错/],
  ];

  for (const [reason, pattern] of cases) {
    const text = describeAutoFetchFailure({ reason });
    assert.match(text, pattern, `${reason} 的提示应包含对应的处置建议`);
    assert.ok(text.length > 10, `${reason} 的提示不应是一句空话`);
  }
});

test('未知原因也给出可操作的提示', () => {
  const text = describeAutoFetchFailure({ reason: 'something-else' });
  assert.match(text, /设置页|手动添加/);
});

test('扫描出错时的提示里带上原始错误', () => {
  const text = describeAutoFetchFailure({ reason: 'scan-failed', message: '磁盘读取失败' });
  assert.match(text, /磁盘读取失败/);
});

test('适配器在没有可用凭据时会触发自动获取', () => {
  // 这是本功能的接入点：必须在 stream() 里、发出请求之前。
  const source = readFileSync(new URL('../lib/adapter.js', import.meta.url), 'utf8');

  assert.match(source, /hasUsableCredential\(kernel\)/, '应先判断是否有可用凭据');
  assert.match(source, /autoFetchBrowserTokens\(/, '应触发自动获取');
  assert.match(source, /describeAutoFetchFailure\(/, '失败时应给出可操作的提示');
});

test('自动获取成功后要让内核把新凭据同步进池', () => {
  // 只写配置不刷新池，池里仍然是空的，请求照样失败——
  // 这正是"看似成功、实际仍不可用"的典型陷阱。
  const source = readFileSync(new URL('../lib/adapter.js', import.meta.url), 'utf8');
  assert.match(source, /syncTokenPoolFromConfig\(\)/, '入库后必须同步凭据池');
});

test('设置页与自动获取共用同一套有效性判定', () => {
  // 两处判定口径必须一致，否则用户会看到矛盾的结果
  // （设置页说"已添加"，首次对话却说"没有可用凭据"）。
  const routes = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8');
  const adapter = readFileSync(new URL('../lib/adapter.js', import.meta.url), 'utf8');
  const validate = readFileSync(new URL('../lib/credential-validate.js', import.meta.url), 'utf8');

  assert.match(validate, /export async function isTokenUsable/, '判定应实现在共享模块里');
  assert.match(routes, /credential-validate\.js/, '路由应引用共享判定');
  assert.match(adapter, /credential-validate\.js/, '适配器应引用共享判定');
});

test('浏览器扫描放在 worker 线程里，不阻塞主线程', () => {
  // 扫描要读盘 + Snappy 解压，本机 1.5~4 秒。放在主线程会冻结整个
  // DSH 界面——用户看到的是"点了没反应"。
  const browserToken = readFileSync(new URL('../lib/browser-token.js', import.meta.url), 'utf8');
  assert.match(browserToken, /worker_threads/, '应引入 worker');
  assert.match(browserToken, /scanBrowserCandidatesAsync/, '应提供异步扫描入口');

  const workerFile = new URL('../lib/browser-scan-worker.js', import.meta.url);
  assert.ok(readFileSync(workerFile, 'utf8').includes('scanBrowserCandidates'), 'worker 应调用扫描函数');
});
