/**
 * 复现：为什么每轮 conversationId 都不同、affinity 始终 false。
 * 用真实会话消息，按 DSH 的发送方式逐轮调用 getConversationBinding。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const { getConversationBinding, resolveConversation, recordResponseMessageId } = await import('file:///C:/Tools/dsh-web-omni/kernel/services/conversation.js');
const { loadConfig, updateConfig } = await import('file:///C:/Tools/dsh-web-omni/kernel/services/config-store.js');
loadConfig({ force: true });
updateConfig({ runtime: { enableConversationAffinity: true } });

const recs = readFileSync(process.env.TEMP + '/s3.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));

// 按 DSH 的方式重建每步发给模型的 openAIMessages
const steps = [];
let acc = [];
for (const r of recs) {
  if (r.type === 'system/message') acc.push({ role: 'system', content: r.data.message?.content });
  else if (r.type === 'user/message') acc.push({ role: 'user', content: r.data.content });
  else if (r.type === 'assistant/message') {
    const msg = r.data.message || {};
    acc.push({ role: 'assistant', content: msg.content, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
    steps.push({ t: r.data.turn, s: r.data.step, msgs: acc.slice() });
  } else if (r.type === 'tool/result') {
    acc.push({ role: 'tool', content: r.data.message?.content, tool_call_id: r.data.message?.toolCallId });
  }
}

const req = { headers: {} };
let prev = null;
for (const st of steps) {
  const b = getConversationBinding(req, st.msgs);
  // 复刻 runner：拿到 binding 后由 completion 内部调 resolveConversation，
  // 它才会把会话登记进 store，供下一轮前缀匹配。
  const resolved = await resolveConversation({
    conversationId: b.conversationId,
    modelType: 'default',
    token: 'probe-token-abcdef123456',
    createSessionFn: async () => ({ id: `sess-${st.t}-${st.s}` }),
  });
  recordResponseMessageId(b.conversationId, `resp-${st.t}-${st.s}`);
  const changed = prev && prev.conversationId !== b.conversationId;
  console.log(
    `t${st.t} s${st.s} | msgs ${String(st.msgs.length).padStart(3)} | conv ${b.conversationId.slice(0, 18)}…`
    + ` | matched ${b.matchedPrefixLength} | ${resolved.promptMode}${changed ? '  ← 变化' : ''}`,
  );
  prev = b;
}
