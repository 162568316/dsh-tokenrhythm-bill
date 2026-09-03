# 插件市场收录（dsh-market）

本插件要被 [dsh-market](https://github.com/dsh-market/dsh-market)（设置 → Plugin Market）查询到，
需要进入它的**目录注册表** [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：

- 市场每次打开实时拉取 <https://awesome-dsh-plugin.com/plugins.json>（CI 每日刷新）；
- 向注册表仓库提 PR 加**一条目录条目**即可，通常一天内生效；dshmarket.com、
  awesome-dsh-plugin.com 与市场同步展示；
- **不要**把插件条目 PR 到 `dsh-market/dsh-market` —— 那是市场应用仓库，不是目录。

## 目录条目（PR 内容草稿）

> 提交前请以注册表仓库内现有条目的实际格式为准；发布后的 `plugins.json`
> 条目与下述结构同构。`page` / `stars` / `downloads` / `added` 由目录 CI
> 自动生成，**不要手填**。

```json
{
  "name": "dsh-tokenrhythm-bill",
  "owner": "162568316",
  "url": "https://github.com/162568316/dsh-tokenrhythm-bill",
  "category": ["usage", "model"],
  "description": {
    "en": "Tokenrhythm (基元律动) finance dashboard for DeepSeek Harness: a sidebar entry with the brand mark and a persistent balance pill opens a draggable panel; hovering the entry reveals an expiring-credits timeline that lists every limited-time grant with its remaining days, and the settings tab switches the pill between total balance and expiring balance. Low balance and expiring grants raise native desktop notifications via DSH's built-in desktopRuntime channel (click to focus DSH, suppressed while the window is focused, each state notified once). The Models tab filters the gateway model list by category (text / image / audio / video / embedding) and shows model ID, upstream source, platform status (online / testing), context window, supported modalities, input / output / cache pricing with discounted prices and per-image price; a per-card connectivity dot runs a real 1-token inference check (60 s cache, ~¥0.0004). The Balance tab shows the account balance, expiring quota with countdown and share bar, frozen amount, today's usage aggregated from call logs and a 7-day cost chart with per-model hover details, auto-refreshing every 60 s, with per-account data isolation. The Keys tab lists / creates platform API keys (masked). A built-in update check compares npm dist-tags and offers a copy-update-command (reminder only, never auto-executes). Balance queries work via platform account login or a pasted tr_session cookie; credentials stay host-side and the browser only ever sees masks.",
    "zh": "基元律动费用中心：DSH 侧栏品牌标入口带常驻余额胶囊，悬停入口浮出限时余额时间线（逐笔列出每笔限时额度与剩余天数），设置页可把胶囊切换为总余额或限时总余额；低余额 / 限时到期时通过 DSH 原生 desktopRuntime 通道弹系统通知（点击唤起 DSH，窗口聚焦时不打扰，同一状态只提醒一次）。模型页签按分类（文本 / 图像 / 音频 / 视频 / 向量）筛选网关模型，卡片展示模型 ID、上游来源、平台状态（在线 / 测试中）、上下文、支持模态、输入 / 输出 / 缓存单价（含折扣价）与图片单价，右上角连通状态点可做真实 1-token 推理检测（60 秒缓存，约 ¥0.0004）；余额页签展示账户余额、限时额度倒计时与占比、冻结金额，按本地 0 点起聚合的调用日志统计当日用量，并附近 7 天花费柱状图（悬停看各模型明细），每 60 秒自动刷新，数据按账号隔离（切换账号余额立即刷新）；密钥页签查看 / 新建平台 API Key（只显掩码）。内置插件更新检测（比对 npm dist-tags，仅提醒并提供复制更新命令，不自动执行）。支持平台账号登录或粘贴 tr_session 会话 Cookie 查询余额；凭据只存本机 host 进程，浏览器侧仅显示掩码。"
  },
  "install": "dsh plugin --profile web add dsh-tokenrhythm-bill",
  "npm": "dsh-tokenrhythm-bill"
}
```

### 安装路线说明

市场按以下优先级选择安装源（`npm` > 同仓库 Release tarball > GitHub 源码）：

| 条目字段 | 安装行为 |
|----------|----------|
| `"npm": "dsh-tokenrhythm-bill"`（✅ 已发布，PR 里带上） | 秒级 npm 安装，无需构建脚本 |
| `tarball` 指向本仓库 Release 的 `.tgz` | 预构建安装（URL 必须属于本仓库，跨仓库会被拒绝） |
| 无 `npm` / `tarball` 时 | `github:162568316/dsh-tokenrhythm-bill`，整仓下载 |

npm 包已发布并通过 `repository` 校验（`npm view dsh-tokenrhythm-bill repository.url` 返回本仓库）。

## npm 发布清单（照此流程，每个版本重复）

1. `package.json` 元数据已补齐：`repository` / `bugs` / `homepage` 指向本仓库
   （目录 CI 靠 `repository` 做 npm ↔ 仓库绑定校验，即 repo-verified）；
2. `npm login`；
3. `npm publish` —— `files` 字段已限定只发布 `lib`、`tests`、`image`、
   `cordis.patch.yml`、`LICENSE`、`README.md`（含界面截图）；
4. 验证：`npm view dsh-tokenrhythm-bill repository` 应返回本仓库；
5. （可选）打 `git tag v0.2.0` 并创建 GitHub Release、附构建 `.tgz`，
   可同时启用 tarball 快速路线；
6. （可选）往仓库加 `assets/` 截图并把 raw URL 填进条目 `screenshots`
   数组 —— 市场卡片会直接展示作者截图，未提供时回落到 README 自动抽取。

## PR 步骤

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`；
2. 按其仓库说明在列表中追加上面这条条目（若已发布 npm，带上 `npm` 字段）；
3. 提交 PR 并在描述里放一句插件用途说明；
4. 合并后次日 CI 刷新 `plugins.json`，市场即可搜索、一键安装本插件。

收录之前，市场安装端只接受目录白名单内的源（安全设计），但手动安装始终可用：

```sh
dsh plugin --profile desktop add github:162568316/dsh-tokenrhythm-bill
```
