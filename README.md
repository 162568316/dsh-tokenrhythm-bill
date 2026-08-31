# dsh-tokenrhythm-bill

DeepSeek Harness（DSH）插件：**基元律动模型 / 余额 / 密钥面板**。

在 DSH 网页侧栏底部（设置按钮上方）加一个「¥ 基元律动-费用中心」入口，点开是一个可拖拽面板（内容只针对**基元律动**）：

- **模型 / 余额 / 密钥** — 面板页签共三枚（分段式按钮）：模型页签顶部有**分类筛选**（全部 / 文本 / 图像 / 音频 / 视频 / 向量，带计数，口径与平台模型列表页一致），下方以卡片网格展示模型（显示名、上下文、输入/输出/缓存单价、折扣价、图片单价、能力徽标），卡片右上角**连通状态点**可做手动单测（真实 1-token 推理请求：绿=连通+延迟、红=异常，60s 缓存防重复扣费；图像等非 chat 类型不支持）；余额页签主卡以**账户余额**为主数字，限时额度作副位并带**倒计时胶囊**（≤3 天转警示色）与**限时占比条**，下方为**当日使用**（本地 0 点起聚合调用日志）与**近 7 天花费柱状图**（悬停浮出当日各模型消费明细，Top 6 + 其他），每 60s 自动刷新；密钥页签可查看/新建平台 API Key。
- **设置（右上角 ⚙）** — 添加/切换基元律动账号，以及网页会话 Cookie 兜底粘贴。
- **样式** — 全量挂 DSH 设计令牌（`--dsw-alias-*`），明暗主题自动跟随 DSH，无本地配色；侧栏入口的收起/展开过渡与原生侧栏按钮同一套编排（宿主 `wide` 标志驱动）。

## 安装

把本目录放进目标 profile 的 `node_modules`（与 `dsh-music-player` 同款方式）：

```sh
cp -R dsh-tokenrhythm-bill ~/.dsh/profiles/<profile>/node_modules/
```

重启 DSH 后生效。`package.json` 已声明 `dsh.bundle.patch`（roster 插入）与 `dsh.client`（浏览器半区加载），无需其它配置。

## 配置余额查询（一次性）

面板「设置」页签（右上角 ⚛/⚙ 进入）→ 填写平台**账号和密码** → 点「登录并保存会话」。主机端直接调用平台登录接口换取网页会话（密码只用于本次请求，不落盘），无需 F12 复制任何东西。

登录接口不可用时的兜底：浏览器登录 [tokenrhythm.studio](https://tokenrhythm.studio) 后，F12 → 应用 → Cookie → 复制 `tr_session` 的值粘贴到「备用：粘贴网页会话 Cookie」框中保存（直接粘贴 `tr_session=sess_...` 整串也认）。

Cookie 过期后余额页签会出现黄条引导回「设置」重新登录。

## 安全边界

- API Key / 会话 Cookie 只存在 host 进程内存与 `~/.dsh/tokenrhythm-bill-state.json`（mode 0600，旧名 `model-balance-state.json` 首次启动自动迁移），**永不下发浏览器**；
- 所有对浏览器的响应只含掩码（如 `sk_tr…(49)`）；
- Key 读取次序：环境变量优先，其次 `~/.dsh/.credentials.yaml` 的 `refs` 段（键名 = settings 里的 `apiKeyEnv`）。

## 数据源

| 数据 | 来源 |
|------|------|
| 提供商清单 | `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers`（仅取 baseURL 含 tokenrhythm 的，flow / block 布局都支持） |
| 模型清单 | `GET {baseURL}/models`（baseURL 已带 /v1 时；Bearer API Key） |
| 余额 | `GET https://tokenrhythm.studio/api/usage-summary` + `/api/me`（`tr_session` Cookie） |
| 当日使用 | `GET /api/call-logs/page`（本地 0 点起翻页聚合） |
| 面板几何 | host 端 `/prefs` 持久化（不依赖 localStorage，重启不丢） |

## 开发

```sh
npm test   # node --test，解析器/归一化/掩码 14 个单测
```

目录结构：

- `lib/index.js` — host 半区：YAML 解析（纯函数，可测）+ `/dsh-tokenrhythm-bill/*` 路由 + 上游代理
- `lib/client.js` — browser 半区：侧栏入口按钮（「基元律动-费用中心」，收起态仅 ¥ 图标）+ 可拖拽三页签面板（React，经 `window.__ModuleLoader__` 加载）；样式全量引用 DSH 设计令牌，明暗自动跟随
- `tests/parsers.spec.mjs` — node:test 单测

## 已知限制

1. 余额仅支持基元律动；其余提供商显示「该提供商暂不支持余额查询」。
2. 模型列表以网关实时返回为准，settings.yaml 里的静态 models 仅用于 manifest 计数，不与 `/v1/models` 合并。
3. Key 缺失时模型页签明确显示原因（如「未读到 JY_API_KEY」），不静默空白。

## 插件市场收录

被 [dsh-market](https://github.com/dsh-market/dsh-market) 查询 / 安装需要进入其目录注册表
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：
目录条目草稿与 npm 发布步骤见 [MARKET-SUBMISSION.md](MARKET-SUBMISSION.md)。
