/**
 * 对话模式的取值、默认值与生效规则 —— 单一来源。
 *
 * 为什么单独抽一个模块：mode 的默认值此前散落在 5 处，每处的"缺省语义"
 * 还互相打架：
 *
 *   内核配置      缺省 'agent'
 *   归一化        非法值 → 'agent'
 *   适配器回落    读配置失败 → 'agent'
 *   路由读取      缺省 → 'agent'
 *   前端初始态    'agent'
 *
 * 只要有一处漏改，用户看到的界面和实际生效的行为就对不上——而这类
 * 不一致极难察觉：界面显示 Ask，模型照样收到了全部工具声明。
 *
 * 现在统一到这里：改默认值只改一处，其余全部引用。
 *
 * 放在内核侧而不是 lib/：内核是内核与插件的公共底座，依赖方向必须
 * 保持"插件 → 内核"，反向依赖会形成环。
 */

/** 合法取值。 */
export const MODE_ASK = 'ask';
export const MODE_AGENT = 'agent';

/** 全部合法取值，供参数校验用。 */
export const MODES = [MODE_AGENT, MODE_ASK];

/**
 * 默认对话模式。
 *
 * 2026-11-03 起默认 ask：插件的定位是"把 DeepSeek Web 接进 DSH 做对话"，
 * 而 DSH 默认会带上完整的行为契约与全部工具声明（约 25K 字符）。对只想
 * 问答的用户，这是又贵又不想要的；想用工具时切到 Agent 即可，一键可达。
 */
export const DEFAULT_MODE = MODE_ASK;

/**
 * 归一化任意输入为合法模式。
 *
 * 非法值（含空、null、拼错）一律落到默认值，而不是某个"看起来合理"的
 * 兜底——兜底值不同正是这类不一致的根源。
 */
export function normalizeMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return MODES.includes(mode) ? mode : DEFAULT_MODE;
}

/**
 * 解析出**实际生效**的模式。
 *
 * 这里要处理一个真实存在过的歧义：配置在写盘时会被整体物化——
 * saveConfig 落盘的是"归一化后的完整配置"，于是连用户从没碰过的字段
 * 也会出现在文件里。结果是：
 *
 *   用户从未选择、拿到的就是默认值 'agent'   →  磁盘上写着 mode:'agent'
 *   用户明确选择了 Agent                      →  磁盘上写着 mode:'agent'
 *
 * 两种情况在磁盘上**逐字节相同**，无法区分。而它们理应有不同命运：
 * 前者应当跟随新默认值，后者必须被尊重。
 *
 * 因此引入 modeExplicit 标记：
 *   - 设置页**每次**切换模式都会写 modeExplicit:true，此后以 mode 为准；
 *   - 没有该标记的（历史遗留的）配置，一律按默认值处理。
 *
 * 这样迁移是单向且安全的：明确选过 Agent 的用户不会被改动；只是吃默认值
 * 的用户跟随新默认。将来再改默认值，历史用户也不会被意外翻转。
 *
 * @param {{mode?: string, modeExplicit?: boolean}} runtime 配置里的 runtime 段
 * @returns {'ask'|'agent'} 生效的模式
 */
export function resolveMode(runtime = {}) {
  // 显式选择优先。显式值非法时也归一化，避免落进"读取失败"分支。
  if (runtime?.modeExplicit === true) return normalizeMode(runtime.mode);
  return DEFAULT_MODE;
}
