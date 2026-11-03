import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extractToken, findBrowserExecutable, loginWithAccount } from '../lib/account-login.js';

/**
 * 账号密码登录。
 *
 * 背景（2026-11-03 实测，结论明确）：
 *
 *   1. WAF 拦的是"登录动作"，不是 IP。同一时刻同一 IP 下，
 *      chat_session/create 返回 200，users/login 返回 202 + 空响应。
 *      伪造 cookie / 真实 UA / X-Requested-With 全部无效。
 *
 *   2. 登录请求的 body 是 224 字节加密密文，不是明文 JSON——
 *      这正是 Node 侧直连永远 422 的原因。
 *
 *   因此实现是"借真实 Chrome 完成填表提交，再取回 token"。
 * 这些测试覆盖不需要真登录也能验证的部分：
 * 参数校验、token 提取、浏览器探测、以及密码不外泄的结构约束。
 */

test('extractToken 支持当前版本的单 token 包装', () => {
  // 实测登录成功后 userToken 的存储形态
  const raw = JSON.stringify({
    value: '5ehXiYm6Y/7QnUaEk06pOPglCymYXlTUTrRk4uMMthld1UPlySuVXvV3c7Fn8AQ0',
    __version: '0',
  });
  assert.equal(
    extractToken(raw),
    '5ehXiYm6Y/7QnUaEk06pOPglCymYXlTUTrRk4uMMthld1UPlySuVXvV3c7Fn8AQ0',
  );
});

test('extractToken 支持旧的多账号形态，取过期最晚的', () => {
  const raw = JSON.stringify({
    old: { token: 'OLDTOKEN_aaaaaaaaaaaaaaaaaaaaaaaa', expiration: '2025-01-01T00:00:00Z' },
    now: { token: 'NEWTOKEN_bbbbbbbbbbbbbbbbbbbbbbbb', expiration: '2027-05-07T03:30:41Z' },
  });
  assert.equal(extractToken(raw), 'NEWTOKEN_bbbbbbbbbbbbbbbbbbbbbbbb');
});

test('extractToken 对原始字符串与空值都稳妥', () => {
  // 直接就是 token
  assert.equal(
    extractToken('bEssK7h1WdmT3nL8Q4GUe+k0EE4ntQqqRUWQFQBgdr/RFqyknnq6YTORO/Mu1cfT'),
    'bEssK7h1WdmT3nL8Q4GUe+k0EE4ntQqqRUWQFQBgdr/RFqyknnq6YTORO/Mu1cfT',
  );
  assert.equal(extractToken(''), null);
  assert.equal(extractToken(null), null);
  assert.equal(extractToken('短'), null, '过短的串不应被当成 token');
});

test('缺少账号或密码时立刻返回，不启动浏览器', async () => {
  const a = await loginWithAccount({ email: '', password: 'x' });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'invalid-input');

  const b = await loginWithAccount({ email: 'a@b.com', password: '' });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'invalid-input');
});

test('找不到浏览器时给出可操作的提示，而不是笼统失败', async (t) => {
  // 本机若装了 Chrome，这个用例没有意义，跳过。
  if (findBrowserExecutable()) return t.skip('本机有浏览器');

  const r = await loginWithAccount({ email: 'a@b.com', password: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-browser');
  assert.match(r.message, /Chrome|Edge/);
  assert.match(r.message, /从浏览器获取/, '应给出替代方案');
});

test('登录模块不留存密码', () => {
  const src = readFileSync(new URL('../lib/account-login.js', import.meta.url), 'utf8');

  // 密码只能作为参数传给页面脚本，不能被持久化或打印。
  assert.doesNotMatch(src, /writeFileSync\([^)]*password/i, '不得把密码写入文件');
  assert.doesNotMatch(src, /console\.(log|warn|error)\([^)]*password/i, '不得把密码打进日志');
  // 也不应把它塞进 config / 环境变量
  assert.doesNotMatch(src, /process\.env\.\w*PASSWORD\s*=/i, '不得把密码写入环境变量');
});

test('每次登录使用全新的临时 profile', () => {
  // 复用用户自己的浏览器 profile 会带来两个问题：
  //   1. 可能已经登录，测试"登录成功"其实没验证到密码；
  //   2. 会污染用户的浏览器数据。
  const src = readFileSync(new URL('../lib/account-login.js', import.meta.url), 'utf8');
  assert.match(src, /mkdtempSync/, '应新建临时目录');
  assert.match(src, /--user-data-dir=/, '应指定独立的 profile 目录');
  assert.match(src, /rmSync\(dir/, '结束时应清理临时目录');
});
