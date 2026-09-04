import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const clientPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js')
const src = readFileSync(clientPath, 'utf8')
const hostPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'index.js')
const hostSrc = readFileSync(hostPath, 'utf8')

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
    // 入口与原生「设置」触发行对齐：完整镜像其行几何——calc(100%+4px) 行宽 + 左右
    // -2px 出血 + padding 0 10px 0 8px（图标起点 18px）。当前 DSH 槽位包装层是
    // display:contents（不裁剪出血）；footerActions 是 flex 容器，须 flex:none 防止
    // flex-shrink 收回 +4px；并去掉宿主槽位 scrollbar-gutter:stable 的常驻滚动条槽。
    assert.ok(src.includes('height:42px') && src.includes('width:calc(100% + 4px)'), '入口行应镜像设置触发行宽度（+4px 出血）')
    assert.ok(src.includes('margin:4px -2px 0') && src.includes('padding:0 10px 0 8px'), '入口行应镜像设置触发行的出血与内边距')
    assert.ok(src.includes('flex:none;width:calc(100% + 4px)'), '入口行应 flex:none 防止 flex 容器收回出血宽度')
    assert.ok(src.includes('scrollbar-gutter:auto'), '应去掉宿主槽位的常驻滚动条槽')
    // 限时余额悬浮卡：逐笔（金额 + N 天后失效），无限时数据不渲染、限时为 0 不显示弹窗
    // （用户定稿：不显示总余额、不显示具体日期、无 caption、空数据悬停无反应）。
    assert.ok(src.includes('ExpiringHoverCard'), '入口应有限时余额悬浮卡组件')
    assert.ok(src.includes('expDaysLeft'), '悬浮卡应实时计算剩余天数')
    assert.ok(src.includes("'⏳ 限时余额'"), '悬浮卡头部应为限时余额文案（无总余额）')
    assert.ok(src.includes("'今天失效'") && src.includes("' 天后失效'"), '悬浮卡应展示 N 天后失效（含今天失效）')
    assert.ok(src.includes('HOV_SHOW_DELAY_MS') && src.includes('HOV_HIDE_DELAY_MS'), '悬浮卡应有 hover 显示/收起延时')
    assert.ok(src.includes('hovCapable = hovItems.length > 0 && !s.open'), '无限时数据或面板打开时不显示悬浮卡')
    assert.ok(src.includes('expiringItems: Array.isArray('), '余额响应应把 expiringItems 写入 store')
    // 入口胶囊余额二选一（设置页，插件更新上方）：总余额 / 限时总余额，点击切换
    // 并持久化 prefs；轮询同步模式，面板从未打开入口胶囊也能按设置显示。
    assert.ok(src.includes("'入口胶囊余额'"), '设置页应有「入口胶囊余额」卡片')
    assert.ok(src.includes("'总余额'") && src.includes("'限时总余额'"), '入口胶囊余额应有两个选项')
    assert.ok(src.includes("setEntryBalance('total')") && src.includes("setEntryBalance('expiring')"), '两个选项点击应调 setEntryBalance 切换')
    assert.ok(src.includes('entryBalMode:'), 'store 应有入口胶囊模式字段')
    assert.ok(src.includes("prefs: { entryBalance: mode }"), '切换后应持久化到 prefs')
    assert.ok(src.includes("p.prefs.entryBalance === 'total' || p.prefs.entryBalance === 'expiring'"), '轮询应同步入口胶囊模式')
    assert.ok(src.includes('entryMode === \'expiring\''), '入口胶囊应按模式取值（限时模式取逐笔合计）')
    // 入口图标：基元律动品牌标（brand-logo.svg 图形部分紧裁 viewBox，fill:currentColor，
    // SVG 几何盒 16/18px 与原生线稿图标一致——文字字形度量会导致折叠态图标跑偏）。
    assert.ok(src.includes('const EntryMark') && src.includes("MARK_VIEWBOX = '10.4213 15.2079 60.8522 37.2003'"), '入口图标应为基元律动品牌标 SVG（紧裁 viewBox）')
    assert.ok(src.includes('fill: \'currentColor\''), '品牌标应跟随文字色（明暗主题适配）')
    assert.ok(!src.includes("'¥',"), '入口不应再用 ¥ 文字字形')
    // 设置页备用粘贴：默认折叠。
    assert.ok(src.includes('useState(false) // 默认折叠'), '备用粘贴区应默认折叠')
    // 设置页插件更新卡片：npm dist-tags 比对，只提醒 + 复制命令，不自动执行。
    assert.ok(src.includes("React.createElement('div', { className: 'dsh-mb-set-title' }, '插件更新')"), '设置页应有插件更新卡片')
    assert.ok(src.includes("jsonGet(API + '/update'"), '进入设置页应拉取 /update（host 24h TTL）')
    assert.ok(src.includes("loadUpdate(true)"), '「检查更新」按钮应带 force=1 绕过缓存')
    assert.ok(src.includes("copyText('dsh plugin add dsh-tokenrhythm-bill')"), '复制更新命令应为 dsh plugin add（不自动执行）')
    assert.ok(src.includes("jsonPost(API + '/update/ignore'"), '忽略此版本应调 /update/ignore')
    assert.ok(src.includes("'本地开发模式'"), 'local 安装模式应显示本地开发模式标识')
    assert.ok(src.includes("'已是最新版本'") && src.includes("'有新版本 v'"), '状态行应区分最新/有新版本')
    assert.ok(src.includes("'已忽略 v'"), '被忽略的版本应有独立文案')
    assert.ok(src.includes('.dsh-mb-upd-state.new'), '有新版本时状态行应有强调色')
    // 加载骨架屏：三页签的加载占位与真实内容同构（shimmer 微光扫过，尊重系统减动效）。
    assert.ok(src.includes('dsh-mb-skel-cards') && src.includes('dsh-mb-skel-hero') && src.includes('dsh-mb-skel-rows'), '模型/余额/密钥页签应有同构骨架屏占位')
    assert.ok(src.includes('@keyframes dsh-mb-shimmer') && src.includes('prefers-reduced-motion:reduce'), '骨架屏应有 shimmer 动效并尊重系统减动效设置')
    assert.ok(!src.includes("key: 'ld' }, '加载中…'"), '不应再有纯文字加载占位')
    // 分类筛选行滚动固定：sticky 钉在滚动容器顶部，负 margin 铺满左右内边距并垫实色底。
    assert.ok(src.includes('.dsh-mb-cats{position:sticky'), '模型分类筛选行应滚动固定（sticky）')
    // 缓存标签并入分类行，整行保持一行（放不下横向滚动）。
    assert.ok(src.includes('const cacheTag') && src.includes('flex-wrap:nowrap') && src.includes('.dsh-mb-cache-tag{'), '缓存标签应并入分类行且整行保持一行')
    // 模型卡片：对齐平台官方结构——headline（名称+状态胶囊）/ subline（模型 ID+来源）
    // / details 两栏 dl（规格：序列长度/支持模态/最大输出长度；价格：输入/输出/缓存命中）。
    assert.ok(src.includes('dsh-mb-card-name') && src.includes('dsh-mb-card-dl') && src.includes("'模型 ID: '"), '模型卡片应对齐平台官方结构（名称+胶囊 / ID+来源 / 两栏 dl）')
    assert.ok(src.includes("'序列长度'") && src.includes("'缓存命中单价'") && src.includes('dsh-mb-card-price-old'), '卡片规格/价格两栏字段与折扣划线价应对齐官方')
    assert.ok(src.includes("m.platformStatus === 'online' ? '在线'") && src.includes("'测试中'"), '平台状态应映射为在线/测试中文案')
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
    // 数据账号显示平台用户名而非登录手机号：manifest 带 accountName（/api/me 提取），
    // 标签优先取它，其次余额响应 account，都缺才回退登录标识 account（手机号）。
    assert.ok(src.includes('manifest.session.accountName') && src.includes('sessionAccountName ||'), '数据账号应优先显示平台用户名（manifest accountName）')
    assert.ok(hostSrc.includes('accountName: meName || null'), 'manifest 会话应带 accountName（平台用户名，两种登录模式都取）')
    // 0.3.3 移除手动连通检测：连通点改为状态页探测自动点亮（只读、零扣费）。
    assert.ok(!src.includes('/model-check') && !hostSrc.includes('/model-check'), '手动连通检测应双端移除（/model-check）')
    assert.ok(!src.includes('checkModel'), 'checkModel 回调应已删除')
    assert.ok(src.includes('dsh-mb-card-status-dot'), '状态胶囊圆点应反映状态页探测结果（ok/deg/fail，无数据中性灰）')
    // 死代码回归防护：renderKeysTab 只允许定义一次（第二次定义曾覆盖带复制按钮的版本）。
    assert.equal((src.match(/function renderKeysTab/g) || []).length, 1, 'renderKeysTab 只允许定义一次')
    assert.ok(src.includes('复制完整值'), '密钥页签应保留「复制完整值」能力')
    // 状态页签（0.3.3）：服务状态总览 + 模型卡片连通点自动联动。
    assert.ok(src.includes("[['balance', '余额'], ['models', '模型'], ['status', '状态'], ['keys', '密钥']]"), '页签顺序应为 余额/模型/状态/密钥')
    assert.ok(src.includes("useState('balance')") && src.includes("useRef('balance')"), '默认落地页签应为余额')
    assert.ok(src.includes('function renderStatusTab'), '状态页签应有渲染函数')
    assert.ok(src.includes("jsonGet(API + '/status?range='"), '状态数据应经 host /status 按 range 拉取（浏览器不跨域直连状态站）')
    assert.ok(src.includes("useState('24h')") && src.includes("'24小时'") && src.includes('dsh-mb-st-rbtn'), '状态页应有官方同款 24小时/7天/90天 视图切换（默认 24h）')
    assert.ok(src.includes('slotCodes') && src.includes('bucketize') && src.includes('SLOT_BUCKETS'), '24h/7d 应按桶重采样渲染格子（最差状态上色，不出滚动条）')
    assert.ok(!src.includes('dsh-mb-st-cells.scroll'), '状态格子不应出现横向滚动条（全部 flex 自适应铺满）')
    assert.ok(src.includes('slotPct') && src.includes("ch === 'u' ? ' up' : ch === 'g' ? ' degraded'") === false && src.includes("b.worst === 'u' ? ' up' : b.worst === 'g' ? ' degraded'"), '桶格子上色应取桶内最差状态')
    assert.ok(src.includes('setInterval(loadStatus, 60 * 1000)'), '状态页签应 60s 轮询')
    assert.ok(!src.includes('statusByModel'), '模型页签探测联动应已移除（探测详情只在「状态」页签）')
    assert.ok(src.includes('dsh-mb-card-disc') && src.includes('.dsh-mb-card-disc{') && !src.includes('dsh-mb-card-meta,.dsh-mb-card-details'), '折扣徽章应为实底绿白字（标题行最左、行内排布不改变卡片布局）')
    assert.ok(src.includes('dsh-mb-card-status-dot'), '状态胶囊圆点应反映状态（ok/deg/fail，无数据中性灰）')
    assert.ok(src.includes("pillCls === ' on' ? ' ok' : pillCls === ' testing' ? ' deg'"), '胶囊圆点颜色应跟随胶囊色调（测试中=琥珀，不出现绿点）')
    assert.ok(src.includes('setStatusOpen({})') && src.includes('statusSnapRef'), '新快照到达应重置分组折叠（对齐官方：问题组自动展开重算）')
    assert.ok(src.includes('.dsh-mb-card-status-dot.deg'), '状态胶囊圆点应有 deg 琥珀态 CSS')
    assert.ok(src.includes('ST_TONE') && src.includes("'部分服务中断'"), '整体状态文案应对齐官方页（部分服务中断等）')
    assert.ok(src.includes('stVendorOf') && src.includes('ST_VENDORS') && src.includes("'平台网关'"), '通道应按厂商分组（官方 VENDOR_MAP 方式，平台网关排最前）')
    assert.ok(src.includes('dsh-mb-st-vgroup') && src.includes('statusOpen'), '厂商分组应为折叠面板（问题组自动展开，statusOpen 记录手动覆盖）')
    assert.ok(src.includes('dsh-mb-st-banner') && src.includes('dsh-mb-st-mrow') && src.includes('dsh-mb-st-inc'), '状态页签应有横幅/官方 mrow 通道行/事故样式')
    assert.ok(src.includes('dsh-mb-st-cell') && src.includes("v >= 995 ? ' up' : v >= 950 ? ' degraded'"), '展开行应照官方渲染 90 天逐日柱条（绿≥99.5/琥珀≥95/红）')
    assert.ok(src.includes("'OpenAI 兼容端点'") && src.includes('modelDaily') && src.includes('metaOf'), '行元信息与逐日序列应来自 host /status（days/modelDaily/meta）')
    assert.ok(hostSrc.includes("'/dsh-tokenrhythm-bill/status'"), 'host 应有 /status 路由')
    assert.ok(hostSrc.includes('status.moonlink.top'), 'host 应指向状态页上游')
    assert.ok(hostSrc.includes('STATUS_TTL_MS'), 'host /status 应有 TTL 缓存')
    assert.ok(src.includes('基元律动-费用中心'), '入口/标题文案应为「基元律动-费用中心」')
  } finally {
    for (const fn of cleanups) fn()
  }
  void hooks
})

test('Panel 状态页签真实渲染（24h/90d 两档，防 TDZ / 运行时崩溃回归）', () => {
  // 等价真实渲染器的桩：函数组件在 createElement 时立即执行（这样 renderStatusTab
  // 会真正跑起来，RANGE_LABELS 之类「先使用后声明」的 TDZ 崩溃能在这里拦住）；
  // useState 记录 init 序列，第二次渲染按 overrides 下标注入 view/pos/statusData。
  const seq = []
  let overrides = {}
  const R = {
    createElement: (type, props, ...children) => (typeof type === 'function' ? type(props || {}) : { type, props, children }),
    useState: (init) => {
      const i = seq.length
      seq.push(init)
      const v = Object.prototype.hasOwnProperty.call(overrides, i)
        ? overrides[i]
        : (typeof init === 'function' ? init() : init)
      return [v, () => {}]
    },
    useEffect: () => {},
    useRef: (init) => ({ current: init === undefined ? null : init }),
    useCallback: (fn) => fn,
  }
  const registered = []
  const renderFns = {}
  globalThis.window = { __ModuleLoader__: { load: (reg) => registered.push(reg) }, innerWidth: 1440, innerHeight: 900 }
  globalThis.document = {
    head: { appendChild: () => {} },
    createElement: () => ({ setAttribute() {}, select() {}, get parentNode() { return null } }),
    body: { appendChild: () => {}, removeChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    execCommand: () => true,
  }
  new Function('window', 'document', 'require', src)(globalThis.window, globalThis.document, () => R)
  const slots = {
    inject: (name, fn) => { fn(); void name },
    register: (meta, renderFn) => { renderFns[meta.name] = renderFn; return meta.id },
  }
  const cleanups2 = []
  try {
    registered[0].factory(() => R).apply({
      get: (k) => (k === 'slots' ? slots : undefined),
      effect: (fn) => { const r = fn(); if (typeof r === 'function') cleanups2.push(r); return r },
    })
    assert.ok(renderFns['sidebar.footer.action'] && renderFns['shell.overlay'], 'apply 应注册侧栏入口与面板')
    // 关闭态跑一遍：只记录 hook init 序列（hooks 全在顶部，早退不影响计数）
    renderFns['shell.overlay']()
    const viewIdx = seq.indexOf('balance')
    const rangeIdx = seq.indexOf('24h')
    assert.ok(viewIdx >= 0 && rangeIdx > viewIdx, 'hook 序列应含 view(balance) 与 statusRange(24h)')
    const posIdx = viewIdx + 1
    const dataIdx = rangeIdx - 1
    // 打开面板：入口树里触发全部 onClick（其中一个 setStore({open:true})）
    const onClicks = []
    const walk = (el, depth = 0) => {
      if (el === null || el === undefined || typeof el !== 'object' || depth > 40) return
      if (el.props && typeof el.props.onClick === 'function') onClicks.push(el.props.onClick)
      const kids = Array.isArray(el.children) ? el.children : []
      for (const k of kids) { const list = Array.isArray(k) ? k : [k]; for (const kk of list) walk(kk, depth + 1) }
    }
    walk(renderFns['sidebar.footer.action']())
    assert.ok(onClicks.length > 0, '入口应有点击处理器')
    for (const fn of onClicks) { try { fn() } catch { /* 桩环境下的副作用忽略 */ } }
    const collectCls = (el, acc, depth = 0) => {
      if (el === null || el === undefined || typeof el !== 'object' || depth > 40) return
      if (el.props && typeof el.props.className === 'string') acc.push(el.props.className)
      const kids = Array.isArray(el.children) ? el.children : []
      for (const k of kids) { const list = Array.isArray(k) ? k : [k]; for (const kk of list) collectCls(kk, acc, depth + 1) }
    }
    const base = {
      ok: true, overall: 'operational', checkedAt: 1757000000, probedAt: 1757000000000,
      modelCount: 3, upCount: 2, todayAvail: 99.5, avgTtfb: 300, historyDays: 25, unresolvedCount: 0,
      stale: false, daily: [{ d: '2026-09-01', v: 995 }], days: ['2026-09-01'],
      incidents: [
        { title: '网关探测超时', detail: '上游 HTTP 503', startedAt: 1756999000, resolvedAt: 1756999600 },
        { title: '模型延迟升高', detail: '', startedAt: 1757000000, resolvedAt: null },
      ],
      unresolvedCount: 1,
      meta: { 'glm-5.1': '200K · ¥8/28' },
      modelDaily: { '@api': [null], 'glm-5.1': [995], 'qwen3.7-max': [980] },
      models: [
        { id: '@api', status: 'up', ttfb: 210, http: 200, error: '', a24: 100, a7: 100, a90: 99.8 },
        { id: 'glm-5.1', status: 'up', ttfb: 312, http: 200, error: '', a24: 100, a7: 100, a90: 99.8 },
        { id: 'qwen3.7-max', status: 'degraded', ttfb: 1500, http: 200, error: '', a24: 98, a7: 99, a90: 99.4 },
      ],
    }
    // pass 24h：qwen 降级组自动展开 → 桶格子渲染
    overrides = {
      [viewIdx]: 'status',
      [posIdx]: { x: 0, y: 0, w: 520, h: 600 },
      [rangeIdx]: '24h',
      [dataIdx]: { ...base, range: '24h', slotGrid: [['2026-09-04', ['10:00', '10:05', '10:10']]], slotCodes: { '@api': 'uuu', 'glm-5.1': 'uug', 'qwen3.7-max': 'udu' } },
    }
    seq.length = 0
    const cls24 = []
    collectCls(renderFns['shell.overlay'](), cls24)
    assert.ok(cls24.includes('dsh-mb-st-rangebar'), '24h 应渲染视图切换条')
    assert.equal(cls24.filter((c) => c === 'dsh-mb-st-rbtn' || c.startsWith('dsh-mb-st-rbtn ')).length, 3, '应有 3 个区间按钮（24小时/7天/90天）')
    assert.ok(cls24.includes('dsh-mb-st-mrow') && cls24.some((c) => c.startsWith('dsh-mb-st-cell')), '24h 应渲染通道行与桶格子')
    assert.ok(cls24.some((c) => c === 'dsh-mb-st-inc') && cls24.some((c) => c.startsWith('dsh-mb-st-inc-chip')) && cls24.includes('dsh-mb-st-inc-hd'), '事故卡应为时间线样式（竖轨 + 状态软徽章 + 计数头）')
    assert.ok(!cls24.some((c) => String(c).includes('scroll')), '24h 不应出现滚动容器')
    // pass 90d：逐日柱条渲染
    overrides = {
      [viewIdx]: 'status',
      [posIdx]: { x: 0, y: 0, w: 520, h: 600 },
      [rangeIdx]: '90d',
      [dataIdx]: { ...base, range: '90d', slotGrid: null, slotCodes: null },
    }
    seq.length = 0
    const cls90 = []
    collectCls(renderFns['shell.overlay'](), cls90)
    assert.ok(cls90.includes('dsh-mb-st-mrow') && cls90.some((c) => c.startsWith('dsh-mb-st-cell')), '90d 应渲染逐日柱条')
    assert.ok(!cls90.some((c) => String(c).includes('scroll')), '90d 不应出现滚动容器')
  } finally {
    for (const fn of cleanups2) fn()
    overrides = {}
  }
})
