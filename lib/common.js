/**
 * 跨平台共用纯函数（零依赖，协议层专用）。
 *
 * 为什么单列一层：step / tierflow / opencsg / zcode 四个平台各自都抄过同一批小工具——
 * 「数字与数字字符串都认」「-1 / 0 是哨兵不是时间」「Node 没有 cookie jar，Set-Cookie 得
 * 自己接住再原样回传」「业务码没映射到就回平台原文」。同一口径抄四份的代价不是多敲几个字，
 * 而是**改一处漏三处**：`-1` 当时间戳渲染成 1970、`Expires=Wed, 21 Oct…` 里那个逗号被当
 * cookie 分隔符，都真发生过。口径统一放这里，各协议层只保留自己的常量与字段名。
 *
 * 本模块**只做纯函数**：不发请求、不读文件、不碰全局状态。
 */

/** 普通对象判定：null 与数组都不算。*/
export function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 数字字段统一：数字与数字字符串都认，非有限数 → null。
 * **缺失与 0 必须分清**（0 是有效金额，不是「没有」）。
 */
export function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 字符串字段统一：非字符串 → ''（不把 undefined 泄进界面，界面只判空串）。*/
export function str(v) {
  return typeof v === 'string' ? v : ''
}

/**
 * 容错取键：按候选键名依次取第一个「能算出有限数」的值（**0 是有效值，照样命中**）。
 * 全都没命中 → null。
 *
 * 为什么需要它：平台改版、或同一字段在不同口的写法不一致时（账单口行里叫 `prompt_token`，
 * 别处可能叫 `input_tokens`），宁可给 null 让界面显示「—」，也不能把没见过的键名猜成 0
 * （0 会被读成「没有消耗」，是把账算少的错）。
 */
export function pickNum(obj, keys) {
  if (!isObj(obj) || !Array.isArray(keys)) return null
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue
    const n = num(obj[k])
    if (n !== null) return n
  }
  return null
}

/**
 * 时间戳归一 → 毫秒。口径容忍三种（Go 后端常见混用）：
 *   - 数字：> 1e12 视为毫秒，否则视为秒；**≤ 0 → null**
 *   - 数字字符串：同上（含前导 `-`，平台拿 `-1` 当哨兵）
 *   - RFC3339/ISO 字符串：Date.parse；解不出 → null
 *
 * 为什么 `-1` 必须判成 null 而不是「1969 年」：平台自己的格式化器就是这个口径
 * （`0 / -1 / falsy → "-"`，「永不过期」也走那条路）。照 -1×1000 算，`end_time = -1`
 * 会被读成「早就过期」，当前套餐直接消失，界面还会显示 1970-01-01。
 */
export function tsToMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    if (!(v > 0)) return null
    return v > 1e12 ? Math.trunc(v) : Math.trunc(v * 1000)
  }
  if (typeof v === 'string') {
    const s = v.trim()
    if (s === '') return null
    if (/^-?\d+$/.test(s)) return tsToMs(Number(s))
    const parsed = Date.parse(s)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * JWT 第二段（payload）解码 → 解析结果；解不出 → null。
 *
 * **不做签名校验**（本层零依赖，只用来读 `uuid` / `current_user` / `exp` 这类非敏感声明，
 * 真正的校验永远在平台侧）。把 base64url 转回 base64 再交给 Buffer：各平台发的都是不带
 * padding 的 base64url，Node 的 'base64' 解码器不吃 `-` `_`，而 'base64url' 老版本 Node 又
 * 未必有——两边都兼容的写法只有替换字符这一种。
 *
 * 返回的是 JSON.parse 的原样结果（各层自己判是不是对象、有没有 exp）。
 */
export function jwtPayload(token) {
  if (typeof token !== 'string' || token === '') return null
  const parts = token.split('.')
  if (parts.length < 2 || parts[1] === '') return null
  try {
    const seg = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(Buffer.from(seg, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Set-Cookie 归一：字符串数组（推荐，`headers.getSetCookie()` 的结果）、单个字符串、
 * 空值都接受。
 *
 * 为什么还要留「拼接串」这条路：`getSetCookie()` 是较新的 undici API，宿主 Node 旧一点
 * 就只剩 `headers.get('set-cookie')`——那是一条用 ", " 拼起来的串。**不能直接按逗号切**：
 * `Expires=Wed, 21 Oct 2026 07:28:00 GMT` 里也有逗号。
 */
export function cookieEntries(raw) {
  if (Array.isArray(raw)) {
    const out = []
    for (const item of raw) if (typeof item === 'string' && item !== '') out.push(item)
    return out
  }
  if (typeof raw !== 'string' || raw === '') return []
  // 只在「逗号 + 可选空白 + cookie 名 + =」处切：日期段逗号后面跟的是数字/星期名，
  // 到第一个 ';' 之前都不会出现 '='，因此不会命中。切出来的段顺手 trim 并丢掉空段——
  // 切点前面那个空格属于分隔符，不该留给下一段；纯空白段根本不是 cookie，留着只会让
  // 调用方多写一次判空（数组那条路径本来就滤掉了空串，两条路径的输出因此完全一致）。
  return raw.split(/,(?=\s*[^;=,\s]+=[^;]*)/).map((s) => s.trim()).filter((s) => s !== '')
}

/**
 * Set-Cookie / name-value 配对表 → 单个 Cookie 请求头值（`a=b; c=d`）。
 *
 * 用途：**Node 的 fetch 没有 cookie jar**，各平台的会话 cookie 全靠我们自己接住再回传。
 * 只取每条的 `name=value` 段，属性（Path/HttpOnly/SameSite/Expires…）全部丢弃——属性不是
 * 浏览器该回传的东西。没有 `=` 的段（畸形串）直接丢。
 *
 * 重名规则由 `opts.prefer` 决定（两家平台的真实行为不同，别统一）：
 *   - `'last'`（默认，浏览器口径 / RFC 6265 §5.3）：后到的覆盖先到的，但**空值不覆盖**非空值
 *     （真值之后再跟一条清理用的 `Max-Age=0`，不至于把刚建立的会话抹掉）；
 *   - `'first'`：同名只留第一次出现的（服务端重复下发时，后一个常是清理用的空值，
 *     覆盖会把有效会话抹掉）。
 *
 * 吃三种形态（caller 从 Set-Cookie / 配对表接出来的东西形态不定）：
 *   - `'name=value; Path=/'` 这样的整条字符串（或它的数组）
 *   - `['name', 'value']` 二元组
 *   - `{ name, value }` 对象
 */
export function cookieHeader(items, opts) {
  const o = isObj(opts) ? opts : {}
  const preferFirst = o.prefer === 'first'
  const list = Array.isArray(items) ? items : (typeof items === 'string' ? cookieEntries(items) : [])
  const picked = new Map()
  for (const item of list) {
    let head = ''
    if (typeof item === 'string') {
      head = item.split(';')[0].trim()
    } else if (Array.isArray(item)) {
      const n = str(item[0]).trim()
      if (n !== '') head = n + '=' + (item[1] === undefined || item[1] === null ? '' : String(item[1]))
    } else if (isObj(item)) {
      const n = str(item.name).trim()
      if (n !== '') head = n + '=' + (item.value === undefined || item.value === null ? '' : String(item.value))
    }
    const eq = head.indexOf('=')
    if (eq <= 0) continue
    const name = head.slice(0, eq).trim()
    if (name === '') continue
    if (preferFirst) {
      if (!picked.has(name)) picked.set(name, head)
      continue
    }
    const empty = head.slice(eq + 1) === ''
    const prev = picked.get(name)
    if (prev !== undefined && prev.empty === false && empty) continue
    picked.set(name, { head, empty })
  }
  // 'first' 直接存串、'last' 存 { head, empty }，收口时统一取 head
  return [...picked.values()].map((v) => (typeof v === 'string' ? v : v.head)).join('; ')
}

/** Set-Cookie 里是否下发了名为 `name` 的 cookie（登录是否真的成功的判据）。*/
export function hasCookie(raw, name) {
  if (typeof name !== 'string' || name === '') return false
  for (const item of cookieEntries(raw)) {
    const head = item.split(';')[0]
    const eq = head.indexOf('=')
    if (eq > 0 && head.slice(0, eq).trim() === name) return true
  }
  return false
}

/**
 * 业务码 → 中文文案的工厂（各平台只给自己的映射表）。
 *
 * 平台自己的 message 是英文的，界面全中文，故映射；**没映射到的一律回平台原文**
 * （宁可露英文也不吞错），两个都没有才回「未知错误」。
 */
export function makeCodeText(texts) {
  const table = isObj(texts) ? texts : {}
  return (code, message) => {
    const c = typeof code === 'string' ? code : ''
    const m = typeof message === 'string' ? message.trim() : ''
    if (Object.prototype.hasOwnProperty.call(table, c)) return table[c] + (m !== '' ? '（' + m + '）' : '')
    if (m !== '' && c !== '') return m + '（' + c + '）'
    if (m !== '') return m
    if (c !== '') return c
    return '未知错误'
  }
}

/**
 * 「确定性登录失败」判定工厂。
 *
 * 确定性失败（凭据不对 / 结构不认识 / 账号被禁 / 授权被拒）**拒收**——不把错密码存进账号池，
 * 否则以后每次都要等它失败一遍，还可能把人家账号锁掉；暂时态失败（网络抖动、平台 5xx、
 * 自家冷却窗口）**先存后补**（凭据大概率没错，只是现在问不到平台）。
 *
 * 各平台的码集不同、理由不同，故只共用判定骨架，码集留在各自的协议层。
 */
export function makeDeterministicFailure(codes) {
  const set = new Set(Array.isArray(codes) ? codes : [])
  return (code) => set.has(typeof code === 'string' ? code : '')
}
