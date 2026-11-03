/**
 * 凭据可用性的验证。
 *
 * 单独抽出来是因为有两处要用它，而两处的判定必须**一致**：
 *   - 设置页点"从浏览器获取"：验证通过才入库
 *   - 首次对话自动获取：验证通过才入库
 *
 * 若两处判定口径不同，用户会遇到诡异现象：设置页显示"已添加"，
 * 首次对话却又说"没找到可用凭据"——两边对同一份数据的结论相反。
 */

import { loadKernel } from './runtime.js';

/**
 * 验证一个 token 是否真的可用。
 *
 * 为什么必须验证：localStorage 里的登录记录会长期保留，即使用户早已
 * 重新登录、旧 token 失效。实测本机 Chrome 里那份 token 是 47 天前的，
 * 上游直接返回 40003。不验证就入库，用户看到"添加成功"，一用对话就报错——
 * 比直接告诉他"读到的是过期数据"糟糕得多。
 *
 * 判定方式：让内核建一次会话。这是最轻的、真实经过上游鉴权的调用。
 *
 * @param {string} token
 * @returns {Promise<boolean>}
 */
export async function isTokenUsable(token) {
  try {
    const kernel = await loadKernel();
    await kernel.session.createSession(token, 'default');
    return true;
  } catch {
    // 失败即视为不可用（失效/被封/网络问题都按"不可用"处理——
    // 宁可让用户手动确认，也不要把不可用的 token 静默存进去）。
    return false;
  }
}
