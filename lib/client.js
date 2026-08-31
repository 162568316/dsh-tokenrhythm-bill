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

    // ---- tiny cross-component store（入口按钮与面板分属两个槽位，需要共享状态） ----
    const store = { open: false, view: 'models', alert: null, theme: 'H' };
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
    const fmtCtx = (n) => {
      if (n === null || n === undefined || !Number.isFinite(n)) return null
      if (n >= 1000000) return trimNum(n / 1000000) + 'M'
      if (n >= 1000) return trimNum(n / 1000) + 'K'
      return String(n)
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

    // ---- 侧栏入口按钮：wide 时带文字，窄栏只显示 ¥ 图标；有预警时右上角琥珀点 ----
    function EntryButton(props) {
      const wide = !!(props && props.wide)
      const s = useStore()
      const title = s.alert
        ? '模型 / 余额（' + (s.alert.expiring ? '限时额度 ' + s.alert.expiringDays + ' 天后到期' : '余额不足') + '）'
        : '模型 / 余额'
      return React.createElement('button', {
        className: 'dsh-mb-entry dsh-mb-th-' + (s.theme || 'H') + (s.open ? ' active' : ''),
        title,
        onClick: () => setStore({ open: !s.open }),
      },
        React.createElement('span', { className: 'dsh-mb-entry-icon' },
          '¥',
          s.alert ? React.createElement('span', { className: 'dsh-mb-dot' }) : null,
        ),
        React.createElement('span', { className: 'dsh-mb-entry-label' }, '模型 / 余额'),
      )
    }

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
      const [showBackup, setShowBackup] = useState(true) // 默认展开：粘贴恢复会话是高频操作
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

      // 外观主题：F 翡翠薄荷 / G 樱雾浅色 / H 石墨蓝钢，选择持久化到 host。
      const setThemePref = useCallback((t) => {
        setStore({ theme: t })
        void jsonPost(API + '/prefs', { prefs: { theme: t } })
      }, [])

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
          if (r.prefs.theme) setStore({ theme: r.prefs.theme })
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
            setStore({ alert: alertOf(r) })
          } else {
            setBalance({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
          }
        })
      }, [])

      // 余额：页签打开时拉取，之后每 60s 自动刷新（面板开着才刷）。
      useEffect(() => {
        if (!s.open || view !== 'balance') return
        loadBalance()
        const timer = setInterval(loadBalance, 60 * 1000)
        return () => clearInterval(timer)
      }, [view, s.open, loadBalance])

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
        const m = await jsonGet(API + '/manifest')
        if (m && m.ok) setManifest(m)
        if (view === 'balance') loadBalance()
        switchTab('balance')
      }

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
          setStore({ alert: null })
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
          setStore({ alert: null })
        } else {
          setAccMsg({ ok: false, text: (r && r.error) || '登录失败' })
        }
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
        className: 'dsh-mb-panel dsh-mb-th-' + (s.theme || 'H'),
        ref: panelRef,
        style: { left: pos.x, top: pos.y, width: pos.w, height: pos.h || undefined },
        role: 'dialog',
      },
        // 头部：标题（拖拽把手）+ 右上角动作区（设置齿轮 / 关闭）。
        React.createElement('div', { className: 'dsh-mb-head', onPointerDown: onHeaderDown },
          React.createElement('span', { className: 'dsh-mb-head-title' }, '模型 / 余额'),
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
          view === 'models' ? renderModelsTab({ manifest, providers, models, catFilter, setCatFilter, copiedId, copyId }) : null,
          view === 'balance' ? renderBalanceTab({ manifest, balance, loadBalance, goSettings: toggleSettings, showCalls, setShowCalls }) : null,
          view === 'keys' ? renderKeysTab({
            manifest, keysData, loadKeys, keyName, setKeyName, keyCreating, createKey,
            createdKey, setCreatedKey, copiedCreated, copyCreatedKey, copiedKeyId, copyReveal,
          }) : null,
          view === 'settings' ? renderSettingsTab({
            manifest, sessionConfigured, sessionAccount: (manifest && manifest.session && manifest.session.account) || null, theme: s.theme, setThemePref,
            cookieInput, setCookieInput,
            cookieBusy, cookieMsg, saveCookie,
            accounts, addAcc, setAddAcc, addPw, setAddPw, showAddPw, setShowAddPw,
            accBusy, accMsg, addAccount, removeAccount, loginStored, showAccPw, setShowAccPw,
            showBackup, setShowBackup,
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

    function renderModelsTab({ manifest, providers, models, catFilter, setCatFilter, copiedId, copyId }) {
      if (manifest && manifest.error) {
        return React.createElement('div', { className: 'dsh-mb-notice err' }, manifest.error)
      }
      if (providers.length === 0) {
        return React.createElement('div', { className: 'dsh-mb-notice' }, 'settings.yaml 里没有配置基元律动（tokenrhythm）提供商')
      }
      const rows = []
      if (models === null || models.loading) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'ld' }, '加载中…'))
      } else if (models.error) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'er' },
          models.code === 'NO_KEY' ? models.error : '拉取模型列表失败：' + models.error))
      } else {
        if (models.cached) {
          rows.push(React.createElement('div', { className: 'dsh-mb-cache-tag' + (models.stale ? ' stale' : ''), key: 'ct' },
            models.stale ? '上游失败，显示 60s 前的缓存' : '缓存（60s 内）'))
        }
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
          ))
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
              React.createElement('span', { className: 'dsh-mb-card-id', title: m.id }, m.name || m.id),
              copiedId === m.id
                ? React.createElement('span', { className: 'dsh-mb-copied' }, '已复制')
                : (m.hasDiscount ? React.createElement('span', { className: 'dsh-mb-badge disc' }, '折扣') : null),
            ),
            m.name && m.name !== m.id ? React.createElement('div', { className: 'dsh-mb-card-sub' }, m.id) : null,
            React.createElement('div', { className: 'dsh-mb-card-badges' },
              m.tools ? React.createElement('span', { className: 'dsh-mb-badge' }, '工具') : null,
              m.reasoning ? React.createElement('span', { className: 'dsh-mb-badge' }, '推理') : null,
              m.vision ? React.createElement('span', { className: 'dsh-mb-badge' }, '视觉') : null,
              m.webSearch ? React.createElement('span', { className: 'dsh-mb-badge' }, '联网') : null,
            ),
            React.createElement('div', { className: 'dsh-mb-card-lines' },
              m.contextLength !== null ? React.createElement('div', { className: 'dsh-mb-card-line' },
                React.createElement('span', { className: 'dsh-mb-card-k' }, '上下文'),
                React.createElement('span', { className: 'dsh-mb-card-v' }, fmtCtx(m.contextLength))) : null,
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
        rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'ld' }, '加载中…'))
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
    function renderKeysTab({ manifest, keysData, loadKeys, keyName, setKeyName, keyCreating, createKey, createdKey, setCreatedKey, copiedCreated, copyCreatedKey }) {
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
        rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'ld' }, '加载中…'))
      } else if (!keysData.error && Array.isArray(keysData.list)) {
        if (keysData.list.length === 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'empty' }, '还没有密钥，用上面的按钮创建一个'))
        }
        rows.push(React.createElement('div', { className: 'dsh-mb-keys-list', key: 'ls' },
          keysData.list.map((k) => React.createElement('div', { className: 'dsh-mb-key-card', key: k.id || k.masked },
            React.createElement('div', { className: 'dsh-mb-key-card-top' },
              React.createElement('span', { className: 'dsh-mb-key-card-name' }, k.name),
              React.createElement('span', { className: 'dsh-mb-badge' + (k.status === 'enabled' ? ' on' : ' off') },
                k.status === 'enabled' ? '使用中' : '已停用'),
            ),
            React.createElement('div', { className: 'dsh-mb-key-card-code' }, k.masked || '—'),
            React.createElement('div', { className: 'dsh-mb-key-card-meta' },
              k.lastUsedAt ? '最近使用 ' + (fmtDay(k.lastUsedAt) || '—') : '从未使用',
              k.createdAt ? ' · 创建于 ' + (fmtDay(k.createdAt) || '—') : ''),
          ))),
        )
        rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
          '平台安全策略：密钥只在创建时显示一次，列表里只有打码版本，可随时到官网重新创建',
          React.createElement('button', { className: 'dsh-mb-link', style: { marginLeft: 4 }, onClick: () => { try { window.open('https://tokenrhythm.studio/account/keys', '_blank') } catch { /* 拦截无碍 */ } } }, '去官网管理 ↗')))
      }
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 余额页签：限时额度 hero + 当日使用（含缓存命中）+ 7 天趋势 + 最近调用 ----
    function renderBalanceTab({ manifest, balance, loadBalance, goSettings, showCalls, setShowCalls }) {
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
        // 主卡：剩余限时额度（到期未用部分失效）。
        const expiry = d.nextExpiryAt ? new Date(d.nextExpiryAt) : null
        const expiryText = expiry && !Number.isNaN(expiry.getTime())
          ? (expiry.getMonth() + 1) + ' 月 ' + expiry.getDate() + ' 日 ' + expiry.getHours() + ':' + String(expiry.getMinutes()).padStart(2, '0') + ' 到期'
          : null
        rows.push(React.createElement('div', { className: 'dsh-mb-hero', key: 'hero' },
          React.createElement('span', { className: 'dsh-mb-hero-num' }, '¥' + trimNum(d.expiringBalanceCny)),
          React.createElement('span', { className: 'dsh-mb-hero-label' }, '剩余限时额度'),
          expiryText ? React.createElement('span', { className: 'dsh-mb-hero-expiry' }, expiryText) : null,
          d.expiringBalanceCny !== null && d.balanceCny !== null
            ? React.createElement('span', { className: 'dsh-mb-hero-sub' }, '账户余额 ¥' + trimNum(d.balanceCny) + '（含限时额度）')
            : null,
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
        // 近 7 天花费趋势（迷你柱状图，柱顶直接标金额，今天高亮）。
        if (Array.isArray(d.trend) && d.trend.length > 0) {
          const max = Math.max.apply(null, d.trend.map((b) => b.costCny).concat([0.01]))
          const totalCost = d.trend.reduce((acc, b) => acc + b.costCny, 0)
          const totalCalls = d.trend.reduce((acc, b) => acc + b.calls, 0)
          rows.push(React.createElement('div', { className: 'dsh-mb-trend-wrap', key: 'trend' },
            React.createElement('div', { className: 'dsh-mb-day-title' },
              '近 7 天花费 · 合计 ¥' + trimNum(totalCost) + ' · ' + totalCalls + ' 次'),
            React.createElement('div', { className: 'dsh-mb-trend' },
              d.trend.map((b, i) => React.createElement('div', {
                className: 'dsh-mb-trend-col' + (i === d.trend.length - 1 ? ' today' : ''),
                key: i,
                title: b.date + ' · ¥' + trimNum(b.costCny) + ' · ' + b.calls + ' 次',
              },
                React.createElement('span', { className: 'dsh-mb-trend-val' }, '¥' + trimNum(b.costCny)),
                React.createElement('div', { className: 'dsh-mb-trend-bar', style: { height: Math.max(4, Math.round(b.costCny / max * 40)) + 'px' } }),
                React.createElement('span', { className: 'dsh-mb-trend-date' }, b.date),
              )),
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
    function renderSettingsTab({ manifest, sessionConfigured, sessionAccount, theme, setThemePref, cookieInput, setCookieInput, cookieBusy, cookieMsg, saveCookie, accounts, addAcc, setAddAcc, addPw, setAddPw, showAddPw, setShowAddPw, accBusy, accMsg, addAccount, removeAccount, loginStored, showAccPw, setShowAccPw, showBackup, setShowBackup }) {
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
          React.createElement('div', { className: 'dsh-mb-set-title' }, '账号'),
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
                className: 'dsh-mb-pw-eye', title: showAddPw ? '隐藏密码' : '明文显示密码',
                onClick: () => setShowAddPw(!showAddPw),
              }, showAddPw ? '隐藏' : '明文'),
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
                    className: 'dsh-mb-key-copy', title: showAccPw === a.account ? '隐藏密码' : '明文显示密码',
                    onClick: () => setShowAccPw(showAccPw === a.account ? null : a.account),
                  }, showAccPw === a.account ? '隐藏' : '查看'),
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
        // 外观卡片
        React.createElement('div', { className: 'dsh-mb-set-card' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '外观'),
          React.createElement('div', { className: 'dsh-mb-theme-row' },
            [['F', '翡翠薄荷', '#34d399', '#a3e635'], ['G', '樱雾浅色', '#ec4899', '#a855f7'], ['H', '石墨蓝钢', '#38bdf8', '#818cf8']].map(([id, label, t1, t2]) =>
              React.createElement('button', {
                key: id,
                className: 'dsh-mb-theme-chip' + (theme === id ? ' on' : ''),
                style: { '--t1': t1, '--t2': t2 },
                title: '切换到「' + label + '」配色',
                onClick: () => setThemePref(id),
              }, React.createElement('span', { className: 'dsh-mb-theme-dot' }), label)),
          ),
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

      // 预警轮询：每 5 分钟查一次余额（面板关着也查），临期/低余额点亮入口琥珀点。
      ctx.effect(() => {
        let timer = null
        let stopped = false
        const check = async () => {
          if (stopped) return
          const m = await jsonGet(API + '/manifest')
          if (!m || !m.ok || !m.session || !m.session.configured) return
          const b = await jsonGet(API + '/balance')
          if (b && b.ok) setStore({ alert: alertOf(b) })
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

    // ---- CSS：三套可切换主题（F 翡翠薄荷 / G 樱雾浅色 / H 石墨蓝钢），全变量化 ----
    const PANEL_CSS = `
      .dsh-mb-th-F{--mb-panelBg:linear-gradient(170deg, rgba(8,24,18,.95), rgba(6,18,14,.92));
        --mb-line:rgba(52,211,153,.25);--mb-soft:rgba(52,211,153,.09);--mb-card:rgba(255,255,255,.045);
        --mb-txt:#e6f5ee;--mb-sub:#8fb5a6;--mb-acc1:#34d399;--mb-acc2:#a3e635;--mb-accS:#6ee7b7;
        --mb-acc:rgba(52,211,153,.5);--mb-glow:rgba(52,211,153,.4);
        --mb-heroBg:linear-gradient(140deg, rgba(52,211,153,.13), rgba(163,230,53,.09));
        --mb-chipOn:rgba(52,211,153,.2);--mb-barBg:rgba(143,181,166,.45);--mb-btnTx:#052e1c;
        --mb-ok:#34d399;--mb-warn:#fbbf24;--mb-err:#f87171;
        --mb-inputBg:rgba(255,255,255,.06);--mb-inputLine:rgba(255,255,255,.16);
        --mb-codeBg:rgba(52,211,153,.12);--mb-codeTx:#6ee7b7;--mb-iconTx:#052e1c;
        --mb-keyBoxBg:rgba(0,0,0,.35);--mb-shadow:0 18px 52px rgba(0,0,0,.45)}
      .dsh-mb-th-G{--mb-panelBg:linear-gradient(170deg, rgba(255,250,252,.94), rgba(250,243,250,.9));
        --mb-line:rgba(236,72,153,.22);--mb-soft:rgba(236,72,153,.08);--mb-card:rgba(255,255,255,.85);
        --mb-txt:#3d2c38;--mb-sub:#a3798f;--mb-acc1:#ec4899;--mb-acc2:#a855f7;--mb-accS:#db2777;
        --mb-acc:rgba(236,72,153,.45);--mb-glow:rgba(236,72,153,.3);
        --mb-heroBg:linear-gradient(140deg, rgba(236,72,153,.1), rgba(168,85,247,.1));
        --mb-chipOn:rgba(236,72,153,.14);--mb-barBg:rgba(163,121,143,.4);--mb-btnTx:#ffffff;
        --mb-ok:#0a7d33;--mb-warn:#b45309;--mb-err:#d5304f;
        --mb-inputBg:rgba(255,255,255,.8);--mb-inputLine:rgba(236,72,153,.25);
        --mb-codeBg:rgba(236,72,153,.1);--mb-codeTx:#db2777;--mb-iconTx:#ffffff;
        --mb-keyBoxBg:rgba(0,0,0,.05);--mb-shadow:0 18px 52px rgba(236,72,153,.18)}
      .dsh-mb-th-H{--mb-panelBg:linear-gradient(170deg, rgba(15,21,33,.96), rgba(11,15,25,.93));
        --mb-line:rgba(96,165,250,.25);--mb-soft:rgba(96,165,250,.09);--mb-card:rgba(255,255,255,.045);
        --mb-txt:#e4eaf5;--mb-sub:#8b99b8;--mb-acc1:#38bdf8;--mb-acc2:#818cf8;--mb-accS:#93c5fd;
        --mb-acc:rgba(96,165,250,.45);--mb-glow:rgba(129,140,248,.4);
        --mb-heroBg:linear-gradient(140deg, rgba(56,189,248,.12), rgba(129,140,248,.13));
        --mb-chipOn:rgba(96,165,250,.18);--mb-barBg:rgba(139,153,184,.45);--mb-btnTx:#0b1020;
        --mb-ok:#34d399;--mb-warn:#fbbf24;--mb-err:#f87171;
        --mb-inputBg:rgba(255,255,255,.06);--mb-inputLine:rgba(255,255,255,.16);
        --mb-codeBg:rgba(96,165,250,.12);--mb-codeTx:#93c5fd;--mb-iconTx:#0b1020;
        --mb-keyBoxBg:rgba(0,0,0,.35);--mb-shadow:0 18px 52px rgba(0,0,0,.45)}

      .dsh-mb-entry{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-width:0;height:34px;margin:0 2px 8px;padding:0 10px;
        cursor:pointer;border:1px solid var(--mb-line);border-radius:10px;
        background:var(--mb-panelBg);color:var(--mb-txt);font-size:13px;font-weight:500;
        -webkit-backdrop-filter:blur(18px) saturate(1.2);backdrop-filter:blur(18px) saturate(1.2);
        transition:border-color .15s ease}
      .dsh-mb-entry:hover{border-color:var(--mb-acc)}
      .dsh-mb-entry.active{border-color:var(--mb-acc2)}
      .dsh-mb-entry-icon{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;
        background:linear-gradient(135deg, var(--mb-acc1), var(--mb-acc2));color:var(--mb-iconTx);font-size:12px;font-weight:700}
      .dsh-mb-dot{position:absolute;top:-3px;right:-3px;width:7px;height:7px;border-radius:50%;background:#f59e0b;
        box-shadow:0 0 0 2px rgba(245,158,11,.3)}
      .dsh-mb-entry-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsh-mb-entry{container-type:inline-size}
      @container (max-width:60px){.dsh-mb-entry-label{display:none}.dsh-mb-entry{justify-content:center;padding:0;width:34px;height:34px;margin:0 auto 8px}}

      .dsh-mb-panel{position:fixed;z-index:10000;display:flex;flex-direction:column;
        max-height:min(80vh,760px);box-sizing:border-box;
        background:var(--mb-panelBg);color:var(--mb-txt);
        -webkit-backdrop-filter:blur(36px) saturate(1.3);backdrop-filter:blur(36px) saturate(1.3);
        border:1px solid var(--mb-line);border-radius:16px;
        box-shadow:var(--mb-shadow), inset 0 1px 0 rgba(255,255,255,.06);
        overflow:hidden;font-size:13px;line-height:1.5}
      .dsh-mb-head{flex:none;display:flex;align-items:center;justify-content:space-between;height:42px;padding:0 8px 0 14px;
        border-bottom:1px solid var(--mb-line);cursor:grab;user-select:none;touch-action:none}
      .dsh-mb-head:active{cursor:grabbing}
      .dsh-mb-head-title{font-weight:600;font-size:13px;letter-spacing:.2px;color:var(--mb-txt)}
      .dsh-mb-head-actions{display:flex;align-items:center;gap:2px}
      .dsh-mb-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
        border:none;border-radius:8px;background:transparent;cursor:pointer;color:var(--mb-sub);font-size:13px}
      .dsh-mb-iconbtn:hover{background:var(--mb-soft);color:var(--mb-txt)}
      .dsh-mb-iconbtn.active{background:var(--mb-chipOn);color:var(--mb-accS)}
      .dsh-mb-tabs{flex:none;display:flex;gap:4px;margin:8px 12px 0;padding:3px;border-radius:10px;
        background:var(--mb-soft)}
      .dsh-mb-tab{flex:1;border:none;background:transparent;cursor:pointer;padding:5px 0;border-radius:8px;
        color:var(--mb-sub);font-size:12.5px;font-weight:500;transition:background .15s ease}
      .dsh-mb-tab:hover{color:var(--mb-txt)}
      .dsh-mb-tab.active{color:var(--mb-txt);font-weight:600;
        background:var(--mb-card);border:1px solid var(--mb-acc);
        box-shadow:0 0 12px var(--mb-glow)}
      .dsh-mb-body{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 14px}
      .dsh-mb-section{display:flex;flex-direction:column;gap:8px}

      .dsh-mb-notice{padding:14px 10px;text-align:center;color:var(--mb-sub)}
      .dsh-mb-notice.err{color:var(--mb-err)}
      .dsh-mb-banner{display:flex;align-items:center;gap:2px;padding:8px 10px;border-radius:10px;font-size:12px;
        background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.4);color:var(--mb-warn)}
      .dsh-mb-link{border:none;background:transparent;cursor:pointer;padding:0 2px;font-size:12px;font-weight:600;
        color:var(--mb-accS);text-decoration:underline}

      .dsh-mb-cats{display:flex;flex-wrap:wrap;gap:6px}
      .dsh-mb-cat{cursor:pointer;border:1px solid var(--mb-acc);border-radius:999px;
        background:var(--mb-soft);color:var(--mb-accS);padding:2px 10px;font-size:12px}
      .dsh-mb-cat:hover{background:var(--mb-chipOn)}
      .dsh-mb-cat.active{background:var(--mb-chipOn);
        color:var(--mb-txt);border-color:var(--mb-acc);font-weight:600}
      .dsh-mb-cat-count{opacity:.7;font-size:11px;margin-left:1px}
      .dsh-mb-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px}
      .dsh-mb-card{padding:10px 12px;border:1px solid var(--mb-acc);border-radius:12px;
        background:var(--mb-card);cursor:pointer;transition:border-color .15s ease, box-shadow .15s ease}
      .dsh-mb-card:hover{border-color:var(--mb-acc2);box-shadow:0 0 14px var(--mb-glow)}
      .dsh-mb-card.copied{border-color:var(--mb-ok)}
      .dsh-mb-copied{font-size:10px;font-weight:600;color:var(--mb-ok)}
      .dsh-mb-hint{font-size:10.5px;color:var(--mb-sub);text-align:center;opacity:.8}
      .dsh-mb-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-card-id{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt)}
      .dsh-mb-card-sub{font-size:10.5px;color:var(--mb-sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
      .dsh-mb-card-badges{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;min-height:0}
      .dsh-mb-badge{font-size:10px;padding:1px 6px;border-radius:6px;background:var(--mb-soft);color:var(--mb-sub)}
      .dsh-mb-badge.disc{color:var(--mb-ok);background:var(--mb-soft)}
      .dsh-mb-badge.on{color:var(--mb-ok);background:var(--mb-soft)}
      .dsh-mb-badge.off{color:var(--mb-sub);background:var(--mb-soft)}
      .dsh-mb-card-lines{display:flex;flex-direction:column;gap:2px;margin-top:7px}
      .dsh-mb-card-line{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px}
      .dsh-mb-card-k{color:var(--mb-sub);flex:none}
      .dsh-mb-card-v{font-weight:600;text-align:right;color:var(--mb-txt)}
      .dsh-mb-card-eff{color:var(--mb-ok);font-weight:600}

      .dsh-mb-hero{display:flex;flex-direction:column;align-items:center;gap:2px;padding:16px 0 12px;
        border:1px solid var(--mb-acc);border-radius:14px;
        background:var(--mb-heroBg);
        -webkit-backdrop-filter:blur(24px) saturate(1.2);backdrop-filter:blur(24px) saturate(1.2)}
      .dsh-mb-hero-num{font-size:36px;font-weight:700;line-height:1.1;
        background:linear-gradient(90deg, var(--mb-acc1), var(--mb-acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
      .dsh-mb-hero-label{font-size:12px;color:var(--mb-sub)}
      .dsh-mb-hero-expiry{margin-top:4px;font-size:12px;font-weight:600;color:var(--mb-accS)}
      .dsh-mb-hero-sub{font-size:11px;color:var(--mb-sub)}
      .dsh-mb-day-title{font-size:12px;font-weight:600;color:var(--mb-sub);margin-top:2px}
      .dsh-mb-kv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px}
      .dsh-mb-kv{display:flex;flex-direction:column;gap:1px;padding:8px 10px;border-radius:10px;
        background:var(--mb-card);border:1px solid var(--mb-line)}
      .dsh-mb-kv-k{font-size:11px;color:var(--mb-sub)}
      .dsh-mb-kv-v{font-size:13px;font-weight:600;color:var(--mb-txt)}
      .dsh-mb-trend-wrap{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:10px;
        background:var(--mb-card);border:1px solid var(--mb-line)}
      .dsh-mb-trend{display:flex;align-items:flex-end;gap:5px;height:78px;padding:0 2px}
      .dsh-mb-trend-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;height:100%;justify-content:flex-end}
      .dsh-mb-trend-val{font-size:9.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--mb-txt)}
      .dsh-mb-trend-col.today .dsh-mb-trend-val{background:linear-gradient(90deg, var(--mb-acc1), var(--mb-acc2));-webkit-background-clip:text;background-clip:text;color:transparent}
      .dsh-mb-trend-bar{width:100%;max-width:28px;border-radius:4px 4px 2px 2px;background:var(--mb-barBg)}
      .dsh-mb-trend-col.today .dsh-mb-trend-bar{background:linear-gradient(180deg, var(--mb-acc1), var(--mb-acc2));box-shadow:0 0 10px var(--mb-glow)}
      .dsh-mb-trend-date{font-size:9.5px;color:var(--mb-sub);white-space:nowrap}
      .dsh-mb-toggle{align-self:flex-start;border:none;background:transparent;cursor:pointer;padding:2px 0;
        font-size:12px;font-weight:600;color:var(--mb-sub)}
      .dsh-mb-toggle:hover{color:var(--mb-txt)}
      .dsh-mb-calls{display:flex;flex-direction:column;gap:2px}
      .dsh-mb-call{display:flex;align-items:center;gap:8px;font-size:11.5px;padding:4px 8px;border-radius:8px;
        background:var(--mb-card)}
      .dsh-mb-call-dot{flex:none;width:6px;height:6px;border-radius:50%}
      .dsh-mb-call-dot.ok{background:var(--mb-ok)}
      .dsh-mb-call-dot.err{background:var(--mb-err)}
      .dsh-mb-call-time{flex:none;color:var(--mb-sub);font-variant-numeric:tabular-nums}
      .dsh-mb-call-model{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mb-txt)}
      .dsh-mb-call-cost{flex:none;font-weight:600;color:var(--mb-txt)}
      .dsh-mb-balance-foot{display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--mb-sub)}
      .dsh-mb-refresh{cursor:pointer;border:1px solid var(--mb-line);border-radius:8px;
        background:var(--mb-card);color:var(--mb-txt);padding:3px 12px;font-size:12px}
      .dsh-mb-refresh:hover{border-color:var(--mb-acc)}

      .dsh-mb-set-title{font-weight:600;font-size:13px;color:var(--mb-txt)}
      .dsh-mb-set-desc{font-size:12px;color:var(--mb-sub)}
      .dsh-mb-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
        background:var(--mb-codeBg);color:var(--mb-codeTx);border-radius:4px;padding:0 4px}
      .dsh-mb-session-row{display:flex;align-items:center;gap:8px;font-size:12px}
      .dsh-mb-ok{color:var(--mb-ok);font-weight:500}
      .dsh-mb-warn{color:var(--mb-warn);font-weight:500}
      .dsh-mb-input{width:100%;box-sizing:border-box;resize:vertical;min-height:56px;padding:8px 10px;border-radius:8px;font-size:12px;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
        border:1px solid var(--mb-inputLine);background:var(--mb-inputBg);
        color:var(--mb-txt)}
      .dsh-mb-input:focus{outline:none;border-color:var(--mb-acc)}
      .dsh-mb-input::placeholder{color:var(--mb-sub);opacity:.75}
      .dsh-mb-btn-row{display:flex;gap:8px}
      .dsh-mb-btn{cursor:pointer;border:none;border-radius:8px;padding:6px 16px;font-size:13px;font-weight:600;
        background:linear-gradient(90deg, var(--mb-acc1), var(--mb-acc2));color:var(--mb-btnTx)}
      .dsh-mb-btn:disabled{opacity:.5;cursor:default}
      .dsh-mb-btn.ghost{background:var(--mb-card);color:var(--mb-txt);
        border:1px solid var(--mb-line)}
      .dsh-mb-cookie-msg{font-size:12px;color:var(--mb-sub)}
      .dsh-mb-cookie-msg.err{color:var(--mb-err)}
      .dsh-mb-key-list{display:flex;flex-direction:column;gap:4px}
      .dsh-mb-key-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;
        border-bottom:1px dashed var(--mb-line)}
      .dsh-mb-key-name{font-weight:600;min-width:64px;color:var(--mb-txt)}
      .dsh-mb-key-copy{margin-left:auto;flex:none;cursor:pointer;border:1px solid var(--mb-line);border-radius:6px;
        background:var(--mb-card);color:var(--mb-txt);padding:1px 10px;font-size:11px}
      .dsh-mb-key-copy:hover{border-color:var(--mb-acc)}
      .dsh-mb-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;touch-action:none;
        background:linear-gradient(135deg, transparent 50%, var(--mb-sub) 45%)}
      // 外观：主题选择。
      .dsh-mb-theme-row{display:flex;gap:6px;flex-wrap:wrap}
      .dsh-mb-theme-chip{cursor:pointer;border:1px solid var(--mb-line);border-radius:999px;
        background:var(--mb-card);color:var(--mb-txt);padding:4px 14px;font-size:12px;display:inline-flex;align-items:center;gap:6px}
      .dsh-mb-theme-chip.on{border-color:var(--mb-acc);background:var(--mb-chipOn);font-weight:600;color:var(--mb-txt)}
      .dsh-mb-theme-dot{width:12px;height:12px;border-radius:50%;flex:none;
        background:linear-gradient(135deg, var(--t1), var(--t2));border:1px solid rgba(128,128,128,.3)}

      // 密钥页签：新建行 / 创建成功一次性展示 / 密钥卡片列表。
      .dsh-mb-key-create{display:flex;gap:8px;align-items:center}
      .dsh-mb-key-create .dsh-mb-input{flex:1}
      .dsh-mb-key-create .dsh-mb-btn{flex:none;padding:6px 14px}
      .dsh-mb-created{border:1px solid var(--mb-acc);border-radius:12px;padding:12px 14px;background:var(--mb-heroBg)}
      .dsh-mb-created-title{font-size:12px;font-weight:600;color:var(--mb-accS);margin-bottom:8px}
      .dsh-mb-created-key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all;
        background:var(--mb-keyBoxBg);border:1px solid var(--mb-line);border-radius:8px;padding:8px 10px;color:var(--mb-txt)}
      .dsh-mb-created .dsh-mb-btn-row{margin-top:8px}
      .dsh-mb-keys-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-keys-list{display:flex;flex-direction:column;gap:6px}
      .dsh-mb-key-card{padding:9px 12px;border:1px solid var(--mb-acc);border-radius:12px;background:var(--mb-card)}
      .dsh-mb-key-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-key-card-name{font-weight:600;font-size:12.5px;color:var(--mb-txt)}
      .dsh-mb-badge.on{color:var(--mb-ok);background:var(--mb-soft)}
      .dsh-mb-badge.off{color:var(--mb-sub);background:var(--mb-soft)}
      .dsh-mb-key-code-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:5px}
      .dsh-mb-key-card-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--mb-codeTx);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-key-card .dsh-mb-key-copy{flex:none}
      .dsh-mb-key-card-meta{font-size:10.5px;color:var(--mb-sub);margin-top:3px}
      // 设置页：分区卡片 + 账号行（头像字/当前徽标/明文切换）。
      .dsh-mb-set-card{border:1px solid var(--mb-line);border-radius:12px;background:var(--mb-card);
        padding:12px;display:flex;flex-direction:column;gap:8px}
      .dsh-mb-status-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
      .dsh-mb-status-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;
        padding:3px 12px;border-radius:999px}
      .dsh-mb-status-pill.ok{color:var(--mb-ok);background:var(--mb-soft)}
      .dsh-mb-status-pill.warn{color:var(--mb-warn);background:var(--mb-soft)}
      .dsh-mb-status-dot{width:7px;height:7px;border-radius:50%;background:currentColor}
      .dsh-mb-acc-form{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      .dsh-mb-acc-form .dsh-mb-input{flex:1;min-width:130px}
      .dsh-mb-acc-form .dsh-mb-btn{flex:none;padding:7px 14px}
      .dsh-mb-pw-wrap{position:relative;display:flex;flex:1;min-width:150px}
      .dsh-mb-pw-wrap .dsh-mb-input{flex:1;padding-right:52px}
      .dsh-mb-pw-eye{position:absolute;right:4px;top:50%;transform:translateY(-50%);cursor:pointer;
        border:none;background:transparent;color:var(--mb-accS);font-size:11px;padding:3px 6px}
      .dsh-mb-acc-list{display:flex;flex-direction:column;gap:4px}
      .dsh-mb-acc-row{display:flex;align-items:center;gap:8px;font-size:12px;padding:7px 9px;border-radius:10px;
        background:var(--mb-card);border:1px solid var(--mb-line)}
      .dsh-mb-acc-row.cur{border-color:var(--mb-ok)}
      .dsh-mb-acc-avatar{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
        border-radius:8px;background:linear-gradient(135deg, var(--mb-acc1), var(--mb-acc2));color:var(--mb-iconTx);font-weight:700;font-size:12px}
      .dsh-mb-acc-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
      .dsh-mb-acc-name{font-weight:600;color:var(--mb-txt);display:flex;align-items:center;gap:6px;min-width:0}
      .dsh-mb-acc-cur{flex:none;font-size:9.5px;font-weight:600;color:var(--mb-ok);background:var(--mb-soft);
        border-radius:5px;padding:0 5px}
      .dsh-mb-acc-pw{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--mb-sub);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-key-copy.primary{color:var(--mb-btnTx);background:linear-gradient(90deg, var(--mb-acc1), var(--mb-acc2));border:none;font-weight:600}
      .dsh-mb-key-copy.danger{color:var(--mb-err);border-color:var(--mb-err)}
      @media (prefers-reduced-motion:reduce){.dsh-mb-entry{transition:none}};
`;
        return module.exports;
  }
});
