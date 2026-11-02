/**
 * Snappy 解压（LevelDB 块压缩用的格式）。
 *
 * 为什么自己实现：LevelDB 默认用 Snappy 压缩数据块，而 localStorage 里
 * 的键值就藏在压缩块中。不引入原生依赖（插件要"装完即用"，不想引入需要
 * 编译的包），所以按官方格式说明手写。
 *
 * 格式（https://github.com/google/snappy/blob/main/format_description.txt）：
 *   开头是未压缩长度的 varint，随后是一串 tag：
 *   低 2 位是类型：
 *     0 = literal   高 6 位是长度-1（<60），或 60/61/62/63 表示随后 1~4 字节长度
 *     1 = copy      长度 4~11（高 3 位 + 4），偏移 11 位（高 3 位 + 低 8 位）
 *     2 = copy      长度 1~64（高 6 位 + 1），偏移 2 字节
 *     3 = copy      长度 1~64（高 6 位 + 1），偏移 4 字节
 */

/**
 * 解压一段 Snappy 数据。
 *
 * @param {Buffer} input 压缩数据
 * @returns {Buffer|null} 解压结果；格式非法时返回 null（而不是抛错，
 *   因为调用方是在"试探"某个块是否压缩）
 */
export function snappyDecompress(input) {
  if (!input || input.length === 0) return null;

  // 读取未压缩长度
  let pos = 0;
  let expected = 0;
  let shift = 0;
  for (;;) {
    if (pos >= input.length || shift > 32) return null;
    const byte = input[pos];
    pos += 1;
    expected += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  // 防御：长度异常（损坏或不是 Snappy）直接放弃
  if (expected <= 0 || expected > 64 * 1024 * 1024) return null;

  const out = Buffer.alloc(expected);
  let written = 0;

  while (pos < input.length && written < expected) {
    const tag = input[pos];
    pos += 1;
    const type = tag & 0x03;

    if (type === 0) {
      // literal
      let length = (tag >> 2) + 1;
      if (length > 60) {
        const extra = length - 60;          // 1..4 字节的长度字段
        if (pos + extra > input.length) return null;
        length = 0;
        for (let i = 0; i < extra; i += 1) length += input[pos + i] * 2 ** (8 * i);
        pos += extra;
        length += 1;
      }
      if (pos + length > input.length || written + length > expected) return null;
      input.copy(out, written, pos, pos + length);
      pos += length;
      written += length;
      continue;
    }

    let length;
    let offset;
    if (type === 1) {
      length = ((tag >> 2) & 0x07) + 4;
      if (pos >= input.length) return null;
      offset = ((tag >> 5) << 8) | input[pos];
      pos += 1;
    } else if (type === 2) {
      length = (tag >> 2) + 1;
      if (pos + 2 > input.length) return null;
      offset = input.readUInt16LE(pos);
      pos += 2;
    } else {
      length = (tag >> 2) + 1;
      if (pos + 4 > input.length) return null;
      offset = input.readUInt32LE(pos);
      pos += 4;
    }

    if (offset <= 0 || offset > written || written + length > expected) return null;

    // copy 允许重叠（RLE 场景），必须逐字节复制
    for (let i = 0; i < length; i += 1) {
      out[written] = out[written - offset];
      written += 1;
    }
  }

  return written === expected ? out : out.subarray(0, written);
}
