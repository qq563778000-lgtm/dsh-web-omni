/**
 * 从 DSH 的 asar 里解出 @deepseek-ai/cordis，让契约测试能真正跑起来。
 *
 * 为什么需要：dsh-llm 通过 npm 装在本地，但 cordis 只存在于 DSH 的
 * asar 里。没有它，契约测试整组跳过——而那恰恰是验证"插件能否被真实
 * LlmRuntime 装载"的关键一环，跳过等于没验证。
 *
 * 这是开发期工具，不随插件分发。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ASAR = join(
  process.env.LOCALAPPDATA || '',
  'Programs/DeepSeek Harness/resources/app.asar',
);

if (!existsSync(ASAR)) {
  console.error('找不到 DSH asar：', ASAR);
  process.exit(1);
}

const fd = readFileSync(ASAR);
const headerSize = fd.readUInt32LE(12);
const header = JSON.parse(fd.subarray(16, 16 + headerSize).toString('utf8'));
const dataStart = 16 + headerSize;

const entries = [];
(function walk(node, base) {
  for (const [key, value] of Object.entries(node.files || {})) {
    const full = base + '/' + key;
    if (value.files) walk(value, full);
    else entries.push({ path: full, size: value.size, offset: Number(value.offset), unpacked: !!value.unpacked });
  }
})(header, '');

// 需要解出的包：cordis 本体 + 它的运行时依赖 cosmokit
// 解出所有 @deepseek-ai 包：契约测试要用真实的 dsh-llm，而它的依赖链
// 会一直延伸到十几个包。与其逐个补，不如一次全解。
const PACKAGE_NAMES = [...new Set(
  entries
    .filter(e => e.path.startsWith('/dsh/node_modules/@deepseek-ai/'))
    .map(e => e.path.slice('/dsh/node_modules/@deepseek-ai/'.length).split('/')[0])
)];
const PACKAGES = PACKAGE_NAMES.map(name => ({
  name,
  prefix: `/dsh/node_modules/@deepseek-ai/${name}/`,
}));

let written = 0;
for (const pkg of PACKAGES) {
  const outDir = join(process.cwd(), 'node_modules/@deepseek-ai', pkg.name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // .js / .mjs / .cjs 都要：有些包（如 schemastery）只有 .mjs 入口
  const targets = entries.filter(e => e.path.startsWith(pkg.prefix) && /\.(js|mjs|cjs)$/.test(e.path));
  if (!targets.length) {
    console.error('asar 内未找到', pkg.name);
    continue;
  }

  for (const entry of targets) {
    const rel = entry.path.slice(pkg.prefix.length);
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (entry.unpacked) {
      const unpackedPath = join(ASAR + '.unpacked', entry.path);
      if (existsSync(unpackedPath)) {
        writeFileSync(dest, readFileSync(unpackedPath));
        written += 1;
        continue;
      }
    }
    const buf = fd.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size);
    writeFileSync(dest, buf);
    written += 1;
  }

  // package.json 手写：asar 里那份带二进制 padding，JSON.parse 会失败。
  // 入口按实际存在的文件推断。
  // 入口按实际存在的文件推断：不同包的入口扩展名不同（lib/index.js、
  // lib/index.mjs、src/index.ts），写死任何一个都会让 Node 解析失败。
  const CANDIDATES = [
    './lib/index.mjs', './lib/index.js', './src/index.js',
    './lib/index.cjs', './index.js', './index.mjs',
  ];
  const main = CANDIDATES.find(rel => existsSync(join(outDir, rel))) || './lib/index.js';
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({
    name: `@deepseek-ai/${pkg.name}`,
    version: '4.0.5',
    type: 'module',
    main,
    exports: { '.': main, './package.json': './package.json' },
  }, null, 2));
}

console.log(`已解出 ${written} 个文件到 node_modules/@deepseek-ai/`);
