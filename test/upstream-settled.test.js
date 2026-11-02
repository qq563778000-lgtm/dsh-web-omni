import test from 'node:test';
import assert from 'node:assert/strict';

import { isUpstreamNotSettledError } from '../kernel/utils/sse.js';

/**
 * 上游「上一条回复还没收尾」的识别。
 *
 * 真实故障（2026-11-02 DSH，session-7085899a）：
 *
 *   step 8 产出工具调用 → 立刻 cancel 上游流（没读到 status=FINISHED）
 *   350ms 后 step 9 拿那条消息当 parent_message_id 续传 →
 *   {"code":0,"data":{"biz_code":11,"biz_msg":"message still wip"}}
 *
 * 表现为「最新一轮对话一发送就报错」，且只在下一步紧接着发起时出现。
 *
 * 这类错误会随着上游把上一次生成收尾而自行消失，所以处置方式是
 * **同会话短暂等待后重发**——不是换凭据，也不是立即放弃。
 */

const wip = { code: 0, msg: '', data: { biz_code: 11, biz_msg: 'message still wip', biz_data: null } };
const invalidId = { code: 0, msg: '', data: { biz_code: 26, biz_msg: 'invalid message id', biz_data: null } };

test('biz_code=11（message still wip）被识别为未收尾', () => {
  assert.equal(isUpstreamNotSettledError(wip), true);
});

test('biz_code=26（invalid message id）同样视为未收尾', () => {
  assert.equal(isUpstreamNotSettledError(invalidId), true);
});

test('其它业务码不误判', () => {
  const cases = [
    { code: 0, data: { biz_code: 5, biz_msg: 'user is muted' } },   // 禁言：应禁用凭据
    { code: 40003 },                                                // token 失效
    { code: 40004 },                                                // 封禁
    { code: 0, data: { biz_code: 10 } },
    { code: 0, data: { biz_code: 0 } },
    { code: 0, data: null },
    {},
    null,
  ];
  for (const json of cases) {
    assert.equal(isUpstreamNotSettledError(json), false, `不应判为未收尾：${JSON.stringify(json)}`);
  }
});
