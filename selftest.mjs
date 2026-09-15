/**
 * sandbox-auto-escalate 离线自测 —— 完全不接触 DSH。
 *
 * 目的：在**不把插件装进 DSH** 的前提下，验证它的判断与重派发逻辑。
 *
 * 这里精确复刻了 `@deepseek-ai/cordis` 的 waterfall 语义（lib/index.js:317）：
 *
 *   waterfall(...args) {
 *     const cbs = this.dispatch("waterfall", args)   // 消费掉 thisArg 与事件名
 *     const inner = args.pop()
 *     const next = () => (cbs.shift() ?? inner)(...args)
 *     args.push(next)
 *     return next()
 *   }
 *
 * 关键点：`next` 是**共享的有状态闭包**。链走空之后再调 `next()`，会直接再次执行
 * `inner`，也就是重新派发这次工具调用——插件的“同轮自动升级”正是靠这一点。
 *
 * 运行：node selftest.mjs
 */

import { apply } from './index.js'

// ---------------------------------------------------------------- 测试脚手架

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks++
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` -> ${detail}`}`)
  }
}

/** 造一个只实现本插件所需表面的假 ctx（含 cordis waterfall 语义）。 */
function makeContext() {
  const hooks = new Map()
  const ctx = {
    logger: { warn: () => {} },
    /**
     * cordis 的按需服务注入。默认模拟「settings 服务缺席」：不执行回调，
     * 插件应当静默退回组合配置而不是挂掉。
     */
    inject(_dependencies, _callback) {},
    on(event, listener) {
      if (!hooks.has(event)) hooks.set(event, [])
      hooks.get(event).push(listener)
    },
    /** 精确复刻 cordis 的 waterfall 编排。 */
    waterfall(event, ...args) {
      const cbs = [...(hooks.get(event) ?? [])]
      const inner = args.pop()
      const next = () => (cbs.shift() ?? inner)(...args)
      args.push(next)
      return next()
    },
  }
  return ctx
}

const success = (text) => ({ isError: false, value: { text }, content: [{ type: 'text', text }] })
const failure = (message) => ({ isError: true, content: [{ type: 'text', text: `Error: ${message}` }], error: { message } })

const DENIED = '[sandbox: file access denied under workspace-write mode]\n[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]'

/**
 * 驱动一次完整的 tools/execute 调度。
 * @param options.toolArgs 模型传来的原始参数（会被深冻结，模拟真实 exec）。
 * @param options.approval 审批结果：'allowed-once' | 'rejected' | 'unavailable' | 'schema-error'
 * @param options.pluginConfig 插件 config
 * @param options.withOuterWrapper 是否额外挂一个外层包装器（模拟 checkpoint / timeout policy）
 * @param options.denyAfterEscalation 升级后仍然被拒（用于验证不会无限循环）
 */
async function drive(options = {}) {
  const {
    toolName = 'pwsh',
    toolArgs = { command: 'curl.exe --version' },
    approval = 'allowed-once',
    pluginConfig = {},
    withOuterWrapper = false,
    denyAfterEscalation = false,
  } = options

  const calls = []
  const approvalRequests = []
  const ctx = makeContext()

  if (withOuterWrapper) {
    ctx.on('tools/execute', async (exec, next) => {
      calls.push({ phase: 'outer-wrapper', args: exec.arguments })
      return next()
    })
  }

  apply(ctx, pluginConfig)

  // 真实 exec：arguments 被 deepFreeze，只有对象本身可写。
  const exec = {
    name: toolName,
    callId: 'call-1',
    agent: { session: { header: { cwd: 'C:\\ws' } } },
    signal: { aborted: false },
    arguments: Object.freeze({ ...toolArgs }),
  }

  // 真实 body：第一次拒绝，带 sandbox_permissions 时走审批。
  const inner = async () => {
    calls.push({ phase: 'body', args: { ...exec.arguments } })
    const escalated = exec.arguments.sandbox_permissions !== undefined
    if (!escalated) return success(DENIED)
    if (denyAfterEscalation) return success('[sandbox: file access denied under danger-full-access mode]')

    approvalRequests.push({ mode: exec.arguments.sandbox_permissions, justification: exec.arguments.justification })
    if (approval === 'allowed-once') return success('curl 8.13.0 (Windows) libcurl/8.13.0 Schannel')
    if (approval === 'rejected') return failure('the user rejected escalating this command to "danger-full-access"')
    if (approval === 'unavailable') return failure('sandbox escalation to "danger-full-access" requires approval, but no approval channel is available')
    return failure('invalid arguments: unexpected property "sandbox_permissions"')
  }

  const result = await ctx.waterfall('tools/execute', exec, inner)
  return { result, calls, approvalRequests, exec }
}

// ------------------------------------------------------------------- 用例

console.log('\n[1] 沙箱拒绝 + 用户允许 -> 同轮自动升级，模型只看到成功')
{
  const { result, calls, approvalRequests } = await drive()
  check('body 被调用两次（原始 + 升级重试）', calls.filter((c) => c.phase === 'body').length === 2, `实际 ${calls.filter((c) => c.phase === 'body').length}`)
  check('返回的是升级后的成功结果', result.isError === false && result.content[0].text.includes('curl 8.13.0'), JSON.stringify(result.content?.[0]))
  check('升级目标为 danger-full-access', calls[1].args.sandbox_permissions === 'danger-full-access', JSON.stringify(calls[1].args))
  check('自动附带了 justification', typeof calls[1].args.justification === 'string' && calls[1].args.justification.length > 0)
  check('justification 说明了拒绝模式与命令', /workspace-write/.test(calls[1].args.justification) && /curl\.exe/.test(calls[1].args.justification), calls[1].args.justification)
  check('原始命令未被篡改', calls[1].args.command === 'curl.exe --version')
  check('恰好发起 1 次审批', approvalRequests.length === 1, `实际 ${approvalRequests.length}`)
}

console.log('\n[2] 沙箱拒绝 + 用户拒绝 -> 模型看到明确拒绝文案')
{
  const { result, calls } = await drive({ approval: 'rejected' })
  check('结果为错误', result.isError === true)
  check('文案说明用户拒绝', /the user rejected/.test(result.error.message), result.error.message)
  check('仍然只重试一次', calls.filter((c) => c.phase === 'body').length === 2)
}

console.log('\n[3] 审批通道不可用 -> 原样返回最初的拒绝结果（不改变既有语义）')
{
  const { result, calls } = await drive({ approval: 'unavailable' })
  check('返回的是原始拒绝结果', result.isError === false && result.content[0].text.includes('file access denied'), JSON.stringify(result.content?.[0]))
  check('确实尝试过一次升级', calls.filter((c) => c.phase === 'body').length === 2)
}

console.log('\n[4] 参数 schema 不支持升级 -> 原样返回原始拒绝')
{
  const { result } = await drive({ approval: 'schema-error' })
  check('返回原始拒绝结果', result.isError === false && result.content[0].text.includes('file access denied'))
}

console.log('\n[5] 未被拒绝 -> 完全直通，零额外开销')
{
  const ctx = makeContext()
  let bodyCalls = 0
  apply(ctx, {})
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ command: 'echo hi' }) }
  const result = await ctx.waterfall('tools/execute', exec, async () => {
    bodyCalls++
    return success('hi')
  })
  check('body 只调用一次', bodyCalls === 1, `实际 ${bodyCalls}`)
  check('结果未被改动', result.content[0].text === 'hi')
}

console.log('\n[6] 模型已自行升级 -> 插件不插手，避免二次弹窗')
{
  const { calls, approvalRequests } = await drive({ toolArgs: { command: 'x', sandbox_permissions: 'danger-full-access', justification: '用户已批准' } })
  check('body 只调用一次', calls.filter((c) => c.phase === 'body').length === 1)
  check('插件没有替换 justification', calls[0].args.justification === '用户已批准')
}

console.log('\n[7] 升级后仍被拒 -> 不会无限循环')
{
  const { calls } = await drive({ denyAfterEscalation: true })
  check('body 恰好调用两次后停止', calls.filter((c) => c.phase === 'body').length === 2, `实际 ${calls.filter((c) => c.phase === 'body').length}`)
}

console.log('\n[8] read-only 模式 -> 取严格更宽阶梯的最宽项')
{
  const ctx = makeContext()
  const seen = []
  apply(ctx, {})
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ command: 'x' }) }
  await ctx.waterfall('tools/execute', exec, async () => {
    seen.push({ ...exec.arguments })
    if (exec.arguments.sandbox_permissions !== undefined) return success('ok')
    return success('[sandbox: file access denied under read-only mode]')
  })
  check('read-only 升级到 danger-full-access', seen[1].sandbox_permissions === 'danger-full-access', JSON.stringify(seen[1]))
}

console.log('\n[9] config.targetMode 可指定更保守的目标')
{
  const ctx = makeContext()
  const seen = []
  apply(ctx, { targetMode: 'workspace-write' })
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ command: 'x' }) }
  await ctx.waterfall('tools/execute', exec, async () => {
    seen.push({ ...exec.arguments })
    if (exec.arguments.sandbox_permissions !== undefined) return success('ok')
    return success('[sandbox: file access denied under read-only mode]')
  })
  check('read-only 升级到 workspace-write', seen[1].sandbox_permissions === 'workspace-write', JSON.stringify(seen[1]))
}

console.log('\n[10] config.tools 白名单生效')
{
  const { calls } = await drive({ toolName: 'write', toolArgs: { path: 'C:\\x' }, pluginConfig: { tools: ['pwsh'] } })
  check('白名单外的工具不重试', calls.filter((c) => c.phase === 'body').length === 1)
}

console.log('\n[11] config.enabled=false 完全退回原生行为')
{
  const { calls } = await drive({ pluginConfig: { enabled: false } })
  check('body 只调用一次', calls.filter((c) => c.phase === 'body').length === 1)
}

console.log('\n[12] 存在外层包装器时依然工作')
{
  const { result, calls } = await drive({ withOuterWrapper: true })
  check('外层包装器在第一次执行时被调用', calls.filter((c) => c.phase === 'outer-wrapper').length === 1, `实际 ${calls.filter((c) => c.phase === 'outer-wrapper').length}`)
  check('仍然升级成功', result.isError === false && result.content[0].text.includes('curl 8.13.0'))
  check('body 调用两次', calls.filter((c) => c.phase === 'body').length === 2)
}

console.log('\n[13] exec.arguments 深冻结 -> 插件必须整体替换而非原地修改')
{
  const { result } = await drive()
  check('未因冻结抛错并成功返回', result.isError === false)
}

console.log('\n[14] 命令文本里的“假标记”不会误触发')
{
  const ctx = makeContext()
  let bodyCalls = 0
  apply(ctx, {})
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ command: 'x' }) }
  const result = await ctx.waterfall('tools/execute', exec, async () => {
    bodyCalls++
    return failure('Error: something else failed')
  })
  check('错误结果不被当作拒绝判定', bodyCalls === 1 && result.isError === true)
}

console.log('\n[14b] fs 家族回归：拒绝以 isError:true 投递时也必须触发升级')
{
  // 实测抓到的缺陷：pwsh/bash 把拒绝标记渲染进**成功结果**的 notice，
  // 而 fs 家族（read/write/edit/…）直接抛出，被 registry 包成 isError:true。
  // 早期 contentText() 里有一行 `if (result.isError === true) return undefined`，
  // 把整个 fs 家族的拒绝滤掉了，插件完全不触发。
  const ctx = makeContext()
  const seen = []
  let approvals = 0
  apply(ctx, {})
  const exec = { name: 'write', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ file_path: 'C:\\outside\\x.tmp' }) }
  const result = await ctx.waterfall('tools/execute', exec, async () => {
    seen.push({ ...exec.arguments })
    if (exec.arguments.sandbox_permissions !== undefined) {
      approvals++
      return success('written')
    }
    return failure('[sandbox: file access denied under workspace-write mode]\n[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]')
  })
  check('isError 的拒绝结果被识别并重试', seen.length === 2, `实际调用 ${seen.length} 次`)
  check('升级目标为 danger-full-access', seen[1]?.sandbox_permissions === 'danger-full-access', JSON.stringify(seen[1]))
  check('返回升级后的成功结果', result.isError === false && result.content[0].text === 'written', JSON.stringify(result.content?.[0]))
  check('审批只发起一次', approvals === 1, `实际 ${approvals}`)
}

console.log('\n[15] 已中止的信号 -> 不重试')
{
  const ctx = makeContext()
  let bodyCalls = 0
  apply(ctx, {})
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: true }, arguments: Object.freeze({ command: 'x' }) }
  await ctx.waterfall('tools/execute', exec, async () => {
    bodyCalls++
    return success(DENIED)
  })
  check('body 只调用一次', bodyCalls === 1, `实际 ${bodyCalls}`)
}

// ------------------------------------------------- pwsh 初始化失败规则（新增）

/** 造一个“pwsh 被沙箱打断在初始化阶段”的结果：输出全空、无拒绝标记。 */
const initFailure = (withStructured) => ({
  isError: false,
  ...(withStructured
    ? {
        value: {
          kind: 'foreground',
          exitCode: 3221225794,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
          sandbox: { mode: 'workspace-write', denied: false },
        },
      }
    : {}),
  content: [{ type: 'text', text: '\n[exit code: 3221225794]' }],
})

console.log('\n[16] pwsh 初始化失败（含结构化 exitCode）-> 自动升级')
{
  const ctx = makeContext()
  const seen = []
  apply(ctx, {})
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ command: 'Get-ChildItem' }) }
  const result = await ctx.waterfall('tools/execute', exec, async () => {
    seen.push({ ...exec.arguments })
    if (exec.arguments.sandbox_permissions !== undefined) return success('ok from pwsh')
    return initFailure(true)
  })
  check('识别初始化失败并重试', seen.length === 2, `实际 ${seen.length}`)
  check('升级到 danger-full-access', seen[1]?.sandbox_permissions === 'danger-full-access', JSON.stringify(seen[1]))
  check('justification 指出被打断在初始化阶段', /初始化/.test(seen[1]?.justification ?? ''), seen[1]?.justification)
  check('返回升级后的成功结果', result.isError === false && result.content[0].text === 'ok from pwsh')
}

console.log('\n[17] pwsh 初始化失败（只有渲染文本，无结构化字段）-> 也能识别')
{
  const ctx = makeContext()
  const seen = []
  apply(ctx, {})
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ command: 'Get-ChildItem' }) }
  await ctx.waterfall('tools/execute', exec, async () => {
    seen.push({ ...exec.arguments })
    if (exec.arguments.sandbox_permissions !== undefined) return success('ok from pwsh')
    return initFailure(false)
  })
  check('从 [exit code: ...] 文本识别并重试', seen.length === 2, `实际 ${seen.length}`)
}

console.log('\n[18] triggerPwshInitFailure=false -> 该规则关闭')
{
  const ctx = makeContext()
  let bodyCalls = 0
  apply(ctx, { triggerPwshInitFailure: false })
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ command: 'x' }) }
  await ctx.waterfall('tools/execute', exec, async () => {
    bodyCalls++
    return initFailure(true)
  })
  check('不做升级', bodyCalls === 1, `实际 ${bodyCalls}`)
}

console.log('\n[19] tools 白名单排除 pwsh -> 不升级')
{
  const ctx = makeContext()
  let bodyCalls = 0
  apply(ctx, { tools: ['write'] })
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ command: 'x' }) }
  await ctx.waterfall('tools/execute', exec, async () => {
    bodyCalls++
    return initFailure(true)
  })
  check('白名单外不升级', bodyCalls === 1, `实际 ${bodyCalls}`)
}

console.log('\n[20] 普通非零退出码 -> 不误触发')
{
  const ctx = makeContext()
  let bodyCalls = 0
  apply(ctx, {})
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ command: 'exit 1' }) }
  await ctx.waterfall('tools/execute', exec, async () => {
    bodyCalls++
    return {
      isError: false,
      value: { kind: 'foreground', exitCode: 1, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, sandbox: { mode: 'workspace-write', denied: false } },
      content: [{ type: 'text', text: '[exit code: 1]' }],
    }
  })
  check('exit 1 不触发升级', bodyCalls === 1, `实际 ${bodyCalls}`)
}

console.log('\n[21] triggerSandboxDenial=false -> 拒绝规则关闭，但初始化失败规则仍生效')
{
  const ctx = makeContext()
  const seen = []
  apply(ctx, { triggerSandboxDenial: false })
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ command: 'x' }) }
  await ctx.waterfall('tools/execute', exec, async () => {
    seen.push({ ...exec.arguments })
    if (exec.arguments.sandbox_permissions !== undefined) return success('ok')
    return initFailure(true)
  })
  check('初始化失败规则不受 denial 开关影响', seen.length === 2, `实际 ${seen.length}`)
}

console.log('\n[22] 设置文档的值覆盖组合配置')
{
  const ctx = makeContext()
  let registered = null
  let pending = null
  ctx.inject = (dependencies, callback) => {
    if (!Array.isArray(dependencies) || !dependencies.includes('settings')) return
    const scope = {
      /** 模拟用户层把它改成了 workspace-write，而组合配置写的是 danger-full-access。 */
      get: () => ({
        enabled: true,
        targetMode: 'workspace-write',
        tools: [],
        triggerSandboxDenial: true,
        triggerPwshInitFailure: true,
      }),
      watch: () => {},
    }
    // 回调现在是 async（schemastery 走动态解析），必须把 promise 留住 await。
    pending = callback({
      settings: {
        register: (namespace, schema, options) => {
          registered = { namespace, options, schema }
          return scope
        },
      },
    })
  }

  const seen = []
  // 注入假的 schema 解析器：工作区里根本没有 @deepseek-ai/schemastery，
  // 而这条用例要验的是「设置文档覆盖组合配置」，不是 schema 长什么样。
  // 假实现仍要具备 schemastery 的表面（object/boolean/string/array），
  // 否则 buildSettingsSchema 会抛错、整段设置接入被 catch 降级。
  const fakeZ = {
    object: (shape) => ({ kind: 'object', shape }),
    boolean: () => ({ default: (value) => value }),
    string: () => ({ default: (value) => value }),
    array: () => ({ default: (value) => value }),
  }
  apply(ctx, { targetMode: 'danger-full-access' }, { resolveSchema: async () => fakeZ })
  await pending
  const exec = { name: 'pwsh', callId: 'c', agent: {}, signal: { aborted: false }, arguments: Object.freeze({ command: 'x' }) }
  await ctx.waterfall('tools/execute', exec, async () => {
    seen.push({ ...exec.arguments })
    if (exec.arguments.sandbox_permissions !== undefined) return success('ok')
    // read-only 的阶梯是 [workspace-write, danger-full-access]，两者都合法，
    // 因此最终目标值能唯一区分「取自设置文档」还是「取自组合配置」。
    return { isError: false, content: [{ type: 'text', text: '[sandbox: file access denied under read-only mode]' }] }
  })
  check('注册到正确命名空间', registered?.namespace === 'sandbox-auto-escalate', JSON.stringify(registered?.namespace))
  check('schema 由 buildSettingsSchema 构建', registered?.schema?.kind === 'object', JSON.stringify(Object.keys(registered?.schema ?? {})))
  check('组合 config 作为 base 层传入', registered?.options?.base?.targetMode === 'danger-full-access', JSON.stringify(registered?.options))
  check('升级目标取自设置文档而非组合配置', seen[1]?.sandbox_permissions === 'workspace-write', JSON.stringify(seen[1]))
}

// ------------------------------------------------------------------- 汇总

console.log(`\n${'='.repeat(60)}`)
console.log(failures === 0 ? `全部通过：${checks} 项断言` : `失败 ${failures} / ${checks} 项断言`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
