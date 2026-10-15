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
 * Set-Cookie 归一：字符串数组（推荐，`headers.getSetCookie()` 的结果）、单个字符串、
 * 空值都接受。
 *
 * 为什么还要留「拼接串」这条路：`getSetCookie()` 是较新的 undici API，宿主 Node 旧一点
 * 就只剩 `headers.get('set-cookie')`——那是一条用 ", " 拼起来的串。**不能直接按逗号切**：
 * `Expires=Wed, 21 Oct 2026 07:28:00 GMT` 里也有逗号。
 */
function tfCookieEntries(raw) {
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
 * 为什么需要它：**Node 的 fetch 没有 cookie jar**，30 天会话全靠我们自己接住再回传。
 * 只取每条的 `name=value` 段，属性（Path/HttpOnly/SameSite/Expires…）全部丢弃——
 * 属性不是浏览器该回传的东西。同名 cookie 只留第一次出现的（服务端可能重复下发，
 * 后一个通常是清理用的空值，覆盖会把有效会话抹掉）。
 */
function tfCookieFromSetCookie(raw) {
  const parts = []
  const seen = new Set()
  for (const item of tfCookieEntries(raw)) {
    const head = item.split(';')[0].trim()
    const eq = head.indexOf('=')
    if (eq <= 0) continue
    const name = head.slice(0, eq).trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    parts.push(head)
  }
  return parts.join('; ')
}

/** Set-Cookie 里是否下发了 `session`（登录是否真的成功的判据）。*/
function tfHasSessionCookie(raw) {
  for (const item of tfCookieEntries(raw)) {
    const head = item.split(';')[0]
    const eq = head.indexOf('=')
    if (eq > 0 && head.slice(0, eq).trim() === 'session') return true
  }
  return false
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
 * 平台业务码 → 中文。平台自己的 message 是英文的，界面全中文，故映射；
 * **没映射到的一律回平台原文**（宁可露英文也不吞错），两个都没有才回 '未知错误'。
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

function tfErrorText(code, message) {
  const c = typeof code === 'string' ? code : ''
  const m = typeof message === 'string' ? message.trim() : ''
  if (Object.prototype.hasOwnProperty.call(TF_CODE_TEXT, c)) return TF_CODE_TEXT[c] + (m !== '' ? '（' + m + '）' : '')
  if (m !== '' && c !== '') return m + '（' + c + '）'
  if (m !== '') return m
  if (c !== '') return c
  return '未知错误'
}

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
 * 时间戳归一 → 毫秒。口径容忍三种（Go 后端常见混用，不猜就崩）：
 *   - 数字：> 1e12 视为毫秒，否则视为秒；**≤ 0 → null**
 *   - 数字字符串：同上（含前导 `-`，平台会拿 `-1` 当哨兵）
 *   - RFC3339/ISO 字符串：Date.parse；解不出 → null
 *
 * 为什么 `-1` 必须判成 null 而不是「1969 年」：平台自己的格式化器就是这个口径——
 * `fk(t)`：`0 / -1 / falsy → "-"`；`Ey(t)`（过期时间专用）：`-1 → "Never"`。
 * 若照 -1×1000 算，`end_time = -1`（永不过期）会被算成已过期，当前套餐直接消失，
 * 界面还会显示 1970-01-01。
 */
function tfTsToMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (!(v > 0)) return null
    return v > 1e12 ? Math.trunc(v) : Math.trunc(v * 1000)
  }
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '') return null
    if (/^-?\d+$/.test(s)) return tfTsToMs(Number(s))
    const parsed = Date.parse(s)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

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

/** 数字字段统一：非有限数 → null。**缺失与 0 必须分清**（0 是有效额度）。*/
function tfNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 字符串字段统一：非字符串 → ''（不把 undefined 泄进界面，界面只判空串）。*/
function tfStr(v) {
  return typeof v === 'string' ? v : ''
}

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
      status: tfStr(sub.status),
      statusName: tfSubStatusName(sub.status),
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

function tfDeterministicLoginFailure(code) {
  const c = typeof code === 'string' ? code : ''
  return c === 'LOGIN_CREDENTIALS_REQUIRED' || c === 'LOGIN_INVALID_CREDENTIALS'
    || c === 'TF_2FA_REQUIRED' || c === 'TF_SHAPE' || c === 'TF_NO_COOKIE'
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
}
