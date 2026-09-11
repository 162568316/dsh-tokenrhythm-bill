/**
 * 阶跃星辰（StepFun）Step Plan 协议层（纯函数，零依赖）。
 *
 * 背景：阶跃没有公开「套餐 Credit 余额」API。本模块复刻控制台的内部 RPC：
 *   1) account.stepfun.com  PassportService/RegisterDevice   → Set-Cookie: Oasis-Token/Oasis-Webid（匿名设备 token）
 *   2) account.stepfun.com  PassportService/SignInByPassword → 用户 token（activated:true，~30min）
 *   3) platform.stepfun.com /api/<devcenter FQN>/<Method>    → GetStepPlanStatus / QueryStepPlanRateLimit / QueryStepPlanUsages
 * 关键实测结论：登录凭据**必须**经 Cookie 通道送回（oasis-token 头通道一律 "token is illegal"）。
 *
 * 传输为 grpc-web：请求体 = [0x00 | u32be len | protobuf message]；
 * 响应含数据帧（flag 0x00）与 trailer 帧（flag 0x80，"grpc-status: N\r\ngRPC-message: ..."）。
 * 网关对 content-type: application/grpc-web+proto 接受二进制帧（application/json 直传则按帧读原始字节）。
 *
 * protobuf wire 字段号（自平台前端 bundle 反解，2026-09 实测）：
 *   SignInByPasswordRequest  { 1 username:string, 2 password:string }
 *   AccessToken              { 1 raw:string, 2 duration:int64 }
 *   SignInByPasswordResponse { 1 access_token:AccessToken, 2 refresh_token:RefreshToken }
 *   RegisterDeviceResponse   { 1 access_token, 2 refresh_token, 3 device{2 deviceID} }
 *   GetStepPlanStatusResponse{ 1 status:enum, 2 desc:string, 3 subscription, 4 agreement, 5 plan_definition, 6 can_resign:bool }
 *   UserPlanSubscription     { 1 plan_type:enum, 2 name:string, 3 status:enum, 5 activated_at, 6 expired_at, 7 auto_renew:bool, 8 plan_id }
 *   QueryStepPlanRateLimitResponse { 1 status, 2 desc, 3 five_hour_usage_left_rate, 5 weekly_usage_left_rate,
 *                                    11 plan_credit_rate_limit { 1 subscription_credit_left_rate, 2 subscription_credit_reset_time,
 *                                                               3 topup_credit_left_rate, 4 credit_buckets[] } }
 *   PlanCreditBucket         { 1 type:enum, 2 credit_total:int64, 3 credit_residual:int64, 4 expire_at, 5 next_reset_at }
 *   QueryStepPlanUsagesResponse{ 1 status, 2 desc, 3 records[]{ 1 from_time, 2 to_time, 3 model_id, 4 calls, 5 credit_consumed }, 4 total }
 */

// ---------------------------------------------------------------- protobuf 最小编解码

/** 无符号 varint → Buffer */
function varintBytes(n) {
  const out = []
  let v = typeof n === 'bigint' ? n : BigInt(Math.trunc(n))
  if (v < 0n) v = 0n
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    out.push(b)
  } while (v > 0n)
  return Buffer.from(out)
}

/** 读 varint（int64 安全）：返回 [值, 新位置]；溢出截断为 Number */
function readVarint(buf, p) {
  let result = 0n
  let shift = 0n
  let i = p
  for (;;) {
    if (i >= buf.length) return [null, i]
    const b = buf[i++]
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7n
    if (shift > 70n) return [null, i] // 恶意长 varint
  }
  const num = Number(result & 0xffffffffffffffffn)
  return [num, i]
}

/** length-delimited 字段（tag: 字段号 << 3 | 2） */
function pbString(fieldNo, str) {
  const s = Buffer.from(String(str), 'utf8')
  return Buffer.concat([Buffer.from([(fieldNo << 3) | 2]), varintBytes(s.length), s])
}

/** varint 字段（tag: 字段号 << 3 | 0） */
function pbVarint(fieldNo, num) {
  const n = Number(num) || 0
  return Buffer.concat([Buffer.from([(fieldNo << 3) | 0]), varintBytes(n < 0 ? 0 : Math.trunc(n))])
}

/** 嵌套消息字段 */
function pbMessage(fieldNo, inner) {
  return Buffer.concat([Buffer.from([(fieldNo << 3) | 2]), varintBytes(inner.length), inner])
}

/** 解一条消息为 [{no, wt, val}]；wt=2 → Buffer，wt=0 → Number；遇未知 wiretype 即停（防御） */
function pbDecode(buf) {
  const out = []
  let i = 0
  while (i < buf.length) {
    const [key, p2] = readVarint(buf, i)
    if (key === null) break
    i = p2
    const no = Number(key) >> 3
    const wt = Number(key) & 7
    if (wt === 2) {
      const [len, p3] = readVarint(buf, i)
      if (len === null || p3 + len > buf.length) break
      out.push({ no, wt, val: buf.slice(p3, p3 + len) })
      i = p3 + len
    } else if (wt === 0) {
      const [v, p3] = readVarint(buf, i)
      if (v === null) break
      out.push({ no, wt, val: v })
      i = p3
    } else if (wt === 5) {
      if (i + 4 > buf.length) break
      out.push({ no, wt, val: buf.readUInt32LE(i) })
      i += 4
    } else if (wt === 1) {
      if (i + 8 > buf.length) break
      out.push({ no, wt, val: Number(buf.readBigUInt64LE(i)) })
      i += 8
    } else break
  }
  return out
}

/** 取某字段（首个匹配）；wiretype2 时可选递归解码 */
function pbField(fields, no) {
  const f = fields.find((x) => x.no === no)
  return f ? f.val : undefined
}
function pbStr(fields, no) {
  const v = pbField(fields, no)
  return Buffer.isBuffer(v) ? v.toString('utf8') : (typeof v === 'number' ? v : null)
}
function pbNum(fields, no) {
  const v = pbField(fields, no)
  return typeof v === 'number' ? v : (Buffer.isBuffer(v) && v.length === 4 ? v.readUInt32LE(0) : null)
}
function pbSub(fields, no) {
  const v = pbField(fields, no)
  return Buffer.isBuffer(v) ? pbDecode(v) : null
}
/** repeated 子消息（同字段号全部） */
function pbSubs(fields, no) {
  return fields.filter((x) => x.no === no && Buffer.isBuffer(x.val)).map((x) => pbDecode(x.val))
}

// ---------------------------------------------------------------- grpc-web 帧

/** protobuf message → grpc-web 数据帧 */
function encodeFrame(msg) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(msg.length, 0)
  return Buffer.concat([Buffer.from([0]), len, msg])
}

/**
 * 解析 grpc-web 响应字节 → { data: 解码字段|null, grpcStatus:number|null, grpcMessage:string }
 * trailer 帧 flag 高位为 1（0x80/0x88）；HTTP 头里的 grpc-status 作兜底由调用方处理，
 * 此函数额外返回 bodyTrailerStatus。
 */
function parseGrpcWeb(buf) {
  let data = null
  let trailer = ''
  let i = 0
  while (i + 5 <= buf.length) {
    const flag = buf[i]
    const len = buf.readUInt32BE(i + 1)
    if (len < 0 || i + 5 + len > buf.length) break
    const chunk = buf.slice(i + 5, i + 5 + len)
    i += 5 + len
    if ((flag & 0x80) !== 0) trailer += chunk.toString('utf8')
    else if (data === null) data = chunk
  }
  let grpcStatus = null
  let grpcMessage = ''
  for (const line of trailer.split(/\r?\n/)) {
    const m = line.match(/^grpc-(status|message):\s*(.*)$/i)
    if (!m) continue
    if (m[1].toLowerCase() === 'status') grpcStatus = Number(m[2])
    else { try { grpcMessage = decodeURIComponent(m[2]) } catch { grpcMessage = m[2] } }
  }
  return { data: data === null ? null : pbDecode(data), grpcStatus, grpcMessage, dataRaw: data }
}

// ---------------------------------------------------------------- 请求编码
// 【已弃用·2026-09】密码登录已改 JSON 通道（见 index.js stepLogin）：官方前端本就是
// application/json，这些 grpc-web 帧编码是协议考古遗物，仅保留供 passport 万一回退时用。

/** [已弃用] SignInByPassword 请求帧（现走 JSON：{username,password}） */
function encodeSignInByPassword(username, password) {
  return encodeFrame(Buffer.concat([pbString(1, username), pbString(2, password)]))
}

/** [已弃用] RegisterDevice 请求帧（现走 JSON 空体 {}） */
function encodeRegisterDevice() {
  return encodeFrame(Buffer.alloc(0))
}

/** QueryStepPlanUsagesRequest：{1 start_time, 2 to_time, 3 page, 4 page_size, 5 granular_hour} */
function encodeQueryUsages({ startTime, toTime, page = 1, pageSize = 100, granularHour = 0 } = {}) {
  const parts = []
  if (startTime != null) parts.push(pbVarint(1, startTime))
  if (toTime != null) parts.push(pbVarint(2, toTime))
  parts.push(pbVarint(3, page), pbVarint(4, pageSize), pbVarint(5, granularHour))
  return encodeFrame(Buffer.concat(parts))
}

/** 解析登录响应（SignIn/RegisterDevice 通用外层：1=access_token{1 raw,2 duration}，2=refresh_token{1 raw}） */
function parseAuthResponse(fields) {
  const at = pbSub(fields || [], 1)
  const rt = pbSub(fields || [], 2)
  return {
    accessToken: at ? { raw: pbStr(at, 1), duration: pbNum(at, 2) } : null,
    refreshToken: rt ? { raw: pbStr(rt, 1) } : null,
  }
}

/** RegisterDevice 完整解析（附 device.deviceID，供 webid 记忆） */
function parseRegisterDeviceResponse(fields) {
  const base = parseAuthResponse(fields)
  const dev = pbSub(fields || [], 3)
  return { ...base, deviceId: dev ? pbStr(dev, 2) : null }
}

/** JWT exp（秒）—— 惰性续命判定用；解不出返回 null */
function jwtExpiry(token) {
  try {
    const seg = String(token).split('.')[1]
    if (!seg) return null
    const json = JSON.parse(Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return typeof json.exp === 'number' ? json.exp : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- 响应归一

/**
 * GetStepPlanStatusResponse → 订阅摘要。
 * 任何字段缺失都降级为 null，绝不抛出（内部接口，字段随平台漂移）。
 * 通道形态（2026-09 CDP 抓包坐实）：devcenter 三个方法都是**同款 URL 的 JSON 接口**
 * （content-type: application/json，请求体 {} 或 camelCase JSON），返回体里的
 * `status:1` 才是成功——不是 protobuf 零值 0。曾用 grpc-web 帧硬发，网关只回
 * 200 空 body，白烧了一晚上。protobuf 字段号与 JSON 键名一一对应，bundle 没白挖。
 */
function jnum(v) {
  const x = typeof v === 'string' ? Number(v) : v
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}
function jstr(v) { return typeof v === 'string' ? v : null }
function jobj(v) { return v && typeof v === 'object' ? v : null }

/** GetStepPlanStatusResponse(JSON) → 套餐摘要 */
function normalizeStepPlanStatus(json) {
  const j = jobj(json)
  if (j === null) return null
  const sub = jobj(j.subscription)
  const def = jobj(j.plan_definition)
  return {
    ok: j.status === 1, // JSON 通道：1=OK（实测），0 反而是"无数据"枚举
    desc: jstr(j.desc) || '',
    tier: sub ? jstr(sub.name) : null, // 实测 "Mini"
    planType: sub ? jnum(sub.plan_type) : null,
    planStatus: sub ? jnum(sub.status) : null,
    activatedAt: sub ? jnum(sub.activated_at) : null,
    expireAt: sub ? jnum(sub.expired_at) : null,
    autoRenew: sub ? (sub.auto_renew === true || sub.auto_renew === 1) : null,
    planId: sub ? (jstr(sub.plan_id) ?? jnum(sub.plan_id)) : null,
    canResign: j.can_resign === true,
    priceCny: def ? jnum(def.price) : null, // 单位分（实测 "45600" = ¥456/年）
    durationDays: def ? jnum(def.duration_days) : null,
  }
}

/**
 * QueryStepPlanRateLimitResponse(JSON) → Credit 池摘要。
 * credit_buckets[].type：1=订阅月池（实测 total 4e8，residual 字符串大数）；2=加油包。
 * subscription_credit_left_rate 是 0~1 小数（实测 0.9782602）。
 */
function normalizeStepCredit(json) {
  const j = jobj(json)
  if (j === null) return null
  const pcl = jobj(j.plan_credit_rate_limit)
  if (pcl === null) return null
  const buckets = (Array.isArray(pcl.credit_buckets) ? pcl.credit_buckets : [])
    .map((b) => jobj(b))
    .filter((b) => b !== null)
    .map((b) => ({
      type: jnum(b.type),
      total: jnum(b.credit_total),
      residual: jnum(b.credit_residual),
      expireAt: jnum(b.expire_at),
      nextResetAt: jnum(b.next_reset_at),
    }))
  let total = 0
  let residual = 0
  let has = false
  for (const b of buckets) {
    if (b.total != null) { total += b.total; has = true }
    if (b.residual != null) { residual += b.residual; has = true }
  }
  const topup = buckets.find((b) => b.type === 2) || null
  return {
    ok: j.status === 1,
    desc: jstr(j.desc) || '',
    subscriptionLeftRate: jnum(pcl.subscription_credit_left_rate), // 0~1 小数
    subscriptionResetAt: jnum(pcl.subscription_credit_reset_time),
    topupLeftRate: jnum(pcl.topup_credit_left_rate),
    buckets,
    credits: has ? { total, residual, used: Math.max(0, total - residual) } : null,
    hasTopup: !!topup,
  }
}

/** QueryStepPlanUsagesResponse(JSON) → [{from,to,model,calls,credit}]
 * proto 字段名（bundle 挖证）：StepPlanUsageRecord{1 from_time,2 to_time,3 model_id,4 calls,5 credit_consumed}；
 * 键名防 camel/snake 双漂移。官方页面实证：from_time/to_time 是「毫秒」粒度
 * （如 1786118400000 = 当地日界 00:00），统一归一到秒，客户端按秒*1000 渲染。 */
function normalizeStepUsages(json) {
  const j = jobj(json)
  if (j === null) return []
  const toSec = (v) => {
    const x = jnum(v)
    if (x === null || x === 0) return x
    return x > 1e12 ? Math.floor(x / 1000) : x // >1e12 视为毫秒
  }
  return (Array.isArray(j.records) ? j.records : [])
    .map((r) => jobj(r))
    .filter((r) => r !== null)
    .map((r) => ({
      from: toSec(r.from_time ?? r.from ?? r.start_time),
      to: toSec(r.to_time ?? r.to ?? r.end_time),
      model: jstr(r.model_id ?? r.modelId) || '',
      calls: jnum(r.calls ?? r.total_calls ?? r.count),
      credit: jnum(r.credit_consumed ?? r.credit),
    }))
}

/**
 * 官方 GET /v1/accounts JSON → 预付费摘要（非 protobuf）。
 * 实测响应是 camelCase：{"type":"prepaid","balance":0,"totalCash":0,"totalVoucher":0}
 * ——不是 OpenAI 风格 snake_case，曾按 total_cash_balance 取键永远读出 null，教训。
 */
function normalizeStepAccounts(json) {
  if (!json || typeof json !== 'object') return null
  const num = (v) => {
    const x = typeof v === 'string' ? Number(v) : v
    return typeof x === 'number' && Number.isFinite(x) ? x : null
  }
  return {
    type: typeof json.type === 'string' ? json.type : null, // prepaid | postpaid
    balance: num(json.balance),
    totalCash: num(json.totalCash ?? json.total_cash_balance ?? json.total_cash),
    totalVoucher: num(json.totalVoucher ?? json.total_voucher_balance ?? json.total_voucher),
  }
}

/**
 * 控制台钱包 QueryAccountBalanceResponse(JSON，实测坐实) → 与官方 /v1/accounts 同形（元）。
 * {"voucher":"1396","payment":"0","balance":"1396","cost_yesterday":"0","cost_month":"0",
 *  "cost_total":"763","credit":"0","voucher_api":"1396","voucher_plan":"0"}
 * **金额字段单位是分**（对照 ListStepPlans price "9900"=¥99/月；用户实测口径纠正）：
 * balance=payment(现金)+voucher(赠送)；赠送再拆 API 券/套餐券。有浏览器会话就走这条
 * 免 key 通道，且信息比 /v1/accounts 更全（带消耗统计）。
 */
function normalizeStepWallet(json) {
  const j = jobj(json)
  if (j === null) return null
  const toYuan = (v) => { const x = jnum(v); return x === null ? null : x / 100 }
  return {
    type: 'prepaid',
    balance: toYuan(j.balance),
    totalCash: toYuan(j.payment),
    totalVoucher: toYuan(j.voucher),
    voucherApi: toYuan(j.voucher_api),
    voucherPlan: toYuan(j.voucher_plan),
    costYesterday: toYuan(j.cost_yesterday),
    costMonth: toYuan(j.cost_month),
    costTotal: toYuan(j.cost_total),
  }
}

// ---------------------------------------------------------------- 胶囊仲裁（纯函数）

/**
 * 入口胶囊内容仲裁：provider 面板切换 → 胶囊跟随。
 * prefs.stepEntry = { takeover:true|false, mode:'auto'|'credits'|'balance' }
 * 返回 { provider:'step'|'tr', value, label } —— provider:'tr' 表示沿用基元现有胶囊。
 */
function pickStepEntryDisplay({ activeProvider, credit, account, prefs }) {
  const p = prefs || {}
  if (activeProvider !== 'step' || p.takeover === false) return { provider: 'tr' }
  // 与 client.js computeStepEntry 逐字同口径（非法 mode 归 auto、balance 用 Number.isFinite
  // 防 NaN 混入）——两份实现由 tests/step.spec.mjs 的同步用例表锁死，单边改动即红。
  const mode = p.mode === 'credits' || p.mode === 'balance' ? p.mode : 'auto'
  const credits = mode === 'auto' || mode === 'credits'
  const balance = mode === 'auto' || mode === 'balance'
  if (credits && credit && credit.credits && credit.credits.total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round((credit.credits.residual / credit.credits.total) * 1000) / 10))
    return { provider: 'step', label: '阶跃', value: pct + '%' }
  }
  if (balance && account && Number.isFinite(account.balance)) {
    return { provider: 'step', label: '阶跃', value: '¥' + account.balance.toFixed(2) }
  }
  return { provider: 'tr' } // 两者皆无 → 回落基元，不出现空胶囊
}

// ---------------------------------------------------------------- 平台内部 RPC 端点（焊死）

/**
 * devcenter 仪表盘服务全名。2026-07 实测（用户控制台 F12 坐实）：
 *   https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus
 * 注意名字**没有** `Service` 后缀——按惯例猜名的 110 次全部 404，教训在此。
 * 同服务下另有 QueryStepPlanRateLimit（Credit 池）/ QueryStepPlanUsages（用量明细）/
 * ListStepPlans（在售档位）/ UserInfo（uid/mobile/nickname）。
 * 2026-09 CDP 抓包再坐实：这些是**JSON 接口**（application/json + 空对象体），
 * 与 account.stepfun.com 的 passport 登录（真 grpc-web）不是一套传输，别搞混。
 */
const STEP_DEV_SERVICE = 'step.openapi.devcenter.Dashboard'

// ---------------------------------------------------------------- 登录两步协议装配

const STEP_ACCOUNT_BASE = 'https://account.stepfun.com'
const STEP_PLATFORM_BASE = 'https://platform.stepfun.com'
/** 浏览器实测必需静态头 */
const STEP_OASIS_HEADERS = {
  'oasis-appid': '10300',
  'oasis-platform': 'web',
  'oasis-language': 'zh-CN',
}

/** 登录链第一步 URL */
function stepRegisterUrl() {
  return STEP_ACCOUNT_BASE + '/passport/proto.api.passport.v1.PassportService/RegisterDevice'
}
/** 登录链第二步 URL */
function stepSignInUrl() {
  return STEP_ACCOUNT_BASE + '/passport/proto.api.passport.v1.PassportService/SignInByPassword'
}
/** 套餐 RPC URL（由导入路径拼平台域） */
function stepRpcUrl(path) {
  return STEP_PLATFORM_BASE + path
}

export {
  // codec
  varintBytes, readVarint, pbString, pbVarint, pbMessage, pbDecode,
  pbField, pbStr, pbNum, pbSub, pbSubs,
  // grpc-web
  encodeFrame, parseGrpcWeb,
  // 请求编码 / 响应解析
  encodeSignInByPassword, encodeRegisterDevice, encodeQueryUsages,
  parseAuthResponse, parseRegisterDeviceResponse, jwtExpiry,
  // 归一
  normalizeStepPlanStatus, normalizeStepCredit, normalizeStepUsages, normalizeStepAccounts, normalizeStepWallet,
  // 胶囊
  pickStepEntryDisplay,
  // 常量
  STEP_ACCOUNT_BASE, STEP_PLATFORM_BASE, STEP_OASIS_HEADERS, STEP_DEV_SERVICE,
  stepRegisterUrl, stepSignInUrl, stepRpcUrl,
}
