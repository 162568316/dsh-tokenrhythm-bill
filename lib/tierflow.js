/**
 * 清枢智汇 / TierFlow（tierflow.cn）协议层（纯函数，零依赖）。
 *
 * 背景：清枢智汇（北京清枢智汇科技有限公司，产品名「清枢词元云」/TierFlow）没有公开
 * API 文档。本模块复刻其 Web 控制台自己的调用口径，证据来自两端：
 *   ① 反解前端产物（rspack 打包，202 个 async chunk，见 .recon/tf/）；
 *   ② 真发请求实测（含认证通道的排除法验证）。
 * 与 step.js 的分工一致：**本模块只做纯函数**（请求装配、信封解析、字段归一），
 * 网络 I/O、缓存、退避都在 index.js —— 这样协议层可以脱离网络单测。
 *
 * 实测坐实的关键结论（2026，逐条都有请求或产物证据）：
 *   1. 登录 `POST /api/user/login`，请求体 `{ identifier, password }`——字段就叫
 *      `identifier`（邮箱或手机号）。传 `username` 会拿到 `LOGIN_CREDENTIALS_REQUIRED`。
 *   2. **密码登录不需要验证码**：gocaptcha 只挂在发码类接口
 *      （`/api/verification/{email,sms}/*`，走 `X-Captcha-Token` 头）。实测用不存在的
 *      账号 + 任意密码直接得到 `LOGIN_INVALID_CREDENTIALS`，没有触发滑块。
 *   3. 凭据 = 服务端下发的 **`session` cookie**（HttpOnly + SameSite=Strict +
 *      Max-Age=2592000=30 天）。前端**不存任何 token**（localStorage 里只有 `uid`/`user`），
 *      请求头里也没有 `Authorization`。`TF-User`（= uid）**单独不构成鉴权**：实测带上它
 *      访问 `/api/user/self` 仍然 401。
 *      → Node 没有 cookie jar，必须自己从响应的 Set-Cookie 里接住 `session` 再原样回传。
 *   4. 统一信封 `{ success, code, message, data }`，**HTTP 200 也可能是业务失败**
 *      （业务失败只有 `success:false` + `code`），未登录才是真的 HTTP 401。
 *      → 判成功只能看 `success`，不能看状态码。
 *   5. 无 CSRF 头（防跨站靠 SameSite=Strict）、**无 refresh 端点**、401 即会话真失效。
 *   6. 角色枚举 `{GUEST:0, USER:1, DEALER:5, ADMIN:10, SENIOR_ADMIN:20, SUPER_ADMIN:100}`。
 */

import {
  cookieEntries, cookieHeader, hasCookie, makeCodeText, makeDeterministicFailure, num, str, tsToMs,
} from './common.js'

// ---------------------------------------------------------------- 平台常量（焊死）

/** 平台源。*/
const TF_BASE = 'https://tierflow.cn'

/**
 * 浏览器实测 UA。平台对 UA 没有硬校验，但照抄真身可以少一类「为什么它能过我不能」的
 * 排查成本；与 step.js 的 STEP_UA 同一考虑。
 */
const TF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0'

/** 端点（自前端产物里逐字抄出，别按惯例猜）。*/
const TF_PATH = {
  status: '/api/status',
  login: '/api/user/login',
  login2fa: '/api/user/login/2fa',
  logout: '/api/user/logout',
  self: '/api/user/self',
  dataSelf: '/api/data/self',
  subscription: '/api/subscription/self',
  subscriptionList: '/api/subscription/self/list',
  // 套餐列表与升级报价（同样自前端产物里抄出：zf.js 里
  // `FH.get("/api/subscription/upgrade/quote", {params:{sub_no, plan_slug}})`——**GET + query**，
  // 不是 POST，别按惯例猜）
  plans: '/api/subscription/plans',
  upgradeQuote: '/api/subscription/upgrade/quote',
  // 余额升级的付款口（官方 zf.js：`Yr:()=>o` → `POST /api/subscription/upgrade/balance`，
  // body 直传）。微信那条（`/api/subscription/upgrade/wechat` + `/wechat/pay`）**不用、不实现**
  // ——用户定稿「我们只用余额升级即可，不使用微信和支付宝」。
  upgradeBalance: '/api/subscription/upgrade/balance',
  // 余额**购买**：新开一份订阅（官方 zf.js：`Ax:()=>l` → `POST /api/subscription/balance/pay`，
  // body 直传）。这个口只带一个字段——官方弹窗里没订阅就是 `Ax({plan_slug})`，有订阅要升级才
  // 走上面那个 `Yr({sub_no, plan_slug})`（hy.js：`W&&Z ? Yr({sub_no:Z,plan_slug:Y.slug}) :
  // Ax({plan_slug:Y.slug})`）。微信那条（`/api/subscription/wechat/pay`）同样**不用、不实现**。
  balancePay: '/api/subscription/balance/pay',
  // ---- 按量 API Key（官网 /keys/ 页，前端产物 gf.42c746e01d.js 的 kD 模块逐字抄出；
  // 鉴权就是 cookie + TF-User，无 CSRF 头，与会话类接口同一套）。见下方「按量密钥」段。
  tokenList: '/api/token/?p=1&size=100',
  // 状态专用更新（PUT，query 带 status_only=true，body {token_no, status}）
  tokenStatus: '/api/token/?status_only=true',
  // 单条详情 / 删除（官方删除路径带尾斜杠 `FH.delete(`/api/token/${e}/`)`，逐字照抄；
  // 详情 GET 不带尾斜杠。插件只用详情做兜底，列表本来就带全字段）。
  tokenItem: (no) => '/api/token/' + no,
  tokenItemDelete: (no) => '/api/token/' + no + '/',
}

/**
 * 额度换算基准的兜底值：平台前端在 `/api/status` 解析不出时也用这个数
 * （`quotaPerUnit` fallback 5e5），故与平台同源。正常路径一律优先读接口。
 */
const TF_QUOTA_PER_UNIT_FALLBACK = 500000

// ---------------------------------------------------------------- 请求装配

/**
 * 请求头。实测浏览器只带这几样：
 *   - `cookie`        ——唯一鉴权凭据（有则带）
 *   - `TF-User`       ——= localStorage.uid，**不参与鉴权**，但浏览器总会带；
 *                        带上更接近真身，故有 uid 就带。绝不编造。
 *   - `accept-language` ——前端恒为 "zh" 或 "en"（它自己把 zh-CN 归一成 zh）；
 *                        实测只影响报错语言。默认 zh（用户是国内平台）。
 * 另外照抄前端的 `Cache-Control: no-store`（axios 实例级默认头）。
 */
function tfHeaders(input) {
  const o = input === undefined || input === null ? {} : input
  const h = {
    accept: 'application/json',
    'accept-language': o.lang === 'en' ? 'en' : 'zh',
    'cache-control': 'no-store',
    'user-agent': TF_UA,
  }
  const cookie = typeof o.cookie === 'string' ? o.cookie.trim() : ''
  if (cookie !== '') h.cookie = cookie
  const uid = o.uid
  if (uid !== undefined && uid !== null && String(uid) !== '') h['TF-User'] = String(uid)
  return h
}

/**
 * Set-Cookie 归一（拼接串怎么切、Expires 里的逗号为什么不能当分隔符 → 见 common.js）。
 */
const tfCookieEntries = cookieEntries

/**
 * Set-Cookie 列表 → 单个 Cookie 请求头值。
 *
 * 同名 cookie **只留第一次出现的**：服务端可能重复下发，后一个通常是清理用的空值，
 * 覆盖会把有效会话抹掉。这一条与 OpenCSG 相反（浏览器口径是后到覆盖），故显式传 prefer。
 */
function tfCookieFromSetCookie(raw) {
  return cookieHeader(tfCookieEntries(raw), { prefer: 'first' })
}

/** Set-Cookie 里是否下发了 `session`（登录是否真的成功的判据）。*/
function tfHasSessionCookie(raw) {
  return hasCookie(raw, 'session')
}

// ---------------------------------------------------------------- 统一信封

/**
 * 信封归一。**判成功只认 `success`**：
 *   - HTTP 401 → 未登录/会话失效（`authFailed:true`），调用方据此重登；
 *   - HTTP 2xx 但 `success:false` → 业务失败（带 `code`），不是抛异常的场合；
 *   - body 不是对象 → 结构不可识别（`TF_SHAPE`）；非 2xx 又是这种体 → `TF_HTTP`
 *     （网关/反代吐的错误页，根本不带 data，按成功处理会拿 null 去猜字段）；
 *   - 非 2xx 且**没有显式** `success:true` → 一律失败（只有平台明说成功才认）。
 */
function tfEnvelope(status, body) {
  const http = typeof status === 'number' ? status : 0
  const authFailed = http === 401
  const notOkHttp = http !== 0 && (http < 200 || http >= 300)
  const j = body !== null && typeof body === 'object' && !Array.isArray(body) ? body : null
  if (j === null) {
    return {
      ok: false,
      code: authFailed ? 'TF_UNAUTHORIZED' : (notOkHttp ? 'TF_HTTP' : 'TF_SHAPE'),
      message: '',
      data: null,
      status: http,
      authFailed,
    }
  }
  const code = typeof j.code === 'string' ? j.code : ''
  const message = typeof j.message === 'string' ? j.message : ''
  if (authFailed) {
    return { ok: false, code: code !== '' ? code : 'TF_UNAUTHORIZED', message, data: null, status: http, authFailed: true }
  }
  if (j.success === false) {
    return { ok: false, code, message, data: null, status: http, authFailed: false }
  }
  if (notOkHttp && j.success !== true) {
    return { ok: false, code: code !== '' ? code : 'TF_HTTP', message, data: null, status: http, authFailed: false }
  }
  return { ok: true, code, message, data: j.data === undefined ? null : j.data, status: http, authFailed: false }
}

// ---------------------------------------------------------------- 文案

/**
 * 平台业务码 → 中文（映射表见下；没映射到回平台原文，口径见 common.js 的 makeCodeText）。
 */
const TF_CODE_TEXT = {
  LOGIN_CREDENTIALS_REQUIRED: '账号或密码为空',
  LOGIN_INVALID_CREDENTIALS: '账号或密码不正确',
  TF_UNAUTHORIZED: '会话已失效，请重新登录',
  TF_NET: '网络请求失败',
  TF_HTTP: '平台返回异常状态',
  TF_SHAPE: '平台返回结构无法识别',
  TF_NO_COOKIE: '登录响应没有下发会话 cookie',
  TF_2FA_REQUIRED: '该账号开启了两步验证，插件暂不支持',
}

const tfErrorText = makeCodeText(TF_CODE_TEXT)

// ---------------------------------------------------------------- 字段归一

/** 角色名。数字与数字字符串都认；认不出就原样回显（不编）。*/
const TF_ROLE_NAMES = { 0: '访客', 1: '用户', 5: '经销商', 10: '管理员', 20: '高级管理员', 100: '超级管理员' }

function tfRoleName(role) {
  const n = typeof role === 'number' ? role
    : (typeof role === 'string' && /^\d+$/.test(role.trim()) ? Number(role.trim()) : NaN)
  if (Number.isFinite(n) && Object.prototype.hasOwnProperty.call(TF_ROLE_NAMES, n)) return TF_ROLE_NAMES[n]
  return typeof role === 'string' && role !== '' ? role : '未知'
}

/**
 * 时间戳归一 → 毫秒（数字 / 数字字符串 / RFC3339；`-1` `0` 是「没有时间」的哨兵，
 * 不是 1969 年——照 -1×1000 算会让套餐直接显示过期）。完整口径见 common.js 的 tsToMs。
 */
const tfTsToMs = tsToMs

/** 订阅来源（自前端产物抄出的枚举→文案）。认不出回原值。*/
const TF_SUB_SOURCE_NAMES = {
  registration: '注册赠送',
  referral: '推荐赠送',
  admin: '管理员发放',
  redemption: '兑换码',
  order: '购买',
  upgrade: '升级',
  subscription: '订阅',
  trial: '试用',
}

function tfSubSourceName(source) {
  const s = typeof source === 'string' ? source.trim() : ''
  if (s === '') return ''
  const key = s.toLowerCase()
  return Object.prototype.hasOwnProperty.call(TF_SUB_SOURCE_NAMES, key) ? TF_SUB_SOURCE_NAMES[key] : s
}

/** 订阅状态（同上）。*/
const TF_SUB_STATUS_NAMES = {
  active: '生效中',
  expired: '已过期',
  cancelled: '已取消',
  canceled: '已取消',
  pending: '待生效',
  paused: '已暂停',
}

function tfSubStatusName(status) {
  const s = typeof status === 'string' ? status.trim() : ''
  if (s === '') return ''
  const key = s.toLowerCase()
  return Object.prototype.hasOwnProperty.call(TF_SUB_STATUS_NAMES, key) ? TF_SUB_STATUS_NAMES[key] : s
}

// ---------------------------------------------------------------- 响应 → 视图模型

/** 数字 / 字符串字段统一（缺失 ≠ 0，非有限数 → null / ''）：口径见 common.js。*/
const tfNum = num
const tfStr = str

/**
 * `GET /api/user/self` 的 `data` 本体（它**不再包一层**：`auth.user` 就是它）→ 视图模型。
 *
 * 字段全部取自平台自己读的位置。平台没有的字段（`display_name`、头像 URL）这里也不编：
 * 显示名与首字母由渲染层按平台同一套规则从 `username`/`email` 派生（见 client.js）。
 *
 * `quota < 0`（典型 -1）：平台**在用户对象上没有无限量分支**（直接套金额格式会渲染成
 * `-¥0.0000`），故这里显式给出 `unlimited`，让渲染层改成「无限量」文案。
 *
 * **限时 / 不限时余额**（面板账号卡右侧那格）：平台给的是**到期计划**
 * `gift_expiring_schedule`（逐笔 `{quota, at}`），`gift_expiring_quota` / `gift_expiring_at`
 * 只是其中**最近的一笔**。这里按平台钱包卡「赠送到期计划」下方那行**合计到期**的口径把
 * 还没到期的各笔加起来 → `expiringQuota`（会到期失效的那部分），最近一笔的到期时刻 →
 * `expiringNextAtMs`，笔数 → `expiringBatchCount`。**已过期的笔不计**（平台已经回收，
 * 算进去就是虚增）；`expiringQuota` 再按 `quota` 夹一次上界，绝不出现「限时 > 总额」。
 * 计划为空但 `gift_expiring_quota > 0` 时退回那一笔（旧数据 / 平台改版时的兜底）。
 * 「不限时余额」不在这里算：它是 `quota − expiringQuota`，属于渲染层的减法。
 */
function tfNormalizeUser(input, nowMs) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false }
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now()
  const uidNum = tfNum(input.uid)
  const uid = uidNum === null ? '' : String(Math.trunc(uidNum))
  const username = tfStr(input.username)
  const email = tfStr(input.email)
  // 三个身份字段全缺 = 结构不对（会话没生效时平台不会返回用户对象），不假装成功。
  if (uid === '' && username === '' && email === '') return { ok: false }
  const quota = tfNum(input.quota)
  const roleNum = tfNum(input.role)
  const role = roleNum === null ? null : Math.trunc(roleNum)
  // 限时余额 = 到期计划里**还没到期**的各笔之和（平台「合计到期」的同一口径）。
  const schedule = Array.isArray(input.gift_expiring_schedule) ? input.gift_expiring_schedule : []
  let expiringQuota = 0
  let expiringBatchCount = 0
  let expiringNextAtMs = null
  for (const item of schedule) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const q = tfNum(item.quota)
    const at = tfTsToMs(item.at)
    if (q === null || q <= 0) continue
    if (at !== null && at <= now) continue
    expiringQuota += q
    expiringBatchCount += 1
    if (at !== null && (expiringNextAtMs === null || at < expiringNextAtMs)) expiringNextAtMs = at
  }
  const giftExpiringQuota = tfNum(input.gift_expiring_quota)
  const giftExpiringAtMs = tfTsToMs(input.gift_expiring_at)
  if (expiringBatchCount === 0 && giftExpiringQuota !== null && giftExpiringQuota > 0) {
    expiringQuota = giftExpiringQuota
    expiringBatchCount = 1
    expiringNextAtMs = giftExpiringAtMs
  }
  if (quota !== null && quota > 0 && expiringQuota > quota) expiringQuota = quota
  return {
    ok: true,
    user: {
      uid,
      username,
      email,
      phone: tfStr(input.phone),
      group: tfStr(input.group),
      role,
      roleName: role === null ? '' : tfRoleName(role),
      quota,
      usedQuota: tfNum(input.used_quota),
      requestCount: tfNum(input.request_count),
      giftQuota: tfNum(input.gift_quota),
      giftExpiringQuota: tfNum(input.gift_expiring_quota),
      giftExpiringAtMs: tfTsToMs(input.gift_expiring_at),
      // 限时（会到期）余额的合计 / 笔数 / 最近到期时刻——「限时余额 ｜ 不限时余额」那格的数据源
      expiringQuota,
      expiringBatchCount,
      expiringNextAtMs,
      createdAtMs: tfTsToMs(input.created_at),
      hasPassword: typeof input.has_password === 'boolean' ? input.has_password : null,
      unlimited: quota !== null && quota < 0,
    },
  }
}

/**
 * `GET /api/data/self` 的 `data`（**是数组，不是 {items,total}**）→ 行 + 汇总。
 *
 * 汇总就是平台 `/usage` 顶部那几个卡片的算法：Σquota / Σcount / Σtoken_used
 * （外加窗口分钟数，供 Avg TPM/RPM）。**汇总与分桶无关**——totals 是窗口内所有行的和，
 * 所以我们只要窗口对，granularity 发不发都不影响这几个数字。
 * `created_at` 无效（0/缺失，平台 `if(e<=0)continue`）的行直接丢，与平台同办。
 */
function tfNormalizeUsageRows(input) {
  if (!Array.isArray(input)) return { ok: false, rows: [], totals: null }
  const rows = []
  let count = 0
  let quota = 0
  let tokens = 0
  for (const raw of input) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const createdAtMs = tfTsToMs(raw.created_at)
    if (createdAtMs === null) continue
    const rawTokens = tfNum(raw.token_used)
    const rawCount = tfNum(raw.count)
    const rawQuota = tfNum(raw.quota)
    const rTokens = rawTokens === null ? 0 : rawTokens
    const rCount = rawCount === null ? 0 : rawCount
    const rQuota = rawQuota === null ? 0 : rawQuota
    rows.push({
      createdAtMs,
      tokens: rTokens,
      count: rCount,
      quota: rQuota,
      billingSource: tfStr(raw.billing_source),
      modelGroup: tfStr(raw.model_group),
      subscriptionBucket: tfStr(raw.subscription_bucket),
    })
    count += rCount
    quota += rQuota
    tokens += rTokens
  }
  rows.sort((a, b) => a.createdAtMs - b.createdAtMs)
  return { ok: true, rows, totals: { count, quota, tokens } }
}

/**
 * 期限（`duration_unit` + `duration_value`，或自定义秒数）→ 中文文案。
 * 平台只有 day 这一种（实测 30 day = 30 天）；其余单位按常见写法兜底，认不出就原样带单位，
 * **不编**「每月」这类平台没说的说法（`quota_reset_period` 是「额度重置」不是「有效期」）。
 */
const TF_DURATION_CN = {
  day: '天', days: '天', week: '周', weeks: '周', month: '个月', months: '个月',
  quarter: '季度', quarters: '季度', year: '年', years: '年', hour: '小时', hours: '小时',
  minute: '分钟', minutes: '分钟',
}
function tfDurationLabel(unit, value, customSeconds) {
  const u = tfStr(unit)
  if (u === 'custom' || u === '') {
    const sec = tfNum(customSeconds)
    if (sec === null || sec <= 0) return ''
    if (sec % 86400 === 0) return (sec / 86400) + ' 天'
    if (sec % 3600 === 0) return (sec / 3600) + ' 小时'
    if (sec % 60 === 0) return (sec / 60) + ' 分钟'
    return sec + ' 秒'
  }
  const n = tfNum(value)
  if (n === null) return ''
  const cn = TF_DURATION_CN[u]
  return cn === undefined ? n + ' ' + u : n + ' ' + cn
}

/**
 * `GET /api/subscription/plans` 的 `data`（**数组，每项形如 `{plan:{…}}`**）→ 套餐列表。
 *
 * 金额字段有**两套单位**，绝不可混：`price_amount` 是**钱**（¥29.9 就是 29.9 元，别再除
 * quota_per_unit），`total_amount` / `basic_token_total` 才是 quota / 原始 token 数
 * （渲染层按 quota_per_unit 折 ¥、按 亿/万 缩写）。`hidden` / `enabled` 原样带出，
 * 由渲染层决定藏不藏、能不能买——归一化层不替平台做删减（下架的套餐列表里仍可能出现）。
 * `allow_balance_pay` 带出来当**硬事实**用（渲染层据此关掉「余额购买」，官方弹窗也这么判：
 * `ei = !1 !== plan.allow_balance_pay`）；`max_purchase_per_user` 是平台的**限购份数**，
 * 只当事实写进 tooltip——用户已购份数面板算不准，够不够买由平台判，面板不替它拦。
 * 顺序保留平台返回的顺序（平台的 sort_order 已在服务端排好，本层不再重排）。
 */
function tfNormalizePlans(input) {
  if (!Array.isArray(input)) return { ok: false, plans: [] }
  const plans = []
  for (const item of input) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const p = item.plan
    if (p === null || typeof p !== 'object' || Array.isArray(p)) continue
    const slug = tfStr(p.slug)
    if (slug === '') continue
    const totalAmount = tfNum(p.total_amount)
    const basicTokenTotal = tfNum(p.basic_token_total)
    plans.push({
      slug,
      title: tfStr(p.title),
      subtitle: tfStr(p.subtitle),
      priceAmount: tfNum(p.price_amount),
      durationLabel: tfDurationLabel(p.duration_unit, p.duration_value, p.custom_seconds),
      totalAmount,
      basicTokenTotal,
      unlimitedAmount: totalAmount === null || totalAmount <= 0,
      unlimitedTokens: basicTokenTotal === -1,
      recommended: p.recommended === true,
      enabled: p.enabled !== false,
      hidden: p.hidden === true,
      allowBalancePay: p.allow_balance_pay === true,
      maxPurchasePerUser: tfNum(p.max_purchase_per_user),
      quotaResetPeriod: tfStr(p.quota_reset_period),
    })
  }
  return { ok: true, plans }
}

/**
 * 从套餐目录里挑出「比 `slug` 这一档更贵的档」——升级只往上走（平台原话
 * 「仅支持升级到更高价格的套餐」），所以先在本地把注定被平台拒绝的档滤掉，弹窗里就不排那些行。
 * 返回三种情况要分清：`[]` = 已经在最高档（没有可升的）、非空数组 = 可升的档、
 * `null` = **这档不在目录里**（已下架）——这时不能断言「没有可升的」，交给调用方退回
 * 「把其余档都列出来，让平台自己拒绝」，别自己编结论。
 */
function tfHigherPlans(plans, slug) {
  const list = Array.isArray(plans) ? plans : []
  const self = list.filter((p) => p.slug === slug)[0]
  if (self === undefined) return null
  const base = typeof self.priceAmount === 'number' && Number.isFinite(self.priceAmount) ? self.priceAmount : null
  if (base === null) return null
  return list.filter((p) => p.slug !== slug
    && typeof p.priceAmount === 'number' && Number.isFinite(p.priceAmount) && p.priceAmount > base)
}

/**
 * `GET /api/subscription/upgrade/quote?sub_no&plan_slug` 的 `data` → 升级报价。
 *
 * 全是**钱**（¥），不是 quota：`target_price` 59.9 = ¥59.9、`amount_due` 30 = 应付差价 ¥30、
 * `min_amount_due` 0.6 = 平台在线支付下限。`limited_by`（实测 `none`）是平台的拦截原因码，
 * 原样带出让渲染层写进 tooltip；失败时平台会在 `message` 里直说（例如「目标套餐与当前套餐
 * 相同」），那类文本由 host 侧原样透传，本层不重写。
 */
function tfNormalizeQuote(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false }
  return {
    ok: true,
    quote: {
      currentSubNo: tfStr(input.current_sub_no),
      currentPlanSlug: tfStr(input.current_plan_slug),
      remainingDays: tfNum(input.remaining_days),
      remainingValue: tfNum(input.remaining_value),
      targetPlanSlug: tfStr(input.target_plan_slug),
      targetPrice: tfNum(input.target_price),
      amountDue: tfNum(input.amount_due),
      minAmountDue: tfNum(input.min_amount_due),
      periodDays: tfNum(input.period_days),
      allowanceRatio: tfNum(input.allowance_ratio),
      timeRatio: tfNum(input.time_ratio),
      limitedBy: tfStr(input.limited_by),
    },
  }
}

/**
 * `GET /api/subscription/self` 的 `data`（**是数组，不是 {items,total}**）
 * → 当前套餐 + 全量列表。
 *
 * **两套单位，绝不能混**（报告 §3/§5 代码级坐实，也是平台购买弹窗并排用两个格式化器的原因）：
 *   - `amount_total` / `amount_used`：quota 整数，÷quotaPerUnit 才是 ¥
 *   - `basic_token_total` / `basic_token_used`：**原始 token 计数**，与 quotaPerUnit 无关
 *   - `amount_total <= 0`（含缺失）→ 无限量；`basic_token_total === -1` → 无限量；
 *      `basic_token_total === 0` → 渲染层显示 '-'（既不是 0 token 也不是无限量）
 *
 * 「当前套餐」的选法与平台同：`status === 'active'` 且未过期（`end_time` 缺失视为不过期），
 * 多个候选按 `end_time` 升序取第一个（无到期时间的排在最后）。
 *
 * **列表内容与顺序（两条都是用户定稿）**：
 *   · **已取消的订阅不进列表**（「排除已取消的套餐」）：取消掉的那份只剩历史意义，摆在套餐用量里
 *     既占屏，又容易和真正在用的那几份混着读。两种拼写（cancelled / canceled）都认，判定只走
 *     `tfSubStatusName` 这一张表；其余一律照实列出——已过期 / 已暂停 / 已下架套餐都留着。
 *   · **最先订阅的在前面**（按 `start_time` 升序）：平台给的是它自己的顺序（习惯上新订阅在前），
 *     面板把它重排成一条时间线，从哪儿开始一眼看得出；缺 `start_time` 的排最后（没有时间就是
 *     没有位置，不拿别的时间顶替）。`count` 就是排完之后的条数，页首「全部订阅（N）」用它。
 */
function tfNormalizeSubscriptions(input, nowMs) {
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now()
  const list = input !== null && typeof input === 'object' && !Array.isArray(input) && Array.isArray(input.all_subscriptions)
    ? input.all_subscriptions : null
  if (list === null) return { ok: false, current: null, subs: [], count: 0 }
  const subs = []
  for (const item of list) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const sub = item.subscription
    if (sub === null || typeof sub !== 'object' || Array.isArray(sub)) continue
    // 已取消 → 整条不进列表（见上面「列表内容与顺序」）。先判状态再接后面的字段：被丢掉的那条
    // 一个字段都不必算；拼写两种都认，判定只走 tfSubStatusName 那一张表。
    const status = tfStr(sub.status)
    if (tfSubStatusName(status) === '已取消') continue
    const plan = item.plan !== null && typeof item.plan === 'object' && !Array.isArray(item.plan) ? item.plan : null
    const ownTitle = tfStr(sub.plan_title)
    const planTitle = ownTitle !== '' ? ownTitle : (plan === null ? '' : tfStr(plan.title))
    const amountTotal = tfNum(sub.amount_total)
    const basicTokenTotal = tfNum(sub.basic_token_total)
    const endTimeMs = tfTsToMs(sub.end_time)
    subs.push({
      subNo: tfStr(sub.sub_no),
      planSlug: tfStr(sub.plan_slug),
      planTitle,
      // plan_title 与 plan.title 都缺 = 下架套餐（平台此时显示「已下架套餐」）
      planMissing: planTitle === '',
      status,
      statusName: tfSubStatusName(status),
      source: tfStr(sub.source),
      sourceName: tfSubSourceName(sub.source),
      startTimeMs: tfTsToMs(sub.start_time),
      endTimeMs,
      nextResetTimeMs: tfTsToMs(sub.next_reset_time),
      amountTotal,
      amountUsed: tfNum(sub.amount_used),
      basicTokenTotal,
      basicTokenUsed: tfNum(sub.basic_token_used),
      hasKey: sub.has_key === true,
      paidMoney: tfNum(sub.paid_money),
      fromPlanTitle: tfStr(item.from_plan_title),
      unlimitedAmount: amountTotal === null || amountTotal <= 0,
      unlimitedTokens: basicTokenTotal === -1,
      // 剩余天数（平台口径 max(0, ceil((end-now)/86400))）；无到期时间 → null（界面不显示）
      daysLeft: endTimeMs === null ? null : Math.max(0, Math.ceil((endTimeMs - now) / 86400000)),
    })
  }
  // 顺序：最先订阅的在前面（用户定稿）。sort 稳定，缺 start_time 的那几条保持进来时的先后。
  subs.sort((a, b) => {
    const x = a.startTimeMs === null ? Number.POSITIVE_INFINITY : a.startTimeMs
    const y = b.startTimeMs === null ? Number.POSITIVE_INFINITY : b.startTimeMs
    return x - y
  })
  let current = null
  for (const s of subs) {
    if (s.status !== 'active') continue
    if (s.endTimeMs !== null && s.endTimeMs < now) continue
    if (current === null) { current = s; continue }
    const a = s.endTimeMs === null ? Number.POSITIVE_INFINITY : s.endTimeMs
    const b = current.endTimeMs === null ? Number.POSITIVE_INFINITY : current.endTimeMs
    if (a < b) current = s
  }
  return { ok: true, current, subs, count: subs.length }
}

/**
 * 登录失败是「确定性」的（账号密码不对 / 要 2FA / 结构不认识 / 没下发会话），
 * 还是「暂时态」的（网络抖动、平台 5xx、自家冷却窗口）？
 *
 * 用途与阶跃同一处：确定性失败**拒收**（不把错密码存进账号池，否则以后每次都要等它失败
 * 一遍，还可能把人家的账号锁掉）；暂时态**先存后补**（凭据大概率没错，只是现在问不到平台）。
 */
/**
 * 用量行 → **按本地日历日**分桶（面板「近 7 日消耗」逐日柱条用）。
 * 与平台 /usage 图表的差别：平台按它自己的 `offset_seconds` 分桶，这里按本机时区的自然日
 * ——面板上标的是 M-D，读者对的是自己的日历，用本机日更不容易对错。
 * 阶跃账户卡的近 7 日柱条也是这么分桶的（客户端按本地日期聚合），两边画法一致。
 * 返回升序（老 → 新）；空输入返回空数组。
 */
function tfUsageDayBuckets(rows) {
  const map = new Map()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) continue
    if (!Number.isFinite(r.createdAtMs)) continue
    const d = new Date(r.createdAtMs)
    d.setHours(0, 0, 0, 0)
    const k = d.getTime()
    const cur = map.get(k)
    if (cur) {
      cur.tokens += r.tokens || 0
      cur.quota += r.quota || 0
      cur.count += r.count || 0
    } else {
      map.set(k, { dayStartMs: k, tokens: r.tokens || 0, quota: r.quota || 0, count: r.count || 0 })
    }
  }
  return [...map.values()].sort((a, b) => a.dayStartMs - b.dayStartMs)
}

/** 确定性登录失败（码集见下，判定骨架见 common.js 的 makeDeterministicFailure）。*/
const tfDeterministicLoginFailure = makeDeterministicFailure([
  'LOGIN_CREDENTIALS_REQUIRED', 'LOGIN_INVALID_CREDENTIALS', 'TF_2FA_REQUIRED', 'TF_SHAPE', 'TF_NO_COOKIE',
])

// ---------------------------------------------------------------- 按量密钥（API Keys）
//
// 端点与载荷全部自前端产物逐字抄出（gf.42c746e01d.js 的 kD 模块 = 接口层，
// k.7c907d7173.js = 密钥页组件，q9.01bf426034.js = 创建成功的一次性明文弹窗）：
//   · GET    /api/token/?p=&size=        分页列表（data = {items, total}）
//   · GET    /api/token/{token_no}       单条详情——**key 不可用**：官方编辑弹窗回放的
//                                        字段里没有 key（k.js @14960 附近 reset({name,
//                                        remain_quota_dollars, expired_time, unlimited_quota,
//                                        model_limits})），列表与详情的 key 恒是服务端掩码。
//   · POST   /api/token/                 创建——**全链路唯一的明文出处**：响应 data.key 是完整
//                                        明文，官方弹窗文案写明 "you will not be able to view it
//                                        again through the API keys management interface"。
//                                        关闭即永失 → 宿主把创建回的明文落本机（savedKeys），
//                                        之后「复制完整值」只从本机副本出（与 OpenCSG 同一
//                                        用户定稿：2026-10-17「新创建的密钥存到本地」）。
//   · PUT    /api/token/                 全量更新（创建载荷 + token_no）。插件不做编辑。
//   · PUT    /api/token/?status_only=true  body {token_no, status} 仅改状态（启停）。
//   · DELETE /api/token/{token_no}/      删除（注意尾斜杠，官方路径逐字如此）。
// 载荷形状 `{name, remain_quota, expired_time, unlimited_quota, model_limits_enabled,
// model_limits}` 抄 k.js @15460 的 toX()：官方表单字段 remain_quota_dollars（本站语义是
// **元**）在提交时 ×quota_per_unit 折成整数 quota；expired_time 是 unix 秒，`-1` = 永不过期
// （列表渲染 `-1===s.expired_time ? "Never" : 格式化`）；不设过期时官方就传 -1。
// 状态枚举（密钥表状态映射 j，@6708 可见 value:4 danger 档）：1=启用、2=停用、
// 3=已过期（平台按 expired_time 判）、4=额度耗尽（remain_quota 打空后平台自动停用）。

/** 密钥状态 → 文案（界面 pill 用；认不出的值宿主原样标「未知」，不编）。*/
const TF_KEY_STATUS_NAMES = { 1: '启用', 2: '停用', 3: '已过期', 4: '额度耗尽' }

/** 官方创建表单默认值（k.js @13925 ea）：名称必填、默认无限额、默认不过期、默认不限模型。 */
const TF_KEY_NAME_MAX = 128

/**
 * token_no 归一 → 字符串 | null。
 * 官网把 token_no 同时用作 URL 路径段（`/api/token/${no}/`）与 status body 的键值——
 * 因此这里把**能破坏 URL 拼装的一切**挡掉：只认正整数（数字或数字字符串）与
 * `^[A-Za-z0-9_-]{1,64}$` 字符串；带 `/`、`?`、`%`、`.`、空格的统统 null。
 * 返回字符串形态：本机副本、hasLocal 比对、路由入参全用同一个口径，不来回折数字。
 */
function tfTokenNo(raw) {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0 ? String(raw) : null
  }
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s === '') return null
    if (/^\d+$/.test(s)) return s.replace(/^0+(?=\d)/, '')
    return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null
  }
  return null
}

/**
 * 列表 data（`{items, total}` 或裸数组，两种形态都见过就先都认）→ { ok, rows, total }。
 * 逐行归一：只保证 `no` 与 `name` 是真字段，其余缺了就是 null/''——**绝不替平台补数据**。
 * `key`（服务端掩码）原样透传，防御性再掩一道由宿主做（与 ocKeyMask 同口径，那里注释更全）。
 */
function tfNormalizeTokenList(data) {
  const d = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : null
  const arr = Array.isArray(data) ? data : (d !== null && Array.isArray(d.items) ? d.items : null)
  if (arr === null) return { ok: false, rows: [], total: 0 }
  const rows = []
  for (const raw of arr) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const no = tfTokenNo(raw.token_no !== undefined ? raw.token_no : raw.id)
    if (no === null) continue // 没有主键的行对不上删除/启停，留着只会误操作
    const name = str(raw.name).trim().slice(0, TF_KEY_NAME_MAX)
    const st = num(raw.status)
    const unlimited = raw.unlimited_quota === true
    // 平台用 `-1` 表示「永不过期」（它自己的格式化器直接显示 Never）。tsToMs 按哨兵把 -1
    // 折成 null——这里把它显式还原成 neverExpire，两者都不会错显成「没有到期信息」。
    const expiredRaw = num(raw.expired_time)
    const never = expiredRaw === -1
    rows.push({
      no,
      name,
      status: st,
      keyMask: str(raw.key).slice(0, 128),
      unlimited,
      remainQuota: unlimited ? null : num(raw.remain_quota),
      usedQuota: num(raw.used_quota),
      // -1（永不过期）归一为「没有到期时间」；其它按秒/毫秒/字符串统一成毫秒（tsToMs 口径）
      expiredAtMs: never ? null : tsToMs(raw.expired_time),
      neverExpire: never,
      createdAtMs: tsToMs(raw.created_time),
      accessedAtMs: tsToMs(raw.accessed_time),
      modelLimitsEnabled: raw.model_limits_enabled === true && str(raw.model_limits).trim() !== '',
      modelLimits: str(raw.model_limits).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 64),
    })
  }
  const total = d !== null ? num(d.total) : null
  return { ok: true, rows, total: total !== null && total >= 0 ? Math.trunc(total) : rows.length }
}

/**
 * 创建载荷装配（字段集与官方 toX() 逐字一致，不多不少）。
 * 入参是宿主路由校验过的原始值；这里做最后一道归一与范围收口，返回 null = 输入不可用
 * （调用方转成 400，绝不带着半吊子 body 去 POST——创建是真会改变账号状态的动作）。
 *   · name：1..128 非空；
 *   · unlimited=true → remain_quota 恒 0（官方表单在 unlimited 时把金额输入置灰，提交也带 0）；
 *   · unlimited=false → quotaYuan ∈ (0, 1000000] 折整 quota = round(yuan × quotaPerUnit)，
 *     quotaPerUnit 由宿主从 /api/status 取（拿不到用与平台同源的 5e5 兜底，同一口径）；
 *   · expiredDays：>0 → now + days×86400（1..3650 天，再长就是误填）；0/缺 → -1（永不）。
 * 限模型本版插件不做：enabled false + limits ''（官方表单默认值同样是不限）。
 */
function tfTokenCreateBody(input, quotaPerUnit) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null
  const name = str(input.name).trim().slice(0, TF_KEY_NAME_MAX)
  if (name === '') return null
  const unlimited = input.unlimited === true
  let remain = 0
  if (!unlimited) {
    const yuan = num(input.quotaYuan)
    if (yuan === null || yuan <= 0 || yuan > 1000000) return null
    const qpu = num(quotaPerUnit)
    if (qpu === null || !(qpu > 0)) return null
    remain = Math.round(yuan * qpu)
    if (!(remain > 0)) return null
  }
  const days = num(input.expiredDays)
  if (days !== null && (days < 0 || days > 3650)) return null
  const expired = days !== null && days > 0
    ? Math.floor(Date.now() / 1000) + Math.trunc(days) * 86400
    : -1
  return {
    name,
    remain_quota: remain,
    expired_time: expired,
    unlimited_quota: unlimited,
    model_limits_enabled: false,
    model_limits: '',
  }
}

/** 创建响应里的明文 key 归一：非空、限长 256、且**不得是掩码形态**（含 * 的一律拒——
 *  平台哪天改成列表回显掩码混进创建口，宁可判「没拿到明文」也不把一串星号存成副本）。 */
function tfCreatedKeyPlaintext(raw) {
  const s = str(raw).trim()
  if (s === '' || s.length > 256 || s.indexOf('*') >= 0) return null
  return s
}

/** 本机明文副本上限（与 OpenCSG 同口径 50：密钥不是账单流水，正常用量远到不了；
 *  到顶截最旧，防历史脏数据把 state 文件撑爆）。 */
const TF_SAVED_KEY_MAX = 50

/**
 * 本机留存的一条明文密钥净化 → 记录 | null。判据与 ocSavedKeyEntry 同一套
 * （入参是**宿主 state 文件里的条目**，防历史脏数据/手改坏档）：
 *   · `no`：过 tfTokenNo——对不上列表行的副本是废条目；
 *   · `token`：过 tfCreatedKeyPlaintext——没有明文的副本毫无价值；
 *   · `name` 空也收（≤128）；时间字段可缺（列表行才是权威，这只是创建时快照）；
 *   · `savedAt` 必须正毫秒，缺失按 nowMs 兜。
 */
function tfSavedKeyEntry(raw, nowMs) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const no = tfTokenNo(raw.no)
  if (no === null) return null
  const token = tfCreatedKeyPlaintext(raw.token)
  if (token === null) return null
  const savedAt = num(raw.savedAt)
  const now = num(nowMs)
  const at = savedAt !== null && savedAt > 0 ? Math.trunc(savedAt) : (now !== null && now > 0 ? Math.trunc(now) : null)
  if (at === null) return null
  return {
    no,
    name: str(raw.name).trim().slice(0, TF_KEY_NAME_MAX),
    token,
    createdAtMs: num(raw.createdAtMs),
    expiredAtMs: num(raw.expiredAtMs),
    savedAt: at,
  }
}

/**
 * 本机密钥库归一：`{ [identifier小写]: [条目…] }`。不变式与 ocNormalizeSavedKeys
 * 完全同一套（**串号是安全事故**）：键小写归一、**只认账号池内的 identifier**（池外槽整槽
 * 丢弃——绝不让 A 账号的明文挂到 B 账号名下）、逐条过 tfSavedKeyEntry、保序不重排、
 * 每账号 ≤ TF_SAVED_KEY_MAX 条、整库 ≤ 20 个账号（与 sessions 同口径）。池空 → 整库清空。
 */
function tfNormalizeSavedKeys(input, accounts) {
  const pool = new Set()
  if (Array.isArray(accounts)) {
    for (const a of accounts) {
      if (a !== null && typeof a === 'object' && !Array.isArray(a) && typeof a.identifier === 'string' && a.identifier !== '') {
        pool.add(a.identifier.toLowerCase())
      }
    }
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input) || pool.size === 0) return {}
  const out = {}
  for (const [rawKey, rawList] of Object.entries(input)) {
    const key = typeof rawKey === 'string' ? rawKey.trim().toLowerCase() : ''
    if (key === '' || !pool.has(key) || !Array.isArray(rawList)) continue
    const rows = []
    for (const raw of rawList) {
      const rec = tfSavedKeyEntry(raw, Date.now())
      if (rec === null) continue
      rows.push(rec)
      if (rows.length >= TF_SAVED_KEY_MAX) break
    }
    out[key] = rows
    if (Object.keys(out).length >= 20) break
  }
  return out
}

export {
  TF_BASE, TF_UA, TF_PATH, TF_QUOTA_PER_UNIT_FALLBACK,
  tfNormalizePlans, tfNormalizeQuote, tfDurationLabel, tfHigherPlans,
  tfHeaders, tfCookieFromSetCookie, tfCookieEntries, tfHasSessionCookie,
  tfEnvelope, tfErrorText, TF_CODE_TEXT, tfDeterministicLoginFailure,
  tfRoleName, TF_ROLE_NAMES,
  tfTsToMs,
  tfNormalizeUser, tfNormalizeUsageRows, tfNormalizeSubscriptions, tfUsageDayBuckets,
  tfSubSourceName, tfSubStatusName, TF_SUB_SOURCE_NAMES, TF_SUB_STATUS_NAMES,
  TF_KEY_STATUS_NAMES, TF_KEY_NAME_MAX, TF_SAVED_KEY_MAX,
  tfTokenNo, tfNormalizeTokenList, tfTokenCreateBody, tfCreatedKeyPlaintext,
  tfSavedKeyEntry, tfNormalizeSavedKeys,
}
