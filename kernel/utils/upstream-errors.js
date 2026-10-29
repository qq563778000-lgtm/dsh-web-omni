/**
 * 上游响应信封解析与错误语义分类
 *
 * 为什么单独成模块：DeepSeek 的各端点（PoW 挑战、补全、会话创建、上传）
 * 返回同一套信封 `{ code, msg, data: { biz_code, biz_msg, biz_data } }`，
 * 但调用方分散在 pow.js / sse.js / session.js / auth.js 中，各自手写判定
 * 会导致同一事实被判定出不同结论。
 *
 * 实测过的真实故障：`create_pow_challenge` 对失效 token 返回
 * `{ code: 40003, msg: 'Authorization Failed (invalid token)' }`，
 * 但 pow.js 只检查 challenge 是否存在，把 40003 压成通用文案，
 * 于是上层的"换一个凭据可能成功"判定失效——池里还有可用凭据也无法被使用。
 *
 * 因此这里集中两件事：
 *   1. 解析信封，拿到上游原始 code；
 *   2. 把 code 翻译成本项目统一的错误语义标记。
 *
 * 本模块是纯函数，不做 I/O、不引用 auth.js / sse.js / pow.js，避免循环依赖。
 */

/**
 * 凭据本身已不可用的上游错误码。
 *
 * - 40003 `Authorization Failed (invalid token)`：token 失效或已被上游作废
 * - 40004 账号封禁
 *
 * 这两个是确定性结论：重试同一凭据不会变好，只能换凭据。
 */
export const CREDENTIAL_INVALID_CODES = new Set([40003, 40004]);

/**
 * 凭据被临时限制的上游错误码。
 *
 * 换一个凭据多半可以绕过，但凭据本身未必失效，因此不算 invalid。
 * - 429 限流；40301 会话级限流；biz_code=5 禁言（禁言有自己的禁期语义，
 *   由 sse.js 单独处理，这里只做归类）
 */
export const CREDENTIAL_THROTTLE_CODES = new Set([429, 40301, 5]);

/**
 * 解析上游统一响应信封。
 *
 * 上游把业务码放在两处：顶层 `code` 与 `data.biz_code`。不同端点取用的位置
 * 并不一致（例如补全在 HTTP 200 时用 `data.biz_code`），所以两者都取出，
 * 调用方按需选择；`code` 优先，因为它在前置校验类接口上更可靠。
 *
 * @param {unknown} json 上游返回的已解析 JSON
 * @returns {{
 *   code: number|null,
 *   bizCode: number|null,
 *   message: string,
 *   targetPath: string|null,
 *   muteUntil: unknown,
 *   upstream: { code: number|null, bizCode: number|null, bizMsg: string|null, msg: string|null, muteUntil: unknown }
 * } | null} 不是信封结构时返回 null
 */
export function parseUpstreamEnvelope(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  // 至少要有 code 或 data，才可能是一个信封；否则视为业务数据体。
  if (!Object.prototype.hasOwnProperty.call(json, 'code') && !Object.prototype.hasOwnProperty.call(json, 'data')) {
    return null;
  }

  const bizData = json?.data?.biz_data ?? null;
  const rawCode = json?.code;
  const rawBizCode = json?.data?.biz_code;

  const code = toFiniteInt(rawCode);
  const bizCode = toFiniteInt(rawBizCode);
  const msg = typeof json?.msg === 'string' ? json.msg : '';
  const bizMsg = typeof json?.data?.biz_msg === 'string' ? json.data.biz_msg : '';

  return {
    code,
    bizCode,
    message: msg || bizMsg,
    targetPath: typeof bizData?.target_path === 'string' ? bizData.target_path : null,
    muteUntil: bizData?.mute_until ?? null,
    upstream: {
      code,
      bizCode,
      bizMsg: bizMsg || null,
      msg: msg || null,
      muteUntil: bizData?.mute_until ?? null,
    },
  };
}

/**
 * 判定 code 是否代表"凭据已失效"。
 * 同时接受顶层 code 与 biz_code，因为两条路径都可能承载这个事实。
 */
export function isCredentialInvalidCode(code) {
  const value = toFiniteInt(code);
  return value !== null && CREDENTIAL_INVALID_CODES.has(value);
}

/** 判定 code 是否代表"凭据被临时限制"。 */
export function isCredentialThrottleCode(code) {
  const value = toFiniteInt(code);
  return value !== null && CREDENTIAL_THROTTLE_CODES.has(value);
}

/**
 * 构造带上游语义的错误。
 *
 * 用标记而非自定义 Error 子类：既有的故障转移判定（sse.js 的
 * isCredentialRelatedError）与各处 catch 都按属性读取，改成子类会波及
 * 所有 instanceof 判断；属性标记是纯增量，向后兼容。
 *
 * @param {string} message 面向开发者/日志的消息，应包含上游原始 code 便于归因
 * @param {object} [options]
 * @param {number|null} [options.code] 上游原始 code
 * @param {boolean} [options.credentialFailover] 换凭据可能成功
 * @param {boolean} [options.credentialInvalid] 该凭据已确定不可用
 * @param {boolean} [options.retryable] 客户端重试可能成功
 * @param {object} [options.upstream] 上游报文的精简快照，随事件落盘
 * @returns {Error}
 */
export function credentialError(message, {
  code = null,
  credentialFailover = false,
  credentialInvalid = false,
  retryable = false,
  upstream = null,
} = {}) {
  const err = new Error(message);
  if (code !== null && code !== undefined) err.upstreamCode = code;
  if (credentialFailover) err.credentialFailover = true;
  if (credentialInvalid) err.credentialInvalid = true;
  if (retryable) err.retryable = true;
  if (upstream) err.upstream = upstream;
  return err;
}

/**
 * 把一个上游 code 翻译成统一的错误语义。
 *
 * @param {number|null} code 上游 code（顶层或 biz_code）
 * @returns {{ credentialFailover: boolean, credentialInvalid: boolean, retryable: boolean }}
 */
export function classifyUpstreamCode(code) {
  if (isCredentialInvalidCode(code)) {
    return { credentialFailover: true, credentialInvalid: true, retryable: false };
  }
  if (isCredentialThrottleCode(code)) {
    return { credentialFailover: true, credentialInvalid: false, retryable: true };
  }
  return { credentialFailover: false, credentialInvalid: false, retryable: false };
}

function toFiniteInt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // 上游偶尔以字符串下发 code，接受可完整转换的十进制串。
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
