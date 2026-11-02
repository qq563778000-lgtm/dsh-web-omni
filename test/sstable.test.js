import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { snappyDecompress } from '../lib/snappy.js';
import { iterateSstable } from '../lib/sstable.js';

/**
 * LevelDB 压缩块解析。
 *
 * 为什么必须有这一层：Chromium 的 localStorage 表默认用 Snappy 压缩数据块，
 * 压缩流里**不存在明文的 key 或 value**。按字面量搜字节只能命中少量未压缩
 * 记录，于是得出"浏览器里没有 token"的错误结论——2026-11-02 的排查正是
 * 因此走偏了两轮。
 */

/** 构造一段 Snappy literal 编码（最简单的合法输入）。 */
function snappyLiteral(payload) {
  const len = payload.length;
  const head = [];
  // 先放未压缩长度 varint
  let n = len;
  while (n >= 0x80) { head.push((n & 0x7f) | 0x80); n >>= 7; }
  head.push(n);

  // literal tag：长度 - 1 左移 2 位（<60 时直接放）
  if (len - 1 < 60) {
    head.push((len - 1) << 2);
  } else {
    head.push(60 << 2);   // 随后 1 字节长度
    head.push(len - 1);
  }
  return Buffer.concat([Buffer.from(head), payload]);
}

test('Snappy：literal 块能原样还原', () => {
  const payload = Buffer.from('hello snappy world', 'utf8');
  const out = snappyDecompress(snappyLiteral(payload));
  assert.ok(out);
  assert.equal(out.toString('utf8'), 'hello snappy world');
});

test('Snappy：copy 指令能还原重复内容', () => {
  // "abcd" + copy(offset=4, len=8) → "abcdabcdabcd"
  const head = [12, 3 << 2];   // 未压缩长度 12，literal 4 字节
  const body = Buffer.from('abcd', 'utf8');
  // copy type 1：长度 4~11，偏移 11 位
  const copyTag = (8 - 4) << 2 | 1;   // len=8，type=1
  const copyOff = 4;                   // 偏移低 8 位
  const buf = Buffer.concat([Buffer.from([...head, ...body, copyTag, copyOff])]);

  const out = snappyDecompress(buf);
  assert.ok(out, '应能解压 copy 指令');
  assert.equal(out.toString('utf8'), 'abcdabcdabcd');
});

test('Snappy：非法输入返回 null 而不是抛错', () => {
  assert.equal(snappyDecompress(Buffer.alloc(0)), null);
  assert.equal(snappyDecompress(Buffer.from([0xff, 0xff, 0xff])), null);
  // 声明长度 100 但只给 1 字节
  assert.equal(snappyDecompress(Buffer.from([100, 0x00])), null);
});

test('SSTable：非 LevelDB 文件不会抛错', () => {
  assert.doesNotThrow(() => {
    for (const _ of iterateSstable(Buffer.from('not a leveldb file'))) { /* 空 */ }
  });
  assert.deepEqual([...iterateSstable(Buffer.alloc(0))], []);
});

/**
 * 以下用例读本机真实 Chrome 数据，**目录不存在时自动跳过**（CI 无浏览器）。
 * 它们存在的意义：验证解析器对真实文件的格式假设没有过期。
 */
function findChromeLevelDb() {
  const base = join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data');
  if (!existsSync(base)) return [];
  const out = [];
  for (const prof of readdirSync(base)) {
    const dir = join(base, prof, 'Local Storage', 'leveldb');
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.ldb')) continue;
      const p = join(dir, n);
      try {
        if (statSync(p).size > 1000) out.push({ prof, n, p });
      } catch { /* 忽略 */ }
    }
  }
  return out;
}

test('SSTable：能从真实 Chrome .ldb 解出条目', () => {
  const files = findChromeLevelDb();
  if (!files.length) return;   // 本机无 Chrome，跳过

  let total = 0;
  for (const f of files.slice(0, 3)) {
    const entries = [...iterateSstable(readFileSync(f.p))];
    total += entries.length;
    for (const e of entries) {
      assert.ok(Buffer.isBuffer(e.key));
      assert.ok(Buffer.isBuffer(e.value));
    }
  }
  assert.ok(total > 0, '真实 .ldb 应能解出至少一条记录');
});
