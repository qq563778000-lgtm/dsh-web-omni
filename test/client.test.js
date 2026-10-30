import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 客户端 UI 契约。
//
// DSH 的客户端插件是预打包模块，必须通过 window.__ModuleLoader__.load
// 注册，并在 factory 里用宿主传入的 require 取 react——直接 import
// 会拿到 undefined 并让整个设置页空白。这类错误只在真实宿主里才暴露，
// 因此这里用最小桩模拟宿主加载过程。
// ---------------------------------------------------------------------------

const reactStub = {
  createElement: () => null,
  useEffect() {},
  useState: value => [value, () => {}],
  useCallback: fn => fn,
};

async function loadClient() {
  const loaded = {};
  globalThis.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => { loaded[id] = factory; },
    },
  };
  await import(`../client/client.js?t=${Date.now()}${Math.random()}`);
  return loaded;
}

test('客户端模块通过 __ModuleLoader__ 注册', async () => {
  const loaded = await loadClient();
  assert.deepEqual(Object.keys(loaded), ['dsh-web-omni']);
});

test('factory 使用宿主传入的 require 取 react', async () => {
  const loaded = await loadClient();
  const requested = [];
  const mod = loaded['dsh-web-omni']((name) => {
    requested.push(name);
    if (name === 'react') return reactStub;
    throw new Error(`未知模块 ${name}`);
  });

  assert.deepEqual(requested, ['react'], '只能依赖宿主的 react，不能引入其他包');
  assert.equal(typeof mod.apply, 'function');
  assert.ok(Array.isArray(mod.inject));
});

test('apply 注册 settings.section', async () => {
  const loaded = await loadClient();
  const mod = loaded['dsh-web-omni'](() => reactStub);

  const registered = [];
  mod.apply({
    slots: {
      inject: (_name, cb) => cb(),
      register: (meta, render) => {
        registered.push({ meta, render });
        return () => {};
      },
    },
  });

  assert.equal(registered.length, 1);
  assert.equal(registered[0].meta.name, 'settings.section');
  assert.equal(registered[0].meta.id, 'dsh-web-omni');
  assert.equal(typeof registered[0].meta.label, 'function');
  assert.equal(registered[0].meta.label(), 'dsh-web-omni');
  assert.equal(typeof registered[0].render, 'function');
});

test('inject 声明了 slots 依赖', async () => {
  const loaded = await loadClient();
  const mod = loaded['dsh-web-omni'](() => reactStub);
  assert.ok(mod.inject.includes('slots'));
});

// ---------------------------------------------------------------------------
// 设置页不再提供「添加账号」（2026-10-30）
//
// 上游登录接口被 AWS WAF 拦截：从非浏览器网络直接登录常返回 202 空响应，
// 成功率取决于出口 IP。用户看到的是"填了密码却说登录失败"。
// 相比从浏览器复制一个 token，账号方式既不可靠，也让密码落盘。
// ---------------------------------------------------------------------------

test('设置页与路由都不再暴露账号入口', async () => {
  const { readFileSync } = await import('node:fs');
  const clientSource = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  const routesSource = readFileSync(new URL('../lib/routes.js', import.meta.url), 'utf8');

  assert.doesNotMatch(clientSource, /addAccount/, '客户端不得再提交 addAccount');
  // 不得再有账号表单：邮箱输入 + 密码输入的组合
  assert.doesNotMatch(clientSource, /email/i, '界面不得出现邮箱输入');
  assert.doesNotMatch(routesSource, /addAccount/, '路由不得再接受 addAccount');

  // 但必须保留 Token 入口
  assert.match(clientSource, /addToken/);
  assert.match(routesSource, /addToken/);
});

test('设置页使用 Host 主题变量而非写死颜色', async () => {
  const { readFileSync } = await import('node:fs');
  const clientSource = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

  // 颜色必须走主题变量，深浅色主题切换才能自动跟随
  assert.match(clientSource, /--dsw-alias-label-primary/, '应使用 Host 的文字色变量');
  assert.match(clientSource, /--dsw-radius-md/, '应使用 Host 的圆角刻度');
  // 交互反馈需要 :hover / :focus-visible，内联样式无法表达
  assert.match(clientSource, /:focus-visible/, '应有键盘焦点样式');
  assert.match(clientSource, /:hover/, '应有悬停样式');
});

// ---------------------------------------------------------------------------
// 「如何获取 Token」引导命令必须真的能跑
//
// 这段命令是嵌在模板字符串里的 JS，写错一个转义就会在用户浏览器里抛
// SyntaxError，而用户在 Console 里看到报错只会以为插件坏了。
// 这里提取真实命令并用 mock 环境执行，验证四种场景。
// ---------------------------------------------------------------------------

async function loadTokenCommand() {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
  const m = src.match(/const TOKEN_COMMAND = `([\s\S]*?)`;\n/);
  assert.ok(m, '未能从 client.js 提取 TOKEN_COMMAND');
  return m[1];
}

function runCommand(cmd, store, cookie = '') {
  const keys = Object.keys(store);
  const ls = {
    length: keys.length,
    key: i => keys[i],
    getItem: k => (k in store ? store[k] : null),
  };
  const logs = [];
  const warns = [];
  let copied = null;
  const navigator = { clipboard: { writeText: async v => { copied = v; } } };
  const fakeConsole = {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => warns.push(a.join(' ')),
  };
  // eslint-disable-next-line no-new-func
  new Function('localStorage', 'document', 'navigator', 'console', cmd)(
    ls, { cookie }, navigator, fakeConsole,
  );
  return { get copied() { return copied; }, logs, warns };
}

test('引导命令语法有效', async () => {
  const cmd = await loadTokenCommand();
  assert.doesNotThrow(() => new Function(cmd), '命令必须是可解析的 JS');
});

test('引导命令能从已知键取出 token', async () => {
  const cmd = await loadTokenCommand();
  const value = 'A'.repeat(64);
  const r = runCommand(cmd, { userToken: JSON.stringify({ value, __version: '0' }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(r.copied, value, '应从 userToken 的 value 字段取出');
});

test('引导命令能扫描未知键名', async () => {
  const cmd = await loadTokenCommand();
  const value = 'B'.repeat(64);
  const r = runCommand(cmd, { someAuthThing: value });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(r.copied, value, '键名含 auth 且值像 token 时应命中');
});

test('多个候选时不瞎选，全部列出', async () => {
  const cmd = await loadTokenCommand();
  const r = runCommand(cmd, { tokenA: 'C'.repeat(64), tokenB: 'D'.repeat(64) });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(r.copied, null, '不得自动选一个');
  assert.match(r.logs.join(' '), /找到多个候选/, '应提示用户手动选择');
});

test('找不到时给出明确指引而不是静默失败', async () => {
  const cmd = await loadTokenCommand();
  const r = runCommand(cmd, { unrelated: 'hello' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(r.copied, null);
  assert.match(r.warns.join(' '), /Network 面板/, '应指引用户从 Network 面板复制');
});
