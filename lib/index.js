/**
 * dsh-tokenrhythm-bill host half: a plain Cordis plugin running in the host
 * process. It reads the provider roster from ~/.dsh/settings.yaml
 * (llm-pi-ai.providers, flow and block layouts alike) plus API keys from
 * ~/.dsh/.credentials.yaml / environment variables, then answers the browser
 * half's JSON calls over the webServer:
 *
 *   /manifest   provider roster + session status (masked)
 *   /models     proxied GET {baseURL}/v1/models (60s cache, 1 retry on 5xx gw)
 *   /balance    proxied tokenrhythm usage-summary + me (web session cookie)
 *   /status     proxied status.moonlink.top 90d aggregate (2min cache, stale fallback)
 *   /session    paste/clear the tokenrhythm web cookie (stored host-side only)
 *   /prefs      panel geometry persistence
 *
 * Security boundary: API keys and the session cookie live only in host memory
 * and ~/.dsh/tokenrhythm-bill-state.json (mode 0600); every response to the
 * browser carries masked hints only (e.g. "sk_tr…(49)"), never the secret.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as stepLib from './step.js'
import { fileURLToPath } from 'node:url'
import * as os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PKG_VERSION = (() => {
  try { return String(require('../package.json').version || '') } catch { return '' }
})()

// ---- upstreams ----
// 余额只支持基元律动（其控制台在 tokenrhythm.studio）：网页会话 Cookie 才能查
// 余额（API Key 实测 401），模型清单则各提供商都能用各自 Key 查 /v1/models。
const TOKENRHYTHM_BASE = 'https://tokenrhythm.studio'
const MODELS_TTL_MS = 60 * 1000
const UPSTREAM_TIMEOUT_MS = 15 * 1000
const RETRYABLE_STATUS = new Set([502, 503, 504])

// =====================================================================
// 纯函数（导出供 node:test 单测）：YAML 解析 / 归一化 / 掩码
// =====================================================================

// 去掉 YAML 注释：逐字符扫描，字符串（'…" / "…"）内的 # 不算注释；
// # 只有出现在行首或前一个字符是空白时才开启注释。
export function stripYamlComments(text) {
  const s = String(text)
  let out = ''
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote !== '') {
      out += c
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"') { quote = c; out += c; continue }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      const nl = s.indexOf('\n', i)
      if (nl === -1) break
      i = nl - 1 // keep the newline itself
      continue
    }
    out += c
  }
  return out
}

// 按 sep 切分，但只在深度 0（不在 {} / [] 内、不在字符串内）处切。
function splitTopLevel(s, sep) {
  const parts = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote !== '') {
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"') { quote = c; continue }
    if (c === '{' || c === '[') { depth++; continue }
    if (c === '}' || c === ']') { depth--; continue }
    if (c === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1 }
  }
  parts.push(s.slice(start))
  return parts
}

// 从 from 起找与之配对的右括号，返回 { end, inner }；找不到返回 null。
function matchBracket(text, from, open, close) {
  let depth = 0
  let quote = ''
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (quote !== '') {
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"') { quote = c; continue }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return { end: i, inner: text.slice(from + 1, i) }
    }
  }
  return null
}

function unquote(v) {
  const s = String(v).trim()
  if (s.length >= 2 && ((s[0] === '\'' && s[s.length - 1] === '\'') || (s[0] === '"' && s[s.length - 1] === '"'))) {
    return s.slice(1, -1)
  }
  return s
}

// 解析 flow 标量 / {map} / [array]。只求能用：标量保留字符串（数字由调用方按需转换）。
function parseFlowValue(s) {
  const t = String(s).trim()
  if (t.startsWith('{')) {
    const m = matchBracket(t, 0, '{', '}')
    return m ? parseFlowMap(m.inner) : null
  }
  if (t.startsWith('[')) {
    const m = matchBracket(t, 0, '[', ']')
    return m ? parseFlowArray(m.inner) : null
  }
  return unquote(t)
}

function parseFlowMap(inner) {
  const out = {}
  for (const raw of splitTopLevel(inner, ',')) {
    const entry = raw.trim()
    if (entry === '') continue
    const i = indexOfTopLevelColon(entry)
    if (i === -1) continue
    const key = unquote(entry.slice(0, i))
    if (key === '') continue
    out[key] = parseFlowValue(entry.slice(i + 1))
  }
  return out
}

function parseFlowArray(inner) {
  const out = []
  for (const raw of splitTopLevel(inner, ',')) {
    const t = raw.trim()
    if (t === '') continue
    out.push(parseFlowValue(t))
  }
  return out
}

// 首个深度 0 的 `: `（key 后必须紧跟值，兼容 "key:" 换行写法——此时返回首个冒号）。
function indexOfTopLevelColon(s) {
  let depth = 0
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote !== '') {
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"') { quote = c; continue }
    if (c === '{' || c === '[') { depth++; continue }
    if (c === '}' || c === ']') { depth--; continue }
    if (c === ':' && depth === 0) {
      const next = s[i + 1]
      if (next === undefined || next === ' ' || next === '\t' || next === '\n') return i
    }
  }
  return -1
}

// 把多行文本折成 [{indent, text}]（已去注释、去空行）。tab 按 2 空格折算防呆。
function toLines(text) {
  const lines = []
  for (const raw of String(text).split(/\r?\n/)) {
    const expanded = raw.replace(/\t/g, '  ')
    const t = expanded.trim()
    if (t === '') continue
    lines.push({ indent: expanded.length - expanded.trimStart().length, text: t })
  }
  return lines
}

// block 布局解析：从 lines[i]（缩进 indent 的映射）开始解析嵌套 map / list。
// 返回 { value, next }；next 为该块之后的第一行下标。
function parseBlockMap(lines, i, indent) {
  const out = {}
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.indent < indent) break
    if (ln.indent > indent) { i++; continue } // 容忍意外深缩进：跳过
    const ci = indexOfTopLevelColon(ln.text)
    if (ci === -1) { i++; continue }
    const key = unquote(ln.text.slice(0, ci))
    const rest = ln.text.slice(ci + 1).trim()
    i++
    if (rest === '') {
      // 嵌套块：map 或 list，由下一行是否以 "- " 开头决定。
      if (i < lines.length && lines[i].indent > indent && /^-(\s|$)/.test(lines[i].text)) {
        const lst = parseBlockList(lines, i, lines[i].indent)
        out[key] = lst.value
        i = lst.next
      } else if (i < lines.length && lines[i].indent > indent) {
        const sub = parseBlockMap(lines, i, lines[i].indent)
        out[key] = sub.value
        i = sub.next
      } else {
        out[key] = null
      }
    } else {
      out[key] = parseFlowValue(rest)
    }
  }
  return { value: out, next: i }
}

function parseBlockList(lines, i, indent) {
  const out = []
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.indent !== indent || !/^-(\s|$)/.test(ln.text)) {
      if (ln.indent < indent || (ln.indent === indent && !/^-(\s|$)/.test(ln.text))) break
      i++
      continue
    }
    let item = ln.text.replace(/^-\s*/, '')
    i++
    if (item === '') {
      // "- " 后换行的块项（"- id: x" 不属于这种）。
      if (i < lines.length && lines[i].indent > indent) {
        const sub = parseBlockMap(lines, i, lines[i].indent)
        out.push(sub.value)
        i = sub.next
      } else {
        out.push(null)
      }
    } else if (item.startsWith('{') || item.startsWith('[')) {
      out.push(parseFlowValue(item))
    } else {
      // "- id: x" 形式：首键在 item 里，后续键在更深缩进的行里。
      const ci = indexOfTopLevelColon(item)
      if (ci >= 0 && i < lines.length && lines[i].indent > ln.indent) {
        const firstKey = unquote(item.slice(0, ci))
        const sub = parseBlockMap(lines, i, lines[i].indent)
        out.push({ [firstKey]: parseFlowValue(item.slice(ci + 1)), ...sub.value })
        i = sub.next
      } else if (ci >= 0) {
        const firstKey = unquote(item.slice(0, ci))
        out.push({ [firstKey]: parseFlowValue(item.slice(ci + 1)) })
      } else {
        out.push(parseFlowValue(item))
      }
    }
  }
  return { value: out, next: i }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const asStr = (v) => (v === undefined || v === null ? '' : String(v)).trim()

function normalizeProviderEntry(id, entry) {
  if (!isObj(entry)) return null
  const modelsRaw = entry.models
  const models = (Array.isArray(modelsRaw) ? modelsRaw : [])
    .map((m) => isObj(m)
      ? { id: asStr(m.id || m.name), name: asStr(m.name || m.id), contextWindow: toNum(m.contextWindow ?? m.context_window) }
      : null)
    .filter((m) => m !== null && m.id !== '')
  const baseURL = asStr(entry.baseURL || entry.base_url)
  return {
    id: asStr(id),
    displayName: asStr(entry.displayName || entry.display_name) || asStr(id),
    apiKeyEnv: asStr(entry.apiKeyEnv || entry.api_key_env),
    baseURL,
    models,
    balanceCapable: /tokenrhythm/i.test(baseURL),
  }
}

/**
 * 解析 settings.yaml 的 llm-pi-ai.providers 段。同时支持 flow（带大括号，本机实际
 * 布局）与 block（缩进式）两种写法；models 支持 { id, name, contextWindow } flow 项
 * 与 `- id:` block 项。解析失败/缺段返回空数组，绝不抛错（面板按「无提供商」展示）。
 * 返回 [{id, displayName, apiKeyEnv, baseURL, models, balanceCapable}]。
 */
export function parseSettingsProviders(text) {
  const clean = stripYamlComments(String(text == null ? '' : text).replace(/\t/g, '  '))
  const lines = toLines(clean)
  // 每个保留行在 clean 里的起始偏移（flow 提取需要精确到字符；与 lines 下标对齐）。
  const offsets = []
  {
    let offset = 0
    for (const raw of clean.split('\n')) {
      if (raw.trim() !== '') offsets.push(offset)
      offset += raw.length + 1
    }
  }
  // 找 providers: 键（任意缩进——真实文件在 llm-pi-ai: 之下）。
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^providers\s*:/.test(lines[i].text)) { idx = i; break }
  }
  if (idx === -1) return []
  const rest = lines[idx].text.replace(/^providers\s*:/, '').trim()

  // 判别 flow / block：`providers:` 之后（同行或下一保留行）第一个非空白字符
  // 是 `{` → 外层 flow map；否则按 block 缩进布局解析。
  let valueAt = -1
  if (rest !== '') {
    if (rest.startsWith('{')) valueAt = offsets[idx] + clean.slice(offsets[idx]).indexOf(rest)
  } else if (idx + 1 < lines.length) {
    const start = offsets[idx + 1]
    const tail = clean.slice(start)
    valueAt = start + (tail.length - tail.trimStart().length)
  }
  if (valueAt !== -1 && clean[valueAt] === '{') {
    const m = matchBracket(clean, valueAt, '{', '}')
    if (m === null) return []
    const map = parseFlowMap(m.inner)
    const out = []
    for (const key of Object.keys(map)) {
      const p = normalizeProviderEntry(key, map[key])
      if (p !== null) out.push(p)
    }
    return out
  }

  // block 布局：providers: 换行 + 更深缩进。
  if (idx + 1 < lines.length && lines[idx + 1].indent > lines[idx].indent) {
    const sub = parseBlockMap(lines, idx + 1, lines[idx + 1].indent)
    const out = []
    for (const key of Object.keys(sub.value)) {
      const p = normalizeProviderEntry(key, sub.value[key])
      if (p !== null) out.push(p)
    }
    return out
  }
  return []
}

/**
 * 从 .credentials.yaml 文本里取 envName 对应的键值。行级正则优先（兼容 refs:
 * 嵌套与旧平铺两种布局），再退化为全文内的键值搜索（单行 flow 布局）。
 * 匹配不到返回 null；绝不抛错。
 */
export function extractCredentialFromText(envName, text) {
  const name = String(envName || '').trim()
  if (name === '' || text == null) return null
  const clean = stripYamlComments(String(text))
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '')
    if (/^\s*#/.test(line)) continue
    const m = new RegExp('^\\s*-?\\s*' + esc + '\\s*:\\s*(.*?)\\s*$').exec(line)
    if (m !== null) {
      const v = unquote(m[1].replace(/,\s*$/, ''))
      if (v !== '') return v
    }
  }
  const flow = new RegExp('[,{\\s]' + esc + '\\s*:\\s*([^\\s,}\\]]+)')
  const fm = flow.exec(clean)
  if (fm !== null) {
    const v = unquote(fm[1])
    if (v !== '') return v
  }
  return null
}

const toNum = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const toBool = (v) => {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return true
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no' || s === '') return false
  return null
}
// 依次尝试候选键，返回第一个可用的数值/布尔。
function pickNum(obj, keys) {
  for (const k of keys) { const n = toNum(obj[k]); if (n !== null) return n }
  return null
}
function pickBool(obj, keys) {
  for (const k of keys) { const b = toBool(obj[k]); if (b !== null) return b }
  return null
}

/**
 * 归一化 /v1/models 返回：容忍 {data:[…]} 信封或裸数组；字段名多候选兼容，
 * 数值解析失败记 null 不抛错。字段见实施文档 §5.1 Model。
 */
export function normalizeModels(json) {
  const list = Array.isArray(json)
    ? json
    : (isObj(json) && Array.isArray(json.data) ? json.data : [])
  const out = []
  for (const raw of list) {
    if (!isObj(raw)) continue
    const id = asStr(raw.id || raw.model || raw.name)
    if (id === '') continue
    const rc = isObj(raw.responses_capabilities) ? raw.responses_capabilities : {}
    const inPrice = pickNum(raw, ['input_price_per_million', 'inputPricePerMillion', 'input_price', 'prompt_price_per_million'])
    const outPrice = pickNum(raw, ['output_price_per_million', 'outputPricePerMillion', 'output_price', 'completion_price_per_million'])
    const cachePrice = pickNum(raw, ['cache_price_per_million', 'cachePricePerMillion', 'cache_read_price_per_million', 'cached_input_price_per_million', 'cache_read_input_price_per_million'])
    const effIn = pickNum(raw, ['effective_input_price_per_million', 'effectiveInputPricePerMillion', 'effective_input_price', 'discount_input_price_per_million'])
    const effOut = pickNum(raw, ['effective_output_price_per_million', 'effectiveOutputPricePerMillion', 'effective_output_price', 'discount_output_price_per_million'])
    const effCache = pickNum(raw, ['effective_cache_price_per_million', 'effectiveCachePricePerMillion', 'effective_cache_read_price_per_million', 'effective_cache_price', 'discount_cache_read_price_per_million'])
    const responses = (() => {
      const direct = toBool(raw.supports_responses)
      if (direct !== null) return direct
      return Object.keys(rc).length > 0
    })()
    out.push({
      id,
      contextLength: pickNum(raw, ['context_length', 'contextLength', 'context_window', 'max_context_tokens']),
      maxOutput: pickNum(raw, ['max_output_tokens', 'maxOutput', 'max_completion_tokens', 'max_tokens', 'output_token_limit']),
      currency: asStr(raw.currency) || 'CNY',
      inPrice,
      outPrice,
      cachePrice,
      effInPrice: effIn,
      effOutPrice: effOut,
      effCachePrice: effCache,
      hasDiscount: toBool(raw.has_discount) ?? (() => {
        const pairs = [[effIn, inPrice], [effOut, outPrice], [effCache, cachePrice]]
        let any = false
        for (const [eff, base] of pairs) {
          if (eff !== null && base !== null && eff < base) any = true
        }
        return any
      })(),
      tools: pickBool(raw, ['supports_tools', 'tool_call', 'function_calling']) ?? toBool(raw.tools) ?? false,
      reasoning: pickBool(raw, ['supports_reasoning', 'reasoning', 'thinking']) ?? false,
      vision: pickBool(raw, ['supports_vision', 'vision', 'multimodal']) ?? false,
      responses,
      webSearch: toBool(rc.webSearch) ?? toBool(rc.web_search) ?? false,
    })
  }
  return out
}

// 解 {data:{…}} 信封；非对象原样返回。
function unwrapEnvelope(json) {
  return isObj(json) && isObj(json.data) ? json.data : json
}

/**
 * 归一化平台「模型列表」页接口（/api/models，会话 Cookie）：比 /v1/models 多出
 * 显示名 / 类型（chat|image）/ 模态 / 图片单价。分类口径与平台一致：
 *   文本 = type chat、图像 = type image、视频/音频/向量 = capabilities 对应位。
 * 返回与 normalizeModels 同构的 Model（多 name / perImagePrice / categories）。
 */
export function normalizePlatformModels(json) {
  // 信封形态：[数组] / {data:[数组]} / {data:{list:[数组]}}。
  let list = []
  if (Array.isArray(json)) list = json
  else if (isObj(json) && Array.isArray(json.data)) list = json.data
  else if (isObj(json) && isObj(json.data) && Array.isArray(json.data.list)) list = json.data.list
  const out = []
  for (const raw of list) {
    if (!isObj(raw)) continue
    const id = asStr(raw.id)
    if (id === '') continue
    const caps = isObj(raw.capabilities) ? raw.capabilities : {}
    const modalities = Array.isArray(raw.modalities) ? raw.modalities.map(asStr) : []
    const kind = asStr(raw.type) || 'chat'
    const categories = []
    if (kind === 'chat') categories.push('text')
    if (kind === 'image') categories.push('image')
    if (modalities.includes('video') || toBool(caps.video) === true) categories.push('video')
    if (toBool(caps.audio) === true) categories.push('audio')
    if (toBool(caps.embeddings) === true) categories.push('vector')
    const inPrice = toNum(raw.inputPrice)
    const outPrice = toNum(raw.outputPrice)
    const cachePrice = toNum(raw.cacheReadPrice)
    const effIn = toNum(raw.effectiveInputPrice)
    const effOut = toNum(raw.effectiveOutputPrice)
    const effCache = toNum(raw.effectiveCacheReadPrice)
    out.push({
      id,
      name: asStr(raw.name) || id,
      // 来源（无问 / DeepSeek / 阿里云…）：取平台 providerBrands 品牌名列表——
      // 同一模型可能经多个上游提供（如 deepseek 同时标 DeepSeek/阿里云/无问），
      // 缺失时回退 providerDisplayName → provider 键。
      provider: (Array.isArray(raw.providerBrands) && raw.providerBrands.length > 0
        ? [...new Set(raw.providerBrands
            .map((b) => (isObj(b) ? asStr(b.providerBrandName) : ''))
            .filter((s) => s !== ''))].join(' / ')
        : '') || asStr(raw.providerDisplayName) || asStr(raw.provider),
      platformStatus: asStr(raw.status) || null,
      kind,
      categories,
      contextLength: toNum(raw.contextWindow),
      maxOutput: toNum(raw.maxOutputTokens),
      currency: asStr(raw.currency) || 'CNY',
      inPrice,
      outPrice,
      cachePrice,
      effInPrice: effIn,
      effOutPrice: effOut,
      effCachePrice: effCache,
      hasDiscount: toBool(raw.hasDiscount) ?? ([effIn, effOut, effCache].some((eff, i) => {
        const base = [inPrice, outPrice, cachePrice][i]
        return eff !== null && base !== null && eff < base
      })),
      tools: toBool(caps.tools) ?? false,
      reasoning: toBool(caps.reasoning) ?? false,
      vision: toBool(caps.vision) ?? false,
      responses: toBool(caps.responses) ?? false,
      webSearch: false,
      perImagePrice: toNum(raw.pricePerImage),
    })
  }
  return out
}

/** 分类计数（全部/文本/图像/音频/视频/向量），与平台「模型列表」页口径一致。 */
export function categoryCounts(models) {
  const counts = { all: 0, text: 0, image: 0, audio: 0, video: 0, vector: 0 }
  for (const m of models) {
    counts.all++
    for (const c of m.categories || []) {
      if (counts[c] !== undefined) counts[c]++
    }
  }
  return counts
}

/**
 * 归一化余额：/api/usage-summary + /api/me。容忍 {data:{…}} 信封与 snake_case
 * 变体；字段缺失记 null。字段含义（平台实测）：
 *   balanceCny 账户余额 / availableBalanceCny 可用 / frozenBalanceCny 冻结 /
 *   expiringBalanceCny 限时额度（到期失效部分）/ nextExpiryAt 最近到期时间
 */
/**
 * 从 /api/me 响应提取账户名（name > nickname > username > email > id）。
 * 容忍 {data:{…}} 信封与脏数据；全部缺失返回空串。Cookie 模式下
 * manifest / session 路由用它标注「数据账号」。
 */
export function accountNameFromMe(meJson) {
  const me = isObj(meJson) ? unwrapEnvelope(meJson) : {}
  return [me.name, me.nickname, me.username, me.email, me.id]
    .map(asStr).find((v) => v !== '') || ''
}

export function normalizeBalance(summaryJson, meJson, expiringJson) {
  const s = unwrapEnvelope(summaryJson) || {}
  const account = accountNameFromMe(meJson)
  return {
    balanceCny: pickNum(s, ['balanceCny', 'balance', 'availableBalanceCny', 'available_balance_cny']),
    availableBalanceCny: pickNum(s, ['availableBalanceCny', 'available_balance_cny']),
    frozenBalanceCny: pickNum(s, ['frozenBalanceCny', 'frozen_balance_cny']),
    expiringBalanceCny: pickNum(s, ['expiringBalanceCny', 'expiring_balance_cny']),
    nextExpiryAt: asStr(s.nextExpiryAt || s.next_expiry_at) || null,
    // 逐笔限时额度以 /api/wallet/expiring-credits 为权威（expiringJson），
    // 该接口请求失败（null/undefined）时回退 usage-summary 深扫兜底。
    expiringItems: normalizeExpiringCredits(expiringJson) ?? extractExpiringItems(summaryJson),
    inputTokens: pickNum(s, ['inputTokens', 'input_tokens']),
    outputTokens: pickNum(s, ['outputTokens', 'output_tokens']),
    costCny: pickNum(s, ['totalCostCny', 'total_cost_cny', 'costCny', 'cost_cny', 'cost']),
    calls: pickNum(s, ['calls']),
    successCalls: pickNum(s, ['successCalls', 'success_calls']),
    currency: asStr(s.currency) || 'CNY',
    account,
    fetchedAt: Date.now(),
  }
}

// ---- 逐笔限时额度提取 ----
// 平台字段名未长期稳定：先试已知候选键，再深度扫描兜底——数组中每项同时含
// 「金额字段」与「到期时间字段」即认。按到期时间升序；缺失/为空返回 []。
const EXPIRING_LIST_KEYS = [
  'expiringItems', 'expiring_items', 'expiringList', 'expiring_list',
  'gifts', 'giftList', 'gift_list', 'grants', 'promotions', 'promotionList',
  'quotaList', 'quota_list', 'quotas', 'presentList', 'present_list', 'rewards',
]
const MONEY_KEY_RE = /(amount|balance|quota|money|cny|price|value)/i
const TIME_KEY_RE = /(expire|expiry|expir|deadline|end.?time|end.?at|valid|due|until)/i
const NAME_KEY_RE = /(name|title|label|remark|desc|source|note)/i

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v)
// 金额容错直接复用上方 toNum（数字 / 带千分位的数字串都认）
// 时间形态：ISO/日期串、秒或毫秒时间戳
const isTimeLike = (v) => (typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v))
  || (isFiniteNum(v) && v > 1e9)

function toExpireAtMs(v) {
  if (isFiniteNum(v)) return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** 从单个明细对象里抠出 { name?, amountCny, expireAt(ISO) }；缺金额或时间则丢弃。 */
function parseExpiringItem(item) {
  if (!isObj(item)) return null
  let amountCny = null
  let expireMs = null
  let name = ''
  for (const [key, value] of Object.entries(item)) {
    if (amountCny === null && !TIME_KEY_RE.test(key) && MONEY_KEY_RE.test(key)) {
      const n = toNum(value)
      if (n !== null) amountCny = n
    }
    if (expireMs === null && isTimeLike(value) && TIME_KEY_RE.test(key)) expireMs = toExpireAtMs(value)
    if (name === '' && typeof value === 'string' && NAME_KEY_RE.test(key) && !TIME_KEY_RE.test(value)) name = value
  }
  if (amountCny === null || expireMs === null || !Number.isFinite(expireMs)) return null
  const out = { amountCny, expireAt: new Date(expireMs).toISOString() }
  if (name !== '') out.name = name
  return out
}

const sortByExpire = (items) => items.slice().sort((a, b) => Date.parse(a.expireAt) - Date.parse(b.expireAt))

/** 深度扫描（≤4 层）：找到第一个「每项都能抠出金额+时间」的数组即收工。 */
function deepScanExpiring(node, depth) {
  if (depth > 4 || !isObj(node) && !Array.isArray(node)) return []
  if (Array.isArray(node)) {
    const items = node.map(parseExpiringItem).filter(Boolean)
    if (items.length > 0 && items.length >= Math.ceil(node.length / 2)) return sortByExpire(items)
    return []
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value) || isObj(value)) {
      const hit = deepScanExpiring(value, depth + 1)
      if (hit.length > 0) return hit
    }
  }
  return []
}

/**
 * 从 /api/usage-summary 提取逐笔限时额度 [{name?, amountCny, expireAt(ISO)}]。
 * 候选键直取 → 深度扫描兜底；任何形态都取不到时返回 []（UI 侧据此不渲染悬浮卡）。
 */
export function extractExpiringItems(summaryJson) {
  const s = summaryJson && isObj(summaryJson) ? unwrapEnvelope(summaryJson) : null
  if (!s) return []
  for (const key of EXPIRING_LIST_KEYS) {
    const arr = s[key]
    if (!Array.isArray(arr) || arr.length === 0) continue
    const items = arr.map(parseExpiringItem).filter(Boolean)
    if (items.length > 0) return sortByExpire(items)
  }
  return deepScanExpiring(s, 0)
}

/**
 * 归一化 /api/wallet/expiring-credits 响应（逐笔限时额度的权威来源，平台实测形态：
 * data.list[] = {id, source, sourceLabel, grantedCny, remainingCny, grantedAt, expiresAt}，
 * data.summary = {expiringBalanceCny, nextExpiryAt}）。
 * 映射为 [{name?, amountCny(剩余), expireAt}] 按到期升序；响应不可用（非对象信封 /
 * 无 list 数组）返回 null，调用方回退 usage-summary 深扫；剩余 ≤0 的条目丢弃。
 */
export function normalizeExpiringCredits(expiringJson) {
  const d = expiringJson && isObj(expiringJson) ? unwrapEnvelope(expiringJson) : null
  if (!d || !Array.isArray(d.list)) return null
  const items = []
  for (const raw of d.list) {
    if (!isObj(raw)) continue
    const amountCny = toNum(raw.remainingCny ?? raw.remaining_cny)
    const expireMs = Date.parse(asStr(raw.expiresAt || raw.expires_at))
    if (amountCny === null || amountCny <= 0 || !Number.isFinite(expireMs)) continue
    const name = asStr(raw.sourceLabel || raw.source_label || raw.source)
    const item = { amountCny, expireAt: new Date(expireMs).toISOString() }
    if (name !== '') item.name = name
    items.push(item)
  }
  return sortByExpire(items)
}

// ---- 更新检测（npm dist-tags 比对）----

/** 解析 v?x.y.z[-prerelease] 的数字三元组；不可解析返回 null。 */
const parseVersionTriple = (value) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || '').trim())
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** remote 是否比 local 新（仅比较三元组，忽略 prerelease 后缀）；任一不可解析返回 false。 */
export function isNewerVersion(local, remote) {
  const a = parseVersionTriple(local)
  const b = parseVersionTriple(remote)
  if (a === null || b === null) return false
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i]
  }
  return false
}

/** 从 registry dist-tags 响应提取 latest 版本串；兼容 {latest} 与 {dist-tags:{latest}} 两形态，无合法版本返回 null。 */
export function normalizeDistTags(json) {
  const d = isObj(json) ? json : {}
  const tags = isObj(d['dist-tags']) ? d['dist-tags'] : d
  const latest = asStr(tags.latest)
  return parseVersionTriple(latest) !== null ? latest : null
}

/** 更新状态持久化字段清洗：只留合法键（版本串必须可解析，时间必须为正数）。 */
export function sanitizeUpdate(raw) {
  if (!isObj(raw)) return {}
  const out = {}
  const latest = asStr(raw.latestVersion)
  if (parseVersionTriple(latest) !== null) out.latestVersion = latest
  const checkedAt = toNum(raw.checkedAt)
  if (checkedAt !== null && checkedAt > 0) out.checkedAt = checkedAt
  const current = asStr(raw.currentAtCheck)
  if (parseVersionTriple(current) !== null) out.currentAtCheck = current
  const ignored = asStr(raw.ignoredVersion)
  if (parseVersionTriple(ignored) !== null) out.ignoredVersion = ignored
  return out
}

/** 入口胶囊余额模式清洗：只认 total（总余额）/ expiring（限时总余额），其余返回 null。 */
export function sanitizeEntryBalance(v) {
  return v === 'total' || v === 'expiring' ? v : null
}

/** 安装模式：检查各 profile 的 node_modules 安装项——是符号链接（junction）且指向本包 → 'local'，
 * 否则 npm 副本。不能用 import.meta.url 的 realpath 比较：Node 解析默认 realpath，
 * 经 junction 加载时模块路径已是真实路径，跟谁比都相等。 */
export function detectInstallMode(home = (process.env.DSH_HOME && String(process.env.DSH_HOME)) || join(os.homedir(), '.dsh')) {
  try {
    const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
    const profiles = join(home, 'profiles')
    for (const name of existsSync(profiles) ? readdirSync(profiles) : []) {
      const entry = join(profiles, name, 'node_modules', 'dsh-tokenrhythm-bill')
      try {
        if (!lstatSync(entry).isSymbolicLink()) continue
        if (realpathSync(entry) === root) return 'local'
      } catch { /* 跳过坏条目 */ }
    }
  } catch { return 'npm' }
  return 'npm'
}

/**
 * 聚合当日调用日志（/api/call-logs/page 的响应）：求和 inputTokens /
 * outputTokens / costCny 并统计调用次数。容忍 {data:{list:[…]}} 信封或裸数组；
 * 返回 {inputTokens, outputTokens, costCny, calls, successCalls, fetched}，
 * fetched 为实际参与聚合的条数（调用方据此判断是否还有下一页）。
 */
export function summarizeDailyLogs(json) {
  const data = isObj(json) && isObj(json.data) ? json.data : (isObj(json) ? json : {})
  const list = Array.isArray(data.list) ? data.list : (Array.isArray(json) ? json : [])
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let costCny = 0
  let calls = 0
  let successCalls = 0
  for (const item of list) {
    if (!isObj(item)) continue
    calls++
    inputTokens += toNum(item.inputTokens ?? item.input_tokens) ?? 0
    outputTokens += toNum(item.outputTokens ?? item.output_tokens) ?? 0
    cacheReadTokens += toNum(item.cacheReadTokens ?? item.cache_read_tokens) ?? 0
    costCny += toNum(item.costCny ?? item.cost_cny) ?? 0
    if (toNum(item.status) === 200) successCalls++
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    costCny: Math.round(costCny * 1e6) / 1e6,
    calls,
    successCalls,
    fetched: list.length,
  }
}

/** 掩码：前 5 位…(长度)，如 "sk_tr…(49)"；空值返回空串。 */
export function maskSecret(value) {
  const s = String(value || '')
  if (s === '') return ''
  return s.slice(0, 5) + '…(' + s.length + ')'
}

// 从粘贴内容里提取 tr_session 的值：兼容整段 Cookie / "tr_session=sess_x" / 裸 sess_x。
export function extractSessionCookie(input) {
  const s = String(input || '').trim()
  if (s === '') return ''
  const m = /tr_session\s*=\s*([A-Za-z0-9._-]+)/.exec(s)
  if (m !== null) return m[1]
  if (/^[A-Za-z0-9._-]+$/.test(s)) return s
  return ''
}

// 从粘贴内容里提取 tr_csrf 的值（CSRF 双提交令牌，与 tr_session 同源下发）；
// 仅当用户粘贴整段 Cookie 时可能带上，裸 session 粘贴则没有（走自愈补取）。
export function extractCsrfCookie(input) {
  const s = String(input || '').trim()
  if (s === '') return ''
  const m = /tr_csrf\s*=\s*([A-Za-z0-9._-]+)/.exec(s)
  return m !== null ? m[1] : ''
}

/**
 * 归一化平台「我的 API Key」列表（/api/api-keys）：容忍信封与字段变体。
 * 平台列表只给掩码（maskedKey + keyPrefix），完整 Key 仅创建响应返回一次。
 * 返回 [{id, name, masked, status, lastUsedAt, createdAt}]。
 */
export function normalizePlatformKeys(json) {
  let list = []
  if (Array.isArray(json)) list = json
  else if (isObj(json) && Array.isArray(json.data)) list = json.data
  else if (isObj(json) && isObj(json.data)) {
    if (Array.isArray(json.data.list)) list = json.data.list
    else if (Array.isArray(json.data.keys)) list = json.data.keys
  }
  const out = []
  for (const raw of list) {
    if (!isObj(raw)) continue
    const masked = asStr(raw.maskedKey || raw.masked_key || raw.key || raw.masked)
    const prefix = asStr(raw.keyPrefix || raw.key_prefix)
    const id = asStr(raw.id)
    if (id === '' && masked === '' && prefix === '') continue
    out.push({
      id,
      name: asStr(raw.name) || '未命名密钥',
      masked: masked !== '' ? masked : prefix + '****',
      prefix,
      status: asStr(raw.status) || 'enabled',
      lastUsedAt: asStr(raw.lastUsedAt || raw.last_used_at) || null,
      createdAt: asStr(raw.createdAt || raw.created_at) || null,
    })
  }
  return out
}

/**
 * 账号列表净化（宿主持久化用）：只接受 {account, password}，去掉空项与超长值。
 * 明文密码按用户要求保存在本机 state 文件（0600），供面板内查看与一键登录。
 */
export function sanitizeAccounts(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    if (!isObj(raw)) continue
    const account = asStr(raw.account)
    const password = typeof raw.password === 'string' ? raw.password : ''
    if (account === '' || account.length > 64 || password.length > 256) continue
    const key = account.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ account, password, addedAt: toNum(raw.addedAt) ?? Date.now() })
  }
  return out
}

/**
 * 已存账号里挑选自动重登凭据（「cookie 即身份」的保守守卫）：
 * 仅当 activeAccount 非空且命中（大小写不敏感）且有密码时返回该条目；
 * activeAccount 为空（纯 cookie 粘贴 / 身份未知 / 未命中）一律 null ——
 * 宁可不自动重登，也绝不把 A 账号重登到 B 的会话上。
 */
export function pickReloginAccount(state) {
  if (!isObj(state)) return null
  const active = typeof state.activeAccount === 'string' ? state.activeAccount.trim().toLowerCase() : ''
  if (active === '' || !Array.isArray(state.accounts)) return null
  for (const a of state.accounts) {
    if (isObj(a) && typeof a.account === 'string' && a.account.toLowerCase() === active
      && typeof a.password === 'string' && a.password !== '') return a
  }
  return null
}

/**
 * 账号名匹配（/session 粘贴新 cookie 后的身份对齐用）：返回命中的账号条目或 null。
 */
export function matchAccountName(accounts, name) {
  const key = typeof name === 'string' ? name.trim().toLowerCase() : ''
  if (key === '' || !Array.isArray(accounts)) return null
  for (const a of accounts) {
    if (isObj(a) && typeof a.account === 'string' && a.account.toLowerCase() === key) return a
  }
  return null
}

// =====================================================================
// 阶跃（StepFun）持久化结构净化（与基元账号池同一口径：明文凭据只落本机 0600 state 文件）
// =====================================================================

/**
 * 阶跃账号池净化（密码直登单轨，2026-09 定稿：浏览器登录功能整体摘除）：
 * 账号 3~64 + 密码 1~256；同键去重、≤20 条。凭据只落本机 0600 state 文件。
 */
export function sanitizeStepAccounts(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    if (!isObj(raw)) continue
    const username = asStr(raw.username).trim()
    const password = typeof raw.password === 'string' ? raw.password : ''
    if (username.length < 3 || username.length > 64 || password === '' || password.length > 256) continue
    const key = username.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ username, password, addedAt: toNum(raw.addedAt) ?? Date.now() })
    if (out.length >= 20) break
  }
  return out
}

/** 阶跃偏好净化：胶囊接管开关 / 显示内容 / 当前面板提供商（跨会话记忆） */
export function sanitizeStepPrefs(input) {
  const out = { takeover: true, mode: 'auto', provider: 'tr' }
  if (!isObj(input)) return out
  if (input.takeover === false) out.takeover = false
  if (input.mode === 'credits' || input.mode === 'balance' || input.mode === 'auto') out.mode = input.mode
  if (input.provider === 'step' || input.provider === 'tr') out.provider = input.provider
  return out
}

/** 当前阶跃活跃登录凭据（与 pickReloginAccount 同一保守护栏：无绑定绝不借他人账号） */
export function pickStepAccount(step) {
  if (!isObj(step) || !Array.isArray(step.accounts)) return null
  const active = typeof step.activeAccount === 'string' ? step.activeAccount.trim().toLowerCase() : ''
  if (active === '') return null
  for (const a of step.accounts) {
    if (isObj(a) && typeof a.username === 'string' && a.username.toLowerCase() === active
      && typeof a.password === 'string' && a.password !== '') return a
  }
  return null
}

// =====================================================================
// Cordis 插件半区：路由注册（全部包在 effect 里，卸载即回收）
// =====================================================================

export const name = 'dsh-tokenrhythm-bill'
// ---- normalizeStatus：status.moonlink.top /api/status?range=90d 响应 → 面板轻量结构。
// 返回 null 表示入参不可解析。设计要点：
//   * latest.models 逐通道挑字段（status 三态白名单，ttfb/http 缺失 → null）；
//   * a24/a7/a90 逐日聚合可用率（%保留 1 位小数；'@api' 网关无逐日记录 → null）；
//   * daily 全通道按天合并成功率（%保留 2 位，t=0 的天丢弃）；
//   * incidents 兼容 {events:[…]}（90d 档实测形态）、裸数组与平铺 {id: item} 三种
//     形态，按 started_at 降序截 12 条，resolved_at 缺失/0 视为未解决；
//   * 24h/7d 档 slots → slotGrid + 每模型状态码串（u/g/d/-，与 grid 展平序对齐）；
//   * catalog 只取上下文/价格拼 meta 文案；
export function normalizeStatus(raw, range) {
  range = range === '24h' || range === '7d' || range === '90d' ? range : '90d'
  if (!isObj(raw) || !isObj(raw.latest) || !isObj(raw.latest.models)) return null
  const daysMap = isObj(raw.history) && isObj(raw.history.days) ? raw.history.days : {}
  const days = Object.keys(daysMap).filter((d) => isObj(daysMap[d])).sort()
  const today = days.length > 0 ? days[days.length - 1] : null
  const winAvail = (id, n) => {
    let ok = 0
    let t = 0
    for (const d of days.slice(-n)) {
      const e = daysMap[d][id]
      if (isObj(e) && Number.isFinite(e.ok) && Number.isFinite(e.t) && e.t > 0) { ok += e.ok; t += e.t }
    }
    return t > 0 ? Math.round((ok / t) * 1000) / 10 : null
  }
  const models = []
  for (const m of Object.values(raw.latest.models)) {
    if (!isObj(m) || typeof m.model !== 'string' || m.model === '') continue
    const t24 = today !== null && isObj(daysMap[today][m.model]) ? daysMap[today][m.model] : null
    models.push({
      id: m.model,
      status: m.status === 'up' || m.status === 'degraded' || m.status === 'down' ? m.status : 'down',
      ttfb: Number.isFinite(m.ttfb) ? m.ttfb : null,
      http: Number.isFinite(m.http) ? m.http : null,
      error: typeof m.error === 'string' ? m.error : '',
      a24: isObj(t24) && Number.isFinite(t24.ok) && Number.isFinite(t24.t) && t24.t > 0
        ? Math.round((t24.ok / t24.t) * 1000) / 10
        : null,
      a7: winAvail(m.model, 7),
      a90: winAvail(m.model, days.length || 1),
    })
  }
  const daily = []
  for (const d of days) {
    let ok = 0
    let t = 0
    for (const e of Object.values(daysMap[d])) {
      if (isObj(e) && Number.isFinite(e.ok) && Number.isFinite(e.t) && e.t > 0) { ok += e.ok; t += e.t }
    }
    if (t > 0) daily.push({ d, v: Math.round((ok / t) * 10000) / 100 })
  }
  // 逐模型逐日可用性（千分比整数，null=无数据，对齐 days 键序）——客户端照官方页
  // 渲染 90 天逐日柱条；catalog 只拼 meta 文案「ctxK · ¥in/out」（照官方页口径）。
  const metaMap = {}
  const catModels = isObj(raw.catalog) && isObj(raw.catalog.models) ? raw.catalog.models : {}
  for (const [id, info] of Object.entries(catModels)) {
    if (!isObj(info)) continue
    const ctx = Number.isFinite(info.context_length) && info.context_length > 0 ? (info.context_length / 1000) + 'K' : ''
    const price = Number.isFinite(info.input_price) && Number.isFinite(info.output_price)
      ? '¥' + info.input_price + '/' + info.output_price
      : ''
    const meta = [ctx, price].filter(Boolean).join(' · ')
    if (meta !== '') metaMap[id] = meta
  }
  const modelDaily = {}
  for (const m of models) {
    const arr = []
    for (const d of days) {
      const e = daysMap[d][m.id]
      arr.push(isObj(e) && Number.isFinite(e.ok) && Number.isFinite(e.t) && e.t > 0
        ? Math.round((e.ok / e.t) * 1000)
        : null)
    }
    modelDaily[m.id] = arr
  }
  // 24h/7d 档：slots（{日期:{时刻:{s,ttfb,err}}}）→ 官方式细格子。grid = 日期×时刻
  // 展平序（官方同款双排序）；每模型一条状态码串（u/g/d/-，与 grid 对齐），客户端
  // 切尾 maxCells（24h=288 / 7d=2016）后逐格渲染 + 悬停「模型 · 时间 · 状态」。
  let slotGrid = null
  let slotCodes = null
  if (range !== '90d' && isObj(raw.slots)) {
    const grid = []
    let total = 0
    const slotDays = Object.keys(raw.slots).filter((dk) => isObj(raw.slots[dk])).sort()
    for (const dk of slotDays) {
      const hms = Object.keys(raw.slots[dk]).filter((hm) => isObj(raw.slots[dk][hm])).sort()
      grid.push([dk, hms])
      total += hms.length
    }
    if (total > 0) {
      slotGrid = grid
      slotCodes = {}
      for (const m of models) {
        let s = ''
        for (const [dk, hms] of grid) {
          for (const hm of hms) {
            const e = raw.slots[dk][hm][m.id]
            s += isObj(e) && typeof e.s === 'string'
              ? (e.s === 'up' ? 'u' : e.s === 'degraded' ? 'g' : 'd')
              : '-'
          }
        }
        slotCodes[m.id] = s
      }
    }
  }
  // incidents 形态防御：实测 90d 档是 { events: [...] }；兼容裸数组与平铺 {id: item}。
  const incRaw = raw.incidents
  let incSrc = []
  if (Array.isArray(incRaw)) incSrc = incRaw
  else if (isObj(incRaw)) {
    if (Array.isArray(incRaw.events)) incSrc = incRaw.events
    else if (Array.isArray(incRaw.list)) incSrc = incRaw.list
    else {
      const arrMember = Object.values(incRaw).find((v) => Array.isArray(v))
      incSrc = arrMember !== undefined ? arrMember : Object.values(incRaw)
    }
  }
  const incidents = incSrc
    .filter((i) => isObj(i) && typeof i.title === 'string' && i.title !== '')
    .sort((a, b) => (Number(b.started_at) || 0) - (Number(a.started_at) || 0))
    .slice(0, 12)
    .map((i) => ({
      title: i.title,
      detail: typeof i.detail === 'string' ? i.detail : '',
      startedAt: Number(i.started_at) || 0,
      resolvedAt: Number(i.resolved_at) || 0,
    }))
  const ups = models.filter((m) => m.status === 'up' && m.ttfb !== null)
  let okSum = 0
  let tSum = 0
  if (today !== null) {
    for (const e of Object.values(daysMap[today])) {
      if (isObj(e) && Number.isFinite(e.ok) && Number.isFinite(e.t) && e.t > 0) { okSum += e.ok; tSum += e.t }
    }
  }
  return {
    overall: typeof raw.latest.overall === 'string' ? raw.latest.overall : 'unknown',
    checkedAt: Number(raw.latest.checked_at) || 0,
    probedAt: 0, // host 抓取成功后回填 Date.now()
    modelCount: models.length,
    upCount: models.filter((m) => m.status === 'up').length,
    todayAvail: tSum > 0 ? Math.round((okSum / tSum) * 10000) / 100 : null,
    avgTtfb: ups.length > 0 ? Math.round(ups.reduce((s, m) => s + m.ttfb, 0) / ups.length) : null,
    historyDays: days.length,
    unresolvedCount: incidents.filter((i) => i.resolvedAt === 0).length,
    models,
    daily,
    days,
    modelDaily,
    meta: metaMap,
    range,
    slotGrid,
    slotCodes,
    incidents,
  }
}

export const inject = ['webServer']

export function apply(ctx) {
  // ---- DSH 目录与文件 ----
  const dshDir = () => (process.env.DSH_HOME && String(process.env.DSH_HOME))
    || (typeof os !== 'undefined' && os.homedir ? join(os.homedir(), '.dsh') : null)
  const settingsPath = () => { const d = dshDir(); return d === null ? null : join(d, 'settings.yaml') }
  const credentialsPath = () => { const d = dshDir(); return d === null ? null : join(d, '.credentials.yaml') }
  // 会话 Cookie + 面板几何都存这个文件（0600），不进浏览器、不进 settings。
  const statePath = () => { const d = dshDir(); return d === null ? null : join(d, 'tokenrhythm-bill-state.json') }
  // 旧项目名（dsh-model-balance）时代的 state 文件：新文件缺失时读它做一次性迁移。
  const legacyStatePath = () => { const d = dshDir(); return d === null ? null : join(d, 'model-balance-state.json') }

  const readTextSafe = (file) => {
    if (file === null) return ''
    try { return existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { return '' }
  }

  // ---- 持久化状态（cookie / 账号列表 / prefs）：读写都 best-effort ----
  let stateLoaded = false
  let state = { cookie: '', csrf: '', prefs: {}, accounts: [], activeAccount: '', update: {}, step: { accounts: [], activeAccount: '', device: '', prefs: sanitizeStepPrefs({}) } }
  const blankStep = () => ({ accounts: [], activeAccount: '', device: '', prefs: sanitizeStepPrefs({}) })

  const loadState = () => {
    if (stateLoaded) return state
    stateLoaded = true
    const file = statePath()
    if (file === null) return state
    let text = readTextSafe(file)
    if (text.trim() === '') text = readTextSafe(legacyStatePath()) // 迁移：旧名 state 兜底
    try {
      const data = JSON.parse(text)
      if (isObj(data)) {
        if (typeof data.cookie === 'string') state.cookie = data.cookie
        if (typeof data.csrf === 'string') state.csrf = data.csrf
        if (typeof data.activeAccount === 'string') state.activeAccount = data.activeAccount
        if (isObj(data.prefs)) state.prefs = data.prefs
        state.accounts = sanitizeAccounts(data.accounts)
        state.update = sanitizeUpdate(data.update)
        if (isObj(data.step)) {
          state.step = {
            accounts: sanitizeStepAccounts(data.step.accounts),
            activeAccount: typeof data.step.activeAccount === 'string' ? data.step.activeAccount : '',
            device: typeof data.step.device === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(data.step.device.trim()) ? data.step.device.trim() : '',
            prefs: sanitizeStepPrefs(data.step.prefs),
          }
        }
      }
    } catch { /* 不可读 → 空状态 */ }
    return state
  }
  const saveState = () => {
    const file = statePath()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ cookie: state.cookie, csrf: state.csrf, prefs: state.prefs, accounts: state.accounts, activeAccount: state.activeAccount, update: state.update, step: state.step, savedAt: Date.now() }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch { /* best-effort：丢持久化不丢功能 */ }
  }

  const sanitizePrefs = (input) => {
    const out = {}
    if (!isObj(input)) return out
    if (isObj(input.panel)) {
      const p = input.panel
      const panel = {}
      for (const k of ['x', 'y', 'w', 'h']) {
        const n = toNum(p[k])
        if (n !== null) panel[k] = n
      }
      if (Object.keys(panel).length > 0) out.panel = panel
    }
    const eb = sanitizeEntryBalance(input.entryBalance)
    if (eb !== null) out.entryBalance = eb
    return out
  }

  // ---- provider / 凭据解析（每次现读，改 settings 即时生效）----
  const readProviders = () => {
    const file = settingsPath()
    const text = readTextSafe(file)
    if (text.trim() === '') return { providers: [], error: (file === null ? '无法定位 DSH 目录' : 'settings.yaml 为空或不可读') }
    try {
      return { providers: parseSettingsProviders(text), error: null }
    } catch (err) {
      return { providers: [], error: 'settings.yaml 解析失败: ' + String((err && err.message) || err) }
    }
  }
  // env 变量优先（同音乐插件 readCredential 的次序），其次凭据文件 refs。
  const resolveKey = (provider) => {
    if (!provider || provider.apiKeyEnv === '') return ''
    try {
      const fromEnv = process.env && process.env[provider.apiKeyEnv]
      if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
    } catch { /* env 不可用 → 落到文件 */ }
    return extractCredentialFromText(provider.apiKeyEnv, readTextSafe(credentialsPath())) || ''
  }

  // ---- /models 上游代理（60s 缓存 + 5xx 网关错重试 1 次）----
  const modelsCache = new Map() // providerId -> { models, ts }
  const fetchWithTimeout = async (url, init) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      return await fetch(url, { ...init, signal: ac.signal })
    } finally {
      clearTimeout(timer)
    }
  }
  const fetchUpstreamModels = async (provider, key) => {
    // baseURL 已以 /v1 等版本段结尾（settings 实际布局）时直接接 /models，
    // 否则补 /v1/models —— 避免拼出 /v1/v1/models。
    const base = provider.baseURL.replace(/\/+$/, '')
    const url = /\/v\d+$/.test(base) ? base + '/models' : base + '/v1/models'
    const init = { headers: { Authorization: 'Bearer ' + key } }
    let res = await fetchWithTimeout(url, init)
    if (RETRYABLE_STATUS.has(res.status)) res = await fetchWithTimeout(url, init)
    const bodyText = await res.text()
    let json = null
    try { json = JSON.parse(bodyText) } catch { /* 非 JSON → 按状态码报错 */ }
    if (!res.ok) {
      const detail = isObj(json) && json.error ? String(json.error.message || json.error) : bodyText.slice(0, 200)
      const err = new Error('上游 ' + res.status + ': ' + detail)
      err.status = res.status
      throw err
    }
    return normalizeModels(json)
  }

  // ---- /balance 上游代理（网页会话 Cookie）----
  // 当日用量：/api/call-logs/page 按本地当日 0 点（UTC ISO）起翻页聚合，
  // 最多 10 页 × 100 条（当日超 1000 次调用时封顶，够用且不拖慢余额加载）。
  const DAILY_LOG_PAGES = 10
  const DAILY_LOG_PAGE_SIZE = 100
  const localMidnightIso = () => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }
  const fetchDailyUsage = async (cookie) => {
    const headers = trHeaders(cookie)
    const startAt = localMidnightIso()
    const endAt = new Date().toISOString()
    let acc = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costCny: 0, calls: 0, successCalls: 0, fetched: 0 }
    for (let page = 1; page <= DAILY_LOG_PAGES; page++) {
      const qs = 'startAt=' + encodeURIComponent(startAt) + '&endAt=' + encodeURIComponent(endAt)
        + '&page=' + page + '&pageSize=' + DAILY_LOG_PAGE_SIZE
      const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/call-logs/page?' + qs, { headers })
      if (!res.ok) break // 日志接口失败只降级当日区块，不影响余额主数据
      const part = summarizeDailyLogs(await res.json().catch(() => null))
      acc = {
        inputTokens: acc.inputTokens + part.inputTokens,
        outputTokens: acc.outputTokens + part.outputTokens,
        cacheReadTokens: acc.cacheReadTokens + part.cacheReadTokens,
        costCny: Math.round((acc.costCny + part.costCny) * 1e6) / 1e6,
        calls: acc.calls + part.calls,
        successCalls: acc.successCalls + part.successCalls,
        fetched: acc.fetched + part.fetched,
      }
      if (part.fetched < DAILY_LOG_PAGE_SIZE) break
    }
    return { ...acc, since: startAt }
  }

  // ---- 近 7 天花费趋势（本地日分桶 + 按模型细分，5 分钟缓存，避免每次余额刷新都翻页）----
  const TREND_TTL_MS = 5 * 60 * 1000
  const TREND_MAX_PAGES = 15
  const TREND_TOP_MODELS = 6
  // 缓存按账号隔离（state.activeAccount）：切换账号后旧账号的缓存不会被发给新账号，
  // 切回原账号也能立刻命中它自己的缓存，而不是看到别的账号的 ¥0。
  const trendCaches = new Map() // activeAccount -> { data, ts }
  const fetchUsageTrend = async (cookie) => {
    const cacheKey = state.activeAccount || '_'
    const hit = trendCaches.get(cacheKey)
    if (hit && Date.now() - hit.ts < TREND_TTL_MS) return hit.data
    const days = 7
    const start = new Date()
    start.setDate(start.getDate() - (days - 1))
    start.setHours(0, 0, 0, 0)
    const end = new Date()
    // 按本地日预建桶（toDateString 即本地时区日期）；models 供柱状图悬停明细。
    const buckets = new Map()
    for (let i = 0; i < days; i++) {
      const d = new Date(start)
      d.setDate(d.getDate() + i)
      buckets.set(d.toDateString(), { date: (d.getMonth() + 1) + '-' + d.getDate(), costCny: 0, calls: 0, models: new Map() })
    }
    const headers = trHeaders(cookie)
    for (let page = 1; page <= TREND_MAX_PAGES; page++) {
      const qs = 'startAt=' + encodeURIComponent(start.toISOString()) + '&endAt=' + encodeURIComponent(end.toISOString())
        + '&page=' + page + '&pageSize=' + DAILY_LOG_PAGE_SIZE
      const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/call-logs/page?' + qs, { headers })
      if (!res.ok) break
      const json = await res.json().catch(() => null)
      const data = unwrapEnvelope(json)
      const list = isObj(data) && Array.isArray(data.list) ? data.list : []
      for (const item of list) {
        if (!isObj(item)) continue
        const t = new Date(item.requestAt || item.time || '')
        const b = buckets.get(t.toDateString())
        if (!b) continue
        const cost = toNum(item.costCny) ?? 0
        b.costCny += cost
        b.calls++
        const name = asStr(item.model || item.requestModelId) || '未知模型'
        const m = b.models.get(name) || { costCny: 0, calls: 0 }
        m.costCny += cost
        m.calls++
        b.models.set(name, m)
      }
      if (list.length < DAILY_LOG_PAGE_SIZE) break
    }
    const out = [...buckets.values()].map((b) => {
      // 模型明细：按花费降序，只保留 Top N，尾部聚合成「其他」行，控制 payload 体积。
      const ranked = [...b.models.entries()]
        .map(([model, m]) => ({ model, costCny: Math.round(m.costCny * 1e4) / 1e4, calls: m.calls }))
        .sort((x, y) => y.costCny - x.costCny)
      let models = ranked
      if (ranked.length > TREND_TOP_MODELS) {
        const tail = ranked.slice(TREND_TOP_MODELS)
        models = ranked.slice(0, TREND_TOP_MODELS)
        models.push({
          model: '其他 ' + tail.length + ' 个模型',
          costCny: Math.round(tail.reduce((acc, m) => acc + m.costCny, 0) * 1e4) / 1e4,
          calls: tail.reduce((acc, m) => acc + m.calls, 0),
        })
      }
      return { date: b.date, costCny: Math.round(b.costCny * 1000) / 1000, calls: b.calls, models }
    })
    trendCaches.set(cacheKey, { data: out, ts: Date.now() })
    // 简单防膨胀：账号数远小于上限，超限清理最旧的一个即可。
    if (trendCaches.size > 12) {
      let oldestKey = null
      let oldestTs = Infinity
      for (const [k, v] of trendCaches) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k }
      }
      if (oldestKey !== null) trendCaches.delete(oldestKey)
    }
    return out
  }

  // ---- 最近调用（24h 内最新 10 条，给面板的「最近调用」折叠列表）----
  const fetchRecentCalls = async (cookie) => {
    const end = new Date()
    const start = new Date(end.getTime() - 24 * 3600 * 1000)
    const qs = 'startAt=' + encodeURIComponent(start.toISOString()) + '&endAt=' + encodeURIComponent(end.toISOString())
      + '&page=1&pageSize=10'
    const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/call-logs/page?' + qs, { headers: trHeaders(cookie) })
    if (!res.ok) return []
    const json = await res.json().catch(() => null)
    const data = unwrapEnvelope(json)
    const list = isObj(data) && Array.isArray(data.list) ? data.list : []
    return list.slice(0, 10).map((item) => ({
      model: asStr(item.model || item.requestModelId),
      status: toNum(item.status),
      latencyMs: toNum(item.latencyMs),
      costCny: toNum(item.costCny),
      inputTokens: toNum(item.inputTokens),
      outputTokens: toNum(item.outputTokens),
      t: asStr(item.requestAt || item.time || ''),
    }))
  }

  // ---- 平台请求统一头：实测网关对无 UA 的请求偶发 504，带上浏览器式头更稳。
  // 变更请求（POST/DELETE…）平台还做 CSRF 双提交 + fetch-metadata 校验：
  // 需 Origin/Sec-Fetch-*（浏览器自动带，node fetch 必须手动补）与
  // X-CSRF-Token（值 = tr_csrf cookie，随会话下发），缺失即 403 CSRF_INVALID。----
  const trHeaders = (cookie, csrf) => ({
    Cookie: csrf ? 'tr_session=' + cookie + '; tr_csrf=' + csrf : 'tr_session=' + cookie,
    Accept: 'application/json',
    'Content-Type': 'application/json', // 变更类请求 body 是 JSON 串；缺它平台按 text/plain 解析 → 400 请求参数类型错误
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Referer: TOKENRHYTHM_BASE + '/account',
    Origin: TOKENRHYTHM_BASE,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
  })

  // ---- 账号密码登录平台（密码只在本次请求内存中出现）----
  const loginOnPlatform = async (account, password) => {
    let res
    try {
      res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ account, password }),
      })
    } catch (err) {
      return { ok: false, error: '登录请求失败：' + String((err && err.message) || err) }
    }
    if (res.status === 401) return { ok: false, error: '账号或密码错误' }
    if (!res.ok) {
      let detail = ''
      try {
        const j = await res.json()
        if (isObj(j) && typeof j.message === 'string') detail = j.message
      } catch { /* 非 JSON 错误体 */ }
      return { ok: false, error: '登录失败（平台 ' + res.status + '）' + (detail ? '：' + detail : '') }
    }
    let cookie = ''
    let csrf = ''
    try {
      const cookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/)
      for (const line of cookies) {
        const m = /tr_session=([^;\s]+)/.exec(line)
        if (m !== null) cookie = m[1]
        const c = /tr_csrf=([^;\s]+)/.exec(line)
        if (c !== null) csrf = c[1]
      }
    } catch { /* 取不到 Set-Cookie → 按失败处理 */ }
    if (cookie === '') return { ok: false, error: '登录成功但未返回会话，请改用粘贴方式' }
    return { ok: true, cookie, csrf }
  }

  // ---- 逐笔限时额度（/api/wallet/expiring-credits，page/pageSize 分页）。----
  // 任一页失败按「首页前失败 → null（回退深扫）/ 中途失败 → 已得条目」降级，
  // 不阻塞余额主数据。
  const EXPIRING_PAGE_SIZE = 50
  const EXPIRING_MAX_PAGES = 5
  const fetchExpiringCredits = async (cookie) => {
    const headers = trHeaders(cookie)
    const merged = []
    for (let page = 1; page <= EXPIRING_MAX_PAGES; page++) {
      const res = await fetchWithTimeout(
        TOKENRHYTHM_BASE + '/api/wallet/expiring-credits?page=' + page + '&pageSize=' + EXPIRING_PAGE_SIZE,
        { headers },
      ).catch(() => null)
      const body = res !== null && res.ok ? await res.json().catch(() => null) : null
      const list = body && isObj(body.data) && Array.isArray(body.data.list) ? body.data.list : []
      if (res === null || !res.ok) return page === 1 ? null : { data: { list: merged } }
      merged.push(...list)
      const total = isObj(body.data) && Number.isFinite(Number(body.data.total)) ? Number(body.data.total) : 0
      if (list.length === 0 || merged.length >= total) break
    }
    return { data: { list: merged } }
  }

  const fetchUpstreamBalance = async (cookie, retried) => {
    const headers = trHeaders(cookie)
    const [summaryRes, meRes, expiring] = await Promise.all([
      fetchWithTimeout(TOKENRHYTHM_BASE + '/api/usage-summary', { headers }),
      fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me', { headers }).catch(() => null),
      fetchExpiringCredits(cookie),
    ])
    if (summaryRes.status === 401 || (meRes !== null && meRes.status === 401)) {
      // 会话过期：用当前绑定账号自动重登一次（无绑定/重登失败 → 维持原报错），
      // 成功后用新 cookie 整体重试（retried 防递归）。
      if (retried !== true && (await reloginActive())) return fetchUpstreamBalance(state.cookie, true)
      const err = new Error('session expired')
      err.code = 'SESSION_EXPIRED'
      throw err
    }
    if (!summaryRes.ok) {
      const err = new Error('usage-summary 上游 ' + summaryRes.status)
      err.status = summaryRes.status
      throw err
    }
    const summary = await summaryRes.json().catch(() => null)
    const me = meRes !== null && meRes.ok ? await meRes.json().catch(() => null) : null
    const [daily, trend, recent] = await Promise.all([
      fetchDailyUsage(cookie).catch(() => null),
      fetchUsageTrend(cookie).catch(() => null),
      fetchRecentCalls(cookie).catch(() => null),
    ])
    return { ...normalizeBalance(summary, me, expiring), daily, trend, recent }
  }

  // Cookie 模式账户名缓存：manifest / session 路由标注「数据账号」用。
  // 以 cookie 为键（换会话自动失效），TTL 10 分钟；请求失败静默返回 null，
  // 前端回退「未登录（Cookie 模式）」文案——标注用途，宁可缺不阻塞。
  const meAccount = { cookie: '', name: null, ts: 0 }
  const ME_ACCOUNT_TTL_MS = 10 * 60 * 1000
  const fetchMeAccountName = async (cookie) => {
    if (cookie === '') return null
    if (meAccount.cookie === cookie && meAccount.name && Date.now() - meAccount.ts < ME_ACCOUNT_TTL_MS) return meAccount.name
    try {
      const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me', { headers: trHeaders(cookie) })
      if (!res.ok) return null
      const name = accountNameFromMe(await res.json().catch(() => null))
      if (name === '') return null
      meAccount.cookie = cookie
      meAccount.name = name
      meAccount.ts = Date.now()
      return name
    } catch { return null }
  }

  // ---- 会话验活（区别于 fetchMeAccountName 的名字缓存：只认实时 200）。
  // 成功结果缓存 60 秒，manifest 每次打开不必都打平台；失败不缓存，可立即重试。----
  let sessionProbeCache = { cookie: '', valid: false, name: null, ts: 0 }
  const PROBE_TTL_MS = 60 * 1000
  const probeSession = async (cookie) => {
    if (cookie === '') return { valid: false, name: null }
    if (sessionProbeCache.cookie === cookie && Date.now() - sessionProbeCache.ts < PROBE_TTL_MS) {
      return { valid: sessionProbeCache.valid, name: sessionProbeCache.name }
    }
    try {
      const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me', { headers: trHeaders(cookie) })
      if (res.status !== 200) return { valid: false, name: null }
      const name = accountNameFromMe(await res.json().catch(() => null))
      const out = { valid: name !== '', name: name || null }
      if (out.valid) sessionProbeCache = { cookie, valid: true, name: out.name, ts: Date.now() }
      return out
    } catch { return { valid: false, name: null } }
  }

  // ---- 会话自动续期：cookie 失效（401）时用「当前绑定账号」的已存密码重登一次。
  // 绑定由 /session 粘贴时对齐（matchAccountName），不存在绑定绝不自动重登；
  // 30 秒冷却防平台故障时反复打登录接口。成功更新 cookie/csrf/activeAccount 并落盘。----
  let lastReloginAt = 0
  const RELOGIN_COOLDOWN_MS = 30 * 1000
  const reloginActive = async () => {
    loadState()
    if (Date.now() - lastReloginAt < RELOGIN_COOLDOWN_MS) return false
    const acc = pickReloginAccount(state)
    if (acc === null) return false
    lastReloginAt = Date.now()
    const r = await loginOnPlatform(acc.account, acc.password)
    if (!r.ok) return false
    state.cookie = r.cookie
    if (r.csrf) state.csrf = r.csrf
    state.activeAccount = acc.account
    saveState()
    return true
  }

  // ---- 阶跃（StepFun）登录与套餐 RPC（实测规则：oasis 凭据**只认 cookie 通道**，
  // header 送 token 一律 "token is illegal"；登录两步 RegisterDevice→SignInByPassword 走
  // **JSON 通道**——2026-09 CDP 拦截真机登录页坐实：官方前端早就是 application/json，
  // 我们旧 grpc-web 二进制帧是全网独一份客户端，被网关当异常流量静默限流（200 空体）。
  // 用户 token ~30min，惰性续命，同基元 relogin 的保序保守护栏）。----
  const STEP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0'
  const STEP_TOKEN_EARLY_S = 300
  const STEP_LOGIN_COOLDOWN_MS = 30 * 1000
  const stepSess = { token: '', expAt: 0, cookie: '', webid: '', account: '', source: '' }
  let stepLastLoginAt = 0
  let stepThrottleUntil = 0 // 平台软频控（200 空体）命中后退避 10 分钟，防用户连点加深封锁
  const STEP_THROTTLE_BACKOFF_MS = 10 * 60 * 1000
  const stepClearSess = () => { stepSess.token = ''; stepSess.expAt = 0; stepSess.cookie = ''; stepSess.webid = ''; stepSess.account = '' }
  // Set-Cookie 白名单：只接收阶跃自己的两枚，绝不回存第三方 cookie（防把无关域凭据带上 RPC）
  const STEP_COOKIE_NAMES = new Set(['Oasis-Token', 'Oasis-Webid'])
  const readStepCookies = (res, jar) => {
    let lines = []
    try {
      lines = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : String(res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/)
    } catch { return }
    for (const line of lines) {
      const m = /^\s*([^=;\s]+)=([^;\s]+)/.exec(line)
      if (m !== null && STEP_COOKIE_NAMES.has(m[1])) jar[m[1]] = m[2]
    }
  }
  const stepCookieHeader = (jar) => ['Oasis-Token', 'Oasis-Webid'].filter((k) => jar[k]).map((k) => k + '=' + jar[k]).join('; ')
  const stepJsonHeaders = (referer, jar) => ({
    ...stepLib.STEP_OASIS_HEADERS,
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': STEP_UA,
    origin: stepLib.STEP_ACCOUNT_BASE,
    referer,
    ...(jar !== null && stepCookieHeader(jar) !== '' ? { cookie: stepCookieHeader(jar) } : {}),
  })
  /**
   * 两步密码登录（JSON 通道，不依赖也不改动全局会话；测试与正式登录共用）。
   * 2026-09 破案（CDP 拦截真实登录页请求）：passport 前端早就是 application/json
   * （RegisterDevice 体 `{}`，SignInByPassword 体 {username,password}）；旧 grpc-web
   * 二进制帧是全网独一份的客户端 → 被网关当异常流量静默限流（200 空体）。换 JSON 即通。
   * knownWebid：沿用上次设备号，减少新设备暴露面。
   */
  const stepLogin = async (username, password, knownWebid) => {
    const jar = {}
    if (typeof knownWebid === 'string' && knownWebid !== '') jar['Oasis-Webid'] = knownWebid
    const loginReferer = stepLib.STEP_ACCOUNT_BASE + '/login'
    let res
    try {
      res = await fetchWithTimeout(stepLib.stepRegisterUrl(), { method: 'POST', headers: stepJsonHeaders(loginReferer, jar), body: '{}' })
    } catch (err) { return { ok: false, error: '注册设备网络失败：' + String((err && err.message) || err) } }
    readStepCookies(res, jar)
    const regj = res.ok ? await res.json().catch(() => null) : null
    if (regj === null) {
      return res.status === 200
        ? { ok: false, code: 'STEP_THROTTLED', error: '注册设备被静默拒绝（空响应，疑似频率限制）：等几分钟再试，勿连续点击' }
        : { ok: false, code: 'STEP_HTTP', error: '注册设备失败：HTTP ' + res.status }
    }
    if (!jar['Oasis-Token'] && regj.accessToken && regj.accessToken.raw) jar['Oasis-Token'] = regj.accessToken.raw
    let res2
    try {
      res2 = await fetchWithTimeout(stepLib.stepSignInUrl(), { method: 'POST', headers: stepJsonHeaders(loginReferer, jar), body: JSON.stringify({ username, password }) })
    } catch (err) { return { ok: false, error: '登录网络失败：' + String((err && err.message) || err) } }
    readStepCookies(res2, jar)
    if (res2.status === 401 || res2.status === 403) return { ok: false, code: 'STEP_BAD_CREDS', error: '账号或密码错误' }
    const auth = res2.ok ? await res2.json().catch(() => null) : null
    if (auth === null) {
      return res2.status === 200
        ? { ok: false, code: 'STEP_THROTTLED', error: '登录被静默拒绝（空响应，疑似频率限制）：请等几分钟后重试，勿连续点击' }
        : { ok: false, code: 'STEP_HTTP', error: '登录失败：HTTP ' + res2.status }
    }
    const at = auth.accessToken || auth.access_token
    const token = at && typeof at.raw === 'string' ? at.raw : null
    if (token === null) {
      const msg = typeof auth.desc === 'string' ? auth.desc : ''
      return { ok: false, code: msg !== '' ? 'STEP_BAD_CREDS' : 'STEP_SHAPE', error: msg !== '' ? '登录被拒：' + msg : '登录响应缺少 token（接口可能已改版）' }
    }
    // 实测（"token is illegal" 案，2026-09）：Set-Cookie 里的 Oasis-Token 是平台可用的
    // 长会话令牌（~628 字节）；JSON 体的 accessToken.raw 是 account 域作用域短令牌
    // （~316 字节），拿它覆盖 cookie 会话会被平台 RPC 判非法 —— 只在 Set-Cookie 缺失时才回退。
    const cookieToken = typeof jar['Oasis-Token'] === 'string' && jar['Oasis-Token'] !== '' ? jar['Oasis-Token'] : token
    const expAt = stepLib.jwtExpiry(cookieToken) || stepLib.jwtExpiry(token) || Math.floor(Date.now() / 1000) + 1500
    const rt = auth.refreshToken || auth.refresh_token
    return { ok: true, token: cookieToken, expAt, webid: jar['Oasis-Webid'] || '', cookie: stepCookieHeader(jar), refreshToken: rt && typeof rt.raw === 'string' ? rt.raw : '' }
  }
  const stepSessFresh = () => stepSess.token !== '' && stepSess.expAt - Math.floor(Date.now() / 1000) > STEP_TOKEN_EARLY_S
  /** 命中软频控 → 记退避窗；退避期内所有登录尝试（含手动测试）统一挡回，防连点加深封锁 */
  const stepNoteThrottle = (r) => { if (r && r.code === 'STEP_THROTTLED') stepThrottleUntil = Date.now() + STEP_THROTTLE_BACKOFF_MS }
  const stepThrottleGate = () => {
    if (Date.now() < stepThrottleUntil) {
      const min = Math.ceil((stepThrottleUntil - Date.now()) / 60000)
      return { ok: false, code: 'STEP_THROTTLED', error: '阶跃平台暂时限流，约 ' + min + ' 分钟后自动重试（无需连续点击）' }
    }
    return null
  }
  /** 登录成功 → 会话缓存 + 设备号持久化（下次登录复用，降新设备暴露面） */
  const stepApplySession = (r, account) => {
    Object.assign(stepSess, { token: r.token, expAt: r.expAt, cookie: r.cookie, webid: r.webid, account, source: 'script' })
    if (r.webid && r.webid !== state.step.device) { state.step.device = r.webid; saveState() }
  }
  // ---- 密码直登为唯一主轨（2026-09 定稿：浏览器登录功能整体摘除。JSON 通道打通后
  // 密码登录全链实测稳定，风控顾虑解除；浏览器轨的 profile 维护成本不再值得）----
  const stepScriptEnsureSession = async (acc, force) => {
    const gated = stepThrottleGate()
    if (gated !== null) return gated
    if (!force && stepSessFresh() && stepSess.account === acc.username) return { ok: true }
    if (!force && Date.now() - stepLastLoginAt < STEP_LOGIN_COOLDOWN_MS) return { ok: false, code: 'STEP_COOLDOWN', error: '重登冷却中（30 秒），稍后自动恢复' }
    stepLastLoginAt = Date.now()
    const r = await stepLogin(acc.username, acc.password, state.step.device)
    if (!r.ok) { stepClearSess(); stepNoteThrottle(r); return { ok: false, code: r.code || 'STEP_REAUTH_FAILED', error: r.error } }
    stepApplySession(r, acc.username)
    return { ok: true }
  }
  const stepEnsureSessionInner = async (force) => {
    loadState()
    const acc = pickStepAccount(state.step)
    if (acc === null) {
      // 有账号但没密码（浏览器时代残留）→ 指引补密码，别用「未配置」误导
      if (isObj(state.step) && Array.isArray(state.step.accounts) && state.step.accounts.length > 0) {
        return { ok: false, code: 'NO_STEP_ACCOUNT', error: '账号缺少密码：设置 → 阶跃账号 → 输入密码保存后即可使用' }
      }
      return { ok: false, code: 'NO_STEP_ACCOUNT', error: '未配置阶跃账号（设置 → 阶跃账号）' }
    }
    return stepScriptEnsureSession(acc, force)
  }
  // 并发去重：fetchStepPlan 三路 stepRpc 同刻齐发，若各自独立走到冷却戳/登录动作，
  // 后来者会被首个调用刚写下的冷却窗误伤（实测 credit/usages 双双"冷却中"）。
  // 同账号的并发 ensure 共享同一个 in-flight promise，谁先跑谁干活。
  const stepEnsureBusy = new Map()
  const stepEnsureSession = (force) => {
    loadState()
    const acc = pickStepAccount(state.step)
    if (acc === null) return Promise.resolve({ ok: false, code: 'NO_STEP_ACCOUNT', error: '未配置阶跃账号（设置 → 阶跃账号）' })
    const key = acc.username
    const busy = stepEnsureBusy.get(key)
    if (busy !== undefined) return busy
    const p = stepEnsureSessionInner(force).finally(() => { stepEnsureBusy.delete(key) })
    stepEnsureBusy.set(key, p)
    return p
  }
  /**
   * 平台 JSON RPC（控制台同款形态，CDP 抓包坐实）：POST {} / application/json，
   * 响应 JSON，成功 = HTTP 200 且 status:1；401/403 → 会话失效，强制重登/重收割重试一次
   * （relogged 防递归），与基元 401 重登同构。
   */
  const stepRpc = async (service, method, bodyObj, relogged) => {
    const s = await stepEnsureSession(false)
    if (!s.ok) return s
    let res
    try {
      res = await fetchWithTimeout(stepLib.stepRpcUrl('/api/' + service + '/' + method), {
        method: 'POST',
        headers: {
          ...stepLib.STEP_OASIS_HEADERS,
          'content-type': 'application/json',
          accept: 'application/json',
          cookie: stepSess.cookie,
          'oasis-webid': stepSess.webid,
          origin: stepLib.STEP_PLATFORM_BASE,
          referer: stepLib.STEP_PLATFORM_BASE + '/step-plan',
        },
        body: JSON.stringify(bodyObj || {}),
      })
    } catch (err) { return { ok: false, code: 'STEP_NET', error: method + ' 网络失败：' + String((err && err.message) || err) } }
    const authed = res.status === 401 || res.status === 403
    let json = null
    if (!authed && res.ok) json = await res.json().catch(() => null)
    if (authed || (res.ok && json === null)) {
      if (relogged !== true) {
        const s2 = await stepEnsureSession(true)
        if (!s2.ok) return { ok: false, code: 'STEP_REAUTH_FAILED', error: s2.error }
        return stepRpc(service, method, bodyObj, true)
      }
      return { ok: false, code: 'STEP_REAUTH_FAILED', error: method + ' 会话失效（HTTP ' + res.status + '）' }
    }
    if (!res.ok) return { ok: false, code: 'STEP_RPC', error: method + ' 失败：HTTP ' + res.status }
    if (typeof json.status === 'number' && json.status !== 1) {
      return { ok: false, code: 'STEP_RPC', error: method + ' 拒绝(status ' + json.status + ')：' + (json.desc || '无描述') }
    }
    return { ok: true, data: json }
  }
  // 套餐三查询并行（5min TTL + 单飞 + 上次成功值 stale 兜底；usages 失败只降级不阻塞）
  const STEP_PLAN_TTL_MS = 5 * 60 * 1000
  let stepPlanCache = null // { data, ts, account }
  let stepPlanBusy = null
  const fetchStepPlan = async (force) => {
    loadState()
    const acc = pickStepAccount(state.step)
    if (acc === null) return { ok: false, code: 'NO_STEP_ACCOUNT', error: '未配置阶跃账号（设置 → 阶跃账号）' }
    if (!force && stepPlanCache && stepPlanCache.account === acc.username && Date.now() - stepPlanCache.ts < STEP_PLAN_TTL_MS) return { ok: true, ...stepPlanCache.data, cached: true }
    if (stepPlanBusy !== null) return stepPlanBusy
    stepPlanBusy = (async () => {
      const nowS = Math.floor(Date.now() / 1000)
      // QueryStepPlanUsages 官方页面实证：int64 毫秒时间戳必须以「字符串」发送
      // （connect JSON 的 bigint 序列化口径），毫秒数字/秒值都会被服务端静默清零 → 恒空。
      // 窗口放宽到 35 天：账号的记录流不保证落在近 7 日（最近记录可能数周前），
      // 拉全量由前端取「最近 7 个有记录的日子」作图。
      const dayMs = (d) => { const t = new Date(d); t.setHours(0, 0, 0, 0); return t.getTime() }
      const usageStart = String(dayMs(Date.now() - 35 * 86400000))
      const usageTo = String(Date.now())
      const [statusR, creditR, usageR] = await Promise.all([
        stepRpc(stepLib.STEP_DEV_SERVICE, 'GetStepPlanStatus', {}),
        stepRpc(stepLib.STEP_DEV_SERVICE, 'QueryStepPlanRateLimit', {}),
        stepRpc(stepLib.STEP_DEV_SERVICE, 'QueryStepPlanUsages', { startTime: usageStart, toTime: usageTo, page: 1, pageSize: 200 }),
      ])
      if (!statusR.ok && !creditR.ok) {
        if (stepPlanCache && stepPlanCache.account === acc.username) return { ok: true, ...stepPlanCache.data, cached: true, stale: true, error: statusR.error || creditR.error }
        return { ok: false, code: statusR.code || creditR.code || 'STEP_RPC', error: statusR.error || creditR.error }
      }
      const data = {
        plan: statusR.ok ? stepLib.normalizeStepPlanStatus(statusR.data) : null,
        credit: creditR.ok ? stepLib.normalizeStepCredit(creditR.data) : null,
        usages: usageR.ok ? stepLib.normalizeStepUsages(usageR.data).slice(0, 400) : [],
        statusError: statusR.ok ? null : statusR.error,
        creditError: creditR.ok ? null : creditR.error,
        usageError: usageR.ok ? null : usageR.error,
        fetchedAt: Date.now(),
        account: acc.username,
      }
      stepPlanCache = { data, ts: Date.now(), account: acc.username }
      return { ok: true, ...data }
    })()
    try { return await stepPlanBusy } finally { stepPlanBusy = null }
  }
  // 余额（双通道）：① 有阶跃账号（任意轨）→ 优先控制台 QueryAccountBalance（浏览器会话
  // 同款接口，免 API key，含现金/赠送/消耗全量字段，实测坐实）；② 失败或无账号 →
  // 官方 /v1/accounts API-key 通道兜底。
  const fetchStepOfficialBalance = async () => {
    loadState()
    const acc = pickStepAccount(state.step)
    if (acc !== null) {
      const r = await stepRpc(stepLib.STEP_DEV_SERVICE, 'QueryAccountBalance', {})
      if (r.ok) {
        const w = stepLib.normalizeStepWallet(r.data)
        if (w !== null && w.balance !== null) return { ok: true, account: w, source: 'console' }
      }
    }
    const { providers } = readProviders()
    const p = providers.find((x) => x && x.id === 'step') || null
    const key = resolveKey(p !== null ? p : { apiKeyEnv: 'STEP_API_KEY' })
    if (key === '') return { ok: false, code: 'NO_KEY', error: acc !== null ? '控制台余额接口暂不可达，且未配置 STEP_API_KEY 兜底' : '未找到 STEP_API_KEY（env 与 ~/.dsh/.credentials.yaml 都没有）' }
    try {
      const res = await fetchWithTimeout('https://api.stepfun.com/v1/accounts', { headers: { Authorization: 'Bearer ' + key, 'user-agent': STEP_UA } })
      if (!res.ok) return { ok: false, code: 'STEP_HTTP', error: '阶跃余额接口 HTTP ' + res.status }
      return { ok: true, account: stepLib.normalizeStepAccounts(await res.json().catch(() => null)), source: 'api' }
    } catch (err) {
      return { ok: false, code: 'STEP_NET', error: '阶跃余额接口网络失败：' + String((err && err.message) || err) }
    }
  }
  const stepPublicAccounts = () => state.step.accounts.map((a) => ({ username: a.username, addedAt: a.addedAt }))

  // ---- /status 服务状态代理（status.moonlink.top 公开状态页）。按 range 取档：
  // 90d=逐日聚合（无逐 5 分钟明细）、24h/7d=含 slots 细格子（官方页三个视图）。
  // 浏览器不跨域直连，统一走 host：每档独立 2min TTL 缓存 + 单飞；上游失败回内存
  // 上次成功结果标 stale，从未成功过才报错（与 /models 的 stale 兜底同一画法）。----
  const STATUS_TTL_MS = 2 * 60 * 1000
  const STATUS_BASE = 'https://status.moonlink.top/api/status'
  const STATUS_RANGES = ['24h', '7d', '90d']
  const statusCaches = {} // range -> { data, ts }
  const statusBusy = {} // range -> 单飞：并发请求共享同一次上游抓取
  const getStatusSnapshot = async (range) => {
    const rg = STATUS_RANGES.includes(range) ? range : '90d'
    const hit = statusCaches[rg]
    if (hit !== undefined && Date.now() - hit.ts < STATUS_TTL_MS) {
      return { data: hit.data, cached: true }
    }
    if (statusBusy[rg] !== undefined) return statusBusy[rg]
    statusBusy[rg] = (async () => {
      try {
        const res = await fetchWithTimeout(STATUS_BASE + '?range=' + rg, {})
        if (!res.ok) { const err = new Error('状态页上游 HTTP ' + res.status); err.status = res.status; throw err }
        const raw = await res.json().catch(() => null)
        const data = normalizeStatus(raw, rg)
        if (data === null) throw new Error('状态页返回不可解析')
        data.probedAt = Date.now()
        statusCaches[rg] = { data, ts: Date.now() }
        return { data, cached: false }
      } catch (err) {
        if (statusCaches[rg] !== undefined) {
          return { data: statusCaches[rg].data, cached: true, stale: true, upstreamError: String((err && err.message) || err) }
        }
        throw err
      }
    })()
    try { return await statusBusy[rg] } finally { delete statusBusy[rg] }
  }

  // ---- shared HTTP helpers（同音乐插件）----
  const writeJson = (res, value, status) => {
    res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  async function readBody(req) {
    let text = ''
    for await (const chunk of req) text += chunk
    if (text === '') return {}
    try { return JSON.parse(text) } catch { return {} }
  }

  const serve = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      const pathname = url.pathname

      if (pathname === '/dsh-tokenrhythm-bill/manifest' && req.method === 'GET') {
        loadState()
        const { providers, error } = readProviders()
        // 用户指定：面板只保留基元律动（tokenrhythm）的内容。
        const visible = providers.filter((p) => p.balanceCapable)
        // 数据账号标注：账号密码模式 activeAccount 是登录手机号，界面上应显示
        // 平台用户名，因此有会话 Cookie 时两种模式都取带缓存的 /api/me 账户名
        // （accountName；失败静默 → 前端回退 account / Cookie 模式文案）。
        // account 保留登录标识（手机号）：设置页账号列表的「当前」徽标靠它比对。
        const meName = state.cookie !== '' ? await fetchMeAccountName(state.cookie) : null
        const sessionAccount = state.activeAccount || meName || null
        // 会话验活：401 先按绑定账号自动重登再验（打开面板即自愈）。
        let probe = state.cookie !== '' ? await probeSession(state.cookie) : { valid: false, name: null }
        if (state.cookie !== '' && !probe.valid && (await reloginActive())) probe = await probeSession(state.cookie)
        writeJson(res, {
          ok: true,
          version: PKG_VERSION,
          providers: visible.map((p) => {
            const key = resolveKey(p)
            return {
              id: p.id,
              displayName: p.displayName,
              baseURL: p.baseURL,
              apiKeyEnv: p.apiKeyEnv,
              hasKey: key !== '',
              keyHint: maskSecret(key),
              balanceCapable: p.balanceCapable,
              modelCount: p.models.length,
            }
          }),
          session: { configured: state.cookie !== '', valid: probe.valid, hint: maskSecret(state.cookie), account: sessionAccount || null, accountName: meName || null },
          step: {
            configured: state.step.accounts.length > 0,
            account: state.step.activeAccount || null,
            session: stepSessFresh() && stepSess.account === (state.step.activeAccount || '') && stepSess.account !== '' ? { valid: true, expAt: stepSess.expAt, source: stepSess.source } : { valid: false },
            prefs: state.step.prefs,
            accounts: stepPublicAccounts(),
          },
          error,
        })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/models' && req.method === 'GET') {
        const providerId = url.searchParams.get('provider') || ''
        const { providers } = readProviders()
        const provider = providers.find((p) => p.id === providerId)
        if (!provider) { writeJson(res, { ok: false, code: 'NO_PROVIDER', error: '未找到提供商: ' + providerId }, 404); return }
        if (provider.baseURL === '') { writeJson(res, { ok: false, code: 'NO_BASE_URL', error: '该提供商未配置 baseURL' }, 409); return }

        // 首选平台模型列表（/api/models，会话 Cookie）：带分类/模态/显示名。
        // 401（会话过期）或失败时静默回退到网关 /v1/models（API Key，无分类）。
        loadState()
        if (state.cookie !== '') {
          const hit = modelsCache.get(provider.id)
          if (hit !== undefined && hit.source === 'platform' && Date.now() - hit.ts < MODELS_TTL_MS) {
            writeJson(res, { ok: true, provider: provider.id, models: hit.models, cached: true, categories: hit.categories, source: 'platform' })
            return
          }
          try {
            const res2 = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/models', { headers: { Cookie: 'tr_session=' + state.cookie } })
            if (res2.ok) {
              const models = normalizePlatformModels(await res2.json().catch(() => null))
              const categories = categoryCounts(models)
              modelsCache.set(provider.id, { models, categories, source: 'platform', ts: Date.now() })
              writeJson(res, { ok: true, provider: provider.id, models, cached: false, categories, source: 'platform' })
              return
            }
          } catch { /* 平台接口不可用 → 走网关兜底 */ }
        }

        const key = resolveKey(provider)
        if (key === '') {
          writeJson(res, { ok: false, code: 'NO_KEY', error: '未读到 ' + provider.apiKeyEnv + '（env 与 ~/.dsh/.credentials.yaml 都没有）' }, 409)
          return
        }
        const hit = modelsCache.get(provider.id)
        if (hit !== undefined && hit.source !== 'platform' && Date.now() - hit.ts < MODELS_TTL_MS) {
          writeJson(res, { ok: true, provider: provider.id, models: hit.models, cached: true, categories: hit.categories, source: 'gateway' })
          return
        }
        try {
          const models = await fetchUpstreamModels(provider, key)
          modelsCache.set(provider.id, { models, source: 'gateway', ts: Date.now() })
          writeJson(res, { ok: true, provider: provider.id, models, cached: false, source: 'gateway' })
        } catch (err) {
          // 上游失败但有过期缓存：宁可给旧数据也别白屏。
          if (hit !== undefined && hit.source !== 'platform') { writeJson(res, { ok: true, provider: provider.id, models: hit.models, cached: true, stale: true, source: 'gateway' }); return }
          writeJson(res, { ok: false, code: err.code || 'UPSTREAM_ERROR', error: String((err && err.message) || err) }, err.status && err.status >= 400 ? err.status : 502)
        }
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/balance' && req.method === 'GET') {
        loadState()
        if (state.cookie === '') { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未配置网页会话 Cookie' }); return }
        try {
          const balance = await fetchUpstreamBalance(state.cookie)
          writeJson(res, { ok: true, ...balance })
        } catch (err) {
          if (err && err.code === 'SESSION_EXPIRED') {
            writeJson(res, { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期，请到「设置」页签重新粘贴 Cookie' })
            return
          }
          writeJson(res, { ok: false, code: 'UPSTREAM_ERROR', error: String((err && err.message) || err) }, 502)
        }
        return
      }

      // 服务状态：基元律动状态页聚合（含网关入口 '@api' 与逐模型 24h/7d/90d 可用率）。
      if (pathname === '/dsh-tokenrhythm-bill/status' && req.method === 'GET') {
        try {
          const r = await getStatusSnapshot(url.searchParams.get('range'))
          writeJson(res, {
            ok: true,
            ...r.data,
            cached: r.cached,
            ...(r.stale ? { stale: true } : {}),
            ...(r.upstreamError ? { upstreamError: r.upstreamError } : {}),
          })
        } catch (err) {
          writeJson(res, { ok: false, error: '状态页不可达：' + String((err && err.message) || err) }, 502)
        }
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/session' && req.method === 'GET') {
        loadState()
        // 验活而非只看「有没有 cookie」：/api/me 200 才算有效；401 先按绑定账号
        // 自动重登一次再验。未配置 / 无绑定 / 重登失败 → valid=false。
        let probe = state.cookie !== '' ? await probeSession(state.cookie) : { valid: false, name: null }
        if (state.cookie !== '' && !probe.valid && (await reloginActive())) probe = await probeSession(state.cookie)
        writeJson(res, { ok: true, configured: state.cookie !== '', valid: probe.valid, account: probe.name, hint: maskSecret(state.cookie) })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/session' && req.method === 'POST') {
        const body = await readBody(req)
        const raw = body && typeof body.value === 'string' ? body.value : ''
        const cookie = extractSessionCookie(raw)
        const csrf = extractCsrfCookie(raw)
        loadState()
        state.cookie = cookie
        if (csrf !== '') state.csrf = csrf
        // 换 Cookie 即切号：解析新 cookie 的真实身份并对齐绑定。解析失败 / 未命中
        // 一律清空 activeAccount —— 宁可不自动重登，也绝不把旧账号重登到新会话上。
        let bound = false
        let sessionAccount = null
        if (cookie !== '') {
          sessionAccount = await fetchMeAccountName(cookie)
          const hit = matchAccountName(state.accounts, sessionAccount)
          if (hit !== null) { state.activeAccount = hit.account; bound = true }
          else state.activeAccount = ''
        } else {
          state.activeAccount = ''
        }
        saveState()
        writeJson(res, { ok: true, configured: cookie !== '', hint: maskSecret(cookie), account: sessionAccount, bound })
        return
      }

      // 账号密码登录：host 直接调平台登录接口，成功后从 Set-Cookie 提取
      // tr_session 存入 state（0600）。凭据同时并入 accounts（明文 0600，与账号
      // 管理一致）：会话过期后自动重登可用，登录事件与贴 Cookie 两条路径绑定语义一致。
      if (pathname === '/dsh-tokenrhythm-bill/auth/login' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account.trim() : ''
        const password = body && typeof body.password === 'string' ? body.password : ''
        if (account === '' || password === '') { writeJson(res, { ok: false, error: '请填写账号和密码' }, 400); return }
        const r = await loginOnPlatform(account, password)
        if (!r.ok) { writeJson(res, { ok: false, error: r.error }); return }
        loadState()
        state.cookie = r.cookie
        if (r.csrf) state.csrf = r.csrf
        state.activeAccount = account
        const rest = state.accounts.filter((a) => a.account.toLowerCase() !== account.toLowerCase())
        state.accounts = sanitizeAccounts([...rest, { account, password, addedAt: Date.now() }])
        saveState()
        writeJson(res, { ok: true, configured: true, hint: maskSecret(r.cookie) })
        return
      }

      // 账号管理：添加（按用户要求明文保存密码，可随时查看）/ 删除 / 一键登录。
      if (pathname === '/dsh-tokenrhythm-bill/accounts' && req.method === 'GET') {
        loadState()
        writeJson(res, { ok: true, accounts: state.accounts })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/accounts/add' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account.trim() : ''
        const password = body && typeof body.password === 'string' ? body.password : ''
        if (account === '' || password === '') { writeJson(res, { ok: false, error: '请填写账号和密码' }, 400); return }
        loadState()
        const rest = state.accounts.filter((a) => a.account.toLowerCase() !== account.toLowerCase())
        state.accounts = sanitizeAccounts([...rest, { account, password, addedAt: Date.now() }])
        saveState()
        const r = await loginOnPlatform(account, password)
        if (r.ok) { state.cookie = r.cookie; if (r.csrf) state.csrf = r.csrf; state.activeAccount = account; saveState() }
        writeJson(res, { ok: true, saved: true, loggedIn: r.ok, hint: r.ok ? maskSecret(r.cookie) : null, error: r.error || null })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/accounts/remove' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account : ''
        loadState()
        state.accounts = state.accounts.filter((a) => a.account.toLowerCase() !== account.toLowerCase())
        saveState()
        writeJson(res, { ok: true, accounts: state.accounts })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/accounts/login' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account : ''
        loadState()
        const acc = state.accounts.find((a) => a.account.toLowerCase() === account.toLowerCase())
        if (!acc) { writeJson(res, { ok: false, error: '账号不存在' }, 404); return }
        const r = await loginOnPlatform(acc.account, acc.password)
        if (!r.ok) { writeJson(res, { ok: false, error: r.error }); return }
        state.cookie = r.cookie
        if (r.csrf) state.csrf = r.csrf
        state.activeAccount = acc.account
        saveState()
        writeJson(res, { ok: true, hint: maskSecret(r.cookie) })
        return
      }

      // 平台「我的 API Key」：列表（平台只给掩码）与新建（完整 Key 只在创建响应出现一次）。
      if (pathname === '/dsh-tokenrhythm-bill/keys' && req.method === 'GET') {
        loadState()
        if (state.cookie === '') { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未登录' }); return }
        try {
          let up = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/api-keys', { headers: trHeaders(state.cookie) })
          // 401（会话过期）：按绑定账号自动重登一次后用新 cookie 重试。
          if (up.status === 401 && (await reloginActive())) {
            up = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/api-keys', { headers: trHeaders(state.cookie) })
          }
          if (up.status === 401) { writeJson(res, { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期' }); return }
          if (!up.ok) { writeJson(res, { ok: false, error: '平台返回 ' + up.status }, 502); return }
          // 平台列表只给打码值；本机凭据若与某把密钥的前缀/后缀一致，则标记可复制完整值。
          const { providers } = readProviders()
          const tProvider = providers.find((p) => p.balanceCapable)
          const localKey = tProvider ? resolveKey(tProvider) : ''
          const keys = normalizePlatformKeys(await up.json().catch(() => null))
          for (const k of keys) {
            const suffix = k.masked.includes('****') ? k.masked.split('****').pop() : ''
            k.copyable = !!localKey && ((k.prefix !== '' && localKey.startsWith(k.prefix)) || (suffix !== '' && localKey.endsWith(suffix)))
          }
          writeJson(res, { ok: true, keys, localKnown: localKey !== '' })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }

      // 复制旧密钥：平台只存打码值，但本机凭据与其匹配时返回完整值。
      if (pathname === '/dsh-tokenrhythm-bill/key-reveal' && req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') || ''
        const suffix = url.searchParams.get('suffix') || ''
        const { providers } = readProviders()
        const tProvider = providers.find((p) => p.balanceCapable)
        const localKey = tProvider ? resolveKey(tProvider) : ''
        if (localKey === '' || prefix === '' || suffix === '') { writeJson(res, { ok: false, error: '本机没有对应的完整密钥' }, 404); return }
        if (localKey.startsWith(prefix) && localKey.endsWith(suffix)) {
          writeJson(res, { ok: true, key: localKey })
        } else {
          writeJson(res, { ok: false, error: '本机没有对应的完整密钥' }, 404)
        }
        return
      }
      // ---- 变更类平台请求（POST/DELETE…）封装：平台的 CSRF 双提交 + fetch-metadata
      // 校验只针对非安全方法。遇 403 CSRF_INVALID 自愈：GET /api/auth/me 让平台重发
      // tr_csrf（可能同时轮换 tr_session），落盘新配对后重试一次；仍失败才报给界面。
      // 返回 { status, ok, body }；本机未登录返回 null。----
      const trMutate = async (path, init) => {
        loadState()
        if (state.cookie === '') return null
        const attempt = async (cookie, csrf) => {
          const res = await fetchWithTimeout(TOKENRHYTHM_BASE + path, {
            ...(init || {}),
            headers: { ...trHeaders(cookie, csrf), ...(init && init.headers ? init.headers : {}) },
          })
          return { status: res.status, ok: res.ok, body: await res.json().catch(() => null) }
        }
        let r = await attempt(state.cookie, state.csrf)
        if (r.status !== 403 || !isObj(r.body) || String(r.body.code || '').toUpperCase() !== 'CSRF_INVALID') return r
        try {
          const me = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/auth/me', { headers: trHeaders(state.cookie, state.csrf) })
          const lines = typeof me.headers.getSetCookie === 'function'
            ? me.headers.getSetCookie()
            : (me.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/)
          for (const line of lines) {
            const s = /tr_session=([^;\s]+)/.exec(line)
            if (s !== null) state.cookie = s[1]
            const c = /tr_csrf=([^;\s]+)/.exec(line)
            if (c !== null) state.csrf = c[1]
          }
          saveState()
        } catch { /* 刷新失败 → 仍用现有配对重试一次 */ }
        const r2 = await attempt(state.cookie, state.csrf)
        // 401（会话过期）：按绑定账号自动重登一次后用新配对再试。
        if (r2.status === 401 && (await reloginActive())) return attempt(state.cookie, state.csrf)
        return r2
      }
      if (pathname === '/dsh-tokenrhythm-bill/keys/create' && req.method === 'POST') {
        const body = await readBody(req)
        const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 64) : ''
        if (name === '') { writeJson(res, { ok: false, error: '请填写密钥名称' }, 400); return }
        try {
          const up = await trMutate('/api/api-keys', { method: 'POST', body: JSON.stringify({ name }) })
          if (up === null) { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未登录' }); return }
          if (up.status === 401) { writeJson(res, { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期' }); return }
          if (!up.ok) {
            const detail = isObj(up.body) && typeof up.body.message === 'string' ? up.body.message : ''
            writeJson(res, { ok: false, error: '创建失败（平台 ' + up.status + '）' + (detail ? '：' + detail : '') }, 502)
            return
          }
          const data = unwrapEnvelope(up.body)
          const fullKey = isObj(data) ? asStr(data.key || data.keyValue || data.secret) : ''
          if (fullKey === '') { writeJson(res, { ok: false, error: '平台未返回完整密钥' }, 502); return }
          writeJson(res, { ok: true, id: isObj(data) ? asStr(data.id) : '', name, key: fullKey })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }

      // 返回完整 API Key 供「复制」按钮写入剪贴板（仅本机请求；不在界面上明文渲染）。
      if (pathname === '/dsh-tokenrhythm-bill/key' && req.method === 'GET') {
        const providerId = url.searchParams.get('provider') || ''
        const { providers } = readProviders()
        const provider = providers.find((p) => p.id === providerId)
        if (!provider) { writeJson(res, { ok: false, error: '未找到提供商: ' + providerId }, 404); return }
        const key = resolveKey(provider)
        if (key === '') { writeJson(res, { ok: false, error: '未读到 ' + provider.apiKeyEnv }, 404); return }
        writeJson(res, { ok: true, key })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/prefs' && req.method === 'GET') {
        loadState()
        writeJson(res, { ok: true, prefs: state.prefs })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/prefs' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        state.prefs = { ...state.prefs, ...sanitizePrefs(body && body.prefs ? body.prefs : body) }
        saveState()
        writeJson(res, { ok: true, prefs: state.prefs })
        return
      }

      // ---- 更新检测：npm dist-tags 比对。24h TTL，未过期零网络；失败降级回持久化结果。----
      const UPDATE_TTL_MS = 24 * 60 * 60 * 1000
      let updateBusy = null // 单飞：并发请求共享同一次上游检查
      const fetchLatestVersion = async () => {
        for (const base of ['https://registry.npmmirror.com', 'https://registry.npmjs.org']) {
          try {
            const res = await fetchWithTimeout(base + '/-/package/dsh-tokenrhythm-bill/dist-tags', {})
            if (!res.ok) continue
            const latest = normalizeDistTags(await res.json().catch(() => null))
            if (latest !== null) return latest
          } catch { /* 换下一个 registry */ }
        }
        return null
      }
      const updateResponse = (latest, checkedAt, stale) => {
        const current = PKG_VERSION
        const ignored = state.update.ignoredVersion || ''
        return {
          ok: true,
          current,
          latest,
          updateAvailable: isNewerVersion(current, latest) && latest !== ignored,
          ignoredVersion: ignored,
          installMode: detectInstallMode(),
          checkedAt,
          ...(stale ? { stale: true } : {}),
        }
      }
      const checkUpdate = async (force) => {
        loadState()
        const saved = state.update
        if (!force && saved.latestVersion && Date.now() - (saved.checkedAt || 0) < UPDATE_TTL_MS) {
          return updateResponse(saved.latestVersion, saved.checkedAt || 0, false)
        }
        if (updateBusy !== null) return updateBusy
        updateBusy = (async () => {
          const latest = await fetchLatestVersion()
          if (latest !== null) {
            state.update = { ...sanitizeUpdate(saved), latestVersion: latest, checkedAt: Date.now(), currentAtCheck: PKG_VERSION }
            saveState()
            return updateResponse(latest, state.update.checkedAt, false)
          }
          // 上游全挂：有持久化结果给旧值标 stale，否则静默失败（不阻塞设置页）
          if (saved.latestVersion) return { ...updateResponse(saved.latestVersion, saved.checkedAt || 0, true), error: '检查失败，显示上次结果' }
          return { ok: true, current: PKG_VERSION, latest: null, updateAvailable: false, installMode: detectInstallMode(), checkedAt: 0, error: '检查失败，稍后再试' }
        })()
        try { return await updateBusy } finally { updateBusy = null }
      }
      if (pathname === '/dsh-tokenrhythm-bill/update' && req.method === 'GET') {
        writeJson(res, await checkUpdate(url.searchParams.get('force') === '1'))
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/update/ignore' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        state.update = { ...sanitizeUpdate(state.update), ignoredVersion: asStr(body && body.version) ? asStr(body.version) : '' }
        if (state.update.ignoredVersion === '') delete state.update.ignoredVersion
        saveState()
        const saved = state.update
        writeJson(res, { ok: true, ...updateResponse(saved.latestVersion || null, saved.checkedAt || 0, false) })
        return
      }

      // ================= 阶跃（StepFun）Step Plan =================
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/plan' && req.method === 'GET') {
        writeJson(res, await fetchStepPlan(url.searchParams.get('force') === '1'))
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/balance' && req.method === 'GET') {
        writeJson(res, await fetchStepOfficialBalance())
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/accounts' && req.method === 'GET') {
        loadState()
        writeJson(res, { ok: true, accounts: stepPublicAccounts(), activeAccount: state.step.activeAccount || null })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/login-test' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        const u = asStr(body && body.username).trim() || state.step.activeAccount || ''
        let pw = typeof (body && body.password) === 'string' ? body.password : ''
        if (pw === '') { const acc = pickStepAccount(state.step); if (acc !== null) pw = acc.password }
        if (u === '' || pw === '') { writeJson(res, { ok: false, error: '缺少账号或密码' }, 400); return }
        const gated = stepThrottleGate()
        if (gated !== null) { writeJson(res, gated, 429); return }
        const r = await stepLogin(u, pw, state.step.device)
        stepNoteThrottle(r)
        // 测的就是当前活跃账号 → 顺手续上会话缓存（省一次重登）；他人账号只测不落
        if (r.ok && state.step.activeAccount && state.step.activeAccount.toLowerCase() === u.toLowerCase()) stepApplySession(r, state.step.activeAccount)
        writeJson(res, r.ok ? { ok: true, expiresAt: r.expAt } : { ok: false, error: r.error }, r.ok ? 200 : 401)
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/account/add' && req.method === 'POST') {
        const body = await readBody(req)
        const username = asStr(body && body.username).trim()
        const password = typeof (body && body.password) === 'string' ? body.password : ''
        if (username.length < 3 || username.length > 64 || password === '' || password.length > 256) {
          writeJson(res, { ok: false, error: '账号需 3~64 字符、密码 1~256 字符' }, 400); return
        }
        loadState()
        // 自家退避窗内直接走「待补登录」，不再撞平台
        const gated = stepThrottleGate()
        const r = gated !== null ? gated : await stepLogin(username, password, state.step.device)
        // 密码/账号错这类确定性失败拒收；频控/冷却是暂时态 → 先保存，解除后自动补登录
        if (!r.ok && r.code !== 'STEP_THROTTLED' && r.code !== 'STEP_COOLDOWN') {
          writeJson(res, { ok: false, error: '登录校验未通过，未保存：' + r.error }, 401); return
        }
        if (!r.ok) stepNoteThrottle(r)
        const prev = state.step.accounts.find((a) => a.username.toLowerCase() === username.toLowerCase())
        const rest = state.step.accounts.filter((a) => a.username.toLowerCase() !== username.toLowerCase())
        state.step.accounts = sanitizeStepAccounts([...rest, { username, password, addedAt: prev ? prev.addedAt : Date.now() }])
        state.step.activeAccount = username
        stepPlanCache = null
        if (r.ok) stepApplySession(r, username)
        saveState()
        writeJson(res, r.ok
          ? { ok: true, accounts: stepPublicAccounts(), activeAccount: state.step.activeAccount }
          : { ok: true, pending: true, accounts: stepPublicAccounts(), activeAccount: state.step.activeAccount, error: r.error })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/account/remove' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        const username = asStr(body && body.username).trim()
        // 与 add 同口径：大小写不敏感（add 去重按 toLowerCase，精确匹配会让大小写变体账号删不掉）
        const key = username.toLowerCase()
        state.step.accounts = state.step.accounts.filter((a) => a.username.toLowerCase() !== key)
        if (key !== '' && state.step.activeAccount.toLowerCase() === key) { state.step.activeAccount = ''; stepClearSess(); stepPlanCache = null }
        saveState()
        writeJson(res, { ok: true, accounts: stepPublicAccounts(), activeAccount: state.step.activeAccount || null })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/account/use' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        const username = asStr(body && body.username).trim()
        // 与 add 同口径：大小写不敏感查找（否则大小写变体账号切不到，404）
        const key = username.toLowerCase()
        const hit = state.step.accounts.find((a) => a.username.toLowerCase() === key)
        if (!hit) { writeJson(res, { ok: false, error: '账号不存在' }, 404); return }
        state.step.activeAccount = hit.username
        stepClearSess(); stepPlanCache = null // 切账号即重登重取（与基元缓存隔离同义）
        saveState()
        const s = await stepEnsureSession(true)
        // 切换本身已持久化；登录被限流只影响即时刷新，解除后自动补
        writeJson(res, { ok: s.ok, switched: true, account: hit.username, pending: !s.ok, error: s.ok ? undefined : s.error })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/prefs' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        const patch = isObj(body && body.prefs) ? body.prefs : body
        state.step.prefs = sanitizeStepPrefs({ ...state.step.prefs, ...(isObj(patch) ? patch : {}) })
        saveState()
        writeJson(res, { ok: true, prefs: state.step.prefs })
        return
      }

      writeJson(res, { ok: false, error: 'not found' }, 404)
    } catch (err) {
      try { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500) } catch { /* socket 已断 */ }
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-tokenrhythm-bill', handler: serve }), 'tokenrhythm-bill: routes')
}
