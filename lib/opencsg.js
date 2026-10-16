/**
 * OpenCSG（opencsg.com）协议层（纯函数，零依赖）。
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
 *       "autoSignin":true,"type":"login"}`。应用名有两处实测（门户 authorize URL 里逐字的
 *      `client_id=CSGShip`、`GET /api/get-app-login` 回包 `name="CSGShip"`）；
 *      **组织名是本轮踩的坑**：Casdoor 服务端 `controllers/auth.go` L981 把请求里的
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
 */

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
 * 账单口每页条数。**取门户自己的默认值 10**，不擅自放大：门户分页组件的 perPage 初值
 * 就是这个数，平台允许到多大没有实测坐实，而放大一个没验过的值属于拿真实账号去试探。
 * 卡片上那两个数（接口数 `total`、本期金额 `total_value`）都是**服务端按整个窗口算的**，
 * 与分页无关——所以首页 10 条足够撑起卡片，逐接口明细在「用量」页签里逐条列。
 */
const OC_BILL_PER_PAGE = 10

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

/** 数字字段统一：数字与数字字符串都认，非有限数 → null。**缺失与 0 必须分清**（0 是有效金额）。*/
function ocNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 字符串字段统一：非字符串 → ''（不把 undefined 泄进界面，界面只判空串）。*/
function ocStr(v) {
  return typeof v === 'string' ? v : ''
}

/** 普通对象判定：null 与数组都不算。*/
function ocIsObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 容错取键：按候选键名依次取第一个「能算出有限数」的值（**0 是有效值，照样命中**）。
 * 全都没命中 → null。
 *
 * 为什么需要它：**平台改版、或同一个字段在不同口的写法不一致**时（账单口行里叫
 * `prompt_token`，别处可能叫 `input_tokens`），宁可给 null 让界面显示「—」，
 * 也不能把没见过的键名猜成 0（0 会被读成「没有消耗」，是把账算少的错）。
 */
function ocPickNum(obj, keys) {
  if (!ocIsObj(obj)) return null
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
    const n = ocNum(obj[k])
    if (n !== null) return n
  }
  return null
}

/**
 * 时间戳归一 → 毫秒。口径容忍三种（与清枢智汇 `tfTsToMs` 同一做法）：
 *   - 数字：> 1e12 视为毫秒，否则视为秒；**≤ 0 → null**（Go 的零值 0 与 -1 哨兵都表示「没有时间」，
 *     照 -1×1000 算会渲染成 1970 年，界面还会把「没有到期时间」读成「早就过期了」）
 *   - 数字字符串：同上（含前导 `-`）
 *   - RFC3339/ISO 字符串：Date.parse；解不出 → null
 */
function ocTsToMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (!(v > 0)) return null
    return v > 1e12 ? Math.trunc(v) : Math.trunc(v * 1000)
  }
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '') return null
    if (/^-?\d+$/.test(s)) return ocTsToMs(Number(s))
    const parsed = Date.parse(s)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// ---------------------------------------------------------------- 请求装配

/**
 * 账号密码登录体（Casdoor 口径）→ **JSON 字符串**（host 直接拿去当 POST body）。
 *
 * 字段名与顺序逐字来自实测：`{application, organization, username, password, autoSignin, type}`
 * —— 字段就叫 `username`（不是 identifier/email），Casdoor 自己按内容认邮箱还是用户名
 * （`object/user_util.go` `GetUserByFields`：name → email（含 @ 时）→ phone → id → id_card）。
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
    type: 'login',
  })
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
 * Set-Cookie 归一：字符串数组（推荐，`headers.getSetCookie()` 的结果）、单个字符串、
 * 空值都接受。
 *
 * 为什么还要留「拼接串」这条路：`getSetCookie()` 是较新的 undici API，宿主 Node 旧一点
 * 就只剩 `headers.get('set-cookie')`——那是一条用 ", " 拼起来的串。**不能直接按逗号切**：
 * `Expires=Wed, 21 Oct 2026 07:28:00 GMT` 里也有逗号。
 */
function ocCookieEntries(raw) {
  if (Array.isArray(raw)) {
    const out = []
    for (const item of raw) if (typeof item === 'string' && item !== '') out.push(item)
    return out
  }
  if (typeof raw !== 'string' || raw === '') return []
  // 只在「逗号 + 可选空白 + cookie 名 + =」处切：日期段逗号后面跟的是数字/星期名，
  // 到第一个 ';' 之前都不会出现 '='，因此不会命中。
  return raw.split(/,(?=\s*[^;=,\s]+=[^;]*)/)
}

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
 * `name=value` 段列表 → Cookie 请求头值（`a=b; c=d`）。与 ocCookieFromSetCookie 同一口径
 * （重名取最后一个非空值、没有 `=` 的段直接丢），单独导出是给「cookie 要跨多个响应累加」的场合用：
 * SSO 那条链路先接 `casdoor_session_id`，再换本地 JWT，两段 Set-Cookie 得合起来回传。
 *
 * **重名为什么取「最后一个非空」**：浏览器就是后到的覆盖先到的（RFC 6265 §5.3：cookie 存储里
 * 同名 cookie 会被新下发的删掉再加进来，即**最后一个生效**），我们用它的会话 cookie 去换授权码，
 * 就得跟浏览器的口径一致。原先这里取的是「第一个」，与规范相反：登录响应若先下清理用的空值、
 * 再下真值（或反过来先旧后新），我们就会拿着一枚错的/空的 cookie 去 authorize，
 * 于是 step ③ 永远换不到 code —— 表现就是「明明账号密码正确，登录不上」。
 * 只认非空值是额外的一层保险：真值之后跟一条清理空值（Max-Age=0）时，不至于把有效会话抹掉
 * （严格照规范此时浏览器已无 cookie，但我们的目的是把刚建立的会话递下去，空值一定没用）。
 *
 * 吃三种形态（caller 从 Set-Cookie / 配对表里接出来的东西形态不定）：
 *   - `'name=value; Path=/'` 这样的整条字符串（或它的数组）
 *   - `['name', 'value']` 二元组
 *   - `{ name, value }` 对象
 */
function ocCookieHeaderValue(pairs) {
  const list = Array.isArray(pairs) ? pairs : (typeof pairs === 'string' ? ocCookieEntries(pairs) : [])
  const picked = new Map()
  for (const item of list) {
    let head = ''
    if (typeof item === 'string') {
      head = item.split(';')[0].trim()
    } else if (Array.isArray(item)) {
      const n = ocStr(item[0]).trim()
      if (n !== '') head = n + '=' + (item[1] === undefined || item[1] === null ? '' : String(item[1]))
    } else if (ocIsObj(item)) {
      const n = ocStr(item.name).trim()
      if (n !== '') head = n + '=' + (item.value === undefined || item.value === null ? '' : String(item.value))
    }
    const eq = head.indexOf('=')
    if (eq <= 0) continue
    const name = head.slice(0, eq).trim()
    if (name === '') continue
    const empty = head.slice(eq + 1) === ''
    const prev = picked.get(name)
    if (prev !== undefined && prev.empty === false && empty) continue
    picked.set(name, { head, empty })
  }
  return [...picked.values()].map((v) => v.head).join('; ')
}

// ---------------------------------------------------------------- JWT / 重定向

/**
 * JWT 第二段（payload）解码 → 对象；失败 → null。
 *
 * **不做签名校验**（本层零依赖，且只用来读 `uuid` / `current_user` / `exp` 这类非敏感声明，
 * 真正的校验永远在平台侧——面板拿它只是想知道「这是谁、什么时候过期」）。
 * 显式把 base64url 转回 base64（`-`→`+`、`_`→`/`）再交给 Buffer 的 'base64'：Casdoor 发的
 * 是不带 padding 的 base64url，Node 的 'base64' 解码器不吃 `-` `_`。
 */
function ocJwtClaims(token) {
  if (typeof token !== 'string' || token === '') return null
  const parts = token.split('.')
  if (parts.length < 2 || parts[1] === '') return null
  try {
    const seg = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const j = JSON.parse(Buffer.from(seg, 'base64').toString('utf8'))
    return ocIsObj(j) ? j : null
  } catch (e) {
    return null
  }
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
 * 平台业务码 / 本层自定义码 → 中文。平台的 msg 是英文的（`password or code is incorrect`
 * 这种），界面全中文，故映射；**没映射到的一律回平台原文**（宁可露英文也不吞错），
 * 两个都没有才回 '未知错误'。
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

function ocErrorText(code, message) {
  const c = typeof code === 'string' ? code : ''
  const m = typeof message === 'string' ? message.trim() : ''
  if (Object.prototype.hasOwnProperty.call(OC_CODE_TEXT, c)) return OC_CODE_TEXT[c] + (m !== '' ? '（' + m + '）' : '')
  if (m !== '' && c !== '') return m + '（' + c + '）'
  if (m !== '') return m
  if (c !== '') return c
  return '未知错误'
}

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
  const p = (x) => String(x).padStart(2, '0')
  const fmt = (x) => x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate())
  return { fromDate: fmt(new Date(d.getFullYear(), d.getMonth(), 1)), toDate: fmt(d) }
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
 * **只归一门户真的读过的字段**：`total_token`、耗时、调用次数这类字段平台上有没有、叫什么
 * 都没有证据，编一个出来就是假账。
 *
 * `apiCount` 取 `total`（条数）而不是 `rows.length`：rows 只有当前页，total 是整个窗口的。
 * 拿不到就 null——**不拿 rows.length 顶替**（那会把「共 37 个接口」悄悄说成「10 个」，是少报）。
 */
function ocNormalizeBills(body) {
  const raw = ocIsObj(body) && ocIsObj(body.data) ? body.data : null
  if (raw === null) return { ok: false, apiCount: null, valueCents: null, rows: [] }
  const list = Array.isArray(raw.data) ? raw.data : []
  const rows = []
  for (const r of list) {
    if (!ocIsObj(r)) continue
    rows.push({
      apiId: ocStr(r.instance_name),
      tokensIn: ocPickNum(r, ['prompt_token']),
      tokensOut: ocPickNum(r, ['completion_token']),
      tokensReasoning: ocPickNum(r, ['reasoning_token']),
      tokensCached: ocPickNum(r, ['prompt_cached_token']),
      costCents: ocPickNum(r, ['value', 'cost']),
    })
  }
  return { ok: true, apiCount: ocNum(raw.total), valueCents: ocCents(raw.total_value), rows }
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
function ocDeterministicLoginFailure(code) {
  const c = typeof code === 'string' ? code : ''
  return c === 'OC_LOGIN_FAILED' || c === 'OC_SHAPE'
    || c === 'OC_DISABLED' || c === 'OC_UNAUTHORIZED'
}

export {
  OC_BASE, OC_IAM, OC_UA, OC_PATH, OC_AUTH_SCHEMES,
  OC_BILL_SCENE_API, OC_BILL_PER_PAGE, ocBillsQuery, ocMonthWindow,
  OC_CASDOOR_APP, OC_CASDOOR_ORG, OC_CASDOOR_ORG_FALLBACKS, ocCasdoorOrgCandidates,
  ocLoginBody, ocIamHeaders, ocHubHeaders, ocAuthHeaderValue,
  ocCookieEntries, ocCookieFromSetCookie, ocCookieHeaderValue,
  ocJwtClaims, ocJwtExpMs, ocJwtExpired,
  ocRedirectParam, ocTokenFromRedirect, ocCodeFromRedirect,
  ocEnvelope, OC_CODE_TEXT, ocErrorText,
  ocCents, ocYuanText,
  ocNormalizeBalance, ocNormalizeInvitations, ocNormalizeBills,
  ocTsToMs, ocDeterministicLoginFailure,
}
