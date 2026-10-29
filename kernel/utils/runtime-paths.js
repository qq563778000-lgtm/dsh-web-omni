import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// 部署形态只有本地与 Docker 两种：源码目录始终随进程一起分发，
// 因此路径基于模块位置解析，而不是依赖启动时的当前工作目录。
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = resolve(SRC_DIR, '..');

export function srcPath(...segments) {
  return resolve(SRC_DIR, ...segments);
}

export function appRootPath(...segments) {
  return resolve(APP_ROOT, ...segments);
}

// 版本号以 package.json 为唯一来源，避免在多处硬编码而不同步。
let cachedVersion = null;

export function appVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(appRootPath('package.json'), 'utf8'));
    cachedVersion = String(pkg.version || '0.0.0');
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}
