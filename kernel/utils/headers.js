import { ProxyAgent } from 'undici';
import { createHash } from 'node:crypto';

// Mimic real Chrome 120 browser session
const UA_VERSION = '120.0.0.0';
const UA_MAJOR = '120';

const BROWSER_HEADERS = {
  'user-agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${UA_VERSION} Safari/537.36`,
  'accept-language': 'zh-CN,zh;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
  'origin': 'https://chat.deepseek.com',
  'referer': 'https://chat.deepseek.com/',
  'sec-ch-ua': `"Not_A Brand";v="8", "Chromium";v="${UA_MAJOR}", "Google Chrome";v="${UA_MAJOR}"`,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'x-client-timezone-offset': '28800',
};

// Per-token cookie jar: smidV2, HWWAFSESTIME, HWWAFSESID, ds_session_id, thumbcache
const tokenCookies = new Map();

function randomHex(len) {
  const chars = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
  return s;
}

function randomAlphaNum(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function ensureCookies(token) {
  if (tokenCookies.has(token)) return tokenCookies.get(token);
  const smidV2 = `20260520${randomAlphaNum(10)}${randomHex(24)}`;
  const HWWAFSESTIME = `${Date.now()}`;
  const HWWAFSESID = `${randomAlphaNum(4)}${randomHex(12)}`;
  const dsSessionId = `${randomHex(32)}`;
  const thumbcacheKey = randomHex(32);
  // 与请求参数 did 使用同一派生值：真实浏览器里 thumbcache 与 did 本就来自
  // 同一份设备指纹；两处用不同随机值反而是可被识别的"不一致"信号。
  const deviceId = deriveDeviceId(token);
  const thumbcacheValue = deviceId;
  const cookie = `smidV2=${smidV2}; HWWAFSESTIME=${HWWAFSESTIME}; HWWAFSESID=${HWWAFSESID}; ds_session_id=${dsSessionId}; .thumbcache_${thumbcacheKey}=${encodeURIComponent(thumbcacheValue)}`;
  tokenCookies.set(token, { cookie, deviceId });
  return tokenCookies.get(token);
}


// HIF (Hidden Integration Feature) token management
// DeepSeek uses hif-leim and hif-dliq headers for request validation
// These are fetched from hif-leim.deepseek.com/query and hif-dliq.deepseek.com/query
const HIF_BASE = 'https://hif-leim.deepseek.com/query';
const HIF_DLIQ_BASE = 'https://hif-dliq.deepseek.com/query';

const hifCache = new Map(); // key: token, value: { leim, dliq, expiresAt }

async function fetchHifToken(url, token) {
  const headers = {
    'user-agent': BROWSER_HEADERS['user-agent'],
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'accept-encoding': 'gzip, deflate, br',
    'origin': 'https://chat.deepseek.com',
    'referer': 'https://chat.deepseek.com/',
  };
  if (token) {
    headers['authorization'] = `Bearer ${token}`;
  }
  const res = await proxiedFetch(url, { headers });
  const json = await res.json();
  const value = json.data?.biz_data?.value;
  const ttl = parseInt(res.headers.get('x-hif-ttl') || '600', 10);
  return { value, ttl: (isNaN(ttl) || ttl <= 0) ? 600 : ttl };
}

async function refreshHifTokens(token) {
  try {
    const [leimResult, dliqResult] = await Promise.allSettled([
      fetchHifToken(HIF_BASE, token),
      fetchHifToken(HIF_DLIQ_BASE, token),
    ]);

    const leim = leimResult.status === 'fulfilled' ? leimResult.value : null;
    const dliq = dliqResult.status === 'fulfilled' ? dliqResult.value : null;

    if (leim?.value && dliq?.value) {
      const ttl = Math.min(leim.ttl, dliq.ttl);
      hifCache.set(token, {
        leim: leim.value,
        dliq: dliq.value,
        expiresAt: Date.now() + ttl * 1000,
      });
    } else if (leim?.value || dliq?.value) {
      // Cache partial result — at least one header is available
      const existing = hifCache.get(token) || {};
      hifCache.set(token, {
        leim: leim?.value || existing.leim,
        dliq: dliq?.value || existing.dliq,
        expiresAt: Date.now() + Math.min(leim?.ttl || 600, dliq?.ttl || 600) * 1000,
      });
    }
  } catch (e) {
    // HIF fetch failed — requests will proceed without it
  }
}

async function getHifHeaders(token) {
  const cached = hifCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return { 'x-hif-leim': cached.leim, 'x-hif-dliq': cached.dliq };
  }

  await refreshHifTokens(token);
  const refreshed = hifCache.get(token);
  if (refreshed) {
    return { 'x-hif-leim': refreshed.leim, 'x-hif-dliq': refreshed.dliq };
  }
  return {};
}

// Proxy dispatcher for bypassing IP-based rate limits
let proxyDispatcher = null;

export async function getDispatcher() {
  if (proxyDispatcher !== null) return proxyDispatcher;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxyUrl) {
    proxyDispatcher = false;
    return false;
  }
  try {
    proxyDispatcher = new ProxyAgent(proxyUrl);
    console.log(`Proxy enabled: ${proxyUrl}`);
    return proxyDispatcher;
  } catch (e) {
    throw new Error(`Failed to init proxy (${proxyUrl}): ${e.message}`);
  }
}

// Common headers for API requests
export async function apiHeaders(token, extra = {}) {
  const cookieData = ensureCookies(token);
  const hifHeaders = await getHifHeaders(token);
  return {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'accept': '*/*',
    'x-app-version': '2.0.0',
    'x-client-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'zh_CN',
    'cookie': cookieData.cookie,
    ...BROWSER_HEADERS,
    ...hifHeaders,
    ...extra,
  };
}

// Headers for SSE streaming requests
export async function streamHeaders(token, powResponse, extra = {}) {
  const cookieData = ensureCookies(token);
  const hifHeaders = await getHifHeaders(token);
  return {
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'x-ds-pow-response': powResponse,
    'accept': 'text/event-stream',
    'x-app-version': '2.0.0',
    'x-client-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'zh_CN',
    'cookie': cookieData.cookie,
    ...BROWSER_HEADERS,
    ...hifHeaders,
    ...extra,
  };
}

// Headers for GET requests (no content-type)
export async function getHeaders(token, extra = {}) {
  const cookieData = ensureCookies(token);
  return {
    'authorization': `Bearer ${token}`,
    'accept': '*/*',
    'x-app-version': '2.0.0',
    'x-client-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'zh_CN',
    'cookie': cookieData.cookie,
    ...BROWSER_HEADERS,
    ...extra,
  };
}

// Headers for login (no token)
export function loginHeaders(extra = {}) {
  return {
    'content-type': 'application/json',
    'accept': '*/*',
    'x-app-version': '2.0.0',
    'x-client-version': '2.0.0',
    'x-client-platform': 'web',
    'x-client-locale': 'zh_CN',
    ...BROWSER_HEADERS,
    ...extra,
  };
}

// 设备标识（device id）。
//
// 为什么必须按 token 派生而不是进程级共享：池中每个账号在上游看来都应是
// 一台独立设备。若所有账号共用一个进程级 did，上游可以据此把整池账号关联
// 为同一来源——这与"未配置代理时共用出口 IP"是同一类关联信号，会显著抬高
// 批量风控的概率。
//
// 采用确定性派生（同 token → 同 did）而非每次随机：一是与 ensureCookies 里
// 按 token 生成的 deviceId 语义一致，二是同一账号多次请求保持稳定设备身份，
// 频繁变更设备反而更像异常客户端。
function deriveDeviceId(token) {
  const digest = createHash('sha256').update(`omni-device:${token || 'anonymous'}`).digest('hex');
  // 拼成 UUID 形态，贴合真实浏览器从指纹采集得到的 did 格式。
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`, // 版本位，模拟 UUID v4
    `a${digest.slice(17, 20)}`, // 变体位
    digest.slice(20, 32),
  ].join('-');
}

// 无 token 场景（如健康检查）的兜底设备标识，进程内保持稳定。
const anonymousDeviceId = randomHex(8) + '-' + randomHex(4) + '-' + randomHex(4) + '-' + randomHex(4) + '-' + randomHex(12);

/** 取设备标识。传 token 则返回该账号专属的稳定 did；不传则返回匿名兜底值。 */
export function getDeviceId(token) {
  return token ? deriveDeviceId(token) : anonymousDeviceId;
}

/** 供 checkVisionCapability 等按 token 查询设备能力的调用方使用。 */
export function getDeviceIdForToken(token) {
  return deriveDeviceId(token);
}

// Wrap fetch to use proxy dispatcher when available
export async function proxiedFetch(url, options = {}) {
  const dispatcher = await getDispatcher();
  if (dispatcher) {
    options.dispatcher = dispatcher;
  }
  return fetch(url, options);
}
