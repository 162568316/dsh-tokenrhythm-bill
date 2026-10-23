/**
 * 账号池 / 会话槽 / 密码掩码的共用口径（纯函数，零依赖）。
 *
 * 为什么要单列一层：阶跃、清枢智汇、OpenCSG 三家各有一套「账号池 + 按账号分槽的长会话 +
 * 密码掩码」，形状完全一样，差别只有**字段名**（username / identifier）、**长度上限**
 * （用户名 64、邮箱手机号 96）和**会话条目的字段白名单**。以前是三份 60 行的复制品，
 * 改一条规矩要改三处——漏一处就是「A 家能串号、B 家不能」这种只有出事才知道的差异。
 *
 * 这里只放**与平台无关的骨架**：怎么去重、怎么限长、怎么按账号池过滤、怎么截断条目数。
 * 「会话里哪些字段算数、各限多长」是各家自己的知识，留在 index.js 的 entry 回调里。
 */

import { isObj } from './common.js'

/** 池子上限：一家平台最多存 20 条（账号与会话槽同一口径）。 */
const POOL_LIMIT = 20

/**
 * 文本归一：`String()` 强转 + trim。**与 common.js 的 str 不同**——str 只认字符串
 * （协议层字段宁缺毋滥），这里要的是「存档里手写的数字账号也让进」：
 * state 文件是用户可手改的 JSON，`identifier: 13800138000` 写成了数字不该被丢掉。
 */
function text(v) {
  return v === undefined || v === null ? '' : String(v).trim()
}

/** 数字归一（存档字段用）：容忍千分位与空白的写法，解析不出 → null。*/
function looseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v.replace(/[,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * 密码掩码：固定 6 个圆点，**不反映真实长度**（长度也是信息，没必要漏）。
 * 空/非字符串 → ''，前端据此显示「未存密码」而不是一排点。
 * 与密钥同一口径：列表只回掩码，明文按需单取。
 */
export function maskPassword(pw) {
  if (typeof pw !== 'string' || pw === '') return ''
  return '••••••'
}

/**
 * 账号池净化。
 *
 * 规则（三家共用）：账号 3~maxLen 字、密码 1~256 字、同键去重（小写）、≤20 条、
 * `addedAt` 缺省补当前时刻。凭据只落本机 0600 state 文件，绝不下发浏览器。
 *
 * cfg:
 *   - `field`：账号字段名（`username` / `identifier`）
 *   - `maxLen`：账号长度上限（用户名 64、邮箱/手机号 96）
 */
export function sanitizeAccountPool(input, cfg) {
  const o = isObj(cfg) ? cfg : {}
  const field = typeof o.field === 'string' && o.field !== '' ? o.field : 'identifier'
  const minLen = typeof o.minLen === 'number' ? o.minLen : 3
  const maxLen = typeof o.maxLen === 'number' ? o.maxLen : 64
  const passwordMax = typeof o.passwordMax === 'number' ? o.passwordMax : 256
  const toNum = typeof o.num === 'function' ? o.num : looseNum
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    if (!isObj(raw)) continue
    const name = text(raw[field])
    const password = typeof raw.password === 'string' ? raw.password : ''
    if (name.length < minLen || name.length > maxLen || password === '' || password.length > passwordMax) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ [field]: name, password, addedAt: toNum(raw.addedAt) ?? Date.now() })
    if (out.length >= POOL_LIMIT) break
  }
  return out
}

/**
 * 长会话净化：键 = 账号名（小写归一口径，与账号池同一套）。
 *
 * 骨架（三家共用）：
 *   - **只认账号池内存在的账号**：池外条目一律丢弃（防串号，串号是安全事故）
 *   - 键必须是非空字符串，脏键丢弃
 *   - 条目由 `entry(raw)` 逐个白名单化：返回 null 表示这条不要
 *   - 最多 20 条
 *
 * cfg:
 *   - `field`：账号字段名（`username` / `identifier`）
 *   - `entry`：`(raw) => object | null`，各家自己的字段白名单（长度、时间戳、字符集）
 */
export function sanitizeSessionPool(input, accounts, cfg) {
  const o = isObj(cfg) ? cfg : {}
  const field = typeof o.field === 'string' && o.field !== '' ? o.field : 'identifier'
  const entry = typeof o.entry === 'function' ? o.entry : null
  const pool = new Set()
  if (Array.isArray(accounts)) {
    for (const a of accounts) {
      // 池子的键只认字符串账号（与账号池净化后的形态一致），非字符串一律不进池
      if (isObj(a) && typeof a[field] === 'string' && a[field] !== '') pool.add(a[field].toLowerCase())
    }
  }
  if (!isObj(input) || pool.size === 0 || entry === null) return {}
  const out = {}
  for (const [rawKey, raw] of Object.entries(input)) {
    if (!isObj(raw)) continue
    const key = text(rawKey).toLowerCase()
    if (key === '' || !pool.has(key)) continue
    const v = entry(raw)
    if (v === null || v === undefined) continue
    out[key] = v
    if (Object.keys(out).length >= POOL_LIMIT) break
  }
  return out
}

/**
 * 账号池里按名字找人（大小写不敏感、两侧空白容忍）。
 * `requirePassword`：只算「有密码」的账号（自动重登要用密码，半条凭据不算可用）。
 * 命中不到 / 名字为空 / 非数组 → null。
 */
export function findAccount(accounts, field, name, opts) {
  const o = isObj(opts) ? opts : {}
  const requirePassword = o.requirePassword === true
  const want = text(name).toLowerCase()
  if (want === '' || !Array.isArray(accounts)) return null
  for (const a of accounts) {
    if (!isObj(a) || typeof a[field] !== 'string' || a[field].toLowerCase() !== want) continue
    if (requirePassword && !(typeof a.password === 'string' && a.password !== '')) continue
    return a
  }
  return null
}

/**
 * 当前活跃登录凭据（「cookie 即身份」的保守守卫）。
 *
 * `identifier` 省略 → 取 `state.activeAccount` 指向的账号（绝大多数调用点）；
 * 显式传入 → 只在账号池内解析该账号（多账号面板按账号懒查）。
 * 两种情况都要求**密码非空**；未绑定 / 池外 / 名字为空一律 null——
 * 宁可不自动重登，也绝不把 A 账号重登到 B 的会话上。
 */
export function pickBoundAccount(state, identifier, field) {
  if (!isObj(state) || !Array.isArray(state.accounts)) return null
  if (identifier === undefined) {
    const active = text(state.activeAccount).toLowerCase()
    return active === '' ? null : findAccount(state.accounts, field, active, { requirePassword: true })
  }
  if (typeof identifier !== 'string') return null
  const want = text(identifier).toLowerCase()
  return want === '' ? null : findAccount(state.accounts, field, want, { requirePassword: true })
}

/**
 * 账号 + 密码的基本形状校验：合规返回 null，不合规返回**给前端看的整句文案**。
 *
 * 清枢与 OpenCSG 两家的码点完全一致（3~96 / 1~256），此前是两处逐字抄的 if 块；
 * 阶跃那套不同（3~64、字段叫 username），所以别硬并到同一处。
 * 返回文案而不是布尔值：调用点直接 `writeJson(res, { ok: false, error: bad }, 400)`，
 * 免得每个调用点再写一遍同一句话（两边文案不一致时前端就会看到两种说法）。
 */
export const accountCredsError = (identifier, password) =>
  (identifier.length < 3 || identifier.length > 96 || password === '' || password.length > 256)
    ? '账号需 3~96 字符、密码 1~256 字符'
    : null

/**
 * 账号池的「加 / 改」：同键旧行就地更新、新账号追加，整体再过一遍调用方的净化函数。
 *
 * 保留原有的 `addedAt`：改密码不该把「加入时间」冲成今天（面板上那行日期会莫名跳动）。
 * `keyOf` 由调用方给：清枢是小写化（平台侧账号名大小写不敏感），OpenCSG 用 ocSessKey
 * （它还要抹掉邮箱里的 `+tag`，两边键的算法本就不一样）。
 * 返回归一后的键——调用点随后要用它作废旧会话与旧缓存。
 */
export const upsertPoolAccount = (pool, keyOf, identifier, password, sanitize) => {
  const key = keyOf(identifier)
  const prev = pool.accounts.find((a) => keyOf(a.identifier) === key)
  const rest = pool.accounts.filter((a) => keyOf(a.identifier) !== key)
  pool.accounts = sanitize([...rest, { identifier, password, addedAt: prev ? prev.addedAt : Date.now() }])
  return key
}
