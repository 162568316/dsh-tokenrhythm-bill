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

    // 用量页签的 token 展示：量级差太大（单笔几 K、汇总几亿），统一用「万/亿」两档。
    const fmtTok = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return '—'
      return fmtTokens(n)
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
    // 峰谷分时计价明细（徽章 title）：把 peak/valley 两个时段的刊例价/折扣价、
    // 时段边界与「当前所处时段」压成一段可读文本。字段缺失就少一行，绝不拼 undefined。
    const peakValleyTip = (s) => {
      if (!s) return ''
      const unit = ' / ' + (Number(s.billingUnit) || 1000000).toLocaleString('zh-CN') + ' Tokens'
      const line = (label, p) => {
        if (!p) return null
        const lp = p.listPrice || {}
        const dp = p.discountPrice || null
        const price = (v) => (v === null || v === undefined ? '—' : '¥' + trimNum(v))
        const body = dp
          ? '输入 ' + price(dp.inputPrice) + '（刊例 ' + price(lp.inputPrice) + '）'
            + ' · 输出 ' + price(dp.outputPrice) + '（刊例 ' + price(lp.outputPrice) + '）'
            + ' · 缓存 ' + price(dp.cacheReadPrice) + '（刊例 ' + price(lp.cacheReadPrice) + '）'
          : '输入 ' + price(lp.inputPrice) + ' · 输出 ' + price(lp.outputPrice) + ' · 缓存 ' + price(lp.cacheReadPrice)
        return label + ' ' + (p.startTime || '--:--') + '–' + (p.endTime || '--:--') + '：' + body + unit
      }
      const rows = [line('峰时段', s.peak), line('谷时段', s.valley)].filter(Boolean)
      const cur = s.expectedPeriod === 'PEAK' ? '峰时段' : s.expectedPeriod === 'VALLEY' ? '谷时段' : ''
      if (cur !== '') {
        const t = typeof s.nextSwitchAt === 'string' ? Date.parse(s.nextSwitchAt) : NaN
        rows.push('当前：' + cur + (Number.isFinite(t) ? '（' + fmtProbeTime(t) + ' 切换）' : ''))
      }
      return '峰谷分时计价' + (s.timezone ? ' · ' + s.timezone : '') + '\n' + rows.join('\n')
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

    // ---- 页首行（余额 / ZCode 用量 / ZCode 活动三个页签共用）：更新时间 + 刷新按钮，
    // 右对齐贴页面右上角（用户指定）。原先它在页脚，一行里还挂着「每 60s 自动刷新」与
    // 账号名——刷新间隔是实现细节、账号名在主卡上方的「数据账号」行已有，只留时间。
    // 没有更新时间（活动页 / 首次加载中）就只出刷新按钮，仍贴右。
    function pageTopBar({ at, onRefresh }) {
      return React.createElement('div', { className: 'dsh-mb-topbar' },
        at ? React.createElement('span', { className: 'dsh-mb-topbar-at' }, '更新于 ' + at) : null,
        React.createElement('button', { className: 'dsh-mb-refresh', onClick: onRefresh }, '刷新'),
      )
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
    // 复制成功反馈的统一时长：五处复制入口（模型 ID / 密钥 / 一次性明文 / 阶跃密钥 / 更新命令）
    // 原先 1200 与 1500 混用，同一交互在不同页停留时间不同，观感像卡顿。
    const COPY_FLASH_MS = 1500
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
      const [view, setView] = useState('balance') // 'balance'|'models'|'status'|'keys'；'step-account'；'zc-usage'|'zc-claim'。设置走弹窗不占视图
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
      const lastStepTabRef = useRef('step-account')
      const lastZcTabRef = useRef('zc-usage')
      const providerRef = useRef('tr') // 胶囊仲裁读取的实时提供商（避开 useCallback 闭包）
      const zcQuotaRef = useRef(null) // 最近一次 ZCode 额度数据（切提供商即时换胶囊用）
      const [stepPlan, setStepPlan] = useState(null)
      const [stepBal, setStepBal] = useState(null)
      // 账号清单 + 各账号已缓存的套餐/余额快照（GET /stepfun/accounts，零网络）
      const [stepAccs, setStepAccs] = useState(null)
      // 各账号展开态：username -> bool。默认全折叠（明细默认折叠）
      const [stepOpen, setStepOpen] = useState({})
      const [accDetailBusy, setAccDetailBusy] = useState(false)
      const stepPlanRef = useRef(null)
      const stepBalRef = useRef(null)
      const stepPrefsRef = useRef(null)
      const [stepAcc, setStepAcc] = useState('')
      const [stepAccPw, setStepAccPw] = useState('')
      const [showStepPw, setShowStepPw] = useState(false)
      const [stepAccBusy, setStepAccBusy] = useState(false)
      const [stepAccMsg, setStepAccMsg] = useState(null)
      // 账户页签内的账号增删（v0.5.9 从设置页搬来）：
      // stepAccConfirm = 待确认删除的 username（两段式——删账号连会话一起丢，不可恢复）
      // stepAddOpen   = 「添加账号」表单开合，账号数为 0 时强制展开（空状态）
      const [stepAccConfirm, setStepAccConfirm] = useState(null)
      const [stepAddOpen, setStepAddOpen] = useState(false)
      // 卡片上的密码显示：默认打码（host 只回掩码），点眼睛才单取明文，且同一时刻只展开一个
      // （密码明文在界面上多开一份就多一分被瞟/截屏拍走的风险）。
      const [stepPwShown, setStepPwShown] = useState(null)
      const [stepPwVal, setStepPwVal] = useState('')
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
      // ---- 基元「用量」页签（0.5.5）----
      // usage：host 把 /api/usage/panel（汇总/按模型/按客户端/Top 花费）与
      // /api/usage-daily（按天明细）合成一个 /usage 响应，前端只发 1 个请求。
      // 按天数据**不是**逐日拉的：usage-daily 的 data 本身就是 date × model ×
      // Key × clientApp 的扁平行，host 分桶成 daily.days 直接下发。
      const [usage, setUsage] = useState(null)
      const [calHover, setCalHover] = useState(null) // 悬停的 'YYYY-MM-DD'

      // 复制与本机凭据一致的历史密钥（host 校验前缀+后缀后返回完整值）。
      const copyReveal = useCallback(async (k) => {
        const r = await jsonGet(API + '/key-reveal?prefix=' + encodeURIComponent(k.prefix) + '&suffix=' + encodeURIComponent(k.masked.split('****').pop()))
        if (r && r.ok && await copyText(r.key)) {
          setCopiedKeyId(k.id)
          setTimeout(() => setCopiedKeyId((cur) => (cur === k.id ? null : cur)), COPY_FLASH_MS)
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
          // 接管是**唯一行为**（设置里「接管 / 不接管」那行已按用户要求删除，默认即接管）：
          // 这里强制 takeover:true，历史存档里的 takeover:false 一并作废——否则老存档会
          // 停在「不接管」而界面上再也没有开关能改回来。纯函数 computeStepEntry 仍保留
          // takeover 分支（与 host 侧 pickStepEntryDisplay 逐用例同步，见 tests/step.spec.mjs）。
          stepEntry: computeStepEntry({ plan: stepPlanRef.current, balance: stepBalRef.current, prefs: pf ? { ...pf, takeover: true } : pf }),
          stepTakeover: true,
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
      // 账号清单 + 各账号已缓存的套餐/余额快照：host 侧纯读缓存，零网络。
      const loadStepAccs = useCallback(() => {
        jsonGet(API + '/stepfun/accounts').then((r) => {
          if (r && r.ok) setStepAccs(r)
          else setStepAccs({ error: (r && r.error) || '账号清单加载失败' })
        })
      }, [])
      // 顺序补齐所有账号（host 侧串行 + 30s 登录冷却，约 1 分钟）。
      const loadStepAccsDetail = useCallback(() => {
        setAccDetailBusy(true)
        jsonPost(API + '/stepfun/accounts-detail', {}).then((r) => {
          setAccDetailBusy(false)
          if (r && r.ok) {
            setStepAccs(r)
            // 顺带刷新当期账号的 plan/balance，让卡片数字与快照一致
            loadStepPlan(true)
            loadStepBal()
          } else if (r) {
            setStepAccs((cur) => ({ ...(cur || {}), error: r.error || '补齐失败', aborted: r.aborted }))
          } else setStepAccs((cur) => ({ ...(cur || {}), error: '补齐失败' }))
        })
      }, [loadStepPlan, loadStepBal])
      // 单个账号强制重查（卡片上的「刷新」/「查询此账号」）。host 侧按 username 分槽缓存，
      // 非活跃账号会临时登该账号；登录冷却/限流时把错误带回卡片，不用 alert 打断。
      const refreshStepAccount = useCallback((username) => {
        setStepAccs((cur) => (cur === null ? cur : { ...cur, busy: { ...(cur.busy || {}), [username]: true } }))
        Promise.all([
          jsonGet(API + '/stepfun/plan?force=1&username=' + encodeURIComponent(username)),
          jsonGet(API + '/stepfun/balance?force=1&username=' + encodeURIComponent(username)),
        ]).then(([p, b]) => {
          setStepAccs((cur) => {
            if (cur === null) return cur
            const next = { ...cur, busy: { ...(cur.busy || {}), [username]: false } }
            next.plans = { ...(cur.plans || {}) }
            next.balances = { ...(cur.balances || {}) }
            if (p && p.ok) next.plans[username] = { ...p, cached: false }
            else if (p) next.plans[username] = { ok: false, error: p.error, code: p.code }
            if (b && b.ok) next.balances[username] = { ...b, cached: false }
            else if (b) next.balances[username] = { ok: false, error: b.error, code: b.code }
            return next
          })
          // 当期账号的数字要同步到 hero/胶囊数据源
          const act = cur && cur.activeAccount
          if (act === username) { loadStepPlan(true); loadStepBal() }
        })
      }, [loadStepPlan, loadStepBal])

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
      // 账号清单 + 各账号缓存快照（零网络，纯读 host 缓存，60s 轻轮询）。
      // 注意**不限账户页签**：密钥页要靠 activeAccount 判断「当前显示账号换了没」，
      // 只在账户页签拉的话，密钥页永远拿不到最新值 → 切了显示账号也不重拉密钥。
      // 开销为零（纯缓存读），与 plan 页签级轮询同一口径。
      useEffect(() => {
        if (!s.open || provider !== 'step') return
        if (s.settingsOpen && settingsTab !== 'step') return
        loadStepAccs()
        const t = setInterval(loadStepAccs, accDetailBusy ? 1200 : 60 * 1000)
        return () => clearInterval(t)
      }, [s.open, provider, s.settingsOpen, settingsTab, loadStepAccs, accDetailBusy])
      // 进入账户页签：自动补齐全部账号。
      // 会话按账号分槽且落盘（平台 token 有效期长），已登录过的账号直接复用本地会话、
      // 不发登录请求；只有真正缺会话的账号才会依次登一次。所以常态开销接近零，
      // 首次冷启动才需要走一遍。账号集合变化（增删账号）时也补一次。
      const autoFilledRef = useRef('')
      useEffect(() => {
        if (!s.open || provider !== 'step' || view !== 'step-account') return
        const list = (stepAccs && Array.isArray(stepAccs.accounts)) ? stepAccs.accounts : []
        const sig = list.map((a) => a.username).join('|')
        if (sig === '' || sig === autoFilledRef.current) return
        autoFilledRef.current = sig
        loadStepAccsDetail()
      }, [s.open, provider, view, stepAccs, loadStepAccsDetail])

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
        setStepAddOpen(false) // 表单收起来，直接看到新卡片
        setStepAccMsg({ ok: true, text: r.pending
          ? '已保存：' + r.activeAccount + '（登录通道暂时限流，解除后自动登录）'
          : '已添加并登录：' + r.activeAccount })
        void refreshManifest()
        // 账号集合变了 → 重新拉列表与主卡，否则新账号要等下一次轮询才出现
        if (provider === 'step') { loadStepAccs(); loadStepPlan() }
      }
      const removeStepAccount = async (username) => {
        // 两段式确认：误点第一次只进入待确认态，再点一次才真删（删账号连会话一起丢，不可恢复）
        if (stepAccConfirm !== username) { setStepAccConfirm(username); return }
        setStepAccConfirm(null)
        setStepAccBusy(true)
        const r = await jsonPost(API + '/stepfun/account/remove', { username })
        setStepAccBusy(false)
        setStepAccMsg(r && r.ok
          ? { ok: true, text: '已删除：' + username }
          : { ok: false, text: (r && r.error) || '删除失败' })
        void refreshManifest()
        if (provider === 'step') { loadStepAccs(); loadStepPlan() }
        // 账号没了就别留着它的明文——卡片卸载了，state 还攥着一份密码没意义
        setStepPwShown(null)
        setStepPwVal('')
      }
      // 卡片上的密码：默认打码（host 列表只回掩码），点眼睛才按需单取明文。
      // 同一时刻只展开一个：密码明文在界面上多开一份，就多一分被瞟到/被截屏拍走的风险。
      const revealStepPw = async (username) => {
        if (stepPwShown === username) { setStepPwShown(null); setStepPwVal(''); return }
        const r = await jsonGet(API + '/stepfun/account/password?username=' + encodeURIComponent(username))
        // 取不到就保持打码，并把原因丢进既有消息通道（不再为一个错误单开一套 UI）
        if (!(r && r.ok)) { setStepAccMsg({ ok: false, text: (r && r.error) || '读取密码失败' }); return }
        setStepAccMsg(null)
        setStepPwShown(username)
        setStepPwVal(typeof r.password === 'string' ? r.password : '')
      }
      // 「显示」= 让侧栏胶囊 / 主卡显示这个账号的数据。纯显示偏好：
      // 各账号会话分槽并存，不切换登录身份、不清缓存、不触发重登。
      const useStepAccount = async (username) => {
        setStepAccBusy(true)
        setStepAccMsg(null)
        const r = await jsonPost(API + '/stepfun/account/use', { username })
        setStepAccBusy(false)
        setStepAccMsg(r && r.switched
          ? { ok: true, text: '胶囊已显示：' + username }
          : { ok: false, text: (r && r.error) || '设置失败' })
        void refreshManifest()
        if (r && r.switched && provider === 'step') { loadStepPlan(); loadStepAccs() }
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
      // RPC（Dashboard 服务）。列表只带掩码；复制时 host 现拉列表取回完整值写剪贴板。
      // 密钥属于「当前显示账号」——账号清单拉回来后，显示账号一变就必须重拉。----
      // 已加载过哪个账号的密钥：用 ref 而不是 state，避免把它塞进 effect 依赖造成环路。
      const stepKeysAccountRef = useRef('')
      const loadStepKeys = useCallback(async (username) => {
        setStepKeys({ loading: true })
        // username 必须显式传：host 的 stepRpc 是按账号分槽取会话的，不传就要靠它兜底
        // 解析到活跃账号。传清楚既稳，也把「密钥属于当前显示账号」写进调用本身。
        const q = typeof username === 'string' && username !== '' ? ('?username=' + encodeURIComponent(username)) : ''
        const r = await jsonGet(API + '/stepfun/keys' + q)
        if (r && r.ok) {
          stepKeysAccountRef.current = typeof r.account === 'string' && r.account !== '' ? r.account : ''
          setStepKeys({ loading: false, list: r.keys || [], total: r.total, account: stepKeysAccountRef.current })
        }
        else setStepKeys({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
      }, [])
      // 当前显示账号（= host 的 activeAccount，由卡片上的「显示」按钮设置）。
      // 账户页签之外也要能拿到它——密钥页靠它判断「显示账号换了没」。
      const stepAccAccount = stepAccs && typeof stepAccs.activeAccount === 'string' && stepAccs.activeAccount !== ''
        ? stepAccs.activeAccount : ''
      useEffect(() => {
        if (!s.open || (!s.settingsOpen && view !== 'step-keys')) return
        if (s.settingsOpen && settingsTab !== 'step') return
        // 已经为当前显示账号拉过就不再打 RPC：/stepfun/keys 是真 RPC，
        // 不是零网络的缓存读。账号还未探明（''）时先拉一次，等清单回来再比对。
        if (stepAccAccount !== '' && stepKeysAccountRef.current === stepAccAccount) return
        loadStepKeys(stepAccAccount)
      }, [s.open, s.settingsOpen, settingsTab, view, loadStepKeys, stepAccAccount])
      const createStepKey = async () => {
        const name = stepKeyName.trim()
        if (!name) { setStepKeyMsg({ ok: false, text: '请填写密钥名称' }); return }
        if (name.length > 20) { setStepKeyMsg({ ok: false, text: '不超过 20 字符' }); return }
        setStepKeyBusy(true)
        setStepKeyMsg(null)
        const r = await jsonPost(API + '/stepfun/key-create', { name, username: stepAccAccount })
        setStepKeyBusy(false)
        if (r && r.ok) {
          setStepKeyCreated({ name: r.name, key: r.key })
          setStepKeyName('')
          setStepKeyMsg({ ok: true, text: '已创建「' + r.name + '」——完整密钥只显示这一次，请立即复制保存' })
          void loadStepKeys(stepAccAccount)
          void copyText(r.key) // 与基元密钥同款：创建即自动复制，防用户忘复制
        } else {
          setStepKeyMsg({ ok: false, text: (r && r.error) || '创建失败' })
        }
      }
      const copyStepCreatedKey = async () => {
        if (stepKeyCreated && await copyText(stepKeyCreated.key)) {
          setStepKeyCopied('created')
          setTimeout(() => setStepKeyCopied((cur) => (cur === 'created' ? null : cur)), COPY_FLASH_MS)
        }
      }
      const copyStepKey = async (k) => {
        const un = stepAccAccount === '' ? '' : ('&username=' + encodeURIComponent(stepAccAccount))
        const r = await jsonGet(API + '/stepfun/key?keyId=' + encodeURIComponent(k.keyId) + un)
        if (r && r.ok && await copyText(r.key)) {
          setStepKeyCopied(k.keyId)
          setTimeout(() => setStepKeyCopied((cur) => (cur === k.keyId ? null : cur)), COPY_FLASH_MS)
        } else {
          setStepKeyMsg({ ok: false, text: (r && r.error) || '复制失败' })
        }
      }
      const deleteStepKey = async (k) => {
        // 两段式确认：误点第一次只进入待确认态，再点一次才真删（密钥删除立即失效）
        if (stepKeyConfirm !== k.keyId) { setStepKeyConfirm(k.keyId); return }
        setStepKeyConfirm(null)
        const r = await jsonPost(API + '/stepfun/key-delete', { keyId: k.keyId, username: stepAccAccount })
        if (r && r.ok) {
          // 归属优先用响应里的 account（host 已回传），退化到旧 state 兜底
          setStepKeys((cur) => ({
            loading: false, list: r.keys || [], total: r.total,
            account: (typeof r.account === 'string' && r.account !== '') ? r.account
              : (cur && typeof cur.account === 'string' ? cur.account : ''),
          }))
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
        const w = Math.min(DEFAULT_PANEL_W, window.innerWidth - 16)
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
          if (r && r.ok) setModels({ loading: false, list: r.models || [], cached: !!r.cached, stale: !!r.stale, categories: r.categories || null, source: r.source, schedules: r.schedules || null, schedulesAsOf: r.schedulesAsOf || '' })
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

      const loadUsage = useCallback((force) => {
        setUsage((cur) => ({ loading: true, data: cur && cur.data }))
        jsonGet(API + '/usage' + (force === true ? '?force=1' : '')).then((r) => {
          if (r && r.ok) setUsage({ loading: false, data: r })
          else setUsage({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
        })
      }, [])

      // 当前登录账号（manifest 会话里带的）：作为余额刷新依赖，切换账号立即重拉。
      const sessionAccount = (manifest && manifest.session && manifest.session.account) || null
      // 平台用户名（/api/me 提取，manifest.accountName）：数据账号标注用它，
      // 账号密码模式下 account 只是登录手机号，不适合当展示名。
      const sessionAccountName = (manifest && manifest.session && manifest.session.accountName) || null
      // 用量：页签打开时拉一次，之后每 90s 刷新。比余额的 60s 长——上游要 2 个
      // 请求，且平台限流凶，别跟余额轮询撞车。切账号立即重拉，防看到上一个账号的数。
      useEffect(() => {
        if (!s.open || view !== 'usage') return
        loadUsage()
        const timer = setInterval(() => loadUsage(), 90 * 1000)
        return () => clearInterval(timer)
      }, [view, s.open, loadUsage, sessionAccount])
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
          setTimeout(() => setCopiedCreated(false), COPY_FLASH_MS)
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
        setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), COPY_FLASH_MS)
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
        setTimeout(() => setUpdCopied(false), COPY_FLASH_MS)
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
        const p = posRef.current || { x: 0, y: 0, w: DEFAULT_PANEL_W }
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
        const p = posRef.current || { x: 0, y: 0, w: DEFAULT_PANEL_W }
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
            ? [
                ['step-account', '账户'],
                // 密钥页签标签带当前显示账号：多账号时切了「显示」，不用点进页签就知道
                // 这堆密钥是谁的。增删密钥不可逆，归属不该藏在二级页面里。
                ['step-keys', stepAccAccount === '' ? '密钥' : '密钥（' + stepAccAccount + '）'],
              ]
            : effProv === 'zcode'
              ? [['zc-usage', '用量'], ['zc-claim', '活动']]
              : [['balance', '余额'], ['usage', '用量'], ['models', '模型'], ['status', '状态'], ['keys', '密钥']]).map(([id, label]) =>
            React.createElement('button', {
              key: id,
              className: 'dsh-mb-tab' + (view === id ? ' active' : ''),
              onClick: () => switchTab(id),
            }, label)),
        ),
        React.createElement('div', { className: 'dsh-mb-body' },
          view === 'models' ? renderModelsTab({ manifest, providers, models, catFilter, setCatFilter, copiedId, copyId }) : null,
          view === 'balance' ? renderBalanceTab({ manifest, balance, loadBalance, goSettings: toggleSettings, sessionAccount, sessionAccountName }) : null,
          view === 'usage' ? renderUsageTab({ usage, loadUsage, sessionAccount, calHover, setCalHover }) : null,
          // 状态页签 = 自定义检测（自己的 Key 实测；官方状态站 2026-09-14 起停更并移除）。
          view === 'status' ? renderCheckPanel({
            models, checkSel, toggleCheckSel, checkBusy, checkResults,
            checkInterval, setCheckInterval, checkNextAt, checkMsg, runCheckNow,
          }) : null,
          view === 'keys' ? renderKeysTab({
            manifest, keysData, loadKeys, keyName, setKeyName, keyCreating, createKey,
            createdKey, setCreatedKey, copiedCreated, copyCreatedKey, copiedKeyId, copyReveal,
          }) : null,
          // 阶跃「账户」= 账号 + 用量二合一：列出全部账号，每张卡带套餐与余额，
          // 明细默认折叠。原 step-usage 页签内容并入账号卡的展开区。
          view === 'step-account' ? renderStepAccountTab({
            stepAccs, loadStepAccs, refreshStepAccount, loadStepAccsDetail, accDetailBusy,
            useStepAccount, stepOpen, setStepOpen,
            stepAcc, setStepAcc, stepAccPw, setStepAccPw, showStepPw, setShowStepPw,
            stepAccBusy, stepAccMsg, addStepAccount, removeStepAccount,
            stepAccConfirm, setStepAccConfirm, stepAddOpen, setStepAddOpen,
            stepPwShown, stepPwVal, revealStepPw,
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
                setStepEntryPref,
              })),
          ),
        ) : null,
        React.createElement('div', { className: 'dsh-mb-resize', title: '调整大小', onPointerDown: onResizeDown }),
      )
    }

    // 面板默认宽度（用户指定：默认宽度一行放 3 张模型卡）。
    // 网格列数 = floor((面板宽 − 34 描边内距 + 8) ÷ (--mb-mc-min-w 190 + 8))，660 → 内容 626 → 3 列；
    // 卡片最小宽不变的话 3 张需要 650+，所以这里从 560 提到 660（老宽度 560 只会出 2 列）。
    const DEFAULT_PANEL_W = 660

    const sanitizePos = (p) => {
      const w = Math.min(860, Math.max(360, Number(p.w) || DEFAULT_PANEL_W), window.innerWidth - 16)
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
        return React.createElement('div', { className: 'dsh-mb-notice' }, '未配置基元律动（tokenrhythm）提供商：settings.yaml 或 profile 的 cordis.patch.yml 里没有 baseURL 含 tokenrhythm 的 llm-pi-ai 条目')
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
        // 峰谷表按模型 ID 贴到模型上（只读挂载，不改原对象）——没有配置的模型不带 schedule，
        // 卡片据此决定画不画「峰谷」徽章。
        const schedMap = (models.schedules && typeof models.schedules === 'object') ? models.schedules : null
        const list = sortModelsLikeCards(models.list)
          .map((m) => (schedMap && schedMap[m.id] ? { ...m, schedule: schedMap[m.id] } : m))
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
                // 峰谷徽章：该模型在平台配了分时计价（peak/valley）才画。与折扣徽章
                // 并列同行，冷暖双色区分——折扣=省钱、峰谷=分时。明细全在 title 里。
                m.schedule ? React.createElement('span', {
                  className: 'dsh-mb-card-pv',
                  key: 'pv',
                  title: peakValleyTip(m.schedule),
                }, '峰谷') : null,
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
            // 用户要求：明细字段**不并排**——规格与价格合成一个单栏 dl，逐行列出
            // （原先拆成两个 dl、各占一栏，字段会左右分栏显示）
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
                  React.createElement('dd', { title: '完整数值：' + m.maxOutput + ' Token' }, fmtCtx(m.maxOutput))) : null,
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
      // 同余额页：host 的失败原因优先于「没有提供商」这句概括
      if (manifest && manifest.error) {
        return React.createElement('div', { className: 'dsh-mb-notice err' }, manifest.error)
      }
      const capable = manifest && Array.isArray(manifest.providers) && manifest.providers.some((p) => p.balanceCapable)
      if (!capable) {
        return React.createElement('div', { className: 'dsh-mb-notice' }, '未配置基元律动（tokenrhythm）提供商：settings.yaml 或 profile 的 cordis.patch.yml 里没有 baseURL 含 tokenrhythm 的 llm-pi-ai 条目')
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

    // ---- 用量页签（0.5.5）：近 30 天汇总 + 30 天热力日历 + 按模型/客户端拆分 ----
    // 注意：本函数与 Panel 组件体是兄弟作用域，拿不到里面的 useState，所以悬停态
    // calHover/setCalHover 必须由调用方当 props 传进来。
    //
    // 数据来源（host 2 个上游请求）：
    //   · /api/usage/panel?range=30d  → summary / byModel / byClientApp / topCostCalls
    //   · /api/usage-daily             → date × model × Key × clientApp 扁平行，分桶成日历
    // 为什么要两个：panel 给不了按天（实测 groupBy/startAt/endDate 全被忽略），
    // usage-daily 给不了「单笔最贵调用」。两者 30 天合计实测逐位相同（¥242.49619028），
    // 互为校验，host 已把差值放在 meta.crossCheck，这里据此如实标注。
    const USAGE_WD = ['日', '一', '二', '三', '四', '五', '六']
    function renderUsageTab({ usage, loadUsage, sessionAccount, calHover, setCalHover }) {
      const d = usage && usage.data ? usage.data : null
      const rows = []
      if (!d) {
        if (usage && usage.error) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'e' }, '用量查询失败：' + usage.error))
        } else {
          rows.push(React.createElement('div', { className: 'dsh-mb-skel-hero', key: 'ld', role: 'status', 'aria-label': '加载中' },
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '46%', height: 28, borderRadius: 8 } }),
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '70%' } }),
            React.createElement('div', { className: 'dsh-mb-skel', style: { width: '100%', height: 96, borderRadius: 10 } }),
          ))
        }
        return React.createElement('div', { className: 'dsh-mb-section' }, rows)
      }

      const s = d.summary || {}
      const days = Array.isArray(d.daily && d.daily.days) ? d.daily.days : []
      const meta = d.meta || {}
      const cc = meta.crossCheck || null
      // 日历窗口合计 vs panel 汇总：实测一致，不一致就在标题下如实点出来（不悄悄用哪个）
      const drift = cc && Math.abs(cc.dailyCostCny - cc.panelCostCny) > 0.005

      // ---- 汇总卡：hero 用余额/阶跃同款的 dsh-mb-hero-stats + stat 结构（复用既有样式）----
      const cacheRate = s.inputTokens > 0 && s.cacheReadTokens > 0 ? s.cacheReadTokens / s.inputTokens : null
      rows.push(React.createElement('div', { className: 'dsh-mb-hero', key: 'hero' },
        React.createElement('div', { className: 'dsh-mb-hero-stats' },
          React.createElement('div', { className: 'dsh-mb-stat' },
            React.createElement('span', { className: 'dsh-mb-stat-k' }, '近 30 天总花费'),
            React.createElement('span', { className: 'dsh-mb-stat-v' }, '¥' + trimNum(s.costCny))),
          // 调用次数与总 Tokens 并排同一组：两者都是「用了多少」的量，原先一个在主卡、
          // 一个在下方指标卡里，同一段时间的体量要跨两处对照。花钱在左（主值 28px），
          // 这两个量在右（副值 20px）——一眼读完「花多少、跑多少次、烧多少 token」。
          React.createElement('div', { className: 'dsh-mb-hero-pair' },
            React.createElement('div', { className: 'dsh-mb-stat right' },
              React.createElement('span', { className: 'dsh-mb-stat-k' }, '调用'),
              React.createElement('span', { className: 'dsh-mb-stat-v' }, (s.calls || 0).toLocaleString() + ' 次')),
            React.createElement('div', { className: 'dsh-mb-stat right' },
              React.createElement('span', { className: 'dsh-mb-stat-k' }, '总 Tokens'),
              React.createElement('span', { className: 'dsh-mb-stat-v' }, fmtTok(s.totalTokens)))),
        ),
        React.createElement('div', { className: 'dsh-mb-kv-grid' },
          React.createElement('div', { className: 'dsh-mb-kv', key: 'k1' },
            React.createElement('span', { className: 'dsh-mb-kv-k' }, '成功 / 失败'),
            React.createElement('span', { className: 'dsh-mb-kv-v' }, (s.successCalls || 0).toLocaleString() + ' / ' + (s.errorCalls || 0).toLocaleString())),
          React.createElement('div', { className: 'dsh-mb-kv', key: 'k2' },
            React.createElement('span', { className: 'dsh-mb-kv-k' }, '中止'),
            React.createElement('span', { className: 'dsh-mb-kv-v' }, (s.abortedCalls || 0).toLocaleString())),
          // 输入 / 输出合一张卡：两个数放两张卡太碎，并排读才有「进多少出多少」的对照感。
          // 摆在缓存命中率前面：入/出 → 命中率，是从粗到细的口径（总 Tokens 已提到主卡，
          // 与调用次数并排——量级口径放主卡，指标卡只留细化拆分）。
          React.createElement('div', { className: 'dsh-mb-kv', key: 'k4' },
            React.createElement('span', { className: 'dsh-mb-kv-k' }, '输入 / 输出'),
            React.createElement('span', { className: 'dsh-mb-kv-v' }, fmtTok(s.inputTokens) + ' / ' + fmtTok(s.outputTokens))),
          React.createElement('div', { className: 'dsh-mb-kv', key: 'k5' },
            React.createElement('span', { className: 'dsh-mb-kv-k' }, '缓存命中率'),
            React.createElement('span', { className: 'dsh-mb-kv-v' }, cacheRate === null ? '—' : (cacheRate * 100).toFixed(2) + '%')),
        ),
      ))

      // ---- 日历：最近 30 天按周铺开，一格一天 ----
      // 样式走「热力日历」：格子底色随当日花费深浅变化（越贵越浓），金额直接摆在格子里，
      // 不再用一根细条——细条在 70px 宽的格子里既看不清也说不出「多少」。
      // 空的格子画虚线框 + 「—」，明确是「这天没调用」，不让它看起来像坏了。
      if (days.length > 0) {
        const maxCost = Math.max.apply(null, days.map((b) => b.costCny).concat([0.0001]))
        // usage-daily 只对「有调用」的日子吐行。没有行可能是两种完全不同的情况：
        //   ① 当天真的 0 次调用（绝大多数情况，已由 crossCheck 与汇总逐位相符证实；
        //      30 格里的调用数/金额合计 === /api/usage/panel 的 summary）；
        //   ② 那天早于平台返回明细的最早日（新账号/平台裁剪），属于「无数据」而非「0 次」。
        // 界面必须把两者分开说，否则 22 个空格子会被当成页面坏了。
        const earliest = String(meta.earliestDate || '')
        const activeDays = days.filter((b) => b.hasData && b.calls > 0).length
        const wdOf = (k) => {
          const p = k.split('-')
          return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay()
        }
        // 前导占位：第一天若不是周日，前面补空格才能对齐星期表头
        const lead = wdOf(days[0].date)
        const cells = []
        for (let i = 0; i < lead; i++) cells.push({ blank: true, key: 'b' + i })
        days.forEach((b, i) => cells.push({ b, key: b.date, idx: i, col: (lead + i) % 7, row: Math.floor((lead + i) / 7) }))
        rows.push(React.createElement('div', { className: 'dsh-mb-cal-wrap', key: 'cal' },
          // 标题 + 覆盖度同一行：左边标题，右边角标。覆盖度是「读这张表的辅助信息」，
          // 单独占一整行会把标题和日历隔开；放右上角既不打扰扫读又能随时看到。
          React.createElement('div', { className: 'dsh-mb-cal-head' },
            React.createElement('span', { className: 'dsh-mb-day-title' },
              '近 ' + days.length + ' 天用量日历' + (sessionAccount ? ' · ' + sessionAccount : '')),
            // 文案压到最短：「N 天有调用 · 明细起 XXXX-XX-XX」。空格子占多数是常态，
            // 角标要说清「空的是真空」而不是「没加载出来」。
            React.createElement('span', { className: 'dsh-mb-cal-meta' },
              activeDays + ' / ' + days.length + ' 天有调用'
              + (earliest !== '' ? ' · 明细起 ' + earliest : ''))),
          React.createElement('div', { className: 'dsh-mb-cal-hd' },
            USAGE_WD.map((w, i) => React.createElement('span', { key: w, className: 'dsh-mb-cal-wd' + (i === 0 || i === 6 ? ' wknd' : '') }, w))),
          React.createElement('div', {
            className: 'dsh-mb-cal',
            onMouseLeave: () => setCalHover(null),
          },
            cells.map((c) => {
              if (c.blank) return React.createElement('div', { className: 'dsh-mb-cal-cell blank', key: c.key })
              const b = c.b
              const p = b.date.split('-')
              const isToday = c.idx === days.length - 1
              // 热度 → 底色浓度。下限 7% 保证空格与「有数据但极便宜」仍可分辨。
              const heat = b.costCny <= 0 ? 0 : Math.max(0.12, Math.min(1, b.costCny / maxCost))
              const tint = Math.round((7 + heat * 25) * 10) / 10
              const wd = wdOf(b.date)
              const cls = 'dsh-mb-cal-cell'
                + (b.hasData ? ' has' : ' nodata')
                + (isToday ? ' today' : '')
                + (wd === 0 || wd === 6 ? ' wknd' : '')
              return React.createElement('div', {
                className: cls,
                key: c.key,
                // 热力底色用内联算（每格浓度不同，写不进静态 CSS）
                style: b.hasData
                  ? { background: 'color-mix(in srgb, var(--mb-acc) ' + tint + '%, transparent)' }
                  : undefined,
                // 空日子不给悬浮：没有明细可看，弹个「无数据」只是噪声；
                // 顺带把上一格的浮层收掉（置 null），不然浮层会粘在别处。
                onMouseEnter: () => setCalHover(b.hasData ? b.date : null),
              },
                React.createElement('span', { className: 'dsh-mb-cal-day' }, Number(p[2])),
                React.createElement('span', { className: 'dsh-mb-cal-cost' },
                  b.hasData ? '¥' + trimNum(b.costCny) : '—'),
                calHover === b.date && b.hasData ? React.createElement('div', {
                  // 防出面板按**列**算，不是按第几天：月初若不是周日，第 0 天其实落在第
                  // 2、3 列，真正贴左边的是后面的日子。列 0/1 靠左对齐、列 5/6 靠右对齐，
                  // 中间列才居中——居中浮层约 170~250px 宽，偏一列就会探出面板。
                  // .dsh-mb-body 是 overflow-y:auto（按规范此时 overflow-x 会计算成 auto），
                  // 横向超出必然被裁，所以边缘列必须显式贴边。
                  // 第一行的浮层往上弹会被父级裁掉，改往下方弹。
                  className: 'dsh-mb-trend-tip'
                    + (c.col <= 1 ? ' edge-l' : c.col >= 5 ? ' edge-r' : '')
                    + (c.row === 0 ? ' below' : ''),
                },
                  React.createElement('div', { className: 'dsh-mb-trend-tip-head' },
                    React.createElement('span', null, b.date),
                    React.createElement('span', null, '¥' + trimNum(b.costCny) + ' · ' + b.calls.toLocaleString() + ' 次')),
                  // 有数据但 models 取空（host 兜底）时给一行说明，别留个空浮层
                  (b.models.length > 0 ? b.models : [{ model: '当天无调用' }]).map((m, j) => React.createElement('div', { className: 'dsh-mb-trend-tip-row', key: j },
                    React.createElement('span', { className: 'dsh-mb-trend-tip-model' }, m.model),
                    m.costCny === undefined ? null : React.createElement('span', { className: 'dsh-mb-trend-tip-cost' }, '¥' + trimNum(m.costCny)),
                    m.calls === undefined ? null : React.createElement('span', { className: 'dsh-mb-trend-tip-calls' }, m.calls + ' 次'),
                  )),
                  b.hasData && b.modelCount > b.models.length
                    ? React.createElement('div', { className: 'dsh-mb-trend-tip-row' },
                      React.createElement('span', { className: 'dsh-mb-trend-tip-model' }, '…等 ' + b.modelCount + ' 个模型'),
                      React.createElement('span', { className: 'dsh-mb-trend-tip-calls' }, ''))
                    : null,
                  b.tokenSavingUsd > 0
                    ? React.createElement('div', { className: 'dsh-mb-trend-tip-row' },
                      React.createElement('span', { className: 'dsh-mb-trend-tip-model' }, '开源节省'),
                      React.createElement('span', { className: 'dsh-mb-trend-tip-cost' }, '$' + trimNum(b.tokenSavingUsd)))
                    : null,
                ) : null,
              )
            }),
          ),
          // 覆盖说明：只有「日历起点早于平台明细最早日」时才提示会看到无数据格，
          // 否则空格子就是真的没调用（上面那行已经说清了天数）。
          meta.earliestDate && meta.earliestDate > days[0].date
            ? React.createElement('div', { className: 'dsh-mb-hint' },
              '日历起点 ' + days[0].date + '，早于 ' + meta.earliestDate.split('T')[0] + ' 的日期平台未返回明细，标为「—」而非 0 次')
            : null,
          drift && cc
            ? React.createElement('div', { className: 'dsh-mb-hint' },
              '日历窗口合计 ¥' + trimNum(cc.dailyCostCny) + ' 与接口汇总 ¥' + trimNum(cc.panelCostCny) + ' 差 ¥' + trimNum(Math.abs(cc.dailyCostCny - cc.panelCostCny)) + '（一个是自然日窗口、一个是滚动 30 天，边界日不同），此处以汇总为准')
            : null,
          React.createElement('button', {
            className: 'dsh-mb-toggle',
            style: { marginTop: 2 },
            onClick: () => loadUsage(true),
          }, '刷新用量'),
        ))
      }

      // ---- 按模型 / 按客户端：左右并排，各占一半宽度 ----
      // 按花费降序取前 6：尾部散着的小模型进 tooltip 都嫌挤，别铺满屏。
      // 并排而不是上下堆：两张表信息量相当、也常常要对照着看（哪个模型在哪个客户端烧钱），
      // 上下排会把「用量」页撑到要滚两屏。只有一边有数据时才独占整行。
      const top6 = (list) => (Array.isArray(list) ? list : [])
        .slice()
        .sort((a, b) => (b.costCny || 0) - (a.costCny || 0))
        .slice(0, 6)
      const byModel = top6(d.byModel)
      const byApp = top6(d.byClientApp)
      const rankRows = (list, nameOf, key) => {
        const mx = Math.max.apply(null, list.map((g) => g.costCny).concat([0.0001]))
        return list.map((g, i) => React.createElement('div', { className: 'dsh-mb-rank', key: key + i },
          React.createElement('span', { className: 'dsh-mb-rank-k' }, nameOf(g)),
          React.createElement('span', { className: 'dsh-mb-rank-bar' },
            React.createElement('i', { style: { width: Math.max(3, Math.round(g.costCny / mx * 100)) + '%' } })),
          React.createElement('span', { className: 'dsh-mb-rank-v' }, '¥' + trimNum(g.costCny)),
          React.createElement('span', { className: 'dsh-mb-rank-c' }, g.calls + ' 次'),
        ))
      }
      const splitCols = []
      if (byModel.length > 0) {
        splitCols.push(React.createElement('div', { className: 'dsh-mb-trend-wrap col', key: 'bymodel' },
          React.createElement('div', { className: 'dsh-mb-day-title' }, '按模型（前 ' + byModel.length + '，共 ' + (d.byModel || []).length + '）'),
          rankRows(byModel, (g) => g.model || g.modelId || '未知模型', 'm')))
      }
      if (byApp.length > 0) {
        splitCols.push(React.createElement('div', { className: 'dsh-mb-trend-wrap col', key: 'byapp' },
          React.createElement('div', { className: 'dsh-mb-day-title' }, '按客户端（前 ' + byApp.length + '，共 ' + (d.byClientApp || []).length + '）'),
          rankRows(byApp, (g) => g.clientApp || 'unknown', 'a')))
      }
      if (splitCols.length === 2) {
        rows.push(React.createElement('div', { className: 'dsh-mb-split', key: 'split' }, splitCols))
      } else {
        for (const col of splitCols) rows.push(col)
      }

      // 说明：/api/usage/panel 里的 topCostCalls（单笔最贵）已不在界面展示——
      // 30 天日历 + 按模型/客户端拆分已经能回答「钱花在哪」，单笔明细属于调试信息，
      // 摆在这只会把面板撑得很长。host 侧仍照原样解析返回（normalizeUsagePanel
      // 忠实于平台响应），前端不用而已。
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 余额页签：限时额度 hero + 当日使用（含缓存命中）。花费走势与最近调用看「用量」页签 ----
    function renderBalanceTab({ manifest, balance, loadBalance, goSettings, sessionAccount, sessionAccountName }) {
      // host 侧 readProviders 的失败原因必须显出来。曾经这里只看 capable，于是
      // /manifest 500 或「补丁层枚举失败」都被显示成一句「没有提供商」——用户照着
      // 去改一个本来没问题的配置文件，真正原因反被吞了（实测踩过）。
      if (manifest && manifest.error) {
        return React.createElement('div', { className: 'dsh-mb-notice err' }, manifest.error)
      }
      const capable = manifest && Array.isArray(manifest.providers) && manifest.providers.some((p) => p.balanceCapable)
      if (!capable) {
        return React.createElement('div', { className: 'dsh-mb-notice' }, '未配置基元律动（tokenrhythm）提供商，无法查询余额：settings.yaml 或 profile 的 cordis.patch.yml 里没有 baseURL 含 tokenrhythm 的 llm-pi-ai 条目')
      }
      const rows = []
      // 页首右上角：更新时间 + 刷新（用户指定）。原先这行沉在页脚，还挂着
      // 「每 60s 自动刷新」与账号名：刷新间隔是固定实现细节，账号名主卡上方已有
      // 「数据账号」行——三段里只有时间有用，只留它，并挪到右上角。
      rows.push(pageTopBar({
        at: balance && balance.data && balance.data.fetchedAt ? new Date(balance.data.fetchedAt).toLocaleTimeString() : null,
        onRefresh: loadBalance,
      }))
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
          // 两段堆叠条（.limited）：右端橙段＝限时额度，左侧蓝底＝非限时额度（用户指定
          // 「限时的在右边」）。限时为 0 时不出橙段——fill 带 2px 最小宽，留着会在纯蓝条
          // 右端挂一颗橙色小点，看着像「有一点点限时」。
          share !== null ? React.createElement('div', { className: 'dsh-mb-hero-bar limited', title: chipTitle },
            share > 0 ? React.createElement('div', { className: 'dsh-mb-hero-bar-fill', style: { width: (share * 100) + '%' } }) : null,
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
        // 当日卡只在「分页真的缺页」时才提示：页面顺序最新优先，今天的数字仍是全的，
        // 不必拿「更早的日子没拉完」吓唬用户。
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

        // ---- 资金明细：钱是哪来的、每笔还剩多少 ----
        // 数据源 /api/wallet/expiring-credits?includeInactive=true。回答主卡答不了的
        // 问题：账户余额是「一坨总数」，这里把它拆回来源——充值本金、体验卡、邀请奖励
        // 各自给了多少、用了多少、还剩多少、什么时候到期。用完的（USED_UP）也保留：
        // 那是历史事实，删了就说不出「总共赠送过多少」。1 个请求，失败只丢这块。
        if (d.wallet) {
          const w = d.wallet
          const walletRows = []
          // 充值本金常年 USED_UP 且没过期时间，单独置顶，不与赠送额度混在一张按到期排的表里
          if (w.principal) {
            walletRows.push(React.createElement('div', { className: 'dsh-mb-wrow principal', key: 'p' },
              React.createElement('span', { className: 'dsh-mb-wrow-k' }, w.principal.sourceLabel || '充值本金'),
              React.createElement('span', { className: 'dsh-mb-wrow-n' },
                '赠送 ¥' + trimNum(w.principal.grantedCny) + ' / 已用 ¥' + trimNum(w.principal.consumedCny)),
              React.createElement('span', { className: 'dsh-mb-wrow-r' }, '剩 ¥' + trimNum(w.principal.remainingCny)),
              React.createElement('span', { className: 'dsh-mb-wrow-x' }, w.principal.expiresAt ? '到期 ' + fmtDay(w.principal.expiresAt) : '不过期')))
          }
          for (const it of w.items) {
            const state = it.status === 'ACTIVE' ? 'active' : (it.status === 'USED_UP' ? 'used' : 'other')
            walletRows.push(React.createElement('div', { className: 'dsh-mb-wrow ' + state, key: it.id || it.source + (it.grantedAt || '') },
              React.createElement('span', { className: 'dsh-mb-wrow-k', title: it.source || '' }, it.sourceLabel || it.source || '—'),
              React.createElement('span', { className: 'dsh-mb-wrow-n' },
                '赠送 ¥' + trimNum(it.grantedCny) + ' / 已用 ¥' + trimNum(it.consumedCny)),
              React.createElement('span', { className: 'dsh-mb-wrow-r' }, '剩 ¥' + trimNum(it.remainingCny)),
              React.createElement('span', { className: 'dsh-mb-wrow-x' },
                it.expiresAt ? '到期 ' + fmtDay(it.expiresAt) : '不过期')))
          }
          const giftBits = []
          if (w.summary && w.summary.cumulativeGiftGrantedCny > 0) giftBits.push('累计赠送 ¥' + trimNum(w.summary.cumulativeGiftGrantedCny))
          if (w.summary && w.summary.expiringBalanceCny > 0) giftBits.push('未到期 ¥' + trimNum(w.summary.expiringBalanceCny))
          rows.push(React.createElement('div', { className: 'dsh-mb-day-title', key: 'wtitle' }, '资金明细'))
          rows.push(React.createElement('div', { className: 'dsh-mb-wallet', key: 'wallet' },
            giftBits.length > 0 ? React.createElement('div', { className: 'dsh-mb-hint' }, giftBits.join(' · ')) : null,
            walletRows.length > 0 ? walletRows : React.createElement('div', { className: 'dsh-mb-hint' }, '暂无额度明细（未充值也没有赠送）'),
          ))
        }
      }
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
      // 页首右上角：更新时间 + 刷新（与基元余额页同一套页首行）
      rows.push(pageTopBar({
        at: zcQuota && zcQuota.data && zcQuota.data.fetchedAt ? new Date(zcQuota.data.fetchedAt).toLocaleTimeString() : null,
        onRefresh: () => loadZcQuota(true),
      }))
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
            // ZCode 占比条 = **剩余额度**（用户指定），中性配方：灰轨道 + 主题蓝填充，
            // 左端起、**不出现橙色**（橙色在本插件里专属「限时额度」语义，只给基元那张两段条用）。
            // 剩余为 0 时不画填充段：fill 带 2px 最小宽，留着会在空条左端挂一颗蓝色小点。
            remainPct !== null ? React.createElement('div', { className: 'dsh-mb-hero-bar', title: '剩余 ' + trimNum(remainPct) + '%' },
              remainPct > 0 ? React.createElement('div', { className: 'dsh-mb-hero-bar-fill', style: { width: remainPct + '%' } }) : null,
            ) : null,
            // 图例只留互补的「已用 X%」：主位大字已经是剩余额度，不再复述；**不再显示数据来源**
            // （用户要求删掉那行数据来源——来源是内部实现细节，不该占版面）。
            React.createElement('div', { className: 'dsh-mb-hero-legend' },
              React.createElement('span', null, pct !== null ? '已用 ' + pct + '%' : '已用 —'),
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
      }
      // 页首右上角：刷新按钮（与余额/ZCode 用量页同一套页首行；这页没有更新时间）
      rows.unshift(pageTopBar({ onRefresh: loadZcPlans }))
      rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
        '读取本机 ~/.zcode/v2 登录凭证 · 接口经插件后台代理 · 凭证只留在本机'))
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 阶跃工具格式化 ----
    // 套餐档位 → 水印配色类名。平台侧 tier = subscription.name，实测只见过 "Mini"，
    // 另外三档（Plus / Pro / Max）由用户确认存在。按「档位越高越暖」排：蓝 → 青 → 紫 → 金，
    // 一眼分得出高低。认不出的档位返回 null —— **不画水印**：宁可没有，
    // 也不能给一个来路不明的归属色（用户会以为那代表某种状态）。
    const STEP_TIER_CLASS = { mini: 't-mini', plus: 't-plus', pro: 't-pro', max: 't-max' }
    const stepTierClass = (name) => {
      if (typeof name !== 'string') return null
      const k = name.trim().toLowerCase()
      return Object.prototype.hasOwnProperty.call(STEP_TIER_CLASS, k) ? STEP_TIER_CLASS[k] : null
    }
    const fmtStepDate = (epochSec) => {
      const n = Number(epochSec)
      if (!Number.isFinite(n) || n <= 0) return null
      const d = new Date(n * 1000)
      if (!Number.isFinite(d.getTime())) return null
      const md = (d.getMonth() + 1) + '月' + d.getDate() + '日'
      return d.getFullYear() === new Date().getFullYear() ? md : d.getFullYear() + '-' + md
    }
    // 月池重置时间用紧凑日期（M/D，跨年才带年），完整年月日时分放 title
    const fmtShortDate = (epochSec) => {
      const d = new Date(Number(epochSec) * 1000)
      if (!Number.isFinite(d.getTime())) return null
      const same = d.getFullYear() === new Date().getFullYear()
      return (same ? '' : d.getFullYear() + '/') + (d.getMonth() + 1) + '/' + d.getDate()
    }
    const fmtStepFull = (epochSec) => {
      const d = new Date(Number(epochSec) * 1000)
      if (!Number.isFinite(d.getTime())) return ''
      const p = (n) => (n < 10 ? '0' + n : '' + n)
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }
    // Credit 数字：亿/万缩写（完整值放 title）；1M Credit=¥1 的换算只作 tooltip 说明。
    const stepCreditTip = (n) => (Number.isFinite(n) ? '完整值：' + n.toLocaleString('en-US') + ' Credit（1M Credit=¥1，以控制台为准）' : '')

    // ---- 阶跃「账户」页签：全部账号一览，每张卡带套餐与余额；明细默认折叠 ----
    // 数据来源：GET /stepfun/accounts（零网络，纯 host 缓存快照）——
    //   accounts[] / activeAccount / plans{username} / balances{username}
    // 未缓存的账号显示「尚未查询」，绝不拿 ¥0 冒充查到了。
    function renderStepAccountTab({ stepAccs, loadStepAccs, refreshStepAccount, loadStepAccsDetail, accDetailBusy, useStepAccount, stepOpen, setStepOpen, stepAcc, setStepAcc, stepAccPw, setStepAccPw, showStepPw, setShowStepPw, stepAccBusy, stepAccMsg, addStepAccount, removeStepAccount, stepAccConfirm, setStepAccConfirm, stepAddOpen, setStepAddOpen, stepPwShown, stepPwVal, revealStepPw }) {
      if (stepAccs === null) {
        return React.createElement('div', { className: 'dsh-mb-section' },
          React.createElement('div', { className: 'dsh-mb-skel-hero', key: 'sk1' }),
          React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'sk2' }))
      }
      if (stepAccs.error && !Array.isArray(stepAccs.accounts)) {
        return React.createElement('div', { className: 'dsh-mb-section' },
          React.createElement('div', { className: 'dsh-mb-notice err', key: 'e' },
            stepAccs.error,
            React.createElement('div', { style: { marginTop: 6 } },
              React.createElement('button', { className: 'dsh-mb-link', onClick: loadStepAccs }, '重试'))))
      }
      const accounts = Array.isArray(stepAccs.accounts) ? stepAccs.accounts : []
      const active = typeof stepAccs.activeAccount === 'string' ? stepAccs.activeAccount : ''
      const plans = stepAccs.plans || {}
      const balances = stepAccs.balances || {}
      const busy = stepAccs.busy || {}

      // ---- 账号增删（v0.5.9 从设置页搬来）：加在卡片列表之前，删在每张卡的顶行 ----
      // 表单默认收起（账号多时不给列表添噪音）；一个账号都没有时强制展开——那就是空状态，
      // 用户进来看见的就该是「怎么加第一个账号」而不是一片空。
      const addOpen = accounts.length === 0 ? true : stepAddOpen
      const mgmt = []
      mgmt.push(React.createElement('div', { className: 'dsh-mb-stepacc-addbar', key: 'ab' },
        React.createElement('button', {
          className: 'dsh-mb-btn small ghost',
          disabled: stepAccBusy,
          title: addOpen ? '收起添加表单' : '添加一个阶跃账号（手机号/邮箱 + 密码）',
          onClick: () => setStepAddOpen(!addOpen),
        }, addOpen ? '收起添加' : '＋ 添加账号'),
        React.createElement('span', { className: 'dsh-mb-hint', key: 'n' },
          accounts.length > 0 ? '共 ' + accounts.length + ' 个账号' : '还没有账号'),
        // 主操作独立放右侧：查询要真打平台、耗时可达 1 分钟，是这一页最重的动作，
        // 不该和「添加账号」这种低频操作并列混在一起。
        React.createElement('span', { className: 'sp', key: 'sp' }),
        React.createElement('button', {
          className: 'dsh-mb-btn small',
          disabled: accDetailBusy || accounts.length === 0,
          title: '查询全部账号的账户余额与 Credit 月池（真发请求，会话失效的账号会先自动续期/登录）',
          onClick: loadStepAccsDetail,
        }, accDetailBusy ? '查询中…' : '查询余额')))
      if (addOpen) {
        const form = []
        form.push(React.createElement('input', {
          className: 'dsh-mb-input', key: 'u',
          style: { minHeight: 0, padding: '6px 10px' },
          type: 'text', autoComplete: 'off', maxLength: 64,
          placeholder: '手机号 / 邮箱', value: stepAcc,
          onChange: (e) => setStepAcc(e.target.value),
        }))
        form.push(React.createElement('div', { className: 'dsh-mb-pw-wrap', key: 'pw' },
          React.createElement('input', {
            className: 'dsh-mb-input',
            style: { minHeight: 0, padding: '6px 10px' },
            type: showStepPw ? 'text' : 'password', autoComplete: 'off',
            placeholder: '密码', value: stepAccPw,
            onChange: (e) => setStepAccPw(e.target.value),
          }),
          React.createElement('button', {
            className: 'dsh-mb-pw-eye', title: showStepPw ? '隐藏密码' : '显示密码',
            onClick: () => setShowStepPw(!showStepPw),
          }, EyeIcon({ off: showStepPw }))))
        form.push(React.createElement('button', {
          className: 'dsh-mb-btn', key: 'go',
          disabled: stepAccBusy || stepAcc.trim() === '' || stepAccPw === '',
          onClick: addStepAccount,
        }, stepAccBusy ? '处理中…' : '登录'))
        mgmt.push(React.createElement('div', { className: 'dsh-mb-acc-form', key: 'fm' }, form))
        mgmt.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'pwtip' },
          '密码只存本机（0600 文件），不上传任何服务器；会话由插件自动续期，不必反复登录。'))
      }
      if (stepAccMsg) {
        mgmt.push(React.createElement('div', {
          className: 'dsh-mb-cookie-msg' + (stepAccMsg.ok ? '' : ' err'), key: 'msg',
        }, stepAccMsg.text))
      }

      // 单个账号的展开明细（原「用量」页签主体：近 7 日 Credit 柱条）
      const renderDetail = (d) => {
        if (!d) return null
        const rows = []
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
        const dayLabel = (x) => (x.dt.getMonth() + 1) + '-' + x.dt.getDate()
        if (picked.length > 0) {
          // 真近 7 日：最早一条仍在 7×24h 内；否则是「最近 7 个有记录日」，不得冒充近 7 日
          const stale = picked[0].dt.getTime() < Date.now() - 7 * 86400000
          const cells = picked.map((x) => ({ label: dayLabel(x), v: x.v }))
          const max = Math.max(1, ...cells.map((x) => x.v))
          rows.push(React.createElement('div', { className: 'dsh-mb-day-title', key: 'dt' },
            stale ? 'Credit 消耗（最近 7 个有记录日）' : '近 7 日 Credit 消耗'),
            stale ? React.createElement('div', { className: 'dsh-mb-hint', key: 'dh' },
              '最早记录 ' + dayLabel(picked[0]) + ' · 无调用的日子平台不留痕') : null,
            cells.map((x) => React.createElement('div', { key: x.label, className: 'dsh-mb-step-bar' },
              React.createElement('span', { className: 'dsh-mb-step-bar-d' }, x.label),
              React.createElement('span', { className: 'dsh-mb-step-bar-track' },
                React.createElement('span', { className: 'dsh-mb-step-bar-fill', style: { width: (x.v / max * 100) + '%' } })),
              React.createElement('span', { className: 'dsh-mb-step-bar-v', title: stepCreditTip(x.v) }, x.v > 0 ? fmtTokens(x.v) : ''))))
        } else if (d.usageError) {
          rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'ue' }, '用量明细暂不可用：' + d.usageError))
        } else {
          rows.push(React.createElement('div', { className: 'dsh-mb-day-title', key: 'dt' }, '近 7 日 Credit 消耗'),
            React.createElement('div', { className: 'dsh-mb-hint', key: 'dh' },
              '近 7 日暂无调用明细（通过 Studio / MCP 等通道的消耗平台不在此接口留痕）'))
        }
        // 明细里原有一组「类型 / 消耗 / 到期 / 续费」四项，用户要求整组下架：
        // 前两项与卡片主区重复或无意义，后两项本来就在 Credit 格次级行
        // 「套餐 tier · 到期 · 续费状态」里——同一数据在两处出现只是噪音。
        // dl 容器随之删除：空 grid 会在明细底部留一块说不清来源的留白。
        const partErrs = [d.statusError, d.creditError].filter(Boolean)
        if (partErrs.length > 0) rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'pe' }, '部分接口异常：' + partErrs[0]))
        if (d.bal && d.bal.ok === false) rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'be' }, '余额暂不可用：' + (d.bal.error || '未知错误')))
        return rows
      }

      const cards = accounts.map((a) => {
        const u = a.username
        const isCur = u === active
        const p = plans[u]
        const b = balances[u]
        const hasPlan = !!(p && p.ok !== false && (p.plan || p.credit))
        const hasBal = !!(b && b.ok !== false && b.account)
        const queried = hasPlan || hasBal
        const isBusy = busy[u] === true
        const open = stepOpen[u] === true
        const rows = []

        // 顶行：头像 + 账号名 + 胶囊角标 + 显示按钮 + 删除（两段式确认）
        const confirming = stepAccConfirm === u
        rows.push(React.createElement('div', { className: 'dsh-mb-stepacc-top', key: 'top' },
          React.createElement('span', { className: 'dsh-mb-stepacc-ava' }, '阶'),
          // 名字行只放「未查询」角标。「显示中」不在这里重复——右侧按钮位已经写着
          // 「显示中」，同一个词紧挨着出现两遍纯属噪音；显示态的观感由 .cur 的
          // 主色描边 + 淡底 + 左侧竖条承担。
          React.createElement('div', { className: 'dsh-mb-stepacc-id' },
            React.createElement('div', { className: 'dsh-mb-stepacc-name' }, u,
              // 密码胶囊：账号后面，默认打码，点一下才显明文（同一时刻只展开一个）
              React.createElement('button', {
                key: 'pw',
                className: 'dsh-mb-stepacc-pw' + (stepPwShown === u ? ' on' : ''),
                title: a.pwMask
                  ? (stepPwShown === u ? '点击隐藏密码' : '点击显示本机保存的密码')
                  : '这个账号没有保存密码（浏览器时代导入的旧数据）',
                disabled: !a.pwMask,
                onClick: () => revealStepPw(u),
              }, stepPwShown === u
                ? (stepPwVal === '' ? '（空密码）' : stepPwVal)
                : (a.pwMask || '未存密码')),
              queried ? null
                : React.createElement('span', {
                  className: 'dsh-mb-stepacc-unq',
                  title: '这个账号还没查过——点右上角「查询余额」，或卡片上的「查询此账号」',
                }, '未查询'))),
          isCur
            ? React.createElement('button', {
              className: 'dsh-mb-btn small ghost', disabled: true,
              title: '侧栏胶囊与主卡正显示这个账号',
            }, '显示中')
            : React.createElement('button', {
              className: 'dsh-mb-btn small',
              title: '让侧栏胶囊与主卡显示这个账号（各账号会话独立，不切换登录）',
              onClick: () => useStepAccount(u),
            }, '显示'),
          React.createElement('button', {
            className: 'dsh-mb-stepacc-x' + (confirming ? ' armed' : ''),
            title: confirming
              ? '再点一次确认删除（会话与缓存一起丢，不可恢复）'
              : '删除这个账号（会话与缓存一起丢，不可恢复）',
            onClick: () => removeStepAccount(u),
          }, confirming ? '确认' : '✕')))

        // kv 两格：账户余额（次级行=昨日消耗+现金/赠送）｜ Credit 月池（条 + 档位/到期/续费）
        const acct = hasBal ? b.account : null
        const cashSub = acct && Number.isFinite(acct.costYesterday)
          ? '昨日消耗 ¥' + fmtCny(acct.costYesterday)
            + (Number.isFinite(acct.totalCash) ? ' · 现金 ¥' + fmtCny(acct.totalCash) : '')
            + (Number.isFinite(acct.totalVoucher) ? ' 赠送 ¥' + fmtCny(acct.totalVoucher) : '')
          : null
        const credit = hasPlan && p.credit && p.credit.credits ? p.credit.credits : null
        const share = credit && credit.total > 0 ? Math.max(0, Math.min(1, credit.residual / credit.total)) : null
        const pct = share === null ? null : Math.round(share * 1000) / 10
        const creditTip = credit ? '剩余 ' + credit.residual.toLocaleString('en-US') + ' / 共 ' + credit.total.toLocaleString('en-US') + ' Credit' : ''
        // 月池重置时间：优先订阅月池总表 subscriptionResetAt，退化到 type=1 桶的 nextResetAt。
        // **读对对象**：上面的局部 `credit` 是 p.credit.credits（纯计数 {residual,used,total}），
        // 重置字段在 p.credit 上。曾经在这里读成 credit.subscriptionResetAt → 恒 undefined → 胶囊永远不出现。
        // 这个字段没有实测过（schema 注释说秒级，与 expired_at 同口径）。万一平台哪天改成毫秒，
        // 日期会被渲染成公元 5 万年——所以加合理性窗口 [今天-1年, 今天+3年]，窗口外一律不显示：
        // **宁可不显示，也不能显示一个错日期**。
        const pcl = hasPlan ? p.credit : null
        let resetRaw = null
        if (pcl && Number.isFinite(pcl.subscriptionResetAt) && pcl.subscriptionResetAt > 0) resetRaw = pcl.subscriptionResetAt
        else if (pcl && Array.isArray(pcl.buckets)) {
          const b1 = pcl.buckets.find((x) => x && x.type === 1 && Number.isFinite(x.nextResetAt) && x.nextResetAt > 0)
          if (b1) resetRaw = b1.nextResetAt
        }
        const nowS = Math.floor(Date.now() / 1000)
        const resetAt = (Number.isFinite(resetRaw) && resetRaw > nowS - 365 * 86400 && resetRaw <= nowS + 3 * 365 * 86400) ? resetRaw : null
        // 天数走日历日口径（0=今天、1=明天、负=已过），与 expiryDaysOf 一致。
        // 不能用 ceil：今晚就重置的情况会被算成「还剩 1 天」，那是撒谎。
        const rstDayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
        const resetDays = resetAt === null ? null : Math.round((rstDayStart(resetAt * 1000) - rstDayStart(Date.now())) / 86400000)
        const resetShort = resetAt === null ? null : fmtShortDate(resetAt)
        const resetChip = (queried && resetShort !== null)
          ? React.createElement('span', {
            className: 'dsh-mb-stepacc-rst', key: 'rst',
            title: 'Credit 月池将于 ' + fmtStepFull(resetAt) + ' 重置' + (resetDays === null || resetDays > 0
              ? (resetDays === null ? '' : '（还剩 ' + resetDays + ' 天）')
              : (resetDays === 0 ? '（今天重置）' : '（按缓存数据已过期）')),
          }, '↻ ' + resetShort + ' 重置')
          : null
        // 档位：只喂给档位水印，不再进 Credit 格次级行（那本来就是它的旧位置）。
        const tier = hasPlan && p.plan && p.plan.tier ? p.plan.tier : null
        // 档位水印元素，Credit 月池格的第一个子元素。**必须定义在 return 之前**：
        // createElement 当场求参，而 const 有 TDZ——定义在后面就是 ReferenceError
        // （本项目已踩过一次同型坑）。只在查过、且档位认得出来时才画：
        // 未查询的卡画个水印等于编数据。
        const tierCls = stepTierClass(tier)
        const watermark = (queried && tierCls !== null)
          ? React.createElement('span', {
            className: 'dsh-mb-stepacc-wm', key: 'wm',
            title: '套餐档位：' + tier,
          }, tier)
          : null
        // Credit 格次级行：只剩到期日。续费开关那一项整条下架——它是设置项不是用量
        // 信息，用户两次要求删它。到期也可能没有（平台没给 expired_at），
        // 此时次级行**不渲染**：留一行空高度 + margin 反而看着像没加载完。
        const exp = hasPlan && p.plan && p.plan.expireAt ? fmtStepDate(p.plan.expireAt) : null
        const planBits = []
        if (exp) planBits.push(exp + ' 到期')
        rows.push(React.createElement('div', { className: 'dsh-mb-stepacc-kv', key: 'kv' },
          React.createElement('div', { className: queried ? '' : 'dim' },
            React.createElement('span', { className: 'k' }, '账户余额'),
            React.createElement('span', { className: 'v' }, queried && acct && Number.isFinite(acct.balance) ? '¥' + fmtCny(acct.balance) : '—'),
            React.createElement('span', { className: 'sub' }, cashSub || (queried ? '' : '尚未查询'))),
          // Credit 格宽一档。首行做成「标签 + 右上角重置时间」：套餐信息都在这格里，
          // 重置时间放格子右上角，而不是塞进下面那行已经挤着的摘要。
          React.createElement('div', { className: 'wide' + (queried ? '' : ' dim') },
            watermark,
            React.createElement('div', { className: 'krow', key: 'krow' },
              React.createElement('span', { className: 'k' }, 'Credit 月池'),
              resetChip),
            React.createElement('span', { className: 'v', title: creditTip }, pct === null ? '—' : pct + '%'),
            React.createElement('span', { className: 'bar', title: creditTip },
              React.createElement('i', { style: { width: (share === null ? 0 : share * 100) + '%' } })),
            queried
              ? (planBits.length > 0
                ? React.createElement('span', { className: 'sub' }, planBits.join(' · '))
                : null)
              : React.createElement('span', { className: 'sub' }, '尚未查询 · 切换或点查询后显示'))))

        // 图例：Credit 细账（已用/共/加油包）
        const legend = []
        if (credit) {
          legend.push('已用 ' + fmtTokens(credit.used) + ' · 共 ' + fmtTokens(credit.total))
          if (hasPlan && p.credit && p.credit.hasTopup) {
            const tb = (p.credit.buckets || []).find((x) => x.type === 2)
            if (tb) legend.push('加油包 ' + fmtTokens(tb.residual) + (tb.expireAt ? ' · ' + (fmtStepDate(tb.expireAt) || '') + ' 到期' : ''))
          }
        }
        if (legend.length > 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-stepacc-legend', key: 'lg' },
            legend.map((t) => React.createElement('span', { key: t }, t))))
        }

        // 展开态明细
        // 脚行：展开/收起 · 数据时间 · 刷新
        const foot = []
        if (queried) foot.push(React.createElement('button', {
          className: 'dsh-mb-btn small ghost', key: 'tg',
          onClick: () => setStepOpen((cur) => ({ ...cur, [u]: !open })),
        }, open ? '收起 ▲' : '展开 ▼'))
        else foot.push(React.createElement('button', {
          className: 'dsh-mb-btn small ghost', key: 'q',
          disabled: isBusy, onClick: () => refreshStepAccount(u),
        }, isBusy ? '查询中…' : '查询此账号'))
        foot.push(React.createElement('span', { className: 'sp', key: 'sp' }))
        const at = hasPlan && p.fetchedAt ? fmtCheckedAt(p.fetchedAt) : (hasBal && b.cachedAt ? fmtCheckedAt(b.cachedAt) : null)
        if (at) foot.push(React.createElement('span', { className: 'dsh-mb-stepacc-meta', key: 'at' }, '数据时间 ' + at))
        foot.push(React.createElement('button', {
          className: 'dsh-mb-btn small ghost', key: 'rf',
          disabled: isBusy, onClick: () => refreshStepAccount(u),
        }, isBusy ? '…' : '刷新'))
        rows.push(React.createElement('div', { className: 'dsh-mb-stepacc-foot', key: 'ft' }, foot))

        // 明细图必须在「展开/收起」按钮**下面**：按钮是这张卡的收尾操作，明细是被它
        // 展开的内容，阅读顺序该是「先看到开关、再看到展开出来的东西」。
        // 原先 det 排在 ft 之前 push，明细图反而压在按钮上方——看着像按钮属于明细区。
        if (open && queried) {
          rows.push(React.createElement('div', { className: 'dsh-mb-stepacc-det', key: 'det' }, renderDetail({ ...p, bal: b })))
        }

        // 单账号查询失败（缓存槽里存了 ok:false）→ 提示但不遮罩整卡
        const failNote = (p && p.ok === false) || (b && b.ok === false)
          ? ((p && p.error) || (b && b.error) || '查询失败') : null

        return React.createElement('div', {
          className: 'dsh-mb-stepacc' + (isCur ? ' cur' : '') + (queried ? '' : ' dim')
            + (tierCls === null ? '' : ' ' + tierCls),
          key: u,
        }, rows, failNote
          ? React.createElement('div', { className: 'dsh-mb-hint', key: 'fn' }, failNote) : null)
      })

      const tail = []
      // 会话按账号分槽且落盘：已登录过的账号复用本地会话、不发登录请求，
      // 只有缺会话的账号才会登一次（30 秒一次重登是自家的防连点护栏，不是平台限制）。
      const total = accounts.length
      const doneN = (stepAccs && Array.isArray(stepAccs.done)) ? stepAccs.done.length : 0
      if (accDetailBusy) {
        tail.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'pg' },
          '正在查询全部账号… ' + doneN + ' / ' + total + (doneN < total ? '（会话已失效的账号需重新登录一次，其余直接复用）' : '')))
      }
      tail.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'h' },
        '各账号会话独立保存，登过一次即可长期复用；打开面板会自动补齐全部账号——会话齐了之后并发查询，不用逐个等。'))
      if (stepAccs.aborted) tail.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'ab' }, stepAccs.aborted.error || '查询被中止'))
      // 底部不再放「刷新」/「查询全部账号」：
      //   · 刷新是纯读 host 本地缓存（零网络），点它数字不会变，用户只会以为坏了；
      //   · 它该做的事 60s 自动轮询已经在干，手动点最多早几秒看到同一份缓存；
      //   · 和卡片脚行那个真查单账号的「刷新」同名不同义，纯属误导。
      // 主动作收敛成一个「查询余额」，放在顶部右侧（账号多时要滚动，不该沉到底部）。
      // 增删 UI 在最前：账号多时要滚动，添加/删除入口不该被挤到列表末尾
      return React.createElement('div', { className: 'dsh-mb-section' }, mgmt.concat(cards).concat(tail))
    }

    // ---- 阶跃「接口密钥」页签（与设置页阶跃卡共用同一套 inner UI）----
    function renderStepKeysTab({ stepKeys, stepKeyName, setStepKeyName, stepKeyBusy, stepKeyMsg, stepKeyCreated, stepKeyCopied, stepKeyConfirm, createStepKey, copyStepCreatedKey, copyStepKey, deleteStepKey, loadStepKeys }) {
      const rows = []
      rows.push(React.createElement('div', { className: 'dsh-mb-key-create', key: 'create' },
        React.createElement('input', {
          className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
          type: 'text',
          maxLength: 20,
          autoComplete: 'off',
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
    function renderSettingsTab({ manifest, sessionConfigured, sessionAccount, cookieInput, setCookieInput, cookieBusy, cookieMsg, saveCookie, accounts, addAcc, setAddAcc, addPw, setAddPw, showAddPw, setShowAddPw, accBusy, accMsg, addAccount, removeAccount, loginStored, showAccPw, setShowAccPw, showBackup, setShowBackup, updInfo, updBusy, loadUpdate, copyUpdateCmd, updCopied, ignoreUpdate, entryMode, setEntryBalance, zcEnabled, setZcodeEnabled, settingsTab, setSettingsTab, stepCfg, setStepEntryPref }) {
      // 分组页签：设置卡按「账号 / 胶囊 / ZCode / 关于」归类，避免一长条。
      // 阶跃分组只在该配置了账号时出现——那一组现在只剩「接管时胶囊显示」（接管本身是固定
      // 行为，已无可选项），没配阶跃就是一个空页，不如不摆这个页签。
      const settingsTabs = [['tr', '基元']]
        .concat(stepCfg && stepCfg.configured ? [['step', '阶跃']] : [])
        .concat([['zcode', 'ZCode'], ['about', '关于']])
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
        ] : []),
        // 阶跃分组只留「胶囊接管时显示什么」（见下面 pillstep 卡）。原来这里还有几张卡，
        // 均按用户要求删除（2026-10-01）：
        //   · 会话状态卡（「当前会话 / 已登录 · sess_…」）——会话由插件自动续期，不需要看；
        //   · 「阶跃账号（Step Plan）」卡与「去「账户」页签管理账号」按钮——账号增删本来就在
        //     面板「账户」页签，不需要一张说明卡把人再指过去一遍（连弹窗内文案一起删）。
        ...(settingsTab === 'tr' ? [
        // 备用粘贴（默认折叠）
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'backup' },
          React.createElement('button', {
            className: 'dsh-mb-toggle',
            onClick: () => setShowBackup(!showBackup),
          }, (showBackup ? '▾ ' : '▸ ') + '备用：手动粘贴登录凭证'),
          showBackup
            ? React.createElement('div', { className: 'dsh-mb-section' },
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
        // 「接管 / 不接管」那行已按用户要求删除（2026-10-01）——**接管是唯一行为**，
        // 没有可选项就没必要摆两个按钮；历史存档里的 takeover:false 也不再被采纳
        // （见 recomputeStepEntry）。这里只留「接管时胶囊显示什么」。
        // 未配置阶跃时整卡不渲染：没有数据可显示，摆一张空卡只会增加噪音。
        stepCfg && stepCfg.configured ? React.createElement('div', { className: 'dsh-mb-set-card', key: 'pillstep' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '胶囊接管（阶跃）'),
          React.createElement('div', { className: 'dsh-mb-seg-line', key: 'spmode' },
            React.createElement('span', { className: 'dsh-mb-seg-desc' }, '阶跃接管时胶囊显示'),
            React.createElement('span', { className: 'dsh-mb-seg-row' },
              [['auto', '自动'], ['credits', 'Credit 剩余'], ['balance', 'API 余额']].map(([m, label]) =>
                React.createElement('button', {
                  key: m,
                  className: 'dsh-mb-cat' + (((stepCfg.prefs && stepCfg.prefs.mode) || 'auto') === m ? ' active' : ''),
                  onClick: () => setStepEntryPref({ mode: m }),
                }, label)),
            )),
        ) : null,
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

    // ---- 输入行按钮：压缩上下文（/compact）与计划模式（/plan、/plan off）----
    // 挂 conversation.input.right：该槽是 list、当前无官方占用，且与模型选择器同处一个 flex
    // 组、DOM 在它之前 → 渲染出来正好在「对话模型」左边。owner 在轮次进行中会把整组（含模型
    // 选择器）一起隐藏，本按钮随之同进同退，与官方控件行为一致。
    // 计划状态读宿主投影 plan（{active,pending}，宿主折叠值，非客户端乐观态）——与官方 PlanChip
    // 同一数据源；投影不存在（没挂 plan-mode 包）时计划按钮不渲染，不摆一个必然报错的按钮。
    // 命令结果形状（api-gateway 契约）：ok:false = 网关/查找失败；value === undefined = 命令未
    // 挂载或行不合法；value.result.kind === 'error' = 业务失败（busy/cancelled 等，文案固定）；
    // 否则成功文案在 value.result.text。
    // ---- 输入行图标：路径数据取自 DSH 官方原语（IconCompactOutline / IconListPenOutline，
    // 16×16 网格），在本插件里自包含渲染以保持零依赖，观感与官方输入行控件一致。----
    function IconCompact({ size }) {
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
        strokeWidth: 1, strokeLinecap: 'round',
      },
        React.createElement('path', {
          opacity: 0.35, stroke: 'currentColor',
          d: 'M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5'
            + 'C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z',
        }),
        React.createElement('path', {
          stroke: 'currentColor',
          d: 'M8 1.5C8.85359 1.5 9.69883 1.66813 10.4874 1.99478C11.2761 2.32144 11.9926 2.80022'
            + ' 12.5962 3.40381C13.1998 4.00739 13.6786 4.72394 14.0052 5.51256C14.3319 6.30117 14.5 7.14641 14.5 8',
        }))
    }
    function IconPlan({ size }) {
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true',
      },
        React.createElement('path', { stroke: 'currentColor', strokeLinecap: 'round', d: 'M4.9375 5.90295H11.0625' }),
        React.createElement('path', { stroke: 'currentColor', strokeLinecap: 'round', d: 'M4.9375 9.02991H8.27841' }),
        React.createElement('path', {
          fill: 'currentColor',
          d: 'M12.5 1.32617C13.3039 1.32617 14 1.95171 14 2.77637V7.61328L13 8.68164V2.77637'
            + 'C13 2.55186 12.8007 2.32617 12.5 2.32617H3.5C3.1993 2.32617 3 2.55186 3 2.77637V13.2246'
            + 'C3.00044 13.4489 3.19963 13.6738 3.5 13.6738H8.32812L7.39258 14.6738H3.5'
            + 'C2.69637 14.6738 2.00042 14.0489 2 13.2246V2.77637C2 1.95171 2.69613 1.32617 3.5 1.32617H12.5Z',
        }),
        React.createElement('path', {
          fill: 'currentColor',
          d: 'M8.97212 14.3693C9.17511 14.5723 9.37811 14.7753 9.5811 14.9783C9.67012 14.8953 9.75914 14.8123'
            + ' 9.84815 14.7293C11.4505 13.2352 13.0528 11.7411 14.6551 10.247C14.7441 10.164 14.8331 10.081 14.9221 9.99803'
            + 'C14.5989 9.6748 14.2756 9.35157 13.9524 9.02834C13.8694 9.11736 13.7864 9.20637 13.7034 9.29539'
            + 'C12.2093 10.8977 10.7152 12.5 9.22113 14.1023C9.13813 14.1913 9.05513 14.2803 8.97212 14.3693Z',
        }),
        React.createElement('path', {
          fill: 'currentColor',
          d: 'M11.6323 13.7841C11.6323 14.0395 11.6323 14.295 11.6323 14.5504C11.6812 14.5523 11.7301 14.5543'
            + ' 11.779 14.5562C12.659 14.5913 13.539 14.6263 14.419 14.6614C14.4679 14.6633 14.5168 14.6653 14.5657 14.6672'
            + 'C14.5657 14.3339 14.5657 14.0006 14.5657 13.6672C14.5168 13.6692 14.4679 13.6711 14.419 13.6731'
            + 'C13.539 13.7081 12.659 13.7432 11.779 13.7783C11.7301 13.7802 11.6812 13.7821 11.6323 13.7841Z',
        }))
    }

    function ComposerActions({ sessionId, useProjection, useSession, execute }) {
      const proj = (key) => (typeof useProjection === 'function' ? useProjection(key) : undefined)
      const plan = proj('plan')
      const active = plan === null || plan === undefined ? null : (plan.pending ? !plan.active : plan.active)
      // 「对话正在跑」：用 DSH 自己的判据（InputBar 取的就是会话快照的 running），
      // 轮次进行中禁用压缩——平台此时一定拒绝 /compact（活动中的压缩 / 非空闲 agent），
      // 给一个点了必然失败的按钮没有意义。
      const running = typeof useSession === 'function' ? (useSession((s) => s && s.running) ?? false) : false
      // 上下文占用：照官方 ContextMeter 的口径 (projectedTokens ?? pressureTokens) / contextWindow，
      // 超 60% 就把压缩按钮标红——「上下文该压一压了」这件事只有这个按钮能回答。
      const pressure = proj('contextPressure')
      const usedPct = (function () {
        if (pressure === null || pressure === undefined) return null
        // 与官方同口径的 ??（null 也回退，不只是 undefined）：投影字段「未知」时给的是 null
        const projected = pressure.projectedTokens
        const used = projected === undefined || projected === null ? pressure.pressureTokens : projected
        if (used === undefined || used === null || !(pressure.contextWindow > 0)) return null
        return Math.min(100, Math.round(used / pressure.contextWindow * 100))
      })()
      const compactAlert = usedPct !== null && usedPct > 60
      const [busy, setBusy] = useState(null)
      // 失败信息只进按钮 tooltip：用户要求输入行一个文字都不显示（原先压缩按钮旁的
      // 「压缩中…／结果／报错」回显行已整条去掉，自动消失的计时器随之删除）。
      const [planErr, setPlanErr] = useState(null)
      const [compactErr, setCompactErr] = useState(null)
      // 失败的非文字反馈：用户要求输入行不出文字，但「点了毫无反应」会让人以为按钮坏了
      // （实测踩过）。失败时图标短暂转红、原因仍写在 tooltip 里，6 秒后自动恢复。
      const [failed, setFailed] = useState(null)
      const sessionRef = useRef(sessionId)
      sessionRef.current = sessionId
      useEffect(() => {
        if (failed === null) return undefined
        const timer = setTimeout(() => setFailed(null), 6000)
        return () => clearTimeout(timer)
      }, [failed])
      const messageOf = (r) => {
        if (r === null || r === undefined || typeof r !== 'object') return { text: '命令未返回结果', ok: false }
        if (r.ok === false) return { text: (r.error && (r.error.message || r.error.code)) || '命令执行失败', ok: false }
        if (r.value === undefined) return { text: '当前配置未挂载该命令', ok: false }
        const res = r.value.result
        if (res === undefined || res === null) return { text: '命令未返回结果', ok: false }
        if (res.kind === 'error') return { text: res.text || '命令执行失败', ok: false }
        return { text: res.text || '已执行', ok: true }
      }
      // 界面一条提示都不出（用户要求）：成功静默，失败只写进对应按钮的 tooltip。
      const run = (line, which) => async () => {
        if (busy !== null) return
        setBusy(which)
        const setErr = which === 'plan' ? setPlanErr : setCompactErr
        setErr(null)
        try {
          const r = await execute(sessionId, line)
          if (sessionRef.current !== sessionId) return // 执行期间切了会话 → 丢弃这次结果，防串会话
          const m = messageOf(r)
          if (!m.ok) { setErr(m.text); setFailed({ which, at: Date.now() }); return }
          setFailed(null)
        } catch (err) {
          if (sessionRef.current !== sessionId) return
          setErr(String((err && err.message) || err))
          setFailed({ which, at: Date.now() })
        } finally {
          if (sessionRef.current === sessionId) setBusy(null)
        }
      }
      // 只放图标（路径与官方输入行控件同源）：文案全在 aria-label / title 上。
      // 顺序按用户要求：计划在左、压缩在右（压缩紧邻模型选择器）。
      const failCls = (which) => (failed !== null && failed.which === which ? ' failed' : '')
      const buttons = []
      if (active !== null) {
        buttons.push(React.createElement('button', {
          key: 'plan',
          type: 'button',
          className: 'dsh-mb-cbtn' + (active ? ' on' : '') + (busy === 'plan' ? ' busy' : '') + failCls('plan'),
          disabled: busy !== null,
          'aria-pressed': active,
          'aria-label': active ? '退出计划模式' : '进入计划模式',
          title: (active
            ? '计划模式已开启 —— 点击退出（/plan off）'
            : '进入计划模式（/plan）：先勘察、出方案，经你评审后再动手')
            + (planErr === null ? '' : ' · 上次失败：' + planErr),
          onClick: run(active ? '/plan off' : '/plan', 'plan'),
        }, React.createElement(IconPlan, { size: 14 })))
      }
      buttons.push(React.createElement('button', {
        key: 'compact',
        type: 'button',
        className: 'dsh-mb-cbtn' + (compactAlert ? ' alert' : '') + (busy === 'compact' ? ' busy' : '') + failCls('compact'),
        // 轮次进行中一并禁用：那时平台一定拒绝 /compact，按钮不该可点
        disabled: busy !== null || running,
        'aria-label': '压缩上下文',
        title: '压缩上下文（/compact）：把较早的对话历史替换为一条摘要，不消耗模型轮次；'
          + '轮次进行中或已有压缩在跑时不可用'
          + (usedPct === null ? '' : ' · 当前上下文已用 ' + usedPct + '%')
          + (compactErr === null ? '' : ' · 上次失败：' + compactErr),
        onClick: run('/compact', 'compact'),
      }, React.createElement(IconCompact, { size: 14 })))
      // 只有按钮，没有任何文字节点（用户要求：输入行不出文字）
      return React.createElement('span', { className: 'dsh-mb-composer' }, buttons)
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

      // ---- 快捷键呼出/收起面板 ----
      // 走 DSH 官方的 shortcuts 服务：命令会自动列进「设置 → 快捷键」，用户可自行
      // 改键，无需自己造一套键位配置界面。默认 Ctrl+J（macOS Cmd+J）。
      // 桌面与 web 故意不同键：浏览器端只放行少数单修饰键组合（Comma/Backslash/
      // Backquote 或 Slash、Comma+shift、Period+shift），Ctrl+J 在浏览器里是
      // 「下载」故不被承认——照 DSH 自家 sidebar.left.toggle 的口径，桌面给
      // primary、web 给 primary+alt。
      //
      // 必须用 ctx.inject 而不是 ctx.get：ctx.get 是「此刻读一次」，本插件 apply
      // 往往跑得比 shortcuts 插件激活更早，只会拿到 undefined 然后静默跳过——
      // 快捷键莫名其妙不生效且毫无提示（实测踩过）。ctx.inject 让 cordis 把这个
      // 子插件挂起等服务就绪，shortcuts 上线时 notify() 会重估并激活它；profile
      // 里没有 shortcuts 服务时子插件一直不激活，面板本身不受影响。
      // 这也是 DSH 官方给的做法：可选服务放 inject / ctx.inject，缺服务的 profile
      // 里插件保持 inactive 而不是抛错。
      ctx.inject(['shortcuts'], (scope) => {
        scope.effect(() => {
          let off = null;
          try {
            off = scope.shortcuts.register({
              id: 'tokenrhythm-bill.toggle',
              label: () => '费用中心',
              aliases: ['tokenrhythm', '基元律动', '余额', '费用中心'],
              defaults: {
                'desktop:macos': { code: 'KeyJ', modifiers: ['primary'] },
                'desktop:windows': { code: 'KeyJ', modifiers: ['primary'] },
                'desktop:linux': { code: 'KeyJ', modifiers: ['primary'] },
                'web:macos': { code: 'KeyJ', modifiers: ['primary', 'alt'] },
                'web:windows': { code: 'KeyJ', modifiers: ['primary', 'alt'] },
                // web:linux 故意缺席：浏览器端在 linux 上 primary+alt 也不被承认，
                // 硬塞默认值会让 register 抛「Reserved shortcut default」。
                // 缺席只是该 profile 默认没键，用户在设置里自己绑即可（一方缺席
                // 不影响其它 profile，DSH 自家插件也是这么给的）。
              },
              regions: ['page', 'editable'],
              modals: [],
              resolve: ({ modal }) => {
                // 有模态开着时不动作：面板是浮层，藏在模态后面开合只会像快捷键失灵
                if (modal !== null && modal !== undefined) return { status: 'blocked', reason: 'modal' };
                return { status: 'handled', run: () => setStore({ open: !store.open }) };
              },
            });
          } catch { off = null; } // 重复 id / 默认键撞车 → 只是没有快捷键
          return () => { if (off !== null) off(); };
        }, 'tokenrhythm-bill: toggle shortcut');
      });

      // ---- 输入行按钮：压缩上下文 / 计划模式 ----
      // 整块放在可选依赖里：命令桥缺失的 profile 里子插件保持 inactive，**面板本身照常工作**。
      // 若写进顶层 inject 数组，缺服务会让整个插件不激活（余额面板一起消失）——与上面
      // shortcuts 的处理同口径。
      ctx.inject(['remote', 'remote.commands'], (scope) => {
        scope.effect(() => slots.inject('conversation.input.right', () => slots.register(
          { name: 'conversation.input.right', id: 'tokenrhythm-bill-composer', order: 100 },
          // 命令桥契约（只面向桌面端 DSH 2.0.x）：commands/execute 是
          // (agentId, line, submittedAttachments) **三个**业务参数，之后才是可选的取消信号
          // （AbortSignal）。第三个参数是「本次提交的附件」，按钮调用没有附件 → 传 []。
          // 少传会在**发出 RPC 之前**被客户端网关拦下并抛错（实测：
          // 「client api: commands/execute expected 3 business argument(s) …, got 2」），
          // 表现为「按钮点了没反应」——所以这三位一个都不能省，也绝不能靠猜。
          // 用箭头包一层而不是直接传 scope.remote.commands.execute：保住方法接收者（this）。
          (props) => React.createElement(ComposerActions, {
            ...props,
            execute: (sid, line) => scope.remote.commands.execute(sid, line, []),
          }),
        )), 'tokenrhythm-bill: composer actions');
      });

      // ---- 隐藏 /plan 在对话里的命令结果行 ----
      // 那两句「Plan mode on. Use /plan off to leave.」「Plan mode off.」是计划模式命令的**返回
      // 值文本**，DSH 会把命令运行渲染成一行（conversation.chat.commandview，按命令名分派）。
      // 该槽是 keyed、当前所有键都无人占用、replaceRisk 为 none：占住 'plan' 键渲染空，这一行
      // 就不再出现；按钮自己靠图标高亮（on）表达当前状态，界面一条文字都不出。
      // 只藏 plan——/compact 的结果（压缩了多少条历史、省了多少 token）是有效信息，保留。
      // 不在这里做「隐藏模式切换通知行」：那是 DSH 自己按 notice 形式写入的用户消息，其 DOM 钩子
      // 被 8 种 notice（模型切换、子代理完成、任务/目标、webhook、工具提醒…）共用，客户端无法只挑
      // 计划模式那一种隐藏，见 README 的说明。
      ctx.effect(() => slots.inject('conversation.chat.commandview', () => slots.register(
        { name: 'conversation.chat.commandview', key: 'plan' },
        () => null,
      )), 'tokenrhythm-bill: hide plan command row');
    }

    exports.apply = apply;
    exports.inject = inject;

    // ---- CSS：全量挂 DSH 设计令牌（--dsw-alias-* / --ds-*，由 dsh-client-ui-theme 定义在
    // body 上），明暗主题经 body[data-ds-dark-theme] 自动跟随；不再有本地配色主题。
    // --mb-* 只是短别名桥接层，var() 第二参为令牌缺失时的保守回退。 ----
    const PANEL_CSS = `
      /* .dsh-mb-hov（入口的 fixed 悬浮卡）与 .dsh-mb-composer（对话输入行里的按钮）
       * 都不在面板子树内，必须自己挂变量桥接层，否则 var(--mb-panelBg) 等解析为空
       * → 背景透明。 */
      .dsh-mb-panel,.dsh-mb-entry,.dsh-mb-hov,.dsh-mb-composer{
        --mb-font:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",Helvetica,Arial,sans-serif);
        --mb-codeFont:var(--ds-font-family-code,"SF Mono","JetBrains Mono","Fira Code",Consolas,"Liberation Mono",Menlo,Courier,"PingFang SC","Microsoft YaHei",monospace);
        --mb-panelBg:var(--dsw-alias-bg-layer-2,#fff);
        --mb-line:var(--dsw-alias-border-l2,rgba(0,0,0,.102));
        --mb-lineSoft:var(--dsw-alias-border-l1,rgba(0,0,0,.039));
        --mb-soft:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.059));
        --mb-softAccent:var(--dsw-alias-interactive-bg-hover-accent,rgba(38,49,72,.14));
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
        /* ---- 排版刻度：6 正文档 + 2 展示档 + 1 图标档 + 1 锁定档 ----
         * 面板基准字号就是 strong（.dsh-mb-panel 继承它）。曾整体下移 1px（13→12）实测偏小，
         * 已回到 13px 基准——以后要调字号，改这里的一个数字即可全站生效。
         * micro 徽章/日历格 · meta hint · body 正文 · strong 面板基准与卡主行 · title 标题
         * sub hero 副值 · hero 主数值 · wm 档位水印（仅阶跃卡） · ICON rail 入口图标尺寸
         * entry 侧栏入口行：镜像 DSH 原生设置行的行几何，字号锁 14px，不参与正文刻度收缩。 */
        --mb-fs-micro:10px;
        --mb-fs-meta:11px;
        --mb-fs-body:12px;
        --mb-fs-strong:13px;
        --mb-fs-title:14px;
        --mb-fs-sub:20px;
        --mb-fs-hero:28px;
        --mb-fs-wm:52px;
        --mb-icon-lg:18px;
        --mb-entry-fs:14px;
        --mb-lh-body:1.5;
        /* ---- 间距刻度：4 档全局节奏 + 1 档密集卡内部紧凑档 ----
         * 全局：1 紧凑 4 / 2 默认 8 / 3 卡片内距 12 / 4 区块内距 16。
         * tight 6px 只给信息密度高的卡片内部用（模型卡的徽章间距、副行间隙等）：
         * 用 8px 会把 240px 宽的卡撑得发散，用 4px 又挤在一起。 */
        --mb-sp-1:4px;
        --mb-sp-tight:6px;
        --mb-sp-2:8px;
        --mb-sp-3:12px;
        --mb-sp-4:16px;
        /* ---- 圆角刻度：4 档 + 胶囊。轨道圆角由「内块 + 轨道内边距」派生，
         * 改内块圆角时轨道自动跟随，不再出现内外失配。 ---- */
        --mb-r-xs:6px;
        --mb-r-ctl:8px;
        --mb-r-track:calc(var(--mb-r-ctl) + var(--mb-sp-1));
        --mb-r-card:12px;
        --mb-r-shell:16px;
        --mb-r-pill:999px;
        /* ---- 模型卡锁定组（用户指定：这张卡保持原设计，不随全局刻度改）----
         * 模型页是面板里信息密度最高的一屏，原设计的密度比全局刻度细一档：
         * 字号 13.5 / 10.5 / 11.5，内距 10×12，胶囊内距 7px，副行上距 1px，
         * 明细单栏逐行（行距走 6px 紧凑档）。全局字号调档、间距归位都不波及它。
         * min-w 是网格轨道下限（用户指定：**默认宽度下一行放 3 张模型卡**）：
         * 列数 = floor((面板宽 − 34 描边内距 + 8) ÷ (min-w + 8))，190 → 面板 660（新默认）
         * 与 661（老存档宽度）都正好 3 列，拖到 ≥818 才自然变 4 列，<620 回落 2 列、<422 单列。 */
        --mb-mc-name-fs:13.5px;
        --mb-mc-sub-fs:10.5px;
        --mb-mc-dd-fs:11.5px;
        --mb-mc-old-fs:10.5px;
        --mb-mc-pad-y:10px;
        --mb-mc-pad-x:12px;
        --mb-mc-pill-px:7px;
        --mb-mc-sub-top:1px;
        --mb-mc-min-w:190px;
        /* ---- 层次 / 焦点环 / 禁用透明度 ---- */
        --mb-el-raised:var(--dsw-shadow-lv1,0 1px 2px rgba(0,0,0,.06));
        --mb-el-hover:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,.16));
        --mb-el-float:var(--dsw-shadow-lv3,0 24px 64px color-mix(in srgb, #000 38%, transparent));
        --mb-ring:0 0 0 3px color-mix(in srgb, var(--mb-acc) 24%, transparent);
        --mb-op-off:.45;
        --mb-dur:var(--ds-transition-duration,.2s);
      }

      /* 侧栏入口：完整镜像原生「设置」触发行（SettingsRoot .trigger）的行几何：
       * calc(100%+4px) 行宽 + margin 左右 -2px 出血 + padding 0 10px 0 8px（图标起点
       * 12-2+8=18px 与设置行逐像素一致）。槽位包装层是 display:contents 不裁剪出血；
       * 外层 footerActions 是 flex 容器，必须 flex:none 防止 +4px 被 flex-shrink 收回
       * （设置行所在的 settingsArea 是普通 block，无此问题）。 */
      .dsh-mb-entry{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:var(--mb-sp-2);
        flex:none;width:calc(100% + 4px);min-width:0;height:42px;margin:4px -2px 0;padding:0 10px 0 8px;
        cursor:pointer;border:none;border-radius:var(--mb-r-card);text-align:left;
        background:transparent;color:var(--mb-txt);font-family:var(--mb-font);font-size:var(--mb-entry-fs);font-weight:400;line-height:22px;
        transition:background-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-entry:hover{background:var(--mb-soft)}
      .dsh-mb-entry.active{background:var(--mb-soft)}
      .dsh-mb-entry-icon{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px}
      .dsh-mb-entry-icon svg{display:block}
      .dsh-mb-dot{position:absolute;top:-2px;right:-3px;width:7px;height:7px;border-radius:50%;background:var(--mb-warn);
        box-shadow:0 0 0 2px color-mix(in srgb, var(--mb-warn) 30%, transparent)}
      .dsh-mb-entry-left{display:flex;align-items:center;gap:var(--mb-sp-2);min-width:0;flex:1 1 auto}
      .dsh-mb-entry-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsh-mb-entry-label.wide-in{animation:dsh-mb-wide-in var(--mb-dur) var(--mb-ease) backwards}
      .dsh-mb-entry-bal{margin-left:auto;flex:none;padding:3px 9px;border-radius:var(--mb-r-pill);font-variant-numeric:tabular-nums;
        color:var(--mb-acc);font-size:var(--mb-fs-body);font-weight:600;letter-spacing:.2px;white-space:nowrap;
        background:color-mix(in srgb,var(--mb-acc) 10%,transparent)}
      .dsh-mb-entry-bal.alert{color:var(--mb-warnTx);background:color-mix(in srgb,var(--mb-warn) 12%,transparent)}
      /* 入口悬浮卡：限时余额逐笔（金额 + N 天后失效）。fixed 定位贴视口、由 JS 按
       * 入口 rect 计算位置（宽态行上方右对齐 / rail 态同式，钳制在视口内）；
       * 进卡片不断链，移开 150ms 收起；整卡可点击打开面板。 */
      .dsh-mb-hov{position:fixed;z-index:10001;box-sizing:border-box;padding:var(--mb-sp-2) var(--mb-sp-3);
        background:var(--mb-panelBg);color:var(--mb-txt);font-family:var(--mb-font);
        border:1px solid var(--dsw-alias-border-inverted,rgba(0,0,0,.06));border-radius:var(--mb-r-card);
        box-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,.16));
        font-size:var(--mb-fs-body);line-height:var(--mb-lh-body);cursor:pointer;user-select:none;
        animation:dsh-mb-hov-in var(--mb-fast) var(--mb-ease)}
      @keyframes dsh-mb-hov-in{0%{opacity:0}}
      .dsh-mb-hov-head{font-weight:600;color:var(--mb-sub);margin-bottom:var(--mb-sp-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsh-mb-hov-item{display:flex;align-items:center;justify-content:space-between;gap:var(--mb-sp-3);padding:var(--mb-sp-1) 0;font-variant-numeric:tabular-nums}
      .dsh-mb-hov-amt{font-weight:600;font-size:var(--mb-fs-strong)}
      .dsh-mb-hov-days{color:var(--mb-sub);white-space:nowrap}
      .dsh-mb-hov-item.soon .dsh-mb-hov-amt{color:var(--mb-warnTx)}
      .dsh-mb-hov-item.soon .dsh-mb-hov-days{color:var(--mb-warnTx);font-weight:600}
      @keyframes dsh-mb-wide-in{0%{opacity:0}}
      /* rail（收起）形态：对齐设置触发行 rail（36×36 圆形、居中、图标 18px）。 */
      .dsh-mb-entry[data-wide="0"]{border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;min-width:0;padding:0;margin:8px auto 0}
      .dsh-mb-entry[data-wide="0"] .dsh-mb-entry-icon{width:18px;height:18px;font-size:var(--mb-icon-lg)}
      .dsh-mb-entry[data-wide="0"]:hover{background:var(--mb-soft)}
      /* 收起态绝不显示余额（JSX 已不渲染，这里兜底防溢出圆外）。 */
      .dsh-mb-entry[data-wide="0"] .dsh-mb-entry-bal{display:none}
      .dsh-mb-entry:not([data-wide]){container-type:inline-size}
      @container (max-width:60px){
        .dsh-mb-entry:not([data-wide]){border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0;margin:8px auto 0}
        .dsh-mb-entry:not([data-wide]) .dsh-mb-entry-icon{width:18px;height:18px;font-size:var(--mb-icon-lg)}
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
        border:1px solid var(--dsw-alias-border-inverted,rgba(0,0,0,.06));border-radius:var(--mb-r-shell);
        box-shadow:var(--mb-el-float);
        overflow:hidden;font-size:var(--mb-fs-strong);line-height:var(--mb-lh-body)}
      .dsh-mb-head{flex:none;display:flex;align-items:center;justify-content:space-between;height:44px;padding:0 var(--mb-sp-2) 0 var(--mb-sp-4);
        border-bottom:1px solid var(--mb-lineSoft);cursor:grab;user-select:none;touch-action:none}
      .dsh-mb-head:active{cursor:grabbing}
      .dsh-mb-head-title{font-weight:500;font-size:var(--mb-fs-title);letter-spacing:.2px;color:var(--mb-txt)}
      .dsh-mb-head-actions{display:flex;align-items:center;gap:var(--mb-sp-1)}
      /* 头部左侧组：原标题（任何模式保留）+ 提供商切换器（配好阶跃才出现，紧贴标题） */
      .dsh-mb-head-left{display:flex;align-items:center;gap:var(--mb-sp-2);min-width:0}
      /* 标题位提供商切换器（基元律动｜阶跃）：轨道段样式与页签条同语言，配好阶跃才顶替标题出现 */
      .dsh-mb-prov{display:flex;gap:var(--mb-sp-1);padding:var(--mb-sp-1);border-radius:var(--mb-r-track);background:var(--mb-soft)}
      .dsh-mb-prov-btn{border:none;background:transparent;cursor:pointer;padding:var(--mb-sp-1) var(--mb-sp-3);border-radius:var(--mb-r-ctl);
        color:var(--mb-sub);font-size:var(--mb-fs-body);font-weight:500;font-family:inherit;
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-prov-btn:hover{color:var(--mb-txt);background:var(--mb-softAccent)}
      .dsh-mb-prov-btn.active{color:var(--mb-txt);font-weight:600;background:var(--mb-panelBg);box-shadow:inset 0 0 0 1px var(--mb-line)}
      /* 阶跃「用量」：近 7 日 Credit 迷你柱条（横排版趋势柱，窄面板不出滚动条） */
      .dsh-mb-step-bar{display:flex;align-items:center;gap:var(--mb-sp-2);padding:var(--mb-sp-1) 0}
      .dsh-mb-step-bar-d{flex:none;width:40px;font-size:var(--mb-fs-meta);color:var(--mb-sub)}
      .dsh-mb-step-bar-track{flex:1;min-width:0;height:8px;border-radius:var(--mb-r-xs);background:var(--mb-soft);overflow:hidden}
      .dsh-mb-step-bar-fill{display:block;height:100%;background:var(--mb-warn);border-radius:var(--mb-r-xs)}
      .dsh-mb-step-bar-v{flex:none;min-width:46px;text-align:right;font-size:var(--mb-fs-meta);color:var(--mb-txt)}
      .dsh-mb-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;
        border:none;border-radius:var(--mb-r-ctl);background:transparent;cursor:pointer;color:var(--mb-sub);font-size:var(--mb-fs-title);
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-iconbtn:hover{background:var(--mb-soft);color:var(--mb-txt)}
      .dsh-mb-iconbtn.active{background:var(--mb-ghostFill);color:var(--mb-txt);box-shadow:inset 0 0 0 1px var(--mb-ghostLine)}
      /* 页签条：轨道用淡填充（DSH active 导航项的 ~6-8% 填充画法），激活页签用面板
       * 同色「凸起」+ border-l2 细描边，明暗两套主题都清晰。 */
      .dsh-mb-tabs{flex:none;display:flex;gap:var(--mb-sp-1);margin:var(--mb-sp-2) var(--mb-sp-4) 0;padding:var(--mb-sp-1);border-radius:var(--mb-r-track);
        background:var(--mb-soft)}
      /* 页签标签不许换行/撑爆：密钥页签会带账号（密钥（138****0001）），
         账号名再长也只能省略，不能把两格页签挤成三行。 */
      .dsh-mb-tab{flex:1;min-width:0;border:none;background:transparent;cursor:pointer;padding:var(--mb-sp-1) 0;border-radius:var(--mb-r-ctl);
        color:var(--mb-sub);font-size:var(--mb-fs-body);font-weight:500;font-family:inherit;
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-tab:hover{color:var(--mb-txt);
        background:var(--mb-softAccent)}
      .dsh-mb-tab.active{color:var(--mb-txt);font-weight:600;
        background:var(--mb-panelBg);box-shadow:inset 0 0 0 1px var(--mb-line)}
      .dsh-mb-body{flex:1;min-height:0;overflow-y:auto;padding:var(--mb-sp-2) var(--mb-sp-4) var(--mb-sp-4)}
      .dsh-mb-section{display:flex;flex-direction:column;gap:var(--mb-sp-2)}

      .dsh-mb-notice{padding:var(--mb-sp-4) var(--mb-sp-2);text-align:center;color:var(--mb-sub)}
      .dsh-mb-notice.err{color:var(--mb-err)}
      /* 加载骨架屏：与真实内容同构的 shimmer 占位（soft 底 + 文字色 8% 微光扫过，
       * 尊重系统减动效设置）。 */
      .dsh-mb-skel{position:relative;overflow:hidden;flex:none;height:12px;border-radius:var(--mb-r-xs);background:var(--mb-soft)}
      .dsh-mb-skel::after{content:"";position:absolute;inset:0;transform:translateX(-100%);
        background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--mb-txt) 8%,transparent),transparent);
        animation:dsh-mb-shimmer 1.4s var(--mb-ease) infinite}
      @keyframes dsh-mb-shimmer{100%{transform:translateX(100%)}}
      /* 骨架屏网格与真实网格同下限，加载态不跳列 */
      .dsh-mb-skel-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--mb-mc-min-w),1fr));gap:var(--mb-sp-2)}
      .dsh-mb-skel-card{display:flex;flex-direction:column;gap:var(--mb-sp-2);padding:var(--mb-sp-2) var(--mb-sp-3);
        border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-card)}
      .dsh-mb-skel-hero{display:flex;flex-direction:column;gap:var(--mb-sp-2);padding:var(--mb-sp-4) var(--mb-sp-4);
        border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-card);background:var(--mb-card)}
      .dsh-mb-skel-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:var(--mb-sp-2)}
      .dsh-mb-skel-kv-i{display:flex;flex-direction:column;gap:var(--mb-sp-2);padding:var(--mb-sp-2) var(--mb-sp-2);border-radius:var(--mb-r-card);
        background:var(--mb-card);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-skel-rows{display:flex;flex-direction:column;gap:var(--mb-sp-3);padding:var(--mb-sp-1) var(--mb-sp-1)}
      @media (prefers-reduced-motion:reduce){.dsh-mb-skel::after{animation:none}}
      .dsh-mb-banner{display:flex;align-items:center;gap:var(--mb-sp-1);padding:var(--mb-sp-2) var(--mb-sp-2);border-radius:var(--mb-r-card);font-size:var(--mb-fs-body);
        background:color-mix(in srgb, var(--mb-warn) 10%, transparent);
        border:1px solid color-mix(in srgb, var(--mb-warn) 35%, transparent);color:var(--mb-warnTx)}
      .dsh-mb-link{border:none;background:transparent;cursor:pointer;padding:0 var(--mb-sp-1);font-size:var(--mb-fs-body);font-weight:600;font-family:inherit;
        color:var(--mb-acc);text-decoration:underline}

      /* 分类筛选 chips：Pill 规格（h24/r12/12px），激活态 ghost 填充 + 内描边。 */
      /* 分类筛选行滚动固定：sticky 钉在滚动容器顶部。top/margin-top 各 -10px 抵消
       * body 的 padding-top，钉住时靠 14px 上内边距盖住原间隙——滚动内容不再从
       * 头部与筛选行之间透出。负 margin 铺满左右内边距并垫面板实色底；缓存标签
       * margin-left:auto 靠行最右，放不下时横向滚动（隐藏滚动条）。 */
      /* 负 margin 与 body 内距必须同源（同一组 --mb-sp-*），否则筛选行贴不满左右边缘 */
      .dsh-mb-cats{position:sticky;top:calc(-1 * var(--mb-sp-2));z-index:2;display:flex;flex-wrap:nowrap;align-items:center;gap:var(--mb-sp-2);
        margin:calc(-1 * var(--mb-sp-2)) calc(-1 * var(--mb-sp-4)) 0;padding:var(--mb-sp-4) var(--mb-sp-4) var(--mb-sp-2);background:var(--mb-panelBg);overflow-x:auto;scrollbar-width:none}
      .dsh-mb-cats::-webkit-scrollbar{display:none}
      .dsh-mb-cache-tag{flex:none;margin-left:auto;font-size:var(--mb-fs-meta);line-height:24px;padding:0 var(--mb-sp-2);border-radius:var(--mb-r-card);
        color:var(--mb-sub);background:var(--mb-soft)}
      .dsh-mb-cache-tag.stale{color:var(--mb-warnTx);background:color-mix(in srgb,var(--mb-warn) 12%,transparent)}
      .dsh-mb-cat{cursor:pointer;border:none;height:24px;display:inline-flex;align-items:center;border-radius:var(--mb-r-card);
        padding:0 var(--mb-sp-2);font-size:var(--mb-fs-body);line-height:18px;font-family:inherit;background:transparent;color:var(--mb-sub);
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      .dsh-mb-cat:hover{background:var(--mb-soft);color:var(--mb-txt)}
      /* 筛选 chip 的选中配方（全站唯一来源）：accent 浅底 + accent 文字 + accent 内描边。
       * 不用 ghost 灰填充——设置卡底色就是 --mb-soft，灰填充叠上去几乎看不见。 */
      .dsh-mb-cat.active{background:color-mix(in srgb,var(--mb-acc) 12%,transparent);
        color:var(--mb-acc);font-weight:600;box-shadow:inset 0 0 0 1px var(--mb-acc)}
      .dsh-mb-cat-count{opacity:.7;font-size:var(--mb-fs-meta);margin-left:var(--mb-sp-1);font-variant-numeric:tabular-nums}
      /* 轨道下限走模型卡锁定组的 --mb-mc-min-w（用户指定：默认宽度一行 3 张） */
      .dsh-mb-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--mb-mc-min-w),1fr));gap:var(--mb-sp-2)}
      /* 模型卡片：DSH 淡填充（interactive-bg-hover）+ 细描边 + shadow-lv1 抬升，
       * hover 加深到 accent 填充 + border-l2 + shadow-lv2，浅色下面板与卡片分离明显。 */
      /* ---- 卡片配方（三种，全站唯一来源）----
       * 静默数据卡（.dsh-mb-ckcard/.dsh-mb-kv/.dsh-mb-trend-wrap/.dsh-mb-wallet/.dsh-mb-cal-wrap/
       *   .dsh-mb-key-card/.dsh-mb-set-card/.dsh-mb-acc-row）：soft 底 + lineSoft 描边 + --mb-sp-3 内距；
       * 可点卡（.dsh-mb-card 模型卡 / .dsh-mb-stepacc 阶跃账号卡）= 浅灰 soft 填充 + --mb-el-raised
       *   ——**面板底层就是白（layer-2），任何卡都不能拿实底白当卡面**：与面板同色就只剩一根 4% 描边，
       *   看着「没有样式」——模型卡早已因此改 soft；阶跃账号卡原来是 card 实底白，浅色主题下用户
       *   直接反馈「没有颜色、看不出卡片边界」，现也一并改 soft：卡内两格随之反相（卡面 soft、
       *   格面 card 白，见 .dsh-mb-stepacc-kv>div），灰度差方向反过来、幅度不变，格子仍分得出。
       *   模型卡的内距/字号按「模型卡锁定组 --mb-mc-*」保持原设计，不走全局刻度；
       * 强调卡（.dsh-mb-hero / .dsh-mb-created）：accent 7% 底 + 25% 描边 + --mb-sp-4 内距。
       * 内距、圆角、描边一律走 --mb-sp-… / --mb-r-… / --mb-line… 令牌，不再逐处手写数值。
       * （注意：注释正文里绝不能出现「星号 + 斜杠」，那会提前闭合注释、把紧随其后的规则
       *   整个丢给解析器的错误恢复——模型卡「没有内边距」就是这么来的。） */
      /* 模型卡 = 「浅灰填充 + 投影」的可点卡，**不是**实底白色：面板底色就是
       * layer-2（白），卡片若也用 --mb-card 就与面板同色，一屏卡片看着「没有样式」。
       * 内距与卡内间隙走紧凑档，240px 最小卡宽下才不发散。 */
      .dsh-mb-card{padding:var(--mb-mc-pad-y) var(--mb-mc-pad-x);border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-card);
        background:var(--mb-soft);cursor:pointer;box-shadow:var(--mb-el-raised);
        transition:border-color var(--mb-fast) var(--mb-ease),background-color var(--mb-fast) var(--mb-ease),box-shadow var(--mb-fast) var(--mb-ease)}
      /* 折扣徽章：标题行最左（内容区左上角），实底绿渐变 + 白字醒目；
       * 行内排布随行高走，卡片布局零影响。 */
      .dsh-mb-card-disc{flex:none;margin-right:var(--mb-sp-tight);font-size:var(--mb-fs-micro);font-weight:700;line-height:16px;
        letter-spacing:1px;padding:0 var(--mb-sp-2);border-radius:var(--mb-r-xs);color:#fff;
        background:linear-gradient(135deg,color-mix(in srgb,var(--mb-ok) 78%,#000),var(--mb-ok));
        box-shadow:0 1px 3px color-mix(in srgb,var(--mb-ok) 35%,transparent)}
      /* 峰谷徽章：与折扣徽章并列同一行，用琥珀渐变区分语义（折扣=省钱 / 峰谷=分时计价）。
       * 同款行内排布，零布局影响；明细走原生 title，悬浮即见峰/谷两段价格。 */
      .dsh-mb-card-pv{flex:none;margin-right:var(--mb-sp-tight);font-size:var(--mb-fs-micro);font-weight:700;line-height:16px;
        letter-spacing:1px;padding:0 var(--mb-sp-2);border-radius:var(--mb-r-xs);color:#fff;cursor:help;
        background:linear-gradient(135deg,color-mix(in srgb,var(--mb-warn) 78%,#000),var(--mb-warn));
        box-shadow:0 1px 3px color-mix(in srgb,var(--mb-warn) 35%,transparent)}
      .dsh-mb-card:hover{border-color:var(--mb-line);
        background:var(--mb-softAccent);
        box-shadow:var(--mb-el-hover)}
      .dsh-mb-card.copied{border-color:var(--mb-ok)}
      .dsh-mb-copied{font-size:var(--mb-fs-micro);font-weight:600;color:var(--mb-ok)}
      .dsh-mb-hint{font-size:var(--mb-fs-meta);color:var(--mb-sub);text-align:center;opacity:.85}
      .dsh-mb-card-head{display:flex;align-items:center;justify-content:space-between;gap:var(--mb-sp-2)}
      .dsh-mb-card-name{flex:1 1 auto;min-width:0;font-weight:700;font-size:var(--mb-mc-name-fs);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt)}
      .dsh-mb-card-head-r{flex:none;display:inline-flex;align-items:center;gap:var(--mb-sp-tight)}
      /* 状态胶囊（官方 model-status-pill）：纯平台状态——在线=绿点 / 测试中=琥珀点，
       * 圆点颜色跟随胶囊色调（dotCls 由 pillCls 派生），无平台状态不渲染。 */
      .dsh-mb-card-status{flex:none;display:inline-flex;align-items:center;gap:var(--mb-sp-1);font-size:var(--mb-fs-micro);line-height:16px;
        padding:0 var(--mb-mc-pill-px);border-radius:var(--mb-r-ctl);background:var(--mb-soft);color:var(--mb-sub)}
      .dsh-mb-card-status-dot{width:6px;height:6px;border-radius:50%;background:var(--mb-tert)}
      .dsh-mb-card-status-dot.ok{background:var(--mb-ok)}
      .dsh-mb-card-status-dot.deg{background:var(--mb-warn)}
      .dsh-mb-card-status-dot.fail{background:var(--mb-err)}
      .dsh-mb-card-status.on{color:var(--mb-ok);background:color-mix(in srgb,var(--mb-ok) 12%,transparent)}
      .dsh-mb-card-status.testing{color:var(--mb-warnTx);background:color-mix(in srgb,var(--mb-warn) 12%,transparent)}
      .dsh-mb-card-status.err{color:var(--mb-err);background:color-mix(in srgb,var(--mb-err) 12%,transparent)}
      /* ---- 自定义检测（状态页签置顶卡）：控制行 + 模型 chips + 结果行 ---- */
      .dsh-mb-ckcard{border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-card);background:var(--mb-soft);
        padding:var(--mb-sp-3);margin-bottom:var(--mb-sp-2)}
      .dsh-mb-ck-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--mb-sp-2)}
      .dsh-mb-ck-title{font-weight:700;font-size:var(--mb-fs-strong);color:var(--mb-txt)}
      .dsh-mb-ck-sub{font-size:var(--mb-fs-meta);color:var(--mb-tert)}
      .dsh-mb-ck-ctl{display:flex;align-items:center;gap:var(--mb-sp-2);flex-wrap:wrap;margin-top:var(--mb-sp-2)}
      .dsh-mb-ck-run{border:1px solid var(--mb-line);border-radius:var(--mb-r-ctl);background:var(--mb-acc);color:#fff;
        font-family:inherit;font-size:var(--mb-fs-meta);font-weight:600;line-height:1;padding:var(--mb-sp-1) var(--mb-sp-2);cursor:pointer;
        transition:opacity var(--mb-fast) var(--mb-ease)}
      .dsh-mb-ck-run:hover{opacity:.88}
      .dsh-mb-ck-run.disabled{opacity:.45;cursor:default}
      .dsh-mb-ck-int{border:1px solid var(--mb-line);border-radius:var(--mb-r-ctl);background:var(--mb-soft);color:var(--mb-sub);
        font-family:inherit;font-size:var(--mb-fs-meta);line-height:1;padding:var(--mb-sp-1) var(--mb-sp-2);cursor:pointer}
      .dsh-mb-ck-next{font-size:var(--mb-fs-meta);color:var(--mb-sub);font-variant-numeric:tabular-nums}
      .dsh-mb-ck-count{margin-left:auto;font-size:var(--mb-fs-meta);color:var(--mb-sub);font-variant-numeric:tabular-nums}
      .dsh-mb-ck-chips{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:var(--mb-sp-2);margin-top:var(--mb-sp-2)}
      .dsh-mb-ck-chip{border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-card);background:transparent;color:var(--mb-sub);
        font-family:inherit;font-size:var(--mb-fs-meta);line-height:1;padding:var(--mb-sp-1) var(--mb-sp-2);cursor:pointer;min-width:0;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap;
        transition:background-color var(--mb-fast) var(--mb-ease),border-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-ck-chip.on{background:color-mix(in srgb,var(--mb-acc) 12%,transparent);border-color:var(--mb-acc);
        color:var(--mb-acc);font-weight:600}
      .dsh-mb-ck-empty{font-size:var(--mb-fs-meta);color:var(--mb-tert);grid-column:1 / -1}
      /* 检测结果：独立小节（虚线与上方 chips 隔开），每行一条：点 + 模型名 + 右侧状态。 */
      .dsh-mb-ck-results{display:flex;flex-direction:column;gap:var(--mb-sp-1);margin-top:var(--mb-sp-2);padding-top:var(--mb-sp-2);
        border-top:1px dashed var(--mb-lineSoft)}
      .dsh-mb-ck-results-hd{font-size:var(--mb-fs-micro);font-weight:600;letter-spacing:.5px;color:var(--mb-tert);margin-bottom:var(--mb-sp-1)}
      .dsh-mb-ck-res{display:flex;align-items:center;gap:var(--mb-sp-2);min-width:0;padding:var(--mb-sp-1) var(--mb-sp-2);border-radius:var(--mb-r-ctl);
        font-size:var(--mb-fs-meta);color:var(--mb-sub);transition:background-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-ck-res:hover{background:color-mix(in srgb,var(--mb-soft) 70%,transparent)}
      .dsh-mb-ck-res-id{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt)}
      .dsh-mb-ck-res-ms{flex:none;font-variant-numeric:tabular-nums;color:var(--mb-tert)}
      .dsh-mb-ck-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--mb-tert)}
      .dsh-mb-ck-dot.none{opacity:.5}
      .dsh-mb-ck-dot.ok{background:var(--mb-ok)}
      .dsh-mb-ck-dot.deg{background:var(--mb-warn)}
      .dsh-mb-ck-dot.fail{background:var(--mb-err)}
      .dsh-mb-ck-err{margin-top:var(--mb-sp-2);font-size:var(--mb-fs-meta);color:var(--mb-err)}
      .dsh-mb-card-sub{display:flex;align-items:center;justify-content:space-between;gap:var(--mb-sp-tight);font-size:var(--mb-mc-sub-fs);color:var(--mb-sub);overflow:hidden;margin-top:var(--mb-mc-sub-top)}
      .dsh-mb-card-id{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-card-src{flex:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* details：规格 + 价格两栏（官方 model-spec-list / model-price-list 布局）。 */
      /* 用户要求：明细字段不并排——单栏逐行；行间距统一走 6px 紧凑档 */
      .dsh-mb-card-details{margin-top:var(--mb-sp-2)}
      .dsh-mb-card-dl{margin:0;display:flex;flex-direction:column;gap:var(--mb-sp-tight)}
      .dsh-mb-card-dl > div{display:flex;align-items:baseline;justify-content:space-between;gap:var(--mb-sp-2)}
      .dsh-mb-card-dl dt{flex:none;color:var(--mb-sub);font-size:var(--mb-fs-meta)}
      .dsh-mb-card-dl dd{margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        font-weight:600;font-size:var(--mb-mc-dd-fs);text-align:right;color:var(--mb-txt);font-variant-numeric:tabular-nums}
      .dsh-mb-card-price-old{margin-right:var(--mb-sp-1);font-size:var(--mb-mc-old-fs);font-weight:500;color:var(--mb-tert);text-decoration:line-through}
      .dsh-mb-badge{font-size:var(--mb-fs-micro);padding:var(--mb-sp-1) var(--mb-sp-2);border-radius:var(--mb-r-xs);background:var(--mb-soft);color:var(--mb-sub)}
      .dsh-mb-badge.disc{color:var(--mb-ok)}
      .dsh-mb-badge.on{color:var(--mb-ok)}
      .dsh-mb-badge.off{color:var(--mb-tert)}

      /* 余额 hero：品牌蓝 7% 淡底 + 25% 描边（color-mix 跟随主题），数字纯色不再渐变。 */
      /* 余额主卡：品牌蓝淡底定位「钱」卡，双列统计（账户余额为主）+ 倒计时胶囊 +
       * 限时占比条；颜色全走令牌桥，明暗自动跟随。 */
      .dsh-mb-acct-line{display:flex;align-items:center;gap:var(--mb-sp-2);font-size:var(--mb-fs-meta);color:var(--mb-sub);padding:var(--mb-sp-1) var(--mb-sp-1) 0}
      .dsh-mb-acct-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--mb-ok)}
      .dsh-mb-acct-line.none .dsh-mb-acct-dot{background:var(--mb-warn)}
      .dsh-mb-hero{display:flex;flex-direction:column;gap:var(--mb-sp-2);padding:var(--mb-sp-4);border-radius:var(--mb-r-card);
        border:1px solid color-mix(in srgb, var(--mb-acc) 25%, transparent);
        background:color-mix(in srgb, var(--mb-acc) 7%, transparent)}
      .dsh-mb-hero-stats{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--mb-sp-4);flex-wrap:wrap}
      /* 主卡右侧的「量级组」：调用次数 + 总 Tokens 并排。窄面板下整组换行仍贴右，
       * 组内两个数各自右对齐（与单个数时的 .dsh-mb-stat.right 同一视觉语言）。 */
      .dsh-mb-hero-pair{display:flex;align-items:flex-start;justify-content:flex-end;gap:var(--mb-sp-4);
        margin-left:auto;min-width:0;flex-wrap:wrap}
      .dsh-mb-stat{display:flex;flex-direction:column;gap:var(--mb-sp-1);min-width:0}
      .dsh-mb-stat.right{align-items:flex-end;text-align:right}
      .dsh-mb-stat-k{font-size:var(--mb-fs-body);color:var(--mb-sub)}
      .dsh-mb-stat-v{font-size:var(--mb-fs-hero);font-weight:600;line-height:1.15;white-space:nowrap;
        font-variant-numeric:tabular-nums;color:var(--mb-txt)}
      .dsh-mb-stat.right .dsh-mb-stat-v{font-size:var(--mb-fs-sub)}
      .dsh-mb-hero-chip{display:inline-flex;align-items:center;margin-top:var(--mb-sp-1);padding:var(--mb-sp-1) var(--mb-sp-2);border-radius:var(--mb-r-pill);
        font-size:var(--mb-fs-meta);font-weight:600;line-height:16px;
        color:var(--mb-sub);background:var(--mb-soft)}
      .dsh-mb-hero-chip.soon{color:var(--mb-warnTx);
        background:color-mix(in srgb, var(--mb-warn) 12%, transparent)}
      /* 占比条两条配方：
         · 基元余额（.limited，用户指定配色）：**两段语义**——蓝底（= 非限时额度，余额里不会
           过期的那部分）+ 右端橙段（= 限时额度，会到期失效的那部分）。限时必须在右边，
           所以用 justify-content:flex-end 把填充段推到右端，左侧余下的就是蓝底。
         · 其余（ZCode 的「已用 %」等）：中性配方，**不出现橙色**——灰轨道 + 主题蓝填充。 */
      .dsh-mb-hero-bar{display:flex;height:6px;border-radius:var(--mb-r-xs);overflow:hidden;
        background:color-mix(in srgb, var(--mb-sub) 18%, transparent)}
      .dsh-mb-hero-bar-fill{height:100%;min-width:2px;background:var(--mb-acc)}
      .dsh-mb-hero-bar.limited{justify-content:flex-end;background:var(--mb-acc)}
      .dsh-mb-hero-bar.limited .dsh-mb-hero-bar-fill{background:var(--mb-warn)}
      .dsh-mb-hero-legend{display:flex;align-items:center;justify-content:space-between;gap:var(--mb-sp-2);
        font-size:var(--mb-fs-meta);color:var(--mb-sub);font-variant-numeric:tabular-nums}
      .dsh-mb-day-title{font-size:var(--mb-fs-body);font-weight:600;color:var(--mb-sub);margin-top:var(--mb-sp-1)}
      /* ---- 阶跃「账户」页签：多账号卡（账号 + 用量二合一，明细默认折叠）---- */
      /* 档位水印：isolation:isolate 让卡片自成层叠上下文——负 z-index 的孙辈
         （水印在月池格里）才会停在「卡片底色之上、内容之下」，而不会一路沉到面板底色后面。 */
      /* 卡面走 soft（**不是** --mb-card 实底白）：面板底层就是白，用实底白＝与面板同色，
         一屏只有一根 4% 描边，用户反馈「没有颜色、看不出卡片边界」。 */
      .dsh-mb-stepacc{position:relative;isolation:isolate;display:flex;flex-direction:column;gap:var(--mb-sp-2);
        padding:var(--mb-sp-3);border-radius:var(--mb-r-card);background:var(--mb-soft);border:1px solid var(--mb-lineSoft);box-shadow:var(--mb-el-raised)}
      /* 水印本体：**水平居中于 Credit 月池格**（left:50% + translateX(-50%)）。
         用户要的「套餐卡片的水平居中」指的是月池格本身——tier 是月池套餐的属性；
         两格按 1:1.6 分宽，整卡中线落在余额格上，卡片级居中看着永远偏左。
         用 translateX(-50%) 而不是贴边：档位名长短不一（Mini 短、Plus 长），
         贴边时水印左右位置会随字数晃，以对称轴为基准则始终可预期。
         垂直方向贴格顶 top:0（格上沿即 kv 行上沿，头像行高度恒定，是不变量；
         曾按整卡 50% 定过，一展开明细卡片长高、水印跟着跑）。 */
      .dsh-mb-stepacc-wm{position:absolute;left:50%;transform:translateX(-50%);top:0;
        z-index:-1;font-size:var(--mb-fs-wm);font-weight:800;line-height:1;letter-spacing:-1px;
        white-space:nowrap;pointer-events:none;user-select:none;-webkit-user-select:none;
        opacity:.12;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
      /* 四档配色：档位越高越暖（蓝 → 青 → 紫 → 金），一眼分得出高低。
         固定色值不用主题变量：水印只有 12% 透明度，明暗两套主题下都能用，
         且档位色应当跨主题保持一致——它是「这一档长什么样」的固有认知。 */
      .dsh-mb-stepacc.t-mini .dsh-mb-stepacc-wm{color:#3b82f6}
      .dsh-mb-stepacc.t-plus .dsh-mb-stepacc-wm{color:#14b8a6}
      .dsh-mb-stepacc.t-pro  .dsh-mb-stepacc-wm{color:#8b5cf6}
      .dsh-mb-stepacc.t-max  .dsh-mb-stepacc-wm{color:#f59e0b}
      /* 未查询（.dim）的卡没有水印，这里只兜个底：万一将来放开，
         虚线框 + 透明底的卡上水印会比实底卡更显眼，先压一档。 */
      .dsh-mb-stepacc.dim .dsh-mb-stepacc-wm{opacity:.07}
      /* 三种状态必须一眼可辨：显示中 / 已查询 / 未查询。
         原先只靠一个 42% 透明度的边框 + 整体 opacity:.62——一屏卡片里几乎看不出差别，
         而且压暗会把卡上的 ✕ 按钮弄得像禁用的。改成：边框样式 + 底色 + 左边竖条三路叠加。 */
      .dsh-mb-stepacc.dim{border-style:dashed;background:transparent}
      .dsh-mb-stepacc.dim .dsh-mb-stepacc-ava{opacity:.5}
      /* 未查询的卡面透明，卡内两格回落 soft：保持原来「浅灰格浮在白底上」的观感 */
      .dsh-mb-stepacc.dim .dsh-mb-stepacc-kv>div{background:var(--mb-soft)}
      /* 「显示中」保持原样式（用户指定）：accent 8% 叠在 card 白上（不是叠在 soft 灰上），
         卡内两格也回到 soft——这一态本来就有 accent 描边 + 左侧竖条，本来就看得出。 */
      .dsh-mb-stepacc.cur{
        border-color:color-mix(in srgb,var(--mb-acc) 60%,transparent);
        background:color-mix(in srgb,var(--mb-acc) 8%,var(--mb-card));
        box-shadow:inset 3px 0 0 var(--mb-acc)}
      .dsh-mb-stepacc.cur .dsh-mb-stepacc-kv>div{background:var(--mb-soft)}
      /* 显示中但还没查过：既是主账号又是空数据，两种观感都要在 */
      .dsh-mb-stepacc.dim.cur{border-style:dashed;background:color-mix(in srgb,var(--mb-acc) 5%,transparent)}
      .dsh-mb-stepacc-top{display:flex;align-items:center;gap:var(--mb-sp-2);min-width:0}
      .dsh-mb-stepacc-ava{flex:none;display:inline-flex;align-items:center;justify-content:center;
        width:28px;height:28px;border-radius:var(--mb-r-ctl);font-size:var(--mb-fs-body);font-weight:600;color:var(--mb-acc);
        background:color-mix(in srgb,var(--mb-acc) 13%,transparent)}
      .dsh-mb-stepacc-id{flex:1;min-width:0;display:flex;flex-direction:column;gap:var(--mb-sp-1)}
      .dsh-mb-stepacc-name{display:flex;align-items:center;gap:var(--mb-sp-2);font-size:var(--mb-fs-body);font-weight:600;
        color:var(--mb-txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-stepacc-kv{display:flex;gap:var(--mb-sp-2);align-items:stretch}
      /* 卡内两格反相成白：卡面是 soft 灰，格面就必须是 card 白，否则两者同色、格子也「看不出来」 */
      .dsh-mb-stepacc-kv>div{flex:1;min-width:0;display:flex;flex-direction:column;gap:var(--mb-sp-1);
        padding:var(--mb-sp-2) var(--mb-sp-2);border-radius:var(--mb-r-ctl);background:var(--mb-card)}
      /* Credit 格宽一档：它要多扛一行「档位 · 到期 · 续费状态」 */
      /* 水印定位父级：position:relative 当锚，isolation 自成层叠上下文，
         负 z-index 的水印停在格底色之上、格内容之下。 */
      .dsh-mb-stepacc-kv>div.wide{flex:1.6 1 0;position:relative;isolation:isolate}
      .dsh-mb-stepacc-kv .k{font-size:var(--mb-fs-meta);color:var(--mb-sub);white-space:nowrap}
      .dsh-mb-stepacc-kv .v{font-size:var(--mb-fs-title);font-weight:650;color:var(--mb-txt);
        font-variant-numeric:tabular-nums;line-height:1.25}
      .dsh-mb-stepacc-kv .sub{margin-top:var(--mb-sp-1);font-size:var(--mb-fs-micro);line-height:1.3;color:var(--mb-tert);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      /* 月池进度条嵌在 Credit 格里（标签→数值→条→摘要），不单独占一行 */
      .dsh-mb-stepacc-kv .bar{display:block;height:6px;margin-top:var(--mb-sp-1);border-radius:var(--mb-r-xs);
        background:color-mix(in srgb,var(--mb-txt) 9%,transparent);overflow:hidden}
      .dsh-mb-stepacc-kv .bar>i{display:block;height:100%;border-radius:var(--mb-r-xs);background:var(--mb-acc)}
      .dsh-mb-stepacc-kv>div.dim .v{color:var(--mb-tert)}
      .dsh-mb-stepacc-kv>div.dim .bar>i{background:var(--mb-tert)}
      /* Credit 格首行：标签靠左、右上角挂「月池重置」小胶囊。胶囊 flex:none 不收缩，
         挤的时候让 .k 省略——标签是理解这一格的锚，消歧优先。 */
      .dsh-mb-stepacc-kv .krow{display:flex;align-items:center;gap:var(--mb-sp-2);min-width:0}
      .dsh-mb-stepacc-kv .krow .k{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
      .dsh-mb-stepacc-rst{flex:none;font-size:var(--mb-fs-micro);color:var(--mb-tert);white-space:nowrap;
        font-variant-numeric:tabular-nums}
      /* 未查询格没有重置时间可显示（resetChip 为 null），这里兜一层防呆 */
      .dsh-mb-stepacc-kv>div.dim .krow .k{color:var(--mb-tert)}
      /* 图例行：卡片级，只放 Credit 细账（已用/共/加油包） */
      .dsh-mb-stepacc-legend{display:flex;flex-wrap:wrap;gap:var(--mb-sp-1) var(--mb-sp-3);margin-top:-2px;
        font-size:var(--mb-fs-meta);color:var(--mb-tert);font-variant-numeric:tabular-nums}
      .dsh-mb-stepacc-det{border-top:1px solid var(--mb-lineSoft);padding-top:var(--mb-sp-2);
        display:flex;flex-direction:column;gap:var(--mb-sp-2)}
      .dsh-mb-stepacc-foot{display:flex;align-items:center;gap:var(--mb-sp-2)}
      .dsh-mb-stepacc-foot .sp{flex:1}
      .dsh-mb-stepacc-meta{font-size:var(--mb-fs-meta);color:var(--mb-tert);font-variant-numeric:tabular-nums}
      /* 增删（v0.5.9 从设置页搬来） */
      .dsh-mb-stepacc-addbar{display:flex;align-items:center;gap:var(--mb-sp-2)}
      .dsh-mb-stepacc-addbar .dsh-mb-hint{margin:0}
      /* addbar 右侧留白：主操作「查询余额」贴右上角，不与低频的「添加账号」并列 */
      .dsh-mb-stepacc-addbar .sp{flex:1}
      /* 密码胶囊：账号名字后面，默认打码（border 虚、字色弱），展开后变实边 + 等宽明文。
         是「这里有个密码、点我看」的可见提示，但绝不让明文在默认态露一个字符。 */
      .dsh-mb-stepacc-pw{flex:none;display:inline-flex;align-items:center;gap:var(--mb-sp-1);
        max-width:150px;padding:var(--mb-sp-1) var(--mb-sp-2);border:1px dashed var(--mb-lineSoft);border-radius:var(--mb-r-xs);
        background:transparent;color:var(--mb-tert);font-size:var(--mb-fs-meta);line-height:var(--mb-lh-body);
        cursor:pointer;font-family:inherit}
      .dsh-mb-stepacc-pw span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-stepacc-pw:hover{background:var(--mb-soft);color:var(--mb-sub)}
      .dsh-mb-stepacc-pw.on{border-style:solid;border-color:color-mix(in srgb,var(--mb-acc) 55%,transparent);
        color:var(--mb-txt);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
        max-width:210px}
      .dsh-mb-stepacc-pw:disabled{cursor:default}
      .dsh-mb-stepacc-pw:disabled:hover{background:transparent;color:var(--mb-tert)}
      /* 未查询角标：虚线框之外再给一个显式标记（不是所有人的卡都能看出虚线差异） */
      .dsh-mb-stepacc-unq{flex:none;font-size:var(--mb-fs-micro);font-weight:600;color:var(--mb-tert);
        border:1px dashed var(--mb-lineSoft);padding:var(--mb-sp-1) var(--mb-sp-2);border-radius:var(--mb-r-xs)}
      .dsh-mb-stepacc-x{flex:none;width:22px;height:22px;padding:0;border:0;border-radius:var(--mb-r-xs);
        background:transparent;color:var(--mb-tert);font-size:var(--mb-fs-body);line-height:1;cursor:pointer}
      .dsh-mb-stepacc-x:hover{background:var(--mb-soft);color:var(--mb-err)}
      /* 两段式确认的待删态：换成文字 + 警示色，别让一个 ✕ 静默吃掉一整个账号 */
      .dsh-mb-stepacc-x.armed{width:auto;padding:0 var(--mb-sp-2);background:var(--mb-err);color:#fff;font-size:var(--mb-fs-meta);font-weight:600}
      .dsh-mb-stepacc .dsh-mb-hint{font-size:var(--mb-fs-meta)}
      .dsh-mb-kv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:var(--mb-sp-2)}
      .dsh-mb-kv{display:flex;flex-direction:column;gap:var(--mb-sp-1);padding:var(--mb-sp-3);border-radius:var(--mb-r-card);
        background:var(--mb-soft);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-kv-k{font-size:var(--mb-fs-meta);color:var(--mb-sub)}
      .dsh-mb-kv-v{font-size:var(--mb-fs-strong);font-weight:600;color:var(--mb-txt);font-variant-numeric:tabular-nums}
      .dsh-mb-trend-wrap{display:flex;flex-direction:column;gap:var(--mb-sp-1);padding:var(--mb-sp-3);border-radius:var(--mb-r-card);
        background:var(--mb-soft);border:1px solid var(--mb-lineSoft)}
      /* 悬停气泡：对齐原生 Tooltip.module.css（tooltip-bg 深底 + 白字、r8、150ms 淡入、
       * pointer-events:none）；首/末列用 edge 类防出面板。
       * 0.5.5 起余额页的 7 日柱状图已删，这套 tip 现在只服务「用量」页的日历格子。 */
      .dsh-mb-trend-tip{position:absolute;z-index:20;bottom:calc(100% + 14px);left:50%;transform:translateX(-50%);
        min-width:170px;max-width:250px;box-sizing:border-box;padding:var(--mb-sp-2) var(--mb-sp-2);border-radius:var(--mb-r-ctl);text-align:left;
        background:var(--dsw-alias-tooltip-bg,#283142);color:var(--dsw-static-neutral-bluish-00,#fff);
        box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.05));pointer-events:none;
        display:flex;flex-direction:column;gap:var(--mb-sp-1);font-size:var(--mb-fs-meta);line-height:17px;
        animation:dsh-mb-tip-in 150ms var(--mb-ease)}
      .dsh-mb-trend-tip.edge-l{left:0;transform:none}
      .dsh-mb-trend-tip.edge-r{left:auto;right:0;transform:none}
      /* 第一行的浮层翻到下方：往上是 .dsh-mb-cal-wrap / 指标卡区域，
       * 面板滚动到位时还会被 .dsh-mb-body 的 overflow-y:auto 裁掉。 */
      .dsh-mb-trend-tip.below{bottom:auto;top:calc(100% + 8px)}
      .dsh-mb-trend-tip-head{display:flex;align-items:center;justify-content:space-between;gap:var(--mb-sp-2);
        padding-bottom:var(--mb-sp-1);margin-bottom:var(--mb-sp-1);border-bottom:1px solid rgba(255,255,255,.08);
        color:var(--dsw-static-neutral-bluish-300,#cfd3d6);font-weight:600}
      .dsh-mb-trend-tip-row{display:flex;align-items:center;gap:var(--mb-sp-2)}
      .dsh-mb-trend-tip-model{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-trend-tip-cost{flex:none;font-weight:600;font-variant-numeric:tabular-nums}
      .dsh-mb-trend-tip-calls{flex:none;color:var(--dsw-static-neutral-bluish-400,#adb2b8);font-variant-numeric:tabular-nums}
      /* 资金明细行：来源名 + 赠送/已用 + 余额 + 到期。剩 0 的行整行压暗（是历史事实但不该抢眼），
       * 临期（≤3 天）的到期文字转警示色——那才是要立刻花掉的。 */
      .dsh-mb-wallet{display:flex;flex-direction:column;gap:var(--mb-sp-1);padding:var(--mb-sp-3);border-radius:var(--mb-r-card);
        background:var(--mb-soft);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-wrow{display:flex;align-items:center;gap:var(--mb-sp-2);font-size:var(--mb-fs-meta);min-width:0;
        padding:var(--mb-sp-1) 0;font-variant-numeric:tabular-nums}
      .dsh-mb-wrow + .dsh-mb-wrow{border-top:1px solid color-mix(in srgb,var(--mb-lineSoft) 55%,transparent)}
      .dsh-mb-wrow-k{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        color:var(--mb-txt);font-weight:500}
      .dsh-mb-wrow-n{flex:none;color:var(--mb-sub);font-size:var(--mb-fs-meta)}
      .dsh-mb-wrow-r{flex:none;font-weight:600;color:var(--mb-txt);min-width:62px;text-align:right;font-variant-numeric:tabular-nums}
      .dsh-mb-wrow-x{flex:none;color:var(--mb-tert);font-size:var(--mb-fs-meta);min-width:78px;text-align:right;font-variant-numeric:tabular-nums}
      .dsh-mb-wrow.principal .dsh-mb-wrow-k{color:var(--mb-txt)}
      .dsh-mb-wrow.used{opacity:.5}
      .dsh-mb-wrow.used .dsh-mb-wrow-r{color:var(--mb-tert)}
      .dsh-mb-wrow.other .dsh-mb-wrow-k{color:var(--mb-tert)}
      /* ---- 用量页签：30 天热力日历 + 排行 ---- */
      .dsh-mb-cal-wrap{display:flex;flex-direction:column;gap:var(--mb-sp-2);padding:var(--mb-sp-3);border-radius:var(--mb-r-card);
        background:var(--mb-soft);border:1px solid var(--mb-lineSoft)}
      /* 标题行：左标题右角标。角标是三级字色 + 不换行，长账号名挤过来时它先让位
       * （现在把覆盖度单独占一整行会和标题、日历隔开）。 */
      .dsh-mb-cal-head{display:flex;align-items:baseline;justify-content:space-between;gap:var(--mb-sp-2);
        min-width:0;margin-top:var(--mb-sp-1)}
      .dsh-mb-cal-head .dsh-mb-day-title{margin-top:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-cal-meta{flex:none;font-size:var(--mb-fs-meta);font-weight:400;color:var(--mb-tert);
        font-variant-numeric:tabular-nums;white-space:nowrap}
      .dsh-mb-cal-hd{display:grid;grid-template-columns:repeat(7,1fr);gap:var(--mb-sp-1)}
      .dsh-mb-cal-wd{font-size:var(--mb-fs-micro);color:var(--mb-sub);text-align:center;padding:var(--mb-sp-1) 0;border-radius:var(--mb-r-xs);
        font-variant-numeric:tabular-nums}
      /* 周末列表头压暗，跟下面周末格的底色区分呼应 */
      .dsh-mb-cal-wd.wknd{color:var(--mb-tert)}
      .dsh-mb-cal{display:grid;grid-template-columns:repeat(7,1fr);gap:var(--mb-sp-1);position:relative}
      /* 一格一天：日期 + 当日金额。底色 accent 浓度由内联按花费算（热力），
       * 静态只兜底一个最浅的底，保证 JS 没算出来时格子里仍有东西。 */
      .dsh-mb-cal-cell{position:relative;display:flex;flex-direction:column;align-items:center;
        justify-content:center;gap:var(--mb-sp-1);box-sizing:border-box;
        min-width:0;min-height:38px;padding:var(--mb-sp-1) var(--mb-sp-1);border-radius:var(--mb-r-ctl);cursor:default;
        background:color-mix(in srgb,var(--mb-acc) 7%,transparent);
        border:1px solid color-mix(in srgb,var(--mb-acc) 12%,transparent);
        transition:background-color var(--mb-fast) var(--mb-ease),border-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-cal-cell.blank{background:none;border-color:transparent}
      /* 周末格再压暗一档，跟工作日分开（有数据时被内联 accent 底色盖住，只影响空周末） */
      .dsh-mb-cal-cell.wknd:not(.today){border-color:color-mix(in srgb,var(--mb-sub) 12%,transparent)}
      .dsh-mb-cal-day{font-size:var(--mb-fs-micro);color:var(--mb-sub);font-variant-numeric:tabular-nums;line-height:13px}
      .dsh-mb-cal-cost{font-size:var(--mb-fs-micro);font-weight:600;color:var(--mb-txt);font-variant-numeric:tabular-nums;
        max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* 只有「有数据」的格才给悬停反馈——空格没有可看的东西，不做成可点样子 */
      .dsh-mb-cal-cell.has:hover{background:color-mix(in srgb,var(--mb-acc) 16%,transparent)}
      /* 空格：虚线框 + 三级字色的「—」，明说「这天没调用」而不是「坏了」 */
      .dsh-mb-cal-cell.nodata{background:color-mix(in srgb,var(--mb-sub) 3%,transparent);
        border-style:dashed;border-color:color-mix(in srgb,var(--mb-sub) 14%,transparent)}
      .dsh-mb-cal-cell.nodata .dsh-mb-cal-cost{font-weight:400;color:var(--mb-tert)}
      /* 今天：accent 实线描边 + 日期字加粗，扫过去就知道查到哪天 */
      .dsh-mb-cal-cell.today{border-color:var(--mb-acc);border-width:1.5px;
        box-shadow:0 0 0 2.5px color-mix(in srgb,var(--mb-acc) 12%,transparent)}
      .dsh-mb-cal-cell.today .dsh-mb-cal-day{color:var(--mb-acc);font-weight:700}
      /* 并排两栏：按模型 / 按客户端各占一半。窄栏里 rank 行的字号与列宽都要收一档，
       * 否则「名称 92px + 金额 + 次数」在 ~250px 里会把占比条挤成一丝。 */
      .dsh-mb-split{display:flex;gap:var(--mb-sp-2);align-items:flex-start;min-width:0}
      .dsh-mb-split>.dsh-mb-trend-wrap{flex:1 1 0;min-width:0;padding:var(--mb-sp-2)}
      .dsh-mb-split .dsh-mb-day-title{font-size:var(--mb-fs-meta)}
      .dsh-mb-split .dsh-mb-rank{font-size:var(--mb-fs-meta);gap:var(--mb-sp-1)}
      .dsh-mb-split .dsh-mb-rank-k{flex:0 0 66px}
      .dsh-mb-split .dsh-mb-rank-v{font-size:var(--mb-fs-meta)}
      .dsh-mb-split .dsh-mb-rank-c{width:44px;font-size:var(--mb-fs-micro)}
      .dsh-mb-split .dsh-mb-rank-bar{height:4px}
      /* 排行行：名称 / 条 / 金额 / 次数（整行独占时用上面的宽档） */
      .dsh-mb-rank{display:flex;align-items:center;gap:var(--mb-sp-2);font-size:var(--mb-fs-meta);min-width:0}
      .dsh-mb-rank-k{flex:0 0 92px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt)}
      .dsh-mb-rank-bar{flex:1;min-width:0;height:5px;border-radius:var(--mb-r-xs);
        background:color-mix(in srgb,var(--mb-sub) 22%,transparent);overflow:hidden}
      .dsh-mb-rank-bar>i{display:block;height:100%;border-radius:var(--mb-r-xs);background:var(--mb-acc)}
      .dsh-mb-rank-v{flex:none;font-weight:600;color:var(--mb-txt);font-variant-numeric:tabular-nums}
      .dsh-mb-rank-c{flex:none;width:52px;text-align:right;color:var(--mb-sub);font-variant-numeric:tabular-nums}
      @keyframes dsh-mb-tip-in{from{opacity:0}}
      .dsh-mb-toggle{align-self:flex-start;border:none;background:transparent;cursor:pointer;padding:var(--mb-sp-1) 0;
        font-size:var(--mb-fs-body);font-weight:600;color:var(--mb-sub);font-family:inherit;
        transition:color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-toggle:hover{color:var(--mb-txt)}
      /* 页首行：更新时间 + 刷新，右对齐贴页面右上角（原先沉在页脚的那行已删） */
      .dsh-mb-topbar{display:flex;align-items:center;justify-content:flex-end;gap:var(--mb-sp-2);
        font-size:var(--mb-fs-meta);color:var(--mb-sub);font-variant-numeric:tabular-nums}
      .dsh-mb-refresh{cursor:pointer;border:1px solid var(--mb-line);border-radius:var(--mb-r-ctl);font-family:inherit;
        background:transparent;color:var(--mb-txt);padding:var(--mb-sp-1) var(--mb-sp-3);font-size:var(--mb-fs-body);
        transition:background-color var(--mb-fast) var(--mb-ease),border-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-refresh:hover{background:var(--mb-soft);border-color:var(--mb-ghostLine)}

      .dsh-mb-set-title{font-weight:600;font-size:var(--mb-fs-strong);color:var(--mb-txt)}
      .dsh-mb-set-desc{font-size:var(--mb-fs-body);color:var(--mb-sub)}
      /* 插件更新卡片：单行——版本 + 模式徽标 + 状态靠左，操作按钮靠右。
       * 状态过长省略号截断；actions 整组 flex:none，极窄面板时随 wrap 换行。 */
      .dsh-mb-upd-line{display:flex;align-items:center;gap:var(--mb-sp-2);flex-wrap:wrap}
      .dsh-mb-upd-cur{font-family:var(--mb-codeFont);font-size:var(--mb-fs-body);font-weight:600;color:var(--mb-txt);flex:none}
      .dsh-mb-upd-mode{font-size:var(--mb-fs-meta);color:var(--mb-sub);flex:none;
        border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-pill);padding:0 var(--mb-sp-2);line-height:18px}
      .dsh-mb-upd-state{font-size:var(--mb-fs-body);color:var(--mb-sub);flex:1 1 auto;min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-upd-state.new{color:var(--mb-acc);font-weight:600}
      .dsh-mb-upd-actions{margin-left:auto;display:flex;gap:var(--mb-sp-2);flex:none}
      .dsh-mb-btn.small{height:24px;padding:0 var(--mb-sp-3);font-size:var(--mb-fs-body);font-weight:500;border-radius:var(--mb-r-card)}
      /* 入口胶囊余额：骨架与「插件更新」卡一致——标题行 + 内容行（说明靠左、
       * 按钮组贴右）；复用 .dsh-mb-cat 的 chip/active 样式，极窄面板才换行。 */
      .dsh-mb-seg-line{display:flex;align-items:center;gap:var(--mb-sp-2);flex-wrap:wrap}
      .dsh-mb-seg-desc{font-size:var(--mb-fs-body);color:var(--mb-sub);flex:1 1 auto;min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-seg-row{margin-left:auto;display:flex;gap:var(--mb-sp-2);flex:none}
      .dsh-mb-code{font-family:var(--mb-codeFont);font-size:var(--mb-fs-meta);
        background:var(--mb-codeBg);color:var(--mb-txt);border-radius:var(--mb-r-xs);padding:0 var(--mb-sp-1)}
      .dsh-mb-session-row{display:flex;align-items:center;gap:var(--mb-sp-2);font-size:var(--mb-fs-body)}
      .dsh-mb-ok{color:var(--mb-ok);font-weight:500}
      .dsh-mb-warn{color:var(--mb-warnTx);font-weight:500}
      .dsh-mb-input{width:100%;box-sizing:border-box;resize:vertical;min-height:56px;padding:var(--mb-sp-2) var(--mb-sp-2);border-radius:var(--mb-r-ctl);font-size:var(--mb-fs-body);
        font-family:var(--mb-codeFont);
        border:1px solid var(--mb-inputLine);background:var(--mb-inputBg);color:var(--mb-txt);
        transition:border-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-input:focus{outline:none;border-color:var(--mb-focus)}
      .dsh-mb-input::placeholder{color:var(--mb-dim)}
      .dsh-mb-btn-row{display:flex;gap:var(--mb-sp-2)}
      .dsh-mb-btn{cursor:pointer;border:none;border-radius:var(--mb-r-shell);height:32px;padding:0 var(--mb-sp-4);font-size:var(--mb-fs-strong);font-weight:600;font-family:inherit;
        background:var(--mb-btnFill);color:var(--mb-btnTx);
        transition:background-color var(--mb-fast) var(--mb-ease),opacity var(--mb-fast) var(--mb-ease)}
      .dsh-mb-btn:hover:not(:disabled){background:var(--mb-btnHover)}
      .dsh-mb-btn:disabled{opacity:.4;cursor:not-allowed}
      .dsh-mb-btn.ghost{background:transparent;color:var(--mb-txt);border:1px solid var(--mb-line)}
      .dsh-mb-btn.ghost:hover:not(:disabled){background:var(--mb-soft)}
      .dsh-mb-cookie-msg{font-size:var(--mb-fs-body);color:var(--mb-sub)}
      .dsh-mb-cookie-msg.err{color:var(--mb-err)}
      .dsh-mb-key-list{display:flex;flex-direction:column;gap:var(--mb-sp-1)}
      .dsh-mb-key-row{display:flex;align-items:center;gap:var(--mb-sp-2);font-size:var(--mb-fs-body);padding:var(--mb-sp-1) 0;
        border-bottom:1px dashed var(--mb-lineSoft)}
      .dsh-mb-key-name{font-weight:600;min-width:64px;color:var(--mb-txt)}
      .dsh-mb-key-copy{margin-left:auto;flex:none;cursor:pointer;border:1px solid var(--mb-line);border-radius:var(--mb-r-ctl);font-family:inherit;
        background:transparent;color:var(--mb-txt);padding:var(--mb-sp-1) var(--mb-sp-2);font-size:var(--mb-fs-meta);
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
        padding:var(--mb-sp-3);background:color-mix(in srgb, var(--mb-txt) 28%, transparent);
        border-radius:inherit;overflow:hidden;
        animation:dsh-mb-tip-in 150ms var(--mb-ease)}
      .dsh-mb-modal-card{width:100%;max-width:640px;height:100%;display:flex;flex-direction:column;overflow:hidden;
        border-radius:var(--mb-r-card);background:var(--mb-panelBg);
        box-shadow:var(--mb-el-hover)}
      .dsh-mb-modal-head{flex:none;display:flex;align-items:center;justify-content:space-between;height:42px;
        padding:0 var(--mb-sp-2) 0 var(--mb-sp-4);border-bottom:1px solid var(--mb-lineSoft)}
      .dsh-mb-modal-title{font-weight:500;font-size:var(--mb-fs-title);letter-spacing:.2px;color:var(--mb-txt)}
      .dsh-mb-modal-body{flex:1;min-height:0;overflow-y:auto;padding:var(--mb-sp-2) var(--mb-sp-4) var(--mb-sp-4)}

      /* 密钥页签：新建行 / 创建成功一次性展示 / 密钥卡片列表。 */
      .dsh-mb-key-create{display:flex;gap:var(--mb-sp-2);align-items:center}
      .dsh-mb-key-create .dsh-mb-input{flex:1}
      .dsh-mb-key-create .dsh-mb-btn{flex:none}
      .dsh-mb-created{border:1px solid color-mix(in srgb, var(--mb-acc) 25%, transparent);border-radius:var(--mb-r-card);padding:var(--mb-sp-4);
        background:color-mix(in srgb, var(--mb-acc) 7%, transparent)}
      .dsh-mb-created-title{font-size:var(--mb-fs-body);font-weight:600;color:var(--mb-acc);margin-bottom:var(--mb-sp-2)}
      .dsh-mb-created-key{font-family:var(--mb-codeFont);font-size:var(--mb-fs-body);word-break:break-all;
        background:var(--mb-codeBlock);border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-ctl);padding:var(--mb-sp-2) var(--mb-sp-2);color:var(--mb-txt)}
      .dsh-mb-created .dsh-mb-btn-row{margin-top:var(--mb-sp-2)}
      .dsh-mb-keys-head{display:flex;align-items:center;justify-content:space-between;gap:var(--mb-sp-2)}
      .dsh-mb-keys-list{display:flex;flex-direction:column;gap:var(--mb-sp-2)}
      .dsh-mb-key-card{padding:var(--mb-sp-3);border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-card);background:var(--mb-soft)}
      .dsh-mb-key-card-top{display:flex;align-items:center;justify-content:space-between;gap:var(--mb-sp-2)}
      .dsh-mb-key-card-name{font-weight:600;font-size:var(--mb-fs-body);color:var(--mb-txt)}
      .dsh-mb-key-code-row{display:flex;align-items:center;justify-content:space-between;gap:var(--mb-sp-2);margin-top:var(--mb-sp-1)}
      .dsh-mb-key-card-code{font-family:var(--mb-codeFont);font-size:var(--mb-fs-body);color:var(--mb-sub);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-key-card .dsh-mb-key-copy{flex:none}
      .dsh-mb-key-card-meta{font-size:var(--mb-fs-meta);color:var(--mb-sub);margin-top:var(--mb-sp-1)}
      /* 设置页：分区卡片 + 账号行（头像字/当前徽标/明文切换）。 */
      .dsh-mb-set-card{border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-card);background:var(--mb-soft);
        padding:var(--mb-sp-3);display:flex;flex-direction:column;gap:var(--mb-sp-2)}
      .dsh-mb-acc-form{display:flex;gap:var(--mb-sp-2);flex-wrap:wrap;align-items:center}
      .dsh-mb-acc-form .dsh-mb-input{flex:1;min-width:130px}
      .dsh-mb-acc-form .dsh-mb-btn{flex:none}
      .dsh-mb-pw-wrap{position:relative;display:flex;flex:1;min-width:150px}
      .dsh-mb-pw-wrap .dsh-mb-input{flex:1;padding-right:34px}
      .dsh-mb-pw-eye{position:absolute;right:3px;top:50%;transform:translateY(-50%);cursor:pointer;
        display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;
        border:none;background:transparent;color:var(--mb-acc);border-radius:var(--mb-r-xs);
        transition:background-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-pw-eye:hover{background:var(--mb-soft)}
      .dsh-mb-acc-list{display:flex;flex-direction:column;gap:var(--mb-sp-1)}
      .dsh-mb-acc-row{display:flex;align-items:center;gap:var(--mb-sp-2);font-size:var(--mb-fs-body);padding:var(--mb-sp-3);border-radius:var(--mb-r-card);
        background:var(--mb-soft);border:1px solid var(--mb-lineSoft)}
      .dsh-mb-acc-row.cur{border-color:var(--mb-ok)}
      .dsh-mb-acc-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
        border-radius:var(--mb-r-ctl);background:var(--mb-ghostFill);color:var(--mb-txt);font-weight:600;font-size:var(--mb-fs-body)}
      .dsh-mb-acc-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:var(--mb-sp-1)}
      .dsh-mb-acc-name{font-weight:600;color:var(--mb-txt);display:flex;align-items:center;gap:var(--mb-sp-2);min-width:0}
      .dsh-mb-acc-cur{flex:none;font-size:var(--mb-fs-micro);font-weight:600;color:var(--mb-ok);background:color-mix(in srgb, var(--mb-ok) 10%, transparent);
        border-radius:var(--mb-r-xs);padding:0 var(--mb-sp-1)}
      .dsh-mb-acc-pw{font-family:var(--mb-codeFont);font-size:var(--mb-fs-meta);color:var(--mb-sub);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-key-copy.primary{color:var(--mb-btnTx);background:var(--mb-btnFill);border-color:var(--mb-btnFill);font-weight:600}
      .dsh-mb-key-copy.primary:hover:not(:disabled){background:var(--mb-btnHover)}
      .dsh-mb-key-copy.danger{color:var(--mb-err);border-color:color-mix(in srgb, var(--mb-err) 40%, transparent)}
      .dsh-mb-key-copy.danger.armed{color:var(--mb-btnTx);background:var(--mb-err);border-color:var(--mb-err);font-weight:600}
      .dsh-mb-key-copy.danger.armed:hover:not(:disabled){filter:brightness(1.08)}

      /* ---- 统一交互态：键盘焦点环 / 按下底色 / 禁用透明度 ----
       * 焦点环只在 :focus-visible 出现（鼠标点击不画环，与 DSH 原生控件同口径）；
       * 禁用态统一走 --mb-op-off，不再各处写内联 opacity。 */
      .dsh-mb-btn:focus-visible,.dsh-mb-iconbtn:focus-visible,.dsh-mb-tab:focus-visible,
      .dsh-mb-prov-btn:focus-visible,.dsh-mb-cat:focus-visible,.dsh-mb-ck-chip:focus-visible,
      .dsh-mb-ck-run:focus-visible,.dsh-mb-key-copy:focus-visible,.dsh-mb-refresh:focus-visible,
      .dsh-mb-toggle:focus-visible,.dsh-mb-link:focus-visible,.dsh-mb-input:focus-visible,
      .dsh-mb-card:focus-visible,.dsh-mb-stepacc-x:focus-visible,.dsh-mb-stepacc-pw:focus-visible,
      .dsh-mb-pw-eye:focus-visible{outline:none;box-shadow:var(--mb-ring)}
      .dsh-mb-tab:active:not(.active),.dsh-mb-prov-btn:active:not(.active),.dsh-mb-cat:active:not(.active),
      .dsh-mb-iconbtn:active,.dsh-mb-btn.ghost:active{background:var(--mb-ghostFill)}
      .dsh-mb-btn:disabled,.dsh-mb-iconbtn:disabled,.dsh-mb-ck-run:disabled,.dsh-mb-key-copy:disabled,
      .dsh-mb-input:disabled{opacity:var(--mb-op-off);cursor:not-allowed}

      /* ---- 对话输入行按钮（压缩上下文 / 计划模式）----
       * 落在 conversation.input.right：与模型选择器同一 flex 组且在其之前 → 正好是
       * 「对话模型」左边的位置。行内高度 28px 与官方 ＋号/计划片同高，间距由父级 flex
       * 的 gap 统一给，这里不再加外边距。 */
      .dsh-mb-composer{display:inline-flex;align-items:center;gap:var(--mb-sp-1);min-width:0}
      /* 纯图标按钮：28×28 方形（与官方 ＋号 / 语音按钮同尺寸），图标 14px */
      .dsh-mb-cbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;
        border:none;border-radius:var(--mb-r-ctl);background:var(--mb-soft);color:var(--mb-sub);cursor:pointer;
        transition:background-color var(--mb-fast) var(--mb-ease),color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-cbtn svg{display:block}
      .dsh-mb-cbtn.busy{cursor:progress}
      /* 上下文占用超 60%：压缩按钮转红（与「该压一压了」的语义一致） */
      .dsh-mb-cbtn.alert{background:color-mix(in srgb,var(--mb-err) 12%,transparent);color:var(--mb-err);
        box-shadow:inset 0 0 0 1px var(--mb-err)}
      .dsh-mb-cbtn:hover:not(:disabled){color:var(--mb-txt);background:var(--mb-softAccent)}
      .dsh-mb-cbtn:focus-visible{outline:none;box-shadow:var(--mb-ring)}
      .dsh-mb-cbtn:disabled{opacity:var(--mb-op-off);cursor:not-allowed}
      /* 计划模式激活：accent 浅底 + 内描边（与筛选 chip 同一套选中语言） */
      .dsh-mb-cbtn.on{background:color-mix(in srgb,var(--mb-acc) 12%,transparent);color:var(--mb-acc);
        box-shadow:inset 0 0 0 1px var(--mb-acc)}
      /* 失败反馈（非文字）：图标转红，6 秒后自动恢复；原因在 tooltip 里 */
      .dsh-mb-cbtn.failed{color:var(--mb-err)}
      /* 命令回显行已按用户要求整条去掉（输入行不出文字，失败只进 tooltip），
         对应的样式规则随之删除——不留没人渲染的死规则 */

      @media (prefers-reduced-motion:reduce){.dsh-mb-cbtn,.dsh-mb-entry,.dsh-mb-entry-label.wide-in,.dsh-mb-trend-tip,.dsh-mb-hov{transition:none;animation:none}}
`;
        return module.exports;
  }
});
