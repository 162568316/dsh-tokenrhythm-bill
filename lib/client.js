/**
 * dsh-tokenrhythm-bill client half: the browser panel, loaded by the web
 * ModuleLoader as a plain React plugin. It injects:
 *   - a sidebar footer entry button (slot `sidebar.footer.action`, rendered
 *     right above the settings button) with an amber alert dot when the
 *     expiring quota is close to expiry or balance runs low;
 *   - a draggable/resizable frosted-glass panel (slot `shell.overlay`) with
 *     two tabs (模型 / 余额) and a gear in the top-right corner for settings:
 *       模型    — category chips (全部/文本/图像/音频/视频/向量) + model cards;
 *                 click a card to copy its model id;
 *       余额    — expiring-quota hero, daily usage (incl. cache hits),
 *                 7-day cost sparkline, recent calls list;
 *       设置    — paste/clear the tokenrhythm session cookie, key status.
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
    const store = { open: false, view: 'models', alert: null, balanceCny: null, expiringItems: [], entryBalMode: 'total' };
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
    const fmtPrice = (m, key) => {
      const v = m[key]
      if (v === null || v === undefined || !Number.isFinite(v)) return null
      const cur = m.currency === 'CNY' || m.currency === 'cny' || m.currency === '¥' ? '¥' : (m.currency || '') + ' '
      return cur + trimNum(v)
    }
    // 预警判定：临期 ≤3 天且还有限时额度，或可用余额 < ¥10。
    const alertOf = (d) => {
      if (!d) return null
      const expDays = d.nextExpiryAt ? Math.ceil((new Date(d.nextExpiryAt).getTime() - Date.now()) / 86400000) : null
      const low = d.availableBalanceCny !== null && d.availableBalanceCny !== undefined && d.availableBalanceCny < 10
      const expiring = expDays !== null && expDays <= 3 && (d.expiringBalanceCny || 0) > 0
      if (!low && !expiring) return null
      return { low, expiring, expDays, expiringBalanceCny: d.expiringBalanceCny, availableBalanceCny: d.availableBalanceCny }
    }

    // ---- 侧栏入口按钮：形态由宿主侧栏的 wide 标志驱动（与原生「新会话」按钮同一套
    // 折叠编排：收起时宽栏内容随侧栏淡出，settle 后 rail 图标淡入），宿主未传 wide 时
    // 回退到容器查询；有预警时图标右上角琥珀点 ----
    const ENTRY_LABEL = '基元律动-费用中心'
    // 限时余额悬浮卡：只显示逐笔限时额度（金额 + N 天后失效），无限时数据不渲染、
    // 限时为 0 不显示弹窗（用户定稿）。fixed 定位按入口 rect 计算，进卡片保持显示。
    const HOV_SHOW_DELAY_MS = 400
    const HOV_HIDE_DELAY_MS = 150
    const HOV_WIDTH = 260
    const expDaysLeft = (expireAt) => {
      const t = Date.parse(expireAt)
      if (!Number.isFinite(t)) return null
      return Math.max(0, Math.ceil((t - Date.now()) / 86400000))
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
      const title = s.alert
        ? ENTRY_LABEL + '（' + (s.alert.expiring ? '限时额度 ' + s.alert.expiringDays + ' 天后到期' : '余额不足') + '）'
        : ENTRY_LABEL
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
      const hovCapable = hovItems.length > 0 && !s.open
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
        'aria-label': ENTRY_LABEL,
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
      const balText = pillVal !== null && pillVal !== undefined ? '¥' + fmtCny(pillVal) : null
      return React.createElement(React.Fragment, null,
        React.createElement('button', btnProps,
          wide ? React.createElement('span', { className: 'dsh-mb-entry-left' },
            React.createElement('span', { className: 'dsh-mb-entry-icon' },
              EntryMark({ size: 16 }),
              s.alert ? React.createElement('span', { className: 'dsh-mb-dot' }) : null,
            ),
            React.createElement('span', { className: 'dsh-mb-entry-label wide-in' }, ENTRY_LABEL),
          ) : React.createElement('span', { className: 'dsh-mb-entry-icon' },
            EntryMark({ size: 18 }),
            s.alert ? React.createElement('span', { className: 'dsh-mb-dot' }) : null,
          ),
          wide && balText ? React.createElement('span', { className: 'dsh-mb-entry-bal' + (s.alert ? ' alert' : '') }, balText) : null,
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

    // ---- 面板 ----
    function Panel() {
      const s = useStore()
      const [view, setView] = useState('models') // 'models' | 'balance' | 'settings'
      const lastTabRef = useRef('models')
      const [pos, setPos] = useState(null) // {x,y,w,h?}；prefs 加载前 null → 面板不渲染避免闪跳
      const posRef = useRef(null)
      const panelRef = useRef(null)
      const [manifest, setManifest] = useState(null)
      const [providerId, setProviderId] = useState('')
      const [models, setModels] = useState(null)
      const [catFilter, setCatFilter] = useState('all')
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

      // 设置是右上角齿轮切入的临时视图：进出时记住/恢复上一个页签。
      const switchTab = useCallback((id) => {
        lastTabRef.current = id
        setView(id)
        setStore({ view: id })
      }, [])
      const toggleSettings = useCallback(() => {
        setView((v) => {
          const next = v === 'settings' ? lastTabRef.current : v
          if (v !== 'settings') lastTabRef.current = v
          setStore({ view: next })
          return v === 'settings' ? next : 'settings'
        })
      }, [])

      // 首开：加载面板几何 + manifest。
      useEffect(() => {
        let alive = true
        jsonGet(API + '/prefs').then((r) => {
          if (!alive || !r || !r.ok || !r.prefs) return
          if (r.prefs.panel) setPosSafe(sanitizePos(r.prefs.panel))
        })
        jsonGet(API + '/manifest').then((r) => {
          if (!alive) return
          setManifest(r && r.ok ? r : { ok: false, providers: [], error: r && r.error ? r.error : '加载失败' })
          if (r && r.ok && Array.isArray(r.providers) && r.providers.length > 0) {
            setProviderId((cur) => (cur !== '' && r.providers.some((p) => p.id === cur) ? cur : r.providers[0].id))
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

      // Esc / 点击面板外部关闭。
      useEffect(() => {
        if (!s.open) return
        const onKey = (e) => { if (e.key === 'Escape') setStore({ open: false }) }
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

      // 模型列表：随 providerId 变化拉取（host 端 60s 缓存）。
      useEffect(() => {
        if (!s.open || providerId === '' || view !== 'models') return
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
        setCookieMsg({ ok: true, text: value === '' ? '已清除会话' : '已保存：' + r.hint })
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

      // 点击模型卡片 → 复制模型 id（配置 agent 时直接粘贴）。
      const copyId = useCallback((id) => {
        void copyText(id)
        setCopiedId(id)
        setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1200)
      }, [])

      // 模型连通检测：真实 1-token 推理（host 60s 缓存 + 单飞），结果按模型 id 存。
      const [modelChecks, setModelChecks] = useState({})
      const modelChecksRef = useRef({})
      const applyChecks = (updater) => {
        modelChecksRef.current = updater(modelChecksRef.current)
        setModelChecks(modelChecksRef.current)
      }
      const checkModel = useCallback(async (modelId) => {
        if (!modelId) return
        const cur = modelChecksRef.current[modelId]
        if (cur && cur.state === 'testing') return // 防重入
        applyChecks((m) => ({ ...m, [modelId]: { state: 'testing' } }))
        const r = await jsonPost(API + '/model-check', { model: modelId }).catch(() => null)
        const result = r && r.ok && r.result ? r.result : { ok: false, error: (r && r.error) || '检测失败' }
        applyChecks((m) => ({ ...m, [modelId]: {
          state: result.ok ? 'ok' : 'fail',
          latencyMs: result.latencyMs,
          error: result.error,
        } }))
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

      // 账号列表：进入设置页签时拉取（添加/删除后会再刷新），否则刷新页面后列表永远不出现。
      useEffect(() => {
        if (!s.open || view !== 'settings') return
        loadAccounts()
      }, [s.open, view, loadAccounts])

      // ---- 更新检测：进入设置页签时拉取（host 端 24h TTL，force=1 绕过）----
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
        if (!s.open || view !== 'settings') return
        loadUpdate(false)
      }, [s.open, view, loadUpdate])
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

      return React.createElement('div', {
        className: 'dsh-mb-panel',
        ref: panelRef,
        style: { left: pos.x, top: pos.y, width: pos.w, height: pos.h || undefined },
        role: 'dialog',
      },
        // 头部：标题（拖拽把手）+ 右上角动作区（设置齿轮 / 关闭）。
        React.createElement('div', { className: 'dsh-mb-head', onPointerDown: onHeaderDown },
          React.createElement('span', { className: 'dsh-mb-head-title' }, ENTRY_LABEL),
          React.createElement('div', { className: 'dsh-mb-head-actions' },
            React.createElement('button', {
              className: 'dsh-mb-iconbtn' + (view === 'settings' ? ' active' : ''),
              title: '设置',
              onClick: toggleSettings,
            }, '⚙'),
            React.createElement('button', { className: 'dsh-mb-iconbtn', title: '关闭 (Esc)', onClick: () => setStore({ open: false }) }, '✕'),
          ),
        ),
        // 页签（设置经由右上角齿轮进入，不占页签）。
        React.createElement('div', { className: 'dsh-mb-tabs' },
          [['models', '模型'], ['balance', '余额'], ['keys', '密钥']].map(([id, label]) =>
            React.createElement('button', {
              key: id,
              className: 'dsh-mb-tab' + (view === id ? ' active' : ''),
              onClick: () => switchTab(id),
            }, label)),
        ),
        React.createElement('div', { className: 'dsh-mb-body' },
          view === 'models' ? renderModelsTab({ manifest, providers, models, catFilter, setCatFilter, copiedId, copyId, modelChecks, checkModel }) : null,
          view === 'balance' ? renderBalanceTab({ manifest, balance, loadBalance, goSettings: toggleSettings, showCalls, setShowCalls, trendHoverIdx, setTrendHoverIdx, sessionAccount }) : null,
          view === 'keys' ? renderKeysTab({
            manifest, keysData, loadKeys, keyName, setKeyName, keyCreating, createKey,
            createdKey, setCreatedKey, copiedCreated, copyCreatedKey, copiedKeyId, copyReveal,
          }) : null,
          view === 'settings' ? renderSettingsTab({
            manifest, sessionConfigured, sessionAccount: (manifest && manifest.session && manifest.session.account) || null,
            cookieInput, setCookieInput,
            cookieBusy, cookieMsg, saveCookie,
            accounts, addAcc, setAddAcc, addPw, setAddPw, showAddPw, setShowAddPw,
            accBusy, accMsg, addAccount, removeAccount, loginStored, showAccPw, setShowAccPw,
            showBackup, setShowBackup,
            updInfo, updBusy, loadUpdate, copyUpdateCmd, updCopied, ignoreUpdate,
            entryMode: s.entryBalMode === 'expiring' ? 'expiring' : 'total', setEntryBalance,
          }) : null,
        ),
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

    function renderModelsTab({ manifest, providers, models, catFilter, setCatFilter, copiedId, copyId, modelChecks, checkModel }) {
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
        const list = models.list.filter((m) => catFilter === 'all' || !(m.categories) || m.categories.includes(catFilter))
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
            React.createElement('div', { className: 'dsh-mb-card-head' },
              React.createElement('span', { className: 'dsh-mb-card-id', title: m.name && m.name !== m.id ? m.name : m.id }, m.id),
              copiedId === m.id
                ? React.createElement('span', { className: 'dsh-mb-copied' }, '已复制')
                : (m.hasDiscount ? React.createElement('span', { className: 'dsh-mb-badge disc' }, '折扣') : null),
              // 连通状态点：灰=未测 / 琥珀脉冲=检测中 / 绿=连通+延迟 / 红=异常（title 看错误）。
              // 图像等非 chat 类型不支持推理测试（/v1 回退源无 kind 字段，视为可测）。
              (() => {
                const chk = modelChecks[m.id]
                const nontest = m.kind !== undefined && m.kind !== 'chat'
                const st = chk ? chk.state : ''
                return React.createElement('button', {
                  className: 'dsh-mb-model-dot-btn' + (st ? ' ' + st : '') + (nontest ? ' nontest' : ''),
                  disabled: nontest || (st === 'testing'),
                  title: nontest
                    ? '该类型不支持推理测试'
                    : st === 'fail' ? ('连通异常：' + (chk.error || '未知错误'))
                      : st === 'ok' ? ('连通正常 · ' + chk.latencyMs + 'ms（点击重测，60s 内走缓存）')
                        : '点击测试连通性（发送 1-token 测试请求）',
                  onClick: (e) => { e.stopPropagation(); checkModel(m.id) },
                },
                  React.createElement('span', { className: 'dsh-mb-model-dot' }),
                  st === 'ok' && chk.latencyMs !== undefined ? React.createElement('span', { className: 'dsh-mb-model-lat' }, chk.latencyMs + 'ms') : null,
                )
              })(),
            ),
            // 第二行：左边来源（无问芯穹/DeepSeek/百炼…），右边平台状态（在线/测试中）。
            m.provider || m.platformStatus
              ? React.createElement('div', { className: 'dsh-mb-card-sub' },
                  m.provider
                    ? React.createElement('span', { className: 'dsh-mb-card-src', title: m.provider }, m.provider)
                    : React.createElement('span'),
                  m.platformStatus
                    ? React.createElement('span', {
                        className: 'dsh-mb-card-status' + (m.platformStatus === 'online' ? ' on' : m.platformStatus === 'testing' ? ' testing' : ''),
                      }, m.platformStatus === 'online' ? '在线' : m.platformStatus === 'testing' ? '测试中' : m.platformStatus)
                    : null,
                )
              : null,
            React.createElement('div', { className: 'dsh-mb-card-lines' },
              m.contextLength !== null ? React.createElement('div', { className: 'dsh-mb-card-line' },
                React.createElement('span', { className: 'dsh-mb-card-k' }, '上下文'),
                React.createElement('span', { className: 'dsh-mb-card-v' }, fmtCtx(m.contextLength))) : null,
              // 支持模态：紧跟上下文（文本/图像/视频/音频/向量，口径与分类筛选一致）。
              Array.isArray(m.categories) && m.categories.length > 0
                ? React.createElement('div', { className: 'dsh-mb-card-line' },
                    React.createElement('span', { className: 'dsh-mb-card-k' }, '支持模态'),
                    React.createElement('span', { className: 'dsh-mb-card-v' },
                      m.categories.map((c) => CAT_LABELS[c] || c).join(' / ')))
                : null,
              fmtPrice(m, 'inPrice') !== null ? React.createElement('div', { className: 'dsh-mb-card-line' },
                React.createElement('span', { className: 'dsh-mb-card-k' }, '输入'),
                React.createElement('span', { className: 'dsh-mb-card-v' }, fmtPrice(m, 'inPrice') + '/M',
                  m.hasDiscount && m.effInPrice !== null && m.effInPrice !== m.inPrice
                    ? React.createElement('span', { className: 'dsh-mb-card-eff' }, ' → ' + fmtPrice(m, 'effInPrice'))
                    : null)) : null,
              fmtPrice(m, 'outPrice') !== null ? React.createElement('div', { className: 'dsh-mb-card-line' },
                React.createElement('span', { className: 'dsh-mb-card-k' }, '输出'),
                React.createElement('span', { className: 'dsh-mb-card-v' }, fmtPrice(m, 'outPrice') + '/M',
                  m.hasDiscount && m.effOutPrice !== null && m.effOutPrice !== m.outPrice
                    ? React.createElement('span', { className: 'dsh-mb-card-eff' }, ' → ' + fmtPrice(m, 'effOutPrice'))
                    : null)) : null,
              fmtPrice(m, 'cachePrice') !== null ? React.createElement('div', { className: 'dsh-mb-card-line' },
                React.createElement('span', { className: 'dsh-mb-card-k' }, '缓存'),
                React.createElement('span', { className: 'dsh-mb-card-v' }, fmtPrice(m, 'cachePrice') + '/M',
                  m.hasDiscount && m.effCachePrice !== null && m.effCachePrice !== m.cachePrice
                    ? React.createElement('span', { className: 'dsh-mb-card-eff' }, ' → ' + fmtPrice(m, 'effCachePrice'))
                    : null)) : null,
              m.perImagePrice !== null && m.perImagePrice !== undefined ? React.createElement('div', { className: 'dsh-mb-card-line' },
                React.createElement('span', { className: 'dsh-mb-card-k' }, '图片'),
                React.createElement('span', { className: 'dsh-mb-card-v' }, '¥' + trimNum(m.perImagePrice) + '/张')) : null,
              m.maxOutput !== null ? React.createElement('div', { className: 'dsh-mb-card-line' },
                React.createElement('span', { className: 'dsh-mb-card-k' }, '最大输出'),
                React.createElement('span', { className: 'dsh-mb-card-v' }, fmtCtx(m.maxOutput))) : null,
            ),
          ))),
        )
        rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' }, '点击卡片复制模型 ID'))
      }
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
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
          React.createElement('button', { className: 'dsh-mb-link', onClick: () => setStore({ view: 'settings' }) }, '设置'),
          ' 重新登录'))
      } else if (keysData && keysData.code === 'NO_SESSION') {
        rows.push(React.createElement('div', { className: 'dsh-mb-banner', key: 'nosess' },
          '尚未登录，请到 ',
          React.createElement('button', { className: 'dsh-mb-link', onClick: () => setStore({ view: 'settings' }) }, '设置'),
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
    function renderBalanceTab({ manifest, balance, loadBalance, goSettings, showCalls, setShowCalls, trendHoverIdx, setTrendHoverIdx, sessionAccount }) {
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
              ? '限时额度 ' + alert.expiringDays + ' 天后到期，且可用余额已不足 ¥10，尽快使用或充值'
              : alert.expiring
                ? '限时额度 ¥' + trimNum(alert.expiringBalanceCny) + ' 将于 ' + alert.expiringDays + ' 天后到期，到期未用部分失效'
                : '可用余额仅剩 ¥' + trimNum(alert.availableBalanceCny) + '，建议充值'))
        }
        // 数据归属标注：余额/趋势都是「当前登录账号」的数据，切换账号会随之变化。
        // 账号名优先 manifest 会话（Cookie 模式下 host 也会带 /api/me 的账户名），
        // 其次用余额响应里 normalizeBalance 提取的 account；都缺才显示 Cookie 模式文案。
        const dataAccount = sessionAccount || (balance && balance.data && balance.data.account) || null
        rows.push(React.createElement('div', { className: 'dsh-mb-acct-line' + (dataAccount ? '' : ' none'), key: 'acct' },
          React.createElement('span', { className: 'dsh-mb-acct-dot' }),
          '数据账号：' + (dataAccount || '未登录（Cookie 模式）'),
        ))
        // 主卡：账户余额为主位，限时额度副位（倒计时胶囊）+ 限时占比条 + 图例。
        const expiry = d.nextExpiryAt ? new Date(d.nextExpiryAt) : null
        const expiryValid = expiry !== null && !Number.isNaN(expiry.getTime())
        const expDays = expiryValid ? Math.ceil((expiry.getTime() - Date.now()) / 86400000) : null
        const chipText = expiryValid
          ? (expDays <= 0 ? '今天到期' : expDays === 1 ? '明天到期' : expDays + ' 天后到期')
            + ' · ' + (expiry.getMonth() + 1) + '月' + expiry.getDate() + '日'
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
        // 当日使用情况（本地 0 点起，聚合调用日志；含缓存命中）。
        const day = d.daily
        rows.push(React.createElement('div', { className: 'dsh-mb-day-title', key: 'daytitle' }, '当日使用'))
        rows.push(React.createElement('div', { className: 'dsh-mb-kv-grid', key: 'kv' },
          [
            ['调用', day ? (day.calls + ' 次' + (day.calls > day.successCalls ? '（成功 ' + day.successCalls + '）' : '')) : '—'],
            ['输入', day ? fmtTokens(day.inputTokens) + ' tokens' : '—'],
            ['输出', day ? fmtTokens(day.outputTokens) + ' tokens' : '—'],
            ['缓存命中', day ? fmtTokens(day.cacheReadTokens) + ' tokens' : '—'],
            ['花费', day ? '¥' + trimNum(day.costCny) : '—'],
          ].map(([k, v], i) => React.createElement('div', { className: 'dsh-mb-kv', key: i },
            React.createElement('span', { className: 'dsh-mb-kv-k' }, k),
            React.createElement('span', { className: 'dsh-mb-kv-v' }, v)))),
        )
        // 近 7 天花费趋势（迷你柱状图，柱顶直接标金额，今天高亮；悬停浮出当日模型明细）。
        if (Array.isArray(d.trend) && d.trend.length > 0) {
          const max = Math.max.apply(null, d.trend.map((b) => b.costCny).concat([0.01]))
          const totalCost = d.trend.reduce((acc, b) => acc + b.costCny, 0)
          const totalCalls = d.trend.reduce((acc, b) => acc + b.calls, 0)
          const lastDay = d.trend.length - 1
          rows.push(React.createElement('div', { className: 'dsh-mb-trend-wrap', key: 'trend' },
            React.createElement('div', { className: 'dsh-mb-day-title' },
              '近 7 天花费 · 合计 ¥' + trimNum(totalCost) + ' · ' + totalCalls + ' 次'),
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
                  className: 'dsh-mb-trend-col' + (i === lastDay ? ' today' : ''),
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
        // 最近调用（24h 内最新 10 条，折叠列表）。
        const recent = Array.isArray(d.recent) ? d.recent : []
        if (recent.length > 0) {
          rows.push(React.createElement('button', {
            className: 'dsh-mb-toggle', key: 'calls-toggle',
            onClick: () => setShowCalls(!showCalls),
          }, (showCalls ? '▾' : '▸') + ' 最近调用（24h 内 ' + recent.length + ' 条）'))
          if (showCalls) {
            rows.push(React.createElement('div', { className: 'dsh-mb-calls', key: 'calls' },
              recent.map((c, i) => {
                const t = c.t ? new Date(c.t) : null
                const time = t && !Number.isNaN(t.getTime())
                  ? String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0')
                  : '--:--'
                const ok = c.status === 200
                return React.createElement('div', { className: 'dsh-mb-call', key: i, title: (c.model || '') + ' · 状态 ' + c.status + ' · ' + (c.latencyMs || 0) + 'ms' },
                  React.createElement('span', { className: 'dsh-mb-call-dot ' + (ok ? 'ok' : 'err') }),
                  React.createElement('span', { className: 'dsh-mb-call-time' }, time),
                  React.createElement('span', { className: 'dsh-mb-call-model' }, c.model || '—'),
                  React.createElement('span', { className: 'dsh-mb-call-cost' }, '¥' + trimNum(c.costCny)),
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

    // ---- 设置页签（右上角齿轮进入）：账号卡片 + 会话状态 + 折叠的备用粘贴 ----
    function renderSettingsTab({ manifest, sessionConfigured, sessionAccount, cookieInput, setCookieInput, cookieBusy, cookieMsg, saveCookie, accounts, addAcc, setAddAcc, addPw, setAddPw, showAddPw, setShowAddPw, accBusy, accMsg, addAccount, removeAccount, loginStored, showAccPw, setShowAccPw, showBackup, setShowBackup, updInfo, updBusy, loadUpdate, copyUpdateCmd, updCopied, ignoreUpdate, entryMode, setEntryBalance }) {
      const pill = sessionConfigured
        ? React.createElement('span', { className: 'dsh-mb-status-pill ok' },
            React.createElement('span', { className: 'dsh-mb-status-dot' }),
            '已登录' + ((manifest.session && manifest.session.hint) ? ' · ' + manifest.session.hint : ''))
        : React.createElement('span', { className: 'dsh-mb-status-pill warn' },
            React.createElement('span', { className: 'dsh-mb-status-dot' }),
            '未登录')
      return React.createElement('div', { className: 'dsh-mb-section' },
        // 账号卡片
        React.createElement('div', { className: 'dsh-mb-set-card' },
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
        React.createElement('div', { className: 'dsh-mb-set-card' },
          React.createElement('div', { className: 'dsh-mb-status-row' },
            React.createElement('span', { className: 'dsh-mb-kv-k' }, '当前会话'),
            pill,
          ),
        ),
        // 备用粘贴（默认折叠）
        React.createElement('div', { className: 'dsh-mb-set-card' },
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
        // 布局与「插件更新」卡一致：标题行 + 内容行（说明靠左，按钮组贴右）。
        React.createElement('div', { className: 'dsh-mb-set-card' },
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
        // 插件更新卡片（npm dist-tags 比对）。只提醒不自动执行：宿主进程占用
        // node_modules 时自动重装有 EPERM 风险，复制命令由用户手动跑最稳。
        // 单行布局：版本 + 模式徽标 + 状态靠左，操作按钮靠右（用户定稿一行放不下
        // 不截断——状态过长时省略号，按钮组在极窄面板才整体换行）。
        React.createElement('div', { className: 'dsh-mb-set-card' },
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
      .dsh-mb-card:hover{border-color:var(--mb-line);
        background:var(--dsw-alias-interactive-bg-hover-accent,rgba(38,49,72,.14));
        box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.05))}
      .dsh-mb-card.copied{border-color:var(--mb-ok)}
      .dsh-mb-copied{font-size:10px;font-weight:600;color:var(--mb-ok)}
      .dsh-mb-hint{font-size:10.5px;color:var(--mb-sub);text-align:center;opacity:.85}
      .dsh-mb-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      /* 连通状态点：灰空心=未测、琥珀脉冲=检测中、绿=连通、红=异常；ok 时旁边带延迟。 */
      .dsh-mb-model-dot-btn{flex:none;display:inline-flex;align-items:center;gap:4px;border:none;background:transparent;
        cursor:pointer;padding:2px 4px;border-radius:6px;color:var(--mb-sub);font-size:10px;font-variant-numeric:tabular-nums;
        transition:background-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-model-dot-btn:hover:not(:disabled){background:var(--mb-soft)}
      .dsh-mb-model-dot-btn:disabled{cursor:default}
      .dsh-mb-model-dot{flex:none;width:8px;height:8px;border-radius:50%;border:1.5px solid var(--mb-tert);background:transparent}
      .dsh-mb-model-dot-btn.testing .dsh-mb-model-dot{background:var(--mb-warn);border-color:var(--mb-warn);
        animation:dsh-mb-dot-pulse 1s var(--mb-ease) infinite}
      .dsh-mb-model-dot-btn.ok .dsh-mb-model-dot{background:var(--mb-ok);border-color:var(--mb-ok)}
      .dsh-mb-model-dot-btn.fail .dsh-mb-model-dot{background:var(--mb-err);border-color:var(--mb-err)}
      .dsh-mb-model-dot-btn.nontest .dsh-mb-model-dot{opacity:.45}
      .dsh-mb-model-lat{font-weight:600;color:var(--mb-ok)}
      @keyframes dsh-mb-dot-pulse{0%,100%{opacity:1}50%{opacity:.3}}
      .dsh-mb-card-id{flex:1 1 auto;min-width:0;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt)}
      .dsh-mb-card-sub{display:flex;align-items:center;justify-content:space-between;gap:6px;font-size:10.5px;color:var(--mb-sub);overflow:hidden;margin-top:1px}
      .dsh-mb-card-src{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-card-status{flex:none;font-size:10px;line-height:16px;padding:0 6px;border-radius:6px;background:var(--mb-soft);color:var(--mb-sub)}
      .dsh-mb-card-status.on{color:var(--mb-ok);background:color-mix(in srgb,var(--mb-ok) 12%,transparent)}
      .dsh-mb-card-status.testing{color:var(--mb-warnTx);background:color-mix(in srgb,var(--mb-warn) 12%,transparent)}
      .dsh-mb-badge{font-size:10px;padding:1px 6px;border-radius:6px;background:var(--mb-soft);color:var(--mb-sub)}
      .dsh-mb-badge.disc{color:var(--mb-ok)}
      .dsh-mb-badge.on{color:var(--mb-ok)}
      .dsh-mb-badge.off{color:var(--mb-tert)}
      .dsh-mb-card-lines{display:flex;flex-direction:column;gap:2px;margin-top:7px}
      .dsh-mb-card-line{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px}
      .dsh-mb-card-k{color:var(--mb-sub);flex:none}
      .dsh-mb-card-v{font-weight:600;text-align:right;color:var(--mb-txt);font-variant-numeric:tabular-nums}
      .dsh-mb-card-eff{color:var(--mb-ok);font-weight:600}

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
      .dsh-mb-kv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
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
      .dsh-mb-calls{display:flex;flex-direction:column;gap:2px}
      .dsh-mb-call{display:flex;align-items:center;gap:8px;font-size:11.5px;padding:4px 8px;border-radius:8px;
        background:var(--mb-soft)}
      .dsh-mb-call-dot{flex:none;width:6px;height:6px;border-radius:50%}
      .dsh-mb-call-dot.ok{background:var(--mb-ok)}
      .dsh-mb-call-dot.err{background:var(--mb-err)}
      .dsh-mb-call-time{flex:none;color:var(--mb-sub);font-variant-numeric:tabular-nums}
      .dsh-mb-call-model{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt)}
      .dsh-mb-call-cost{flex:none;font-weight:600;color:var(--mb-txt);font-variant-numeric:tabular-nums}
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
      @media (prefers-reduced-motion:reduce){.dsh-mb-entry,.dsh-mb-entry-label.wide-in,.dsh-mb-trend-tip,.dsh-mb-hov{transition:none;animation:none}
        .dsh-mb-model-dot-btn.testing .dsh-mb-model-dot{animation:none}}
`;
        return module.exports;
  }
});
