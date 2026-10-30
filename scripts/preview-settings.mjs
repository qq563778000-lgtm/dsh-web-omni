/**
 * 设置页视觉预览（开发期工具）
 *
 * 为什么需要：样式好不好看无法靠读代码判断。DSH 客户端插件跑在宿主的
 * 预打包模块加载器里，无法直接在本机渲染。这里提取 client.js 里真实的
 * CSS 常量，按 Section 的 DOM 结构手写等价 HTML，再用 headless Chrome
 * 截图——渲染结果与 React 输出一致，可以直接看效果。
 *
 * 用法：node scripts/preview-settings.mjs [输出png]
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const clientSrc = readFileSync(join(ROOT, 'client', 'client.js'), 'utf8');

// 提取 CSS 模板字符串（const CSS = ` ... `;）
const cssMatch = clientSrc.match(/const CSS = `([\s\S]*?)`;\n/);
if (!cssMatch) throw new Error('未能从 client.js 提取 CSS');
const CSS = cssMatch[1];

// DSH 主题变量的 fallback 值（client.js 里写的就是这些）
const THEME = `
:root{
  --dsw-alias-label-primary:#1f1e1d;
  --dsw-alias-label-secondary:#6b6b6b;
  --dsw-alias-label-tertiary:#8a8a8a;
  --dsw-alias-bg-base:#ffffff;
  --dsw-alias-bg-layer-1:#ffffff;
  --dsw-alias-bg-layer-3:rgba(127,127,127,.06);
  --dsw-alias-border-l4:rgba(127,127,127,.25);
  --dsw-alias-interactive-bg-hover:rgba(127,127,127,.08);
  --dsw-alias-state-success-primary:#16a34a;
  --dsw-alias-state-error-primary:#c22;
  --dsw-radius-md:8px;
  --dsw-radius-lg:12px;
}
body{margin:0;padding:24px;background:#fff;font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
`;

// 与 Section 的 return 结构一一对应的静态 HTML
const BODY = `
<div class="dwo-root">
  <div class="dwo-head">
    <h3 class="dwo-title">dsh-web-omni</h3>
    <p class="dwo-sub">DeepSeek Web 转 API · 凭据池</p>
  </div>

  <div class="dwo-stats">
    <div class="dwo-stat"><span class="dwo-stat-label">可用</span><span class="dwo-stat-value">1</span></div>
    <div class="dwo-stat"><span class="dwo-stat-label">总数</span><span class="dwo-stat-value">2</span></div>
    <div class="dwo-stat dwo-stat-warn"><span class="dwo-stat-label">已禁用</span><span class="dwo-stat-value">1</span></div>
  </div>

  <p class="dwo-notice">凭据池尚未就绪，首次对话时会自动初始化。</p>

  <ul class="dwo-list">
    <li class="dwo-row">
      <span class="dwo-label">+U7ZgprKcckU…</span>
      <span class="dwo-badge dwo-badge-ok">可用</span>
      <button class="dwo-btn dwo-btn-link">删除</button>
    </li>
    <li class="dwo-row">
      <span class="dwo-label">vo4x8Wjy2wpB…</span>
      <span class="dwo-err">错误 5</span>
      <span class="dwo-badge dwo-badge-off">已禁用</span>
      <button class="dwo-btn dwo-btn-link">删除</button>
    </li>
  </ul>

  <div class="dwo-add">
    <input class="dwo-input" placeholder="粘贴 DeepSeek Web Token" />
    <button class="dwo-btn dwo-btn-primary">添加</button>
  </div>

  <details class="dwo-help" open>
    <summary>如何获取 Token</summary>
    <div class="dwo-help-body">
      <ol class="dwo-help-steps">
        <li>在浏览器打开 chat.deepseek.com 并登录。</li>
        <li>按 F12 打开开发者工具，切到 Console。</li>
        <li>粘贴下面的命令并回车，Token 会自动复制到剪贴板。</li>
      </ol>
      <div class="dwo-code-wrap">
        <pre class="dwo-code"><code>(()=&gt;{const pick=v=&gt;{if(!v)return'';try{const j=JSON.parse(v);return j.value||j.token||j.access_token||''}catch{return v}};const known=['userToken','token','dsc-token','auth_token'];let t='';for(const k of known){t=pick(localStorage.getItem(k));if(t)break}if(!t){const m=document.cookie.match(/(?:^|;\s*)(?:userToken|token)=([^;]+)/);if(m)t=decodeURIComponent(m[1])}if(!t){const hits=[];for(let i=0;i&lt;localStorage.length;i++){const k=localStorage.key(i);const v=localStorage.getItem(k)||'';if(!/token|auth|jwt/i.test(k)&amp;&amp;!/token/i.test(v.slice(0,80)))continue;const c=pick(v);if(typeof c==='string'&amp;&amp;/^[A-Za-z0-9_.+/=-]{40,200}$/.test(c))hits.push([k,c])}if(hits.length===1)t=hits[0][1];else if(hits.length&gt;1){console.log('[OmniAPI] 找到多个候选，请手动复制正确的那个：');hits.forEach(([k,c])=&gt;console.log(k,'=',c));return}}if(!t){console.warn('[OmniAPI] 未自动找到 Token。');return}navigator.clipboard.writeText(t).then(()=&gt;console.log('[OmniAPI] Token 已复制'))})()</code></pre>
        <button class="dwo-btn dwo-btn-link dwo-code-copy">复制命令</button>
      </div>
      <p class="dwo-hint">若命令提示找不到，请在 Network 面板里任选一个 api 请求，复制请求头 Authorization 中 Bearer 之后的字符。</p>
      <p class="dwo-hint">Token 等同于账号登录态，只保存在本机，不要分享给他人。</p>
    </div>
  </details>

  <div class="dwo-actions">
    <button class="dwo-btn">测试全部凭据</button>
    <button class="dwo-btn">刷新</button>
  </div>

  <ul class="dwo-test">
    <li class="dwo-test-ok">+U7ZgprKcckU… — 有效</li>
    <li class="dwo-test-bad">vo4x8Wjy2wpB… — 无效（Token invalid (40003)）</li>
  </ul>
</div>
`;

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${THEME}${CSS}</style></head><body>${BODY}</body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'omni-preview-'));
const htmlPath = join(dir, 'preview.html');
writeFileSync(htmlPath, html, 'utf8');

const out = process.argv[2] || join(ROOT, 'settings-preview.png');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(p => { try { execFileSync('cmd', ['/c', 'if', 'exist', `"${p}"`, 'exit', '0']); return true; } catch { return false; } });

if (!CHROME) {
  console.log('未找到 Chrome，已生成预览文件：', htmlPath);
  process.exit(0);
}

execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--window-size=680,940',
  `--screenshot=${out}`,
  `file:///${htmlPath.replace(/\\/g, '/')}`,
], { stdio: 'ignore' });

console.log('✓ 已生成预览：', out);
console.log('  HTML 源：', htmlPath);
