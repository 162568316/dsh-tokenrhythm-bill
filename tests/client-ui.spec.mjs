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
    // 侧栏入口：形态由宿主 wide 标志驱动（data-wide 属性 + rail 类），带容器查询回退。
    assert.ok(src.includes("'data-wide'"), 'EntryButton 应在宿主传 wide 时挂 data-wide 属性')
    assert.ok(src.includes("[data-wide=\"0\"]"), 'CSS 应定义 rail（收起）形态')
    assert.ok(src.includes('@container (max-width:60px)'), '宿主未传 wide 时应保留容器查询回退')
    assert.ok(src.includes('dsh-mb-wide-in'), 'label 重挂时应有 wide-in 淡入动画（对齐原生 newSessionLabel）')
    // 入口与原生「设置」触发行对齐：同高 42px、图标起点 18px（左 6px 内边距补偿，
    // 不用负 margin 出血——槽位容器 overflow-x:hidden 会裁掉出血且不产生横向滚动条），
    // 并去掉宿主槽位 scrollbar-gutter:stable 的常驻滚动条槽。
    assert.ok(src.includes('height:42px') && src.includes('padding:0 8px 0 6px'), '入口行几何应对齐设置触发行（内边距补偿，无出血）')
    assert.ok(!src.includes('width:calc(100% + 4px)'), '不应使用负 margin 出血（会在槽位容器里产生横向滚动条）')
    assert.ok(src.includes('scrollbar-gutter:auto'), '应去掉宿主槽位的常驻滚动条槽')
    // 入口图标：基元律动品牌标（brand-logo.svg 图形部分紧裁 viewBox，fill:currentColor，
    // SVG 几何盒 16/18px 与原生线稿图标一致——文字字形度量会导致折叠态图标跑偏）。
    assert.ok(src.includes('const EntryMark') && src.includes("MARK_VIEWBOX = '10.4213 15.2079 60.8522 37.2003'"), '入口图标应为基元律动品牌标 SVG（紧裁 viewBox）')
    assert.ok(src.includes('fill: \'currentColor\''), '品牌标应跟随文字色（明暗主题适配）')
    assert.ok(!src.includes("'¥',"), '入口不应再用 ¥ 文字字形')
    // 设置页备用粘贴：默认折叠。
    assert.ok(src.includes('useState(false) // 默认折叠'), '备用粘贴区应默认折叠')
    // 加载骨架屏：三页签的加载占位与真实内容同构（shimmer 微光扫过，尊重系统减动效）。
    assert.ok(src.includes('dsh-mb-skel-cards') && src.includes('dsh-mb-skel-hero') && src.includes('dsh-mb-skel-rows'), '模型/余额/密钥页签应有同构骨架屏占位')
    assert.ok(src.includes('@keyframes dsh-mb-shimmer') && src.includes('prefers-reduced-motion:reduce'), '骨架屏应有 shimmer 动效并尊重系统减动效设置')
    assert.ok(!src.includes("key: 'ld' }, '加载中…'"), '不应再有纯文字加载占位')
    // 分类筛选行滚动固定：sticky 钉在滚动容器顶部，负 margin 铺满左右内边距并垫实色底。
    assert.ok(src.includes('.dsh-mb-cats{position:sticky'), '模型分类筛选行应滚动固定（sticky）')
    // 缓存标签并入分类行，整行保持一行（放不下横向滚动）。
    assert.ok(src.includes('const cacheTag') && src.includes('flex-wrap:nowrap') && src.includes('.dsh-mb-cache-tag{'), '缓存标签应并入分类行且整行保持一行')
    // UI 与 DSH 设计系统一致：全量引用 --dsw-alias-* 设计令牌，不再有本地配色主题。
    assert.ok(src.includes('--dsw-alias-bg-layer-2'), '面板底色应使用 DSH 层级令牌')
    assert.ok(src.includes('--dsw-alias-state-business-primary'), '强调色应为 DSH 品牌蓝')
    assert.ok(src.includes('--ds-ease-in-out') && src.includes('--ds-transition-duration-fast'), '动效应使用 DSH 缓动/时长令牌')
    // 卡片可见性：淡填充 + shadow-lv1 抬升、hover 用 accent 填充 + shadow-lv2（DSH 画法）。
    assert.ok(src.includes('--dsw-shadow-lv1') && src.includes('--dsw-shadow-lv2'), '模型卡片应有 DSH 层级阴影')
    assert.ok(src.includes('--dsw-alias-interactive-bg-hover-accent'), '卡片 hover 应使用 DSH accent 交互底色')
    assert.ok(!src.includes('dsh-mb-th-'), '不应再有三套本地主题类')
    assert.ok(!src.includes('backdrop-filter'), '面板应为实色卡面（DSH 无磨砂卡面）')
    assert.ok(!src.includes('background-clip:text'), 'hero 数字不再使用渐变文字')
    // 余额主卡：双统计布局（账户余额主位 + 限时额度副位/倒计时胶囊 + 占比条）。
    assert.ok(src.includes('dsh-mb-hero-stats') && src.includes('dsh-mb-hero-bar') && src.includes('dsh-mb-hero-chip'), '余额主卡应为双统计 + 倒计时胶囊 + 占比条布局')
    assert.ok(src.includes('const fmtCny = '), '主卡金额应有千分位格式化助手 fmtCny')
    // 趋势图：悬停浮出模型明细气泡（深色 tooltip），不再用原生 title；首末列防出面板。
    assert.ok(src.includes('dsh-mb-trend-tip') && src.includes('edge-l') && src.includes('edge-r'), '趋势柱悬停应有模型明细气泡（含首末列边缘修正）')
    assert.ok(src.includes('--dsw-alias-tooltip-bg') && src.includes('--dsw-static-neutral-bluish-00'), '气泡应对齐 DSH 原生 tooltip 深底白字规范')
    assert.ok(!src.includes('title: b.date'), '趋势柱不应再用原生 title 气泡')
    // 设置页签：进入即拉取账号列表（否则刷新后账号管理只有表单、没有列表）。
    assert.ok(src.includes("view !== 'settings'") && src.includes('loadAccounts()'), '进入设置页签应自动拉取账号列表')
    assert.ok(src.includes("'账号管理'"), '设置页账号卡片标题应为「账号管理」')
    // 密码可见性切换：图标按钮（eye/eye-off 线稿），不再用「明文/隐藏/查看」汉字文案。
    assert.ok(src.includes('const EyeIcon'), '密码可见性切换应使用 EyeIcon 线稿图标')
    assert.ok(!src.includes("? '隐藏' : '明文'") && !src.includes("? '隐藏' : '查看'"), '密码切换按钮不应再使用汉字文案')
    // 账号切换：余额立即重拉（sessionAccount 进 effect 依赖），页签标注数据归属账号。
    assert.ok(src.includes('loadBalance, sessionAccount]'), '切换账号后应立即重拉余额')
    assert.ok(src.includes('数据账号'), '余额页签应标注数据归属账号')
    // 模型连通检测：卡片状态点手动单测（真实 1-token 推理），点状态点不触发卡片复制。
    assert.ok(src.includes('/model-check') && src.includes('dsh-mb-model-dot'), '模型卡应有连通检测状态点（host /model-check 路由）')
    assert.ok(src.includes('e.stopPropagation()'), '点状态点不应触发卡片复制模型 ID')
    assert.ok(src.includes("m.kind !== 'chat'"), '非 chat 类型模型应禁用推理测试')
    // 死代码回归防护：renderKeysTab 只允许定义一次（第二次定义曾覆盖带复制按钮的版本）。
    assert.equal((src.match(/function renderKeysTab/g) || []).length, 1, 'renderKeysTab 只允许定义一次')
    assert.ok(src.includes('复制完整值'), '密钥页签应保留「复制完整值」能力')
    assert.ok(src.includes('基元律动-费用中心'), '入口/标题文案应为「基元律动-费用中心」')
  } finally {
    for (const fn of cleanups) fn()
  }
  void hooks
})
