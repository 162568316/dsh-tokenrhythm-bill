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
    "en": "Tokenrhythm (基元律动) finance dashboard for DeepSeek Harness: balance & expiring credits, category-filtered model price cards (with discounts), an official-style service status view (24h / 7d / 90d) and platform key management, auto-refreshing every 60 s; login via platform account or session cookie — credentials stay on the local host only.",
    "zh": "基元律动费用中心：账户余额与限时额度、按分类筛选的模型价格卡（含折扣价）、官方同款服务状态（24小时 / 7天 / 90天）与平台密钥管理，60 秒自动刷新；支持平台账号或 Cookie 登录，凭据只存本机 host。"
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
   已有条目时**编辑现有条目**替换 `description` 为上面的短版即可；
3. 提交 PR 并在描述里放一句插件用途说明；
4. 合并后次日 CI 刷新 `plugins.json`，市场即可搜索、一键安装本插件。

收录之前，市场安装端只接受目录白名单内的源（安全设计），但手动安装始终可用：

```sh
dsh plugin --profile desktop add github:162568316/dsh-tokenrhythm-bill
```
