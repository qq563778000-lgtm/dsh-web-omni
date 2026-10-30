/**
 * dsh-web-omni 设置页
 *
 * DSH 的客户端插件是预打包模块：宿主用 window.__ModuleLoader__.load
 * 注入一个 factory，我们从 factory 参数拿到 require('react')，返回
 * { inject, apply }。不能直接 import react。
 *
 * 页面职责：
 *   - 展示凭据池状态（可用数、禁用原因、剩余禁期）
 *   - 录入账号/Ten 两种凭据
 *   - 一键测试全部凭据
 *
 * 页面**不显示凭据明文**：后端返回的已是掩码，这里也不再提供"查看"入口。
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
      title: 'OmniAPI',
      subtitle: 'DeepSeek Web 转 API · 凭据池',
      available: '可用',
      total: '总数',
      disabled: '已禁用',
      addToken: '添加 Token',
      addAccount: '添加账号',
      tokenPlaceholder: '粘贴 DeepSeek Web Token',
      emailPlaceholder: '邮箱',
      passwordPlaceholder: '密码',
      submit: '保存',
      remove: '删除',
      testAll: '测试全部凭据',
      testing: '测试中…',
      reload: '刷新',
      empty: '还没有凭据。添加 Token 或账号后即可在模型选择器中使用 omni。',
      notReady: '凭据池尚未就绪，首次对话时会自动初始化。',
      reason: '原因',
      valid: '有效',
      invalid: '无效',
    };

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

    function Stat({ label, value, tone }) {
      return h('div', { style: { minWidth: 72 } },
        h('div', { style: { fontSize: 11, opacity: 0.65 } }, label),
        h('div', {
          style: { fontSize: 20, fontWeight: 600, color: tone === 'warn' ? '#B45309' : undefined },
        }, String(value)));
    }

    function Section() {
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [testResult, setTestResult] = useState(null);
      const [mode, setMode] = useState('token');
      const [token, setToken] = useState('');
      const [email, setEmail] = useState('');
      const [password, setPassword] = useState('');

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
        setBusy(true);
        setError(null);
        try {
          if (mode === 'token') {
            await request(CREDENTIALS_PATH, {
              method: 'POST',
              body: JSON.stringify({ action: 'addToken', token }),
            });
            setToken('');
          } else {
            await request(CREDENTIALS_PATH, {
              method: 'POST',
              body: JSON.stringify({ action: 'addAccount', email, password }),
            });
            setEmail('');
            setPassword('');
          }
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
            body: JSON.stringify({
              action: 'remove',
              kind: item.kind,
              value: item.kind === 'account' ? item.label : item.label,
            }),
          });
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

      const credentials = state?.credentials || { items: [], summary: { total: 0, available: 0, disabled: 0 } };
      const kernel = state?.kernel;

      // 测试结果单独算成变量：嵌套在三元与 map 里时括号极易写错，
      // 且出错时只报 "Unexpected token" 而不给位置。
      const testResultList = testResult
        ? h('ul', {
          style: { listStyle: 'none', margin: 0, padding: 0, fontSize: 12, display: 'grid', gap: 4 },
        }, testResult.results.map((item, index) => {
          const verdict = item.valid ? text.valid : text.invalid;
          const detail = item.error ? `（${item.error}）` : '';
          return h('li', { key: `${item.label}-${index}` }, `${item.label} — ${verdict}${detail}`);
        }))
        : null;

      const rowStyle = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
        border: '1px solid rgba(0,0,0,0.08)', borderRadius: 8 };
      const btnStyle = { fontSize: 12, padding: '6px 14px', cursor: 'pointer' };
      const inputStyle = { flex: 1, fontSize: 12, padding: '6px 8px', minWidth: 0 };
      const noteStyle = { margin: 0, fontSize: 12 };

      const credentialRows = credentials.items.map(item => h('li', { key: item.id, style: rowStyle },
        h('span', { style: { fontSize: 12, fontFamily: 'monospace', flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis' } }, item.label),
        h('span', {
          style: {
            fontSize: 11, padding: '2px 8px', borderRadius: 999,
            background: item.disabled ? 'rgba(185,28,28,0.08)' : 'rgba(22,163,74,0.10)',
            color: item.disabled ? '#B91C1C' : '#16A34A',
          },
        }, item.disabled ? `${text.disabled}${item.disabledReason ? ` · ${item.disabledReason}` : ''}` : text.available),
        item.errorCount > 0 ? h('span', { style: { fontSize: 11, opacity: 0.6 } }, `错误 ${item.errorCount}`) : null,
        h('button', {
          type: 'button',
          onClick: () => remove(item),
          disabled: busy,
          style: { fontSize: 11, cursor: 'pointer', background: 'none', border: 'none', color: '#B91C1C' },
        }, text.remove)));

      const credentialBlock = credentials.items.length === 0
        ? h('p', { style: { ...noteStyle, opacity: 0.7 } }, text.empty)
        : h('ul', {
          style: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 },
        }, credentialRows);

      const form = mode === 'token'
        ? h('div', { style: { display: 'flex', gap: 8 } },
          h('input', {
            value: token,
            onChange: event => setToken(event.target.value),
            placeholder: text.tokenPlaceholder,
            type: 'password',
            autoComplete: 'off',
            style: inputStyle,
          }),
          h('button', {
            type: 'button', onClick: submit, disabled: busy || !token.trim(), style: btnStyle,
          }, text.submit))
        : h('div', { style: { display: 'flex', gap: 8 } },
          h('input', {
            value: email,
            onChange: event => setEmail(event.target.value),
            placeholder: text.emailPlaceholder,
            autoComplete: 'off',
            style: inputStyle,
          }),
          h('input', {
            value: password,
            onChange: event => setPassword(event.target.value),
            placeholder: text.passwordPlaceholder,
            type: 'password',
            autoComplete: 'new-password',
            style: inputStyle,
          }),
          h('button', {
            type: 'button', onClick: submit, disabled: busy || !email.trim() || !password, style: btnStyle,
          }, text.submit));

      const notices = [
        kernel && !kernel.ready
          ? h('p', { key: 'not-ready', style: { ...noteStyle, color: '#B45309' } }, text.notReady)
          : null,
        kernel && kernel.error
          ? h('p', { key: 'kernel-error', style: { ...noteStyle, color: '#B91C1C' } }, kernel.error)
          : null,
        error ? h('p', { key: 'error', style: { ...noteStyle, color: '#B91C1C' } }, error) : null,
      ];

      return h('div', { style: { display: 'grid', gap: 16, padding: '4px 0' } }, [
        h('div', { key: 'head', style: { display: 'grid', gap: 4 } }, [
          h('h3', { key: 'title', style: { margin: 0, fontSize: 16, fontWeight: 600 } }, text.title),
          h('p', { key: 'sub', style: { margin: 0, fontSize: 12, opacity: 0.7 } }, text.subtitle),
        ]),
        h('div', { key: 'stats', style: { display: 'flex', gap: 24 } }, [
          h(Stat, { key: 'a', label: text.available, value: credentials.summary.available }),
          h(Stat, { key: 't', label: text.total, value: credentials.summary.total }),
          h(Stat, {
            key: 'd', label: text.disabled, value: credentials.summary.disabled,
            tone: credentials.summary.disabled > 0 ? 'warn' : undefined,
          }),
        ]),
        ...notices,
        credentialBlock,
        h('select', {
          key: 'mode',
          value: mode,
          onChange: event => setMode(event.target.value),
          style: { fontSize: 12, padding: '4px 8px', width: 140 },
        }, [
          h('option', { key: 'token', value: 'token' }, text.addToken),
          h('option', { key: 'account', value: 'account' }, text.addAccount),
        ]),
        form,
        h('div', { key: 'actions', style: { display: 'flex', gap: 8 } }, [
          h('button', { key: 'test', type: 'button', onClick: runTest, disabled: busy, style: btnStyle },
            busy ? text.testing : text.testAll),
          h('button', { key: 'reload', type: 'button', onClick: load, disabled: busy, style: btnStyle }, text.reload),
        ]),
        testResultList,
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
