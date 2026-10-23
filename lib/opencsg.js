/**
 * OpenCSG（opencsg.com）协议层（纯函数；共用口径在 ./common.js）。
 *
 * 背景：OpenCSG（CSGHub / 星流）没有面向第三方的余额 API 文档。本模块复刻它自己的
 * 门户（csghub-portal，Vite + Vue 的 SPA）与后端（csghub-server，Go）的调用口径，
 * 证据来自四端：
 *   ① 门户前端产物逐字反解（金额格式化、账单口的行级字段与窗口默认值、邀请口的两个金额）；
 *   ② 平台**生产环境的 OpenAPI 规格是公开的**：`GET https://opencsg.com/api/v1/swagger/doc.json`
 *      （1.6 MB、366 条路径、basePath `/api/v1`）——**路径存在性以它为准**，别按惯例猜；
 *   ③ csghub-server 公开源码（handler / middleware / 信封结构 / 鉴权常量）；
 *   ④ 真发请求实测（IAM 登录体、SSO 回调 302）。
 * 与 tierflow.js / step.js 的分工一致：**本模块只做纯函数**（请求装配、信封解析、字段归一），
 * 网络 I/O、缓存、退避、凭据落盘都在 index.js —— 这样协议层可以脱离网络单测。
 *
 * 实测/反解坐实的关键结论（逐条都有请求、产物或源码证据）：
 *   1. 门户 `https://opencsg.com` 是 Vite + Vue 的 SPA（csghub-portal），后端是 Go 的
 *      csghub-server；**API 基址 `https://opencsg.com/api/v1`**（SPA 里的 ky 实例就是
 *      `baseUrl = ${CSGHUB_SERVER}/api/v1`），统一信封 `{code?, msg, data?, total?}`
 *      （csghub-server `api/httpbase/response.go` 的 `R{Code, Msg, Data, Total}`）。
 *   2. **鉴权是外部 Casdoor IAM**：`https://iam.opencsg.com`。判据：Casdoor 自己的静态资源
 *      （`/static/js/main.*.js`）只在该域名下 200；`https://opencsg.com/login` 返回的是同一份
 *      Casdoor HTML（HTML 200），但它引用的 `/static/js/main.*.js` 是 404 —— 说明那只是个
 *      **残留的反代**，真正的 IAM 在 iam.opencsg.com（所以登录体必须打到 OC_IAM，不是 OC_BASE）。
 *   3. 账号密码登录：`POST https://iam.opencsg.com/api/login`，请求体
 *      `{"application":"CSGShip","organization":"OpenCSG","username":…,"password":…,
 *       "autoSignin":true,"type":"code"}`。**type 必须是 "code"**：门户进登录页的唯一入口就是
 *      authorize（`GET https://opencsg.com/login` 现场实测 302 到
 *      `iam.opencsg.com/login/oauth/authorize?client_id=…&response_type=code&…`），Casdoor 自己
 *      的登录 SPA（web/src/pages/auth/LoginPage.tsx）把 `values.type = oAuthParams?.responseType`
 *      提交回去 —— 即 OAuth 流里的登录永远是 `type:"code"`，后端（controllers/auth.go 的
 *      authorization-code 分支）校验完密码**直接在登录响应里回授权码**（`data` = code），
 *      SPA 拿到 code 就 302 去 redirect_uri —— 根本不需要再访问一次 authorize。
 *      （原先写 `type:"login"`：那是不带 OAuth 参数的独立登录，`data` 回的是 userId 字符串，
 *      既不是令牌也不是授权码，探针必然打空 ——「登录成功但换不到令牌」的一半原因。）
 *      应用有两处坐实：门户 authorize URL 的 client_id=**`d623c957e69976c8a7a8`**（2025 现场
 *      `curl -I https://opencsg.com/login` 的 302 Location 逐字；应用标识就是这串随机码，
 *      旧记录里的 `client_id=CSGShip` 是错的——Casdoor 按 client_id 查应用，`CSGShip` 只是
 *      **应用名**，拿它当 client_id 查无此应用，authorize 必然回登录页）；`CSGShip` 作为
 *      **application 名**仍由 `GET /api/get-app-login` 回包 `name="CSGShip"` 坐实。
 *      **组织名是本轮踩的坑**：Casdoor 服务端 `controllers/auth.go` 把请求里的
 *      `organization` **原样**交给 `object.CheckUserPassword`，而 `object/user_util.go`
 *      的 `GetUserByFields` 每一个字段（name/email/phone/id/id_card）都按 organization 过滤
 *      —— 组织名传错 = 这个组织里查无此人 = 登录失败。更麻烦的是 **Casdoor 对「查无此人」
 *      与「密码错」回的是同一句**（本层已用必不存在的假用户名实测：照样只回「密码错误」，
 *      HTTP 200 + `status:"error"`），所以报错文案**不能反推**是哪一种，只能按组织候选逐个试。
 *      （早期这里写着「能走到密码错说明应用名/组织名是对的」——那句是错的，已按实测更正。）
 *   4. 仓内 API 只认三种 Bearer：系统 API token、**本地签发的 JWT**、以及访问令牌。
 *      本地 JWT 的来源是 `user/handler/user.go` 的 Casdoor 回调 → `component.Signin` →
 *      `generateLocalJWT`（claims 里带 `uuid` / `current_user` / `exp`），SPA 就是从
 *      `user_token` cookie 里那个 JWT 读 uuid 的。另有 `Authorization: OAuth <token>` 分支
 *      （`common/types/auth.go` 的 `HeaderOAuthPrefix = "OAuth "`）；社区版
 *      `api/middleware/authenticator_ce.go` 里 `isValidOAuthToken` 是个 `return false` 的桩，
 *      注释写明「OAuth token exchange is not supported in CE」——**所以 SaaS 版这条分支是活的，
 *      Casdoor token 有希望直接用作 `Authorization: OAuth …`**。登录后两条路（OAuth 头 /
 *      本地 JWT）本层都要能表达，故 `OC_AUTH_SCHEMES = ['OAuth', 'Bearer']` 按序试。
 *   5. SSO 回调 `GET https://opencsg.com/api/v1/callback/casdoor?code=…&state=casdoor`
 *      **实测活着**：拿假 code 请求 → `302` →
 *      `https://opencsg.com/errors/server-error?error_code=500&error_message=failed+to+signin%3A
 *      failed+to+get+token+from+casdoor…`（平台的错误也是这么透传出来的）。成功后按源码会
 *      `302` 到 `signinSuccessRedirectURL + '?jwt=' + 本地JWT`（`user/handler/user.go` 的
 *      `state == CASDOOR` 分支），所以**「本地 JWT」可以从这个 302 的 Location 里捞**——
 *      `ocTokenFromRedirect` / `ocCodeFromRedirect` 就是干这个的。
 *   6. **金额单位是「分」**，门户前端逐字：`(e.data.balance/100).toFixed(2)`、
 *      `(e.row.value/100).toFixed(8)`、`(e.row.amount_paid/100).toFixed(2)`。
 *      本层字段一律以 `Cents` 结尾存分，只在渲染时除 100（弄错就是 100 倍错账）。
 *   7. `casdoor_session_id` 是 IAM 侧的会话标识，必须自己从 Set-Cookie 里接住（Node 的 fetch
 *      没有 cookie jar）；与清枢智汇接 `session` 同一个坑。
 *   8. 账户卡片的三个读数各有出处（用户定案：账户余额 / API 调用量 / 待发放余额，
 *      并明确「不需要套餐」）：
 *        · 账户余额 `GET /api/v1/accounting/credit/{uuid}/balance` → `data.balance` 与
 *          `data.composition.{cash,bonus}`，都是分（实测 9898.31 = 现金 1.44 + 赠金 9896.87）。
 *          不带 uuid 的「自身余额」`/credit/balance` 是**管理员口，实测 403**。
 *        · API 调用量 `GET /api/v1/accounting/credit/{uuid}/bills?scene=15&…`——门户
 *          「API 调用量」页签用的就是它。scene 号：15 = LLM 调用（本插件用这条），
 *          16 = 多模态调用次数，10/11/12/14 = GPU 时长（只在 EE 的汇总里用）。
 *          窗口默认 = **本月 1 号 → 今天**（门户 `TQ()`/`SQ()`）。
 *        · 待发放余额 `GET /api/v1/invitations` → `data.pending_credit`（待发放）、
 *          `data.total_credit`（累计）、`data.invites`（人数），金额同为分。
 *      订阅（套餐）那一层**整体不取**：界面上任何位置都不再出现档位/订阅状态。
 *   9. API Key（AI Gateway 访问密钥）口（2026-10-17 实测 + 门户产物逐字反解，路径/字段见
 *      OC_PATH.apiKeyList / ocCreateApiKeyBody / ocNormalizeApiKeys 上方）：
 *        · 门户 `/settings/api-keys` 页（ApiKeysManager 组件，产物 `apiPaths` 逐字）：
 *          list/create 都是 `/namespaces/{ns}/apikeys`，编辑 = PUT `/{id}`，状态切换 =
 *          PUT `/{id}/status`（body `{is_active}`），删除 = DELETE `/{id}`，内置刷新 =
 *          PUT `/builtin/refresh`。**公开 OpenAPI 规格里没有这组路径**（swagger 比门户旧），
 *          路径存在性以门户产物为准、生产环境实测坐实。
 *        · namespace 是**用户命名空间的 uuid**：实测与本地 JWT claims 里的 `uuid` 同值
 *          （`GET /api/v1/user/{name}` → `data.namespaces[].Type=='user'` 的 UUID ===
 *          claims.uuid，2026-10-17 次账号实测）；按用户名拼路径恒 500（SYS-ERR-3
 *          Record not found）——所以宿主直接用账单口那个 uuid，不再多问一次用户信息口。
 *        · 列表信封 `{msg:"OK", data:[rows]}`（**单层**，行数组直接在 data）；行里
 *          `token` 是**服务端掩码**（如 `gk***36`），明文只在创建响应 `data.token` 出现
 *          **一次**——门户自己也不在列表里回明文，「历史密钥只显示掩码」的隐私口径
 *          服务端天然满足；平台没有「按 id 单取完整值」的口（门户也只有创建时一次性展示）。
 *        · 创建体 `{name, expired_at, quotas}`：`expired_at` 无过期 = 2099 年底的 ISO
 *          （门户 `moment("2099-12-31T23:59:59").toISOString()`，本地时区换算）；`quotas`
 *          至少带一条 fee unlimited（门户 `u4e` 恒推 `l("fee",{…},!0)`，不限流时 quota=0）。
 *        · 列表行 `token_type` 是 `builtin`/`custom`，创建响应却是 `owner`（三个值是三个
 *          语义：内置 / 自建 / 归属者回显）——归一时按「builtin 或 default 算内置」判。
 *        · 内置 key **不可删**（门户删除按钮只挂在自建行上）；本插件只做 列表/创建/删除，
 *          状态切换、编辑、内置刷新不做（用户要的是「创建 key 的卡片」，够用原则）。
 *        · **本机留存**（用户定稿「新创建的密钥。存到本地」）：创建响应里的明文在落一份到
 *          本机 0600 state（state.oc.savedKeys，按账号分槽），此后列表里能认出的行挂着
 *          「复制完整值」。平台本身没有这个能力（明文出处就创建响应那一处、且创建时
 *          忘复制就永远拿不回来），门户也只在创建时展示一次——本机留存是对「只显示一次」
 *          这个平台行为的**本地补救**，密钥照旧只在 host 内存与本机文件里过，不进浏览器
 *          持久化、不进日志、不进任何响应（除了那一条显式的单取路由，宿主侧
 *          ocKeyRevealLocal）。归一/净化在本层（ocSavedKeyEntry / ocNormalizeSavedKeys），
 *          与 sanitizeOcSessions 的「池外丢弃」同一套安全姿态。
 */

import {
  cookieEntries, cookieHeader, isObj, jwtPayload, makeCodeText, makeDeterministicFailure, num, pickNum, str, tsToMs,
} from './common.js'

// ---------------------------------------------------------------- 平台常量（焊死）

/** 门户与 API 基址（API 基址 = OC_BASE + '/api/v1'）。*/
const OC_BASE = 'https://opencsg.com'

/**
 * 外部 IAM（Casdoor 自建实例）。登录、令牌、SSO 授权都挂在这个域名下，
 * **不在 OC_BASE**（opencsg.com/login 只是残留反代，见头部结论 ②）。
 */
const OC_IAM = 'https://iam.opencsg.com'

/** 浏览器实测 UA。平台对 UA 没有硬校验，但照抄真身可以少一类「为什么它能过我不能」的排查成本。*/
const OC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0'

/**
 * 端点（值就是路径字符串；`casdoor*` 挂 OC_IAM，其余挂 OC_BASE）。
 * 路径存在性以公开 OpenAPI 规格（basePath `/api/v1`）与前端产物为准，别按惯例猜。
 */
const OC_PATH = {
  // ---- IAM（Casdoor，挂在 OC_IAM）
  casdoorLogin: '/api/login',
  casdoorAuthorize: '/login/oauth/authorize',
  casdoorAppLogin: '/api/get-app-login',
  // ---- 门户（挂在 OC_BASE）
  ssoCallback: '/api/v1/callback/casdoor',
  // 余额口是「带 uuid」的管理员口（/credit/{uuid}/balance），自身余额另有专门的一段路径，
  // 两条都在规格里。前缀常量与拼接函数都留着：host 需要前缀做日志/匹配，也需要函数拼 uuid。
  balance: '/api/v1/accounting/credit/',
  balanceOf: (uuid) => '/api/v1/accounting/credit/' + encodeURIComponent(uuid) + '/balance',
  selfBalance: '/api/v1/accounting/credit/balance',
  // 账单口（逐场景用量）：`/accounting/credit/{uuid}/bills?scene=…&start_date=…&end_date=…&per=&page=`。
  // 「API 调用量」用 scene=15（见 OC_BILL_SCENE_API）。规格里 `start_date`/`end_date`/`current_user`
  // 都标着 required，而门户自己**只发前两个**（`ya()` 里逐字只有 per/page/start_date/end_date/
  // scene/instance_name）——`current_user` 由服务端从令牌里补，我们照门户的样，不自己编一个。
  bills: '/api/v1/accounting/credit/',
  billsOf: (uuid) => '/api/v1/accounting/credit/' + encodeURIComponent(uuid) + '/bills',
  // 邀请（拉新）口：`GET /api/v1/invitations` 回邀请码与两个金额——`pending_credit`（待发放）
  // 与 `total_credit`（累计），金额同为分。门户 `/profile/invite/ali` 逐字渲染这两个数
  // （`profile.invite.pendingEarnings` → `M(U.pending_credit)`，`M` 里是 `(Math.floor(e)/100).toFixed(2)`）。
  invitations: '/api/v1/invitations',
  // API Key（AI Gateway 访问密钥）口：门户 `/settings/api-keys` 页用的就是这一组。
  // **namespace 是用户命名空间的 uuid**，实测与本地 JWT claims 的 `uuid` 同值（见头部结论 ⑨）：
  // 按用户名拼恒 500。两个函数都留着（列表/创建同一路径、删除/编辑/状态挂 `/{id}`）。
  apiKeyList: (ns) => '/api/v1/namespaces/' + encodeURIComponent(ns) + '/apikeys',
  apiKeyItem: (ns, id) => '/api/v1/namespaces/' + encodeURIComponent(ns) + '/apikeys/' + encodeURIComponent(String(id)),
  models: '/aigateway/v1/models',
  userByName: (u) => '/api/v1/user/' + encodeURIComponent(u),
}

/**
 * Authorization 前缀的**两种候选，按序试**（实测待定项，见头部结论 ④）：
 *   - `OAuth`  —— 平台源码里 `HeaderOAuthPrefix = "OAuth "` 这条分支，CE 版是 `return false`
 *                  的桩，SaaS 版活着，Casdoor token 有希望直接吃；
 *   - `Bearer` —— 系统 API token / 本地 JWT / 访问令牌都走这条。
 * 本层不替 host 挑，只保证两种都能表达（`ocAuthHeaderValue` / `ocHubHeaders`）。
 */
const OC_AUTH_SCHEMES = ['OAuth', 'Bearer']

/**
 * 「API 调用量」那一栏的 scene 号：**15**。
 *
 * 出处在门户产物里是两条独立线索，互相印证：
 *   ① 取数函数 `Ua` 拼的是 `/accounting/credit/{uuid}/bills?...&scene=15`，回包喂给
 *      `ee.value = e.data.data || []`、`ae.value = e.data.total || 0`、
 *      `te.value = (Math.abs(e.data.total_value || 0) / 100).toFixed(2)`；
 *   ② 同一页的 `apiCalls` 页签（标题取 `billing.apiCalls`，即「API 调用量」）渲染的正是
 *      `ee.value` 这批行，表头列是 `billing.apiId` / `inputTokens` / `outputTokens` /
 *      `reasoningTokens` / `promptCachedToken` / `cost`，合计行写 `${currencyName} ${te.value}`。
 * 于是「栏名 → scene 号 → 回包字段」是一条链子，不是猜的。
 * 另外 EE 的汇总 `ba()` 里 `ie=We(s(15),'total_consumption')` 也把 scene 15 当 LLM token 总量用。
 */
const OC_BILL_SCENE_API = 15

/**
 * 账单口每页条数（门户口径的兜底值）。**门户分页组件的 perPage 初值就是 10**；卡片上那两个数
 * （接口数 `total`、本期金额 `total_value`）都是**服务端按整个窗口算的**，与分页无关——
 * 「账户」页只吃这两个窗口数，10 够用。「用量」页要按接口拆分，走的是下面的
 * `OC_BILL_USAGE_PER_PAGE`（实测坐实 100 可用）+ 宿主翻页取全量，不用这个兜底值。
 */
const OC_BILL_PER_PAGE = 10

/**
 * 「用量」页取账单用的每页条数：**实测坐实 100 可用、500 被平台直接拒（HTTP 400）**
 * （2026-10-17 拿自己账号的 uuid 打账单口，per=10/50/100 都正常回包，per=500 回 400）。
 * 放大到 100 的原因不是「少打几次」，而是**按接口拆分的份额必须建立在完整的行集上**：
 * 首页 10 条只能说明「前 10 条」，份额、接口数、调用次数在这种行集上算出来都是错的。
 * 一行不满 100 就说明已经取完（宿主据此停止翻页），所以轻量账号仍然只打一次。
 */
const OC_BILL_USAGE_PER_PAGE = 100

/** 翻页硬上限（100 × 5 = 500 行）：超了就停，界面标「仅前 N 条」，不拿部分行冒充整窗口。*/
const OC_BILL_MAX_PAGES = 5

/**
 * Casdoor 密码登录要的两个身份参数：`application` / `organization`。
 *
 * `CSGShip` 有**两处独立实测**坐实：① 门户自己的授权 URL（从本机 Edge 历史里挖到的原文）
 * `client_id=CSGShip`；② `GET iam.opencsg.com/api/get-app-login` 回包 `name="CSGShip"`。
 *
 * `organization` 是**这次踩的坑**：Casdoor 服务端 `controllers/auth.go` L981 把请求里的
 * `organization` **原样**传给 `object.CheckUserPassword(organization, username, …)`，而
 * `object/user_util.go` 的 `GetUserByFields` 查询**每一个字段（name/email/phone/id/id_card）
 * 都按 organization 过滤**。也就是说组织名传错 → 这个组织里查无此人 → 登录失败。
 * 而 Casdoor 对「查无此人」和「密码错」**回的是同一句**（本层已用假用户名实测：必不存在的
 * 用户名照样只回「密码错误」，HTTP 200 + status=error），于是表现成用户那句话：
 * 「明明账号密码正确 登录不上」。
 * 原来这里填的 `built-in` 是 Casdoor 自带示例应用 `app-built-in` 的组织（照抄文档留下的），
 * 而 `get-app-login` 对本站回的是 `organization="OpenCSG"` —— 与 `application` 同源、
 * 也是门户登录页拿去提交的那份配置，故以它为准。
 */
const OC_CASDOOR_APP = 'CSGShip'
const OC_CASDOOR_ORG = 'OpenCSG'

/**
 * OAuth **client_id**（应用标识，随机码）——`2025 现场实测`：`GET https://opencsg.com/login`
 * 回 `302` → Location 逐字为
 * `https://iam.opencsg.com/login/oauth/authorize?client_id=d623c957e69976c8a7a8
 *  &response_type=code&redirect_uri=https://opencsg.com/api/v1/callback/casdoor
 *  &scope=read&state=casdoor`。
 *
 * 这条 302 是门户服务端自己发的，是**当前**应用的权威标识。旧的 `client_id=CSGShip`
 * 是把应用名当成了 client_id —— Casdoor 的 authorize 用 client_id 查应用
 * （`object.GetApplicationByClientId`），`CSGShip` 不是任何应用的 client_id，
 * 查无此应用 → 不发 code、回落到登录页（200 HTML、无 code、无 error 参数），
 * 正是「IAM 没有认下这枚会话 cookie（回到了登录页）」的另一半真因。
 * 它与 `OC_CASDOOR_APP`（应用名，登录体里用）是**两个东西**，别再合并成一个常量。
 */
const OC_CASDOOR_CLIENT_ID = 'd623c957e69976c8a7a8'

/**
 * `organization` 的**候选序列**：第一个是上面坐实的主值，后面是「万一用户不在主组织里」的兜底。
 *
 * 为什么需要兜底而不是只填一个：Casdoor 的失败文案是反枚举的（见上），组织传错和密码错
 * **在报文上完全无法区分**，我们没有任何办法在本地判断哪个组织才是用户所在的。而一个用户
 * 只可能住在**一个**组织里，所以兜底尝试**最多只会真正校验一次密码**（其余组织查无此人、
 * 连密码都不会比对，也不会给用户记错误次数——错误次数是存在 User 记录上的）。
 * `built-in` 是 Casdoor 原生默认组织，留作最后一条。
 */
const OC_CASDOOR_ORG_FALLBACKS = ['built-in']

/**
 * 组织候选去重（保持顺序、丢掉空白项）。纯函数：host 拿它逐个试，协议层负责「试哪些、按什么序」。
 * 不传主值时用 `OC_CASDOOR_ORG`；重复项（含主值本身出现在兜底里的情况）只留第一次出现的位置。
 */
function ocCasdoorOrgCandidates(primary) {
  const head = typeof primary === 'string' && primary.trim() !== '' ? primary : OC_CASDOOR_ORG
  const out = []
  for (const v of [head, ...OC_CASDOOR_ORG_FALLBACKS]) {
    const s = typeof v === 'string' ? v.trim() : ''
    if (s === '' || out.includes(s)) continue
    out.push(s)
  }
  return out
}

// ---------------------------------------------------------------- 小工具（缺失 ≠ 0）

// 数字 / 字符串 / 普通对象 / 容错取键：口径与清枢、阶跃、ZCode 共用一套（见 common.js）。
const ocNum = num
const ocStr = str
const ocIsObj = isObj
const ocPickNum = pickNum

/**
 * 时间戳归一 → 毫秒（三种口径与 -1 哨兵的处理见 common.js 的 tsToMs；与清枢 `tfTsToMs`
 * 同一做法）。
 */
const ocTsToMs = tsToMs

// ---------------------------------------------------------------- 请求装配

/**
 * 账号密码登录体（Casdoor 口径）→ **JSON 字符串**（host 直接拿去当 POST body）。
 *
 * 字段名与顺序逐字来自实测：`{application, organization, username, password, autoSignin, type}`
 * —— 字段就叫 `username`（不是 identifier/email），Casdoor 自己按内容认邮箱还是用户名
 * （`object/user_util.go` `GetUserByFields`：name → email（含 @ 时）→ phone → id → id_card）。
 *
 * **type 用 "code" 而不是 "login"**（见头部结论 3）：门户进登录页的唯一入口是 authorize，
 * Casdoor 登录 SPA 把 `values.type = oAuthParams?.responseType`（= "code"）原样提交；
 * 服务端在 authorization-code 分支里校验完密码**直接回授权码**（`data` = code）。
 * `type:"login"` 是独立登录：`data` 回 userId 字符串，既非令牌也非授权码。
 *
 * 应用/组织默认取 `OC_CASDOOR_APP` / `OC_CASDOOR_ORG`（见那两处的取证说明）。
 * **注意**：这两个默认值的旧值是 Casdoor 示例应用的 `app-built-in`/`built-in`，当时的「实测」
 * 其实是用**空密码**打的，回「密码错误」是必然结果、并不能证明这对参数可用——已纠正。
 * host 侧永远是显式传入，默认值只服务于测试与单点调用。
 *
 * 返回字符串而不是对象：host 侧要用它直接发请求、算长度；字符串只有一种形态，少一层
 * 序列化歧义，字段顺序也与实测请求体一致（便于和服务端日志逐字对照）。
 */
function ocLoginBody(identifier, password, opts) {
  const o = ocIsObj(opts) ? opts : {}
  const application = ocStr(o.application).trim() !== '' ? o.application : OC_CASDOOR_APP
  const organization = ocStr(o.organization).trim() !== '' ? o.organization : OC_CASDOOR_ORG
  return JSON.stringify({
    application,
    organization,
    username: typeof identifier === 'string' ? identifier : (identifier === undefined || identifier === null ? '' : String(identifier)),
    password: typeof password === 'string' ? password : (password === undefined || password === null ? '' : String(password)),
    autoSignin: true,
    type: 'code',
  })
}

/**
 * `/api/login` POST 的 **query 串**（含前导 `?`；无参时回 ''）。
 *
 * 为什么登录体之外还要挂一串 query：Casdoor 服务端在 authorization-code 分支里读的
 * OAuth 参数**全部取自 query**（controllers/auth.go：`c.Ctx.Input.Query("clientId")` 等，
 * camelCase），登录体（JSON body）里没有这些字段；Casdoor 登录 SPA 的提交就是
 * `POST /api/login${oAuthParamsToQuery(oAuthParams)}`（web/src/backend/AuthBackend.ts），
 * query 名与顺序逐字照抄它：`clientId / responseType / redirectUri / type / scope / state /
 * nonce / code_challenge_method / code_challenge`（后三个本链路为空，仍按 SPA 的样带上，
 * 便于和服务端日志逐字对照）。
 *
 * client_id 取 `OC_CASDOOR_CLIENT_ID`（应用标识）；redirectUri 取门户 SSO 回调
 * （= authorize 用的那一个，服务端会校验 code 的 redirect_uri 与签发时一致，两边必须同值）。
 * 纯函数：输入不齐（缺 clientId/redirectUri）回 ''，让 host 跳过 query、走纯 body 登录——
 * 宁可少一串参数，也不发半截错误的 URL。
 */
function ocLoginQuery(opts) {
  const o = ocIsObj(opts) ? opts : {}
  const clientId = ocStr(o.clientId).trim() !== '' ? o.clientId : OC_CASDOOR_CLIENT_ID
  const redirectUri = ocStr(o.redirectUri).trim()
  if (clientId === '' || redirectUri === '') return ''
  const scope = ocStr(o.scope).trim() !== '' ? o.scope : 'read'
  const state = ocStr(o.state).trim() !== '' ? o.state : 'casdoor'
  return '?' + [
    'clientId=' + encodeURIComponent(clientId),
    'responseType=code',
    'redirectUri=' + encodeURIComponent(redirectUri),
    'type=code',
    'scope=' + encodeURIComponent(scope),
    'state=' + encodeURIComponent(state),
    'nonce=',
    'code_challenge_method=',
    'code_challenge=',
  ].join('&')
}

/**
 * IAM（Casdoor）请求头。**不允许在这里编造任何凭据**：`/api/login` 就是匿名口，凭据在 body 里；
 * 带一个空的 `authorization` 反而会被 Casdoor 当坏令牌拒掉（错误就从「密码错」漂成「令牌无效」，
 * 排查方向全错）。凭据与令牌由 host 通过 `extra` 显式传入（同名字段覆盖默认值）——这是本层
 * 「不编凭据」规矩的唯一出口。
 */
function ocIamHeaders(extra) {
  const h = {
    accept: 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    'user-agent': OC_UA,
  }
  if (ocIsObj(extra)) {
    for (const k of Object.keys(extra)) if (extra[k] !== undefined) h[k] = extra[k]
  }
  return h
}

/**
 * 仓内 API（OC_BASE）请求头。`input = { token, scheme }`。
 *
 * **没有 token 时必须完全省略 Authorization**（照 tfHeaders 的规矩）：发一个
 * `Authorization: Bearer `（空值）会把「还没登录」变成「令牌无效」，错误码就从 OC_NO_TOKEN
 * 漂成 OC_UNAUTHORIZED，让人去查令牌，而真实原因只是没配。
 * 有 token **但没给 scheme 时也不发**：前缀是实测待定项（见 OC_AUTH_SCHEMES），猜一个前缀
 * 等于把「这条没试过」写成「试过了」，host 的按序试逻辑就被悄悄短路了。
 * 不带 `content-type`（本层以 GET 为主，POST 由 host 按需加）。
 */
function ocHubHeaders(input) {
  const o = ocIsObj(input) ? input : {}
  const h = {
    accept: 'application/json',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent': OC_UA,
  }
  const token = typeof o.token === 'string' ? o.token.trim() : ''
  const scheme = typeof o.scheme === 'string' ? o.scheme.trim() : ''
  if (token !== '' && scheme !== '') h.authorization = ocAuthHeaderValue(scheme, token)
  return h
}

/** Authorization 头值 `<前缀> <令牌>`；前缀或令牌为空 → ''（绝不吐出半截头，见 ocHubHeaders）。*/
function ocAuthHeaderValue(scheme, token) {
  const s = typeof scheme === 'string' ? scheme.trim() : ''
  const t = typeof token === 'string' ? token.trim() : ''
  if (s === '' || t === '') return ''
  return s + ' ' + t
}

/**
 * Set-Cookie 归一（拼接串怎么切、Expires 里的逗号为什么不能当分隔符 → 见 common.js）。
 */
const ocCookieEntries = cookieEntries

/**
 * Set-Cookie 列表 → 单个 Cookie 请求头值。
 *
 * 用途：**接住 Casdoor 登录响应的 `casdoor_session_id`**（IAM 侧认人的会话标识；Node 的 fetch
 * 没有 cookie jar，不接住就丢）。只取每条的 `name=value` 段，属性（Path/HttpOnly/SameSite/
 * Expires…）全丢——属性不是浏览器该回传的东西。
 *
 * 同名 cookie 的重名规则：**取最后一个非空值**（理由见 ocCookieHeaderValue）。
 */
function ocCookieFromSetCookie(raw) {
  return ocCookieHeaderValue(ocCookieEntries(raw))
}

/**
 * `name=value` 段列表 → Cookie 请求头值（`a=b; c=d`）。
 *
 * 与 ocCookieFromSetCookie 同一口径（重名取**最后一个非空值**、没有 `=` 的段直接丢），
 * 单独导出是给「cookie 要跨多个响应累加」的场合用：SSO 那条链路先接
 * `casdoor_session_id`，再换本地 JWT，两段 Set-Cookie 得合起来回传。
 *
 * 重名为什么取「最后一个非空」而不是 tierflow 那边的「第一个」：浏览器就是后到的覆盖先到的
 * （RFC 6265 §5.3），我们拿它的会话 cookie 去换授权码就得跟浏览器一致；而「空值不覆盖非空」
 * 是额外一层保险——真值之后跟一条清理用的 `Max-Age=0` 时别把刚建立的会话抹掉。
 * 两种重名规则都在 common.js 的 cookieHeader 里，靠 prefer 区分。
 */
function ocCookieHeaderValue(pairs) {
  return cookieHeader(pairs, { prefer: 'last' })
}

// ---------------------------------------------------------------- JWT / 重定向

/**
 * JWT 第二段（payload）解码 → 对象；失败 / 解出非对象 → null。
 *
 * **不做签名校验**（本层零依赖，只用来读 `uuid` / `current_user` / `exp` 这类非敏感声明，
 * 真正的校验永远在平台侧）。解码口径（base64url 无 padding）与阶跃、ZCode 共用，见 common.js。
 */
function ocJwtClaims(token) {
  const v = jwtPayload(token)
  return ocIsObj(v) ? v : null
}

/**
 * `exp`（秒）→ 毫秒；没有 / 不是数字 → null。
 * 判「过没过期」用 ocJwtExpired，**不要拿 null 当 0**（0 会被读成 1970 年就过期了）。
 */
function ocJwtExpMs(token) {
  const claims = ocJwtClaims(token)
  if (claims === null) return null
  const exp = ocNum(claims.exp)
  return exp === null ? null : Math.trunc(exp * 1000)
}

/**
 * 令牌是否已过期。**没有 `exp` 视为未过期**：平台自己签的本地 JWT 必带 `exp`
 * （`generateLocalJWT` 的 claims），但外部 Casdoor 发的令牌不保证带；把「读不到 exp」
 * 当成已过期会让人白重登一次（还会把一个其实能用的令牌丢掉）。过期与否最终由平台的 401 回答。
 */
function ocJwtExpired(token, nowMs) {
  const expMs = ocJwtExpMs(token)
  if (expMs === null) return false
  const now = ocNum(nowMs)
  return (now === null ? Date.now() : now) >= expMs
}

/**
 * 从 Location（**可能是相对路径**）里取查询参数；取不到 → ''。
 *
 * 为什么不直接 `new URL()`：SSO 回调实测回来的两条 Location 一条是绝对地址
 * （成功时 `signinSuccessRedirectURL + '?jwt=…'`）、一条是相对路径
 * （`/errors/server-error?error_code=500&error_message=…`）；这里手写解析，两种都能吃，
 * 也不会因为一个畸形地址就抛异常把整条登录链打断。
 * `+` 按 query 的规矩还原成空格（平台的 error_message 就是 `failed+to+signin%3A…` 这种），
 * `decodeURIComponent` 失败（半截百分号）就原样返回，不吞掉。
 */
function ocRedirectParam(location, name) {
  if (typeof location !== 'string' || location === '') return ''
  if (typeof name !== 'string' || name === '') return ''
  const q = location.indexOf('?')
  if (q < 0) return ''
  let s = location.slice(q + 1)
  const h = s.indexOf('#')
  if (h >= 0) s = s.slice(0, h)
  for (const part of s.split('&')) {
    if (part === '') continue
    const eq = part.indexOf('=')
    const k = eq < 0 ? part : part.slice(0, eq)
    if (k !== name) continue
    const v = eq < 0 ? '' : part.slice(eq + 1)
    try {
      return decodeURIComponent(v.replace(/\+/g, ' '))
    } catch (e) {
      return v
    }
  }
  return ''
}

/** SSO 回调成功时的**本地 JWT**（`302 …?jwt=…`，见头部结论 ⑤）。*/
function ocTokenFromRedirect(location) {
  return ocRedirectParam(location, 'jwt')
}

/** SSO 回调里 Casdoor 给的授权码（`?code=…&state=casdoor`）。*/
function ocCodeFromRedirect(location) {
  return ocRedirectParam(location, 'code')
}

// ---------------------------------------------------------------- 统一信封

/**
 * 信封归一。平台的统一信封是 `{code?, msg, data?, total?}`（csghub-server
 * `api/httpbase/response.go` 的 `R{Code, Msg, Data, Total}`）：**成功只有 `msg:"OK"`**，
 * 失败是**非 2xx + `{code, msg}`**（不像清枢智汇那样用 HTTP 200 装业务失败）。
 * 判定：
 *   - `ok = 2xx && !body.code`（平台成功不给 code；给了 code 就是业务失败，哪怕状态码 200）
 *   - `authFailed = 401 || 403`（**403 也算**：仓内鉴权中间件对「令牌有效但无权」就回 403，
 *     对面板来说和 401 一样要重登/换账号）
 *   - `message = body.msg`（字段名是 **msg**，不是 message/tip——照搬会永远拿到空串，
 *     界面上就只剩一个错误码，等于把平台的原话丢了）
 *   - body 不是对象 → 结构不可识别：非 2xx 时给 OC_HTTP（网关/反代吐的错误页，当成功处理会
 *     拿 null 去猜字段），2xx 时给 OC_SHAPE
 */
function ocEnvelope(status, body) {
  const n = ocNum(status)
  const http = n === null ? 0 : Math.trunc(n)
  const authFailed = http === 401 || http === 403
  const notOkHttp = http !== 0 && (http < 200 || http >= 300)
  const j = ocIsObj(body) ? body : null
  if (j === null) {
    return {
      ok: false,
      code: authFailed ? 'OC_UNAUTHORIZED' : (notOkHttp ? 'OC_HTTP' : 'OC_SHAPE'),
      message: '',
      data: null,
      total: null,
      status: http,
      authFailed,
    }
  }
  const rawCode = j.code
  // code 可能是数字（Go 的 int 字段）：统一成字符串，界面/文案层只认字符串；
  // **falsy（0 / ''）一律当没有 code**——0 是「成功」的标记，不是业务码，别让它变成字符串 '0'
  // 去骗调用方的 `code === ''` 判断。
  const code = rawCode ? (typeof rawCode === 'string' ? rawCode : String(rawCode)) : ''
  const message = ocStr(j.msg)
  const total = j.total === undefined ? null : j.total
  if (authFailed) {
    return { ok: false, code: code !== '' ? code : 'OC_UNAUTHORIZED', message, data: null, total: null, status: http, authFailed: true }
  }
  if (!(http >= 200 && http < 300) || rawCode) {
    return { ok: false, code: code !== '' ? code : 'OC_HTTP', message, data: null, total: null, status: http, authFailed: false }
  }
  return { ok: true, code, message, data: j.data === undefined ? null : j.data, total, status: http, authFailed: false }
}

// ---------------------------------------------------------------- 文案

/**
 * 平台业务码 / 本层自定义码 → 中文（映射表见下；没映射到回平台原文，口径与清枢共用
 * common.js 的 makeCodeText）。
 */
const OC_CODE_TEXT = {
  OC_UNAUTHORIZED: '登录已失效，请重新登录',
  OC_NET: '网络请求失败',
  OC_HTTP: '平台返回异常状态',
  OC_SHAPE: '平台返回结构无法识别',
  OC_NO_TOKEN: '登录成功但没拿到令牌',
  OC_LOGIN_FAILED: '账号或密码不正确',
  OC_COOLDOWN: '请求过于频繁，请稍后再试',
  OC_DISABLED: '该账号已被平台禁用',
  NO_OC_ACCOUNT: '没有可用的 OpenCSG 账号',
}

const ocErrorText = makeCodeText(OC_CODE_TEXT)

// ---------------------------------------------------------------- 金额（单位是「分」，最容易错）

/**
 * 金额归一 → **分**。非有限数 → null。
 *
 * 单位是门户前端逐字坐实的「分」（头部结论 ⑥ 的三条证据）。数字字符串也吃：Go 把大整数
 * 序列化成字符串是常态，`/100` 之前必须先变成数。
 * **不做取整**：平台既然按「分」存，正常都是整数；真出现小数（按 token 计费的单价折算）
 * 就原样保留，截断等于替平台改账。
 */
function ocCents(v) {
  return ocNum(v)
}

/**
 * 分 → 显示文案。**null → '—'**：余额字段缺失（请求失败 / 平台改版）时绝不能渲染成 ¥0.00
 * ——「0 元」和「问不到」在面板上是两件事，前者让人以为钱没了，后者只是这次没答上来。
 */
function ocYuanText(cents) {
  const c = ocCents(cents)
  if (c === null) return '—'
  return '¥' + (c / 100).toFixed(2)
}

// ---------------------------------------------------------------- 时间窗口 / 查询串

/**
 * 账单口（逐场景用量）的查询串。**顺序照门户**（取数函数 `Ua` 与 `ya()` 的 append 次序）：
 * per → page → start_date → end_date → scene，便于和服务端日志/抓包逐字对照。
 *
 * 两个「不发」的字段各有一条实测理由：
 *   · `current_user` —— 规格里标着 required，**门户自己一个字都不发**（`ya()` 里没有它），
 *     说明服务端是按令牌里的身份补的。我们跟着不发：自己填一个用户名，等于替服务端指定
 *     「查谁的账」，门户没这个动作，我们也不做。
 *   · `instance_name` —— 门户只在筛选框有值时才发（`l && e.append("instance_name", l)`）。
 *     我们不做筛选，所以永远不发。
 * `start_date` / `end_date` 是 `YYYY-MM-DD`（门户 `SQ()` 就是这个格式，服务端按天收）。
 */
function ocBillsQuery(opts) {
  const o = ocIsObj(opts) ? opts : {}
  const scene = ocNum(o.scene)
  const per = ocNum(o.per)
  const page = ocNum(o.page)
  const parts = []
  parts.push('per=' + encodeURIComponent(String(per === null ? OC_BILL_PER_PAGE : per)))
  parts.push('page=' + encodeURIComponent(String(page === null ? 1 : page)))
  parts.push('start_date=' + encodeURIComponent(ocStr(o.fromDate)))
  parts.push('end_date=' + encodeURIComponent(ocStr(o.toDate)))
  parts.push('scene=' + encodeURIComponent(String(scene === null ? OC_BILL_SCENE_API : scene)))
  const name = ocStr(o.instanceName).trim()
  if (name !== '') parts.push('instance_name=' + encodeURIComponent(name))
  return parts.join('&')
}

/**
 * 一个 Date → **本机时区**的 `YYYY-MM-DD`（服务端按这个格式收日期，`2026-1-5` 是非法日期）。
 * 月窗口与今日窗口共用这一份：两个窗口口径必须同源，各写一遍迟早会在补零/时区上分叉。
 */
function ocLocalYmd(d) {
  const p = (x) => String(x).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/**
 * 账单窗口默认值 = **本月 1 号 → 今天**，逐字对齐门户那两个函数：
 *   `TQ()` = 当月 1 号（`new Date(年, 月, 1)` 再格式化成 `YYYY-MM-DD`），
 *   `SQ()` = 今天。
 * 门户把这两个值当计费区间的初值（`Re=$(TQ())` / `Fe=$(SQ())`），所以本插件里「本期」的含义
 * 与门户一致——**不是「近 30 天」，就是本月至今**。
 *
 * 用**本机时区**（`new Date(y, m, 1)` 走本地日历）：面板上写的是「本月」，读者对的是自己的
 * 日历；换成 UTC 会在每月 1 号前后把跨月的那几个小时算错一天。
 */
function ocMonthWindow(nowMs) {
  const n = ocNum(nowMs)
  const d = new Date(n === null ? Date.now() : n)
  return { fromDate: ocLocalYmd(new Date(d.getFullYear(), d.getMonth(), 1)), toDate: ocLocalYmd(d) }
}

/**
 * 「今日」账单窗口 = **今天 → 今天**（用量页那一格「今日」，v0.7.3）。
 *
 * 为什么必须**另开一次请求**、而不是拿月窗口的行按 `created_at` 切天：见 `ocNormalizeBills`
 * 上方那段——行的 `created_at` 是**记录生成时刻**，同一接口在月窗口里只出一行，多行的
 * `created_at` 还会落在不同的日子里（2026-10-19 实测：月窗口三行的 created_at 落在 10-16 与
 * 10-17 两天，而这两天的用量并不等于那两行）。拿它切「今日」就是编。
 *
 * 而 `start_date`/`end_date` 是**服务端真的会过滤**的（2026-10-19 实网坐实）：同一天
 *   · 月窗口 `2026-10-01 ~ 2026-10-19` → 798 次调用 / 93,458,176 token / -3177.023324 分
 *   · 今日   `2026-10-19 ~ 2026-10-19` →  24 次调用 /  1,654,251 token /  -233.309292 分
 *   · 昨日   `2026-10-18 ~ 2026-10-18` → 552 次调用 / 70,735,547 token / -2485.181698 分
 *   · 宽窗口 `2020-01-01 ~ 2030-01-01` → 与月窗口**逐位相同**（都在窗口内，本该相同）
 * 再把 10-16 ~ 10-19 逐天问一遍，四天合计（798 / 93,458,176 / -3177.023324）与月窗口信封
 * **逐位相符**——说明单日窗口不是「近似」，是与窗口合计同一把尺子，且日界就取本机日历日
 * （10-17 那天唯一一行的记录时刻是本地 10-17 00:36，落在 10-17 的窗口里）。
 *
 * 时区口径与 ocMonthWindow 同一条：**本机日历日**（读者对的是自己的日历；用 UTC 会在 UTC+8
 * 的夜里把「今天」算错 8 小时）。今天恰好是本月 1 号时，今日窗口与月窗口同值——这是对的，
 * 不是重复。
 */
function ocDayWindow(nowMs) {
  const n = ocNum(nowMs)
  const d = new Date(n === null ? Date.now() : n)
  const day = ocLocalYmd(d)
  return { fromDate: day, toDate: day }
}

// ---------------------------------------------------------------- API Key（创建体）

/** 密钥名称上限。**门户自己卡的就是 128**（产物 `nameTooLong:{max:128}`，校验函数逐字
 *  `a.length>128` 与 `/[\r\n\u0000]/`），照抄它，不自己放宽也不收紧。*/
const OC_APIKEY_NAME_MAX = 128

/** 「无过期」的落点年份（门户 `moment("2099-12-31T23:59:59")`）。*/
const OC_APIKEY_NEVER_YEAR = 2099

/**
 * 密钥名称校验 → 错误文案（合规回 ''）。**逐条对齐门户的校验函数**（产物 `ve()`）：
 * 非空、≤128、不含 `\r\n\0`。校验消息在协议层出（host 与界面共用同一份判据，不许各写一套）。
 */
function ocApiKeyNameError(name) {
  const s = typeof name === 'string' ? name.trim() : ''
  if (s === '') return '请填写密钥名称'
  if (s.length > OC_APIKEY_NAME_MAX) return '名称不超过 ' + OC_APIKEY_NAME_MAX + ' 字符'
  if (/[\r\n\u0000]/.test(s)) return '名称不能包含换行或空字符'
  return ''
}

/**
 * 有效期选项 → `expired_at` 的 ISO 字符串（**本地时区的当日末刻**，与门户同口径）。
 *
 * 门户 `ue()` 的 switch 逐字：
 *   · `never`（默认分支）→ `moment("2099-12-31T23:59:59").toISOString()`
 *   · `30d` / `90d`      → `moment().add(N,'day').endOf('day').toISOString()`
 *   · `custom`           → 用户给的时刻的 ISO；解析不出回 **null**（门户也是 null，
 *                          由界面拦在「必须选时间」那一步，协议层不替它编一个）
 * 认不出的值一律按 `never`（门户 default 分支就是回 never 那个常量）。
 *
 * 为什么坚持本地时区：`endOf('day')` 在用户眼里是「今天 23:59 到期」，写成 UTC 会在
 * UTC+8 的夜里差 8 小时（读者对的是自己的日历，与 ocMonthWindow 同一条理由）。
 */
function ocApiKeyExpireIso(choice, nowMs, customIso) {
  const c = typeof choice === 'string' ? choice.trim() : ''
  const n = ocNum(nowMs)
  const base = new Date(n === null ? Date.now() : n)
  const dayEndIso = (addDays) => new Date(
    base.getFullYear(), base.getMonth(), base.getDate() + addDays, 23, 59, 59, 999,
  ).toISOString()
  if (c === '30d') return dayEndIso(30)
  if (c === '90d') return dayEndIso(90)
  if (c === 'custom') {
    const t = typeof customIso === 'string' ? customIso.trim() : ''
    if (t === '') return null
    const parsed = Date.parse(t)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  return new Date(OC_APIKEY_NEVER_YEAR, 11, 31, 23, 59, 59, 999).toISOString()
}

/**
 * 创建密钥的请求体 → **JSON 字符串**（host 直接拿去当 POST body，同 ocLoginBody 的理由）。
 *
 * 字段与顺序逐字对齐门户 `ue()`：**`{quotas, name, expired_at}`**（门户是先 `{quotas}`、
 * 再补 name 与 expired_at）。`quotas` 至少带一条 `fee / unlimited / 0`——门户的 `u4e` 对
 * fee 那一条是**恒推**（`l("fee",{…},!0)`，不限流时 quota 就是 0），其余条目只在真的限流时
 * 才出现。本插件不做限流 UI，所以永远只发这一条「不限额度」的 fee：**与门户新密钥的默认
 * 形态一致**（不发 quota 与发 unlimited 在服务端是同一个语义，但照门户的样发出来，
 * 服务端日志里能逐字对上）。
 */
function ocCreateApiKeyBody(opts) {
  const o = ocIsObj(opts) ? opts : {}
  return JSON.stringify({
    quotas: [{ quota_value_type: 'fee', quota_type: 'unlimited', quota: 0, allocation: '' }],
    name: typeof o.name === 'string' ? o.name.trim() : '',
    expired_at: ocApiKeyExpireIso(o.expire, o.nowMs, o.customIso),
  })
}

// ---------------------------------------------------------------- 响应 → 视图模型

/**
 * 余额响应 → 视图模型。入参是**整个信封**（`{msg:'OK', data:{balance:…}}`），不是信封里的
 * data：平台的余额就在 `data.balance` 这一层（前端 `e.data.balance/100`）。
 * 取不到 balance → `ok:false` 且 `balanceCents:null`（**不许塌成 0**，同 ocYuanText 的理由）。
 * 代金券字段两种拼写都试（`voucher_balance` 是 Go 的 json tag 写法，`voucherBalance` 是前端
 * 可能见过的驼峰）——取不到就 null，不编 0。
 * `raw` 是平台原始 `data` 节点（不是整个信封）：留个出口给渲染层挖本层没归一的字段。
 */
function ocNormalizeBalance(body) {
  const raw = ocIsObj(body) && ocIsObj(body.data) ? body.data : null
  if (raw === null) {
    return { ok: false, balanceCents: null, voucherCents: null, bonusCents: null, cashCents: null, lowBalanceWarnCents: null, raw: null }
  }
  const voucherCents = ocCents(raw.voucher_balance === undefined ? raw.voucherBalance : raw.voucher_balance)
  const balanceCents = ocCents(raw.balance)
  // 余额构成（实测 `data.composition.{bonus,cash}`）：赠金 / 现金。**门户没有渲染这两个字段**
  // （产物里搜不到 composition），所以这里是「按字段名直读」而不是「对着界面核出来的」——
  // 与 balance 对不上时以 balance 为准，界面上两个分量只是构成说明，不参与任何加减。
  const comp = ocIsObj(raw.composition) ? raw.composition : null
  return {
    ok: balanceCents !== null,
    balanceCents,
    voucherCents,
    bonusCents: comp === null ? null : ocCents(comp.bonus),
    cashCents: comp === null ? null : ocCents(comp.cash),
    // 低余额告警阈值（单位同样是分，门户 PUT 时逐字 `low_balance_warn: 100*Number(...)`——
    // 那是「元 → 分」的换算，反证余额系字段的单位就是分）。0 是「没设阈值」，照实带出。
    lowBalanceWarnCents: ocCents(raw.low_balance_warn),
    raw,
  }
}

/**
 * `GET /api/v1/invitations` → 视图模型（「待发放余额」的来源）。
 *
 * 门户 `/profile/invite/ali`（组件 `InviteDetail`）逐字：`U.value = t.value.data`，然后渲染
 * `pending_credit`（`profile.invite.pendingEarnings`）、`total_credit`
 * （`profile.invite.totalEarnings`）、`invites`（`profile.invite.successfulInvites`）；
 * 金额走 `M=(e,a=!0,t=2)=>{const l=(Math.floor(e)/100).toFixed(t);…}` —— **单位是分**。
 * 本层归一这三个数 + 邀请码（邀请码只留协议层方便排查，不进浏览器载荷：界面不需要它）。
 *
 * 取不到 `data` → `ok:false` 且三个值全 null（**缺失 ≠ 0**：`pending_credit` 真为 0 时平台
 * 回的是 0，它与「这个口没答上来」在界面上必须是两件事）。
 */
function ocNormalizeInvitations(body) {
  const raw = ocIsObj(body) && ocIsObj(body.data) ? body.data : null
  if (raw === null) return { ok: false, inviteCode: '', invites: null, totalCreditCents: null, pendingCreditCents: null }
  return {
    ok: true,
    inviteCode: ocStr(raw.invite_code),
    invites: ocNum(raw.invites),
    totalCreditCents: ocCents(raw.total_credit),
    pendingCreditCents: ocCents(raw.pending_credit),
  }
}

/**
 * `GET /api/v1/accounting/credit/{uuid}/bills?scene=15&…` → 视图模型（「API 调用量」的来源）。
 *
 * 信封是**两层**：门户取数函数 `Ua` 逐字 `ee.value = e.data.data || []`、`ae.value =
 * e.data.total || 0`、`te.value = (Math.abs(e.data.total_value || 0) / 100).toFixed(2)`
 * —— 行数组在 `body.data.data`，而 `total`（条数）与 `total_value`（金额，分）挂在 `body.data`。
 * 与 `/user/{username}/order/resources` 那种单层嵌套不同，这里**必须下钻一层**：少钻一层拿到
 * `undefined`，界面就会显示「本期没有任何调用」而其实有一堆。
 *
 * 行级字段名逐字来自门户那张表的列定义（`apiCalls` 页签）：
 *   `instance_name`（接口名，空时门户显示 '-'）、`prompt_token`、`completion_token`、
 *   `reasoning_token`、`prompt_cached_token`（这四个门户都 `?? 0`）、`value`（该行金额，分）。
 * 另外三个字段是 2026-10-17 直接读回包挖出来并**逐行对账坐实**的（当时以为没有证据而扣住
 * 没归一，这轮把证据补上了）：
 *   · `count` —— **这一行聚合了多少次调用**（AtestA 实测：三行 count = 100 / 82 / 3，
 *     行合计 185 与信封 `total_count` 185 逐位相符；C1677 同验：14 === 14）。
 *   · `consumption` —— 这一行的 token 合计，**逐行等于 prompt + completion**
 *     （9189554 + 50165 = 9239719；三行全中），行合计又与信封 `total_consumption` 相符。
 *   · `created_at` —— 记录时间（RFC3339 带微秒）。**注意它不能当「按天分组」的键用**：
 *     实测两个账号的所有行都落在同一天（10-16），无法证明一行是「接口×天」还是
 *     「接口×窗口」，所以界面不拿它铺日历——只当这一行的记录时间显示。
 *   费用类字段：`value`（该行金额，**单位是分**，实测 2026-10-17 为**负数**——扣费记负）、
 *   `total_value`（窗口合计）。用户 2026-10-18 明确要「按接口怎么没花费」，所以
 *   `value` 归一成行级 `costCents` 并参与聚合；`cash_value` / `voucher_value` 的拆分语义
 *   仍未坐实（现金/代金券各占多少没验证过），照旧**不归一不展示**。
 *   **符号怎么处理**：门户那行合计是逐字 `(Math.abs(total_value) / 100).toFixed(2)`——
 *   「花费」这个词本身就是正的数额。界面跟着取绝对值显示，但**协议层存的是原值**（负数
 *   照实留着），并在悬浮里写明白是扣费，不悄悄改账。
 *
 * `apiCount` 取 `total`（条数）而不是 `rows.length`：rows 只有当前页，total 是整个窗口的。
 * 拿不到就 null——**不拿 rows.length 顶替**（那会把「共 37 个接口」悄悄说成「10 个」，是少报）。
 *
 * **整窗口合计**（2026-10-16 坐实四路 token；2026-10-17 坐实 `total_consumption` /
 * `total_count`）：`total_prompt_token` / `total_completion_token` / `total_reasoning_token`
 * / `total_prompt_cached_token` / `total_consumption`（= 输入 + 输出）/ `total_count`
 * （= 各行 count 之和 = 窗口内调用次数），都是服务端按**整个窗口**算好的，与分页无关。
 * 剩下的 `total_voucher_value` / `total_cash_value` / `total_duration` 语义仍未实测坐实
 * （代金券/现金拆分、时长单位都没验证过），**一概不归一不展示**。
 */
function ocNormalizeBills(body) {
  const raw = ocIsObj(body) && ocIsObj(body.data) ? body.data : null
  if (raw === null) {
    return { ok: false, apiCount: null, valueCents: null, totalTokensIn: null, totalTokensOut: null, totalTokensReasoning: null, totalTokensCached: null, totalConsumption: null, totalCalls: null, rows: [] }
  }
  const list = Array.isArray(raw.data) ? raw.data : []
  const rows = []
  for (const r of list) {
    if (!ocIsObj(r)) continue
    let createdAtMs = ocTsToMs(r.created_at)
    if (createdAtMs !== null && createdAtMs < 0) createdAtMs = null // Go 零值（与 ocNormalizeApiKeys 同一坑）
    rows.push({
      apiId: ocStr(r.instance_name),
      tokensIn: ocPickNum(r, ['prompt_token']),
      tokensOut: ocPickNum(r, ['completion_token']),
      tokensReasoning: ocPickNum(r, ['reasoning_token']),
      tokensCached: ocPickNum(r, ['prompt_cached_token']),
      // 行级调用次数与 token 合计（2026-10-17 实测坐实，见上方注释；缺失就是 null，不当 0）
      calls: ocPickNum(r, ['count']),
      consumption: ocPickNum(r, ['consumption']),
      createdAtMs,
      costCents: ocPickNum(r, ['value', 'cost']),
    })
  }
  return {
    ok: true,
    apiCount: ocNum(raw.total),
    valueCents: ocCents(raw.total_value),
    totalTokensIn: ocNum(raw.total_prompt_token),
    totalTokensOut: ocNum(raw.total_completion_token),
    totalTokensReasoning: ocNum(raw.total_reasoning_token),
    totalTokensCached: ocNum(raw.total_prompt_cached_token),
    // 窗口 token 合计与调用次数（服务端算好的，与分页无关；行合计实测逐位相符）
    totalConsumption: ocNum(raw.total_consumption),
    totalCalls: ocNum(raw.total_count),
    rows,
  }
}

/**
 * 账单行 → **按接口聚合**的排名行（「用量」页那张按接口拆分的表的数据源）。
 *
 * 为什么要聚合：账单口一行 = 一次聚合记录（同接口在一个窗口里可能出多行，实测两个账号都是
 * 一行一接口，但**没有证据说明它不会出第二行**），所以「按接口」这一层必须由我们合一次，
 * 不能把行直接当接口——同名接口出两行时，界面上就会同时出现两个「同一个模型」。
 *
 * 排序键用 `costCents` 的**绝对值**（平台把扣费记成负数），整表都没有花费读数时才退回
 * `consumption`（= 平台的 prompt + completion，实测逐行相符）。两个键都是平台自己的口径，
 * 不自己造「总 token」（把 cached / reasoning 也加进去会重复计数——缓存命中是输入的子集、
 * 推理是输出的子集）。
 * 份额 `share` 用「本接口 consumption ÷ 全部已取回行 consumption 之和」，分母是**已取回**
 * 的量：宿主翻页取全量时它等于窗口合计，取不全（partial）时界面必须标出「仅前 N 条」。
 *
 * 纯函数、无副作用；输入是 ocNormalizeBills 的 rows（缺失字段按 0 参与求和，但**排名行
 * 自己带 null**：全行都缺某个字段时该字段仍是 null，不让「问不到」显示成 0）。
 */
function ocAggregateBillsByApi(rows) {
  const list = Array.isArray(rows) ? rows : []
  const map = new Map()
  let sum = 0
  let sumCalls = 0
  for (const r of list) {
    if (!ocIsObj(r)) continue
    const key = ocStr(r.apiId)
    let g = map.get(key)
    if (g === undefined) {
      g = { apiId: key === '' ? '（未命名接口）' : key, records: 0, calls: null, consumption: null, tokensIn: null, tokensOut: null, tokensReasoning: null, tokensCached: null, costCents: null, lastCreatedAtMs: null }
      map.set(key, g)
    }
    g.records += 1
    for (const f of ['calls', 'consumption', 'tokensIn', 'tokensOut', 'tokensReasoning', 'tokensCached', 'costCents']) {
      const v = ocNum(r[f])
      if (v === null) continue // 这个字段平台没给：不参与求和，也不把整格判 0
      g[f] = (g[f] === null ? 0 : g[f]) + v
    }
    const at = ocNum(r.createdAtMs)
    if (at !== null && (g.lastCreatedAtMs === null || at > g.lastCreatedAtMs)) g.lastCreatedAtMs = at
    const c = ocNum(r.consumption)
    if (c !== null) sum += c
    const kk = ocNum(r.calls)
    if (kk !== null) sumCalls += kk // 行级 count 相加（与信封 total_count 实测逐位相符）
  }
  const out = []
  for (const g of map.values()) {
    const c = ocNum(g.consumption)
    out.push({ ...g, consumption: c, share: c !== null && sum > 0 ? c / sum : null })
  }
  // **排序键：花费优先，token 兜底。**「按接口」这一栏的头等数是花费（用户改口要的），
  // 而 `value` 是负数（扣费记负），所以比的是**绝对值**——花得最多的排最前。整表都没有
  // 花费读数时才退回按 token 合计排（缺花费 ≠ 花费为 0，两种情况在界面上分别是「—」和数字）。
  const hasCost = out.some((g) => g.costCents !== null)
  const rankOf = (g) => (hasCost
    ? (g.costCents === null ? -1 : Math.abs(g.costCents))
    : (g.consumption === null ? -1 : g.consumption))
  out.sort((a, b) => rankOf(b) - rankOf(a))
  let sumCost = 0
  for (const g of out) if (g.costCents !== null) sumCost += Math.abs(g.costCents)
  return {
    apis: out,
    sumConsumption: sum > 0 ? sum : null,
    apiCount: out.length,
    sumCalls: sumCalls > 0 ? sumCalls : null,
    // 已取回行的花费绝对值之和（分）；与信封 |total_value| 同口径，供界面自证「条是按什么画的」
    sumCostAbsCents: sumCost > 0 ? sumCost : null,
    rankBy: hasCost ? 'cost' : 'consumption',
  }
}

/**
 * `GET /api/v1/namespaces/{ns}/apikeys` → 视图模型（「API Key」卡片的列表）。
 *
 * **信封是单层**：行数组直接在 `body.data`（2026-10-17 生产实测 `{msg:"OK", data:[…]}`）。
 * 但门户的归一器两种都吃（`Array.isArray(e.data) ? e.data : Array.isArray(e.data.data) ?
 * e.data.data : []`），本层照抄这份容忍——平台万一哪天套一层也不至于整卡变空。
 *
 * `data === null` 与 `data === []` 都算**空列表**（新账号一把 key 都没有是有效状态）；
 * 但**连 `data` 字段都没有**（`undefined`）判 `ok:false`：那是结构不认识，不是「没有密钥」
 * ——两者在界面上一个是「还没有密钥，创建一个」、一个是「结构无法识别」，不能混。
 *
 * 行字段（门户归一器逐字 + 生产实测）：
 *   · `id`（数字）/ `token_name`（列表口叫这个；**创建响应却叫 `name`**，故两种都兜）
 *   · `token`：**服务端掩码**（实测 `gk***36`）——不是明文，本层也不去猜明文
 *   · `token_type`：`builtin` / `custom`（创建响应里是 `owner`，那是第三种语义，见下）
 *   · `is_active`、`created_at`、`expire_at`、`quotas[].last_used_at`、`ns_uuid`、`application`
 *
 * 两个「归一」的坑，各有实测依据：
 *   ① `expire_at` 无过期时回 **Go 零值 `"0001-01-01T00:00:00Z"`**（内置行实测）。`ocTsToMs`
 *      对 ISO 串会解出**负毫秒**（约 -6.2e13），照直渲染就是公元一年。这里把负毫秒一律
 *      抹成 null = 「长期有效」，与「这个字段没答上来」同一个显示位（都是「—」/「长期」）。
 *   ② 内置判定：`token_type` 是 `builtin` **或 `default`** 都算内置（门户 `Q()` 逐字
 *      `a===i5e||"default"===a`）。内置 key 不可删——界面据此决定删不删那一行。
 *   ③ `last_used_at` 行级没有时，兜 `quotas[].last_used_at` 的**最大值**（门户同款）；
 *      全没有才是 null（=「从未调用」，与「问不到」同一个显示位）。
 * `is_active` 缺失时按 **true**（门户 `X()`：`!1!==(is_active ?? isActive)`——只有显式
 *  `false` 才算停用），0/缺失不该把一把好钥匙显示成停用。
 */
function ocNormalizeApiKeys(body) {
  const env = ocIsObj(body) ? body : null
  if (env === null || env.data === undefined) return { ok: false, rows: [] }
  const d = env.data
  const list = Array.isArray(d) ? d : (ocIsObj(d) && Array.isArray(d.data) ? d.data : (d === null ? [] : null))
  if (list === null) return { ok: false, rows: [] }
  const rows = []
  for (const r of list) {
    if (!ocIsObj(r)) continue
    const typeRaw = ocStr(r.token_type !== undefined ? r.token_type
      : (r.tokenType !== undefined ? r.tokenType : (r.type !== undefined ? r.type : r.Type))).toLowerCase()
    let expireMs = ocTsToMs(r.expire_at !== undefined ? r.expire_at
      : (r.expired_at !== undefined ? r.expired_at : (r.expireAt !== undefined ? r.expireAt : r.expiredAt)))
    if (expireMs !== null && expireMs < 0) expireMs = null // Go 零值 0001-01-01（见上 ①）
    let lastUsedMs = ocTsToMs(r.last_used_at !== undefined ? r.last_used_at : r.lastUsedAt)
    if (lastUsedMs === null && Array.isArray(r.quotas)) {
      for (const q of r.quotas) {
        if (!ocIsObj(q)) continue
        const m = ocTsToMs(q.last_used_at)
        if (m !== null && (lastUsedMs === null || m > lastUsedMs)) lastUsedMs = m
      }
    }
    rows.push({
      id: ocNum(r.id !== undefined ? r.id : r.ID),
      name: ocStr(r.token_name !== undefined ? r.token_name
        : (r.tokenName !== undefined ? r.tokenName : r.name)),
      tokenMasked: ocStr(r.token),
      application: ocStr(r.application),
      isBuiltin: typeRaw === 'builtin' || typeRaw === 'default',
      isActive: r.is_active !== undefined ? r.is_active === true : (r.isActive !== undefined ? r.isActive === true : true),
      expireMs,
      createdAtMs: ocTsToMs(r.created_at !== undefined ? r.created_at : r.createdAt),
      lastUsedMs,
      quotaCount: Array.isArray(r.quotas) ? r.quotas.length : 0,
    })
  }
  return { ok: true, rows }
}

/**
 * `POST /api/v1/namespaces/{ns}/apikeys` 的响应 → 视图模型。**这是全文唯一能看到明文密钥
 * 的地方**（2026-10-17 实测：`data.token` 55 字符明文，列表口只回掩码），所以 `token` 的
 * 用途就是三件：一次性展示、复制进剪贴板、**在本机 0600 state 里留一份副本**（用户定稿
 * 「新创建的密钥。存到本地」，见头部结论 ⑨ 末条与下面的 ocSavedKeyEntry）。
 *
 * 响应是**单层对象**（`body.data` 就是这把钥匙本身，不是数组、不再套一层）——与列表口的
 * `data:[…]` 是同一个 `data` 键的两种形态，别记混。实测字段：
 *   `{id, git_id, name, token, user_id, user, application:"aigateway", permission,
 *     is_active, expired_at, DeletedAt, ns_uuid, token_type:"owner", created_at, updated_at}`
 * 两个要点：名字在 **`name`** 这个键上（列表口叫 `token_name`，故此处以 name 为主、token_name
 * 兜底）；`token_type` 回的是 `owner`（不是 builtin/custom）——创建完的卡只显示名字与明文，
 * 不拿这个值去判内置，所以不归一它。
 * `ok` 只认「拿到了明文 token」：没有它，创建就等于白跑（界面无事可示），必须让调用方看到失败。
 */
function ocNormalizeApiKeyCreated(body) {
  const raw = ocIsObj(body) && ocIsObj(body.data) ? body.data : null
  if (raw === null) return { ok: false, id: null, name: '', token: '', application: '', isActive: false, expiredAtMs: null }
  const token = ocStr(raw.token)
  let expiredAtMs = ocTsToMs(raw.expired_at !== undefined ? raw.expired_at : raw.expire_at)
  if (expiredAtMs !== null && expiredAtMs < 0) expiredAtMs = null
  return {
    ok: token !== '',
    id: ocNum(raw.id !== undefined ? raw.id : raw.ID),
    name: ocStr(raw.name !== undefined ? raw.name : raw.token_name),
    token,
    application: ocStr(raw.application),
    isActive: raw.is_active !== undefined ? raw.is_active === true : true,
    expiredAtMs,
  }
}

// ---------------------------------------------------------------- API Key（本机留存）

/** 单账号本机留存的明文密钥条数上限（新建的往最前插，超限从尾部丢——最老的最可能已删）。*/
const OC_SAVED_KEY_MAX = 50

/** 本机留存的明文 token 限长（实测 55 字符；256 足够，防历史脏数据把 state 撑爆）。*/
const OC_SAVED_KEY_TOKEN_MAX = 256

/**
 * 本机留存的一条明文密钥净化 → 记录 | null。
 *
 * 入参是 **宿主 state 文件里的条目**（本插件自己写下去的，不是平台报文），净化的意义与
 * sanitizeOcSessions 同一条：防历史脏数据 / 手改坏档把宿主搞崩。逐项判据：
 *   · `id`：正整数（数字或数字字符串都认）——没有 id 的副本对不上列表行，是废条目；
 *   · `token`：1..256 的非空字符串——**没有明文的副本毫无价值**（平台列表本来就给掩码），
 *     留着只会摆出「能复制」的假象，直接丢弃。**掩码形态一并拒收**：实测列表回的掩码
 *     长这样 `gk***36`（中间三颗星），state 里绝不该出现它——出现即说明这条副本根本
 *     没拿到明文，存下来只会让「复制完整值」复制出一串星号。
 *   · `name` 空也收（≤128，与门户名称上限同值）；`application` 截 64；
 *   · `createdAtMs` / `expiredAtMs` 可缺（null）——列表行才是权威，这只是创建时的快照；
 *   · `savedAt` 必须是正毫秒（写入时恒有；缺失按 nowMs 兜——state 里它是「什么时候存的」）。
 */
function ocSavedKeyEntry(raw, nowMs) {
  if (!ocIsObj(raw)) return null
  const idNum = ocNum(raw.id !== undefined ? raw.id : raw.ID)
  if (idNum === null || !(idNum > 0)) return null
  const token = typeof raw.token === 'string' ? raw.token.trim() : ''
  if (token === '' || token.length > OC_SAVED_KEY_TOKEN_MAX) return null
  if (token.indexOf('***') >= 0) return null // 服务端掩码形态（实测 gk***36）：这条副本没拿到明文
  const savedAt = ocNum(raw.savedAt)
  const now = ocNum(nowMs)
  const at = savedAt !== null && savedAt > 0 ? Math.trunc(savedAt) : (now !== null && now > 0 ? Math.trunc(now) : null)
  if (at === null) return null
  return {
    id: Math.trunc(idNum),
    name: ocStr(raw.name).trim().slice(0, OC_APIKEY_NAME_MAX),
    token,
    application: ocStr(raw.application).slice(0, 64),
    createdAtMs: ocNum(raw.createdAtMs),
    expiredAtMs: ocNum(raw.expiredAtMs),
    savedAt: at,
  }
}

/**
 * 本机密钥库的归一：入参是 state 文件里 `oc.savedKeys` 的原始对象（键 = identifier 小写、
 * 值 = 条目数组），出参是同一形态的净化版。
 *
 * 不变式与 sanitizeOcSessions 完全同一套（**串号是安全事故**）：
 *   · 键一律小写归一（与 ocSessKey 同一口径），空键丢弃；
 *   · **只认账号池内的 identifier**——池外条目一律丢弃（state 是按账号分槽的，槽名必须
 *     落在账号池内，绝不让 A 账号的明文挂到 B 账号名下）；
 *   · 每条过 ocSavedKeyEntry；**保序不重排**（落盘时新条目 unshift 在最前，超限截尾）；
 *   · 每账号 ≤ OC_SAVED_KEY_MAX 条、整库 ≤ 20 个账号（与 sessions 的 20 同口径）。
 * `accounts` 传账号池（sanitizeOcAccounts 的出参即可）；池为空 → 整库清空（同 sessions）。
 */
function ocNormalizeSavedKeys(input, accounts) {
  const pool = new Set()
  if (Array.isArray(accounts)) {
    for (const a of accounts) {
      if (ocIsObj(a) && typeof a.identifier === 'string' && a.identifier !== '') pool.add(a.identifier.toLowerCase())
    }
  }
  if (!ocIsObj(input) || pool.size === 0) return {}
  const out = {}
  for (const [rawKey, rawList] of Object.entries(input)) {
    const key = typeof rawKey === 'string' ? rawKey.trim().toLowerCase() : ''
    if (key === '' || !pool.has(key) || !Array.isArray(rawList)) continue
    const rows = []
    for (const raw of rawList) {
      // 没写 savedAt 的条目按「现在」兜（净化时刻即视为存入时刻），不至于整条丢弃
      const rec = ocSavedKeyEntry(raw, Date.now())
      if (rec === null) continue
      rows.push(rec)
      if (rows.length >= OC_SAVED_KEY_MAX) break
    }
    out[key] = rows
    if (Object.keys(out).length >= 20) break
  }
  return out
}

/**
 * 登录失败是「确定性」的（凭据不对 / 结构不认识 / 账号被禁 / 授权被拒），
 * 还是「暂时态」的（网络抖动、平台 5xx、自家冷却窗口）？
 *
 * 用途与清枢智汇同一处：确定性失败**拒收**（不把错密码存进账号池，否则以后每次都要等它失败
 * 一遍，还可能把人家的账号锁掉）；暂时态**先存后补**（凭据大概率没错，只是现在问不到平台）。
 * `OC_UNAUTHORIZED` 也算确定性：**这条函数只在「刚试过登录」的路径上被调用**，那时 401/403
 * 只可能是凭据/授权码/换令牌被拒（重试同一份凭据没意义）；会话自然过期不在这里判。
 * `NO_OC_ACCOUNT` 是「本机还没配账号」，不是平台拒了凭据，故留 false（配置问题不该触发拒收）。
 *
 * `OC_NO_TOKEN` 从确定性里**移出来了**（原来是确定性的）：它只在「Casdoor 已经收下了这组账号
 * 密码」之后才可能出现（走到它就意味着 `/api/login` 回了 `status:'ok'` 且我们拿到了 Casdoor
 * 令牌或会话 cookie），所以它恰恰**证明凭据是对的**，失败的只是后面「换本站令牌」那一步。
 * 把它当确定性失败会直接拒收——用户明明账号密码正确，却连账号都存不进去，这正是本轮要修的
 * 那类「登录不上」体验：凭据对，却被挡在门外。归入暂时态后账号先存下来，之后每次刷新自动再试。
 */
const ocDeterministicLoginFailure = makeDeterministicFailure([
  'OC_LOGIN_FAILED', 'OC_SHAPE', 'OC_DISABLED', 'OC_UNAUTHORIZED',
])

// ---------------------------------------------------------------- 密钥反查（头部角标）

/** 掩码指纹的头/尾段长：服务端掩码（实测 `gk***36`）留头 2 尾 2；宿主防御性再掩
 *  （ocKeyMask：`首6 + … + 尾4`）留头 6 尾 4。段数取两口径都覆盖的最小公共比对集时
 *  会丢信息，所以不取最小——解析出**实际分隔符**两侧的段，各比各的。 */
const OC_KEY_MASK_SEP = ['***', '…']

/**
 * 明文 token 与服务端/宿主掩码是否同一条：掩码串按分隔符拆成「头段 + 尾段」，
 * 明文必须以头段开头、以尾段结尾，且长度不小于两段之和。
 *
 * 认两种分隔符：`***`（opencsg.com 列表口实测形态 `gk***36`）与 `…`（宿主 ocKeyMask
 * 对>32字符回明文的防御性掩码形态）。分隔符缺失、两侧有空段、串不规整 → **一律 false**
 * （判不准就当不匹配，与「不编数」同一条规矩：错认账号比认不出更糟）。
 * 明文自己含 `***`/`…` 的畸形串同样直接拒——OC 明文实测 55 字符的字母数字形态碰不到。
 */
function ocKeyMaskMatches(rawToken, maskStr) {
  const raw = typeof rawToken === 'string' ? rawToken.trim() : ''
  const mask = typeof maskStr === 'string' ? maskStr.trim() : ''
  if (raw === '' || mask === '') return false
  for (const sep of OC_KEY_MASK_SEP) {
    const i = mask.indexOf(sep)
    if (i <= 0 || i + sep.length >= mask.length) continue
    // 掩码里只允许出现一次该分隔符；混着出现两种的脏串在下面逐段判定中自然落 false
    if (mask.indexOf(sep, i + sep.length) !== -1) continue
    const head = mask.slice(0, i)
    const tail = mask.slice(i + sep.length)
    if (raw.length < head.length + tail.length) return false
    if (raw.startsWith(head) && raw.endsWith(tail)) return true
  }
  return false
}

/** 明文 token → 「指纹」：头 4 + 尾 4 + 长度（不含任何可还原中段的信息）。
 *  这是「当前使用的密钥」匹配结果的 10 分钟缓存键——**与 step 的 masked+length 指纹
 *  同一个定位**：缓存里只存这串，明文绝不出现在缓存键上（state 文件泄露时少一路旁证）。
 *  太短的串（<12）不配指纹（正常 55 字符，脏数据进不了匹配表）。 */
function ocKeyFingerprint(rawToken) {
  const raw = typeof rawToken === 'string' ? rawToken.trim() : ''
  if (raw.length < 12) return ''
  return raw.slice(0, 4) + '#' + raw.slice(-4) + '#' + raw.length
}

export {
  OC_BASE, OC_IAM, OC_UA, OC_PATH, OC_AUTH_SCHEMES,
  OC_BILL_SCENE_API, OC_BILL_PER_PAGE, OC_BILL_USAGE_PER_PAGE, OC_BILL_MAX_PAGES,
  ocBillsQuery, ocMonthWindow, ocDayWindow, ocAggregateBillsByApi,
  OC_CASDOOR_APP, OC_CASDOOR_ORG, OC_CASDOOR_ORG_FALLBACKS, ocCasdoorOrgCandidates,
  OC_CASDOOR_CLIENT_ID,
  ocLoginBody, ocLoginQuery, ocIamHeaders, ocHubHeaders, ocAuthHeaderValue,
  ocCookieEntries, ocCookieFromSetCookie, ocCookieHeaderValue,
  ocJwtClaims, ocJwtExpMs, ocJwtExpired,
  ocRedirectParam, ocTokenFromRedirect, ocCodeFromRedirect,
  ocEnvelope, OC_CODE_TEXT, ocErrorText,
  ocCents, ocYuanText,
  ocNormalizeBalance, ocNormalizeInvitations, ocNormalizeBills,
  OC_APIKEY_NAME_MAX, ocApiKeyNameError, ocApiKeyExpireIso, ocCreateApiKeyBody,
  ocNormalizeApiKeys, ocNormalizeApiKeyCreated,
  OC_SAVED_KEY_MAX, OC_SAVED_KEY_TOKEN_MAX, ocSavedKeyEntry, ocNormalizeSavedKeys,
  OC_KEY_MASK_SEP, ocKeyMaskMatches, ocKeyFingerprint,
  ocTsToMs, ocDeterministicLoginFailure,
}
