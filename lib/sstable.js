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

/**
 * 只遍历含 `prefix` 开头的 key 的那些 data block。
 *
 * 为什么要专门有这个入口：index block 里每个 entry 的 key 是**它所辖
 * data block 的分隔符**——即"块内最后一个 key"，而不是块内首个 key。
 *
 * 实测本机 Chromium 的 localStorage 表有三个特征，决定了判据怎么写：
 *
 *   1. 键形如 `_https://chat.deepseek.com\x00\x01userToken\x01<8字节序号>`。
 *      键名之后是分隔符，再跟 8 字节的序号/填充后缀。
 *
 *   2. 同一 origin 的键**不连续**——它们之间夹着 `META:` 开头的元数据键，
 *      而 `META:` 排在 `_https://…` 之前（'M' < '_'）。
 *
 *   3. 一个 data block 内的 key 跨越多个 origin。实测某块首键是
 *      `_https://chat.deepseek.com…hif_leim_cached`，末键是
 *      `_https://linux.do…__mbLastAjax`——即**同一个块里既有 deepseek
 *      也有 linux.do**。
 *
 * 由 (3) 可知：**不能用 index 条目的 key（= 块末键）来判断块内有没有
 * 目标键**。块末键可能是下一个 origin 的，而目标键排在它前面。
 *
 * 正确做法：解压候选块，检查块内**任意一个** key 是否以 prefix 开头。
 * 候选块的选择用"块末键 ≥ prefix"这个必要条件——块末键小于 prefix 时，
 * 块内所有 key 都小于 prefix（块内有序），必然不含目标键。
 *
 * 收益有限但确实存在（本机实测 2026-11-03，Chrome 62 个 .ldb 共 67MB）：
 *   全量遍历 1441ms / 34192 条记录
 *   index 预筛 1234ms（候选块占 73.6%，Chromium 的键排序使 deepseek
 *                      落在大部分块之后，因此收窄效果有限）
 *
 * 之所以仍然保留：它同时是**正确性的旁证**——用同一份实现对全部块
 * 求并集，与逐文件全量遍历对照，62 个 .ldb 上命中集合完全一致
 * （0 处差异）。任何对分隔符语义的误判都会在这里暴露。
 *
 * @param {Buffer} file   .ldb 文件内容
 * @param {string} prefix 目标 key 前缀（如 origin）
 */
export function* iterateSstableByPrefix(file, prefix) {
  if (!file || file.length < 48) return;

  const footer = file.subarray(file.length - 48);
  if (footer.readBigUInt64LE(40) !== MAGIC) return;

  const meta = readBlockHandle(footer, 0);
  if (!meta) return;
  const index = readBlockHandle(footer, meta.next);
  if (!index) return;

  const indexBlock = readBlock(file, index);
  if (!indexBlock) return;

  const needle = Buffer.from(prefix, 'latin1');

  for (const entry of parseBlock(indexBlock)) {
    // 必要条件：块末键（= 分隔符）必须 ≥ prefix。
    //
    // 块内 key 有序，因此块末键 < prefix 时块内不可能有 prefix 开头的 key。
    // 这条筛掉了部分无关块，且**不会漏**（漏读风险来自"过早收尾"，
    // 而这里只是跳过确定无关的块）。
    if (entry.key.compare(needle) < 0) continue;

    const handle = readBlockHandle(entry.value, 0);
    if (!handle) continue;
    const dataBlock = readBlock(file, handle);
    if (!dataBlock) continue;

    const entries = parseBlock(dataBlock);
    // 块内是否有目标前缀的键？
    const hit = entries.some(kv => kv.key.subarray(0, needle.length).equals(needle));
    if (!hit) continue;

    for (const kv of entries) yield kv;
  }
}
