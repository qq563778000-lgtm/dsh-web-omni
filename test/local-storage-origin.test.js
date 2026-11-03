import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseStoredToken } from '../lib/local-storage.js';

/**
 * localStorage 读取的 origin 限定。
 *
 * 真实故障（2026-11-03）：用户声明"Chrome 多个账号都登录了，但没获取到"。
 *
 * 根因：同一个 .ldb 文件里同时存在两个 origin 的同名键：
 *   _https://chat.deepseek.com     userToken = F6E8xvVz…  ✓ 有效
 *   _https://platform.deepseek.com userToken = ddStdeXy…  ✗ 已失效
 *
 * 旧实现只按 key 名匹配、不限定 origin，且后来者覆盖前者——最终返回的是
 * platform.deepseek.com 那条失效值。于是"明明登录了却读不到"。
 */

const lsSource = readFileSync(new URL('../lib/local-storage.js', import.meta.url), 'utf8');

test('读取时限定 origin，不跨站点串值', () => {
  assert.match(lsSource, /TARGET_ORIGIN/, '应定义目标 origin');
  assert.match(lsSource, /indexOf\(TARGET_ORIGIN\)/, '应按 origin 定位');
  // origin 必须在 key 名之前被检查
  const originAt = lsSource.indexOf('indexOf(TARGET_ORIGIN)');
  const keyAt = lsSource.indexOf('indexOf(key, originAt');
  assert.ok(originAt > 0 && keyAt > originAt, '应先定位 origin 再找 key');
});

test('同一 origin 下取首个命中，不被后续记录覆盖', () => {
  // LevelDB 会重排记录，"最后一个"未必是最新值；靠上层逐个验证来取舍。
  assert.match(lsSource, /if \(!found\) found = entry\.value/, '首个命中即用');

  // 不应出现"无条件覆盖"：那会让后出现的 platform.deepseek.com 记录
  // 覆盖掉先出现的 chat.deepseek.com 记录。
  const unconditional = lsSource.match(/(?<!if \(!found\) )found = entry\.value\.toString\('utf8'\);/g) || [];
  assert.equal(unconditional.length, 0, '不应无条件覆盖已找到的值');
});

test('origin 常量指向 chat.deepseek.com', () => {
  assert.match(lsSource, /TARGET_ORIGIN\s*=\s*'_https:\/\/chat\.deepseek\.com'/);
});

test('parseStoredToken 能取出包装里的 token', () => {
  const token = 'F6E8xvVzTC0RvmJzgs/fjdMgn0i9V423jpwrUxyYnIo3/PboqIM6CZbNVQocVHS1';
  const raw = JSON.stringify({ value: token, __version: '0' });
  assert.equal(parseStoredToken(raw), token);
});
