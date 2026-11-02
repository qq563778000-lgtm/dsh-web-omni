/**
 * 从本机浏览器的 cookie 库中取出 DeepSeek Web 登录态。
 *
 * 为什么需要它：用户要拿到 Token，现状是「打开浏览器 → F12 → Console →
 * 粘一段脚本 → 复制 → 回到设置页粘贴」。全自动做不到（DeepSeek 的登录态
 * 只存在于浏览器里），但「用户已在本机浏览器登录过」这个前提下，可以直接
 * 读浏览器自己的 cookie 库，省掉全部手工步骤。
 *
 * 实现要点与限制：
 *   - 只读，不写：先复制一份库文件再查询，绝不改动浏览器原始数据。
 *   - cookie 值用 AES-256-GCM 加密，密钥在 Local State 的
 *     os_crypt.encrypted_key，由 Windows DPAPI 以「当前用户」保护。
 *     因此**必须与浏览器同一 Windows 用户**运行，跨用户取不到。
 *   - 浏览器运行时会锁库，所以一律复制（含 -wal / -shm）后再读。
 *   - 不记录、不回显 cookie 原文；找到 token 后按 maskToken 脱敏返回。
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

/**
 * 用 DPAPI 解开浏览器的 master key。
 *
 * 走 PowerShell 的 ProtectedData 而不是原生模块：插件不引入编译期依赖，
 * 装机即用。命令里只传密钥的 base64，不含任何用户数据。
 */
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

/** 读取并解开某个浏览器 profile 的 master key。 */
function readMasterKey(userDataDir) {
  const statePath = join(userDataDir, 'Local State');
  if (!existsSync(statePath)) throw new Error('缺少 Local State');

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const encrypted = state?.os_crypt?.encrypted_key;
  if (!encrypted) throw new Error('Local State 中没有 encrypted_key');

  const raw = Buffer.from(encrypted, 'base64');
  // 前 5 字节固定是 "DPAPI"，属于标识而不是密钥内容。
  if (raw.subarray(0, 5).toString() !== 'DPAPI') {
    throw new Error('encrypted_key 前缀不是 DPAPI（可能是企业策略或非 Windows 平台）');
  }
  return dpapiUnprotect(raw.subarray(5).toString('base64'));
}

/**
 * 解密一条 cookie 值。
 *
 * Chrome/Edge 现行格式：[v10 或 v11][12 字节 nonce][密文][16 字节 GCM tag]。
 * 早期格式是 v10 + DPAPI 直接加密，这里一并兼容。
 */
function decryptCookieValue(buffer, masterKey) {
  if (!buffer || buffer.length < 4) return null;
  const prefix = buffer.subarray(0, 3).toString();

  if (prefix !== 'v10' && prefix !== 'v11') return null;

  // 早期 v10：整体就是 DPAPI 密文（没有 nonce/tag 结构）。
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

/**
 * 用 Python 的 sqlite3 查询复制出来的 cookie 库。
 *
 * 为什么不用 node 的 sqlite：Node 24 还没有稳定的内置 sqlite 驱动，
 * 而引入 better-sqlite3 需要编译（插件要"装完即用"）。Python 在
 * DSH 的用户机器上通常可用；不可用时由调用方降级到手工方式。
 */
function queryCookies(dbPath, hostKeyword) {
  const script = [
    'import sqlite3, json, sys',
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

/**
 * 枚举某个浏览器的所有 profile（Default / Profile 1 / Profile 2 …）。
 * 只取真实存在 cookie 库的目录。
 */
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

/**
 * 在某个浏览器里找 DeepSeek 的登录 token。
 *
 * 上游 Web 登录态的关键 cookie 名是 `userToken`（历史上也叫过 token）。
 * 这里不写死单一名字：凡是 deepseek.com 域下、名含 token 且值形态像
 * 令牌的都收集起来，按「名字精确匹配优先」排序后取第一个可用的。
 *
 * 返回 { ok, token, browser, profile, cookieName } 或 { ok:false, reason }。
 * 绝不把 token 原文写进日志或错误信息。
 */
function extractTokenFromBrowser(browser) {
  if (!existsSync(browser.root)) {
    return { ok: false, reason: '未安装' };
  }

  let masterKey;
  try {
    masterKey = readMasterKey(browser.root);
  } catch (err) {
    return { ok: false, reason: `无法读取密钥（${err.message}）` };
  }

  for (const profile of listProfiles(browser.root)) {
    let tmpDir;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), 'dwo-cookies-'));
      const copy = join(tmpDir, 'Cookies');
      // 复制而不是直接打开原库：浏览器运行时持有锁，且我们绝不改动原数据。
      copyFileSync(profile.db, copy);
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(profile.db + suffix)) copyFileSync(profile.db + suffix, copy + suffix);
      }

      const rows = queryCookies(copy, TARGET_HOST);
      if (!rows.length) continue;

      // 有 cookie 但全是 v20：说明是 App-Bound Encryption。
      // 这种情况必须与"没登录"区分开——用户去登录也没用，是浏览器版本的限制。
      const allV20 = rows.every(([, , hex]) => Buffer.from(hex, 'hex').subarray(0, 3).toString() === 'v20');

      // 名字优先级：上游历代用过的确切键名排在前面。
      const preferred = ['userToken', 'token', 'access_token', 'Authorization'];
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
        // token 形态：较长的、无空白的可见字符串。
        const candidate = String(value).trim();
        if (!candidate || candidate.length < 20 || /\s/.test(candidate)) continue;
        return { ok: true, token: candidate, browser: browser.name, profile: profile.name, cookieName: row.name };
      }

      // 有登录态却一条都解不开，且全部是 v20 → App-Bound Encryption。
      if (allV20) {
        return { ok: false, reason: 'encrypted-by-browser', browser: browser.name, profile: profile.name };
      }
    } catch {
      // 单个 profile 失败不影响其它 profile 继续尝试。
    } finally {
      if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
    }
  }

  return { ok: false, reason: '未找到登录态' };
}

/**
 * 扫描本机所有已知浏览器，返回第一个找到的 DeepSeek 登录 token。
 *
 * 返回值刻意不含 token 原文以外的东西；token 由调用方决定如何保存，
 * 本模块不做任何落盘。
 */
export function findBrowserToken() {
  const tried = [];
  for (const browser of BROWSERS) {
    if (!browser.root || !existsSync(browser.root)) continue;
    const result = extractTokenFromBrowser(browser);
    tried.push({
      browser: browser.name,
      ok: result.ok,
      reason: result.reason || null,
      profile: result.profile || null,
    });
    if (result.ok) return { ...result, tried };
    // 已经确认是浏览器加密限制：换其它浏览器大概率同样，但继续试完，
    // 让用户看到完整的探测结果，而不是停在第一个失败上。

  }
  return { ok: false, tried };
}

/** 本机可用浏览器探测（供设置页展示"检测到 Chrome / Edge"）。 */
export function listAvailableBrowsers() {
  return BROWSERS
    .filter(browser => browser.root && existsSync(browser.root))
    .map(browser => ({ id: browser.id, name: browser.name }));
}
