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
    "en": "Tokenrhythm model / balance / usage dashboard: a sidebar footer entry opens a draggable panel whose Models tab filters the gateway model list by category (text / image / audio / video / embedding) showing name, context window, input / output / cache pricing, discount and image pricing with capability badges; the Balance tab shows the remaining limited-time quota with expiry and today's usage aggregated from call logs, auto-refreshing every 60 s. Balance queries work via platform account login or a pasted tr_session cookie; API keys and cookies stay host-side and are only ever masked in the browser.",
    "zh": "基元律动模型 / 余额 / 用量面板：侧栏底部「¥ 模型 / 余额」入口打开可拖拽面板。模型页签按分类（文本 / 图像 / 音频 / 视频 / 向量）筛选网关模型列表，展示显示名、上下文、输入 / 输出 / 缓存单价、折扣价、图片单价与能力徽标；余额页签展示剩余限时额度与到期时间，并按本地 0 点起聚合的调用日志统计当日用量，每 60 秒自动刷新。支持平台账号登录或粘贴 tr_session 会话 Cookie 查询余额；API Key 与 Cookie 只存 host 进程内存与本地状态文件，浏览器侧仅显示掩码。"
  },
  "install": "dsh plugin --profile web add dsh-tokenrhythm-bill",
  "npm": "dsh-tokenrhythm-bill"
}
```

### 安装路线说明

市场按以下优先级选择安装源（`npm` > 同仓库 Release tarball > GitHub 源码）：

| 条目字段 | 安装行为 |
|----------|----------|
| `"npm": "dsh-tokenrhythm-bill"`（✅ 0.1.0 已发布，PR 里带上） | 秒级 npm 安装，无需构建脚本 |
| `tarball` 指向本仓库 Release 的 `.tgz` | 预构建安装（URL 必须属于本仓库，跨仓库会被拒绝） |
| 无 `npm` / `tarball` 时 | `github:162568316/dsh-tokenrhythm-bill`，整仓下载 |

npm 包 0.1.0 已发布并通过 `repository` 校验（`npm view dsh-tokenrhythm-bill repository.url` 返回本仓库）。

## npm 发布清单（0.1.0 ✅ 已完成，后续版本照此流程）

1. `package.json` 元数据已补齐：`repository` / `bugs` / `homepage` 指向本仓库
   （目录 CI 靠 `repository` 做 npm ↔ 仓库绑定校验，即 repo-verified）；
2. `npm login`；
3. `npm publish` —— `files` 字段已限定只发布 `lib`、`tests`、
   `cordis.patch.yml`、`LICENSE`、`README.md`；
4. 验证：`npm view dsh-tokenrhythm-bill repository` 应返回本仓库；
5. （可选）打 `git tag v0.1.0` 并创建 GitHub Release、附构建 `.tgz`，
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
