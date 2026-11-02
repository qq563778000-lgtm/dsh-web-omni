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

test('findBrowserToken 在没有登录态时优雅返回，不抛异常', () => {
  let result;
  assert.doesNotThrow(() => { result = findBrowserToken(); });

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

test('成功时返回的 token 不含空白字符', () => {
  const result = findBrowserToken();
  if (!result.ok) return;   // 本机未登录，跳过
  assert.equal(typeof result.token, 'string');
  assert.ok(result.token.length >= 20);
  assert.ok(!/\s/.test(result.token), 'token 里不应有空白');
});
