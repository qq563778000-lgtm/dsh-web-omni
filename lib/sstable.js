/**
 * LevelDB SSTable（.ldb）解析：把压缩块解开，遍历真实键值。
 *
 * 为什么要完整解析而不是"搜字节"：
 * Chromium 的 localStorage 表默认用 Snappy 压缩数据块。压缩后的字节流里
 * 根本不存在明文的 key 或 value——之前按字面量搜索只能命中**未压缩**的
 * 少量记录（比如刚写入还在 memtable 里、或小于压缩阈值的块），
 * 于是得到"浏览器里没有 token"的错误结论。
 *
 * 文件结构（标准 LevelDB 格式）：
 *   [ data block 0 ][ data block 1 ] … [ filter ] [ metaindex ] [ index ] [ footer ]
 *
 *   - 每个 block：数据区 + 1 字节压缩类型 + 4 字节 CRC
 *   - footer 固定 48 字节，末尾 8 字节是 magic 0xdb4775248b80fb57
 *   - footer 前 40 字节含 metaindex 与 index 两个 block handle（varint 编码）
 *   - block 内：若干记录，采用"共享前缀"压缩
 *
 * 这里只解析 data block（我们要的 key/value 都在那里），不处理 bloom filter。
 */

import { snappyDecompress } from './snappy.js';

const MAGIC = 0xdb4775248b80fb57n;

/** 读 varint（LevelDB 内部用 unsigned LEB128） */
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let i = pos;
  while (i < buf.length && shift < 64) {
    const byte = buf[i];
    i += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value: result, next: i };
    shift += 7;
  }
  return null;
}

/** 解析一个 block handle（offset + size），返回 { offset, size, next }。 */
function readBlockHandle(buf, pos) {
  const off = readVarint(buf, pos);
  if (!off) return null;
  const size = readVarint(buf, off.next);
  if (!size) return null;
  return { offset: off.value, size: size.value, next: size.next };
}

/**
 * 读取并解压一个 block。
 *
 * block 尾部 5 字节是 [compressionType(1)][crc32(4)]。
 * compressionType：0 = 未压缩，1 = Snappy。
 */
function readBlock(file, handle) {
  const start = handle.offset;
  const end = start + handle.size;
  if (end + 5 > file.length) return null;

  const raw = file.subarray(start, end);
  const compressionType = file[end];

  if (compressionType === 0) return raw;
  if (compressionType === 1) return snappyDecompress(raw);
  return null;   // 其它压缩算法（zstd 等）暂不支持
}

/**
 * 解析一个 block 内的所有 key/value 记录。
 *
 * 记录格式（共享前缀压缩）：
 *   sharedLen(varint) nonSharedLen(varint) valueLen(varint)
 *   keyDelta[nonSharedLen] value[valueLen]
 *
 * 每个 block 的**末尾 4 字节**是 restart point 数组长度，还要再往前读
 * 每个 restart 的 4 字节偏移。遍历时遇到 restart 位置，共享前缀归零。
 *
 * @returns {Array<{key: Buffer, value: Buffer}>}
 */
function parseBlock(buf) {
  if (!buf || buf.length < 4) return [];

  const numRestarts = buf.readUInt32LE(buf.length - 4);
  const restartsStart = buf.length - 4 - numRestarts * 4;
  if (restartsStart < 0) return [];

  const restartSet = new Set();
  for (let i = 0; i < numRestarts; i += 1) {
    restartSet.add(buf.readUInt32LE(restartsStart + i * 4));
  }

  const entries = [];
  let pos = 0;
  let lastKey = Buffer.alloc(0);

  while (pos < restartsStart) {
    const shared = readVarint(buf, pos);
    if (!shared) break;
    const nonShared = readVarint(buf, shared.next);
    if (!nonShared) break;
    const valueLen = readVarint(buf, nonShared.next);
    if (!valueLen) break;

    const keyStart = valueLen.next;
    const keyEnd = keyStart + nonShared.value;
    const valEnd = keyEnd + valueLen.value;
    if (valEnd > restartsStart) break;

    const keyDelta = buf.subarray(keyStart, keyEnd);
    const value = buf.subarray(keyEnd, valEnd);

    const base = restartSet.has(pos) ? Buffer.alloc(0) : lastKey;
    const key = Buffer.concat([base.subarray(0, Math.min(shared.value, base.length)), keyDelta]);

    entries.push({ key, value });
    lastKey = key;
    pos = valEnd;
  }

  return entries;
}

/**
 * 遍历一个 .ldb 文件的全部 data block，产出所有 key/value。
 *
 * 只解析 index block 里登记的数据块；不读 filter / metaindex。
 */
export function* iterateSstable(file) {
  if (!file || file.length < 48) return;

  const footer = file.subarray(file.length - 48);
  const magic = footer.readBigUInt64LE(40);
  if (magic !== MAGIC) return;

  // footer 前 40 字节：metaindex handle, index handle, 末尾补齐
  let pos = 0;
  const meta = readBlockHandle(footer, pos);
  if (!meta) return;
  const index = readBlockHandle(footer, meta.next);
  if (!index) return;

  const indexBlock = readBlock(file, index);
  if (!indexBlock) return;

  // index block 的每个 entry 的 value 是 data block handle
  for (const entry of parseBlock(indexBlock)) {
    let hp = 0;
    const handle = readBlockHandle(entry.value, hp);
    if (!handle) continue;
    const dataBlock = readBlock(file, handle);
    if (!dataBlock) continue;
    for (const kv of parseBlock(dataBlock)) yield kv;
  }
}
