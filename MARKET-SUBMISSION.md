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
>
> **描述保持 2 句以内**（v0.3.3 定稿）：目录条目 / 市场卡片直接展示该文案，
> 长版功能清单放 README 即可。**当前注册表里还是旧版长描述（含已删除的
> 1-token 探测），需再提一个 PR 替换为下面的短版**，合并次日 CI 刷新生效。

```json
{
  "name": "dsh-tokenrhythm-bill",
  "owner": "162568316",
  "url": "https://github.com/162568316/dsh-tokenrhythm-bill",
  "category": ["usage", "model"],
  "description": {
    "en": "Finance dashboard for DeepSeek Harness (DSH): balance & expiring credits (with an experience-card redeem-code entry) and a realname badge next to the data account, category-filtered model price cards (discounts + peak/off-peak pricing), a 30-day usage heatmap broken down by model/client, self-key connectivity checks and platform key management (keys created in-panel keep a local plaintext copy so their full value stays copyable later — and that copy can be cleared row by row; the StepFun keys tab deliberately keeps none, because that platform hands the full value back on demand); per-system switches under Settings (基元律动 only by default, at least one stays on) gate the StepFun (阶跃) tab with per-account avatar, realname status, plan & balance, and one-click switching of the API key DSH actually uses (writes the local credential store, hot-reloads with no restart), a ZCode tab reading local desktop credentials for plan quota, a TierFlow (清枢智汇) pair of tabs for account info and plan/subscription quota, and an OpenCSG section (account + password sign-in, multi-account) with a balance / pending-credit account card, a usage tab modelled on the built-in one (window token + call totals, today's usage fetched as its own single-day window, per-interface breakdown, full paging) and platform API-key management (masked list, plaintext kept locally on creation, delete for custom keys only); when the conversation runs an OpenCSG model, a balance chip shows up at the right end of the conversation/trace tab line — it follows the account that owns the key DSH actually uses (local plaintext copy first, mask-fingerprint fallback), and it refreshes right after each finished conversation turn (reusing the cached key-ownership match, re-fetching only the account snapshot); the StepFun chip refreshes the same way after each turn (reusing the cached key-ownership fingerprint, re-fetching only the plan snapshot); the 基元 (tokenrhythm) chip does the same after each turn (reusing its cached key-ownership check, re-fetching only the balance snapshot). All credentials stay on the local host only.",
    "zh": "DeepSeek Harness 费用中心：账户余额与限时额度（含体验卡兑换码入口，数据账号行带实名状态徽章）、按分类筛选的模型价格卡（含折扣与峰谷分时计价）、近 30 天用量热力日历（按模型/客户端拆分）、用自己 Key 实测的连通检测与平台密钥管理（面板里新建的 Key 当场在本机留一份明文副本，之后随时能复制完整值，也可逐条清掉；阶跃的密钥页刻意不落副本——那家平台随时能给回完整值）；基元律动 / 阶跃 / ZCode / 清枢智汇 / OpenCSG 五家在「设置 → 系统管理」里独立开关（默认只显示基元，至少留一个）；阶跃页签按账号展示头像、实名状态、套餐与余额，并可在密钥页把某把平台密钥一键设为 DSH 实际使用的 key（写本机凭据文件，热重载立即生效）；ZCode 页签读取本机桌面端凭证查看套餐额度；清枢智汇页签展示用户信息与套餐用量；OpenCSG 用账号密码登录（支持多账号）：账户卡展示余额与待发放余额，用量页照基元版式给窗口 token/调用合计、今日用量（单独一次单日窗口请求）与按接口拆分（翻页取全量），另有平台 API Key 管理（掩码列表、创建即在本机留存一份明文、仅自建可删）；对话在用 OpenCSG 模型时，「对话/轨迹」页签行右端出现账户余额角标——跟着 DSH 实际在用那把密钥的归属账号走（本机明文副本先精确比对，落空再用平台掩码做头尾指纹反查），且**每轮对话结束后即时刷新**（复用密钥归属匹配缓存，只重取账户余额快照）；阶跃那枚角标同样在每轮对话结束后即时刷新（复用 10 分钟密钥归属指纹缓存，只重取套餐快照）；基元那枚同理（跟着 DSH 实际在用那把密钥走，每轮对话结束后只重取账户余额快照）。凭据只存本机。"
  },
  "install": "dsh plugin add dsh-tokenrhythm-bill",
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
3. `npm publish` —— `files` 字段已限定只发布 `lib`、`image`、
   `cordis.patch.yml`、`LICENSE`、`README.md`（含界面截图）。**`tests` 不发**
   （2026-10-20 定稿）：它在 `.gitignore` 里、是本机维护产物，且带着 8 条与远端源码
   漂移的红，发出去只会让人 `npm test` 看到一片红；测试随 git 历史走，不进 npm 包
   （包体随之从 681 kB / 21 个文件降到 491 kB / 14 个文件）；
4. 验证：`npm view dsh-tokenrhythm-bill repository` 应返回本仓库；
5. （可选）打 `git tag v0.2.0` 并创建 GitHub Release、附构建 `.tgz`，
   可同时启用 tarball 快速路线；
6. （可选）往仓库加 `assets/` 截图并把 raw URL 填进条目 `screenshots`
   数组 —— 市场卡片会直接展示作者截图，未提供时回落到 README 自动抽取。

## PR 步骤

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`；
2. 按其仓库说明在列表中追加上面这条条目（若已发布 npm，带上 `npm` 字段）；
   已有条目时**编辑现有条目**替换 `description` 为上面的短版即可；
3. 提交 PR 并在描述里放一句插件用途说明；
4. 合并后次日 CI 刷新 `plugins.json`，市场即可搜索、一键安装本插件。

收录之前，市场安装端只接受目录白名单内的源（安全设计），但手动安装始终可用：

```sh
dsh plugin --profile desktop add github:162568316/dsh-tokenrhythm-bill
```
