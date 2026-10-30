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
  assert.equal(registered[0].meta.label(), 'OmniAPI');
  assert.equal(typeof registered[0].render, 'function');
});

test('inject 声明了 slots 依赖', async () => {
  const loaded = await loadClient();
  const mod = loaded['dsh-web-omni'](() => reactStub);
  assert.ok(mod.inject.includes('slots'));
});
