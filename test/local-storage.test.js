import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findInLocalStorage,
  parseStoredToken,
  readKeyFromLevelDbFile,
} from '../lib/local-storage.js';

/**
 * 从 Chromium Local Storage（LevelDB）读取 DeepSeek 登录态。
 *
 * 这里锁住的是**真实的物理布局**。2026-11-02 实测 Chrome 156 的
 * 024783.ldb，userTokens 条目的字节序列是：
 *
 *   01 | 7d 1b 03 00 00 00 00 | 01 | {"MTUw...":{"token":"..."}}
 *   ↑    └── 长度（7 字节）──┘   ↑   └──── value ────┘
 *   类型                         类型
 *
 * 关键教训：长度字段的**字节数不固定**（这里 7 字节），也不是标准 varint。
 * 硬编码 4 或 8 字节读出来全是垃圾——这也正是为什么本实现改成
 * "直接找值的起始字符再找结尾" 的结构推断法。
 *
 * 另外 2026-11-03 发现：真实键形如
 *   _https://chat.deepseek.com\x00\x01userToken
 * origin 是键的一部分，解析时必须限定，否则会串到 platform.deepseek.com
 * 下的同名键（那里的值往往已失效）。
 */

const TOKEN = 'NUcrszY1EKbuIYA4yrNsy9eowlwkm3dABbKLPf2oX5fyGvPu10VQMtE-t1ru-elR';

/** DeepSeek Web 的 origin。 */
const ORIGIN = '_https://chat.deepseek.com';

/**
 * 按实测布局构造一条未压缩记录：key + 类型 + 变长长度 + 类型 + value。
 *
 * 值的结束位置是靠"下一个控制字符"判定的，因此记录末尾必须跟分隔符，
 * 否则值会被截断——这是 leveldb 的实际存储方式。
 */
function buildRecord(key, value, lengthBytes = 7, origin = ORIGIN) {
  const keyBuf = Buffer.from(`${origin}\x00\x01${key}`, 'latin1');
  const valueBuf = Buffer.from(value, 'utf8');

  const prefix = Buffer.alloc(1 + lengthBytes + 1);
  prefix[0] = 0x01;                       // 键后的类型标记
  let size = valueBuf.length;
  for (let i = 0; i < lengthBytes; i++) {
    prefix[1 + i] = size & 0xff;
    size >>= 8;
  }
  prefix[1 + lengthBytes] = 0x01;         // 值前的类型标记

  return Buffer.concat([keyBuf, prefix, valueBuf, Buffer.from('\x00\x00\x00', 'latin1')]);
}

test('能从实测布局里读出 userTokens 的 JSON 值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-ls-'));
  try {
    const value = JSON.stringify({ 'MTUwMTc4ODMzOTIwNzgyMzM2MA==': { token: TOKEN, expiration: '2027-05-07T03:30:41Z' } });
    const file = join(dir, '000001.log');
    writeFileSync(file, Buffer.concat([
      Buffer.from('\x00\x00garbage-before\x00', 'latin1'),
      buildRecord('userTokens', value),
      Buffer.from('\x00garbage-after', 'latin1'),
    ]));

    const read = readKeyFromLevelDbFile(file, 'userTokens');
    assert.ok(read, '应读到 userTokens');
    assert.equal(parseStoredToken(read), TOKEN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('长度字段字节数不同也能读（3 / 4 / 8 字节都试）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-ls-'));
  try {
    for (const lengthBytes of [3, 4, 8]) {
      const value = JSON.stringify({ u: { token: TOKEN, expiration: '2027-01-01T00:00:00Z' } });
      const file = join(dir, `00000${lengthBytes}.log`);
      writeFileSync(file, buildRecord('userTokens', value, lengthBytes));

      const read = readKeyFromLevelDbFile(file, 'userTokens');
      assert.ok(read, `${lengthBytes} 字节长度字段应可解析`);
      assert.equal(parseStoredToken(read), TOKEN, `${lengthBytes} 字节长度字段解析结果应正确`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('userToken 与 userTokens 不会互相误命中', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-ls-'));
  try {
    const value = JSON.stringify({ u: { token: TOKEN, expiration: '2027-01-01T00:00:00Z' } });
    const file = join(dir, '000002.log');
    // 只写 userTokens，查 userToken 不应命中（否则会把结构化 JSON 当纯 token 用）
    writeFileSync(file, buildRecord('userTokens', value));

    assert.equal(readKeyFromLevelDbFile(file, 'userToken'), null);
    assert.ok(readKeyFromLevelDbFile(file, 'userTokens'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('不命中其它 origin 下的同名键', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-ls-'));
  try {
    const good = JSON.stringify({ value: TOKEN, __version: '0' });
    const bad = JSON.stringify({ value: 'X'.repeat(64), __version: '0' });
    const file = join(dir, '000003.log');

    // 先写 chat.deepseek.com 的有效值，再写 platform.deepseek.com 的失效值。
    // 旧实现（只按 key 名匹配、后来者覆盖前者）会返回后者。
    writeFileSync(file, Buffer.concat([
      buildRecord('userToken', good, 7, '_https://chat.deepseek.com'),
      buildRecord('userToken', bad, 7, '_https://platform.deepseek.com'),
    ]));

    const read = readKeyFromLevelDbFile(file, 'userToken');
    assert.ok(read, '应读到 userToken');
    assert.equal(parseStoredToken(read), TOKEN, '必须取目标 origin 下的值');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseStoredToken 支持 {"value": token} 包装形态', () => {
  // 当前 Chrome 156 上 userToken 的实际存法（实测 2026-11-02）。
  // 不认这一层就会返回 null——值就在眼前却取不出来。
  const wrapped = JSON.stringify({ value: TOKEN, __version: '0' });
  assert.equal(parseStoredToken(wrapped), TOKEN);
});

test('parseStoredToken 接受标准 base64（含 + 与 /）', () => {
  // 实测的 DeepSeek token 用的是标准 base64，不是 base64url。
  // 只认 base64url 会把真实 token 判为非法。
  const standard = 'bEssK7h1WdmT3nL8Q4GUe+k0EE4ntQqqRUWQFQBgdr/RFqyknnq6YTORO/Mu1cfT';
  assert.equal(parseStoredToken(standard), standard);
  assert.equal(parseStoredToken(JSON.stringify({ value: standard, __version: '0' })), standard);
});

test('parseStoredToken 支持三种历史形态', () => {
  // 旧版：值就是 token
  assert.equal(parseStoredToken(TOKEN), TOKEN);

  // 新版：结构化，多账号时取 expiration 最晚的那个
  const structured = JSON.stringify({
    old: { token: 'OLDOLDOLDOLDOLDOLDOLDOLDOLDOLD_old', expiration: '2025-01-01T00:00:00Z' },
    now: { token: TOKEN, expiration: '2027-05-07T03:30:41Z' },
  });
  assert.equal(parseStoredToken(structured), TOKEN, '应取最晚过期的账号');

  // 片段：JSON 被截断时从里面挖
  assert.equal(parseStoredToken(`{"token":"${TOKEN}","expiration":"2027`), TOKEN);

  assert.equal(parseStoredToken(''), null);
  assert.equal(parseStoredToken('not-a-token'), null);
});

test('findInLocalStorage 在没有目标键时返回 null 而不是抛错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-ls-'));
  try {
    // 目录不存在的情况
    assert.doesNotThrow(() => findInLocalStorage(dir));
    assert.equal(findInLocalStorage(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
