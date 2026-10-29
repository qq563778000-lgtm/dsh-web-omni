// Performance metrics collector — sliding window + timeseries storage
// Provides RPM, TTFB P50/P90, Token speed, Session hit rate, per-model breakdown

const WINDOW_SIZES = [60, 300, 900]; // 1min, 5min, 15min in seconds

// Per-request data point (kept in sliding windows)
class RequestRecord {
  constructor(time, model, duration, status, ttfb, tokens) {
    this.time = time;
    this.model = model;
    this.duration = duration;
    this.status = status;
    this.ttfb = ttfb;
    this.tokens = tokens;
  }
}

const requestBuffer = []; // all recent records (capped at 5000)
// 内存缓冲上限。低配服务器上刻意收紧：
//   requestBuffer 5000→1000（滑动窗口只需近几分钟的数据）
//   sessionEvents 2000→500（仅用于算命中率）
//   timeseries    4320→2880（72h→48h，每点约 200B）
// 均可通过环境变量覆盖。
function cap(name, fallback) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const BUFFER_CAP = cap('METRICS_REQUEST_BUFFER_CAP', 1000);

// Session hit/miss counters (sliding window)
const sessionEvents = []; // { time, hit: bool }
const SESSION_CAP = cap('METRICS_SESSION_EVENTS_CAP', 500);

// Timeseries snapshots (1 per minute, 72h = 4320 points)
const TIMESERIES_CAP = cap('METRICS_TIMESERIES_CAP', 2880);
const timeseries = []; // { ts, rpm, ttfbP50, ttfbP90, tokenSpeed, sessionHitRate, errorRate, perModel: {} }
let lastSnapshotTime = 0;

// Overload counter
let overloadCount = 0;
let overloadRejectCount = 0;

// --- Recording functions ---

export function recordRequest(model, duration, status) {
  const now = Date.now();
  const record = new RequestRecord(now, model, duration, status, null, null);
  requestBuffer.push(record);
  if (requestBuffer.length > BUFFER_CAP) requestBuffer.splice(0, requestBuffer.length - BUFFER_CAP);
  return record;
}

export function recordTTFB(model, ttfb) {
  // Attach TTFB to the most recent record for this model
  for (let i = requestBuffer.length - 1; i >= 0; i--) {
    if (requestBuffer[i].model === model && requestBuffer[i].ttfb === null) {
      requestBuffer[i].ttfb = ttfb;
      return;
    }
  }
}

/**
 * 把本次请求的 token 用量挂到响应对象上，由日志中间件在写记录时读取。
 *
 * 为什么不用「按模型配对最近一条未配对记录」：并发请求下无法确定哪条
 * 记录属于哪个请求，会把 A 的 token 数配到 B 的耗时上，算出天文数字般的
 * tok/s（实测出现过 1586、780）。挂在 res 上则是严格 1:1，与并发无关。
 */
export function recordUsage(res, { outputTokens = 0, durationMs = 0 } = {}) {
  if (!res || !(outputTokens > 0) || !(durationMs > 0)) return;
  res.omniUsage = { outputTokens, durationMs };
}

/** 取出并清除响应对象上的用量（由日志中间件调用，保证只消费一次）。 */
export function takeUsage(res) {
  if (!res || !res.omniUsage) return null;
  const usage = res.omniUsage;
  res.omniUsage = null;
  return usage;
}

/**
 * 把用量写入「刚由 recordRequest 创建的那条记录」。
 *
 * 由日志中间件在 recordRequest 之后立即调用，因此目标记录必然是缓冲区
 * 末尾且属于本次请求——不依赖"最近未配对记录"这类在并发下会错配的启发式。
 */
export function recordUsageRecord(record, { outputTokens = 0, durationMs = 0 } = {}) {
  if (!record || !(outputTokens > 0)) return;
  record.tokens = outputTokens;
  // 用 runner 上报的服务端完整耗时（与 tokens 同源），
  // 避免 tokens 与 duration 来自不同请求而算出畸形速度。
  if (durationMs > 0) record.duration = durationMs;
}

export function recordSessionHit(hit) {
  const now = Date.now();
  sessionEvents.push({ time: now, hit });
  if (sessionEvents.length > SESSION_CAP) sessionEvents.splice(0, sessionEvents.length - SESSION_CAP);
}

export function recordOverload(rejected = false) {
  overloadCount++;
  if (rejected) overloadRejectCount++;
}

// --- Computation helpers ---

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  // Nearest-rank method: the p-th percentile is the value at rank
  // ceil(p/100 * n), 1-indexed. Corrects the previous ceil-1 formula which
  // biased low for small samples (e.g. n=1 returned index -1 -> clamped).
  const idx = Math.min(Math.ceil((p / 100) * sorted.length), sorted.length) - 1;
  return sorted[idx];
}

function getWindowRecords(windowSec) {
  const cutoff = Date.now() - windowSec * 1000;
  return requestBuffer.filter(r => r.time >= cutoff);
}

function getSessionHitRate(windowSec) {
  const cutoff = Date.now() - windowSec * 1000;
  const events = sessionEvents.filter(e => e.time >= cutoff);
  if (events.length === 0) return null; // no data, not 100%
  const hits = events.filter(e => e.hit).length;
  return Math.round((hits / events.length) * 100);
}

function computeModelMetrics(records) {
  const byModel = {};
  for (const r of records) {
    if (!byModel[r.model]) byModel[r.model] = { requests: [], ttfbs: [], tokenSpeeds: [], errors: 0 };
    const m = byModel[r.model];
    m.requests.push(r);
    if (r.ttfb !== null) m.ttfbs.push(r.ttfb);
    if (r.tokens !== null && r.duration > 0) m.tokenSpeeds.push(r.tokens / (r.duration / 1000));
    if (r.status >= 400) m.errors++;
  }

  const result = {};
  for (const [model, m] of Object.entries(byModel)) {
    const ttfbs = m.ttfbs.sort((a, b) => a - b);
    result[model] = {
      rpm: Math.round(m.requests.length / 5), // 5min window → per minute
      ttfbP50: ttfbs.length ? Math.round(percentile(ttfbs, 50)) : 0,
      ttfbP90: ttfbs.length ? Math.round(percentile(ttfbs, 90)) : 0,
      tokenSpeed: m.tokenSpeeds.length ? Math.round(m.tokenSpeeds.reduce((a, b) => a + b, 0) / m.tokenSpeeds.length) : 0,
      errors: m.errors,
      requests: m.requests.length,
    };
  }
  return result;
}

// --- Public query functions ---

export function getMetrics() {
  const records5m = getWindowRecords(300);
  const ttfbs = records5m.filter(r => r.ttfb !== null).map(r => r.ttfb).sort((a, b) => a - b);
  const tokenSpeeds = records5m.filter(r => r.tokens !== null && r.duration > 0).map(r => r.tokens / (r.duration / 1000));
  const errors = records5m.filter(r => r.status >= 400).length;

  return {
    rpm: Math.round(records5m.length / 5),
    ttfbP50: ttfbs.length ? Math.round(percentile(ttfbs, 50)) : 0,
    ttfbP90: ttfbs.length ? Math.round(percentile(ttfbs, 90)) : 0,
    tokenSpeed: tokenSpeeds.length ? Math.round(tokenSpeeds.reduce((a, b) => a + b, 0) / tokenSpeeds.length) : 0,
    sessionHitRate: getSessionHitRate(300),
    errorRate: records5m.length ? Math.round((errors / records5m.length) * 100) : 0,
    overloadCount,
    overloadRejectCount,
    perModel: computeModelMetrics(records5m),
    uptime: process.uptime(),
  };
}

// --- Timeseries ---

export function maybeSnapshot() {
  const now = Date.now();
  // Snapshot every 60 seconds
  if (now - lastSnapshotTime < 60000) return;
  lastSnapshotTime = now;

  const m = getMetrics();
  timeseries.push({
    ts: now,
    rpm: m.rpm,
    ttfbP50: m.ttfbP50,
    ttfbP90: m.ttfbP90,
    tokenSpeed: m.tokenSpeed,
    sessionHitRate: m.sessionHitRate,
    errorRate: m.errorRate,
    perModel: m.perModel,
  });
  if (timeseries.length > TIMESERIES_CAP) timeseries.splice(0, timeseries.length - TIMESERIES_CAP);
}

export function getTimeseries(range = '6h') {
  const rangeMs = parseRange(range);
  const cutoff = Date.now() - rangeMs;
  return timeseries.filter(p => p.ts >= cutoff);
}

function parseRange(range) {
  const map = { '1h': 3600000, '3h': 10800000, '6h': 21600000, '12h': 43200000, '24h': 86400000, '48h': 172800000, '72h': 259200000 };
  return map[range] || map['6h'];
}

// Start snapshot timer
const snapshotInterval = setInterval(maybeSnapshot, 30000); // check every 30s, snapshot every 60s
snapshotInterval.unref?.(); // don't keep process alive for this
