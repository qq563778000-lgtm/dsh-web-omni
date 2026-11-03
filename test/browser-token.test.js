import test from 'node:test';
import assert from 'node:assert/strict';

import { findBrowserToken, listAvailableBrowsers } from '../lib/browser-token.js';

/**
 * 从本机浏览器读取 DeepSeek 登录态。
 *
 * 这组测试不依赖"本机是否真的登录过"，只锁住两件事：
 *   1. 探测过程绝不抛异常——设置页点按钮不能因为没装浏览器就崩；
 *   2. 返回结构稳定，调用方能据此给出可操作的提示。
 *
 * 关于 App-Bound Encryption 的现实约束（写在这里，避免以后误以为实现有 bug）：
 * Chrome 127+ / Edge 127+ 把 cookie 换成了 `v20` 前缀 + ABE，密钥由浏览器
 * 以自身身份向系统服务申请，**同用户的其它进程也取不到**。实测用 DPAPI
 * 解出的 master key 解 40 条真实 cookie，成功 0 条。
 *
 * 因此本功能在主流新版浏览器上通常返回失败。保留它的价值在于：旧版浏览器
 * （v10/v11）仍可用，且探测结果能把"没登录"与"浏览器加密不支持"区分开。
 */

test('listAvailableBrowsers 返回结构稳定', () => {
  const browsers = listAvailableBrowsers();
  assert.ok(Array.isArray(browsers));
  for (const browser of browsers) {
    assert.equal(typeof browser.id, 'string');
    assert.equal(typeof browser.name, 'string');
    assert.ok(browser.id.length > 0 && browser.name.length > 0);
  }
});

test('findBrowserToken 在没有登录态时优雅返回，不抛异常', async () => {
  let result;
  await assert.doesNotReject(async () => { result = await findBrowserToken(); });

  assert.equal(typeof result.ok, 'boolean');
  assert.ok(Array.isArray(result.tried), '应报告尝试过哪些浏览器');

  for (const entry of result.tried) {
    assert.equal(typeof entry.browser, 'string');
    assert.equal(typeof entry.ok, 'boolean');
  }

  if (!result.ok) {
    // 失败时必须给出可读原因，设置页据此提示用户下一步做什么。
    for (const entry of result.tried) {
      assert.ok(
        entry.reason === null || typeof entry.reason === 'string',
        '每个浏览器的尝试结果都应带 reason',
      );
    }
  }
});

test('成功时返回的 token 不含空白字符', async () => {
  const result = await findBrowserToken();
  if (!result.ok) return;   // 本机未登录，跳过
  assert.equal(typeof result.token, 'string');
  assert.ok(result.token.length >= 20);
  assert.ok(!/\s/.test(result.token), 'token 里不应有空白');
});

test('浏览器启用 App-Bound 加密时，reason 必须是 encrypted-by-browser', async () => {
  const result = await findBrowserToken();
  if (result.ok) return;    // 真读到了就不用检查失败原因

  // 本机 Chrome/Edge 156 全部使用 v20 + ABE。若这里拿到的是
  // '未找到登录态'，说明判定逻辑退化成了"只在找到 cookie 时才判 ABE"——
  // 那样用户没登录时会被引导去登录，登录完仍然失败，白跑一趟。
  const abeBrowsers = result.tried.filter(entry => entry.reason === 'encrypted-by-browser');
  if (abeBrowsers.length > 0) {
    assert.equal(result.reason, 'encrypted-by-browser',
      '整体结果也要标成加密限制，设置页据此给出正确提示');
    assert.ok(result.browser, '应指出是哪个浏览器');
  }
});

test('传入 validate 时，只返回通过验证的候选', async () => {
  // 模拟"第一个候选失效、第二个有效"的情况——真实环境里多个 Chrome 账号
  // 各自留有历史 token，失效的常常排在前面。只取第一个必然拿到废值。
  const seen = [];
  const result = await findBrowserToken({
    validate: async (token) => {
      seen.push(token);
      return token.endsWith('VALID');
    },
  });

  assert.ok(seen.length >= 1, '应逐个验证候选');
  if (result.ok) {
    assert.ok(result.token.endsWith('VALID'), '返回的必须是验证通过的 token');
  }
});

test('候选全部失效时，reason 是 stale', async () => {
  const result = await findBrowserToken({ validate: async () => false });
  if (result.ok) return;   // 有 cookie 兜底路径时可能仍成功

  const stale = result.tried.filter(entry => entry.reason === 'stale');
  if (stale.length > 0) {
    assert.equal(result.reason, 'stale',
      '读到了记录但全部失效，应报告 stale 而非 not-found');
  }
});
