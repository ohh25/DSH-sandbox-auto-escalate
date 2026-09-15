/**
 * sandbox-auto-escalate 的浏览器半侧 —— 设置 → 「沙箱自动升级」页面。
 *
 * 形态说明
 * --------
 * 这是客户端模块系统的 **lazy-CJS factory bundle**：宿主只按文本提供本文件、
 * 不做任何编译，所以这里必须是**纯 JS**（无 JSX、无 TS），元素一律用
 * `React.createElement` 构造。`require` 由平台 seed 表回答（`react` /
 * `react/jsx-runtime` / `react-dom` 均已证实可用）。
 *
 * 读写设置
 * --------
 * 走官方 `ctx.settingsScope.bind({ namespace })`，而不是自建 HTTP 路由：
 * - `scope.getSnapshot()` → `{ status, value, base, user, revision, writable, mode }`
 * - `scope.subscribe(listener)` → 返回 disposer
 * - `scope.set(field, value)` → 写顶层字段（**所以宿主配置刻意是扁平结构**）
 *
 * 注册点
 * ------
 * `settings.section`（list slot，`id` 必填）。声明者是
 * `@deepseek-ai/dsh-client-ui-settings-general`；本页作为设置里的一级导航项出现。
 */
window.__ModuleLoader__.load({
  id: 'sandbox-auto-escalate',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports
    const e = React.createElement

    const NS = 'sandbox-auto-escalate'

    /** 可勾选的工具种类。与宿主侧 `tools` 字段的取值一致。 */
    const TOOL_KINDS = [
      { id: 'pwsh', label: 'PowerShell（pwsh）', hint: '注意：pwsh 在当前沙箱下每次调用都会失败，勾上它等于每次都要点一次授权。' },
      { id: 'bash', label: 'Bash' },
      { id: 'read', label: '文件读取（read）' },
      { id: 'write', label: '文件写入（write）' },
      { id: 'edit', label: '文件编辑（edit）' },
    ]

    const CSS = [
      '.sae-page{display:flex;flex-direction:column;gap:16px;padding:2px;max-width:660px}',
      '.sae-group{border:1px solid rgba(128,128,128,.28);border-radius:8px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
      '.sae-legend{font-size:12px;font-weight:600;opacity:.75;letter-spacing:.02em}',
      '.sae-row{display:flex;align-items:flex-start;gap:9px;font-size:13px;line-height:1.5}',
      '.sae-row input[type=checkbox],.sae-row input[type=radio]{margin-top:2px;flex:none}',
      '.sae-hint{font-size:12px;opacity:.6;margin-top:2px;line-height:1.45}',
      '.sae-tools{display:flex;flex-direction:column;gap:9px;padding-left:24px;border-left:2px solid rgba(128,128,128,.18);margin-left:3px}',
      '.sae-select{padding:4px 8px;border-radius:6px;background:transparent;color:inherit;border:1px solid rgba(128,128,128,.4);font-size:13px}',
      '.sae-banner{font-size:12px;padding:8px 10px;border-radius:6px;background:rgba(200,140,0,.14);line-height:1.5}',
      '.sae-muted{font-size:12px;opacity:.6}',
      '.sae-title{font-size:15px;font-weight:600;margin:0}',
    ].join('\n')

    let styleInjected = false
    const injectStyle = () => {
      if (styleInjected) return
      styleInjected = true
      try {
        const tag = document.createElement('style')
        tag.setAttribute('data-dsh-plugin', NS)
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch {
        /* 样式注入失败不影响功能 */
      }
    }

    // ---------------------------------------------------------------- 绑定设置

    const EMPTY_SNAPSHOT = { status: 'unavailable', value: {}, writable: false }

    /** 当前绑定的 scope；settingsScope 服务可用后填充。 */
    let scope = null
    let scopeDisposer = null
    const subscribers = new Set()

    const notify = () => {
      for (const fn of subscribers) {
        try {
          fn()
        } catch {
          /* 单个订阅者异常不影响其它 */
        }
      }
    }

    /** 稳定的 subscribe：只在第一个订阅者出现时挂到 scope 上。 */
    const subscribe = (fn) => {
      if (subscribers.size === 0 && scope !== null && scopeDisposer === null) {
        scopeDisposer = scope.subscribe(notify)
      }
      subscribers.add(fn)
      return () => {
        subscribers.delete(fn)
        if (subscribers.size === 0 && scopeDisposer !== null) {
          try {
            scopeDisposer()
          } catch {
            /* 释放失败忽略 */
          }
          scopeDisposer = null
        }
      }
    }

    /** 稳定的 getSnapshot：无 scope 时返回同一个常量对象引用。 */
    const getSnapshot = () => (scope === null ? EMPTY_SNAPSHOT : scope.getSnapshot())

    // ---------------------------------------------------------------- 组件

    function CheckRow(props) {
      return e(
        'label',
        { className: 'sae-row' },
        e('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (event) => props.onChange(event.target.checked),
        }),
        e(
          'span',
          null,
          e('div', null, props.label),
          props.hint ? e('div', { className: 'sae-hint' }, props.hint) : null,
        ),
      )
    }

    function Section() {
      injectStyle()
      const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)

      const status = snapshot ? snapshot.status : 'loading'
      const value = (snapshot && snapshot.value) || {}
      const writable = !snapshot || snapshot.writable !== false
      const tools = Array.isArray(value.tools) ? value.tools : []
      const allTools = tools.length === 0

      const set = (field, next) => {
        if (scope === null) return
        try {
          void scope.set(field, next)
        } catch {
          /* 写入失败由 scope 自己恢复读取 */
        }
      }

      if (scope === null) {
        return e('div', { className: 'sae-page' }, e('div', { className: 'sae-banner' }, '设置服务不可用，本页暂时无法读写配置。'))
      }

      const children = []

      children.push(
        e(
          'div',
          { key: 'head' },
          e('h3', { className: 'sae-title' }, '沙箱自动升级'),
          e(
            'div',
            { className: 'sae-hint' },
            '工具调用被沙箱挡住时，自动在同一轮内以更宽模式重试，并弹出一次授权确认 —— 模型不会再为此多花一轮。',
          ),
        ),
      )

      if (status !== 'ready') {
        children.push(e('div', { key: 'status', className: 'sae-muted' }, `设置状态：${String(status)}`))
      }
      if (!writable) {
        children.push(
          e('div', { key: 'ro', className: 'sae-banner' }, '当前设置文档不可写（非 loopback 页面或没有设置存储），下面的开关不会保存。'),
        )
      }

      children.push(
        e(
          'div',
          { key: 'master', className: 'sae-group' },
          e(CheckRow, {
            label: '启用自动升级',
            checked: value.enabled !== false,
            disabled: !writable,
            onChange: (on) => set('enabled', on),
          }),
        ),
      )

      children.push(
        e(
          'fieldset',
          { key: 'triggers', className: 'sae-group' },
          e('legend', { className: 'sae-legend' }, '什么情况下自动升级'),
          e(CheckRow, {
            label: '沙箱文件访问拒绝',
            hint: '结果里出现 [sandbox: file access denied …] 时。pwsh/bash 与 fs 家族的投递形态不同，两种都识别。',
            checked: value.triggerSandboxDenial !== false,
            disabled: !writable,
            onChange: (on) => set('triggerSandboxDenial', on),
          }),
          e(CheckRow, {
            label: 'pwsh 进程初始化被沙箱打断（0xC0000142）',
            hint: 'pwsh 在当前沙箱下会死在 DLL 初始化阶段，输出全空、且没有拒绝标记 —— 只有这条规则能救它。',
            checked: value.triggerPwshInitFailure !== false,
            disabled: !writable,
            onChange: (on) => set('triggerPwshInitFailure', on),
          }),
        ),
      )

      const toolRows = [
        e(
          'label',
          { className: 'sae-row', key: 'all' },
          e('input', {
            type: 'radio',
            name: 'sae-tools-scope',
            checked: allTools,
            disabled: !writable,
            onChange: () => set('tools', []),
          }),
          e('span', null, e('div', null, '对所有工具生效')),
        ),
        e(
          'label',
          { className: 'sae-row', key: 'some' },
          e('input', {
            type: 'radio',
            name: 'sae-tools-scope',
            checked: !allTools,
            disabled: !writable,
            onChange: () => set('tools', ['pwsh']),
          }),
          e('span', null, e('div', null, '仅对选定的工具生效')),
        ),
      ]

      toolRows.push(
        e(
          'div',
          { className: 'sae-tools', key: 'kinds' },
          ...TOOL_KINDS.map((kind) =>
            e(CheckRow, {
              key: kind.id,
              label: kind.label,
              hint: kind.hint,
              checked: tools.includes(kind.id),
              disabled: !writable || allTools,
              onChange: (on) => {
                // 取消到空 = 退回「对所有工具生效」（宿主里 tools:[] 就是这个含义）。
                // 不要塞哨兵值：非空名单里没有任何工具命中时，插件会静默失效。
                const next = on
                  ? TOOL_KINDS.map((k) => k.id).filter((id) => id === kind.id || tools.includes(id))
                  : tools.filter((id) => id !== kind.id)
                set('tools', next)
              },
            }),
          ),
        ),
      )

      children.push(e('fieldset', { key: 'tools', className: 'sae-group' }, e('legend', { className: 'sae-legend' }, '适用哪些工具'), ...toolRows))

      children.push(
        e(
          'div',
          { key: 'target', className: 'sae-group' },
          e(
            'label',
            { className: 'sae-legend' },
            '升级到哪个模式',
            e(
              'div',
              { style: { marginTop: '8px' } },
              e(
                'select',
                {
                  className: 'sae-select',
                  value: typeof value.targetMode === 'string' ? value.targetMode : 'danger-full-access',
                  disabled: !writable,
                  onChange: (event) => set('targetMode', event.target.value),
                },
                e('option', { value: 'danger-full-access' }, 'danger-full-access（不受限，一定能救回 pwsh）'),
                e('option', { value: 'workspace-write' }, 'workspace-write（较保守，只放宽到工作区+临时目录）'),
              ),
            ),
          ),
          e('div', { className: 'sae-hint' }, '必须是比当前模式严格更宽的模式，否则宿主会拒绝这次升级。'),
        ),
      )

      children.push(
        e(
          'div',
          { key: 'note', className: 'sae-hint' },
          '改动立即写入设置文档并生效，不需要重启。授权本身仍是一次性的：每次触发都要点一次「允许」。',
        ),
      )

      return e('div', { className: 'sae-page' }, ...children)
    }

    // ---------------------------------------------------------------- 注册

    /**
     * @param {object} ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      ctx.inject(['settingsScope'], (raw) => {
        const binder = raw.settingsScope
        if (binder === undefined || binder === null) return
        scope = binder.bind({ namespace: NS })
        // scope 的 disposer 归调用方 fiber 所有；这里只负责把订阅者在卸载时摘掉。
        raw.effect(() => () => {
          if (scopeDisposer !== null) {
            try {
              scopeDisposer()
            } catch {
              /* 释放失败忽略 */
            }
            scopeDisposer = null
          }
          scope = null
        }, `${NS}: settings scope`)
      })

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: NS,
            order: 90,
            label: '沙箱自动升级',
          },
          Section,
        ),
      )
    }

    module.exports = {
      name: NS,
      inject: ['slots'],
      apply,
    }
    return module.exports
  },
})
