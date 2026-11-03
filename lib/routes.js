/**
 * 设置页所需的 HTTP 端点
 *
 * 为什么不能只靠 ctx.remote.settings：那个通道只读写"配置项"，
 * 而设置页要展示的是**运行时状态**（凭据是否可用、禁用到什么时候），
 * 这些不在配置里，也无法通过配置表单表达。因此照 dsh-proxy 的做法
 * 注册一个只允许本机访问的端点。
 *
 * 安全约束：
 *   - 只接受来自 loopback 的请求
 *   - 校验 Host/Origin，拒绝跨站请求（防 DNS rebinding 与 CSRF）
 *   - 响应里不含任何凭据明文
 */

import { findBrowserToken } from './browser-token.js';
import { addToken, listCredentials, removeCredential, testAllCredentials } from './credentials.js';
import { kernelStatus, loadKernel, readKernelConfig, writeKernelConfig } from './runtime.js';

const STATUS_PATH = '/api/dsh-web-omni/status';
const CREDENTIALS_PATH = '/api/dsh-web-omni/credentials';
const TEST_PATH = '/api/dsh-web-omni/test';
const SETTINGS_PATH = '/api/dsh-web-omni/settings';
const BROWSER_TOKEN_PATH = '/api/dsh-web-omni/browser-token';

/**
 * 判定请求是否来自本机。
 *
 * 三个条件缺一不可：
 *   1. socket 对端是 loopback —— 挡住外部来源
 *   2. Host 头指向 localhost —— 挡住 DNS rebinding
 *   3. Origin（若存在）与 Host 同源 —— 挡住浏览器跨站发起的请求
 */
export function isLocalRequest(req) {
  const remote = req.socket?.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;

  try {
    const host = new URL(`http://${req.headers.host ?? ''}`);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false;
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    return req.headers.origin === undefined || new URL(req.headers.origin).host === host.host;
  } catch {
    return false;
  }
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // 凭据输入很小，但要有上限：无限制读取会被恶意大包拖垮进程。
    if (size > limitBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 包一层统一的鉴权与错误处理，避免每个 handler 重复写。 */
function guarded(handler) {
  return async (req, res) => {
    if (!isLocalRequest(req)) return send(res, 403, { ok: false, error: '仅允许本机访问' });
    try {
      return await handler(req, res);
    } catch (err) {
      return send(res, 400, { ok: false, error: String(err?.message || err) });
    }
  };
}

export const statusRoute = {
  kind: 'exact',
  path: STATUS_PATH,
  handler: guarded(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false });
    const [credentials] = await Promise.all([listCredentials().catch(() => null)]);
    const settings = await readSettings();
    send(res, 200, {
      ok: true,
      value: {
        kernel: kernelStatus(),
        credentials: credentials || { items: [], summary: { total: 0, available: 0, disabled: 0 } },
        // 运行时开关：设置页据此渲染，切换后立即生效（适配器每次请求重读）。
        settings,
        // 兼容旧字段：已有前端仍读 state.mode。
        mode: settings.mode,
      },
    });
  }),
};

/** 对话模式相关的读写（ask / agent）。 */
/**
 * 验证一个从浏览器读到的 token 是否真的可用。
 *
 * 为什么必须验证：localStorage 里的登录记录会长期保留，即使用户早已
 * 重新登录、旧 token 失效。实测本机 Chrome 里那份 token 是 47 天前的，
 * 上游直接返回 40003。不验证就入库，用户看到"添加成功"，一用对话就报错——
 * 比直接告诉他"读到的是过期数据"糟糕得多。
 *
 * 判定方式：让内核建一次会话。这是最轻的、真实经过上游鉴权的调用。
 */
async function isTokenUsable(token) {
  try {
    // 让内核建一次会话：这是最轻的、真实经过上游鉴权的调用。
    // 失败即视为不可用（失效/被封/网络问题都按"不可用"处理——
    // 宁可让用户手动确认，也不要把不可用的 token 静默存进去）。
    const kernel = await loadKernel();
    await kernel.session.createSession(token, 'default');
    return true;
  } catch {
    return false;
  }
}

async function readMode() {
  const config = await readKernelConfig();
  return config?.runtime?.mode === 'ask' ? 'ask' : 'agent';
}

/** 一次性读出设置页需要的全部运行时开关。 */
async function readSettings() {
  const config = await readKernelConfig();
  const runtime = config?.runtime || {};
  return {
    mode: runtime.mode === 'ask' ? 'ask' : 'agent',
    // 缺省视为开启：这是内核的默认值，也是"更省更快"的一侧。
    affinity: runtime.enableConversationAffinity !== false,
  };
}

/**
 * 运行时开关的读写：对话模式、会话亲和。
 *
 * 两个开关都落在 `runtime` 下，处置方式完全一致（写盘 + 刷新内核内存），
 * 因此合并成一个端点，避免两套几乎相同的代码各自演化出偏差。
 */
export const settingsRoute = {
  kind: 'exact',
  path: SETTINGS_PATH,
  handler: guarded(async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false });
    const body = await readJsonBody(req);

    const patch = {};

    if (body.mode !== undefined) {
      const mode = String(body.mode).toLowerCase();
      if (mode !== 'ask' && mode !== 'agent') {
        return send(res, 400, { ok: false, error: `未知模式: ${body.mode}` });
      }
      patch.mode = mode;
    }

    if (body.affinity !== undefined) {
      patch.enableConversationAffinity = Boolean(body.affinity);
    }

    if (Object.keys(patch).length === 0) {
      return send(res, 400, { ok: false, error: '没有需要更新的设置' });
    }

    // 先读后写，避免覆盖并发写入的凭据等其它字段。
    const config = await readKernelConfig();
    await writeKernelConfig({
      ...config,
      runtime: { ...(config.runtime || {}), ...patch },
    });

    // 写盘后让内核的内存配置同步刷新，否则适配器读到的仍是旧值。
    try {
      const kernel = await loadKernel();
      kernel.configStore.loadConfig({ force: true });
    } catch {
      // 内核未加载时无需刷新：适配器首次读取就会加载最新文件。
    }

    send(res, 200, { ok: true, value: await readSettings() });
  }),
};

export const credentialsRoute = {
  kind: 'exact',
  path: CREDENTIALS_PATH,
  handler: guarded(async (req, res) => {
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const action = String(body.action || '');

      if (action === 'addToken') {
        await addToken({ token: body.token });
        return send(res, 200, { ok: true, value: await listCredentials() });
      }
      if (action === 'remove') {
        await removeCredential({ kind: body.kind, value: body.value });
        return send(res, 200, { ok: true, value: await listCredentials() });
      }
      return send(res, 400, { ok: false, error: `未知操作: ${action}` });
    }

    if (req.method === 'GET') {
      return send(res, 200, { ok: true, value: await listCredentials() });
    }
    return send(res, 405, { ok: false });
  }),
};

export const testRoute = {
  kind: 'exact',
  path: TEST_PATH,
  handler: guarded(async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false });
    // 逐个打上游，耗时可能数十秒；设置页需要临时放宽超时或轮询状态。
    const result = await testAllCredentials();
    send(res, 200, { ok: true, value: result });
  }),
};

/**
 * 从本机浏览器自动获取 Token。
 *
 * 现实约束（2026-11-02 本机实测，必须如实告知用户）：
 *   - Chrome 127+ / Edge 127+ 起，cookie 改用 App-Bound Encryption（`v20`）。
 *     密钥由浏览器以自身身份向系统服务申请，**同用户的其它进程也取不到**。
 *     实测用 DPAPI 解出的 master key 去解 40 条真实 cookie，成功 0 条。
 *   - 因此本接口在主流新版浏览器上大概率返回"未找到"。
 *
 * 保留它的理由：
 *   1. 旧版浏览器（v10/v11 格式）仍可用，这类环境真实存在；
 *   2. 一旦用户改用不受 ABE 限制的浏览器或系统，无需改代码；
 *   3. 探测结果会明确告诉用户"是没登录，还是浏览器加密不支持"，
 *      而不是笼统的"失败"——这对排错很重要。
 */
export const browserTokenRoute = {
  kind: 'exact',
  path: BROWSER_TOKEN_PATH,
  handler: guarded(async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { ok: false });

    // 把校验传进查找过程，让它逐个试候选。
    //
    // 为什么不能"先取第一个、再验证"：多个 profile 各自留着历史 token，
    // 失效的常常排在最前（实测 Profile 1 失效、Profile 2 有效）。
    // 取第一个必然拿到失效值，然后误报"读到过期记录"——用户按提示重新
    // 登录多少次都没用，因为有效的那份就在隔壁 profile 里。
    const result = await findBrowserToken({ validate: isTokenUsable });

    if (result.ok) {
      // 走到这里说明已经验证通过，直接入库，省掉用户再点一次"添加"。
      try {
        await addToken({ token: result.token });
      } catch (err) {
        // 该 token 已经在池里（用户重复点击）不算失败
        if (!/已存在/.test(String(err?.message || ''))) throw err;
      }
      return send(res, 200, {
        ok: true,
        value: {
          added: true,
          browser: result.browser,
          profile: result.profile,
          credentials: await listCredentials(),
        },
      });
    }

    // 失败时把「原因」一并返回，设置页据此给出对应的处置建议。
    //
    // 四种原因指向四种不同动作，混为一谈会让用户白费力气：
    //   stale        → 读到的全部失效，需要重新登录
    //   not-flushed  → 已登录但数据没落盘，关掉标签页再试
    //   not-found    → 确实没登录，去登录
    return send(res, 200, {
      ok: true,
      value: {
        added: false,
        reason: result.reason || 'not-found',
        browser: result.browser || null,
        tried: result.tried,
        credentials: await listCredentials(),
      },
    });
  }),
};

export const ROUTES = [statusRoute, credentialsRoute, testRoute, settingsRoute, browserTokenRoute];
