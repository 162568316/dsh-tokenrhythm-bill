import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const clientPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const src = readFileSync(clientPath, 'utf8')

// 括号/引号平衡检查：曾经手写 createElement 连续三次括号不匹配导致 renderer 白屏，
// 这里在 CI 里拦住同类错误。扫描时跳过字符串（' " `）与注释（// 与 /* */）。
function bracketBalance(text) {
  const pairs = { '(': ')', '{': '}', '[': ']' }
  const closers = new Set(Object.values(pairs))
  const stack = []
  let i = 0
  let line = 1
  while (i < text.length) {
    const c = text[i]
    if (c === '\n') { line++; i++; continue }
    // 注释
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++ }
      i += 2
      continue
    }
    // 字符串（client.js 不使用模板字符串，但一并支持 ${} 内的表达式跳过太复杂——
    // 简单处理：模板串内不再嵌套扫描，整个串视为字面量）
    if (c === '\'' || c === '"' || c === '`') {
      const quote = c
      i++
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\') i++
        if (text[i] === '\n' && quote !== '`') throw new Error(`第 ${line} 行附近有未闭合的 ${quote} 字符串`)
        i++
      }
      if (i >= text.length) throw new Error(`第 ${line} 行附近有未闭合的 ${quote} 字符串`)
      i++
      continue
    }
    if (pairs[c] !== undefined) { stack.push({ ch: c, line }); i++; continue }
    if (closers.has(c)) {
      const top = stack.pop()
      if (top === undefined || pairs[top.ch] !== c) {
        throw new Error(`第 ${line} 行出现不匹配的 "${c}"（最近未闭合的是 ${top ? '"' + top.ch + '" @line ' + top.line : '无'}）`)
      }
      i++
      continue
    }
    i++
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1]
    throw new Error(`有 ${stack.length} 个未闭合的 "${top.ch}"（@line ${top.line}）`)
  }
}

test('client.js 括号/引号全部配对（防 renderer 白屏回归）', () => {
  bracketBalance(src)
})

test('client.js 可在桩环境完成 factory + apply（槽位注册齐全）', async () => {
  const R = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
  const hooks = { setTimeoutFns: [] }
  const registered = []
  const injected = []
  const effects = []
  globalThis.window = {
    __ModuleLoader__: { load: (reg) => registered.push(reg) },
    innerWidth: 1440,
    innerHeight: 900,
  }
  globalThis.document = {
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute() {}, select() {}, get parentNode() { return null } }),
    body: { appendChild: () => {}, removeChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    execCommand: () => true,
  }
  // 执行文件
  new Function('window', 'document', 'require', src)(
    globalThis.window,
    globalThis.document,
    (spec) => { assert.equal(spec, 'react'); return R },
  )
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'dsh-tokenrhythm-bill')
  const exportsObj = registered[0].factory((spec) => R)
  assert.deepEqual(Object.keys(exportsObj).sort(), ['apply', 'inject'])
  const slots = {
    inject: (name, fn) => { injected.push(name); fn() },
    register: (meta) => meta.id,
  }
  const cleanups = []
  try {
    exportsObj.apply({
      get: (k) => (k === 'slots' ? slots : undefined),
      effect: (fn, label) => {
        const r = fn()
        effects.push(label || '(anon)')
        if (typeof r === 'function') cleanups.push(r) // 清理预警轮询的 setInterval，否则 node:test 挂住
        return r
      },
    })
    assert.ok(injected.includes('sidebar.footer.action'))
    assert.ok(injected.includes('shell.overlay'))
    assert.ok(effects.some((l) => String(l).includes('alert poll')))
    // 三套可切换主题（F/G/H）的标志性样式。
    assert.ok(src.includes('backdrop-filter'), 'CSS 应包含 backdrop-filter')
    assert.ok(src.includes('background-clip:text'), 'CSS 应包含渐变文字')
    for (const th of ['dsh-mb-th-F', 'dsh-mb-th-G', 'dsh-mb-th-H']) {
      assert.ok(src.includes(th), 'CSS 应定义主题 ' + th)
    }
    assert.ok(src.includes("dsh-mb-th-' + (s.theme || 'H')"), '面板/入口应按主题挂类')
  } finally {
    for (const fn of cleanups) fn()
  }
  void hooks
})
