import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// 凭据读写：设置页的所有凭据操作都走这里。
//
// 两条硬约束：
//   1. 返回值不得含明文（UI 只能看到掩码）
//   2. 落盘位置必须是插件自己的数据目录，不能碰主项目的 config.json
// ---------------------------------------------------------------------------

// 模块级单例：credentials.js 与 runtime.js 共享同一份模块状态，
// 用查询串重复 import 只会拿到"新外壳 + 旧状态"，造成用例互相污染。
// 隔离应当体现在数据目录上，而不是模块实例上。
const runtime = await import('../lib/runtime.js');
const credentials = await import('../lib/credentials.js');

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'omni-cred-'));
  runtime.__resetKernelState();
  runtime.isolateEnvironment(dir);
  return { dir, runtime };
}

async function loadCredentials() {
  return credentials;
}

test('maskToken 不泄露明文', async () => {
  const { maskToken } = await loadCredentials();
  const token = 'abcdef1234567890abcdef';
  const masked = maskToken(token);

  assert.ok(!masked.includes(token));
  assert.match(masked, /^abcdef\.\.\./);
  assert.match(masked, /cdef$/);
  // 极短 token 也不能整段暴露
  assert.equal(maskToken('abc'), 'ab***');
  assert.equal(maskToken(''), '');
});

test('添加 token 写入插件自己的 config.json', async () => {
  const { dir } = await setup();
  try {
    const cred = await loadCredentials();
    await cred.addToken({ token: 'token-abc-1234567890' });

    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(raw.deepseek.tokens, ['token-abc-1234567890']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重复 token 被拒绝，避免池中出现重复占位', async () => {
  const { dir } = await setup();
  try {
    const cred = await loadCredentials();
    await cred.addToken({ token: 'dup-token-1234567890' });
    await assert.rejects(() => cred.addToken({ token: 'dup-token-1234567890' }), /已存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空 token 被拒绝', async () => {
  const { dir } = await setup();
  try {
    const cred = await loadCredentials();
    await assert.rejects(() => cred.addToken({ token: '   ' }), /不能为空/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('添加账号需要邮箱与密码', async () => {
  const { dir } = await setup();
  try {
    const cred = await loadCredentials();
    await assert.rejects(() => cred.addAccount({ email: 'a@b.com' }), /都必须填写/);
    await cred.addAccount({ email: 'a@b.com', password: 'pwd' });

    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(raw.deepseek.accounts, [{ email: 'a@b.com', password: 'pwd' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重复账号被拒绝', async () => {
  const { dir } = await setup();
  try {
    const cred = await loadCredentials();
    await cred.addAccount({ email: 'a@b.com', password: 'p1' });
    await assert.rejects(() => cred.addAccount({ email: 'a@b.com', password: 'p2' }), /已存在/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('删除凭据后不再出现在列表里', async () => {
  const { dir } = await setup();
  try {
    const cred = await loadCredentials();
    await cred.addToken({ token: 'token-to-remove-123456' });
    const before = await cred.listCredentials();
    assert.equal(before.summary.total, 1);

    await cred.removeCredential({ kind: 'token', value: before.items[0].label });
    const after = await cred.listCredentials();
    assert.equal(after.summary.total, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listCredentials 只返回掩码，不返回明文', async () => {
  const { dir } = await setup();
  try {
    const cred = await loadCredentials();
    const secret = 'supersecrettoken0123456789';
    await cred.addToken({ token: secret });

    const list = await cred.listCredentials();
    const serialized = JSON.stringify(list);
    assert.ok(!serialized.includes(secret), '列表不得包含 token 明文');
    assert.match(serialized, /supers\.\.\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('空池时 summary 如实为 0', async () => {
  const { dir } = await setup();
  try {
    const cred = await loadCredentials();
    const list = await cred.listCredentials();
    assert.deepEqual(list.summary, { total: 0, available: 0, disabled: 0 });
    assert.deepEqual(list.items, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('不会写到主项目的 config.json', async () => {
  const { dir } = await setup();
  const projectConfig = join(process.cwd(), '..', 'config.json');
  const existedBefore = existsSync(projectConfig);
  try {
    const cred = await loadCredentials();
    await cred.addToken({ token: 'isolation-check-123456' });
    assert.ok(existsSync(join(dir, 'config.json')), '应写入插件数据目录');
    if (!existedBefore) {
      assert.equal(existsSync(projectConfig), false, '不得在主项目根目录生成 config.json');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
