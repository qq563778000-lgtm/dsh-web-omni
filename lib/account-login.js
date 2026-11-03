/**
 * 用邮箱 + 密码登录 DeepSeek，换取 Token。
 *
 * 为什么必须借真实浏览器（2026-11-03 实测，结论明确）：
 *
 *   1. **WAF 拦的是"登录动作"，不是 IP**
 *      同一时刻、同一出口 IP：`chat_session/create` 返回 200 + 正常 JSON，
 *      而 `users/login` 返回 202 + 空响应。伪造 cookie / 真实 UA /
 *      X-Requested-With 全部无效——WAF 看的是 TLS 指纹与行为特征。
 *
 *   2. **登录请求的 body 是加密的**
 *      在真实 Chrome 里拦截该请求，拿到的是 224 字节二进制密文，不是
 *      明文 JSON。这正是 Node 侧直接发 JSON 永远 422 的原因——服务端
 *      解不开。要复刻就得逆向前端加密实现，上游一改就失效。
 *
 * 因此在真实 Chrome 里完成填表与提交，再从 localStorage 取回 token。
 * 这条路已验证可行：登录后 userToken 落地，且上游确认有效。
 *
 * 安全约定：
 *   - 密码只在内存里用于这一次填表，**不写入任何文件、不进日志**
 *   - 拿到 token 后立刻销毁浏览器进程与临时 profile 目录
 *   - 临时目录每次新建，不污染用户的浏览器配置
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 常见 Chrome 安装位置（Windows）。 */
const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

/** 找到可用的浏览器可执行文件。 */
export function findBrowserExecutable() {
  return CHROME_CANDIDATES.find(p => p && existsSync(p)) || null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 通过 DevTools Protocol 与浏览器通信的最小客户端。
 *
 * 只实现用得到的几个命令。手写而不是引 puppeteer/playwright：后者要
 * 多装 50MB+ 依赖，而这里只需要"打开页面、执行一段脚本、读回结果"。
 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let msgId = 0;
  const pending = new Map();

  const ready = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('无法连接浏览器调试端口'));
    setTimeout(() => reject(new Error('连接浏览器调试端口超时')), 15000);
  });

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  const send = (method, params = {}, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = ++msgId;
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} 超时`)); }
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });

  return { ws, ready, send };
}

/**
 * 在页面里执行登录流程，返回 token。
 *
 * 这段脚本运行在 chat.deepseek.com 的页面上下文里，因此它的请求带真实
 * 的 TLS 指纹与浏览器特征——这正是穿透 WAF 的关键。
 *
 * @param {{email: string, password: string}} creds
 * @returns {string} 登录脚本的表达式（返回 JSON 字符串）
 */
function buildLoginExpression({ email, password }) {
  // 凭据经 JSON.stringify 转义后嵌入，避免引号/反斜杠破坏表达式。
  const payload = JSON.stringify({ email, password });
  return `(async () => {
    const cred = ${payload};
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const out = { steps: [] };

    const clickText = (t) => {
      const el = Array.from(document.querySelectorAll('span,div,a,button,p,label'))
        .filter(e => e.children.length === 0 && (e.innerText || '').trim() === t).pop();
      if (el) { el.click(); return true; }
      return false;
    };

    // 登录页默认是"手机号 + 验证码"，密码登录是次要入口，必须先切过去。
    if (!clickText('密码登录')) {
      out.error = '页面上找不到「密码登录」入口';
      return JSON.stringify(out);
    }
    out.steps.push('已切换到密码登录');
    await sleep(3000);

    const ins = Array.from(document.querySelectorAll('input'));
    const pw = ins.find(i => i.type === 'password');
    const idInput = ins.find(i => i.type === 'text' || i.type === 'email');
    if (!pw || !idInput) {
      out.error = '找不到账号或密码输入框';
      return JSON.stringify(out);
    }

    // React 受控组件只认原生 setter + InputEvent，直接赋值 el.value 不生效。
    const set = (el, v) => {
      const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      s.call(el, v);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: v, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(idInput, cred.email);
    set(pw, cred.password);
    await sleep(800);

    const cands = Array.from(document.querySelectorAll('button, [role=button], div[class*=submit], span[class*=submit]'));
    const btn = cands.find(x => /登\\s*录/.test((x.innerText || '').trim()));
    if (!btn) {
      out.error = '找不到「登录」按钮';
      return JSON.stringify(out);
    }
    btn.click();
    out.steps.push('已提交');
    await sleep(9000);

    // 等待登录态落盘。成功时 URL 会从 /signin 跳到首页。
    let raw = null;
    for (let i = 0; i < 12; i++) {
      raw = localStorage.getItem('userToken') || localStorage.getItem('userTokens');
      if (raw) break;
      await sleep(1000);
    }

    // 页面上若显示错误（密码错、账号异常），如实带回，不要笼统报失败。
    const errEl = document.querySelector('.ds-form-error, [class*=error], [class*=Error]');
    out.pageError = errEl ? (errEl.innerText || '').trim().slice(0, 200) : '';
    out.url = location.href.slice(0, 120);
    out.raw = raw ? String(raw).slice(0, 2000) : '';

    return JSON.stringify(out);
  })()`;
}

/**
 * 从 localStorage 的原始值里取出 token。
 *
 * 两种已知形态：
 *   {"value":"<token>","__version":"0"}                     —— 当前版本
 *   {"<uid>":{"token":"...","expiration":"..."}}            —— 旧的多账号形态
 */
export function extractToken(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) {
      if (typeof parsed.value === 'string' && parsed.value.trim()) return parsed.value.trim();
      const entries = Object.values(parsed)
        .filter(v => v && typeof v === 'object' && typeof v.token === 'string')
        .sort((a, b) => (Date.parse(b.expiration || '') || 0) - (Date.parse(a.expiration || '') || 0));
      if (entries.length) return entries[0].token.trim();
    }
  } catch {
    // 不是 JSON，可能直接就是 token
  }
  return /^[A-Za-z0-9_+/=-]{20,}$/.test(text) ? text : null;
}

/**
 * 用账号密码登录，返回 token。
 *
 * @param {{email: string, password: string, timeoutMs?: number}} options
 * @returns {Promise<{ok: true, token: string} | {ok: false, reason: string, message: string}>}
 */
export async function loginWithAccount({ email, password, timeoutMs = 90000 } = {}) {
  const address = String(email || '').trim();
  const secret = String(password || '');
  if (!address || !secret) {
    return { ok: false, reason: 'invalid-input', message: '账号与密码都必须填写' };
  }

  const browser = findBrowserExecutable();
  if (!browser) {
    return {
      ok: false,
      reason: 'no-browser',
      message: '本机没有找到 Chrome 或 Edge。账号登录需要借真实浏览器完成'
        + '（登录接口有防火墙校验，程序直连会被拦截），请安装 Chrome，'
        + '或改用「从浏览器获取 Token」。',
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'dwo-login-'));
  // 端口随机化：固定端口在并发或残留进程时会冲突。
  const port = 20000 + Math.floor(Math.random() * 20000);
  let proc = null;
  let client = null;

  const cleanup = () => {
    try { client?.ws?.close(); } catch { /* 已关闭 */ }
    try { proc?.kill(); } catch { /* 已退出 */ }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* 忽略 */ }
    proc = null;
    client = null;
  };

  try {
    proc = spawn(browser, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      // 每次用全新的临时 profile：不碰用户自己的浏览器数据，
      // 也避免复用已登录状态导致"登录成功"的假象。
      '--user-data-dir=' + join(dir, 'ud'),
      '--remote-debugging-port=' + port,
      'https://chat.deepseek.com/signin',
    ], { stdio: 'ignore' });

    // 等浏览器起来。相比轮询端口，固定的短暂等待更简单；
    // 后续连不上还有 ready 的超时兜底。
    await sleep(3500);

    const deadline = Date.now() + 15000;
    let page = null;
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        page = list.find(t => t.type === 'page');
        if (page) break;
      } catch { /* 还没起来 */ }
      await sleep(500);
    }
    if (!page) {
      return { ok: false, reason: 'browser-failed', message: '浏览器没能启动，请稍后重试' };
    }

    client = connect(page.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Runtime.enable');

    // SPA 渲染需要时间，太早执行脚本会找不到元素。
    await sleep(6000);

    const res = await client.send('Runtime.evaluate', {
      expression: buildLoginExpression({ email: address, password: secret }),
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);

    const rawValue = res?.result?.result?.value;
    if (!rawValue) {
      return { ok: false, reason: 'login-failed', message: '登录脚本没有返回结果，请重试' };
    }

    let parsed;
    try {
      parsed = JSON.parse(rawValue);
    } catch {
      return { ok: false, reason: 'login-failed', message: '登录结果无法解析，请重试' };
    }

    if (parsed.error) {
      return { ok: false, reason: 'login-failed', message: parsed.error };
    }

    const token = extractToken(parsed.raw);
    if (!token) {
      // 没拿到 token 时，把页面上的提示原样带回——密码错、账号被限制
      // 这些信息只有上游知道，猜不出来。
      const hint = parsed.pageError
        ? `登录失败：${parsed.pageError}`
        : '登录后没有拿到 Token。请确认账号密码正确；'
          + '若账号开启了二次验证，请改用「从浏览器获取 Token」。';
      return { ok: false, reason: 'no-token', message: hint };
    }

    return { ok: true, token };
  } catch (err) {
    return { ok: false, reason: 'login-failed', message: String(err?.message || err) };
  } finally {
    cleanup();
  }
}
