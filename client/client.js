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
    const SETTINGS_PATH = '/api/dsh-web-omni/settings';
    const BROWSER_TOKEN_PATH = '/api/dsh-web-omni/browser-token';

    const text = {
      title: 'dsh-web-omni',
      subtitle: 'DeepSeek Web 转 API',
      available: '可用',
      total: '总数',
      disabled: '已禁用',
      tokenPlaceholder: '粘贴 DeepSeek Web Token',
      add: '添加',
      remove: '删除',
      testOne: '测试有效性',
      notTested: '未测试',
      reload: '刷新',
      empty: '还没有 Token，添加后即可开始对话。',
      notReady: '凭据池尚未就绪，首次对话时自动初始化。',
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
      modeTitle: '对话模式',
      modeAgent: 'Agent',
      modeAgentDesc: '系统提示 + 全部工具，可读写文件、执行命令。',
      modeAsk: 'Ask',
      modeAskDesc: '原生对话，只发你说的话，不带任何提示与注入。',
      affinityTitle: '会话亲和',
      affinityOn: '开',
      affinityOnDesc: '同一对话复用上游会话，只发增量内容。',
      affinityOff: '关',
      affinityOffDesc: '每轮重发完整历史，最兼容但输入成本更高。',
      autoFetch: '从浏览器获取 Token（全部 profile）——重新登录浏览器后点此恢复',
      autoFetching: '正在读取…',
      autoFetchOk: (browser) => `已从 ${browser} 添加 Token。`,
      autoFetchPresent: '读到的 Token 已在列表中。',
      autoFetchFail: '未能从浏览器读到 Token。',
      autoFetchPendingTitle: '已登录，但数据还没落盘',
      autoFetchPending: '关闭 chat.deepseek.com 那个标签页（Ctrl+W）后再试。',
      autoFetchNoLoginTitle: '没有找到 DeepSeek 登录态',
      autoFetchNoLogin: '请先在浏览器登录 chat.deepseek.com。',
      autoFetchStaleTitle: '读到的是过期登录记录',
      autoFetchStale: '请重新登录 chat.deepseek.com，关闭该标签页后再试。',
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
.dwo-sub{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}

.dwo-stats{display:flex;gap:8px}
.dwo-stat{flex:1;display:grid;gap:2px;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);
  background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.06))}
.dwo-stat-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dwo-stat-value{font-size:20px;line-height:26px;font-weight:600;font-variant-numeric:tabular-nums}
.dwo-stat-warn .dwo-stat-value{color:var(--dsw-alias-state-error-primary,#c22)}

.dwo-notice{margin:0;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dwo-notice-warn{color:#b45309}
.dwo-notice-error{color:var(--dsw-alias-state-error-primary,#c22)}

.dwo-list{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.dwo-row{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 10px 0 12px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.25));
  border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,transparent)}
.dwo-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  color:var(--dsw-alias-label-secondary,#6b6b6b)}
.dwo-err{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}

/* 图标按钮：状态与操作用图标表达，靠 title 提供无障碍名称 */
.dwo-icon{flex:none;display:inline-flex;align-items:center;justify-content:center;
  width:28px;height:28px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);
  background:transparent;cursor:pointer;color:var(--dsw-alias-label-tertiary,#8a8a8a);
  transition:background .12s ease,color .12s ease}
.dwo-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1));
  color:var(--dsw-alias-label-primary,#1f1e1d)}
.dwo-icon:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#1f1e1d);outline-offset:-1px}
.dwo-icon:disabled{opacity:.45;cursor:default}
.dwo-icon svg{width:16px;height:16px;display:block;fill:none;stroke:currentColor;
  stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.dwo-icon-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}
.dwo-icon-bad{color:var(--dsw-alias-state-error-primary,#c22)}
.dwo-icon-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#c22)}
.dwo-icon-primary{background:var(--dsw-alias-label-primary,#1f1e1d);color:var(--dsw-alias-bg-base,#fff)}
.dwo-icon-primary:hover:not(:disabled){background:var(--dsw-alias-label-primary,#1f1e1d);color:var(--dsw-alias-bg-base,#fff);opacity:.88}
.dwo-icon-busy{animation:dwo-spin .8s linear infinite}
@keyframes dwo-spin{to{transform:rotate(360deg)}}
/* 状态图标：无边框，纯指示 */
.dwo-state{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px}
.dwo-state svg{width:15px;height:15px;display:block;fill:none;stroke:currentColor;
  stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.dwo-state-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}
.dwo-state-bad{color:var(--dsw-alias-state-error-primary,#c22)}
.dwo-state-wait{color:var(--dsw-alias-label-tertiary,#8a8a8a)}

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

/* 设置项容器：标题 + 可选说明 */
.dwo-field{display:grid;gap:8px}
.dwo-field-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dwo-field-label{font-size:12px;line-height:18px;font-weight:500;
  color:var(--dsw-alias-label-secondary,#6b6b6b)}
.dwo-field-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}

/* 设置行：多个功能并排，标签在左、控件在右 */
.dwo-settings{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.dwo-setting{display:flex;align-items:center;gap:7px}
.dwo-setting-label{font-size:11px;line-height:22px;white-space:nowrap;
  color:var(--dsw-alias-label-tertiary,#8a8a8a)}

/* 分段单选：紧凑的 pill 形态，高度只有 22px */
.dwo-seg{display:inline-flex;padding:2px;gap:2px;box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.22));
  border-radius:999px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.05))}
.dwo-seg-b{height:22px;padding:0 11px;border:none;border-radius:999px;background:transparent;
  font:inherit;font-size:12px;line-height:22px;cursor:pointer;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,#6b6b6b);
  transition:background .12s ease,color .12s ease}
.dwo-seg-b:hover:not(:disabled):not(.dwo-seg-on){color:var(--dsw-alias-label-primary,#1f1e1d)}
.dwo-seg-b:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#1f1e1d);outline-offset:1px}
.dwo-seg-b:disabled{opacity:.5;cursor:default}
.dwo-seg-on{background:var(--dsw-alias-label-primary,#1f1e1d);
  color:var(--dsw-alias-bg-base,#fff);cursor:default}
.dwo-notice-ok{color:var(--dsw-alias-state-success-primary,#16a34a)}
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

    /**
     * 内联图标集。
     *
     * 用 SVG 而不是字符/emoji：字形在部分系统字体里会缺字变成方框，
     * emoji 的配色也无法跟随主题。这里统一 currentColor + stroke，
     * 深浅色主题自动适配。
     */
    const ICONS = {
      // 圆内对勾：可用
      check: 'M20 6L9 17l-5-5',
      // 圆内叉：失效/已禁用
      cross: 'M15 9l-6 6M9 9l6 6',
      // 横线：未测试/未知
      minus: 'M8 12h8',
      // 从浏览器抓取：云 + 下箭头。
      //
      // 试过窗口+下箭头、钥匙、括号等形状，都不如这个直观——
      // 窗口容易被读成"打开浏览器"，钥匙指向密码而非 token。
      // 云+箭头直接表达"从别处取下来"。
      browser: 'M6.5 18a4.5 4.5 0 0 1-3-4.5 4.5 4.5 0 0 1 2.2 3.9A5.5 5.5 0 0 1-.6 4.8M12 12v8M8.5 16.5L12 20l3.5-3.5',
      // 测试有效性：药丸 + 勾（"这一条通不通"），比秒表轮廓清晰
      gauge: 'M4.5 12.5l4 4 6-9 5 5 5-5',
      // 刷新
      refresh: 'M20 11a8 8 0 10-2.3M4 13a8 8 0 1010 2.3M20 5v6h-6M4 19v-6h6',
      // 删除（垃圾桶）
      trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
      // 添加（加号）
      plus: 'M12 5v14M5 12h14',
    };

    /** 单个图标。 */
    function Icon({ name, className = '' }) {
      const path = ICONS[name];
      if (!path) return null;
      return h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', className },
        h('path', { d: path }));
    }

    /** 图标按钮（带 title 作为无障碍名称）。 */
    function IconButton({ icon, title, onClick, disabled, className = '', busy }) {
      return h('button', {
        type: 'button',
        className: `dwo-icon ${className}${busy ? ' dwo-icon-busy' : ''}`,
        onClick,
        disabled: disabled || busy,
        title,
        'aria-label': title,
      }, h(Icon, { name: icon }));
    }

    /** 纯状态指示（不可点）。 */
    function StateIcon({ state, title }) {
      const map = {
        ok: { icon: 'check', cls: 'dwo-state-ok' },
        bad: { icon: 'cross', cls: 'dwo-state-bad' },
        wait: { icon: 'minus', cls: 'dwo-state-wait' },
      };
      const item = map[state] || map.wait;
      return h('span', {
        className: `dwo-state ${item.cls}`,
        title,
        'aria-label': title,
      }, h(Icon, { name: item.icon }));
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

    /**
     * 紧凑的分段单选。
     *
     * 两个设置（对话模式、会话亲和）都用它，视觉一致，控件高度只有 22px。
     *
     * 之前用过"大卡片 + 说明文字"的样式，但那个尺寸在设置页里过于抢眼——
     * 这类开关的说明本来就是"点开才知道"的信息，不该占据主视觉。
     * 现在改成标签 + 紧凑 pill，必要时用 title 提供补充说明。
     */
    function SegmentedRadio({ label, value, options, busy, onChange, title }) {
      return h('div', { className: 'dwo-setting', title }, [
        h('span', { key: 'l', className: 'dwo-setting-label' }, label),
        h('div', {
          key: 'g',
          className: 'dwo-seg',
          role: 'radiogroup',
          'aria-label': label,
        }, options.map(option => {
          const on = option.id === value;
          return h('button', {
            key: option.id,
            type: 'button',
            role: 'radio',
            'aria-checked': on,
            className: `dwo-seg-b${on ? ' dwo-seg-on' : ''}`,
            onClick: () => { if (!on) onChange(option.id); },
            disabled: busy,
            title: option.desc || option.title || option.label,
          }, option.label);
        })),
      ]);
    }

    function Section() {
      useStyles();
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [testResult, setTestResult] = useState(null);
      const [testingId, setTestingId] = useState(null);
      const [token, setToken] = useState('');
      // 初始态与服务端缺省保持一致（ask）。服务端返回后会用真实值覆盖。
      //
      // 这里必须写死字面量：客户端是预打包模块，只能 require('react')，
      // 引不进内核的常量模块。与内核默认值的一致性由 test/client.test.js
      // 断言守住——两边一旦漂移，用户会看到界面显示 Ask 却按 Agent 执行。
      const [mode, setMode] = useState('ask');
      const [affinity, setAffinity] = useState(true);
      const [autoBusy, setAutoBusy] = useState(false);
      const [autoResult, setAutoResult] = useState(null);

      const load = useCallback(async () => {
        try {
          const value = await request(STATUS_PATH);
          setState(value);
          const settings = value?.settings || {};
          if (settings.mode === 'ask' || settings.mode === 'agent') setMode(settings.mode);
          if (typeof settings.affinity === 'boolean') setAffinity(settings.affinity);
          setError(null);
        } catch (err) {
          setError(String(err.message || err));
        }
      }, []);

      useEffect(() => { load(); }, [load]);

      /**
       * 提交一个运行时开关。
       *
       * 乐观更新：先改本地状态让界面立刻响应，失败再回滚。开关是本地布尔值，
       * 等网络往返会让点击有明显延迟感。
       */
      const patchSettings = async (patch, rollback) => {
        setError(null);
        try {
          await request(SETTINGS_PATH, { method: 'POST', body: JSON.stringify(patch) });
        } catch (err) {
          rollback();
          setError(String(err.message || err));
        }
      };

      const changeMode = (next) => {
        const previous = mode;
        setMode(next);
        patchSettings({ mode: next }, () => setMode(previous));
      };

      const changeAffinity = (next) => {
        const previous = affinity;
        setAffinity(next);
        patchSettings({ affinity: next }, () => setAffinity(previous));
      };

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

      /**
       * 从本机浏览器读取 Token。
       *
       * 成功则直接入库并刷新；失败时给出**可操作**的原因：
       *   - 是没登录 → 提示先去登录
       *   - 是浏览器加密（ABE）→ 说明这是浏览器安全设计，无法绕过，
       *     并把手动方式指出来
       *
       * 这两种情况的处置完全不同，笼统报"失败"只会让用户反复重试。
       */
      const autoFetch = async () => {
        setAutoBusy(true);
        setAutoResult(null);
        setError(null);
        try {
          const value = await request(BROWSER_TOKEN_PATH, { method: 'POST' });

          // 清理失效项也要如实报出来。
          //
          // 为什么：用户在浏览器退出登录后，旧 token 全部失效。这次点
          // "重新获取"会顺手把死掉的清掉——如果只说"添加了 1 个"，用户
          // 会发现列表里的 ✗ 不见了却不知道为什么。
          const removed = Number(value?.removed) || 0;

          if (value?.added > 0 && removed > 0) {
            setAutoResult({
              kind: 'ok',
              text: `已从浏览器添加 ${value.added} 个 Token，并清理 ${removed} 个失效项。`,
            });
            setState({ ...(state || {}), credentials: value.credentials });
          } else if (value?.added > 0) {
            // 一次可能读到多个有效 token（本机多个 Chrome 账号都登录过）
            const n = value.added;
            setAutoResult({
              kind: 'ok',
              text: n > 1 ? `已从浏览器添加 ${n} 个 Token。` : `已从 ${value.browser} 添加 Token。`,
            });
            setState({ ...(state || {}), credentials: value.credentials });
          } else if (removed > 0) {
            // 只清理了失效项、没有新增：说明浏览器里没有可用的登录态，
            // 但旧的那批确实死了。这不是成功，但也不是失败。
            setAutoResult({
              kind: 'fail',
              reason: 'not-found',
              text: `已清理 ${removed} 个失效 Token，但浏览器里没有可用的登录态。`,
            });
            setState({ ...(state || {}), credentials: value.credentials });
          } else if (value?.alreadyPresent > 0) {
            // 读到的 token 已在池里：不是错误，但也确实没新增。
            // 必须如实说，否则用户会以为添加成功却在列表里找不到。
            setAutoResult({ kind: 'ok', text: text.autoFetchPresent });
            setState({ ...(state || {}), credentials: value.credentials });
          } else {
            // 按后端给出的原因分流。三种原因对应三种完全不同的处置：
            //   stale → 读到了但已失效，重新登录
            //   not-flushed → 已登录但没落盘，关标签页
            //   not-found   → 确实没登录，去登录
            // 混在一起说会让用户反复做无用功。
            const reason = value?.reason === 'stale'
              ? 'stale'
              : value?.reason === 'not-flushed' ? 'pending' : 'not-found';

            const title = {
              stale: text.autoFetchStaleTitle,
              pending: text.autoFetchPendingTitle,
              'not-found': text.autoFetchNoLoginTitle,
            }[reason];

            setAutoResult({ kind: 'fail', reason, text: title });
          }
          await load();
        } catch (err) {
          setAutoResult({ kind: 'fail', text: String(err.message || err) });
        } finally {
          setAutoBusy(false);
        }
      };

      /**
       * 测试单条凭据。
       *
       * 逐条测而不是"测试全部"：后者要逐条打上游，几十条凭据时设置页会
       * 卡住几十秒，用户不知道在等什么。点哪条测哪条，反馈立即可见。
       */
      const testOne = async (item) => {
        setTestingId(item.id);
        setTestResult(null);
        try {
          const result = await request(TEST_PATH, {
            method: 'POST',
            body: JSON.stringify({ id: item.id }),
          });
          setTestResult(result);
          await load();
        } catch (err) {
          setError(String(err.message || err));
        } finally {
          setTestingId(null);
        }
      };

      const credentials = state?.credentials
        || { items: [], summary: { total: 0, available: 0, disabled: 0 } };
      const kernel = state?.kernel;

      const rows = credentials.items.map(item => {
        // 状态图标：已禁用 → 红叉；测试通过 → 对勾；未测/出错 → 横线
        const tested = testResult && testResult.label === item.label;
        const state = item.disabled ? 'bad'
          : tested ? (testResult.valid ? 'ok' : 'bad')
            : 'wait';
        const stateTitle = item.disabled
          ? (item.disabledReason || text.disabled)
          : tested ? (testResult.valid ? text.valid : (testResult.error || text.invalid))
            : text.notTested;

        return h('li', { key: item.id, className: 'dwo-row' }, [
          h('span', { key: 'l', className: 'dwo-label', title: item.label }, item.label),
          item.errorCount > 0
            ? h('span', { key: 'e', className: 'dwo-err' }, `错误 ${item.errorCount}`)
            : null,
          h(StateIcon, { key: 's', state, title: stateTitle }),
          h(IconButton, {
            key: 't',
            icon: 'gauge',
            title: text.testOne,
            onClick: () => testOne(item),
            busy: testingId === item.id,
            disabled: busy,
          }),
          h(IconButton, {
            key: 'rm',
            icon: 'trash',
            className: 'dwo-icon-danger',
            title: text.remove,
            onClick: () => remove(item),
            disabled: busy,
          }),
        ]);
      });

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

        h('div', { key: 'settings', className: 'dwo-settings' }, [
          h(SegmentedRadio, {
            key: 'mode',
            label: text.modeTitle,
            value: mode,
            busy,
            onChange: changeMode,
            options: [
              { id: 'ask', label: text.modeAsk, desc: text.modeAskDesc },
              { id: 'agent', label: text.modeAgent, desc: text.modeAgentDesc },
            ],
          }),

          h(SegmentedRadio, {
            key: 'affinity',
            label: text.affinityTitle,
            value: affinity ? 'on' : 'off',
            busy,
            onChange: next => changeAffinity(next === 'on'),
            options: [
              { id: 'on', label: text.affinityOn, desc: text.affinityOnDesc },
              { id: 'off', label: text.affinityOff, desc: text.affinityOffDesc },
            ],
          }),
        ]),

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
          h(IconButton, {
            key: 'add',
            icon: 'plus',
            className: 'dwo-icon-primary',
            title: text.add,
            onClick: submit,
            disabled: busy || !token.trim(),
          }),
          h(IconButton, {
            key: 'auto',
            icon: 'browser',
            title: autoBusy ? text.autoFetching : text.autoFetch,
            onClick: autoFetch,
            busy: autoBusy,
            disabled: busy,
          }),
        ]),

        autoResult
          ? h('div', { key: 'ar' }, [
            h('p', {
              key: 'r',
              className: `dwo-notice${autoResult.kind === 'ok' ? '' : ' dwo-notice-warn'}`,
            }, autoResult.text),
            // 失败时只显示与本次原因对应的那一段，避免说法互相干扰。
            autoResult.kind === 'fail'
              ? h('p', { key: 'why', className: 'dwo-hint' }, {
                stale: text.autoFetchStale,
                pending: text.autoFetchPending,
                'not-found': text.autoFetchNoLogin,
              }[autoResult.reason] || text.autoFetchNoLogin)
              : null,
          ])
          : null,

        h(Help, { key: 'help' }),

        h('div', { key: 'actions', className: 'dwo-actions' }, [
          h(IconButton, {
            key: 'reload',
            icon: 'refresh',
            title: text.reload,
            onClick: load,
            disabled: busy,
          }),
        ]),

        testResult
          ? h('p', {
            key: 'tr',
            className: `dwo-notice${testResult.valid ? ' dwo-notice-ok' : ' dwo-notice-warn'}`,
          }, `${testResult.label} — ${testResult.valid ? text.valid : text.invalid}${testResult.error ? `（${testResult.error}）` : ''}`)
          : null,
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
