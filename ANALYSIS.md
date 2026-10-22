# dsh-whale-pet 分析与优化记录

| 项 | 值 |
|---|---|
| 被分析版本 | `dsh-whale-pet@1.0.0`（profile 中由 GitHub tarball 安装） |
| 优化版本 | `1.3.1`（时长/交互口径修正 + 记录跳转） |
| 对照插件 | `dsh-context@0.73.3` |
| 运行环境 | DeepSeek Harness Web GUI（profile `desktop`） |
| 改动范围 | Host `index.js`（待授权折叠）+ Browser `client.js`（上下文面板 / 紧急音 / 轮询） |
| 生效方式 | 刷新页面；本次 Host 改动需重启一次 DSH |

---

## 1. 结论先行

原插件已经是一个结构清晰、零依赖、可降级的宠物插件：Host 折叠会话事件，Browser 负责动效、音效、账本展示。它最大的空白不是“再画得好看一点”，而是**只知道自己花了多少 token，不知道上下文窗口还剩多少**。

本次优化把 `dsh-context` 的上下文洞察能力接到宠物身上，形成一条连贯的叙事：

> **鲸鱼的状态 = Harness 在不在工作；需要授权 = 紧急声音 + 蓝色光晕；点开面板 = 这些工作花了多少、上下文被什么占满、要不要压缩。**

同时修掉了原实现中一个会让“浏览器投影兜底”永远失效的服务定位 bug，把固定 1.5 s 轮询改成自适应节奏，并为“需要授权”补上独立的紧急声音提醒（v1.2.0）。

---

## 2. 原实现分析

### 2.1 做得好的地方

- **双进程职责清楚**：Host 只看得到会话生命周期（prompt / reply / usage / error），Browser 只看得到 DOM、音频、实时 session 状态；两边各自兜底，Host 挂了宠物仍然会响、会动。
- **零运行时依赖**：Host 只 import `node:fs`；Browser 是手写 `window.__ModuleLoader__.load`，React 从模块表取。没有构建步骤，目录 / tarball 都能装。
- **事件订阅带 `{ global: true }`**：根挂载插件能观察所有会话，这是 `session/event` 能到达宠物的关键。
- **账本有界**：80 条记录、60 条 feed、400 字符截断、1.5 s 轮询、余额 60 s TTL，内存与请求都有明确上限。
- **可降级**：Host 不可达 → 浏览器本地账本；没有 `deepseekAccount` → 余额行消失；音频不可用 → 动效仍在。

### 2.2 发现的问题

| # | 问题 | 证据 / 影响 | 处理 |
|---|---|---|---|
| 1 | **服务定位器被当成 sessions 服务传入，且槽位没有注入 `ctx`** | `servicesRef.current = { get }`，但 `readClientTokens(servicesRef.current, …)` 需要的是带 `.binding()` 的 sessions 服务；同时 `shell.overlay` 的 standard props 只有 hooks，没有 `ctx`，原组件直接读 `props.ctx` 在真实槽位上也拿不到服务。结果浏览器端 `tokenUsage` 兜底恒为 `undefined`，而代码注释却宣称“Host 不可达时自动降级”。本次接入上下文时，桩测试第一次渲染得到 `data-ctx="none"`，正是这个原因。 | 在 `apply(ctx)` 里用一层 `WhalePetWithContext` 显式把真实 Client 上下文注入组件；所有投影读取改为 `servicesRef.current?.get?.('sessions')`。修复后同一桩测试得到 `calm / 4.2%`。 |
| 2 | **固定 1.5 s 轮询，不看页面状态** | 空闲且面板关闭时仍 40 次/分钟；标签页隐藏时也继续。Host 快照不大，但这是无意义的常驻请求。 | 工作或面板打开 1.5 s；空闲 5 s；页面隐藏 20 s；重新可见、窗口聚焦、打开面板立即补一次。 |
| 3 | **`BUSY_GRACE_MS` / `activityRef` 是死代码** | 原 `DESIGN.md` 风险表已注明“已声明但从未使用”。 | 删除常量、未读 ref 与相关 effect。 |
| 4 | **没有上下文窗口视角** | 面板只有 token 花费，没有“窗口占用 / 构成 / 压缩”；而这正是 `dsh-context` 的核心能力。 | 新增面板 Context 卡片 + 悬停提示 + 洞察页跳转；外圈曾在 v1.1.0/1.1.1 实现，v1.1.2 因遮挡鲸鱼尾巴而移除。 |
| 5 | **投影只在面板打开时补载，且只补 token** | 冷启动时面板没有数据；打开后也要等下一轮。 | 会话切换时补载一次 `refreshProjections`，800 ms 后再触发一次渲染；打开面板时再补一次（必要时重试）。 |
| 6 | **上下文目标会话可能选错** | 原账本优先“有花费的会话”，子代理可能比主会话花得多。 | 上下文目标优先取 `retainedBy.mainView > 0` 的主视图会话，再退到运行中会话、账本会话。 |
| 7 | **面板只能用鼠标收起** | 没有键盘关闭。 | 增加 `Escape` 关闭。 |
| 8 | **装饰色误用了主题 `--dsw-alias-brand-primary`** | 深色主题里 `--dsw-alias-brand-primary` = `--dsw-static-neutral-bluish-50` = `#f9fafb`（近白），不是品牌蓝。于是记录数 badge 变成白底白字（截图右下角的白色胶囊），上下文环的 calm 填充和 16% 轨道也变成白色/灰色大圆——正是用户看到的“宠物背景有问题”。 | 装饰性蓝色一律改用固定 DeepSeek 蓝 `#4d6bfe`；badge 固定蓝底白字；v1.1.2 进一步移除外圈，v1.1.3 移除角标本身，只保留面板与悬停提示。 |
| 9 | **“本会话”的计数与明细实际是全局记录** | `AccountSection` 使用全局 `records`（所有会话，最多 80 条），因此“33 次交互”和下方明细可能混入子代理 / 其他会话；“本会话时长”其实是 `now - SessionHeader.createdAt`，包含空闲，不是实际工作时长。 | 主视图会话优先；按 `sessionId` 过滤计数与明细；标签改为“会话年龄（含空闲）”并新增“交互耗时”（已结算记录之和）。 |

---

## 3. 与 dsh-context 的结合方式

不 import `dsh-context` 的任何代码，也不依赖它的私有模块；只读它注册的 **session projection**，必要时调用公开的 Client 导航服务。

### 3.1 读取的三个投影

| 投影 | 注册方 | 字段 | 用途 |
|---|---|---|---|
| `contextPressure` | Harness 官方 token-meter | `pressureTokens` / `projectedTokens` / `contextWindow` | 占用比例；与输入框旁的上下文环同源 |
| `contextBreakdown` | Harness 官方 token-meter | `systemTokens` / `toolsTokens` / `messageTokens` | 三段构成条 |
| `contextTimeline` | `dsh-context` | `current{system,tools,user,inject,skill,assistant,tool,total}`、`contextWindow`、`maxOutputTokens`、`counts{compactions,prunes,turns,steps}`、`model` | 更细的构成、压缩计数、预留输出、模型名、洞察入口 |

字段语义已在安装的 DSH `0.2.1-rc.2` session projection schema 中核对：

- `contextPressure.pressureTokens` 是最近一次请求的 provider prompt 大小（uncached input + cache read/write），不含正在流式输出的 response；
- `contextPressure.projectedTokens` 是“下一次请求”的预估，从 provider 样本出发，只对 surface 的增减做启发式重算，因此压缩发生后也能立刻反映；
- `contextBreakdown` 是 system / tools / 其余可见节点的启发式构成。

因此占用优先用 `projectedTokens`（下一次请求），`pressureTokens` 只在没有 projected 时兜底；三段构成之和与 pressure 不相等时，多出来的部分显示为“其他”。

读取路径是 `sessions.binding(id).session.projections.faceOf(key).getSnapshot()`，每一跳都 optional + try/catch；任何投影缺失都只让对应字段消失，不会让宠物报错。

### 3.2 上下文呈现（v1.1.2 最终形态）

宠物本体**不再绘制外圈 / 背景，也不显示记录数角标**。原因见 §8：圆环在 96×88 的鲸鱼上会与右侧尾鳍相交，既像“背景”，又容易被误认为加载动画；右下角的数字角标则会让宠物看起来像带通知的按钮。

最终呈现位置：

| 位置 | 内容 |
|---|---|
| 面板 Context 卡片 | 占用百分比、构成条、窗口 / 剩余 / 预留、压缩次数、缓存命中率、阈值提醒、洞察入口 |
| 宠物悬停提示 / `aria-label` | `上下文 42.3% · Context 42.3%`，不占视觉空间 |
| 阈值颜色 | `<80%` 蓝 `#4d6bfe`；`80–90%` 琥珀（warn token）；`≥90%` 错误红（error token） |

外圈曾在 v1.1.0/1.1.1 用 `conic-gradient` + `mask` 实现，v1.1.2 已整体移除。

### 3.3 面板 Context 卡片

从上到下：

1. 标题 + 占用百分比（颜色跟阈值走）。
2. 构成条：系统提示 / 工具 schema / 消息（有 dsh-context 时还有注入/技能、其他）。
3. 图例：每一项的 token 数。
4. 占用 / 剩余窗口 / 预留输出 / 压缩次数 / 缓存命中率。
5. 阈值提醒（仅 80% 以上）。
6. 来源标记（`dsh-context` 或“官方 token 投影”）+ **上下文洞察 Context Insights ↗**。

### 3.4 洞察页跳转

`dsh-context` 在 `main` slot 注册的 key 是 `dsh-context`。按钮调用公开的：

```js
ctx.get('layout').selectPanel('dsh-context')
```

只在 `contextTimeline` 存在（即 dsh-context 已装）时渲染按钮；面板不存在时不会显示死按钮。

### 3.5 没有 dsh-context 时

面板、占用、三段构成、缓存命中仍然工作，只是没有压缩计数和洞察跳转。**不会因为少装一个插件而退化成一个装饰品。**

### 3.6 权限提醒（v1.2.0）

DSH 的审批落成两条 durable session event：

- `approval/asked` → `{ id, toolName, callId?, reason? }`
- `approval/decided` → `{ id, outcome }`

Host 半侧在已有的 `session/event` 折叠里维护一个 `approvals` Map（按 `sessionId + id`），`approval/decided` 删除，`session/disposed` 清空该会话，快照增加：

```jsonc
{
  "version": 4,
  "approvals": [
    { "id": "...", "sessionId": "...", "label": "...", "toolName": "bash",
      "reason": "...", "askedAt": 1730000000000 }
  ],
  "approvalCount": 1
}
```

Browser 半侧：

- 待授权集合从空变为非空时播放**固定**的紧急双音（B5/E5 交替 + 高音收尾，方波），不受用户选择的完成音色影响；
- **只响一次**：未处理期间不重复，页面重新可见不补响，同一批多个请求也只响一次；全部处理完后新的请求才会再次响；
- 鲸鱼光晕保持与本体一致的蓝色渐变并闪烁（不再用琥珀色；仍是软光晕，不是外圈）；
- 面板顶部列出待授权工具、原因与会话标签。

这个功能必须改 Host，所以**安装这一版后要重启一次 DSH**；重启后 `GET /pet-whale/state` 的 `version` 变为 `4`。

### 3.7 动画同步（v1.2.1）

工作时鲸鱼本体用 `bob` 上下浮动（同时带 ±1.2° 摆动）。虚线工作环与光晕原来各自固定在中心，视觉上像鲸鱼穿过一个静止的环。现在二者被放进同一个 `orbit` 组：

- `orbit` 只做 `translateY(0 → -7px → 0)`，与本体 `bob` 的垂直分量同周期（空闲 3.4s / 工作 1.15s）；
- 环自身仍保留 `spin` 旋转，光晕保留 `pulse` / `flash` 透明度；
- `prefers-reduced-motion` 下三者的动画一起关闭。

这样“转圈圈的光影”会跟着鲸鱼一起上下，而不会左右摆动或改变环的形状。

### 3.8 记录跳转（v1.3.0）

每条交互记录都携带 `sessionId`，现在整行可点击（也可用键盘）：

- `RecordRow` → `onOpenRecord(record)` → `uiWorkspace.openSession(record.sessionId)`，把中央列切到该会话；
- 随后 `layout.selectPanel('conversation')`，确保当前主面板是对话而不是插件页 / 上下文洞察页；
- 只有两步都成功调用后才关闭宠物面板；会话已归档 / 已释放或服务缺失时保持面板打开，避免“点一下什么都没了”；
- 可点击行带 `role="button"`、`tabIndex=0`、Enter / Space 激活、hover / focus 背景和右上角 `↗` 提示。

### 3.9 时长与交互口径（v1.3.1）

截图里同一个红色框内其实混了两个口径：

| 字段 | 真实含义 |
|---|---|
| `本会话时长`（旧标签） | `now - SessionHeader.createdAt` 的墙钟年龄，包含空闲、页面关闭、等待人类的时间；不是 Harness 实际工作时长。 |
| `33 次交互` | 旧实现取全局 `records.length`（所有会话，最多 80 条），不是这个会话的交互数，可能混入子代理 / 其他会话。 |

修正：

- 标签改为 **会话年龄 Session age**，注明“含空闲 · idle”；
- 新增 **交互耗时 Episode time**：该会话已结算记录的 `durationMs` 之和，不含交互之间的空闲，也不含当前尚未结算的回合；
- 账本目标会话改为优先取主视图会话（不再优先取“花费最多”的会话，避免把子代理账单显示成“本会话”）；
- 计数和下方每次交互明细都按 `sessionId` 过滤。

所以 `120m 02s` 是“这个会话从创建到现在过了 2 小时”，不是“工作了 2 小时”；实际交互耗时看新增的那一行。

---

## 4. 性能优化

| 场景 | 原请求频率 | 新请求频率 | 变化 |
|---|---|---|---|
| 工作中 / 面板打开 | 40 次/分钟 | 40 次/分钟 | 不变（需要实时） |
| 空闲、面板关闭 | 40 次/分钟 | 12 次/分钟 | **-70%** |
| 页面隐藏 | 40 次/分钟 | 3 次/分钟 | **-92.5%** |
| 从隐藏恢复 / 窗口聚焦 / 打开面板 | 等下一 tick | 立即一次 | 响应更快 |

其他：

- 面板打开期间每 1.2 s 只重读**内存中的 projection**，不额外走 HTTP；HTTP 轮询仍按上面的节奏。
- `readProjection` / `readContext` 是纯读，无缓存写入、无会话修改、无遥测。
- 删除死代码后，`view` 的依赖数组不再包含未使用的 `runningCount`。
- Host 只新增待授权折叠（`approval/asked|decided`），不参与轮询与计价；其余 Host 逻辑未改。

---

## 5. 代码落点

| 内容 | 位置 |
|---|---|
| 轮询节奏 / 阈值常量 | `client.js:43` 起 |
| 通用 projection 读取 | `client.js:213` |
| 上下文读取与降级 | `client.js:331` |
| 紧急音音符 / `audio.urgent()` | `client.js:825` 起 / `client.js:1046` |
| Context 卡片 | `client.js:1354` |
| 授权面板行 / 蓝色光晕 | `client.js:1743` / `client.js:1087` |
| 自适应轮询 | `client.js:1969` |
| 服务定位修复 | `client.js:2196` 起 |
| 待授权集合 / 单次响 | `client.js:2180` / `client.js:2420` 起 |
| 主视图会话选择 | `client.js:2313` |
| 投影补载 | `client.js:2335` 起 |
| 洞察页跳转 | `client.js:2374` |
| 槽位上下文注入 | `client.js:2624` |
| Host 待授权折叠 | `index.js:347` / `529` 起 |
| Host 快照 `approvals` | `index.js:692` 起 |

---

## 6. 验证记录

### 6.1 已做

| 验证 | 结果 |
|---|---|
| `node --check client.js` / `index.js` | 通过 |
| 桩加载 `window.__ModuleLoader__` | 插件导出 `{ inject: ['slots'], apply }` |
| `readContext` 单元断言 | 完整 / 无 timeline / `current: null` / 全缺失 / 95% critical / `compact(42300) === '42.3k'` 全部通过 |
| `ContextSection` 渲染断言 | 4.2%、`42.0k / 1.0M`、`2 次` 压缩、75% 缓存命中、95% 警告、空状态均出现 |
| `WhalePet` 初始渲染断言 | title 含 `4.2%`；按钮不再渲染任何外圈节点 |
| `Panel` 渲染断言 | Context 卡片出现在 Usage 卡片之前，内容完整 |
| Host 审批折叠桩测试 | `approval/asked` → 1 条；重复 ask 不膨胀；`approval/decided` → 0；`session/disposed` 清空；快照 `version: 4` |
| 授权面板渲染断言 | `需要授权`、工具名 `bash`、原因、会话标签均出现 |
| `install_bundle` | `application: applied`，安装时 `1.1.0`；当前 link 版本 `1.2.0` |
| `Config.listConfigs name=dsh-whale-pet` | 存在 `include:pet-whale` |
| `Slots.listSubTree root=shell.overlay` | 占用者 `pet-whale`，`active: true` |
| `GET /pet-whale/state` | 当前运行进程仍为 `version: 3`；**重启 DSH 后应为 `4`** |
| 用户截图像素分析 | 白色胶囊位于 `(159..186, 156..171)`，颜色 `#f9fafb` = `--dsw-static-neutral-bluish-50`；灰色圆环是该色的 16% 混合。确认根因是主题 token 误用。v1.1.2 已移除整个外圈。 |

### 6.2 未做 / 限制

- **没有在真实页面上做 DOM / 截图控制**：浏览器端没有可用的 DOM 截图 / 点击控制；本次通过用户截图做了像素级根因定位，组件树与颜色值正确，但修复后的实际观感仍需刷新后目视确认。
- **没有读取到实时的 projection 值**：验证用的是按已确认 schema 构造的桩数据；真实 dsh-context 投影是否存在，需要刷新后看面板 Context 卡片是否出现。
- **“上下文洞察”跳转按钮没有真实点击验证**：`layout.selectPanel('dsh-context')` 的 key 已通过 `Slots` 确认，但点击后的页面切换未在浏览器里执行。
- **权限紧急音没有真实试听**：音符、音色与调度走的是既有 `renderChime` 路径，`audio.urgent()` 已接入；实际音量与“紧急感”需要重启后在浏览器里确认。
- **Host 审批折叠尚未在真实进程重启后验证**：桩测试覆盖了 asked/decided/重复/disposed，但当前线上 `/pet-whale/state` 仍是旧进程的 `version: 3`；重启后才会变成 `4`。

---

## 7. 后续可做

1. **Host 快照 ETag / 304**：目前每次 1.5 s 都重新 JSON 序列化整份快照；加 `ETag` 或 `If-None-Match` 可以进一步降低空闲成本。需要改 Host，重启 DSH 才能生效。
2. **给 `sessionTotals` 设上限**：记录窗口有 80 条上限，但按会话的累计表没有淘汰；长期运行的大量子代理会话会留下空壳行。建议按 `lastEventAt` 保留最近 64 个。
3. **上下文趋势**：dsh-context 的 `contextTimeline.detailRev` 后面还有详细事件 / 请求数据；若愿意走它的 detail 路由，可以在面板里加一条迷你趋势条或最近压缩事件。当前只用了 slim head 的 `counts`，没有额外拉详情。
4. **可选的压缩提醒音**：90% 阈值目前只有视觉脉冲；若用户希望，可在每会话首次跨过 90% 时加一声轻提示（需要防重复与静音开关）。
5. **真实浏览器回归**：刷新后检查明暗主题、窄屏 390 px 面板、Context 卡片在 0.1% / 80% / 95% 三档的观感。
6. **重启后实测权限提醒**：触发一次需要审批的工具调用，确认紧急音只响一次、不重复、页面恢复不补响，面板待授权行与蓝色光晕都按预期工作。

---

## 8. 视觉回退记录（v1.1.2）

| 版本 | 外圈 | 用户反馈 | 处理 |
|---|---|---|---|
| v1.1.0 | 88×88 conic-gradient + mask，16% 轨道，brand token 填充 | 截图：灰色大圆 + 白色胶囊 badge | 定位到 `--dsw-alias-brand-primary` 在深色主题是 `#f9fafb`；改固定蓝、去 calm 轨道、badge 固定蓝底白字 |
| v1.1.1 | 同上，calm 无轨道、只有蓝色弧 | 截图：蓝色弧仍与鲸鱼右侧尾鳍相交，看起来像贴在身上的“背景” | 决定不再在宠物本体上画任何外圈 |
| v1.1.2 | **完全移除** | — | 上下文只在面板 Context 卡片和悬停提示中出现；宠物保持鲸鱼本体 |
| v1.1.3 | 不再显示 | 用户圈出右下角数字角标，要求去掉 | 移除 `.badge` 元素与样式；交互记录仍可在面板查看 |

这个回退是有意的：96×88 的鲸鱼轮廓右侧尾鳍几乎顶到圆环半径，任何整圈或弧都会与尾鳍相交；继续调半径只会让圆变大、更像背景。把“上下文”放回面板是更稳的取舍。

