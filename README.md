# 🐋 Whale pet

一个 DeepSeek 蓝色鲸鱼宠物插件,住在 Harness Web UI 右下角。

- **动效** — 空闲时轻轻浮动;工作时游动加快、气泡上升、光环脉动、外圈转动。
- **状态** — 实时显示 Harness 是否在工作,以及正在处理哪个会话。
- **音效** — 工作完成时播放 `assets/tone.wav`;失败时播放该音色的下行合成版本;开始工作时轻响一声。
- **用量与花费** — 点击鲸鱼展开面板,显示本会话的 token 分解(缓存命中 / 未命中 / 缓存写入 / 输出)、按官方费率算出的人民币(或美元)金额、会话时长、账户余额,以及每一次交互的明细。
- **交互记录** — 每条记录含提示词、回复摘要、工具 / 轮次 / 步骤计数、耗时与费用。

## 换音效

**完成音是一份文件,不是代码。** 直接替换即可:

```
plugin/assets/tone.wav
```

支持 `.wav` / `.mp3` / `.ogg` / `.m4a` / `.aac` / `.flac` / `.webm`(改名成 `tone.wav` 之外的扩展名后,同步改
`plugin/client.js` 里的 `TONE_URL` 常量)。

- 建议 **0.3–1.5 秒**、峰值接近但不超过 1.0,否则会被削波
- 改了资源要**重启 DSH**(主机端只在加载时读取一次,之后从内存提供)
- 若资源缺失或无法解码,**自动回退到合成音效**,不会静音

## 面板里的音色选择

下拉框的 5 个选项**播放的确实是不同的声音**:

| 选项 | 完成音来源 |
|---|---|
| **明亮铃音 Bright（音频文件）** | `assets/tone.wav` |
| 柔和木琴 Soft | 实时合成 |
| 木质马林巴 Marimba | 实时合成 |
| 轻点提示 Click | 实时合成 |
| 长尾钟声 Bell | 实时合成 |

每个音色用 `source` 字段声明完成音走哪条路:`'asset'` 播文件,`'synth'` 实时合成。
**失败与开始提示音始终是合成的**(资源里只有成功音),会跟随所选音色。

想只保留一种声音,把 `DEFAULT_TONE` 改成对应名字即可;其余选项仍留在下拉框里。

## 安装

需要 **DeepSeek Harness 0.2.0-rc.2**(已验证版本)。

通过 Plugin Manager 安装,路径必须是**绝对路径**:

```
install_bundle  target: <绝对路径>/dsh-whale-pet/package
```

也支持 tarball(本地或 HTTP)与 git 仓库:

```
install_bundle  target: C:\path\to\dsh-whale-pet.tgz
install_bundle  target: https://example.com/dsh-whale-pet.tgz
```

`install_bundle` 会自己完成 profile 的包安装与 bundle 启用。**不要**手改 profile 的
`package.json` / `cordis.patch.yml`,也不要在 profile 目录里跑 pnpm。

## 启用与确认

- `Config.listConfigs name=dsh-whale-pet` → 应有一条 `include:pet-whale`
- `Slots.listSubTree root=shell.overlay` → 占用者 `pet-whale`,`active: true`
- `GET /pet-whale/state` → `{"ok":true,"version":3,…}`

## 改动后如何生效

| 改了什么 | 需要做什么 |
|---|---|
| `client.js`(界面) | 刷新页面(必要时 Ctrl+Shift+R 绕过缓存) |
| `index.js`(主机端) | **重启 DSH** |

原因:加载器每个进程世代只 import 一次 ES 模块,禁用/启用 bundle 只是复用缓存,
不会重新读取 `index.js`。

## 依赖情况

**没有任何运行时依赖,也没有 import。** 不需要 `node_modules`、不需要构建步骤:

- 主机端只用 Node 内置能力,不 import 任何 `@deepseek-ai/*` 包(这也是它能从裸
  `link:` 目录加载的原因)。
- 浏览器端是手写的 `window.__ModuleLoader__.load({...})` 格式,Web shell 本来就
  消费这种格式;React 从浏览器模块表里取。

安装方式决定了后续行为:

- 从**目录**安装 → profile 里建立 `link:`,指向你的文件夹,之后改动立即生效。
- 从 **tarball** 安装 → 复制一份,版本被冻结。**分发时用 tarball。**

## 运行环境要求

- profile 必须提供 `webServer`(随 Web 组合自带),否则面板拿不到数据。
- `deepseekAccount` 为可选:有它才显示账户余额;没有它其余功能照常,余额行不出现。
- 面板样式只使用 `--dsw-alias-*` 主题 token,自动适配明暗主题。

## 说明

鲸鱼轮廓取自官方 Harness 品牌标的几何数据(`FISH_LOGO_PATH`),以便宠物与产品
视觉一致;该美术资源版权归 DeepSeek 所有,本包不主张任何权利。详见 `LICENSE`。

完整的设计说明、实现取舍与验证方式见仓库根目录的 `DESIGN.md`。
