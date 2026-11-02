/**
 * 读取 Chromium 系浏览器（Chrome / Edge / Brave …）的 Local Storage。
 *
 * 为什么是 Local Storage 而不是 Cookies：
 *
 * DeepSeek Web 把登录态存在 **localStorage** 的 `userToken` / `userTokens`，
 * 而不是 cookie。这一点决定了可行性——cookie 从 Chrome 127 起启用
 * App-Bound Encryption，密钥由浏览器自身身份向系统服务申请，第三方进程
 * 即使同一 Windows 用户也解不开；而 **localStorage 完全不加密**，
 * LevelDB 里的键值就是明文。
 *
 * 实测到的物理布局（2026-11-02，Chrome 156 的 024783.ldb）：
 *
 *   "userTokens"  01  7d 1b 03 00  00 00 00  01  {"MTUw...":{"token":"..."}}
 *   └─ key ────┘ │  └──── 长度 ────┘ │  └────── value ──────┘
 *                │   （4 字节，小端）  └─ 类型标记
 *                └─ 值类型/标志
 *
 * 注意：不同 Chromium 版本的表格式有差异——有的把 origin 写进 key
 * （`_https://chat.deepseek.com\x00\x01userToken`），有的只写裸键名。
 * 因此解析不能依赖固定前缀，而要**按 key 名直接定位**，再在 key 之后
 * 尝试几种可能的长度字段编码。
 *
 * 重要限制：浏览器运行时，最近的写入留在内存 memtable 里，尚未落盘。
 * 本模块只能读到**已刷盘**的数据；用户关闭该标签页后即可读到。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 浏览器数据目录下的 localStorage 键名。 */
export const TOKEN_KEYS = ['userToken', 'userTokens'];

/** 值是否是"看起来像 token"的字符串。 */
function looksLikeToken(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 20 || text.length > 4096) return false;
  // DeepSeek 的 token 是 base64url 风格：字母数字 + - _，偶尔带 = 填充
  return /^[A-Za-z0-9_-]+={0,2}$/.test(text);
}

/** LevelDB 的变长整数解码（续位在最高位）。 */
function readVarint(buffer, position) {
  let result = 0;
  let shift = 0;
  let cursor = position;

  while (cursor < buffer.length && shift < 64) {
    const byte = buffer[cursor];
    cursor += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value: result, next: cursor };
    shift += 7;
  }
  return null;
}

/** 读 4 字节小端无符号整数。 */
function readUint32LE(buffer, position) {
  if (position + 4 > buffer.length) return null;
  return buffer.readUInt32LE(position);
}

/**
 * 尝试从 `start` 起解析出一段"长度 + 内容"，返回内容字符串。
 *
 * 依次尝试三种长度编码（实测不同表格式都用过）：
 *   1. 4 字节小端（Chromium localStorage 的常见形态）
 *   2. varint（标准 LevelDB）
 *   3. 跳过 1~2 字节类型标记后再试上面两种
 */
function readLengthPrefixed(buffer, start, maxLength = 4 * 1024 * 1024, depth = 0) {
  // 实测布局（Chrome 156，024783.ldb，`userTokens` 条目）：
  //
  //   01 | 7d 1b 03 00 00 00 00 | 01 | {"MTUwMTc4ODM...
  //   ↑    └─ 长度 0x31b7d ────┘   ↑    └─ JSON ─
  //   类型     （小端，但字节数因值而异）  类型
  //
  // 长度字段的**字节数不固定**（这里是 7 字节），硬编码 4/8 都会错。
  // 因此改成结构推断：在 key 之后的小窗口里，找第一个 "{"/"["/"\"" 作为
  // 值的起点；再用"从该起点到下一个控制字符/文件末尾"确定值的终点。
  //
  // 这条路径比读长度更稳：localStorage 的值一定是 UTF-8 文本，而 SQLite 式
  // 的长度前缀在不同 Chromium 版本里变过好几次。
  const WINDOW = 24;
  const probeEnd = Math.min(start + WINDOW, buffer.length);

  for (let at = start; at < probeEnd; at += 1) {
    const char = buffer[at];
    if (char !== 0x7b && char !== 0x5b && char !== 0x22) continue;   // { [ "

    // 从 at 起截到下一个控制字符（\x00-\x08 等）为止
    let end = at;
    while (end < buffer.length && end - at <= maxLength) {
      const byte = buffer[end];
      if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) break;
      end += 1;
    }
    if (end - at < 8) continue;

    const text = buffer.subarray(at, end).toString('utf8').trim();
    if (!text) continue;
    // 值必须以完整结构收尾，否则是"读到了别的条目的开头"
    const first = text[0];
    const last = text[text.length - 1];
    if (first === '{' && last !== '}') continue;
    if (first === '[' && last !== ']') continue;
    if (first === '"' && last !== '"') continue;
    return text;
  }

  return null;
}

/**
 * 在一个 LevelDB 文件里查找指定键的值。
 *
 * 做法：直接搜键名字节，然后在其后尝试解析长度前缀。之所以不用"origin 前缀"
 * 定位，是因为实测有的表把 origin 编码进 key、有的不编码，硬编码前缀会漏。
 */
export function readKeyFromLevelDbFile(filePath, key) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return null;
  }

  const needle = Buffer.from(key, 'latin1');
  let searchFrom = 0;

  const isIdent = (c) => /[A-Za-z0-9_]/.test(String.fromCharCode(c));

  while (searchFrom < buffer.length) {
    const at = buffer.indexOf(needle, searchFrom);
    if (at < 0) break;
    searchFrom = at + 1;

    // 键名两侧都不能紧邻标识符字符——否则查 "userToken" 会命中
    // "userTokens" 的前缀，把结构化 JSON 当成纯 token 返回。
    // 注意"后面"的检查必须看 needle 之后的那个字节：`userTokens` 中
    // needle 后面紧跟 `s`，是标识符，据此排除。
    const before = at > 0 ? buffer[at - 1] : 0;
    const after = at + needle.length < buffer.length ? buffer[at + needle.length] : 0;
    if (isIdent(before) || isIdent(after)) continue;

    // 键名之后通常有 1 字节的类型标记（0x01），也可能直接跟长度
    for (let offset = 0; offset <= 2; offset += 1) {
      const value = readLengthPrefixed(buffer, at + needle.length + offset);
      if (!value || !value.trim()) continue;

      const head = value.trim()[0];
      // 值必须是我们认识的两种形态之一；否则说明长度/起点判断错了
      const looksRight = head === '{' || head === '[' || /^[A-Za-z0-9_-]{20,}/.test(value.trim());
      if (looksRight) return value;
    }
  }

  return null;
}

/**
 * 在某个浏览器的所有 profile 中查找指定 localStorage 键。
 *
 * @param {string} userDataDir 形如 `.../Google/Chrome/User Data`
 * @param {string[]} keys 候选键名，按优先级排列
 * @returns {{ profile: string, file: string, key: string, value: string } | null}
 */
export function findInLocalStorage(userDataDir, keys = TOKEN_KEYS) {
  if (!existsSync(userDataDir)) return null;

  let profiles;
  try {
    profiles = readdirSync(userDataDir);
  } catch {
    return null;
  }

  let best = null;

  for (const profile of profiles) {
    const leveldb = join(userDataDir, profile, 'Local Storage', 'leveldb');
    if (!existsSync(leveldb)) continue;

    let files;
    try {
      files = readdirSync(leveldb);
    } catch {
      continue;
    }

    // 新的文件优先：同一个键可能有多份历史值，越新的越接近当前登录态。
    const ordered = files
      .filter(name => /\.(ldb|log)$/.test(name))
      .map(name => {
        const full = join(leveldb, name);
        try {
          return { name, full, mtime: statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    for (const key of keys) {
      for (const file of ordered) {
        const value = readKeyFromLevelDbFile(file.full, key);
        if (!value) continue;
        const entry = { profile, file: file.name, key, value, mtime: file.mtime };
        if (!best || entry.mtime > best.mtime) best = entry;
        break;   // 该 key 已在这个 profile 找到，换下一个 key
      }
    }
  }

  return best;
}

/**
 * 从 localStorage 的原始值里抽出真正的 token。
 *
 * 三种历史形态都要支持：
 *   1. 直接就是 token（旧版 `userToken`）
 *   2. 结构化（新版 `userTokens`）：
 *      `{"<base64 uid>":{"token":"...","expiration":"2027-05-07T..."}}`
 *   3. 被引号/转义包裹的片段
 *
 * 结构化且有多个账号时，取 expiration 最晚的那个——它对应最近登录的账号。
 */
export function parseStoredToken(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  if (looksLikeToken(text)) return text;

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const entries = Object.values(parsed)
        .filter(item => item && typeof item === 'object' && typeof item.token === 'string')
        .map(item => ({
          token: item.token,
          expiration: Date.parse(item.expiration || '') || 0,
        }))
        .filter(item => looksLikeToken(item.token))
        .sort((a, b) => b.expiration - a.expiration);

      if (entries.length) return entries[0].token;
    }
  } catch {
    // 不是完整 JSON，继续尝试从片段里挖
  }

  const embedded = text.match(/"token"\s*:\s*"([A-Za-z0-9_-]{30,200})"/);
  if (embedded) return embedded[1];

  const unwrapped = text.replace(/^["'`]|["'`]$/g, '').trim();
  if (looksLikeToken(unwrapped)) return unwrapped;

  return null;
}

/** 供测试与诊断：列出某个 profile 下所有 LevelDB 文件名。 */
export function listLevelDbFiles(userDataDir, profile) {
  const dir = join(userDataDir, profile, 'Local Storage', 'leveldb');
  try {
    return readdirSync(dir).filter(name => /\.(ldb|log)$/.test(name));
  } catch {
    return [];
  }
}
