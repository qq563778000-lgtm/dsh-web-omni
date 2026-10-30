/**
 * dsh-web-omni 设置页
 *
 * DSH 的客户端插件是预打包模块：宿主用 window.__ModuleLoader__.load
 * 注入一个 factory，我们从 factory 参数拿到 require('react')，返回
 * { inject, apply }。不能直接 import react。
 *
 * 页面职责：
 *   - 展示凭据池状态（可用数、禁用原因、剩余禁期）
 *   - 录入 Token
 *   - 一键测试全部凭据
 *
 * 设计约定（与 DSH 原生设置页保持一致）：
 *   - 只使用 Host 暴露的 --dsw-* 主题变量取色，不写死颜色，
 *     深浅色主题切换时自动跟随
 *   - 样式集中在注入的 <style> 里，而不是每个元素写内联 style：
 *     内联样式无法表达 :hover / :focus-visible，交互反馈会缺失
 *   - 字号与圆角沿用 Host 的刻度（正文 13、说明 12、圆角 8/12）
 *
 * 页面**不显示凭据明文**：后端返回的已是掩码，这里也不提供"查看"入口。
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-omni',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useCallback } = React;

    const NS = 'dsh-web-omni';
    const STATUS_PATH = '/api/dsh-web-omni/status';
    const CREDENTIALS_PATH = '/api/dsh-web-omni/credentials';
    const TEST_PATH = '/api/dsh-web-omni/test';

    const text = {
      title: 'dsh-web-omni',
      subtitle: 'DeepSeek Web 转 API · 凭据池',
      available: '可用',
      total: '总数',
      disabled: '已禁用',
      tokenPlaceholder: '粘贴 DeepSeek Web Token',
      add: '添加',
      remove: '删除',
      testAll: '测试全部凭据',
      testing: '测试中…',
      reload: '刷新',
      empty: '还没有凭据。添加一个 Token 后，即可在模型选择器里选 omni 开始对话。',
      notReady: '凭据池尚未就绪，首次对话时会自动初始化。',
      valid: '有效',
      invalid: '无效',
      helpTitle: '如何获取 Token',
      helpStep1: '在浏览器打开 chat.deepseek.com 并登录。',
      helpStep2: '按 F12 打开开发者工具，切到 Console。',
      helpStep3: '粘贴下面的命令并回车，Token 会自动复制到剪贴板。',
      copyCommand: '复制命令',
      copied: '已复制',
      helpFallback: '若命令提示找不到，请在 Network 面板里任选一个 api 请求，复制请求头 Authorization 中 Bearer 之后的字符。',
      helpPrivacy: 'Token 等同于账号登录态，只保存在本机，不要分享给他人。',
    };

    /**
     * 在浏览器控制台里自动取出 DeepSeek Web 的 token 并复制。
     *
     * 为什么要「先试已知键、再扫描兜底」：上游前端的存储键名换过几次
     * （userToken / token / dsc-token），写死一个键在版本变化后就会失效，
     * 而用户只会看到"找不到 Token"，不知道该怪谁。
     *
     * 兜底扫描的判据保守：键名或值里出现 token/auth 字样，且值本身是
     * 40~200 字符的 base64url 串——这正好是 DeepSeek token 的形态。
     * 命中多于一个时全部打印出来让用户自己挑，绝不瞎选一个塞进去。
     */
    const TOKEN_COMMAND = `(()=>{const pick=v=>{if(!v)return'';try{const j=JSON.parse(v);return j.value||j.token||j.access_token||''}catch{return v}};const known=['userToken','token','dsc-token','auth_token'];let t='';for(const k of known){t=pick(localStorage.getItem(k));if(t)break}if(!t){const m=document.cookie.match(/(?:^|;\\s*)(?:userToken|token)=([^;]+)/);if(m)t=decodeURIComponent(m[1])}if(!t){const hits=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);const v=localStorage.getItem(k)||'';if(!/token|auth|jwt/i.test(k)&&!/token/i.test(v.slice(0,80)))continue;const c=pick(v);if(typeof c==='string'&&/^[A-Za-z0-9_.+/=-]{40,200}$/.test(c))hits.push([k,c])}if(hits.length===1)t=hits[0][1];else if(hits.length>1){console.log('[dsh-web-omni] 找到多个候选，请手动复制正确的那个：');hits.forEach(([k,c])=>console.log(k,'=',c));return}}if(!t){console.warn('[dsh-web-omni] 未自动找到 Token。请在 Network 面板任选一个 api 请求，复制 Authorization 里 Bearer 之后的部分。');return}navigator.clipboard.writeText(t).then(()=>console.log('[dsh-web-omni] Token 已复制（'+t.length+' 字符），回到 DSH 设置页粘贴即可')).catch(()=>console.log('[dsh-web-omni] 自动复制失败，请手动复制：\\n'+t))})()`;

    const CSS = `
.dwo-root{display:grid;gap:16px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary,#1f1e1d)}
.dwo-head{display:grid;gap:2px}
.dwo-title{margin:0;font-size:15px;font-weight:600;line-height:22px}
.dwo-sub{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b6b6b)}

.dwo-stats{display:flex;gap:8px}
.dwo-stat{flex:1;display:grid;gap:2px;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);
  background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.06))}
.dwo-stat-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dwo-stat-value{font-size:20px;line-height:26px;font-weight:600;font-variant-numeric:tabular-nums}
.dwo-stat-warn .dwo-stat-value{color:var(--dsw-alias-state-error-primary,#c22)}

.dwo-notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b6b6b)}
.dwo-notice-warn{color:#b45309}
.dwo-notice-error{color:var(--dsw-alias-state-error-primary,#c22)}

.dwo-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.dwo-row{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 12px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.25));
  border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.dwo-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  color:var(--dsw-alias-label-secondary,#6b6b6b)}
.dwo-badge{flex:none;display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 8px;
  border-radius:999px;font-size:11px;line-height:20px;white-space:nowrap}
.dwo-badge-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 12%,transparent);
  color:var(--dsw-alias-state-success-primary,#16a34a)}
.dwo-badge-off{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c22) 12%,transparent);
  color:var(--dsw-alias-state-error-primary,#c22)}
.dwo-err{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}

.dwo-add{display:flex;gap:8px}
.dwo-input{flex:1;min-width:0;height:36px;padding:0 12px;box-sizing:border-box;font:inherit;font-size:13px;
  color:var(--dsw-alias-label-primary,#1f1e1d);
  border:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.25));
  border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.dwo-input::placeholder{color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dwo-input:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#1f1e1d);outline-offset:-1px;border-color:transparent}

.dwo-btn{flex:none;height:36px;padding:0 16px;box-sizing:border-box;font:inherit;font-size:13px;
  border-radius:var(--dsw-radius-md,8px);cursor:pointer;
  border:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.25));
  background:transparent;color:var(--dsw-alias-label-primary,#1f1e1d);
  transition:background .12s ease,opacity .12s ease}
.dwo-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.dwo-btn:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#1f1e1d);outline-offset:-1px}
.dwo-btn:disabled{opacity:.45;cursor:default}
.dwo-btn-primary{background:var(--dsw-alias-label-primary,#1f1e1d);color:var(--dsw-alias-bg-base,#fff);
  border-color:transparent}
.dwo-btn-primary:hover:not(:disabled){background:var(--dsw-alias-label-primary,#1f1e1d);opacity:.88}
.dwo-btn-link{flex:none;height:auto;padding:0;border:none;background:none;font-size:12px;cursor:pointer;
  color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dwo-btn-link:hover{color:var(--dsw-alias-state-error-primary,#c22);background:none}

.dwo-actions{display:flex;gap:8px}

.dwo-help{border:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.25));
  border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.dwo-help>summary{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;box-sizing:border-box;
  font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary,#6b6b6b);list-style:none;
  border-radius:var(--dsw-radius-md,8px)}
.dwo-help>summary:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))}
.dwo-help>summary::-webkit-details-marker{display:none}
/* 箭头用纯 CSS 画：▸ 这类字形在部分系统字体里缺失，会渲染成方框或星号 */
.dwo-help>summary::before{content:'';width:0;height:0;flex:none;
  border-left:5px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent;
  transition:transform .12s ease}
.dwo-help[open]>summary::before{transform:rotate(90deg)}
.dwo-help-body{display:grid;gap:10px;padding:0 12px 12px}
.dwo-help-steps{margin:0;padding-left:18px;display:grid;gap:6px;font-size:12px;line-height:20px;
  color:var(--dsw-alias-label-secondary,#6b6b6b)}
.dwo-code-wrap{position:relative}
.dwo-code{margin:0;padding:10px 12px;padding-right:84px;max-height:132px;overflow:auto;box-sizing:border-box;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;line-height:17px;white-space:pre-wrap;word-break:break-all;
  color:var(--dsw-alias-label-primary,#1f1e1d);
  background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.06));
  border-radius:var(--dsw-radius-md,8px)}
/* 按钮固定在容器右上，不随命令内容滚动；给右侧留出按钮宽度避免压字 */
.dwo-code-copy{position:absolute;top:6px;right:6px;padding:2px 8px;height:24px;
  background:var(--dsw-alias-bg-base,#fff);border-radius:var(--dsw-radius-md,8px)}
.dwo-hint{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}

.dwo-test{list-style:none;margin:0;padding:0;display:grid;gap:4px;font-size:12px;
  color:var(--dsw-alias-label-secondary,#6b6b6b)}
.dwo-test-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}
.dwo-test-bad{color:var(--dsw-alias-state-error-primary,#c22)}
`;

    /** 注入样式表（每份文档只注入一次）。 */
    function useStyles() {
      useEffect(() => {
        const id = `${NS}-styles`;
        if (document.getElementById(id)) return undefined;
        const style = document.createElement('style');
        style.id = id;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => { style.remove(); };
      }, []);
    }

    async function request(url, init) {
      const response = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        ...init,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        throw new Error(body.error || `请求失败 (${response.status})`);
      }
      return body.value;
    }

    function Stat({ label, value, warn }) {
      return h('div', { className: `dwo-stat${warn ? ' dwo-stat-warn' : ''}` },
        h('span', { className: 'dwo-stat-label' }, label),
        h('span', { className: 'dwo-stat-value' }, String(value)));
    }

    /** 「如何获取 Token」折叠区。 */
    function Help() {
      const [copied, setCopied] = useState(false);

      const copyCommand = async () => {
        try {
          await navigator.clipboard.writeText(TOKEN_COMMAND);
        } catch {
          // 剪贴板不可用（非安全上下文）时退回选中文本，用户可手动复制
          const range = document.createRange();
          const node = document.getElementById(`${NS}-cmd`);
          if (node) {
            range.selectNodeContents(node);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
          }
          return;
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      };

      return h('details', { className: 'dwo-help' }, [
        h('summary', { key: 'sum' }, text.helpTitle),
        h('div', { key: 'body', className: 'dwo-help-body' }, [
          h('ol', { key: 'steps', className: 'dwo-help-steps' }, [
            h('li', { key: '1' }, text.helpStep1),
            h('li', { key: '2' }, text.helpStep2),
            h('li', { key: '3' }, text.helpStep3),
          ]),
          h('div', { key: 'code', className: 'dwo-code-wrap' }, [
            h('pre', { key: 'pre', className: 'dwo-code' },
              h('code', { id: `${NS}-cmd` }, TOKEN_COMMAND)),
            h('button', {
              key: 'copy',
              type: 'button',
              className: 'dwo-btn dwo-btn-link dwo-code-copy',
              onClick: copyCommand,
            }, copied ? text.copied : text.copyCommand),
          ]),
          h('p', { key: 'fallback', className: 'dwo-hint' }, text.helpFallback),
          h('p', { key: 'privacy', className: 'dwo-hint' }, text.helpPrivacy),
        ]),
      ]);
    }

    function Section() {
      useStyles();
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [testResult, setTestResult] = useState(null);
      const [token, setToken] = useState('');

      const load = useCallback(async () => {
        try {
          setState(await request(STATUS_PATH));
          setError(null);
        } catch (err) {
          setError(String(err.message || err));
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      const submit = async () => {
        if (!token.trim()) return;
        setBusy(true);
        setError(null);
        try {
          await request(CREDENTIALS_PATH, {
            method: 'POST',
            body: JSON.stringify({ action: 'addToken', token }),
          });
          setToken('');
          setTestResult(null);
          await load();
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
        }
      };

      const remove = async (item) => {
        setBusy(true);
        try {
          await request(CREDENTIALS_PATH, {
            method: 'POST',
            body: JSON.stringify({ action: 'remove', kind: item.kind, value: item.label }),
          });
          setTestResult(null);
          await load();
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
        }
      };

      const runTest = async () => {
        setBusy(true);
        setTestResult(null);
        try {
          setTestResult(await request(TEST_PATH, { method: 'POST' }));
          await load();
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setBusy(false);
        }
      };

      const credentials = state?.credentials
        || { items: [], summary: { total: 0, available: 0, disabled: 0 } };
      const kernel = state?.kernel;

      const rows = credentials.items.map(item => h('li', { key: item.id, className: 'dwo-row' }, [
        h('span', { key: 'l', className: 'dwo-label', title: item.label }, item.label),
        item.errorCount > 0
          ? h('span', { key: 'e', className: 'dwo-err' }, `错误 ${item.errorCount}`)
          : null,
        h('span', {
          key: 'b',
          className: `dwo-badge ${item.disabled ? 'dwo-badge-off' : 'dwo-badge-ok'}`,
          title: item.disabled ? (item.disabledReason || '') : '',
        }, item.disabled ? text.disabled : text.available),
        h('button', {
          key: 'rm',
          type: 'button',
          className: 'dwo-btn dwo-btn-link',
          onClick: () => remove(item),
          disabled: busy,
        }, text.remove),
      ]));

      const testList = testResult
        ? h('ul', { className: 'dwo-test' }, testResult.results.map((item, index) => {
          const detail = item.error ? `（${item.error}）` : '';
          return h('li', {
            key: `${item.label}-${index}`,
            className: item.valid ? 'dwo-test-ok' : 'dwo-test-bad',
          }, `${item.label} — ${item.valid ? text.valid : text.invalid}${detail}`);
        }))
        : null;

      const notices = [
        kernel && !kernel.ready
          ? h('p', { key: 'nr', className: 'dwo-notice dwo-notice-warn' }, text.notReady) : null,
        kernel && kernel.error
          ? h('p', { key: 'ke', className: 'dwo-notice dwo-notice-error' }, kernel.error) : null,
        error
          ? h('p', { key: 'e', className: 'dwo-notice dwo-notice-error' }, error) : null,
      ].filter(Boolean);

      return h('div', { className: 'dwo-root' }, [
        h('div', { key: 'head', className: 'dwo-head' }, [
          h('h3', { key: 't', className: 'dwo-title' }, text.title),
          h('p', { key: 's', className: 'dwo-sub' }, text.subtitle),
        ]),

        h('div', { key: 'stats', className: 'dwo-stats' }, [
          h(Stat, { key: 'a', label: text.available, value: credentials.summary.available }),
          h(Stat, { key: 't', label: text.total, value: credentials.summary.total }),
          h(Stat, {
            key: 'd',
            label: text.disabled,
            value: credentials.summary.disabled,
            warn: credentials.summary.disabled > 0,
          }),
        ]),

        ...notices,

        credentials.items.length === 0
          ? h('p', { key: 'empty', className: 'dwo-notice' }, text.empty)
          : h('ul', { key: 'list', className: 'dwo-list' }, rows),

        h('div', { key: 'add', className: 'dwo-add' }, [
          h('input', {
            key: 'i',
            className: 'dwo-input',
            value: token,
            onChange: event => setToken(event.target.value),
            onKeyDown: event => { if (event.key === 'Enter') submit(); },
            placeholder: text.tokenPlaceholder,
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
          }),
          h('button', {
            key: 'b',
            type: 'button',
            className: 'dwo-btn dwo-btn-primary',
            onClick: submit,
            disabled: busy || !token.trim(),
          }, text.add),
        ]),

        h(Help, { key: 'help' }),

        h('div', { key: 'actions', className: 'dwo-actions' }, [
          h('button', {
            key: 'test',
            type: 'button',
            className: 'dwo-btn',
            onClick: runTest,
            disabled: busy || credentials.items.length === 0,
          }, busy ? text.testing : text.testAll),
          h('button', {
            key: 'reload',
            type: 'button',
            className: 'dwo-btn',
            onClick: load,
            disabled: busy,
          }, text.reload),
        ]),

        testList,
      ]);
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 70,
        label: () => text.title,
      }, () => h(Section)));
    }

    return { inject, apply };
  },
});
