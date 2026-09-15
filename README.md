# DSH-sandbox-auto-escalate

> DSH 插件 · 沙箱挡住工具调用时，自动在**同一轮内**以更宽模式重试，并弹出一次授权确认 —— 模型不必为「失败一次再重试」多花一轮。

**English** — A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. When the sandbox blocks a tool call, it re-dispatches that *same* call with wider permissions inside the same turn, so the existing approval UI asks the user exactly once instead of costing the model an extra round-trip. It ships a web settings page for choosing which tool kinds and failure modes escalate.

---

## 它解决什么

DSH 原生行为是「**失败 → 由模型重试**」：

```
模型调用工具  →  沙箱拒绝
             →  工具结果里只有提示：
                [sandbox: file access denied under workspace-write mode]
                [sandbox: escalation available — retry this exact operation once
                 with sandbox_permissions ... + justification]
             →  模型必须再发一次带 sandbox_permissions 的调用
             →  这时候才弹审批窗
```

中间那次失败 + 重试要多烧一轮 token，而被挡住的往往只是沙箱边界本身。

装上本插件后变成「**同轮自动升级**」：

```
模型调用工具  →  沙箱拒绝
             →  插件立刻以更宽模式重新派发同一次调用
             →  ctx.approval.request(...)
             →  既有 dsh-client-ui-approval 弹出确认面板
                 点「允许」 → 以更宽模式真正执行，模型只看到成功结果
                 点「拒绝」 → 模型看到明确的拒绝文案并停止
```

**模型侧无感**：没有额外工具调用，没有额外失败。

## 两条触发规则

### 1. `sandboxDenial` —— 结果里出现沙箱拒绝标记

两族工具的**拒绝投递形态不同**，必须都扫：

| 工具族 | 投递方式 |
|---|---|
| `pwsh` / `bash` | 标记渲染进**成功结果**的 notice 文本 |
| `fs` 家族（`read`/`write`/`edit`/…） | 直接抛出，被注册表包成 **`isError: true`**，内容形如 `Error: [sandbox: file access denied ...]` |

> 早期版本只看成功结果，把整个 fs 家族的拒绝全漏掉、插件等于完全不工作。离线自测当时 28 项断言全绿也没发现 —— 是端到端对照测试把它逼出来的。

### 2. `pwshInitFailure` —— `pwsh` 死在进程初始化

在 Windows 的 `workspace-write` 沙箱下，`pwsh` **每次调用都会死**：

```
(no output)
[exit code: 3221225794]        # 0xC0000142 STATUS_DLL_INIT_FAILED
```

关键：这种失败**不产生拒绝标记**，DSH 把它归类为普通命令错误，**原生升级提示根本不会出现**。所以「把 pwsh 加进适用范围名单」是没用的 —— 必须先有一条能识别它的新规则。识别方式（两种形态都认）：

- 结构化 `value.exitCode === 3221225794`
- 渲染文本里的 `[exit code: 3221225794]`

升级到 `danger-full-access` 后 pwsh 恢复正常。

## 实测验证记录

两条规则都已在真机端到端跑通：

| 规则 | 触发方式 | 结果 | 日志证据 |
|---|---|---|---|
| `pwshInitFailure` | `pwsh` 执行 `Get-Date` | ✅ 输出 `2026-09-15 14:36:01` | `escalating "pwsh" (pwshInitFailure) to danger-full-access` |
| `sandboxDenial` | `write` 到会话工作区之外 | ✅ 文件创建成功 | `escalating "write" (sandboxDenial) to danger-full-access` |

关键前提也核对过：会话策略确认为 `workspace-write`（**没变过**），而沙箱仍在强制执行（`pwsh` 依旧死于 `0xC0000142` —— 沙箱若失效它反而会活过来）。也就是说，同一个被拒的操作从「失败」变成「成功」，唯一的新变量就是本插件。

## 安装

这是一个 **profile 本地插件**：不需要发布到 npm、不需要 `pnpm install`、不需要进 `dsh.profile.bundles`。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
# 卸载
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

脚本做三件事：

1. 把 `index.js` + `client.js` + `package.json` 复制到 `<profile>\plugins\sandbox-auto-escalate\`
2. 在 `<profile>\cordis.patch.yml` 幂等注入 insert 行
3. 改前自动备份为 `.bak`

默认 `-ProfileDir` 是 `%USERPROFILE%\.dsh\profiles\desktop`，其它 profile 用参数覆盖。

**顺序很重要**：务必**先落文件、再写 patch 行**。反过来会出现「patch 引用了不存在的文件」的中间态，桌面端的 profile 一致性检查会立刻报错并可能把你踢进安全模式。脚本已经是这个顺序。

**新增 insert 行需要重启 DSH Desktop** —— 实测 `patchReload: live` 没能热应用新增条目。

### 自测（不碰 DSH）

```powershell
# DSH Desktop 自带 node，不要求系统安装 node。
# 路径形如：<DSH 安装目录>\resources\app\node_modules\node\bin\node.exe
# 找不到的话，从 DSH 的启动日志里搜 harness-node 的 execPath。
$node = "<DSH 安装目录>\resources\app\node_modules\node\bin\node.exe"
& $node .\selftest.mjs
```

`selftest.mjs` 精确复刻 cordis 的 waterfall 语义，在假 ctx 上驱动插件，覆盖触发规则、形态识别、开关、白名单、设置覆盖、冻结参数、循环防护等。

## 配置

扁平结构（**刻意压平**：设置界面的 `settingsScope.set(field, value)` 只能写顶层字段，嵌套的 `triggers: {...}` 界面写不进去）：

```yaml
- insert:
    - id: sandbox-auto-escalate
      name: './plugins/sandbox-auto-escalate/index.js'
      config:
        enabled: true
        targetMode: danger-full-access     # 或 workspace-write
        tools: []                          # 空 = 对所有工具生效
        triggerSandboxDenial: true
        triggerPwshInitFailure: true
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关，`false` = 完全退回原生行为 |
| `targetMode` | `danger-full-access` | 升级目标，必须比当前模式严格更宽 |
| `tools` | `[]` | 允许自动升级的工具种类；**空 = 不限制** |
| `triggerSandboxDenial` | `true` | 沙箱拒绝标记 |
| `triggerPwshInitFailure` | `true` | pwsh 进程初始化失败 |
| `initFailureExitCodes` | `[3221225794]` | 视为「初始化失败」的退出码（高级项） |
| `fallbackMode` | `workspace-write` | 读不出沙箱模式时的兜底（高级项） |

组合配置作为 **base 层**；`@deepseek-ai/dsh-settings` 存在时同名 namespace 注册为用户层，设置页面的改动覆盖它并持久化到 `<DSH_HOME>/settings.yaml`。

## 设置界面

设置 → **「沙箱自动升级」**（`settings.section` 一级导航页）：

- 启用自动升级（总开关）
- 什么情况下自动升级（两条规则开关）
- 适用哪些工具（「对所有工具生效」↔「仅对选定的工具生效」+ 五种工具种类复选框）
- 升级到哪个模式

改动**立即写入设置文档并生效**，不需要重启。授权本身仍是一次性的：每次触发都要点一次「允许」。

## 实现要点

| 项 | 说明 |
|---|---|
| 挂载点 | `tools/execute` waterfall（`@deepseek-ai/dsh-tools` 的 `dispatchScheduledExecution`） |
| 为什么能同轮重发 | cordis 的 `waterfall` 里 `next` 是**共享的有状态闭包**（内部 `cbs.shift()`）；链走空后再调 `next()` 直接命中最内层 body，也就是重新派发 |
| 升级参数 | 注入 `sandbox_permissions` + `justification`，复用工具自己的 `approveEscalation` → `ctx.approval.request`，不自绘 UI |
| 循环防护 | 每个 `exec` 最多自动升级一次（`WeakSet`）；模型已自行升级时完全不插手 |
| 语义保底 | 审批通道不可用 / schema 不接受升级参数时，**原样返回最初的拒绝结果** |
| 依赖 | 宿主半**加载零依赖**；schemastery 走 `await import(...)` 按需解析 |

三个必须知道的实现约束：

1. **`exec.arguments` 是深冻结的**（`createExecution` 里 `deepFreeze`），只能**整体替换**成新对象，不能改属性。
2. **重试会跳过注册在外层的 `tools/execute` 包装器**（checkpoint / timeout policy）—— 它们只在第一次走链时被消费。副作用：重试那次不受 `tool-call-timeout-policy` 包装，但仍受工具自身 `timeoutMs` 约束。
3. **不要在模块顶层 `import` schemastery**。那样会让 `index.js` 在 profile 之外（例如在工作区里直接跑自测）加载即失败，把一个零依赖插件绑上硬依赖。

## 已知边界

- **插件不解决 `pwsh` 的 `0xC0000142` 本身** —— 它绕过它（升级到不受限模式）。根因在 DSH 的 Windows ACL 沙箱后端（受限令牌杀子进程），要真修得改那边。
- **每次触发都要点一次授权**。DSH 的审批词汇只有 `allowed-once`，没有 `allow-always` / 规则记忆，插件不越权发明。
- **行为变化**：工作区外操作不再「直接失败」，而是**弹窗问你**。不想要就关掉总开关。
- 重试会**重新执行**原操作。被拒绝的操作通常什么都没做，但若某操作部分成功后才被拒，重试可能重复副作用；授权窗口会显示具体命令供你判断。

## 风险（客户端半）

`package.json` 里的 `dsh.client` 与 `exports["./client"]` **必须同时存在**。只声明 `dsh.client` 而缺 bundle 文件，宿主会抛 `ClientPackageCompositionError`，**整个 web 客户端插件表不可用**。

只想去掉设置页、保留宿主功能，就把 `dsh` 段和 `"./client"` 导出**一起**删掉。

## 结构

```
index.js          宿主半：触发规则 + 配置 + 设置 namespace 注册
client.js         浏览器半：设置页（lazy-CJS factory bundle，纯 JS 无 JSX）
package.json      同时声明 exports["./client"] 与 dsh.client
install.ps1       安装 / 卸载（幂等）
selftest.mjs      离线自测：精确复刻 cordis waterfall 语义
LICENSE           MIT
.gitignore        依赖 / 运行时产物
.gitattributes    仓库内统一 LF，避免跨平台 diff 噪音
```

## 维护备注：Windows PowerShell 5.1 的三个坑

写 `install.ps1` 时实测踩到的，都已规避。想在别的机器上复刻这套脚本，先看这里。

1. **无 BOM 的 `.ps1` 会按系统 ANSI 码页读取**（本机是 GBK）。脚本里写中文会被解析成乱码并**直接语法报错**，实测报
   `Missing ')' in function parameter list` 或 `The string is missing the terminator`。
   所以脚本刻意保持**纯 ASCII**；中文只放在 README 与 JS 文件里 —— 它们始终按 UTF-8 读。

2. **`$PSScriptRoot` 在 `param()` 默认值里是空的。** 这是 PowerShell 5.1 的怪癖（PS Core 才修），
   `[string]$Dir = (Join-Path $PSScriptRoot 'x')` 会抛
   `Cannot bind argument to parameter 'Path' because it is an empty string`。
   必须在**函数体**里用 `Split-Path -Parent $MyInvocation.MyCommand.Path` 解析。

3. **写回 YAML 不能用 `Set-Content -Encoding UTF8`**：PS 5.1 的 `UTF8` 会带 BOM，而 profile 自带的
   `cordis.patch.yml` 无 BOM。`install.ps1` 统一走 `[System.IO.File]::WriteAllText` + `UTF8Encoding($false)`。

## 许可

MIT
