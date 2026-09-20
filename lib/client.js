/**
 * dsh-tokenrhythm-bill client half: the browser panel, loaded by the web
 * ModuleLoader as a plain React plugin. It injects:
 *   - a sidebar footer entry button (slot `sidebar.footer.action`, rendered
 *     right above the settings button) with an amber alert dot when the
 *     expiring quota is close to expiry or balance runs low;
 *   - a draggable/resizable frosted-glass panel (slot `shell.overlay`) with
 *     tabs (余额 / 模型 / 状态 / 密钥) and a gear in the top-right corner for settings:
 *       余额    — expiring-quota hero, daily usage (incl. cache hits),
 *                 7-day cost sparkline, recent calls list;
 *       模型    — category chips (全部/文本/图像/音频/视频/向量) + model cards;
 *                 click a card to copy its model id (platform status pill only);
 *       状态    — 自定义检测: tick chat models + 立即检测 / 定时间隔, the host
 *                 probes with the DSH-configured key (real 1-token billing),
 *                 per-model result dot + latency (official status site killed
 *                 probing on 2026-09-14, so the old health section is removed);
 *       设置    — paste/clear the tokenrhythm session cookie, key status.
 * The title hosts a provider switcher (基元 | 阶跃 | ZCode); the ZCode half shows
 * plan quota (用量) and claimable activities (活动) read from ~/.zcode/v2
 * credentials via the host. Settings opens as a modal over the panel (gear).
 *
 * Host communication is plain HTTP to /dsh-tokenrhythm-bill/* (same origin).
 * Panel geometry persists via the Host's /prefs endpoint. A 5-minute
 * background poll keeps the alert dot fresh even while the panel is closed.
 * Secrets never reach this half: the Host only ever sends masked hints.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tokenrhythm-bill',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    const API = '/dsh-tokenrhythm-bill';

    // ---- tiny cross-component store（入口按钮与面板分属两个槽位，需要共享状态）。
    // balanceCny 独立于 alert 存放：alert 只在低余额/临期时有值，正常余额时为 null，
    // 入口常驻的总余额不能挂在它上面 ----
    const store = { open: false, view: 'models', alert: null, balanceCny: null, expiringItems: [], entryBalMode: 'total', provider: 'tr', stepEntry: null, stepConfigured: true, stepTakeover: true, settingsOpen: false, zcEntry: null, zcodeEnabled: false };
    const listeners = new Set();
    const setStore = (patch) => {
      Object.assign(store, patch);
      for (const fn of listeners) { try { fn() } catch { /* 单个订阅者异常不拖垮其它 */ } }
    };
    const useStore = () => {
      const [, force] = useState(0);
      useEffect(() => {
        const fn = () => force((n) => n + 1);
        listeners.add(fn);
        return () => listeners.delete(fn);
      }, []);
      return store;
    };

    // ---- fetch helpers ----
    const jsonGet = async (path) => {
      try {
        const res = await fetch(path, { cache: 'no-store' });
        return await res.json();
      } catch { return null }
    };
    const jsonPost = async (path, body) => {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await res.json();
      } catch { return null }
    };

    // ---- 剪贴板 ----
    const copyText = async (text) => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true }
        const ta = document.createElement('textarea')
        ta.value = text
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        return true
      } catch { return false }
    }

    // ---- formatting ----
    const trimNum = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—'
      const r = Math.abs(n) >= 100 ? Math.round(n * 10) / 10 : Math.round(n * 1000) / 1000
      return String(r)
    }
    // 主卡金额：≥1000 加千分位（¥1,669.3），其余与 trimNum 口径一致。
    const fmtCny = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—'
      if (Math.abs(n) >= 1000) return (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })
      return trimNum(n)
    }
    const fmtCtx = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return null
      if (n >= 1000000) return trimNum(n / 1000000) + 'M'
      if (n >= 1000) return trimNum(n / 1000) + 'K'
      return String(n)
    }
    // 更新检测时间：今天显示 HH:MM，更早显示 M-D。
    const fmtCheckedAt = (ts) => {
      const d = new Date(ts)
      if (!Number.isFinite(d.getTime())) return ''
      const now = new Date()
      const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
      if (sameDay) return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
      return (d.getMonth() + 1) + '-' + d.getDate()
    }
    const fmtTokens = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—'
      if (Math.abs(n) >= 100000000) return trimNum(n / 100000000) + ' 亿'
      if (Math.abs(n) >= 10000) return trimNum(n / 10000) + ' 万'
      return String(Math.round(n))
    }
    // 状态页首字延迟：≥1s 显示 x.xs，其余整 ms（矩阵与连通点共用）。
    const fmtMsShort = (v) => {
      if (v === null || v === undefined || !Number.isFinite(v)) return '—'
      return v >= 1000 ? trimNum(v / 1000) + 's' : Math.round(v) + 'ms'
    }
    // 连通检测：失败原因文案（结果行悬浮提示）。
    const PROBE_KIND_TEXT = {
      rate_limited: '限流',
      auth_error: '认证失败',
      model_not_found: '模型不存在',
      server_error: '服务端错误',
      timeout: '超时',
      network_error: '网络错误',
      client_error: '请求被拒',
    }
    // 模型是否可连通检测：仅 chat 类（图像/音频/视频/向量不支持 chat completions）；
    // 网关回退模型（无 kind、无 categories）视作文本组 → 可检测。
    const canCheckModel = (m) => {
      if (m.kind && m.kind !== 'chat') return false
      if (Array.isArray(m.categories) && m.categories.length > 0 && m.categories.indexOf('text') === -1) return false
      return true
    }
    // 本地探测结果时间戳 → HH:MM；兼容 epoch 秒（探测结果）与毫秒（定时下次时刻）。
    const fmtProbeTime = (ts) => {
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return ''
      const d = new Date(ts > 1e12 ? ts : ts * 1000)
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    }
    // 价格单元格（官方样式）：折扣时划线原价 + 折后现价，¥x.xx/M。
    const priceCell = (base, eff) => {
      const discounted = eff !== null && eff !== undefined && eff !== base
      const cur = discounted ? eff : base
      return React.createElement('span', { className: 'dsh-mb-card-price' },
        discounted ? React.createElement('span', { className: 'dsh-mb-card-price-old' }, '¥' + trimNum(base) + '/M') : null,
        '¥' + cur.toFixed(2) + '/M')
    }
    // 到期天数：按「日历日」算（今天到期 = 0、明天 = 1、已过期 < 0）；缺失/解析失败返回 null。
    // 不用 Math.ceil((t-now)/86400000)：今晚到期会被算成 1 天，胶囊会写成「明天到期 · 今天日期」。
    const expiryDaysOf = (expireAt) => {
      if (expireAt === null || expireAt === undefined) return null
      const t = typeof expireAt === 'number' ? expireAt : Date.parse(expireAt)
      if (!Number.isFinite(t)) return null
      const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
      return Math.round((dayStart(t) - dayStart(Date.now())) / 86400000)
    }
    // 到期文案：0 → 今天到期、1 → 明天到期、N → N 天后到期、负数 → 已到期。
    // 天数缺失时退「即将到期」——绝不把 undefined / NaN 拼进用户可见文案。
    const expiryLabel = (days) => {
      if (days === null || days === undefined || !Number.isFinite(days)) return '即将到期'
      if (days < 0) return '已到期'
      if (days === 0) return '今天到期'
      if (days === 1) return '明天到期'
      return days + ' 天后到期'
    }
    // 预警判定：临期 ≤3 天且还有限时额度，或可用余额 < ¥10。
    // 字段名必须与读取端（入口 title / 余额横幅）一致：曾写 expDays 而读 expiringDays，
    // 横幅于是渲染成「限时额度 ¥67.986 将于 undefined 天后到期」。已过期（负数）不算临期，
    // 避免对已经作废的额度反复催办。
    const alertOf = (d) => {
      if (!d) return null
      const expiringDays = expiryDaysOf(d.nextExpiryAt)
      const low = d.availableBalanceCny !== null && d.availableBalanceCny !== undefined && d.availableBalanceCny < 10
      const expiring = expiringDays !== null && expiringDays >= 0 && expiringDays <= 3 && (d.expiringBalanceCny || 0) > 0
      if (!low && !expiring) return null
      return { low, expiring, expiringDays, expiringBalanceCny: d.expiringBalanceCny, availableBalanceCny: d.availableBalanceCny }
    }

    // ---- 阶跃入口胶囊仲裁（面板切到「阶跃」→ 胶囊跟随显示阶跃数据）----
    // 数据优先级按 prefs.mode：auto = Credit 月池剩余% → 官方 API 预付费余额 → 无则
    // 回落基元（绝不出现空胶囊）。纯函数放模块内供源码级测试断言。
    function computeStepEntry({ plan, balance, prefs }) {
      const p = prefs || {}
      if (p.takeover === false) return null
      const mode = p.mode === 'credits' || p.mode === 'balance' ? p.mode : 'auto'
      const c = plan && plan.credit
      if ((mode === 'auto' || mode === 'credits') && c && c.credits && c.credits.total > 0) {
        const pct = Math.max(0, Math.min(100, Math.round((c.credits.residual / c.credits.total) * 1000) / 10))
        return { label: '阶跃', value: pct + '%' }
      }
      const b = balance && balance.account
      if ((mode === 'auto' || mode === 'balance') && b && Number.isFinite(b.balance)) {
        return { label: '阶跃', value: '¥' + b.balance.toFixed(2) }
      }
      return null
    }

    // ---- ZCode 入口胶囊仲裁（面板切到「ZCode」→ 胶囊跟随显示套餐剩余）----
    // 数据优先级：有总量 → 剩余百分比（与阶跃 Credit 同款口径）；无总量只有余量
    // → token 缩写；无凭证 / 空套餐 / 未选中 → null（胶囊整体回落基元身份）。
    function computeZcEntry({ provider, quota }) {
      if (provider !== 'zcode' || !quota || quota.ok === false) return null
      if (quota.source === 'no_plan' || quota.isEmpty === true) return null
      const r = quota.remaining
      if (r === null || r === undefined || !Number.isFinite(r)) return null
      if (Number.isFinite(quota.total) && quota.total > 0 && Number.isFinite(quota.percentUsed)) {
        const pct = Math.max(0, Math.min(100, Math.round((100 - quota.percentUsed) * 10) / 10))
        return { label: 'ZCode', value: pct + '%' }
      }
      return { label: 'ZCode', value: fmtTokens(r) }
    }

    // ---- 侧栏入口按钮：形态由宿主侧栏的 wide 标志驱动（与原生「新会话」按钮同一套
    // 折叠编排：收起时宽栏内容随侧栏淡出，settle 后 rail 图标淡入），宿主未传 wide 时
    // 回退到容器查询；有预警时图标右上角琥珀点 ----
    const ENTRY_LABEL = '基元律动-费用中心'
    // 面板切到阶跃时，弹窗标题与侧栏胶囊整体换成阶跃星辰身份（用户定稿）
    const STEP_ENTRY_LABEL = '阶跃星辰-费用中心'
    // 面板切到 ZCode 时，胶囊换成 ZCode 身份（显示套餐剩余%）
    const ZC_ENTRY_LABEL = 'ZCode-费用中心'
    // 限时余额悬浮卡：只显示逐笔限时额度（金额 + N 天后失效），无限时数据不渲染、
    // 限时为 0 不显示弹窗（用户定稿）。fixed 定位按入口 rect 计算，进卡片保持显示。
    const HOV_SHOW_DELAY_MS = 400
    const HOV_HIDE_DELAY_MS = 150
    const HOV_WIDTH = 260
    const expDaysLeft = (expireAt) => {
      const days = expiryDaysOf(expireAt)
      // 已过期逐笔（平台可能仍列出）夹到 0：显示「今天失效」，不出现负数天数。
      return days === null ? null : Math.max(0, days)
    }
    function ExpiringHoverCard({ rect, items, onEnter, onLeave, onOpen }) {
      const total = items.reduce((acc, it) => acc + (Number.isFinite(it.amountCny) ? it.amountCny : 0), 0)
      const left = Math.max(8, Math.min(rect.right - HOV_WIDTH, window.innerWidth - HOV_WIDTH - 8))
      const bottom = Math.max(8, window.innerHeight - rect.top + 8)
      return React.createElement('div', {
        className: 'dsh-mb-hov',
        style: { left: left + 'px', bottom: bottom + 'px', width: HOV_WIDTH + 'px' },
        onMouseEnter: onEnter,
        onMouseLeave: onLeave,
        onClick: onOpen,
        role: 'status',
      },
        React.createElement('div', { className: 'dsh-mb-hov-head' },
          '⏳ 限时余额' + (items.length > 1 ? ' · 共 ¥' + fmtCny(total) : '')),
        items.map((it, i) => {
          const days = expDaysLeft(it.expireAt)
          const soon = days !== null && days <= 3
          return React.createElement('div', { key: i, className: 'dsh-mb-hov-item' + (soon ? ' soon' : '') },
            React.createElement('span', { className: 'dsh-mb-hov-amt' }, '¥' + fmtCny(it.amountCny)),
            React.createElement('span', { className: 'dsh-mb-hov-days' },
              days === null ? '到期时间未知' : days === 0 ? '今天失效' : days + ' 天后失效'),
          )
        }),
      )
    }
    function EntryButton(props) {
      const hasWide = !!(props && Object.prototype.hasOwnProperty.call(props, 'wide'))
      const wide = hasWide ? !!props.wide : true
      const s = useStore()
      // 阶跃胶囊接管标记（面板切到阶跃 → 胶囊跟随显示阶跃数据）
      const stepOn = s.provider === 'step' && s.stepEntry && typeof s.stepEntry.value === 'string' && s.stepEntry.value !== ''
      // ZCode 胶囊接管标记（面板切到 ZCode → 胶囊跟随显示套餐剩余%）
      const zcOn = s.provider === 'zcode' && s.zcEntry && typeof s.zcEntry.value === 'string' && s.zcEntry.value !== ''
      // 阶跃身份（图标/文字随面板切换；账号被删 / 设置「不接管」时整体回落基元身份）
      const stepProv = s.provider === 'step' && s.stepConfigured !== false && s.stepTakeover !== false
      // ZCode 身份：只要面板切到 ZCode 就换图标/文字；数值缺席时胶囊回落基元余额
      const zcProv = s.provider === 'zcode'
      const title = zcOn
        ? ZC_ENTRY_LABEL + '（' + s.zcEntry.value + '）'
        : stepOn
          ? STEP_ENTRY_LABEL + '（' + s.stepEntry.value + '）'
          : s.alert && !stepProv && !zcProv
            ? ENTRY_LABEL + '（' + (s.alert.expiring ? '限时额度 ' + expiryLabel(s.alert.expiringDays) : '余额不足') + '）'
            : zcProv ? ZC_ENTRY_LABEL : stepProv ? STEP_ENTRY_LABEL : ENTRY_LABEL
      // 悬浮卡：按钮 hover 400ms 显示，移开 150ms 收起；移入卡片不中断。
      const [hovOpen, setHovOpen] = useState(false)
      const [hovRect, setHovRect] = useState(null)
      const btnRef = useRef(null)
      const hovTimers = useRef({ open: null, close: null })
      useEffect(() => () => {
        clearTimeout(hovTimers.current.open)
        clearTimeout(hovTimers.current.close)
      }, [])
      const hovItems = Array.isArray(s.expiringItems) ? s.expiringItems : []
      const hovCapable = hovItems.length > 0 && !s.open && !stepOn && !zcProv
      const hovEnter = (immediate) => {
        clearTimeout(hovTimers.current.close)
        clearTimeout(hovTimers.current.open)
        if (!hovCapable) return
        const btn = btnRef.current
        if (btn) setHovRect(btn.getBoundingClientRect())
        hovTimers.current.open = setTimeout(() => setHovOpen(true), immediate ? 0 : HOV_SHOW_DELAY_MS)
      }
      const hovLeave = () => {
        clearTimeout(hovTimers.current.open)
        clearTimeout(hovTimers.current.close)
        hovTimers.current.close = setTimeout(() => setHovOpen(false), HOV_HIDE_DELAY_MS)
      }
      const btnProps = {
        className: 'dsh-mb-entry' + (s.open ? ' active' : '') + (wide ? '' : ' rail'),
        'aria-label': zcProv ? ZC_ENTRY_LABEL : stepProv ? STEP_ENTRY_LABEL : ENTRY_LABEL,
        ref: btnRef,
        onClick: () => setStore({ open: !s.open }),
        onMouseEnter: () => hovEnter(false),
        onMouseLeave: hovLeave,
      }
      if (!hovCapable) btnProps.title = title // 有悬浮卡时去掉原生 title，避免双气泡
      if (hasWide) btnProps['data-wide'] = wide ? '1' : '0'
      // 胶囊金额按设置模式取值：total = 账户总余额；expiring = 逐笔限时合计（无
      // 限时数据时不显示胶囊，与「限时为 0 不显示弹窗」同口径）。
      const entryMode = s.entryBalMode === 'expiring' ? 'expiring' : 'total'
      let pillVal = null
      if (entryMode === 'total') pillVal = s.balanceCny
      else if (hovItems.length > 0) pillVal = hovItems.reduce((a, it) => a + (Number.isFinite(it.amountCny) ? it.amountCny : 0), 0)
      let balText = pillVal !== null && pillVal !== undefined ? '¥' + fmtCny(pillVal) : null
      // 面板切到阶跃 → 胶囊改显阶跃数据（host 侧仲裁结果由 store.stepEntry 携带）
      if (stepOn) balText = s.stepEntry.value
      // 面板切到 ZCode → 胶囊改显套餐剩余%（store.zcEntry 由 Panel 仲裁）
      if (zcOn) balText = s.zcEntry.value
      return React.createElement(React.Fragment, null,
        React.createElement('button', btnProps,
          wide ? React.createElement('span', { className: 'dsh-mb-entry-left' },
            React.createElement('span', { className: 'dsh-mb-entry-icon' },
              zcProv ? ZcMark({ size: 16 }) : stepProv ? StepMark({ size: 16 }) : EntryMark({ size: 16 }),
              s.alert && !stepProv && !zcProv ? React.createElement('span', { className: 'dsh-mb-dot' }) : null,
            ),
            React.createElement('span', { className: 'dsh-mb-entry-label wide-in' }, zcProv ? ZC_ENTRY_LABEL : stepProv ? STEP_ENTRY_LABEL : ENTRY_LABEL),
          ) : React.createElement('span', { className: 'dsh-mb-entry-icon' },
            zcProv ? ZcMark({ size: 18 }) : stepProv ? StepMark({ size: 18 }) : EntryMark({ size: 18 }),
            s.alert && !stepProv && !zcProv ? React.createElement('span', { className: 'dsh-mb-dot' }) : null,
          ),
          wide && balText ? React.createElement('span', { className: 'dsh-mb-entry-bal' + (s.alert && !stepProv && !zcProv ? ' alert' : '') }, balText) : null,
        ),
        hovOpen && hovCapable && hovRect
          ? React.createElement(ExpiringHoverCard, {
            rect: hovRect,
            items: hovItems,
            onEnter: () => hovEnter(true),
            onLeave: hovLeave,
            onOpen: () => { setHovOpen(false); setStore({ open: true }) },
          })
          : null,
      )
    }

    // 密码可见性图标（feather eye / eye-off 线稿，替代「明文/隐藏」汉字按钮文案）。
    const EyeIcon = ({ off }) => React.createElement('svg', {
      viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor',
      strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
    },
      off
        ? [
          React.createElement('path', { key: 'p', d: 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24' }),
          React.createElement('line', { key: 'l', x1: 1, y1: 1, x2: 23, y2: 23 }),
        ]
        : [
          React.createElement('path', { key: 'p', d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' }),
          React.createElement('circle', { key: 'c', cx: 12, cy: 12, r: 3 }),
        ],
    )

    // 侧栏入口图标：基元律动品牌标（tokenrhythm.studio 官方 brand-logo.svg 的图形部分，
    // 三个 fill path；viewBox 按墨迹紧裁 10.4213 15.2079 60.8522 37.2003；fill:currentColor
    // 跟随文字色，明暗主题自动适配）。SVG 几何盒与原生 16/18px 线稿图标一致，折叠态不跑偏。
    const MARK_VIEWBOX = '10.4213 15.2079 60.8522 37.2003'
    const MARK_ASPECT = 37.2003 / 60.8522
    const MARK_PATHS = ["M28.2869 15.3313L52.3032 15.3318C56.6495 15.332 61.1409 15.3885 65.4782 15.3038C62.4476 17.8251 58.7745 21.2659 55.8259 23.9557C54.451 24.0375 52.5027 23.9839 51.0859 23.9842C48.459 23.9946 45.832 23.9874 43.2052 23.9626C44.8543 25.4287 47.4485 28.1941 49.1119 29.8604L61.0355 41.7999L68.4647 49.2348C68.9123 49.6831 71.0764 51.7891 71.2735 52.1321L71.1537 52.1688C67.1352 52.0344 62.9706 52.1522 58.9688 51.9728L45.811 38.8082C42.8897 35.885 39.8219 32.8966 36.9616 29.9257L36.9693 44.1437C34.1378 46.911 31.1624 49.6754 28.2845 52.4082L28.2869 15.3313Z","M66.8075 16.3432C66.9854 16.5409 66.8988 26.5212 66.8939 27.8531C64.2096 30.6301 61.1162 33.5951 58.3448 36.3093L55.4318 33.3274C54.3728 32.2341 53.3067 31.1479 52.2334 30.0688L66.8075 16.3432Z","M20.3634 15.2565C22.2816 15.2079 24.3745 15.2491 26.3065 15.2484C26.241 18.0694 26.2922 21.1045 26.2817 23.9411L16.4729 23.9386C14.5285 23.9342 12.3458 23.8846 10.4213 23.964C13.7597 21.1535 17.0176 18.0347 20.3634 15.2565Z"]
    const EntryMark = ({ size }) => React.createElement('svg', {
      width: size, height: size * MARK_ASPECT, viewBox: MARK_VIEWBOX, fill: 'none',
      'aria-hidden': 'true',
    }, MARK_PATHS.map((d, i) => React.createElement('path', { key: i, d, fill: 'currentColor' })))

    // 侧栏入口图标（阶跃模式）：自绘品牌意象线稿——「阶跃」三级台阶 +「星辰」四芒星；
    // 与原生 feather 线稿同 24 viewBox / stroke 2 / currentColor，明暗主题自动适配。
    const StepMark = ({ size }) => React.createElement('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    },
      React.createElement('path', { key: 's', d: 'M3 20.5h5v-4.5h4.5V11.5' }),
      React.createElement('path', {
        key: 'star',
        d: 'M18.5 1.8L20.1 4.4L22.7 6L20.1 7.6L18.5 10.2L16.9 7.6L14.3 6L16.9 4.4Z',
        fill: 'currentColor', stroke: 'none',
      }),
    )

    // 侧栏入口图标（ZCode 模式）：feather zap 线稿（额度/能量意象），与其他
    // 24 viewBox 线稿同语言，currentColor 跟随文字色，明暗主题自动适配。
    const ZcMark = (props) => React.createElement('svg', {
      width: (props && props.size) || 16, height: (props && props.size) || 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    },
      React.createElement('polygon', { points: '13 2 3 14 12 14 11 22 21 10 12 10 13 2' }),
    )

    // ---- 面板 ----
    function Panel() {
      const s = useStore()
      const [view, setView] = useState('balance') // 'balance'|'models'|'status'|'keys'；'step-usage'|'step-account'；'zc-usage'|'zc-claim'。设置走弹窗不占视图
      const lastTabRef = useRef('balance')
      const [pos, setPos] = useState(null) // {x,y,w,h?}；prefs 加载前 null → 面板不渲染避免闪跳
      const posRef = useRef(null)
      const panelRef = useRef(null)
      const [manifest, setManifest] = useState(null)
      const [providerId, setProviderId] = useState('')
      const [models, setModels] = useState(null)
      const [catFilter, setCatFilter] = useState('all')
      // ---- 自定义检测（状态页签）：勾选 chat 模型 + 立即/定时，host 用 DSH 已配置的
      // key 真实探测。间隔/选中集持久化到 host prefs（state.prefs.check）；结果只存会话内。
      const [checkSel, setCheckSel] = useState({}) // { modelId: true }
      const [checkInterval, setCheckInterval] = useState(0) // 0=关；5/10/15/30/60 分钟
      const [checkBusy, setCheckBusy] = useState(false)
      const [checkResults, setCheckResults] = useState({}) // { modelId: {status, ms, error, errorKind, checkedAt, cached} }
      const [checkNextAt, setCheckNextAt] = useState(null) // 定时下一轮时间戳（展示用）
      const [checkMsg, setCheckMsg] = useState(null) // { error }
      const checkSeqRef = useRef(0) // 在飞序号：快速重复触发时忽略旧一轮的过期响应
      const checkSelRef = useRef({}) // 计时器闭包读实时选中集（避开 state 闭包）
      const checkBusyRef = useRef(false) // 在飞防重入
      const checkLoadedRef = useRef(false) // prefs 载入完成标记（首挂不落默认值覆盖已存配置）
      const [balance, setBalance] = useState(null)
      const [copiedId, setCopiedId] = useState(null)
      const [showCalls, setShowCalls] = useState(false)
      const [trendHoverIdx, setTrendHoverIdx] = useState(null)
      const [cookieInput, setCookieInput] = useState('')
      const [cookieBusy, setCookieBusy] = useState(false)
      const [cookieMsg, setCookieMsg] = useState(null)
      const [loginAccount, setLoginAccount] = useState('')
      const [loginPassword, setLoginPassword] = useState('')
      const [loginBusy, setLoginBusy] = useState(false)
      const [copiedKeyId, setCopiedKeyId] = useState(null)
      // 账号管理
      const [accounts, setAccounts] = useState(null)
      const [addAcc, setAddAcc] = useState('')
      const [addPw, setAddPw] = useState('')
      const [showAddPw, setShowAddPw] = useState(false)
      const [accBusy, setAccBusy] = useState(false)
      const [accMsg, setAccMsg] = useState(null)
      const [showAccPw, setShowAccPw] = useState(null) // 明文显示密码的账号
      const [showBackup, setShowBackup] = useState(false) // 默认折叠：保持设置页简洁，需要时再展开
      // 平台密钥页签
      const [keysData, setKeysData] = useState(null)
      const [keyName, setKeyName] = useState('')
      const [keyCreating, setKeyCreating] = useState(false)
      const [createdKey, setCreatedKey] = useState(null) // {name, key} 完整值只显示一次
      const [copiedCreated, setCopiedCreated] = useState(false)
      // ---- 阶跃（StepFun）面板：提供商切换 + 用量/账户两页签 + 设置卡状态 ----
      const [provider, setProvider] = useState('tr') // 'tr' | 'step' | 'zcode'（manifest.step.prefs.provider 播种）
      const providerInitRef = useRef(false)
      const lastStepTabRef = useRef('step-usage')
      const lastZcTabRef = useRef('zc-usage')
      const providerRef = useRef('tr') // 胶囊仲裁读取的实时提供商（避开 useCallback 闭包）
      const zcQuotaRef = useRef(null) // 最近一次 ZCode 额度数据（切提供商即时换胶囊用）
      const [stepPlan, setStepPlan] = useState(null)
      const [stepBal, setStepBal] = useState(null)
      const stepPlanRef = useRef(null)
      const stepBalRef = useRef(null)
      const stepPrefsRef = useRef(null)
      const [stepAcc, setStepAcc] = useState('')
      const [stepAccPw, setStepAccPw] = useState('')
      const [showStepPw, setShowStepPw] = useState(false)
      const [stepAccBusy, setStepAccBusy] = useState(false)
      const [stepAccMsg, setStepAccMsg] = useState(null)
      // ---- ZCode 页签（额度展示 + 活动领取；读 ~/.zcode/v2 凭证，接口经 host 代理）----
      const [zcQuota, setZcQuota] = useState(null)
      const [zcPlans, setZcPlans] = useState(null)
      const [zcMsg, setZcMsg] = useState(null)
      const [settingsTab, setSettingsTab] = useState('tr') // 设置弹窗分组：基元/阶跃/ZCode/关于
      // ---- 阶跃接口密钥维护（设置 → 阶跃卡）：控制台同款新增/复制/删除。
      // host 列表只回掩码；完整值创建时展示一次、复制时按需单取。----
      const [stepKeys, setStepKeys] = useState(null)
      const [stepKeyName, setStepKeyName] = useState('')
      const [stepKeyBusy, setStepKeyBusy] = useState(false)
      const [stepKeyMsg, setStepKeyMsg] = useState(null)
      const [stepKeyCreated, setStepKeyCreated] = useState(null) // {name, key} 完整值只显示一次
      const [stepKeyCopied, setStepKeyCopied] = useState(null) // 'created' | keyId（复制成功反馈）
      const [stepKeyConfirm, setStepKeyConfirm] = useState(null) // 待确认删除的 keyId（两段式，防误触）

      // 复制与本机凭据一致的历史密钥（host 校验前缀+后缀后返回完整值）。
      const copyReveal = useCallback(async (k) => {
        const r = await jsonGet(API + '/key-reveal?prefix=' + encodeURIComponent(k.prefix) + '&suffix=' + encodeURIComponent(k.masked.split('****').pop()))
        if (r && r.ok && await copyText(r.key)) {
          setCopiedKeyId(k.id)
          setTimeout(() => setCopiedKeyId((cur) => (cur === k.id ? null : cur)), 1500)
        }
      }, [])

      // 复制完整 API Key 到剪贴板（host 返回明文但界面只显示「已复制」反馈）。

      const setPosSafe = (p) => { posRef.current = p; setPos(p) }

      // 设置改为右上角齿轮打开的弹窗（不再占视图）；进出不改变当前页签。
      const switchTab = useCallback((id) => {
        if (String(id).indexOf('step-') === 0) lastStepTabRef.current = id
        else if (String(id).indexOf('zc-') === 0) lastZcTabRef.current = id
        else lastTabRef.current = id
        setView(id)
        setStore({ view: id })
      }, [])
      const toggleSettings = useCallback(() => {
        setStore({ settingsOpen: !(store.settingsOpen === true) })
      }, [])

      // ---- 面板提供商切换（标题分段器：基元 / 阶跃 / ZCode）；选择持久化到 host
      // step.prefs（跨会话记忆）。切到阶跃 → 胶囊跟随（store.provider/stepEntry 由
      // EntryButton 消费）；ZCode 不接管胶囊，保持基元身份。----
      const recomputeStepEntry = useCallback(() => {
        const pf = stepPrefsRef.current
        setStore({
          stepEntry: computeStepEntry({ plan: stepPlanRef.current, balance: stepBalRef.current, prefs: pf }),
          // 不接管 = 胶囊整体保持基元身份（图标/文字/金额都不换），用户在设置里定的口径
          stepTakeover: !(pf && pf.takeover === false),
        })
      }, [])
      const switchProvider = useCallback((p) => {
        const want = p === 'step' ? 'step' : p === 'zcode' ? 'zcode' : 'tr'
        if (want === provider) return
        setProvider(want)
        providerRef.current = want
        // 切提供商即仲裁胶囊：ZCode 用最近一次额度缓存（无数据则回落基元身份）
        setStore({ provider: want, zcEntry: want === 'zcode' ? computeZcEntry({ provider: 'zcode', quota: zcQuotaRef.current }) : null })
        void jsonPost(API + '/stepfun/prefs', { prefs: { provider: want } })
        setView((v) => {
          if (want === 'step') return String(v).indexOf('step-') === 0 ? v : lastStepTabRef.current
          if (want === 'zcode') return String(v).indexOf('zc-') === 0 ? v : lastZcTabRef.current
          return String(v).indexOf('step-') === 0 || String(v).indexOf('zc-') === 0 ? lastTabRef.current : v
        })
      }, [provider])
      // 阶跃被移除配置后自动落回基元（不留悬空 provider）
      useEffect(() => {
        if (manifest && manifest.ok && provider === 'step' && (!manifest.step || !manifest.step.configured)) {
          setProvider('tr')
          setStore({ provider: 'tr', stepEntry: null })
        }
      }, [manifest, provider])
      // ZCode 集成被关闭后自动落回基元（胶囊/页签一并还原）
      useEffect(() => {
        if (provider === 'zcode' && s.zcodeEnabled !== true) {
          setProvider('tr')
          providerRef.current = 'tr'
          setStore({ provider: 'tr', zcEntry: null })
        }
      }, [provider, s.zcodeEnabled])

      useEffect(() => { providerRef.current = provider }, [provider])

      // provider 与 view 必须同族（TR 页签配基元、step 页签配阶跃、zc 页签配 ZCode）
      // ——否则持久化的提供商在首包接管时，面板会以「A 页签 + B 内容」的错位状态初始化
      // （view 初始硬编码 'balance'，switchProvider 对已就位的 provider 会早退不搬 view）。
      useEffect(() => {
        const isStep = String(view).indexOf('step-') === 0
        const isZc = String(view).indexOf('zc-') === 0
        if (provider === 'step' && !isStep) { setView(lastStepTabRef.current); setStore({ view: lastStepTabRef.current }) }
        else if (provider === 'zcode' && !isZc) { setView(lastZcTabRef.current); setStore({ view: lastZcTabRef.current }) }
        else if (provider !== 'step' && isStep) { setView(lastTabRef.current); setStore({ view: lastTabRef.current }) }
        else if (provider !== 'zcode' && isZc) { setView(lastTabRef.current); setStore({ view: lastTabRef.current }) }
      }, [provider, view])

      const loadStepPlan = useCallback((force) => {
        setStepPlan((cur) => ({ loading: true, data: cur && cur.data }))
        jsonGet(API + '/stepfun/plan' + (force === true ? '?force=1' : '')).then((r) => {
          if (r && r.ok) {
            stepPlanRef.current = r
            setStepPlan({ loading: false, data: r })
          } else {
            if (r && r.code === 'NO_STEP_ACCOUNT') stepPlanRef.current = null
            setStepPlan({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
          }
          recomputeStepEntry()
        })
      }, [recomputeStepEntry])
      const loadStepBal = useCallback(() => {
        jsonGet(API + '/stepfun/balance').then((r) => {
          if (r && r.ok) { stepBalRef.current = r; setStepBal({ data: r }) }
          else setStepBal({ error: (r && r.error) || '加载失败', code: r && r.code })
          recomputeStepEntry()
        })
      }, [recomputeStepEntry])

      // 阶跃面板数据：选中阶跃（非设置页）时拉 plan，60s 随面板轮询；账户页签另拉官方余额。
      useEffect(() => {
        if (!s.open || provider !== 'step') return
        loadStepPlan()
        const t = setInterval(loadStepPlan, 60 * 1000)
        return () => clearInterval(t)
      }, [s.open, provider, view, loadStepPlan])
      useEffect(() => {
        if (!s.open || provider !== 'step' || view !== 'step-account') return
        loadStepBal()
        const t = setInterval(loadStepBal, 60 * 1000)
        return () => clearInterval(t)
      }, [s.open, provider, view, loadStepBal])

      // ---- ZCode 页签：用量 60s 轮询、活动进页签拉一次；领取结果由弹窗页
      // postMessage 回传（同源路由与 CSP 回退服务器两个来源都收）。----
      const loadZcQuota = useCallback((force) => {
        setZcQuota((cur) => ({ loading: true, data: cur && cur.data }))
        jsonGet(API + '/zcode/quota' + (force === true ? '?force=1' : '')).then((r) => {
          if (r && r.ok) {
            zcQuotaRef.current = r
            setZcQuota({ loading: false, data: r })
            setStore({ zcEntry: computeZcEntry({ provider: providerRef.current, quota: r }) })
          } else {
            zcQuotaRef.current = null
            setZcQuota({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
            setStore({ zcEntry: null }) // 无数据 → 胶囊回落基元身份
          }
        })
      }, [])
      const loadZcPlans = useCallback(() => {
        setZcPlans((cur) => ({ loading: true, list: (cur && cur.list) || null }))
        jsonGet(API + '/zcode/claim/preview').then((r) => {
          if (r && r.ok) setZcPlans({ loading: false, list: r.plans || [], activated: r.activated, activationError: r.activationError || null })
          else setZcPlans({ loading: false, error: (r && r.error) || '加载失败', biz: r && r.code === 'CLAIM_BIZ' ? r : null })
        })
      }, [])
      useEffect(() => {
        if (!s.open || provider !== 'zcode') return
        if (view === 'zc-claim') { loadZcPlans(); return }
        loadZcQuota()
        const t = setInterval(loadZcQuota, 60 * 1000)
        return () => clearInterval(t)
      }, [s.open, provider, view, loadZcQuota, loadZcPlans])
      const claimZcodePlan = useCallback((plan) => {
        const w = window.open(API + '/captcha?planId=' + encodeURIComponent(plan.planId), 'dsh-zcode-captcha', 'width=440,height=620')
        if (!w) setZcMsg({ ok: false, text: '弹窗被拦截，请允许本站弹出窗口后重试' })
      }, [])
      useEffect(() => {
        const onMsg = (e) => {
          const d = e && e.data
          if (!d || d.source !== 'dsh-tokenrhythm-bill' || d.kind !== 'zcode-claim') return
          setZcMsg(d.ok
            ? { ok: true, text: '领取成功' + (d.planName ? '：' + d.planName : '') }
            : { ok: false, text: d.message || '领取失败' })
          if (d.ok) { loadZcQuota(true); loadZcPlans() }
        }
        window.addEventListener('message', onMsg)
        return () => window.removeEventListener('message', onMsg)
      }, [loadZcQuota, loadZcPlans])

      // 阶跃账号管理（设置页卡）：添加=先验登录再入库；切换/删除/测试登录。
      const refreshManifest = useCallback(async () => {        const m = await jsonGet(API + '/manifest')
        if (m && m.ok) {
          setManifest(m)
          stepPrefsRef.current = m.step && m.step.prefs ? m.step.prefs : null
          setStore({ stepConfigured: !!(m.step && m.step.configured) }) // 胶囊身份门控（账号被删即回落基元）
          recomputeStepEntry()
        }
      }, [recomputeStepEntry])
      const addStepAccount = async () => {
        setStepAccBusy(true)
        setStepAccMsg(null)
        const r = await jsonPost(API + '/stepfun/account/add', { username: stepAcc.trim(), password: stepAccPw })
        setStepAccBusy(false)
        if (!r || !r.ok) { setStepAccMsg({ ok: false, text: (r && r.error) || '操作失败' }); return }
        setStepAcc('')
        setStepAccPw('')
        setStepAccMsg({ ok: true, text: r.pending
          ? '已保存：' + r.activeAccount + '（登录通道暂时限流，解除后自动登录）'
          : '已添加并登录：' + r.activeAccount })
        void refreshManifest()
      }
      const removeStepAccount = async (username) => {
        await jsonPost(API + '/stepfun/account/remove', { username })
        void refreshManifest()
      }
      const useStepAccount = async (username) => {
        setStepAccBusy(true)
        setStepAccMsg(null)
        const r = await jsonPost(API + '/stepfun/account/use', { username })
        setStepAccBusy(false)
        setStepAccMsg(r && r.switched
          ? { ok: true, text: r.ok ? '已切换：' + username : '已切换：' + username + '（限流解除后自动登录）' }
          : { ok: false, text: (r && r.error) || '切换失败' })
        void refreshManifest()
        if (r && r.switched && provider === 'step') loadStepPlan(true)
      }
      const setStepEntryPref = async (patch) => {
        const r = await jsonPost(API + '/stepfun/prefs', { prefs: patch })
        if (r && r.ok) {
          stepPrefsRef.current = r.prefs
          recomputeStepEntry()
          void refreshManifest()
        }
      }

      // ---- 阶跃接口密钥（设置 → 阶跃卡）：列表/新建/复制/删除全走 host 的控制台内部
      // RPC（Dashboard 服务）。列表只带掩码；复制时 host 现拉列表取回完整值写剪贴板。----
      const loadStepKeys = useCallback(async () => {
        setStepKeys({ loading: true })
        const r = await jsonGet(API + '/stepfun/keys')
        if (r && r.ok) setStepKeys({ loading: false, list: r.keys || [], total: r.total })
        else setStepKeys({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
      }, [])
      useEffect(() => {
        if (!s.open || (!s.settingsOpen && view !== 'step-keys')) return
        if (s.settingsOpen && settingsTab !== 'step') return
        loadStepKeys()
      }, [s.open, s.settingsOpen, settingsTab, view, loadStepKeys])
      const createStepKey = async () => {
        const name = stepKeyName.trim()
        if (!name) { setStepKeyMsg({ ok: false, text: '请填写密钥名称' }); return }
        if (name.length > 20) { setStepKeyMsg({ ok: false, text: '不超过 20 字符' }); return }
        setStepKeyBusy(true)
        setStepKeyMsg(null)
        const r = await jsonPost(API + '/stepfun/key-create', { name })
        setStepKeyBusy(false)
        if (r && r.ok) {
          setStepKeyCreated({ name: r.name, key: r.key })
          setStepKeyName('')
          setStepKeyMsg({ ok: true, text: '已创建「' + r.name + '」——完整密钥只显示这一次，请立即复制保存' })
          void loadStepKeys()
          void copyText(r.key) // 与基元密钥同款：创建即自动复制，防用户忘复制
        } else {
          setStepKeyMsg({ ok: false, text: (r && r.error) || '创建失败' })
        }
      }
      const copyStepCreatedKey = async () => {
        if (stepKeyCreated && await copyText(stepKeyCreated.key)) {
          setStepKeyCopied('created')
          setTimeout(() => setStepKeyCopied((cur) => (cur === 'created' ? null : cur)), 1500)
        }
      }
      const copyStepKey = async (k) => {
        const r = await jsonGet(API + '/stepfun/key?keyId=' + encodeURIComponent(k.keyId))
        if (r && r.ok && await copyText(r.key)) {
          setStepKeyCopied(k.keyId)
          setTimeout(() => setStepKeyCopied((cur) => (cur === k.keyId ? null : cur)), 1500)
        } else {
          setStepKeyMsg({ ok: false, text: (r && r.error) || '复制失败' })
        }
      }
      const deleteStepKey = async (k) => {
        // 两段式确认：误点第一次只进入待确认态，再点一次才真删（密钥删除立即失效）
        if (stepKeyConfirm !== k.keyId) { setStepKeyConfirm(k.keyId); return }
        setStepKeyConfirm(null)
        const r = await jsonPost(API + '/stepfun/key-delete', { keyId: k.keyId })
        if (r && r.ok) {
          setStepKeys({ loading: false, list: r.keys || [], total: r.total })
          setStepKeyMsg({ ok: true, text: '已删除「' + (k.name || '未命名') + '」' })
        } else {
          setStepKeyMsg({ ok: false, text: (r && r.error) || '删除失败' })
        }
      }

      // 首开：加载面板几何 + manifest。
      useEffect(() => {
        let alive = true
        jsonGet(API + '/prefs').then((r) => {
          if (!alive || !r || !r.ok || !r.prefs) return
          if (r.prefs.panel) setPosSafe(sanitizePos(r.prefs.panel))
          setStore({ zcodeEnabled: r.prefs.zcode === true }) // ZCode 集成默认关闭
        })
        jsonGet(API + '/manifest').then((r) => {
          if (!alive) return
          setManifest(r && r.ok ? r : { ok: false, providers: [], error: r && r.error ? r.error : '加载失败' })
          if (r && r.ok && Array.isArray(r.providers) && r.providers.length > 0) {
            setProviderId((cur) => (cur !== '' && r.providers.some((p) => p.id === cur) ? cur : r.providers[0].id))
          }
          if (r && r.ok && r.step) {
            if (r.step.prefs) stepPrefsRef.current = r.step.prefs
            if (!providerInitRef.current) { // 首包播种：上次选中的提供商（未配置阶跃一律落基元）
              providerInitRef.current = true
              const want = r.step.prefs && r.step.prefs.provider === 'step' && r.step.configured ? 'step'
                : r.step.prefs && r.step.prefs.provider === 'zcode' ? 'zcode' : 'tr'
              setProvider(want)
              providerRef.current = want
              setStore({ provider: want, zcEntry: want === 'zcode' ? computeZcEntry({ provider: 'zcode', quota: zcQuotaRef.current }) : null })
            }
          }
        })
        return () => { alive = false }
      }, [])

      // 默认几何：视口水平居中、距顶 72px。prefs 到达后覆盖。
      useEffect(() => {
        if (pos !== null) return
        const w = Math.min(560, window.innerWidth - 16)
        setPosSafe({ x: Math.round((window.innerWidth - w) / 2), y: 72, w })
      }, [pos === null])

      // Esc / 点击面板外部关闭。Esc 优先关设置弹窗，再关面板。
      useEffect(() => {
        if (!s.open) return
        const onKey = (e) => {
          if (e.key !== 'Escape') return
          if (store.settingsOpen) setStore({ settingsOpen: false })
          else setStore({ open: false })
        }
        const onDown = (e) => {
          const el = panelRef.current
          if (el && !el.contains(e.target) && !(e.target.closest && e.target.closest('.dsh-mb-entry'))) {
            setStore({ open: false })
          }
        }
        window.addEventListener('keydown', onKey)
        document.addEventListener('pointerdown', onDown, true)
        return () => {
          window.removeEventListener('keydown', onKey)
          document.removeEventListener('pointerdown', onDown, true)
        }
      }, [s.open])

      // 模型列表：随 providerId 变化拉取（host 端 60s 缓存）。模型页签与状态页签
      // （自定义检测选模型）共用同一份数据。
      useEffect(() => {
        if (!s.open || providerId === '' || (view !== 'models' && view !== 'status')) return
        let alive = true
        setModels({ loading: true })
        jsonGet(API + '/models?provider=' + encodeURIComponent(providerId)).then((r) => {
          if (!alive) return
          if (r && r.ok) setModels({ loading: false, list: r.models || [], cached: !!r.cached, stale: !!r.stale, categories: r.categories || null, source: r.source })
          else setModels({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
          if (!r || !r.ok || !r.categories) setCatFilter('all')
        })
        return () => { alive = false }
      }, [providerId, view, s.open])

      // ---- 自定义检测：refs 同步 + 设置持久化 + 立即/定时执行 ----
      useEffect(() => { checkSelRef.current = checkSel }, [checkSel])
      useEffect(() => { checkBusyRef.current = checkBusy }, [checkBusy])
      // 首挂读回已存检测设置（host 有 check 段才生效，缺省全关）。
      useEffect(() => {
        jsonGet(API + '/prefs').then((r) => {
          if (r && r.ok && r.prefs && r.prefs.check) {
            const c = r.prefs.check
            if ([5, 10, 15, 30, 60].indexOf(c.interval) >= 0) setCheckInterval(c.interval)
            if (c.sel && typeof c.sel === 'object') setCheckSel(c.sel)
          }
        }, () => {}).then(() => { checkLoadedRef.current = true })
      }, [])
      // 载入完成后同步设置到 host（跳过首趟，防止默认值覆盖已存值）。
      useEffect(() => {
        if (!checkLoadedRef.current) return
        void jsonPost(API + '/prefs', { prefs: { check: { interval: checkInterval, sel: checkSel } } })
      }, [checkInterval, checkSel])
      // 切换提供商：模型集合与 key 都变了，旧探测结果作废。
      useEffect(() => { setCheckResults({}); setCheckMsg(null) }, [providerId])

      const toggleCheckSel = useCallback((id) => {
        setCheckSel((cur) => {
          const next = { ...cur }
          if (next[id]) delete next[id]; else next[id] = true
          return next
        })
      }, [])

      // 立即/定时检测：POST /model-check（force 绕过 host 60s 缓存）。
      // 选中集从 ref 读（定时器闭包）；busy 防重入；seq 丢弃过期响应。
      const runCheck = useCallback(async (opts) => {
        const force = !!(opts && opts.force)
        const sel = checkSelRef.current
        const selIds = Object.keys(sel).filter((id) => sel[id] === true)
        if (selIds.length === 0 || checkBusyRef.current) return
        checkSeqRef.current++
        const seq = checkSeqRef.current
        setCheckBusy(true)
        setCheckMsg(null)
        const r = await jsonPost(API + '/model-check', { provider: providerId, models: selIds, force })
        if (seq !== checkSeqRef.current) return // 已被更新的轮次取代
        setCheckBusy(false)
        if (r && r.ok) {
          setCheckResults((cur) => {
            const next = { ...cur }
            const res = r.results || {}
            for (const id of Object.keys(res)) next[id] = res[id]
            return next
          })
        } else {
          const raw = (r && (r.error || '检测失败')) || '检测失败'
          setCheckMsg({ error: r && r.code === 'NO_KEY' ? '未读到 API Key，无法检测：' + raw : raw })
        }
      }, [providerId])
      const runCheckNow = useCallback(() => { void runCheck({ force: true }) }, [runCheck])

      // 定时检测：面板打开期间按间隔自动重探（与当前页签无关；关面板即停）。
      // 未勾选任何模型时 runCheck 自行早退，不会发请求。
      useEffect(() => {
        if (checkInterval === 0 || !s.open) return
        setCheckNextAt(Date.now() + checkInterval * 60 * 1000)
        const timer = setInterval(() => {
          void runCheck({ force: true })
          setCheckNextAt(Date.now() + checkInterval * 60 * 1000)
        }, checkInterval * 60 * 1000)
        return () => { clearInterval(timer); setCheckNextAt(null) }
      }, [checkInterval, s.open, runCheck])

      const loadBalance = useCallback(() => {
        setBalance((cur) => ({ loading: true, data: cur && cur.data }))
        jsonGet(API + '/balance').then((r) => {
          if (r && r.ok) {
            setBalance({ loading: false, data: r })
            setStore({
              alert: alertOf(r),
              balanceCny: r.balanceCny !== null && r.balanceCny !== undefined ? r.balanceCny : null,
              expiringItems: Array.isArray(r.expiringItems) ? r.expiringItems : [],
            })
          } else {
            setBalance({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
          }
        })
      }, [])

      // 当前登录账号（manifest 会话里带的）：作为余额刷新依赖，切换账号立即重拉。
      const sessionAccount = (manifest && manifest.session && manifest.session.account) || null
      // 平台用户名（/api/me 提取，manifest.accountName）：数据账号标注用它，
      // 账号密码模式下 account 只是登录手机号，不适合当展示名。
      const sessionAccountName = (manifest && manifest.session && manifest.session.accountName) || null
      // 余额：页签打开时拉取，之后每 60s 自动刷新（面板开着才刷）；切换账号立即刷新，
      // 避免把上一个账号的数据当成当前账号的看。
      useEffect(() => {
        if (!s.open || view !== 'balance') return
        loadBalance()
        const timer = setInterval(loadBalance, 60 * 1000)
        return () => clearInterval(timer)
      }, [view, s.open, loadBalance, sessionAccount])

      // 平台密钥：列表 + 新建（完整值只显示一次）。
      const loadKeys = useCallback(async () => {
        setKeysData({ loading: true })
        const r = await jsonGet(API + '/keys')
        if (r && r.ok) setKeysData({ loading: false, list: r.keys || [] })
        else setKeysData({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
      }, [])
      useEffect(() => {
        if (!s.open || view !== 'keys') return
        loadKeys()
      }, [view, s.open, loadKeys])
      const createKey = async () => {
        setKeyCreating(true)
        const r = await jsonPost(API + '/keys/create', { name: keyName.trim() || ('我的密钥 ' + new Date().toLocaleDateString()) })
        setKeyCreating(false)
        if (r && r.ok) {
          setCreatedKey({ name: r.name, key: r.key })
          setKeyName('')
          loadKeys()
          void copyText(r.key) // 创建后自动复制完整值
        } else {
          setKeysData((cur) => ({ ...(cur || {}), error: (r && r.error) || '创建失败', code: r && r.code, list: (cur && cur.list) || [] }))
        }
      }
      const copyCreatedKey = async () => {
        if (createdKey && await copyText(createdKey.key)) {
          setCopiedCreated(true)
          setTimeout(() => setCopiedCreated(false), 1500)
        }
      }

      // 保存会话 Cookie / 清除。
      const saveCookie = async (value) => {
        setCookieBusy(true)
        setCookieMsg(null)
        const r = await jsonPost(API + '/session', { value })
        setCookieBusy(false)
        if (!r) { setCookieMsg({ ok: false, text: '保存失败' }); return }
        // 换 Cookie 即切号：host 已解析新 cookie 身份并对齐绑定（bound）。
        const tail = value === '' ? '' : (r.bound && r.account
          ? '（已绑定 ' + r.account + ' · 过期可自动重登）'
          : (r.account ? '（账号 ' + r.account + '）' : '（未能识别账号）'))
        setCookieMsg({ ok: true, text: value === '' ? '已清除会话' : '已保存：' + r.hint + tail })
        setCookieInput('')
        setStore({ alert: null, balanceCny: null, expiringItems: [] }) // 旧会话的余额/预警立即失效
        const m = await jsonGet(API + '/manifest')
        if (m && m.ok) setManifest(m)
        if (view === 'balance') loadBalance()
        switchTab('balance')
      }

      // 入口胶囊显示模式（total=总余额 / expiring=限时总余额）：本地立即生效 + 持久化。
      const setEntryBalance = useCallback((mode) => {
        if (mode !== 'total' && mode !== 'expiring') return
        setStore({ entryBalMode: mode })
        void jsonPost(API + '/prefs', { prefs: { entryBalance: mode } })
      }, [])
      // ZCode 集成开关：本地立即生效 + 持久化到 host prefs；关闭时若正停在
      // ZCode 页签，由「关闭回落」effect 自动切回基元。
      const setZcodeEnabled = useCallback((on) => {
        setStore({ zcodeEnabled: on === true })
        void jsonPost(API + '/prefs', { prefs: { zcode: on === true } })
      }, [])

      // 点击模型卡片 → 复制模型 id（配置 agent 时直接粘贴）。
      const copyId = useCallback((id) => {
        void copyText(id)
        setCopiedId(id)
        setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1200)
      }, [])

      // 账号管理：添加（保存并可明文查看）/ 删除 / 一键登录。
      const loadAccounts = useCallback(async () => {
        const r = await jsonGet(API + '/accounts')
        if (r && r.ok) setAccounts(r.accounts || [])
      }, [])
      const addAccount = async () => {
        setAccBusy(true)
        setAccMsg(null)
        const r = await jsonPost(API + '/accounts/add', { account: addAcc.trim(), password: addPw })
        setAccBusy(false)
        if (!r || !r.ok) { setAccMsg({ ok: false, text: (r && r.error) || '操作失败' }); return }
        if (r.loggedIn) {
          setAccMsg({ ok: true, text: '已添加并登录：' + r.hint })
          setAddPw('')
          const m = await jsonGet(API + '/manifest')
          if (m && m.ok) setManifest(m)
          setStore({ alert: null, balanceCny: null, expiringItems: [] })
          loadBalance()
        } else {
          setAccMsg({ ok: true, text: '账号已保存，但登录失败：' + (r.error || '未知原因') })
        }
        loadAccounts()
      }
      const removeAccount = async (account) => {
        await jsonPost(API + '/accounts/remove', { account })
        if (showAccPw === account) setShowAccPw(null)
        loadAccounts()
      }
      const loginStored = async (account) => {
        setAccBusy(true)
        setAccMsg(null)
        const r = await jsonPost(API + '/accounts/login', { account })
        setAccBusy(false)
        if (r && r.ok) {
          setAccMsg({ ok: true, text: '已切换登录：' + account })
          const m = await jsonGet(API + '/manifest')
          if (m && m.ok) setManifest(m)
          setStore({ alert: null, balanceCny: null, expiringItems: [] })
          loadBalance()
        } else {
          setAccMsg({ ok: false, text: (r && r.error) || '登录失败' })
        }
      }

      // 账号列表：打开设置弹窗时拉取（添加/删除后会再刷新），否则列表永远不出现。
      useEffect(() => {
        if (!s.open || !s.settingsOpen) return
        loadAccounts()
      }, [s.open, s.settingsOpen, loadAccounts])

      // ---- 更新检测：打开设置弹窗时拉取（host 端 24h TTL，force=1 绕过）----
      const [updInfo, setUpdInfo] = useState(null)
      const [updBusy, setUpdBusy] = useState(false)
      const [updCopied, setUpdCopied] = useState(false)
      const loadUpdate = useCallback(async (force) => {
        setUpdBusy(true)
        const r = await jsonGet(API + '/update' + (force ? '?force=1' : '')).catch(() => null)
        setUpdBusy(false)
        if (r && r.ok) setUpdInfo(r)
      }, [])
      useEffect(() => {
        if (!s.open || !s.settingsOpen) return
        loadUpdate(false)
      }, [s.open, s.settingsOpen, loadUpdate])
      const copyUpdateCmd = () => {
        void copyText('dsh plugin add dsh-tokenrhythm-bill')
        setUpdCopied(true)
        setTimeout(() => setUpdCopied(false), 1500)
      }
      const ignoreUpdate = async () => {
        const r = await jsonPost(API + '/update/ignore', { version: updInfo && updInfo.latest ? updInfo.latest : '' })
        if (r && r.ok) setUpdInfo((cur) => (cur ? { ...cur, ...r } : r))
      }

      // ---- 拖拽（头部按下拖动，松开持久化）----
      const persistPos = () => {
        const cur = posRef.current
        if (cur) {
          const panel = { x: Math.round(cur.x), y: Math.round(cur.y), w: Math.round(cur.w) }
          if (cur.h) panel.h = Math.round(cur.h)
          void jsonPost(API + '/prefs', { prefs: { panel } })
        }
      }
      const onHeaderDown = (e) => {
        if (e.button !== 0) return
        const target = e.target
        if (target && target.closest && target.closest('button')) return // 头部按钮不触发拖拽
        e.preventDefault()
        const p = posRef.current || { x: 0, y: 0, w: 560 }
        const startX = e.clientX, startY = e.clientY, origX = p.x, origY = p.y
        const move = (ev) => {
          setPosSafe(clampPos({ x: origX + ev.clientX - startX, y: origY + ev.clientY - startY, w: p.w, h: p.h }))
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          persistPos()
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      // ---- 右下角把手：调整宽高并持久化 ----
      const onResizeDown = (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const p = posRef.current || { x: 0, y: 0, w: 560 }
        const startX = e.clientX, startY = e.clientY, w0 = p.w
        const h0 = p.h || (panelRef.current ? panelRef.current.offsetHeight : 480)
        const move = (ev) => {
          const w = Math.max(360, Math.min(w0 + ev.clientX - startX, window.innerWidth - 16))
          const h = Math.max(280, Math.min(h0 + ev.clientY - startY, window.innerHeight - 40))
          setPosSafe(clampPos({ x: p.x, y: p.y, w, h }))
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          persistPos()
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      if (!s.open || pos === null) return null
      const providers = (manifest && Array.isArray(manifest.providers)) ? manifest.providers : []
      const sessionConfigured = !!(manifest && manifest.session && manifest.session.configured)
      const stepCfg = manifest && manifest.step ? manifest.step : null
      const stepReady = !!(stepCfg && stepCfg.configured) // 阶跃已配置才允许停在阶跃（未配置由回落 effect 兜底）
      const effProv = provider === 'step' && stepReady ? 'step'
        : provider === 'zcode' && s.zcodeEnabled ? 'zcode' : 'tr'
      return React.createElement('div', {
        className: 'dsh-mb-panel' + (s.settingsOpen ? ' settings-open' : ''),
        ref: panelRef,
        style: { left: pos.x, top: pos.y, width: pos.w, height: pos.h || undefined },
        role: 'dialog',
      },
        // 头部：原标题（任何模式保留）+ 提供商切换器（配好阶跃才出现，紧贴标题）
        // + 右上角动作区（设置齿轮 / 关闭）。
        React.createElement('div', { className: 'dsh-mb-head', onPointerDown: onHeaderDown },
          React.createElement('div', { className: 'dsh-mb-head-left' },
            React.createElement('span', { className: 'dsh-mb-head-title' },
              effProv === 'step' ? STEP_ENTRY_LABEL : effProv === 'zcode' ? ZC_ENTRY_LABEL : ENTRY_LABEL),
            // 标题位提供商切换器：基元常驻，阶跃需已配置、ZCode 需设置里启用；
            // 只剩基元一个段时整体不渲染（与未配置阶跃的旧版行为一致，零打扰）。
            (function () {
              const segs = [['tr', '基元', '基元律动面板']]
              if (stepReady) segs.push(['step', '阶跃', '阶跃 Step Plan 面板'])
              if (s.zcodeEnabled) segs.push(['zcode', 'ZCode', 'ZCode 套餐与活动'])
              if (segs.length < 2) return null
              return React.createElement('div', { className: 'dsh-mb-prov' },
                segs.map(([id, label, tip]) => React.createElement('button', {
                  key: id,
                  className: 'dsh-mb-prov-btn' + (effProv === id ? ' active' : ''),
                  title: tip, onClick: () => switchProvider(id),
                }, label)),
              )
            })(),
          ),
          React.createElement('div', { className: 'dsh-mb-head-actions' },
            React.createElement('button', {
              className: 'dsh-mb-iconbtn' + (s.settingsOpen ? ' active' : ''),
              title: '设置',
              onClick: toggleSettings,
            }, '⚙'),
            React.createElement('button', { className: 'dsh-mb-iconbtn', title: '关闭 (Esc)', onClick: () => setStore({ open: false }) }, '✕'),
          ),
        ),
        // 页签：三家各一套（设置以弹窗打开，不占页签）。
        React.createElement('div', { className: 'dsh-mb-tabs' },
          (effProv === 'step'
            ? [['step-usage', '用量'], ['step-account', '账户'], ['step-keys', '密钥']]
            : effProv === 'zcode'
              ? [['zc-usage', '用量'], ['zc-claim', '活动']]
              : [['balance', '余额'], ['models', '模型'], ['status', '状态'], ['keys', '密钥']]).map(([id, label]) =>
            React.createElement('button', {
              key: id,
              className: 'dsh-mb-tab' + (view === id ? ' active' : ''),
              onClick: () => switchTab(id),
            }, label)),
        ),
        React.createElement('div', { className: 'dsh-mb-body' },
          view === 'models' ? renderModelsTab({ manifest, providers, models, catFilter, setCatFilter, copiedId, copyId }) : null,
          view === 'balance' ? renderBalanceTab({ manifest, balance, loadBalance, goSettings: toggleSettings, showCalls, setShowCalls, trendHoverIdx, setTrendHoverIdx, sessionAccount, sessionAccountName }) : null,
          // 状态页签 = 自定义检测（自己的 Key 实测；官方状态站 2026-09-14 起停更并移除）。
          view === 'status' ? renderCheckPanel({
            models, checkSel, toggleCheckSel, checkBusy, checkResults,
            checkInterval, setCheckInterval, checkNextAt, checkMsg, runCheckNow,
          }) : null,
          view === 'keys' ? renderKeysTab({
            manifest, keysData, loadKeys, keyName, setKeyName, keyCreating, createKey,
            createdKey, setCreatedKey, copiedCreated, copyCreatedKey, copiedKeyId, copyReveal,
          }) : null,
          view === 'step-usage' ? renderStepUsageTab({ stepPlan, loadStepPlan, goSettings: toggleSettings }) : null,
          view === 'step-account' ? renderStepAccountTab({
            stepBal, loadStepBal, stepPlan, goSettings: toggleSettings,
          }) : null,
          view === 'step-keys' ? renderStepKeysTab({
            stepKeys, stepKeyName, setStepKeyName, stepKeyBusy, stepKeyMsg, stepKeyCreated,
            stepKeyCopied, stepKeyConfirm, createStepKey, copyStepCreatedKey, copyStepKey, deleteStepKey, loadStepKeys,
          }) : null,
          view === 'zc-usage' ? renderZcUsageTab({
            zcQuota, loadZcQuota,
          }) : null,
          view === 'zc-claim' ? renderZcClaimTab({
            zcPlans, loadZcPlans, zcMsg, claimZcodePlan,
          }) : null,
        ),
        // 设置弹窗：覆盖整个面板的模态层（点遮罩 / ✕ / Esc 关闭）。
        s.settingsOpen ? React.createElement('div', {
          className: 'dsh-mb-modal',
          onClick: (e) => { if (e.target === e.currentTarget) setStore({ settingsOpen: false }) },
        },
          React.createElement('div', { className: 'dsh-mb-modal-card', role: 'dialog', 'aria-label': '设置' },
            React.createElement('div', { className: 'dsh-mb-modal-head' },
              React.createElement('span', { className: 'dsh-mb-modal-title' }, '设置'),
              React.createElement('button', {
                className: 'dsh-mb-iconbtn', title: '关闭 (Esc)',
                onClick: () => setStore({ settingsOpen: false }),
              }, '✕'),
            ),
            React.createElement('div', { className: 'dsh-mb-modal-body' },
              renderSettingsTab({
                manifest, sessionConfigured, sessionAccount: (manifest && manifest.session && manifest.session.account) || null,
                cookieInput, setCookieInput,
                cookieBusy, cookieMsg, saveCookie,
                accounts, addAcc, setAddAcc, addPw, setAddPw, showAddPw, setShowAddPw,
                accBusy, accMsg, addAccount, removeAccount, loginStored, showAccPw, setShowAccPw,
                showBackup, setShowBackup,
                updInfo, updBusy, loadUpdate, copyUpdateCmd, updCopied, ignoreUpdate,
                entryMode: s.entryBalMode === 'expiring' ? 'expiring' : 'total', setEntryBalance,
                zcEnabled: s.zcodeEnabled === true, setZcodeEnabled,
                settingsTab, setSettingsTab,
                stepCfg,
                stepAcc, setStepAcc, stepAccPw, setStepAccPw, showStepPw, setShowStepPw,
                stepAccBusy, stepAccMsg, addStepAccount, removeStepAccount, useStepAccount,
                setStepEntryPref,
                stepKeys, stepKeyName, setStepKeyName, stepKeyBusy, stepKeyMsg, stepKeyCreated,
                stepKeyCopied, stepKeyConfirm, createStepKey, copyStepCreatedKey, copyStepKey, deleteStepKey,
              })),
          ),
        ) : null,
        React.createElement('div', { className: 'dsh-mb-resize', title: '调整大小', onPointerDown: onResizeDown }),
      )
    }

    const sanitizePos = (p) => {
      const w = Math.min(860, Math.max(360, Number(p.w) || 560), window.innerWidth - 16)
      const h = p.h ? Math.max(280, Math.min(Number(p.h) || 480, window.innerHeight - 40)) : null
      return clampPos({ x: Number(p.x) || 0, y: Number(p.y) || 0, w, h })
    }
    const clampPos = ({ x, y, w, h }) => ({
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - 80)),
      w,
      h: h || null,
    })

    // ---- 模型页签（卡片网格 + 分类筛选；点卡片复制模型 id）----
    const CAT_LABELS = { all: '全部', text: '文本', image: '图像', audio: '音频', video: '视频', vector: '向量' }
    // 模型统一排序（模型页签卡片与状态页签检测卡 chips/结果行共用同一心智顺序）：
    // 文本组在前、图像组在后，组内价格升序——图像按图片单价、文本按输入单价（有折扣
    // 取折扣价）；无价格的（网关 /v1/models 回退、平台未定价的测试模型）排在组尾，
    // 同价/无价组内保持平台原序（sort 稳定）。网关回退的模型没有 categories，视作文本组。
    const sortModelsLikeCards = (arr) => {
      const priceOf = (m) => (m.perImagePrice ?? m.effInPrice ?? m.inPrice ?? null)
      const groupOf = (m) => ((m.categories || []).includes('image') ? 1 : 0)
      return arr.slice().sort((a, b) => {
        const ga = groupOf(a)
        const gb = groupOf(b)
        if (ga !== gb) return ga - gb
        const pa = priceOf(a)
        const pb = priceOf(b)
        if (pa === null && pb === null) return 0
        if (pa === null) return 1
        if (pb === null) return -1
        return pa - pb
      })
    }

    function renderModelsTab({ manifest, providers, models, catFilter, setCatFilter, copiedId, copyId }) {
      if (manifest && manifest.error) {
        return React.createElement('div', { className: 'dsh-mb-notice err' }, manifest.error)
      }
      if (providers.length === 0) {
        return React.createElement('div', { className: 'dsh-mb-notice' }, 'settings.yaml 里没有配置基元律动（tokenrhythm）提供商')
      }
      const rows = []
      if (models === null || models.loading) {
        // 骨架屏：与模型卡片网格同构的 shimmer 占位（6 卡 × 三行），替代纯文字「加载中…」。
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-cards', key: 'ld', role: 'status', 'aria-label': '加载中' },
          Array.from({ length: 6 }, (_, i) => React.createElement('div', { className: 'dsh-mb-skel-card', key: i },
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '58%' } }),
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '88%' } }),
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '42%' } }),
          ))))
      } else if (models.error) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'er' },
          models.code === 'NO_KEY' ? models.error : '拉取模型列表失败：' + models.error))
      } else {
        // 缓存标签并入分类 tabs 行首（保持一行；stale 长文案改放悬浮提示）。
        const cacheTag = models.cached
          ? React.createElement('span', {
              className: 'dsh-mb-cache-tag' + (models.stale ? ' stale' : ''),
              key: 'ct',
              title: models.stale ? '上游失败，显示 60s 前的缓存' : undefined,
            }, models.stale ? '缓存（上游失败）' : '缓存（60s 内）')
          : null
        if (models.list.length === 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'empty' }, '网关返回的模型列表为空'))
        }
        if (models.categories) {
          rows.push(React.createElement('div', { className: 'dsh-mb-cats', key: 'cats' },
            Object.keys(CAT_LABELS).map((key) => {
              const n = models.categories[key]
              if (key !== 'all' && !n) return null
              return React.createElement('button', {
                key,
                className: 'dsh-mb-cat' + (catFilter === key ? ' active' : ''),
                onClick: () => setCatFilter(key),
              }, CAT_LABELS[key] + ' ', React.createElement('span', { className: 'dsh-mb-cat-count' }, n || 0))
            }),
            // 缓存标签放行尾：margin-left:auto 吸走剩余空间 → chips 靠左、标签靠最右。
            cacheTag,
          ))
        } else if (cacheTag) {
          rows.push(React.createElement('div', { className: 'dsh-mb-cats', key: 'cats' }, cacheTag))
        }
        // 排序与状态页签检测卡共用 sortModelsLikeCards（价格升序、文本组在前，见助手注释）。
        const list = sortModelsLikeCards(models.list)
          .filter((m) => catFilter === 'all' || !(m.categories) || m.categories.includes(catFilter))
        if (list.length === 0 && models.list.length > 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'nofilter' }, '该分类下暂无模型'))
        }
        rows.push(React.createElement('div', { className: 'dsh-mb-cards', key: 'cards' },
          list.map((m) => React.createElement('div', {
            className: 'dsh-mb-card' + (copiedId === m.id ? ' copied' : ''),
            key: m.id,
            title: '点击复制模型 ID：' + m.id,
            onClick: () => copyId(m.id),
          },
            // 卡片结构对齐平台模型页（model-card）：headline（折扣徽章 + 名称 + 状态胶囊）/
            // subline（模型 ID + 来源）/ details（规格 + 价格两栏 dl）。
            React.createElement('div', { className: 'dsh-mb-card-meta' },
              React.createElement('div', { className: 'dsh-mb-card-head' },
                // 折扣徽章：实底绿 + 白字放标题行最左（内容区左上角），行内排布不占额外高度。
                m.hasDiscount ? React.createElement('span', { className: 'dsh-mb-card-disc' }, '折扣') : null,
                React.createElement('span', { className: 'dsh-mb-card-name', title: m.name && m.name !== m.id ? m.name : m.id },
                  m.name && m.name !== m.id ? m.name : m.id),
                React.createElement('span', { className: 'dsh-mb-card-head-r' },
                  copiedId === m.id ? React.createElement('span', { className: 'dsh-mb-copied' }, '已复制') : null,
                  // 状态胶囊：纯平台状态（在线=绿点 / 测试中=琥珀点），官方 model-status-pill
                  // 画法；探测联动已整体移除，探测详情只在「状态」页签。
                  (() => {
                    if (!m.platformStatus) return null
                    const pillCls = m.platformStatus === 'online' ? ' on' : m.platformStatus === 'testing' ? ' testing' : ''
                    const txt = m.platformStatus === 'online' ? '在线' : m.platformStatus === 'testing' ? '测试中' : m.platformStatus
                    const dotCls = pillCls === ' on' ? ' ok' : pillCls === ' testing' ? ' deg' : ''
                    return React.createElement('span', { className: 'dsh-mb-card-status' + pillCls, title: '平台状态：' + txt },
                      React.createElement('i', { className: 'dsh-mb-card-status-dot' + dotCls }),
                      txt)
                  })())),
              React.createElement('div', { className: 'dsh-mb-card-sub' },
                React.createElement('span', { className: 'dsh-mb-card-id', title: m.id }, '模型 ID: ' + m.id),
                m.provider ? React.createElement('span', { className: 'dsh-mb-card-src', title: m.provider }, m.provider) : null),
            ),
            React.createElement('div', { className: 'dsh-mb-card-details' },
              React.createElement('dl', { className: 'dsh-mb-card-dl' },
                m.contextLength !== null ? React.createElement('div', { key: 'ctx' },
                  React.createElement('dt', null, '序列长度'),
                  React.createElement('dd', { title: '完整数值：' + m.contextLength + ' Token' }, fmtCtx(m.contextLength))) : null,
                Array.isArray(m.categories) && m.categories.length > 0 ? React.createElement('div', { key: 'mod' },
                  React.createElement('dt', null, '支持模态'),
                  React.createElement('dd', null, m.categories.map((c) => CAT_LABELS[c] || c).join(' / '))) : null,
                m.maxOutput !== null ? React.createElement('div', { key: 'maxout' },
                  React.createElement('dt', null, '最大输出长度'),
                  React.createElement('dd', { title: '完整数值：' + m.maxOutput + ' Token' }, fmtCtx(m.maxOutput))) : null),
              React.createElement('dl', { className: 'dsh-mb-card-dl' },
                m.inPrice !== null && m.inPrice !== undefined ? React.createElement('div', { key: 'in' },
                  React.createElement('dt', null, '输入单价'),
                  React.createElement('dd', null, priceCell(m.inPrice, m.hasDiscount ? m.effInPrice : null))) : null,
                m.outPrice !== null && m.outPrice !== undefined ? React.createElement('div', { key: 'out' },
                  React.createElement('dt', null, '输出单价'),
                  React.createElement('dd', null, priceCell(m.outPrice, m.hasDiscount ? m.effOutPrice : null))) : null,
                m.cachePrice !== null && m.cachePrice !== undefined ? React.createElement('div', { key: 'cache' },
                  React.createElement('dt', null, '缓存命中单价'),
                  React.createElement('dd', null, priceCell(m.cachePrice, m.hasDiscount ? m.effCachePrice : null))) : null,
                m.perImagePrice !== null && m.perImagePrice !== undefined ? React.createElement('div', { key: 'img' },
                  React.createElement('dt', null, '图片单价'),
                  React.createElement('dd', null, '¥' + trimNum(m.perImagePrice) + '/张')) : null)),
          ))),
        )
        rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' }, '点击卡片复制模型 ID'))
      }
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 自定义检测面板（状态页签置顶卡）：勾选 chat 模型 + 立即/定时，host 用
    // DSH 已配置的 key 真实 1-token 探测。纯渲染函数：状态全挂 Panel 层（同 catFilter 约定）。
    function renderCheckPanel({ models, checkSel, toggleCheckSel, checkBusy, checkResults, checkInterval, setCheckInterval, checkNextAt, checkMsg, runCheckNow }) {
      // chips 与结果行都按模型页签的排序展示（sortModelsLikeCards），且只显示可检测的
      // chat 类模型——图像/音频等本来就不能探测，直接不出现（用户定稿）。
      const list = (models && Array.isArray(models.list)) ? sortModelsLikeCards(models.list).filter(canCheckModel) : []
      const selCount = list.filter((m) => checkSel[m.id] === true).length
      const checkableCount = list.length
      const rows = []
      rows.push(React.createElement('div', { className: 'dsh-mb-ck-head', key: 'h' },
        React.createElement('span', { className: 'dsh-mb-ck-title' }, '自定义检测'),
        React.createElement('span', { className: 'dsh-mb-ck-sub' }, '用 DSH 已配置的 Key 实测 · 真实 1-token 计费（约 ¥0.0004/模型）')))
      rows.push(React.createElement('div', { className: 'dsh-mb-ck-ctl', key: 'c' },
        React.createElement('button', {
          className: 'dsh-mb-ck-run' + (checkBusy || selCount === 0 ? ' disabled' : ''),
          disabled: checkBusy || selCount === 0,
          onClick: runCheckNow,
          title: '对每个选中模型执行一次真实 1-token 推理，计入你的 API Key 账单',
        }, checkBusy ? '检测中…' : '立即检测'),
        React.createElement('select', {
          className: 'dsh-mb-ck-int',
          value: checkInterval,
          onChange: (e) => setCheckInterval(Number(e.target.value)),
          title: '面板打开期间按间隔自动重测（关面板即停）',
        },
          React.createElement('option', { value: 0 }, '定时：关'),
          [5, 10, 15, 30, 60].map((n) => React.createElement('option', { key: n, value: n }, '定时：每 ' + n + ' 分钟'))),
        checkInterval > 0 && checkNextAt ? React.createElement('span', { className: 'dsh-mb-ck-next' }, '下次 ' + fmtProbeTime(checkNextAt)) : null,
        React.createElement('span', { className: 'dsh-mb-ck-count' }, '已选 ' + selCount + '/' + checkableCount)))
      if (models === null || models.loading) {
        rows.push(React.createElement('div', { className: 'dsh-mb-ck-chips', key: 'ch' },
          React.createElement('span', { className: 'dsh-mb-ck-empty' }, '模型列表加载中…')))
      } else if (list.length === 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-ck-chips', key: 'ch' },
          React.createElement('span', { className: 'dsh-mb-ck-empty' }, '没有可检测的 chat 类模型')))
      } else {
        // 模型 chips：只含可检测的 chat 类（已在上面的 list 过滤），一行固定 5 个等宽。
        rows.push(React.createElement('div', { className: 'dsh-mb-ck-chips', key: 'ch' },
          list.map((m) => {
            const on = checkSel[m.id] === true
            return React.createElement('button', {
              key: m.id,
              className: 'dsh-mb-ck-chip' + (on ? ' on' : ''),
              title: '点击' + (on ? '取消勾选' : '勾选'),
              onClick: () => toggleCheckSel(m.id),
            }, m.name && m.name !== m.id ? m.name : m.id)
          })))
      }
      // 结果行：只看当前勾选的模型（未测=灰点「未检测」），取消勾选的不再显示。
      // 结果行顺序 = 模型页签顺序（与 chips 同序）；列表刷新后残留的已选 id 追加在尾部。
      const selIds = list.filter((m) => checkSel[m.id] === true).map((m) => m.id)
      for (const id of Object.keys(checkSel)) {
        if (checkSel[id] === true && !selIds.includes(id)) selIds.push(id)
      }
      if (selIds.length > 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-ck-results', key: 'r' },
          React.createElement('span', { className: 'dsh-mb-ck-results-hd' }, '检测结果'),
          selIds.map((id) => {
            const p = checkResults[id] || null
            if (!p) {
              return React.createElement('span', { key: id, className: 'dsh-mb-ck-res', title: '未检测——点「立即检测」或等定时轮' },
                React.createElement('i', { className: 'dsh-mb-ck-dot none' }),
                React.createElement('span', { className: 'dsh-mb-ck-res-id' }, id),
                React.createElement('span', { className: 'dsh-mb-ck-res-ms' }, '未检测'))
            }
            const cls = p.status === 'up' ? 'ok' : p.status === 'degraded' ? 'deg' : 'fail'
            const txt = p.status === 'up'
              ? fmtMsShort(p.ms)
              : p.status === 'degraded'
                ? '降级' + (p.ms != null ? ' ' + fmtMsShort(p.ms) : '')
                : (PROBE_KIND_TEXT[p.errorKind] || '失败')
            const tip = '本地检测' + (fmtProbeTime(p.checkedAt) ? ' ' + fmtProbeTime(p.checkedAt) + ' · ' : '')
              + (p.status === 'up' ? '正常' : p.status === 'degraded' ? '降级（可能限流）' : '失败')
              + (p.error ? ' · ' + p.error : '')
            return React.createElement('span', { key: id, className: 'dsh-mb-ck-res', title: tip },
              React.createElement('i', { className: 'dsh-mb-ck-dot ' + cls }),
              React.createElement('span', { className: 'dsh-mb-ck-res-id' }, id),
              React.createElement('span', { className: 'dsh-mb-ck-res-ms' }, txt))
          })))
      }
      if (checkMsg) {
        rows.push(React.createElement('div', { className: 'dsh-mb-ck-err', key: 'e' }, checkMsg.error))
      }
      return React.createElement('div', { className: 'dsh-mb-ckcard' }, rows)
    }

    // ---- 密钥页签：平台「我的 API Key」列表 + 新建（完整值只显示一次）----
    function fmtDay(iso) {
      const t = iso ? new Date(iso) : null
      if (!t || Number.isNaN(t.getTime())) return null
      return (t.getMonth() + 1) + '-' + t.getDate()
    }
    function renderKeysTab({ manifest, keysData, loadKeys, keyName, setKeyName, keyCreating, createKey, createdKey, setCreatedKey, copiedCreated, copyCreatedKey, copiedKeyId, copyReveal }) {
      const capable = manifest && Array.isArray(manifest.providers) && manifest.providers.some((p) => p.balanceCapable)
      if (!capable) {
        return React.createElement('div', { className: 'dsh-mb-notice' }, 'settings.yaml 里没有基元律动（tokenrhythm）提供商')
      }
      const rows = []
      if (keysData && keysData.code === 'SESSION_EXPIRED') {
        rows.push(React.createElement('div', { className: 'dsh-mb-banner', key: 'expired' },
          '登录已过期，请到 ',
          React.createElement('button', { className: 'dsh-mb-link', onClick: () => setStore({ settingsOpen: true }) }, '设置'),
          ' 重新登录'))
      } else if (keysData && keysData.code === 'NO_SESSION') {
        rows.push(React.createElement('div', { className: 'dsh-mb-banner', key: 'nosess' },
          '尚未登录，请到 ',
          React.createElement('button', { className: 'dsh-mb-link', onClick: () => setStore({ settingsOpen: true }) }, '设置'),
          ' 添加账号'))
      } else if (keysData && keysData.error) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'err' }, '加载失败：' + keysData.error))
      }
      // 新建入口。
      rows.push(React.createElement('div', { className: 'dsh-mb-key-create', key: 'create' },
        React.createElement('input', {
          className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
          placeholder: '新密钥名称（可留空自动命名）',
          value: keyName,
          onChange: (e) => setKeyName(e.target.value),
        }),
        React.createElement('button', { className: 'dsh-mb-btn', disabled: keyCreating, onClick: createKey },
          keyCreating ? '创建中…' : '新建密钥'),
      ))
      // 创建成功：完整密钥只显示一次。
      if (createdKey) {
        rows.push(React.createElement('div', { className: 'dsh-mb-created', key: 'created' },
          React.createElement('div', { className: 'dsh-mb-created-title' }, '「' + createdKey.name + '」已创建，完整密钥只显示这一次'),
          React.createElement('div', { className: 'dsh-mb-created-key' }, createdKey.key),
          React.createElement('div', { className: 'dsh-mb-btn-row' },
            React.createElement('button', { className: 'dsh-mb-btn', onClick: copyCreatedKey },
              copiedCreated ? '已复制 ✓' : '复制密钥'),
            React.createElement('button', { className: 'dsh-mb-btn ghost', onClick: () => setCreatedKey(null) }, '我已保存'),
          ),
        ))
      }
      // 列表。
      if (keysData === null || keysData.loading) {
        // 骨架屏：密钥行 shimmer 占位。
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'ld', role: 'status', 'aria-label': '加载中' },
          [38, 62, 50, 56].map((w, i) => React.createElement('div', { className: 'dsh-mb-skel', key: i, style: { width: w + '%' } })),
        ))
      } else if (!keysData.error && Array.isArray(keysData.list)) {
        const list = keysData.list
        const copyableCount = list.filter((k) => k.copyable).length
        rows.push(React.createElement('div', { className: 'dsh-mb-keys-head', key: 'hd' },
          React.createElement('span', { className: 'dsh-mb-day-title', style: { marginTop: 0 } }, '我的密钥（' + list.length + '）'),
          React.createElement('span', { className: 'dsh-mb-hint', style: { opacity: 1 } },
            copyableCount > 0 ? copyableCount + ' 把可复制完整值' : ''),
        ))
        if (list.length === 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'empty' }, '还没有密钥，用上面的按钮创建一个'))
        }
        rows.push(React.createElement('div', { className: 'dsh-mb-keys-list', key: 'ls' },
          list.map((k) => React.createElement('div', { className: 'dsh-mb-key-card', key: k.id || k.masked },
            React.createElement('div', { className: 'dsh-mb-key-card-top' },
              React.createElement('span', { className: 'dsh-mb-key-card-name' }, k.name),
              React.createElement('span', { className: 'dsh-mb-badge' + (k.status === 'enabled' ? ' on' : ' off') },
                k.status === 'enabled' ? '使用中' : '已停用'),
            ),
            React.createElement('div', { className: 'dsh-mb-key-code-row' },
              React.createElement('span', { className: 'dsh-mb-key-card-code' }, k.masked || '—'),
              k.copyable
                ? React.createElement('button', {
                    className: 'dsh-mb-key-copy', title: '复制完整密钥',
                    onClick: () => copyReveal(k),
                  }, copiedKeyId === k.id ? '已复制 ✓' : '复制完整值')
                : null,
            ),
            React.createElement('div', { className: 'dsh-mb-key-card-meta' },
              k.lastUsedAt ? '最近使用 ' + (fmtDay(k.lastUsedAt) || '—') : '从未使用',
              k.createdAt ? ' · 创建于 ' + (fmtDay(k.createdAt) || '—') : ''),
          ))),
        )
        const noneCopyable = list.length > 0 && copyableCount === 0
        rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
          noneCopyable
            ? '历史密钥平台只保留打码值，无法复制完整内容；需要新密钥可在上方一键创建（创建时显示一次）'
            : '与平台安全策略一致：历史密钥只显示打码值，完整值仅在创建时展示一次',
          React.createElement('button', { className: 'dsh-mb-link', style: { marginLeft: 4 }, onClick: () => { try { window.open('https://tokenrhythm.studio/account/keys', '_blank') } catch { /* 拦截无碍 */ } } }, '官网管理 ↗')))
      }
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 余额页签：限时额度 hero + 当日使用（含缓存命中）+ 7 天趋势 + 最近调用 ----
    function renderBalanceTab({ manifest, balance, loadBalance, goSettings, showCalls, setShowCalls, trendHoverIdx, setTrendHoverIdx, sessionAccount, sessionAccountName }) {
      const capable = manifest && Array.isArray(manifest.providers) && manifest.providers.some((p) => p.balanceCapable)
      if (!capable) {
        return React.createElement('div', { className: 'dsh-mb-notice' }, 'settings.yaml 里没有基元律动（tokenrhythm）提供商，无法查询余额')
      }
      const rows = []
      if (balance && balance.code === 'SESSION_EXPIRED') {
        rows.push(React.createElement('div', { className: 'dsh-mb-banner', key: 'expired' },
          '网页会话已过期，请到 ',
          React.createElement('button', { className: 'dsh-mb-link', onClick: goSettings }, '设置'),
          ' 页签重新粘贴 Cookie'))
      } else if (balance && balance.code === 'NO_SESSION') {
        rows.push(React.createElement('div', { className: 'dsh-mb-banner', key: 'nosess' },
          '尚未配置网页会话，请到 ',
          React.createElement('button', { className: 'dsh-mb-link', onClick: goSettings }, '设置'),
          ' 页签粘贴 Cookie（只需一次）'))
      } else if (balance && balance.error) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'err' }, '余额查询失败：' + balance.error))
      }
      // 首查加载：与主卡 / 当日使用同构的骨架屏占位（有数据或错误/会话提示时不再显示）。
      if (!balance || (balance.loading && !balance.data)) {
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-hero', key: 'ld', role: 'status', 'aria-label': '加载中' },
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '40%', height: 30, borderRadius: 8 } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '72%' } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '100%', height: 7, borderRadius: 4 } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '28%' } }),
        ))
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-kv', key: 'ldkv' },
          Array.from({ length: 5 }, (_, i) => React.createElement('div', { className: 'dsh-mb-skel-kv-i', key: i },
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '40%' } }),
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '72%' } }),
          ))))
      }
      const d = balance && balance.data
      if (d) {
        // 预警条：临期 / 余额不足。
        const alert = alertOf(d)
        if (alert) {
          rows.push(React.createElement('div', { className: 'dsh-mb-banner', key: 'alert' },
            alert.expiring && alert.low
              ? '限时额度 ' + expiryLabel(alert.expiringDays) + '，且可用余额已不足 ¥10，尽快使用或充值'
              : alert.expiring
                ? '限时额度 ¥' + trimNum(alert.expiringBalanceCny) + '，' + expiryLabel(alert.expiringDays) + '，到期未用部分失效'
                : '可用余额仅剩 ¥' + trimNum(alert.availableBalanceCny) + '，建议充值'))
        }
        // 数据归属标注：余额/趋势都是「当前登录账号」的数据，切换账号会随之变化。
        // 显示平台用户名：优先 manifest.accountName（/api/me 提取，开面板即有），
        // 其次余额响应里的 account（同样来自 /api/me，每 60s 刷新）；
        // 都缺（/api/me 不可用）才回退登录标识 account（手机号）或 Cookie 模式文案。
        const dataAccount = sessionAccountName || (balance && balance.data && balance.data.account) || sessionAccount || null
        rows.push(React.createElement('div', { className: 'dsh-mb-acct-line' + (dataAccount ? '' : ' none'), key: 'acct' },
          React.createElement('span', { className: 'dsh-mb-acct-dot' }),
          '数据账号：' + (dataAccount || '未登录（Cookie 模式）'),
        ))
        // 主卡：账户余额为主位，限时额度副位（倒计时胶囊）+ 限时占比条 + 图例。
        const expiry = d.nextExpiryAt ? new Date(d.nextExpiryAt) : null
        const expiryValid = expiry !== null && !Number.isNaN(expiry.getTime())
        const expDays = expiryValid ? expiryDaysOf(expiry.getTime()) : null
        const chipText = expiryValid
          ? expiryLabel(expDays) + ' · ' + (expiry.getMonth() + 1) + '月' + expiry.getDate() + '日'
          : null
        const chipTitle = expiryValid
          ? expiry.getFullYear() + '-' + String(expiry.getMonth() + 1).padStart(2, '0') + '-' + String(expiry.getDate()).padStart(2, '0')
            + ' ' + String(expiry.getHours()).padStart(2, '0') + ':' + String(expiry.getMinutes()).padStart(2, '0') + ' 到期'
          : null
        const hasTotal = d.balanceCny !== null && d.balanceCny !== undefined
        const hasExpiring = d.expiringBalanceCny !== null && d.expiringBalanceCny !== undefined
        const share = hasTotal && hasExpiring && d.balanceCny > 0
          ? Math.min(1, Math.max(0, d.expiringBalanceCny / d.balanceCny))
          : null
        const legendBits = []
        if (share !== null) legendBits.push('限时占 ' + (Math.round(share * 1000) / 10) + '%')
        if (d.frozenBalanceCny) legendBits.push('冻结 ¥' + fmtCny(d.frozenBalanceCny))
        rows.push(React.createElement('div', { className: 'dsh-mb-hero', key: 'hero' },
          React.createElement('div', { className: 'dsh-mb-hero-stats' },
            React.createElement('div', { className: 'dsh-mb-stat' },
              React.createElement('span', { className: 'dsh-mb-stat-k' }, '账户余额'),
              React.createElement('span', { className: 'dsh-mb-stat-v' }, hasTotal ? '¥' + fmtCny(d.balanceCny) : '—'),
            ),
            hasExpiring ? React.createElement('div', { className: 'dsh-mb-stat right' },
              React.createElement('span', { className: 'dsh-mb-stat-k' }, '限时额度（到期失效）'),
              React.createElement('span', { className: 'dsh-mb-stat-v' }, '¥' + fmtCny(d.expiringBalanceCny)),
              chipText !== null ? React.createElement('span', {
                className: 'dsh-mb-hero-chip' + (expDays !== null && expDays <= 3 ? ' soon' : ''),
                title: chipTitle,
              }, chipText) : null,
            ) : null,
          ),
          share !== null ? React.createElement('div', { className: 'dsh-mb-hero-bar', title: chipTitle },
            React.createElement('div', { className: 'dsh-mb-hero-bar-fill', style: { width: (share * 100) + '%' } }),
          ) : null,
          legendBits.length > 0 ? React.createElement('div', { className: 'dsh-mb-hero-legend' },
            legendBits.map((bit, i) => React.createElement('span', { key: i }, bit)),
          ) : null,
        ))
        // 当日使用情况（与花费趋势同源：今天的 call-logs 分桶直读，数字必然一致；含缓存命中与命中率）。
        // 输入/输出合一张卡；缓存命中 + 命中率合一张卡。
        // 命中率口径（实测平台日志修正）：缓存命中 ÷ 输入。平台 call-logs 的
        // input_tokens【已包含】缓存命中部分（totalTokens = in + out 可证；费用
        // 反推 (in−缓存)×单价 + 缓存×缓存价 与 costCny 分毫不差），分母不再加缓存。
        const cacheHitRate = (day) => {
          const denom = day.inputTokens || 0
          if (denom <= 0) return '—'
          return trimNum(Math.round((day.cacheReadTokens || 0) / denom * 1000) / 10) + '%'
        }
        const day = d.daily
        rows.push(React.createElement('div', { className: 'dsh-mb-day-title', key: 'daytitle' }, '当日使用'))
        // 当日卡只在「分页真的缺页」（trendMeta.dailyPartial）时才提示：truncated 通常
        // 只是更早的日子没拉完（页序最新优先），今天的数字仍是全的，不必吓唬用户。
        if (d.trendMeta && d.trendMeta.dailyPartial) {
          rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'dayhint' },
            '当日日志分页拉取有失败，下方数字可能偏小，60s 内自动补齐'))
        }
        rows.push(React.createElement('div', { className: 'dsh-mb-kv-grid', key: 'kv' },
          [
            ['调用', day ? (day.calls + ' 次' + (day.calls > day.successCalls ? '（成功 ' + day.successCalls + '）' : '')) : '—'],
            ['输入 / 输出', day ? fmtTokens(day.inputTokens) + ' / ' + fmtTokens(day.outputTokens) : '—'],
            ['缓存命中 / 命中率', day ? fmtTokens(day.cacheReadTokens) + ' · ' + cacheHitRate(day) : '—', '缓存命中率 = 缓存命中 ÷ 输入（平台 input_tokens 已包含缓存命中部分）'],
            ['花费', day ? '¥' + trimNum(day.costCny) : '—'],
          ].map(([k, v, tip], i) => React.createElement('div', { className: 'dsh-mb-kv', key: i, title: tip || undefined },
            React.createElement('span', { className: 'dsh-mb-kv-k' }, k),
            React.createElement('span', { className: 'dsh-mb-kv-v' }, v)))),
        )
        // 花费趋势：最近 7 个有调用记录的日子（无记录日不留痕、不占柱位，与用量页 7 日图同口径）。
        // 柱顶直接标金额；「今天」高亮仅当最新有记录日就是今天；悬停浮出当日模型明细。
        // trendMeta.truncated：窗口/页数上限内没能凑齐完整的 7 个有记录日——注明仅统计
        // 最新 N 条，不装准。
        if (Array.isArray(d.trend) && d.trend.length > 0) {
          const meta = d.trendMeta && d.trendMeta.truncated ? d.trendMeta : null
          const max = Math.max.apply(null, d.trend.map((b) => b.costCny).concat([0.01]))
          const totalCost = d.trend.reduce((acc, b) => acc + b.costCny, 0)
          const totalCalls = d.trend.reduce((acc, b) => acc + b.calls, 0)
          const now = new Date()
          const todayLabel = (now.getMonth() + 1) + '-' + now.getDate()
          const lastDay = d.trend.length - 1
          rows.push(React.createElement('div', { className: 'dsh-mb-trend-wrap', key: 'trend' },
            React.createElement('div', { className: 'dsh-mb-day-title' },
              '花费 · 最近 ' + d.trend.length + ' 个有记录日 · 合计 ¥' + trimNum(totalCost) + ' · ' + totalCalls + ' 次'),
            meta ? React.createElement('div', { className: 'dsh-mb-hint' },
              '记录未完整拉取（仅统计最新 ' + meta.fetched + ' 条），金额与次数偏小仅作参考') : null,
            React.createElement('div', {
              className: 'dsh-mb-trend',
              onMouseLeave: () => setTrendHoverIdx(null),
            },
              d.trend.map((b, i) => {
                const models = Array.isArray(b.models) ? b.models : null
                const tipRows = models === null
                  ? [{ model: '暂无模型明细' }]
                  : models.length > 0 ? models : [{ model: '当天无调用' }]
                return React.createElement('div', {
                  className: 'dsh-mb-trend-col' + (b.date === todayLabel ? ' today' : ''),
                  key: i,
                  onMouseEnter: () => setTrendHoverIdx(i),
                },
                  React.createElement('span', { className: 'dsh-mb-trend-val' }, '¥' + trimNum(b.costCny)),
                  React.createElement('div', { className: 'dsh-mb-trend-bar', style: { height: Math.max(4, Math.round(b.costCny / max * 40)) + 'px' } }),
                  React.createElement('span', { className: 'dsh-mb-trend-date' }, b.date),
                  trendHoverIdx === i ? React.createElement('div', {
                    className: 'dsh-mb-trend-tip' + (i === 0 ? ' edge-l' : i === lastDay ? ' edge-r' : ''),
                  },
                    React.createElement('div', { className: 'dsh-mb-trend-tip-head' },
                      React.createElement('span', null, b.date),
                      React.createElement('span', null, '¥' + trimNum(b.costCny) + ' · ' + b.calls + ' 次'),
                    ),
                    tipRows.map((m, j) => React.createElement('div', { className: 'dsh-mb-trend-tip-row', key: j },
                      React.createElement('span', { className: 'dsh-mb-trend-tip-model' }, m.model),
                      m.costCny === undefined ? null : React.createElement('span', { className: 'dsh-mb-trend-tip-cost' }, '¥' + trimNum(m.costCny)),
                      m.calls === undefined ? null : React.createElement('span', { className: 'dsh-mb-trend-tip-calls' }, m.calls + ' 次'),
                    )),
                  ) : null,
                )
              }),
            ),
          ))
        }
        // 最近调用（24h 内最新 10 条，折叠列表；卡片化行列表 + 状态点晕 + 耗时/费用右对齐）。
        const recent = Array.isArray(d.recent) ? d.recent : []
        if (recent.length > 0) {
          rows.push(React.createElement('button', {
            className: 'dsh-mb-toggle', key: 'calls-toggle',
            onClick: () => setShowCalls(!showCalls),
          },
            (showCalls ? '▾' : '▸') + ' 最近调用',
            React.createElement('span', { className: 'dsh-mb-call-count' }, '24h · ' + recent.length + ' 条')))
          if (showCalls) {
            rows.push(React.createElement('div', { className: 'dsh-mb-calls', key: 'calls' },
              recent.map((c, i) => {
                const t = c.t ? new Date(c.t) : null
                const time = t && !Number.isNaN(t.getTime())
                  ? String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
                  : '--:--'
                const ok = c.status === 200
                return React.createElement('div', { className: 'dsh-mb-call' + (ok ? '' : ' err'), key: i, title: (c.model || '') + ' · 状态 ' + c.status + ' · ' + (c.latencyMs || 0) + 'ms' },
                  React.createElement('span', { className: 'dsh-mb-call-dot ' + (ok ? 'ok' : 'err') }),
                  React.createElement('span', { className: 'dsh-mb-call-time' }, time),
                  React.createElement('span', { className: 'dsh-mb-call-model' }, c.model || '—'),
                  React.createElement('span', { className: 'dsh-mb-call-lat' }, (c.latencyMs || 0) + 'ms'),
                  React.createElement('span', { className: 'dsh-mb-call-cost' + (c.costCny > 0 ? '' : ' zero') }, '¥' + trimNum(c.costCny)),
                )
              }),
            ))
          }
        }
      }
      rows.push(React.createElement('div', { className: 'dsh-mb-balance-foot', key: 'ft' },
        d
          ? '更新于 ' + new Date(d.fetchedAt).toLocaleTimeString() + ' · 每 60s 自动刷新' + (d.account ? ' · ' + d.account : '')
          : (balance && balance.loading ? '查询中…' : ''),
        React.createElement('button', { className: 'dsh-mb-refresh', onClick: loadBalance }, '刷新'),
      ))
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- ZCode「用量」页签：套餐额度英雄卡 + 分项限额。数据来自本机
    // ~/.zcode/v2 凭证 + zcode.z.ai / open.bigmodel.cn 官方接口（host 代理）。
    // 值格式：token 类大数用 万/亿 缩写，其余用 trimNum。 ----
    const zcFmtVal = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—'
      return Math.abs(n) >= 10000 ? fmtTokens(n) : trimNum(n)
    }
    function renderZcUsageTab({ zcQuota, loadZcQuota }) {
      const rows = []
      if (zcQuota === null || (zcQuota.loading && !zcQuota.data)) {
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-hero', key: 'ld', role: 'status', 'aria-label': '加载中' },
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '40%', height: 30, borderRadius: 8 } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '72%' } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '100%', height: 7, borderRadius: 4 } }),
        ))
      } else if (zcQuota.error) {
        rows.push(React.createElement('div', { className: zcQuota.code === 'NO_CREDENTIALS' ? 'dsh-mb-notice' : 'dsh-mb-notice err', key: 'qerr' },
          zcQuota.code === 'NO_CREDENTIALS'
            ? '未找到 ZCode 登录凭证（~/.zcode/v2/credentials.json）——请先在 ZCode 客户端登录，再回到本页查看额度'
            : '额度查询失败：' + zcQuota.error,
          zcQuota.code !== 'NO_CREDENTIALS'
            ? React.createElement('div', { style: { marginTop: '6px' } },
              React.createElement('button', { className: 'dsh-mb-link', onClick: () => loadZcQuota(true) }, '重试'))
            : null))
      } else {
        const d = zcQuota.data
        const noPlan = d.source === 'no_plan' || (d.isEmpty === true && !d.planTier && (d.items || []).length === 0)
        if (noPlan) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'noplan' },
            '当前 ZCode 账号没有可展示的套餐额度（未订阅 coding plan 或额度为空）'))
        } else {
          const idLine = d.identity && (d.identity.name || d.identity.provider)
            ? 'ZCode 账号：' + (d.identity.name || '未知') + (d.identity.provider ? '（' + d.identity.provider + '）' : '')
            : null
          if (idLine !== null) {
            rows.push(React.createElement('div', { className: 'dsh-mb-acct-line', key: 'acct' },
              React.createElement('span', { className: 'dsh-mb-acct-dot' }), idLine))
          }
          const unit = ((d.items || []).find((i) => i.unit) || { unit: '' }).unit
          const hasRemaining = d.remaining !== null && d.remaining !== undefined
          const pct = d.percentUsed !== null && d.percentUsed !== undefined
            ? Math.min(100, Math.max(0, Math.round(d.percentUsed * 10) / 10))
            : null
          // 主位显示「剩余百分比」（与入口胶囊同口径），token 绝对值退居副行；
          // 无总量/百分比时回落 token 数直显。
          const remainPct = pct !== null ? Math.min(100, Math.max(0, Math.round((100 - pct) * 10) / 10)) : null
          const remainTxt = hasRemaining ? zcFmtVal(d.remaining) + (unit && unit !== 'quota' ? ' ' + unit : '') : null
          rows.push(React.createElement('div', { className: 'dsh-mb-hero', key: 'hero' },
            React.createElement('div', { className: 'dsh-mb-hero-stats' },
              React.createElement('div', { className: 'dsh-mb-stat' },
                React.createElement('span', { className: 'dsh-mb-stat-k' }, '剩余额度'),
                React.createElement('span', { className: 'dsh-mb-stat-v' },
                  remainPct !== null ? trimNum(remainPct) + '%' : (remainTxt || '—')),
                remainPct !== null && remainTxt !== null
                  ? React.createElement('span', { className: 'dsh-mb-stat-k' }, '≈ ' + remainTxt)
                  : null,
              ),
              React.createElement('div', { className: 'dsh-mb-stat right' },
                (d.planTier !== null && d.planTier !== undefined && d.planTier !== '') ? [
                  React.createElement('span', { className: 'dsh-mb-stat-k', key: 'k' }, '套餐'),
                  React.createElement('span', { className: 'dsh-mb-stat-v', key: 'v' }, d.planTier),
                  d.planExpire ? React.createElement('span', { className: 'dsh-mb-hero-chip', key: 'chip', title: '套餐到期时间' }, d.planExpire + ' 到期') : null,
                ] : null,
              ),
            ),
            pct !== null ? React.createElement('div', { className: 'dsh-mb-hero-bar', title: '已用 ' + pct + '%' },
              React.createElement('div', { className: 'dsh-mb-hero-bar-fill', style: { width: pct + '%' } }),
            ) : null,
            React.createElement('div', { className: 'dsh-mb-hero-legend' },
              React.createElement('span', null, pct !== null ? '已用 ' + pct + '%' : '已用 —'),
              React.createElement('span', null, (d.source === 'bigmodel.cn/api/monitor' || (d.source || '').includes('bigmodel')) ? '来源：open.bigmodel.cn' : '来源：zcode.z.ai'),
            ),
          ))
          // 分项限额（提示次数 / 时长 / 各模型 token 池）。
          const items = Array.isArray(d.items) ? d.items : []
          if (items.length > 0) {
            rows.push(React.createElement('div', { className: 'dsh-mb-kv-grid', key: 'items' },
              items.map((it, i) => React.createElement('div', { className: 'dsh-mb-kv', key: i, title: it.periodEnd || undefined },
                React.createElement('span', { className: 'dsh-mb-kv-k' }, it.name || '额度'),
                React.createElement('span', { className: 'dsh-mb-kv-v' },
                  (it.used !== null && it.used !== undefined ? zcFmtVal(it.used) : '—')
                  + (it.total !== null && it.total !== undefined ? ' / ' + zcFmtVal(it.total) : '')
                  + (it.unit && it.unit !== 'quota' ? ' ' + it.unit : '')),
                it.periodEnd ? React.createElement('span', { className: 'dsh-mb-kv-k' }, it.periodEnd) : null,
              ))))
          }
          rows.push(React.createElement('div', { className: 'dsh-mb-balance-foot', key: 'qfoot' },
            '更新于 ' + (d.fetchedAt ? new Date(d.fetchedAt).toLocaleTimeString() : '—') + ' · 每 60s 自动刷新' + (zcQuota.cached ? ' · 缓存' : ''),
            React.createElement('button', { className: 'dsh-mb-refresh', onClick: () => loadZcQuota(true) }, '刷新'),
          ))
        }
      }
      rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
        '读取本机 ~/.zcode/v2 登录凭证 · 接口经插件后台代理 · 凭证只留在本机'))
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- ZCode「活动」页签：可领取套餐卡片 + 验证码弹窗领取（结果经 postMessage 回传）。
    function renderZcClaimTab({ zcPlans, loadZcPlans, zcMsg, claimZcodePlan }) {
      const rows = []
      if (zcMsg) {
        rows.push(React.createElement('div', { className: 'dsh-mb-cookie-msg' + (zcMsg.ok ? '' : ' err'), key: 'msg' }, zcMsg.text))
      }
      if (zcPlans === null || (zcPlans.loading && !zcPlans.list)) {
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'pld', role: 'status', 'aria-label': '加载中' },
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '62%' } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '88%' } }),
        ))
      } else if (zcPlans.error) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'perr' },
          '活动列表加载失败：' + ((zcPlans.biz && zcPlans.biz.message) || zcPlans.error) + (zcPlans.biz && zcPlans.biz.nextAt
            ? '（' + new Date(zcPlans.biz.nextAt).toLocaleString() + ' 后可再领）' : ''),
          React.createElement('div', { style: { marginTop: '6px' } },
            React.createElement('button', { className: 'dsh-mb-link', onClick: loadZcPlans }, '重试'))))
      } else {
        const list = Array.isArray(zcPlans.list) ? zcPlans.list : []
        if (list.length === 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'pempty' }, '当前没有可领取的套餐'))
        } else {
          rows.push(React.createElement('div', { className: 'dsh-mb-keys-list', key: 'plist' },
            list.map((p) => React.createElement('div', { className: 'dsh-mb-key-card', key: p.planId },
              React.createElement('div', { className: 'dsh-mb-key-card-top' },
                React.createElement('span', { className: 'dsh-mb-key-card-name', title: p.description || p.name }, p.name || p.planId),
                React.createElement('button', { className: 'dsh-mb-key-copy primary', onClick: () => claimZcodePlan(p) }, '领取'),
              ),
              p.description ? React.createElement('div', { className: 'dsh-mb-key-card-meta' }, p.description) : null,
              p.grants && p.grants.length > 0 ? React.createElement('div', { className: 'dsh-mb-key-card-meta' }, p.grants.join('；')) : null,
            ))))
        }
        if (zcPlans.activationError) {
          rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'acterr' },
            '激活上报失败：' + zcPlans.activationError + '（不影响展示，领取可能受限）'))
        }
        rows.push(React.createElement('div', { className: 'dsh-mb-balance-foot', key: 'pfoot' },
          '领取需通过验证码 · 弹窗完成后自动提交',
          React.createElement('button', { className: 'dsh-mb-refresh', onClick: loadZcPlans }, '刷新'),
        ))
      }
      rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
        '读取本机 ~/.zcode/v2 登录凭证 · 接口经插件后台代理 · 凭证只留在本机'))
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 阶跃工具格式化 ----
    const fmtStepDate = (epochSec) => {
      const n = Number(epochSec)
      if (!Number.isFinite(n) || n <= 0) return null
      const d = new Date(n * 1000)
      if (!Number.isFinite(d.getTime())) return null
      const md = (d.getMonth() + 1) + '月' + d.getDate() + '日'
      return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + '-' + md
    }
    // Credit 数字：亿/万缩写（完整值放 title）；1M Credit=¥1 的换算只作 tooltip 说明。
    const stepCreditTip = (n) => (Number.isFinite(n) ? '完整值：' + n.toLocaleString('en-US') + ' Credit（1M Credit=¥1，以控制台为准）' : '')

    // ---- 阶跃「用量」页签：Step Plan 月池英雄卡 + 明细 + 近 7 日 Credit 柱条 ----
    function renderStepUsageTab({ stepPlan, loadStepPlan, goSettings }) {
      if (stepPlan === null || (stepPlan.loading && !stepPlan.data)) {
        return React.createElement('div', { className: 'dsh-mb-section' },
          React.createElement('div', { className: 'dsh-mb-skel-hero', key: 'sk1' }),
          React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'sk2' }))
      }
      if (!stepPlan.data) {
        const needConfig = stepPlan.code === 'NO_STEP_ACCOUNT'
        return React.createElement('div', { className: 'dsh-mb-section' },
          React.createElement('div', { className: 'dsh-mb-notice' + (needConfig ? '' : ' err'), key: 'n' },
            stepPlan.error || '加载失败',
            React.createElement('div', { style: { marginTop: 6 } }, needConfig
              ? React.createElement('button', { className: 'dsh-mb-link', onClick: goSettings }, '前往设置完成配置')
              : React.createElement('button', { className: 'dsh-mb-link', onClick: () => loadStepPlan(true) }, '重试'))))
      }
      const d = stepPlan.data
      const plan = d.plan || null
      const credit = d.credit || null
      const rows = []
      if (d.stale) rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'stale' },
        '阶跃暂时不可达，显示 ' + fmtCheckedAt(d.fetchedAt) + ' 的上次结果'))
      // 英雄卡：月池剩余
      const c = credit && credit.credits ? credit.credits : null
      const share = c && c.total > 0 ? Math.max(0, Math.min(1, c.residual / c.total)) : null
      const pct = share === null ? null : Math.round(share * 1000) / 10 // 一位小数百分比，如 97.8
      rows.push(React.createElement('div', { className: 'dsh-mb-hero', key: 'hero' },
        React.createElement('div', { className: 'dsh-mb-hero-stats' },
          React.createElement('div', { className: 'dsh-mb-stat', key: 'l' },
            React.createElement('span', { className: 'dsh-mb-stat-k' }, 'Credit 月池剩余'),
            React.createElement('span', {
              className: 'dsh-mb-stat-v',
              title: c ? '剩余 ' + c.residual.toLocaleString('en-US') + ' / 共 ' + c.total.toLocaleString('en-US') + ' Credit' : '',
            }, pct === null ? '—' : pct + '%')),
          React.createElement('div', { className: 'dsh-mb-stat right', key: 'r' },
            React.createElement('span', { className: 'dsh-mb-stat-k' }, '套餐档位'),
            React.createElement('span', { className: 'dsh-mb-stat-v' }, plan && plan.tier ? plan.tier : '—'),
            plan && plan.autoRenew === true
              ? React.createElement('span', { className: 'dsh-mb-hero-chip', title: '自动续费已开' }, '自动续费')
              : null)),
        share !== null
          ? React.createElement('div', {
            className: 'dsh-mb-hero-bar',
            title: c ? '剩余 ' + c.residual.toLocaleString('en-US') + ' / 共 ' + c.total.toLocaleString('en-US') + ' Credit' : '',
          }, React.createElement('div', { className: 'dsh-mb-hero-bar-fill', style: { width: (share * 100) + '%' } }))
          : null,
        c
          ? React.createElement('div', { className: 'dsh-mb-hero-legend' },
            React.createElement('span', null, '已用 ' + fmtTokens(c.used) + ' · 共 ' + fmtTokens(c.total)),
            React.createElement('span', null, credit.subscriptionResetAt ? fmtStepDate(credit.subscriptionResetAt) + ' 重置' : ''))
          : null))
      // 明细卡（含部分失败的报错透出）
      const dl = []
      if (plan && plan.expireAt) dl.push(React.createElement('div', { key: 'exp' }, React.createElement('dt', null, '套餐到期'),
        React.createElement('dd', null, fmtStepDate(plan.expireAt) || '—')))
      if (plan && plan.autoRenew === false) dl.push(React.createElement('div', { key: 'ar' }, React.createElement('dt', null, '自动续费'), React.createElement('dd', null, '已关闭')))
      if (credit && credit.hasTopup) {
        const tb = (credit.buckets || []).find((b) => b.type === 2)
        if (tb) dl.push(React.createElement('div', { key: 'tp' }, React.createElement('dt', null, '加油包'),
          React.createElement('dd', { title: stepCreditTip(tb.residual) }, fmtTokens(tb.residual) + (tb.expireAt ? ' · ' + (fmtStepDate(tb.expireAt) || '') + ' 到期' : ''))))
      }
      dl.push(React.createElement('div', { key: 'at' }, React.createElement('dt', null, '数据时间'),
        React.createElement('dd', null, fmtCheckedAt(d.fetchedAt))))
      const partErrs = [d.statusError, d.creditError].filter(Boolean)
      rows.push(React.createElement('div', { className: 'dsh-mb-card', key: 'det' },
        React.createElement('dl', { className: 'dsh-mb-card-dl' }, dl),
        partErrs.length > 0 ? React.createElement('div', { className: 'dsh-mb-hint' }, '部分接口异常：' + partErrs[0]) : null))
      // 近 7 日 Credit 消耗（QueryStepPlanUsages；按本地日聚合，取最近 7 个有记录的日子——
      // 平台的记录流不保证连续（无调用日无记录），最近一条可能已是数周前；
      // 此时「近 7 日」名不副实，标题降级为「最近 7 个有记录日」并标注最早日期）
      const usageErr = d.usageError
      const usages = Array.isArray(d.usages) ? d.usages : []
      const days = new Map()
      for (const u of usages) {
        if (!u || !Number.isFinite(u.from)) continue
        const dt = new Date(u.from * 1000)
        const key = dt.getFullYear() + '-' + dt.getMonth() + '-' + dt.getDate()
        const prev = days.get(key)
        days.set(key, { dt, v: (prev ? prev.v : 0) + (Number(u.credit) || 0) })
      }
      const picked = [...days.values()].sort((a, b) => b.dt - a.dt).slice(0, 7).sort((a, b) => a.dt - b.dt)
      if (picked.length > 0) {
        const dayLabel = (x) => (x.dt.getMonth() + 1) + '-' + x.dt.getDate()
        // 真近 7 日：最早一条仍在 7×24h 内；否则是「最近 7 个有记录日」，不得冒充近 7 日
        const stale = picked[0].dt.getTime() < Date.now() - 7 * 86400000
        const cells = picked.map((x) => ({ label: dayLabel(x), v: x.v }))
        const max = Math.max(1, ...cells.map((x) => x.v))
        rows.push(React.createElement('div', { className: 'dsh-mb-card', key: 'usg' },
          React.createElement('div', { className: 'dsh-mb-day-title' }, stale ? 'Credit 消耗（最近 7 个有记录日）' : '近 7 日 Credit 消耗'),
          stale ? React.createElement('div', { className: 'dsh-mb-hint' },
            '最早记录 ' + dayLabel(picked[0]) + ' · 无调用的日子平台不留痕') : null,
          cells.map((x) => React.createElement('div', { key: x.label, className: 'dsh-mb-step-bar' },
            React.createElement('span', { className: 'dsh-mb-step-bar-d' }, x.label),
            React.createElement('span', { className: 'dsh-mb-step-bar-track' },
              React.createElement('span', { className: 'dsh-mb-step-bar-fill', style: { width: (x.v / max * 100) + '%' } })),
            React.createElement('span', { className: 'dsh-mb-step-bar-v', title: stepCreditTip(x.v) }, x.v > 0 ? fmtTokens(x.v) : '')))))
      } else if (usageErr) {
        rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'ue' }, '用量明细暂不可用：' + usageErr))
      } else {
        rows.push(React.createElement('div', { className: 'dsh-mb-card', key: 'usg' },
          React.createElement('div', { className: 'dsh-mb-day-title' }, '近 7 日 Credit 消耗'),
          React.createElement('div', { className: 'dsh-mb-hint' },
            '近 7 日暂无调用明细（通过 Studio / MCP 等通道的消耗平台不在此接口留痕）')))
      }
      rows.push(React.createElement('div', { className: 'dsh-mb-btn-row', key: 're' },
        React.createElement('button', { className: 'dsh-mb-btn small ghost', onClick: () => loadStepPlan(true) }, '刷新')))
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 阶跃「账户」页签：余额英雄卡（控制台钱包主通道，API Key 兜底）----
    function renderStepAccountTab({ stepBal, loadStepBal, goSettings }) {
      const rows = []
      // 官方余额卡
      if (stepBal === null) {
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-hero', key: 'sk' }))
      } else if (!stepBal.data) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice' + (stepBal.code === 'NO_KEY' ? '' : ' err'), key: 'be' },
          stepBal.error || '加载失败',
          React.createElement('div', { style: { marginTop: 6 } },
            React.createElement('button', { className: 'dsh-mb-link', onClick: () => loadStepBal() }, '重试'),
            stepBal.code === 'NO_KEY' ? React.createElement('span', null,
              '　', React.createElement('button', { className: 'dsh-mb-link', onClick: goSettings }, '配置说明见设置')) : null)))
      } else {
        const acct = stepBal.data.account || {}
        const consoleSrc = stepBal.data.source === 'console'
        const typeName = acct.type === 'prepaid' ? '预付费' : acct.type === 'postpaid' ? '后付费' : (acct.type || '—')
        rows.push(React.createElement('div', { className: 'dsh-mb-hero', key: 'bhero' },
          React.createElement('div', { className: 'dsh-mb-hero-stats' },
            React.createElement('div', { className: 'dsh-mb-stat', key: 'l' },
              React.createElement('span', { className: 'dsh-mb-stat-k' }, '账户余额'),
              React.createElement('span', { className: 'dsh-mb-stat-v' }, '¥' + fmtCny(Number.isFinite(acct.balance) ? acct.balance : null))),
            React.createElement('div', { className: 'dsh-mb-stat right', key: 'r' },
              React.createElement('span', { className: 'dsh-mb-stat-k' }, '账户类型'),
              React.createElement('span', { className: 'dsh-mb-stat-v' }, typeName),
              React.createElement('span', {
                className: 'dsh-mb-hero-chip',
                title: consoleSrc ? '控制台 QueryAccountBalance（与登录会话同通道，免 API Key）' : '官方 /v1/accounts（API Key 通道，与内部登录无关）',
              }, consoleSrc ? '控制台' : '官方 API'))),
          React.createElement('div', { className: 'dsh-mb-hero-legend' },
            React.createElement('span', null, '现金 ¥' + fmtCny(acct.totalCash || 0)),
            React.createElement('span', null, '赠送 ¥' + fmtCny(acct.totalVoucher || 0)),
            consoleSrc && Number.isFinite(acct.costMonth)
              ? React.createElement('span', null, '本月消耗 ¥' + fmtCny(acct.costMonth) + ' · 累计 ¥' + fmtCny(acct.costTotal || 0))
              : null)))
      }
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 阶跃「接口密钥」页签（与设置页阶跃卡共用同一套 inner UI）----
    function renderStepKeysTab({ stepKeys, stepKeyName, setStepKeyName, stepKeyBusy, stepKeyMsg, stepKeyCreated, stepKeyCopied, stepKeyConfirm, createStepKey, copyStepCreatedKey, copyStepKey, deleteStepKey, loadStepKeys }) {
      const rows = []
      rows.push(React.createElement('div', { className: 'dsh-mb-key-create', key: 'create' },
        React.createElement('input', {
          className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
          placeholder: '请填写密钥名称（平台要求，不超过 20 字符）',
          value: stepKeyName,
          onChange: (e) => setStepKeyName(e.target.value),
        }),
        React.createElement('button', {
          className: 'dsh-mb-btn',
          disabled: stepKeyBusy || stepKeyName.trim() === '',
          onClick: createStepKey,
        }, stepKeyBusy ? '创建中…' : '创建密钥'),
      ))
      if (stepKeyCreated) {
        rows.push(React.createElement('div', { className: 'dsh-mb-created', key: 'created' },
          React.createElement('div', { className: 'dsh-mb-created-title' }, '「' + stepKeyCreated.name + '」已创建，完整密钥只显示这一次'),
          React.createElement('div', { className: 'dsh-mb-created-key' }, stepKeyCreated.key),
          React.createElement('div', { className: 'dsh-mb-btn-row' },
            React.createElement('button', { className: 'dsh-mb-btn', onClick: copyStepCreatedKey },
              stepKeyCopied === 'created' ? '已复制 ✓' : '复制密钥'),
            React.createElement('button', { className: 'dsh-mb-btn ghost', onClick: () => setStepKeyCreated(null) }, '我已保存'),
          ),
        ))
      }
      if (stepKeys === null || stepKeys.loading) {
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'ld', role: 'status', 'aria-label': '加载中' },
          [38, 62, 50].map((w, i) => React.createElement('div', { className: 'dsh-mb-skel', key: i, style: { width: w + '%' } })),
        ))
      } else if (stepKeys.error) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'err' }, '加载失败：' + stepKeys.error))
      } else if ((stepKeys.list || []).length === 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'empty' }, '还没有密钥，填个名称创建一个'))
      } else {
        rows.push(React.createElement('div', { className: 'dsh-mb-keys-list', key: 'ls' },
          (stepKeys.list || []).map((k) => React.createElement('div', { className: 'dsh-mb-key-card', key: k.keyId || k.masked },
            React.createElement('div', { className: 'dsh-mb-key-card-top' },
              React.createElement('span', { className: 'dsh-mb-key-card-name' }, k.name || '未命名'),
              k.isDefault ? React.createElement('span', { className: 'dsh-mb-badge on' }, '默认') : null,
            ),
            React.createElement('div', { className: 'dsh-mb-key-code-row' },
              React.createElement('span', { className: 'dsh-mb-key-card-code' }, k.masked || '—'),
              React.createElement('button', {
                className: 'dsh-mb-key-copy', title: '复制完整密钥',
                onClick: () => copyStepKey(k),
              }, stepKeyCopied === k.keyId ? '已复制 ✓' : '复制完整值'),
            ),
            React.createElement('div', { className: 'dsh-mb-key-card-meta' },
              k.createdAt ? '创建于 ' + (fmtDay(k.createdAt) || '—') : '创建时间未知',
              k.lastUsedAt ? ' · 最近调用 ' + (fmtDay(k.lastUsedAt) || '—') : ' · 从未调用'),
            React.createElement('button', {
              className: 'dsh-mb-key-copy danger' + (stepKeyConfirm === k.keyId ? ' armed' : ''),
              disabled: stepKeyBusy,
              title: stepKeyConfirm === k.keyId ? '再点一次确认删除' : '删除该密钥',
              onClick: () => deleteStepKey(k),
            }, stepKeyConfirm === k.keyId ? '确认删除' : '删除'),
          )),
        ))
      }
      if (stepKeyMsg) {
        rows.push(React.createElement('div', { className: 'dsh-mb-cookie-msg' + (stepKeyMsg.ok ? '' : ' err') }, stepKeyMsg.text))
      }
      rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
        '与平台安全策略一致：历史密钥只显示掩码，完整值仅在创建时展示一次；复制走本机 host 单取，不经过任何服务器。',
        React.createElement('button', { className: 'dsh-mb-link', style: { marginLeft: 4 }, onClick: () => { try { window.open('https://platform.stepfun.com/interface-key', '_blank') } catch { /* 拦截无碍 */ } } }, '官网管理 ↗')),
      )
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 设置页签（右上角齿轮进入）：账号卡片 + 会话状态 + 折叠的备用粘贴 ----
    function renderSettingsTab({ manifest, sessionConfigured, sessionAccount, cookieInput, setCookieInput, cookieBusy, cookieMsg, saveCookie, accounts, addAcc, setAddAcc, addPw, setAddPw, showAddPw, setShowAddPw, accBusy, accMsg, addAccount, removeAccount, loginStored, showAccPw, setShowAccPw, showBackup, setShowBackup, updInfo, updBusy, loadUpdate, copyUpdateCmd, updCopied, ignoreUpdate, entryMode, setEntryBalance, zcEnabled, setZcodeEnabled, settingsTab, setSettingsTab, stepCfg, stepAcc, setStepAcc, stepAccPw, setStepAccPw, showStepPw, setShowStepPw, stepAccBusy, stepAccMsg, addStepAccount, removeStepAccount, useStepAccount, setStepEntryPref, stepKeys, stepKeyName, setStepKeyName, stepKeyBusy, stepKeyMsg, stepKeyCreated, stepKeyCopied, stepKeyConfirm, createStepKey, copyStepCreatedKey, copyStepKey, deleteStepKey }) {
      const sessionValid = !!(manifest.session && manifest.session.valid)
      const pill = !sessionConfigured
        ? React.createElement('span', { className: 'dsh-mb-status-pill warn' },
            React.createElement('span', { className: 'dsh-mb-status-dot' }),
            '未登录')
        : (sessionValid
          ? React.createElement('span', { className: 'dsh-mb-status-pill ok' },
              React.createElement('span', { className: 'dsh-mb-status-dot' }),
              '已登录' + ((manifest.session && manifest.session.hint) ? ' · ' + manifest.session.hint : ''))
          : React.createElement('span', { className: 'dsh-mb-status-pill warn' },
              React.createElement('span', { className: 'dsh-mb-status-dot' }),
              '会话已过期 · 自动重登未成功，请重新登录'))
      // 分组页签：设置卡按「账号 / 胶囊 / ZCode / 关于」归类，避免一长条。
      const settingsTabs = [['tr', '基元'], ['step', '阶跃'], ['zcode', 'ZCode'], ['about', '关于']]
      return React.createElement('div', { className: 'dsh-mb-section' },
        React.createElement('div', { className: 'dsh-mb-seg-line', style: { flexWrap: 'wrap' } },
          settingsTabs.map(([id, label]) => React.createElement('button', {
            key: id,
            className: 'dsh-mb-cat' + (settingsTab === id ? ' active' : ''),
            onClick: () => setSettingsTab(id),
          }, label))),
        ...(settingsTab === 'tr' ? [
        // 账号卡片
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'account' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '账号管理'),
          React.createElement('div', { className: 'dsh-mb-set-desc' },
            '添加基元律动账号，登录后即可查看余额、用量和密钥。密码保存在本机，随时可以查看；支持多个账号随时切换。'),
          React.createElement('div', { className: 'dsh-mb-acc-form' },
            React.createElement('input', {
              className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
              placeholder: '账号（手机号）',
              value: addAcc,
              onChange: (e) => setAddAcc(e.target.value),
            }),
            React.createElement('div', { className: 'dsh-mb-pw-wrap' },
              React.createElement('input', {
                className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
                type: showAddPw ? 'text' : 'password',
                placeholder: '密码',
                value: addPw,
                onChange: (e) => setAddPw(e.target.value),
              }),
              React.createElement('button', {
                className: 'dsh-mb-pw-eye', title: showAddPw ? '隐藏密码' : '显示密码',
                onClick: () => setShowAddPw(!showAddPw),
              }, EyeIcon({ off: showAddPw })),
            ),
            React.createElement('button', {
              className: 'dsh-mb-btn', disabled: accBusy || addAcc.trim() === '' || addPw === '',
              onClick: addAccount,
            }, accBusy ? '处理中…' : '添加并登录'),
          ),
          accMsg ? React.createElement('div', { className: 'dsh-mb-cookie-msg' + (accMsg.ok ? '' : ' err') }, accMsg.text) : null,
          accounts !== null && accounts.length > 0
            ? React.createElement('div', { className: 'dsh-mb-acc-list' },
              accounts.map((a) => {
                const cur = sessionAccount !== null && sessionAccount !== undefined
                  ? String(sessionAccount).toLowerCase() === a.account.toLowerCase()
                  : false
                return React.createElement('div', { className: 'dsh-mb-acc-row' + (cur ? ' cur' : ''), key: a.account },
                  React.createElement('span', { className: 'dsh-mb-acc-avatar' }, a.account.slice(0, 1).toUpperCase()),
                  React.createElement('div', { className: 'dsh-mb-acc-info' },
                    React.createElement('div', { className: 'dsh-mb-acc-name' },
                      a.account,
                      cur ? React.createElement('span', { className: 'dsh-mb-acc-cur' }, '当前') : null),
                    React.createElement('div', { className: 'dsh-mb-acc-pw' },
                      showAccPw === a.account ? a.password : '••••••••'),
                  ),
                  React.createElement('button', {
                    className: 'dsh-mb-key-copy icon', title: showAccPw === a.account ? '隐藏密码' : '显示密码',
                    onClick: () => setShowAccPw(showAccPw === a.account ? null : a.account),
                  }, EyeIcon({ off: showAccPw === a.account })),
                  React.createElement('button', {
                    className: 'dsh-mb-key-copy' + (cur ? ' primary' : ''), disabled: accBusy || cur,
                    title: cur ? '已是当前登录账号' : '切换到此账号登录',
                    onClick: () => loginStored(a.account),
                  }, cur ? '登录中' : '登录'),
                  React.createElement('button', {
                    className: 'dsh-mb-key-copy danger', disabled: accBusy,
                    onClick: () => removeAccount(a.account),
                  }, '删除'),
                )
              }))
            : null,
        ),
        // 会话状态卡片
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'session' },
          React.createElement('div', { className: 'dsh-mb-status-row' },
            React.createElement('span', { className: 'dsh-mb-kv-k' }, '当前会话'),
            pill,
          ),
        ),
        ] : []),
        ...(settingsTab === 'step' ? [
        // ---- 阶跃账号（Step Plan）：密码直登单轨（JSON 通道实测稳定，凭据只存本机）。
        // manifest.step 就位才渲染（未配置时设置页与旧版一致）。----
        stepCfg ? React.createElement('div', { className: 'dsh-mb-set-card', key: 'step' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '阶跃账号（Step Plan）'),
          React.createElement('div', { className: 'dsh-mb-set-desc' },
            '手机号/邮箱 + 密码直登，会话由插件自动续期。密码只存本机（0600 文件），不上传任何服务器。'),
          Array.isArray(stepCfg.accounts) && stepCfg.accounts.length > 0
            ? React.createElement('div', { className: 'dsh-mb-acc-list' },
              stepCfg.accounts.map((a) => {
                const cur = !!stepCfg.account && String(stepCfg.account).toLowerCase() === String(a.username).toLowerCase()
                return React.createElement('div', { key: a.username, className: 'dsh-mb-acc-row' + (cur ? ' cur' : '') },
                  React.createElement('span', { className: 'dsh-mb-acc-avatar' }, '阶'),
                  React.createElement('div', { className: 'dsh-mb-acc-info' },
                    React.createElement('div', { className: 'dsh-mb-acc-name' }, a.username,
                      cur ? React.createElement('span', { className: 'dsh-mb-acc-cur' }, '当前') : null),
                    React.createElement('div', { className: 'dsh-mb-acc-pw' }, cur ? '控制台会话自动续期' : '密码存于本机')),
                  React.createElement('button', {
                    className: 'dsh-mb-key-copy' + (cur ? ' primary' : ''), disabled: stepAccBusy || cur,
                    title: cur ? '已是当前账号' : '切换到此账号登录',
                    onClick: () => useStepAccount(a.username),
                  }, cur ? '当前' : '使用'),
                  React.createElement('button', {
                    className: 'dsh-mb-key-copy danger', disabled: stepAccBusy,
                    onClick: () => removeStepAccount(a.username),
                  }, '删除'),
                )
              }))
            : null,
          React.createElement('div', { className: 'dsh-mb-acc-form' },
            React.createElement('input', {
              className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
              placeholder: '手机号 / 邮箱', value: stepAcc,
              onChange: (e) => setStepAcc(e.target.value),
            }),
            React.createElement('div', { className: 'dsh-mb-pw-wrap' },
              React.createElement('input', {
                className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
                type: showStepPw ? 'text' : 'password', placeholder: '密码', value: stepAccPw,
                onChange: (e) => setStepAccPw(e.target.value),
              }),
              React.createElement('button', {
                className: 'dsh-mb-pw-eye', title: showStepPw ? '隐藏密码' : '显示密码',
                onClick: () => setShowStepPw(!showStepPw),
              }, EyeIcon({ off: showStepPw })),
            ),
            React.createElement('button', {
              className: 'dsh-mb-btn', disabled: stepAccBusy || stepAcc.trim() === '' || stepAccPw === '',
              onClick: addStepAccount,
            }, stepAccBusy ? '处理中…' : '登录'),
          ),
          stepAccMsg ? React.createElement('div', { className: 'dsh-mb-cookie-msg' + (stepAccMsg.ok ? '' : ' err') }, stepAccMsg.text) : null,
        ) : null,
        ] : []),
        ...(settingsTab === 'tr' ? [
        // 备用粘贴（默认折叠）
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'backup' },
          React.createElement('button', {
            className: 'dsh-mb-toggle',
            onClick: () => setShowBackup(!showBackup),
          }, (showBackup ? '▾ ' : '▸ ') + '备用：手动粘贴登录凭证'),
          showBackup
            ? React.createElement('div', { className: 'dsh-mb-section', style: { gap: 6 } },
                React.createElement('div', { className: 'dsh-mb-set-desc' },
                  '在浏览器登录 ',
                  React.createElement('span', { className: 'dsh-mb-code' }, 'tokenrhythm.studio'),
                  ' 后，按 F12 打开开发者工具 → 应用 → Cookie，复制 ',
                  React.createElement('span', { className: 'dsh-mb-code' }, 'tr_session'),
                  ' 的值粘贴到下面（整段粘贴也认）。凭证只保存在这台电脑上。'),
                React.createElement('textarea', {
                  className: 'dsh-mb-input',
                  placeholder: '粘贴 tr_session 的值，留空提交 = 清除当前会话',
                  value: cookieInput,
                  onChange: (e) => setCookieInput(e.target.value),
                  rows: 3,
                }),
                React.createElement('div', { className: 'dsh-mb-btn-row' },
                  React.createElement('button', {
                    className: 'dsh-mb-btn', disabled: cookieBusy,
                    onClick: () => saveCookie(cookieInput),
                  }, cookieBusy ? '保存中…' : '保存'),
                  React.createElement('button', {
                    className: 'dsh-mb-btn ghost', disabled: cookieBusy || !sessionConfigured,
                    onClick: () => saveCookie(''),
                  }, '清除'),
                ),
                cookieMsg ? React.createElement('div', { className: 'dsh-mb-cookie-msg' + (cookieMsg.ok ? '' : ' err') }, cookieMsg.text) : null,
              )
            : null,
        ),
        // 入口胶囊余额：切换侧栏入口右侧胶囊显示「总余额」还是「限时总余额」，
        // 本地立即生效并持久化到 prefs（轮询会同步给未开过面板的入口按钮）。
        ] : []),
        ...(settingsTab === 'tr' ? [
        // 布局与「插件更新」卡一致：标题行 + 内容行（说明靠左，按钮组贴右）。
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'pillbase' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '入口胶囊余额'),
          React.createElement('div', { className: 'dsh-mb-seg-line' },
            React.createElement('span', { className: 'dsh-mb-seg-desc' }, '侧栏入口右侧胶囊显示的金额'),
            React.createElement('span', { className: 'dsh-mb-seg-row' },
              React.createElement('button', {
                className: 'dsh-mb-cat' + (entryMode === 'total' ? ' active' : ''),
                onClick: () => setEntryBalance('total'),
              }, '总余额'),
              React.createElement('button', {
                className: 'dsh-mb-cat' + (entryMode === 'expiring' ? ' active' : ''),
                onClick: () => setEntryBalance('expiring'),
              }, '限时总余额'),
            ),
          ),
        ),
        ] : []),
        ...(settingsTab === 'step' ? [
        // 胶囊接管（阶跃）：面板切到阶跃时，胶囊改显阶跃数据（用户定稿）。
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'pillstep' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '胶囊接管（阶跃）'),
          // 阶跃接管行（配好阶跃才出现）：面板切到阶跃时，胶囊改显阶跃数据（用户定稿）
          stepCfg && stepCfg.configured
            ? React.createElement('div', { className: 'dsh-mb-seg-line', key: 'sptake' },
              React.createElement('span', { className: 'dsh-mb-seg-desc' }, '面板切到「阶跃」时接管胶囊'),
              React.createElement('span', { className: 'dsh-mb-seg-row' },
                React.createElement('button', {
                  className: 'dsh-mb-cat' + (stepCfg.prefs && stepCfg.prefs.takeover !== false ? ' active' : ''),
                  onClick: () => setStepEntryPref({ takeover: true }),
                }, '接管'),
                React.createElement('button', {
                  className: 'dsh-mb-cat' + (stepCfg.prefs && stepCfg.prefs.takeover === false ? ' active' : ''),
                  onClick: () => setStepEntryPref({ takeover: false }),
                }, '不接管'),
              ))
            : null,
          stepCfg && stepCfg.configured && !(stepCfg.prefs && stepCfg.prefs.takeover === false)
            ? React.createElement('div', { className: 'dsh-mb-seg-line', key: 'spmode' },
              React.createElement('span', { className: 'dsh-mb-seg-desc' }, '阶跃接管时胶囊显示'),
              React.createElement('span', { className: 'dsh-mb-seg-row' },
                [['auto', '自动'], ['credits', 'Credit 剩余'], ['balance', 'API 余额']].map(([m, label]) =>
                  React.createElement('button', {
                    key: m,
                    className: 'dsh-mb-cat' + (((stepCfg.prefs && stepCfg.prefs.mode) || 'auto') === m ? ' active' : ''),
                    onClick: () => setStepEntryPref({ mode: m }),
                  }, label)),
              ))
            : null,
          !(stepCfg && stepCfg.configured)
            ? React.createElement('div', { className: 'dsh-mb-hint' }, '配置阶跃账号后，可在这里设置面板切到阶跃时是否接管侧栏胶囊')
            : null,
        ),
        ] : []),
        ...(settingsTab === 'zcode' ? [
        // ---- ZCode 集成卡：默认关闭。开启后面板标题切换器出现 ZCode 段，
        // 插件后台才允许读取 ~/.zcode/v2 凭证并直连官方接口。----
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'zcode' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, 'ZCode 集成'),
          React.createElement('div', { className: 'dsh-mb-seg-line' },
            React.createElement('span', { className: 'dsh-mb-seg-desc' },
              '读取本机 ~/.zcode/v2 登录凭证，展示 ZCode 套餐额度并可领取活动（默认关闭）'),
            React.createElement('span', { className: 'dsh-mb-seg-row' },
              React.createElement('button', {
                className: 'dsh-mb-cat' + (zcEnabled ? ' active' : ''),
                onClick: () => setZcodeEnabled(true),
              }, '开启'),
              React.createElement('button', {
                className: 'dsh-mb-cat' + (!zcEnabled ? ' active' : ''),
                onClick: () => setZcodeEnabled(false),
              }, '关闭'),
            ),
          ),
          zcEnabled ? React.createElement('div', { className: 'dsh-mb-hint' },
            '已开启：切换器出现「ZCode」段。凭证只在插件后台内存使用，浏览器不见明文；关闭即停读') : null,
        ),
        ] : []),
        ...(settingsTab === 'about' ? [
        // 插件更新卡片（npm dist-tags 比对）。只提醒不自动执行：宿主进程占用
        // node_modules 时自动重装有 EPERM 风险，复制命令由用户手动跑最稳。
        // 单行布局：版本 + 模式徽标 + 状态靠左，操作按钮靠右（用户定稿一行放不下
        // 不截断——状态过长时省略号，按钮组在极窄面板才整体换行）。
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'about' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '插件更新'),
          React.createElement('div', { className: 'dsh-mb-upd-line' },
            React.createElement('span', { className: 'dsh-mb-upd-cur' },
              'v' + ((updInfo && updInfo.current) || (manifest && manifest.version) || '…')),
            updInfo && updInfo.installMode === 'local'
              ? React.createElement('span', { className: 'dsh-mb-upd-mode' }, '本地开发模式')
              : null,
            React.createElement('span', { className: 'dsh-mb-upd-state' + (updInfo && updInfo.updateAvailable ? ' new' : '') },
              updInfo === null ? (updBusy ? '正在检查更新…' : '—')
                : updInfo.latest === null || updInfo.latest === undefined ? (updInfo.error || '暂无版本信息')
                : updInfo.updateAvailable ? '有新版本 v' + updInfo.latest + (updInfo.checkedAt ? '（' + fmtCheckedAt(updInfo.checkedAt) + ' 检测）' : '')
                : (updInfo.ignoredVersion && updInfo.ignoredVersion === updInfo.latest) ? '已忽略 v' + updInfo.latest + ' 的更新提示'
                : '已是最新版本' + (updInfo.checkedAt ? '（' + fmtCheckedAt(updInfo.checkedAt) + ' 检测）' : '')),
            React.createElement('span', { className: 'dsh-mb-upd-actions' },
              React.createElement('button', {
                className: 'dsh-mb-btn small', disabled: updBusy,
                onClick: () => loadUpdate(true),
              }, updBusy ? '检查中…' : '检查更新'),
              updInfo && updInfo.updateAvailable
                ? React.createElement('button', {
                  className: 'dsh-mb-btn small ghost', onClick: copyUpdateCmd, title: '复制 dsh plugin add dsh-tokenrhythm-bill',
                }, updCopied ? '已复制 ✓' : '复制更新命令')
                : null,
              updInfo && updInfo.updateAvailable
                ? React.createElement('button', {
                  className: 'dsh-mb-btn small ghost', onClick: ignoreUpdate, title: '不再提示此版本',
                }, '忽略此版本')
                : null,
            ),
          ),
        ),
        ] : []),
      )
    }

    const inject = ['slots'];
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (slots === undefined) return;

      ctx.effect(() => {
        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-plugin', 'dsh-tokenrhythm-bill');
        styleEl.textContent = PANEL_CSS;
        document.head.appendChild(styleEl);
        return () => { if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); };
      });

      // 预警轮询：每 5 分钟查一次余额（面板关着也查），临期/低余额点亮入口琥珀点；
      // 同时刷新入口常驻总余额（balanceCny）。会话未配置/失效时清空两者。
      ctx.effect(() => {
        let timer = null
        let stopped = false
        const check = async () => {
          if (stopped) return
          const m = await jsonGet(API + '/manifest')
          if (!m || !m.ok || !m.session || !m.session.configured) {
            setStore({ alert: null, balanceCny: null, expiringItems: [] })
            return
          }
          // 入口胶囊显示模式等轻量偏好：随轮询同步（面板从未打开也能生效）。
          const p = await jsonGet(API + '/prefs')
          if (p && p.ok && p.prefs && (p.prefs.entryBalance === 'total' || p.prefs.entryBalance === 'expiring')) {
            setStore({ entryBalMode: p.prefs.entryBalance })
          }
          const b = await jsonGet(API + '/balance')
          if (b && b.ok) {
            setStore({
              alert: alertOf(b),
              balanceCny: b.balanceCny !== null && b.balanceCny !== undefined ? b.balanceCny : null,
              expiringItems: Array.isArray(b.expiringItems) ? b.expiringItems : [],
            })
          }
        }
        const start = () => {
          check()
          timer = setInterval(check, 5 * 60 * 1000)
        }
        start()
        return () => { stopped = true; if (timer !== null) clearInterval(timer) }
      }, 'tokenrhythm-bill: alert poll');

      // 侧栏底部动作（footerActions 在 settingsArea 之前渲染 → 天然在设置按钮上方）。
      ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register(
        { name: 'sidebar.footer.action', id: 'tokenrhythm-bill-entry', order: 10 },
        (props) => React.createElement(EntryButton, props),
      )), 'tokenrhythm-bill: sidebar entry');

      ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
        { name: 'shell.overlay', id: 'tokenrhythm-bill-panel', order: 30 },
        () => React.createElement(Panel),
      )), 'tokenrhythm-bill: overlay panel');
    }

    exports.apply = apply;
    exports.inject = inject;

    // ---- CSS：全量挂 DSH 设计令牌（--dsw-alias-* / --ds-*，由 dsh-client-ui-theme 定义在
    // body 上），明暗主题经 body[data-ds-dark-theme] 自动跟随；不再有本地配色主题。
    // --mb-* 只是短别名桥接层，var() 第二参为令牌缺失时的保守回退。 ----
    const PANEL_CSS = `
      /* .dsh-mb-hov 是入口按钮的兄弟节点（fixed 悬浮卡），必须自己挂变量桥接层，
       * 否则 var(--mb-panelBg) 等解析为空 → 背景透明。 */
      .dsh-mb-panel,.dsh-mb-entry,.dsh-mb-hov{
        --mb-font:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Helvetica,Arial,sans-serif);
        --mb-codeFont:var(--ds-font-family-code,"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,Courier,"PingFang SC","Microsoft YaHei",monospace);
        --mb-panelBg:var(--dsw-alias-bg-layer-2,#fff);
        --mb-line:var(--dsw-alias-border-l2,rgba(0,0,0,.102));
        --mb-lineSoft:var(--dsw-alias-border-l1,rgba(0,0,0,.039));
        --mb-soft:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.059));
        --mb-card:var(--dsw-alias-bg-layer-1,#fff);
        --mb-txt:var(--dsw-alias-label-primary,#0f1115);
        --mb-sub:var(--dsw-alias-label-secondary,#81858c);
        --mb-tert:var(--dsw-alias-label-tertiary,#979da6);
        --mb-dim:var(--dsw-alias-label-dimmed,#dcdcdc);
        --mb-acc:var(--dsw-alias-state-business-primary,#4176e6);
        --mb-btnFill:var(--dsw-alias-button-primary-fill,#0f1115);
        --mb-btnHover:var(--dsw-alias-button-primary-hover,#3c3c3d);
        --mb-btnTx:var(--dsw-alias-label-primary-foreground,#fff);
        --mb-elev:var(--dsw-alias-button-elevated-fill,#fff);
        --mb-float:var(--dsw-alias-button-floating-hover,#e5f0ff);
        --mb-ghostFill:var(--dsw-alias-button-ghost-active-fill,#e9ecf2);
        --mb-ghostLine:var(--dsw-alias-button-ghost-active-border,#979da6);
        --mb-ok:var(--dsw-alias-state-success-primary,#22c55e);
        --mb-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
        --mb-warnTx:var(--dsw-alias-state-warn-label,#dd8629);
        --mb-err:var(--dsw-alias-state-error-primary,#ec1313);
        --mb-inputBg:var(--dsw-alias-bg-layer-1,#fff);
        --mb-inputLine:var(--dsw-alias-border-l2,rgba(0,0,0,.102));
        --mb-focus:var(--dsw-alias-brand-primary,#0f1115);
        --mb-codeBg:var(--dsw-alias-markdown-inline-code,#ebeef2);
        --mb-codeBlock:var(--dsw-alias-markdown-code-block,#f9fafb);
        --mb-ease:var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1));
        --mb-fast:var(--ds-transition-duration-fast,.1s);
        --mb-dur:var(--ds-transition-duration,.2s);
      }

      /* 侧栏入口：完整镜像原生「设置」触发行（SettingsRoot .trigger）的行几何：
       * calc(100%+4px) 行宽 + margin 左右 -2px 出血 + padding 0 10px 0 8px（图标起点
       * 12-2+8=18px 与设置行逐像素一致）。槽位包装层是 display:contents 不裁剪出血；
       * 外层 footerActions 是 flex 容器，必须 flex:none 防止 +4px 被 flex-shrink 收回
       * （设置行所在的 settingsArea 是普通 block，无此问题）。 */
      .dsh-mb-entry{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:8px;
        flex:none;width:calc(100% + 4px);min-width:0;height:42px;margin:4px -2px 0;padding:0 10px 0 8px;
        cursor:pointer;border:none;border-radius:12px;text-align:left;
        background:transparent;color:var(--mb-txt);font-family:var(--mb-font);font-size:14px;font-weight:400;line-height:22px;
        transition:background-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-entry:hover{background:var(--mb-soft)}
      .dsh-mb-entry.active{background:var(--mb-soft)}
      .dsh-mb-entry-icon{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}
      .dsh-mb-entry-icon svg{display:block}
      .dsh-mb-dot{position:absolute;top:-2px;right:-3px;width:7px;height:7px;border-radius:50%;background:var(--mb-warn);
        box-shadow:0 0 0 2px color-mix(in srgb, var(--mb-warn) 30%, transparent)}
      .dsh-mb-entry-left{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}
      .dsh-mb-entry-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsh-mb-entry-label.wide-in{animation:dsh-mb-wide-in var(--mb-dur) var(--mb-ease) backwards}
      .dsh-mb-entry-bal{margin-left:auto;flex:none;padding:3px 9px;border-radius:999px;font-variant-numeric:tabular-nums;
        color:var(--mb-acc);font-size:12px;font-weight:600;letter-spacing:.2px;white-space:nowrap;
        background:color-mix(in srgb,var(--mb-acc) 10%,transparent)}
      .dsh-mb-entry-bal.alert{color:var(--mb-warnTx);background:color-mix(in srgb,var(--mb-warn) 12%,transparent)}
      /* 入口悬浮卡：限时余额逐笔（金额 + N 天后失效）。fixed 定位贴视口、由 JS 按
       * 入口 rect 计算位置（宽态行上方右对齐 / rail 态同式，钳制在视口内）；
       * 进卡片不断链，移开 150ms 收起；整卡可点击打开面板。 */
      .dsh-mb-hov{position:fixed;z-index:10001;box-sizing:border-box;padding:10px 12px;
        background:var(--mb-panelBg);color:var(--mb-txt);font-family:var(--mb-font);
        border:1px solid var(--dsw-alias-border-inverted,rgba(0,0,0,.06));border-radius:12px;
        box-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,.16));
        font-size:12px;line-height:1.5;cursor:pointer;user-select:none;
        animation:dsh-mb-hov-in var(--mb-fast) var(--mb-ease)}
      @keyframes dsh-mb-hov-in{0%{opacity:0}}
      .dsh-mb-hov-head{font-weight:600;color:var(--mb-sub);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsh-mb-hov-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:3px 0;font-variant-numeric:tabular-nums}
      .dsh-mb-hov-amt{font-weight:600;font-size:13px}
      .dsh-mb-hov-days{color:var(--mb-sub);white-space:nowrap}
      .dsh-mb-hov-item.soon .dsh-mb-hov-amt{color:var(--mb-warnTx)}
      .dsh-mb-hov-item.soon .dsh-mb-hov-days{color:var(--mb-warnTx);font-weight:600}
      @keyframes dsh-mb-wide-in{0%{opacity:0}}
      /* rail（收起）形态：对齐设置触发行 rail（36×36 圆形、居中、图标 18px）。 */
      .dsh-mb-entry[data-wide="0"]{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;min-width:0;padding:0;margin:8px auto 0}
      .dsh-mb-entry[data-wide="0"] .dsh-mb-entry-icon{width:18px;height:18px;font-size:18px}
      .dsh-mb-entry[data-wide="0"]:hover{background:var(--mb-soft)}
      /* 收起态绝不显示余额（JSX 已不渲染，这里兜底防溢出圆外）。 */
      .dsh-mb-entry[data-wide="0"] .dsh-mb-entry-bal{display:none}
      .dsh-mb-entry:not([data-wide]){container-type:inline-size}
      @container (max-width:60px){
        .dsh-mb-entry:not([data-wide]){border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0;margin:8px auto 0}
        .dsh-mb-entry:not([data-wide]) .dsh-mb-entry-icon{width:18px;height:18px;font-size:18px}
        .dsh-mb-entry:not([data-wide]) .dsh-mb-entry-bal{display:none}
        .dsh-mb-entry:not([data-wide]):hover{background:var(--mb-soft)}
      }
      /* 宿主给 footer.action 槽位设了 scrollbar-gutter:stable，会在右侧常驻滚动条槽
       * （宽态行宽变窄、收起态 36px 圆被压扁）——去掉预留，仅此一项，不碰 overflow。 */
      body:is([data-dsh-desktop-mode="extended"],[data-dsh-desktop-mode="advanced"],[data-dsh-desktop-mode="compatibility"])
        [data-slot="sidebar.footer.action"]{scrollbar-gutter:auto}

      /* 浮层：实色 layer-2 + inverted 描边 + 桌面设置弹窗同款投影（DSH 无磨砂卡面）。 */
      .dsh-mb-panel{position:fixed;z-index:10000;display:flex;flex-direction:column;
        max-height:min(80vh,760px);box-sizing:border-box;
        background:var(--mb-panelBg);color:var(--mb-txt);font-family:var(--mb-font);
        border:1px solid var(--dsw-alias-border-inverted,rgba(0,0,0,.06));border-radius:16px;
        box-shadow:0 24px 64px color-mix(in srgb, #000 38%, transparent);
        overflow:hidden;font-size:13px;line-height:1.5}
      .dsh-mb-head{flex:none;display:flex;align-items:center;justify-content:space-between;height:44px;padding:0 8px 0 14px;
        border-bottom:1px solid var(--mb-lineSoft);cursor:grab;user-select:none;touch-action:none}
      .dsh-mb-head:active{cursor:grabbing}
      .dsh-mb-head-title{font-weight:500;font-size:14px;letter-spacing:.2px;color:var(--mb-txt)}
      .dsh-mb-head-actions{display:flex;align-items:center;gap:2px}
      /* 头部左侧组：原标题（任何模式保留）+ 提供商切换器（配好阶跃才出现，紧贴标题） */
      .dsh-mb-head-left{display:flex;align-items:center;gap:10px;min-width:0}
      /* 标题位提供商切换器（基元律动｜阶跃）：轨道段样式与页签条同语言，配好阶跃才顶替标题出现 */
      .dsh-mb-prov{display:flex;gap:3px;padding:3px;border-radius:10px;background:var(--mb-soft)}
      .dsh-mb-prov-btn{border:none;background:transparent;cursor:pointer;padding:4px 12px;border-radius:8px;
        color:var(--mb-sub);font-size:12.5px;font-weight:500;font-family:inherit;
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-prov-btn:hover{color:var(--mb-txt);background:var(--dsw-alias-interactive-bg-hover-accent,rgba(38,49,72,.14))}
      .dsh-mb-prov-btn.active{color:var(--mb-txt);font-weight:600;background:var(--mb-panelBg);box-shadow:inset 0 0 0 1px var(--mb-line)}
      /* 阶跃「用量」：近 7 日 Credit 迷你柱条（横排版趋势柱，窄面板不出滚动条） */
      .dsh-mb-step-bar{display:flex;align-items:center;gap:8px;padding:2px 0}
      .dsh-mb-step-bar-d{flex:none;width:40px;font-size:11px;color:var(--mb-sub)}
      .dsh-mb-step-bar-track{flex:1;min-width:0;height:8px;border-radius:4px;background:var(--mb-soft);overflow:hidden}
      .dsh-mb-step-bar-fill{display:block;height:100%;background:var(--mb-warn);border-radius:4px}
      .dsh-mb-step-bar-v{flex:none;min-width:46px;text-align:right;font-size:11.5px;color:var(--mb-txt)}
      .dsh-mb-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
        border:none;border-radius:8px;background:transparent;cursor:pointer;color:var(--mb-sub);font-size:14px;
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-iconbtn:hover{background:var(--mb-soft);color:var(--mb-txt)}
      .dsh-mb-iconbtn.active{background:var(--mb-ghostFill);color:var(--mb-txt);box-shadow:inset 0 0 0 1px var(--mb-ghostLine)}
      /* 页签条：轨道用淡填充（DSH active 导航项的 ~6-8% 填充画法），激活页签用面板
       * 同色「凸起」+ border-l2 细描边，明暗两套主题都清晰。 */
      .dsh-mb-tabs{flex:none;display:flex;gap:4px;margin:10px 14px 0;padding:3px;border-radius:10px;
        background:var(--mb-soft)}
      .dsh-mb-tab{flex:1;border:none;background:transparent;cursor:pointer;padding:5px 0;border-radius:8px;
        color:var(--mb-sub);font-size:12.5px;font-weight:500;font-family:inherit;
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-tab:hover{color:var(--mb-txt);
        background:var(--dsw-alias-interactive-bg-hover-accent,rgba(38,49,72,.14))}
      .dsh-mb-tab.active{color:var(--mb-txt);font-weight:600;
        background:var(--mb-panelBg);box-shadow:inset 0 0 0 1px var(--mb-line)}
      .dsh-mb-body{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 14px}
      .dsh-mb-section{display:flex;flex-direction:column;gap:8px}

      .dsh-mb-notice{padding:14px 10px;text-align:center;color:var(--mb-sub)}
      .dsh-mb-notice.err{color:var(--mb-err)}
      /* 加载骨架屏：与真实内容同构的 shimmer 占位（soft 底 + 文字色 8% 微光扫过，
       * 尊重系统减动效设置）。 */
      .dsh-mb-skel{position:relative;overflow:hidden;flex:none;height:12px;border-radius:6px;background:var(--mb-soft)}
      .dsh-mb-skel::after{content:"";position:absolute;inset:0;transform:translateX(-100%);
        background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--mb-txt) 8%,transparent),transparent);
        animation:dsh-mb-shimmer 1.4s var(--mb-ease) infinite}
      @keyframes dsh-mb-shimmer{100%{transform:translateX(100%)}}
      .dsh-mb-skel-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
      .dsh-mb-skel-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;
        border:1px solid var(--mb-lineSoft);border-radius:12px}
      .dsh-mb-skel-hero{display:flex;flex-direction:column;gap:10px;padding:14px 16px;
        border:1px solid var(--mb-lineSoft);border-radius:12px;background:var(--mb-card)}
      .dsh-mb-skel-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
      .dsh-mb-skel-kv-i{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:10px;
        background:var(--mb-card);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-skel-rows{display:flex;flex-direction:column;gap:12px;padding:4px 2px}
      @media (prefers-reduced-motion:reduce){.dsh-mb-skel::after{animation:none}}
      .dsh-mb-banner{display:flex;align-items:center;gap:2px;padding:8px 10px;border-radius:10px;font-size:12px;
        background:color-mix(in srgb, var(--mb-warn) 10%, transparent);
        border:1px solid color-mix(in srgb, var(--mb-warn) 35%, transparent);color:var(--mb-warnTx)}
      .dsh-mb-link{border:none;background:transparent;cursor:pointer;padding:0 2px;font-size:12px;font-weight:600;font-family:inherit;
        color:var(--mb-acc);text-decoration:underline}

      /* 分类筛选 chips：Pill 规格（h24/r12/12px），激活态 ghost 填充 + 内描边。 */
      /* 分类筛选行滚动固定：sticky 钉在滚动容器顶部。top/margin-top 各 -10px 抵消
       * body 的 padding-top，钉住时靠 14px 上内边距盖住原间隙——滚动内容不再从
       * 头部与筛选行之间透出。负 margin 铺满左右内边距并垫面板实色底；缓存标签
       * margin-left:auto 靠行最右，放不下时横向滚动（隐藏滚动条）。 */
      .dsh-mb-cats{position:sticky;top:-10px;z-index:2;display:flex;flex-wrap:nowrap;align-items:center;gap:6px;
        margin:-10px -14px 0;padding:14px 14px 6px;background:var(--mb-panelBg);overflow-x:auto;scrollbar-width:none}
      .dsh-mb-cats::-webkit-scrollbar{display:none}
      .dsh-mb-cache-tag{flex:none;margin-left:auto;font-size:11px;line-height:24px;padding:0 8px;border-radius:12px;
        color:var(--mb-sub);background:var(--mb-soft)}
      .dsh-mb-cache-tag.stale{color:var(--mb-warnTx);background:color-mix(in srgb,var(--mb-warn) 12%,transparent)}
      .dsh-mb-cat{cursor:pointer;border:none;height:24px;display:inline-flex;align-items:center;border-radius:12px;
        padding:0 8px;font-size:12px;line-height:18px;font-family:inherit;background:transparent;color:var(--mb-sub);
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-cat:hover{background:var(--mb-soft);color:var(--mb-txt)}
      .dsh-mb-cat.active{background:var(--mb-ghostFill);
        color:var(--mb-txt);font-weight:600;box-shadow:inset 0 0 0 1px var(--mb-ghostLine)}
      .dsh-mb-cat-count{opacity:.7;font-size:11px;margin-left:1px;font-variant-numeric:tabular-nums}
      .dsh-mb-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
      /* 模型卡片：DSH 淡填充（interactive-bg-hover）+ 细描边 + shadow-lv1 抬升，
       * hover 加深到 accent 填充 + border-l2 + shadow-lv2，浅色下面板与卡片分离明显。 */
      .dsh-mb-card{padding:10px 12px;border:1px solid var(--mb-lineSoft);border-radius:12px;
        background:var(--mb-soft);cursor:pointer;box-shadow:var(--dsw-shadow-lv1,0 2px 4px rgba(0,0,0,.05));
        transition:border-color var(--mb-fast) var(--mb-ease),background-color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      /* 折扣徽章：标题行最左（内容区左上角），实底绿渐变 + 白字醒目；
       * 行内排布随行高走，卡片布局零影响。 */
      .dsh-mb-card-disc{flex:none;margin-right:6px;font-size:10px;font-weight:700;line-height:16px;
        letter-spacing:1px;padding:0 8px;border-radius:6px;color:#fff;
        background:linear-gradient(135deg,color-mix(in srgb,var(--mb-ok) 78%,#000),var(--mb-ok));
        box-shadow:0 1px 3px color-mix(in srgb,var(--mb-ok) 35%,transparent)}
      .dsh-mb-card:hover{border-color:var(--mb-line);
        background:var(--dsw-alias-interactive-bg-hover-accent,rgba(38,49,72,.14));
        box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.05))}
      .dsh-mb-card.copied{border-color:var(--mb-ok)}
      .dsh-mb-copied{font-size:10px;font-weight:600;color:var(--mb-ok)}
      .dsh-mb-hint{font-size:10.5px;color:var(--mb-sub);text-align:center;opacity:.85}
      .dsh-mb-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-card-name{flex:1 1 auto;min-width:0;font-weight:700;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt)}
      .dsh-mb-card-head-r{flex:none;display:inline-flex;align-items:center;gap:6px}
      /* 状态胶囊（官方 model-status-pill）：纯平台状态——在线=绿点 / 测试中=琥珀点，
       * 圆点颜色跟随胶囊色调（dotCls 由 pillCls 派生），无平台状态不渲染。 */
      .dsh-mb-card-status{flex:none;display:inline-flex;align-items:center;gap:4px;font-size:10px;line-height:16px;
        padding:0 7px;border-radius:8px;background:var(--mb-soft);color:var(--mb-sub)}
      .dsh-mb-card-status-dot{width:6px;height:6px;border-radius:50%;background:var(--mb-tert)}
      .dsh-mb-card-status-dot.ok{background:var(--mb-ok)}
      .dsh-mb-card-status-dot.deg{background:var(--mb-warn)}
      .dsh-mb-card-status-dot.fail{background:var(--mb-err)}
      .dsh-mb-card-status.on{color:var(--mb-ok);background:color-mix(in srgb,var(--mb-ok) 12%,transparent)}
      .dsh-mb-card-status.testing{color:var(--mb-warnTx);background:color-mix(in srgb,var(--mb-warn) 12%,transparent)}
      .dsh-mb-card-status.err{color:var(--mb-err);background:color-mix(in srgb,var(--mb-err) 12%,transparent)}
      /* ---- 自定义检测（状态页签置顶卡）：控制行 + 模型 chips + 结果行 ---- */
      .dsh-mb-ckcard{border:1px solid var(--mb-lineSoft);border-radius:12px;background:var(--mb-soft);
        padding:10px 12px;margin-bottom:10px}
      .dsh-mb-ck-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
      .dsh-mb-ck-title{font-weight:700;font-size:13px;color:var(--mb-txt)}
      .dsh-mb-ck-sub{font-size:10.5px;color:var(--mb-tert)}
      .dsh-mb-ck-ctl{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
      .dsh-mb-ck-run{border:1px solid var(--mb-line);border-radius:8px;background:var(--mb-acc);color:#fff;
        font-family:inherit;font-size:11.5px;font-weight:600;line-height:1;padding:5px 10px;cursor:pointer;
        transition:opacity var(--mb-fast) var(--mb-ease)}
      .dsh-mb-ck-run:hover{opacity:.88}
      .dsh-mb-ck-run.disabled{opacity:.45;cursor:default}
      .dsh-mb-ck-int{border:1px solid var(--mb-line);border-radius:8px;background:var(--mb-soft);color:var(--mb-sub);
        font-family:inherit;font-size:11.5px;line-height:1;padding:4px 6px;cursor:pointer}
      .dsh-mb-ck-next{font-size:11px;color:var(--mb-sub);font-variant-numeric:tabular-nums}
      .dsh-mb-ck-count{margin-left:auto;font-size:11px;color:var(--mb-sub);font-variant-numeric:tabular-nums}
      .dsh-mb-ck-chips{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;margin-top:8px}
      .dsh-mb-ck-chip{border:1px solid var(--mb-lineSoft);border-radius:12px;background:transparent;color:var(--mb-sub);
        font-family:inherit;font-size:11.5px;line-height:1;padding:5px 8px;cursor:pointer;min-width:0;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;
        transition:background-color var(--mb-fast) var(--mb-ease),border-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-ck-chip.on{background:color-mix(in srgb,var(--mb-acc) 14%,transparent);border-color:var(--mb-acc);
        color:var(--mb-txt);font-weight:600}
      .dsh-mb-ck-empty{font-size:11px;color:var(--mb-tert);grid-column:1 / -1}
      /* 检测结果：独立小节（虚线与上方 chips 隔开），每行一条：点 + 模型名 + 右侧状态。 */
      .dsh-mb-ck-results{display:flex;flex-direction:column;gap:2px;margin-top:9px;padding-top:8px;
        border-top:1px dashed var(--mb-lineSoft)}
      .dsh-mb-ck-results-hd{font-size:10px;font-weight:600;letter-spacing:.5px;color:var(--mb-tert);margin-bottom:2px}
      .dsh-mb-ck-res{display:flex;align-items:center;gap:7px;min-width:0;padding:3px 6px;border-radius:7px;
        font-size:11.5px;color:var(--mb-sub);transition:background-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-ck-res:hover{background:color-mix(in srgb,var(--mb-soft) 70%,transparent)}
      .dsh-mb-ck-res-id{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt)}
      .dsh-mb-ck-res-ms{flex:none;font-variant-numeric:tabular-nums;color:var(--mb-tert)}
      .dsh-mb-ck-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--mb-tert)}
      .dsh-mb-ck-dot.none{opacity:.5}
      .dsh-mb-ck-dot.ok{background:var(--mb-ok)}
      .dsh-mb-ck-dot.deg{background:var(--mb-warn)}
      .dsh-mb-ck-dot.fail{background:var(--mb-err)}
      .dsh-mb-ck-err{margin-top:8px;font-size:11px;color:var(--mb-err)}
      .dsh-mb-card-sub{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:10.5px;color:var(--mb-sub);overflow:hidden;margin-top:1px}
      .dsh-mb-card-id{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-card-src{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* details：规格 + 价格两栏（官方 model-spec-list / model-price-list 布局）。 */
      .dsh-mb-card-details{display:flex;gap:6px 18px;flex-wrap:wrap;margin-top:8px}
      .dsh-mb-card-dl{flex:1 1 150px;min-width:145px;margin:0;display:flex;flex-direction:column;gap:3px}
      .dsh-mb-card-dl > div{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
      .dsh-mb-card-dl dt{flex:none;color:var(--mb-sub);font-size:11px}
      .dsh-mb-card-dl dd{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        font-weight:600;font-size:11.5px;text-align:right;color:var(--mb-txt);font-variant-numeric:tabular-nums}
      .dsh-mb-card-price-old{margin-right:4px;font-size:10.5px;font-weight:500;color:var(--mb-tert);text-decoration:line-through}
      .dsh-mb-badge{font-size:10px;padding:1px 6px;border-radius:6px;background:var(--mb-soft);color:var(--mb-sub)}
      .dsh-mb-badge.disc{color:var(--mb-ok)}
      .dsh-mb-badge.on{color:var(--mb-ok)}
      .dsh-mb-badge.off{color:var(--mb-tert)}

      /* 余额 hero：品牌蓝 7% 淡底 + 25% 描边（color-mix 跟随主题），数字纯色不再渐变。 */
      /* 余额主卡：品牌蓝淡底定位「钱」卡，双列统计（账户余额为主）+ 倒计时胶囊 +
       * 限时占比条；颜色全走令牌桥，明暗自动跟随。 */
      .dsh-mb-acct-line{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--mb-sub);padding:2px 2px 0}
      .dsh-mb-acct-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--mb-ok)}
      .dsh-mb-acct-line.none .dsh-mb-acct-dot{background:var(--mb-warn)}
      .dsh-mb-hero{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:12px;
        border:1px solid color-mix(in srgb, var(--mb-acc) 25%, transparent);
        background:color-mix(in srgb, var(--mb-acc) 7%, transparent)}
      .dsh-mb-hero-stats{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
      .dsh-mb-stat{display:flex;flex-direction:column;gap:2px;min-width:0}
      .dsh-mb-stat.right{align-items:flex-end;text-align:right}
      .dsh-mb-stat-k{font-size:12px;color:var(--mb-sub)}
      .dsh-mb-stat-v{font-size:28px;font-weight:600;line-height:1.15;white-space:nowrap;
        font-variant-numeric:tabular-nums;color:var(--mb-txt)}
      .dsh-mb-stat.right .dsh-mb-stat-v{font-size:20px}
      .dsh-mb-hero-chip{display:inline-flex;align-items:center;margin-top:2px;padding:1px 8px;border-radius:999px;
        font-size:11px;font-weight:600;line-height:16px;
        color:var(--mb-sub);background:var(--mb-soft)}
      .dsh-mb-hero-chip.soon{color:var(--mb-warnTx);
        background:color-mix(in srgb, var(--mb-warn) 12%, transparent)}
      .dsh-mb-hero-bar{display:flex;height:6px;border-radius:3px;overflow:hidden;
        background:color-mix(in srgb, var(--mb-sub) 18%, transparent)}
      .dsh-mb-hero-bar-fill{height:100%;min-width:2px;background:var(--mb-warn)}
      .dsh-mb-hero-legend{display:flex;align-items:center;justify-content:space-between;gap:8px;
        font-size:11px;color:var(--mb-sub);font-variant-numeric:tabular-nums}
      .dsh-mb-day-title{font-size:12px;font-weight:600;color:var(--mb-sub);margin-top:2px}
      .dsh-mb-kv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px}
      .dsh-mb-kv{display:flex;flex-direction:column;gap:1px;padding:8px 10px;border-radius:10px;
        background:var(--mb-soft);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-kv-k{font-size:11px;color:var(--mb-sub)}
      .dsh-mb-kv-v{font-size:13px;font-weight:600;color:var(--mb-txt);font-variant-numeric:tabular-nums}
      .dsh-mb-trend-wrap{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:10px;
        background:var(--mb-soft);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-trend{display:flex;align-items:flex-end;gap:5px;height:78px;padding:0 2px}
      .dsh-mb-trend-col{position:relative;flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;height:100%;justify-content:flex-end}
      .dsh-mb-trend-val{font-size:9.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--mb-txt)}
      .dsh-mb-trend-col.today .dsh-mb-trend-val{color:var(--mb-acc)}
      .dsh-mb-trend-bar{width:100%;max-width:28px;border-radius:4px 4px 2px 2px;
        background:color-mix(in srgb, var(--mb-sub) 45%, transparent)}
      .dsh-mb-trend-col.today .dsh-mb-trend-bar{background:var(--mb-acc)}
      .dsh-mb-trend-col:hover .dsh-mb-trend-bar{background:var(--mb-acc)}
      .dsh-mb-trend-date{font-size:9.5px;color:var(--mb-sub);white-space:nowrap}
      /* 悬停气泡：对齐原生 Tooltip.module.css（tooltip-bg 深底 + 白字、r8、150ms 淡入、
       * pointer-events:none）；首/末列用 edge 类防出面板。 */
      .dsh-mb-trend-tip{position:absolute;z-index:20;bottom:calc(100% + 14px);left:50%;transform:translateX(-50%);
        min-width:170px;max-width:250px;box-sizing:border-box;padding:8px 10px;border-radius:8px;text-align:left;
        background:var(--dsw-alias-tooltip-bg,#283142);color:var(--dsw-static-neutral-bluish-00,#fff);
        box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.05));pointer-events:none;
        display:flex;flex-direction:column;gap:3px;font-size:11px;line-height:17px;
        animation:dsh-mb-tip-in 150ms var(--mb-ease)}
      .dsh-mb-trend-tip.edge-l{left:0;transform:none}
      .dsh-mb-trend-tip.edge-r{left:auto;right:0;transform:none}
      .dsh-mb-trend-tip-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
        padding-bottom:3px;margin-bottom:1px;border-bottom:1px solid rgba(255,255,255,.08);
        color:var(--dsw-static-neutral-bluish-300,#cfd3d6);font-weight:600}
      .dsh-mb-trend-tip-row{display:flex;align-items:center;gap:8px}
      .dsh-mb-trend-tip-model{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-trend-tip-cost{flex:none;font-weight:600;font-variant-numeric:tabular-nums}
      .dsh-mb-trend-tip-calls{flex:none;color:var(--dsw-static-neutral-bluish-400,#adb2b8);font-variant-numeric:tabular-nums}
      @keyframes dsh-mb-tip-in{from{opacity:0}}
      .dsh-mb-toggle{align-self:flex-start;border:none;background:transparent;cursor:pointer;padding:2px 0;
        font-size:12px;font-weight:600;color:var(--mb-sub);font-family:inherit;
        transition:color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-toggle:hover{color:var(--mb-txt)}
      .dsh-mb-calls{display:flex;flex-direction:column;border:1px solid var(--mb-lineSoft);border-radius:10px;padding:2px 0;overflow:hidden}
      /* 调用行：去掉逐行灰底，改为发丝分隔 + 悬停浮起；错误行淡红可扫读。 */
      .dsh-mb-call{display:flex;align-items:center;gap:8px;font-size:11.5px;padding:5px 10px;
        transition:background var(--mb-fast) var(--mb-ease)}
      .dsh-mb-call + .dsh-mb-call{border-top:1px solid color-mix(in srgb,var(--mb-lineSoft) 60%,transparent)}
      .dsh-mb-call:hover{background:var(--mb-soft)}
      .dsh-mb-call.err{background:color-mix(in srgb,var(--mb-err) 5%,transparent)}
      .dsh-mb-call-dot{flex:none;width:6px;height:6px;border-radius:50%}
      .dsh-mb-call-dot.ok{background:var(--mb-ok);
        box-shadow:0 0 0 2.5px color-mix(in srgb,var(--mb-ok) 18%,transparent)}
      .dsh-mb-call-dot.err{background:var(--mb-err);
        box-shadow:0 0 0 2.5px color-mix(in srgb,var(--mb-err) 20%,transparent)}
      .dsh-mb-call-time{flex:none;width:34px;color:var(--mb-tert);font-variant-numeric:tabular-nums}
      .dsh-mb-call-model{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt);font-weight:500}
      .dsh-mb-call-lat{flex:none;color:var(--mb-tert);font-size:10.5px;font-variant-numeric:tabular-nums}
      .dsh-mb-call-cost{flex:none;min-width:44px;text-align:right;font-weight:600;color:var(--mb-txt);font-variant-numeric:tabular-nums}
      .dsh-mb-call-cost.zero{color:var(--mb-tert);font-weight:500}
      .dsh-mb-call-count{margin-left:6px;font-size:10px;font-weight:600;color:var(--mb-sub);
        border:1px solid var(--mb-lineSoft);border-radius:5px;padding:0 6px;line-height:15px}
      .dsh-mb-balance-foot{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--mb-sub)}
      .dsh-mb-refresh{cursor:pointer;border:1px solid var(--mb-line);border-radius:8px;font-family:inherit;
        background:transparent;color:var(--mb-txt);padding:3px 12px;font-size:12px;
        transition:background-color var(--mb-fast) var(--mb-ease),border-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-refresh:hover{background:var(--mb-soft);border-color:var(--mb-ghostLine)}

      .dsh-mb-set-title{font-weight:600;font-size:13px;color:var(--mb-txt)}
      .dsh-mb-set-desc{font-size:12px;color:var(--mb-sub)}
      /* 插件更新卡片：单行——版本 + 模式徽标 + 状态靠左，操作按钮靠右。
       * 状态过长省略号截断；actions 整组 flex:none，极窄面板时随 wrap 换行。 */
      .dsh-mb-upd-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .dsh-mb-upd-cur{font-family:var(--mb-codeFont);font-size:12px;font-weight:600;color:var(--mb-txt);flex:none}
      .dsh-mb-upd-mode{font-size:11px;color:var(--mb-sub);flex:none;
        border:1px solid var(--mb-lineSoft);border-radius:999px;padding:0 8px;line-height:18px}
      .dsh-mb-upd-state{font-size:12px;color:var(--mb-sub);flex:1 1 auto;min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-upd-state.new{color:var(--mb-acc);font-weight:600}
      .dsh-mb-upd-actions{margin-left:auto;display:flex;gap:8px;flex:none}
      .dsh-mb-btn.small{height:24px;padding:0 12px;font-size:12px;font-weight:500;border-radius:12px}
      /* 入口胶囊余额：骨架与「插件更新」卡一致——标题行 + 内容行（说明靠左、
       * 按钮组贴右）；复用 .dsh-mb-cat 的 chip/active 样式，极窄面板才换行。 */
      .dsh-mb-seg-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .dsh-mb-seg-desc{font-size:12px;color:var(--mb-sub);flex:1 1 auto;min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-seg-row{margin-left:auto;display:flex;gap:8px;flex:none}
      /* 设置卡背景是 --mb-soft，与 .active 的 ghost 填充几乎同色 → 选中态隐形。
       * seg 行内改用 accent 描边 + accent 文字，任何底色上都一眼可辨。 */
      .dsh-mb-seg-row .dsh-mb-cat.active{background:color-mix(in srgb,var(--mb-acc) 10%,transparent);
        color:var(--mb-acc);font-weight:600;box-shadow:inset 0 0 0 1px var(--mb-acc)}
      .dsh-mb-code{font-family:var(--mb-codeFont);font-size:11px;
        background:var(--mb-codeBg);color:var(--mb-txt);border-radius:4px;padding:0 4px}
      .dsh-mb-session-row{display:flex;align-items:center;gap:8px;font-size:12px}
      .dsh-mb-ok{color:var(--mb-ok);font-weight:500}
      .dsh-mb-warn{color:var(--mb-warnTx);font-weight:500}
      .dsh-mb-input{width:100%;box-sizing:border-box;resize:vertical;min-height:56px;padding:8px 10px;border-radius:8px;font-size:12px;
        font-family:var(--mb-codeFont);
        border:1px solid var(--mb-inputLine);background:var(--mb-inputBg);color:var(--mb-txt);
        transition:border-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-input:focus{outline:none;border-color:var(--mb-focus)}
      .dsh-mb-input::placeholder{color:var(--mb-dim)}
      .dsh-mb-btn-row{display:flex;gap:8px}
      .dsh-mb-btn{cursor:pointer;border:none;border-radius:16px;height:32px;padding:0 16px;font-size:13px;font-weight:600;font-family:inherit;
        background:var(--mb-btnFill);color:var(--mb-btnTx);
        transition:background-color var(--mb-fast) var(--mb-ease),opacity var(--mb-fast) var(--mb-ease)}
      .dsh-mb-btn:hover:not(:disabled){background:var(--mb-btnHover)}
      .dsh-mb-btn:disabled{opacity:.4;cursor:not-allowed}
      .dsh-mb-btn.ghost{background:transparent;color:var(--mb-txt);border:1px solid var(--mb-line)}
      .dsh-mb-btn.ghost:hover:not(:disabled){background:var(--mb-soft)}
      .dsh-mb-cookie-msg{font-size:12px;color:var(--mb-sub)}
      .dsh-mb-cookie-msg.err{color:var(--mb-err)}
      .dsh-mb-key-list{display:flex;flex-direction:column;gap:4px}
      .dsh-mb-key-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;
        border-bottom:1px dashed var(--mb-lineSoft)}
      .dsh-mb-key-name{font-weight:600;min-width:64px;color:var(--mb-txt)}
      .dsh-mb-key-copy{margin-left:auto;flex:none;cursor:pointer;border:1px solid var(--mb-line);border-radius:8px;font-family:inherit;
        background:transparent;color:var(--mb-txt);padding:2px 10px;font-size:11px;
        transition:background-color var(--mb-fast) var(--mb-ease),border-color var(--mb-fast) var(--mb-ease),opacity var(--mb-fast) var(--mb-ease)}
      .dsh-mb-key-copy:hover:not(:disabled){background:var(--mb-soft)}
      .dsh-mb-key-copy:disabled{opacity:.4;cursor:not-allowed}
      .dsh-mb-key-copy.icon{display:inline-flex;align-items:center;justify-content:center;
        width:26px;height:20px;padding:0;color:var(--mb-sub)}
      .dsh-mb-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;touch-action:none;
        background:linear-gradient(135deg, transparent 50%, var(--mb-sub) 45%)}
      /* 设置弹窗：覆盖整个面板的模态层——纯色压暗遮罩（遵守 DSH 实色卡面规范，
       * 不用磨砂玻璃）+ 居中卡片（头部 + 滚动体）；点遮罩空白 / ✕ / Esc 关闭；
       * z-index 压过 sticky 筛选行(z=2)。 */
      .dsh-mb-panel.settings-open{border-color:transparent}
      .dsh-mb-modal{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;
        padding:12px;background:color-mix(in srgb, var(--mb-txt) 28%, transparent);
        border-radius:inherit;overflow:hidden;
        animation:dsh-mb-tip-in 150ms var(--mb-ease)}
      .dsh-mb-modal-card{width:100%;max-width:640px;height:100%;display:flex;flex-direction:column;overflow:hidden;
        border-radius:12px;background:var(--mb-panelBg);
        box-shadow:var(--dsw-shadow-lv2,0 6px 18px rgba(0,0,0,.12))}
      .dsh-mb-modal-head{flex:none;display:flex;align-items:center;justify-content:space-between;height:42px;
        padding:0 8px 0 14px;border-bottom:1px solid var(--mb-lineSoft)}
      .dsh-mb-modal-title{font-weight:500;font-size:14px;letter-spacing:.2px;color:var(--mb-txt)}
      .dsh-mb-modal-body{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 14px}

      /* 密钥页签：新建行 / 创建成功一次性展示 / 密钥卡片列表。 */
      .dsh-mb-key-create{display:flex;gap:8px;align-items:center}
      .dsh-mb-key-create .dsh-mb-input{flex:1}
      .dsh-mb-key-create .dsh-mb-btn{flex:none}
      .dsh-mb-created{border:1px solid color-mix(in srgb, var(--mb-acc) 25%, transparent);border-radius:12px;padding:12px 14px;
        background:color-mix(in srgb, var(--mb-acc) 7%, transparent)}
      .dsh-mb-created-title{font-size:12px;font-weight:600;color:var(--mb-acc);margin-bottom:8px}
      .dsh-mb-created-key{font-family:var(--mb-codeFont);font-size:12px;word-break:break-all;
        background:var(--mb-codeBlock);border:1px solid var(--mb-lineSoft);border-radius:8px;padding:8px 10px;color:var(--mb-txt)}
      .dsh-mb-created .dsh-mb-btn-row{margin-top:8px}
      .dsh-mb-keys-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-keys-list{display:flex;flex-direction:column;gap:6px}
      .dsh-mb-key-card{padding:9px 12px;border:1px solid var(--mb-lineSoft);border-radius:12px;background:var(--mb-soft)}
      .dsh-mb-key-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-key-card-name{font-weight:600;font-size:12.5px;color:var(--mb-txt)}
      .dsh-mb-key-code-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:5px}
      .dsh-mb-key-card-code{font-family:var(--mb-codeFont);font-size:12px;color:var(--mb-sub);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-key-card .dsh-mb-key-copy{flex:none}
      .dsh-mb-key-card-meta{font-size:10.5px;color:var(--mb-sub);margin-top:3px}
      /* 设置页：分区卡片 + 账号行（头像字/当前徽标/明文切换）。 */
      .dsh-mb-set-card{border:1px solid var(--mb-lineSoft);border-radius:12px;background:var(--mb-soft);
        padding:12px;display:flex;flex-direction:column;gap:8px}
      .dsh-mb-status-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-status-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;
        padding:2px 10px;border-radius:999px}
      .dsh-mb-status-pill.ok{color:var(--mb-ok);background:color-mix(in srgb, var(--mb-ok) 10%, transparent)}
      .dsh-mb-status-pill.warn{color:var(--mb-warnTx);background:color-mix(in srgb, var(--mb-warn) 12%, transparent)}
      .dsh-mb-status-dot{width:7px;height:7px;border-radius:50%;background:currentColor}
      .dsh-mb-acc-form{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .dsh-mb-acc-form .dsh-mb-input{flex:1;min-width:130px}
      .dsh-mb-acc-form .dsh-mb-btn{flex:none}
      .dsh-mb-pw-wrap{position:relative;display:flex;flex:1;min-width:150px}
      .dsh-mb-pw-wrap .dsh-mb-input{flex:1;padding-right:34px}
      .dsh-mb-pw-eye{position:absolute;right:3px;top:50%;transform:translateY(-50%);cursor:pointer;
        display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;
        border:none;background:transparent;color:var(--mb-acc);border-radius:6px;
        transition:background-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-pw-eye:hover{background:var(--mb-soft)}
      .dsh-mb-acc-list{display:flex;flex-direction:column;gap:4px}
      .dsh-mb-acc-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:7px 9px;border-radius:10px;
        background:var(--mb-panelBg);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-acc-row.cur{border-color:var(--mb-ok)}
      .dsh-mb-acc-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
        border-radius:8px;background:var(--mb-ghostFill);color:var(--mb-txt);font-weight:600;font-size:12px}
      .dsh-mb-acc-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
      .dsh-mb-acc-name{font-weight:600;color:var(--mb-txt);display:flex;align-items:center;gap:6px;min-width:0}
      .dsh-mb-acc-cur{flex:none;font-size:9.5px;font-weight:600;color:var(--mb-ok);background:color-mix(in srgb, var(--mb-ok) 10%, transparent);
        border-radius:5px;padding:0 5px}
      .dsh-mb-acc-pw{font-family:var(--mb-codeFont);font-size:10.5px;color:var(--mb-sub);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-key-copy.primary{color:var(--mb-btnTx);background:var(--mb-btnFill);border-color:var(--mb-btnFill);font-weight:600}
      .dsh-mb-key-copy.primary:hover:not(:disabled){background:var(--mb-btnHover)}
      .dsh-mb-key-copy.danger{color:var(--mb-err);border-color:color-mix(in srgb, var(--mb-err) 40%, transparent)}
      .dsh-mb-key-copy.danger.armed{color:var(--mb-btnTx);background:var(--mb-err);border-color:var(--mb-err);font-weight:600}
      .dsh-mb-key-copy.danger.armed:hover:not(:disabled){filter:brightness(1.08)}

      @media (prefers-reduced-motion:reduce){.dsh-mb-entry,.dsh-mb-entry-label.wide-in,.dsh-mb-trend-tip,.dsh-mb-hov{transition:none;animation:none}}
`;
        return module.exports;
  }
});
