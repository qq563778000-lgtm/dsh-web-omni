/**
 * 浏览器扫描 worker。
 *
 * 为什么要单独一个线程：读取浏览器 Local Storage 要读盘并解压 LevelDB
 * 数据块（Snappy），本机实测 1.5~4 秒。这段是**纯同步**的——放在主线程
 * 会把整个 DSH 进程卡住，表现为界面无响应、输入框打不出字。
 *
 * 放进 worker 后，主线程只等一个 Promise，界面全程可响应。
 *
 * 为什么不做成"只读最新几个文件"来提速：那样会漏掉旧 profile 里的
 * token，而"本机多个账号都登录过"正是这个功能的核心价值。
 * 正确性优先——宁可慢，也不能只拿到一个账号的凭据。
 */

import { parentPort } from 'node:worker_threads';

import { scanBrowserCandidates } from './browser-token.js';

parentPort.on('message', () => {
  let result;
  try {
    result = scanBrowserCandidates();
  } catch (err) {
    // 扫描失败不应让 worker 崩掉：上层要把它当作"没找到"处理，
    // 而不是让整个自动获取流程挂住。
    result = { candidates: [], traces: [], error: String(err?.message || err) };
  }
  parentPort.postMessage(result);
});
