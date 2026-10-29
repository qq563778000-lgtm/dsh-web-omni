import { createHash, timingSafeEqual } from 'crypto';
import { BUILTIN_API_KEY, getConfig } from './config-store.js';

export const ADMIN_SESSION_COOKIE = 'omni_admin';

export function getAdminApiKey() {
  return getConfig().server.apiKey || process.env.API_KEY || '';
}

/**
 * 管理后台接受的全部 Key（含内置放行 Key）。
 * 与 /v1 走同一套判定，避免两处鉴权规则不一致。
 */
function acceptedAdminKeys() {
  const keys = [BUILTIN_API_KEY, getAdminApiKey()];
  // 外部 API Key 同样允许用于后台（与 /v1 一致）。
  for (const item of getConfig().server.apiKeys || []) {
    keys.push(typeof item === 'string' ? item : item?.key);
  }
  return keys.map(k => String(k || '').trim()).filter(Boolean);
}

function sessionValue(apiKey = getAdminApiKey()) {
  if (!apiKey) return '';
  return createHash('sha256').update(`omni-admin-session:${apiKey}`).digest('hex');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function hasValidAdminAuth(req) {
  const apiKey = getAdminApiKey();
  if (!apiKey) return true;

  // 兼容三种认证方式，与 /v1/ 中间件保持一致
  const auth = req.headers?.authorization || '';
  const apiKeyHeader = req.headers?.['api-key'] || '';
  const xApiKey = req.headers?.['x-api-key'] || '';
  const token = (auth.startsWith('Bearer ') ? auth.slice(7).trim() : '')
    || apiKeyHeader.trim()
    || xApiKey.trim();
  if (token && acceptedAdminKeys().some(k => safeEqual(k, token))) return true;

  const cookies = parseCookies(req.headers?.cookie);
  return safeEqual(cookies[ADMIN_SESSION_COOKIE], sessionValue(apiKey));
}

export function setAdminSessionCookie(res, apiKey = getAdminApiKey()) {
  const value = sessionValue(apiKey);
  if (!value) return;
  res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
}

export function clearAdminSessionCookie(res) {
  res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function authStatus(req) {
  const apiKey = getAdminApiKey();
  return {
    authRequired: Boolean(apiKey),
    apiKeyConfigured: Boolean(apiKey),
    authenticated: hasValidAdminAuth(req),
  };
}

export function verifyAdminPassword(password) {
  return acceptedAdminKeys().some(k => safeEqual(password, k));
}
