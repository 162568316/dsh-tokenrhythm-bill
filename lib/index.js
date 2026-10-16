/**
 * dsh-tokenrhythm-bill host half: a plain Cordis plugin running in the host
 * process. It reads the provider roster from ~/.dsh/settings.yaml
 * (llm-pi-ai.providers, flow and block layouts alike) — or, on DSH 0.1.7+
 * where that document was retired, from the active profile's patch layer
 * (profiles/<name>/cordis.patch.yml, same section under `- id: llm-pi-ai`) —
 * plus API keys from ~/.dsh/.credentials.yaml / environment variables, then
 * answers the browser half's JSON calls over the webServer:
 *
 *   /manifest   provider roster + session status (masked)
 *   /models     proxied GET {baseURL}/v1/models (60s cache, 1 retry on 5xx gw)
 *   /balance    proxied tokenrhythm usage-summary + me (web session cookie)
 *   /model-check POST probe-now for ticked chat models (DSH key, 1-token, TTL cache)
 *   /session    paste/clear the tokenrhythm web cookie (stored host-side only)
 *   /prefs      panel geometry persistence
 *   /stepfun/*  阶跃 Step Plan: account pool + plan/balance/profile RPCs
 *   /tierflow/* 清枢智汇 (TierFlow): account pool + 账户/套餐用量 (session cookie)
 *
 * Security boundary: API keys and the session cookie live only in host memory
 * and ~/.dsh/tokenrhythm-bill-state.json (mode 0600); every response to the
 * browser carries masked hints only (e.g. "sk_tr…(49)"), never the secret.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync, readdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as stepLib from './step.js'
import * as tfLib from './tierflow.js'
import * as ocLib from './opencsg.js'
import * as zc from './zcode.js'
import { fileURLToPath } from 'node:url'
import * as os from 'node:os'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

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

// ---- 「用量」页签（0.5.5）----
// 日历固定展示最近 30 天：usage/panel 的 range 只认 7d/30d，30d 是与「月度用量」
// 最贴合的窗口，且汇总/按模型/按客户端都能一次拿到。
const USAGE_DAYS = 30
const USAGE_RANGE = '30d'
// 单页条数：usage/panel 的 pageSize 上限是 100。
const USAGE_DAY_PAGE_SIZE = 100
// 每日模型明细行数上限（tooltip 里要能放下，尾部散着的小模型不进浮层）。
const MODEL_ROWS_PER_DAY = 6
// panel 的 topCostCalls 条数上限：平台本身只给 3 条，多要也拿不到。0.5.5 起界面
// 不再展示单笔花费（30 天日历 + 拆分已能回答「钱花在哪」），这个常量保留是为了
// normalizeUsagePanel 忠实还原平台响应，删了它就要动到已测试的解析契约。
const TOP_COST_CALLS = 3
// 用量数据缓存 TTL：与模型列表同口径 60s。日历要打 30 个按天请求，不能跟着
// 面板 60s 自动刷新空转——由页签打开/手动刷新触发，缓存命中才零请求。
const USAGE_TTL_MS = 60 * 1000

// =====================================================================
// 纯函数（导出供 node:test 单测）：YAML 解析 / 归一化 / 掩码
// =====================================================================

// 去掉 YAML 注释：逐字符扫描，字符串（'…" / "…"）内的 # 不算注释；
// # 只有出现在行首或前一个字符是空白时才开启注释。
/**
 * 会话身份键：从 JWT 取 oasis_id|organization_id；解不出返回 null。
 * 续期（RefreshToken）后必须核对它——平台对「签名非法的 token」只会铸出设备匿名令牌
 * （身份不同、RPC 401），不核对就会把 A 的设备令牌当成 B 的会话存下来（串号）。
 */
export function stepSessionIdentity(token) {
  const claims = stepLib.jwtClaims(token)
  if (claims === null || claims.oasis_id === undefined) return null
  return String(claims.oasis_id) + '|' + String(claims.organization_id)
}

/** 临期判定：expAt 距现在不足 margin 秒。解不出 expAt → false（一路用到平台说不过为止） */
export function stepSessionNearExpiry(expAt, margin, now) {
  if (typeof expAt !== 'number' || !Number.isFinite(expAt) || expAt <= 0) return false
  return expAt - now < margin
}

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
 * 解析 profile 补丁层（profiles/<name>/cordis.patch.yml）里 llm-pi-ai 条目的 providers 段。
 *
 * 为什么需要它：DSH 0.1.7 起 settings.yaml 被废除——设置服务把 ~/.dsh/settings.yaml
 * 改名成 settings.yaml.imported，各段写进「当前 profile 的补丁层」，此后补丁层才是活存储，
 * 原文件不再重建（重建会造成第二次导入，把 Setup 默认值盖回用户的选择上）。
 * 于是 provider 名册的活来源从 settings.yaml 变成了补丁层；只认旧路径的插件会
 * 把自己配置好的 provider 全数看丢，面板显示「没有基元律动提供商」。
 *
 * 布局差异：settings.yaml 是 `llm-pi-ai:\n  providers:\n    …`；补丁层是顶层 YAML 数组，
 * providers 藏在 `- id: llm-pi-ai` 条目的 `config:` 底下。段内布局（flow / block）
 * 与原来一致，所以把 providers: 块原样重排成一份最小文档、复用 parseSettingsProviders，
 * 不另写一套 YAML 解析。
 *
 * 只认 block 写法的 `- id: llm-pi-ai` 条目首行（设置服务就是这么写的）；flow 写法的
 * 条目行不认，返回 []。找不到条目或没有 providers 段 → []，绝不抛错。
 */
export function parsePatchProviders(text) {
  const clean = stripYamlComments(String(text == null ? '' : text).replace(/\t/g, '  '))
  const lines = toLines(clean)
  for (let i = 0; i < lines.length; i++) {
    // 认 id 不认 name：id 是设置服务写进去的稳定键，name 是包名（历史上有过改名）。
    const m = /^-\s*id:\s*["']?([A-Za-z0-9_@/.-]+)["']?\s*$/.exec(lines[i].text)
    if (m === null || m[1] !== 'llm-pi-ai') continue
    // 条目范围：到下一个同级 `- ` 为止（补丁层顶层是数组，条目之间互为兄弟）。
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      if (/^-\s/.test(lines[j].text) && lines[j].indent <= lines[i].indent) { end = j; break }
    }
    for (let j = i; j < end; j++) {
      const lm = /^providers\s*:(.*)$/.exec(lines[j].text)
      if (lm === null) continue
      const rest = lm[1].trim()
      // flow：providers: { … } 与键同一行
      if (rest.startsWith('{')) return parseSettingsProviders('providers: ' + rest)
      // block：providers: 换行 + 更深缩进。按各自绝对缩进原样重排——
      // parseSettingsProviders 只比相对缩进，基线无所谓。
      if (j + 1 < end && lines[j + 1].indent > lines[j].indent) {
        const body = lines.slice(j + 1, end).map((l) => ' '.repeat(l.indent) + l.text).join('\n')
        return parseSettingsProviders('providers:\n' + body)
      }
      return []
    }
    return []
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

/**
 * 归一化峰谷分时计价表：/api/model-price-schedules（公开接口，无需会话）。
 * 平台给每个参与分时的模型一份 peak/valley 配置，谷时段打折、峰时段原价。
 * 信封 {data:{items:[…],asOf}}；返回 { modelId → schedule, asOf } 便于按模型 ID 索引。
 *
 * 实测样本（deepseek-flash）：
 *   peak  { startTime:'08:00', endTime:'22:00', listPrice:{inputPrice:'2',outputPrice:'8',cacheReadPrice:'0.04'}, discountPrice:null }
 *   valley{ startTime:'22:00', endTime:'08:00', listPrice:{inputPrice:'1',outputPrice:'4',cacheReadPrice:'0.02'}, discountPrice:null }
 *   expectedPeriod:'PEAK' | 'VALLEY'（平台当前所处时段）、nextSwitchAt:ISO（下次切换）
 *
 * 缺失/脏数据一律不生成条目（该模型就不显示峰谷徽章），绝不抛错打断模型列表。
 */
export function normalizePriceSchedules(json) {
  const data = isObj(json) ? unwrapEnvelope(json) : {}
  const items = Array.isArray(data.items) ? data.items : []
  const out = {}
  for (const raw of items) {
    if (!isObj(raw)) continue
    const modelId = asStr(raw.modelId)
    if (modelId === '') continue
    // 时段价格：listPrice 必有，discountPrice 可选（谷时段常配折扣价）。
    const period = (p) => {
      if (!isObj(p)) return null
      const lp = isObj(p.listPrice) ? p.listPrice : {}
      const dp = isObj(p.discountPrice) ? p.discountPrice : null
      return {
        startTime: asStr(p.startTime),
        endTime: asStr(p.endTime),
        listPrice: {
          inputPrice: toNum(lp.inputPrice),
          outputPrice: toNum(lp.outputPrice),
          cacheReadPrice: toNum(lp.cacheReadPrice),
        },
        discountPrice: dp ? {
          inputPrice: toNum(dp.inputPrice),
          outputPrice: toNum(dp.outputPrice),
          cacheReadPrice: toNum(dp.cacheReadPrice),
        } : null,
      }
    }
    const peak = period(raw.peak)
    const valley = period(raw.valley)
    // 峰谷都没解析出价格 → 视为无效条目，跳过。
    if ((!peak || peak.listPrice.inputPrice === null) && (!valley || valley.listPrice.inputPrice === null)) continue
    const expectedPeriod = asStr(raw.expectedPeriod).toUpperCase()
    out[modelId] = {
      modelId,
      currency: asStr(raw.currency) || 'CNY',
      billingUnit: toNum(raw.billingUnit) ?? 1000000,
      timezone: asStr(raw.timezone) || 'Asia/Shanghai',
      peak,
      valley,
      expectedPeriod: expectedPeriod === 'PEAK' || expectedPeriod === 'VALLEY' ? expectedPeriod : '',
      nextSwitchAt: asStr(raw.nextSwitchAt),
    }
  }
  return { schedules: out, asOf: asStr(data.asOf) }
}

/**
 * 解析 /api/usage/panel（range=30d）为「用量」页签所需的稳定形状。
 *
 * 平台实测口径（2026-09-22，账号 18238683825）：
 *   - {data:{summary, byModel[], byClientApp[], topTokenCalls[], topCostCalls[],
 *            items[], total, page, pageSize, nextCursor}}
 *   - range 只接受 7d / 30d；24h/90d/1d/all → 400；groupBy/dimension/startAt/endAt
 *     等参数一律被忽略（响应与不带时逐字节相同）→ **没有按天聚合，日历不能靠它**。
 *   - pageSize 上限 100（200 起 400）；翻页到第 3 页起必然 503 限流。
 *   - summary.calls=2307 含失败，而 byModel/byClientApp/items 合计 = total=2295 =
 *     successCalls —— 分组只含成功调用，差值就是失败+中止。
 *   - usageTokenSemantics='inclusive_cache'：totalTokens = input + output，
 *     cacheReadTokens 是 inputTokens 的**子集**（不是叠加项）。
 *   - costCny/actualCostUsd 汇率恒为 6.8；inputCostCny 等逐项拆分全为 null 且
 *     costBreakdownComplete=false —— 逐项成本平台没实现，只能信汇总 costCny。
 *   - costCny 字符串（'67.75571396'），转 number；脏值按 null。
 *
 * 返回 { summary, byModel, byClientApp, topCostCalls, meta }，任何一层畸形都降级
 * 为空数组/零值，绝不抛错打断页签。
 */
export function normalizeUsagePanel(json) {
  const data = isObj(json) ? unwrapEnvelope(json) : {}
  const money = (v) => {
    const n = toNum(v)
    return n === null || !Number.isFinite(n) ? 0 : n
  }
  const metricBlock = (raw) => {
    const s = isObj(raw) ? raw : {}
    return {
      calls: toNum(s.calls) ?? 0,
      successCalls: toNum(s.successCalls) ?? 0,
      errorCalls: toNum(s.errorCalls) ?? 0,
      abortedCalls: toNum(s.abortedCalls) ?? 0,
      inputTokens: toNum(s.inputTokens) ?? 0,
      outputTokens: toNum(s.outputTokens) ?? 0,
      totalTokens: toNum(s.totalTokens) ?? 0,
      cacheReadTokens: toNum(s.cacheReadTokens) ?? 0,
      cacheCreationTokens: toNum(s.cacheCreationTokens) ?? null,
      reasoningTokens: toNum(s.reasoningTokens) ?? null,
      costCny: money(s.costCny),
      actualCostUsd: money(s.actualCostUsd),
      tokenSavingCny: money(s.tokenSavingCny),
      fusionEquivalentOpusCny: money(s.fusionEquivalentOpusCny),
      cacheReadComplete: s.cacheReadComplete === true,
      cacheWriteComplete: s.cacheWriteComplete === true,
      costBreakdownComplete: s.costBreakdownComplete === true,
      cacheReadMissingCalls: toNum(s.cacheReadMissingCalls) ?? 0,
      cacheWriteMissingCalls: toNum(s.cacheWriteMissingCalls) ?? 0,
      tokenRequestCount: toNum(s.tokenRequestCount) ?? 0,
      imageRequestCount: toNum(s.imageRequestCount) ?? 0,
    }
  }
  const groupRow = (raw, keyField) => {
    const g = isObj(raw) ? raw : {}
    const b = metricBlock(g)
    // 分组行的身份字段比汇总多一个（modelId/model 或 clientApp）
    return { ...b, [keyField]: asStr(g[keyField]), model: asStr(g.model) }
  }
  const callRow = (raw) => {
    const c = isObj(raw) ? raw : {}
    return {
      id: asStr(c.id),
      traceId: asStr(c.traceId),
      requestAt: asStr(c.requestAt),
      time: asStr(c.time),
      modelId: asStr(c.modelId),
      model: asStr(c.model) || asStr(c.modelId) || '未知模型',
      clientApp: asStr(c.clientApp),
      agent: asStr(c.agent),
      conversationSummary: asStr(c.conversationSummary),
      requestPreview: asStr(c.requestPreview),
      inputTokens: toNum(c.inputTokens) ?? 0,
      outputTokens: toNum(c.outputTokens) ?? 0,
      totalTokens: toNum(c.totalTokens) ?? 0,
      cacheReadTokens: toNum(c.cacheReadTokens) ?? 0,
      reasoningTokens: toNum(c.reasoningTokens) ?? null,
      costCny: money(c.costCny),
      usageTokenSemantics: asStr(c.usageTokenSemantics),
    }
  }
  const groups = (rawList, keyField) => (Array.isArray(rawList) ? rawList : [])
    .filter((r) => isObj(r) && asStr(r[keyField]) !== '')
    .map((r) => groupRow(r, keyField))
  return {
    summary: metricBlock(data.summary),
    byModel: groups(data.byModel, 'modelId'),
    byClientApp: groups(data.byClientApp, 'clientApp'),
    topCostCalls: (Array.isArray(data.topCostCalls) ? data.topCostCalls : [])
      .filter((r) => isObj(r))
      .map(callRow)
      .slice(0, TOP_COST_CALLS),
    meta: {
      // total 是平台侧的记录总数（= 成功调用数），items 只是其中一页
      total: toNum(data.total) ?? 0,
      page: toNum(data.page) ?? 0,
      pageSize: toNum(data.pageSize) ?? 0,
      referenceModel: asStr(data.summary && data.summary.referenceModel),
      savingClientApp: asStr(data.summary && data.summary.savingClientApp),
    },
  }
}

/**
 * 把 /api/usage-daily 的原始行（date × modelId × apiKeyId × clientApp）分桶成
 * 「日历直接可用」的按天数组。
 *
 * 这个接口是关键突破（0.5.5 定案前一直在用按天窗口一个一个请求它，其实没必要）：
 *   · data 是**扁平行数组**，每行一个 日期+模型+Key+客户端 组合；
 *   · range/startDate/endAt/page/pageSize **全部被忽略**（实测怎么传都返回同样
 *     的 122 行 / 95440B），所以它固定吐一整份近 8 周的按天明细；
 *   · 关键是**它本来就是按天的**：把 date 相同的行累加，就是当天的调用数/花费/
 *     模型明细——日历每格要的东西全在里面，一个请求拿完，无需按天逐日打。
 *
 * 口径核对（2026-09-22，账号 18258683825）：分桶出的最近 30 自然日合计
 * ¥242.49619028、10094 次，与 /api/usage/panel?range=30d 的 summary
 * costCny/calls **逐位相同**——两个接口互相印证，聚合口径可信。
 *
 * days 固定铺满「今天往前 USAGE_DAYS 天」（含今天、升序），当天没有行的填 0 并把
 * hasData=false：客户端要能区分「真的没调用」和「这一天不在数据覆盖范围内」。
 * 后者只有 dump 历史不够长时才会出现，用 meta.earliestDate 让界面如实说明。
 *
 * @param json  usage-daily 原始响应
 * @param today 本机「今天」的 Date（只在测试里注入，运行期传 new Date()）
 */
export function normalizeUsageDaily(json, today) {
  const rows = Array.isArray(json && json.data) ? json.data : []
  const money = (v) => { const n = toNum(v); return n === null || !Number.isFinite(n) ? 0 : n }
  const nz = (v) => { const n = toNum(v); return n === null || !Number.isFinite(n) || n < 0 ? 0 : n }

  const buckets = new Map()
  const earliest = { date: '', latest: '' }
  for (const raw of rows) {
    if (!isObj(raw)) continue
    const date = asStr(raw.date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (earliest.date === '' || date < earliest.date) earliest.date = date
    if (date > earliest.latest) earliest.latest = date

    let b = buckets.get(date)
    if (b === undefined) {
      b = {
        date, rows: 0,
        calls: 0, successCalls: 0, errorCalls: 0,
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
        costCny: 0, tokenSavingUsd: 0, fusionEquivalentOpusUsd: 0,
        models: new Map(), apps: new Map(),
      }
      buckets.set(date, b)
    }
    b.rows++
    b.calls += nz(raw.calls)
    b.successCalls += nz(raw.successCalls)
    b.errorCalls += nz(raw.errorCalls)
    b.inputTokens += nz(raw.inputTokens)
    b.outputTokens += nz(raw.outputTokens)
    b.cacheReadTokens += nz(raw.cacheReadTokens)
    b.reasoningTokens += nz(raw.reasoningTokens)
    // tokenSavingUsd / fusionEquivalentOpusUsd 只有 opensquilla 有值，其余行没有，
    // 累加时按 0 走（不能记 null，否则客户端要判两种空）。
    b.tokenSavingUsd += money(raw.tokenSavingUsd)
    b.fusionEquivalentOpusUsd += money(raw.fusionEquivalentOpusUsd)

    const modelName = asStr(raw.model) || asStr(raw.modelId) || '未知模型'
    const modelId = asStr(raw.modelId) || modelName
    const mKey = modelId + '\u0000' + modelName
    const cost = money(raw.costCny)
    let m = b.models.get(mKey)
    if (m === undefined) {
      m = { modelId, model: modelName, calls: 0, costCny: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, rows: 0 }
      b.models.set(mKey, m)
    }
    m.calls += nz(raw.calls)
    m.costCny += cost
    m.inputTokens += nz(raw.inputTokens)
    m.outputTokens += nz(raw.outputTokens)
    m.cacheReadTokens += nz(raw.cacheReadTokens)
    m.rows++

    // 当天合计也要累：早先只加了模型桶和客户端桶，忘了这一天自己的总额，
    // 结果 calendar.costCny 恒为 0（单测把这个洞照出来了）。
    b.costCny += cost

    const appName = asStr(raw.clientApp) || 'unknown'
    let a = b.apps.get(appName)
    if (a === undefined) {
      a = { clientApp: appName, calls: 0, costCny: 0 }
      b.apps.set(appName, a)
    }
    a.calls += nz(raw.calls)
    a.costCny += cost
  }

  // 金额精度对齐平台：costCny/actualCostUsd 实测都是 8 位小数字符串
  // （'7.78293208'）。按 6 位舍入会在多行/多天累加时悄悄丢钱，
  // 与 usage/panel 的 summary 逐位对照就对不上了，故统一保留 8 位。
  const r8 = (v) => Math.round(v * 1e8) / 1e8
  const finalize = (b) => {
    const models = [...b.models.values()]
      .map((m) => ({
        modelId: m.modelId, model: m.model,
        calls: m.calls,
        costCny: r8(m.costCny),
        inputTokens: m.inputTokens, outputTokens: m.outputTokens,
        cacheReadTokens: m.cacheReadTokens, rows: m.rows,
      }))
      .sort((x, y) => y.costCny - x.costCny || y.calls - x.calls)
    return {
      date: b.date,
      hasData: true,
      rows: b.rows,
      calls: b.calls,
      successCalls: b.successCalls,
      errorCalls: b.errorCalls,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      totalTokens: b.inputTokens + b.outputTokens,
      cacheReadTokens: b.cacheReadTokens,
      reasoningTokens: b.reasoningTokens,
      costCny: r8(b.costCny),
      tokenSavingUsd: r8(b.tokenSavingUsd),
      fusionEquivalentOpusUsd: r8(b.fusionEquivalentOpusUsd),
      models: models.slice(0, MODEL_ROWS_PER_DAY),
      modelCount: models.length,
      apps: [...b.apps.values()]
        .map((a) => ({ clientApp: a.clientApp, calls: a.calls, costCny: r8(a.costCny) }))
        .sort((x, y) => y.costCny - x.costCny || y.calls - x.calls),
    }
  }
  const empty = (date) => ({
    date,
    hasData: false,
    rows: 0,
    calls: 0, successCalls: 0, errorCalls: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cacheReadTokens: 0, reasoningTokens: 0,
    costCny: 0, tokenSavingUsd: 0, fusionEquivalentOpusUsd: 0,
    models: [], modelCount: 0, apps: [],
  })

  const keyOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0')
  const anchor = today instanceof Date && !Number.isNaN(today.getTime()) ? today : new Date()
  const days = []
  let withData = 0
  for (let i = USAGE_DAYS - 1; i >= 0; i--) {
    const d = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
    d.setDate(d.getDate() - i)
    const key = keyOf(d)
    const b = buckets.get(key)
    if (b === undefined) days.push(empty(key))
    else { days.push(finalize(b)); withData++ }
  }
  return {
    days,
    meta: {
      rowCount: rows.filter((r) => isObj(r)).length,
      daysTotal: USAGE_DAYS,
      daysWithData: withData,
      // dump 覆盖到的最早一天：比它还早的日期属于「无数据」而非「无调用」。
      earliestDate: earliest.date,
      latestDate: earliest.latest,
    },
  }
}
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

/**
 * 从 /api/me/identity-verification 响应提取实名认证状态（0.6.2 新增，平台实测）：
 *   status: 'unverified'|'verified'|'reviewing'|'rejected'（平台前端分包证实的状态机）
 *   nextAction / rejectionReasonCode: rejected 时的原因与下一步
 *   migration.apiAccess: 'allowed'|'blocked'——blocked 时平台对 API 调用抛 403
 *     IDENTITY_VERIFICATION_REQUIRED（实名门禁），徽章必须警示
 *   migration.required / deadlineAt / remainingDays: 实名迁移宽限期
 * 只留徽章需要的字段；信封 code!==0 / 缺 data / 空 status 一律 null——宁可缺不编。
 * 也容忍直接传内层 data（调用方/单测省一层信封）。
 */
export function realnameFromIdentity(json) {
  if (!isObj(json)) return null
  if (json.code !== undefined && json.code !== 0) return null
  const data = isObj(json.data) ? json.data : json
  if (data === null) return null
  const status = asStr(data.status)
  if (status === '') return null
  const mig = isObj(data.migration) ? data.migration : {}
  const dlRaw = asStr(mig.deadlineAt)
  const dl = dlRaw !== '' && !Number.isNaN(new Date(dlRaw).getTime()) ? dlRaw : null
  const remaining = Number(mig.remainingDays)
  return {
    status,
    nextAction: asStr(data.nextAction) || null,
    rejectionReason: asStr(data.rejectionReasonCode) || null,
    apiAccess: asStr(mig.apiAccess) || null,
    required: mig.required === true,
    deadlineAt: dl,
    remainingDays: Number.isFinite(remaining) ? remaining : null,
  }
}

// ---- 模型批量连通检测（/model-check）：真实 1-token 请求，走用户自己的 key。
// 选哪些模型、多久一次全由客户端决定（面板打开期间）；host 只执行「这一轮」，
// 60s TTL 内存缓存防重复计费；并发与抖动参数沿用状态站防风控经验值。----
export const CHECK_MAX_MODELS = 30
export const CHECK_TTL_MS = 60 * 1000
const CHECK_TIMEOUT_MS = 30 * 1000
const CHECK_CONCURRENCY = 3
const CHECK_JITTER_MS = 15 * 1000

/**
 * 单模型连通探测分类（口径与状态站一致）：
 * 200→up；429→degraded（上游限流不算模型故障）；http=0→down（网络/超时）；
 * 401/403→auth_error；404→model_not_found；≥500→server_error；其余 4xx→client_error。
 */
export function classifyProbe(http, detail) {
  const d = String(detail || '')
  if (http === 200) return { status: 'up', error: null, errorKind: null }
  if (http === 429) return { status: 'degraded', error: d.slice(0, 120) || 'HTTP 429', errorKind: 'rate_limited' }
  if (http === 0) return {
    status: 'down',
    error: d.slice(0, 120) || '网络错误',
    errorKind: /time|abort|aborterror/i.test(d) ? 'timeout' : 'network_error',
  }
  if (http === 401 || http === 403) return { status: 'down', error: '认证失败（API Key 无效或无权限）HTTP ' + http, errorKind: 'auth_error' }
  if (http === 404) return { status: 'down', error: d.slice(0, 120) || '模型不存在 HTTP 404', errorKind: 'model_not_found' }
  if (http >= 500) return { status: 'down', error: 'HTTP ' + http, errorKind: 'server_error' }
  return { status: 'down', error: ('HTTP ' + http + (d ? ' ' + d.slice(0, 60) : '')).slice(0, 120), errorKind: 'client_error' }
}

/**
 * 构建一轮批量检测的执行计划：字符串化 + trim、去重、≤CHECK_MAX_MODELS，
 * TTL（默认 60s）内已有结果的模型跳过（force 时全探）。
 * cache 接受 Map 或 {model: {ts,…}} 对象。返回 { toProbe, cachedResults }。
 */
export function buildCheckPlan(models, cache, force, now, ttl) {
  const ttlMs = Number(ttl) > 0 ? Number(ttl) : CHECK_TTL_MS
  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
  const hit = (id) => {
    if (cache == null) return null
    try {
      if (typeof cache.get === 'function') return cache.get(id) || null
      return isObj(cache) ? (cache[id] || null) : null
    } catch { return null }
  }
  const seen = {}
  const toProbe = []
  const cachedResults = {}
  const list = Array.isArray(models) ? models : []
  for (const raw of list) {
    if (typeof raw !== 'string') continue // 只接受字符串模型 ID（数字/对象等一律无效）
    const id = asStr(raw)
    if (id === '' || seen[id]) continue
    seen[id] = true
    if (toProbe.length >= CHECK_MAX_MODELS) break
    const h = hit(id)
    if (!force && h && typeof h === 'object' && typeof h.ts === 'number' && nowMs - h.ts < ttlMs) {
      cachedResults[id] = {
        status: h.status, ms: h.ms, error: h.error || null, errorKind: h.errorKind || null,
        checkedAt: h.checkedAt, cached: true,
      }
      continue
    }
    toProbe.push(id)
  }
  return { toProbe, cachedResults }
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

/**
 * 解析 /api/wallet/expiring-credits 为「资金明细」区块所需的稳定形状。
 *
 * 平台实测（2026-09-22，账号 18238683825）：
 *   - {data:{asOf, summary:{expiringBalanceCny, nextExpiryAt,
 *            cumulativeGiftGrantedCny},
 *            rechargePrincipal:{source, sourceLabel, grantedCny, consumedCny,
 *            remainingCny, status, expiresAt},
 *            list:[...], total, page, pageSize}}
 *   - list 每项：id / source / sourceLabel / grantedCny / consumedCny /
 *     remainingCny / status / grantedAt / expiresAt。
 *   - status 实测有 ACTIVE / USED_UP（充本金 USED_UP 且 remaining=0 时仍占一行，
 *     因为 grantedCny 是历史事实，不能因为用完就让它从明细里消失）。
 *   - 金额都是字符串（'18.45596260'），按 8 位小数的数处理。
 *   - 这个接口已被 fetchExpiringCredits 用于「入口悬停限时余额时间线」，但那条链路
 *     只取 remaining>0 且有过期时间的项；这里要的是**完整资金台账**（含用完的），
 *     所以另写一个 normalizer，不复用 normalizeExpiringCredits 的过滤口径。
 *
 * 返回 { summary, principal, items, total }；任何一层畸形都降级为空，绝不抛错。
 */
export function normalizeWalletCredits(json) {
  const data = isObj(json) ? unwrapEnvelope(json) : {}
  const num = (v) => {
    const n = toNum(v)
    return n === null || !Number.isFinite(n) ? 0 : n
  }
  const dateStr = (v) => {
    const s = asStr(v)
    if (s === '') return null
    const ms = Date.parse(s)
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null
  }
  const row = (raw) => {
    if (!isObj(raw)) return null
    const label = asStr(raw.sourceLabel || raw.source_label || raw.source)
    return {
      id: asStr(raw.id),
      source: asStr(raw.source),
      sourceLabel: label,
      grantedCny: num(raw.grantedCny ?? raw.granted_cny),
      consumedCny: num(raw.consumedCny ?? raw.consumed_cny),
      remainingCny: num(raw.remainingCny ?? raw.remaining_cny),
      status: asStr(raw.status),
      grantedAt: dateStr(raw.grantedAt ?? raw.granted_at),
      expiresAt: dateStr(raw.expiresAt ?? raw.expires_at),
    }
  }
  const rawSummary = isObj(data.summary) ? data.summary : {}
  const principal = row(isObj(data.rechargePrincipal) ? data.rechargePrincipal : null)
  const items = (Array.isArray(data.list) ? data.list : [])
    .map(row)
    .filter((it) => it !== null)
    // 到期近的排前面：临期额度最该被看见。
    .sort((a, b) => {
      const ta = a.expiresAt === null ? Infinity : Date.parse(a.expiresAt)
      const tb = b.expiresAt === null ? Infinity : Date.parse(b.expiresAt)
      if (ta !== tb) return ta - tb
      return b.grantedCny - a.grantedCny
    })
  return {
    asOf: dateStr(data.asOf),
    summary: {
      expiringBalanceCny: num(rawSummary.expiringBalanceCny ?? rawSummary.expiring_balance_cny),
      cumulativeGiftGrantedCny: num(rawSummary.cumulativeGiftGrantedCny ?? rawSummary.cumulative_gift_granted_cny),
      nextExpiryAt: dateStr(rawSummary.nextExpiryAt ?? rawSummary.next_expiry_at),
    },
    principal: principal === null ? null : {
      sourceLabel: principal.sourceLabel || '充值本金',
      grantedCny: principal.grantedCny,
      consumedCny: principal.consumedCny,
      remainingCny: principal.remainingCny,
      status: principal.status,
    },
    items,
    total: toNum(data.total) ?? items.length,
  }
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

/** 清枢智汇入口胶囊口径清洗：total（总余额）/ expiring（限时余额）/ planMoney（套餐余额）/
 * planToken（套餐 token），其余返回 null。口径本身只是一句话，认不出就不落库——客户端那边
 * normalizeTfEntryMode 会把认不出的值回落到 total，两边各自兜底、不互相依赖。 */
export function sanitizeTfEntryMode(v) {
  return v === 'total' || v === 'expiring' || v === 'planMoney' || v === 'planToken' ? v : null
}

/** OpenCSG 入口胶囊口径清洗：balance（账户余额）/ api（API 调用量）/ pending（待发放余额），
 * 其余返回 null。与清枢那套同一约定：口径只是一句话，认不出就不落库——客户端那边
 * normalizeOcEntryMode 会把认不出的值回落到 balance，两边各自兜底、不互相依赖。
 *
 * 老存档里可能存着 `vip` / `usage`（0.7.0 的口径，随用户定案「不需要套餐」一并废弃）：
 * 它们**不是**本版本认识的取值，这里回 null、客户端回落到 balance。**刻意不做**
 * 「vip → api」这类迁移映射：老值说的是「会员档位」，而档位已经不在卡片上了，猜一个近似的
 * 口径等于替用户改设置——回落成最直白的余额更老实。 */
export function sanitizeOcEntryMode(v) {
  return v === 'balance' || v === 'api' || v === 'pending' ? v : null
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
/**
 * 密码掩码：固定 6 个圆点，不反映真实长度（长度也是信息，没必要漏）。
 * 空/非字符串 → '' ，前端据此显示「未存密码」而不是一排点。
 * 与密钥同一口径：**列表只回掩码，明文按需单取**（见 /stepfun/account/password）。
 */
export function stepMaskPassword(pw) {
  if (typeof pw !== 'string' || pw === '') return ''
  return '••••••'
}

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

/**
 * 阶跃长会话净化：键 = 账号 username（小写归一口径，与账号池同一套），
 * 值 = { cookie, webid, token, expAt, source }。
 *
 * 落盘的会话是平台 bearer 凭据（与密码同级敏感），故逐项白名单：
 * - 只认账号池内存在的 username（池外条目一律丢弃，防串号）
 * - expAt 必须是有限正数（脏时间戳会让会话永远「新鲜」或永远「过期」）
 * - cookie/webid 限长限字符集，防历史脏数据把请求头撑爆
 */
export function sanitizeStepSessions(input, accounts) {
  const pool = new Set()
  if (Array.isArray(accounts)) {
    for (const a of accounts) {
      if (isObj(a) && typeof a.username === 'string' && a.username !== '') pool.add(a.username.toLowerCase())
    }
  }
  if (!isObj(input) || pool.size === 0) return {}
  const out = {}
  for (const [rawKey, raw] of Object.entries(input)) {
    if (!isObj(raw)) continue
    const key = asStr(rawKey).trim().toLowerCase()
    if (key === '' || !pool.has(key)) continue
    const cookie = typeof raw.cookie === 'string' ? raw.cookie : ''
    const webid = typeof raw.webid === 'string' ? raw.webid : ''
    const token = typeof raw.token === 'string' ? raw.token : ''
    const expAt = toNum(raw.expAt)
    if (cookie === '' && token === '') continue
    if (expAt === null || expAt <= 0 || !Number.isFinite(expAt)) continue
    // expAt 只用于丢极端老的磁盘脏数据（30 天以上没用过），不用于判「过期」：
    // cookie 实际寿命常比 JWT exp 长，按时间戳主动重登会变成反复重新登录。
    if (expAt < Math.floor(Date.now() / 1000) - 30 * 86400) continue
    if (cookie.length > 4096 || webid.length > 128 || token.length > 4096) continue
    out[key] = {
      cookie: cookie.slice(0, 4096),
      webid: webid.slice(0, 128),
      token: token.slice(0, 4096),
      expAt: Math.floor(expAt),
      source: typeof raw.source === 'string' && raw.source !== '' ? raw.source.slice(0, 32) : 'script',
    }
    if (Object.keys(out).length >= 20) break
  }
  return out
}

/** 阶跃偏好净化：胶囊接管开关 / 显示内容 / 当前面板提供商（跨会话记忆） */
export function sanitizeStepPrefs(input) {
  const out = { takeover: true, mode: 'auto', provider: 'tr' }
  if (!isObj(input)) return out
  if (input.takeover === false) out.takeover = false
  if (input.mode === 'credits' || input.mode === 'balance' || input.mode === 'auto') out.mode = input.mode
  // provider 是「面板当前看哪家」：白名单必须跟着 SYS_KEYS 一起长，漏一个那家的选择就不跨会话，
  // 重开面板会莫名其妙跳回基元（0.6.2 加 zcode、0.6.4 加 tf、本轮加 oc 都是这个坑）。
  if (input.provider === 'step' || input.provider === 'tr' || input.provider === 'zcode' || input.provider === 'tf' || input.provider === 'oc') out.provider = input.provider
  return out
}

/**
 * 当前阶跃活跃登录凭据（与 pickReloginAccount 同一保守护栏：无绑定绝不借他人账号）。
 * username 省略 → 取 state.step.activeAccount 指向的账号（绝大多数调用点）。
 * username 显式传入 → 只在账号池内解析该账号（必须存在且有密码）；
 * 用于「多账号面板」按账号懒查套餐/余额——池子本身就是用户自己的账号，
 * 显式点名不算借用他人凭据，但绝不接受池外或无密码的账号名。
 */
export function pickStepAccount(step, username) {
  if (!isObj(step) || !Array.isArray(step.accounts)) return null
  if (username === undefined) {
    const active = typeof step.activeAccount === 'string' ? step.activeAccount.trim().toLowerCase() : ''
    if (active === '') return null
    for (const a of step.accounts) {
      if (isObj(a) && typeof a.username === 'string' && a.username.toLowerCase() === active
        && typeof a.password === 'string' && a.password !== '') return a
    }
    return null
  }
  if (typeof username !== 'string') return null
  const want = username.trim().toLowerCase()
  if (want === '') return null
  for (const a of step.accounts) {
    if (isObj(a) && typeof a.username === 'string' && a.username.toLowerCase() === want
      && typeof a.password === 'string' && a.password !== '') return a
  }
  return null
}

// =====================================================================
// 清枢智汇（TierFlow）持久化结构净化（与阶跃账号池同一口径：
// 明文密码只落本机 0600 state 文件；列表只回掩码，明文按需单取）
// =====================================================================

/**
 * 密码掩码：固定 6 个圆点，不反映真实长度（长度也是信息，没必要漏）。
 * 与 stepMaskPassword 同一口径：空/非字符串 → ''，前端据此显示「未存密码」。
 */
export function tfMaskPassword(pw) {
  if (typeof pw !== 'string' || pw === '') return ''
  return '••••••'
}

/**
 * 账号池净化。identifier 是**邮箱或手机号**——平台登录字段就叫 identifier
 * （传 username 直接 `LOGIN_CREDENTIALS_REQUIRED`），所以长度上限比阶跃的
 * 用户名口径放宽到 96（邮箱比用户名长，64 对邮箱偏紧）；密码 1~256。
 * 同键去重（小写）、≤20 条。凭据只落本机 0600 state 文件。
 */
export function sanitizeTfAccounts(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    if (!isObj(raw)) continue
    const identifier = asStr(raw.identifier).trim()
    const password = typeof raw.password === 'string' ? raw.password : ''
    if (identifier.length < 3 || identifier.length > 96 || password === '' || password.length > 256) continue
    const key = identifier.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ identifier, password, addedAt: toNum(raw.addedAt) ?? Date.now() })
    if (out.length >= 20) break
  }
  return out
}

/**
 * 长会话净化：键 = identifier（小写归一口径，与账号池同一套），
 * 值 = { cookie, uid, savedAt }。
 *
 * 平台会话就是 HttpOnly 的 `session` cookie（Max-Age 30 天）。cookie 值本身是
 * securecookie 封装（ts|gob|mac），内部时间戳能解但**不值得依赖**：过期与否一律
 * 以平台的 401 为准（见 tfFetchAccount：401 就把内存与磁盘会话一起作废并重登）。
 * savedAt 只用来丢极端老的磁盘脏数据（30 天以上没用过），不用于判过期。
 *
 * 逐项白名单与阶跃同一套理由：
 * - 只认账号池内存在的 identifier（池外条目一律丢弃，防串号——串号是安全事故）
 * - cookie 限长 4096，防历史脏数据把请求头撑爆
 * - uid 只留纯数字，因为它要被拼进 `TF-User` 请求头
 */
export function sanitizeTfSessions(input, accounts) {
  const pool = new Set()
  if (Array.isArray(accounts)) {
    for (const a of accounts) {
      if (isObj(a) && typeof a.identifier === 'string' && a.identifier !== '') pool.add(a.identifier.toLowerCase())
    }
  }
  if (!isObj(input) || pool.size === 0) return {}
  const out = {}
  for (const [rawKey, raw] of Object.entries(input)) {
    if (!isObj(raw)) continue
    const key = asStr(rawKey).trim().toLowerCase()
    if (key === '' || !pool.has(key)) continue
    const cookie = typeof raw.cookie === 'string' ? raw.cookie : ''
    if (cookie === '' || cookie.length > 4096) continue
    const uidRaw = raw.uid === undefined || raw.uid === null ? '' : String(raw.uid).trim()
    const uid = /^\d{1,20}$/.test(uidRaw) ? uidRaw : ''
    const savedAt = toNum(raw.savedAt)
    if (savedAt === null || !Number.isFinite(savedAt) || savedAt <= 0) continue
    if (savedAt < Date.now() - 30 * 86400 * 1000) continue
    out[key] = { cookie: cookie.slice(0, 4096), uid, savedAt: Math.trunc(savedAt) }
    if (Object.keys(out).length >= 20) break
  }
  return out
}

/**
 * 当前清枢智汇活跃登录凭据（与 pickStepAccount 同一保守护栏：无绑定绝不借他人账号）。
 * identifier 省略 → 取 state.tf.activeAccount 指向的账号（绝大多数调用点）；
 * 显式传入 → 只在账号池内解析该账号（多账号面板按账号懒查）。
 * 两种情况都要求**密码非空**，绝不拿半条凭据去打平台。
 */
export function pickTfAccount(tf, identifier) {
  if (!isObj(tf) || !Array.isArray(tf.accounts)) return null
  const match = (want) => {
    for (const a of tf.accounts) {
      if (isObj(a) && typeof a.identifier === 'string' && a.identifier.toLowerCase() === want
        && typeof a.password === 'string' && a.password !== '') return a
    }
    return null
  }
  if (identifier === undefined) {
    const active = typeof tf.activeAccount === 'string' ? tf.activeAccount.trim().toLowerCase() : ''
    return active === '' ? null : match(active)
  }
  if (typeof identifier !== 'string') return null
  const want = identifier.trim().toLowerCase()
  return want === '' ? null : match(want)
}

// =====================================================================
// OpenCSG（opencsg.com）持久化结构净化（与阶跃 / 清枢账号池同一口径：
// 明文密码只落本机 0600 state 文件；列表只回掩码，明文按需单取）
// =====================================================================

/**
 * 密码掩码：固定 6 个圆点，不反映真实长度（长度也是信息，没必要漏）。
 * 与 stepMaskPassword / tfMaskPassword 同一口径：空/非字符串 → ''。
 */
export function ocMaskPassword(pw) {
  if (typeof pw !== 'string' || pw === '') return ''
  return '••••••'
}

/**
 * 账号池净化。identifier 是**手机号 / 邮箱**（Casdoor 的登录字段就叫 username，
 * 内容自己认手机还是邮箱）；长度上限与清枢同口径 96（邮箱比用户名长，64 对邮箱偏紧），
 * 密码 1~256。同键去重（小写）、≤20 条。凭据只落本机 0600 state 文件。
 */
export function sanitizeOcAccounts(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    if (!isObj(raw)) continue
    const identifier = asStr(raw.identifier).trim()
    const password = typeof raw.password === 'string' ? raw.password : ''
    if (identifier.length < 3 || identifier.length > 96 || password === '' || password.length > 256) continue
    const key = identifier.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ identifier, password, addedAt: toNum(raw.addedAt) ?? Date.now() })
    if (out.length >= 20) break
  }
  return out
}

/**
 * 长会话净化：键 = identifier（小写归一口径，与账号池同一套），
 * 值 = { token, scheme, uuid, username, savedAt }。
 *
 * 与清枢（一枚 30 天的 HttpOnly cookie）不同，OpenCSG 这边存的是**平台签的本地 JWT**
 * （实测 `Authorization: Bearer <本地JWT>` 能过，cookie 单独发是 401 AUTH-ERR-1）。
 * token 的有效期能从 JWT 的 exp 读出来，但**过期与否一律以平台的 401 为准**
 * （见 fetchOcAccount 的重登分支）——解析 exp 只是给「要不要提前重登」一个参考。
 *
 * 逐项白名单理由与清枢同一套：
 * - 只认账号池内存在的 identifier（池外条目一律丢弃，防串号——串号是安全事故）
 * - token 限长 4096，防历史脏数据把请求头撑爆
 * - scheme 只认实测的两种前缀（OC_AUTH_SCHEMES），别的值会让请求头变成垃圾
 * - uuid / username 只留短字符串（它们要进 URL 与界面，不参与鉴权）
 */
export function sanitizeOcSessions(input, accounts) {
  const pool = new Set()
  if (Array.isArray(accounts)) {
    for (const a of accounts) {
      if (isObj(a) && typeof a.identifier === 'string' && a.identifier !== '') pool.add(a.identifier.toLowerCase())
    }
  }
  if (!isObj(input) || pool.size === 0) return {}
  const out = {}
  for (const [rawKey, raw] of Object.entries(input)) {
    if (!isObj(raw)) continue
    const key = asStr(rawKey).trim().toLowerCase()
    if (key === '' || !pool.has(key)) continue
    const token = typeof raw.token === 'string' ? raw.token.trim() : ''
    if (token === '' || token.length > 4096) continue
    const scheme = typeof raw.scheme === 'string' && ocLib.OC_AUTH_SCHEMES.indexOf(raw.scheme.trim()) >= 0 ? raw.scheme.trim() : ''
    if (scheme === '') continue
    const savedAt = toNum(raw.savedAt)
    if (savedAt === null || !Number.isFinite(savedAt) || savedAt <= 0) continue
    if (savedAt < Date.now() - 30 * 86400 * 1000) continue
    const uuid = asStr(raw.uuid).slice(0, 64)
    const username = asStr(raw.username).slice(0, 96)
    out[key] = { token: token.slice(0, 4096), scheme, uuid, username, savedAt: Math.trunc(savedAt) }
    if (Object.keys(out).length >= 20) break
  }
  return out
}

/**
 * 当前 OpenCSG 活跃登录凭据（与 pickTfAccount 同一保守护栏：无绑定绝不借他人账号）。
 * identifier 省略 → 取 state.oc.activeAccount 指向的账号（绝大多数调用点）；
 * 显式传入 → 只在账号池内解析该账号（多账号面板按账号懒查）。
 * 两种情况都要求**密码非空**，绝不拿半条凭据去打平台。
 */
export function pickOcAccount(oc, identifier) {
  if (!isObj(oc) || !Array.isArray(oc.accounts)) return null
  const match = (want) => {
    for (const a of oc.accounts) {
      if (isObj(a) && typeof a.identifier === 'string' && a.identifier.toLowerCase() === want
        && typeof a.password === 'string' && a.password !== '') return a
    }
    return null
  }
  if (identifier === undefined) {
    const active = typeof oc.activeAccount === 'string' ? oc.activeAccount.trim().toLowerCase() : ''
    return active === '' ? null : match(active)
  }
  if (typeof identifier !== 'string') return null
  const want = identifier.trim().toLowerCase()
  return want === '' ? null : match(want)
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
  let state = { cookie: '', csrf: '', prefs: {}, accounts: [], activeAccount: '', update: {}, step: { accounts: [], activeAccount: '', device: '', sessions: {}, prefs: sanitizeStepPrefs({}) }, tf: { accounts: [], activeAccount: '', sessions: {} }, oc: { accounts: [], activeAccount: '', sessions: {} } }
  const blankStep = () => ({ accounts: [], activeAccount: '', device: '', sessions: {}, prefs: sanitizeStepPrefs({}) })
  const blankTf = () => ({ accounts: [], activeAccount: '', sessions: {} })
  const blankOc = () => ({ accounts: [], activeAccount: '', sessions: {} })

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
          const stepAccounts = sanitizeStepAccounts(data.step.accounts)
          state.step = {
            accounts: stepAccounts,
            activeAccount: typeof data.step.activeAccount === 'string' ? data.step.activeAccount : '',
            device: typeof data.step.device === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(data.step.device.trim()) ? data.step.device.trim() : '',
            // 按账号分槽的长会话（oasis cookie）。平台 token 有效期长（~30min 且可续），
            // 登录一次即可长期复用——落盘后连重启都不必重登。串号是安全事故，故键名必须落在账号池内。
            sessions: sanitizeStepSessions(data.step.sessions, stepAccounts),
            prefs: sanitizeStepPrefs(data.step.prefs),
          }
        }
        if (isObj(data.tf)) {
          const tfAccounts = sanitizeTfAccounts(data.tf.accounts)
          state.tf = {
            accounts: tfAccounts,
            activeAccount: typeof data.tf.activeAccount === 'string' ? data.tf.activeAccount : '',
            // 平台会话是 30 天的 HttpOnly cookie（Max-Age=2592000），按账号分槽落盘后
            // 连重启都不必重登；串号是安全事故，故键名必须落在账号池内。
            sessions: sanitizeTfSessions(data.tf.sessions, tfAccounts),
          }
        }
        if (isObj(data.oc)) {
          const ocAccounts = sanitizeOcAccounts(data.oc.accounts)
          state.oc = {
            accounts: ocAccounts,
            activeAccount: typeof data.oc.activeAccount === 'string' ? data.oc.activeAccount : '',
            // 这里的凭据是平台签的本地 JWT（Bearer），同样按账号分槽落盘；
            // 串号是安全事故，故键名必须落在账号池内。
            sessions: sanitizeOcSessions(data.oc.sessions, ocAccounts),
          }
        }
      }
    } catch { /* 不可读 → 空状态 */ }
    stepLoadSessions() // 落盘的长会话装进内存 Map（多账号并存的前提）
    tfLoadSessions() // 清枢智汇同款：30 天会话按账号分槽落盘
    ocLoadSessions() // OpenCSG 同款：本地 JWT 按账号分槽落盘
    return state
  }
  const saveState = () => {
    const file = statePath()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ cookie: state.cookie, csrf: state.csrf, prefs: state.prefs, accounts: state.accounts, activeAccount: state.activeAccount, update: state.update, step: state.step, tf: state.tf, oc: state.oc, savedAt: Date.now() }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch { /* best-effort：丢持久化不丢功能 */ }
  }

  // ---- 启用的系统（0.6.2「系统管理」）----
  // 面板里能出现哪几家（基元 / 阶跃 / ZCode / 清枢智汇 / OpenCSG）：**默认只有基元**，另四家要在
  // 设置 → 系统管理里显式勾上才出现。prefs.systems 是权威；老存档里只有 0.6.x 的
  // ZCode 总开关（prefs.zcode），缺 systems 时按它推导——老用户开过 ZCode 的不会被悄悄关掉。
  // 不变式：**至少留一个**（全关等于面板空转），任何入口进来的全关状态都落回基元。
  const SYS_KEYS = ['tr', 'step', 'zcode', 'tf', 'oc']
  const systemsOf = (prefs) => {
    const p = isObj(prefs) ? prefs : {}
    const raw = isObj(p.systems) ? p.systems : {}
    const out = {}
    for (const k of SYS_KEYS) {
      if (typeof raw[k] === 'boolean') out[k] = raw[k]
      else if (k === 'zcode') out[k] = p.zcode === true
      else out[k] = k === 'tr'
    }
    // 逐键判空而不是硬点四家人的名字：以后再加系统时这条不变式不会漏改。
    if (!SYS_KEYS.some((k) => out[k] === true)) out.tr = true
    return out
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
    // 清枢智汇入口胶囊口径（设置 → 清枢 → 胶囊接管（清枢智汇））：四选一，认不出就不写。
    const tfm = sanitizeTfEntryMode(input.entryTfMode)
    if (tfm !== null) out.entryTfMode = tfm
    // OpenCSG 入口胶囊口径（设置 → OpenCSG → 胶囊接管（OpenCSG））：三选一，认不出就不写。
    const ocm = sanitizeOcEntryMode(input.entryOcMode)
    if (ocm !== null) out.entryOcMode = ocm
    // ZCode 集成总开关（默认关闭——插件面向所有用户，读 ~/.zcode/v2 凭证必须显式
    // 开启）。只在请求显式携带时才写入：面板几何等其它 prefs POST 不覆盖此开关。
    if (input.zcode !== undefined) out.zcode = input.zcode === true
    // 启用的系统（设置 → 系统管理）：白名单三个布尔值。**全 false 的请求整段忽略**——
    // 客户端点最后一个开关时会自己拦下并提示，这里是不被绕过的第二道（老客户端/手改 prefs
    // 都堵住）。写 systems 的同时镜像老的 zcode 总开关，让 zcodeEnabled() 只有一份真相；
    // 少了哪个键也没关系，systemsOf() 会按老 zcode / 默认基元逐键补齐。
    if (isObj(input.systems)) {
      const sys = {}
      for (const k of SYS_KEYS) if (typeof input.systems[k] === 'boolean') sys[k] = input.systems[k]
      if (SYS_KEYS.some((k) => sys[k] === true)) {
        out.systems = sys
        if (typeof sys.zcode === 'boolean') out.zcode = sys.zcode
      }
    }
    // 批量检测设置（模型页签）：开关 / 定时间隔 / 选中模型集。间隔走白名单，
    // 选中集每项必须是非控制字符的短字符串（模型 ID 形态），上限 CHECK_MAX_MODELS。
    if (isObj(input.check)) {
      const c = input.check
      const check = { mode: c.mode === true }
      if (c.interval !== undefined) {
        const iv = toNum(c.interval)
        check.interval = iv !== null && [5, 10, 15, 30, 60].indexOf(iv) >= 0 ? iv : 0
      }
      if (isObj(c.sel)) {
        const sel = {}
        let n = 0
        for (const k of Object.keys(c.sel)) {
          if (n >= CHECK_MAX_MODELS) break
          if (c.sel[k] === true && /^[^\x00-\x1f]{1,120}$/.test(k)) { sel[k] = true; n++ }
        }
        if (n > 0) check.sel = sel
      }
      out.check = check
    }
    return out
  }

  // 0.1.7+ 的活存储是「profile 补丁层」。候选顺序：
  //   ① 装着本插件的 profile —— 插件只在装了自己的 profile 里加载，这比猜「当前
  //      profile」可靠（profile 选择状态不在本插件可见范围内）
  //   ② 其余 profile，按名字排序保证确定性（同装插件时谁先谁后稳定可复现）
  // 家目录级补丁层（$DSH_HOME/cordis.patch.yml）对所有 profile 生效，排最后兜底。
  const patchLayerPaths = () => {
    const home = dshDir()
    if (home === null) return []
    const out = []
    const homePatch = join(home, 'cordis.patch.yml')
    if (existsSync(homePatch)) out.push(homePatch)
    const root = join(home, 'profiles')
    let names = []
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name)
    } catch { return out }
    const cands = []
    for (const name of names) {
      const patch = join(root, name, 'cordis.patch.yml')
      if (!existsSync(patch)) continue
      // name 必须一起存：下面排序的平手判据读它。曾漏掉 → a.name 为 undefined，
      // localeCompare 抛 TypeError，而调用方没有 try/catch，整个 /manifest 500，
      // 面板只显示「没有提供商」，真正原因被吞（实测踩过）。
      cands.push({ name, patch, mine: existsSync(join(root, name, 'node_modules', 'dsh-tokenrhythm-bill')) })
    }
    // 装着本插件的 profile 优先；平手按名字，保证同装多个时顺序确定可复现
    cands.sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || a.name.localeCompare(b.name))
    for (const c of cands) out.push(c.patch)
    return out
  }

  // ---- provider / 凭据解析（每次现读，改 settings 即时生效）----
  // 来源按序：settings.yaml（0.1.6 及更早的活文件）→ profile 补丁层（0.1.7+ 的活存储）。
  // 只读不写：绝不替用户重建 settings.yaml——那会造成第二次导入，把 Setup 的默认值
  // 盖回用户已经改过的选择上（DSH 自己的注释明确写了这个坑）。
  // 与 parseSettingsProviders 同一契约：任何失败都化作 error 文案返回，绝不向外抛——
  // 抛出会让 /manifest 整个 500，面板只剩一句「没有提供商」，真正原因被吞掉。
  const readProviders = () => {
    const file = settingsPath()
    const legacyText = readTextSafe(file)
    if (legacyText.trim() !== '') {
      try { return { providers: parseSettingsProviders(legacyText), error: null } }
      catch (err) { return { providers: [], error: 'settings.yaml 解析失败: ' + String((err && err.message) || err) } }
    }
    let patches = []
    try { patches = patchLayerPaths() }
    catch (err) { return { providers: [], error: '枚举 profile 补丁层失败: ' + String((err && err.message) || err) } }
    if (patches.length === 0) {
      return {
        providers: [],
        error: file === null ? '无法定位 DSH 目录' : 'settings.yaml 不存在，也没找到任何 profile 的 cordis.patch.yml',
      }
    }
    let sawText = false
    let firstNonEmpty = null // 全家都没有 tokenrhythm 时的兜底：第一份非空名册
    for (const patch of patches) {
      const text = readTextSafe(patch)
      if (text.trim() === '') continue
      sawText = true
      let list = []
      try { list = parsePatchProviders(text) }
      catch (err) { return { providers: [], error: '补丁层解析失败: ' + String((err && err.message) || err) } }
      if (list.length === 0) continue
      // 本插件只为 tokenrhythm 余额而生：哪份补丁层里有可查余额的条目（baseURL 含
      // tokenrhythm）就用哪份，不再死守「第一个非空」。为什么不能只靠 patchLayerPaths
      // 的排序：mine 判据是「这个 profile 装没装本插件」，多个 profile 都装过就全部打平、
      // 退化按名字排——实测 web/desktop/work 三 profile 全装时 desktop 胜出，而
      // tokenrhythm 提供商配在 work 的补丁层里，于是先读到一份只有 tierflow 的名册，
      // 面板误报「未配置基元律动提供商，无法查询余额」。当前 profile 不在插件可见
      // 范围内（宿主进程环境里只有 DSH_HOME，没有 profile 标识），所以按内容选，
      // 比猜 profile 可靠。
      if (list.some((p) => p.balanceCapable)) return { providers: list, error: null }
      if (firstNonEmpty === null) firstNonEmpty = list
    }
    if (firstNonEmpty !== null) return { providers: firstNonEmpty, error: null }
    return {
      providers: [],
      error: sawText
        ? 'settings.yaml 与各 profile 补丁层里都没有 llm-pi-ai.providers 段'
        : 'settings.yaml 与各 profile 补丁层都为空或不可读',
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
  // ---- 峰谷分时计价表 TTL 缓存：/api/model-price-schedules 是公开接口（无需会话），
  // 与模型列表解耦——网关兜底路径也能拿到峰谷徽章数据。缓存结构与模型列表一致。 ----
  const schedulesCache = { data: null, ts: 0 }
  const fetchPriceSchedules = async () => {
    if (schedulesCache.data !== null && Date.now() - schedulesCache.ts < MODELS_TTL_MS) return schedulesCache.data
    try {
      const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/model-price-schedules')
      if (!res.ok) return schedulesCache.data
      const data = normalizePriceSchedules(await res.json().catch(() => null))
      schedulesCache.data = data
      schedulesCache.ts = Date.now()
      return data
    } catch {
      // 峰谷表拉取失败不该影响模型列表：返回旧缓存（没有就返回空表）。
      return schedulesCache.data
    }
  }
  // ---- /model-check 批量检测 TTL 缓存：model -> { ts, status, ms, error, errorKind, checkedAt } ----
  // 60s 内同模型不重复真实探测（防连续点「立即检测」重复计费）；force 绕过。
  const checkCache = new Map()
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
  // 当日使用与花费趋势共用同一份 call-logs 分页（见 fetchUsageTrend），不再各自翻页——
  // 旧实现当日卡最多串行 10 页、趋势图又把今天的页重拉一遍，同样的日志每次刷新
  // 被平台吐两遍，且当日卡封顶 1000 次与趋势图数字对不上。
  const DAILY_LOG_PAGE_SIZE = 100

  // ---- 「当日使用」数据源：本地日分桶 + 按模型细分 ----
  // 0.5.5 起界面删掉了 7 日趋势图与「最近调用」，这组分桶现在只服务余额页的
  // 「当日使用」卡（今天 0 点起至今的调用/花费/tokens）。翻页早停判据仍按
  // 「凑满 N 个有记录日且最老记录早于第 N 新的 0 点」算——它保证最后一天
  // （也就是今天）的记录已经拉全，正是当日卡要的。
  // 当日使用卡片直接取今天的分桶（分页最新优先，今天的记录天然在最新几页且完整）。
  // 实测：pageSize 被服务端锁死 100（500 直接 400），但响应带 total。
  const TREND_TTL_MS = 5 * 60 * 1000 // 全量重翻间隔
  const TREND_TOPUP_TTL_MS = 60 * 1000 // 60s 内直接吃缓存；60s~5min 只补拉今天（1~2 页）
  const TREND_DAYS = 7
  const TREND_WINDOW_DAYS = 90
  const TREND_MAX_PAGES = 60
  const TREND_BATCH = 6
  const TREND_TOP_MODELS = 6
  // 缓存按账号隔离（state.activeAccount）：切换账号后旧账号的缓存不会被发给新账号，
  // 切回原账号也能立刻命中它自己的缓存，而不是看到别的账号的 ¥0。
  const trendCaches = new Map() // activeAccount -> { data, ts, buckets }

  const makeBucket = (dayStart) => ({
    key: dayStart.toDateString(),
    t: dayStart.getTime(),
    date: (dayStart.getMonth() + 1) + '-' + dayStart.getDate(),
    costCny: 0,
    calls: 0,
    successCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    models: new Map(),
  })

  // 把一页日志灌进分桶（toDateString 即本地时区日期）；字段口径：snake_case 兜底、
  // 非法数值按 0。返回本批已见最老记录的时间戳（无有效记录返回 Infinity）。
  const ingestInto = (buckets, list) => {
    let oldest = Infinity
    for (const item of list) {
      if (!isObj(item)) continue
      const t = new Date(item.requestAt || item.time || '')
      if (Number.isNaN(t.getTime())) continue
      const ts = t.getTime()
      if (ts < oldest) oldest = ts
      const dayStart = new Date(t)
      dayStart.setHours(0, 0, 0, 0)
      const key = dayStart.toDateString()
      let b = buckets.get(key)
      if (!b) {
        b = makeBucket(dayStart)
        buckets.set(key, b)
      }
      const cost = toNum(item.costCny) ?? 0
      b.costCny += cost
      b.calls++
      if (toNum(item.status) === 200) b.successCalls++
      b.inputTokens += toNum(item.inputTokens ?? item.input_tokens) ?? 0
      b.outputTokens += toNum(item.outputTokens ?? item.output_tokens) ?? 0
      b.cacheReadTokens += toNum(item.cacheReadTokens ?? item.cache_read_tokens) ?? 0
      const name = asStr(item.model || item.requestModelId) || '未知模型'
      const m = b.models.get(name) || { costCny: 0, calls: 0 }
      m.costCny += cost
      m.calls++
      b.models.set(name, m)
    }
    return oldest
  }

  // 当日使用卡片数据：今天的桶直读。旧实现当日卡封顶 10 页=1000 次、趋势图却拉全，
  // 同一面板两个「今天」数字互相矛盾；现在同源同数。
  const dailyFromBuckets = (buckets, todayStart) => {
    const b = buckets.get(todayStart.toDateString())
    return {
      inputTokens: b ? b.inputTokens : 0,
      outputTokens: b ? b.outputTokens : 0,
      cacheReadTokens: b ? b.cacheReadTokens : 0,
      costCny: b ? Math.round(b.costCny * 1e6) / 1e6 : 0,
      calls: b ? b.calls : 0,
      successCalls: b ? b.successCalls : 0,
      fetched: b ? b.calls : 0,
      since: todayStart.toISOString(),
    }
  }

  const fetchLogPage = async (cookie, page, startIso, endIso) => {
    const headers = trHeaders(cookie)
    const qs = 'startAt=' + encodeURIComponent(startIso) + '&endAt=' + encodeURIComponent(endIso)
      + '&page=' + page + '&pageSize=' + DAILY_LOG_PAGE_SIZE
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/call-logs/page?' + qs, { headers })
        // 5xx 网关错重试 1 次（与 /models 代理同口径）。
        if (RETRYABLE_STATUS.has(res.status)) res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/call-logs/page?' + qs, { headers })
        if (!res.ok) return null
        return await res.json().catch(() => null)
      } catch { if (attempt > 0) return null }
    }
    return null
  }

  // 只补拉今天：余额面板 60s 自动刷新，全量重翻不必跟着这么勤——缓存 60s~5min 之间
  // 只拉 1~2 页把今天的桶换新（页数按缓存里今天的调用量估）。覆盖判据：补拉页里
  // 最老一条记录早于今天 0 点（翻过了午夜线，今天必已完整），或整个窗口本就无记录。
  // 翻不过去（今天调用暴涨超出估计）或拉页失败 → 返回 null，走全量重翻。
  const topupToday = async (cookie, hit) => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const start = new Date(todayStart)
    start.setDate(start.getDate() - TREND_WINDOW_DAYS)
    const startIso = start.toISOString()
    const endIso = new Date().toISOString()
    const pages = Math.min(TREND_MAX_PAGES, Math.ceil((hit.data.daily ? hit.data.daily.calls : 0) / DAILY_LOG_PAGE_SIZE) + 1)
    const temp = new Map()
    let oldest = Infinity
    let ok = true
    for (let p = 1; p <= pages; p++) {
      const j = await fetchLogPage(cookie, p, startIso, endIso)
      if (j === null) { ok = false; break }
      const d = unwrapEnvelope(j)
      const list = isObj(d) && Array.isArray(d.list) ? d.list : []
      oldest = Math.min(oldest, ingestInto(temp, list))
      if (list.length < DAILY_LOG_PAGE_SIZE) break
    }
    if (!ok) return null
    const todayKey = todayStart.toDateString()
    if (oldest === Infinity || oldest < todayStart.getTime()) {
      // 已越过今天 0 点（或窗口内根本没有记录）：今天的桶可信，直接换新；
      // 今天的调用/花费由此恢复完整，dailyPartial 解除。
      const tb = temp.get(todayKey)
      if (tb) hit.buckets.set(todayKey, tb)
      else hit.buckets.delete(todayKey)
    } else {
      return null
    }
    hit.data = {
      ...hit.data,
      daily: dailyFromBuckets(hit.buckets, todayStart),
      dailyPartial: false,
    }
    hit.ts = Date.now()
    return hit.data
  }

  // 「当日使用」数据源：按天把 call-logs 的当日调用聚成桶，再把今天 0 点起的那个桶
  // 取出来给余额页。翻页逻辑（早停判据 / 缺页如实截断）沿用原趋势图那套，因为
  // 「今天到此刻花了多少」同样要求今天的记录拉全。
  // 注意：翻页只为「当日」这一个数字服务；超过窗口的页面不会再拉。
  const fetchUsageTrendFull = async (cookie, cacheKey) => {
    const start = new Date()
    start.setDate(start.getDate() - TREND_WINDOW_DAYS)
    start.setHours(0, 0, 0, 0)
    const end = new Date()
    const startIso = start.toISOString()
    const endIso = end.toISOString()
    // 按需建桶（有记录的日子才有桶）；models 字段已无人消费（趋势图删了），
    // 但 ingestInto 顺手套一层成本为零，留着不影响正确性。
    const buckets = new Map()
    let oldestSeen = Infinity
    let fetchedCount = 0 // 只当计数用：不把最多 6000 条原始记录整个攥在内存里
    let pageFailed = false
    // 第一页失败不可静默：最新的 100 条（通常就是今天）缺了、更早的页面照常灌桶，
    // 早停判据照样成立——会得到「完整却缺了今天」的当日数字。宁可整体失败，
    // 让当日卡显示 —，也不装完整。
    const first = await fetchLogPage(cookie, 1, startIso, endIso)
    if (first === null) throw new Error('call-logs 第一页拉取失败')
    const firstData = unwrapEnvelope(first)
    const firstList = isObj(firstData) && Array.isArray(firstData.list) ? firstData.list : []
    const total = isObj(firstData) && Number.isFinite(Number(firstData.total)) ? Number(firstData.total) : 0
    fetchedCount += firstList.length
    oldestSeen = Math.min(oldestSeen, ingestInto(buckets, firstList))
    // 完整性判据：非空日凑满 TREND_DAYS 个、且已见最老记录早于其中第 TREND_DAYS
    // 新的 0 点（那天已完整，因而今天也完整）；或 90 天窗口内记录已全部拉取；
    // 或窗口内本就无记录（第一页成功且空、total=0，不算截断）。
    // 任一页拉取失败则永不判完整：缺页的数据不能冒充全量。
    const emptyWindow = firstList.length === 0 && total === 0
    const completenessNeed = () => {
      const active = [...buckets.values()].filter((b) => b.calls > 0).sort((a, b) => b.t - a.t)
      return active.length >= TREND_DAYS ? active[TREND_DAYS - 1].t : null
    }
    const complete = () => {
      if (pageFailed) return false
      if (emptyWindow) return true
      const need = completenessNeed()
      if (need !== null && oldestSeen < need) return true
      return total > 0 && fetchedCount >= total
    }
    for (let p = 2; p <= TREND_MAX_PAGES && !complete(); p += TREND_BATCH) {
      const batch = []
      for (let q = p; q < p + TREND_BATCH && q <= TREND_MAX_PAGES; q++) batch.push(q)
      const parts = await Promise.all(batch.map((pg) => fetchLogPage(cookie, pg, startIso, endIso)))
      let any = false
      for (const j of parts) {
        if (j === null) { pageFailed = true; continue }
        const d = unwrapEnvelope(j)
        if (isObj(d) && Array.isArray(d.list) && d.list.length > 0) {
          fetchedCount += d.list.length
          oldestSeen = Math.min(oldestSeen, ingestInto(buckets, d.list))
          any = true
        }
      }
      if (pageFailed || !any) break // 缺页要如实截断；整批无数据=越界/异常，后续页不会再有新记录
    }
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const result = {
      daily: dailyFromBuckets(buckets, todayStart),
      dailyPartial: pageFailed,
    }
    trendCaches.set(cacheKey, { data: result, ts: Date.now(), buckets })
    // 简单防膨胀：账号数远小于上限，超限清理最旧的一个即可。
    if (trendCaches.size > 12) {
      let oldestKey = null
      let oldestTs = Infinity
      for (const [k, v] of trendCaches) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k }
      }
      if (oldestKey !== null) trendCaches.delete(oldestKey)
    }
    return result
  }

  // 入口：60s 内直接吃缓存；60s~5min 只补拉今天；超 5min（或补拉失败）全量重翻。
  const fetchUsageTrend = async (cookie) => {
    const cacheKey = state.activeAccount || '_'
    const hit = trendCaches.get(cacheKey)
    if (hit) {
      const age = Date.now() - hit.ts
      if (age < TREND_TOPUP_TTL_MS) return hit.data
      if (age < TREND_TTL_MS) {
        const topped = await topupToday(cookie, hit).catch(() => null)
        if (topped !== null) return topped
      }
    }
    return fetchUsageTrendFull(cookie, cacheKey)
  }

  // ---- 「用量」页签上游（0.5.5）----
  // 两个来源分工：
  //   1) /api/usage/panel?range=30d —— 一次请求拿到 30 天汇总、按模型、按客户端。
  //      它不支持任何按天参数（实测 groupBy/startAt/endAt/dimension 全被忽略，
  //      响应与不带时逐字节相同），所以日历的按天数据不能问它；而且它的游标翻页
  //      第 3 页起必然 503，想靠翻 items 拼出 30 天要约 99 个请求。
  //   2) /api/usage-daily —— 一次请求拿到 date × model × Key × clientApp 的扁平行，
  //      分桶即得 30 天日历每格的数据。
  //
  // 请求量控制：整个页签只需 **2 个请求**。早期方案是「一天一个 call-logs 窗口」，
  // 要 30 个请求，既慢又容易触发平台限流（约每 3 个请求 503 一次，还要挂 5s），
  // 已废弃。
  const usageCaches = new Map() // activeAccount -> { data, ts }

  const fetchUsagePanel = async (cookie) => {
    const path = TOKENRHYTHM_BASE + '/api/usage/panel?range=' + USAGE_RANGE + '&page=1&pageSize=' + USAGE_DAY_PAGE_SIZE
    let res = await fetchWithTimeout(path, { headers: trHeaders(cookie, state.csrf) }).catch(() => null)
    if (res !== null && RETRYABLE_STATUS.has(res.status)) {
      res = await fetchWithTimeout(path, { headers: trHeaders(cookie, state.csrf) }).catch(() => null)
    }
    if (res === null || !res.ok) return null
    return await res.json().catch(() => null)
  }

  // /api/usage-daily：**日历的数据源**。data 是 date × modelId × apiKeyId ×
  // clientApp 的扁平行，按 date 分桶即得每天的调用数/花费/模型明细。
  // 实测它的 range/startDate/endDate/page/pageSize 全部被忽略（怎么传都回同样
  // 122 行），所以不带参数、固定拿一整份近 8 周明细，在 normalizeUsageDaily 里
  // 自行截到最近 30 天。
  // 限流比 panel 凶：探测时首个请求 503 挂了 6.5s，因此退避拉长到 1.5s/3.5s/7s。
  const fetchUsageDaily = async (cookie) => {
    const path = TOKENRHYTHM_BASE + '/api/usage-daily'
    let res = await fetchWithTimeout(path, { headers: trHeaders(cookie, state.csrf) }).catch(() => null)
    if (res !== null && RETRYABLE_STATUS.has(res.status)) {
      for (const wait of [1500, 3500, 7000]) {
        await new Promise((r) => setTimeout(r, wait))
        res = await fetchWithTimeout(path, { headers: trHeaders(cookie, state.csrf) }).catch(() => null)
        if (res !== null && !RETRYABLE_STATUS.has(res.status)) break
      }
    }
    if (res === null || !res.ok) return null
    return await res.json().catch(() => null)
  }

  const fetchUpstreamUsage = async (cookie) => {
    const cacheKey = state.activeAccount || '_'
    const hit = usageCaches.get(cacheKey)
    if (hit && Date.now() - hit.ts < USAGE_TTL_MS) return hit.data

    // 两个接口并发：panel 取汇总/按模型/按客户端，usage-daily 取日历按天明细。
    // 合计 2 个请求就能画完整个页签（曾按天逐日打 30 个，其实完全没必要——
    // usage-daily 的 data 本身就是按天铺开的扁平行）。
    const panelP = fetchUsagePanel(cookie)
    const dailyP = fetchUsageDaily(cookie)
    const [panelJson, dailyJson] = await Promise.all([panelP, dailyP])
    // panel 是页签主体，失败即整体失败；daily 失败则日历那一块留空，其余照常展示。
    if (panelJson === null) {
      const err = new Error('usage panel 上游无响应')
      err.status = 502
      throw err
    }
    const panel = normalizeUsagePanel(panelJson)
    const daily = normalizeUsageDaily(dailyJson, new Date())
    const out = {
      ...panel,
      daily,
      meta: {
        ...panel.meta,
        ...daily.meta,
        range: USAGE_RANGE,
        fetchedAt: Date.now(),
        // 交叉校验：日历窗口合计 vs panel 汇总。实测两者逐位相同（¥242.49619028），
        // 万一哪天平台改口径出现差值，界面据此如实说明而不是悄悄用其中一个。
        crossCheck: {
          dailyCalls: daily.days.reduce((a, d) => a + d.calls, 0),
          dailyCostCny: Math.round(daily.days.reduce((a, d) => a + d.costCny, 0) * 1e8) / 1e8,
          panelCalls: panel.summary.calls,
          panelCostCny: panel.summary.costCny,
        },
      },
    }
    usageCaches.set(cacheKey, { data: out, ts: Date.now() })
    if (usageCaches.size > 8) {
      let oldestKey = null
      let oldestTs = Infinity
      for (const [k, v] of usageCaches) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k }
      }
      if (oldestKey !== null) usageCaches.delete(oldestKey)
    }
    return out
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
  // 资金明细单页条数：明细区块一次展示全部来源（充值本金 + 每笔赠送），
  // pageSize 给大些省得翻页；平台实测 20~50 都正常返回。
  const WALLET_PAGE_SIZE = 50
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

  // 资金明细全量拉取：余额页「资金明细」区块要展示完整台账（含已用完的本金），
  // 所以 includeInactive=true 把非 ACTIVE 的也一起要过来；悬停时间线那边仍走
  // normalizeExpiringCredits 自己的过滤口径（只看 remaining>0 且有到期时间的）。
  const fetchWalletCredits = async (cookie) => {
    const headers = trHeaders(cookie)
    const res = await fetchWithTimeout(
      TOKENRHYTHM_BASE + '/api/wallet/expiring-credits?page=1&pageSize=' + WALLET_PAGE_SIZE + '&includeInactive=true',
      { headers },
    ).catch(() => null)
    if (res === null || !res.ok) return null
    return await res.json().catch(() => null)
  }

  const fetchUpstreamBalance = async (cookie, retried) => {
    const headers = trHeaders(cookie)
    const [summaryRes, meRes, expiring, wallet, rn] = await Promise.all([
      fetchWithTimeout(TOKENRHYTHM_BASE + '/api/usage-summary', { headers }),
      fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me', { headers }).catch(() => null),
      fetchExpiringCredits(cookie),
      fetchWalletCredits(cookie).catch(() => null),
      // 实名状态搭车余额轮询（0.6.2）：fetchRealname 自带 5 分钟缓存 + 失败回退，
      // 这里 .catch 只防实现意外的同步抛错，不影响余额主链。
      fetchRealname(cookie).catch(() => null),
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
    // 只留「当日使用」所需的当日桶（call-logs 翻页）。趋势图与最近调用已在 0.5.5
    // 从界面移除——30 天体量都在「用量」页签，这里再翻几十页纯属浪费请求
    // （平台约每 3 个请求就 503 一次，还要挂 5s）。
    const trendAll = await fetchUsageTrend(cookie).catch(() => null)
    return {
      ...normalizeBalance(summary, me, expiring),
      daily: trendAll ? trendAll.daily : null,
      trendMeta: trendAll ? {
        dailyPartial: !!trendAll.dailyPartial,
      } : null,
      wallet: wallet === null ? null : normalizeWalletCredits(wallet),
      realname: rn,
    }
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

  // 实名认证状态（/api/me/identity-verification，0.6.2）：余额页页首与设置页当前
  // 账号行的实名徽章数据源。每 cookie 缓存 5 分钟（换号自动失效）；请求失败回
  // 陈旧值、无可回退返 null——徽章宁可缺不编，且绝不阻塞余额主链。
  const realnameCache = { cookie: '', data: null, ts: 0 }
  const REALNAME_TTL_MS = 5 * 60 * 1000
  const fetchRealname = async (cookie) => {
    if (cookie === '') return null
    const fresh = realnameCache.cookie === cookie && realnameCache.data !== null
      && Date.now() - realnameCache.ts < REALNAME_TTL_MS
    if (!fresh) {
      try {
        const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me/identity-verification', { headers: trHeaders(cookie) })
        const body = res.ok ? await res.json().catch(() => null) : null
        const rn = realnameFromIdentity(body)
        if (rn !== null) {
          realnameCache.cookie = cookie
          realnameCache.data = rn
          realnameCache.ts = Date.now()
        }
      } catch { /* 失败保留陈旧值，走下面的回退 */ }
    }
    return realnameCache.cookie === cookie ? realnameCache.data : null
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
  // 用户 token ~30min（2026-09-24 实测 accessToken.duration = 1800s），但有 RefreshToken 可续期：
  // 过期但真实的 token 能换回本人有效会话，无需密码重登（见 stepRefreshSession）。
  const STEP_LOGIN_COOLDOWN_MS = 30 * 1000
  // 阶跃会话按账号分槽并存（键 = username 小写口径，与账号池一致）。
  // 2026-09 重构：原先是单槽 stepSess，导致查账号 B 必须覆盖账号 A 的会话 → 每次切号都重登，
  // 「查询全部」被拖成 1 分钟。平台 token 有效期长且可续，多个会话完全并存得下；
  // 单槽纯粹是我们的实现选择，不是平台限制。会话同时落盘（state.step.sessions），
  // 重启后仍可复用，不必重新登录。
  const stepSessMap = new Map()
  // 每账号上次续期时刻：万一平台不轮换 token（续期回来 expAt 仍临期），别每次 RPC 都去续一次
  const stepRefreshAt = new Map()
  const stepSessKey = (username) => String(username || '').trim().toLowerCase()
  const stepLoadSessions = () => {
    const sess = state.step && isObj(state.step.sessions) ? state.step.sessions : {}
    for (const [k, v] of Object.entries(sess)) stepSessMap.set(k, v)
  }
  const stepSaveSessions = () => {
    if (!isObj(state.step)) return
    const out = {}
    for (const [k, v] of stepSessMap) out[k] = v
    state.step.sessions = out
    saveState()
  }
  const stepGetSess = (username) => {
    // username 省略（undefined/null/''）= 当期活跃账号，与 pickStepAccount 同一口径。
    // 曾经这里对省略态一律按空串查 Map → 恒为 null，于是所有不传 username 的调用点
    // （密钥那四个路由全都没传）稳定报「ListAccessKeys 无可用会话」——多账号重构的回归。
    // 显式传了 username 却没会话时**不**兜底到活跃账号：那正是「查 B 回了 A 的结果」
    // 这类张冠李戴 bug 的温床。
    const u = stepSessKey(username)
    if (u !== '') return stepSessMap.get(u) || null
    const act = stepSessKey(state.step && state.step.activeAccount)
    return act === '' ? null : (stepSessMap.get(act) || null)
  }
  const stepClearSess = (username) => {
    // 不传账号 = 全清（保留给「清空所有阶跃凭据」这类显式动作）
    if (username === undefined || username === null || username === '') { stepSessMap.clear() }
    else { stepSessMap.delete(stepSessKey(username)) }
  }
  let stepLastLoginAt = 0
  let stepThrottleUntil = 0 // 平台软频控（200 空体）命中后退避 10 分钟，防用户连点加深封锁
  const STEP_THROTTLE_BACKOFF_MS = 10 * 60 * 1000
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
  /**
   * 「有凭据」= 会话槽里有 cookie 或 token。
   * 注意这只判断**有没有**，不判断**新不新鲜**——新鲜度归 stepSessNearExpiry 管
   * （临期则续期），两者别混为一谈：按 expAt 把会话判废再密码重登，是「登过了还反复登」的根因。
   */
  const stepSessHasCred = (username) => {
    const s = stepGetSess(username)
    return !!(s && (s.cookie !== '' || s.token !== ''))
  }
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
    const key = stepSessKey(account)
    stepSessMap.set(key, {
      token: r.token, expAt: r.expAt, cookie: r.cookie, webid: r.webid, source: 'script',
    })
    stepSaveSessions()
    // webid 是设备号：按账号分别记，别让账号 B 沿用账号 A 的设备暴露面
    if (r.webid && r.webid !== state.step.device) { state.step.device = r.webid; saveState() }
  }
  /**
   * 续期（2026-09-24 实测反解）：PassportService/RefreshToken，请求体 `{}`，
   * 凭据走 Cookie（Oasis-Token + Oasis-Webid 缺一即 400）。
   * 实测语义：**过期但真实**的 token 能换回本人有效会话（mode=2、oasis_id 一致、RPC 200）；
   * 签名非法的垃圾 token 只会铸出设备匿名 token（mode=1、身份不同、RPC 401）——
   * 与标准 JWT 刷新一致：签名得是真的，只是过期了。
   * 所以拿到新 token 后必须核对身份，对不上就整条丢掉（串号防护），宁可重登也不将就。
   */
  const stepRefreshSession = async (username) => {
    const sess = stepGetSess(username)
    if (sess === null || sess.cookie === '') return { ok: false, code: 'STEP_NO_SESS', error: '没有可续期的会话' }
    const gated = stepThrottleGate()
    if (gated !== null) return gated
    // 从既有 cookie 串拆键，别把杂质一并带回
    const jar = {}
    for (const part of String(sess.cookie).split(';')) {
      const m = /^\s*([^=]+)=([\s\S]*)$/.exec(part)
      const k = m ? m[1].trim() : ''
      if (k === 'Oasis-Token' || k === 'Oasis-Webid') jar[k] = m[2].trim()
    }
    let res
    try {
      res = await fetchWithTimeout(stepLib.stepRefreshUrl(), { method: 'POST', headers: stepJsonHeaders(stepLib.STEP_ACCOUNT_BASE + '/login', jar), body: '{}' })
    } catch (err) { return { ok: false, code: 'STEP_NET', error: '续期网络失败：' + String((err && err.message) || err) } }
    if (res.status === 401 || res.status === 403) return { ok: false, code: 'STEP_REFRESH_DEAD', error: '会话已被平台吊销，需要重新登录' }
    readStepCookies(res, jar)
    // 新 token 只认 Set-Cookie 里的 Oasis-Token（平台长令牌）；JSON 体的 accessToken.raw 是
    // account 域短令牌，拿它覆盖 cookie 会被平台 RPC 判 "token is illegal"（实测，见 stepLogin 同款注释）。
    const newTok = typeof jar['Oasis-Token'] === 'string' && jar['Oasis-Token'] !== '' ? jar['Oasis-Token'] : null
    if (newTok === null) {
      return res.status === 200
        ? { ok: false, code: 'STEP_SHAPE', error: '续期响应缺少新 token（接口可能已改版）' }
        : { ok: false, code: 'STEP_HTTP', error: '续期失败：HTTP ' + res.status }
    }
    const idOld = stepSessionIdentity(sess.token)
    const idNew = stepSessionIdentity(newTok)
    if (idOld !== null && idNew !== null && idOld !== idNew) {
      stepClearSess(username)
      return { ok: false, code: 'STEP_REFRESH_IDENTITY', error: '续期返回了别的身份的令牌，已丢弃该会话（需要重新登录）' }
    }
    const expAt = stepLib.jwtExpiry(newTok) || Math.floor(Date.now() / 1000) + 1500
    const webid = jar['Oasis-Webid'] || sess.webid || ''
    stepSessMap.set(stepSessKey(username), { token: newTok, expAt, cookie: stepCookieHeader(jar), webid, source: 'refresh' })
    stepSaveSessions()
    stepRefreshAt.set(stepSessKey(username), Date.now())
    if (webid !== '' && webid !== state.step.device) { state.step.device = webid; saveState() }
    return { ok: true, refreshed: true }
  }
  /** 临期 → 主动续期（省掉一次注定 401 的请求）；解不出 expAt 就当不临期，一路用到 401 为止 */
  const STEP_RENEW_MARGIN_S = 300
  const stepSessNearExpiry = (s) => stepSessionNearExpiry(s === null ? undefined : s.expAt, STEP_RENEW_MARGIN_S, Math.floor(Date.now() / 1000))
  // ---- 密码直登为唯一主轨（2026-09 定稿：浏览器登录功能整体摘除。JSON 通道打通后
  // 密码登录全链实测稳定，风控顾虑解除；浏览器轨的 profile 维护成本不再值得）----
  const stepPasswordLogin = async (acc, force) => {
    if (!force && Date.now() - stepLastLoginAt < STEP_LOGIN_COOLDOWN_MS) return { ok: false, code: 'STEP_COOLDOWN', error: '重登冷却中（30 秒），稍后自动恢复' }
    stepLastLoginAt = Date.now()
    const r = await stepLogin(acc.username, acc.password, state.step.device)
    if (!r.ok) { stepClearSess(acc.username); stepNoteThrottle(r); return { ok: false, code: r.code || 'STEP_REAUTH_FAILED', error: r.error } }
    stepApplySession(r, acc.username)
    return { ok: true }
  }
  const stepScriptEnsureSession = async (acc, force) => {
    const gated = stepThrottleGate()
    if (gated !== null) return gated
    const sess = stepGetSess(acc.username)
    const hasCred = sess !== null && (sess.cookie !== '' || sess.token !== '')
    if (!hasCred) return stepPasswordLogin(acc, force)
    // 有凭据：force=true（stepRpc 401 分支已断定失效）或临期 → 先用 RefreshToken 续期（免密码登录）。
    // 未临期 → 直接用，一个请求都不发。
    if (force || (stepSessNearExpiry(sess) && Date.now() - (stepRefreshAt.get(stepSessKey(acc.username)) || 0) > 60 * 1000)) {
      const r = await stepRefreshSession(acc.username)
      if (r.ok) return { ok: true }
      if (r.code === 'STEP_THROTTLED') return r
      // 续期失败 = 凭据已被吊销（或换出异身份）→ 落到密码重登
      return stepPasswordLogin(acc, force)
    }
    return { ok: true }
  }
  const stepEnsureSessionInner = async (force, username) => {
    loadState()
    const acc = pickStepAccount(state.step, username)
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
  const stepEnsureSession = (force, username) => {
    loadState()
    const acc = pickStepAccount(state.step, username)
    if (acc === null) return Promise.resolve({ ok: false, code: 'NO_STEP_ACCOUNT', error: '未配置阶跃账号（设置 → 阶跃账号）' })
    const key = acc.username
    const busy = stepEnsureBusy.get(key)
    if (busy !== undefined) return busy
    // username 必须透传：内层若按 activeAccount 重新解析，请求 B 的套餐时会拿 A 的会话
    // 就地复用，三个 RPC 全用 A 的 cookie 发出去——每个账号查回来都是同一个结果。
    const p = stepEnsureSessionInner(force, username).finally(() => { stepEnsureBusy.delete(key) })
    stepEnsureBusy.set(key, p)
    return p
  }
  /**
   * 平台 JSON RPC（控制台同款形态，CDP 抓包坐实）：POST {} / application/json，
   * 响应 JSON，成功 = HTTP 200 且 status:1；401/403 → 会话失效，强制重登/重收割重试一次
   * （relogged 防递归），与基元 401 重登同构。
   */
  const stepRpc = async (service, method, bodyObj, relogged, username) => {
    const s = await stepEnsureSession(false, username)
    if (!s.ok) return s
    // 必须按 username 取自己的会话：单槽时代这里读的是全局 stepSess，
    // 账号 B 的 RPC 会带上账号 A 的 cookie（正是「每个账号查回来都是同一个结果」的根因）。
    const sess = stepGetSess(username)
    if (sess === null) return { ok: false, code: 'STEP_NO_SESS', error: method + ' 无可用会话' }
    let res
    try {
      res = await fetchWithTimeout(stepLib.stepRpcUrl('/api/' + service + '/' + method), {
        method: 'POST',
        headers: {
          ...stepLib.STEP_OASIS_HEADERS,
          'content-type': 'application/json',
          accept: 'application/json',
          cookie: sess.cookie,
          'oasis-webid': sess.webid,
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
        // 不先清会话：续期（RefreshToken）要拿旧 cookie 当凭据，清了就没得续。
        // force=true 让 stepScriptEnsureSession 走 RefreshToken；只有续期失败
        // （凭据真被吊销/换出异身份）时才由它内部清掉并落到密码重登。
        const s2 = await stepEnsureSession(true, username)
        if (!s2.ok) return { ok: false, code: 'STEP_REAUTH_FAILED', error: s2.error }
        return stepRpc(service, method, bodyObj, true, username)
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
  // 套餐缓存按账号分槽（多账号面板：切走再切回不丢；单账号时行为与旧单槽一致）。
  // 键 = username，值 = { data, ts }。切账号/删账号时整体清空。
  const stepPlanCaches = new Map()
  // 单飞去重也按账号分槽：共用一个槽时，账号 B 的查询会拿到账号 A 的 in-flight
  // promise（并发下必然串数据），这正是「每个账号查回来都是同一个结果」的另一条根因。
  const stepPlanBusyMap = new Map()
  const fetchStepPlan = async (force, username) => {
    loadState()
    const acc = pickStepAccount(state.step, username)
    if (acc === null) return { ok: false, code: 'NO_STEP_ACCOUNT', error: '未配置阶跃账号（设置 → 阶跃账号）' }
    const hit = stepPlanCaches.get(acc.username)
    if (!force && hit && Date.now() - hit.ts < STEP_PLAN_TTL_MS) return { ok: true, ...hit.data, cached: true }
    const busy = stepPlanBusyMap.get(acc.username)
    if (busy !== undefined) return busy
    const p = (async () => {
      const nowS = Math.floor(Date.now() / 1000)
      // QueryStepPlanUsages 官方页面实证：int64 毫秒时间戳必须以「字符串」发送
      // （connect JSON 的 bigint 序列化口径），毫秒数字/秒值都会被服务端静默清零 → 恒空。
      // 窗口放宽到 35 天：账号的记录流不保证落在近 7 日（最近记录可能数周前），
      // 拉全量由前端取「最近 7 个有记录的日子」作图。
      const dayMs = (d) => { const t = new Date(d); t.setHours(0, 0, 0, 0); return t.getTime() }
      const usageStart = String(dayMs(Date.now() - 35 * 86400000))
      const usageTo = String(Date.now())
      const [statusR, creditR, usageR] = await Promise.all([
        stepRpc(stepLib.STEP_DEV_SERVICE, 'GetStepPlanStatus', {}, false, acc.username),
        stepRpc(stepLib.STEP_DEV_SERVICE, 'QueryStepPlanRateLimit', {}, false, acc.username),
        stepRpc(stepLib.STEP_DEV_SERVICE, 'QueryStepPlanUsages', { startTime: usageStart, toTime: usageTo, page: 1, pageSize: 200 }, false, acc.username),
      ])
      if (!statusR.ok && !creditR.ok) {
        const staleHit = stepPlanCaches.get(acc.username)
        if (staleHit) return { ok: true, ...staleHit.data, cached: true, stale: true, error: statusR.error || creditR.error }
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
      stepPlanCaches.set(acc.username, { data, ts: Date.now() })
      return { ok: true, ...data }
    })()
    stepPlanBusyMap.set(acc.username, p)
    try { return await p } finally { stepPlanBusyMap.delete(acc.username) }
  }
  // 余额（双通道）：① 有阶跃账号（任意轨）→ 优先控制台 QueryAccountBalance（浏览器会话
  // 同款接口，免 API key，含现金/赠送/消耗全量字段，实测坐实）；② 失败或无账号 →
  // 官方 /v1/accounts API-key 通道兜底。
  // 余额缓存同样按账号分槽。只缓存「控制台」通道的结果——API Key 兜底那条
  // 不绑账号（Key 属于单一身份），缓存下来会在多账号视图里张冠李戴。
  const stepBalCaches = new Map()
  const STEP_BAL_TTL_MS = 5 * 60 * 1000
  const fetchStepOfficialBalance = async (force, username) => {
    loadState()
    const acc = pickStepAccount(state.step, username)
    if (acc !== null) {
      const hit = stepBalCaches.get(acc.username)
      if (!force && hit && Date.now() - hit.ts < STEP_BAL_TTL_MS) return { ok: true, ...hit.data, cached: true }
      const r = await stepRpc(stepLib.STEP_DEV_SERVICE, 'QueryAccountBalance', {}, false, acc.username)
      if (r.ok) {
        const w = stepLib.normalizeStepWallet(r.data)
        if (w !== null && w.balance !== null) {
          const out = { ok: true, account: w, source: 'console', accountName: acc.username }
          stepBalCaches.set(acc.username, { data: out, ts: Date.now() })
          return { ...out }
        }
      }
      // 非活跃账号控制台通道失败 → 绝不拿 API Key 的数据顶替（Key 是另一个身份）
      if (username !== undefined) return { ok: false, code: r.code || 'STEP_RPC', error: r.error || '控制台余额接口暂不可达', accountName: acc.username }
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
  // 用户资料（devcenter UserInfo：头像 URL / 昵称 / 实名状态，2026-10 实测字段全在根上）。
  // 资料变化频率远低于套餐/余额 → TTL 15 分钟（plan/balance 是 5 分钟），少一次 RPC。
  // 缓存/单飞/失败 stale 兜底与 fetchStepPlan 同构；按账号分槽（键 = username 原样，
  // 与 stepPlanCaches/stepBalCaches 一致——那两张表也按存入时的原样键读写）。
  const stepProfileCaches = new Map()
  const stepProfileBusyMap = new Map()
  const STEP_PROFILE_TTL_MS = 15 * 60 * 1000
  const fetchStepProfile = async (force, username) => {
    loadState()
    const acc = pickStepAccount(state.step, username)
    if (acc === null) return { ok: false, code: 'NO_STEP_ACCOUNT', error: '未配置阶跃账号（设置 → 阶跃账号）' }
    const hit = stepProfileCaches.get(acc.username)
    if (!force && hit && Date.now() - hit.ts < STEP_PROFILE_TTL_MS) return { ok: true, ...hit.data, cached: true }
    const busy = stepProfileBusyMap.get(acc.username)
    if (busy !== undefined) return busy
    const p = (async () => {
      const r = await stepRpc(stepLib.STEP_DEV_SERVICE, 'UserInfo', {}, false, acc.username)
      if (!r.ok) {
        // 失败不顶掉上次成功值：next 轮询把 stale 结果照常下发，卡片资料不闪没
        const staleHit = stepProfileCaches.get(acc.username)
        if (staleHit) return { ok: true, ...staleHit.data, cached: true, stale: true, error: r.error }
        return { ok: false, code: r.code || 'STEP_RPC', error: r.error }
      }
      const profile = stepLib.normalizeStepProfile(r.data)
      if (profile === null) return { ok: false, code: 'STEP_SHAPE', error: 'UserInfo 响应不可解析（接口可能已改版）' }
      const data = { profile, fetchedAt: Date.now(), account: acc.username }
      stepProfileCaches.set(acc.username, { data, ts: Date.now() })
      return { ok: true, ...data }
    })()
    stepProfileBusyMap.set(acc.username, p)
    try { return await p } finally { stepProfileBusyMap.delete(acc.username) }
  }
  // 头像字节代理缓存：username → { buf, type, ts }。头像变了要等 TTL（1h），可接受；
  // 不缓存的话面板 60s 轮询会把同一张 CDN 图放大成持续热链接流量。
  const stepAvaCaches = new Map()
  const STEP_AVA_TTL_MS = 60 * 60 * 1000
  const stepPublicAccounts = () => state.step.accounts.map((a) => ({
    username: a.username,
    // （原先这里还回 addedAt 与 sessionValid 两个字段：前端从来没读过、也不随 add/remove 回传——
    //  addedAt 由 host 自己按 prev.addedAt 续期；会话判定是 host 路由里 stepSessHasCred 的事。）
    // 密码只给掩码，明文绝不进列表响应——要看真值走 /stepfun/account/password 单取
    pwMask: stepMaskPassword(a.password),
  }))

  // ================= 清枢智汇 TierFlow（账户 / 套餐用量） =================
  // 复刻 tierflow.cn Web 控制台自己的调用口径（2026 反解前端产物 + 真发请求坐实，
  // 逐条结论与证据见 lib/tierflow.js 头部注释）。分工与阶跃那套一致：纯函数
  // （请求装配 / 信封 / 字段归一）在 lib/tierflow.js，网络 / 缓存 / 路由在这里。
  //
  // 与基元、阶跃最大的不同：**平台凭据是一枚 HttpOnly 的 `session` cookie**（Max-Age
  // 30 天），不是 token，也没有 refresh 端点。Node 没有 cookie jar，所以我们必须自己
  // 接住 Set-Cookie 再原样回传；好在它有效期长，落盘后连重启都不必重登
  // （state.tf.sessions 按账号分槽）。会话是否还有效**一律以平台 401 为准**，
  // 不去解析 cookie 内部的 securecookie 时间戳——那是实现细节，平台改版就会变。
  //
  // 另一个坑：**HTTP 200 也可能是业务失败**（信封 success:false + code），未登录才是
  // 真 401。判成功只看 tfLib.tfEnvelope 的 ok，绝不看状态码。
  const TF_LOGIN_COOLDOWN_MS = 30 * 1000
  const TF_STATUS_TTL_MS = 24 * 60 * 60 * 1000
  const tfPlansCaches = new Map()
  const tfPlansBusy = new Map()
  const TF_USER_TTL_MS = 5 * 60 * 1000
  const TF_SUB_TTL_MS = 5 * 60 * 1000
  // 套餐列表 + 逐档升级差价（升级订阅弹窗那一份）：套餐本身很少变，差价随时在动，
  // 5 分钟与用户/订阅同档；弹窗里的「刷新」走 force=1 穿透。
  const TF_PLANS_TTL_MS = 5 * 60 * 1000
  const TF_USAGE_DAYS = 7
  const tfSleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const tfEnabled = () => {
    loadState()
    return systemsOf(state.prefs).tf
  }
  const tfDisabledResponse = () => ({ ok: false, code: 'TF_DISABLED', error: '清枢智汇未开启（设置 → 系统管理）' })

  // ---- 会话槽（内存）+ 落盘（state.tf.sessions，键 = identifier 小写）----
  const tfSessMap = new Map()
  const tfSessKey = (identifier) => String(identifier || '').trim().toLowerCase()
  const tfLoadSessions = () => {
    const sess = state.tf && isObj(state.tf.sessions) ? state.tf.sessions : {}
    for (const [k, v] of Object.entries(sess)) tfSessMap.set(k, v)
  }
  const tfSaveSessions = () => {
    if (!isObj(state.tf)) return
    const out = {}
    for (const [k, v] of tfSessMap) out[k] = v
    state.tf.sessions = out
    saveState()
  }
  const tfGetSess = (identifier) => {
    // identifier 省略（undefined/null/''）= 当期活跃账号，与 pickTfAccount 同一口径。
    // 显式传了 identifier 却没会话时**不**兜底到活跃账号：那正是「查 B 回了 A 的结果」
    // 这类张冠李戴 bug 的温床。
    const k = tfSessKey(identifier)
    if (k !== '') return tfSessMap.get(k) || null
    const act = tfSessKey(state.tf && state.tf.activeAccount)
    return act === '' ? null : (tfSessMap.get(act) || null)
  }
  const tfSessHasCred = (identifier) => {
    const s = tfGetSess(identifier)
    return !!(s && typeof s.cookie === 'string' && s.cookie !== '')
  }
  const tfApplySession = (identifier, cookie, uid) => {
    const key = tfSessKey(identifier)
    if (key === '' || typeof cookie !== 'string' || cookie === '') return
    tfSessMap.set(key, { cookie, uid: typeof uid === 'string' ? uid : '', savedAt: Date.now() })
    tfSaveSessions()
  }
  const tfClearSess = (identifier) => {
    // 不传 = 全清（保留给「清空所有清枢智汇凭据」这类显式动作）
    if (identifier === undefined || identifier === null || identifier === '') tfSessMap.clear()
    else tfSessMap.delete(tfSessKey(identifier))
    tfSaveSessions()
  }

  // ---- HTTP：Set-Cookie 必须自己接（Node 无 cookie jar）----
  const tfRequest = async (path, opts) => {
    const o = isObj(opts) ? opts : {}
    const headers = tfLib.tfHeaders({ cookie: o.cookie, uid: o.uid })
    const init = { method: o.method === 'POST' ? 'POST' : 'GET', headers }
    if (typeof o.body === 'string') {
      headers['content-type'] = 'application/json'
      init.body = o.body
    }
    const res = await fetchWithTimeout(tfLib.TF_BASE + path, init)
    // Set-Cookie 可能不止一条（登录时除 session 外还可能有域内其它 cookie），全接下来
    // 再按名取；getSetCookie() 是较新的 undici API，缺失或返回空时退回 get() 拼接串
    // （拼接串的解析见 tierflow.js 的 tfCookieEntries，别在这里按逗号切）。
    let raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    if (!Array.isArray(raw) || raw.length === 0) raw = res.headers.get('set-cookie') || ''
    const json = await res.json().catch(() => null)
    return { ...tfLib.tfEnvelope(res.status, json), setCookie: raw }
  }

  // ---- 密码登录 → 会话。这是唯一会用到明文密码的地方，密码只在本次请求内存里过一遍 ----
  const tfLogin = async (identifier, password) => {
    let r = null
    try {
      r = await tfRequest(tfLib.TF_PATH.login, { method: 'POST', body: JSON.stringify({ identifier, password }) })
    } catch (err) {
      return { ok: false, code: 'TF_NET', error: tfLib.tfErrorText('TF_NET', String((err && err.message) || err)) }
    }
    if (!r.ok) return { ok: false, code: r.code, error: tfLib.tfErrorText(r.code, r.message), authFailed: r.authFailed === true }
    const data = isObj(r.data) ? r.data : {}
    // 两步验证：平台用 data.require_2fa 告知，之后要走 TOTP/备用码那条通道。插件不做，
    // 但必须**明确告知**而不是假装成功——假装成功只会让人以为会话好了，实际每次重登。
    if (data.require_2fa === true) return { ok: false, code: 'TF_2FA_REQUIRED', error: tfLib.tfErrorText('TF_2FA_REQUIRED') }
    // success:true 但没下发 session = 凭据没换成会话，后面每个请求都会 401，这里就判失败。
    if (!tfLib.tfHasSessionCookie(r.setCookie)) return { ok: false, code: 'TF_NO_COOKIE', error: tfLib.tfErrorText('TF_NO_COOKIE') }
    const uidRaw = data.uid === undefined || data.uid === null ? '' : String(data.uid).trim()
    // uid 只留纯数字：它要被拼进 TF-User 请求头
    return { ok: true, cookie: tfLib.tfCookieFromSetCookie(r.setCookie), uid: /^\d{1,20}$/.test(uidRaw) ? uidRaw : '' }
  }

  // 每账号上次登录尝试时刻（30s 冷却，与阶跃同款）。平台没公布登录频控策略，保守取与阶跃
  // 同数量级：登录失败时连点是最容易把账号逼到封锁的用法，冷却换来的是「不会被封」。
  const tfLoginAt = new Map()
  const tfEnsureSession = async (force, identifier) => {
    loadState()
    const acc = pickTfAccount(state.tf, identifier)
    if (acc === null) return { ok: false, code: 'NO_TF_ACCOUNT', error: '未配置清枢智汇账号（面板 → 账户 → 添加账号）' }
    const key = tfSessKey(acc.identifier)
    if (!force) {
      const hit = tfSessMap.get(key)
      if (hit && typeof hit.cookie === 'string' && hit.cookie !== '') {
        return { ok: true, account: acc.identifier, cookie: hit.cookie, uid: typeof hit.uid === 'string' ? hit.uid : '' }
      }
    }
    const at = tfLoginAt.get(key) || 0
    const wait = TF_LOGIN_COOLDOWN_MS - (Date.now() - at)
    if (wait > 0) {
      return { ok: false, code: 'TF_COOLDOWN', error: '登录尝试过于频繁，约 ' + Math.ceil(wait / 1000) + ' 秒后自动重试（无需连点）' }
    }
    tfLoginAt.set(key, Date.now())
    const r = await tfLogin(acc.identifier, acc.password)
    if (!r.ok) return r
    tfApplySession(acc.identifier, r.cookie, r.uid)
    return { ok: true, account: acc.identifier, cookie: r.cookie, uid: r.uid }
  }

  // ---- 金额换算基准（/api/status 是公开接口，无需会话）----
  // 平台自己把 quota_per_unit 持久化在 zustand 里（改版才会变），故一天拉一次足够；
  // 拿不到就用与平台同源的兜底值，**绝不让金额显示成 0**。
  let tfStatusCache = { quotaPerUnit: 0, ts: 0 }
  const tfQuotaPerUnit = async () => {
    if (tfStatusCache.quotaPerUnit > 0 && Date.now() - tfStatusCache.ts < TF_STATUS_TTL_MS) return tfStatusCache.quotaPerUnit
    try {
      const r = await tfRequest(tfLib.TF_PATH.status, {})
      const q = r.ok && isObj(r.data) ? toNum(r.data.quota_per_unit) : null
      const qpu = q !== null && q > 0 ? q : tfLib.TF_QUOTA_PER_UNIT_FALLBACK
      tfStatusCache = { quotaPerUnit: qpu, ts: Date.now() }
      return qpu
    } catch {
      return tfLib.TF_QUOTA_PER_UNIT_FALLBACK
    }
  }

  // ---- 近 7 天用量汇总（平台 /usage 顶部那几张卡的算法）----
  const tfFetchUsage = async (cookie, uid) => {
    // 窗口与平台 /usage 默认一致（近 7 天）。**不传 granularity**：平台只在非 hour 粒度时
    // 才附带 granularity + offset_seconds，那是给图表分桶用的；我们只要 totals，
    // 而 totals 是窗口内所有行的和，与怎么分桶无关。
    const endSec = Math.floor(Date.now() / 1000)
    const startSec = endSec - TF_USAGE_DAYS * 86400
    let r = null
    try {
      r = await tfRequest(tfLib.TF_PATH.dataSelf + '?start_timestamp=' + startSec + '&end_timestamp=' + endSec, { cookie, uid })
    } catch (err) {
      return { ok: false, error: tfLib.tfErrorText('TF_NET', String((err && err.message) || err)) }
    }
    if (!r.ok) return { ok: false, error: tfLib.tfErrorText(r.code, r.message), authFailed: r.authFailed === true }
    const n = tfLib.tfNormalizeUsageRows(r.data)
    if (!n.ok) return { ok: false, error: '用量响应结构无法识别（接口可能已改版）' }
    return {
      ok: true,
      days: TF_USAGE_DAYS,
      startMs: startSec * 1000,
      endMs: endSec * 1000,
      rowCount: n.rows.length,
      totals: n.totals,
      // 按本地日历日分桶的逐日小计（升序）：账户卡的「近 7 日消耗」柱条与阶跃同画法，
      // 每天一根。**在 host 侧分桶**：平台一次可能回上千行原始行（一行一次调用），
      // 原样下发既费带宽又没意义，面板要的只是「哪天多少」这七个数。
      dayBuckets: tfLib.tfUsageDayBuckets(n.rows),
      // Avg TPM/RPM 的分母（平台口径：max(窗口分钟数, 1)）
      windowMinutes: Math.max((endSec - startSec) / 60, 1),
    }
  }

  // ---- 用户信息（/api/user/self + 近 7 天用量）----
  // 缓存 / 单飞 / 失败回退上次成功值的骨架与 fetchStepPlan 同构（那套已在阶跃线上跑过
  // 一版）：轮询与手动刷新撞一起只打平台一次；平台抽风时下发 stale 值而不是让卡片闪没。
  const tfUserCaches = new Map()
  const tfUserBusy = new Map()
  const fetchTfUser = async (force, identifier) => {
    loadState()
    const acc = pickTfAccount(state.tf, identifier)
    if (acc === null) return { ok: false, code: 'NO_TF_ACCOUNT', error: '未配置清枢智汇账号（面板 → 账户 → 添加账号）' }
    const key = tfSessKey(acc.identifier)
    const hit = tfUserCaches.get(key)
    if (!force && hit && Date.now() - hit.ts < TF_USER_TTL_MS) return { ...hit.data, cached: true, cachedAt: hit.ts }
    const busy = tfUserBusy.get(key)
    if (busy !== undefined) return busy
    const p = (async () => {
      const stale = () => {
        const s = tfUserCaches.get(key)
        return s ? { ...s.data, cached: true, stale: true, cachedAt: s.ts } : null
      }
      const netFail = (err) => ({ ok: false, code: 'TF_NET', error: tfLib.tfErrorText('TF_NET', String((err && err.message) || err)) })
      const sess = await tfEnsureSession(false, identifier)
      if (!sess.ok) return stale() || sess
      const qpu = await tfQuotaPerUnit()
      let live = sess
      let r = null
      try {
        r = await tfRequest(tfLib.TF_PATH.self, { cookie: live.cookie, uid: live.uid })
      } catch (err) {
        return stale() || netFail(err)
      }
      if (r.authFailed) {
        // 401 = 会话真失效（平台没有 refresh 端点）→ 丢掉这枚 cookie，用存好的密码重登
        // 一次再试。**只重试一次**：再 401 就是账号侧的问题（被踢下线/被封），
        // 继续重试只会加深封锁。
        tfClearSess(key)
        const sess2 = await tfEnsureSession(true, identifier)
        if (!sess2.ok) return stale() || sess2
        live = sess2
        try {
          r = await tfRequest(tfLib.TF_PATH.self, { cookie: live.cookie, uid: live.uid })
        } catch (err) {
          return stale() || netFail(err)
        }
      }
      if (!r.ok) return stale() || { ok: false, code: r.code, error: tfLib.tfErrorText(r.code, r.message) }
      const nu = tfLib.tfNormalizeUser(r.data)
      if (!nu.ok) return stale() || { ok: false, code: 'TF_SHAPE', error: '用户信息结构无法识别（接口可能已改版）' }
      // 用量是附加信息：它挂了不影响「用户信息」本身，故单独降级、不让整包失败
      const usage = await tfFetchUsage(live.cookie, live.uid)
      const data = {
        ok: true,
        account: acc.identifier,
        quotaPerUnit: qpu,
        user: nu.user,
        usage: usage.ok ? usage : null,
        usageError: usage.ok ? '' : usage.error,
      }
      tfUserCaches.set(key, { data, ts: Date.now() })
      return { ...data, cached: false }
    })()
    tfUserBusy.set(key, p)
    try { return await p } finally { tfUserBusy.delete(key) }
  }

  // ---- 套餐用量（/api/subscription/self：当前套餐 + 全部订阅）----
  const tfSubCaches = new Map()
  const tfSubBusy = new Map()
  const fetchTfSubscription = async (force, identifier) => {
    loadState()
    const acc = pickTfAccount(state.tf, identifier)
    if (acc === null) return { ok: false, code: 'NO_TF_ACCOUNT', error: '未配置清枢智汇账号（面板 → 账户 → 添加账号）' }
    const key = tfSessKey(acc.identifier)
    const hit = tfSubCaches.get(key)
    if (!force && hit && Date.now() - hit.ts < TF_SUB_TTL_MS) return { ...hit.data, cached: true, cachedAt: hit.ts }
    const busy = tfSubBusy.get(key)
    if (busy !== undefined) return busy
    const p = (async () => {
      const stale = () => {
        const s = tfSubCaches.get(key)
        return s ? { ...s.data, cached: true, stale: true, cachedAt: s.ts } : null
      }
      const netFail = (err) => ({ ok: false, code: 'TF_NET', error: tfLib.tfErrorText('TF_NET', String((err && err.message) || err)) })
      const sess = await tfEnsureSession(false, identifier)
      if (!sess.ok) return stale() || sess
      const qpu = await tfQuotaPerUnit()
      let live = sess
      let r = null
      try {
        r = await tfRequest(tfLib.TF_PATH.subscription, { cookie: live.cookie, uid: live.uid })
      } catch (err) {
        return stale() || netFail(err)
      }
      if (r.authFailed) {
        tfClearSess(key)
        const sess2 = await tfEnsureSession(true, identifier)
        if (!sess2.ok) return stale() || sess2
        live = sess2
        try {
          r = await tfRequest(tfLib.TF_PATH.subscription, { cookie: live.cookie, uid: live.uid })
        } catch (err) {
          return stale() || netFail(err)
        }
      }
      if (!r.ok) return stale() || { ok: false, code: r.code, error: tfLib.tfErrorText(r.code, r.message) }
      const ns = tfLib.tfNormalizeSubscriptions(r.data, Date.now())
      if (!ns.ok) return stale() || { ok: false, code: 'TF_SHAPE', error: '套餐用量结构无法识别（接口可能已改版）' }
      const data = {
        ok: true,
        account: acc.identifier,
        quotaPerUnit: qpu,
        current: ns.current,
        subs: ns.subs,
        count: ns.count,
      }
      tfSubCaches.set(key, { data, ts: Date.now() })
      return { ...data, cached: false }
    })()
    tfSubBusy.set(key, p)
    try { return await p } finally { tfSubBusy.delete(key) }
  }

  // 账号清单（纯读内存，零网络）：带该账号**已缓存**的用户信息/套餐摘要，前端切账号时
  // 卡片立刻有数，不用等一轮请求。明文密码绝不进列表，只给掩码。
  const tfPublicAccounts = () => {
    loadState()
    return state.tf.accounts.map((a) => {
      const key = tfSessKey(a.identifier)
      const uc = tfUserCaches.get(key)
      const sc = tfSubCaches.get(key)
      return {
        identifier: a.identifier,
        // （原先这里还回 addedAt 与 sessionValid 两个字段：前端从来没读过、也不随 add/remove 回传——
        //  addedAt 由 host 自己按 prev.addedAt 续期；会话判定是 host 路由里 tfSessHasCred 的事。）
        pwMask: tfMaskPassword(a.password),
        user: uc ? uc.data.user : null,
        subscription: sc ? sc.data.current : null,
        // 近 7 天用量（该账号最近一次 /tierflow/user 的快照）：面板改成阶跃那套账号卡之后，
        // 用量要摆在**每张卡自己**里（明细块逐日柱条），所以跟着快照一起回；没查过的账号是
        // null（卡上写「未查询」，绝不编 0）。
        usage: uc ? uc.data.usage : null,
        usageError: uc ? (uc.data.usageError || '') : '',
        // 两个快照各自的取数时刻（ms）：卡脚「数据时间 …」用 —— 与阶跃账户卡同一处、
        // 同一含义（那张卡说的是「这些数字是什么时候的」）。取两者里较新的一个。
        userAt: uc ? uc.ts : 0,
        subAt: sc ? sc.ts : 0,
      }
    })
  }
  /**
   * 升级订阅弹窗的数据：**套餐目录 + 「每个生效中的订阅 → 各自还能升哪些档 + 差价」**。
   *
   * 升级是**某个订阅的套餐升级**（平台把这个动作挂在每一条订阅上，原话「仅支持升级到更高价格的
   * 套餐」），所以差价必须按 `sub_no` 逐个问：`GET /api/subscription/upgrade/quote?sub_no&plan_slug`。
   * 面板**只读不猜**——差价是平台的算法（目标套餐价 − 该订阅剩余价值，受 allowance/time 比例与
   * 最低差价限制），这里不拿两个价相减；某档问不通就把平台的原话（或「差价查询失败（网络）」）
   * 放进那一档的 `quoteError`，那一档照常列出来、只是没有差价。
   * 只往上走：先用纯函数 `tfHigherPlans` 把不可能是目标的档滤掉（已在最高档 → 空数组；
   * 这档已下架、目录里查不到 → `null`，退回「把其余档都列出来，让平台自己拒绝」）。
   * 只给**生效中且未过期**的订阅配升级位（过期 / 已取消的该走续费或重买，不是升级）。
   * 与 user / subscription 同套：5 分钟缓存、force=1 穿透、失败退回上一次成功的数据。
   */
  const fetchTfPlans = async (force, identifier) => {
    loadState()
    const acc = pickTfAccount(state.tf, identifier)
    if (acc === null) return { ok: false, code: 'NO_TF_ACCOUNT', error: '未配置清枢智汇账号（面板 → 账户 → 添加账号）' }
    const key = tfSessKey(acc.identifier)
    const hit = tfPlansCaches.get(key)
    if (!force && hit && Date.now() - hit.ts < TF_PLANS_TTL_MS) return { ...hit.data, cached: true, cachedAt: hit.ts }
    const busy = tfPlansBusy.get(key)
    if (busy !== undefined) return busy
    const p = (async () => {
      const stale = () => {
        const s = tfPlansCaches.get(key)
        return s ? { ...s.data, cached: true, stale: true, cachedAt: s.ts } : null
      }
      const netFail = (err) => ({ ok: false, code: 'TF_NET', error: tfLib.tfErrorText('TF_NET', String((err && err.message) || err)) })
      const sess = await tfEnsureSession(false, identifier)
      if (!sess.ok) return stale() || sess
      const qpu = await tfQuotaPerUnit()
      let live = sess
      let r = null
      try {
        r = await tfRequest(tfLib.TF_PATH.plans, { cookie: live.cookie, uid: live.uid })
      } catch (err) {
        return stale() || netFail(err)
      }
      if (r.authFailed) {
        tfClearSess(key)
        const sess2 = await tfEnsureSession(true, identifier)
        if (!sess2.ok) return stale() || sess2
        live = sess2
        try {
          r = await tfRequest(tfLib.TF_PATH.plans, { cookie: live.cookie, uid: live.uid })
        } catch (err) {
          return stale() || netFail(err)
        }
      }
      if (!r.ok) return stale() || { ok: false, code: r.code, error: tfLib.tfErrorText(r.code, r.message) }
      const np = tfLib.tfNormalizePlans(r.data)
      if (!np.ok) return stale() || { ok: false, code: 'TF_SHAPE', error: '套餐列表结构无法识别（接口可能已改版）' }
      // 订阅那份直接复用（同账号同 key，命中缓存就不会再打一次平台）
      const subRes = await fetchTfSubscription(false, identifier)
      const allSubs = subRes && subRes.ok && Array.isArray(subRes.subs) ? subRes.subs : []
      const nowMs = Date.now()
      const liveSubs = allSubs.filter((x) => x.status === 'active' && (x.endTimeMs === null || x.endTimeMs > nowMs))
      const groups = []
      for (const s of liveSubs) {
        // 只把「比这一档贵」的档排进来；目录里查不到这一档（已下架）时 higher 为 null，
        // 那就退回「其余档全列出来」，由平台自己拒绝，不替平台下结论
        const higher = tfLib.tfHigherPlans(np.plans, s.planSlug)
        const candidates = higher === null ? np.plans.filter((p) => p.slug !== s.planSlug) : higher
        const targets = []
        for (const plan of candidates) {
          const qs = '?sub_no=' + encodeURIComponent(s.subNo) + '&plan_slug=' + encodeURIComponent(plan.slug)
          let qr = null
          try {
            qr = await tfRequest(tfLib.TF_PATH.upgradeQuote + qs, { cookie: live.cookie, uid: live.uid })
          } catch (err) {
            qr = null
          }
          const row = { ...plan, quote: null, quoteError: '' }
          if (qr === null) {
            row.quoteError = '差价查询失败（网络）'
          } else if (!qr.ok) {
            row.quoteError = qr.message || tfLib.tfErrorText(qr.code, qr.message)
          } else {
            const nq = tfLib.tfNormalizeQuote(qr.data)
            if (nq.ok) row.quote = nq.quote
            else row.quoteError = '差价结构无法识别'
          }
          targets.push(row)
        }
        const cur = np.plans.filter((p) => p.slug === s.planSlug)[0] || null
        groups.push({
          subNo: s.subNo,
          planSlug: s.planSlug,
          planTitle: s.planTitle,
          statusName: s.statusName,
          daysLeft: s.daysLeft,
          endTimeMs: s.endTimeMs,
          amountTotal: s.amountTotal,
          basicTokenTotal: s.basicTokenTotal,
          unlimitedAmount: s.unlimitedAmount === true,
          planPrice: cur === null ? null : cur.priceAmount,
          planInCatalog: cur !== null,
          targets,
        })
      }
      // 余额快照：确认框要显示「从余额扣多少、扣完还剩多少」。命中 user 缓存时零网络，
      // 查不到就带 null（确认框只说差价，不编余额）。
      const usr = await fetchTfUser(false, identifier)
      const uu = usr && usr.ok && usr.user ? usr.user : null
      const data = {
        ok: true,
        account: acc.identifier,
        quotaPerUnit: qpu,
        plans: np.plans,
        subs: groups,
        balance: uu === null ? null : {
          quota: uu.quota,
          giftQuota: uu.giftQuota,
          expiringQuota: uu.expiringQuota === undefined ? null : uu.expiringQuota,
        },
      }
      tfPlansCaches.set(key, { data, ts: Date.now() })
      return { ...data, cached: false }
    })()
    tfPlansBusy.set(key, p)
    try { return await p } finally { tfPlansBusy.delete(key) }
  }

  /**
   * 余额升级（定稿「查看官方源码的升级套餐原理，我们只用余额升级即可，不使用微信和支付宝」）。
   *
   * 官方的三件事，这里只用前两件：
   *   ① `GET  /api/subscription/upgrade/quote?sub_no&plan_slug`  平台算差价（我们自己不算）
   *   ② `POST /api/subscription/upgrade/balance` `{sub_no, plan_slug}`  从**余额**付款并升级
   *   ③ `POST /api/subscription/upgrade/wechat` + `/wechat/pay`  微信支付（不用，不实现）
   * 请求体是**探出来的**，不是猜的：拿「往更便宜的档升」的请求打过去，平台在扣费之前就被价格
   * 守卫拦下（原话「仅支持升级到更高价格的套餐」），说明字段名就是 `sub_no` + `plan_slug`；
   * 不存在的订阅号回「订阅不存在」、空 body 回「参数错误」——三条都不动账。
   *
   * **两道自保**（真花钱的动作，面板必须比用户更谨慎）：
   *   - 先自己现问一次报价；报价失败（拒绝 / 查不到）就直接回错，**不发付款请求**；
   *   - 客户端把它展示过、并被用户点过确认的差价原样带上来（`expectedDue`），与现问的对不上
   *     （平台改价 / 剩余价值随时间变了）就**不扣款**，回 `TF_UPGRADE_PRICE_CHANGED` 带上新报价，
   *     由用户对着新价再确认一次。
   * 成功后清掉该账号的三份缓存（余额 / 订阅 / 套餐），下一次取数就是升级后的样子。
   */
  const fetchTfUpgrade = async (identifier, subNo, planSlug, expectedDue) => {
    loadState()
    const acc = pickTfAccount(state.tf, identifier)
    if (acc === null) return { ok: false, code: 'NO_TF_ACCOUNT', error: '未配置清枢智汇账号（面板 → 账户 → 添加账号）' }
    if (subNo === '' || planSlug === '') return { ok: false, code: 'TF_UPGRADE_ARGS', error: '缺少订阅号或目标套餐' }
    if (typeof expectedDue !== 'number' || !Number.isFinite(expectedDue)) {
      return { ok: false, code: 'TF_UPGRADE_ARGS', error: '缺少确认过的差价' }
    }
    const key = tfSessKey(acc.identifier)
    let sess = await tfEnsureSession(false, identifier)
    if (!sess.ok) return sess
    const qs = '?sub_no=' + encodeURIComponent(subNo) + '&plan_slug=' + encodeURIComponent(planSlug)
    const readQuote = async (live) => {
      let qr = null
      try {
        qr = await tfRequest(tfLib.TF_PATH.upgradeQuote + qs, { cookie: live.cookie, uid: live.uid })
      } catch (err) {
        return { net: tfLib.tfErrorText('TF_NET', String((err && err.message) || err)) }
      }
      if (qr.authFailed) return { auth: true }
      if (!qr.ok) return { err: qr.message || tfLib.tfErrorText(qr.code, qr.message) }
      const nq = tfLib.tfNormalizeQuote(qr.data)
      if (!nq.ok) return { err: '差价结构无法识别（接口可能已改版）' }
      return { quote: nq.quote }
    }
    let got = await readQuote(sess)
    if (got.auth === true) {
      tfClearSess(key)
      sess = await tfEnsureSession(true, identifier)
      if (!sess.ok) return sess
      got = await readQuote(sess)
    }
    if (got.net !== undefined) return { ok: false, code: 'TF_NET', error: got.net }
    if (got.err !== undefined) return { ok: false, code: 'TF_UPGRADE_QUOTE', error: got.err }
    const quote = got.quote
    if (quote.amountDue === null) return { ok: false, code: 'TF_UPGRADE_QUOTE', error: '平台没给出应付差价', quote }
    if (Math.abs(quote.amountDue - expectedDue) > 0.005) {
      return {
        ok: false,
        code: 'TF_UPGRADE_PRICE_CHANGED',
        error: '差价已变（现为 ¥' + quote.amountDue + '），请对着新价再确认一次',
        quote,
      }
    }
    let r = null
    try {
      r = await tfRequest(tfLib.TF_PATH.upgradeBalance, {
        method: 'POST',
        body: JSON.stringify({ sub_no: subNo, plan_slug: planSlug }),
        cookie: sess.cookie,
        uid: sess.uid,
      })
    } catch (err) {
      return { ok: false, code: 'TF_NET', error: tfLib.tfErrorText('TF_NET', String((err && err.message) || err)), quote }
    }
    if (r.authFailed) {
      tfClearSess(key)
      const s2 = await tfEnsureSession(true, identifier)
      if (!s2.ok) return s2
      try {
        r = await tfRequest(tfLib.TF_PATH.upgradeBalance, {
          method: 'POST',
          body: JSON.stringify({ sub_no: subNo, plan_slug: planSlug }),
          cookie: s2.cookie,
          uid: s2.uid,
        })
      } catch (err) {
        return { ok: false, code: 'TF_NET', error: tfLib.tfErrorText('TF_NET', String((err && err.message) || err)), quote }
      }
    }
    if (!r.ok) return { ok: false, code: 'TF_UPGRADE', error: r.message || tfLib.tfErrorText(r.code, r.message), quote }
    // 成功：三份缓存全清，下次取数直接是升级后的余额 / 订阅 / 套餐
    tfUserCaches.delete(key)
    tfSubCaches.delete(key)
    tfPlansCaches.delete(key)
    return { ok: true, account: acc.identifier, subNo, planSlug, quote, data: r.data === undefined ? null : r.data }
  }

  /**
   * 余额**购买**订阅（定稿「账户的部分添加购买订阅的功能，只能余额买」）。这条取代了此前
   * 升级弹窗里那句「购买 / 续费不在面板里做」——升级仍在套餐用量页，购买搬到账户页的**账号卡**
   * 上（随后又按「不应该是账户的，不要放在最上面」从那一页顶部那条栏挪到每张卡的脚行：入口跟着
   * 卡走，付款账号 = 那张卡的账号，弹窗里不再有账号切换，`identifier` 永远就是「买给谁」）。
   *
   * 官方的两件事，这里都用：
   *   ① `GET  /api/subscription/plans`       现读一份目录（价格 / 上架 / 能不能余额付都以它为准）
   *   ② `POST /api/subscription/balance/pay` `{plan_slug}` 从**余额**下单（官方 zf.js 的 `Ax`）
   * 微信 / 支付宝那条（`/api/subscription/wechat/pay`）不接——用户定稿「只能余额买」。
   * 新购**没有报价接口**（报价是「升级」才有的差价），应付金额就是套餐自己的 `price_amount`。
   *
   * **三道自保**（真花钱的动作，面板必须比用户更谨慎）：
   *   - 现读的目录里查不到这档 / 已停售 → 不发付款请求；
   *   - `allow_balance_pay === false`（平台不让这档用余额付）→ 不发付款请求；
   *   - 客户端展示过、被用户点过确认的价格原样带上来（`expectedPrice`），与现读的对不上
   *     （平台调价）→ 不扣款，回 `TF_PURCHASE_PRICE_CHANGED` 带上新价，让用户对着新价再确认。
   * 余额够不够**不在这里拦**：面板手上的余额是快照，拿它硬拦会在快照旧时挡住正当购买；够不够
   * 由平台判（原话「余额不足」原样透传），面板只把快照当提示写出来。
   * 成功后清掉该账号的三份缓存（余额 / 订阅 / 套餐），下一次取数就是购买后的样子。
   */
  const fetchTfPurchase = async (identifier, planSlug, expectedPrice) => {
    loadState()
    const acc = pickTfAccount(state.tf, identifier)
    if (acc === null) return { ok: false, code: 'NO_TF_ACCOUNT', error: '未配置清枢智汇账号（面板 → 账户 → 添加账号）' }
    if (planSlug === '') return { ok: false, code: 'TF_PURCHASE_ARGS', error: '缺少要购买的套餐' }
    if (typeof expectedPrice !== 'number' || !Number.isFinite(expectedPrice)) {
      return { ok: false, code: 'TF_PURCHASE_ARGS', error: '缺少确认过的价格' }
    }
    const key = tfSessKey(acc.identifier)
    let sess = await tfEnsureSession(false, identifier)
    if (!sess.ok) return sess
    const readCatalog = async (live) => {
      let cr = null
      try {
        cr = await tfRequest(tfLib.TF_PATH.plans, { cookie: live.cookie, uid: live.uid })
      } catch (err) {
        return { net: tfLib.tfErrorText('TF_NET', String((err && err.message) || err)) }
      }
      if (cr.authFailed) return { auth: true }
      if (!cr.ok) return { err: cr.message || tfLib.tfErrorText(cr.code, cr.message) }
      const nc = tfLib.tfNormalizePlans(cr.data)
      if (!nc.ok) return { err: '套餐列表结构无法识别（接口可能已改版）' }
      const plan = nc.plans.filter((p) => p.slug === planSlug)[0]
      if (plan === undefined) return { gone: true }
      return { plan }
    }
    let got = await readCatalog(sess)
    if (got.auth === true) {
      tfClearSess(key)
      sess = await tfEnsureSession(true, identifier)
      if (!sess.ok) return sess
      got = await readCatalog(sess)
    }
    if (got.net !== undefined) return { ok: false, code: 'TF_NET', error: got.net }
    if (got.err !== undefined) return { ok: false, code: 'TF_PURCHASE_CATALOG', error: got.err }
    if (got.gone === true) {
      return { ok: false, code: 'TF_PURCHASE_GONE', error: '平台上已经没有这一档了（' + planSlug + '，可能已下架），没有下单' }
    }
    const plan = got.plan
    const name = plan.title === '' ? plan.slug : plan.title
    if (plan.enabled === false) return { ok: false, code: 'TF_PURCHASE_GONE', error: '「' + name + '」平台已停售，没有下单' }
    if (plan.allowBalancePay === false) {
      return { ok: false, code: 'TF_PURCHASE_NO_BALANCE', error: '「' + name + '」平台不让用余额买（面板只做余额购买），没有下单' }
    }
    if (plan.priceAmount === null) {
      return { ok: false, code: 'TF_PURCHASE_PRICE', error: '平台没给「' + name + '」的价格，面板不猜金额，没有下单' }
    }
    if (Math.abs(plan.priceAmount - expectedPrice) > 0.005) {
      return {
        ok: false,
        code: 'TF_PURCHASE_PRICE_CHANGED',
        error: '价格已变（现为 ¥' + plan.priceAmount + '），请对着新价再确认一次',
        plan,
      }
    }
    let r = null
    try {
      r = await tfRequest(tfLib.TF_PATH.balancePay, {
        method: 'POST',
        body: JSON.stringify({ plan_slug: planSlug }),
        cookie: sess.cookie,
        uid: sess.uid,
      })
    } catch (err) {
      return { ok: false, code: 'TF_NET', error: tfLib.tfErrorText('TF_NET', String((err && err.message) || err)), plan }
    }
    if (r.authFailed) {
      tfClearSess(key)
      const s2 = await tfEnsureSession(true, identifier)
      if (!s2.ok) return s2
      try {
        r = await tfRequest(tfLib.TF_PATH.balancePay, {
          method: 'POST',
          body: JSON.stringify({ plan_slug: planSlug }),
          cookie: s2.cookie,
          uid: s2.uid,
        })
      } catch (err) {
        return { ok: false, code: 'TF_NET', error: tfLib.tfErrorText('TF_NET', String((err && err.message) || err)), plan }
      }
    }
    if (!r.ok) return { ok: false, code: 'TF_PURCHASE', error: r.message || tfLib.tfErrorText(r.code, r.message), plan }
    // 成功：三份缓存全清，下次取数直接是购买后的余额 / 订阅 / 套餐
    tfUserCaches.delete(key)
    tfSubCaches.delete(key)
    tfPlansCaches.delete(key)
    const data = r.data === undefined ? null : r.data
    return {
      ok: true,
      account: acc.identifier,
      planSlug,
      price: plan.priceAmount,
      // 平台会为这份新订阅签发专用密钥（服务协议：「购买订阅套餐后自动签发专用 API 密钥」），
      // 订阅号带出来只是让用户知道去平台「密钥」页找哪一份；面板自己没有密钥页。
      subNo: data !== null && typeof data.sub_no === 'string' ? data.sub_no : null,
      data,
    }
  }

  /** 清掉某账号的全部内存缓存（删账号 / 换密码时用，避免旧身份的残留数据被渲染） */
  const tfDropCaches = (key) => {
    const k = tfSessKey(key)
    if (k === '') return
    tfUserCaches.delete(k)
    tfSubCaches.delete(k)
    tfPlansCaches.delete(k)
    tfLoginAt.delete(k)
  }

  // ================= OpenCSG（opencsg.com · 账户余额 / API 调用量 / 待发放余额） =================
  // 这一家与另外四家最大的不同：**它没有可用的长期凭据**。平台给登录用户发的是一枚
  // 有效期约 1 天的「本地 JWT」（HttpOnly cookie `user_token` 里也是它），所以插件必须在
  // 内存里自己把令牌换出来、过期了再换一次。取证结论（2026 用真账号走 Edge CDP + 门户
  // 产物 + csghub-server 源码逐条坐实，详见 lib/opencsg.js 头部与本地维护手册 §1.1）：
  //
  // ① 鉴权：`Authorization: Bearer <本地JWT>` 是**唯一实测能过的**。cookie 单独发
  //    （`user_token=…`）→ 401 AUTH-ERR-1「用户未找到，请先登录」；`OAuth <本地JWT>` →
  //    401 AUTH-ERR-5「无效的授权请求头」（OAuth 前缀只吃 Casdoor 发的 access token）。
  // ② 令牌从哪来：账号密码 → IAM（Casdoor，iam.opencsg.com）`POST /api/login` → 拿到
  //    Casdoor 令牌 + `casdoor_session_id` cookie → 带这枚 cookie 走授权码那条链
  //    （`/login/oauth/authorize` → 302 `?code=` → 平台回调 `/api/v1/callback/casdoor`
  //    → 302 `Login…?jwt=<本地JWT>`）。**授权码换令牌是服务端做的**（csghub-server 拿
  //    client_secret 找 Casdoor 换），所以插件只需要驱动浏览器那一跳，不需要 secret。
  // ③ 那条链的 client_id / redirect_uri 是**从本机 Edge 历史库里门户自己跳转的 URL 上
  //    逐字读出来的**（`client_id=CSGShip`、`redirect_uri=https://opencsg.com/api/v1/callback/casdoor`、
  //    `scope=read`、`state=casdoor`、`type=code`），不是猜的。成功后平台落在
  //    `https://opencsg.com/server/callback?jwt=…`，jwt 参数就是我们要的本地 JWT。
  // ④ 判成功只看仓内信封（ocLib.ocEnvelope）：成功 `{msg:"OK"}`，失败非 2xx + `{code,msg}`。
  //    **IAM 的信封不一样**（`{status:'ok'|'error', msg, data}`，失败也可能是 HTTP 200），
  //    所以 Casdoor 那一步单独用 ocCasdoorEnvelope 判，别混用。
  // ⑤ 单位：余额系字段一律**分**（balance / composition.bonus / composition.cash /
  //    low_balance_warn），门户自己就是 `e.data.balance/100`。
  // ⑥ 用量：普通用户的 token 报表口 `/accounting/token-report` 是**管理员专属 403**
  //    （AUTH-ERR-6「需要管理员权限」；statements / price / vouchers / recharges /
  //    credit/balance 同样 403），所以「用量」只能来自订阅口的 `usage[]`
  //    （各资源本期已用/配额）。**绝不编 token 数**——拿不到就显示「—」。
  //
  // 凭据规矩与另外四家一致：明文密码只在 host 内存与本机 0600 state 文件，
  // 浏览器任何时候只看到掩码（只有 /account/password 那一条路由会吐明文，且要点眼睛才发）。
  const OC_LOGIN_COOLDOWN_MS = 30 * 1000
  const OC_ACCOUNT_TTL_MS = 5 * 60 * 1000
  // 门户自己用的那个 Casdoor 应用 / 回调 / 作用域（逐字来自 Edge 历史库里的 authorize URL）。
  // 应用名与组织名的取值理由写在 lib/opencsg.js 的 OC_CASDOOR_APP / OC_CASDOOR_ORG 上方：
  // 组织名以前照抄 Casdoor 示例应用的 'built-in'，而本站 `get-app-login` 回的是 'OpenCSG'；
  // Casdoor 服务端拿请求里的 organization **原样**去查人（auth.go L981），传错=查无此人=
  // 和密码错同一句文案——就是「明明账号密码正确 登录不上」。
  const OC_CASDOOR_APP = ocLib.OC_CASDOOR_APP
  const OC_CASDOOR_ORG = ocLib.OC_CASDOOR_ORG
  const OC_CASDOOR_SCOPE = 'read'
  const OC_SSO_STATE = 'casdoor'
  const OC_SSO_REDIRECT = ocLib.OC_BASE + ocLib.OC_PATH.ssoCallback

  /** 闸门：设置 → 系统管理里的 OpenCSG 开关。关掉后所有 /opencsg/* 路由整体不可达。 */
  const ocEnabled = () => systemsOf(state.prefs).oc === true
  const ocDisabledResponse = () => ({ ok: false, code: 'OC_DISABLED', error: 'OpenCSG 未启用：请在「设置 → 系统管理」里勾上 OpenCSG' })

  const ocSessKey = (identifier) => asStr(identifier).trim().toLowerCase()

  /**
   * 会话槽：identifier（小写）→ { token, scheme, uuid, username, savedAt }。
   * 与清枢那套同构（按账号分槽、内存 Map 为准、落盘做冷启动续命），差别只有凭据种类：
   * 清枢存的是 30 天 HttpOnly cookie，这里存的是约 1 天的本地 JWT，所以**过期的槽不装**——
   * 装进去只会让第一次查询白撞一次 401。读不出 exp 的令牌按「未过期」处理（平台的 401 才是准的）。
   */
  const ocSessMap = new Map()
  const ocLoadSessions = () => {
    ocSessMap.clear()
    const saved = isObj(state.oc) && isObj(state.oc.sessions) ? state.oc.sessions : {}
    for (const key of Object.keys(saved)) {
      const s = saved[key]
      if (!isObj(s) || typeof s.token !== 'string' || s.token === '') continue
      if (typeof s.scheme !== 'string' || s.scheme === '') continue
      if (ocLib.ocJwtExpired(s.token)) continue
      ocSessMap.set(key, {
        token: s.token,
        scheme: s.scheme,
        uuid: asStr(s.uuid),
        username: asStr(s.username),
        savedAt: toNum(s.savedAt) ?? Date.now(),
      })
    }
  }
  const ocSaveSessions = () => {
    const out = {}
    for (const [key, s] of ocSessMap) {
      out[key] = { token: s.token, scheme: s.scheme, uuid: s.uuid, username: s.username, savedAt: s.savedAt }
    }
    // 落盘前过一遍净化（池内 + 长度 + 30 天上限），保证写下去的东西与读回来的是同一套规矩
    state.oc.sessions = sanitizeOcSessions(out, state.oc.accounts)
    saveState()
  }
  const ocGetSess = (identifier) => {
    const k = ocSessKey(identifier)
    return k === '' ? null : (ocSessMap.get(k) || null)
  }
  const ocSessHasCred = (identifier) => {
    const s = ocGetSess(identifier)
    return s !== null && typeof s.token === 'string' && s.token !== '' && typeof s.scheme === 'string' && s.scheme !== ''
  }
  const ocApplySession = (identifier, token, scheme, uuid, username) => {
    const k = ocSessKey(identifier)
    if (k === '' || typeof token !== 'string' || token === '' || typeof scheme !== 'string' || scheme === '') return
    ocSessMap.set(k, { token, scheme, uuid: asStr(uuid), username: asStr(username), savedAt: Date.now() })
    ocSaveSessions()
  }
  const ocClearSess = (identifier) => {
    const k = ocSessKey(identifier)
    if (k === '') return
    if (ocSessMap.delete(k)) ocSaveSessions()
  }

  /**
   * 一次 HTTP 往返：吃信封 + 接住 Set-Cookie + （手动重定向时）交出 Location。
   * `redirect:'manual'` 是授权码那条链的命门：Node 的 fetch 在 manual 下**能**读到 302 的
   * Location（实测：type=basic、status=302、location 可见），Safari/Firefox 那套 opaqueredirect
   * 的说法在 undici 上不成立。manual 时不读 body（那是跳转页，没有信封）。
   */
  const ocHttp = async (url, opts) => {
    const o = isObj(opts) ? opts : {}
    const init = {
      method: o.method === 'POST' ? 'POST' : 'GET',
      headers: isObj(o.headers) ? o.headers : {},
      redirect: o.redirect === 'manual' ? 'manual' : 'follow',
    }
    if (typeof o.body === 'string') init.body = o.body
    let res
    try {
      res = await fetchWithTimeout(url, init)
    } catch (err) {
      return { netError: String((err && err.message) || err), status: 0, setCookie: [], location: '', json: null }
    }
    let setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    if (!Array.isArray(setCookie) || setCookie.length === 0) setCookie = res.headers.get('set-cookie') || []
    const location = res.headers.get('location') || ''
    const json = init.redirect === 'manual' ? null : await res.json().catch(() => null)
    return { netError: '', status: res.status, setCookie, location, json }
  }

  /**
   * IAM（Casdoor）信封。**与仓内信封不是一套**：成功 `{status:'ok', data:…}`，
   * 失败 `{status:'error', msg:'密码错误'}` 且 HTTP 常是 200 —— 所以这里绝不能拿
   * ocEnvelope 判（它只看 `code` 字段与 HTTP 码，会把 Casdoor 的失败读成成功）。
   */
  const ocCasdoorEnvelope = (r) => {
    if (r.netError !== '') return { ok: false, code: 'OC_NET', message: r.netError, data: null }
    const j = isObj(r.json) ? r.json : null
    const http = r.status
    const okHttp = http >= 200 && http < 300
    const statusText = j === null ? '' : asStr(j.status)
    const msg = j === null ? '' : asStr(j.msg)
    // 成功判据：HTTP 2xx 且（status 明说 ok，或干脆给了 data 且没说是 error）。
    // 老版本 Casdoor 有的不回 status 字段，只回 data —— 两种都吃。
    const ok = okHttp && j !== null && statusText !== 'error' && (statusText === 'ok' || j.data !== undefined)
    if (ok) return { ok: true, code: '', message: msg, data: j.data }
    return { ok: false, code: 'OC_LOGIN_FAILED', message: msg, data: null }
  }

  /** 仓内 API 一次调用 → ocEnvelope 归一后的 `{ok, code, message, data, authFailed}`。 */
  const ocApi = async (method, path, opts) => {
    const o = isObj(opts) ? opts : {}
    const url = path.startsWith('http') ? path : ocLib.OC_BASE + path
    const headers = ocLib.ocHubHeaders({ token: o.token, scheme: o.scheme })
    let body
    if (o.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(o.body)
    }
    const r = await ocHttp(url, { method, headers, body })
    if (r.netError !== '') return { ok: false, code: 'OC_NET', message: r.netError, data: null, status: 0, authFailed: false }
    return ocLib.ocEnvelope(r.status, r.json)
  }

  /**
   * 拿一枚候选令牌去问平台「这枚令牌你认不认」。**用邀请口当探针**：
   * ① 它不需要预先知道 uuid（余额口与账单口都要 uuid 才能拼 URL），
   * ② 它本来就是卡片要的一个读数（待发放余额），探测顺带把数据取回来，不白跑一趟，
   * ③ 它是门户 `/profile/invite/ali` 那个普通用户页面用的口，正常账号必有权。
   *
   * 以前探的是 `/accounting/subscriptions/status?sku_type=1`：那条口随「不需要套餐」一起退场，
   * 而它当时唯一的额外价值 `data.user_uuid` 在本地 JWT 的 claims 里本来就有同值的 `uuid`
   * （实测），所以这里改读 claims —— 少依赖一个随时可能改版的业务口。
   * 判据仍是 `env.ok`（**403 不算通过**）：这是「登录链上验令牌」的语义，宁可判不通过、
   * 让链条走到下一种方案，也不要拿一枚其实没权限的令牌去当会话；而「取数据」那边的
   * 403 是另一套语义（见 ocSessRejected / ocFetchAccountWith）。
   */
  const ocProbeToken = async (token, scheme) => {
    const env = await ocApi('GET', ocLib.OC_PATH.invitations, { token, scheme })
    if (!env.ok) return { ok: false, code: env.code, message: env.message, authFailed: env.authFailed === true, status: env.status }
    const claims = ocLib.ocJwtClaims(token) || {}
    return {
      ok: true,
      // uuid 只剩 claims 一个来源。为什么必须尽力拿到它：余额口与账单口都要拿 uuid 拼 URL
      // （`/accounting/credit/{uuid}/balance`、`…/{uuid}/bills`），拿不到就只能整个不问，
      // 于是三个读数全变「—」而界面上一个错误都看不到 —— 所以下游 fetchOcAccountWith 里还有
      // 一手「问 /api/v1/user/{username} 要 uuid」的兜底。
      uuid: asStr(claims.uuid),
      // 本地 JWT 的 claims 里 `current_user` 就是平台用户名（实测），uuid 也有；
      // Casdoor 令牌没有这两个字段（它的 `name` 是用户名），那就留空、让下游去补。
      username: asStr(claims.current_user) || asStr(claims.name) || asStr(claims.preferred_username),
    }
  }

  /**
   * 这次失败是不是「会话/令牌被平台拒了」（要清槽重登）？
   *
   * **只看 401，不看 403**：实测两种无效令牌（完全不带 Authorization、前缀写成 OAuth）回的都是
   * 401（`AUTH-ERR-1` / `AUTH-ERR-5`）；而 403 是「令牌有效但你没这个权限」——鉴权在授权之前，
   * 能走到 403 说明身份已经被认出来了。拿 403 触发重登，等于把一次「缺权限」刷成一次白重登
   * （还要多打一次 Casdoor 登录）。
   *
   * 这一条对本插件尤其要紧：账单口 `/credit/{uuid}/bills` 与邀请口 `/invitations` 都**还没有
   * 用真实账号验过**。万一它们对普通用户回 403，卡片必须照旧把能拿到的读数显示出来，
   * 而不是整张卡变成错误、更不是把好端端的会话清掉。
   */
  const ocSessRejected = (env) => env !== null && typeof env === 'object' && env.status === 401

  /**
   * 账号密码 → 本地 JWT。三步按「代价从小到大」排：
   *   ① Casdoor 账号密码登录（匿名口，凭据在 body）
   *   ② 拿 Casdoor 令牌直接试两种前缀（OAuth / Bearer）——**可能直接成功**，
   *      那样就完全不需要浏览器那条链（这也是唯一一条纯 Node 能走完的路）
   *   ③ 授权码链：带 casdoor_session_id 去 authorize 拿 code，再走平台回调换本地 JWT
   * 全部失败 → `OC_NO_TOKEN`（**绝不静默、绝不落回基元余额**），错误里带上平台原话。
   */
  const ocLogin = async (identifier, password) => {
    // ① Casdoor 账号密码登录。**组织名要逐个试**：Casdoor 拿请求里的 organization 原样查人
    //    （auth.go L981 → GetUserByFields 每个字段都按 organization 过滤），而它对「这个组织里
    //    查无此人」和「密码错」回的是同一句话，我们无法从报文上区分——所以把坐实的主组织放第一，
    //    兜底组织跟在后面。网络层错误直接返回（换组织解决不了网络问题）；凭据被拒才换下一个。
    const orgs = ocLib.ocCasdoorOrgCandidates(OC_CASDOOR_ORG)
    let iamEnv = null
    let iam = null
    let lastMsg = ''
    for (const org of orgs) {
      iam = await ocHttp(ocLib.OC_IAM + ocLib.OC_PATH.casdoorLogin, {
        method: 'POST',
        headers: ocLib.ocIamHeaders(),
        body: ocLib.ocLoginBody(identifier, password, { application: OC_CASDOOR_APP, organization: org }),
      })
      iamEnv = ocCasdoorEnvelope(iam)
      if (iamEnv.ok) break
      if (iamEnv.code === 'OC_NET') return { ok: false, code: 'OC_NET', error: '连不上登录服务（iam.opencsg.com）：' + iamEnv.message }
      lastMsg = iamEnv.message
      iamEnv = null
    }
    if (iamEnv === null || iam === null) {
      const tried = orgs.length > 1 ? '（已按 ' + orgs.join('、') + ' 逐个试过）' : ''
      return { ok: false, code: 'OC_LOGIN_FAILED', error: ocLib.ocErrorText('OC_LOGIN_FAILED', lastMsg) + tried }
    }
    const casdoorToken = typeof iamEnv.data === 'string' ? iamEnv.data.trim() : ''
    const iamCookie = ocLib.ocCookieFromSetCookie(iam.setCookie)

    // ② Casdoor 令牌直接当平台令牌使（前缀按实测候选顺序：OAuth 是平台源码里那条分支）
    if (casdoorToken !== '') {
      for (const scheme of ocLib.OC_AUTH_SCHEMES) {
        const probe = await ocProbeToken(casdoorToken, scheme)
        if (probe.ok) return { ok: true, token: casdoorToken, scheme, uuid: probe.uuid, username: probe.username }
      }
    }

    // ③ 授权码链。参数与顺序照抄门户自己那条 URL（便于和服务端日志逐字对照）
    const authorizeUrl = ocLib.OC_IAM + ocLib.OC_PATH.casdoorAuthorize + '?' + [
      'response_type=code',
      'client_id=' + encodeURIComponent(OC_CASDOOR_APP),
      'redirect_uri=' + encodeURIComponent(OC_SSO_REDIRECT),
      'scope=' + encodeURIComponent(OC_CASDOOR_SCOPE),
      'state=' + encodeURIComponent(OC_SSO_STATE),
      'type=code',
    ].join('&')
    const headers = ocLib.ocHubHeaders({})
    if (iamCookie !== '') headers.cookie = iamCookie
    const codeRes = await ocHttp(authorizeUrl, { headers, redirect: 'manual' })
    if (codeRes.netError !== '') return { ok: false, code: 'OC_NET', error: '授权跳转失败：' + codeRes.netError }
    const code = ocLib.ocCodeFromRedirect(codeRes.location)
    if (code === '') {
      // 没拿到 code：要么 cookie 没被 IAM 认（会回登录页 200），要么 IAM 直接报了错。
      // 平台的原话（error_message / error）比我们自己编的更有用，能取到就带上。
      const iamMsg = ocLib.ocRedirectParam(codeRes.location, 'error_message') || ocLib.ocRedirectParam(codeRes.location, 'error')
      const why = iamMsg !== '' ? iamMsg : (codeRes.status === 200 ? 'IAM 没有认下这枚会话 cookie（回到了登录页）' : 'HTTP ' + codeRes.status + '，没有 Location 里的授权码')
      return {
        ok: false,
        code: 'OC_NO_TOKEN',
        error: '登录成功但没换到平台令牌：' + why + (codeRes.status === 200 && iamCookie === '' ? '；IAM 也没有下发会话 cookie' : ''),
      }
    }
    const cbRes = await ocHttp(ocLib.OC_BASE + ocLib.OC_PATH.ssoCallback + '?code=' + encodeURIComponent(code) + '&state=' + encodeURIComponent(OC_SSO_STATE), { headers: ocLib.ocHubHeaders({}), redirect: 'manual' })
    if (cbRes.netError !== '') return { ok: false, code: 'OC_NET', error: '平台回调失败：' + cbRes.netError }
    const jwt = ocLib.ocTokenFromRedirect(cbRes.location)
    if (jwt === '') {
      const cbMsg = ocLib.ocRedirectParam(cbRes.location, 'error_message') || ocLib.ocRedirectParam(cbRes.location, 'error')
      return { ok: false, code: 'OC_NO_TOKEN', error: '授权码换令牌失败：' + (cbMsg !== '' ? cbMsg : 'HTTP ' + cbRes.status + '（回调没有回 jwt 参数）') }
    }
    const probe = await ocProbeToken(jwt, 'Bearer')
    if (!probe.ok) {
      return { ok: false, code: 'OC_NO_TOKEN', error: '换到的令牌平台不认：' + ocLib.ocErrorText(probe.code, probe.message) }
    }
    return { ok: true, token: jwt, scheme: 'Bearer', uuid: probe.uuid, username: probe.username }
  }

  /**
   * 保证某账号有可用会话。`identifier` 省略 → 当前活跃账号。
   *
   * **三步的顺序是有讲究的（「刷新 ≠ 重登」修复）**：① 先看有没有可复用的会话 → ② 才看冷却 → ③ 才真登录。
   * 旧实现是「先看冷却、再看会话」，而且多一个 `force` 参数会在 `force=true` 时**连令牌一起丢掉**，
   * 于是「刷新」这条路上有两个毛病：
   *   ① 每次点刷新都带着密码去 Casdoor 重登一次——凭据被反复发送，却一个字节的新信息都没换到；
   *   ② 卡片刷新（显式带 identifier）在 30 秒内会拿到 `OC_COOLDOWN`，把一张**本来有有效令牌**
   *      的卡当场顶掉——冷却挡的是用户连点，不该挡「读缓存」。
   * 令牌被平台提前作废（改密码 / 踢下线）由 fetchOcAccount 的 401/403 自愈段兜住：
   * 清槽 → 回到这里重登一次 → 重放。所以**不需要**用 force 去「碰运气重登」。
   * 冷却只在「真要发登录请求」且「显式指定了账号」（用户连点换账号）时生效。
   */
  const ocLoginAt = new Map()
  const ocEnsureSession = async (identifier) => {
    const acc = pickOcAccount(state.oc, identifier)
    if (acc === null) {
      return { ok: false, code: 'NO_OC_ACCOUNT', error: state.oc.accounts.length === 0 ? '还没有 OpenCSG 账号（面板 → 账户 → 添加账号）' : '指定的 OpenCSG 账号不存在' }
    }
    const key = ocSessKey(acc.identifier)
    const explicit = identifier !== undefined && identifier !== null && asStr(identifier) !== ''
    const sess = ocGetSess(acc.identifier)
    if (sess !== null && !ocLib.ocJwtExpired(sess.token)) return { ok: true, acc, sess, loggedIn: false }
    if (explicit) {
      const wait = OC_LOGIN_COOLDOWN_MS - (Date.now() - (ocLoginAt.get(key) || 0))
      if (wait > 0) return { ok: false, code: 'OC_COOLDOWN', error: '登录尝试过于频繁，约 ' + Math.ceil(wait / 1000) + ' 秒后自动重试（无需连点）' }
    }
    ocLoginAt.set(key, Date.now())
    const r = await ocLogin(acc.identifier, acc.password)
    if (!r.ok) return { ok: false, code: r.code, error: r.error }
    ocApplySession(acc.identifier, r.token, r.scheme, r.uuid, r.username)
    return { ok: true, acc, sess: ocGetSess(acc.identifier), loggedIn: true }
  }

  /**
   * 用一枚已确认可用的会话把卡片的三个读数拉齐：**账户余额 / API 调用量 / 待发放余额**。
   * （用户定案：卡片只说这三件事，且**不要套餐**——订阅那一层整体不取了。）
   *
   * 顺序有讲究：**先问邀请口**，因为它既是「待发放余额」的读数、又是本账号的授权探针：
   * 它 `ok` 与否直接告诉我们这枚令牌还能不能用，而它不需要先知道 uuid。
   * 之后才补身份（昵称 / 实名 / uuid 兜底），最后才是要拼 uuid 的余额口与账单口。
   *
   * 失败**互不牵连**（这是本函数的设计要点，与「一个口查不到就整张卡报错」相反）：
   *   · 401（会话被拒）→ 立刻整次失败，交调用方清槽重登（`authFailed:true`）；
   *   · 403（令牌有效但没这个权限）/ 5xx / 结构不认识 → 只是**那一个读数**变 null，
   *     另外两个照常显示。账单口与邀请口都还没用真实账号验过，界面不能因为其中一个
   *     缺权限就整张卡变红。
   *   · 三个读数**全都**没拿到 → 把第一个失败原因报上去（「三个 — 加一句原因」比光三个「—」有用）。
   */
  const ocFetchAccountWith = async (sess) => {
    let firstFail = null
    const noteFail = (env) => {
      if (firstFail === null) firstFail = env
    }
    // ① 邀请口（待发放余额）
    const invEnv = await ocApi('GET', ocLib.OC_PATH.invitations, { token: sess.token, scheme: sess.scheme })
    if (ocSessRejected(invEnv)) {
      return { ok: false, code: invEnv.code, error: ocLib.ocErrorText(invEnv.code, invEnv.message), authFailed: true }
    }
    let invite = { inviteCode: '', invites: null, totalCreditCents: null, pendingCreditCents: null }
    if (invEnv.ok) invite = ocLib.ocNormalizeInvitations({ msg: invEnv.message, data: invEnv.data })
    else noteFail(invEnv)
    // ② 身份（昵称 / 实名）与 uuid 兜底。为什么兜底是必需的：余额口与账单口都要拿 uuid 拼 URL，
    //    而 uuid 现在只从本地 JWT 的 claims 里来（订阅口退场了）。实测 `/api/v1/user/{name}` 会回
    //    `uuid`（注意：它回的 `uuid` 才是身份标识，`id` 是个数字，别拿错）。
    let uuid = asStr(sess.uuid)
    const username = asStr(sess.username)
    let nickname = ''
    let verifyStatus = null
    if (username !== '') {
      const u = await ocApi('GET', ocLib.OC_PATH.userByName(username), { token: sess.token, scheme: sess.scheme })
      if (u.ok && isObj(u.data)) {
        nickname = asStr(u.data.nickname)
        verifyStatus = toNum(u.data.verify_status)
        if (uuid === '') uuid = asStr(u.data.uuid)
      } else if (ocSessRejected(u)) {
        return { ok: false, code: u.code, error: ocLib.ocErrorText(u.code, u.message), authFailed: true }
      } else if (u.status !== 404) {
        // 404 只是「这个用户名查不到」，不影响读数，不必记成失败原因
        noteFail(u)
      }
    }
    // ③ 余额（有 uuid 才问得动；没有就留 null → 界面显示「—」，不是 ¥0）
    let bal = { balanceCents: null, bonusCents: null, cashCents: null, lowBalanceWarnCents: null }
    if (uuid !== '') {
      const b = await ocApi('GET', ocLib.OC_PATH.balanceOf(uuid), { token: sess.token, scheme: sess.scheme })
      if (b.ok) bal = ocLib.ocNormalizeBalance({ msg: b.message, data: b.data })
      else if (ocSessRejected(b)) return { ok: false, code: b.code, error: ocLib.ocErrorText(b.code, b.message), authFailed: true }
      else noteFail(b)
    }
    // ④ 账单口（API 调用量）：窗口 = 本月 1 号 → 今天，与门户计费区间的初值一致
    const win = ocLib.ocMonthWindow()
    const api = {
      scene: ocLib.OC_BILL_SCENE_API,
      fromDate: win.fromDate,
      toDate: win.toDate,
      apiCount: null,
      valueCents: null,
      rows: [],
    }
    if (uuid !== '') {
      const q = ocLib.ocBillsQuery({ scene: ocLib.OC_BILL_SCENE_API, fromDate: win.fromDate, toDate: win.toDate })
      const b = await ocApi('GET', ocLib.OC_PATH.billsOf(uuid) + '?' + q, { token: sess.token, scheme: sess.scheme })
      if (b.ok) {
        const bills = ocLib.ocNormalizeBills({ msg: b.message, data: b.data })
        api.apiCount = bills.apiCount
        api.valueCents = bills.valueCents
        api.rows = bills.rows
      } else if (ocSessRejected(b)) {
        return { ok: false, code: b.code, error: ocLib.ocErrorText(b.code, b.message), authFailed: true }
      } else {
        noteFail(b)
      }
    }
    // 一个读数都没拿到（且不是会话被拒）→ 报第一个失败原因：面板上「三个 — + 一句为什么」
    // 比「三个 —」有用得多。注意 0 是有效值（`invites:0` / `pending:0` 都算拿到了）。
    const nothing = bal.balanceCents === null && api.apiCount === null && api.valueCents === null
      && invite.invites === null && invite.pendingCreditCents === null
    if (nothing) {
      const code = firstFail === null ? 'OC_SHAPE' : firstFail.code
      const message = firstFail === null ? '' : firstFail.message
      return { ok: false, code, error: ocLib.ocErrorText(code, message), authFailed: false }
    }
    return {
      ok: true,
      data: {
        uuid,
        username,
        nickname,
        verifyStatus,
        balanceCents: bal.balanceCents,
        bonusCents: bal.bonusCents,
        cashCents: bal.cashCents,
        lowBalanceWarnCents: bal.lowBalanceWarnCents,
        api,
        // 待发放余额（邀请口）。`inviteCode` 留在协议层给排查用，不进浏览器载荷。
        invite: {
          invites: invite.invites,
          totalCreditCents: invite.totalCreditCents,
          pendingCreditCents: invite.pendingCreditCents,
        },
        atMs: Date.now(),
      },
    }
  }

  /**
   * 缓存 / 单飞 / 失败退回上一次成功值（与清枢 fetchTfUser 同构）。
   * 401/403 那次**再自愈一次**：清槽 → 用存的密码重登 → 重放。会话过期是常态
   * （令牌只有约 1 天），没有这一段，面板每天第一次打开都会红一次。
   */
  const ocAccountCaches = new Map()
  const ocInFlight = new Map()
  const ocDropCaches = (identifier) => {
    const k = ocSessKey(identifier)
    if (k === '') return
    ocAccountCaches.delete(k)
    ocLoginAt.delete(k)
  }
  const fetchOcAccount = async (force, identifier) => {
    const acc = pickOcAccount(state.oc, identifier)
    if (acc === null) {
      return { ok: false, code: 'NO_OC_ACCOUNT', error: state.oc.accounts.length === 0 ? '还没有 OpenCSG 账号（面板 → 账户 → 添加账号）' : '指定的 OpenCSG 账号不存在' }
    }
    const key = ocSessKey(acc.identifier)
    const hit = ocAccountCaches.get(key)
    if (force !== true && hit !== undefined && Date.now() - hit.ts < OC_ACCOUNT_TTL_MS) {
      return { ok: true, data: hit.data, cached: true }
    }
    const running = ocInFlight.get(key)
    if (running !== undefined) return running
    const task = (async () => {
      try {
        // force 只绕过「5 分钟数据缓存」，不再牵动令牌（见 ocEnsureSession 的顺序说明）
        let ens = await ocEnsureSession(identifier)
        if (!ens.ok) {
          // 有旧数据就不必把一次失败摊在界面上（缓存是 5 分钟，这期间照旧显示上次的数）
          return hit === undefined ? { ok: false, code: ens.code, error: ens.error } : { ok: true, data: hit.data, cached: true, stale: true, error: ens.error }
        }
        let snap = await ocFetchAccountWith(ens.sess)
        if (!snap.ok && snap.authFailed === true && typeof ens.acc.password === 'string' && ens.acc.password !== '') {
          ocClearSess(ens.acc.identifier)
          // 槽已清空 → 这里必然走真登录（不是靠 force 重登）
          ens = await ocEnsureSession(ens.acc.identifier)
          if (ens.ok) snap = await ocFetchAccountWith(ens.sess)
        }
        if (!snap.ok) {
          return hit === undefined ? { ok: false, code: snap.code, error: snap.error } : { ok: true, data: hit.data, cached: true, stale: true, error: snap.error }
        }
        ocAccountCaches.set(key, { data: snap.data, ts: Date.now() })
        if (asStr(snap.data.username) !== '' && !ocLib.ocJwtExpired(ens.sess.token)) {
          // 顺手把槽里的身份补齐（重登换的新 token 可能带来了用户名）
          const cur = ocGetSess(ens.acc.identifier)
          if (cur !== null && (cur.uuid !== asStr(snap.data.uuid) || cur.username !== asStr(snap.data.username))) {
            ocApplySession(ens.acc.identifier, cur.token, cur.scheme, snap.data.uuid, snap.data.username)
          }
        }
        return { ok: true, data: snap.data, loggedIn: ens.loggedIn === true }
      } finally {
        ocInFlight.delete(key)
      }
    })()
    ocInFlight.set(key, task)
    return task
  }

  /** 账号清单（纯读内存，零网络）：带该账号**已缓存**的快照，前端切账号时卡片立刻有数。 */
  const ocPublicAccounts = () => {
    loadState()
    return state.oc.accounts.map((a) => {
      const c = ocAccountCaches.get(ocSessKey(a.identifier))
      return {
        identifier: a.identifier,
        pwMask: ocMaskPassword(a.password),
        // 快照 + 取数时刻：卡片与页首三读数都吃这一份（与清枢 publicAccounts 同款）
        account: c === undefined ? null : c.data,
        at: c === undefined ? 0 : c.ts,
      }
    })
  }

  // ================= ZCode 桌面端（额度展示） =================
  // 移植自 zcode-switch v1.5.4（MIT）：读 ~/.zcode/v2 的凭证文件、按 ZCode 桌面端
  // 同款请求头直连官方接口。凭据/token/user_id 只在 host 内存，浏览器只见掩码。
  // 注意：.zcode 属于 ZCode 客户端，与 DSH 目录无关，永远用真实 HOME。
  // ZCode 集成总开关：systems.zcode === true（老存档看 prefs.zcode）才允许读
  // ~/.zcode/v2 凭证/发上游请求。插件面向所有用户发放，默认关闭，设置弹窗里显式开启。
  const zcodeEnabled = () => {
    loadState()
    return systemsOf(state.prefs).zcode
  }
  const zcodeDisabledResponse = () => ({ ok: false, code: 'ZCODE_DISABLED', error: 'ZCode 集成未开启（设置 → 系统管理）' })
  const zcodeHomeDir = () => (typeof process.env.HOME === 'string' && process.env.HOME !== '' ? process.env.HOME : os.homedir())
  // 凭证文件跟随 ZCode 数据目录（zcode-switch v1.6.0 同款解析，见 zc.resolveDataRoot）。
  // 解密密钥仍由真实 home 推导（ZCode 客户端语义，与数据目录无关）。
  let zcodeDataRootCache = { home: '', root: '' }
  const zcodeDataRoot = () => {
    const home = zcodeHomeDir()
    if (zcodeDataRootCache.home !== home) {
      zcodeDataRootCache = { home, root: zc.resolveDataRoot(home) }
    }
    return zcodeDataRootCache.root
  }
  const zcodeV2File = (name) => join(zcodeDataRoot(), '.zcode', 'v2', name)
  const readZcodeJson = (name) => {
    const text = readTextSafe(zcodeV2File(name))
    if (text.trim() === '') return null
    try { return JSON.parse(text) } catch { return null }
  }
  const zcodeDeviceMid = () => {
    const t = readZcodeJson('telemetry-state.json')
    return t !== null && isObj(t) && typeof t.deviceMid === 'string' && t.deviceMid !== '' ? t.deviceMid : null
  }
  // 统一上游请求：按 URL 域选头（z.ai = 桌面端九件套伪装，bigmodel = 精简三件套）。
  // noAuth: 事件上报 Rust 版只带 Content-Type；emptyAuth: 验证码配置带空 Bearer。
  const zcFetchJson = async (url, token, mid, opts) => {
    const o = opts || {}
    const base = o.noAuth === true ? [] : (url.includes('zcode.z.ai') ? zc.zaiHeaders(token, mid) : zc.bigmodelHeaders(token))
    const headers = { ...Object.fromEntries(base), ...(o.headers || {}) }
    if (o.noAuth === true) headers['Content-Type'] = 'application/json'
    const res = await fetchWithTimeout(url, {
      method: o.method || 'GET',
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    })
    const text = await res.text().catch(() => '')
    let json = null
    if (text !== '') { try { json = JSON.parse(text) } catch { json = null } }
    return { status: res.status, json }
  }
  const zcodeErrMsg = (r, fallback) => {
    if (r !== null && isObj(r.json)) {
      const code = typeof r.json.code === 'number' ? r.json.code : null
      const msg = ['msg', 'message', 'error'].map((k) => (typeof r.json[k] === 'string' ? r.json[k] : '')).find((s) => s !== '') || ''
      if (code === 401) return 'Token 已过期或无效'
      if (msg !== '') return msg
      if (code !== null) return '上游业务错误 ' + code
    }
    return fallback
  }
  // 额度查询：单 token 双通道（bigmodel monitor → 失败回退 z.ai billing），
  // 与 zcode-switch query_with_token 同构。
  const zcodeQueryWithToken = async (token, mid) => {
    let bestErr = null
    try {
      const limit = await zcFetchJson(zc.QUOTA_LIMIT_URL, token, mid)
      if (limit.json !== null && zc.businessOk(limit.json)) {
        const sub = await zcFetchJson(zc.SUBSCRIPTION_URL, token, mid).catch(() => null)
        const ov = zc.normalizeQuotaLimit(limit.json, sub !== null ? sub.json : null)
        ov.source = 'bigmodel.cn/api/monitor'
        return ov
      }
      bestErr = zcodeErrMsg(limit, 'bigmodel 额度接口返回不可解析')
    } catch (err) {
      bestErr = String((err && err.message) || err)
    }
    try {
      const bal = await zcFetchJson(zc.BILLING_BALANCE_URL + '?app_version=' + encodeURIComponent(zc.zcodeAppVersion()), token, mid)
      if (bal.json !== null && zc.businessOk(bal.json)) {
        const ov = zc.normalizeBalance(bal.json)
        ov.source = 'zcode.z.ai/billing'
        return ov
      }
      // 端点不匹配的 401 不应掩盖 bigmodel 侧的业务错（对齐 zcode-switch 用例）：
      // z.ai 侧只有在还没拿到任何错误时才补位。
      if (bestErr === null) {
        bestErr = zcodeErrMsg(bal, 'z.ai 余额接口返回不可解析')
      }
    } catch (err) {
      if (bestErr === null) bestErr = String((err && err.message) || err)
    }
    throw new Error(bestErr || '额度查询失败')
  }
  // 多通道合并（mergeParts 简化版）：跨源同 tier+name 的切片去重，顶层取最高档切片。
  const zcodeMergeParts = (parts) => {
    if (parts.length === 1) return parts[0]
    const slots = []
    const slotSrc = []
    const sources = []
    for (const p of parts) {
      if (!sources.includes(p.source)) sources.push(p.source)
      for (const s of (Array.isArray(p.slots) ? p.slots : [])) {
        const dup = slots.some((t, i) => slotSrc[i] !== p.source && t.tier === s.tier && t.name === s.name
          && (t.items || []).length > 0 && (s.items || []).length > 0)
        if (!dup) { slots.push(s); slotSrc.push(p.source) }
      }
    }
    const items = slots.flatMap((s) => s.items || [])
    let pri = null
    for (const s of slots) {
      const has = s.tier !== null || (s.items || []).length > 0 || s.total !== null
      if (!has) continue
      if (pri === null || zc.tierRankOf(s.tier) > zc.tierRankOf(pri.tier)) pri = s
    }
    return {
      source: sources.join(' + '),
      planTier: pri ? pri.tier : null,
      planExpire: pri ? pri.expire : null,
      total: pri ? pri.total : null,
      used: pri ? pri.used : null,
      remaining: pri ? pri.remaining : null,
      percentUsed: pri ? pri.percentUsed : null,
      isEmpty: slots.length === 0,
      items,
      slots,
    }
  }
  const ZCODE_QUOTA_TTL_MS = 60 * 1000
  let zcodeQuotaCache = null
  let zcodeQuotaBusy = null
  // 全量额度：优先按 config 的 provider 段建双通道（start-plan → z.ai billing，
  // coding-plan → bigmodel monitor），没有通道再退 candidate tokens 逐个试。
  const fetchZcodeQuota = async (force) => {
    if (!force && zcodeQuotaCache !== null && Date.now() - zcodeQuotaCache.ts < ZCODE_QUOTA_TTL_MS) {
      return { ok: true, ...zcodeQuotaCache.data, cached: true }
    }
    if (zcodeQuotaBusy !== null) return zcodeQuotaBusy
    zcodeQuotaBusy = (async () => {
      const creds = readZcodeJson('credentials.json')
      if (creds === null || !isObj(creds)) {
        return { ok: false, code: 'NO_CREDENTIALS', error: '未找到 ZCode 登录凭证（' + zcodeV2File('credentials.json') + ' 不存在或不可读）' }
      }
      const config = readZcodeJson('config.json')
      const mid = zcodeDeviceMid()
      const secret = zc.defaultSecret(zcodeHomeDir())
      const identity = zc.identityFromCredentials(creds, secret)
      const parts = []
      let sawNoPlan = false
      let bestErr = null
      const tryOnce = async (fn) => {
        try { parts.push(await fn()) } catch (err) {
          const msg = String((err && err.message) || err)
          if (msg.includes('不存在coding plan') || msg.includes('没有资格')) sawNoPlan = true
          else if (bestErr === null) bestErr = msg
        }
      }
      // 通道构造（pick_channels 移植）：enabled 优先排序。
      if (config !== null && isObj(config) && isObj(config.provider)) {
        const ordered = Object.entries(config.provider)
          .sort(([, a], [, b]) => (isObj(b) && b.enabled === true ? 0 : 1) - (isObj(a) && a.enabled === true ? 0 : 1))
        for (const [pid, p] of ordered) {
          const apiKey = isObj(p) && isObj(p.options) && typeof p.options.apiKey === 'string'
            && !p.options.apiKey.startsWith('enc:') && zc.looksLikeToken(p.options.apiKey) ? p.options.apiKey : null
          if (pid.includes('start-plan')) {
            const jwt = zc.decryptCredential(creds.zcodejwttoken, secret)
            const active = zc.decryptCredential(creds['oauth:active_provider'], secret)
            const useJwt = pid.startsWith('builtin:zai') ? jwt !== null : (jwt !== null && active === 'bigmodel')
            const tok = (useJwt ? jwt : null) || apiKey
            if (tok !== null) await tryOnce(() => zcodeQueryWithToken(tok, mid))
          } else if (pid.includes('coding-plan') && apiKey !== null) {
            await tryOnce(() => zcodeQueryWithToken(apiKey, mid))
          }
        }
      }
      if (parts.length === 0) {
        const tokens = zc.candidateTokens(creds, config, secret)
        for (const tok of tokens) {
          const before = parts.length
          await tryOnce(() => zcodeQueryWithToken(tok, mid))
          if (parts.length > before) break
        }
      }
      if (parts.length === 0) {
        if (sawNoPlan) return { ok: true, source: 'no_plan', planTier: null, planExpire: null, total: null, used: null, remaining: null, percentUsed: null, isEmpty: true, items: [], slots: [], fetchedAt: Date.now() }
        return { ok: false, code: 'QUOTA_FAIL', error: bestErr || '额度查询失败（没有可用的 token 候选）' }
      }
      const data = zcodeMergeParts(parts)
      data.fetchedAt = Date.now()
      data.identity = {
        provider: identity.provider,
        name: identity.displayName || identity.username || identity.email || null,
      }
      data.deviceLinked = mid !== null
      zcodeQuotaCache = { data, ts: Date.now() }
      return { ok: true, ...data }
    })()
    try { return await zcodeQuotaBusy } finally { zcodeQuotaBusy = null }
  }
  // ---- 账号管理（zcode-switch store.rs 热切换语义移植）----
  // 快照 = {credentials, config, deviceMid}。凭据值本身是 ZCode 客户端的 enc:v1
  // 密文，快照只落本机 0600 state 文件。切换 = 原子覆写 live 文件 + 读回校验身份
  // （zcode-switch 的 hot_switch：不杀进程，客户端下次请求时生效）。


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
        // 实名徽章数据源（0.6.2）：开面板即有——余额页页首与设置页当前账号行的首帧
        // 从这里兜底，余额路由每 60s 轮询带新值。放 relogin 之后：重登换的新 cookie
        // 直接用；失败/无会话 → null（徽章不渲染，宁缺不编）。
        const realname = state.cookie !== '' ? await fetchRealname(state.cookie) : null
        writeJson(res, {
          ok: true,
          version: PKG_VERSION,
          // 启用的系统随 manifest 一起回（客户端首包播种 provider 要用，别等 /prefs 那一包）
          systems: systemsOf(state.prefs),
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
          session: { configured: state.cookie !== '', valid: probe.valid, hint: maskSecret(state.cookie), account: sessionAccount || null, accountName: meName || null, realname },
          step: {
            configured: state.step.accounts.length > 0,
            account: state.step.activeAccount || null,
            // 验活只问当期活跃账号自己那条会话（别的账号会话并存，与此无关）
            session: (() => {
              const act = state.step.activeAccount || ''
              const s = act === '' ? null : stepGetSess(act)
              return (s !== null && stepSessHasCred(act)) ? { valid: true, expAt: s.expAt, source: s.source } : { valid: false }
            })(),
            prefs: state.step.prefs,
            accounts: stepPublicAccounts(),
          },
          tf: {
            configured: state.tf.accounts.length > 0,
            account: state.tf.activeAccount || null,
            // 验活只问当期活跃账号自己那条会话（别的账号会话分槽并存，与此无关）。
            // 与阶跃不同：这里只判「有没有 cookie」——session 是 HttpOnly 长寿命 cookie，
            // 平台没给到期时间，真失效只能靠 401 撞出来（见 fetchTfUser 的重登分支）。
            session: (() => {
              const act = state.tf.activeAccount || ''
              return { valid: act !== '' && tfSessHasCred(act) }
            })(),
            accounts: tfPublicAccounts(),
          },
          oc: {
            configured: state.oc.accounts.length > 0,
            account: state.oc.activeAccount || null,
            // 验活：有没有令牌 + 令牌有没有过期（本地 JWT 自带 exp，能提前判出来；
            // 读不出 exp 的算未过期，最终以平台的 401 为准，见 fetchOcAccount 的自愈分支）。
            session: (() => {
              const act = state.oc.activeAccount || ''
              if (act === '' || !ocSessHasCred(act)) return { valid: false }
              const s = ocGetSess(act)
              return { valid: s !== null && !ocLib.ocJwtExpired(s.token), expAt: s === null ? null : (ocLib.ocJwtExpMs(s.token) || null) }
            })(),
            accounts: ocPublicAccounts(),
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

        // 峰谷分时计价表：公开接口、与模型列表解耦，五种成功路径都随响应下发，
        // 客户端按模型 ID 查表决定要不要画「峰谷」徽章。拉取失败只丢徽章，不丢列表。
        // 先发起 Promise 不 await：与下面的模型列表拉取并发，不为峰谷表多付一次串行
        // 延迟（两个接口各自 15s 超时，串行最坏要等 30s）。
        const schedP = fetchPriceSchedules()
        const withSched = async (payload) => {
          const sched = (await schedP) || { schedules: {}, asOf: '' }
          return { ...payload, schedules: sched.schedules, schedulesAsOf: sched.asOf }
        }

        // 首选平台模型列表（/api/models，会话 Cookie）：带分类/模态/显示名。
        // 401（会话过期）或失败时静默回退到网关 /v1/models（API Key，无分类）。
        loadState()
        if (state.cookie !== '') {
          const hit = modelsCache.get(provider.id)
          if (hit !== undefined && hit.source === 'platform' && Date.now() - hit.ts < MODELS_TTL_MS) {
            writeJson(res, await withSched({ ok: true, provider: provider.id, models: hit.models, cached: true, categories: hit.categories, source: 'platform' }))
            return
          }
          try {
            const res2 = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/models', { headers: { Cookie: 'tr_session=' + state.cookie } })
            if (res2.ok) {
              const models = normalizePlatformModels(await res2.json().catch(() => null))
              const categories = categoryCounts(models)
              modelsCache.set(provider.id, { models, categories, source: 'platform', ts: Date.now() })
              writeJson(res, await withSched({ ok: true, provider: provider.id, models, cached: false, categories, source: 'platform' }))
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
          writeJson(res, await withSched({ ok: true, provider: provider.id, models: hit.models, cached: true, categories: hit.categories, source: 'gateway' }))
          return
        }
        try {
          const models = await fetchUpstreamModels(provider, key)
          modelsCache.set(provider.id, { models, source: 'gateway', ts: Date.now() })
          writeJson(res, await withSched({ ok: true, provider: provider.id, models, cached: false, source: 'gateway' }))
        } catch (err) {
          // 上游失败但有过期缓存：宁可给旧数据也别白屏。
          if (hit !== undefined && hit.source !== 'platform') { writeJson(res, await withSched({ ok: true, provider: provider.id, models: hit.models, cached: true, stale: true, source: 'gateway' })); return }
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


      // 「用量」页签：panel（汇总/按模型/按客户端）+ usage-daily（日历按天）。
      // 合计 2 个上游请求，结果按账号缓存 60s。
      if (pathname === '/dsh-tokenrhythm-bill/usage' && req.method === 'GET') {
        loadState()
        if (state.cookie === '') { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未配置网页会话 Cookie' }); return }
        try {
          const usage = await fetchUpstreamUsage(state.cookie)
          writeJson(res, { ok: true, ...usage, account: state.activeAccount || meAccount.name || null })
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
      // ---- 兑换码（体验卡）：平台 POST /api/auth/exchange-code { code }。
      // 判读口径照抄平台前端自己的 api client（Ar 认信封 / jr 认业务码 / wr 取 data）：
      //   信封 = 含 code 且含 data|message|traceId，或含 data 且含 message|traceId；
      //   业务成功 = code 为 0 / '0' / 200 / '200' / 缺省；
      //   成功取 data 原样交出去，界面按 r.data.quota 取值——和网页端取值路径一致，
      //   不另立字段名、不改写类型（quota 是平台「金额契约」里的固定 8 位小数字符串，
      //   网页端按 wallet mode 渲染 = ¥ + 2 位小数 + ceil）。
      // 失败把平台 message 原样透传（实测无效码 = 400「体验卡无效、已过期或次数已用完」），
      // 不概括、不替平台下结论。平台没有「先校验再兑换」的接口，所以「不可撤销」只写在
      // 界面的确认步里。----
      if (pathname === '/dsh-tokenrhythm-bill/redeem' && req.method === 'POST') {
        const body = await readBody(req)
        const code = body && typeof body.code === 'string' ? body.code.trim().slice(0, 128) : ''
        if (code === '') { writeJson(res, { ok: false, error: '请输入体验卡。' }, 400); return }
        try {
          const up = await trMutate('/api/auth/exchange-code', { method: 'POST', body: JSON.stringify({ code }) })
          if (up === null) { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未登录' }); return }
          if (up.status === 401) { writeJson(res, { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期' }); return }
          const raw = up.body
          const obj = isObj(raw)
          const isEnv = obj && ((('code' in raw) && (('data' in raw) || ('message' in raw) || ('traceId' in raw)))
            || (('data' in raw) && (('message' in raw) || ('traceId' in raw))))
          const envCode = obj ? raw.code : undefined
          const bizOk = envCode === undefined || envCode === 0 || envCode === '0' || envCode === 200 || envCode === '200'
          const platformMsg = obj && typeof raw.message === 'string' && raw.message !== '' ? raw.message : ''
          if (!up.ok || !bizOk) {
            // 平台自己的措辞最准（无效 / 已过期 / 次数用完都在里面），原样交给界面显示。
            writeJson(res, {
              ok: false,
              code: envCode === undefined ? null : envCode,
              error: platformMsg || ('兑换失败（平台 ' + up.status + '）'),
            }, 502)
            return
          }
          const data = isEnv ? raw.data : raw
          if (!isObj(data) || data.quota === undefined || data.quota === null) {
            writeJson(res, { ok: false, error: '平台未返回到账额度' }, 502)
            return
          }
          writeJson(res, {
            ok: true,
            code: 0,
            message: platformMsg || 'ok',
            traceId: obj && typeof raw.traceId === 'string' ? raw.traceId : '',
            data,
          })
        } catch (err) {
          writeJson(res, { ok: false, error: String((err && err.message) || err) }, 502)
        }
        return
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

      // ---- /model-check 批量连通检测：真实 1-token 请求，走 DSH 已配置的 key（resolveKey）。
      // 选哪些模型、多久一次全由客户端决定（面板打开期间定时）；host 只执行「这一轮」：
      // 60s TTL 缓存防重复计费，并发 ≤3 + 每请求前随机抖动（瞬时并发会触发上游风控冻结）。
      if (pathname === '/dsh-tokenrhythm-bill/model-check' && req.method === 'POST') {
        const body = await readBody(req)
        const { providers } = readProviders()
        const wantId = body && typeof body.provider === 'string' ? body.provider.trim() : ''
        const provider = wantId !== ''
          ? providers.find((p) => p.id === wantId) || null
          : providers.find((p) => p.balanceCapable) || providers[0] || null
        if (!provider) { writeJson(res, { ok: false, error: '没有可用提供商（检查 settings.yaml 或 profile 补丁层里的 llm-pi-ai.providers）' }, 404); return }
        const key = resolveKey(provider)
        if (key === '') { writeJson(res, { ok: false, code: 'NO_KEY', error: '未读到 ' + provider.apiKeyEnv + '（env 与 ~/.dsh/.credentials.yaml 都没有）' }, 409); return }
        const force = body && body.force === true
        const plan = buildCheckPlan(body ? body.models : null, checkCache, force, Date.now(), CHECK_TTL_MS)
        if (plan.toProbe.length === 0 && Object.keys(plan.cachedResults).length === 0) {
          writeJson(res, { ok: false, error: '请至少勾选一个模型（models 为字符串数组，最多 ' + CHECK_MAX_MODELS + ' 个）' }, 400); return
        }
        const base = (provider.baseURL || '').replace(/\/+$/, '')
        if (base === '') { writeJson(res, { ok: false, error: '提供商 ' + provider.id + ' 的 baseURL 为空，无法探测' }, 500); return }
        const chatUrl = /\/v\d+$/.test(base) ? base + '/chat/completions' : base + '/v1/chat/completions'
        const results = {}
        for (const id of Object.keys(plan.cachedResults)) results[id] = plan.cachedResults[id]
        const started = Date.now()
        const queue = plan.toProbe.slice()
        let qIdx = 0
        const probeOne = async (modelId) => {
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * CHECK_JITTER_MS)))
          const t0 = Date.now()
          const ac = new AbortController()
          const timer = setTimeout(() => ac.abort(), CHECK_TIMEOUT_MS)
          let http = 0
          let detail = '网络错误'
          try {
            const r2 = await fetch(chatUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
              body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
              signal: ac.signal,
            })
            http = r2.status
            if (r2.ok) {
              detail = ''
              try { await r2.json() } catch { /* 200 非 JSON 也视为可达 */ }
            } else {
              const t = await r2.text().catch(() => '')
              let msg = t.slice(0, 160)
              try {
                const j = JSON.parse(t)
                if (isObj(j) && j.error !== undefined) msg = String((isObj(j.error) ? (j.error.message || j.error) : j.error))
              } catch { /* 保留原始文本 */ }
              detail = 'HTTP ' + http + (msg ? ' ' + msg : '')
            }
          } catch (err) {
            detail = (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))
              ? '超时（' + CHECK_TIMEOUT_MS + 'ms）'
              : String((err && err.message) || err)
          } finally {
            clearTimeout(timer)
          }
          const ms = Date.now() - t0
          const cls = classifyProbe(http, detail)
          const entry = { status: cls.status, ms, error: cls.error, errorKind: cls.errorKind, checkedAt: Math.floor(Date.now() / 1000), cached: false }
          results[modelId] = entry
          checkCache.set(modelId, Object.assign({ ts: Date.now() }, entry))
        }
        // 并发 ≤3 的 worker 池从共享队列取任务（JS 单线程，qIdx 无需锁）。
        await (async () => {
          const workers = []
          for (let w = 0; w < Math.min(CHECK_CONCURRENCY, queue.length); w++) {
            workers.push((async () => {
              while (qIdx < queue.length) {
                const id = queue[qIdx]
                qIdx++
                await probeOne(id)
              }
            })())
          }
          await Promise.all(workers)
        })()
        writeJson(res, {
          ok: true,
          provider: provider.id,
          results,
          probed: plan.toProbe.length,
          cached: Object.keys(plan.cachedResults).length,
          tookMs: Date.now() - started,
        })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/prefs' && req.method === 'GET') {
        loadState()
        // systems 一律回规范化结果（缺 systems 的老存档也能直接读到完整三键）
        writeJson(res, { ok: true, prefs: { ...state.prefs, systems: systemsOf(state.prefs) } })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/prefs' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        state.prefs = { ...state.prefs, ...sanitizePrefs(body && body.prefs ? body.prefs : body) }
        saveState()
        writeJson(res, { ok: true, prefs: { ...state.prefs, systems: systemsOf(state.prefs) } })
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
      // username 省略 = 当期活跃账号（绝大多数调用点，行为同旧版）；
      // 显式传入 = 查指定账号（多账号面板按账号懒查，走同一套缓存/会话）。
      // 注意 searchParams.get() 缺参返回 null 而非 undefined，必须归一成 undefined，
      // 否则 pickStepAccount 的「省略走活跃账号」分支永远进不去。
      const stepUserParam = (sp) => { const v = sp.get('username'); return v === null ? undefined : v }
      // 密钥路由的账号解析：显式 username 优先，省略 = 当期活跃账号。
      // 只查账号池、**不要求密码非空**（不像 pickStepAccount）——没密码的账号该由
      // stepEnsureSession 去报它该报的错，这里别提前把路堵了。
      const stepKeyAccountOf = (raw) => {
        const want = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
        if (want !== '') {
          for (const a of state.step.accounts) {
            if (isObj(a) && typeof a.username === 'string' && a.username.toLowerCase() === want) return a.username
          }
          return null
        }
        return typeof state.step.activeAccount === 'string' && state.step.activeAccount !== '' ? state.step.activeAccount : null
      }
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/plan' && req.method === 'GET') {
        writeJson(res, await fetchStepPlan(url.searchParams.get('force') === '1', stepUserParam(url.searchParams)))
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/balance' && req.method === 'GET') {
        writeJson(res, await fetchStepOfficialBalance(url.searchParams.get('force') === '1', stepUserParam(url.searchParams)))
        return
      }
      // 单账号用户资料（头像/昵称/实名状态）——卡片「刷新」的第三路查询，与 plan/balance
      // 同一参数口径（force=1 绕过 15min 缓存；username 省略 = 活跃账号）。
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/profile' && req.method === 'GET') {
        writeJson(res, await fetchStepProfile(url.searchParams.get('force') === '1', stepUserParam(url.searchParams)))
        return
      }
      // 头像代理：平台 CDN 的 avatar_url 不让浏览器直连（与「浏览器不跨域直连」同一隐私
      // 口径，也顺带绕开防盗链），host 按账号取资料缓存里的 URL 转发图片字节。
      // 只认账号池内的 username（池外 404，不给探测面）；URL 只认 https；字节缓存 1h。
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/avatar' && req.method === 'GET') {
        loadState()
        const want = asStr(stepUserParam(url.searchParams)).toLowerCase()
        let hit = null
        if (want !== '') {
          for (const a of state.step.accounts) {
            if (isObj(a) && typeof a.username === 'string' && a.username.toLowerCase() === want) { hit = a; break }
          }
        }
        if (hit === null) { writeJson(res, { ok: false, code: 'NO_STEP_ACCOUNT', error: '账号不在账号池中' }, 404); return }
        const profHit = stepProfileCaches.get(hit.username)
        const avatarUrl = profHit && profHit.data && profHit.data.profile ? profHit.data.profile.avatarUrl : ''
        if (avatarUrl === '') { writeJson(res, { ok: false, code: 'NO_AVATAR', error: '该账号还没有头像数据' }, 404); return }
        const serve = (buf, type) => {
          res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=3600' })
          res.end(buf)
        }
        const avaHit = stepAvaCaches.get(hit.username)
        if (avaHit && Date.now() - avaHit.ts < STEP_AVA_TTL_MS) { serve(avaHit.buf, avaHit.type); return }
        try {
          const imgRes = await fetchWithTimeout(avatarUrl, { headers: { 'user-agent': STEP_UA, referer: stepLib.STEP_PLATFORM_BASE + '/' } })
          const type = String(imgRes.headers.get('content-type') || '').split(';')[0].trim()
          if (!imgRes.ok || !type.startsWith('image/')) {
            writeJson(res, { ok: false, code: 'STEP_HTTP', error: '头像拉取失败：HTTP ' + imgRes.status }, 502); return
          }
          const buf = Buffer.from(await imgRes.arrayBuffer())
          // 体积护栏：正常头像几 KB～几十 KB；超过 2MB 视为异常，不进缓存不伺服
          if (buf.length === 0 || buf.length > 2 * 1024 * 1024) {
            writeJson(res, { ok: false, code: 'STEP_SHAPE', error: '头像体积异常' }, 502); return
          }
          stepAvaCaches.set(hit.username, { buf, type, ts: Date.now() })
          serve(buf, type)
        } catch (err) {
          writeJson(res, { ok: false, code: 'STEP_NET', error: '头像拉取网络失败：' + String((err && err.message) || err) }, 502)
        }
        return
      }
      // 账号清单 + 各账号已缓存的套餐/余额快照。全部来自本地缓存，零网络：
      // 面板据此渲染多账号卡，未缓存的账号显示「尚未查询」。
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/accounts' && req.method === 'GET') {
        loadState()
        const plans = {}
        for (const [u, c] of stepPlanCaches) plans[u] = { ...c.data, cached: true, cachedAt: c.ts }
        const balances = {}
        for (const [u, c] of stepBalCaches) balances[u] = { ...c.data, cached: true, cachedAt: c.ts }
        const profiles = {}
        for (const [u, c] of stepProfileCaches) profiles[u] = { ...c.data, cached: true, cachedAt: c.ts }
        writeJson(res, { ok: true, accounts: stepPublicAccounts(), activeAccount: state.step.activeAccount || null, plans, balances, profiles })
        return
      }
      // 密码明文按需单取（与密钥同一口径：列表只回掩码，完整值按需单取）。
      // 账号清单接口只回 pwMask；只有用户在卡片上点了「眼睛」才走到这里。
      // 仅认账号池内的 username——池外一律 404，不给探测面；明文不进日志、不落盘。
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/account/password' && req.method === 'GET') {
        loadState()
        const want = typeof stepUserParam(url.searchParams) === 'string' ? stepUserParam(url.searchParams).trim().toLowerCase() : ''
        let hit = null
        if (want !== '') {
          for (const a of state.step.accounts) {
            if (isObj(a) && typeof a.username === 'string' && a.username.toLowerCase() === want) { hit = a; break }
          }
        }
        if (hit === null) { writeJson(res, { ok: false, code: 'NO_STEP_ACCOUNT', error: '账号不在账号池中' }, 404); return }
        writeJson(res, { ok: true, username: hit.username, password: typeof hit.password === 'string' ? hit.password : '' })
        return
      }
      // 补齐所有账号的套餐/余额，分两阶段：
      //   ① 补会话——只有会话真失效的账号才需要登录，受 30s 冷却约束，只能串行；
      //      会话还有效的直接跳过（零请求）。冷启动才需要走这段。
      //   ② 拉数据——会话齐了之后各账号 RPC 互不依赖（各带各的 cookie），并发跑。
      // 曾经的 bug：把「要不要等冷却」的判断放在 fetch 之后——账号 1 刚登完，会话
      // 恰好变新鲜，于是不睡，账号 2 立刻登，直接撞 30 秒冷却 → STEP_COOLDOWN。
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/accounts-detail' && req.method === 'POST') {
        loadState()
        const usernames = Array.isArray(state.step.accounts) ? state.step.accounts.map((a) => a.username) : []
        let aborted = null
        // ① 补会话：只给「一条凭据都没有」的账号登录（首次）。已登过的账号有凭据就复用
        //    （临期由后续 RPC 触发的 RefreshToken 自动续，不占这里）→ 稳态下这一段空转，零请求、零等待。
        //    判据必须在登录之前算：登完凭据必然存在，放到后面会误判成「不用等」。
        let loggedInPrev = false
        for (let i = 0; i < usernames.length; i++) {
          const u = usernames[i]
          const gated = stepThrottleGate()
          if (gated !== null) { aborted = { at: u, remaining: usernames.slice(i), error: gated.error }; break }
          // 套餐缓存还新鲜时连请求都不发，自然也不用会话
          const planHit = stepPlanCaches.get(u)
          const planFresh = planHit !== undefined && Date.now() - planHit.ts < STEP_PLAN_TTL_MS
          const willLogin = !stepSessHasCred(u) && !planFresh
          if (!willLogin) continue
          if (loggedInPrev) await new Promise((r) => setTimeout(r, STEP_LOGIN_COOLDOWN_MS + 500))
          const gated2 = stepThrottleGate()
          if (gated2 !== null) { aborted = { at: u, remaining: usernames.slice(i), error: gated2.error }; break }
          await stepEnsureSession(false, u)
          loggedInPrev = true
        }
        // ② 会话齐了 → 并发拉全部账号（这才是「3 个账号一起查」）
        const entries = await Promise.all(usernames.map(async (u) => {
          const [p, b, pr] = await Promise.all([
            fetchStepPlan(false, u),
            fetchStepOfficialBalance(false, u),
            fetchStepProfile(false, u),
          ])
          return [u, {
            plan: p.ok ? p : { ok: false, error: p.error, code: p.code },
            balance: b.ok ? b : { ok: false, error: b.error, code: b.code },
            profile: pr.ok ? pr : { ok: false, error: pr.error, code: pr.code },
          }]
        }))
        const out = {}
        for (const [u, v] of entries) out[u] = v
        const plans = {}
        for (const [k, c] of stepPlanCaches) plans[k] = { ...c.data, cached: true, cachedAt: c.ts }
        const balances = {}
        for (const [k, c] of stepBalCaches) balances[k] = { ...c.data, cached: true, cachedAt: c.ts }
        const profiles = {}
        for (const [k, c] of stepProfileCaches) profiles[k] = { ...c.data, cached: true, cachedAt: c.ts }
        writeJson(res, { ok: aborted === null, done: Object.keys(out), aborted, plans, balances, profiles })
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
        stepPlanCaches.clear()
        stepBalCaches.clear()
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
        // 只扔这个账号自己的会话与缓存：别人的会话照样有效，切回去不用重登
        stepClearSess(key)
        const dropPlan = []
        for (const k of stepPlanCaches.keys()) if (k.toLowerCase() === key) dropPlan.push(k)
        for (const k of dropPlan) stepPlanCaches.delete(k)
        const dropBal = []
        for (const k of stepBalCaches.keys()) if (k.toLowerCase() === key) dropBal.push(k)
        for (const k of dropBal) stepBalCaches.delete(k)
        const dropProf = []
        for (const k of stepProfileCaches.keys()) if (k.toLowerCase() === key) dropProf.push(k)
        for (const k of dropProf) stepProfileCaches.delete(k)
        const dropAva = []
        for (const k of stepAvaCaches.keys()) if (k.toLowerCase() === key) dropAva.push(k)
        for (const k of dropAva) stepAvaCaches.delete(k)
        if (key !== '' && state.step.activeAccount.toLowerCase() === key) state.step.activeAccount = ''
        saveState()
        writeJson(res, { ok: true, accounts: stepPublicAccounts(), activeAccount: state.step.activeAccount || null })
        return
      }
      // 只改「侧栏胶囊 / 主卡显示哪个账号」——是显示偏好，不是切换登录身份。
      // 各账号会话分槽并存，这里不清任何人的缓存、不强制重登：
      // 换显示目标后，前端既有的轮询会按新的 activeAccount 取它自己那份缓存。
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/account/use' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        const username = asStr(body && body.username).trim()
        // 与 add 同口径：大小写不敏感查找（否则大小写变体账号切不到，404）
        const key = username.toLowerCase()
        const hit = state.step.accounts.find((a) => a.username.toLowerCase() === key)
        if (!hit) { writeJson(res, { ok: false, error: '账号不存在' }, 404); return }
        state.step.activeAccount = hit.username
        saveState()
        writeJson(res, { ok: true, switched: true, account: hit.username })
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

      // ---- 阶跃「接口密钥」维护（控制台同款内部 RPC，2026-09 反解前端 bundle 坐实）：
      // ListAccessKeys/CreateAccessKey/DeleteAccessKey 都走 Dashboard 服务（与套餐查询同服务），
      // 会话/重登/退避全复用 stepRpc。隐私口径与基元密钥一致：列表只回掩码，完整值
      // 仅在创建响应里出现一次、复制时经 /stepfun/key 按需单取，界面绝不明文渲染。----
      const stepListKeys = async (username) => {
        loadState()
        // username 必须一路传到 stepRpc：省略时它默认落活跃账号，但 stepGetSess 是按
        // username 分槽取会话的——传空等于拿空键去查，恒为「无可用会话」（已修的回归）。
        const un = stepKeyAccountOf(username)
        if (un === null) return { ok: false, code: 'NO_STEP_ACCOUNT', error: '未配置阶跃账号（设置 → 阶跃账号）' }
        const r = await stepRpc(stepLib.STEP_DEV_SERVICE, 'ListAccessKeys', {}, false, un)
        if (!r.ok) return { ok: false, code: r.code, error: r.error }
        const n = stepLib.normalizeStepKeys(r.data)
        if (!n.ok) {
          return { ok: false, code: 'STEP_RPC', error: '平台拒绝列出密钥（status≠1）' + (isObj(r.data) && typeof r.data.desc === 'string' && r.data.desc !== '' ? '：' + r.data.desc : '') }
        }
        return { ok: true, keys: n.keys.filter((k) => !k.isDeleted), total: n.total, account: un }
      }
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/keys' && req.method === 'GET') {
        writeJson(res, await stepListKeys(stepUserParam(url.searchParams)))
        return
      }
      // 复制完整密钥：按 keyId 现场拉一次列表取回完整值（只在本地点「复制」时触达）。
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/key' && req.method === 'GET') {
        const keyId = (url.searchParams.get('keyId') || '').trim()
        if (keyId === '') { writeJson(res, { ok: false, error: '缺少 keyId' }, 400); return }
        const un = stepKeyAccountOf(url.searchParams.get('username'))
        if (un === null) { writeJson(res, { ok: false, code: 'NO_STEP_ACCOUNT', error: '未配置阶跃账号（设置 → 阶跃账号）' }, 404); return }
        const r = await stepRpc(stepLib.STEP_DEV_SERVICE, 'ListAccessKeys', {}, false, un)
        if (!r.ok) { writeJson(res, { ok: false, code: r.code, error: r.error }, 502); return }
        const list = isObj(r.data) && Array.isArray(r.data.accessKeys) ? r.data.accessKeys : []
        const hit = list.map((k) => (isObj(k) ? k : null)).find((k) => k !== null && String(k.keyId ?? k.key_id ?? '') === keyId) || null
        const fullKey = hit !== null && typeof hit.accessKey === 'string' ? hit.accessKey : ''
        if (fullKey === '') { writeJson(res, { ok: false, error: '未找到该密钥（可能刚被删除）' }, 404); return }
        writeJson(res, { ok: true, key: fullKey })
        return
      }
      // 新建密钥：平台表单强制名称（≤20 字符）+ 上限 10 把；完整值只在创建响应出现一次。
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/key-create' && req.method === 'POST') {
        const body = await readBody(req)
        // 注意：必须 typeof body.name === 'string'；写成 body.name === 'string' 是拿值跟
        // 字面量比，任何输入都判非字符串 → name 永远 '' → 永远 400（2026-09 实测复现）。
        const name = isObj(body) && typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '' || name.length > 20) { writeJson(res, { ok: false, error: '请填写密钥名称（平台要求，不超过 20 字符）' }, 400); return }
        const cur = await stepListKeys(body.username)
        if (!cur.ok) { writeJson(res, { ok: false, code: cur.code, error: cur.error }, 502); return }
        if (cur.keys.length >= stepLib.STEP_KEY_MAX) {
          writeJson(res, { ok: false, error: '平台最多 ' + stepLib.STEP_KEY_MAX + ' 把密钥，先删除不用的再创建' }, 409); return
        }
        const r = await stepRpc(stepLib.STEP_DEV_SERVICE, 'CreateAccessKey', { name }, false, cur.account)
        if (!r.ok) { writeJson(res, { ok: false, code: r.code, error: r.error }, 502); return }
        const data = isObj(r.data) ? r.data : {}
        const info = isObj(data.keyInfo) ? data.keyInfo : {}
        const fullKey = typeof info.accessKey === 'string' ? info.accessKey : ''
        if (fullKey === '') { writeJson(res, { ok: false, error: '平台未返回完整密钥' }, 502); return }
        writeJson(res, { ok: true, name: typeof info.name === 'string' && info.name !== '' ? info.name : name, key: fullKey })
        return
      }
      // 删除密钥：成功后回传新列表（界面即时刷新，无需再拉一次）。
      if (pathname === '/dsh-tokenrhythm-bill/stepfun/key-delete' && req.method === 'POST') {
        const body = await readBody(req)
        // 同上：必须 typeof body.keyId === 'string'。写成 body.keyId === 'string' 会拿值
        // 跟字面量比，任何 keyId 都判非字符串 → 永远 400「缺少 keyId」，删不掉任何密钥。
        const keyId = isObj(body) && typeof body.keyId === 'string' ? body.keyId.trim()
          : (isObj(body) && typeof body.keyId === 'number' && Number.isFinite(body.keyId) ? String(body.keyId) : '')
        if (keyId === '') { writeJson(res, { ok: false, error: '缺少 keyId' }, 400); return }
        const un = stepKeyAccountOf(isObj(body) ? body.username : undefined)
        if (un === null) { writeJson(res, { ok: false, code: 'NO_STEP_ACCOUNT', error: '未配置阶跃账号（设置 → 阶跃账号）' }, 404); return }
        const r = await stepRpc(stepLib.STEP_DEV_SERVICE, 'DeleteAccessKey', { keyID: keyId }, false, un)
        if (!r.ok) { writeJson(res, { ok: false, code: r.code, error: r.error }, 502); return }
        writeJson(res, await stepListKeys(un))
        return
      }

      // ================= ZCode（额度展示）路由 =================
      if (pathname === '/dsh-tokenrhythm-bill/zcode/quota' && req.method === 'GET') {
        if (!zcodeEnabled()) { writeJson(res, zcodeDisabledResponse()); return }
        writeJson(res, await fetchZcodeQuota(url.searchParams.get('force') === '1'))
        return
      }

      // ================= 清枢智汇（TierFlow）路由 =================
      // 与阶跃同款：GET 只读数据（5 分钟缓存，force=1 绕过），POST 才改账号池。
      // 全部路由都过 tfEnabled() 闸门（设置 → 系统管理里的开关），关掉即整体不可达。
      const tfUserParam = (sp) => { const v = sp.get('identifier'); return v === null ? undefined : v }
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/user' && req.method === 'GET') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        writeJson(res, await fetchTfUser(url.searchParams.get('force') === '1', tfUserParam(url.searchParams)))
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/subscription' && req.method === 'GET') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        writeJson(res, await fetchTfSubscription(url.searchParams.get('force') === '1', tfUserParam(url.searchParams)))
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/plans' && req.method === 'GET') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        writeJson(res, await fetchTfPlans(url.searchParams.get('force') === '1', tfUserParam(url.searchParams)))
        return
      }
      // 余额升级：会花钱的 POST 之一（另一个是下面的余额购买）。前置两道自保在 fetchTfUpgrade 里。
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/upgrade' && req.method === 'POST') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        const body = await readBody(req)
        writeJson(res, await fetchTfUpgrade(
          typeof body.identifier === 'string' ? body.identifier : undefined,
          asStr(body.subNo),
          asStr(body.planSlug),
          typeof body.expectedDue === 'number' ? body.expectedDue : null,
        ))
        return
      }
      // 余额购买订阅（定稿「账户的部分添加购买订阅的功能，只能余额买」）：三道自保在 fetchTfPurchase 里。
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/purchase' && req.method === 'POST') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        const body = await readBody(req)
        writeJson(res, await fetchTfPurchase(
          typeof body.identifier === 'string' ? body.identifier : undefined,
          asStr(body.planSlug),
          typeof body.expectedPrice === 'number' ? body.expectedPrice : null,
        ))
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/accounts' && req.method === 'GET') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        writeJson(res, {
          ok: true,
          accounts: tfPublicAccounts(),
          activeAccount: state.tf.activeAccount || null,
          // 内存里的换算基准（可能还没拉到 → 0，前端此时不显示金额，等 /tierflow/user 回来）
          quotaPerUnit: tfStatusCache.quotaPerUnit > 0 ? tfStatusCache.quotaPerUnit : 0,
        })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/accounts-detail' && req.method === 'POST') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        loadState()
        const idents = state.tf.accounts.map((a) => a.identifier)
        if (idents.length === 0) {
          writeJson(res, { ok: false, code: 'NO_TF_ACCOUNT', error: '未配置清枢智汇账号（面板 → 账户 → 添加账号）' }, 404)
          return
        }
        // ① 先串行把会话补齐。登录有 30s 自家冷却，两个账号同时冷登必有一个被挡回，
        //    所以按顺序来、两次真登录之间留出冷却窗（与阶跃 /stepfun/accounts-detail 同构）。
        //    已有会话的账号直接跳过，零等待。
        let loggedInPrev = false
        for (const id of idents) {
          if (tfSessHasCred(id)) continue
          if (loggedInPrev) await tfSleep(TF_LOGIN_COOLDOWN_MS + 500)
          await tfEnsureSession(false, id)
          loggedInPrev = true
        }
        // ② 会话齐了 → 并发拉全部账号（这才是「N 个账号一起查」）
        const entries = await Promise.all(idents.map(async (id) => {
          const [u, s] = await Promise.all([fetchTfUser(false, id), fetchTfSubscription(false, id)])
          return [id, { user: u, sub: s }]
        }))
        const users = {}
        for (const [k, c] of tfUserCaches) users[k] = { ...c.data, cached: true, cachedAt: c.ts }
        const subs = {}
        for (const [k, c] of tfSubCaches) subs[k] = { ...c.data, cached: true, cachedAt: c.ts }
        const detail = {}
        for (const [id, v] of entries) detail[id] = v
        writeJson(res, { ok: true, done: Object.keys(detail), detail, users, subs, accounts: tfPublicAccounts(), activeAccount: state.tf.activeAccount || null })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/account/add' && req.method === 'POST') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        const body = await readBody(req)
        const identifier = asStr(body && body.identifier)
        const password = typeof (body && body.password) === 'string' ? body.password : ''
        if (identifier.length < 3 || identifier.length > 96 || password === '' || password.length > 256) {
          writeJson(res, { ok: false, error: '账号需 3~96 字符、密码 1~256 字符' }, 400); return
        }
        loadState()
        // 加账号时就真登一次（与阶跃同款）：密码错当场告知，而不是存进去以后每次查询都白等一轮失败
        const r = await tfLogin(identifier, password)
        // 账号密码错 / 要 2FA / 没下发会话这类**确定性**失败 → 拒收。
        // 网络抖动、平台 5xx 这类暂时态 → 先存下（凭据大概率没错），等冷却解除自动补登录。
        if (!r.ok && tfLib.tfDeterministicLoginFailure(r.code)) {
          writeJson(res, { ok: false, error: '登录校验未通过，未保存：' + r.error }, 401); return
        }
        const key = identifier.toLowerCase()
        const prev = state.tf.accounts.find((a) => a.identifier.toLowerCase() === key)
        const rest = state.tf.accounts.filter((a) => a.identifier.toLowerCase() !== key)
        state.tf.accounts = sanitizeTfAccounts([...rest, { identifier, password, addedAt: prev ? prev.addedAt : Date.now() }])
        state.tf.activeAccount = identifier
        // 换账号/改密码 → 旧会话与旧缓存一律作废（那枚 cookie 可能属于另一个身份了）
        tfClearSess(key)
        tfDropCaches(key)
        if (r.ok) tfApplySession(identifier, r.cookie, r.uid)
        saveState()
        writeJson(res, r.ok
          ? { ok: true, accounts: tfPublicAccounts(), activeAccount: state.tf.activeAccount }
          : { ok: true, pending: true, accounts: tfPublicAccounts(), activeAccount: state.tf.activeAccount, error: r.error })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/account/remove' && req.method === 'POST') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        const body = await readBody(req)
        loadState()
        const identifier = asStr(body && body.identifier)
        // 与 add 同口径：大小写不敏感（add 去重按 toLowerCase，精确匹配会让大小写变体账号删不掉）
        const key = identifier.toLowerCase()
        state.tf.accounts = state.tf.accounts.filter((a) => a.identifier.toLowerCase() !== key)
        // 只扔这个账号自己的会话与缓存：别人的会话照样有效，切回去不用重登
        if (key !== '') {
          tfClearSess(key)
          tfDropCaches(key)
          if (state.tf.activeAccount.toLowerCase() === key) state.tf.activeAccount = ''
        }
        saveState()
        writeJson(res, { ok: true, accounts: tfPublicAccounts(), activeAccount: state.tf.activeAccount || null })
        return
      }
      // 只改「面板看哪个账号」——是显示偏好，不是切换登录身份。各账号会话分槽并存，
      // 这里不清任何人的缓存、不强制重登：换显示目标后前端的轮询会按新的 activeAccount 取它自己那份缓存。
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/account/use' && req.method === 'POST') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        const body = await readBody(req)
        loadState()
        const key = asStr(body && body.identifier).toLowerCase()
        const hit = state.tf.accounts.find((a) => a.identifier.toLowerCase() === key)
        if (!hit) { writeJson(res, { ok: false, error: '账号不存在' }, 404); return }
        state.tf.activeAccount = hit.identifier
        saveState()
        writeJson(res, { ok: true, switched: true, account: hit.identifier })
        return
      }
      // 明文密码单取：账号列表里只有掩码，要看真值必须走这里（点击眼睛才发这一次请求）
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/account/password' && req.method === 'GET') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        loadState()
        const key = asStr(url.searchParams.get('identifier') === null ? state.tf.activeAccount : url.searchParams.get('identifier')).toLowerCase()
        const hit = state.tf.accounts.find((a) => a.identifier.toLowerCase() === key)
        if (!hit) { writeJson(res, { ok: false, error: '账号不存在' }, 404); return }
        writeJson(res, { ok: true, identifier: hit.identifier, password: hit.password })
        return
      }
      // 手测登录：会话被平台作废后「校验一下密码还对不对」用；同一账号受 30s 冷却保护
      if (pathname === '/dsh-tokenrhythm-bill/tierflow/login-test' && req.method === 'POST') {
        if (!tfEnabled()) { writeJson(res, tfDisabledResponse()); return }
        const body = await readBody(req)
        loadState()
        const identifier = asStr(body && body.identifier) || state.tf.activeAccount || ''
        let pw = typeof (body && body.password) === 'string' ? body.password : ''
        if (pw === '') {
          const acc = pickTfAccount(state.tf, identifier === '' ? undefined : identifier)
          if (acc !== null) pw = acc.password
        }
        if (identifier === '' || pw === '') { writeJson(res, { ok: false, error: '缺少账号或密码' }, 400); return }
        const key = identifier.toLowerCase()
        const at = tfLoginAt.get(key) || 0
        const wait = TF_LOGIN_COOLDOWN_MS - (Date.now() - at)
        if (wait > 0) {
          writeJson(res, { ok: false, code: 'TF_COOLDOWN', error: '登录尝试过于频繁，约 ' + Math.ceil(wait / 1000) + ' 秒后自动重试（无需连点）' }, 429)
          return
        }
        tfLoginAt.set(key, Date.now())
        const r = await tfLogin(identifier, pw)
        // 测的就是当前活跃账号 → 顺手续上会话缓存（省一次重登）
        if (r.ok && state.tf.activeAccount && state.tf.activeAccount.toLowerCase() === key) {
          tfApplySession(state.tf.activeAccount, r.cookie, r.uid)
        }
        writeJson(res, r.ok ? { ok: true, account: identifier, uid: r.uid } : { ok: false, code: r.code, error: r.error }, r.ok ? 200 : 401)
        return
      }

      // ================= OpenCSG 路由 =================
      // 与清枢同款：GET 只读数据（5 分钟缓存，force=1 绕过），POST 才改账号池；
      // 全部过 ocEnabled() 闸门（设置 → 系统管理），关掉即整体不可达。
      // 与清枢的差别：这边**没有长效凭据**，每次查询都可能触发一次真登录（换令牌），
      // 所以登录冷却与「确定性失败拒收」这两道闸门更要紧。
      const ocUserParam = (sp) => { const v = sp.get('identifier'); return v === null ? undefined : v }
      if (pathname === '/dsh-tokenrhythm-bill/opencsg/account' && req.method === 'GET') {
        if (!ocEnabled()) { writeJson(res, ocDisabledResponse()); return }
        writeJson(res, await fetchOcAccount(url.searchParams.get('force') === '1', ocUserParam(url.searchParams)))
        return
      }
      // 用量：与 account 同一个快照（余额/档位/用量本来就是一次取证拉齐的），
      // 分开一条路由只是让前端两个标签页各取各的、互不牵制。
      if (pathname === '/dsh-tokenrhythm-bill/opencsg/usage' && req.method === 'GET') {
        if (!ocEnabled()) { writeJson(res, ocDisabledResponse()); return }
        writeJson(res, await fetchOcAccount(url.searchParams.get('force') === '1', ocUserParam(url.searchParams)))
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/opencsg/accounts' && req.method === 'GET') {
        if (!ocEnabled()) { writeJson(res, ocDisabledResponse()); return }
        writeJson(res, {
          ok: true,
          accounts: ocPublicAccounts(),
          activeAccount: state.oc.activeAccount || null,
        })
        return
      }
      // 批量明细：N 个账号各自查一遍（前端「刷新全部」）。**串行补会话**是为了绕开
      // 自家 30s 登录冷却（两个账号同时冷登必有一个被挡回），会话齐了再并发拉数据。
      if (pathname === '/dsh-tokenrhythm-bill/opencsg/accounts-detail' && req.method === 'POST') {
        if (!ocEnabled()) { writeJson(res, ocDisabledResponse()); return }
        loadState()
        const idents = state.oc.accounts.map((a) => a.identifier)
        if (idents.length === 0) {
          writeJson(res, { ok: false, code: 'NO_OC_ACCOUNT', error: '未配置 OpenCSG 账号（面板 → 账户 → 添加账号）' }, 404)
          return
        }
        let loggedInPrev = false
        for (const id of idents) {
          if (ocSessHasCred(id) && !ocLib.ocJwtExpired((ocGetSess(id) || {}).token || '')) continue
          if (loggedInPrev) await tfSleep(OC_LOGIN_COOLDOWN_MS + 500)
          await ocEnsureSession(id)
          loggedInPrev = true
        }
        const entries = await Promise.all(idents.map(async (id) => [id, await fetchOcAccount(false, id)]))
        const accounts = {}
        for (const [k, c] of ocAccountCaches) accounts[k] = { ...c.data, cached: true, cachedAt: c.ts }
        const detail = {}
        for (const [id, v] of entries) detail[id] = v
        writeJson(res, { ok: true, done: Object.keys(detail), detail, accounts, list: ocPublicAccounts(), activeAccount: state.oc.activeAccount || null })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/opencsg/account/add' && req.method === 'POST') {
        if (!ocEnabled()) { writeJson(res, ocDisabledResponse()); return }
        const body = await readBody(req)
        const identifier = asStr(body && body.identifier).trim()
        const password = typeof (body && body.password) === 'string' ? body.password : ''
        if (identifier.length < 3 || identifier.length > 96 || password === '' || password.length > 256) {
          writeJson(res, { ok: false, error: '账号需 3~96 字符、密码 1~256 字符' }, 400); return
        }
        loadState()
        // 加账号时就真登一次（与另外四家同款）：密码错当场告知，而不是存进去以后每次查询都白等一轮失败
        const r = await ocLogin(identifier, password)
        // 确定性失败（密码错 / 拿不到令牌 / 结构不认识）→ **拒收**；
        // 网络抖动、平台 5xx 这类暂时态 → 先存下（凭据大概率没错），等下次查询自动补登录。
        if (!r.ok && ocLib.ocDeterministicLoginFailure(r.code)) {
          writeJson(res, { ok: false, code: r.code, error: '登录校验未通过，未保存：' + r.error }, 401); return
        }
        const key = ocSessKey(identifier)
        const prev = state.oc.accounts.find((a) => ocSessKey(a.identifier) === key)
        const rest = state.oc.accounts.filter((a) => ocSessKey(a.identifier) !== key)
        state.oc.accounts = sanitizeOcAccounts([...rest, { identifier, password, addedAt: prev ? prev.addedAt : Date.now() }])
        state.oc.activeAccount = identifier
        // 换账号/改密码 → 旧会话与旧缓存一律作废（那枚令牌可能属于另一个身份了）
        ocClearSess(key)
        ocDropCaches(key)
        if (r.ok) ocApplySession(identifier, r.token, r.scheme, r.uuid, r.username)
        saveState()
        writeJson(res, r.ok
          ? { ok: true, accounts: ocPublicAccounts(), activeAccount: state.oc.activeAccount }
          : { ok: true, pending: true, accounts: ocPublicAccounts(), activeAccount: state.oc.activeAccount, error: r.error })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/opencsg/account/remove' && req.method === 'POST') {
        if (!ocEnabled()) { writeJson(res, ocDisabledResponse()); return }
        const body = await readBody(req)
        loadState()
        const key = ocSessKey(asStr(body && body.identifier))
        state.oc.accounts = state.oc.accounts.filter((a) => ocSessKey(a.identifier) !== key)
        // 只扔这个账号自己的会话与缓存：别人的令牌照样有效，切回去不用重登
        if (key !== '') {
          ocClearSess(key)
          ocDropCaches(key)
          if (ocSessKey(state.oc.activeAccount) === key) state.oc.activeAccount = ''
        }
        saveState()
        writeJson(res, { ok: true, accounts: ocPublicAccounts(), activeAccount: state.oc.activeAccount || null })
        return
      }
      // 只改「面板看哪个账号」——是显示偏好，不是切换登录身份。各账号会话分槽并存，
      // 这里不清任何人的缓存、不强制重登（换显示目标后前端按新的 activeAccount 取它自己那份缓存）。
      if (pathname === '/dsh-tokenrhythm-bill/opencsg/account/use' && req.method === 'POST') {
        if (!ocEnabled()) { writeJson(res, ocDisabledResponse()); return }
        const body = await readBody(req)
        loadState()
        const key = ocSessKey(asStr(body && body.identifier))
        const hit = state.oc.accounts.find((a) => ocSessKey(a.identifier) === key)
        if (!hit) { writeJson(res, { ok: false, error: '账号不存在' }, 404); return }
        state.oc.activeAccount = hit.identifier
        saveState()
        writeJson(res, { ok: true, switched: true, account: hit.identifier })
        return
      }
      // 明文密码单取：账号列表里只有掩码，要看真值必须走这里（点击眼睛才发这一次请求）
      if (pathname === '/dsh-tokenrhythm-bill/opencsg/account/password' && req.method === 'GET') {
        if (!ocEnabled()) { writeJson(res, ocDisabledResponse()); return }
        loadState()
        const want = url.searchParams.get('identifier')
        const key = ocSessKey(want === null ? state.oc.activeAccount : want)
        const hit = state.oc.accounts.find((a) => ocSessKey(a.identifier) === key)
        if (!hit) { writeJson(res, { ok: false, error: '账号不存在' }, 404); return }
        writeJson(res, { ok: true, identifier: hit.identifier, password: hit.password })
        return
      }
      // 手测登录：令牌被平台作废后「校验一下密码还对不对」用；同一账号受 30s 冷却保护。
      // 与清枢的 login-test 同款：**不落库**（只回结果），落库是 add 的事。
      if (pathname === '/dsh-tokenrhythm-bill/opencsg/login-test' && req.method === 'POST') {
        if (!ocEnabled()) { writeJson(res, ocDisabledResponse()); return }
        const body = await readBody(req)
        loadState()
        const identifier = asStr(body && body.identifier) || state.oc.activeAccount || ''
        let pw = typeof (body && body.password) === 'string' ? body.password : ''
        if (pw === '') {
          const acc = pickOcAccount(state.oc, identifier === '' ? undefined : identifier)
          if (acc !== null) pw = acc.password
        }
        if (identifier === '' || pw === '') { writeJson(res, { ok: false, error: '缺少账号或密码' }, 400); return }
        const key = ocSessKey(identifier)
        const wait = OC_LOGIN_COOLDOWN_MS - (Date.now() - (ocLoginAt.get(key) || 0))
        if (wait > 0) {
          writeJson(res, { ok: false, code: 'OC_COOLDOWN', error: '登录尝试过于频繁，约 ' + Math.ceil(wait / 1000) + ' 秒后自动重试（无需连点）' }, 429)
          return
        }
        ocLoginAt.set(key, Date.now())
        const r = await ocLogin(identifier, pw)
        // 测的就是当前活跃账号 → 顺手续上会话（省一次重登）
        if (r.ok && state.oc.activeAccount && ocSessKey(state.oc.activeAccount) === key) {
          ocApplySession(state.oc.activeAccount, r.token, r.scheme, r.uuid, r.username)
        }
        writeJson(res, r.ok ? { ok: true, account: identifier, uuid: r.uuid, username: r.username, scheme: r.scheme } : { ok: false, code: r.code, error: r.error }, r.ok ? 200 : 401)
        return
      }




      writeJson(res, { ok: false, error: 'not found' }, 404)
    } catch (err) {
      try { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500) } catch { /* socket 已断 */ }
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-tokenrhythm-bill', handler: serve }), 'tokenrhythm-bill: routes')
}
