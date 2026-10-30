#!/usr/bin/env node
/**
 * 从主项目 src/ 同步内核到 kernel/
 *
 * 为什么需要这个脚本：插件的"装完即用"依赖内核随包分发，但内核的
 * 唯一事实来源是主项目的 src/。手工拷贝会在某个修复后静默过期，
 * 表现为"主项目已修好、插件里还是旧行为"——这种漂移极难排查。
 *
 * 用法：
 *   node scripts/sync-kernel.mjs            # 同步
 *   node scripts/sync-kernel.mjs --check    # 只检查是否漂移（CI 用）
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT_ROOT = resolve(PLUGIN_ROOT, '..');
const SOURCE_ROOT = resolve(PROJECT_ROOT, 'src');
const TARGET_ROOT = resolve(PLUGIN_ROOT, 'kernel');

// 内核 = 转发链路所需的全部代码。不含：
//   routes/    HTTP 层（插件自带适配器，不需要 Express 路由）
//   server.js  进程入口
//   index.js   同上
//   public/ admin/  管理后台静态资源
//   middleware/ 需要（services 依赖 logger/metrics），下方单列
const KERNEL_DIRS = ['channels', 'core', 'services', 'utils', 'protocols', 'middleware'];
const KERNEL_FILES = ['sha3_wasm_bg.wasm'];

const checkOnly = process.argv.includes('--check');

function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

function collectFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * 内容指纹：与 git 状态无关，只看文件内容。
 *
 * 入参是一组 (相对路径, 绝对路径)，因此可以对"源侧选中的文件"与
 * "目标侧的全部文件"用同一份清单做比较——直接对两个根目录求指纹会
 * 因为 src/ 比 kernel/ 多出 routes/public 等而永远不相等。
 */
function fingerprintOf(entries) {
  const hash = createHash('sha256');
  for (const [rel, abs] of entries) {
    hash.update(rel.replace(/\\/g, '/'));
    hash.update('\0');
    hash.update(readFileSync(abs));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** 源侧：按内核清单枚举文件，产出与目标侧同构的 (相对路径, 绝对路径)。 */
function sourceEntries() {
  const entries = [];
  for (const dir of KERNEL_DIRS) {
    const from = resolve(SOURCE_ROOT, dir);
    if (!existsSync(from)) fail(`主项目缺少目录: src/${dir}`);
    for (const file of collectFiles(from)) {
      entries.push([relative(SOURCE_ROOT, file), file]);
    }
  }
  for (const file of KERNEL_FILES) {
    const from = resolve(SOURCE_ROOT, file);
    if (!existsSync(from)) fail(`主项目缺少文件: src/${file}`);
    entries.push([file, from]);
  }
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

/** 目标侧：kernel/ 下全部文件（排除同步元数据本身）。 */
function targetEntries() {
  return collectFiles(TARGET_ROOT)
    .filter(file => !file.endsWith('KERNEL_VERSION'))
    .map(file => [relative(TARGET_ROOT, file), file])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function projectCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function main() {
  if (!existsSync(SOURCE_ROOT)) {
    // 独立发布后的常态：本仓库不含主项目 src/，kernel/ 是已同步好的产物。
    //
    // 此时不能直接 fail——CI 和普通使用者跑 npm test 时会连带触发这里的
    // 检查，报一个与"能不能用"无关的错误只会造成困惑。改为明确说明：
    // 这是开发期脚本，独立仓库里 kernel/ 即为事实来源。
    if (checkOnly) {
      console.log('ℹ 未找到主项目 src/（独立仓库形态），跳过内核漂移检查；kernel/ 为已同步产物。');
      return;
    }
    fail(
      `找不到主项目源码目录: ${SOURCE_ROOT}\n`
      + '  本脚本用于从主项目 src/ 同步内核。独立发布仓库不含 src/，\n'
      + '  kernel/ 已是同步好的产物，无需运行此脚本。',
    );
  }

  // --check 只比较指纹，不写盘。
  if (checkOnly) {
    if (!existsSync(TARGET_ROOT)) fail('kernel/ 不存在，请先运行 npm run sync:kernel');
    const expected = fingerprintOf(sourceEntries());
    const actual = fingerprintOf(targetEntries());
    if (expected !== actual) {
      fail('kernel/ 与主项目 src/ 不一致，请运行 npm run sync:kernel');
    }
    console.log('✓ kernel/ 与主项目一致');
    return;
  }

  rmSync(TARGET_ROOT, { recursive: true, force: true });
  mkdirSync(TARGET_ROOT, { recursive: true });

  let fileCount = 0;
  for (const dir of KERNEL_DIRS) {
    const from = resolve(SOURCE_ROOT, dir);
    if (!existsSync(from)) fail(`主项目缺少目录: src/${dir}`);
    cpSync(from, resolve(TARGET_ROOT, dir), { recursive: true });
    fileCount += collectFiles(from).length;
  }
  for (const file of KERNEL_FILES) {
    const from = resolve(SOURCE_ROOT, file);
    if (!existsSync(from)) fail(`主项目缺少文件: src/${file}`);
    cpSync(from, resolve(TARGET_ROOT, file));
    fileCount += 1;
  }

  const version = {
    syncedAt: new Date().toISOString(),
    projectCommit: projectCommit(),
    fingerprint: fingerprintOf(targetEntries()),
    files: fileCount,
  };
  writeFileSync(resolve(TARGET_ROOT, 'KERNEL_VERSION'), `${JSON.stringify(version, null, 2)}\n`);

  console.log(`✓ 已同步 ${fileCount} 个文件到 kernel/`);
  console.log(`  主项目 commit: ${version.projectCommit}`);
  console.log(`  指纹: ${version.fingerprint.slice(0, 16)}…`);
}

main();
