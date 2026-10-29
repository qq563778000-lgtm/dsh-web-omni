/**
 * 端到端冒烟：内嵌插件在**没有 OmniAPI 进程**的情况下完成真实对话。
 *
 * 这是"装完即用"的判据：插件自带内核，不依赖外部服务。
 * 需要有效的上游凭据（写入数据目录的 config.json）。
 *
 * 用法：
 *   OMNI_DATA_DIR=<目录> node scripts/e2e-live.mjs
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const dataDir = process.env.OMNI_DATA_DIR || mkdtempSync(join(tmpdir(), 'omni-e2e-'));

const mod = await import('../lib/index.js');
const cred = await import('../lib/credentials.js');
const runtime = await import('../lib/runtime.js');

// 先固定数据目录：凭据读写依赖它，晚设置会落到默认目录造成串用。
runtime.configure({ dataDir });

// 若提供了 token 且尚未存在，则写入（重复写入应视为幂等成功）。
if (process.env.OMNI_TOKEN) {
  const existing = await cred.listCredentials();
  if (existing.summary.total === 0) {
    await cred.addToken({ token: process.env.OMNI_TOKEN });
  }
}

const registered = [];
const ctx = {
  llm: { registerAdapter(providers, adapter) { registered.push({ providers, adapter }); return { replace() {} }; } },
  logger: { info() {}, warn() {} },
  effect() {},
  inject() {},
};

mod.apply(ctx, { dataDir });

record('插件注册 provider', registered.length === 1 && registered[0].providers[0] === 'omni');

const adapter = registered[0].adapter;

// 1) 模型目录不依赖网络
const models = await adapter.listModels('omni');
record('模型目录可用（不依赖网络）', models.length > 0, models.map(m => m.id).join(','));

// 2) 真实对话
const chunks = [];
try {
  for await (const chunk of adapter.stream({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回答两个字：你好' }] }],
  })) {
    chunks.push(chunk);
  }
} catch (err) {
  record('真实对话', false, `${err.code}: ${err.message}`);
}

if (chunks.length > 0) {
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
  const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('');
  const usage = chunks.find(c => c.type === 'usage')?.usage;
  const finish = chunks.find(c => c.type === 'finish')?.reason;

  record('正文非空', text.length > 0, JSON.stringify(text.slice(0, 30)));
  record('推理与正文分离', reasoning.length === 0 || !text.startsWith(reasoning.slice(0, 4)),
    `reasoning ${reasoning.length} 字 / text ${text.length} 字`);
  record('usage 上报', Boolean(usage), JSON.stringify(usage));
  record('finish 收尾', Boolean(finish), JSON.stringify(finish));
  record('恰好一个 finish', chunks.filter(c => c.type === 'finish').length === 1);
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
