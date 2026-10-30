/**
 * 内核引导层
 *
 * 职责：把内嵌的转发内核（kernel/）在 DSH 进程里拉起，并把它与
 * 主项目 OmniAPI 的配置彻底隔离。
 *
 * 为什么隔离必须显式做：内核的 loadEnvironment() 会依次尝试
 * `process.cwd()/.env`、`<appRoot>/.env`。DSH 的工作目录与 appRoot
 * 都可能正好是某个 OmniAPI 部署，那样插件会静默读到主项目的凭据，
 * 出现"两个系统共用一套账号"的隐蔽状态——用户改了一边另一边跟着变，
 * 极难排查。因此这里强制把两个路径都指向插件自己的数据目录。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

let kernelPromise = null;
let kernelReady = false;
let initError = null;
let dataDir = null;
// 插件配置的暂存：apply() 同步阶段就记下来，供 loadKernel 的兜底分支
// 与 initializeKernel 共用同一份来源，避免两条路径算出不同目录。
let pendingConfig = {};

/** 内核模块句柄（延迟加载，避免 apply() 阶段就执行数百 KB 代码）。 */
let kernel = null;

/**
 * 计算插件数据目录。
 *
 * 优先用宿主传入的路径；缺省时退回 OS 临时目录下的固定位置，
 * 保证任何时候都有可写落点，而不是把配置写进 DSH 的 profile 根目录
 * （那里由 Electron 管理，写入可能被覆盖）。
 */
export function resolveDataDir(config = {}) {
  // 优先级：本次入参 > 已隔离的目录 > 已记录的配置 > 默认值。
  //
  // 中间两级不能省：适配器在对话时会以 `{}` 调用（它只关心"哪个目录"），
  // 若此时只看入参就会算出默认路径，与 initializeKernel 用的目录不一致，
  // 直接导致读不到设置页刚保存的凭据。
  if (config?.dataDir) return resolve(String(config.dataDir));
  if (dataDir) return dataDir;
  if (pendingConfig?.dataDir) return resolve(String(pendingConfig.dataDir));

  const base = process.env.DSH_HOME || join(process.env.LOCALAPPDATA || process.env.HOME || '.', 'dsh');
  return resolve(base, 'plugin-data', 'dsh-web-omni');
}

/**
 * 设置隔离环境变量并落盘一个最小 `.env`。
 *
 * 注意：必须在内核模块**首次被 import 之前**设置，因为
 * kernel/utils/env.js 在模块顶层就调用了 loadEnvironment()。
 */
/**
 * 记录插件配置。
 *
 * 必须在 apply() 的最开始调用：适配器构造、内核加载都可能在
 * initializeKernel 之前发生，而它们都要知道数据目录在哪。
 */
export function configure(config = {}) {
  pendingConfig = { ...pendingConfig, ...(config || {}) };
  return pendingConfig;
}

export function isolateEnvironment(dir) {
  dataDir = dir;
  mkdirSync(dir, { recursive: true });

  const envPath = join(dir, '.env');
  // 只写内核认识的键，且刻意不含任何凭据：凭据来自设置页，
  // 由内核的 config.json 承载。
  const lines = [
    '# 由 dsh-web-omni 自动生成，请勿手工编辑',
    '# 凭据请在 DSH 设置页配置；此文件只负责路径与运行时开关',
    '',
  ];
  writeFileSync(envPath, lines.join('\n'), 'utf8');

  process.env.ZHI2API_DATA_DIR = dir;
  process.env.ZHI2API_ENV_PATH = envPath;
  return { dataDir: dir, envPath };
}

/** 内核写入的配置文件路径（凭据与池参数都在这里）。 */
export function configPath() {
  return join(dataDir || resolveDataDir(), 'config.json');
}

/** 读取内核配置（若尚未生成则返回空对象）。 */
export async function readKernelConfig() {
  const { readFileSync } = await import('node:fs');
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8') || '{}');
  } catch {
    return {};
  }
}

/** 写入内核配置。调用方负责先读后合并，避免覆盖并发写入。 */
export async function writeKernelConfig(next) {
  const { writeFileSync } = await import('node:fs');
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/**
 * 加载内核模块。
 *
 * 用动态 import 而非顶层静态 import：这样 apply() 可以先完成注册、
 * 让 DSH 的模型选择器立刻可用，把内核加载与凭据初始化放到后台。
 *
 * 重要时序约束：内核对 ZHI2API_DATA_DIR / ZHI2API_ENV_PATH 的读取发生在
 * **模块顶层**（kernel/utils/env.js 末尾直接调用 loadEnvironment()）。
 * 一旦模块被 import，路径就被固化，之后再改环境变量不再生效。
 * 因此这里必须先确认隔离环境已就绪，否则内核会去读默认路径
 * （cwd 或模块上级目录）的 config.json —— 表现为"设置页存了凭据，
 * 但池里始终 0 条"。
 */
export async function loadKernel() {
  if (kernel) return kernel;

  // 内核模块的顶层会立刻执行 loadEnvironment() 并把配置路径固化，
  // 因此必须在此之前完成隔离。这里用 pendingConfig（由 configure()
  // 记录）而不是 resolveDataDir() 的空参默认值——否则 apply() 传进来的
  // dataDir 会被悄悄忽略，内核去读默认路径，表现为"设置页存了凭据、
  // 池里却始终 0 条"。
  if (!dataDir) {
    isolateEnvironment(resolveDataDir(pendingConfig));
  }

  kernel = {
    generation: await import('../kernel/core/generation.js'),
    internalRequest: await import('../kernel/core/internal-request.js'),
    internalEvents: await import('../kernel/core/internal-events.js'),
    auth: await import('../kernel/services/auth.js'),
    configStore: await import('../kernel/services/config-store.js'),
    conversation: await import('../kernel/services/conversation.js'),
  };
  return kernel;
}

/**
 * 初始化凭据池。
 *
 * 幂等：并发调用共享同一个 Promise，避免重复登录上游（重复登录会让
 * 旧 token 失效，是内核注释里明确警告过的行为）。
 */
export function initializeKernel(config = {}) {
  if (config && Object.keys(config).length > 0) configure(config);
  if (kernelPromise) return kernelPromise;

  kernelPromise = (async () => {
    try {
      const dir = resolveDataDir(pendingConfig);
      isolateEnvironment(dir);

      const k = await loadKernel();
      // initTokenPool 内部会登录缺失的账号、回填禁用态、可选地做启动校验。
      await k.auth.initTokenPool();
      kernelReady = true;
      return { ok: true };
    } catch (err) {
      initError = err;
      // 不抛出：初始化失败不应让插件加载失败，用户仍可在设置页修正后重试。
      return { ok: false, error: err };
    }
  })();

  return kernelPromise;
}

/**
 * 等待内核就绪。
 *
 * 首次对话可能早于凭据池初始化完成（登录上游耗时数秒到数十秒）。
 * 这里等待而不是直接失败，但必须有上限，否则一个卡住的上游会让
 * 整个对话无限挂起。
 */
export async function waitForKernel(config = {}, timeoutMs = 60000) {
  if (kernelReady) return true;
  const pending = initializeKernel(config);
  if (timeoutMs <= 0) {
    await pending;
    return kernelReady;
  }
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
  return kernelReady;
}

/** 当前状态快照，供设置页与日志使用（不含凭据明文）。 */
export function kernelStatus() {
  return {
    ready: kernelReady,
    started: kernelPromise !== null,
    error: initError ? String(initError.message || initError) : null,
    dataDir,
    configPath: dataDir ? configPath() : null,
  };
}

/** 仅供测试：重置内部状态。 */
export function __resetKernelState() {
  kernelPromise = null;
  kernelReady = false;
  initError = null;
  dataDir = null;
  kernel = null;
  pendingConfig = {};
}
