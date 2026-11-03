/**
 * 从本机浏览器读取 DeepSeek Web 的登录 Token。
 *
 * 两条读取路径，按可靠性排序：
 *
 * **主路径：Local Storage（可用）**
 *   DeepSeek Web 把登录态存在 localStorage 的 `userToken` / `userTokens`，
 *   而 localStorage（Chromium 的 LevelDB）**完全不加密**——键值就是明文。
 *   2026-11-02 实测：从 Chrome 156 的 024783.ldb 中直接读出了结构化登录态。
 *
 * **兜底：Cookies（在新版浏览器上已不可用）**
 *   Chrome 127 / Edge 127 起，cookie 改为 App-Bound Encryption（`v20` 前缀），
 *   密钥由浏览器以自身身份向系统服务申请，同用户的其它进程也解不开。
 *   实测用 DPAPI 解出的 master key 解 40 条真实 cookie，成功 0 条。
 *   保留这条路径只为兼容旧版本浏览器。
 *
 * 一条重要限制（数据时效性）：
 *   浏览器**运行中**时，最近的 localStorage 写入留在内存 memtable 里，尚未
 *   落盘。本模块只能读到已刷盘的数据。用户关闭该标签页后即可读到最新值。
 *   找不到时要把这一点告知用户，而不是笼统地说"没登录"。
 *
 * 安全约束：只读不写；不修改浏览器任何数据；不把 token 写进日志。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseStoredToken, readKeyFromLevelDbFile } from './local-storage.js';

/** 已知的浏览器数据目录（按 Windows 常见安装位置）。 */
const BROWSERS = [
  {
    id: 'chrome',
    name: 'Chrome',
    root: join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data'),
  },
  {
    id: 'edge',
    name: 'Edge',
    root: join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/User Data'),
  },
  {
    id: 'edge-beta',
    name: 'Edge Beta',
    root: join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge Beta/User Data'),
  },
  {
    id: 'brave',
    name: 'Brave',
    root: join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/User Data'),
  },
];

/** DeepSeek Web 的域名。 */
const TARGET_HOST = 'deepseek.com';

// ---------------------------------------------------------------------------
// 主路径：Local Storage
// ---------------------------------------------------------------------------

/**
 * 从某个浏览器的 localStorage 里收集**所有**候选 token。
 *
 * 为什么不是一个：用户的多个 Chrome 账号可能各自登录过 DeepSeek，每个
 * profile 都留着历史 token，且**失效的往往还排在前面**（实测 Profile 1
 * 的 ddStde… 已失效，Profile 2 的 bEssK7… 才有效）。
 *
 * 单靠"哪个文件最新"猜不准——两个 profile 的 .log 常常同为最新。
 * 正确做法是把候选全部取出，由上层逐个问上游"这个还能用吗"，
 * 用事实而不是时间戳来决定。
 *
 * @returns {Array<{ token, profile, file, key, mtime }>}
 */
export function collectLocalStorageTokens(browser) {
  if (!browser.root || !existsSync(browser.root)) return [];

  let profiles;
  try {
    profiles = readdirSync(browser.root);
  } catch {
    return [];
  }

  const out = [];

  for (const profile of profiles) {
    const leveldb = join(browser.root, profile, 'Local Storage', 'leveldb');
    if (!existsSync(leveldb)) continue;

    let files;
    try {
      files = readdirSync(leveldb);
    } catch {
      continue;
    }

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

    const seen = new Set();
    for (const key of ['userToken', 'userTokens']) {
      for (const file of ordered) {
        let value;
        try {
          value = readKeyFromLevelDbFile(file.full, key);
        } catch {
          continue;
        }
        if (!value) continue;
        const token = parseStoredToken(value);
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push({ token, profile, file: file.name, key, mtime: file.mtime });
      }
    }
  }

  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * 从某个浏览器的 localStorage 里找 DeepSeek 的登录 token。
 *
 * 只取活跃度最高的那个，**不判断有效性**——调用方需要自己验证。
 * 保留这个便捷入口供不需要验证的场景使用。
 */
function readFromLocalStorage(browser) {
  const all = collectLocalStorageTokens(browser);
  if (!all.length) {
    if (!browser.root || !existsSync(browser.root)) {
      return { ok: false, reason: '未安装' };
    }
    return { ok: false, reason: 'localStorage 中没有登录记录' };
  }
  const hit = all[0];
  return {
    ok: true,
    token: hit.token,
    browser: browser.name,
    profile: hit.profile,
    source: 'localStorage',
    key: hit.key,
  };
}

/**
 * 判断该浏览器的 localStorage 是否"有 DeepSeek 的痕迹但没读到 token"。
 *
 * 用来区分两种失败，给出的提示完全不同：
 *   - 完全没登录 → 让用户去登录
 *   - 登录了但没落盘 → 让用户关掉标签页（Chrome 在页面打开时把写入留在内存）
 */
function hasDeepSeekTrace(browser) {
  if (!browser.root || !existsSync(browser.root)) return false;
  let profiles;
  try {
    profiles = readdirSync(browser.root);
  } catch {
    return false;
  }
  const needle = Buffer.from('_https://chat.deepseek.com', 'latin1');
  for (const profile of profiles) {
    const dir = join(browser.root, profile, 'Local Storage', 'leveldb');
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.(ldb|log)$/.test(name)) continue;
      try {
        if (readFileSync(join(dir, name)).includes(needle)) return true;
      } catch { /* 单文件读失败忽略 */ }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 兜底路径：Cookies（仅旧版浏览器可用）
// ---------------------------------------------------------------------------

/** 用 DPAPI 解开浏览器的 master key。 */
function dpapiUnprotect(base64) {
  const script = [
    'Add-Type -AssemblyName System.Security;',
    `$raw = [Convert]::FromBase64String('${base64}');`,
    '$dec = [System.Security.Cryptography.ProtectedData]::Unprotect(',
    '  $raw, $null,',
    '  [System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[Convert]::ToBase64String($dec)',
  ].join('');

  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  }).trim();

  if (!out) throw new Error('DPAPI 返回空结果');
  return Buffer.from(out, 'base64');
}

function readMasterKey(userDataDir) {
  const statePath = join(userDataDir, 'Local State');
  if (!existsSync(statePath)) throw new Error('缺少 Local State');

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const encrypted = state?.os_crypt?.encrypted_key;
  if (!encrypted) throw new Error('Local State 中没有 encrypted_key');

  const raw = Buffer.from(encrypted, 'base64');
  if (raw.subarray(0, 5).toString() !== 'DPAPI') {
    throw new Error('encrypted_key 前缀不是 DPAPI');
  }
  return dpapiUnprotect(raw.subarray(5).toString('base64'));
}

/** 解密一条 cookie 值（v10/v11：AES-256-GCM）。 */
function decryptCookieValue(buffer, masterKey) {
  if (!buffer || buffer.length < 4) return null;
  const prefix = buffer.subarray(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') return null;

  if (buffer.length < 31) {
    try {
      return dpapiUnprotect(buffer.subarray(3).toString('base64'));
    } catch {
      return null;
    }
  }

  const nonce = buffer.subarray(3, 15);
  const ciphertext = buffer.subarray(15, buffer.length - 16);
  const tag = buffer.subarray(buffer.length - 16);

  try {
    const decipher = createDecipheriv('aes-256-gcm', masterKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function queryCookies(dbPath, hostKeyword) {
  const script = [
    'import sqlite3, json',
    `con = sqlite3.connect(r'${dbPath.replace(/\\/g, '\\\\')}')`,
    'rows = con.execute(',
    '  "SELECT host_key, name, encrypted_value FROM cookies WHERE host_key LIKE ?",',
    `  ('%${hostKeyword}%',)`,
    ').fetchall()',
    'print(json.dumps([[h, n, bytes(e).hex()] for h, n, e in rows]))',
  ].join('\n');

  const out = execFileSync('python', ['-c', script], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });

  return JSON.parse(out || '[]');
}

function listProfiles(userDataDir) {
  const profiles = [];
  try {
    for (const name of readdirSync(userDataDir)) {
      const dir = join(userDataDir, name);
      let stat;
      try { stat = statSync(dir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const db = join(dir, 'Network', 'Cookies');
      if (existsSync(db)) profiles.push({ name, db });
    }
  } catch { /* 目录不可读，忽略 */ }
  return profiles;
}

function readFromCookies(browser) {
  if (!browser.root || !existsSync(browser.root)) {
    return { ok: false, reason: '未安装' };
  }

  let masterKey;
  try {
    masterKey = readMasterKey(browser.root);
  } catch (err) {
    return { ok: false, reason: `无法读取密钥（${err.message}）` };
  }

  const preferred = ['userToken', 'token', 'access_token', 'Authorization'];

  for (const profile of listProfiles(browser.root)) {
    let tmpDir;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), 'dwo-cookies-'));
      const copy = join(tmpDir, 'Cookies');
      copyFileSync(profile.db, copy);
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(profile.db + suffix)) copyFileSync(profile.db + suffix, copy + suffix);
      }

      const rows = queryCookies(copy, TARGET_HOST);
      if (!rows.length) continue;

      const scored = rows
        .map(([host, name, hex]) => {
          const rank = preferred.indexOf(name);
          return { host, name, hex, rank: rank < 0 ? preferred.length : rank };
        })
        .filter(row => /token|auth/i.test(row.name) || row.rank < preferred.length)
        .sort((a, b) => a.rank - b.rank);

      for (const row of scored) {
        const value = decryptCookieValue(Buffer.from(row.hex, 'hex'), masterKey);
        if (!value) continue;
        const candidate = String(value).trim();
        if (!candidate || candidate.length < 20 || /\s/.test(candidate)) continue;
        return { ok: true, token: candidate, browser: browser.name, profile: profile.name, source: 'cookie' };
      }
    } catch {
      // 单个 profile 失败不影响其它
    } finally {
      if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
    }
  }

  return { ok: false, reason: 'cookie 中没有可用 token' };
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/**
 * 扫描本机所有已知浏览器，返回第一个找到的 DeepSeek 登录 token。
 *
 * 顺序：先找 localStorage（可靠），全部失败再退回 cookie（兼容旧浏览器）。
 *
 * 传入 validate 时会用它逐个验证候选 token，返回**第一个通过验证的**。
 * 这一步不可省略：多个 profile 各自留着历史 token，失效的常常排在最前
 * （实测 Profile 1 失效、Profile 2 有效），只取第一个必然拿到废值。
 *
 * @param {{ validate?: (token: string) => Promise<boolean> }} [options]
 */
export async function findBrowserToken({ validate = null } = {}) {
  const tried = [];

  // 第一轮：localStorage。
  //
  // 关键：不能"取到第一个就用"。多个 profile 的历史 token 混在一起，
  // 失效的那个常常排在最前面（实测 Profile 1 失效、Profile 2 有效）。
  // 传入 validate 时逐个问上游，用事实决定；返回所有候选供上层展示。
  for (const browser of BROWSERS) {
    if (!browser.root || !existsSync(browser.root)) continue;

    const candidates = collectLocalStorageTokens(browser);
    if (!candidates.length) {
      tried.push({
        browser: browser.name,
        source: 'localStorage',
        ok: false,
        reason: 'localStorage 中没有登录记录',
        // 有痕迹但没读到 token → 多半是页面还开着、数据未落盘
        pending: hasDeepSeekTrace(browser),
      });
      continue;
    }

    if (typeof validate !== 'function') {
      const hit = candidates[0];
      return {
        ok: true,
        token: hit.token,
        browser: browser.name,
        profile: hit.profile,
        source: 'localStorage',
        key: hit.key,
        tried,
      };
    }

    for (const candidate of candidates) {
      let valid = false;
      try {
        valid = Boolean(await validate(candidate.token));
      } catch {
        valid = false;
      }
      if (!valid) continue;
      return {
        ok: true,
        token: candidate.token,
        browser: browser.name,
        profile: candidate.profile,
        source: 'localStorage',
        key: candidate.key,
        tried,
      };
    }

    // 有记录但全部失效：这是"读到过期登录记录"，不是"没登录"
    tried.push({
      browser: browser.name,
      source: 'localStorage',
      ok: false,
      reason: 'stale',
      count: candidates.length,
    });
  }

  // 第二轮：cookie（旧版浏览器才有意义）
  for (const browser of BROWSERS) {
    if (!browser.root || !existsSync(browser.root)) continue;
    const result = readFromCookies(browser);
    if (result.ok && (typeof validate !== 'function' || await validate(result.token))) {
      return { ...result, tried };
    }
  }

  if (tried.some(entry => entry.reason === 'stale')) {
    return { ok: false, reason: 'stale', tried };
  }

  const pending = tried.find(entry => entry.pending);
  if (pending) {
    return {
      ok: false,
      reason: 'not-flushed',
      browser: pending.browser,
      tried,
    };
  }

  return { ok: false, reason: 'not-found', tried };
}

/** 本机可用浏览器探测（供设置页展示"检测到 Chrome / Edge"）。 */
export function listAvailableBrowsers() {
  return BROWSERS
    .filter(browser => browser.root && existsSync(browser.root))
    .map(browser => ({ id: browser.id, name: browser.name }));
}
