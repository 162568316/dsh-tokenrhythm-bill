/**
 * dsh-tokenrhythm-bill —— ZCode 桌面端凭证访问层（host 半边）。
 *
 * 功能来源：移植 zcode-switch v1.5.4（https://github.com/pjpv/zcode-switch，MIT）
 * 的额度查询（quota.rs）与活动领取（claim.rs）核心逻辑——读 ~/.zcode/v2 下的
 * 凭证文件、按 ZCode 桌面端同款请求头直连官方接口。本文件只放**纯逻辑**（加解密 /
 * token 候选链 / 请求头构造 / 响应归一化），文件读写与网络请求在 index.js。
 *
 * 安全边界与既有约定一致：token / user_id 只在 host 内存出现，浏览器只见掩码。
 */

import { createHash, createDecipheriv, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// ---- 上游端点（与 zcode-switch quota.rs / claim.rs 同源）----
export const ENC_PREFIX = 'enc:v1:'
export const CLIENT_APP_VERSION = '3.11.2'
export const ZCODE_ORIGIN = 'https://zcode.z.ai'
export const ZCODE_LANG = 'zh-CN'
export const ZCODE_CHANNEL = 'stable'
export const QUOTA_LIMIT_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
export const SUBSCRIPTION_URL = 'https://open.bigmodel.cn/api/biz/subscription/list'
export const BILLING_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance'
export const BILLING_PREVIEW_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/preview'
export const BILLING_CLAIM_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/claim'
export const CLIENT_CONFIGS_URL = 'https://zcode.z.ai/api/v1/client/configs'
export const EVENT_REPORT_URL = 'https://zcode.z.ai/api/v1/event/report'
export const ACTIVATION_EVENTS = ['app_launch', 'app_daily_active']

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// =====================================================================
// zcrypto：enc:v1 加密格式（ZCode 客户端凭据加密的复刻，向量来自
// zcode-switch test-vectors/node-enc-v1.json 的跨语言对拍）
// =====================================================================

// process.platform 本就是 node 语义（darwin/win32/linux），与 Rust 端
// node_platform_for(env::consts::OS) 的映射结果一致。
export function composeFallbackSecret(platform, home, username) {
  return 'zcode-credential-fallback:' + platform + ':' + home + ':' + username
}

function pickUsername() {
  if (process.platform !== 'win32') {
    try {
      const n = execFileSync('id', ['-un'], { encoding: 'utf8', timeout: 3000 }).trim()
      if (n !== '') return n
    } catch { /* id 不可用 → env 兜底 */ }
  }
  const u = (process.env.USERNAME || process.env.USER || process.env.LOGNAME || '').trim()
  return u !== '' ? u : 'unknown'
}

/**
 * 凭据解密密钥：$ZCODE_CREDENTIAL_SECRET 优先，否则 ZCode 客户端的
 * fallback 组装式（platform:home:username）。
 */
export function defaultSecret(home) {
  const env = process.env.ZCODE_CREDENTIAL_SECRET
  if (typeof env === 'string' && env !== '') return env
  return composeFallbackSecret(process.platform, String(home), pickUsername())
}

export function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(ENC_PREFIX)
}

/** enc:v1 解密：body = b64url(nonce) . b64url(tag) . b64url(ct)，AES-256-GCM，key=SHA256(secret)。失败抛错。 */
export function decryptWithSecret(value, secret) {
  const body = String(value).slice(ENC_PREFIX.length)
  const parts = body.split('.')
  if (parts.length !== 3) throw new Error('enc:v1 格式不正确')
  const b64url = (s) => Buffer.from(s, 'base64url')
  const nonce = b64url(parts[0])
  const tag = b64url(parts[1])
  const ct = b64url(parts[2])
  if (nonce.length !== 12) throw new Error('nonce 长度异常')
  const key = createHash('sha256').update(String(secret), 'utf8').digest()
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/** 凭据字段取明文：enc:v1 解密（失败 null），普通值原样。 */
export function decryptCredential(value, secret) {
  if (typeof value !== 'string') return null
  if (!isEncrypted(value)) return value
  try { return decryptWithSecret(value, secret) } catch { return null }
}

/** JWT payload 解码（base64url，无签名校验——只用来读 user_id 等非敏感声明）。 */
export function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.')
  if (parts.length < 2 || parts[1] === '') return null
  try {
    const json = Buffer.from(parts[1].replace(/=+$/, ''), 'base64url').toString('utf8')
    const v = JSON.parse(json)
    return isObj(v) ? v : null
  } catch { return null }
}

/**
 * 凭证身份（zcrypto::identity_with_secret 移植）：active_provider → user_info
 * （display/username/email/id）→ access_token JWT 的 user_id 兜底。
 */
export function identityFromCredentials(creds, secret) {
  const id = { provider: 'bigmodel', username: null, displayName: null, email: null, userId: null }
  if (!isObj(creds)) return id
  const ap = decryptCredential(creds['oauth:active_provider'], secret)
  if (ap && ap.trim() !== '') id.provider = ap.trim()
  const ui = decryptCredential(creds['oauth:' + id.provider + ':user_info'], secret)
  if (ui !== null) {
    let info = null
    try { info = JSON.parse(ui) } catch { info = null }
    if (isObj(info)) {
      id.username = typeof info.username === 'string' ? info.username : null
      id.displayName = typeof info.displayName === 'string' ? info.displayName : null
      id.email = typeof info.email === 'string' ? info.email
        : (isObj(info.rawProfile) && typeof info.rawProfile.email === 'string' ? info.rawProfile.email : null)
      if (info.id !== undefined && info.id !== null) {
        id.userId = typeof info.id === 'string' ? info.id : JSON.stringify(info.id)
      }
    }
  }
  if (id.userId === null) {
    const at = decryptCredential(creds['oauth:' + id.provider + ':access_token'], secret)
    const payload = at !== null ? decodeJwtPayload(at) : null
    if (payload && (typeof payload.user_id === 'string' || typeof payload.sub === 'string')) {
      id.userId = typeof payload.user_id === 'string' ? payload.user_id : payload.sub
    }
  }
  return id
}

/**
 * 遥测 user_id（claim.rs telemetry_user_id 移植）：active_provider 缺省 zai
 * （注意与 identity 的 bigmodel 缺省不同，照源码保留），只认 user_info 里的
 * id / user_id，不跨 provider 借。
 */
export function telemetryUserId(creds, secret) {
  if (!isObj(creds)) return null
  const ap = decryptCredential(creds['oauth:active_provider'], secret)
  const provider = ap && ap.trim() !== '' ? ap.trim() : 'zai'
  const raw = creds['oauth:' + provider + ':user_info']
  if (typeof raw !== 'string') return null
  const plain = decryptCredential(raw, secret)
  if (plain === null) return null
  let info = null
  try { info = JSON.parse(plain) } catch { return null }
  if (!isObj(info)) return null
  const pick = (k) => (typeof info[k] === 'string' && info[k].trim() !== '' ? info[k].trim() : null)
  return pick('id') || pick('user_id')
}

// =====================================================================
// token 候选链（quota.rs candidate_tokens / zai_billing_token 移植）
// =====================================================================

export function looksLikeToken(v) {
  return typeof v === 'string' && v.trim().length > 20
}

/** config.json provider 段里 coding-plan 条目的明文 apiKey（enc: 开头的不算）。 */
export function codingPlanApiKeys(config) {
  const keys = []
  const providers = isObj(config) && isObj(config.provider) ? config.provider : null
  if (providers === null) return keys
  const entries = Object.entries(providers)
    .sort(([, a], [, b]) => (isObj(b) && b.enabled === true ? 0 : 1) - (isObj(a) && a.enabled === true ? 0 : 1))
  for (const [pid, p] of entries) {
    if (!pid.includes('coding-plan')) continue
    const key = isObj(p) && isObj(p.options) && typeof p.options.apiKey === 'string' ? p.options.apiKey : ''
    if (key !== '' && !key.startsWith('enc:') && looksLikeToken(key) && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/**
 * 全量 token 候选（去重、保序）：coding-plan apiKey 优先，其后解密的
 * zcodejwttoken → oauth:{active}:access_token → bigmodel/zai 各 token。
 */
export function candidateTokens(creds, config, secret) {
  const tokens = []
  const add = (plain) => {
    if (plain !== null && looksLikeToken(plain) && !tokens.includes(plain)) tokens.push(plain)
  }
  for (const k of codingPlanApiKeys(config)) tokens.push(k)
  const credsObj = isObj(creds) ? creds : {}
  const active = decryptCredential(credsObj['oauth:active_provider'], secret) || 'zai'
  add(decryptCredential(credsObj.zcodejwttoken, secret))
  for (const key of ['oauth:' + active + ':access_token', 'oauth:bigmodel:access_token', 'oauth:zai:access_token']) {
    add(decryptCredential(credsObj[key], secret))
  }
  return tokens
}

/**
 * z.ai billing 通道专用 token（claim.rs claim_token 兜底移植）：
 * 非 bigmodel 活跃时用 zcodejwttoken，否则找 start-plan provider 的 apiKey。
 */
export function zaiBillingToken(creds, config, secret) {
  const credsObj = isObj(creds) ? creds : {}
  const jwt = decryptCredential(credsObj.zcodejwttoken, secret)
  const active = decryptCredential(credsObj['oauth:active_provider'], secret)
  if (active !== 'bigmodel' && jwt !== null && looksLikeToken(jwt)) return jwt
  if (!isObj(config) || !isObj(config.provider)) return null
  const entries = Object.entries(config.provider)
    .sort(([, a], [, b]) => (isObj(b) && b.enabled === true ? 0 : 1) - (isObj(a) && a.enabled === true ? 0 : 1))
  for (const [pid, p] of entries) {
    if (!pid.includes('start-plan')) continue
    const key = isObj(p) && isObj(p.options) && typeof p.options.apiKey === 'string' ? p.options.apiKey : ''
    if (key !== '' && !key.startsWith('enc:') && looksLikeToken(key)) return key
  }
  return null
}

/** 领取 token（claim.rs claim_token）：解密的 zcodejwttoken 优先，回退 zaiBillingToken。 */
export function claimToken(creds, config, secret) {
  const jwt = decryptCredential(isObj(creds) ? creds.zcodejwttoken : undefined, secret)
  if (jwt !== null && looksLikeToken(jwt)) return jwt
  return zaiBillingToken(creds, config, secret)
}

// =====================================================================
// 请求头构造（quota.rs zai_headers_with_version / bigmodel_headers 移植）
// =====================================================================

export function clientPlatform() {
  return process.platform + '-' + process.arch // darwin-arm64 / darwin-x64 / win32-x64 …
}

export function normalizeVersion(v) {
  const parts = String(v || '').trim().split('.')
  if (parts.length >= 3) return parts[0] + '.' + parts[1] + '.' + parts[2]
  return String(v || '').trim()
}

function darwinAppVersion() {
  // macOS：探测 /Applications/ZCode.app 的 Info.plist（CFBundleShortVersionString）。
  try {
    const text = readFileSync('/Applications/ZCode.app/Contents/Info.plist', 'utf8')
    const m = /CFBundleShortVersionString[\s\S]{0,80}?<string>([^<]+)<\/string>/.exec(text)
    if (m !== null) return normalizeVersion(m[1])
  } catch { /* 找不到就回退常量 */ }
  return null
}

let appVersionCache
export function zcodeAppVersion() {
  if (appVersionCache !== undefined) return appVersionCache
  const env = process.env.ZCODE_APP_VERSION
  if (typeof env === 'string' && env.trim() !== '') { appVersionCache = normalizeVersion(env); return appVersionCache }
  if (process.platform === 'darwin') {
    const v = darwinAppVersion()
    if (v !== null) { appVersionCache = v; return appVersionCache }
  }
  appVersionCache = CLIENT_APP_VERSION
  return appVersionCache
}

let osVersionCache
export function osVersion() {
  if (process.platform === 'win32') return null
  if (osVersionCache !== undefined) return osVersionCache
  try {
    const v = execFileSync('uname', ['-r'], { encoding: 'utf8', timeout: 3000 }).trim()
    osVersionCache = v !== '' ? v : null
  } catch { osVersionCache = null }
  return osVersionCache
}

export function clientTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz || 'unknown'
  } catch { return 'unknown' }
}

/**
 * z.ai 请求头（伪装 ZCode 桌面端）：身份九件套 + 可选 X-Os-Version / X-Device-Mid
 * + Bearer + 每请求 uuid。顺序与 Rust 版一致（测试锁定）。
 */
export function zaiHeaders(token, mid, ver) {
  const v = ver !== undefined ? normalizeVersion(ver) : zcodeAppVersion()
  const h = [
    ['User-Agent', 'ZCode/' + v],
    ['HTTP-Referer', ZCODE_ORIGIN],
    ['X-Title', 'Z Code@electron'],
    ['X-ZCode-App-Version', v],
    ['X-Platform', clientPlatform()],
    ['X-Release-Channel', ZCODE_CHANNEL],
    ['X-Client-Language', ZCODE_LANG],
    ['X-Client-Timezone', clientTimezone()],
    ['X-Os-Category', process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'],
  ]
  const osv = osVersion()
  if (osv !== null) h.push(['X-Os-Version', osv])
  if (typeof mid === 'string' && mid !== '') h.push(['X-Device-Mid', mid])
  h.push(['Authorization', 'Bearer ' + token])
  h.push(['x-request-id', randomUUID()])
  return h
}

/** BigModel 通道头（精简三件套）。 */
export function bigmodelHeaders(token) {
  return [
    ['Authorization', 'Bearer ' + token],
    ['User-Agent', 'ZCode/' + zcodeAppVersion()],
    ['x-request-id', randomUUID()],
  ]
}

/** 激活埋点请求体（claim.rs activation_event_body 移植）。ctx 供测试注入。 */
export function activationEventBody(element, eventId, userId, mid, ctx) {
  const c = isObj(ctx) ? ctx : {}
  return {
    event_id: eventId,
    client_timezone: c.timezone !== undefined ? c.timezone : clientTimezone(),
    client_language: ZCODE_LANG,
    element_name: element,
    event_region: 'app',
    event_type: 'view',
    event_text: '',
    event_extra_detail: {},
    user_id: userId,
    screen_resolution: '2560x1440',
    app_version: c.appVersion !== undefined ? c.appVersion : zcodeAppVersion(),
    device_os_category: c.osCategory !== undefined ? c.osCategory
      : (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'),
    device_os_version: c.osVersion !== undefined ? c.osVersion : (osVersion() || ''),
    device_mid: mid,
    mac_id: '',
    marketing_params: '{}',
  }
}

// =====================================================================
// 额度响应归一化（quota.rs normalize_quota_limit / normalize_balance 移植）
// =====================================================================

export function businessOk(v) {
  if (!isObj(v)) return false
  const code = typeof v.code === 'number' ? v.code : null
  const success = typeof v.success === 'boolean' ? v.success : null
  return (code === null || code === 200 || code === 0) && success !== false
}

/** 反复解 {data}/{result} 信封（最多 4 层，键存在即替换，与 Rust unwrap 同语义）。 */
function unwrapDeep(v) {
  let cur = v
  for (let i = 0; i < 4; i++) {
    if (!isObj(cur)) return cur
    if ('data' in cur) { cur = cur.data; continue }
    if ('result' in cur) { cur = cur.result; continue }
    break
  }
  return cur
}

const toNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, '').trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

function flattenNumbers(obj, prefix, out) {
  if (isObj(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      const p = prefix === '' ? k : prefix + '.' + k
      const n = toNumber(v)
      if (n !== null) out.push([p, n])
      else if (isObj(v) || Array.isArray(v)) flattenNumbers(v, p, out)
    }
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      const p = prefix + '.' + i
      const n = toNumber(v)
      if (n !== null) out.push([p, n])
      else if (isObj(v) || Array.isArray(v)) flattenNumbers(v, p, out)
    })
  }
}

function sumNumbers(pool, keys) {
  let total = 0
  let count = 0
  for (const [path, v] of pool) {
    const name = path.split('.').pop()
    if (keys.includes(name)) { total += v; count++ }
  }
  return count > 0 ? total : null
}

function firstNumber(pool, keys) {
  for (const [path, v] of pool) {
    const name = path.split('.').pop()
    if (keys.includes(name)) return v
  }
  return null
}

const pad2 = (n) => String(n).padStart(2, '0')
const fmtLocal = (d, withTime) => {
  const date = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  return withTime ? date + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) : date
}

/** 毫秒时间戳 → 本地 'MM-DD HH:mm'。 */
export function fmtResetTime(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return null
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return null
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}

const looksLikeDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))
const looksLikeDt = (s) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(s || ''))

/**
 * 到期时间提取（quota.rs extract_expire 移植）：多候选键，毫秒/秒时间戳、
 * RFC3339、"YYYY-MM-DD[ HH:mm]"、"valid" 区间尾段都能认；格式统一
 * 'YYYY-MM-DD HH:mm'（无时分则只有日期）。取不到返回 null。
 */
export function extractExpire(obj) {
  if (!isObj(obj)) return null
  const KEYS = ['nextRenewTime', 'expireTime', 'expire_time', 'endTime', 'end_time', 'expireAt', 'expiredTime', 'validEndTime', 'expires_at', 'expiresAt', 'expired_at', 'period_end']
  for (const k of KEYS) {
    const v = obj[k]
    if (v === undefined || v === null) continue
    const n = typeof v === 'number' ? v : (/^\d+$/.test(String(v).trim()) ? Number(v.trim()) : null)
    if (n !== null) {
      if (n > 1e12) { const d = new Date(n); if (!Number.isNaN(d.getTime())) return fmtLocal(d, true) }
      if (n > 1e9) { const d = new Date(n * 1000); if (!Number.isNaN(d.getTime())) return fmtLocal(d, true) }
      continue
    }
    if (typeof v === 'string') {
      const t = v.trim()
      if (t === '') continue
      const iso = Date.parse(t)
      if (Number.isFinite(iso) && /[TZ]/.test(t)) return fmtLocal(new Date(iso), true)
      const spaced = t.indexOf('T') === 10 ? t.slice(0, 10) + ' ' + t.slice(11) : t
      if (looksLikeDt(spaced)) return spaced.slice(0, 16)
      if (looksLikeDate(spaced)) return spaced.slice(0, 10)
      return t
    }
  }
  if (typeof obj.valid === 'string') {
    const s = obj.valid
    const tail = s.slice(-19)
    if (looksLikeDt(tail)) return tail.slice(0, 16)
    if (looksLikeDate(tail)) return tail.slice(0, 10)
    if (looksLikeDate(s.slice(0, 10))) return s.slice(0, 10)
  }
  return null
}

const expiryField = (v) => {
  if (typeof v === 'string') return v.trim() !== '' ? v.trim() : null
  if (typeof v === 'number') return extractExpire({ expires_at: v })
  return null
}

export function tierFromLevel(level) {
  const l = String(level || '').toLowerCase()
  if (l.includes('max')) return 'Max'
  if (l.includes('pro')) return 'Pro'
  if (l.includes('lite')) return 'Lite'
  return String(level || '')
}

function tierCodeFromDisplay(tier) {
  const t = String(tier || '').toLowerCase()
  if (t.includes('max')) return 'max'
  if (t.includes('pro')) return 'pro'
  if (t.includes('lite')) return 'lite'
  if (t.includes('start')) return 'start'
  if (t.includes('trial') || String(tier || '').includes('体验')) return 'trial'
  return 'other'
}

function planTierFromId(planId, name) {
  const hay = String(planId || '').toLowerCase() + ' ' + String(name || '').toLowerCase()
  if (hay.includes('max')) return ['Max', 'max']
  if (hay.includes('pro')) return ['Pro', 'pro']
  if (hay.includes('lite')) return ['Lite', 'lite']
  if (hay.includes('start')) return ['Start Plan', 'start']
  if (['trial', 'taste', 'experience', 'gift', 'weekend', 'promo', 'activity', '体验'].some((k) => hay.includes(k))) return ['体验', 'trial']
  return [String(planId || ''), 'other']
}

const tierRank = (code) => ({ max: 5, pro: 4, lite: 3, start: 2, trial: 1 }[code || ''] || 0)

/** 展示档位 → 排序权重（多通道合并时选主切片用）。 */
export function tierRankOf(tier) {
  return tierRank(tierCodeFromDisplay(tier))
}

const unitLabel = (unit, number) => {
  switch (unit) {
    case 3: return ['每 ' + (number ?? 5) + ' 小时', 'hours:' + (number ?? 5)]
    case 4: return ['每天', 'daily']
    case 5: return ['每月', 'monthly']
    case 6: return ['每周', 'weekly']
    default: return ['每周期', 'cycle']
  }
}

/**
 * BigModel quota/limit + subscription/list → 统一结构。items[] 每项
 * {name,total,used,remaining,percentUsed,unit,periodEnd,reset}；
 * 顶层 total/used/remaining/percentUsed 取 TIME_LIMIT 主项（无则首个有 total 的）。
 */
export function normalizeQuotaLimit(limitResp, subResp) {
  const data = isObj(limitResp) && isObj(limitResp.data) ? limitResp.data : {}
  const limits = Array.isArray(data.limits) ? data.limits : []
  const items = []
  let main = null
  for (const l of limits) {
    if (!isObj(l)) continue
    const typ = typeof l.type === 'string' ? l.type : ''
    const unit = typeof l.unit === 'number' ? l.unit : null
    const number = typeof l.number === 'number' ? l.number : null
    const total = toNumber(l.usage)
    const used = toNumber(l.currentValue)
    const remaining = toNumber(l.remaining)
    const percentage = toNumber(l.percentage)
    const reset = fmtResetTime(l.nextResetTime)
    const [period, window] = unitLabel(unit, number)
    let name = ''
    let unitStr = ''
    let kind = 'raw'
    if (typ === 'TOKENS_LIMIT') { kind = 'prompt_count'; name = '提示次数（' + period + '）'; unitStr = '次' }
    else if (typ === 'TIME_LIMIT') { kind = 'duration'; name = '使用时长（' + period + '）'; unitStr = '分钟' }
    else name = typ + '（' + period + '）'
    const percentUsed = total !== null && used !== null
      ? (total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : null)
      : (percentage !== null ? Math.min(100, Math.max(0, percentage)) : null)
    const item = {
      kind, window, name, unit: unitStr,
      total, used, remaining, percentUsed,
      periodEnd: reset !== null ? reset + ' 重置' : null,
      reset,
    }
    if (typ === 'TIME_LIMIT' && total !== null && main === null) main = item
    items.push(item)
  }
  let planTier = typeof data.level === 'string' ? tierFromLevel(data.level) : null
  let planExpire = null
  let productName = null
  if (isObj(subResp) && businessOk(subResp)) {
    const arr = Array.isArray(subResp.data) ? subResp.data : []
    const current = arr.find((s) => isObj(s) && s.status === 'VALID' && (s.inCurrentPeriod !== false)) || arr[0]
    if (isObj(current)) {
      if (typeof current.productName === 'string' && current.productName.trim() !== '') {
        productName = current.productName.trim()
        planTier = tierFromLevel(productName)
      }
      planExpire = extractExpire(current)
    }
  }
  if (main === null) main = items.find((i) => i.total !== null) || null
  const total = main ? main.total : null
  const used = main ? main.used : null
  const remaining = main ? main.remaining : null
  const percentUsed = main ? main.percentUsed : (items.find((i) => i.percentUsed !== null) || { percentUsed: null }).percentUsed
  const slots = planTier !== null || items.length > 0
    ? [{ tier: planTier, name: productName, expire: planExpire, total, used, remaining, percentUsed, items }]
    : []
  return {
    source: 'bigmodel',
    planTier, planExpire, productName,
    total, used, remaining, percentUsed,
    isEmpty: limits.length === 0,
    items,
    slots,
  }
}

/**
 * z.ai billing/balance → 统一结构（Rust normalize_balance 移植）：plans[] 活跃条目
 * 建槽、balances[] 按 plan_id 归槽（散的聚「其他额度」或顶层兜底），逐槽求和补全。
 */
export function normalizeBalance(balanceJson) {
  const balance = unwrapDeep(balanceJson)
  const pool = []
  flattenNumbers(isObj(balance) ? balance : {}, '', pool)
  const mkItem = (it) => {
    const total = toNumber(it.total_units)
    const used = toNumber(it.used_units)
    const remaining = toNumber(it.remaining_units) ?? toNumber(it.available_units)
    const name = ['show_name', 'name', 'entitlement_id', 'plan_id']
      .map((k) => (typeof it[k] === 'string' ? it[k] : '')).find((s) => s !== '') || 'Unknown'
    return {
      name,
      total, used, remaining,
      percentUsed: total !== null && used !== null && total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : null,
      unit: (typeof it.unit_type === 'string' && it.unit_type !== '' ? it.unit_type : typeof it.meter === 'string' ? it.meter : 'quota'),
      periodEnd: expiryField(it.period_end) ?? expiryField(it.expires_at),
    }
  }
  const plans = isObj(balance) && Array.isArray(balance.plans) ? balance.plans : []
  const slots = plans
    .filter((pl) => isObj(pl) && typeof pl.status === 'string' && pl.status.toLowerCase() === 'active')
    .map((pl) => {
      const pid = typeof pl.plan_id === 'string' ? pl.plan_id : ''
      const pname = typeof pl.name === 'string' ? pl.name : null
      const [tier, tierCode] = planTierFromId(pid, pname)
      return {
        pid, tier, tierCode,
        name: pname && pname.trim() !== '' ? pname : pid,
        expire: extractExpire(pl),
        total: null, used: null, remaining: null, percentUsed: null,
        items: [],
      }
    })
  const balances = isObj(balance) && Array.isArray(balance.balances) ? balance.balances : []
  const anyPid = balances.some((item) => isObj(item) && ['plan_id', 'planId', 'entitlement_id'].some((k) => typeof item[k] === 'string' && item[k] !== ''))
  const loose = []
  for (const item of balances) {
    if (!isObj(item)) continue
    const it = mkItem(item)
    const bpid = ['plan_id', 'planId', 'entitlement_id'].map((k) => (typeof item[k] === 'string' ? item[k] : '')).find((s) => s !== '') || ''
    let target = null
    if (bpid !== '') target = slots.find((s) => s.pid === bpid) || null
    else if (slots.length === 1 && !anyPid) target = slots[0]
    if (target !== null) {
      if (target.expire === null) target.expire = extractExpire(item)
      target.items.push(it)
    } else loose.push(it)
  }
  if (slots.length === 0) {
    if (loose.length > 0) {
      const t = extractPlanTier(balance)
      slots.push({ pid: '', tier: t, tierCode: t !== null ? tierCodeFromDisplay(t) : null, name: null, expire: null, total: null, used: null, remaining: null, percentUsed: null, items: loose })
    } else {
      const ptot = sumNumbers(pool, ['total_units']) ?? firstNumber(pool, ['total', 'totalQuota', 'totalCredits', 'quotaTotal', 'amountTotal', 'creditTotal'])
      const pused = sumNumbers(pool, ['used_units']) ?? firstNumber(pool, ['used', 'usedQuota', 'usedCredits', 'quotaUsed', 'amountUsed', 'consumed', 'totalUsed'])
      const prem = sumNumbers(pool, ['remaining_units']) ?? firstNumber(pool, ['remaining', 'remain', 'balance', 'available', 'availableQuota', 'left', 'quotaRemaining'])
      if (ptot !== null || pused !== null || prem !== null) {
        const t = extractPlanTier(balance)
        slots.push({ pid: '', tier: t, tierCode: t !== null ? tierCodeFromDisplay(t) : null, name: null, expire: null, total: ptot, used: pused, remaining: prem, percentUsed: null, items: [] })
      }
    }
  } else if (loose.length > 0) {
    slots.push({ pid: '', tier: null, tierCode: 'other', name: '其他额度', expire: null, total: null, used: null, remaining: null, percentUsed: null, items: loose })
  }
  for (const s of slots) {
    if (s.items.length === 0 && s.total === null) continue
    const sum = (f) => {
      const vals = s.items.map(f).filter((v) => v !== null && v !== undefined)
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null
    }
    s.total = sum((i) => i.total) ?? s.total
    s.used = sum((i) => i.used) ?? s.used
    s.remaining = sum((i) => i.remaining) ?? s.remaining
    if (s.total === null && s.used !== null && s.remaining !== null) s.total = s.used + s.remaining
    if (s.used === null && s.total !== null && s.remaining !== null) s.used = Math.max(0, s.total - s.remaining)
    if (s.remaining === null && s.total !== null && s.used !== null) s.remaining = Math.max(0, s.total - s.used)
    if (s.percentUsed === null && s.total !== null && s.used !== null && s.total > 0) s.percentUsed = Math.min(100, Math.max(0, s.used / s.total * 100))
  }
  let priIdx = 0
  slots.forEach((s, i) => { if (tierRank(s.tierCode) > tierRank(slots[priIdx].tierCode)) priIdx = i })
  const items = slots.flatMap((s) => s.items)
  const activePlans = plans.filter((pl) => isObj(pl) && typeof pl.status === 'string' && pl.status.toLowerCase() === 'active')
  const maxBucketExpire = (() => {
    const nums = balances.map((it) => (isObj(it) && typeof it.expires_at === 'number' ? it.expires_at : 0)).filter((n) => n > 1e9)
    if (nums.length === 0) return null
    const d = new Date(Math.max.apply(null, nums) * 1000)
    return Number.isNaN(d.getTime()) ? null : fmtLocal(d, true)
  })()
  const planExpireChain = (isObj(balance) ? extractExpire(balance) : null)
    ?? (activePlans.length > 0 ? (extractExpire(activePlans[0]) ?? (plans.length > 0 && isObj(plans[0]) ? extractExpire(plans[0]) : null)) : (plans.length > 0 && isObj(plans[0]) ? extractExpire(plans[0]) : null))
    ?? maxBucketExpire
    ?? (items.find((i) => i.periodEnd) || { periodEnd: null }).periodEnd
  if (slots.length === 1 && slots[0].expire === null) slots[0].expire = planExpireChain
  const pri = slots[priIdx] || null
  return {
    source: 'zai-billing',
    planTier: pri ? pri.tier : null,
    planExpire: (pri && pri.expire !== null ? pri.expire : null) ?? planExpireChain,
    productName: pri ? pri.name : null,
    total: pri ? pri.total : null,
    used: pri ? pri.used : null,
    remaining: pri ? pri.remaining : null,
    percentUsed: pri ? pri.percentUsed : null,
    isEmpty: Array.isArray(balance?.balances) ? balance.balances.length === 0 : false,
    items,
    slots: slots.map((s) => ({ tier: s.tier, name: s.name, expire: s.expire, total: s.total, used: s.used, remaining: s.remaining, percentUsed: s.percentUsed, items: s.items })),
  }
}

/** 从 balance 数据推断套餐档位（quota.rs extract_plan_tier 移植）。 */
export function extractPlanTier(currentData) {
  const cur = unwrapDeep(currentData)
  const plans = isObj(cur) && Array.isArray(cur.plans) ? cur.plans : null
  if (plans === null) return null
  const active = plans.filter((p) => isObj(p) && String(p.status || '').toLowerCase() === 'active')
  if (active.length === 0) return null
  const matches = (kws) => active.some((p) => {
    const id = String(p.plan_id || '').toLowerCase()
    const name = String(p.name || '').toLowerCase()
    return kws.some((k) => id.includes(k) || name.includes(k))
  })
  if (matches(['max'])) return 'Max'
  if (matches(['pro'])) return 'Pro'
  if (matches(['lite'])) return 'Lite'
  if (matches(['start-plan', 'start plan', 'start'])) return 'Start Plan'
  return null
}

// =====================================================================
// 活动领取（claim.rs 移植）
// =====================================================================

const fmtUnits = (n) => {
  const trim = (x) => {
    const r = Math.round(x * 10) / 10
    return Number.isInteger(r) ? String(r) : r.toFixed(1)
  }
  if (n >= 1e8) return trim(n / 1e8) + '亿'
  if (n >= 1e4) return trim(n / 1e4) + '万'
  return String(Math.round(n))
}

const PERIOD_CN = { daily: '每日', weekly: '每周', monthly: '每月' }

/** preview plans[] → 领取卡片结构（entitlements 只认 model_usage+token 且有 show_name 的）。 */
export function parseClaimPlans(json) {
  const plans = isObj(json) && isObj(json.data) && Array.isArray(json.data.plans) ? json.data.plans : []
  const out = []
  for (const p of plans) {
    if (!isObj(p)) continue
    const planId = (typeof p.plan_id === 'string' ? p.plan_id : typeof p.planId === 'string' ? p.planId : '').trim()
    if (planId === '') continue
    const ents = Array.isArray(p.entitlements) ? p.entitlements : []
    const grants = ents
      .filter((e) => isObj(e)
        && (e.meter === 'model_usage')
        && (e.unit_type === 'token' || e.unitType === 'token')
        && ((typeof e.show_name === 'string' && e.show_name.trim() !== '') || (typeof e.showName === 'string' && e.showName.trim() !== '')))
      .map((e) => {
        const name = (e.show_name || e.showName || '').trim()
        const units = toNumber(e.grant_units ?? e.grantUnits) ?? 0
        const period = typeof e.period === 'string' ? e.period : 'one_time'
        return name + ' · ' + fmtUnits(units) + ' Token（' + (PERIOD_CN[period] || '一次性') + '）'
      })
    out.push({
      planId,
      name: (typeof p.name === 'string' ? p.name : '').trim(),
      description: (typeof p.description === 'string' ? p.description : '').trim(),
      priority: typeof p.priority === 'number' ? p.priority : 0,
      grants,
    })
  }
  out.sort((a, b) => b.priority - a.priority || (a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0))
  return out
}

/** 领取/预览业务错误文案（claim.rs failure_message 移植）。 */
export function claimFailureMessage(code, body) {
  const serverMsg = isObj(body)
    ? (['msg', 'message'].map((k) => (typeof body[k] === 'string' ? body[k] : '')).find((s) => s !== '') || '')
    : ''
  const BASE = {
    1001: '套餐不存在',
    1002: '活动已结束或套餐暂不可领取',
    1003: '该套餐已经领取过',
    1004: '不符合领取条件',
    1005: '今日领取名额已用完',
    3001: '领取参数错误，请刷新后重试',
    3007: '验证码校验失败，请重试',
    401: '请先登录后再领取',
  }
  const base = BASE[code] || '领取失败'
  return serverMsg !== '' ? base + '（' + serverMsg + '）' : base
}

/** 领取失败载荷（claim.rs claim_error / failure_payload 移植）。next_at 只认 1005。 */
export function claimErrorPayload(code, body) {
  const nextAt = code === 1005 && isObj(body)
    ? (() => {
      const v = body?.data?.plan?.ends_at
      return typeof v === 'number' ? v * 1000 : null
    })()
    : null
  return { code, message: claimFailureMessage(code, body), nextAt }
}

/** 验证码配置（claim.rs fetch_captcha_config 解析部分）。不可用返回 null。 */
export function parseCaptchaConfig(json) {
  if (!isObj(json) || json.code !== 0) return null
  const c = json?.data?.configs?.captcha
  if (!isObj(c)) return null
  return {
    enabled: c.enabled === true,
    region: typeof c.region === 'string' ? c.region : '',
    prefix: typeof c.prefix === 'string' ? c.prefix : '',
    sceneId: typeof c.sceneId === 'string' ? c.sceneId : '',
  }
}
