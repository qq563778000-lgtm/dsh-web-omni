/**
 * 端到端冒烟：用真实 adapter 打真实 OmniAPI。
 *
 * 与单元测试分开，因为它需要 (1) OmniAPI 正在运行、(2) 有效上游凭据。
 * 不纳入 `npm test`，由验证阶段手动执行：
 *   OMNI_API_KEY=... node test/e2e-live.mjs
 */

import { OmniAdapter } from '../lib/adapter.js';

const baseURL = process.env.OMNI_BASE_URL || 'http://127.0.0.1:18080';
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const adapter = new OmniAdapter({ baseURL, apiKeyEnv: 'OMNI_API_KEY' });

  // 1) 模型发现
  //
  // 注意 DSH 的 listModels 契约只保留 provider/id/name/inputModalities，
  // 上下文长度属于 resolveModel 的 exact 元数据，目录层看不到——所以这里
  // 分别校验两者，不把目录缺少 context 当成缺陷。
  let models;
  try {
    models = await adapter.listModels();
    const first = models[0];
    record('模型发现', models.length > 0, `${models.length} 个，首个: ${first?.id} modalities=${first?.inputModalities}`);

    const exact = await adapter.resolveModel('omni', first.id);
    record(
      '精确模型元数据（上下文/输出上限/推理档位）',
      exact?.context?.contextWindow > 0,
      `ctx=${exact?.context?.contextWindow} max=${exact?.defaultMaxTokens} efforts=${exact?.reasoning?.efforts?.length ?? 0}`,
    );
  } catch (err) {
    record('模型发现', false, err.message);
    return;
  }

  if (models.length === 0) return;
  const model = models[0].id;

  // 2) 流式对话：正文与推理分离
  const chunks = [];
  try {
    for await (const chunk of adapter.stream({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: '请只回答两个字：你好' }] }],
    })) {
      chunks.push(chunk);
    }
  } catch (err) {
    record('流式对话', false, err.message);
    return;
  }

  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
  const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('');
  const usage = chunks.find(c => c.type === 'usage')?.usage;
  const finish = chunks.find(c => c.type === 'finish')?.reason;
  const blockStarts = chunks.filter(c => c.type === 'block-start');

  record('正文非空', text.length > 0, JSON.stringify(text.slice(0, 40)));
  record('推理通道独立（未混入正文）', !text.includes(reasoning.slice(0, 5)) || reasoning.length === 0,
    `reasoning ${reasoning.length} 字 / text ${text.length} 字`);
  record('块声明完整', blockStarts.length > 0, `${blockStarts.length} 个块: ${blockStarts.map(b => b.blockType).join(',')}`);
  record('usage 上报', !!usage, JSON.stringify(usage));
  record('finish 收尾', !!finish, JSON.stringify(finish));

  // 3) 错误路径：拿一个错误的 key 打，应被识别为 INVALID_CREDENTIAL 而非当成正文
  const bad = new OmniAdapter({ baseURL, apiKey: 'sk-invalid-key-for-test' });
  try {
    for await (const _ of bad.stream({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) { /* 不应产出正文 */ }
    record('无效 key 应失败', false, '却成功返回了');
  } catch (err) {
    record('无效 key 被识别为鉴权错误', err.code === 'INVALID_CREDENTIAL', `code=${err.code} msg=${err.message.slice(0, 70)}`);
  }
}

main().then(() => {
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length === 0 ? 0 : 1);
});
