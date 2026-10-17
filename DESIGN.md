# DSH 鲸鱼宠物 · 设计文档

| 项 | 值 |
|---|---|
| 插件名 | `dsh-whale-pet`（Loader id：`pet-whale`） |
| 版本 | 1.0.0 |
| 对应实现 | `plugin/index.js`（Host 半侧，750 行）· `plugin/client.js`（Browser 半侧，2070 行） |
| 目标平台 | DeepSeek Harness Web GUI（Electron 渲染进程 + 宿主 Node 进程） |
| 验证基线 | DSH `0.2.0-rc.2` |
| 状态 | 已实现、已打包分发；5 项自动化测试 + 1 项像素级布局测试通过 |
| 相关文档 | [`README.md`](README.md)（安装与验证记录）· [`dist/INSTALL.md`](dist/INSTALL.md)（接收方说明） |

---

## 1. 概述

### 1.1 一句话定义

一只常驻 Harness Web UI 右下角的 DeepSeek 蓝鲸，用**动效**表达 Harness 此刻是否在工作，用**声音**宣告一次工作结束，点击后展开一个**记录并计价每一次交互**的面板。

### 1.2 需求 → 能力映射

| # | 原始需求 | 设计上的实现 | 落点 |
|---|---|---|---|
| 1 | 有动效的宠物 | 官方剪影 + CSS 关键帧状态机：空闲时缓慢浮动与摆尾；工作时加速游动、气泡上升、光晕脉动、虚线环环绕 | `Whale` + `STYLES` |
| 2 | 显示工作状态、完成时有音效 | Idle / Working / Error 三态指示灯；完成时播放上行三音（失败为下行小三度变体），工作**开始**时轻点一声 | `resolveBusy` + `decideCue` + `audio` |
| 3 | 点击展开第二页 | 点击鲸鱼展开 390px 面板：当前状态 + 每个已完成交互一行（时间、时长、提示词、回复摘要、工具/回合/步数、会话标签、错误） | `Panel` + `RecordRow` |

### 1.3 非目标（明确不做）

- **不修改 Harness 任何源码**，只使用公开扩展点（Cordis 插件、slot、webServer 路由）。
- **不回溯会话日志**做统计重算；Host 半侧只做增量折叠，会话日志始终是唯一事实来源。
- **不发起真实模型请求**，不读 API Key，不上报任何遥测。
- **不引入依赖、不引入构建步骤**（理由见 §2.2，这是硬约束而非偏好）。
- 不做多语言以外的本地化（面板文案为「中文 · English」并列单语态）。

---

## 2. 设计约束

架构几乎完全由下面五条约束推导出来，因此先列约束、再讲结构。

### 2.1 双进程模型

Harness Web 由两部分组成，能力互补且互不重叠：

| | Host 半侧 | Browser 半侧 |
|---|---|---|
| 运行于 | 宿主 Node 进程（Electron 主进程） | 渲染进程 |
| 能看到 | 全部会话的生命周期事件、token 用量、账户余额 | 当前页面的实时会话状态、DOM、Web Audio、localStorage |
| 看不到 | DOM、音频 | 提示词与回复文本、历史交互的细节 |
| 生效方式 | **必须重启 DSH** | **刷新页面即可** |

> **关键工程事实**：Host 半侧是 ES module，Loader 每个进程世代只 import 一次 specifier。反复开关 bundle 或重装**不会**重新求值 `index.js`；而 Browser 半侧的 bundle 是每次按需从磁盘重建的。因此本插件的开发循环是：改 `index.js` → 重启 DSH；改 `client.js` → 刷新页面。设计上据此把「易变的表现逻辑」全部放在 Browser 半侧。

### 2.2 零依赖、零构建

插件以 `link:` 形式装进 profile，从那里**只有 Node 内建模块能解析**。`import '@deepseek-ai/schemastery'` 会直接在 Loader 层让这一行加载失败。由此推出：

- Host 半侧**只 import `node:fs`**，不声明任何 `Config`（不引入 schema 库），可调参数写成模块常量。
- Browser 半侧**不 import 任何 Harness Client 包**，React / ReactDOM 从浏览器模块表 `require` 取；鲸鱼路径直接内联，不去 `require` `@deepseek-ai/dsh-client-ui-primitives`。
- 传输层用**纯 JSON over GET**，因此不需要 Typert 生成的编解码器，也就不需要构建步骤。

### 2.3 Cordis 的作用域过滤（本设计最核心的一条）

DSH 把 agent / session 作用域的事件通过 agent 的 scope carrier 派发，Cordis 会**丢弃** carrier 的 `Context.filter` 不接受的监听器：

```js
// cordis/src/events.ts:171-174
const filter = thisArg?.[Context.filter]
return (this._hooks[name] || [])
  .filter(hook => hook.global || !filter || filter.call(thisArg, hook.ctx))
```

根挂载的插件不在这条作用域里，所以裸的 `ctx.on(...)` **永远不会触发**。`EventOptions.global`（文档语：「receive the event regardless of context filter checks」）是官方逃生口，也是「一个根插件观察全部会话」的前提。

**本插件所有订阅一律带 `{ global: true }`**，并由 `tools/host-test.mjs` 提供**反向证明**：同一份代码去掉该标志后监听器被过滤掉、计数器全零。

> 这条约束同时否决了一批事件：`agent/status`、`agent/error` 同样受作用域影响且不到达根插件，因此实际订阅的是根发射的 `api-session/*` 家族。

### 2.4 面板必须永远有东西可看

浏览器无法可靠回答「Harness 究竟在干什么」——一个被过滤掉的监听器、一个陈旧的 Host 世代，都会让面板空白。因此：

- 声音与状态**以 Browser 自己的观察为主**，Host 数据只做增强；
- 账本有**两个来源**，Host 不可达时自动降级为浏览器本地派生账本（§5.6）。

### 2.5 可移植分发

包内不声明依赖、不需构建、不带 `node_modules`，因此既可以 `link:` 目录，也可以打成 tarball 交给另一台机器（§14）。

---

## 3. 总体架构

```
┌─────────────────────────── 宿主进程 (Node) ───────────────────────────┐
│  cordis.patch.yml  ──insert──▶  plugin/index.js  (name: pet-whale)     │
│                                                                        │
│   ctx.on('session/event',  …, { global: true })  ┐                      │
│   ctx.on('api-session/status', …, { global: true })├─▶ 折叠引擎          │
│   ctx.on('api-session/error',  …, { global: true })│   records / open   │
│   ctx.on('session/disposed',   …, { global: true })┘   running/labels  │
│                                                        sessionTotals   │
│   ctx.inject(['webServer']) ─▶ GET /pet-whale/state   ──▶ snapshot v3  │
│                              ─▶ GET /pet-whale/assets/* ─▶ tone.wav    │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │ 同源相对 URL · 纯 JSON · 1.5s 轮询
┌────────────────────────────────┴───────────────────────────────────────┐
│  渲染进程 (Browser)                                                     │
│  window.__ModuleLoader__.load({ id: 'dsh-whale-pet', … })              │
│                                                                        │
│   ctx.slots.register('shell.overlay', { id: 'pet-whale', order: 40 })  │
│            │                                                            │
│            ▼                                                            │
│   WhalePet ──┬─ useSessionStatus() / useSessions()  ← 实时主观察者       │
│              ├─ fetch('/pet-whale/state')           ← 细节增强者         │
│              ├─ decideCue(...)  ─▶ Web Audio 提示音 / mood 动效          │
│              └─ Whale + Panel(RecordRow, AccountSection)                │
│                 localStorage: 本地账本 / 音色 / 货币 / 模型 / 静音       │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.1 职责划分

| 关注点 | 归属 | 理由 |
|---|---|---|
| 工作状态（是否在跑） | **Browser 为主**，Host 兜底 | 浏览器视图实时且自校正；Host 快照可能陈旧 |
| 完成音效与 mood 动效 | **Browser** | 必须不依赖 Host 健康度；音频只能在渲染进程播放 |
| 提示词 / 回复摘要 / 工具计数 / 错误 | **Host** | 只有宿主能看到完整事件载荷 |
| token 用量与花费 | **双源**（Host 优先，浏览器 projection 兜底） | 两边都能拿到，互为保险 |
| 账户余额 | **Host** | 需要带版本/locale/时区的 Platform 请求 |
| 布局、主题、无障碍 | **Browser** | 纯表现层 |

### 3.2 一次工作回合的数据流

```
用户输入 ──▶ session/event(user/message)   ─┐
                                            ├─▶ episodeOf(id) 开一个「回合」：记下 prompt
           session/event(turn/start)       ─┤    turns += 1
           session/event(tool/call)        ─┤    tools += 1
           session/event(assistant/message)─┤    reply = 文本; steps += 1; usage → episode.tokens
                                            │
           api-session/status(id, true)    ─┘    running.set(id, true)，必要时补开回合
                        ⋮
           api-session/status(id, false) ──▶ settle(id)：episode.tokens 并入 sessionTotals
                                            └─▶ records.unshift({ prompt, reply, tools, turns,
                                                                  steps, tokens, error, … })

浏览器每 1.5s ◀── snapshot(): { busy, active, records, feed, sessions, balance, … }
   ├─ records.length 变化 ⇒ 新行出现 ⇒ Panel 显示；若该 episode 尚未响过 ⇒ 响铃
   └─ sessions 里的 buckets ⇒ 即时计价（含正在进行的回合，token 随长回合爬升）
```

---

## 4. Host 半侧设计

### 4.1 生命周期与注册

`apply(ctx)` 是唯一的入口，所有订阅都在其中登记——**卸载该行即移除全部监听器**，不留悬挂回调。HTTP 路由在 `ctx.inject(['webServer'], scope => …)` 内注册，因此组合中没有 webServer 时插件退化为「纯折叠、无出口」，而不是加载失败。

**身份与装载**：`package.json` 声明 `dsh.bundle.patch` 与 `dsh.client`，`cordis.patch.yml` 把 Host 行插进 profile 的根条目列表。

> `cordis.patch.yml` **故意不写顶层 `id`**。patch 的 `insert` 带 `id` 时会去找同名的**分组**条目，`pet-whale` 不是分组，Loader 会警告 "entry not found" 并跳过插入——结果是 bundle 显示已启用却没有任何插件行。不带 `id` 时插入根列表，这正是所需语义。

### 4.2 事件契约

| 事件 | 载荷 | 本插件如何使用 | 为什么是它 |
|---|---|---|---|
| `session/event` | `(session, { time, type, data })` | 按 `type` 分派：`user/message` 开回合并记 prompt；`assistant/message` 记 reply / steps / tools / usage；`turn/start` 计回合；`tool/call` 计工具；`session/title` 缓存标签 | 唯一同时携带 prompt、回复与 usage 的根可观察源 |
| `api-session/status` | `(sessionId, isRunning)` | 维护 `running` 表；`true→false` 的**边沿**触发 `settle` | 根发射，是「回合开始/结束」的权威信号 |
| `api-session/error` | `(sessionId, message)` | 把错误挂到当前回合；同时记入 feed | 错误只在 idle 转变时才落盘，这里先在途记录 |
| `session/disposed` | `(session)` | 清 `running` / `labels` / `open`；**保留 `sessionTotals`** | 已花掉的 token 是真花掉的，账目应比注册表条目活得久 |

`user/message` 有一个必须过滤的细节：`data.source.kind !== 'user'` 的消息（工具回灌的合成用户消息）**不算新回合**，否则每个工具回合都会开一条假记录。

### 4.3 数据模型

```js
// 在途回合（每会话至多一个）
Episode = {
  sessionId, startedAt, prompt, reply,
  tools, turns, steps, error, tokens: Buckets,
}

// 已结算记录（环形窗口，最多 80 条，最新在前）
Record = {
  id, sessionId, label, startedAt, endedAt, durationMs,
  prompt, reply, tools, turns, steps, tokens, error?,
}

// token 桶（与提供方上报字段一一对应）
Buckets = {
  inputTokens, outputTokens, cacheReadTokens,
  cacheWriteTokens, reasoningTokens, requests,
}

// 会话级状态
running:  Map<sessionId, boolean>        // 最近一次观察到的运行标志
open:     Map<sessionId, Episode>        // 在途回合
labels:   Map<sessionId, string>         // 来自 session/title 的耐久标题
sessionTotals: Map<sessionId, { startedAt, lastEventAt, tokens: Buckets }>
feed:     Array<{ kind, text, sessionId, time }>   // 上限 60，对外只发前 20
```

**三个刻意的设计决定：**

1. **`label` 不复制进 Episode。** 耐久标题可能在本回合中途才到达（`session/title`）；如果在创建回合时拷贝，占位符就被冻结了。两个读取点都通过 `labelFor()` 现场解析，所以迟到的标题仍会落到已完成的记录上。
2. **窗口裁剪时 `open.clear()`。** 记录数组一旦超限就同时清空在途回合表，避免「已经记不清起点、却还在累积」的半截回合继续污染 sessionTotals。
3. **每个会话键都必须过 `isSessionKey` 闸门。** 这些 Map 的键全部来自事件载荷，而非字符串键会一路穿过 Map、直到 `snapshot()` 里才炸——那会把整个端点变成一个没有任何线索的裸 400。因此闸门放在入口，不放在读取处。

### 4.4 快照协议（v3）

`GET /pet-whale/state` → `200 application/json`，`cache-control: no-store`；`HEAD` 同样支持，`GET`/`HEAD` 以外返回 `405`。

```jsonc
{
  "ok": true,
  "version": 3,
  "now": 1730000000000,
  "busy": true,                    // 派生：active.length > 0
  "active": [                      // 正在工作的会话
    { "sessionId": "...", "label": "workspace", "startedAt": 0, "prompt": "...", "tools": 3 }
  ],
  "records": [ /* Record[]，最多 80，最新在前 */ ],
  "feed":    [ /* 最近 20 条一行动态 */ ],
  "sessions": [{                   // 会话级计费汇总，settled + live
    "sessionId": "...", "label": "...",
    "startedAt": 0, "lastEventAt": 0,
    "elapsedMs": 0, "idleMs": 0,
    "running": false,
    "tokens": { /* Buckets */ },
    "totalTokens": 12345
  }],
  "grandTotalTokens": 12345,
  "balance": {                     // 可选；未登录/未取到则整体缺省
    "wallets": [{ "currency": "CNY", "balance": "12.34" }],
    "bonusWallets": [],
    "at": 1730000000000, "error": undefined
  }
}
```

失败时返回 `200` 加 `{ ok: false, error, stack }`——**不用 4xx/5xx**。理由：webServer 会把 handler 抛出的异常变成一个不含原因的裸 400，把失败写进可读载荷才能让快照 bug 从浏览器侧直接诊断。

### 4.5 记账：settled 与 live 不相交

这是本插件被测试抓到过真实 bug 的地方，因此作为不变量写明：

| 作用域 | 存放内容 | 生命周期 |
|---|---|---|
| 在途回合 `episode.tokens` | 尚未结算的用量 | 到回合结算为止 |
| 会话总计 `sessionTotals[].tokens` | **仅**已结算回合 | 整个会话（含 disposed 之后） |

快照对外提供 `settled + live` 的和。若把在途回合也折进会话总计，同一次用量会被计两次——`tools/host-test.mjs` 正是为此加了断言。

```js
tokensTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
```

`reasoningTokens` **不加**：它是 `outputTokens` 的子集，只作为拆分字段展示。任何字段缺失、非有限数或 ≤ 0 都读作 0 并**不计入请求数以外的任何桶**；`requests` 每次结算 `+1`。

### 4.6 余额读取：缓存 + 绝不抛

```js
ctx.get('deepseekAccount').getBalance({ version, locale, timezoneOffsetSeconds })
// → { status: 'ready', value: Wallet[], bonusWallets: Wallet[] } | { status: 'failed' } | null（未登录）
```

三条使其能安全地待在 1.5s 轮询后面的设计：

- **缓存**：`getBalance` 是一次真实的 Platform 请求，读数复用 60s；请求 handler 只在返回途中**踢一次后台刷新**，从不 `await` 网络。`pending` 标志合并并发刷新。
- **绝不抛**：未登录（`null`）、`failed` 结果、被拒绝的 promise、畸形钱包、组合中根本没有该服务——全部降级为「不显示余额行」。测试断言：额外 5 次轮询产生 **0** 次额外调用。
- **货币符号取自钱包自身**，而非所选费率表——Platform 按每个钱包自己的币种上报。

### 4.7 静态资源路由

`GET /pet-whale/assets/<name>`：

- **白名单**：只接受 `^[A-Za-z0-9._-]+$` 且不含 `..`，扩展名必须在媒体类型表中（`wav/mp3/ogg/oga/m4a/aac/flac/webm`）。非法一律 404，因此该路由**无法越出包目录**。
- **类型必须准确**：未知扩展名宁可拒绝，也不猜 `Content-Type`——错误的类型会让 `decodeAudioData` 在客户端失败且报不出有效错误。
- **只读一次、内存常驻**：静态文件不带请求数据，逐请求 `readFileSync` 会把同步 IO 放上事件循环；而字节在下次重启前不会变。响应带 `cache-control: public, max-age=86400`。

### 4.8 防御式编程约定

| 风险 | 对策 |
|---|---|
| `ctx.agents` 在未声明 `inject` 时**抛异常**（不是 `undefined`） | 一律走 `service(ctx, name)` 包装的 `ctx.get(name)`（文档化的可选形式，返回 `undefined`） |
| 一个畸形会话行炸掉整个端点 | `from` 循环内逐行 `try/catch`，坏行**只牺牲自己这一行**并 `warn` 记名 |
| 日志本身失败 | `warn()` 自己包一层 try/catch |
| 服务形状不属于本插件契约 | 每跳访问都做存在性 + 类型检查（`typeof agents?.get === 'function'`） |
| 插件在回合中途被加载 | `ctx.agents.list()` **一次性播种** `running`，因为 `api-session/status` 只是变迁流 |
| 时间戳单位不一致 | `epochMs()` 归一化（§9） |

---

## 5. Browser 半侧设计

### 5.1 挂载点：`shell.overlay`

`dsh-client-ui-layout` 声明的**框架级浮层列表槽**：

- `kind: 'list'`、`scope: 'root'`，传入根 standard kit → 组件**无需任何 DOM 工作**即可拿到 `useSessions` / `useSessionStatus` 选择器 hook。
- 槽层本身是 click-through 的，每个子节点自行恢复指针事件 → 鲸鱼不会挡住 Harness 自身的 UI。
- 注册参数：`{ name: 'shell.overlay', id: 'pet-whale', order: 40, label: 'Whale pet' }`。
- 依赖声明为 `inject: ['slots']`（硬依赖）；`ui-session` 缺失时不是抛错而是**降级**——两个 hook 的存在都在调用前检查，缺失时只依赖 Host 半侧。

```js
ctx.effect(
  () => ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'pet-whale', order: 40, label: 'Whale pet' },
                             WhalePet)),
  'pet-whale: shell.overlay registration',
);
```

### 5.2 组件树

```
WhalePet                       ← 全部状态与副作用集中在此（2070 行中的 ~530 行）
├── Stylesheet                 ← 返回 <style data-plugin>，卸载即移除样式
├── <button.dsh-pet-whale-lyr> ← 96×88 命中区，data-busy / data-mood / aria-expanded
│   ├── Whale {busy, mood}     ← 单条官方剪影 path + 光晕 + 描边 + 水柱 + 气泡 + 环绕虚线圈
│   └── <span.badge>           ← 记录计数（99+ 封顶）
└── Panel (open 时)            ← role="dialog"，390px
    ├── 头部：状态灯 + 标题 + 关闭
    ├── 状态区：会话标签 / prompt / 计数
    ├── AccountSection         ← token 桶、计价、峰谷、余额、货币与模型选择器
    ├── 记录列表 (RecordRow×n)  ← 时间 / 时长 / prompt / reply 摘要 / 标签组
    └── 底部：静音、音色选择、试听、清空
```

### 5.3 状态模型

| 类别 | 状态 | 说明 |
|---|---|---|
| 远程 | `hostState` | `{ ok, busy, active, records, feed, sessions, balance, now }`，`null` 值全部有默认 |
| 派生 | `view` | `{ busy, disagrees, status, active }`，由 `resolveBusy` 得出 |
| 本地 | `localRecords` | 本地账本，随 `localStorage` 持久化 |
| UI | `open / mood / soundOn / tone / audioReady` | |
| 计价 | `rateModel / rateCurrency` | `localStorage` 持久化 |
| 引用 | `cueRef / lastBusyRef / localOpenRef / soundRef / moodTimerRef / activityRef` | 不参与渲染的状态 |

### 5.4 「Harness 在忙吗」的判定规则

这条规则在历史上错了两次、方向相反，因此它是一个**带测试的纯函数**而不是内联表达式：

```js
resolveBusy({ clientKnows, clientBusy, hostBusy }) → { busy, disagrees }
// clientKnows ? clientBusy : hostBusy
```

| 尝试过的方案 | 后果 |
|---|---|
| 优先信 Host | 陈旧的 Host 报 `ok: true` 但账本为空，**藏起了浏览器明明看得见的工作** |
| 无条件并集 | 一个卡住的 Host 声明会在回合结束后**把宠物永久冻在「工作中」** |
| **客户端视图已加载时以客户端为准，否则信 Host** | 两个方向都正确：客户端视图实时自校正；只在客户端一无所知时才不得不用 Host |

`clientKnows = statusSnapshot instanceof Map`：ui-session 根源尚未 live 前 hook 解析为 `undefined`，那一刻客户端确实什么都不知道——这正是「可以纠正 Host，但绝不致盲」的分界。

上层据此派生 `status`：`busy ? 'running' : （最近 8s 内有错误记录 ? 'error' : 'idle'）`。Host 的 `active` 明细**仅在 `busy` 为真时**使用，这样一条陈旧的 Host 条目不可能比它上方的状态活得更久。

### 5.5 账本选择：Host 全量替换，本地仅作离线兜底

```js
selectRecords(hostOk, hostRecords, localRecords)
// hostOk && hostRecords.length > 0  → 用 Host 记录（origin: 'host'）
// 否则                              → 用本地记录（origin: 'local'，按 endedAt 倒序）
```

Host 记录带 prompt 文本、回复摘要、工具计数与错误，因此**完全替换**本地账本。两者观察的是同一批回合，若并列显示必然出现重复行——本地账本的角色是「离线兜底」，不是「第二数据源」。面板对 `origin: 'local'` 的行打 `local` 标签，让降级状态可见。

### 5.6 本地账本：从运行状态变迁折叠

不依赖 Host 也能产出记录：

1. `useSessions` / `useSessionStatus` 的 snapshot 里挑出 `running === true` 的 sessionId 集合。
2. 用 `runningKey`（排序后以 `\u0000` 连接的字符串）作为依赖——selector snapshot 每次读都是**新数组**，只有这个稳定字符串才代表「运行集合真的变了」。
3. 新出现的 id 在 `localOpenRef` 里登记开回合；消失的 id 结算成一条记录并写入 `localStorage`。

> 这个折叠**只在运行集合变化时**执行，不是每次渲染——否则会把同一回合反复结算成多条记录。

### 5.7 Host 轮询

| 参数 | 值 | 说明 |
|---|---|---|
| `POLL_MS` | 1500ms | `setTimeout` 自续，非 `setInterval`，避免请求堆积 |
| `REQUEST_TIMEOUT_MS` | 4000ms | `AbortController` 主动中断 |
| 失败策略 | **保留上一次视图**，但把 `ok` 置 false、`active` 清空 | 防止「冻结的 Host 快照」被继续当真 |
| 卸载 | `stopped` 标志 + `clearTimeout` | 防止卸载后 `setState` |

---

## 6. 交互与视觉设计

### 6.1 动画状态机

由 `data-busy` 与 `data-mood` 两个属性驱动，纯 CSS 关键帧，无 JS 动画循环。

| 状态 | 触发 | 视觉 |
|---|---|---|
| **calm（空闲）** | `busy=false, mood=calm` | 容器 5.2s 浮动；本体 3.4s 上下 7px 摆动并 ±1.2° 侧倾；光晕弱；气泡与环绕环淡出 |
| **running（工作）** | `busy=true` | 浮动周期缩到 2.1s、本体 1.15s（明显更快）；光晕 1.9s 脉动；虚线环 1.6s/圈旋转；三颗气泡 2.9s 循环上升 |
| **done（完成）** | 一次回合结束 | 光晕闪烁 2 次（0.9s）；**喷水柱**从呼吸孔凹口喷出一次（1.5s）；2.6s 后回落 calm |
| **error（失败）** | 回合带错误结束 | 光晕转为 `--dsw-alias-state-error-primary` 并闪 1 次（1.1s） |
| **reduced-motion** | 系统偏好 | `@media (prefers-reduced-motion: reduce)` 下**全部**动画 `animation: none !important`（含面板入场） |

`mood` 由 `applyCue` 统一驱动：`setMood(done|error)` → 2600ms 定时器回落 `calm`；定时器在卸载时清理。

### 6.2 图形设计：只画一条官方路径

鲸鱼本体是**单一的官方 DeepSeek 剪影 path**（`FISH_LOGO_PATH` 的内联副本）。这条约束是踩坑后的产物：

> 早先的版本在剪影之上叠加了自创的「高光多边形」和第二片尾鳍，两者都落在身体内部，渲染出**一块白色斑块盖住鲸鱼**。官方标志本身就是一个完整填充形状。

因此允许的叠加只有两类：

- **在剪影之后**（z 序在下）：一个 `radialGradient` 光晕圆（`cx=11.5, cy=9, r=12.5`）；
- **在剪影之上**：用**同一段 geometry** 以 `#9DB8FF`、宽 0.36 描边、`opacity .55` 勾边，从而同时描出轮廓和标志原有的内部细节——不发明任何形状。

衍生元素的锚点都有依据：水柱锚在呼吸孔凹口顶点 `(12.45, 2.9)`，中心羽状 + 两侧扇形 + 4 颗飞溅水珠；气泡刻意布置在剪影**之外**（`cx≈1.4–2.9`），这样读起来是水而不是鲸鱼身上的斑点；环绕环半径 14.2，同样在剪影之外，用 `stroke-dasharray: 5 44` 做成一段弧。

`viewBox="-2 -3 27.5 25.5"` 为这些外延元素留出画布。容器 96×88，徽章绝对定位在右下。

配色：本体三档线性渐变 `#6D93FF → #4D6BFE → #2B3FD6`（品牌蓝），光晕 `#7BA0FF`。**鲸鱼保持自有配色**——这是被允许的例外（品牌资产），而面板全部走主题令牌。

### 6.3 面板布局

- 尺寸：`width: 390px`、`max-width: min(92vw, 390px)`、`max-height: min(90vh, 860px)`，纵向 flex，`min-height: 0` 让记录区可滚动。
- 分区自上而下：头部（状态灯 + 标题 + 关闭）→ 状态区 → `AccountSection` → 记录列表（滚动区）→ 底部工具条（`flex: none` 的分区不会随滚动消失）。
- 一条记录行：左侧 2px 彩色导轨（出错转红）→ `#序号 · 时刻 · 时长 · [local] 标签` → prompt（缺省时显示「（未采集到提示词 · prompt not captured）」）→ 回复摘要（`-webkit-line-clamp: 2`）→ 标签组 `{会话标签, N tools, N turns, N steps, N glyphs}`。
- 数字一律 `font-variant-numeric: tabular-nums`，避免跳动。
- `glyphs()` 按**码点**计数，中文不会被算成 3 个字符。

### 6.4 主题与无障碍

- 样式只用 `--dsw-alias-*` 令牌，且**每一个都带字面量兜底**（如 `var(--dsw-alias-label-primary,#1b1b1f)`），因此浅色与深色主题下都能正确阅读。
- 所有交互控件都是真实 `<button>`；鲸鱼触发器带 `aria-expanded`、动态 `aria-label`（工作中 / 刚完成 / 空闲）与 `title`；`focus-visible` 有 `2px` 品牌色描边。
- 鲸鱼 SVG 自身 `aria-hidden="true" focusable="false"`（语义由外层按钮承担）。

---

## 7. 声音设计

### 7.1 资产优先，合成为兜底

完成音是**一个文件**：`plugin/assets/tone.wav`，由 Host 在 `/pet-whale/assets/tone.wav` 提供。**替换这一个文件就换了音效**——不改插件、不重新构建。

- **WAV，24kHz 单声道，42 KiB（43168 字节）。** WAV 是唯一无需编解码授权、所有浏览器都能解的容器；降到 24kHz 单声道后仍是很小的 16bit PCM 文件。
- `tools/make-tone-asset.mjs` 从渲染好的音频生成资产，并**校验它刚写出的文件**（峰值、RMS、时长）——静音或削波的文件不可能被发布出去。
- **合成兜底**：资产缺失或解码失败时回落到合成音符，宠物**永不静音**。加载是 fire-and-forget（首次提示音先播合成音，而不是等 fetch 回来再响）。
- **失败音与开始音始终是合成的**，跟随面板中选择的音色；只有完成音走资产。

### 7.2 内置音色

| 键 | 名称 | 音源 | 完成音 | 失败音 | 特征 |
|---|---|---|---|---|---|
| `bright` | 明亮铃音 Bright | **asset** | C-E-G-C 上行四音 | 下行小三度（622→466→349Hz） | 默认，也是随包发布的资产 |
| `soft` | 柔和木琴 Soft | synth / 正弦 | 587 / 880Hz 两音 | 440 → 330Hz | 纯正弦、弱起音、安静 |
| `marimba` | 木质马林巴 Marimba | synth / 方波 | 523 / 784Hz | 392 → 262Hz | 短促干脆 |
| `click` | 轻点提示 Click | synth / 三角波 | 880 / 1175Hz | 349Hz | 最不打扰 |
| `bell` | 长尾钟声 Bell | synth / 三角波 | 523 / 784Hz，长余韵 | 392Hz | 慢起音、长尾 |

每个音色是**数据而非代码**：`{ done, failed, start }` 三组音符列表 + 可选的 voicing（波形 `type`、起音 `attack`、泛音 `octave`、闪烁 `shimmer`、总输出 `master`）。新增音色就是在 `TONES` 里加一项，它会自动出现在选择器里。选择持久化于 `localStorage`（`readTone()` 对损坏值容错）。

`dist/tones/*.wav` 是全部五个音色的离线渲染，便于用耳朵做选择。

### 7.3 音频链与响度预算

```
音符 ─▶ 每音独立 Gain(包络) ─▶ bus ─┬─▶ master(gain=CHIME_MASTER) ─▶ limiter ─▶ destination
                                    └─▶ lowpass(4200Hz) ──────────▶ master
```

- **起音 6ms**（`bell` 35ms），包络按 `setValueAtTime` / 指数衰减写死，避免爆音。
- **两条并联路径**：一条直入 master，一条经 4.2kHz 低通再入 master，使压缩器对「明亮音」和「柔和音」都能正确反应。
- **限幅器**：`threshold -8dB, knee 10, ratio 10, attack 3ms, release 180ms`。阈值定得高是为了**保住钟声的形态**，只压住求和后的峰值——响度上去而音色不被压扁。
- 自动播放策略：`AudioContext` 懒创建，在首次 `pointerdown` / `keydown` 时 `resume`；点击宠物本身也会解锁。`getState()` 是唯一可靠信号。音频完全不可用时置 `audioReady=false`，UI 据此禁用试听。

### 7.4 提示音去重规则 `decideCue`

两个观察者（Browser 自己的运行状态变迁、Host 的记录到达）都灌进同一个纯函数，保证**一个回合最多响一次**：

| 观察 | 结果 |
|---|---|
| 首次见到某会话的客户端 feed | 只建立基线——**不响**（页面加载前已完成的工作不该响） |
| 该会话后续的回合结束 | **响** |
| 首次收到 Host 记录 | 只建立基线 |
| 新的 Host 记录 | **响**，除非客户端已为该回合响过 |
| 已响过的回合，Host 记录显示它**失败**了 | 只升级 mood（`mood-only`） |

- 每个高水位标记**按会话独立**。曾经用单一全局标记是真实 bug：一个会话里较晚的回合会压制另一个会话里较早的回合——两个 subagent 乱序完成，声音就没了。测试固定了这一点。
- 客户端变迁与 Host 记录的起始时间取自相隔数毫秒的两次取值，因此用 **2s 窗口**做同一回合匹配；每会话保留最近 8 个时间戳。
- **主触发器是客户端自己的运行状态变迁**，不是 Host 记录列表。音效不能依赖 Host 健康度：`useSessionStatus` 本来就观察了每个会话，Host 账本为空或陈旧时，这里依然看得见回合结束。
- Host 记录仍是必要的补充：它能把提示音**升级成错误音**，因为客户端无法知道失败。
- 提示音同时是**可见的**：`data-mood` 驱动差异化光晕脉冲（失败转红），所以静音或标签页在后台时，「工作结束」依旧不会错过。

---

## 8. 计价设计

### 8.1 四个可计费桶

| 桶 | 费率 | 说明 |
|---|---|---|
| `inputTokens` | **cache miss**（全价输入） | |
| `cacheWriteTokens` | **cache miss** | DeepSeek 上报它但**按缓存未命中计费**，因此它没有独立费率 |
| `cacheReadTokens` | **cache hit**（远低于输入） | |
| `outputTokens` | 输出 | |
| `reasoningTokens` | — | 是 `outputTokens` 的**子集**，只上报不累加 |

```js
missTokens = inputTokens + cacheWriteTokens
total = missTokens × miss + cacheReadTokens × hit + outputTokens × output
```

### 8.2 费率表（每 1M token，峰 / 谷）

| 模型 | 命中（CNY） | 未命中（CNY） | 输出（CNY） |
|---|---|---|---|
| `deepseek-flash` | ¥0.04 / ¥0.02 | ¥2 / ¥1 | ¥8 / ¥4 |
| `deepseek-v4-pro` | ¥0.30 / ¥0.15 | ¥9 / ¥4.5 | ¥27 / ¥13.5 |

| 模型 | 命中（USD） | 未命中（USD） | 输出（USD） |
|---|---|---|---|
| `deepseek-flash` | $0.006 / $0.003 | $0.30 / $0.15 | $1.20 / $0.60 |
| `deepseek-v4-pro` | $0.044 / $0.022 | $1.32 / $0.66 | $3.96 / $1.98 |

来源：[人民币价目页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) · [USD 价目页](https://api-docs.deepseek.com/quick_start/pricing/)。

**两种货币都内置**，因为国内平台以人民币计费、国际页面以美元报价，而两者**并非彼此的简单换算**。**CNY 为默认**；面板同时提供货币与模型选择器，另有整表 `localStorage` 覆盖项（`RATE_OVERRIDE_KEY`），因为价格会变。测试断言「谷价恰为峰价之半」这一不变量。

### 8.3 高峰窗口

北京时间周一至周五 09:00–12:00 与 14:00–18:00，等价于 **UTC 01:00–04:00 与 06:00–10:00**（北京 = UTC+8，两个页面描述的是同一批窗口）：

```js
PEAK_WINDOWS = [[1, 4], [6, 10]]   // UTC 小时区间，左闭右开，仅工作日
```

**中国法定节假日在已发布的价目表上也是谷价，但那是插件无从得知的移动目标**，因此本插件将其按峰价处理，并在面板上明确标注，而不是悄悄少报。

### 8.4 格式化

| 规则 | 例 |
|---|---|
| 金额 < 1 个货币单位 | 保留 5 位小数：`¥0.00600` |
| 金额 < 1（≥0.01） | 保留 4 位：`¥0.0340` |
| 其余 | 2 位：`¥12.34` |
| 千分位 | `1,234,567` |

亚单位总额四舍五入会变成 `¥0.00`，等于什么都没说；`¥0.00600` 才是信息。

### 8.5 双数据源

| 来源 | 提供什么 | 何时使用 |
|---|---|---|
| Host 快照 `sessions[].tokens` | 会话总计 + **逐回合归属** + 请求数 | Host 有新数据时优先 |
| 浏览器 `tokenUsage` session projection | `uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens` | Host 报不出 token 时兜底（陈旧 Host 模块、或组合中没有它） |

浏览器侧读取路径（每一跳都是可选的，整体被 try/catch 包住）：

```js
ctx.sessions.binding(id).session.projections.faceOf('tokenUsage')?.getSnapshot?.()
// 回退：projections.get('tokenUsage')
```

`refreshProjections(sessionId)` 是异步的，冷启动时一次同步读必然读空，因此**轮询重试至多 6 次、每次间隔 600ms，一旦拿到值就停止**。面板会标注数据来源。这条路径不需要任何 Host 往返，所以刷新页面就能生效；但它无法提供逐回合归属与请求数——那只有 Host 看得见。

---

## 9. 关键设计决策记录（ADR）

| ID | 问题 | 错误做法（已实际发生） | 采纳方案 | 证据 |
|---|---|---|---|---|
| ADR-1 | 根插件收不到 scoped 事件 | 裸 `ctx.on`，一个 subagent 跑完计数仍全为 0 | 每个订阅加 `{ global: true }` | `tools/host-test.mjs` 提供反向证明；`tools/probe-filter.mjs` 展示 filter 只在派发带作用域时被咨询 |
| ADR-2 | 可选服务读不到时**抛异常**而非返回 undefined | `ctx.agents` 抛错，整个端点变成裸 400 且毫无线索 | 统一走 `ctx.get(name)` 包装 | `index.js` `service()` |
| ADR-3 | 一个坏会话行炸掉整个端点 | 快照在循环里抛，整条路由 400 | 逐行 `try/catch` + 跳过 + `warn` 记名 | `snapshot()` |
| ADR-4 | 剪影上叠加自创图形 | 白色斑块盖住鲸鱼 | 只画一条官方 path；叠加只能是**背后**的光晕与**同 geometry** 的描边 | `preview/whale-states.png` |
| ADR-5 | 时间戳单位不一致 | 秒被当毫秒，面板显示 `1497404m 14s`（恰是到 1970 的距离） | `epochMs()`：`<1e11` 视为秒；结果早于 2001 一律拒绝 | 两种单位都有测试，含「与 epoch 距离相差 6 个数量级」的断言 |
| ADR-6 | busy 判定 | ①优先 Host → 藏起真实工作 ②并集 → 永久卡在 working | 客户端视图已加载则以客户端为准，否则信 Host | `resolveBusy` 纯函数 + 注释记录两次失败 |
| ADR-7 | 完成音可能不响 | 单一全局高水位：后来的回合压制别的会话 | 高水位**按会话**；2s 窗口做同回合匹配 | `tools/client-test.mjs` 19 条断言，含「仅客户端观察到的回合必须响」 |
| ADR-8 | 陈旧 Host 世代 | 面板空白 | 音效与状态以客户端为主；账本双源降级 | `selectRecords` + `readClientTokens` |
| ADR-9 | 重复计费 | 在途回合同时折进会话总计 → 计两次 | settled 与 live 不相交，快照提供二者之和 | `tools/host-test.mjs` 记账断言 |
| ADR-10 | patch 带了顶层 `id` | Loader 警告 "entry not found" 并跳过插入，bundle 已启用却无插件行 | `cordis.patch.yml` 去掉顶层 `id` | `README.md` 文件表注 |
| ADR-11 | 1.5s 轮询变成 1.5s 一次 Platform 请求 | — | 余额读数 60s TTL + 请求途中只踢后台刷新 | 测试断言 5 次额外轮询产生 0 次额外调用 |
| ADR-12 | selector snapshot 每次都是新数组 | 以数组为依赖 → 每次渲染都结算一次回合 | 派生稳定字符串 `runningKey` 作为依赖 | `WhalePet` 注释 |

---

## 10. 降级矩阵

| 故障 | 表现 | 用户可见行为 |
|---|---|---|
| `/pet-whale/state` 不可达 | `hostState.ok = false`，`active` 清空 | 状态与音效照常（客户端自持）；账本切到 `local` 行；无 per-episode 细节 |
| Host 半侧是陈旧世代 | `ok: true` 但 `sessions` 缺字段 | 面板显示浏览器 projection 的计价，并标注来源 |
| `webServer` 不在组合中 | 未注册任何路由 | 折叠逻辑仍在跑，只是没有出口；插件不报错 |
| `ui-session` 缺失 | 两个 hook 为 `undefined` | 完全依赖 Host 半侧；槽注册仍成功 |
| 无 `deepseekAccount` / 未登录 | `balance` 缺省 | 不显示余额行 |
| 余额请求失败 | `balance.error` 记录，保留上一次好读数 | 显示旧余额 |
| `tone.wav` 缺失或解码失败 | `bufferState` 标记失败 | 回落到合成音符，**不静音** |
| 音频被浏览器完全禁止 | `audioReady = false` | 禁用试听按钮；动效（mood 光晕）仍在传达完成 |
| `localStorage` 不可用（隐私模式/配额） | 读写各自 try/catch | 账本与偏好在本次页面内有效，不持久化 |
| 音色/费率覆盖值损坏 | 解析失败即忽略 | 回落到内置默认 |
| 会话时间戳不可信 | `elapsedMs` 为 `undefined` | 显示为「未知」，而不是七位数的分钟数 |
| 记录超过 80 条 | 裁剪窗口并清空在途表 | 旧记录自然滚出 |

---

## 11. 性能与资源预算

| 资源 | 预算 | 机制 |
|---|---|---|
| 状态请求频率 | 每页面 0.67 次/秒 | 1500ms 自续 `setTimeout` + 4s 超时 |
| 响应体 | 上限 80 条记录 + 20 条 feed | 每条文本裁剪到 400 字符 |
| 余额 Platform 请求 | ≤ 1 次/分钟 | 60s TTL + `pending` 合并 |
| 静态资产 IO | 每进程 1 次读 | 内存常驻 + `max-age=86400` |
| 本地账本 | 120 条 | `localStorage`，超限即裁剪 |
| 渲染开销 | 无 JS 动画循环 | 全部动效为 CSS keyframes；记录列表为纯函数组件 |
| 内存 | 有界 | 所有 Map/数组均有上限或随 `session/disposed` 清理 |

---

## 12. 安全与隐私

- **不落盘任何会话内容。** 账本只存在于进程内存与浏览器 `localStorage`；不写入会话、不写文件。
- **不发送任何网络请求**，除余额查询这一项由 Harness 自身的 `deepseekAccount` 服务代发（本插件不接触 API Key 或凭据）。
- **静态路由不可越狱**：文件名白名单 + 扩展名白名单 + 禁 `..`。
- **HTTP 方法受限**：仅 `GET` / `HEAD`，其余 405。
- **响应不缓存**：状态端点 `no-store`。
- **无遥测**：本插件不注册任何 telemetry。

---

## 13. 可测试性与验证策略

分层测试的设计要点是：**把可判定逻辑从渲染/音频中提取成纯函数或数据**，这样它们能被直接求值，而不需要一个浏览器。

| 阶段 | 工具 | 覆盖 |
|---|---|---|
| 1 形状检查 | `tools/check.mjs` | manifest、patch、Host 与 Client 的形状断言（含**每个订阅都必须带 `global`**） |
| 2 ES module 解析 | `node --check` | 两个半侧都能被解析（单独一步，因为文件沙箱拒绝捕获子进程的管道输出） |
| 3 Host 行为 | `tools/host-test.mjs` | **在真实 Cordis 运行时上跑 `plugin/index.js`**：构造真实根 `Context`、派发与 DSH 相同的 scoped 事件、通过桩 `webServer` 把插件自己的 HTTP 快照读回来。**39 条断言**：路由注册、完整回合折叠成一条记录、busy→idle 转变、错误路径、忽略工具来源的 `user/message`、从运行中的 agent 播种、`global` 标志的反证、token 记账（在途桶可见性、桶算术、reasoning 不重复计、跨回合累加、已结算桶不与账本共享引用、无 usage 的结算记 0 而不是编数字） |
| 4 提示音规则 | `tools/client-test.mjs` | 从 `client.js` 提取 `decideCue` 直接求值，**19 条断言**：仅客户端回合必须响（静音回归）、对后续 Host 记录的单次去重、失败升级、按会话独立 |
| 5 音频 | `tools/chime-test.mjs` | 通过**记录型桩 `AudioContext`** 驱动真实的 `renderVoice` / `renderChime` / `chimeOutput`：包络形状与起音长度、音符间隔、两个分音、限幅器与柔化器接线、大三和弦频率、余韵返回值、响度预算 |
| 6 计价 | `tools/cost-test.mjs` | 费率表与「谷价恰为峰价之半」不变量、所有高峰边界、按已发布价格手算的算术、缓存写入按未命中计、reasoning 不计入成本与 token 总数、畸形桶读作 0、小额格式化 |
| 7 面板布局 | `tools/layout-test.mjs` | 在无头 Chrome 中实测面板尺寸与布局 |
| 8 分发 | `tools/build-dist.mjs` → `tools/verify-package.mjs` | 打包**之后**逐文件比对源码，并校验身份与美术不变量——被验证的是接收方将要运行的东西，而非它的来源 |

```
powershell -File tools/verify.ps1     # 8 个阶段，全绿输出 VERIFY OK
```

### 13.1 已知未被验证的部分

**渲染出来的像素。** 自动化布局测试覆盖面板几何；但鲸鱼的实际观感、浅色/深色两套主题下面板的视觉、以及提示音**听起来如何**，都依赖人工目视/试听确认。Browser 半侧的**接线**与**提示音规则**是被测试固定的，它的**外观**不是。

---

## 14. 打包与分发设计

```
node tools/build-dist.mjs   →   dist/
```

| 产物 | 用途 |
|---|---|
| `dsh-whale-pet.tgz` | npm/pnpm tarball，可按文件路径或 URL 安装 |
| `dsh-whale-pet.zip` | 手工拷贝或下载 |
| `dsh-whale-pet/` | 已解包的纯目录 |
| `INSTALL.md` | 接收方说明 |

两个归档都把内容嵌在 `dsh-whale-pet/package/` 之下——这是 `npm pack` 的产物结构，也是 pnpm 期望的结构，因此 tarball 能被 dsh 侧正常安装，而解压 zip 得到一个整洁的文件夹而不是散落一地。

**目录安装 vs tarball 安装**：目录安装会形成 `link:`，profile 指向你的文件夹，后续编辑立即生效、版本不冻结；tarball 是复制，安装即冻结。**对外分发用 tarball。**

安装使用**绝对路径**——相对路径被**刻意拒绝**，因为 Host 的工作目录对在浏览器里输入命令的人毫无意义。`install_bundle` 自己完成 profile 安装与 bundle 选择；**绝不手工编辑 profile 的 `package.json` / `cordis.patch.yml`，也绝不在 profile 里跑 pnpm。**

---

## 15. 扩展点与演进路线

按「改动成本从低到高」排序：

1. **换音色** —— 替换 `plugin/assets/tone.wav`，刷新页面。零代码。
2. **加音色** —— 在 `TONES` 里加一项数据，自动出现在选择器里。
3. **改价格** —— 写 `localStorage` 的 `RATE_OVERRIDE_KEY`；或改内置表。
4. **加面板字段** —— Host 侧在 `settle()` 补字段，Client 侧在 `RecordRow` 加一格；快照版本号 `+1`。
5. **把账本换成 session projection** —— 目前用 `session/event` 监听器 + 增量折叠；更正统的升级路径是写一个 `ctx.sessionProjections` 单元。现有账本小而有界，直接监听已够用。
6. **更丰富的面板** —— 用 `tool/call` 的 `callId` 与 `tool/result` 的 `message.toolCallId` 关联出**逐工具时间线**。
7. **多宠物 / 主题化** —— 目前鲸鱼图形与 `pet-whale` 标识硬编码；抽出「宠物包」接口需要把 `Whale` 与提示音表参数化。

---

## 16. 风险与未决问题

| 风险 | 影响 | 现状 / 缓解 |
|---|---|---|
| **Host 半侧改动需要重启 DSH** | 开发循环慢，且用户容易误以为「没生效」 | 已在 README 显式说明；把易变逻辑放到 Client 侧是结构性缓解 |
| 面板标题/回复可能包含敏感内容并落在 `localStorage` | 本机可见的历史 | 有「清空」按钮；如需更严可加自动过期或改为内存态 |
| `epochMs()` 的 `1e11` 阈值 | 依赖「秒 < 1e11 < 毫秒」这一长期成立的事实 | 有双单位测试与 7 天上限双保险 |
| 高峰期窗口不含中国法定节假日 | 节假日会按峰价显示，偏高 | 刻意选择：宁可高报并标注，也不静默少报 |
| 费率表会过期 | 计价偏离实际 | 提供整表覆盖项；面板标注币种与模型 |
| `BUSY_GRACE_MS = 6000` 已声明但**从未使用**（源码中以 `void BUSY_GRACE_MS;` 抑制告警） | 死常量，误导后来者以为存在「Host-only busy 宽限期」 | **待清理**：要么实现该宽限逻辑，要么删除 |
| 记录窗口裁剪时 `open.clear()` | 超过 80 条时，所有在途回合被一并丢弃，长回合可能丢尾巴 | 仅在极端长度下发生；如需精确可改为按会话淘汰 |
| 尚未验证渲染像素与听感 | 外观/音色问题不会被自动化测试拦下 | `preview/whale-states.png` 与 `dist/tones/*.wav` 作为可复核的证据 |

---

## 附录 A · 文件清单

| 文件 | 角色 |
|---|---|
| `plugin/package.json` | 清单：`dsh.bundle.patch`、`dsh.client`、`exports["./client"]` |
| `plugin/cordis.patch.yml` | 插入 Host 行（**故意无顶层 `id`**） |
| `plugin/index.js` | Host 半侧：事件折叠 + JSON 快照 + 资产路由 |
| `plugin/client.js` | Browser 半侧：鲸鱼、面板、提示音、计价 |
| `plugin/icon.svg` | 插件列表图标（鲸鱼） |
| `plugin/assets/tone.wav` | 完成音资产（24kHz 单声道，42 KiB） |
| `plugin/locale/{en,zh}.json` | 插件管理器标题与描述 |
| `plugin/LICENSE` | MIT |
| `tools/*.mjs` | 8 个阶段的测试与打包工具 |
| `preview/whale-states.png` | 96px 出货态与静止态对照 |
| `dist/` | 分发产物（tarball / zip / 目录 / INSTALL.md） |

## 附录 B · 常量总表

| 常量 | 值 | 位置 |
|---|---|---|
| `ROUTE_PATH` | `/pet-whale/state` | Host |
| `ASSET_PATH` | `/pet-whale/assets/` | Host |
| `MAX_RECORDS` | 80 | Host |
| `FEED_LIMIT` / 对外 feed | 60 / 20 | Host |
| `TEXT_LIMIT` | 400 字符 | Host |
| `MAX_PLAUSIBLE_AGE_MS` | 7 天 | Host |
| `BALANCE_TTL_MS` | 60 000 ms | Host |
| 快照 `version` | 3 | Host |
| `ENDPOINT` / `POLL_MS` / `REQUEST_TIMEOUT_MS` | `/pet-whale/state` / 1500 ms / 4000 ms | Client |
| `LOCAL_RECORD_LIMIT` | 120 | Client |
| `STORAGE_KEY` | `dsh.pet.whale.records.v1` | Client |
| `PREFIX` | `dsh-pet-whale` | Client |
| 槽注册 | `shell.overlay` / `pet-whale` / order 40 | Client |
| 宠物尺寸 | 96 × 88 px，`viewBox="-2 -3 27.5 25.5"` | Client |
| 面板尺寸 | 390px 宽 · `min(92vw,390px)` · `min(90vh,860px)` 高 | Client |
| mood 回落延时 | 2600 ms | Client |
| 状态错误窗口 | 8000 ms | Client |
| 同回合匹配窗口 | 2000 ms | Client |
| 音频：起音 / 低通 / 限幅 | 6ms（bell 35ms）/ 4200Hz / -8dB·knee10·ratio10·3ms·180ms | Client |

## 附录 C · 术语

| 术语 | 含义 |
|---|---|
| **半侧（half）** | 本插件的两部分之一：Host（宿主 Node）或 Browser（渲染进程） |
| **回合（episode）** | 一次工作单元：从 prompt 或运行开始，到 idle 转变结束 |
| **结算（settle）** | 把在途回合冻结成一条记录，并将其 token 桶并入会话总计 |
| **scoped event** | 经 agent/session scope carrier 派发、受 `Context.filter` 过滤的事件 |
| **standard kit** | 槽位声明 `scope: 'root'` 时注入组件的标准 props 集合（含根级 hooks） |
| **bucket** | 一个可独立计费的 token 计数桶 |
| **峰 / 谷** | DeepSeek 的峰谷计价窗口（北京时间工作日 09:00–12:00、14:00–18:00） |
