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
 *   /session    paste/clear the tokenrhythm web cookie (stored host-side only)
 *   /prefs      panel geometry persistence
 *
 * Security boundary: API keys and the session cookie live only in host memory
 * and ~/.dsh/tokenrhythm-bill-state.json (mode 0600); every response to the
 * browser carries masked hints only (e.g. "sk_tr…(49)"), never the secret.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
export function normalizeBalance(summaryJson, meJson) {
  const s = unwrapEnvelope(summaryJson) || {}
  const me = isObj(meJson) ? unwrapEnvelope(meJson) : {}
  const account = [me.name, me.nickname, me.username, me.email, me.id]
    .map(asStr).find((v) => v !== '') || ''
  return {
    balanceCny: pickNum(s, ['balanceCny', 'balance', 'availableBalanceCny', 'available_balance_cny']),
    availableBalanceCny: pickNum(s, ['availableBalanceCny', 'available_balance_cny']),
    frozenBalanceCny: pickNum(s, ['frozenBalanceCny', 'frozen_balance_cny']),
    expiringBalanceCny: pickNum(s, ['expiringBalanceCny', 'expiring_balance_cny']),
    nextExpiryAt: asStr(s.nextExpiryAt || s.next_expiry_at) || null,
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

// =====================================================================
// Cordis 插件半区：路由注册（全部包在 effect 里，卸载即回收）
// =====================================================================

export const name = 'dsh-tokenrhythm-bill'
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
  let state = { cookie: '', prefs: {}, accounts: [], activeAccount: '' }

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
        if (typeof data.activeAccount === 'string') state.activeAccount = data.activeAccount
        if (isObj(data.prefs)) state.prefs = data.prefs
        state.accounts = sanitizeAccounts(data.accounts)
      }
    } catch { /* 不可读 → 空状态 */ }
    return state
  }
  const saveState = () => {
    const file = statePath()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ cookie: state.cookie, prefs: state.prefs, accounts: state.accounts, activeAccount: state.activeAccount, savedAt: Date.now() }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
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

  // ---- /model-check：真实 1-token 推理连通测试（手动单测；60s 缓存 + 单飞防重复扣费）----
  const MODEL_CHECK_TTL_MS = 60 * 1000
  const MODEL_CHECK_TIMEOUT_MS = 20 * 1000 // 模型冷启动可能较慢，独立于 UPSTREAM_TIMEOUT_MS
  const modelCheckCache = new Map() // model -> { result, ts }
  const modelCheckInflight = new Map() // model -> Promise<result>
  const runModelCheck = async (key, model) => {
    const url = TOKENRHYTHM_BASE.replace(/\/+$/, '') + '/v1/chat/completions'
    const init = {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
    }
    const startedAt = Date.now()
    let res
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), MODEL_CHECK_TIMEOUT_MS)
      try { res = await fetch(url, { ...init, signal: ac.signal }) } finally { clearTimeout(timer) }
    } catch (err) {
      return { ok: false, model, error: err && err.name === 'AbortError' ? '请求超时（20s）' : String((err && err.message) || err) }
    }
    const latencyMs = Date.now() - startedAt
    const bodyText = await res.text().catch(() => '')
    let json = null
    try { json = JSON.parse(bodyText) } catch { /* 非 JSON → 按状态码报错 */ }
    if (!res.ok) {
      const detail = isObj(json) && json.error ? String(json.error.message || json.error) : bodyText.slice(0, 200)
      return { ok: false, model, status: res.status, error: '网关 ' + res.status + (detail ? '：' + detail : '') }
    }
    return { ok: true, model, latencyMs }
  }
  const modelCheck = async (model) => {
    const id = typeof model === 'string' ? model.trim() : ''
    if (id === '') return { ok: false, error: '缺少 model 参数' }
    const hit = modelCheckCache.get(id)
    if (hit && Date.now() - hit.ts < MODEL_CHECK_TTL_MS) return hit.result
    const inflight = modelCheckInflight.get(id)
    if (inflight) return inflight
    const { providers } = readProviders()
    const tProvider = providers.find((p) => p.balanceCapable)
    const key = tProvider ? resolveKey(tProvider) : ''
    if (key === '') return { ok: false, model: id, error: '未配置基元律动 API Key（settings.yaml 或凭据文件）' }
    const p = runModelCheck(key, id).finally(() => modelCheckInflight.delete(id))
    modelCheckInflight.set(id, p)
    const result = await p
    modelCheckCache.set(id, { result, ts: Date.now() })
    return result
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

  // ---- 平台请求统一头：实测网关对无 UA 的请求偶发 504，带上浏览器式头更稳 ----
  const trHeaders = (cookie) => ({
    Cookie: 'tr_session=' + cookie,
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Referer: TOKENRHYTHM_BASE + '/account',
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
    try {
      const cookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/)
      for (const line of cookies) {
        const m = /tr_session=([^;\s]+)/.exec(line)
        if (m !== null) { cookie = m[1]; break }
      }
    } catch { /* 取不到 Set-Cookie → 按失败处理 */ }
    if (cookie === '') return { ok: false, error: '登录成功但未返回会话，请改用粘贴方式' }
    return { ok: true, cookie }
  }

  const fetchUpstreamBalance = async (cookie) => {
    const headers = trHeaders(cookie)
    const [summaryRes, meRes] = await Promise.all([
      fetchWithTimeout(TOKENRHYTHM_BASE + '/api/usage-summary', { headers }),
      fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me', { headers }).catch(() => null),
    ])
    if (summaryRes.status === 401 || (meRes !== null && meRes.status === 401)) {
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
    return { ...normalizeBalance(summary, me), daily, trend, recent }
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
          session: { configured: state.cookie !== '', hint: maskSecret(state.cookie), account: state.activeAccount || null },
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

      if (pathname === '/dsh-tokenrhythm-bill/session' && req.method === 'GET') {
        loadState()
        writeJson(res, { ok: true, configured: state.cookie !== '', hint: maskSecret(state.cookie) })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/session' && req.method === 'POST') {
        const body = await readBody(req)
        const raw = body && typeof body.value === 'string' ? body.value : ''
        const cookie = extractSessionCookie(raw)
        loadState()
        state.cookie = cookie
        if (cookie === '') state.activeAccount = ''
        saveState()
        writeJson(res, { ok: true, configured: cookie !== '', hint: maskSecret(cookie), account: state.activeAccount || null })
        return
      }

      // 账号密码登录：host 直接调平台登录接口，成功后从 Set-Cookie 提取
      // tr_session 存入 state（0600）。密码只在本次请求内存中出现，绝不落盘/入日志。
      if (pathname === '/dsh-tokenrhythm-bill/auth/login' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account.trim() : ''
        const password = body && typeof body.password === 'string' ? body.password : ''
        if (account === '' || password === '') { writeJson(res, { ok: false, error: '请填写账号和密码' }, 400); return }
        const r = await loginOnPlatform(account, password)
        if (!r.ok) { writeJson(res, { ok: false, error: r.error }); return }
        loadState()
        state.cookie = r.cookie
        state.activeAccount = account
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
        if (r.ok) { state.cookie = r.cookie; state.activeAccount = account; saveState() }
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
          const up = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/api-keys', { headers: trHeaders(state.cookie) })
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
      // 模型连通检测：真实 1-token 推理（手动单测，host 侧 60s 缓存 + 单飞）。
      if (pathname === '/dsh-tokenrhythm-bill/model-check' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          const result = await modelCheck(body && typeof body.model === 'string' ? body.model : '')
          writeJson(res, { ok: true, result })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/keys/create' && req.method === 'POST') {
        const body = await readBody(req)
        const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 64) : ''
        if (name === '') { writeJson(res, { ok: false, error: '请填写密钥名称' }, 400); return }
        loadState()
        if (state.cookie === '') { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未登录' }); return }
        try {
          const up = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/api-keys', {
            method: 'POST',
            headers: { ...trHeaders(state.cookie), 'content-type': 'application/json' },
            body: JSON.stringify({ name }),
          })
          if (up.status === 401) { writeJson(res, { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期' }); return }
          if (!up.ok) {
            let detail = ''
            try { const j = await up.json(); if (isObj(j) && typeof j.message === 'string') detail = j.message } catch { /* 非 JSON 错误体 */ }
            writeJson(res, { ok: false, error: '创建失败（平台 ' + up.status + '）' + (detail ? '：' + detail : '') }, 502)
            return
          }
          const j = await up.json().catch(() => null)
          const data = unwrapEnvelope(j)
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

      writeJson(res, { ok: false, error: 'not found' }, 404)
    } catch (err) {
      try { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500) } catch { /* socket 已断 */ }
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-tokenrhythm-bill', handler: serve }), 'tokenrhythm-bill: routes')
}
