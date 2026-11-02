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
 * `024783.ldb`，`userTokens` 条目的字节序列是：
 *
 *   01 | 7d 1b 03 00 00 00 00 | 01 | {"MTUw...":{"token":"..."}}
 *   ↑    └── 长度（7 字节）──┘   ↑   └──── value ────┘
 *   类型                         类型
 *
 * 关键教训：长度字段的**字节数不固定**（这里 7 字节），也不是标准 varint。
 * 硬编码 4 或 8 字节读出来全是垃圾——这也正是为什么本实现改成
 * "直接找值的起始字符（{ [ "）再找结尾" 的结构推断法。
 */

const TOKEN = 'NUcrszY1EKbuIYA4yrNsy9eowlwkm3dABbKLPf2oX5fyGvPu10VQMtE-t1ru-elR';

/** 按实测布局构造一条 LevelDB 记录：key + 类型 + 变长长度 + 类型 + value。 */
function buildRecord(key, value, lengthBytes = 7) {
  const keyBuf = Buffer.from(key, 'latin1');
  const valueBuf = Buffer.from(value, 'utf8');

  const prefix = Buffer.alloc(1 + lengthBytes + 1);
  prefix[0] = 0x01;                       // 键后的类型标记
  let size = valueBuf.length;
  for (let i = 0; i < lengthBytes; i++) {
    prefix[1 + i] = size & 0xff;
    size >>= 8;
  }
  prefix[1 + lengthBytes] = 0x01;         // 值前的类型标记

  return Buffer.concat([keyBuf, prefix, valueBuf]);
}

test('能从实测布局里读出 userTokens 的 JSON 值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dwo-ls-'));
  try {
    const value = JSON.stringify({ 'MTUwMTc4ODMzOTIwNzgyMzM2MA==': { token: TOKEN, expiration: '2027-05-07T03:30:41Z' } });
    const file = join(dir, '000001.ldb');
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
      const file = join(dir, `00000${lengthBytes}.ldb`);
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
    const file = join(dir, '000002.ldb');
    // 只写 userTokens，查 userToken 不应命中（否则会把结构化 JSON 当纯 token 用）
    writeFileSync(file, buildRecord('userTokens', value));

    assert.equal(readKeyFromLevelDbFile(file, 'userToken'), null);
    assert.ok(readKeyFromLevelDbFile(file, 'userTokens'));
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

  // 新版：结构化，多账号时取 expiration 最晚的
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
    const leveldb = join(dir, 'Profile 1', 'Local Storage', 'leveldb');
    // 目录不存在的情况
    assert.doesNotThrow(() => findInLocalStorage(dir));
    assert.equal(findInLocalStorage(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
