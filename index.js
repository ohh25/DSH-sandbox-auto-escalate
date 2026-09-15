/**
 * sandbox-auto-escalate — DSH 宿主侧 cordis 插件。
 *
 * 解决的问题
 * ----------
 * DSH 的沙箱拒绝本身**不会**弹审批窗：它只返回
 * `[sandbox: file access denied under <mode> mode]` 加一行提示，要求模型再发
 * 一次带 `sandbox_permissions` + `justification` 的调用才会触发
 * `ctx.approval.request`。那一次“失败 + 重试”要多烧一轮 token。
 *
 * 本插件把这轮往返自动化：判定命中触发规则时，在同一轮内直接以升级后的模式重新
 * 派发，由既有审批通道（`dsh-client-ui-approval`）向用户要一次授权。
 *
 * 两条触发规则
 * ------------
 * 1. `triggerSandboxDenial` —— 结果里出现沙箱拒绝标记。
 *    - `pwsh` / `bash`：标记渲染在**成功结果**的 notice 文本里；
 *    - `fs` 家族（read/write/edit/…）：直接抛出，被注册表包成 `isError: true`。
 *    两族形态不同，所以判定时**成功与错误结果都要扫**（早期版本漏了后者，插件等于
 *    完全不工作，是端到端对照测试逼出来的）。
 *
 * 2. `triggerPwshInitFailure` —— `pwsh` 被沙箱打断在**进程初始化**阶段，
 *    退出码 `0xC0000142` (STATUS_DLL_INIT_FAILED, 十进制 3221225794)、输出全空、
 *    且**不产生**拒绝标记。这类失败 DSH 归类为普通命令错误，原生升级提示不会出现；
 *    升级到 `danger-full-access` 后 pwsh 可正常运行（已实测）。
 *
 * 挂载点
 * ------
 * `tools/execute` waterfall（`@deepseek-ai/dsh-tools` 的
 * `dispatchScheduledExecution`）。该 waterfall 传出**可变的** `exec`，且 `next`
 * 是 cordis 里共享的有状态闭包（内部 `cbs.shift()`）；链走空后再调 `next()` 会
 * 直接再次执行最内层 body，也就是重新派发这次工具调用。
 *
 * 配置
 * ----
 * 扁平结构（嵌套字段没法用 `settingsScope.set(field, value)` 写，所以刻意压平）：
 * 组合配置走 cordis `config` 作为 base 层；`@deepseek-ai/dsh-settings` 存在时
 * 注册同名 namespace，用户在设置界面的改动作为用户层覆盖在上面。
 *
 * 关键实现约束
 * ------------
 * - `exec.arguments` 被 `deepFreeze` 深冻结，**不能原地改**，只能整体替换。
 * - 每次调用最多自动升级一次（`retried` WeakSet），避免无限循环。
 * - 重试会跳过注册在外层的 `tools/execute` 包装器（checkpoint / timeout
 *   policy），因为它们只在第一次走链时被消费。
 *
 * @module sandbox-auto-escalate
 */

export const name = 'sandbox-auto-escalate'

/** 需要工具注册表就绪后再激活，保证注册顺序晚于核心工具链插件。 */
export const inject = ['tools']

/** 设置命名空间；必须匹配 `^[a-z][a-z0-9-]*$`。 */
export const SETTINGS_NAMESPACE = 'sandbox-auto-escalate'

/**
 * 默认配置。刻意扁平：设置界面的 `settingsScope.set(field, value)` 只能写顶层字段。
 */
export const DEFAULT_CONFIG = {
  /** 总开关。false = 完全退回原生行为。 */
  enabled: true,
  /** 升级目标模式。必须比当前模式严格更宽。 */
  targetMode: 'danger-full-access',
  /**
   * 允许被自动升级的工具种类（工具注册名，如 `pwsh` / `bash` /
   * `read` / `write` / `edit`）。**空数组 = 不限制**。
   */
  tools: [],
  /** 触发规则：沙箱拒绝标记（success / error 两种投递形态都识别）。 */
  triggerSandboxDenial: true,
  /** 触发规则：pwsh 在进程初始化阶段被沙箱打断（0xC0000142）。 */
  triggerPwshInitFailure: true,
  /** 视为“初始化失败”的退出码。默认只含 0xC0000142 (STATUS_DLL_INIT_FAILED)。 */
  initFailureExitCodes: [3221225794],
  /**
   * 结果里读不出沙箱模式时的兜底模式。只有初始化失败那条规则会用到：
   * 那种失败不携带拒绝标记，结构化字段也可能缺席。
   */
  fallbackMode: 'workspace-write',
}

/**
 * 构造设置界面用的 schemastery schema。这里是**基础字段**的形状；
 * `initFailureExitCodes` / `fallbackMode` 属于高级项，默认不出现在界面上，
 * 仍可通过组合 config 覆盖。
 *
 * 单独抽成函数是刻意的：schema 只能由 `@deepseek-ai/schemastery` 生成，
 * 而那个包只有 profile 里才有。
 * @param {object} z - schemastery 的默认导出。
 */
export function buildSettingsSchema(z) {
  return z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.enabled),
    targetMode: z.string().default(DEFAULT_CONFIG.targetMode),
    tools: z.array(z.string()).default(DEFAULT_CONFIG.tools),
    triggerSandboxDenial: z.boolean().default(DEFAULT_CONFIG.triggerSandboxDenial),
    triggerPwshInitFailure: z.boolean().default(DEFAULT_CONFIG.triggerPwshInitFailure),
  })
}

/**
 * 默认的 schemastery 解析器。
 *
 * ⚠️ **必须是动态 import，不能是模块顶层 import。** 顶层 import 会让
 * `index.js` 在 profile 之外（例如在工作区里直接跑自测）加载即失败：
 * 本插件是零依赖模块，不该为了一个可选功能绑上硬依赖。
 * 解析不到时设置接入整段降级，插件退回组合配置继续工作。
 * @returns {Promise<object>} schemastery 命名空间对象。
 */
export async function resolveSchemastery() {
  const mod = await import('@deepseek-ai/schemastery')
  return mod.default ?? mod
}

/** 沙箱拒绝标记——与 `@deepseek-ai/dsh-sandbox` 的 `sandboxDenialMarker` 同词法。 */
const DENIAL_PATTERN = /\[sandbox: file access denied under ([a-z-]+) mode\]/

/** 渲染后的退出码标记，形如 `[exit code: 3221225794]`。 */
const EXIT_CODE_PATTERN = /\[exit code: (\d+)\]/

/**
 * 严格更宽的升级阶梯——与 `@deepseek-ai/dsh-sandbox` 的 `WIDER_MODES` 一致。
 * 刻意复制而不是 import：这层判定不值得为一次查表绑上对 harness 内部包的依赖。
 */
const WIDER_MODES = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/**
 * 这些文案说明“这次升级请求根本没送到人面前”，此时应把原始结果还给模型，而不是
 * 把一个通道错误当成结论。用户主动拒绝 / 取消**不在**此列——那种必须让模型看到。
 */
const CHANNEL_UNAVAILABLE = [
  'no approval service is composed',
  'no approval channel is available',
  'has no agent to route it through',
  'is not strictly wider than',
  'is not available in this composition',
  // 该工具 schema 不接受我们注入的升级参数 —— 它没有升级能力。
  'unexpected property',
  'unexpected argument',
  'unknown property',
  'unknown argument',
  'additional properties',
  'additionalproperties',
  'invalid arguments',
]

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 结果里的文本内容。
 *
 * ⚠️ **绝不能跳过错误结果。** 两族工具的拒绝投递形态不同：`pwsh`/`bash` 渲染进
 * 成功结果，`fs` 家族抛出后被包成 `isError: true`（内容形如
 * `Error: [sandbox: file access denied ...]`）。只看成功结果会漏掉整个 fs 家族。
 */
function contentText(result) {
  if (!isPlainObject(result) || !Array.isArray(result.content)) return undefined
  const parts = []
  for (const block of result.content) {
    if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** 错误结果的完整文案（error.message + 文本块），用于识别通道不可用。 */
function errorText(result) {
  if (!isPlainObject(result)) return ''
  const parts = []
  if (isPlainObject(result.error) && typeof result.error.message === 'string') parts.push(result.error.message)
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (isPlainObject(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 结构化产物里的 `sandbox` 描述（pwsh / bash 族会带）。 */
function sandboxOf(result) {
  const value = isPlainObject(result) ? result.value : undefined
  return isPlainObject(value) && isPlainObject(value.sandbox) ? value.sandbox : undefined
}

/** 运行本次调用的有效沙箱模式；先看结构化字段，再退回拒绝标记。 */
function currentMode(result) {
  const sandbox = sandboxOf(result)
  if (sandbox !== undefined && typeof sandbox.mode === 'string') return sandbox.mode
  const text = contentText(result)
  if (text === undefined) return undefined
  const match = DENIAL_PATTERN.exec(text)
  return match === null ? undefined : match[1]
}

/** 进程退出码；先看结构化字段，再退回渲染文本。 */
function exitCodeOf(result) {
  const value = isPlainObject(result) ? result.value : undefined
  if (isPlainObject(value) && typeof value.exitCode === 'number') return value.exitCode
  const text = contentText(result)
  if (text === undefined) return undefined
  const match = EXIT_CODE_PATTERN.exec(text)
  return match === null ? undefined : Number(match[1])
}

/** 给用户看的一行调用摘要——进审批窗的 reason，太长就截断。 */
function describeCall(exec, args) {
  const raw =
    (typeof args.command === 'string' && args.command) ||
    (typeof args.description === 'string' && args.description) ||
    (typeof args.path === 'string' && args.path) ||
    exec.name
  const oneLine = String(raw).replace(/\s+/g, ' ').trim()
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine
}

/** 把任意来源（组合 config / 设置文档）的配置折成完整形状，缺项落回默认值。 */
function normalizeConfig(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const codes = Array.isArray(input.initFailureExitCodes)
    ? input.initFailureExitCodes.filter((code) => typeof code === 'number' && Number.isFinite(code))
    : DEFAULT_CONFIG.initFailureExitCodes
  return {
    enabled: input.enabled !== false,
    targetMode: typeof input.targetMode === 'string' ? input.targetMode : DEFAULT_CONFIG.targetMode,
    tools: Array.isArray(input.tools) ? input.tools.filter((tool) => typeof tool === 'string') : [...DEFAULT_CONFIG.tools],
    triggerSandboxDenial: input.triggerSandboxDenial !== false,
    triggerPwshInitFailure: input.triggerPwshInitFailure !== false,
    initFailureExitCodes: codes.length > 0 ? codes : [...DEFAULT_CONFIG.initFailureExitCodes],
    fallbackMode: typeof input.fallbackMode === 'string' ? input.fallbackMode : DEFAULT_CONFIG.fallbackMode,
  }
}

/** 该工具是否在允许自动升级的名单里（空名单 = 不限制）。 */
function toolAllowed(config, exec) {
  if (config.tools.length === 0) return true
  return config.tools.includes(exec.name)
}

/**
 * 触发规则表。每条规则读 `(exec, result, config)`，命中则返回 `{ reason }`，
 * 未命中返回 undefined。`configKey` 指向扁平配置里的开关字段，设置界面直接改它。
 */
const TRIGGERS = {
  sandboxDenial: {
    configKey: 'triggerSandboxDenial',
    label: '沙箱文件访问拒绝',
    detect(exec, result) {
      const text = contentText(result)
      if (text === undefined) return undefined
      if (!DENIAL_PATTERN.test(text)) return undefined
      const mode = currentMode(result)
      return { reason: `被 ${mode ?? '沙箱'} 沙箱拒绝` }
    },
  },
  pwshInitFailure: {
    configKey: 'triggerPwshInitFailure',
    label: '进程初始化被沙箱打断（0xC0000142）',
    detect(exec, result, config) {
      const code = exitCodeOf(result)
      if (code === undefined || !config.initFailureExitCodes.includes(code)) return undefined
      // 已带拒绝标记的情况交给 sandboxDenial，避免两条规则重复计一次。
      const text = contentText(result)
      if (text !== undefined && DENIAL_PATTERN.test(text)) return undefined
      const hex = `0x${(code >>> 0).toString(16).toUpperCase()}`
      return { reason: `进程被沙箱打断在初始化阶段（exit ${hex}）` }
    },
  },
}

/** 命中任意一条启用中的触发规则。 */
function matchTrigger(exec, result, config) {
  for (const [key, rule] of Object.entries(TRIGGERS)) {
    if (config[rule.configKey] !== true) continue
    const hit = rule.detect(exec, result, config)
    if (hit !== undefined) return { key, label: rule.label, ...hit }
  }
  return undefined
}

/**
 * @param {object} ctx - cordis 插件上下文。
 * @param {object} [config] - 组合配置，形状见 {@link DEFAULT_CONFIG}。
 * @param {object} [internals] - 仅供测试的注入点（`resolveSchema`）。
 */
export function apply(ctx, config = {}, internals = {}) {
  let current = normalizeConfig(config)
  /** 每次 exec 只自动升级一次。 */
  const retried = new WeakSet()

  const warn = (message) => {
    try {
      // 不要再手写 `[sandbox-auto-escalate]` 前缀：harness 的 logger 已经带上
      // 插件名了，手写会得到 `[plugin] [plugin] message` 的双前缀（实测踩到）。
      ctx.logger?.warn?.(message)
    } catch {
      /* 日志失败绝不影响工具调用 */
    }
  }

  // 设置文档存在时，用户层的改动覆盖组合 config。provider 缺席就静默退回组合配置，
  // 所以这里用 ctx.inject 而不是写进顶层 inject —— 后者会让整个插件被 park。
  const resolveSchema = internals.resolveSchema ?? resolveSchemastery
  ctx.inject(['settings'], async (sctx) => {
    try {
      const z = await resolveSchema()
      const scope = sctx.settings.register(SETTINGS_NAMESPACE, buildSettingsSchema(z), { base: config })
      const sync = () => {
        try {
          current = normalizeConfig(scope.get())
        } catch (error) {
          warn(`settings read failed: ${error?.message ?? String(error)}`)
        }
      }
      sync()
      if (typeof scope.watch === 'function') scope.watch(sync)
    } catch (error) {
      warn(`settings namespace unavailable, using composition config: ${error?.message ?? String(error)}`)
    }
  })

  ctx.on('tools/execute', async (exec, next) => {
    const first = await next()
    try {
      return (await maybeEscalate(exec, next, first)) ?? first
    } catch (error) {
      warn(`auto-escalation failed for "${String(exec?.name)}": ${error?.message ?? String(error)}`)
      return first
    }
  })

  /**
   * 首次执行命中触发规则时，在同一轮内自动升级重试一次。
   * @param {object} exec - 本次工具执行（可变）。
   * @param {() => Promise<object>} next - waterfall 续跑闭包；再次调用即重新派发。
   * @param {object} first - 第一次执行的结果。
   * @returns {Promise<object|undefined>} 升级后的结果；undefined 表示沿用 first。
   */
  async function maybeEscalate(exec, next, first) {
    if (current.enabled !== true) return undefined
    if (!isPlainObject(exec) || retried.has(exec)) return undefined
    if (exec.signal?.aborted === true) return undefined
    if (!toolAllowed(current, exec)) return undefined

    // exec.arguments 是深冻结的：只能整体替换。
    const args = exec.arguments
    if (!isPlainObject(args)) return undefined
    // 已经是模型自己发起的升级调用 → 不插手，避免二次弹窗与循环。
    if (args.sandbox_permissions !== undefined || args.justification !== undefined) return undefined

    const hit = matchTrigger(exec, first, current)
    if (hit === undefined) return undefined

    // 初始化失败那条规则不携带拒绝标记、结构化字段也可能缺席 → 用兜底模式。
    const mode = currentMode(first) ?? current.fallbackMode
    const ladder = WIDER_MODES[mode]
    if (ladder === undefined || ladder.length === 0) return undefined

    const target = ladder.includes(current.targetMode) ? current.targetMode : ladder[ladder.length - 1]
    const justification = `${hit.reason}，自动请求以 ${target} 重试：${describeCall(exec, args)}`

    retried.add(exec)
    exec.arguments = { ...args, sandbox_permissions: target, justification }
    warn(`escalating "${String(exec.name)}" (${hit.key}) to ${target}: ${describeCall(exec, args)}`)

    const second = await next()
    if (!isPlainObject(second)) return undefined

    if (second.isError === true) {
      const detail = errorText(second)
      // 审批通道压根不可用 → 保留原始结果，不改变既有语义。
      if (CHANNEL_UNAVAILABLE.some((needle) => detail.includes(needle))) {
        warn(`approval channel unavailable for "${String(exec.name)}"; keeping the original result`)
        return undefined
      }
      // 用户拒绝 / 取消 / 其它真实失败 → 让模型看见，避免它继续盲目重试。
      return second
    }
    return second
  }

  // 刻意不返回任何值：cordis 会把 apply 返回的函数当作 disposer，
  // 返回对象是不必要的风险面。
}
