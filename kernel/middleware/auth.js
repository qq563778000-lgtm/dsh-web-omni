/**
 * API Key 认证中间件
 */

import { getAcceptedApiKeys, isAcceptedApiKey } from '../services/config-store.js';

export function authMiddleware(req, res, next) {
  if (getAcceptedApiKeys().length === 0) return next();

  // Admin 页面不使用外部 API Key 认证。
  if (req.method === 'GET' && req.path === '/admin') {
    return next();
  }

  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (token && isAcceptedApiKey(token)) {
    return next();
  }

  res.status(401).json({
    error: {
      message: 'Invalid API key'
    }
  });
}
