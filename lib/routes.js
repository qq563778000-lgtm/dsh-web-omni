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

import { addAccount, addToken, listCredentials, removeCredential, testAllCredentials } from './credentials.js';
import { kernelStatus } from './runtime.js';

const STATUS_PATH = '/api/dsh-web-omni/status';
const CREDENTIALS_PATH = '/api/dsh-web-omni/credentials';
const TEST_PATH = '/api/dsh-web-omni/test';

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
    send(res, 200, {
      ok: true,
      value: {
        kernel: kernelStatus(),
        credentials: credentials || { items: [], summary: { total: 0, available: 0, disabled: 0 } },
      },
    });
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
      if (action === 'addAccount') {
        await addAccount({ email: body.email, password: body.password });
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

export const ROUTES = [statusRoute, credentialsRoute, testRoute];
