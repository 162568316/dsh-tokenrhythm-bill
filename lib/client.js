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
 * plan quota (用量) read from ~/.zcode/v2
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
    // 头部角标要 portal 进宿主的「对话 / 轨迹」页签行（那行没有插件槽）。react-dom 宿主
    // 模块加载器确实提供（官方 ui-model-selection / ui-conversation 都 require 它），但插件
    // 环境一旦缺它，**绝不能把整个余额面板拖死**（0.7.1 就栽过一次顶层引用）——软引，
    // 取不到就没有角标，其它一切照常。
    let ReactDOM = null;
    try { ReactDOM = require('react-dom'); } catch { ReactDOM = null; }
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useRef = React.useRef;
    const useCallback = React.useCallback;

    const API = '/dsh-tokenrhythm-bill';

    // ---- tiny cross-component store（入口按钮与面板分属两个槽位，需要共享状态）。
    // balanceCny 独立于 alert 存放：alert 只在低余额/临期时有值，正常余额时为 null，
    // 入口常驻的总余额不能挂在它上面 ----
    const store = { open: false, view: 'models', alert: null, balanceCny: null, expiringItems: [], entryBalMode: 'total', entryTfMode: 'total', entryOcMode: 'balance', provider: 'tr', stepEntry: null, stepKeyPlan: null, ocKeyAccount: null, trKeyBalance: null, trProviderIds: [], trAccount: '', trAccountName: '', stepConfigured: true, stepTakeover: true, settingsOpen: false, zcEntry: null, tfEntry: null, ocEntry: null, systems: { tr: true, step: false, zcode: false, tf: false, oc: false }, sysOrder: null, sysDrag: null, sysMsg: null };
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
    // 兑换码到账额度：口径照平台网页（金额格式化 mode=wallet）= ¥ + 2 位小数 + ceil 进位。
    // 平台按「金额契约」返回固定 8 位小数字符串，所以这里不能像主卡那样 trim 成 ¥50——
    // 网页端显示的是 ¥50.00，这里必须一致。
    const fmtQuota = (n) => {
      const v = typeof n === 'string' ? Number(n) : n
      if (v === null || v === undefined || !Number.isFinite(v)) return '—'
      const r = v >= 0 ? Math.ceil(v * 100) / 100 : Math.floor(v * 100) / 100
      return '¥' + r.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
    // 日期区间：「2026-10-01 ~ 2026-10-17」两个全量 ISO 串并排，在 ~150px 宽的指标格里必
    // 然折成两行——这一页原先最占地方也最难扫的就是它。**同年两边都省年份**：「10-01 ~ 10-17」
    // （窗口格旁边写着「窗口（本月至今）」，年份本来就不言自明；完整区间在悬浮里）。
    // 跨年才两边写全（省年份就歧义了）。认不出的输入（缺 / 非 ISO）原样返回——不猜日期。
    const fmtDayRange = (from, to) => {
      const a = typeof from === 'string' ? from.trim() : ''
      const b = typeof to === 'string' ? to.trim() : ''
      const iso = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x)
      if (!iso(a) || !iso(b)) return a === '' && b === '' ? '' : (a + ' ~ ' + b)
      if (a.slice(0, 4) !== b.slice(0, 4)) return a + ' ~ ' + b
      return a.slice(5) + ' ~ ' + b.slice(5)
    }
    // 24 小时制时钟（「更新于 …」用它）。**不要用浏览器自带的本地化时刻格式化**：
    // 12/24 小时由系统区域决定，英文区域下实测输出「9:37:58 PM」——用户要求一律 24 小时制。
    const fmtClock = (ts) => {
      const d = new Date(ts)
      if (Number.isNaN(d.getTime())) return '—'
      const p = (n) => String(n).padStart(2, '0')
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
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

    // ---- 页首行（余额 / ZCode 用量 两个页签共用）：**同一行**里左边是「数据账号」
    // （见 acctLine），右边是「更新于 …」+ 刷新按钮（用户指定：这两样保持一行）。
    // 原先「数据账号」自己占一行、页脚另有一行时间+刷新；现在合成一行，时间那行从页脚
    // 挪到右上角。刷新间隔是实现细节（不显示），账号名由左侧那段承担（不重复）。
    // 没有左侧内容或没有更新时间时，缺的那部分直接不渲染。
    // （原先这里有个可选动作位 extra，挂的是清枢页首行右端那个「升级订阅 ↗」；总入口按定稿
    //  删除后它就没有调用方了，形参一并删掉——不留没人传的参数。）
    function pageTopBar({ left, at, onRefresh }) {
      return React.createElement('div', { className: 'dsh-mb-topbar' },
        left || null,
        at ? React.createElement('span', { className: 'dsh-mb-topbar-at' }, '更新于 ' + at) : null,
        React.createElement('button', { className: 'dsh-mb-refresh', onClick: onRefresh }, '刷新'),
      )
    }

    // 「数据账号」段：状态圆点 + 账号名 + 实名徽章（可选第三参，0.6.2；余额页
    // 「数据账号：Ali [已实名]」）。ZCode 用量页不带徽章，保持两参调用不动。
    // 作为 pageTopBar 的 left 传进去，靠 margin-right:auto 把右侧的时间+刷新顶到最右。
    // ok=false 时圆点转警示色（未登录 / Cookie 模式）。
    function acctLine(text, ok, badge) {
      return React.createElement('div', { className: 'dsh-mb-acct-line' + (ok ? '' : ' none') },
        React.createElement('span', { className: 'dsh-mb-acct-dot' }),
        React.createElement('span', { className: 'dsh-mb-acct-txt' }, text),
        badge || null,
      )
    }

    // 实名徽章（0.6.2）：rn 是 host realnameFromIdentity 的产物（manifest.session.realname /
    // balance.realname）。诚实口径（基元保留平台四态；阶跃侧已按用户要求二态收敛，
    // 绿/灰两种颜色与此处一致）：verified→已实名绿、reviewing→
    // 审核中琥珀、rejected→未通过（原因进 tooltip）、unverified→未实名中性灰、
    // 未知码→中性「实名: 原文」+ tooltip 平台返回值。apiAccess==='blocked'（平台实名
    // 门禁会 403 暂停 API 调用）→ 转警示态；宽限期内 tooltip 追加期限。rn 缺 → 不渲染。
    function rnBadge(rn) {
      if (!rn || !rn.status) return null
      const blocked = rn.apiAccess === 'blocked'
      const map = { verified: ['已实名', ' ok'], reviewing: ['审核中', ' pend'], rejected: ['未通过', ' no'], unverified: ['未实名', ' no'] }
      const hit = map[rn.status]
      const text = hit ? hit[0] : '实名: ' + rn.status
      const cls = 'dsh-mb-acct-rn' + (blocked ? ' warn' : hit ? hit[1] : '')
      const bits = []
      if (!hit) bits.push('实名认证状态（平台返回 ' + rn.status + '）')
      if (rn.status === 'rejected' && rn.rejectionReason) bits.push('未通过原因: ' + rn.rejectionReason)
      if (blocked) bits.push('API 调用已被平台暂停——完成实名认证后恢复')
      if (rn.required && rn.deadlineAt) {
        const d = new Date(rn.deadlineAt)
        if (!Number.isNaN(d.getTime())) {
          const rem = Number.isFinite(rn.remainingDays) ? '（还剩 ' + rn.remainingDays + ' 天）' : ''
          bits.push('实名宽限期至 ' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + rem)
        }
      }
      return React.createElement('span', {
        className: cls,
        title: bits.length > 0 ? bits.join('；') : '实名认证状态',
      }, text)
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

    // ---- 清枢智汇入口胶囊仲裁（面板切到「清枢智汇」→ 胶囊跟随显示清枢自己的数）----
    // 侧栏胶囊是常驻的一小块地方，只摆一个数，口径由「设置 → 清枢 → 胶囊接管（清枢智汇）」
    // 四选一（默认 total = 原来的行为）：
    //   total     总余额     = quota ÷ quota_per_unit（¥）
    //   expiring  限时余额   = 会到期失效的那部分（gift_expiring_schedule 里未到期的合计）÷ 单价
    //   planMoney 套餐余额   = 当前生效套餐的剩余额度（amount_total − amount_used）÷ 单价
    //   planToken 套餐 token = 当前生效套餐的剩余 token 池（basic_token_total − basic_token_used）
    // 金额与 token 是**两套单位**（与「套餐用量」页一致，绝不互相换算）；后两个口径读的是
    // 当前生效套餐那一份，没有生效套餐 → null（不编数）。quota < 0 是平台的「不限量」（常为
    // -1），走金额格式会渲染成 -¥0.0000，所以 tfMoney 单独出一句「无限量」。
    // 数据没到（未登录 / 查询失败 / 别的提供商）→ null：胶囊只换身份、不显数字，
    // **绝不拿基元余额顶上**（两家账不能混着看）。「剩余」一律走 tfRemainOf——与套餐页的
    // 进度条同一个减法，两处口径必须同源。
    function computeTfEntry(userRes, subRes, mode) {
      if (!userRes || userRes.ok !== true || !userRes.user) return null
      const u = userRes.user
      // ¥ 折算的兜底在 tfMoney 里（拿不到 quota_per_unit 时用平台同源的 5e5，绝不显示 ¥0）
      const qpu = userRes.quotaPerUnit
      const m = normalizeTfEntryMode(mode)
      if (m === 'expiring') {
        // 限时余额 0 是**有效读数**（眼下没有会到期的额度），照实显示 ¥0——它与「数据没到」
        // 不是一回事，别把它也吞成空胶囊。
        const e = u.expiringQuota
        if (typeof e !== 'number' || !Number.isFinite(e)) return null
        return { label: '清枢智汇', value: tfMoney(e, qpu) }
      }
      if (m === 'planMoney' || m === 'planToken') {
        const cur = subRes && subRes.ok === true && subRes.current ? subRes.current : null
        if (cur === null) return null
        if (m === 'planMoney') {
          if (cur.unlimitedAmount === true) return { label: '清枢智汇', value: '无限量' }
          const rem = tfRemainOf(cur.amountTotal, cur.amountUsed)
          if (rem === null) return null
          return { label: '清枢智汇', value: tfMoney(rem, qpu) }
        }
        if (cur.unlimitedTokens === true) return { label: '清枢智汇', value: '无限量' }
        // basic_token_total === 0 = 平台没给这个数（既不是 0 token 也不是无限量，见 tfTokensOf）：
        // 胶囊上什么都不显，不拿一个「0」冒充读数。
        if (cur.basicTokenTotal === 0) return null
        // 剩余走 tfRemainOf = 套餐页 tfRemainTokens 里那个减法（那边把 null 渲染成「—」，这里
        // 选择整个不显数字）；0 是「用完了」，是有效值，照实显示 0。
        const rem = tfRemainOf(cur.basicTokenTotal, cur.basicTokenUsed)
        if (rem === null) return null
        return { label: '清枢智汇', value: fmtTokens(rem) }
      }
      const q = u.quota
      if (typeof q !== 'number' || !Number.isFinite(q)) return null
      return { label: '清枢智汇', value: tfMoney(q, qpu) }
    }

    // 胶囊口径的合法值（设置里那四个 chip 与这里一份真相）。认不出的一律回落 total：老存档、
    // 手改 prefs、host 还是旧版都给不出新口径，回落到改动前的行为最安全。
    const TF_ENTRY_MODES = ['total', 'expiring', 'planMoney', 'planToken']
    const TF_ENTRY_MODE_LABELS = [['total', '总余额'], ['expiring', '限时余额'], ['planMoney', '套餐余额'], ['planToken', '套餐 token']]
    function normalizeTfEntryMode(v) {
      return TF_ENTRY_MODES.indexOf(v) >= 0 ? v : 'total'
    }

    // 清枢胶囊的最近一份数据与口径。**放工厂作用域而不是组件里的 useRef**：入口按钮、面板、
    // 以及 apply 里那轮「面板关着也跑」的常驻轮询三处都要用它——取数与持有挂在组件上的话，
    // 面板一关胶囊就没有数了（基元余额正是靠那轮常驻轮询喂的，清枢没理由不一样）。
    // user / sub 是 host 两个路由的原样响应（ok:true 才算数，见 computeTfEntry 的判据）。
    const tfPill = { user: null, sub: null, mode: 'total' }
    // 改口径 = 改 tfPill + 改 store + 当场重算胶囊值（设置里点一下就要看见数字跟着变，不等下一
    // 轮轮询）。persist = true 才回写 host：轮询那一包（/prefs）只往下同步，绝不回写，否则会
    // 拿本机旧值盖掉 host 的新值。
    const applyTfEntryMode = (mode, persist) => {
      const m = normalizeTfEntryMode(mode)
      tfPill.mode = m
      setStore({ entryTfMode: m, tfEntry: computeTfEntry(tfPill.user, tfPill.sub, m) })
      if (persist === true) void jsonPost(API + '/prefs', { prefs: { entryTfMode: m } })
    }

    // ---- OpenCSG 入口胶囊仲裁（面板切到「OpenCSG」→ 胶囊跟随显示 OpenCSG 自己的数）----
    // 与清枢那一套同一个骨架（胶囊只摆一个数，口径由设置三选一），差别只在数据源与三个口径：
    //   balance 账户余额   = balanceCents ÷ 100（**现金余额**；代金券 voucherCents 按用户定稿不参与）
    //   api     API 调用量 = 本期账单的费用合计 api.valueCents ÷ 100 —— **服务端按整个窗口算的
    //                        total_value**，不是把本页各行相加（账单口按页返回，见 readCard 那条注释）；
    //                        连费用都拿不到时才退成「N 条记录」（条数 ≠ 调用次数，所以文案写「条」）
    //   pending 待发放余额 = invite.pendingCreditCents ÷ 100（邀请口给的「已邀请成功、还没到账」）
    // 三个口径**同吃一份数据**（/opencsg/account 一次响应里就带着 balanceCents / api / invite），
    // 所以这里只需要一个 res，不像清枢要 user + sub 两份。
    // 数据没到（未登录 / 查询失败 / 别的提供商 / 字段缺失）→ null：胶囊只换身份、不显数字，
    // **绝不拿基元的余额顶上**（两家账不能混着看，与 computeTfEntry 同一条规矩）。
    function computeOcEntry(accountRes, mode) {
      if (!accountRes || accountRes.ok !== true || !accountRes.data) return null
      const u = accountRes.data
      const m = normalizeOcEntryMode(mode)
      // 三个口径都是钱（单价的除法只写这一处）：非有限数 → null（空胶囊，不摆 ¥0）
      const yuan = (c) => (typeof c === 'number' && Number.isFinite(c) ? '¥' + fmtCny(c / 100) : null)
      if (m === 'api') {
        const api = u.api && typeof u.api === 'object' ? u.api : null
        // 花费取**绝对值**：平台把扣费记成负数（.recon 实测 total_value = -3177.023324），
        // 门户那行合计也是 `Math.abs(total_value)/100`。「花费」这个词本身是正的数额，所以
        // 账户卡与用量页都取了绝对值——胶囊原先漏了这一步，同一个数在三处会写成
        // ¥31.77 / ¥31.77 / **¥-31.77**。三处必须是同一种写法。
        const vc = api !== null && typeof api.valueCents === 'number' && Number.isFinite(api.valueCents)
          ? Math.abs(api.valueCents) : null
        const money = vc === null ? null : yuan(vc)
        if (money !== null) return { label: 'OpenCSG', value: money }
        const n = api === null ? null : api.apiCount
        if (typeof n === 'number' && Number.isFinite(n)) return { label: 'OpenCSG', value: fmtTokens(n) + ' 条' }
        return null
      }
      if (m === 'pending') {
        const inv = u.invite && typeof u.invite === 'object' ? u.invite : null
        const t = inv === null ? null : yuan(inv.pendingCreditCents)
        return t === null ? null : { label: 'OpenCSG', value: t }
      }
      // 金额是分：cents ÷ 100 才是 ¥。非数（含 null）→ 空胶囊，绝不渲染成 ¥0。
      const t = yuan(u.balanceCents)
      return t === null ? null : { label: 'OpenCSG', value: t }
    }

    // 胶囊口径的合法值（设置里那三个 chip 与这里一份真相）。认不出的一律回落 balance：
    // 老存档 / 手改 prefs / host 还是旧版都给不出新口径，回落到最直白的那一个最安全
    // （0.7.0 存的 `vip` / `usage` 也走这条路：它们对应的「会员档位 / 调用次数」已经不在卡片上了）。
    const OC_ENTRY_MODES = ['balance', 'api', 'pending']
    const OC_ENTRY_MODE_LABELS = [['balance', '账户余额'], ['api', 'API 调用量'], ['pending', '待发放余额']]
    function normalizeOcEntryMode(v) {
      return OC_ENTRY_MODES.indexOf(v) >= 0 ? v : 'balance'
    }

    // OpenCSG 胶囊的最近一份数据与口径。与 tfPill 同样**放工厂作用域**：入口按钮、面板、以及
    // apply 里那轮「面板关着也跑」的常驻轮询三处共用——挂在组件上的话面板一关胶囊就没数了。
    // account 是 host /opencsg/account 的原样响应（ok:true 才算数，见 computeOcEntry 的判据）。
    const ocPill = { account: null, mode: 'balance' }
    // 改口径 = 改 ocPill + 改 store + 当场重算胶囊值（设置里点一下就要看见数字跟着变）。
    // persist = true 才回写 host：轮询那一包（/prefs）只往下同步，绝不回写，否则会拿本机旧值
    // 盖掉 host 的新值（与 applyTfEntryMode 同一条自我约束）。
    const applyOcEntryMode = (mode, persist) => {
      const m = normalizeOcEntryMode(mode)
      ocPill.mode = m
      setStore({ entryOcMode: m, ocEntry: computeOcEntry(ocPill.account, m) })
      if (persist === true) void jsonPost(API + '/prefs', { prefs: { entryOcMode: m } })
    }

    // ---- 头部角标（OpenCSG 余额）的即时刷新 ----
    // 两个入口共用这一条（v0.7.3）：
    //   · 密钥 / 账号池任何一侧动过 → force=1：归属可能变了，host 侧也会整表作废匹配缓存，
    //     这里把新结论当场拿回来，角标不等那 5 分钟轮询（v0.7.2 定稿，与 useStepKey 同一条）；
    //   · 一轮对话结束（v0.7.3 追加）→ refresh=1：刚花掉的钱要马上看见，但归属几乎不会变——
    //     只重取「账号余额快照」，复用 host 那 10 分钟归属匹配缓存。否则每轮都要把各账号的
    //     密钥列表重问一遍（本机没留明文副本的 key 是逐账号真打平台的）。
    // 取失败（网络层给 null）**留着旧值**：这是后台补充刷新，不是用户显式动作，
    // 不该把已经上屏的数一抹了之（下一轮 5 分钟轮询兜底）；host 的业务性失败（NO_KEY /
    // NO_OC_ACCOUNT / NO_MATCH…）仍是对象，照常写回让角标改口讲原因。
    // 注意「显示账号」切换（useOcAccount）**不**走这里：那只改面板看谁的账，DSH 在用的 key
    // 没动、归属没动，反查结果原样有效——多打一次请求只是白打。
    const refreshOcKeyAccount = async (opts) => {
      if (!normalizeSystems(store.systems).oc) return
      const reuseMatch = opts !== null && opts !== undefined && opts.reuseMatch === true
      const ka = await jsonGet(API + '/opencsg/key-account?' + (reuseMatch ? 'refresh=1' : 'force=1'))
      if (ka === null) return
      setStore({ ocKeyAccount: ka })
    }

    // 基元那枚角标（v0.7.3）的取数与阶跃/OpenCSG 同款，但**触发面更大**：基元只有一个活会话
    // （state.cookie 单槽），切号 / 换 cookie 会把它连账一起换掉，所以账号侧的动作也必须即时
    // 重取——与 OpenCSG「显示账号」切换**不用**重取正好相反（那边换的是「看谁的账」，DSH 在用
    // 的 key 没动；这边换的就是账本身）。两个绕缓存档与另两枚逐字一致（host 侧见
    // fetchTrKeyBalance）：
    //   · 密钥/账号动作（新增密钥、保存 cookie、添加/删除/切换账号）→ force=1：归属匹配表与
    //     余额快照都重来，角标不等那 5 分钟轮询；
    //   · 一轮对话结束 → refresh=1：刚花掉的钱要马上看见，而归属几乎不会变（只绕余额快照，
    //     复用 host 那 10 分钟归属匹配缓存）。
    // 取失败（网络层给 null）**留着旧值**：后台补充刷新不该把已上屏的数一抹了之（下一轮
    // 5 分钟轮询兜底）；host 的业务性失败（NO_KEY / NO_PROVIDER / 会话过期）仍是对象，
    // 照常写回，让角标改口讲原因。
    // 会话在用的基元 provider id（v0.7.3 修）：基元的 provider 可以是**多枚共用同一个 baseURL
    // 的短键**——本机实测 jy(基元) 与 jy131(基元1) 都指向 tokenrhythm.studio，而 host 那侧
    // find(balanceCapable) 只会命中名册第一枚。于是第二枚的会话会：① 核对归属时拿错 apiKeyEnv；
    // ② host 回带的 providerId 与会话在用的 id 不同，角标判「这个会话在用基元吗」判否，整枚消失。
    // 「这个会话在用哪一枚」只有角标组件读得到（projection），所以由它把 id 记在这里，之后
    // 轮询 / 轮末 / 账号动作的每一次取数都带上同一个 id——host 认它就用那一枚自己的钥匙核对归属，
    // 也原样回带，角标两边就都判得准了。
    let trConvProviderId = ''
    const trProviderQuery = () => (trConvProviderId === '' ? '' : '?provider=' + encodeURIComponent(trConvProviderId))
    const refreshTrKeyBalance = async (opts) => {
      if (!normalizeSystems(store.systems).tr) return
      const o = opts !== null && opts !== undefined ? opts : null
      const reuseMatch = o !== null && o.reuseMatch === true
      if (o !== null && typeof o.provider === 'string' && o.provider !== '') trConvProviderId = o.provider
      const parts = []
      if (trConvProviderId !== '') parts.push('provider=' + encodeURIComponent(trConvProviderId))
      parts.push(reuseMatch ? 'refresh=1' : 'force=1')
      const tb = await jsonGet(API + '/tr/key-balance?' + parts.join('&'))
      if (tb === null) return
      setStore({ trKeyBalance: tb })
    }

    // ---- 启用的系统（设置 → 系统管理）----
    // 面板里能出现哪几家：**默认只有基元律动**，阶跃 / ZCode / 清枢智汇要在设置里显式勾上才
    // 出现（切换器、页签、胶囊身份一起跟随）。systems 由 host prefs 持有，这里只做规范化：
    // 逐键回退（tr 认缺省开、其余认缺省关、zcode 认老存档的 prefs.zcode），并保证
    // 「至少留一个」——全关是空面板，落回基元。与 host 侧 systemsOf() 逐用例同口径。
    const SYS_KEYS = ['tr', 'step', 'zcode', 'tf', 'oc']
    const SYS_NAME = { tr: '基元律动', step: '阶跃 Step Plan', zcode: 'ZCode', tf: '清枢智汇', oc: 'OpenCSG' }
    // 每家**自己那套页签**（与下面 tabs 区按 effProv 出的那几段一一对应）。设置里每一行
    // 后面就摆这几个名字：勾了哪家、那家会多出哪些页签，一眼看到，不再写一段说明文字
    // （用户定稿 2026-10-09：说明那句不提示，每个系统后面只显示它下面的 tabs）。
    // 阶跃「密钥」页签在面板里会带当前显示账号，这里只列页签名本身。
    const SYS_TABS = {
      tr: ['余额', '用量', '模型', '状态', '密钥'],
      step: ['账户', '密钥'],
      zcode: ['用量'],
      tf: ['账户', '套餐用量', '密钥'],
      oc: ['账户', '用量', 'API Key'],
    }
    function normalizeSystems(v, legacyZcode) {
      const raw = v && typeof v === 'object' ? v : {}
      const out = {}
      for (const k of SYS_KEYS) {
        if (typeof raw[k] === 'boolean') out[k] = raw[k]
        else if (k === 'zcode') out[k] = legacyZcode === true
        else out[k] = k === 'tr'
      }
      // 至少留一个（全关 = 空面板，落回基元）。**逐键判定而非写死三键**——加 zcode、加 tf
      // 两次都差点漏掉这个泛化，漏了的表现是「只勾了那新的一家，重开面板却跳回基元」。
      if (!SYS_KEYS.some((k) => out[k])) out.tr = true
      return out
    }

    // ---- 拖动排序（设置 → 系统管理）----
    // 顺序存在 prefs.sysOrder 里，与 host 侧 sanitizeSysOrder 同一口径：**完整排列**（五家每个
    // 都在、不重、不缺）。下面三枚纯函数不碰 DOM，测试里能把真身抠出来跑（不是切字符串断言）。
    function normalizeSysOrder(v) {
      const out = []
      if (Array.isArray(v)) for (const k of v) if (SYS_KEYS.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k)
      // 缺的按默认序补末尾：老存档没有 sysOrder、或存的是「加这家之前」的旧排列，都落在这里
      for (const k of SYS_KEYS) if (out.indexOf(k) < 0) out.push(k)
      return out
    }
    // 把 list[from] 挪到 to 位（返回新数组；越界或原地不动就原样返回副本）
    function moveItem(list, from, to) {
      const out = Array.isArray(list) ? list.slice() : []
      if (from === to || from < 0 || to < 0 || from >= out.length || to >= out.length) return out
      const [one] = out.splice(from, 1)
      out.splice(to, 0, one)
      return out
    }
    // 指针纵坐标对应的**插入槽**（0..n；一行都没有给 -1）：只看每行的中线，越过谁的半高就
    // 插到谁前面。返回「槽」而不是「最终下标」是刻意的——往下拖时源行会先被抽走，槽位比下标
    // 正好多 1，调用方减掉那一下才落得准（不然往下拖永远多跳一行，这是拖拽排序的经典坑）。
    function dropSlot(rects, y) {
      if (!Array.isArray(rects) || rects.length === 0) return -1
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i]
        if (r && y < (r.top + r.bottom) / 2) return i
      }
      return rects.length
    }
    // 按拖出来的顺序排一串 [id, ...] 表（标题位切换器分段 + 设置分组页签共用；表里没有的 id
    // 排到最后，绝不丢行）
    function orderBySys(list, order) {
      const rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length : i }
      return list.slice().sort((a, b) => rank(a[0]) - rank(b[0]))
    }
    // 「刚才那一下是拖动，不是点击」（设置 → 系统管理 的整行拖动）。整行既是拖动手柄又是勾选
    // 开关，松开指针后浏览器必定补一个 click——用它把那次 click 吃掉，否则拖完一行顺手就把它
    // 勾反了。同一时刻只可能有一次拖动，所以放模块级；按下时清零，click 里消费。
    let sysDragMoved = false

    // ---- 侧栏入口按钮：形态由宿主侧栏的 wide 标志驱动（与原生「新会话」按钮同一套
    // 折叠编排：收起时宽栏内容随侧栏淡出，settle 后 rail 图标淡入），宿主未传 wide 时
    // 回退到容器查询；有预警时图标右上角琥珀点 ----
    const ENTRY_LABEL = '基元律动-费用中心'
    // 面板切到阶跃时，弹窗标题与侧栏胶囊整体换成阶跃星辰身份（用户定稿）
    const STEP_ENTRY_LABEL = '阶跃星辰-费用中心'
    // 面板切到 ZCode 时，胶囊换成 ZCode 身份（显示套餐剩余%）
    const ZC_ENTRY_LABEL = 'ZCode-费用中心'
    // 面板切到清枢智汇时，胶囊换成清枢智汇身份（显示账户余额）
    const TF_ENTRY_LABEL = '清枢智汇-费用中心'
    // 面板切到 OpenCSG 时，胶囊换成 OpenCSG 身份（显示账户余额 / API 调用量 / 待发放余额，
    // 见 computeOcEntry）
    const OC_ENTRY_LABEL = 'OpenCSG-费用中心'
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
      // 启用的系统（设置 → 系统管理）：阶跃 / ZCode / 清枢智汇 只有在设置里被勾上时，胶囊才
      // 允许换身份、才允许显示它们的数据；基元被关掉后胶囊也不再回落到基元余额（宁缺不假）。
      const sys = normalizeSystems(s.systems)
      // 阶跃胶囊接管标记（面板切到阶跃 → 胶囊跟随显示阶跃数据）
      const stepOn = sys.step && s.provider === 'step' && s.stepEntry && typeof s.stepEntry.value === 'string' && s.stepEntry.value !== ''
      // ZCode 胶囊接管标记（面板切到 ZCode → 胶囊跟随显示套餐剩余%）
      const zcOn = sys.zcode && s.provider === 'zcode' && s.zcEntry && typeof s.zcEntry.value === 'string' && s.zcEntry.value !== ''
      // 清枢智汇胶囊接管标记（面板切到清枢智汇 → 胶囊跟随显示账户余额）
      const tfOn = sys.tf && s.provider === 'tf' && s.tfEntry && typeof s.tfEntry.value === 'string' && s.tfEntry.value !== ''
      // OpenCSG 胶囊接管标记（面板切到 OpenCSG → 胶囊跟随显示它自己的数，口径见 computeOcEntry）
      const ocOn = sys.oc && s.provider === 'oc' && s.ocEntry && typeof s.ocEntry.value === 'string' && s.ocEntry.value !== ''
      // 阶跃身份（图标/文字随面板切换；账号被删 / 设置「不接管」时整体回落基元身份）
      const stepProv = sys.step && s.provider === 'step' && s.stepConfigured !== false && s.stepTakeover !== false
      // ZCode 身份：只要面板切到 ZCode 就换图标/文字；数值缺席时胶囊回落基元余额
      const zcProv = sys.zcode && s.provider === 'zcode'
      // 清枢智汇身份：同上——切过去就换图标/文字，数值没到就是空胶囊（不拿基元的账顶上）
      const tfProv = sys.tf && s.provider === 'tf'
      // OpenCSG 身份：同清枢——切过去就换身份，数值没到就是空胶囊
      const ocProv = sys.oc && s.provider === 'oc'
      // 基元预警点/预警文案只在启用基元时出现，且别家身份占用时让位（基元被关掉就不是它的账了）
      const showAlert = !!(s.alert && sys.tr && !stepProv && !zcProv && !tfProv && !ocProv)
      const title = zcOn
        ? ZC_ENTRY_LABEL + '（' + s.zcEntry.value + '）'
        : stepOn
          ? STEP_ENTRY_LABEL + '（' + s.stepEntry.value + '）'
          : tfOn
            ? TF_ENTRY_LABEL + '（' + s.tfEntry.value + '）'
            : ocOn
              ? OC_ENTRY_LABEL + '（' + s.ocEntry.value + '）'
              : showAlert
                ? ENTRY_LABEL + '（' + (s.alert.expiring ? '限时额度 ' + expiryLabel(s.alert.expiringDays) : '余额不足') + '）'
                : zcProv ? ZC_ENTRY_LABEL : stepProv ? STEP_ENTRY_LABEL : tfProv ? TF_ENTRY_LABEL : ocProv ? OC_ENTRY_LABEL : ENTRY_LABEL
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
      const hovCapable = sys.tr && hovItems.length > 0 && !s.open && !stepOn && !zcProv && !tfProv && !ocProv
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
        'aria-label': zcProv ? ZC_ENTRY_LABEL : stepProv ? STEP_ENTRY_LABEL : tfProv ? TF_ENTRY_LABEL : ocProv ? OC_ENTRY_LABEL : ENTRY_LABEL,
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
      // 基元被关掉 ⇒ 胶囊不再显示基元余额（别家的数据没到就是空胶囊，不拿基元的账顶上）
      if (!sys.tr) balText = null
      // 面板切到阶跃 → 胶囊改显阶跃数据（host 侧仲裁结果由 store.stepEntry 携带）
      if (stepOn) balText = s.stepEntry.value
      // 面板切到 ZCode → 胶囊改显套餐剩余%（store.zcEntry 由 Panel 仲裁）
      if (zcOn) balText = s.zcEntry.value
      // 面板切到清枢智汇 → 胶囊只认清枢自己的数（store.tfEntry 由 Panel 仲裁，口径见 computeTfEntry）
      // 门控用 tfProv 而不是 tfOn：tfOn 只说「眼下有清枢的数」，拿它当门控时清枢数没到就会把
      // 上面算好的**基元余额留在胶囊里**（清枢的身份配基元的钱，两家账混着看）——必须让位。
      if (tfProv) balText = tfOn ? s.tfEntry.value : null
      // 面板切到 OpenCSG → 同清枢那一条：门控用 ocProv 而不是 ocOn（理由同上——ocOn 只说
      // 「眼下有 OpenCSG 的数」，拿它当门控会在数没到时把基元余额留在胶囊里）。
      if (ocProv) balText = ocOn ? s.ocEntry.value : null
      return React.createElement(React.Fragment, null,
        React.createElement('button', btnProps,
          wide ? React.createElement('span', { className: 'dsh-mb-entry-left' },
            React.createElement('span', { className: 'dsh-mb-entry-icon' },
              zcProv ? ZcMark({ size: 16 }) : stepProv ? StepMark({ size: 16 }) : tfProv ? TfMark({ size: 16 }) : ocProv ? OcMark({ size: 16 }) : EntryMark({ size: 16 }),
              showAlert ? React.createElement('span', { className: 'dsh-mb-dot' }) : null,
            ),
            React.createElement('span', { className: 'dsh-mb-entry-label wide-in' }, zcProv ? ZC_ENTRY_LABEL : stepProv ? STEP_ENTRY_LABEL : tfProv ? TF_ENTRY_LABEL : ocProv ? OC_ENTRY_LABEL : ENTRY_LABEL),
          ) : React.createElement('span', { className: 'dsh-mb-entry-icon' },
            zcProv ? ZcMark({ size: 18 }) : stepProv ? StepMark({ size: 18 }) : tfProv ? TfMark({ size: 18 }) : ocProv ? OcMark({ size: 18 }) : EntryMark({ size: 18 }),
            showAlert ? React.createElement('span', { className: 'dsh-mb-dot' }) : null,
          ),
          wide && balText ? React.createElement('span', { className: 'dsh-mb-entry-bal' + (showAlert ? ' alert' : '') }, balText) : null,
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

    // 侧栏入口图标（清枢智汇模式）：feather pie-chart 线稿（「清枢」= 结算/账目意象），
    // 与其他 24 viewBox 线稿同语言，currentColor 跟随文字色，明暗主题自动适配。
    const TfMark = (props) => React.createElement('svg', {
      width: (props && props.size) || 16, height: (props && props.size) || 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    },
      React.createElement('path', { key: 'a', d: 'M21.21 15.89A10 10 0 1 1 8 2.83' }),
      React.createElement('path', { key: 'b', d: 'M22 12A10 10 0 0 0 12 2v10z' }),
    )

    // 侧栏入口图标（OpenCSG 模式）：feather cloud 线稿（「算力在云上」意象），
    // 与其他 24 viewBox 线稿同语言，currentColor 跟随文字色，明暗主题自动适配。
    const OcMark = (props) => React.createElement('svg', {
      width: (props && props.size) || 16, height: (props && props.size) || 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true',
      stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
    },
      React.createElement('path', { key: 'c', d: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z' }),
    )

    // ---- 面板 ----
    function Panel() {
      const s = useStore()
      const [view, setView] = useState('balance') // 'balance'|'models'|'status'|'keys'；'step-account'；'zc-usage'；'tf-user'|'tf-sub'；'oc-user'|'oc-usage'。设置走弹窗不占视图
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
      // 兑换码（体验卡）：入口在余额页「限时占比」那一行的右端（两端对齐），点击开弹窗。
      // 兑换不可撤销（码一提交就失效），所以做成两段式：第一次点「兑换」把按钮变成
      // 「确认兑换」并显示确认提示，第二次才真的发请求——和平台网页的二次确认同义，
      // 但不自己编「校验通过」这种平台没给的结论。
      const [redeemOpen, setRedeemOpen] = useState(false)
      const [redeemCode, setRedeemCode] = useState('')
      const [redeemBusy, setRedeemBusy] = useState(false)
      const [redeemArmed, setRedeemArmed] = useState(false) // true = 已点过一次，等确认
      const [redeemMsg, setRedeemMsg] = useState(null) // { text }
      const [redeemDone, setRedeemDone] = useState(null) // { quota, creditExpiresAt }
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
      const [accPwVal, setAccPwVal] = useState('') // 按需单取的明文（同一时刻只展开一个，隐藏即清空）
      const [showBackup, setShowBackup] = useState(false) // 默认折叠：保持设置页简洁，需要时再展开
      // 平台密钥页签
      const [keysData, setKeysData] = useState(null)
      const [keyName, setKeyName] = useState('')
      const [keyCreating, setKeyCreating] = useState(false)
      const [createdKey, setCreatedKey] = useState(null) // {name, key, savedLocal}：完整值只在创建响应里出现一次
      const [copiedCreated, setCopiedCreated] = useState(false)
      const [keyMsg, setKeyMsg] = useState(null) // 密钥页签的一句反馈（复制失败 / 清了本机副本）
      // ---- 阶跃（StepFun）面板：提供商切换 + 用量/账户两页签 + 设置卡状态 ----
      const [provider, setProvider] = useState('tr') // 'tr' | 'step' | 'zcode'（manifest.step.prefs.provider 播种）
      const providerInitRef = useRef(false)
      const lastStepTabRef = useRef('step-account')
      const lastZcTabRef = useRef('zc-usage')
      const lastTfTabRef = useRef('tf-user')
      const lastOcTabRef = useRef('oc-user')
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
      // ---- ZCode 页签（额度展示；读 ~/.zcode/v2 凭证，接口经 host 代理）----
      const [zcQuota, setZcQuota] = useState(null)
      const [zcMsg, setZcMsg] = useState(null)
      // ---- 清枢智汇（TierFlow）页签：账户 + 套餐用量 ----
      // 账号管理照搬阶跃账户页那一套（添加=先真登一次再入库、切换显示、两段式删除、
      // 密码只给掩码再单取），差别只在凭据：清枢是平台下发的会话 cookie（host 侧落盘、
      // 30 天有效），没有设备码那一路，也没有 refresh——失效就按存的密码重登一次。
      const [tfUser, setTfUser] = useState(null) // /tierflow/user：{ ok, user, usage, quotaPerUnit }
      const [tfSub, setTfSub] = useState(null) // /tierflow/subscription：{ ok, current, subs }
      const [tfAccs, setTfAccs] = useState(null) // /tierflow/accounts：{ accounts, activeAccount }
      const [tfDetailBusy, setTfDetailBusy] = useState(false)
      const [tfAcc, setTfAcc] = useState('')
      const [tfAccPw, setTfAccPw] = useState('')
      const [showTfPw, setShowTfPw] = useState(false)
      const [tfAccBusy, setTfAccBusy] = useState(false)
      const [tfAccMsg, setTfAccMsg] = useState(null)
      const [tfAddOpen, setTfAddOpen] = useState(false)
      const [tfConfirm, setTfConfirm] = useState(null) // 待确认删除的 identifier（两段式，防误触）
      const [tfOpen, setTfOpen] = useState({}) // 各账号「近 7 日消耗」明细的展开态（与阶跃 stepOpen 同款）
      const [tfPwShown, setTfPwShown] = useState(null) // 明文显示密码的账号（同一时刻只展开一个）
      const [tfPwVal, setTfPwVal] = useState('')
      // ---- 清枢「按量 API Key」页签（v0.7.4，照 OpenCSG 那套）----
      // 平台列表只回服务端掩码，明文只在创建响应出现一次 → 创建时落本机副本，
      // 之后「复制完整值」从本机单取；启停/删除直连平台口；orphanIds 是平台已删本机还留的副本。
      const [tfKeys, setTfKeys] = useState(null) // { loading } | { list, total, orphanIds, account } | { error }
      const [tfKeyName, setTfKeyName] = useState('')
      const [tfKeyUnlimited, setTfKeyUnlimited] = useState(true) // 官方表单默认值同：不限量
      const [tfKeyQuota, setTfKeyQuota] = useState('') // 限额（元），勾限量才生效
      const [tfKeyExpire, setTfKeyExpire] = useState('never') // never/30/90（天数）
      const [tfKeyBusy, setTfKeyBusy] = useState(false)
      const [tfKeyMsg, setTfKeyMsg] = useState(null)
      const [tfKeyCreated, setTfKeyCreated] = useState(null) // 一次性明文 { name, key, savedLocal }
      const [tfKeyCopied, setTfKeyCopied] = useState(null) // 刚复制过的行（'created' 或密钥编号）
      const [tfKeyConfirm, setTfKeyConfirm] = useState(null) // 待确认删除的密钥编号（两段式，防误触）
      // 升级订阅弹窗（用户定稿「升级订阅直接弹窗」）：套餐详情列表 + 逐档升级差价。
      // 弹窗挂在面板根上（和设置 / 兑换码两个弹窗同一层），不跟着正文滚动，所以
      // 关掉「套餐用量」页签也不会把它留在半空。
      const [tfPlansOpen, setTfPlansOpen] = useState(false)
      const [tfPlans, setTfPlans] = useState(null)
      // 升级弹窗看哪一份订阅：带订阅号 = 只看那一份（订阅卡进来）；`null` = 全部可升的
      // （弹窗里「看全部订阅」退回），页首那个总入口已按定稿删除
      // （套餐用量页每张订阅卡右端各自的「升级套餐」）。同一层弹窗、同一个取数，只是收窄视图。
      const [tfPlansScope, setTfPlansScope] = useState(null)
      // 余额升级的待确认记录（定稿「我们只用余额升级即可，不使用微信和支付宝」）：
      // 点某一档的「余额升级」→ 记下 subNo / 目标档 / 差价 / 点时的余额快照 → 二次确认框
      // （真花钱，必须两步）→ POST /tierflow/upgrade → 成功刷新余额 / 订阅 / 套餐三份数据。
      const [tfUpgrade, setTfUpgrade] = useState(null)
      // 购买订阅弹窗（定稿「账户的部分添加购买订阅的功能，只能余额买」+「不要放在最上面，
      // 挪到账号卡片上」）：**每张账号卡「限时占 x%」那条图例行右端**那枚「购买订阅」开的就是
      // 它（定稿「购买订阅 和 限时占 73% 部分 两端对齐」＋「购买订阅 按钮 添加 颜色」把它从
      // 脚行挪到了读数行、并改用品牌色胶囊）——钱只从**那张卡这个账号**的余额扣（平台的
      // POST /api/subscription/balance/pay；微信 / 支付宝那条不接），
      // 所以弹窗自带一份**按那张卡的账号取**的套餐目录 `tfBuyPlans`，不与「当前显示」那个账号
      // 共用 `tfPlans`——共用的话，给别的账号买一次就会把它的余额 / 订阅算到这个账号头上。
      // `tfBuyFor` = 正在为哪个账号买（`null` = 弹窗关着）。与升级弹窗各管一头：升级 = 已有订阅
      // 换更贵的档（付差价），购买 = 新开一份（付整价）。
      const [tfBuyFor, setTfBuyFor] = useState(null)
      const [tfBuyPlans, setTfBuyPlans] = useState(null)
      // 购买待确认记录（真花钱，两步）：点某一档的「余额购买」→ 记下 planSlug / 整价 / 点时的
      // 余额快照 / **付款账号**（identifier 一并带上，中途换了「当前显示」也不会扣错账号）→
      // 二次确认 → POST /tierflow/purchase → 成功刷新余额 / 订阅 / 套餐。
      const [tfBuy, setTfBuy] = useState(null)
      // ---- OpenCSG 页签：账户 + 用量 ----
      // 账号管理照搬清枢「账户」页那一套（添加=先真登一次再入库、切换显示、两段式删除、
      // 密码只给掩码再单取）。差别只在数据源：OpenCSG 一个账号一份 /opencsg/account 快照，
      // 卡面上的三件事（账户余额 / API 调用量 / 待发放余额）全出自那一份，不像清枢要 user + 订阅两份。
      // **没有购买 / 升级弹窗**：OpenCSG 这边按用户定稿只读不买，所以一整套 tfPlans / tfBuy
      // 那类 state 在这里一个都不需要（少一层钱相关的状态就少一处出错的地方）。
      const [ocAccs, setOcAccs] = useState(null) // /opencsg/accounts：{ accounts, activeAccount }
      const [ocUsage, setOcUsage] = useState(null) // /opencsg/usage：data = 同一份账户快照 { balanceCents, bonusCents, api, invite, atMs }
      const [ocDetailBusy, setOcDetailBusy] = useState(false)
      const [ocAcc, setOcAcc] = useState('')
      const [ocAccPw, setOcAccPw] = useState('')
      const [showOcPw, setShowOcPw] = useState(false)
      const [ocAccBusy, setOcAccBusy] = useState(false)
      const [ocAccMsg, setOcAccMsg] = useState(null)
      const [ocAddOpen, setOcAddOpen] = useState(false)
      const [ocConfirm, setOcConfirm] = useState(null) // 待确认删除的 identifier（两段式，防误触）
      const [ocPwShown, setOcPwShown] = useState(null) // 明文显示密码的账号（同一时刻只展开一个）
      const [ocPwVal, setOcPwVal] = useState('')
      // ---- OpenCSG「API Key」页签（门户 /settings/api-keys 同款口，2026-10-17 实测）----
      // 状态机与阶跃密钥那一组同构（列表 / 名称 / 创建中 / 一次性明文 / 复制反馈 / 两段式删除），
      // 但**没有「复制完整值」那条**：列表只回服务端掩码、平台也没有单取完整值的口（见宿主
      // ocKeyListOf 上方注释）——能力不存在，就不摆按钮。有效期是门户同款三选一。
      const [ocKeys, setOcKeys] = useState(null) // { loading } | { list, account } | { error }
      const [ocKeyName, setOcKeyName] = useState('')
      const [ocKeyExpire, setOcKeyExpire] = useState('never') // 'never' | '30d' | '90d'
      const [ocKeyBusy, setOcKeyBusy] = useState(false)
      const [ocKeyMsg, setOcKeyMsg] = useState(null)
      const [ocKeyCreated, setOcKeyCreated] = useState(null) // {name, key} 完整值只显示一次
      const [ocKeyCopied, setOcKeyCopied] = useState(null) // 'created' | key id（复制成功反馈，一闪而过）
      const [ocKeyConfirm, setOcKeyConfirm] = useState(null) // 待确认删除的 key id（两段式，防误触）
      // 清枢胶囊要的两份数据与口径**不放组件里**：入口按钮、面板、以及 apply 里那轮常驻轮询
      // （面板关着也跑）三处共用，所以落在工厂作用域的 tfPill 上（见 computeTfEntry 下面）。
      // 面板自己那两个 state（tfUser / tfSub）只喂「账户 / 套餐用量」页，胶囊不读它。
      const [settingsTab, setSettingsTab] = useState('sys') // 设置弹窗分组：系统管理/基元/阶跃/关于
      // ---- 阶跃接口密钥维护（设置 → 阶跃卡）：控制台同款新增/复制/删除。
      // host 列表只回掩码；完整值创建时展示一次、复制时按需单取。----
      const [stepKeys, setStepKeys] = useState(null)
      const [stepKeyName, setStepKeyName] = useState('')
      const [stepKeyBusy, setStepKeyBusy] = useState(false)
      const [stepKeyMsg, setStepKeyMsg] = useState(null)
      const [stepKeyCreated, setStepKeyCreated] = useState(null) // {name, key} 完整值只显示一次
      const [stepKeyCopied, setStepKeyCopied] = useState(null) // 'created' | keyId（复制成功反馈）
      const [stepKeyConfirm, setStepKeyConfirm] = useState(null) // 待确认删除的 keyId（两段式，防误触）
      const [stepKeyUseConfirm, setStepKeyUseConfirm] = useState(null) // 待确认「设为使用」的 keyId（同两段式）
      // ---- 基元「用量」页签（0.5.5）----
      // usage：host 把 /api/usage/panel（汇总/按模型/按客户端/Top 花费）与
      // /api/usage-daily（按天明细）合成一个 /usage 响应，前端只发 1 个请求。
      // 按天数据**不是**逐日拉的：usage-daily 的 data 本身就是 date × model ×
      // Key × clientApp 的扁平行，host 分桶成 daily.days 直接下发。
      const [usage, setUsage] = useState(null)
      const [calHover, setCalHover] = useState(null) // 悬停的 'YYYY-MM-DD'

      // 复制这把密钥的完整值。明文有两条来源，按「它在哪」分（别混成一条）：
      //   · hasLocal：创建时 host 落过本机副本（state.trKeys）→ 按 id 零网络直取；
      //   · copyable：本机正在用的那把就是这一行 → 拿前缀/后缀回 host 比对后返回。
      // 平台列表只回掩码、也没有按 id 单取明文的口，除这两条再没有第三条路。
      const copyReveal = useCallback(async (k) => {
        const r = k && k.hasLocal === true
          ? await jsonGet(API + '/keys/reveal?id=' + encodeURIComponent(k.id))
          : await jsonGet(API + '/key-reveal?prefix=' + encodeURIComponent(k.prefix) + '&suffix=' + encodeURIComponent(k.masked.split('****').pop()))
        if (r && r.ok && await copyText(r.key)) {
          setCopiedKeyId(k.id)
          setTimeout(() => setCopiedKeyId((cur) => (cur === k.id ? null : cur)), COPY_FLASH_MS)
        } else {
          setKeyMsg({ ok: false, text: (r && r.error) || '复制失败' })
        }
      }, [])
      // 清掉本机留存的那份明文（平台上的密钥不动）：之后这一行回到只能看掩码，
      // 想再要完整值只能重新创建一把（平台没有按 id 单取明文的口）。
      const forgetTrKeyLocal = async (k) => {
        const r = await jsonPost(API + '/keys/forget', { ids: [k.id] })
        if (r && r.ok) {
          setKeyMsg({ ok: true, text: '已删除「' + (k.name || '未命名') + '」的本机副本（平台上的密钥不受影响）' })
          void loadKeys()
        } else {
          setKeyMsg({ ok: false, text: (r && r.error) || '删除本机副本失败' })
        }
      }
      // 平台已经删掉、本机还留着的副本（官网删 key 的情况）：host 不自动清（明文删了回不来），
      // 只把 id 报上来，用户点这里才真删。
      const forgetTrKeyOrphans = async (ids) => {
        if (!Array.isArray(ids) || ids.length === 0) return
        const r = await jsonPost(API + '/keys/forget', { ids })
        if (r && r.ok) {
          setKeyMsg({ ok: true, text: '已清掉 ' + (r.removed || ids.length) + ' 份本机副本（平台上的密钥不受影响）' })
          void loadKeys()
        } else {
          setKeyMsg({ ok: false, text: (r && r.error) || '清理本机副本失败' })
        }
      }

      // 复制完整 API Key 到剪贴板（host 返回明文但界面只显示「已复制」反馈）。

      const setPosSafe = (p) => { posRef.current = p; setPos(p) }

      // 设置改为右上角齿轮打开的弹窗（不再占视图）；进出不改变当前页签。
      const switchTab = useCallback((id) => {
        if (String(id).indexOf('step-') === 0) lastStepTabRef.current = id
        else if (String(id).indexOf('zc-') === 0) lastZcTabRef.current = id
        else if (String(id).indexOf('tf-') === 0) lastTfTabRef.current = id
        else if (String(id).indexOf('oc-') === 0) lastOcTabRef.current = id
        else lastTabRef.current = id
        setView(id)
        setStore({ view: id })
      }, [])
      const toggleSettings = useCallback(() => {
        setStore({ settingsOpen: !(store.settingsOpen === true) })
      }, [])

      // ---- 面板提供商切换（标题分段器：基元 / 阶跃 / ZCode / 清枢智汇）；选择持久化到 host
      // prefs（跨会话记忆）。切到阶跃 / ZCode / 清枢智汇 → 胶囊跟随换身份 + 显数
      // （store.stepEntry / zcEntry / tfEntry，由 EntryButton 消费）。----
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
        const want = p === 'step' ? 'step' : p === 'zcode' ? 'zcode' : p === 'tf' ? 'tf' : p === 'oc' ? 'oc' : 'tr'
        // 只能切到已启用的系统（设置里没勾的那家连切换器都不出现，这里是防手滑/防陈旧回调）
        if (!normalizeSystems(store.systems)[want]) return
        if (want === provider) return
        setProvider(want)
        providerRef.current = want
        // 切提供商即仲裁胶囊：ZCode 用最近一次额度缓存、清枢智汇用最近一次账户页缓存、
        // OpenCSG 用最近一次账户快照（无数据就只换身份，绝不拿别家的数字顶上）。
        // 口径取 tfPill.mode / ocPill.mode（见 computeTfEntry / computeOcEntry）
        setStore({
          provider: want,
          zcEntry: want === 'zcode' ? computeZcEntry({ provider: 'zcode', quota: zcQuotaRef.current }) : null,
          tfEntry: want === 'tf' ? computeTfEntry(tfPill.user, tfPill.sub, tfPill.mode) : null,
          ocEntry: want === 'oc' ? computeOcEntry(ocPill.account, ocPill.mode) : null,
        })
        void jsonPost(API + '/stepfun/prefs', { prefs: { provider: want } })
        setView((v) => {
          if (want === 'step') return String(v).indexOf('step-') === 0 ? v : lastStepTabRef.current
          if (want === 'zcode') return String(v).indexOf('zc-') === 0 ? v : lastZcTabRef.current
          if (want === 'tf') return String(v).indexOf('tf-') === 0 ? v : lastTfTabRef.current
          if (want === 'oc') return String(v).indexOf('oc-') === 0 ? v : lastOcTabRef.current
          const sv = String(v)
          return sv.indexOf('step-') === 0 || sv.indexOf('zc-') === 0 || sv.indexOf('tf-') === 0 || sv.indexOf('oc-') === 0 ? lastTabRef.current : v
        })
      }, [provider])
      // 当前提供商必须是「已启用的系统」，否则统一回落到第一个启用的系统。这一条覆盖了
      // 原本分散的两处回落，也是「系统管理」关掉一家后的落地：① 关掉的正停着的那家；
      // ② 持久化的 provider 是阶跃但账号已删（阶跃仍启用 → 仍停在阶跃，页签里就是登录
      // 表单，不再把人踢回基元）；③ 关掉 ZCode / 清枢智汇。全关不可能（host 与设置卡都
      // 保证至少留一个），兜底仍落基元。
      useEffect(() => {
        const sys = normalizeSystems(s.systems)
        if (sys[provider]) return
        switchProvider(sys.tr ? 'tr' : sys.step ? 'step' : sys.zcode ? 'zcode' : sys.tf ? 'tf' : 'oc')
      }, [provider, s.systems, switchProvider])

      useEffect(() => { providerRef.current = provider }, [provider])

      // provider 与 view 必须同族（TR 页签配基元、step 页签配阶跃、zc 页签配 ZCode、
      // tf 页签配清枢智汇）——否则持久化的提供商在首包接管时，面板会以「A 页签 + B 内容」
      // 的错位状态初始化（view 初始硬编码 'balance'，switchProvider 对已就位的 provider 会早退不搬 view）。
      useEffect(() => {
        const isStep = String(view).indexOf('step-') === 0
        const isZc = String(view).indexOf('zc-') === 0
        const isTf = String(view).indexOf('tf-') === 0
        const isOc = String(view).indexOf('oc-') === 0
        if (provider === 'step' && !isStep) { setView(lastStepTabRef.current); setStore({ view: lastStepTabRef.current }) }
        else if (provider === 'zcode' && !isZc) { setView(lastZcTabRef.current); setStore({ view: lastZcTabRef.current }) }
        else if (provider === 'tf' && !isTf) { setView(lastTfTabRef.current); setStore({ view: lastTfTabRef.current }) }
        else if (provider === 'oc' && !isOc) { setView(lastOcTabRef.current); setStore({ view: lastOcTabRef.current }) }
        else if (provider !== 'step' && isStep) { setView(lastTabRef.current); setStore({ view: lastTabRef.current }) }
        else if (provider !== 'zcode' && isZc) { setView(lastTabRef.current); setStore({ view: lastTabRef.current }) }
        else if (provider !== 'tf' && isTf) { setView(lastTabRef.current); setStore({ view: lastTabRef.current }) }
        else if (provider !== 'oc' && isOc) { setView(lastTabRef.current); setStore({ view: lastTabRef.current }) }
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
          jsonGet(API + '/stepfun/profile?force=1&username=' + encodeURIComponent(username)),
        ]).then(([p, b, pr]) => {
          setStepAccs((cur) => {
            if (cur === null) return cur
            const next = { ...cur, busy: { ...(cur.busy || {}), [username]: false } }
            next.plans = { ...(cur.plans || {}) }
            next.balances = { ...(cur.balances || {}) }
            next.profiles = { ...(cur.profiles || {}) }
            if (p && p.ok) next.plans[username] = { ...p, cached: false }
            else if (p) next.plans[username] = { ok: false, error: p.error, code: p.code }
            if (b && b.ok) next.balances[username] = { ...b, cached: false }
            else if (b) next.balances[username] = { ok: false, error: b.error, code: b.code }
            // 资料失败不写槽：卡片保留旧资料（头像/昵称/实名），别让一次网络抖动闪没
            if (pr && pr.ok) next.profiles[username] = { ...pr, cached: false }
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

      // ---- ZCode 页签：用量 60s 轮询。----
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
      useEffect(() => {
        if (!s.open || provider !== 'zcode') return
        loadZcQuota()
        const t = setInterval(loadZcQuota, 60 * 1000)
        return () => clearInterval(t)
      }, [s.open, provider, view, loadZcQuota])

      // ---- 清枢智汇：账户 / 套餐用量 / 账号清单 ----
      // 三个 GET 各自独立：账户页要账号 + 各账号的缓存快照（余额/用量/套餐），套餐用量页要全部订阅。
      // host 侧 5 分钟缓存 + 单飞 + 陈旧兜底，这里 60s 轻轮询（命中缓存时零网络）。
      // 与阶跃同一口径：只在面板打开且选中这家时轮询——面板关着不空转打平台。
      const loadTfUser = useCallback((force) => {
        setTfUser((cur) => ({ loading: true, data: cur && cur.data }))
        jsonGet(API + '/tierflow/user' + (force === true ? '?force=1' : '')).then((r) => {
          if (r && r.ok) {
            // atMs = 本机收到时刻（「更新于 …」用它）；host 侧缓存命中时另有 cachedAt
            const data = { ...r, atMs: Date.now() }
            tfPill.user = data
            setTfUser({ loading: false, data })
            // 口径可能就是「套餐余额 / 套餐 token」：那份 sub 数据在 tfPill 里现读
            setStore({ tfEntry: computeTfEntry(data, tfPill.sub, tfPill.mode) })
            // 账户页现在是「每张卡自己显示自己」：当期账号刚拉到的新快照要当场写进
            // 账号清单里那一张卡，不然这轮 60s 轮询之前，页上看着还是旧数。
            setTfAccs((cur) => {
              if (cur === null || !Array.isArray(cur.accounts)) return cur
              const k = String(data.account || '').toLowerCase()
              if (k === '') return cur
              return { ...cur, accounts: cur.accounts.map((a) => String(a.identifier).toLowerCase() === k
                ? { ...a, user: data.user, usage: data.usage, usageError: data.usageError || '' }
                : a) }
            })
          } else {
            tfPill.user = null
            setTfUser({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
            setStore({ tfEntry: null }) // 无数据 → 胶囊只换身份，不显数字（不拿基元的账顶上）
          }
        })
      }, [])
      const loadTfSub = useCallback((force) => {
        setTfSub((cur) => ({ loading: true, data: cur && cur.data }))
        jsonGet(API + '/tierflow/subscription' + (force === true ? '?force=1' : '')).then((r) => {
          if (r && r.ok) {
            const data = { ...r, atMs: Date.now() }
            tfPill.sub = data
            setTfSub({ loading: false, data })
            // 胶囊口径落在「套餐余额 / 套餐 token」时，这一份就是胶囊的数：拿到就重算。
            // 失败不重算、也不清空——tfPill.sub 里还是上一次的好数（网络抖一下不该让胶囊变空）。
            setStore({ tfEntry: computeTfEntry(tfPill.user, data, tfPill.mode) })
          } else {
            setTfSub({ loading: false, error: (r && r.error) || '加载失败', code: r && r.code })
          }
        })
      }, [])
      // 设置里点口径：落库（applyTfEntryMode，工厂作用域那份）+ 补取这个口径要的那份数据。
      // **不能只改口径**——手上正好没有那份数据时（面板没开在清枢页签、或刚启动）用户会看到
      // 一个空胶囊，像设置没生效。host 侧 5 分钟缓存 + 单飞，这一次补取几乎不花钱。
      const setTfEntryMode = useCallback((mode) => {
        applyTfEntryMode(mode, true)
        const m = normalizeTfEntryMode(mode)
        if (m === 'planMoney' || m === 'planToken') loadTfSub()
        else loadTfUser()
      }, [loadTfSub, loadTfUser])
      // 套餐目录的数据：host 侧一次打包回「套餐列表 + 当前订阅到各档的差价 + 余额快照」
      // （差价是平台 quote 现算的，不是前端拿两个价相减）。force=1 穿透 5 分钟缓存；
      // identifier 缺省 = 「当前显示」那个账号（host 侧同口径）。落到哪个 state 由 apply 决定
      // ——购买弹窗要给**别的账号**取目录，两份 state 绝不能互相覆盖。
      const fetchTfPlans = useCallback((force, identifier, apply) => {
        const qs = []
        if (force === true) qs.push('force=1')
        if (typeof identifier === 'string' && identifier !== '') qs.push('identifier=' + encodeURIComponent(identifier))
        apply((cur) => ({ loading: true, data: cur && cur.data }))
        jsonGet(API + '/tierflow/plans' + (qs.length > 0 ? '?' + qs.join('&') : '')).then((r) => {
          if (r && r.ok) apply({ loading: false, data: { ...r, atMs: Date.now() } })
          else apply({ loading: false, error: (r && r.error) || '套餐列表加载失败', code: r && r.code })
        })
      }, [])
      // 升级弹窗 / 套餐用量页共用的那份：**当前显示**账号的目录（订阅卡上「可升档位」也靠它）。
      const loadTfPlans = useCallback((force) => fetchTfPlans(force, '', setTfPlans), [fetchTfPlans])
      // 购买弹窗自己那份：为 `identifier` 这个**账号卡**取（每张卡各买各的余额），与上面那份
      // 互不覆盖——给 B 买一次，不能把 A 的余额 / 订阅算成 B 的。
      const loadTfBuyPlans = useCallback(
        (force, identifier) => fetchTfPlans(force, identifier, setTfBuyPlans), [fetchTfPlans])
      // 账号清单 + 各账号已缓存的余额/用量/套餐快照：host 侧纯读内存，零网络。
      const loadTfAccs = useCallback(() => {
        jsonGet(API + '/tierflow/accounts').then((r) => {
          if (r && r.ok) setTfAccs(r)
          else setTfAccs({ error: (r && r.error) || '账号清单加载失败' })
        })
      }, [])
      // 顺序补齐所有账号（host 侧串行 + 30s 登录冷却）。已登录过的账号直接复用本地会话、
      // 一个登录请求都不发；只有真缺会话的才依次登一次，所以常态开销接近零。
      const loadTfAccsDetail = useCallback(() => {
        setTfDetailBusy(true)
        jsonPost(API + '/tierflow/accounts-detail', {}).then((r) => {
          setTfDetailBusy(false)
          if (r && r.ok) {
            setTfAccs(r)
            // 主卡数据同步成新一轮：当期账号的余额/套餐跟卡片数字保持一致
            loadTfUser(true)
            loadTfSub(true)
          } else if (r) {
            setTfAccs((cur) => ({ ...(cur || {}), error: r.error || '查询失败' }))
          } else setTfAccs((cur) => ({ ...(cur || {}), error: '查询失败' }))
        })
      }, [loadTfUser, loadTfSub])
      // 记录一次待确认的余额升级。差价与余额都取「点下去那一刻」面板上看到的数，
      // 提交时原样带回 host 比对——平台在这中间改了价就不扣款，让用户对着新价重按一次。
      const askTfUpgrade = useCallback((sub, plan, quote, bal, qpu) => {
        if (quote === null || quote.amountDue === null) return
        setTfUpgrade({
          subNo: sub.subNo,
          planSlug: plan.slug,
          fromTitle: sub.planTitle === '' ? sub.planSlug : sub.planTitle,
          toTitle: plan.title === '' ? plan.slug : plan.title,
          due: quote.amountDue,
          balance: bal === undefined ? null : bal,
          quotaPerUnit: qpu,
          step: 'confirm',
          busy: false,
          msg: null,
        })
      }, [])
      const submitTfUpgrade = useCallback(() => {
        if (tfUpgrade === null || tfUpgrade.busy === true) return
        const subNo = tfUpgrade.subNo
        const planSlug = tfUpgrade.planSlug
        const due = tfUpgrade.due
        setTfUpgrade((cur) => (cur === null ? cur : { ...cur, busy: true, msg: null }))
        jsonPost(API + '/tierflow/upgrade', { subNo, planSlug, expectedDue: due }).then((r) => {
          if (r && r.ok) {
            setTfUpgrade((cur) => (cur === null ? cur : { ...cur, busy: false, step: 'done', msg: null }))
            loadTfPlans(true)
            loadTfSub(true)
            loadTfAccs()
            return
          }
          const q = r && r.quote ? r.quote : null
          setTfUpgrade((cur) => (cur === null ? cur : {
            ...cur,
            busy: false,
            step: 'confirm', // 差价变了也留在确认框里，只是把新价填上、把原因写在下面
            due: q !== null && q.amountDue !== null ? q.amountDue : cur.due,
            msg: (r && r.error) || '升级失败',
          }))
        })
      }, [tfUpgrade, loadTfPlans, loadTfSub, loadTfAccs])
      // 单个账号强制重查（卡片上的「刷新」）：只动那一张卡的数据，不动当期账号的主卡。
      const refreshTfAccount = useCallback((identifier) => {
        setTfAccs((cur) => (cur === null ? cur : { ...cur, busy: { ...(cur.busy || {}), [identifier]: true } }))
        Promise.all([
          jsonGet(API + '/tierflow/user?force=1&identifier=' + encodeURIComponent(identifier)),
          jsonGet(API + '/tierflow/subscription?force=1&identifier=' + encodeURIComponent(identifier)),
        ]).then(([u, s]) => {
          setTfAccs((cur) => {
            if (cur === null || !Array.isArray(cur.accounts)) return cur
            const accounts = cur.accounts.map((a) => {
              if (String(a.identifier).toLowerCase() !== String(identifier).toLowerCase()) return a
              const next = { ...a }
              // 失败不覆盖旧快照：一次网络抖动不该把卡片上的数字抹成空
              if (u && u.ok) { next.user = u.user; next.usage = u.usage; next.usageError = u.usageError || '' }
              if (s && s.ok) next.subscription = s.current
              if (!(u && u.ok) && !(s && s.ok)) next.error = (u && u.error) || (s && s.error) || '查询失败'
              else next.error = ''
              return next
            })
            return { ...cur, accounts, busy: { ...(cur.busy || {}), [identifier]: false } }
          })
        })
      }, [])
      useEffect(() => {
        if (!s.open || provider !== 'tf' || view !== 'tf-user') return
        loadTfUser()
        const t = setInterval(loadTfUser, 60 * 1000)
        return () => clearInterval(t)
      }, [s.open, provider, view, loadTfUser])
      useEffect(() => {
        if (!s.open || provider !== 'tf' || view !== 'tf-sub') return
        // 订阅之外再取一次套餐目录：订阅卡上「升级套餐」按钮只在**还有更高的档**时才出现
        // （最高档不出按钮——点了弹窗里那一组也是空的）。只取一次、不进 60s 轮询：
        // 目录 5 分钟一换，真要动它时（升级成功、手点刷新）都是显式 force=1。
        loadTfPlans()
        loadTfSub()
        const t = setInterval(loadTfSub, 60 * 1000)
        return () => clearInterval(t)
      }, [s.open, provider, view, loadTfSub, loadTfPlans])
      // 胶囊当前显示的就是清枢（provider === 'tf'）→ 把它要的那份数据取回来，别等用户正好翻到
      // 那一页。上面两个 effect 是**按页签**取数的（账户页取账户、套餐页取套餐），而胶囊的口径
      // 是设置里的选择：选了「套餐余额」却停在账户页时，套餐那份永远不来，胶囊就是个空的。
      // 门控与它们同一口径（面板开着 + 选中的是清枢）：面板关着不空转打平台。依赖里不放 view：
      // 换页签时上面那两个 effect 各自会取自己那份，这里只在「打开 / 切到清枢」时补一次。
      useEffect(() => {
        if (!s.open || provider !== 'tf') return
        const m = tfPill.mode
        if (m === 'planMoney' || m === 'planToken') loadTfSub()
        else loadTfUser()
      }, [s.open, provider, loadTfUser, loadTfSub])
      // 账号清单两个页签都要：账户页摆账号管理区，套餐用量页靠它标出「当前是哪个账号」。
      // 补齐进行中把轮询间隔压到 1.2s（纯内存读，等的是 host 侧那串顺序登录）。
      useEffect(() => {
        if (!s.open || provider !== 'tf') return
        loadTfAccs()
        const t = setInterval(loadTfAccs, tfDetailBusy ? 1200 : 60 * 1000)
        return () => clearInterval(t)
      }, [s.open, provider, loadTfAccs, tfDetailBusy])
      // ---- 清枢按量密钥：列表 + 五个动作（与 OpenCSG 密钥页同一套骨架）----
      // 密钥属于「当前显示账号」：显示账号一变就重拉；列表口是真请求（要会话、可能触发
      // 登录），不进轮询，页签打开/账号切换/显式刷新才打一次（与 loadOcKeys 同律）。
      const tfAccIdent = tfAccs && typeof tfAccs.activeAccount === 'string' && tfAccs.activeAccount !== ''
        ? tfAccs.activeAccount : ''
      const tfKeysAccountRef = useRef('')
      const loadTfKeys = useCallback(async (identifier) => {
        setTfKeys((cur) => ({ loading: true, list: cur && cur.list ? cur.list : null }))
        const q = typeof identifier === 'string' && identifier !== ''
          ? ('?identifier=' + encodeURIComponent(identifier)) : ''
        const r = await jsonGet(API + '/tierflow/apikeys' + q)
        if (r && r.ok) {
          tfKeysAccountRef.current = typeof r.account === 'string' ? r.account : ''
          setTfKeys({
            loading: false,
            list: r.keys || [],
            total: typeof r.total === 'number' ? r.total : (r.keys || []).length,
            // 平台已删、本机还留着的副本：host 不自动清（明文删了回不来），用户点一下才真删
            orphanIds: Array.isArray(r.orphanIds) ? r.orphanIds : [],
            account: tfKeysAccountRef.current,
          })
        } else {
          // 失败不覆盖旧列表：一次抖动不该把已有密钥抹成空（与 loadOcKeys 同款）
          setTfKeys((cur) => ({
            loading: false,
            list: cur && cur.list ? cur.list : null,
            account: cur && cur.account ? cur.account : '',
            error: (r && r.error) || '密钥列表加载失败',
            code: r && r.code,
          }))
        }
      }, [])
      useEffect(() => {
        if (!s.open || provider !== 'tf' || view !== 'tf-keys') return
        if (tfAccIdent !== '' && tfKeysAccountRef.current === tfAccIdent) return
        loadTfKeys(tfAccIdent)
      }, [s.open, provider, view, loadTfKeys, tfAccIdent])
      const createTfKey = async () => {
        const name = tfKeyName.trim()
        if (!name) { setTfKeyMsg({ ok: false, text: '请填写密钥名称' }); return }
        if (name.length > 128) { setTfKeyMsg({ ok: false, text: '名称不超过 128 字符' }); return }
        const unlimited = tfKeyUnlimited === true
        let quotaYuan
        if (!unlimited) {
          quotaYuan = Number(tfKeyQuota)
          if (!Number.isFinite(quotaYuan) || quotaYuan <= 0) {
            setTfKeyMsg({ ok: false, text: '限额要大于 0 元（或直接勾「不限量」）' }); return
          }
        }
        setTfKeyBusy(true)
        setTfKeyMsg(null)
        const r = await jsonPost(API + '/tierflow/apikey-create', {
          name, unlimited,
          quota_yuan: unlimited ? undefined : quotaYuan,
          expired_days: tfKeyExpire === 'never' ? undefined : Number(tfKeyExpire),
          // 显式带上当前显示账号：中途换账号也不会把钥匙建到别人名下（与 OC/阶跃同款）
          identifier: tfAccIdent === '' ? undefined : tfAccIdent,
        })
        setTfKeyBusy(false)
        if (r && r.ok) {
          setTfKeyCreated({ name, key: r.key, savedLocal: r.saved === true })
          setTfKeyName('')
          setTfKeyQuota('')
          setTfKeyMsg({ ok: true, text: '已创建「' + name + '」' + (r.saved === true ? '——完整密钥已在本机留存一份，历史列表里也能复制' : '') })
          void loadTfKeys(tfAccIdent)
          void copyText(r.key) // 创建即自动复制，防用户忘复制（平台此后再也吐不出明文）
        } else {
          setTfKeyMsg({ ok: false, text: (r && r.error) || '创建失败' })
        }
      }
      const copyTfCreatedKey = async () => {
        if (tfKeyCreated && await copyText(tfKeyCreated.key)) {
          setTfKeyCopied('created')
          setTimeout(() => setTfKeyCopied((cur) => (cur === 'created' ? null : cur)), COPY_FLASH_MS)
        }
      }
      // 复制**本机留存**的完整密钥：按需单取（点按钮才发这一次），界面从头到尾只见掩码。
      const revealTfKey = async (k) => {
        const q = (tfAccIdent === '' ? '' : '&identifier=' + encodeURIComponent(tfAccIdent))
        const r = await jsonGet(API + '/tierflow/apikey-reveal?keyId=' + encodeURIComponent(k.no) + q)
        if (r && r.ok && typeof r.key === 'string' && r.key !== '') {
          if (await copyText(r.key)) {
            setTfKeyCopied(k.no)
            setTimeout(() => setTfKeyCopied((cur) => (cur === k.no ? null : cur)), COPY_FLASH_MS)
          }
        } else {
          setTfKeyMsg({ ok: false, text: (r && r.error) || '本机没有这把密钥的完整值' })
        }
      }
      const forgetTfKey = async (k) => {
        const r = await jsonPost(API + '/tierflow/apikey-forget', {
          keyIds: [k.no],
          identifier: tfAccIdent === '' ? undefined : tfAccIdent,
        })
        if (r && r.ok) {
          setTfKeyMsg({ ok: true, text: '已删除「' + (k.name || '未命名') + '」的本机副本（平台上的密钥不受影响）' })
          void loadTfKeys(tfAccIdent)
        } else {
          setTfKeyMsg({ ok: false, text: (r && r.error) || '删除本机副本失败' })
        }
      }
      const forgetTfKeyOrphans = async (ids) => {
        if (!Array.isArray(ids) || ids.length === 0) return
        const r = await jsonPost(API + '/tierflow/apikey-forget', {
          keyIds: ids,
          identifier: tfAccIdent === '' ? undefined : tfAccIdent,
        })
        if (r && r.ok) {
          setTfKeyMsg({ ok: true, text: '已清掉 ' + (r.removed || ids.length) + ' 份本机副本（平台上的密钥不受影响）' })
          void loadTfKeys(tfAccIdent)
        } else {
          setTfKeyMsg({ ok: false, text: (r && r.error) || '清理本机副本失败' })
        }
      }
      // 启停：1 启用 ↔ 2 停用（3 过期 / 4 耗尽是平台自判态，界面上没有开关可拨）
      const toggleTfKeyStatus = async (k) => {
        const next = k.status === 1 ? 2 : 1
        setTfKeyBusy(true)
        setTfKeyMsg(null)
        const r = await jsonPost(API + '/tierflow/apikey-status', {
          keyId: k.no, status: next,
          identifier: tfAccIdent === '' ? undefined : tfAccIdent,
        })
        setTfKeyBusy(false)
        if (r && r.ok) {
          setTfKeyMsg({ ok: true, text: (next === 1 ? '已启用「' : '已停用「') + (k.name || '未命名') + '」' })
          void loadTfKeys(tfAccIdent)
        } else {
          setTfKeyMsg({ ok: false, text: (r && r.error) || (next === 1 ? '启用失败' : '停用失败') })
        }
      }
      const deleteTfKey = async (k) => {
        // 两段式确认：误点第一次只进入待确认态，再点一次才真删（删除立即失效，不可恢复）
        if (tfKeyConfirm !== k.no) { setTfKeyConfirm(k.no); return }
        setTfKeyConfirm(null)
        setTfKeyBusy(true)
        const r = await jsonPost(API + '/tierflow/apikey-delete', {
          keyId: k.no,
          identifier: tfAccIdent === '' ? undefined : tfAccIdent,
        })
        setTfKeyBusy(false)
        if (r && r.ok) {
          setTfKeyMsg({ ok: true, text: '已删除「' + (k.name || '未命名') + '」（本机副本同步清掉）' })
          void loadTfKeys(tfAccIdent)
        } else {
          setTfKeyMsg({ ok: false, text: (r && r.error) || '删除失败' })
        }
      }

      // ---- OpenCSG 取数（账户 / 用量两个页签 + 胶囊共用的那一份账户快照）----
      // 与清枢同一套节奏：host 侧 5 分钟缓存 + 单飞，这里 60s 轻轮询（命中缓存时零网络），
      // 且只在「面板打开 + 选中的是 OpenCSG」时轮询——面板关着不空转打平台（关着时的胶囊数
      // 由 apply 里那轮常驻轮询负责，见下面 alert poll 里那段）。
      // 账户快照 = /opencsg/account（一个账号一份：账户余额 / API 调用量 / 待发放余额都在里面）。
      // 它同时喂三处：账户页里那张卡、用量页的页首、以及胶囊（口径见 computeOcEntry）——
      // 所以一取到就往 ocPill 里存一份，并把账号清单里对应的那张卡就地刷新。
      const loadOcAccount = useCallback((force) => {
        jsonGet(API + '/opencsg/account' + (force === true ? '?force=1' : '')).then((r) => {
          if (r && r.ok) {
            const data = { ...r, atMs: Date.now() }
            ocPill.account = data
            setStore({ ocEntry: computeOcEntry(data, ocPill.mode) })
            // 账户页是「每张卡自己显示自己」：当期账号刚拉到的新快照当场写进清单里那一张卡，
            // 不然这轮 60s 轮询之前页上看着还是旧数（与 loadTfUser 同一条理由）。
            // 认哪张卡：/opencsg/account 不带 identifier 时取的就是「当前显示」那个账号，
            // 所以用 cur.activeAccount 落位；顺带按 identifier / uuid 兜一手（host 若把
            // identifier 一并回出来，就直接用它，不依赖清单里的 activeAccount 是否同步）。
            setOcAccs((cur) => {
              if (cur === null || !Array.isArray(cur.accounts)) return cur
              const snap = data.data || null
              const keys = [data.identifier, cur.activeAccount]
                .filter((v) => typeof v === 'string' && v !== '')
                .map((v) => v.toLowerCase())
              const uid = snap && typeof snap.uuid === 'string' ? snap.uuid : ''
              if (keys.length === 0 && uid === '') return cur
              return { ...cur, accounts: cur.accounts.map((a) => {
                const hit = keys.indexOf(String(a.identifier).toLowerCase()) >= 0
                  || (uid !== '' && a.account && a.account.uuid === uid)
                return hit ? { ...a, account: snap, at: data.at, error: '' } : a
              }) }
            })
          } else {
            // 失败不清 ocPill.account 的旧值、也不清空胶囊：网络抖一下不该让胶囊变空
            // （与 loadTfSub 的「失败不重算、也不清空」同一条自我约束）。只把错误挂到清单上。
            if (r) setOcAccs((cur) => (cur === null ? cur : { ...cur, error: r.error || '账户加载失败', code: r.code }))
          }
        })
      }, [])
      // 账号清单 + 各账号已缓存的快照：host 侧纯读内存，零网络。
      const loadOcAccs = useCallback(() => {
        jsonGet(API + '/opencsg/accounts').then((r) => {
          if (r && r.ok) setOcAccs(r)
          else setOcAccs({ error: (r && r.error) || '账号清单加载失败' })
        })
      }, [])
      // 顺序补齐所有账号（host 侧串行 + 登录冷却）。已登录过的账号直接复用本地会话、
      // 一个登录请求都不发；只有真缺会话的才依次登一次，所以常态开销接近零。
      const loadOcAccsDetail = useCallback(() => {
        setOcDetailBusy(true)
        jsonPost(API + '/opencsg/accounts-detail', {}).then((r) => {
          setOcDetailBusy(false)
          if (r && r.ok) {
            // accounts-detail 回的是**两张表**：`list`（数组，每条带 identifier/pwMask/account/at，
            // 卡片直接吃）+ `accounts`（宿主缓存 map，键是会话槽，另一种形状）。原先整份塞进
            // state，卡片的 `Array.isArray(accounts)` 判不成立 → 「查询全部」之后整页空白，
            // 要等下一次轮询才回来（ocDetailBusy 一落，轮询就退回 60s 一拍，空白能挂一分钟）。
            // 现在把数组那份对上：accounts 不是数组时兜 r.list（同一形状，at/pwMask 都在）。
            setOcAccs({ ...r, accounts: Array.isArray(r.accounts) ? r.accounts : (Array.isArray(r.list) ? r.list : []) })
            // 清单刚被整批刷新：胶囊那一份也同步跟上（口径不变，只是换了新数）
            loadOcAccount(true)
          } else if (r) {
            setOcAccs((cur) => ({ ...(cur || {}), error: r.error || '查询失败' }))
          } else setOcAccs((cur) => ({ ...(cur || {}), error: '查询失败' }))
        })
      }, [loadOcAccount])
      // 单个账号强制重查（卡片上的「刷新」）：只动那一张卡，不动「当前显示」那一份。
      const refreshOcAccount = useCallback((identifier) => {
        setOcAccs((cur) => (cur === null ? cur : { ...cur, busy: { ...(cur.busy || {}), [identifier]: true } }))
        jsonGet(API + '/opencsg/account?force=1&identifier=' + encodeURIComponent(identifier)).then((r) => {
          setOcAccs((cur) => {
            if (cur === null || !Array.isArray(cur.accounts)) return cur
            const accounts = cur.accounts.map((a) => {
              if (String(a.identifier).toLowerCase() !== String(identifier).toLowerCase()) return a
              const next = { ...a }
              // 失败不覆盖旧快照：一次网络抖动不该把卡片上的数字抹成空（与 refreshTfAccount 同款）
              if (r && r.ok) {
                next.account = r.data
                // at 只在带回合法数时才覆盖——host 成功路径现在必带取数时刻；万一缺
                // （老 host/降级响应），保留卡片旧时间也比抹成「—」诚实。
                if (typeof r.at === 'number' && r.at > 0) next.at = r.at
                next.error = ''
              }
              else next.error = (r && r.error) || '查询失败'
              return next
            })
            return { ...cur, accounts, busy: { ...(cur.busy || {}), [identifier]: false } }
          })
        })
      }, [])
      // 用量页：订阅口给的「各资源本期已用 / 配额」明细（按产品线分组）。
      // **这里把 host 的信封拆掉一层**：ocUsage.data 直接就是那份快照
      // （与 ocAccs 里每条 account 的形状一致，渲染层两处口径同源）。
      const loadOcUsage = useCallback((force) => {
        setOcUsage((cur) => ({ loading: true, data: cur && cur.data }))
        jsonGet(API + '/opencsg/usage' + (force === true ? '?force=1' : '')).then((r) => {
          // 失败不覆盖旧快照：一次网络抖动不该把明细抹成空（与 refreshOcAccount 同款）
          if (r && r.ok && r.data) setOcUsage({ loading: false, data: r.data })
          else setOcUsage((cur) => ({ loading: false, data: cur && cur.data, error: (r && r.error) || '用量加载失败', code: r && r.code }))
        })
      }, [])
      useEffect(() => {
        if (!s.open || provider !== 'oc' || view !== 'oc-user') return
        loadOcAccs()
        const t = setInterval(loadOcAccs, ocDetailBusy ? 1200 : 60 * 1000)
        return () => clearInterval(t)
      }, [s.open, provider, view, loadOcAccs, ocDetailBusy])
      useEffect(() => {
        if (!s.open || provider !== 'oc' || view !== 'oc-usage') return
        loadOcUsage()
        const t = setInterval(loadOcUsage, 60 * 1000)
        return () => clearInterval(t)
      }, [s.open, provider, view, loadOcUsage])
      // ---- OpenCSG「API Key」（门户 /settings/api-keys 同款口）：列表 / 创建 / 删除 ----
      // 密钥属于「当前显示账号」：账号清单拉回来后，显示账号一变就必须重拉（阶跃密钥同款）。
      // 已加载过哪个账号记在 ref 里（进 state 会让依赖环路），列表挂 loading 骨架。
      const ocKeysAccountRef = useRef('')
      const loadOcKeys = useCallback(async (identifier) => {
        setOcKeys((cur) => ({ loading: true, list: cur && cur.list ? cur.list : null }))
        const q = typeof identifier === 'string' && identifier !== ''
          ? ('?identifier=' + encodeURIComponent(identifier)) : ''
        const r = await jsonGet(API + '/opencsg/apikeys' + q)
        if (r && r.ok) {
          ocKeysAccountRef.current = typeof r.account === 'string' ? r.account : ''
          setOcKeys({
            loading: false,
            list: r.keys || [],
            // 平台已删、本机还留着的副本（官网删 key 的那种）：host 不自动清（明文删了回不来），
            // 只报 id 上来，用户点一下才真删。
            orphanIds: Array.isArray(r.orphanIds) ? r.orphanIds : [],
            account: ocKeysAccountRef.current,
          })
        } else {
          // 失败**不覆盖旧列表**：一次网络抖动不该把已有密钥抹成空（与 loadOcUsage 同款），
          // 只把错误挂上去让列表上方显示一句原因。
          setOcKeys((cur) => ({
            loading: false,
            list: cur && cur.list ? cur.list : null,
            account: cur && cur.account ? cur.account : '',
            error: (r && r.error) || '密钥列表加载失败',
            code: r && r.code,
          }))
        }
      }, [])
      // 当前显示账号（= host 的 activeAccount，由账户卡上的「显示」按钮设置）。密钥页靠它判
      // 「显示账号换了没」——换人就重拉，不换就不打那个真请求。
      const ocAccIdent = ocAccs && typeof ocAccs.activeAccount === 'string' && ocAccs.activeAccount !== ''
        ? ocAccs.activeAccount : ''
      useEffect(() => {
        if (!s.open || provider !== 'oc' || view !== 'oc-keys') return
        // 已经为当前显示账号拉过就不再打：/opencsg/apikeys 是真请求（要取会话、可能触发登录）。
        if (ocAccIdent !== '' && ocKeysAccountRef.current === ocAccIdent) return
        loadOcKeys(ocAccIdent)
      }, [s.open, provider, view, loadOcKeys, ocAccIdent])
      const createOcKey = async () => {
        const name = ocKeyName.trim()
        if (!name) { setOcKeyMsg({ ok: false, text: '请填写密钥名称' }); return }
        if (name.length > 128) { setOcKeyMsg({ ok: false, text: '名称不超过 128 字符' }); return }
        setOcKeyBusy(true)
        setOcKeyMsg(null)
        const r = await jsonPost(API + '/opencsg/apikey-create', {
          name, expire: ocKeyExpire,
          // 显式带上当前显示账号：中途换了账号也不会把钥匙建到别人名下（与阶跃 key-create 同款）
          identifier: ocAccIdent === '' ? undefined : ocAccIdent,
        })
        setOcKeyBusy(false)
        if (r && r.ok) {
          setOcKeyCreated({ name: r.name || name, key: r.key, savedLocal: r.savedLocal === true })
          setOcKeyName('')
          setOcKeyMsg({ ok: true, text: '已创建「' + (r.name || name) + '」——完整密钥已在本机留存一份，历史列表里也能复制' })
          void loadOcKeys(ocAccIdent)
          void copyText(r.key) // 创建即自动复制，防用户忘复制（与基元/阶跃密钥同款）
          // 新建的这把若被粘进 DSH，头部角标下一轮就该认它——当场 force 反查一次（1966 同款）
          void refreshOcKeyAccount()
        } else {
          setOcKeyMsg({ ok: false, text: (r && r.error) || '创建失败' })
        }
      }
      const copyOcCreatedKey = async () => {
        if (ocKeyCreated && await copyText(ocKeyCreated.key)) {
          setOcKeyCopied('created')
          setTimeout(() => setOcKeyCopied((cur) => (cur === 'created' ? null : cur)), COPY_FLASH_MS)
        }
      }
      // 复制**本机留存**的完整密钥（用户定稿「新创建的密钥存到本地」）：完整值按需单取
      // （/opencsg/apikey-reveal，点这个按钮才发这一次），界面从头到尾只见掩码。
      // 与基元 /key-reveal 同一条路：复制的是 host 自己存的那份，不经过任何服务器。
      const revealOcKey = async (k) => {
        const q = (ocAccIdent === '' ? '' : '&identifier=' + encodeURIComponent(ocAccIdent))
        const r = await jsonGet(API + '/opencsg/apikey-reveal?keyId=' + encodeURIComponent(k.id) + q)
        if (r && r.ok && typeof r.key === 'string' && r.key !== '') {
          if (await copyText(r.key)) {
            setOcKeyCopied(k.id)
            setTimeout(() => setOcKeyCopied((cur) => (cur === k.id ? null : cur)), COPY_FLASH_MS)
          }
        } else {
          setOcKeyMsg({ ok: false, text: (r && r.error) || '本机没有这把密钥的完整值' })
        }
      }
      // 清掉本机保存的明文副本（不动平台那把）：之后这一行回到「只显示掩码」，
      // 想再复制只能去官网（平台没有按 id 单取明文的口）。
      const forgetOcKey = async (k) => {
        const r = await jsonPost(API + '/opencsg/apikey-forget', {
          keyIds: [k.id],
          identifier: ocAccIdent === '' ? undefined : ocAccIdent,
        })
        if (r && r.ok) {
          setOcKeyMsg({ ok: true, text: '已删除「' + (k.name || '未命名') + '」的本机副本（平台上的密钥不受影响）' })
          void loadOcKeys(ocAccIdent)
          void refreshOcKeyAccount() // 本机副本没了，若正被 DSH 用着 → 角标当场改口
        } else {
          setOcKeyMsg({ ok: false, text: (r && r.error) || '删除本机副本失败' })
        }
      }
      // 平台已经删掉、本机还留着的副本（官网删 key 的情况）：host 不自动清（明文删了回不来），
      // 只把 id 报上来，用户点这里才真删。
      const forgetOcKeyOrphans = async (ids) => {
        if (!Array.isArray(ids) || ids.length === 0) return
        const r = await jsonPost(API + '/opencsg/apikey-forget', {
          keyIds: ids,
          identifier: ocAccIdent === '' ? undefined : ocAccIdent,
        })
        if (r && r.ok) {
          setOcKeyMsg({ ok: true, text: '已清掉 ' + (r.removed || ids.length) + ' 份本机副本（平台上的密钥不受影响）' })
          void loadOcKeys(ocAccIdent)
          void refreshOcKeyAccount()
        } else {
          setOcKeyMsg({ ok: false, text: (r && r.error) || '清理本机副本失败' })
        }
      }
      const deleteOcKey = async (k) => {
        // 两段式确认：误点第一次只进入待确认态，再点一次才真删（删除立即失效，不可恢复）
        if (ocKeyConfirm !== k.id) { setOcKeyConfirm(k.id); return }
        setOcKeyConfirm(null)
        const r = await jsonPost(API + '/opencsg/apikey-delete', {
          keyId: k.id,
          identifier: ocAccIdent === '' ? undefined : ocAccIdent,
          // 把行的「是否内置」带上：宿主据此拦下内置 key 的删除（门户也只允许删自建）
          row: { isBuiltin: k.isBuiltin === true },
        })
        if (r && r.ok) {
          setOcKeyMsg({ ok: true, text: '已删除「' + (k.name || '未命名') + '」' })
          void loadOcKeys(ocAccIdent)
          void refreshOcKeyAccount() // 平台上这把没了：若正是 DSH 在用的，角标立即改「状态」口径
        } else {
          setOcKeyMsg({ ok: false, text: (r && r.error) || '删除失败' })
        }
      }
      // 账户快照两个页签与胶囊都要（账户卡面要用、用量页页首要标出「当前是哪个账号」）。
      // 只取一次、不进轮询：它真花钱（一个平台请求），显式动作（查询全部 / 刷新 / 切账号 /
      // 改口径）才强制重取；常态由 host 缓存兜。
      useEffect(() => {
        if (!s.open || provider !== 'oc') return
        loadOcAccount()
      }, [s.open, provider, loadOcAccount])
      // 设置里点口径：落库（applyOcEntryMode，工厂作用域那份）之外再补取一次账户快照。
      // **不能只改口径**——刚启动或面板没开在 OpenCSG 页签时手上没有数，用户会看到一个空胶囊，
      // 像设置没生效（与 setTfEntryMode 同一条）。三个口径同吃一份数据，所以只补这一份。
      const setOcEntryMode = useCallback((mode) => {
        applyOcEntryMode(mode, true)
        loadOcAccount()
      }, [loadOcAccount])
      // OpenCSG 账号管理：添加=先真登一次再入库；切换显示/两段式删除/密码单取。
      const addOcAccount = async () => {
        setOcAccBusy(true)
        setOcAccMsg(null)
        const r = await jsonPost(API + '/opencsg/account/add', { identifier: ocAcc.trim(), password: ocAccPw })
        setOcAccBusy(false)
        if (!r || !r.ok) { setOcAccMsg({ ok: false, text: (r && r.error) || '操作失败' }); return }
        setOcAcc('')
        setOcAccPw('')
        setOcAddOpen(false) // 表单收起来，直接看到新卡片
        setOcAccs(r)
        // `pending` 是 host 的真话：账号**存下了**（它把这次失败判成暂时态，凭据大概率没错），
        // 但这一轮没换到平台令牌。以前这里只看 `r.ok`（pending 时也是 true），于是 host 回的
        // 那句 error 被整条吃掉：界面上「加好了」、卡片上三个读数全是「—」，用户拿不到任何理由。
        // 现在照原话报出来——不静默（「pending 被整条吃掉」修复）。
        setOcAccMsg(r.pending === true
          ? { ok: false, text: '账号已保存，但这轮没换到平台令牌：' + (r.error || '原因未知') + '　面板每次刷新都会自动再试。' }
          : null)
        // 拿到令牌的那种成功不出提示（与清枢同款定稿）：表单收起 + 新卡片就在下面，「加好了」看得见。
        loadOcAccount(true)
        void refreshOcKeyAccount() // 池里多了一个账号 = 归属多了一种可能，当场重判
      }
      const removeOcAccount = async (identifier) => {
        // 两段式确认：误点第一次只进入待确认态，再点一次才真删（删账号连会话一起丢，不可恢复）
        if (ocConfirm !== identifier) { setOcConfirm(identifier); return }
        setOcConfirm(null)
        setOcAccBusy(true)
        const r = await jsonPost(API + '/opencsg/account/remove', { identifier })
        setOcAccBusy(false)
        setOcAccMsg(r && r.ok
          ? { ok: true, text: '已删除：' + identifier }
          : { ok: false, text: (r && r.error) || '删除失败' })
        if (r && r.ok) setOcAccs(r)
        if (r && r.ok) void refreshOcKeyAccount() // 池里少了一个账号，同上重判
        // 账号没了就别留着它的明文——卡片卸载了，state 还攥着一份密码没意义
        setOcPwShown(null)
        setOcPwVal('')
      }
      // 卡片上的密码：默认打码（host 列表只回掩码），点眼睛才按需单取明文。
      // 同一时刻只展开一个：密码明文多开一份就多一分被瞟到/被截屏拍走的风险。
      const revealOcPw = async (identifier) => {
        if (ocPwShown === identifier) { setOcPwShown(null); setOcPwVal(''); return }
        const r = await jsonGet(API + '/opencsg/account/password?identifier=' + encodeURIComponent(identifier))
        // 取不到就保持打码，并把原因丢进既有消息通道（不再为一个错误单开一套 UI）
        if (!(r && r.ok)) { setOcAccMsg({ ok: false, text: (r && r.error) || '读取密码失败' }); return }
        setOcAccMsg(null)
        setOcPwShown(identifier)
        setOcPwVal(typeof r.password === 'string' ? r.password : '')
      }
      // 「显示」= 让侧栏胶囊 / 账户页显示这个账号的数据。纯显示偏好：
      // 各账号会话分槽并存，不切换登录身份、不清缓存、不触发重登（与 useTfAccount 同款）。
      const useOcAccount = async (identifier) => {
        setOcAccBusy(true)
        setOcAccMsg(null)
        const r = await jsonPost(API + '/opencsg/account/use', { identifier })
        setOcAccBusy(false)
        setOcAccMsg(r && r.switched
          ? { ok: true, text: '胶囊已显示：' + identifier }
          : { ok: false, text: (r && r.error) || '设置失败' })
        if (r && r.switched) {
          setOcAccs((cur) => ({ ...(cur || {}), activeAccount: r.account }))
          // 非 force：host 侧 5 分钟缓存里多半已有该账号的数据 → 秒出、零网络
          loadOcAccount()
        }
      }
      // 清枢智汇账号管理：添加=先真登一次再入库；切换显示/两段式删除/密码单取。
      const addTfAccount = async () => {
        setTfAccBusy(true)
        setTfAccMsg(null)
        const r = await jsonPost(API + '/tierflow/account/add', { identifier: tfAcc.trim(), password: tfAccPw })
        setTfAccBusy(false)
        if (!r || !r.ok) { setTfAccMsg({ ok: false, text: (r && r.error) || '操作失败' }); return }
        setTfAcc('')
        setTfAccPw('')
        setTfAddOpen(false) // 表单收起来，直接看到新卡片
        // 成功就不出提示（用户定稿「已添加并登录：XXXX 这个文案删除」）：表单已经收起、新卡片
        // 就在下面，「加好了」这件事本身看得见，再写一行只是把卡面上的名字重复一遍还白占一行。
        // 该说的话照说——待补登录（凭据没错，只是平台暂时问不到）与失败两条分支都在下面。
        // （阶跃与基元那两张卡上的同名提示按用户选择不动，只有清枢这里不写。）
        setTfAccMsg(r.pending
          ? { ok: true, text: '已保存：' + r.activeAccount + '（登录通道暂时不可用，解除后自动补登录）' }
          : null)
        setTfAccs(r)
        loadTfUser(true)
        loadTfSub(true)
      }
      const removeTfAccount = async (identifier) => {
        // 两段式确认：误点第一次只进入待确认态，再点一次才真删（删账号连会话一起丢，不可恢复）
        if (tfConfirm !== identifier) { setTfConfirm(identifier); return }
        setTfConfirm(null)
        setTfAccBusy(true)
        const r = await jsonPost(API + '/tierflow/account/remove', { identifier })
        setTfAccBusy(false)
        setTfAccMsg(r && r.ok
          ? { ok: true, text: '已删除：' + identifier }
          : { ok: false, text: (r && r.error) || '删除失败' })
        if (r && r.ok) {
          setTfAccs(r)
          loadTfUser()
          loadTfSub()
        }
        // 账号没了就别留着它的明文——卡片卸载了，state 还攥着一份密码没意义
        setTfPwShown(null)
        setTfPwVal('')
      }
      // 卡片上的密码：默认打码（host 列表只回掩码），点眼睛才按需单取明文。
      // 同一时刻只展开一个：密码明文多开一份就多一分被瞟到/被截屏拍走的风险。
      const revealTfPw = async (identifier) => {
        if (tfPwShown === identifier) { setTfPwShown(null); setTfPwVal(''); return }
        const r = await jsonGet(API + '/tierflow/account/password?identifier=' + encodeURIComponent(identifier))
        // 取不到就保持打码，并把原因丢进既有消息通道（不再为一个错误单开一套 UI）
        if (!(r && r.ok)) { setTfAccMsg({ ok: false, text: (r && r.error) || '读取密码失败' }); return }
        setTfAccMsg(null)
        setTfPwShown(identifier)
        setTfPwVal(typeof r.password === 'string' ? r.password : '')
      }
      // 「显示」= 让侧栏胶囊 / 主卡显示这个账号的数据。纯显示偏好：
      // 各账号会话分槽并存，不切换登录身份、不清缓存、不触发重登。
      const useTfAccount = async (identifier) => {
        setTfAccBusy(true)
        setTfAccMsg(null)
        const r = await jsonPost(API + '/tierflow/account/use', { identifier })
        setTfAccBusy(false)
        setTfAccMsg(r && r.switched
          ? { ok: true, text: '胶囊已显示：' + identifier }
          : { ok: false, text: (r && r.error) || '设置失败' })
        if (r && r.switched) {
          setTfAccs((cur) => ({ ...(cur || {}), activeAccount: r.account }))
          // 非 force：host 侧 5 分钟缓存里多半已有该账号的数据 → 秒出、零网络
          loadTfUser()
          loadTfSub()
        }
      }
      // 「购买订阅」（**每张账号卡那条图例行的右端**那枚）：点开就为**那张卡的账号**取一份套餐目录——非
      // force，host 侧 5 分钟缓存里多半已有（秒开、零网络）；真调了价也不怕，host 下单前会拿
      // 现读的目录再核一次。上一次的目录与待确认记录一并清掉：重新进来就是干净的选档视图。
      const openTfBuy = (identifier) => {
        setTfBuy(null)
        setTfBuyPlans(null)
        setTfBuyFor(identifier)
        loadTfBuyPlans(false, identifier)
      }
      // 关购买弹窗：三层 state 一起收（目录留着没意义——下次进来是别的账号，或同一账号的新价）。
      const closeTfBuy = () => {
        setTfBuyFor(null)
        setTfBuy(null)
        setTfBuyPlans(null)
      }
      // 记一次待确认的余额购买。价格与余额都取「点下去那一刻」面板上看到的数，提交时原样带回
      // host 比对——平台在这中间调了价就不扣款，让用户对着新价重按一次（与升级同一套自保）。
      // 付款账号也一起记下：中途在别处换了「当前显示」，这一单仍然扣原来那个账号的余额。
      const askTfBuy = (plan, bal, qpu, identifier) => {
        if (plan === null || typeof plan.priceAmount !== 'number' || !Number.isFinite(plan.priceAmount)) return
        setTfBuy({
          identifier,
          planSlug: plan.slug,
          title: plan.title === '' ? plan.slug : plan.title,
          price: plan.priceAmount,
          durationLabel: typeof plan.durationLabel === 'string' ? plan.durationLabel : '',
          balance: bal === undefined ? null : bal,
          quotaPerUnit: qpu,
          step: 'confirm',
          busy: false,
          msg: null,
          subNo: null,
        })
      }
      const submitTfBuy = () => {
        if (tfBuy === null || tfBuy.busy === true) return
        const identifier = tfBuy.identifier
        const planSlug = tfBuy.planSlug
        const price = tfBuy.price
        setTfBuy((cur) => (cur === null ? cur : { ...cur, busy: true, msg: null }))
        jsonPost(API + '/tierflow/purchase', { identifier, planSlug, expectedPrice: price }).then((r) => {
          if (r && r.ok) {
            setTfBuy((cur) => (cur === null ? cur : { ...cur, busy: false, step: 'done', msg: null, subNo: r.subNo || null }))
            // 购买动了余额与订阅。① 先让**这张卡**当场显示购买后的数——host 侧那份账号缓存已被
            // 清掉，只 loadTfAccs() 会把卡片读成空快照。② 再把购买弹窗自己那份目录重取一遍
            // （它就是从这个账号取的）。③ 页面上「当前显示」那份（用户 / 订阅 / 套餐目录）只在
            // **买的就是当前显示这个账号**时才重取——给别的账号买不动这个账号的数，重取纯属白问上游。
            const shown = tfAccs && typeof tfAccs.activeAccount === 'string' ? tfAccs.activeAccount : ''
            const sameAcc = shown === '' || shown.toLowerCase() === String(identifier).toLowerCase()
            refreshTfAccount(identifier)
            loadTfBuyPlans(true, identifier)
            if (sameAcc) {
              loadTfPlans(true)
              loadTfSub(true)
              loadTfUser(true)
            }
            return
          }
          const p = r && r.plan ? r.plan : null
          setTfBuy((cur) => (cur === null ? cur : {
            ...cur,
            busy: false,
            step: 'confirm', // 价格变了也留在确认框里，只把新价填上、把原因写在下面
            price: p !== null && typeof p.priceAmount === 'number' ? p.priceAmount : cur.price,
            msg: (r && r.error) || '购买失败',
          }))
        })
      }

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
        // 池里多一个账号 = 当前这把 key 的归属多一种可能（原先是 NO_MATCH 的，加对账号就该
        // 亮起来）→ 头部角标当场 force 重判，不等那 5 分钟轮询（与 OC 加账号同一条）。
        void refreshStepKeyPlan()
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
        // 池里少一个账号 = 归属少一种可能（正显示着的那个套餐可能正属于被删的账号）→
        // 头部角标当场 force 重判，该灰就灰（与 OC 删账号同一条）。
        void refreshStepKeyPlan()
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
          // 删的正是 DSH 在用的那把 → 角标该当场改口（归属没了）。与 OC 删除密钥同一条：
          // 显式动作，force 穿透指纹缓存重判一次。
          void refreshStepKeyPlan()
        } else {
          setStepKeyMsg({ ok: false, text: (r && r.error) || '删除失败' })
        }
      }
      // 切换 DSH 实际使用的阶跃 key：两段式确认（点了先变「确认切换」，再点才动手）。
      // host 端把完整值写进 ~/.dsh/.credentials.yaml 的 STEP_API_KEY 行——宿主凭据分层
      // 是文件 > env 且热重载，**无需重启**，下一句对话就走新 key。成功后立刻 force
      // 重取 key-plan：头部角标当场跟着新 key 走，不等那 5 分钟轮询。
      const useStepKey = async (k) => {
        if (stepKeyUseConfirm !== k.keyId) { setStepKeyUseConfirm(k.keyId); return }
        setStepKeyUseConfirm(null)
        setStepKeyBusy(true)
        const r = await jsonPost(API + '/stepfun/key-use', { keyId: k.keyId, username: (stepKeys && stepKeys.account) || '' })
        setStepKeyBusy(false)
        if (r && r.ok) {
          setStepKeyMsg({ ok: true, text: '已切换为「' + (k.name || '未命名') + '」——DSH 之后的阶跃调用立即走这把 key（凭据热重载，无需重启）' })
          loadStepKeys()
          // 换 key = 角标描述的对象换了：当场 force 反查一次（与 OC 那枚同一条，v0.7.3 收进
          // refreshStepKeyPlan——它带「阶跃没启用就跳过」与「网络失败留旧值」两道门）。
          void refreshStepKeyPlan()
        } else {
          setStepKeyMsg({ ok: false, text: (r && (r.error || r.code)) || '切换失败' })
        }
      }

      // 首开：加载面板几何 + manifest。
      useEffect(() => {
        let alive = true
        jsonGet(API + '/prefs').then((r) => {
          if (!alive || !r || !r.ok || !r.prefs) return
          if (r.prefs.panel) setPosSafe(sanitizePos(r.prefs.panel))
          // 启用的系统：host 已规范化（缺 systems 的老存档按 prefs.zcode 推导）；
          // 客户端再规范化一次，任何形态进来都得到完整三键 + 至少留一个。
          setStore({ systems: normalizeSystems(r.prefs.systems, r.prefs.zcode) })
          // 「设置 → 系统管理」里拖出来的顺序：老存档没有这个字段，normalizeSysOrder 会补成
          // 默认序（与加这个功能之前一致）。这里只播种、不回写。
          setStore({ sysOrder: normalizeSysOrder(r.prefs.sysOrder) })
          // 清枢胶囊口径：首包就播种（别等那轮 5 分钟轮询，否则刷新后头几分钟胶囊口径是默认的
          // total）。这里只同步、不回写；认不出的值由 normalizeTfEntryMode 回落 total。
          if (r.prefs.entryTfMode !== undefined) applyTfEntryMode(r.prefs.entryTfMode, false)
          // OpenCSG 胶囊口径：同样首包就播种（理由同上）。认不出的值由 normalizeOcEntryMode
          // 回落 balance。
          if (r.prefs.entryOcMode !== undefined) applyOcEntryMode(r.prefs.entryOcMode, false)
        })
        jsonGet(API + '/manifest').then((r) => {
          if (!alive) return
          setManifest(r && r.ok ? r : { ok: false, providers: [], error: r && r.error ? r.error : '加载失败' })
          if (r && r.ok && Array.isArray(r.providers) && r.providers.length > 0) {
            setProviderId((cur) => (cur !== '' && r.providers.some((p) => p.id === cur) ? cur : r.providers[0].id))
          }
          if (r && r.ok && r.step) {
            if (r.step.prefs) stepPrefsRef.current = r.step.prefs
            // 启用的系统随 manifest 一起回来（比 /prefs 那包更早到，播种 provider 就用它）。
            // manifest 没带 systems（宿主是旧版）时**不能落默认值**：那会把 /prefs 刚播种
            // 的已存选择冲成「只有基元」，看上去就像勾选没保存住。
            const sys = r.systems && typeof r.systems === 'object' ? normalizeSystems(r.systems) : null
            if (sys !== null) setStore({ systems: sys })
            // 顺序随首包一起回（比 /prefs 那包更早到）。manifest 没带（宿主是旧版）就保持现值，
            // 与上面 systems 同一条道理：不许拿默认序把 /prefs 刚播种的顺序冲掉。
            if (Array.isArray(r.sysOrder)) setStore({ sysOrder: normalizeSysOrder(r.sysOrder) })
            if (!providerInitRef.current) { // 首包播种：上次选中的提供商（未启用/未配置一律落启用里的第一家）
              providerInitRef.current = true
              // 宿主没给 systems 就用当前 store（/prefs 播种的，或还没回来时的默认基元）
              const base = sys !== null ? sys : normalizeSystems(store.systems)
              const last = r.step.prefs && r.step.prefs.provider
              const want = last === 'step' && base.step ? 'step'
                : last === 'zcode' && base.zcode ? 'zcode'
                  : last === 'tf' && base.tf ? 'tf'
                    : last === 'oc' && base.oc ? 'oc'
                      : base.tr ? 'tr' : base.step ? 'step' : base.zcode ? 'zcode' : base.tf ? 'tf' : 'oc'
              setProvider(want)
              providerRef.current = want
              setStore({
                provider: want,
                zcEntry: want === 'zcode' ? computeZcEntry({ provider: 'zcode', quota: zcQuotaRef.current }) : null,
                tfEntry: want === 'tf' ? computeTfEntry(tfPill.user, tfPill.sub, tfPill.mode) : null,
                ocEntry: want === 'oc' ? computeOcEntry(ocPill.account, ocPill.mode) : null,
              })
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

      // Esc / 点击面板外部关闭。Esc 优先关设置弹窗；两个花钱的二次确认框各关自己那一层
      // （平台确认框没有 ✕，但 Esc 仍等于「取消」，且「进行中」时不许关）——购买的确认框与弹窗
      // 都压在升级弹窗上面，所以先关它们；兑换流程里确认框开着时只关确认框，再关兑换码弹窗，
      // 最后才关面板。
      useEffect(() => {
        if (!s.open) return
        const onKey = (e) => {
          if (e.key !== 'Escape') return
          if (store.settingsOpen) setStore({ settingsOpen: false })
          else if (tfUpgrade !== null && tfUpgrade.busy !== true) setTfUpgrade(null)
          else if (tfBuy !== null && tfBuy.busy !== true) setTfBuy(null)
          else if (tfBuyFor !== null) closeTfBuy()
          else if (tfPlansOpen) setTfPlansOpen(false)
          else if (redeemOpen && redeemArmed) { if (!redeemBusy) { setRedeemArmed(false); setRedeemMsg(null) } }
          else if (redeemOpen) setRedeemOpen(false)
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
      }, [s.open, redeemOpen, redeemArmed, redeemBusy, tfPlansOpen, tfUpgrade, tfBuyFor, tfBuy])

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

      // 兑换码（体验卡）：打开时清掉上一次的码与结果——码是一次性的，留着没用；
      // 上次的「已到账」留着会让人误以为这一次也成功了。
      const openRedeem = () => {
        setRedeemCode('')
        setRedeemMsg(null)
        setRedeemDone(null)
        setRedeemArmed(false)
        setRedeemBusy(false)
        setRedeemOpen(true)
      }
      const closeRedeem = () => { if (!redeemBusy) setRedeemOpen(false) }
      const cancelRedeem = () => { if (!redeemBusy) { setRedeemArmed(false); setRedeemMsg(null) } }
      const submitRedeem = async () => {
        if (redeemBusy) return
        const code = redeemCode.trim()
        if (code === '') { setRedeemMsg({ text: '请输入体验卡。' }); return }
        // 第一下只弹确认框：兑换不可撤销（码一提交就失效），与平台网页「确认兑换体验卡」同义。
        if (!redeemArmed) { setRedeemArmed(true); setRedeemMsg(null); return }
        setRedeemBusy(true)
        // 确认框点「确认兑换」即收：平台网页的确认框点确认就关，进度落在表单那颗按钮上。
        setRedeemArmed(false)
        setRedeemMsg(null)
        setRedeemDone(null) // 上一张卡的结果不能留到下一条码上
        const r = await jsonPost(API + '/redeem', { code })
        setRedeemBusy(false)
        if (r && r.ok && r.data) {
          // 取值路径与平台网页一致：r.data.quota / r.data.creditExpiresAt，原值不动。
          setRedeemDone({ quota: r.data.quota, creditExpiresAt: r.data.creditExpiresAt === undefined ? null : r.data.creditExpiresAt })
          setRedeemCode('')
          // 到账后立刻拉新余额：主卡总额、限时额度、占比条、资金明细都在这一个响应里，
          // 不刷新的话用户对着旧数字会以为「码白兑了」；用量页签在切过去时自会拉新数据
          // （与平台网页一样，兑换后 usage 不再用旧值显示）。
          loadBalance()
        } else {
          setRedeemMsg({ text: (r && r.error) || '体验卡兑换失败，请稍后重试。' })
        }
      }

      const redeemExpTxt = redeemDone ? fmtIsoDay(redeemDone.creditExpiresAt) : null

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
        if (r && r.ok) setKeysData({ loading: false, list: r.keys || [], orphanIds: Array.isArray(r.orphanIds) ? r.orphanIds : [] })
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
          // savedLocal：host 已把明文落进本机 state（平台只给这一次，落不下就只能看这一次）。
          setCreatedKey({ name: r.name, key: r.key, savedLocal: r.savedLocal === true })
          setKeyMsg(null)
          setKeyName('')
          loadKeys()
          // 新建的密钥可能正是 DSH 在用的那把（用户建完贴进设置）→ 归属当场重判
          void refreshTrKeyBalance()
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
        // 换 Cookie 即切号，而角标读的正是「本机绑定账号」的账 → 旧数立即作废（连角标一起）。
        setStore({ alert: null, balanceCny: null, expiringItems: [], trKeyBalance: null }) // 旧会话的余额/预警立即失效
        // 清空会话就到此为止（host 侧同样拒答 NO_SESSION）；粘贴了新的会话则当场 force 重取。
        if (value !== '') void refreshTrKeyBalance()
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
      // 系统管理（设置 → 系统管理）：勾选/取消一个系统 → 本地立即生效 + 持久化到 host
      // prefs.systems。**至少留一个**：要关的正是最后一个开着的就拦下并给一句提示
      // （host 侧同样忽略全关请求，两道都不放行）。关掉正停着的那家时 provider 由
      // 「必须是已启用系统」那条 effect 统一回落，这里不搬视图、也不自作主张跳页签。
      // 写盘以 host 回的规范化结果为准（手改存档 / 多窗口并发都由 host 裁决）；host 没回
      // systems 说明它还跑着不认识这个字段的旧代码（插件升级后没重启 DSH）——那种情况**不
      // 能装作已保存**：勾选留在本机（本次会话照旧可用），但明说没有落盘、要重启才好使。
      const setSystem = useCallback(async (key, on) => {
        if (SYS_KEYS.indexOf(key) < 0) return
        const next = { ...normalizeSystems(store.systems), [key]: on === true }
        // 逐键判定而非写死三键：加一家系统就得跟着改，漏了的表现是「勾选被拒但看不出原因」
        if (!SYS_KEYS.some((k) => next[k])) {
          setStore({ sysMsg: '至少要留一个系统：先勾上另一个，再取消这个。' })
          return
        }
        setStore({ systems: next, sysMsg: null })
        const r = await jsonPost(API + '/prefs', { prefs: { systems: next } })
        // 期间又点过别的开关：那次的结果更晚也更权威，这次不回写（避免旧回声盖新选择）
        if (JSON.stringify(normalizeSystems(store.systems)) !== JSON.stringify(next)) return
        const saved = r && r.ok && r.prefs && r.prefs.systems ? normalizeSystems(r.prefs.systems, r.prefs.zcode) : null
        if (saved === null) {
          setStore({
            sysMsg: r && r.ok
              ? '勾选没有写进配置：宿主进程还跑着旧版插件代码，重启 DSH 后再勾选才会保存。'
              : '勾选没有写进配置：宿主没有响应，等会儿再点一次试试。',
          })
          return
        }
        setStore({ systems: saved, sysMsg: null })
      }, [])

      // 拖动排序落盘：与 setSystem 同款——等 host 回执、以它回的规范化顺序为准，host 不认识
      // sysOrder（插件升级后没重启 DSH）就**明说没写进去**，不许只在本地点亮假装已保存。
      // 拖动过程只改本地（面板当场重排），松手才发这一发——拖过 4 行不该发 4 个请求。
      const saveSysOrder = useCallback(async (order) => {
        const r = await jsonPost(API + '/prefs', { prefs: { sysOrder: order } })
        const saved = r && r.ok && r.prefs && Array.isArray(r.prefs.sysOrder) ? normalizeSysOrder(r.prefs.sysOrder) : null
        if (saved === null) {
          setStore({
            sysMsg: r && r.ok
              ? '排序没有写进配置：宿主进程还跑着旧版插件代码，重启 DSH 后再拖动才会保存。'
              : '排序没有写进配置：宿主没有响应，等会儿再拖一次试试。',
          })
          return
        }
        setStore({ sysOrder: saved, sysMsg: null })
      }, [])

      // 整行都能拖（按用户要求从「只抓行首把手」放开到整行）：按下只是**候选**，指针竖向
      // 走够 4px 才真的算拖——没走够就松手，浏览器照常发 click，那一行还是勾选/取消。
      // 于是同一行既是开关又是手柄，两件事靠「有没有走够」分开，谁也不用让着谁。
      // 拖动中只挪本地数组（面板当场重排），松手才落一次盘；目标行由每行中线判定，
      // 移动后 from 立刻跟到新位次，所以指针停在同一行里不会来回抖。
      // 触屏仍建议抓行首那枚「⠿」（只有它带 touch-action:none）：整行都设 none 会把面板的
      // 竖向滚动一起吞掉，为拖五行不值当。
      const onSysRowDown = (e, id) => {
        if (e.button !== 0 || !e.currentTarget) return
        const card = e.currentTarget.closest ? e.currentTarget.closest('.dsh-mb-set-card') : null
        if (!card || !card.querySelectorAll) return
        let order = normalizeSysOrder(store.sysOrder)
        let from = order.indexOf(id)
        if (from < 0) return
        const startY = e.clientY
        let active = false
        let dirty = false
        sysDragMoved = false
        const rowsOf = () => Array.prototype.slice.call(card.querySelectorAll('.dsh-mb-sys-row'))
        const move = (ev) => {
          if (!active) {
            if (Math.abs(ev.clientY - startY) < 4) return
            active = true
            sysDragMoved = true
            if (ev.preventDefault) ev.preventDefault()
            setStore({ sysDrag: id })
          }
          const slot = dropSlot(rowsOf().map((n) => n.getBoundingClientRect()), ev.clientY)
          if (slot < 0) return
          // 槽位 → 最终下标：源行在槽位上方时，抽出它会让目标往前挪一格
          const to = slot > from ? slot - 1 : slot
          if (to === from) return
          order = moveItem(order, from, to)
          from = to
          dirty = true
          setStore({ sysOrder: order })
        }
        // pointercancel 也算松手：触屏上手指被系统手势抢走时不会有 pointerup，
        // 少了这条那两个监听器就要挂到下一个人点鼠标才被清掉。
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', up)
          if (!active) return // 没走够 4px：这就是一次点击，交给 click 去勾选，不必收尾
          setStore({ sysDrag: null })
          if (dirty) void saveSysOrder(order)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', up)
      }

      // 点击模型卡片 → 复制模型 id（配置 agent 时直接粘贴）。
      const copyId = useCallback((id) => {
        void copyText(id)
        setCopiedId(id)
        setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), COPY_FLASH_MS)
      }, [])

      // 账号管理：添加 / 删除 / 一键登录。列表只见掩码（host 只回 pwMask），明文按需单取。
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
          setStore({ alert: null, balanceCny: null, expiringItems: [], trKeyBalance: null })
          loadBalance()
          // 刚登录的账号很可能就是本机绑定账号 → 角标读的那个账换人了，当场重取（force）
          void refreshTrKeyBalance()
        } else {
          setAccMsg({ ok: true, text: '账号已保存，但登录失败：' + (r.error || '未知原因') })
        }
        loadAccounts()
      }
      const removeAccount = async (account) => {
        await jsonPost(API + '/accounts/remove', { account })
        // 账号没了就别留着它的明文——行没了，state 还攥着一份密码没意义
        if (showAccPw === account) { setShowAccPw(null); setAccPwVal('') }
        loadAccounts()
        // 池里少了一个账号：本机绑定与活会话都可能被它连带清掉 → 角标当场重判
        void refreshTrKeyBalance()
      }
      // 账号行上的密码：默认掩码（host 清单只回 pwMask），点眼睛才按需单取明文。
      // 同一时刻只展开一个：明文在界面上多开一份，就多一分被瞟到/被截屏拍走的风险（与阶跃同口径）。
      const revealAccPw = async (account) => {
        if (showAccPw === account) { setShowAccPw(null); setAccPwVal(''); return }
        const r = await jsonGet(API + '/account/password?account=' + encodeURIComponent(account))
        // 取不到就保持打码，并把原因丢进既有消息通道（不为一个错误单开一套 UI）
        if (!(r && r.ok)) { setAccMsg({ ok: false, text: (r && r.error) || '读取密码失败' }); return }
        setAccMsg(null)
        setAccPwVal(typeof r.password === 'string' ? r.password : '')
        setShowAccPw(account)
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
          setStore({ alert: null, balanceCny: null, expiringItems: [], trKeyBalance: null })
          loadBalance()
          // 切号换的就是账本身（基元只有一个活会话）：角标读的账号变了 → 当场重取（force）
          void refreshTrKeyBalance()
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
      // 启用的系统（设置 → 系统管理）：没勾的那家在这里就出不来——切换器、页签、正文
      // 全按它算，provider 由回落 effect 保证总是启用里的一个。
      const sys = normalizeSystems(s.systems)
      const effProv = provider === 'step' && sys.step ? 'step'
        : provider === 'zcode' && sys.zcode ? 'zcode'
          : provider === 'tf' && sys.tf ? 'tf'
            : provider === 'oc' && sys.oc ? 'oc' : 'tr'
      // 清枢智汇当前显示的账号（页签行末尾那枚注脚用它；没配账号就是空串）
      const tfWho = tfAccs && typeof tfAccs.activeAccount === 'string' ? tfAccs.activeAccount : ''
      return React.createElement('div', {
        className: 'dsh-mb-panel' + (s.settingsOpen ? ' settings-open' : ''),
        ref: panelRef,
        style: { left: pos.x, top: pos.y, width: pos.w, height: pos.h || undefined },
        role: 'dialog',
      },
        // 头部：原标题（任何模式保留）+ 提供商切换器（只列已启用的系统）
        // + 右上角动作区（设置齿轮 / 关闭）。
        React.createElement('div', { className: 'dsh-mb-head', onPointerDown: onHeaderDown },
          React.createElement('div', { className: 'dsh-mb-head-left' },
            React.createElement('span', { className: 'dsh-mb-head-title' },
              effProv === 'step' ? STEP_ENTRY_LABEL : effProv === 'zcode' ? ZC_ENTRY_LABEL : effProv === 'tf' ? TF_ENTRY_LABEL : effProv === 'oc' ? OC_ENTRY_LABEL : ENTRY_LABEL),
            // 标题位提供商切换器：只列**设置里启用**的系统（默认只有基元 → 整体不渲染）。
            // 阶跃不再要求「已配好账号」：勾上就出现，未配置时那一页就是登录/添加账号表单，
            // 否则用户没有入口把账号加进来。
            (function () {
              const segs = []
              if (sys.tr) segs.push(['tr', '基元', '基元律动面板'])
              if (sys.step) segs.push(['step', '阶跃', '阶跃 Step Plan 面板'])
              if (sys.zcode) segs.push(['zcode', 'ZCode', 'ZCode 套餐用量'])
              if (sys.tf) segs.push(['tf', '清枢', '清枢智汇面板（账户 / 套餐用量）'])
              if (sys.oc) segs.push(['oc', 'OpenCSG', 'OpenCSG 面板（账户 / 用量）'])
              if (segs.length < 2) return null
              // 分段顺序跟「设置 → 系统管理」里拖出来的顺序走。上面五条 if/push 保持原样不动
              // （那串是「谁有段」的判据），只在最后重排一次，指针怎么拖这里就怎么排。
              const ranked = orderBySys(segs, normalizeSysOrder(s.sysOrder))
              return React.createElement('div', { className: 'dsh-mb-prov' },
                ranked.map(([id, label, tip]) => React.createElement('button', {
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
        // 页签：五家各一套（设置以弹窗打开，不占页签）。
        React.createElement('div', { className: 'dsh-mb-tabs' },
          (effProv === 'step'
            ? [
                ['step-account', '账户'],
                // 密钥页签标签带当前显示账号：多账号时切了「显示」，不用点进页签就知道
                // 这堆密钥是谁的。增删密钥不可逆，归属不该藏在二级页面里。
                ['step-keys', stepAccAccount === '' ? '密钥' : '密钥（' + stepAccAccount + '）'],
              ]
            : effProv === 'zcode'
              ? [['zc-usage', '用量']]
              : effProv === 'tf'
                // 「套餐用量」页签标签带当前显示的账号（用户定稿「照阶跃的放法」）：
                // 阶跃是在末尾那个页签上写「密钥（账号）」——多账号时不用点进去就知道
                // 面板在看谁；标签超长由 .dsh-mb-tab 的省略号兜（那两条规则本来就是为
                // 密钥页签带账号写的）。没配账号时只写页签名，不留空括号。
                ? [['tf-user', '账户'],
                  ['tf-sub', tfWho === '' ? '套餐用量' : '套餐用量（' + tfWho + '）'],
                  // 密钥页签同口径带账号（v0.7.4）：增删密钥不可逆，归属不该藏在二级页面里
                  ['tf-keys', tfWho === '' ? '密钥' : '密钥（' + tfWho + '）']]
                : effProv === 'oc'
                  // OpenCSG 三个页签：账户 / 用量 / API Key。页签名不挂账号注脚——账户页本来
                  // 就一人一张卡（谁是谁一眼看得见），而用量与密钥页的页首都写明「当前显示」，
                  // 再往页签名上挂一遍是同义反复（用户定稿：照用量页的做法）。
                  ? [['oc-user', '账户'], ['oc-usage', '用量'], ['oc-keys', 'API Key']]
                  : [['balance', '余额'], ['usage', '用量'], ['models', '模型'], ['status', '状态'], ['keys', '密钥']]).map(([id, label]) =>
            React.createElement('button', {
              key: id,
              className: 'dsh-mb-tab' + (view === id ? ' active' : ''),
              onClick: () => switchTab(id),
            }, label)),
        ),
        React.createElement('div', { className: 'dsh-mb-body' },
          view === 'models' ? renderModelsTab({ manifest, providers, models, catFilter, setCatFilter, copiedId, copyId }) : null,
          view === 'balance' ? renderBalanceTab({ manifest, balance, loadBalance, goSettings: toggleSettings, sessionAccount, sessionAccountName, onRedeem: openRedeem }) : null,
          view === 'usage' ? renderUsageTab({ usage, loadUsage, sessionAccount, calHover, setCalHover }) : null,
          // 状态页签 = 自定义检测（自己的 Key 实测；官方状态站 2026-09-14 起停更并移除）。
          view === 'status' ? renderCheckPanel({
            models, checkSel, toggleCheckSel, checkBusy, checkResults,
            checkInterval, setCheckInterval, checkNextAt, checkMsg, runCheckNow,
          }) : null,
          view === 'keys' ? renderKeysTab({
            manifest, keysData, loadKeys, keyName, setKeyName, keyCreating, createKey,
            createdKey, setCreatedKey, copiedCreated, copyCreatedKey, copiedKeyId, copyReveal,
            keyMsg, forgetTrKeyLocal, forgetTrKeyOrphans,
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
            stepKeyUseConfirm, useStepKey, stepKeyPlan: s.stepKeyPlan,
          }) : null,
          view === 'zc-usage' ? renderZcUsageTab({
            zcQuota, loadZcQuota,
          }) : null,
          // 清枢智汇「账户」= 全部账号一人一张卡（阶跃同款骨架）：余额 / 近 7 天用量 / 当前套餐 / 到期 + 增删切换。
          view === 'tf-user' ? renderTfUserTab({
            tfUser, tfAccs, loadTfAccs, loadTfAccsDetail, tfDetailBusy,
            refreshTfAccount, useTfAccount, tfAccBusy, tfAccMsg,
            tfAcc, setTfAcc, tfAccPw, setTfAccPw, showTfPw, setShowTfPw,
            addTfAccount, removeTfAccount, tfConfirm, setTfConfirm, tfAddOpen, setTfAddOpen,
            tfPwShown, tfPwVal, revealTfPw, tfOpen, setTfOpen,
            // 每张账号卡图例行右端那枚「购买订阅」的入口（定稿「只能余额买」＋「挪到账号卡上」）
            openTfBuy,
          }) : null,
          // 清枢智汇「套餐用量」= 当前套餐的两条进度（额度 + token 池）与全部订阅列表。
          view === 'tf-sub' ? renderTfSubTab({
            tfSub, tfAccs, loadTfSub, tfPlans,
            // 参数是订阅号时只升那一份。现在只有订阅卡引用它，但判字符串的写法留着：
            // 谁要是直接把它挂到 onClick 上，React 会把事件对象塞进来（→ 看全部）。
            openTfPlans: (subNo) => {
              setTfPlansScope(typeof subNo === 'string' && subNo !== '' ? subNo : null)
              setTfPlansOpen(true)
              loadTfPlans(false)
            },
          }) : null,
          // 清枢「密钥」= 按量 API Key（v0.7.4，照 OpenCSG 密钥页那套 + 清枢多出的启停）。
          view === 'tf-keys' ? renderTfKeysTab({
            tfKeys, tfAccs, loadTfKeys,
            tfKeyName, setTfKeyName, tfKeyUnlimited, setTfKeyUnlimited, tfKeyQuota, setTfKeyQuota,
            tfKeyExpire, setTfKeyExpire, tfKeyBusy, tfKeyMsg, tfKeyCreated, setTfKeyCreated,
            tfKeyCopied, copyTfCreatedKey, tfKeyConfirm,
            createTfKey, deleteTfKey, revealTfKey, forgetTfKey, forgetTfKeyOrphans, toggleTfKeyStatus,
          }) : null,
          // OpenCSG「账户」= 全部账号一人一张卡（布局照清枢：**没有 hero**），卡上是
          // 「账户余额 / API 调用量 / 待发放余额」三件事 + 增删切换。**没有购买那一套**：只读不买。
          view === 'oc-user' ? renderOcUserTab({
            ocAccs, loadOcAccs, loadOcAccsDetail, ocDetailBusy,
            refreshOcAccount, useOcAccount, ocAccBusy, ocAccMsg,
            ocAcc, setOcAcc, ocAccPw, setOcAccPw, showOcPw, setShowOcPw,
            addOcAccount, removeOcAccount, ocConfirm, setOcConfirm, ocAddOpen, setOcAddOpen,
            ocPwShown, ocPwVal, revealOcPw,
          }) : null,
          // OpenCSG「用量」= 本期账单口（scene=15）：窗口合计（token / 调用次数 / 记录条数）
          // + 按接口拆分——门户「API 调用量」页签用的同一条口，窗口 = 本月 1 号 → 今天。
          // 版式照基元用量页（汇总 hero → 按接口拆分表），花费按用户改口摆在同一页（见 renderOcUsageTab）。
          view === 'oc-usage' ? renderOcUsageTab({
            ocUsage, ocAccs, loadOcUsage,
          }) : null,
          // OpenCSG「API Key」= 门户 /settings/api-keys 同款能力：列表（服务端掩码）+ 创建
          // （名称 + 有效期三选一，完整值只展示这一次）+ 删除（仅自建，两段式确认）。
          view === 'oc-keys' ? renderOcKeysTab({
            ocKeys, ocAccs, loadOcKeys,
            ocKeyName, setOcKeyName, ocKeyExpire, setOcKeyExpire,
            ocKeyBusy, ocKeyMsg, ocKeyCreated, setOcKeyCreated,
            ocKeyCopied, copyOcCreatedKey, ocKeyConfirm, createOcKey, deleteOcKey, revealOcKey, forgetOcKey, forgetOcKeyOrphans,
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
                accBusy, accMsg, addAccount, removeAccount, loginStored, showAccPw, accPwVal, revealAccPw,
                showBackup, setShowBackup,
                updInfo, updBusy, loadUpdate, copyUpdateCmd, updCopied, ignoreUpdate,
                entryMode: s.entryBalMode === 'expiring' ? 'expiring' : 'total', setEntryBalance,
                // 清枢那一组的口径（设置 → 清枢 → 胶囊接管（清枢智汇））：四个 chip 里选一个
                tfEntryMode: normalizeTfEntryMode(s.entryTfMode), setTfEntryMode,
                // OpenCSG 那一组的口径（设置 → OpenCSG → 胶囊接管（OpenCSG））：三个 chip 里选一个
                ocEntryMode: normalizeOcEntryMode(s.entryOcMode), setOcEntryMode,
                systems: sys, setSystem, sysMsg: s.sysMsg,
                // 拖动排序：顺序与「正在拖哪一行」都从 store 取（面板重排要它），整行按下走 onSysRowDown
                sysOrder: s.sysOrder, sysDrag: s.sysDrag, onSysRowDown,
                settingsTab, setSettingsTab,
                stepCfg,
                setStepEntryPref,
              })),
          ),
        ) : null,
        // 兑换码弹窗：比设置弹窗小、高度按内容自适应——一次只干一件事，把码交给平台。
        // 「已到账」用平台返回的 quota 原值渲染（¥ 口径见 host 侧注释），解析不出到期
        // 日就只显示金额，绝不补一句猜的日期。
        redeemOpen ? React.createElement('div', {
          className: 'dsh-mb-modal',
          onClick: (e) => { if (e.target === e.currentTarget) closeRedeem() },
        },
          React.createElement('div', { className: 'dsh-mb-modal-card tight', role: 'dialog', 'aria-label': '兑换码' },
            React.createElement('div', { className: 'dsh-mb-modal-head' },
              React.createElement('span', { className: 'dsh-mb-modal-title' }, '兑换码'),
              React.createElement('button', { className: 'dsh-mb-iconbtn', title: '关闭 (Esc)', onClick: closeRedeem }, '✕'),
            ),
            React.createElement('div', { className: 'dsh-mb-modal-body' },
              React.createElement('div', { className: 'dsh-mb-redeem-form' },
                // 平台原文（一字不改）：兑换成功后，额度将到账当前账户，可用于模型调用。
                React.createElement('p', { className: 'dsh-mb-redeem-hint' }, '兑换成功后，额度将到账当前账户，可用于模型调用。'),
                React.createElement('div', null,
                  React.createElement('label', { className: 'dsh-mb-redeem-label', htmlFor: 'dsh-mb-redeem-code' }, '兑换码'),
                  React.createElement('input', {
                    id: 'dsh-mb-redeem-code',
                    className: 'dsh-mb-input',
                    style: { minHeight: 0, padding: '6px 10px' },
                    value: redeemCode,
                    placeholder: '请输入体验卡兑换码',
                    autoFocus: true,
                    disabled: redeemBusy,
                    onChange: (e) => { setRedeemCode(e.target.value); setRedeemArmed(false); setRedeemMsg(null) },
                    onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitRedeem() } },
                  }),
                ),
                redeemDone ? React.createElement('div', { className: 'dsh-mb-redeem-ok', role: 'status' },
                  React.createElement('span', null, '已到账 ',
                    React.createElement('strong', null, fmtQuota(redeemDone.quota))),
                  redeemExpTxt !== null ? React.createElement('span', { className: 'dsh-mb-redeem-exp' }, '额度有效期至 ' + redeemExpTxt) : null,
                ) : null,
                redeemMsg ? React.createElement('div', { className: 'dsh-mb-redeem-err', role: 'alert' }, redeemMsg.text) : null,
                React.createElement('div', { className: 'dsh-mb-redeem-actions' },
                  redeemDone
                    ? React.createElement('button', { className: 'dsh-mb-btn', onClick: closeRedeem }, '完成')
                    : React.createElement('button', {
                      className: 'dsh-mb-btn',
                      disabled: redeemBusy || redeemCode.trim() === '',
                      onClick: submitRedeem,
                    }, redeemBusy ? '兑换中…' : '兑换')),
              ),
            ),
          ),
        ) : null,
        // 二次确认框：平台网页这里是一层**独立确认弹窗**（Modal.confirm：标题「确认兑换体验卡」
        // + 正文 + 取消 / 确认兑换），不是主弹窗里的一段内联文字——所以另起一层遮罩，
        // z-index 压过兑换码弹窗（30 → 40）。平台确认框没有 ✕、点遮罩也不关（maskClosable 默认关），
        // 照做：遮罩不接点击事件，只有两个按钮和 Esc 能出去。
        redeemOpen && redeemArmed && !redeemDone ? React.createElement('div', { className: 'dsh-mb-modal confirm' },
          React.createElement('div', { className: 'dsh-mb-modal-card confirm', role: 'dialog', 'aria-label': '确认兑换体验卡' },
            React.createElement('div', { className: 'dsh-mb-confirm-title' }, '确认兑换体验卡'),
            React.createElement('div', { className: 'dsh-mb-confirm-text' },
              '兑换成功后额度会进入当前账号钱包，同一账号下的 API Key 共享该额度。'),
            React.createElement('div', { className: 'dsh-mb-confirm-actions' },
              React.createElement('button', {
                className: 'dsh-mb-btn ghost',
                disabled: redeemBusy,
                onClick: cancelRedeem,
              }, '取消'),
              React.createElement('button', {
                className: 'dsh-mb-btn',
                disabled: redeemBusy,
                autoFocus: true, // 平台 Modal.confirm 默认把焦点放在确认键上（autoFocusButton='ok'）
                onClick: submitRedeem,
              }, '确认兑换'),
            ),
          ),
        ) : null,
        // 升级订阅弹窗：与设置弹窗同款模态层（点遮罩 / ✕ / Esc 关闭）。高度按内容走
        // （tight），套餐三档刚好一屏；列表再长就由 .dsh-mb-modal-body 自己滚。
        tfPlansOpen ? React.createElement('div', {
          className: 'dsh-mb-modal',
          onClick: (e) => { if (e.target === e.currentTarget) setTfPlansOpen(false) },
        },
          React.createElement('div', { className: 'dsh-mb-modal-card tight', role: 'dialog', 'aria-label': '升级订阅' },
            React.createElement('div', { className: 'dsh-mb-modal-head' },
              React.createElement('span', { className: 'dsh-mb-modal-title' }, '升级订阅'),
              React.createElement('button', {
                className: 'dsh-mb-iconbtn', title: '关闭 (Esc)',
                onClick: () => setTfPlansOpen(false),
              }, '✕'),
            ),
            React.createElement('div', { className: 'dsh-mb-modal-body' },
              renderTfUpgrade({ tfPlans, loadTfPlans, askTfUpgrade, scope: tfPlansScope }))),
        ) : null,
        // 购买订阅弹窗（**账号卡图例行右端**那枚「购买订阅」进来）：与升级弹窗同款模态层，内容换成
        // 「这个账号能买的档」。钱只从**这张卡的账号**余额扣，所以弹窗里不再有账号切换——
        // 点哪张卡就是买哪个账号，付款账号在点「余额购买」那一刻随之锁定。
        tfBuyFor !== null ? React.createElement('div', {
          className: 'dsh-mb-modal',
          onClick: (e) => { if (e.target === e.currentTarget) closeTfBuy() },
        },
          React.createElement('div', { className: 'dsh-mb-modal-card tight', role: 'dialog', 'aria-label': '购买订阅' },
            React.createElement('div', { className: 'dsh-mb-modal-head' },
              React.createElement('span', { className: 'dsh-mb-modal-title' }, '购买订阅'),
              React.createElement('button', {
                className: 'dsh-mb-iconbtn', title: '关闭 (Esc)',
                onClick: closeTfBuy,
              }, '✕'),
            ),
            React.createElement('div', { className: 'dsh-mb-modal-body' },
              renderTfBuy({ tfBuyPlans, loadTfBuyPlans, askTfBuy, forId: tfBuyFor }))),
        ) : null,
        // 余额升级的二次确认框（真花钱，必须两步）。挂在面板根、`.confirm` 那层 z-index 40，
        // 盖在升级弹窗上面；点遮罩 / ✕ / Esc 取消，但「升级中」时不许关（请求已经发出去了）。
        // 外层包一个立即执行的函数，只为把余额那行先算好——不然三元 + 五层 createElement
        // 挤在一行，数括号比读逻辑还费劲。
        tfUpgrade !== null ? (function () {
          const u = tfUpgrade
          const qpu = Number(u.quotaPerUnit) > 0 ? Number(u.quotaPerUnit) : TF_QPU_FALLBACK
          const b = u.balance
          const balLine = (b === null || b === undefined || !Number.isFinite(b.quota))
            ? '差价从账户余额扣（余额以平台为准）'
            : '差价从账户余额扣（当前余额 ' + tfMoney(b.quota, qpu)
              + ' → 升级后约 ' + tfMoney(b.quota - u.due * qpu, qpu) + '）'
          return React.createElement('div', {
            className: 'dsh-mb-modal confirm',
            onClick: (e) => { if (e.target === e.currentTarget && u.busy !== true) setTfUpgrade(null) },
          },
          React.createElement('div', { className: 'dsh-mb-modal-card confirm', role: 'dialog', 'aria-label': '确认余额升级' },
            React.createElement('div', { className: 'dsh-mb-confirm-title' },
              u.step === 'done' ? '升级成功' : '确认余额升级'),
            React.createElement('div', { className: 'dsh-mb-confirm-text' },
              React.createElement('div', null, u.fromTitle + ' → ' + u.toTitle),
              React.createElement('div', { className: 'dsh-mb-redeem-ok' },
                React.createElement('strong', null, '¥' + fmtCny(u.due)),
                React.createElement('span', null, balLine)),
              React.createElement('div', null, u.step === 'done'
                ? '平台的余额支付已完成，余额与订阅正在刷新。'
                : '确认后立即从账户余额扣款，不走微信 / 支付宝。')),
            u.msg === null ? null : React.createElement('div', { className: 'dsh-mb-redeem-err' }, u.msg),
            React.createElement('div', { className: 'dsh-mb-confirm-actions' },
              React.createElement('button', {
                className: 'dsh-mb-btn small ghost',
                disabled: u.busy === true,
                onClick: () => setTfUpgrade(null),
              }, u.step === 'done' ? '关闭' : '取消'),
              u.step === 'done' ? null : React.createElement('button', {
                className: 'dsh-mb-btn small',
                disabled: u.busy === true,
                onClick: submitTfUpgrade,
              }, u.busy === true ? '升级中…' : '确认升级 ¥' + fmtCny(u.due)))))
        })() : null,
        // 余额购买的二次确认框（真花钱，必须两步）。与升级那个同款：`.confirm` 那层 z-index 40，
        // 盖在购买弹窗上面；点遮罩 / ✕ / Esc 取消，但「购买中」时不许关（请求已经发出去了）。
        // 外层包一个立即执行的函数，只为把余额那行先算好。
        tfBuy !== null ? (function () {
          const u = tfBuy
          const qpu = Number(u.quotaPerUnit) > 0 ? Number(u.quotaPerUnit) : TF_QPU_FALLBACK
          const b = u.balance
          const balLine = (b === null || b === undefined || !Number.isFinite(b.quota))
            ? '从账户余额扣（余额以平台为准）'
            : '从账户余额扣（当前余额 ' + tfMoney(b.quota, qpu)
              + ' → 买后约 ' + tfMoney(b.quota - u.price * qpu, qpu) + '）'
          return React.createElement('div', {
            className: 'dsh-mb-modal confirm',
            onClick: (e) => { if (e.target === e.currentTarget && u.busy !== true) setTfBuy(null) },
          },
          React.createElement('div', { className: 'dsh-mb-modal-card confirm', role: 'dialog', 'aria-label': '确认余额购买' },
            React.createElement('div', { className: 'dsh-mb-confirm-title' },
              u.step === 'done' ? '购买成功' : '确认余额购买'),
            React.createElement('div', { className: 'dsh-mb-confirm-text' },
              React.createElement('div', null, '新开一份「' + u.title + '」'
                + (u.durationLabel === '' ? '' : '（' + u.durationLabel + '）')),
              React.createElement('div', { className: 'dsh-mb-redeem-ok' },
                React.createElement('strong', null, '¥' + fmtCny(u.price)),
                React.createElement('span', null, balLine)),
              React.createElement('div', null, u.step === 'done'
                // 平台的余额支付只回订阅号；密钥要去平台「密钥」页取（它会为这份订阅签发专用密钥）
                ? '平台的余额支付已完成（订阅号 ' + (u.subNo === null ? '见平台「订阅」页' : u.subNo)
                  + '）：平台会为这份订阅签发专用密钥，去平台「密钥」页取；余额与订阅正在刷新。'
                : '确认后立即从账户余额扣款，不走微信 / 支付宝。')),
            u.msg === null ? null : React.createElement('div', { className: 'dsh-mb-redeem-err' }, u.msg),
            React.createElement('div', { className: 'dsh-mb-confirm-actions' },
              React.createElement('button', {
                className: 'dsh-mb-btn small ghost',
                disabled: u.busy === true,
                onClick: () => setTfBuy(null),
              }, u.step === 'done' ? '关闭' : '取消'),
              u.step === 'done' ? null : React.createElement('button', {
                className: 'dsh-mb-btn small',
                disabled: u.busy === true,
                onClick: submitTfBuy,
              }, u.busy === true ? '购买中…' : '确认购买 ¥' + fmtCny(u.price)))))
        })() : null,
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
    // 完整日期（YYYY-MM-DD，24h 习惯）：兑换码到账额度的到期日要能区分年份，
    // fmtDay 的 M-D 在这里不够用；解析不出来返回 null（宁缺不编）。
    // 平台这个字段理论上给 ISO 串，但同样是数字时间戳时也认：< 1e11 视为「秒」，
    // 否则视为毫秒——两种量级差 1000 倍，现实中不会歧义。
    function fmtIsoDay(iso) {
      let v = iso
      if (typeof v === 'number' && Number.isFinite(v)) v = v < 1e11 ? v * 1000 : v
      const t = v ? new Date(v) : null
      if (!t || Number.isNaN(t.getTime())) return null
      return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')
    }
    function renderKeysTab({ manifest, keysData, loadKeys, keyName, setKeyName, keyCreating, createKey, createdKey, setCreatedKey, copiedCreated, copyCreatedKey, copiedKeyId, copyReveal, keyMsg, forgetTrKeyLocal, forgetTrKeyOrphans }) {
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
      // 创建成功：完整密钥在这里明文显示一次。之后还能不能再复制，取决于 host 那次落盘成没成
      // （savedLocal）——平台本身只给这一次，落不下就真的没了，文案必须如实说。
      if (createdKey) {
        rows.push(React.createElement('div', { className: 'dsh-mb-created', key: 'created' },
          React.createElement('div', { className: 'dsh-mb-created-title' },
            '「' + createdKey.name + '」已创建',
            createdKey.savedLocal
              ? '——本机已留存一份，之后在列表里也能「复制完整值」'
              : '，完整密钥只显示这一次（没能落本机）'),
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
        // 「可复制」有两种来路，按行去重（一行可能同时满足两条）：
        //   · hasLocal：创建时落过本机副本 → 历史行也能复制；
        //   · copyable：DSH 正在用的那把，靠头尾指纹对上。
        const copyableCount = list.filter((k) => k.copyable === true || k.hasLocal === true).length
        rows.push(React.createElement('div', { className: 'dsh-mb-keys-head', key: 'hd' },
          React.createElement('span', { className: 'dsh-mb-day-title', style: { marginTop: 0 } }, '我的密钥（' + list.length + '）'),
          React.createElement('span', { className: 'dsh-mb-hint', style: { opacity: 1 } },
            copyableCount > 0 ? copyableCount + ' 把可复制完整值' : ''),
        ))
        if (list.length === 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'empty' }, '还没有密钥，用上面的按钮创建一个'))
        }
        rows.push(React.createElement('div', { className: 'dsh-mb-keys-list', key: 'ls' },
          list.map((k) => {
            const canCopy = k.copyable === true || k.hasLocal === true
            return React.createElement('div', { className: 'dsh-mb-key-card', key: k.id || k.masked },
              React.createElement('div', { className: 'dsh-mb-key-card-top' },
                React.createElement('span', { className: 'dsh-mb-key-card-name' }, k.name),
                React.createElement('span', { className: 'dsh-mb-badge' + (k.status === 'enabled' ? ' on' : ' off') },
                  k.status === 'enabled' ? '使用中' : '已停用'),
              ),
              React.createElement('div', { className: 'dsh-mb-key-code-row' },
                React.createElement('span', { className: 'dsh-mb-key-card-code' }, k.masked || '—'),
                // 平台只回掩码、也没有按 id 单取明文的口：本机留存（创建时落盘）是历史行
                // 唯一的复制路。两种来源文案分开写——复制的是哪一份，用户得看得见。
                canCopy
                  ? React.createElement('button', {
                      className: 'dsh-mb-key-copy',
                      title: k.hasLocal === true ? '复制完整密钥（创建时在本机留存的那份）' : '复制完整密钥（本机在用的那把）',
                      onClick: () => copyReveal(k),
                    }, copiedKeyId === k.id ? '已复制 ✓' : '复制完整值')
                  : React.createElement('span', { className: 'dsh-mb-key-card-none' }, '仅创建时展示过一次'),
              ),
              React.createElement('div', { className: 'dsh-mb-key-card-meta' },
                k.lastUsedAt ? '最近使用 ' + (fmtDay(k.lastUsedAt) || '—') : '从未使用',
                k.createdAt ? ' · 创建于 ' + (fmtDay(k.createdAt) || '—') : ''),
              // 清本机副本的入口：只删自己存的那份明文，平台密钥不动（与 oc 那张卡同一条）。
              k.hasLocal === true ? React.createElement('div', { className: 'dsh-mb-key-actions' },
                React.createElement('button', {
                  className: 'dsh-mb-link',
                  title: '删除本机保存的明文副本（平台上的密钥不受影响，这行回到只显示掩码）',
                  onClick: () => forgetTrKeyLocal(k),
                }, '不再在本机保存')) : null,
            )
          }),
        ))
        // 平台已删、本机还留着明文的孤儿副本：不自动清（删了就回不来），只提示 + 一键清。
        const orphans = Array.isArray(keysData.orphanIds) ? keysData.orphanIds : []
        if (orphans.length > 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'orphan' },
            '另有 ' + orphans.length + ' 份本机副本对应的密钥已不在平台（在官网删过？）',
            React.createElement('button', {
              className: 'dsh-mb-link', style: { marginLeft: 4 },
              title: '删掉这些已经用不上的本机明文副本（平台上的东西不受影响）',
              onClick: () => forgetTrKeyOrphans(orphans),
            }, '清掉')))
        }
        rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
          copyableCount > 0
            ? '完整值来自本机：面板里创建过的密钥存了一份副本（可随时删掉），DSH 正在用的那把靠头尾指纹对上'
            : '平台列表只回打码值，也没有按 id 单取明文的口——本机没留过副本的密钥复制不出完整值；新建一把即可（创建时自动留一份）',
          React.createElement('button', { className: 'dsh-mb-link', style: { marginLeft: 4 }, onClick: () => { try { window.open('https://tokenrhythm.studio/account/keys', '_blank') } catch { /* 拦截无碍 */ } } }, '官网管理 ↗')))
      }
      if (keyMsg) {
        rows.push(React.createElement('div', { className: 'dsh-mb-cookie-msg' + (keyMsg.ok ? '' : ' err') }, keyMsg.text))
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
    function renderBalanceTab({ manifest, balance, loadBalance, goSettings, sessionAccount, sessionAccountName, onRedeem }) {
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
      // 页首行（同一行）：左边「数据账号」+ 右边「更新于 …」与刷新按钮（用户指定保持一行）。
      // 账号口径：优先 manifest.accountName（/api/me 提取，开面板即有），其次余额响应里的
      // account（同样来自 /api/me，每 60s 刷新），都缺（/api/me 不可用）才回退登录标识
      // account（手机号）或 Cookie 模式文案。
      const dataAccount = sessionAccountName || (balance && balance.data && balance.data.account) || sessionAccount || null
      // 实名徽章（0.6.2）：余额路由每 60s 轮询带新值；开面板首帧（余额未回）从
      // manifest.session 兜底。缺 → rnBadge 返回 null，徽章不渲染（宁缺不编）。
      const rn = (balance && balance.data && balance.data.realname)
        || (manifest && manifest.session && manifest.session.realname) || null
      rows.push(pageTopBar({
        left: acctLine('数据账号：' + (dataAccount || '未登录（Cookie 模式）'), !!dataAccount, rnBadge(rn)),
        at: balance && balance.data && balance.data.fetchedAt ? fmtClock(balance.data.fetchedAt) : null,
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
        // 「数据账号」已并入页首行（见函数开头），这里不再单独占一行。
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
          // 图例行：左端＝限时占比 / 冻结这类事实（可能一个都没有，比如余额为 0），
          // 右端固定挂「兑换码」入口。两端对齐靠 .dsh-mb-hero-legend 的 space-between
          // ——左组 min-width:0 自己收窄，按钮才被顶到最右；兑换码与图例同一行是用户
          // 指定的位置，不额外占一行。
          React.createElement('div', { className: 'dsh-mb-hero-legend' },
            React.createElement('div', { className: 'dsh-mb-legend-bits' },
              legendBits.map((bit, i) => React.createElement('span', { key: i }, bit))),
            onRedeem ? React.createElement('button', {
              className: 'dsh-mb-redeem-btn',
              key: 'redeem',
              onClick: onRedeem,
              title: '输入体验卡兑换码，额度直接到账当前账号（同一账号下的 API Key 共享）',
            }, '兑换码') : null,
          ),
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
        // 各自给了多少、还剩多少、什么时候到期。
        // 已用完的不展示（2026-10-20 定稿）：remaining=0 或平台标 USED_UP 的行整行去掉，
        // 不再压暗混在可用额度里——那一屏「剩 ¥0」的暗行只会让人多读一遍才反应过来
        // 「这些已经不能花了」。「总共赠送过多少」由下面的累计赠送角标回答，不缺这几行。
        // 1 个请求，失败只丢这块。
        if (d.wallet) {
          const w = d.wallet
          // 两个条件取或：平台偶有 remaining=0 但状态没标 USED_UP 的，同样不留。
          const stillUsable = (r) => r.remainingCny > 0 && r.status !== 'USED_UP'
          const walletRows = []
          // 充值本金是唯一「不过期」的一行，还有钱时才置顶单独列，不与赠送额度混在
          // 一张按到期排的表里（用完了就不占这一行）。
          if (w.principal && stillUsable(w.principal)) {
            walletRows.push(React.createElement('div', { className: 'dsh-mb-wrow principal', key: 'p' },
              React.createElement('span', { className: 'dsh-mb-wrow-k' }, w.principal.sourceLabel || '充值本金'),
              React.createElement('span', { className: 'dsh-mb-wrow-n' },
                '赠送 ¥' + trimNum(w.principal.grantedCny) + ' / 已用 ¥' + trimNum(w.principal.consumedCny)),
              React.createElement('span', { className: 'dsh-mb-wrow-r' }, '剩 ¥' + trimNum(w.principal.remainingCny)),
              React.createElement('span', { className: 'dsh-mb-wrow-x' }, w.principal.expiresAt ? '到期 ' + fmtDay(w.principal.expiresAt) : '不过期')))
          }
          for (const it of w.items) {
            // 已用完的行直接不建（含平台偶发的 remaining=0 但状态没标 USED_UP）
            if (!stillUsable(it)) continue
            // 过滤后剩下的都是「还有钱」的，ACTIVE 之外只可能是平台换了状态字，
            // 兜底压暗来源名，别让它跟正常额度一样抢眼。
            const state = it.status === 'ACTIVE' ? 'active' : 'other'
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
            walletRows.length > 0 ? walletRows : React.createElement('div', { className: 'dsh-mb-hint', key: 'wempty' }, '暂无待使用额度（已用完的明细不再展示）'),
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
      // 页首行（与基元余额页同一套）：左边「ZCode 账号」+ 右边「更新于 …」与刷新按钮，同一行。
      const zcData = zcQuota && zcQuota.data
      const zcId = zcData && zcData.identity && (zcData.identity.name || zcData.identity.provider)
        ? 'ZCode 账号：' + (zcData.identity.name || '未知') + (zcData.identity.provider ? '（' + zcData.identity.provider + '）' : '')
        : null
      rows.push(pageTopBar({
        left: zcId ? acctLine(zcId, true) : null,
        at: zcData && zcData.fetchedAt ? fmtClock(zcData.fetchedAt) : null,
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
          // 「ZCode 账号」已并入页首行（见函数开头），这里不再单独占一行。
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
        '读取本机 ZCode 登录凭证（默认 ~/.zcode/v2，跟随数据目录设置）· 接口经插件后台代理 · 凭证只留在本机'))
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }


    // ================= 清枢智汇（TierFlow）页签：账户 / 套餐用量 =================
    // 平台把所有额度都存成 quota 整数，quota_per_unit（默认 500000）= ¥1；¥ 值一律
    // quota ÷ qpu，绝不写死除数（平台改版时 /api/status 会跟着变）。quota < 0（实测 -1）
    // 是「不限量」——**不能过金额格式**，否则渲染成 -¥0.0000。token 池是**另一套单位**
    // （basic_token_* 就是 token 个数，不是 quota），两套各自独立，绝不换算到一起。
    const TF_QPU_FALLBACK = 500000
    const tfQpuOf = (r) => {
      const q = r ? Number(r.quotaPerUnit) : NaN
      return Number.isFinite(q) && q > 0 ? q : 0
    }
    // quota → ¥（不限量单独出文案；缺值 → —）
    const tfMoney = (quota, qpu) => {
      if (typeof quota !== 'number' || !Number.isFinite(quota)) return '—'
      if (quota < 0) return '无限量'
      const u = Number(qpu) > 0 ? Number(qpu) : TF_QPU_FALLBACK
      return '¥' + fmtCny(quota / u)
    }
    // token 池数值：-1 = 不限量、0 = 平台没给（显示 —），其余按 亿/万 缩写
    const tfTokensOf = (n) => {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
      if (n < 0) return '无限量'
      if (n === 0) return '—'
      return fmtTokens(n)
    }
    // 剩余 = 总量 − 已用（平台只给 amount_total / amount_used、basic_token_total / basic_token_used
    // 四个数，**没有 remaining 字段**——别去臆造接口字段；进度条 tfRemainPct 用的是同一个减法，
    // 值与条必须同源）。总量缺 → null（上层自己走「无限量 / 未查询」分支）；已用缺 → 当 0；负数夹到 0。
    const tfRemainOf = (total, used) => {
      if (typeof total !== 'number' || !Number.isFinite(total)) return null
      const u = typeof used === 'number' && Number.isFinite(used) ? used : 0
      return Math.max(0, total - u)
    }
    // 剩余 token 的显示。**不能复用 tfTokensOf**：那里 0 = 「平台没给」（渲染成 —），
    // 而剩余的 0 是「用完了」，是有效值，必须老老实实显示 0。
    const tfRemainTokens = (total, used) => {
      const r = tfRemainOf(total, used)
      return r === null ? '—' : fmtTokens(r)
    }
    // 毫秒时间戳 → YYYY-MM-DD（host 侧已统一转毫秒；null/0 → —）
    const tfDayOf = (ms) => {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '—'
      const d = new Date(n)
      if (Number.isNaN(d.getTime())) return '—'
      const p = (x) => String(x).padStart(2, '0')
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }
    // 毫秒 → 本地 24 小时制「YYYY-MM-DD HH:MM」（跨天时间点，如下次重置）
    const tfMomentOf = (ms) => {
      const n = Number(ms)
      if (!Number.isFinite(n) || n <= 0) return '—'
      return tfDayOf(n) + ' ' + fmtClock(n).slice(0, 5)
    }
    // 剩余百分比（进度条口径）：不限量恒 100；总量缺失/为 0 → null（那种情况不画条）
    const tfRemainPct = (total, used, unlimited) => {
      if (unlimited === true) return 100
      if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
      const u = typeof used === 'number' && Number.isFinite(used) ? used : 0
      return Math.max(0, Math.min(100, Math.round((total - u) / total * 100)))
    }
    // 头像首字：邮箱取 @ 前那段的首字符，中文用户名取首字
    const tfInitials = (s) => {
      const t = typeof s === 'string' ? s.trim() : ''
      if (t === '') return '清'
      const at = t.indexOf('@')
      const head = at > 0 ? t.slice(0, at) : t
      return head.slice(0, 1).toUpperCase()
    }
    // （旧 tfKv 小格助手已删：账户页改走阶跃的 k/v/sub 数据格后清枢不再用它，
    //  ZCode 页用的是自己手写的 .dsh-mb-kv，CSS 类两页都还在、互不影响。）
    // 进度条行：上面一行「名字 ——— 数值」，下面是中性蓝的占比条（与 ZCode 剩余条同配方，
    // **不用橙色**——本插件里橙色专属「限时额度」语义，套餐额度是常规额度）。
    // 第 4 参是**节点**：两条「剩余 X」（套餐额度 / Token 池）都走 tfBigVal——这两个余量是
    // 这张卡的读数，不能跟标签同号同色。
    const tfBar = (key, label, pct, val, title) => React.createElement('div', {
      key, title: title || undefined, style: { display: 'flex', flexDirection: 'column', gap: 'var(--mb-sp-2)' },
    },
      React.createElement('div', { className: 'dsh-mb-hero-legend' },
        React.createElement('span', null, label),
        React.createElement('span', null, val)),
      pct === null ? null : React.createElement('div', { className: 'dsh-mb-hero-bar' },
        pct > 0 ? React.createElement('div', { className: 'dsh-mb-hero-bar-fill', style: { width: pct + '%' } }) : null))
    // 图例行右端的「主数 + 次量」两段值（订阅卡那两条「剩余 X」都用它）：用户定稿「全部订阅（2）
    // 的剩下的余额 突出显现」＋「token 的余量 也是 添加的颜色」——两个余量原来都跟标签同号同色
    // （都是 11px 灰字），压在一行里读不出重点。主数走 .dsh-mb-legend-v：20px/600 **主色** + 等宽
    // 数字，字号与卡右上「剩余天数 N 天」同档，颜色与它下面那条额度条同一支 --mb-acc（条画的就是
    // 这个余量的占比，读数与条同色是一件事）；分母类的「/ 总额」退成 .dsh-mb-legend-sub（11px 灰）
    // ——数是这张卡的读数，总额只是分母。sub 传 null 就只有主数（无限量时只写「无限量」，没有分母）。
    const tfBigVal = (v, sub) => React.createElement('span', { className: 'dsh-mb-stat-line' },
      React.createElement('span', { className: 'dsh-mb-legend-v' }, v),
      sub ? React.createElement('span', { className: 'dsh-mb-legend-sub' }, sub) : null)

    // ---- 清枢智汇「账户」页签 ----
    // 结构与阶跃「账户」页签**一比一**（用户定稿：布局与 7 天消耗都跟阶跃一致）：
    //   ① 添加栏：＋添加账号 / 共 N 个账号 / 查询全部
    //   ② 添加表单（收起时不出；一个账号都没有时强制展开——那就是空状态）
    //   ③ 账号卡：顶行（身份 / 密码 / 显示 / 删除）→ 一行两格数据格（账户余额 ｜ 当前套餐宽格：
    //      剩余天数 chip + 套餐名 + 剩余额度条 + 两端对齐的次级行）→ 脚行（展开 / 数据时间 /
    //      刷新）→ 展开后的明细块（近 7 日 token 消耗逐日柱条，阶跃同款）。
    // 原先的页首行（「清枢智汇账号：X · 更新于 · 刷新」）与页首主卡删除（用户定稿「账户的
    // 两个部分合二为一」）：主卡讲的就是当前账号，而当前账号本来就是下面账号卡里的一张——
    // 同一份数据在两处出现只是重复。现在所有账号一律一张卡，当前账号靠 .cur（accent 描边 +
    // 左侧竖条 + 右上「显示中」）区分，和阶跃一致。
    // 数据源是 /tierflow/accounts（host 纯读各账号的缓存快照，零网络）：每张卡显示**它自己**
    // 的余额、用量与套餐；要更新哪张点它自己的「刷新」，一次刷全部点「查询全部」。
    function renderTfUserTab({ tfUser, tfAccs, loadTfAccs, loadTfAccsDetail, tfDetailBusy, refreshTfAccount, useTfAccount, tfAccBusy, tfAccMsg, tfAcc, setTfAcc, tfAccPw, setTfAccPw, showTfPw, setShowTfPw, addTfAccount, removeTfAccount, tfConfirm, setTfConfirm, tfAddOpen, setTfAddOpen, tfPwShown, tfPwVal, revealTfPw, tfOpen, setTfOpen, openTfBuy }) {
      // quota_per_unit 是平台级常量（不是按账号）：账号清单自带（host 取自 /status 缓存），
      // 取不到就退页签刚拉到的 /tierflow/user，再退平台默认值——绝不显示成 ¥0。
      const qpuRaw = tfQpuOf(tfAccs) || tfQpuOf(tfUser && tfUser.data)
      const qpu = qpuRaw > 0 ? qpuRaw : TF_QPU_FALLBACK
      if (tfAccs === null) {
        return React.createElement('div', { className: 'dsh-mb-section' },
          React.createElement('div', { className: 'dsh-mb-skel-hero', key: 'sk1', role: 'status', 'aria-label': '加载中' }),
          React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'sk2' }))
      }
      if (tfAccs.error && !Array.isArray(tfAccs.accounts)) {
        return React.createElement('div', { className: 'dsh-mb-section' },
          React.createElement('div', { className: 'dsh-mb-notice err', key: 'e' },
            tfAccs.error,
            React.createElement('div', { style: { marginTop: '6px' } },
              React.createElement('button', { className: 'dsh-mb-link', onClick: loadTfAccs }, '重试'))))
      }
      const rows = []
      const accList = Array.isArray(tfAccs.accounts) ? tfAccs.accounts : []
      const activeId = typeof tfAccs.activeAccount === 'string' ? tfAccs.activeAccount : ''
      const accBusyMap = tfAccs.busy || {}
      // 当期账号这次没查到（会话过期 / 平台抖动）：卡片显示的是上一次的快照，必须说出来——
      // 旧数看着像新数，比没有数更糟。放在列表之前，不占卡片的位置。
      if (tfUser && tfUser.error && accList.length > 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'uerr' },
          '当前显示的账号这次没查到（' + tfUser.error + '），下面卡片是上一次成功的数据。'))
      }
      if (tfAccs.error && accList.length > 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'aerr' },
          '账号清单刷新失败：' + tfAccs.error))
      }
      if (accList.length === 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'none' },
          '还没有清枢智汇账号：用下面「添加账号」里的手机号 / 邮箱 + 密码登录一次即可（添加时会先向平台真登一次校验，密码只存本机，随时可看可删）。'))
      }

      // ---- 添加栏 + 添加表单 + 账号卡（与阶跃账户页同一套骨架；不再有单独的「账号管理」标题，
      // 阶跃这页也没有——添加栏本身就说明了这一段是什么）----
      const addOpen = accList.length === 0 ? true : tfAddOpen
      rows.push(React.createElement('div', { className: 'dsh-mb-stepacc-addbar', key: 'ab' },
        React.createElement('button', {
          className: 'dsh-mb-btn small ghost',
          disabled: tfAccBusy,
          title: addOpen ? '收起添加表单' : '添加一个清枢智汇账号（手机号/邮箱 + 密码）',
          onClick: () => setTfAddOpen(!addOpen),
        }, addOpen ? '收起添加' : '＋ 添加账号'),
        // 空态不再重复「还没有账号」：上面那条空态提示已经把这件事说完了，
        // 两行之内说两遍只是噪音（用户定稿）。有账号时这里照旧写条数与当前显示。
        accList.length > 0
          ? React.createElement('span', { className: 'dsh-mb-hint', key: 'n' },
            '共 ' + accList.length + ' 个账号' + (activeId !== '' ? '（当前显示 ' + activeId + '）' : ''))
          : null,
        React.createElement('span', { className: 'sp', key: 'sp' }),
        // 主操作独立放右侧：查询要逐个真打平台（缺会话的先登录，账号间有 30s 冷却），
        // 是这一页最重的动作，不和「添加账号」这种低频操作并列混在一起。
        // 「购买订阅」原先也挂在这一簇（弹出后还能换账号买），但用户定稿「不应该是账户的，不要
        // 放在最上面」——它是**某一张卡**的事（钱从那个账号的余额扣），已挪到每张账号卡的脚行。
        React.createElement('button', {
          className: 'dsh-mb-btn small',
          disabled: tfDetailBusy || accList.length === 0,
          title: '查询全部账号的余额与套餐（真发请求；会话失效的账号会先按存的密码重登一次）',
          onClick: loadTfAccsDetail,
        }, tfDetailBusy ? '查询中…' : '查询全部')))
      if (addOpen) {
        rows.push(React.createElement('div', { className: 'dsh-mb-acc-form', key: 'form' },
          React.createElement('input', {
            className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
            type: 'text', autoComplete: 'off', maxLength: 96,
            placeholder: '手机号 / 邮箱', value: tfAcc,
            onChange: (e) => setTfAcc(e.target.value),
          }),
          React.createElement('div', { className: 'dsh-mb-pw-wrap' },
            React.createElement('input', {
              className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
              type: showTfPw ? 'text' : 'password', autoComplete: 'off',
              placeholder: '密码', value: tfAccPw,
              onChange: (e) => setTfAccPw(e.target.value),
            }),
            React.createElement('button', {
              className: 'dsh-mb-pw-eye', title: showTfPw ? '隐藏密码' : '显示密码',
              onClick: () => setShowTfPw(!showTfPw),
            }, EyeIcon({ off: showTfPw })),
          ),
          React.createElement('button', {
            className: 'dsh-mb-btn small',
            disabled: tfAccBusy || tfAcc.trim() === '' || tfAccPw === '',
            title: '添加时会先向平台登录校验一次；账号密码不对就不会保存',
            onClick: addTfAccount,
          }, tfAccBusy ? '校验中…' : '添加'),
        ))
      }
      if (tfAccMsg) {
        rows.push(React.createElement('div', { className: 'dsh-mb-cookie-msg' + (tfAccMsg.ok ? '' : ' err'), key: 'msg' }, tfAccMsg.text))
      }
      // 近 7 日消耗明细（阶跃账户卡「近 7 日 Credit 消耗」同款画法，用户定稿「7 天的消耗保持一致」）：
      // 每天一根条——日期 + 轨道 + 数值，条长按窗口内最大值归一。平台只在有调用的日子留痕，
      // 最早一条超过 7×24h 时改写标题说清楚（「最近 N 个有记录日」），绝不冒充「近 7 日」。
      // 每根条的 tooltip 给全口径（次数 / token / 折 ¥），悬停就能对账。
      const renderTfUsage = (us) => {
        const out = []
        const md = (ms) => { const d = new Date(ms); return (d.getMonth() + 1) + '-' + d.getDate() }
        // 只画**最近 7 个有记录日**（用户定稿「token 消耗 只显示 最近有消耗的 7天」）：平台只在
        // 有调用的日子留痕，「有记录日」就是「有消耗的日子」；更早的桶一律不画（原先全画，标题才
        // 被迫写出桶数）。桶升序（老 → 新），末尾 7 个就是最新的 7 天。
        const buckets = (Array.isArray(us.dayBuckets) ? us.dayBuckets : []).slice(-7)
        // 「近 N 天合计：…」不在这里——用户定稿把它挪到卡片脚行「收起」后面
        // （`.dsh-mb-stepacc-sum`）：明细块首从此只有标题 + 每天的条。
        if (buckets.length === 0) {
          out.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'e' },
            us.rowCount === 0 ? '窗口内没有调用记录（平台只统计走到接口的调用）' : '逐日明细暂不可用'))
          return out
        }
        const stale = buckets[0].dayStartMs < Date.now() - 7 * 86400000
        out.push(React.createElement('div', { className: 'dsh-mb-day-title', key: 'dt' },
          stale ? 'token 消耗（最近 ' + buckets.length + ' 个有记录日）' : '近 7 日 token 消耗'))
        const max = Math.max(1, ...buckets.map((x) => x.tokens))
        for (const x of buckets) {
          out.push(React.createElement('div', { key: x.dayStartMs, className: 'dsh-mb-step-bar' },
            React.createElement('span', { className: 'dsh-mb-step-bar-d' }, md(x.dayStartMs)),
            React.createElement('span', { className: 'dsh-mb-step-bar-track' },
              React.createElement('span', { className: 'dsh-mb-step-bar-fill', style: { width: (x.tokens / max * 100) + '%' } })),
            React.createElement('span', {
              className: 'dsh-mb-step-bar-v',
              title: md(x.dayStartMs) + '：' + fmtTokens(x.count) + ' 次请求 · ' + fmtTokens(x.tokens) + ' token · ' + tfMoney(x.quota, qpu),
            }, x.tokens > 0 ? fmtTokens(x.tokens) : '')))
        }
        return out
      }

      accList.forEach((a) => {
        const id = String(a.identifier)
        const au = a.user || null
        const us = a.usage || null
        const asub = a.subscription || null
        const isCur = id.toLowerCase() === activeId.toLowerCase()
        const confirming = tfConfirm === id
        const b = accBusyMap[id] === true
        const showing = tfPwShown === id
        const open = tfOpen[id] === true
        // 这张卡查没查过：host 的账号清单只回已缓存的快照，没查过的账号是 null——
        // 卡面走 .dim（虚线框 + 透明底 + 数值降灰），名字行挂「未查询」角标，与阶跃一致。
        const hasUser = au !== null
        const hasUsage = !!(us && us.totals)
        const hasSub = asub !== null
        const queried = hasUser || hasSub
        const notq = a.error ? '上次查询失败' : '尚未查询'
        // 身份层级（用户定稿「账户信息的布局也对齐」——与阶跃顶行同一套层级）：
        //   显示名 = 平台用户名（那是「这个人的名字」，与阶跃用昵称当显示名同理）；
        //   没查到用户信息时退回登录身份本身（唯一已知的显示名，不编「—」）；
        //   登录身份（当初填的手机号 / 邮箱）**不丢**，另起一枚灰字挂在「显示」前面——
        //   阶跃的顶行就是这个排法（昵称顶主位、手机号退到右侧），登录要用它。
        const uname = hasUser ? (au.username || au.email || '') : ''
        const dispName = uname !== '' ? uname : id
        const showIdChip = uname !== '' && uname.toLowerCase() !== id.toLowerCase()
        const cells = []
        // 顶行：**全部放在一行**（用户定稿「放在一行」）——头像 + 显示名在左，
        // 登录身份 / 密码胶囊 / 显示控制 / 删除**一律靠右**（用户定稿「账号密码放在右边」）：
        // 左边回答「这是谁」，右边回答「能对它做什么」，视线扫右边缘就能找到动作。
        // 宽度不够时**只有名字缩**（min-width:0 + 省略号），右侧簇 flex:none 不参与压缩
        // ——徽章 / 密码胶囊 / 按钮是理解这张卡的锚，缩了就不是「看不全」而是「看不懂」。
        // 「刷新」在脚行：真打平台的动作和「显示」这种低频操作并排是主次不分。
        // 当前账号只出「当前显示」徽章、不出按钮：禁用的「显示中」按钮说的是同一句话，
        // 一行里不写两遍（省下的宽度还给显示名）。
        // 名字行只挂**待办**角标（「未查询」= 这块屏幕还没数），不播报状态：原先那枚会话态徽章
        // （「已登录」/「待登录」）按定稿整枚删除（用户：「已登录的标签 删除」）——清枢的会话由
        // 插件按存的密码自动续期，「本地有会话」是常态，常态不值得每次喊一声；真缺会话也只是
        // 「下次查询会自动登一次」这种会自愈的过渡态，提前预警并没有可做的动作。
        cells.push(React.createElement('div', { className: 'dsh-mb-stepacc-top', key: 'top' },
          React.createElement('span', { className: 'dsh-mb-stepacc-ava', 'aria-hidden': 'true' }, tfInitials(dispName)),
          React.createElement('div', { className: 'dsh-mb-stepacc-name', key: 'id', style: { flex: 1, minWidth: 0 } },
            React.createElement('span', {
              className: 'dsh-mb-stepacc-nick',
              style: { minWidth: 0 },
              title: uname !== '' ? '清枢用户名' : '登录身份',
            }, dispName),
            queried ? null : React.createElement('span', {
              className: 'dsh-mb-stepacc-unq',
              title: '这个账号还没查过——点右上角「查询全部」，或卡片脚行的「查询此账号」',
            }, '未查询'),
          ),
          React.createElement('div', { className: 'dsh-mb-stepacc-tail', key: 'tail' },
            // 登录身份：只在它和显示名不是同一个字符串时出，免得同一个值写两遍。
            showIdChip
              ? React.createElement('span', {
                className: 'dsh-mb-stepacc-idsec', key: 'idsec', title: '登录身份（当初用它登的）',
              }, id)
              : null,
            // 密码胶囊：只在本机读、单取路由，点一下才显明文（同一时刻只展开一个）。
            // 包一层 .dsh-mb-stepacc-idsec 是为了拿到它那套 meta 字号 / 400 字重 / tert 颜色
            // ——直接放进名字行会继承 600 字重，胶囊看着像标题。
            React.createElement('span', { className: 'dsh-mb-stepacc-idsec', key: 'pw' },
              React.createElement('button', {
                className: 'dsh-mb-stepacc-pw' + (showing ? ' on' : ''),
                title: showing ? '隐藏密码' : '显示密码（只在本机读取，不经过网络）',
                onClick: () => revealTfPw(id),
              },
                React.createElement('span', null, showing ? (tfPwVal || '（空）') : (a.pwMask || '••••••')),
                EyeIcon({ off: showing }),
              ),
            ),
            // 显示控制：当前账号给「当前显示」徽章，其余账号给可点的「显示」按钮。
            isCur
              ? React.createElement('span', {
                className: 'dsh-mb-stepacc-cur', key: 'cur',
                title: '侧栏胶囊与主卡显示这个账号的数据',
              }, '当前显示')
              : React.createElement('button', {
                className: 'dsh-mb-btn small',
                title: '让侧栏胶囊与主卡显示这个账号的数据',
                onClick: () => useTfAccount(id),
              }, '显示'),
            React.createElement('button', {
              className: 'dsh-mb-stepacc-x' + (confirming ? ' armed' : ''),
              disabled: tfAccBusy,
              title: confirming ? '再点一次确认删除（连本地会话一起丢）' : '删除该账号（连本地会话一起丢）',
              onClick: () => removeTfAccount(id),
            }, confirming ? '确认删除' : '删除'),
          ),
        ))
        // 卡片数据格（阶跃同款 k/v/sub 配方，一行两格）：账号级快照——host 侧清单只回已缓存的
        // 值，格子的口径是「这个账号上次查到的数」，没查过的格子降灰写明，不编 0。
        //   左：**不限时余额**（用户定稿「左边放不限时的，就是总的减去右边的」）
        //   右（宽格）：**全部到期合计**（同一轮的「右边放全部到期合计，就是余额」）
        // 这两格就是钱包的全貌：左 + 右 = 总额（总额与累计已用退到左格次级行，仍然读得到）。
        // 原先右格讲的是「当前套餐」——套餐额度与订阅明细仍在「套餐用量」页签，
        // 账号卡这里不再重复一遍（同一份数说两处）。
        // 口径：全部到期合计 = 会到期失效的那部分（host 侧按平台「赠送到期计划」把未到期的
        // 各笔加总，见 tfNormalizeUser 的 expiringQuota）；不限时余额 = 总额 − 它，永不过期。
        // 橙色在本插件里**专属「限时」语义**，两段条沿用基元余额页的配方：
        // 蓝底 = 不限时（左），右端橙段 = 限时（用户指定「限时的在右边」）。
        const expQuota = hasUser && Number.isFinite(au.expiringQuota) ? au.expiringQuota : null
        const totalQuota = hasUser && Number.isFinite(au.quota) && au.quota > 0 ? au.quota : null
        const nonExpQuota = expQuota === null || totalQuota === null ? null : Math.max(0, totalQuota - expQuota)
        const expShare = expQuota === null || expQuota <= 0 || totalQuota === null ? 0 : Math.min(1, expQuota / totalQuota)
        const noLimit = hasUser && au.unlimited === true
        const balTip = !hasUser ? '' : ('全部到期合计（限时余额）= 会到期失效的那部分：平台「赠送到期计划」里还没到期的各笔之和'
          + (au.expiringBatchCount > 1 ? '（共 ' + au.expiringBatchCount + ' 笔）' : '')
          + (au.expiringNextAtMs ? '，最近一笔 ' + tfDayOf(au.expiringNextAtMs) + ' 到期' : '')
          + '；到期未用由平台回收。按 quota_per_unit 折成 ¥')
        const nonExpTip = '不限时余额 = 总额 − 全部到期合计，不会过期。按 quota_per_unit 折成 ¥'
        const totalTip = '总额 = 不限时余额 + 全部到期合计；累计已用取平台 used_quota。按 quota_per_unit 折成 ¥'
        cells.push(React.createElement('div', { className: 'dsh-mb-stepacc-kv', key: 'kv' },
          React.createElement('div', { className: hasUser ? '' : 'dim' },
            React.createElement('span', { className: 'k' }, '不限时余额'),
            React.createElement('span', { className: 'v', title: nonExpTip },
              hasUser ? (noLimit ? '无限量' : tfMoney(nonExpQuota, qpu)) : '—'),
            // 总额 / 累计已用分两行而不是一行：左格只有 40% 宽，一行塞两笔 4 位小数的
            // 金额（约 175px）在 400px 面板里会被省略号截到「累计已…」；分两行每行都
            // 放得下，格高也与右格（4 行）对齐。全文仍在 title 里。
            React.createElement('span', { className: 'sub', key: 'tt', title: totalTip },
              hasUser ? '总额 ' + tfMoney(au.quota, qpu) : notq),
            React.createElement('span', { className: 'sub', key: 'tu' },
              hasUser ? '累计已用 ' + tfMoney(au.usedQuota, qpu) : '')),
          React.createElement('div', { className: 'wide' + (hasUser ? '' : ' dim') },
            React.createElement('div', { className: 'krow', key: 'krow' },
              React.createElement('span', { className: 'k' }, '全部到期合计'),
              hasUser && au.expiringNextAtMs
                ? React.createElement('span', {
                  className: 'dsh-mb-stepacc-rst', title: balTip,
                }, tfDayOf(au.expiringNextAtMs) + ' 到期')
                : null),
            React.createElement('span', { className: 'v', title: balTip },
              !hasUser ? '—' : (noLimit ? '无限量' : tfMoney(expQuota, qpu))),
            // 次级行只留笔数（它讲的是「右格这个合计由几笔凑成」）；占比跟条走——条已经搬到
            // 卡片级（见下面「余额构成」那两行），占比是它的图例，跟着一起搬。
            hasUser
              ? React.createElement('span', { className: 'sub', title: balTip },
                '限时余额' + (au.expiringBatchCount > 1 ? ' · ' + au.expiringBatchCount + ' 笔' : ''))
              : React.createElement('span', { className: 'sub' }, notq))))
        // 余额构成（用户定稿「账户卡片的进度条 参考基元的展示格式」）：**整卡宽**的两段条 +
        // 它自己的图例行。基元余额主卡就是「统计 → 条 → 图例」这三行，这里照同一套类名、同一套
        // 顺序落，只是上面那行「统计」是这张卡原有的两格数据格。
        // 条与图例都是**卡片级**的一行，不再嵌在右格里：嵌在格里只有半张卡宽，而它讲的是
        // 「整份余额里有多少会到期」——读的对象是**两格之和**，就该铺满整张卡；图例挂在条
        // 下面，与基元那张卡一样（占比是这条的读数，离开条就没有指代）。
        // 蓝底 = 不限时、右端橙段 = 限时；限时为 0 时不出填充段（fill 有 2px 最小宽，留在纯蓝
        // 条右端像「有一点点限时」），占比照写「限时占 0%」；无限量没有构成可言，**条与占比一起
        // 不出**——但**图例行照出**（定稿「购买订阅 和 限时占 73% 部分 两端对齐」＋「购买订阅 按钮
        // 添加 颜色」）：左端写占比（没数就不写），右端常驻那枚「购买订阅」。
        const showBalBar = hasUser && !noLimit && expQuota !== null
        if (showBalBar) {
          cells.push(React.createElement('div', {
            className: 'dsh-mb-hero-bar limited', key: 'balbar', title: balTip,
          },
            expShare > 0
              ? React.createElement('div', { className: 'dsh-mb-hero-bar-fill', style: { width: (expShare * 100) + '%' } })
              : null))
        }
        // 图例行两端对齐（与基元那张卡的「限时占 / 兑换码」、订阅卡的「下次重置 / 升级套餐」
        // **同一个配方**）：靠 .dsh-mb-hero-legend 的 space-between，再加上按钮自带的
        // margin-left:auto 兜一层。左组即使一个数都没有也要留空节点——只剩按钮一个孩子时，
        // space-between 会把它摆到左端。
        // 这一行是**只要这张卡在就一定渲染**的：条和占比可以因为没数据不出，可它右端挂着这张卡
        // 唯一的付费入口，不能随数据状态时有时无（一枚时有时无的「购买订阅」比位置不理想更糟）。
        cells.push(React.createElement('div', { className: 'dsh-mb-hero-legend', key: 'balleg' },
          React.createElement('div', { className: 'dsh-mb-legend-bits' },
            showBalBar
              ? React.createElement('span', { title: balTip },
                '限时占 ' + (Math.round(expShare * 1000) / 10) + '%')
              : null),
          // 购买订阅（定稿「账户的部分添加购买订阅的功能，只能余额买」＋「不应该是账户的，不要放在
          // 最上面」＋「购买订阅 和 限时占 73% 部分 两端对齐 购买订阅 按钮 添加 颜色」）：跟着
          // **这张卡**走，钱从这张卡的账号余额扣——点哪张卡就买哪个账号，所以弹窗里的目录与付款
          // 账号都认这张卡，不受「当前显示」影响。
          // 位置：从脚行的左侧动作簇挪到这条图例行的右端。脚行那行本来就挤着「展开 / 查询此账号」
          // 与右侧常驻的「数据时间 + 刷新」，四样平铺看不出层级；挪上来之后左边是读数、右边是这张
          // 卡唯一能花钱的动作，分工一眼可辨。
          // 颜色：不再用脚行那种灰描边的次级 ghost，改用订阅卡「升级套餐」那颗**同一配方**的品牌色
          // 胶囊 .dsh-mb-hero-btn（主色字 + 12% 浅底 + 42% 描边）——像素值只写在样式表那一处，
          // 这里只挂类名；依旧**不带悬浮 title**（按钮文字自己就是名字）。
          React.createElement('button', {
            className: 'dsh-mb-hero-btn', key: 'buy',
            onClick: () => openTfBuy(id),
          }, '购买订阅')))
        // 脚行（阶跃同款）：左「展开 ▼ / 收起 ▲」（没查过则是「查询此账号」）+ sp + 数据时间 + 刷新。
        // 数据时间 = 该账号两个快照（余额 / 套餐）里较新的那个取数时刻——没有它，缓存里的
        // 旧数看着就像新数；阶跃卡脚同一位置同一含义。
        // 「近 N 天合计：…」的文本（用户定稿：从明细块首挪到脚行、**紧跟在「收起」后面**）。
        // 展开时才出——它讲的就是展开出来的那一坨数；收起时脚行只说「数据时间 + 刷新」。
        const sumTxt = hasUsage
          ? '近 ' + us.days + ' 天合计：' + fmtTokens(us.totals.count) + ' 次请求 · '
            + fmtTokens(us.totals.tokens) + ' token · ' + tfMoney(us.totals.quota, qpu)
          : ''
        const foot = []
        if (queried) foot.push(React.createElement('button', {
          className: 'dsh-mb-btn small ghost', key: 'tg',
          onClick: () => setTfOpen((cur) => ({ ...cur, [id]: !open })),
        }, open ? '收起 ▲' : '展开 ▼'))
        else foot.push(React.createElement('button', {
          className: 'dsh-mb-btn small ghost', key: 'q',
          disabled: b, onClick: () => refreshTfAccount(id),
        }, b ? '查询中…' : '查询此账号'))
        // 合计贴「收起」放（在弹性留白 .sp 之前），宽度不够时它自己省略——脚行右侧的
        // 「数据时间 + 刷新」是常驻动作，不能被一行合计挤掉；全文在 tooltip 里。
        if (open && sumTxt !== '') foot.push(React.createElement('span', {
          className: 'dsh-mb-stepacc-sum', key: 'sum', title: sumTxt,
        }, sumTxt))
        // 「购买订阅」不在这一行：它挪到上面那条图例行的右端了（定稿「购买订阅 和 限时占 73%
        // 部分 两端对齐」＋「购买订阅 按钮 添加 颜色」，理由见图例行那里的注释）。脚行留 sp：
        // 左侧动作簇与右侧常驻的「数据时间 + 刷新」之间还是要有那道弹性留白。
        foot.push(React.createElement('span', { className: 'sp', key: 'sp' }))
        const atMs = Math.max(a.userAt || 0, a.subAt || 0)
        if (atMs > 0) foot.push(React.createElement('span', { className: 'dsh-mb-stepacc-meta', key: 'at' }, '数据时间 ' + fmtCheckedAt(atMs)))
        foot.push(React.createElement('button', {
          className: 'dsh-mb-btn small ghost', key: 'rf',
          disabled: b, onClick: () => refreshTfAccount(id),
        }, b ? '…' : '刷新'))
        cells.push(React.createElement('div', { className: 'dsh-mb-stepacc-foot', key: 'ft' }, foot))
        // 明细块在「展开/收起」按钮**下面**（阶跃同款阅读顺序：先看到开关，再看到展开的内容）。
        if (open && hasUsage) {
          cells.push(React.createElement('div', { className: 'dsh-mb-stepacc-det', key: 'det' }, renderTfUsage(us)))
        }
        if (a.error) {
          cells.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'err', style: { color: 'var(--mb-warnTx)' } }, '上次查询失败：' + a.error))
        }
        rows.push(React.createElement('div', {
          key: 'a-' + id,
          className: 'dsh-mb-stepacc' + (isCur ? ' cur' : '') + (queried ? '' : ' dim'),
        }, cells))
      })
      // 卡尾那行安全说明（会话 cookie 只留本机 / 接口走插件后台代理 / 「显示」不影响其他
      // 账号的会话）已按用户要求整条删除——三件事都是插件的实现口径，不是这张卡要让用户
      // 做的决定；删掉之后卡片列表直接结束，不再拖一条灰字尾巴。
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- 清枢智汇「套餐用量」页签 ----
    // 当前生效套餐（status=active 且未过期，多条时取最早到期的那条）+ 全部订阅列表。
    // 两条进度各自独立：amount_* 是 quota（→¥），basic_token_* 是 token 个数——**别合并**。
    function renderTfSubTab({ tfSub, tfAccs, loadTfSub, openTfPlans, tfPlans }) {
      // 这一份订阅还有没有更高的档可升：拿 `/tierflow/plans` 里同 subNo 那组的 target 数判。
      // 目录还没取到时默认 false（宁可晚上一步，也不摆一个点了没用的按钮）；最高档就这么消失，
      // 要看全貌还有弹窗里的「看全部订阅（N）」。
      const tfCanUpgrade = (subNo) => {
        const pd = tfPlans && tfPlans.data ? tfPlans.data : null
        if (pd === null || !Array.isArray(pd.subs)) return false
        const g = pd.subs.filter((x) => x.subNo === subNo)[0]
        return g !== undefined && Array.isArray(g.targets) && g.targets.length > 0
      }
      const rows = []
      const subData = tfSub && tfSub.data ? tfSub.data : null
      const subs = subData && Array.isArray(subData.subs) ? subData.subs : []
      const activeId = tfAccs && typeof tfAccs.activeAccount === 'string' ? tfAccs.activeAccount : (subData && subData.account) || ''
      rows.push(pageTopBar({
        // 左边「全部订阅（N）」、右边「更新于 … + 刷新」**同一行两端对齐**（用户定稿）：
        // 正文里那行重复的标题随之删掉——同一句话说两遍，第二遍只会把首屏顶下去。
        // 账号名依旧不在这里重复：它挂在页签标签里。
        left: subs.length > 0
          ? React.createElement('div', { className: 'dsh-mb-day-title' }, '全部订阅（' + subs.length + '）')
          : null,
        at: subData && subData.atMs ? fmtClock(subData.atMs) : null,
        onRefresh: () => loadTfSub(true),
        // 右上角不放「升级订阅」了（定稿「右上角的升级订阅 按钮删除」）：升级的入口只在
        // 订阅卡上——哪张卡有更高的档可升，那张卡右端才出「升级套餐」。（**购买**是另一件事：
        // 按新定稿「账户的部分添加购买订阅的功能，只能余额买」放账户页，且按「不应该是账户的，
        // 不要放在最上面」挂在**每张账号卡的脚行**上——见 renderTfBuy 与 renderTfUserTab。）
      }))
      if (tfSub === null || (tfSub.loading && !subData)) {
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-hero', key: 'ld', role: 'status', 'aria-label': '加载中' },
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '40%', height: 30, borderRadius: 8 } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '72%' } }),
          React.createElement('div', { className: 'dsh-mb-skel', style: { width: '100%', height: 7, borderRadius: 4 } }),
        ))
      } else if (tfSub.error) {
        const noAcc = tfSub.code === 'NO_TF_ACCOUNT'
        rows.push(React.createElement('div', { className: noAcc ? 'dsh-mb-notice' : 'dsh-mb-notice err', key: 'err' },
          noAcc
            ? '还没有清枢智汇账号：切到「账户」页签，用手机号 / 邮箱 + 密码添加一个。'
            : '套餐用量查询失败：' + tfSub.error,
          noAcc
            ? null
            : React.createElement('div', { style: { marginTop: '6px' } },
              React.createElement('button', { className: 'dsh-mb-link', onClick: () => loadTfSub(true) }, '重试'))))
      } else if (subData) {
        // 「当前套餐」主卡删除（用户定稿）：主卡内容本来就是从这份列表里挑出来的
        // （active 且未过期里最早到期的那份），单独再渲染一遍等于同一份套餐说两遍。
        // 全部订阅统一用主卡样式渲染；**生效中的另外给绿徽章 + 高亮**（is-active），
        // 哪份在生效一眼挑得出来，也就不再需要一张单独的「当前套餐」卡。
        if (subs.length === 0) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'none' },
            '这个账号还没有任何订阅记录。'))
        } else {
          // 「生效中」判定与 host 挑当前套餐同一口径（status === 'active' 且未过期，
          // end_time 缺失视为不过期）。判定用的时刻取 `cachedAt`（host 缓存里那份数据的
          // **取数时刻**，命中缓存时才有），依次退到 atMs（本机收到时刻）、当下：
          // 卡上的「剩余天数」是 host 在取数那一刻算的，判定若用当下时间，缓存命中时两个
          // 数会互相矛盾——卡上写「剩余 1 天」却因为 end_time 已过而被标成不是生效中。
          const nowRef = subData.cachedAt || subData.atMs || Date.now()
          subs.forEach((s, i) => {
            const isActive = s.status === 'active' && !(s.endTimeMs !== null && s.endTimeMs < nowRef)
            const pctAmount = tfRemainPct(s.amountTotal, s.amountUsed, s.unlimitedAmount)
            const pctToken = tfRemainPct(s.basicTokenTotal, s.basicTokenUsed, s.unlimitedTokens)
            // 期限的两个端点并在同一行（主卡同款）：缺一端只显示存在的那端，两端都缺整行不出。
            const tfTermTxt = [
              s.startTimeMs ? '生效 ' + tfDayOf(s.startTimeMs) : null,
              s.endTimeMs ? tfDayOf(s.endTimeMs) + ' 到期' : null,
            ].filter(Boolean).join(' · ')
            // 生效中的状态由标题旁的绿徽章表达，副行不再重复「生效中」；其余（已过期 / 待生效）
            // 照实报状态。**来源里「等于没说」的三个不写**（用户定稿两次：「购买的那个占位删除」
            // ＋「专业版生效中 下面的 升级 也删除」）：order=购买 是默认路径，写出来等于
            // 「不是赠送」；upgrade=升级 与卡底那行「由「X」升级而来」说的是同一件事；
            // subscription=订阅 摆在一张订阅卡上更是同义反复。赠送 / 兑换 / 试用 / 管理员发放
            // 这些说的才是别的事，照写；认不出的来源也照写（它可能真说了什么）。副行因此常整行不出。
            const srcTxt = ['order', 'upgrade', 'subscription'].indexOf(s.source) === -1 ? s.sourceName : ''
            const metaTxt = [isActive ? '' : (s.statusName || s.status || '—'), srcTxt].filter(Boolean).join(' · ')
            rows.push(React.createElement('div', { className: 'dsh-mb-hero' + (isActive ? ' is-active' : ''), key: 's' + i },
              React.createElement('div', { className: 'dsh-mb-hero-stats' },
                React.createElement('div', { className: 'dsh-mb-stat' },
                  // 卡上不摆订阅号（定稿「订阅 SB1261014774051。这个删除」）：要认号就 hover
                  // 升级弹窗里的组标题，那里带着。
                  React.createElement('span', { className: 'dsh-mb-stat-v' },
                    s.planMissing ? '已下架套餐' : (s.planTitle || '—'),
                    isActive
                      ? React.createElement('span', { className: 'dsh-mb-badge on', style: { marginLeft: 'var(--mb-sp-2)' }, title: '这份订阅正在生效（与平台同一判定：状态生效中且未过期）' }, '生效中')
                      : null),
                  metaTxt !== '' ? React.createElement('span', { className: 'dsh-mb-stat-k' }, metaTxt) : null,
                ),
                React.createElement('div', { className: 'dsh-mb-stat right' },
                  // 「剩余天数」与「N 天」并成一行（定稿「剩余天数 30 天 放在一行显示」）：竖排时标签
                  // 一行、数字一行，本该挨着读的两个字被拆开；并排后读作一句「剩余天数 30 天」。
                  // 下面那行期限（生效 … · … 到期）说的是另一件事，仍单独一行。
                  React.createElement('span', { className: 'dsh-mb-stat-line' },
                    React.createElement('span', { className: 'dsh-mb-stat-k' }, '剩余天数'),
                    React.createElement('span', { className: 'dsh-mb-stat-v' }, s.daysLeft === null ? '—' : s.daysLeft + ' 天')),
                  tfTermTxt !== '' ? React.createElement('span', { className: 'dsh-mb-stat-k' }, tfTermTxt) : null,
                ),
              ),
              // 数值一律「剩余 / 总额」，标签写明「剩余」：条画的是剩余百分比，与数值同源（口径见 tfRemainOf）。
              // 这一行的数值**占主数位**（用户定稿「全部订阅（2）的剩下的余额 突出显现」）：剩下那笔钱
              // 按卡右上的「剩余天数」同档字渲染（20px/600 主色 + 等宽数字），「/ 总额」退成 11px 灰字的
              // 次量——口径一个字没改，只是把原来挤在一个灰字串里的两段拆开摆（见 tfBigVal）。
              tfBar('ba' + i, '剩余套餐额度',
                pctAmount,
                s.unlimitedAmount
                  ? tfBigVal('无限量', null)
                  : tfBigVal(
                    tfMoney(tfRemainOf(s.amountTotal, s.amountUsed), subData.quotaPerUnit),
                    '/ ' + tfMoney(s.amountTotal, subData.quotaPerUnit)),
                '剩余 / 总额。平台给 amount_total 与 amount_used，剩余 = 总量 − 已用；按 quota_per_unit 折成 ¥'),
              // token 池同款（用户定稿「token 的余量 也是 添加的颜色」）：它和上面那笔钱是同一种东西
              // ——这张卡的两个余量，只是单位不同（token / ¥），所以字号与颜色一并跟上，别一个主色一个灰字。
              tfBar('bt' + i, '剩余 Token 池',
                pctToken,
                s.unlimitedTokens
                  ? tfBigVal('无限量', null)
                  : tfBigVal(
                    tfRemainTokens(s.basicTokenTotal, s.basicTokenUsed),
                    '/ ' + tfTokensOf(s.basicTokenTotal)),
                '剩余 / 总额。平台给 basic_token_total 与 basic_token_used（原始 token 数，不是 quota），剩余 = 总量 − 已用'),
              // 页脚只剩「下次重置」与「已绑密钥」：生效/到期已上移到期限行，不再在这里重复。
              // 两样都没有时整行不出，免得留一条空白。
              // 页脚这一行兼顾两件事：左组是事实（下次重置 / 已绑密钥），右端挂「升级套餐」——
              // 这一份订阅自己的升级入口（与「兑换码」入口同一个两端对齐配方）。生效中的每一份
              // 订阅都有这一行（用户定稿：升级按钮放在每个套餐里面），哪一份都能就地升级。
              // 左组即使两样都没有也保留空节点：space-between 下只有按钮一个孩子时它会被顶到左边。
              (s.nextResetTimeMs || s.hasKey === true || isActive)
                ? React.createElement('div', { className: 'dsh-mb-hero-legend' },
                  React.createElement('span', { className: 'dsh-mb-legend-bits' },
                    s.nextResetTimeMs ? React.createElement('span', null, '下次重置 ' + tfMomentOf(s.nextResetTimeMs)) : null,
                    s.hasKey === true ? React.createElement('span', null, '已绑密钥') : null),
                  isActive && tfCanUpgrade(s.subNo)
                    ? React.createElement('button', {
                      className: 'dsh-mb-hero-btn',
                      title: '只升这一份订阅（订阅号 ' + s.subNo + '）：平台按这条订阅现算差价，只列比它更高的档',
                      onClick: () => openTfPlans(s.subNo),
                    }, '升级套餐')
                    : null)
                : null,
              s.fromPlanTitle ? React.createElement('div', { className: 'dsh-mb-hint' }, '由「' + s.fromPlanTitle + '」升级而来') : null,
            ))
          })
        }
        if (subData.stale === true) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'stale' },
            '平台暂时查不通，下面显示的是上次成功的数据' + (subData.cachedAt ? '（' + fmtClock(subData.cachedAt) + '）' : '') + '。'))
        }
      }
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- OpenCSG「账户」页签 ----
    // 骨架与清枢「账户」页签**完全同一套**（用户定稿「账户的布局参考清疏」）：添加栏 + 表单 +
    // 一人一张卡，卡内是「顶行身份 + 一行 k/v/sub 格 + 脚行」。清枢那页没有 hero，这里也没有
    // （原先那块 hero 已按定稿整块删除，理由见下面那段）。
    // 卡面只讲**两件事**（用户定稿：账户余额 / 待发放余额，「不需要套餐」；
    // 「API 调用量（本期）」那一格已按用户定稿「账户 不要」整格撤下——账户卡只看钱，
    // 调用量与逐接口明细都在「用量」页签，一处数据一处看）：
    //   ① 账户余额     balanceCents ÷ 100（现金口径），次级行摊开「现金 + 赠金」
    //   ② 待发放余额   invite.pendingCreditCents（次级行：已邀请 N 人 · 累计 ¥x）
    // **套餐 / 订阅档位一概不取也不显示**：订阅状态口（subscriptions/status）整层退场，
    // 卡片上不再有「会员档位」这一格。
    // **代金券（voucherCents）按用户定稿不参与显示**：这一页回答的是「现金还剩多少」，
    // 代金券是另一本账，混进来会让人以为现金变多了。
    // **没有购买 / 升级**：OpenCSG 这边只读不买——既没有「购买订阅」按钮也没有升级弹窗，
    // 卡脚只留「数据时间 + 刷新」（清枢那套目录 / 差价 / 购买的 state 与弹窗一概没有）。
    // 不编数：拿不到的字段一律「—」（卡面降灰 + 名字行「未查询」角标），绝不写 0。
    // **当前显示的账号置顶**（用户 2026-10-18 要求）：账户页 / 用量页签 / API Key 页签说的都是
    // 这个账号，它的卡却按本机存的顺序漂在中间，七个账号时得往下翻才找得到。置顶只动这一张，
    // **其余保持原顺序**（不做按余额/按名字的二次排序——那会让人找不到自己存的那份顺序）。
    // 匹配按 identifier 的小写比法走（activeAccount 存的是登录原样，大小写可能不一致）。
    // 找不到（activeAccount 为空 / 拼写对不上）就原样返回——不猜、不重排。
    const ocPinActive = (list, activeId) => {
      const arr = Array.isArray(list) ? list : []
      const id = typeof activeId === 'string' ? activeId.trim() : ''
      if (id === '') return arr
      const ai = arr.findIndex((a) => String(a && a.identifier).toLowerCase() === id.toLowerCase())
      if (ai <= 0) return arr
      return arr.slice(ai, ai + 1).concat(arr.slice(0, ai), arr.slice(ai + 1))
    }
    function renderOcUserTab({ ocAccs, loadOcAccs, loadOcAccsDetail, ocDetailBusy, refreshOcAccount, useOcAccount, ocAccBusy, ocAccMsg, ocAcc, setOcAcc, ocAccPw, setOcAccPw, showOcPw, setShowOcPw, addOcAccount, removeOcAccount, ocConfirm, setOcConfirm, ocAddOpen, setOcAddOpen, ocPwShown, ocPwVal, revealOcPw }) {
      if (ocAccs === null) {
        return React.createElement('div', { className: 'dsh-mb-section' },
          React.createElement('div', { className: 'dsh-mb-skel-hero', key: 'sk1', role: 'status', 'aria-label': '加载中' }),
          React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'sk2' }))
      }
      if (ocAccs.error && !Array.isArray(ocAccs.accounts)) {
        return React.createElement('div', { className: 'dsh-mb-section' },
          React.createElement('div', { className: 'dsh-mb-notice err', key: 'e' },
            ocAccs.error,
            React.createElement('div', { style: { marginTop: '6px' } },
              React.createElement('button', { className: 'dsh-mb-link', onClick: loadOcAccs }, '重试'))))
      }
      const rows = []
      const activeId = typeof ocAccs.activeAccount === 'string' ? ocAccs.activeAccount : ''
      const accList = ocPinActive(Array.isArray(ocAccs.accounts) ? ocAccs.accounts : [], activeId)
      const accBusyMap = ocAccs.busy || {}
      // 头像首字：邮箱取 @ 前那段的首字符，中文用户名取首字；认不出就写平台名（不借清枢的「清」）
      const ocInitials = (str) => {
        const t = typeof str === 'string' ? str.trim() : ''
        if (t === '') return 'OC'
        const at = t.indexOf('@')
        const head = at > 0 ? t.slice(0, at) : t
        return head.slice(0, 1).toUpperCase()
      }
      // 金额（分 → ¥）：非有限数一律「—」，绝不渲染成 ¥0（「0 元」与「问不到」在账上是两件事）。
      const yuan = (c) => (typeof c === 'number' && Number.isFinite(c) ? '¥' + fmtCny(c / 100) : '—')
      // 一张卡的两个读数（「用量」页签另有整窗口口径，见 renderOcUsageTab——两处判据不能各算各的）：
      //   ① 账户余额 = balanceCents（现金口径）；次级行摊开构成「现金 + 赠金」
      //      —— 实测两个分量之和等于总额（9898.31 = 1.44 + 9896.87），摊开是为了说明「这笔钱
      //      里多少是真金白银」；两者缺一就不出次级行（单边出数会让人以为总额只有那一半）
      //   ② 待发放余额 = 邀请口 pendingCreditCents；次级行给「已邀请 N 人 · 累计 ¥x」
      //   缺失一律「—」；0 是**有效读数**，照实显示 0（用户定稿：不许拿 0 冒充缺失）。
      const readCard = (a) => {
        const snap = a && a.account && typeof a.account === 'object' ? a.account : null
        const inv = snap && snap.invite && typeof snap.invite === 'object' ? snap.invite : null
        const hasComp = snap !== null
          && typeof snap.cashCents === 'number' && Number.isFinite(snap.cashCents)
          && typeof snap.bonusCents === 'number' && Number.isFinite(snap.bonusCents)
        const pendBits = []
        if (inv !== null && typeof inv.invites === 'number' && Number.isFinite(inv.invites)) {
          pendBits.push('已邀请 ' + fmtTokens(inv.invites) + ' 人')
        }
        if (inv !== null && typeof inv.totalCreditCents === 'number' && Number.isFinite(inv.totalCreditCents)) {
          pendBits.push('累计 ' + yuan(inv.totalCreditCents))
        }
        return {
          snap,
          balTxt: snap ? yuan(snap.balanceCents) : '—',
          balSub: hasComp ? '现金 ' + yuan(snap.cashCents) + ' + 赠金 ' + yuan(snap.bonusCents) : null,
          pendTxt: inv ? yuan(inv.pendingCreditCents) : '—',
          pendSub: pendBits.length === 0 ? null : pendBits.join(' · '),
        }
      }
      if (accList.length === 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'none' },
          '还没有 OpenCSG 账号：用下面「添加账号」里的手机号 / 邮箱 + 密码登录一次即可（添加时会先向平台真登一次校验，密码只存本机，随时可看可删）。'))
      }
      // 这里原先有一整块 hero（当前账号 + 现金余额 / 会员档位 / 用量三条横条），按用户定稿
      // 「账户的布局参考清疏」整块删除：清枢的账户页**没有 hero**，就是「添加栏 + 一人一张卡」，
      // 三件事由那张卡自己说完。同一份数在 hero 与卡上各说一遍正是清枢明确定为反面的做法
      // （见 renderTfUserTab 里「同一份数说两处」那段注释），何况 hero 的两个标量
      // （当前显示账号 / 账号数）在下面添加栏的「共 N 个账号（当前显示 X）」里本来就有。
      if (ocAccs.error && accList.length > 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'aerr' },
          '账号清单刷新失败：' + ocAccs.error))
      }
      // ---- 添加栏 + 添加表单 + 账号卡（与清枢账户页同一套骨架）----
      const addOpen = accList.length === 0 ? true : ocAddOpen
      rows.push(React.createElement('div', { className: 'dsh-mb-stepacc-addbar', key: 'ab' },
        React.createElement('button', {
          className: 'dsh-mb-btn small ghost',
          disabled: ocAccBusy,
          title: addOpen ? '收起添加表单' : '添加一个 OpenCSG 账号（手机号/邮箱 + 密码）',
          onClick: () => setOcAddOpen(!addOpen),
        }, addOpen ? '收起添加' : '＋ 添加账号'),
        accList.length > 0
          ? React.createElement('span', { className: 'dsh-mb-hint', key: 'n' },
            '共 ' + accList.length + ' 个账号' + (activeId !== '' ? '（当前显示 ' + activeId + '）' : ''))
          : null,
        React.createElement('span', { className: 'sp', key: 'sp' }),
        // 主操作独立放右侧：查询要逐个真打平台（缺会话的先登录），是这一页最重的动作，
        // 不和「添加账号」这种低频操作并列混在一起（与清枢 / 阶跃同一条排法）。
        React.createElement('button', {
          className: 'dsh-mb-btn small',
          disabled: ocDetailBusy || accList.length === 0,
          title: '查询全部账号的余额与用量（真发请求；会话失效的账号会先按存的密码重登一次）',
          onClick: loadOcAccsDetail,
        }, ocDetailBusy ? '查询中…' : '查询全部')))
      if (addOpen) {
        rows.push(React.createElement('div', { className: 'dsh-mb-acc-form', key: 'form' },
          React.createElement('input', {
            className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
            type: 'text', autoComplete: 'off', maxLength: 96,
            placeholder: '手机号 / 邮箱', value: ocAcc,
            onChange: (e) => setOcAcc(e.target.value),
          }),
          React.createElement('div', { className: 'dsh-mb-pw-wrap' },
            React.createElement('input', {
              className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
              type: showOcPw ? 'text' : 'password', autoComplete: 'off',
              placeholder: '密码', value: ocAccPw,
              onChange: (e) => setOcAccPw(e.target.value),
            }),
            React.createElement('button', {
              className: 'dsh-mb-pw-eye', title: showOcPw ? '隐藏密码' : '显示密码',
              onClick: () => setShowOcPw(!showOcPw),
            }, EyeIcon({ off: showOcPw })),
          ),
          React.createElement('button', {
            className: 'dsh-mb-btn small',
            disabled: ocAccBusy || ocAcc.trim() === '' || ocAccPw === '',
            title: '添加时会先向平台登录校验一次；账号密码不对就不会保存',
            onClick: addOcAccount,
          }, ocAccBusy ? '校验中…' : '添加'),
        ))
      }
      if (ocAccMsg) {
        rows.push(React.createElement('div', { className: 'dsh-mb-cookie-msg' + (ocAccMsg.ok ? '' : ' err'), key: 'msg' }, ocAccMsg.text))
      }
      accList.forEach((a) => {
        const id = String(a.identifier)
        const rd = readCard(a)
        const snap = rd.snap
        const isCur = id.toLowerCase() === activeId.toLowerCase()
        const confirming = ocConfirm === id
        const b = accBusyMap[id] === true
        const showing = ocPwShown === id
        // 这张卡查没查过：账号清单只回已缓存的快照，没查过的账号是 null——卡面走 .dim
        // （虚线框 + 透明底 + 数值降灰）、名字行挂「未查询」角标（与清枢 / 阶跃一致）。
        const queried = snap !== null
        // 显示名 = 平台用户名（那是「这个人的名字」）；没查到就退回登录身份本身（唯一已知的名字，
        // 不编「—」）。登录身份（当初填的手机号 / 邮箱）**不丢**，另起一枚灰字挂在右侧——登录要用它。
        const uname = snap && typeof snap.username === 'string' ? snap.username : ''
        const dispName = uname !== '' ? uname : id
        const showIdChip = uname !== '' && uname.toLowerCase() !== id.toLowerCase()
        const cells = []
        cells.push(React.createElement('div', { className: 'dsh-mb-stepacc-top', key: 'top' },
          React.createElement('span', { className: 'dsh-mb-stepacc-ava', 'aria-hidden': 'true' }, ocInitials(dispName)),
          React.createElement('div', { className: 'dsh-mb-stepacc-name', key: 'id', style: { flex: 1, minWidth: 0 } },
            React.createElement('span', {
              className: 'dsh-mb-stepacc-nick',
              style: { minWidth: 0 },
              title: uname !== '' ? 'OpenCSG 用户名' : '登录身份',
            }, dispName),
            queried ? null : React.createElement('span', {
              className: 'dsh-mb-stepacc-unq',
              title: '这个账号还没查过——点右上角「查询全部」，或卡片脚行的「查询此账号」',
            }, '未查询'),
          ),
          React.createElement('div', { className: 'dsh-mb-stepacc-tail', key: 'tail' },
            showIdChip
              ? React.createElement('span', {
                className: 'dsh-mb-stepacc-idsec', key: 'idsec', title: '登录身份（当初用它登的）',
              }, id)
              : null,
            // 密码胶囊：只在本机读、单取路由，点一下才显明文（同一时刻只展开一个）
            React.createElement('span', { className: 'dsh-mb-stepacc-idsec', key: 'pw' },
              React.createElement('button', {
                className: 'dsh-mb-stepacc-pw' + (showing ? ' on' : ''),
                title: showing ? '隐藏密码' : '显示密码（只在本机读取，不经过网络）',
                onClick: () => revealOcPw(id),
              },
                React.createElement('span', null, showing ? (ocPwVal || '（空）') : (a.pwMask || '••••••')),
                EyeIcon({ off: showing }),
              ),
            ),
            isCur
              ? React.createElement('span', {
                className: 'dsh-mb-stepacc-cur', key: 'cur',
                title: '侧栏胶囊与面板显示这个账号的数据',
              }, '当前显示')
              : React.createElement('button', {
                className: 'dsh-mb-btn small',
                title: '让侧栏胶囊与面板显示这个账号的数据',
                onClick: () => useOcAccount(id),
              }, '显示'),
            React.createElement('button', {
              className: 'dsh-mb-stepacc-x' + (confirming ? ' armed' : ''),
              disabled: ocAccBusy,
              title: confirming ? '再点一次确认删除（连本地会话一起丢）' : '删除该账号（连本地会话一起丢）',
              onClick: () => removeOcAccount(id),
            }, confirming ? '确认删除' : '删除'),
          ),
        ))
        // 这一张卡要说的事就**两件**：**账户余额 / 待发放余额**（用户定稿「不需要套餐」，
        // 且「API 调用量（本期）」整格已撤到「用量」页签——钱与调用各归各页，同一个数不在
        // 两页各说一遍）。布局照清枢账户卡那张「k / v / sub」一行两格（用户定稿「账户的布局
        // 参考清疏」）：'.dsh-mb-stepacc-kv > div' 都是 flex:1，**零新增 CSS**。
        //   左：账户余额（现金总额），次级行摊开「现金 + 赠金」
        //   右：待发放余额（邀请口），次级行给「已邀请 N 人 · 累计 ¥x」
        // 两个数都可能拿不到 → 「—」（缺失 ≠ 0）；没查过的账号整格走 .dim（数值降灰）。
        const dim = queried ? '' : ' dim'
        // 两格布局（账户余额 / 待发放余额）：就是清枢账户卡那套「k / v / sub」一行两格，
        // 不再单开 .oc3 三格版——「API 调用量（本期）」整格已按用户定稿撤到「用量」页签。
        cells.push(React.createElement('div', { className: 'dsh-mb-stepacc-kv', key: 'kv' },
          React.createElement('div', { className: dim },
            React.createElement('span', { className: 'k' }, '账户余额'),
            React.createElement('span', {
              className: 'v',
              title: '平台返回的现金余额（balanceCents，单位分 → ¥）；代金券不计入这一格',
            }, rd.balTxt),
            rd.balSub === null ? null : React.createElement('span', { className: 'sub' }, rd.balSub)),
          React.createElement('div', { className: dim },
            React.createElement('span', { className: 'k' }, '待发放余额'),
            React.createElement('span', {
              className: 'v',
              title: '邀请口（GET /api/v1/invitations）的 pending_credit：已经邀请成功、还没发到账的那部分',
            }, rd.pendTxt),
            rd.pendSub === null ? null : React.createElement('span', { className: 'sub' }, rd.pendSub)),
        ))
        // 脚行（清枢同款）：没查过时左边给「查询此账号」，右侧常驻「数据时间 + 刷新」。
        // 数据时间取这张卡快照的取数时刻——没有它，缓存里的旧数看着就像新数。
        const foot = []
        if (!queried) {
          foot.push(React.createElement('button', {
            className: 'dsh-mb-btn small ghost', key: 'q',
            disabled: b, onClick: () => refreshOcAccount(id),
          }, b ? '查询中…' : '查询此账号'))
        }
        foot.push(React.createElement('span', { className: 'sp', key: 'sp' }))
        // 「数据时间」常驻（用户定稿「一直显示」）：原先只有查过才出现，于是「没查过」在界面上
        // 就是一片空白，看着像坏了。没查过照实写「—」，取值时刻仍然只说取到数那一刻（本机时间）。
        foot.push(React.createElement('span', {
          className: 'dsh-mb-stepacc-meta', key: 'at',
          title: typeof a.at === 'number' && a.at > 0
            ? '这份数据的取数时刻（本机时间；平台不返这个数，是宿主取到数那一刻打的戳）'
            : '还没查过：点「查询此账号」或上方「查询全部」才会向平台取一次数',
        }, typeof a.at === 'number' && a.at > 0 ? '数据时间 ' + fmtCheckedAt(a.at) : '数据时间 —'))
        foot.push(React.createElement('button', {
          className: 'dsh-mb-btn small ghost', key: 'rf',
          disabled: b, onClick: () => refreshOcAccount(id),
        }, b ? '…' : '刷新'))
        cells.push(React.createElement('div', { className: 'dsh-mb-stepacc-foot', key: 'ft' }, foot))
        if (a.error) {
          cells.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'err', style: { color: 'var(--mb-warnTx)' } }, '上次查询失败：' + a.error))
        }
        rows.push(React.createElement('div', {
          key: 'a-' + id,
          className: 'dsh-mb-stepacc' + (isCur ? ' cur' : '') + (queried ? '' : ' dim'),
        }, cells))
      })
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- OpenCSG「用量」页签 ----
    // 版式照基元「用量」页那套骨架：**汇总 hero（主值 + 右上并排副值 + 指标格）→ 按维度拆分
    // （rank 行：名称 / 份额条 / 量 / 次数）**。数据来自**账单口**
    // `GET /accounting/credit/{uuid}/bills?scene=15&…`——门户「设置 → 计费」里那个「API 调用量」
    // 页签用的就是这条口（场景号 15 = LLM 调用）。两页对应关系与差异各有出处：
    //   · 主值 = 本期总 Tokens（信封 `total_consumption`，2026-10-17 实测逐行 = 输入 + 输出）；
    //     花费在指标格里（`total_value`）并逐接口摆出来（用户 2026-10-18：「按接口怎么没花费」
    //     ——这条改了原先「用量页不出现 ¥」的定稿，钱与量在同一页对照看，账户卡那边仍只有余额）。
    //     平台把扣费记成**负数**，界面按门户同款取绝对值显示，原值写在悬浮里（不改账）。
    //   · 右上副值 = 调用次数（`total_count`，实测 = 各行 `count` 之和）/ 总 Tokens（`total_consumption`）。
    //   · 指标格 = 输入/输出 · 推理 · 缓存命中 · 窗口。「计费记录」格与整段页脚口径说明按用户
    //     2026-10-18 要求删掉了（口径都搬进各行悬浮；表头也不再带「前 N / 共 M · 按X排」，
    //     只在列表真被截短时才补一句）。
    //   · 指标格 = 输入·输出 / 推理 / 缓存（+ 命中率）/ 窗口：都是服务端按**整个窗口**算好的
    //     `total_*`，与分页无关；命中率 = 缓存 ÷ 输入（与基元那格同一算法）。
    //   · 拆分维度只有「按接口」：账单行给的就是接口维度（`instance_name`），没有客户端维度，
    //     所以不并排两栏，整行一张表。同名接口的多行由宿主先聚合（`api.apis`）再交上来。
    //   · **热力日历不做**：账单口没有「按天的口」——但它认**单日窗口**（见下条），要铺日历就得
    //     按天打 30 次请求；而**行**里的 `created_at` 只是记录生成时刻（实测同一接口在月窗口里
    //     只出一行，多行的 created_at 还会落在不同的日子里），拿它铺日历就是编。
    //   · **今日（v0.7.3）= 另一次账单口请求**：窗口 = 今天 → 今天、只取首页（host 的 ⑤）。
    //     服务端真的按 `start_date`/`end_date` 过滤——2026-10-19 实网对账：月窗口 798 次调用 /
    //     93,458,176 token，今日 24 / 1,654,251，昨日 552 / 70,735,547，宽窗口（2020–2030）与
    //     月窗口逐位相同；再把 10-16 ~ 10-19 逐天问一遍，四天合计与月窗口信封**逐位相符**。
    //     所以「今日」与「本月至今」是同一把尺子算出来的两段，而不是从月窗口的行里切出来的。
    //   · 调用次数、耗时这些字段早期「没有证据」，2026-10-17 直接读回包把 `count` /
    //     `total_count` / `consumption` 三项对账坐实了（行合计 === 信封合计），故这一版敢显示。
    //     （更早那版拿管理员专属的 token-report 当数据源，实测 403 AUTH-ERR-6，已整层删除。）
    const OC_USAGE_RANK_MAX = 12
    function renderOcUsageTab({ ocUsage, ocAccs, loadOcUsage }) {
      const rows = []
      const d = ocUsage && ocUsage.data && typeof ocUsage.data === 'object' ? ocUsage.data : null
      const activeId = ocAccs && typeof ocAccs.activeAccount === 'string' ? ocAccs.activeAccount : ''
      const api = d && d.api && typeof d.api === 'object' ? d.api : null
      const isN = (v) => typeof v === 'number' && Number.isFinite(v)
      const tok = (v) => (isN(v) ? fmtTokens(v) : '—')
      const winFull = api && typeof api.fromDate === 'string' && api.fromDate !== ''
        && typeof api.toDate === 'string' && api.toDate !== '' ? api.fromDate + ' ~ ' + api.toDate : ''
      const win = api && typeof api.fromDate === 'string' && typeof api.toDate === 'string'
        ? fmtDayRange(api.fromDate, api.toDate) : ''
      // 花费：平台把扣费记成**负数**（实测 value / total_value 都是负的），「花费」这个词
      // 本身是正的数额，门户那行合计也逐字取 Math.abs——所以这里按绝对值显示，并在悬浮里
      // 写明白原值是负的扣费，不悄悄改账。缺失一律「—」（不当 0）。
      const yuan = (c) => (typeof c === 'number' && Number.isFinite(c) ? '¥' + fmtCny(Math.abs(c) / 100) : '—')
      // 页首只留「用量 · 账号」：窗口原先挤在标题括号里（三层括号 + 账号 = 这一页最乱的一行），
      // 现在它作为一格摆在指标里，要对照窗口时才看它。
      rows.push(pageTopBar({
        left: React.createElement('div', { className: 'dsh-mb-day-title' },
          '用量（API 调用量）' + (activeId === '' ? '' : '：' + activeId)),
        at: d && d.atMs ? fmtClock(d.atMs) : null,
        onRefresh: () => loadOcUsage(true),
      }))
      // 骨架与「账户」页签同款（hero 一块 + 下面几条）：首次进入（还没发过请求）与「请求在途
      // 且手上还没有数」都走这里——后者原先直接空着，看着像这一页没做。
      if (ocUsage === null || (ocUsage.loading === true && !d)) {
        return React.createElement('div', { className: 'dsh-mb-section' }, rows.concat([
          React.createElement('div', {
            className: 'dsh-mb-skel-hero', key: 'sk1', role: 'status', 'aria-label': '加载中',
          }),
          React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'sk2' }),
        ]))
      }
      if (ocUsage.error && !d) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'e' },
          ocUsage.error,
          React.createElement('div', { style: { marginTop: '6px' } },
            React.createElement('button', { className: 'dsh-mb-link', onClick: () => loadOcUsage(true) }, '重试'))))
        return React.createElement('div', { className: 'dsh-mb-section' }, rows)
      }
      // 「有旧快照 + 这一次刷新失败」：继续渲染旧数，但把失败原因挂在顶上（不悄悄当没事发生）
      if (ocUsage.error && d) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'estale' },
          '本次刷新失败，下面是上次的数：' + ocUsage.error))
      }
      if (d) {
        const agg = api && api.apis && Array.isArray(api.apis.apis) ? api.apis.apis : []
        const raw = api && Array.isArray(api.rows) ? api.rows : []
        const total = api && isN(api.apiCount) ? api.apiCount : null
        const fetched = api && isN(api.fetchedRows) ? api.fetchedRows : 0
        const partial = api && api.partial === true
        const cacheRate = api && isN(api.totalTokensIn) && api.totalTokensIn > 0
          && isN(api.totalTokensCached) && api.totalTokensCached > 0
          ? api.totalTokensCached / api.totalTokensIn : null
        const cntStr = (v, unit) => (isN(v) ? fmtTokens(v) + (unit || '') : '—')
        // ---- 汇总 hero（与基元用量页同款 hero / hero-stats / hero-pair / kv-grid）----
        // 主位给钱（基元那张卡的最大字号位就是「近 30 天总花费」）：用户要的就是「花了多少」，
        // 原先主位摆的是总 Tokens、钱没地方站，所以钱上主位、总 Tokens 退到右上副值。
        // 「计费记录」格按用户要求删掉了（整页不再出现这一读数；行数只在截短/翻页提示里说）。
        rows.push(React.createElement('div', { className: 'dsh-mb-hero', key: 'hero' },
          React.createElement('div', { className: 'dsh-mb-hero-stats' },
            React.createElement('div', { className: 'dsh-mb-stat' },
              React.createElement('span', { className: 'dsh-mb-stat-k' }, '本期花费'),
              React.createElement('span', {
                className: 'dsh-mb-stat-v',
                title: '账单口信封的 total_value：服务端按整个窗口算好的费用合计（单位是分）。'
                  + '平台把扣费记成负数，这里按门户同款口径取绝对值显示'
                  + (api && isN(api.valueCents) ? '（原值 ' + (api.valueCents / 100) + ' 元）' : ''),
              }, yuan(api ? api.valueCents : null))),
            React.createElement('div', { className: 'dsh-mb-hero-pair' },
              React.createElement('div', { className: 'dsh-mb-stat right' },
                React.createElement('span', { className: 'dsh-mb-stat-k' }, '调用'),
                React.createElement('span', {
                  className: 'dsh-mb-stat-v',
                  title: '账单口信封的 total_count：窗口内调用次数（实测 = 各行 count 之和）',
                }, cntStr(api ? api.totalCalls : null, ' 次'))),
              React.createElement('div', { className: 'dsh-mb-stat right' },
                React.createElement('span', { className: 'dsh-mb-stat-k' }, '总 Tokens'),
                React.createElement('span', {
                  className: 'dsh-mb-stat-v',
                  title: '账单口信封的 total_consumption：服务端按整个窗口算好的 token 合计（实测逐行 = 输入 + 输出）',
                }, tok(api ? api.totalConsumption : null))))),
          React.createElement('div', { className: 'dsh-mb-kv-grid' },
            React.createElement('div', {
              className: 'dsh-mb-kv', key: 'io',
              title: 'total_prompt_token / total_completion_token：服务端按整个窗口算好的输入与输出合计（不是本页各行相加）',
            },
              React.createElement('span', { className: 'dsh-mb-kv-k' }, '输入 / 输出'),
              React.createElement('span', { className: 'dsh-mb-kv-v' },
                tok(api ? api.totalTokensIn : null) + ' / ' + tok(api ? api.totalTokensOut : null))),
            React.createElement('div', {
              className: 'dsh-mb-kv', key: 'rs',
              title: 'total_reasoning_token：推理 token 合计（平台单独给的第四路，与输出口径独立）',
            },
              React.createElement('span', { className: 'dsh-mb-kv-k' }, '推理'),
              React.createElement('span', { className: 'dsh-mb-kv-v' }, tok(api ? api.totalTokensReasoning : null))),
            React.createElement('div', {
              className: 'dsh-mb-kv', key: 'cc',
              title: 'total_prompt_cached_token ÷ total_prompt_token：输入里有多少是缓存命中（与基元用量页同一算法）',
            },
              React.createElement('span', { className: 'dsh-mb-kv-k' }, '缓存命中'),
              React.createElement('span', { className: 'dsh-mb-kv-v' },
                tok(api ? api.totalTokensCached : null)
                + (cacheRate === null ? '' : '（' + (cacheRate * 100).toFixed(1) + '%）'))),
            React.createElement('div', {
              className: 'dsh-mb-kv', key: 'win',
              title: '窗口 = 本月 1 号 → 今天（门户计费区间的初值，走本机时区）'
                + (winFull === '' ? '' : '：' + winFull),
            },
              React.createElement('span', { className: 'dsh-mb-kv-k' }, '窗口（本月至今）'),
              React.createElement('span', { className: 'dsh-mb-kv-v' }, win === '' ? '—' : win)))))
        // ---- 今日（v0.7.3）----
        // 数据来自 host 的**另一次账单口请求**（窗口 = 今天 → 今天，实测见协议层 ocDayWindow）：
        // 行的 `created_at` 是记录生成时刻，切不出「今天」（同一接口在月窗口里只出一行，多行的
        // created_at 还会落在不同日子），所以今日只能问服务端，问出来的窗口合计与月窗口同一把尺子。
        // 版式：日标题 + 复用既有 `.dsh-mb-kv-grid`（auto-fit 自己折行），只给四个读数——
        // 花费 / 调用 / Tokens / 缓存命中；输入·输出·推理写进 Tokens 那格的悬浮（今日要的是
        // 「今天怎么样」，摆满七格就与上面那排逐字重复了）。**不做今日的逐接口拆分**：那张
        // 「按接口」是本期口径，两种窗口混进一张表里，读者分不清条与数是哪一段的。
        // 今日取不到（ok:false）时四格一律「—」并明说一句——今日是**有意义的 0**（今天没调用
        // 平台就回 0），拿 0 顶替「没答上来」就正好错在这一格上。
        const t = d.today && typeof d.today === 'object' ? d.today : null
        if (t !== null) {
          const tOk = t.ok === true
          // 「今日（10-19）」：单日窗口不摆「10-19 ~ 10-19」这种同值重复的区间写法
          const dayShort = typeof t.fromDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.fromDate)
            ? t.fromDate.slice(5) : ''
          const tRate = isN(t.totalTokensIn) && t.totalTokensIn > 0 && isN(t.totalTokensCached)
            ? t.totalTokensCached / t.totalTokensIn : null
          const tWinFull = typeof t.fromDate === 'string' && typeof t.toDate === 'string'
            ? t.fromDate + ' ~ ' + t.toDate : '今天'
          rows.push(React.createElement('div', { className: 'dsh-mb-day-title', key: 'tday' },
            '今日' + (dayShort === '' ? '' : '（' + dayShort + '）')))
          rows.push(React.createElement('div', { className: 'dsh-mb-kv-grid dsh-mb-ocday', key: 'today' },
            React.createElement('div', {
              className: 'dsh-mb-kv', title: '今日花费 = 账单口信封的 total_value（窗口 ' + tWinFull
                + '，服务端按该窗口算好的费用合计，单位是分）。平台把扣费记成负数，这里按门户同款口径取绝对值'
                + (isN(t.valueCents) ? '（原值 ' + (t.valueCents / 100) + ' 元）' : ''),
            },
              React.createElement('span', { className: 'dsh-mb-kv-k' }, '花费'),
              React.createElement('span', { className: 'dsh-mb-kv-v' }, tOk ? yuan(t.valueCents) : '—')),
            React.createElement('div', {
              className: 'dsh-mb-kv', title: '今日调用次数 = 账单口信封的 total_count（窗口 ' + tWinFull
                + '；本机日历日，与「窗口（本月至今）」同一把尺子，不是拿月窗口的行切出来的）',
            },
              React.createElement('span', { className: 'dsh-mb-kv-k' }, '调用'),
              React.createElement('span', { className: 'dsh-mb-kv-v' }, tOk ? cntStr(t.totalCalls, ' 次') : '—')),
            React.createElement('div', {
              className: 'dsh-mb-kv',
              title: '今日 token 合计 = 账单口信封的 total_consumption（= 输入 + 输出，服务端按该窗口算的）'
                + (tOk ? '；输入 ' + tok(t.totalTokensIn) + ' / 输出 ' + tok(t.totalTokensOut)
                  + ' / 推理 ' + tok(t.totalTokensReasoning) : ''),
            },
              React.createElement('span', { className: 'dsh-mb-kv-k' }, 'Tokens'),
              React.createElement('span', { className: 'dsh-mb-kv-v' }, tOk ? tok(t.totalConsumption) : '—')),
            React.createElement('div', {
              className: 'dsh-mb-kv',
              title: '今日缓存命中 = total_prompt_cached_token（括号里是 ÷ 今日 total_prompt_token，'
                + '与本月那格、基元用量页同一算法）',
            },
              React.createElement('span', { className: 'dsh-mb-kv-k' }, '缓存命中'),
              React.createElement('span', { className: 'dsh-mb-kv-v' },
                (tOk ? tok(t.totalTokensCached) : '—')
                + (tOk && tRate !== null ? '（' + (tRate * 100).toFixed(1) + '%）' : '')))))
          if (!tOk) {
            rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'terr' },
              '今日用量这一口本次没取到（其余读数照常）——点右上角「刷新」再试一次。'
              + '四个「—」是「没问到」，不是「今天没用量」。'))
          }
        }
        // ---- 按接口（rank 表：名称 / 进度条 / 花费 / token；调用次数在悬浮里）----
        if (agg.length > 0) {
          const shown = agg.slice(0, OC_USAGE_RANK_MAX)
          // 排序键与进度条同一个口径（宿主在聚合时就定好了：有花费按花费、整表没有花费
          // 读数才退回按 token）。**两者必须一致**——条按 token 画、数字按花费排，读者会
          // 以为条画的是钱。花费是负数（扣费），取绝对值比大小。
          const rankBy = api && api.apis && api.apis.rankBy === 'consumption' ? 'consumption' : 'cost'
          const keyOf = (g) => (rankBy === 'cost'
            ? (isN(g.costCents) ? Math.abs(g.costCents) : 0)
            : (isN(g.consumption) ? g.consumption : 0))
          const mx = Math.max.apply(null, shown.map(keyOf).concat([1]))
          rows.push(React.createElement('div', { className: 'dsh-mb-trend-wrap col dsh-mb-ocuse', key: 'byapi' },
            React.createElement('div', { className: 'dsh-mb-day-title' }, '按接口'),
            shown.map((g, i) => React.createElement('div', {
              className: 'dsh-mb-rank', key: 'a' + i,
              title: g.apiId
                + '：花费 ' + (isN(g.costCents) ? '¥' + fmtCny(Math.abs(g.costCents) / 100) : '—')
                // 原值只在真有数时附出来（平台把扣费记成负数，绝对值才是「花了多少」）
                + (isN(g.costCents) ? '（平台原值 ' + (g.costCents / 100) + ' 元，扣费记负）' : '')
                + ' · token ' + tok(g.consumption)
                + ' · 调用 ' + (isN(g.calls) ? fmtTokens(g.calls) + ' 次' : '—')
                + ' · 输入 ' + tok(g.tokensIn) + ' / 输出 ' + tok(g.tokensOut)
                + ' / 推理 ' + tok(g.tokensReasoning) + ' / 缓存 ' + tok(g.tokensCached)
                + (g.records > 1 ? ' · 由 ' + g.records + ' 条计费记录合并' : ''),
            },
              React.createElement('span', { className: 'dsh-mb-rank-k' }, g.apiId),
              React.createElement('span', { className: 'dsh-mb-rank-bar' },
                React.createElement('i', { style: { width: Math.max(3, Math.round((keyOf(g) / mx) * 100)) + '%' } })),
              React.createElement('span', {
                className: 'dsh-mb-rank-m',
                title: '本接口花费（账单行 value 合计，单位是分；扣费记负，这里显示绝对值）',
              }, yuan(g.costCents)),
              React.createElement('span', { className: 'dsh-mb-rank-v', title: '本接口 token 合计（平台 consumption = 输入 + 输出）· 调用 ' + (isN(g.calls) ? fmtTokens(g.calls) + ' 次' : '—') }, tok(g.consumption)))))
          )
          // 只有列表真被截短时才说明——不截断时什么都不加（用户要求删掉表头那串计数）
          if (shown.length < agg.length) {
            rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'trunc' },
              '共 ' + agg.length + ' 个接口，只列出前 ' + shown.length + ' 个。'))
          }
        } else if (raw.length > 0) {
          // 有行却没有聚合结果 = 取数结构不认识：照实说是结构问题，不伪装成「本期没有调用」
          rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'shape' },
            '账单取的到 ' + raw.length + ' 行，但按接口聚合没结果（结构不认识）；这一页暂不显示拆分。'))
        } else {
          rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'nb' },
            '本期（' + (win === '' ? '窗口未知' : win) + '）没有计费记录——平台只在有调用时给行，'
            + '这不代表余额或配额是 0（余额看「账户」页）。'))
        }
        // **交叉校验（基元用量页同款做法）**：窗口花费是服务端 `total_value`，逐接口花费是
        // 账单行 `value` 合计——取全量时两者本该一致（2026-10-18 实网对账：|−458.532334| ===
        // Σ|行 value| 458.532334，逐位相符）。对不上就是**平台的数自己不一致**或我们少拿了行，
        // 界面必须说出来并以窗口合计为准，不悄悄挑一个好看的。差 1 分以内视为浮点/舍入噪声。
        const costSum = api && api.apis && isN(api.apis.sumCostAbsCents) ? api.apis.sumCostAbsCents : null
        const costWin = api && isN(api.valueCents) ? Math.abs(api.valueCents) : null
        const costDrift = !partial && costSum !== null && costWin !== null && Math.abs(costSum - costWin) > 1
        if (costDrift) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'drift' },
            '交叉校验：逐接口花费合计 ¥' + fmtCny(costSum / 100) + ' 与窗口花费 ¥' + fmtCny(costWin / 100)
            + ' 对不上（差 ¥' + fmtCny(Math.abs(costSum - costWin) / 100) + '）。上面以窗口合计为准。'))
        }
        // 翻页上限：取不全必须说出来，不能拿部分行冒充整窗口的份额
        if (partial) {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'partial' },
            '窗口内共 ' + (total === null ? '未知条数' : fmtTokens(total) + ' 条') + '计费记录，本页取回 ' + fetched
            + ' 条（平台翻页上限）；上面那张表按已取回的行算，份额不是整窗口份额。'))
        }
      } else {
        // 既没有数也没有错（理论上不会出现：加载器两个分支必居其一）——给一句话，不留白页
        rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'empty' },
          '还没有取到用量数据——点右上角「刷新」再试一次。'))
      }
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }

    // ---- OpenCSG「API Key」页签（门户 /settings/api-keys 同款能力，2026-10-17 实测坐实）----
    // 三件事：列表 / 创建 / 删除。与阶跃「密钥」页签同一套状态机与视觉（.dsh-mb-key-*），
    // 差异各有出处：
    //   · 名称上限 **128**（门户校验函数逐字；阶跃是 20，平台的口径不同别混）；
    //   · 有效期**三选一**（长期 / 30 天 / 90 天）——门户的 2099 常量与 add(N,'day').endOf('day')
    //     在协议层复刻（ocApiKeyExpireIso）；「自定义日期」不做（门户有，但卡片用不上）；
    //   · 列表只回**服务端掩码**（实测 `gk***36`）：平台没有「按 id 单取完整值」的口，门户
    //     也没有「历史密钥复制明文」的功能。**本机留存补上了这条路**（用户定稿 2026-10-17
    //     「新创建的密钥 存到本地」）：创建时落过本机的行带 hasLocal，「复制完整值」走
    //     /opencsg/apikey-reveal **零网络**单取（阶跃那枚是现场打一次 ListAccessKeys，两条
    //     路都不到任何服务器，但来历不同）；在官网创建的旧钥匙照旧只有掩码，那一格改写
    //     「仅创建时展示过一次」，不摆一个点了必然失败的按钮；
    //   · 明文只在创建响应里出现一次：一次性展示 + 自动复制 +「我已保存」即焚（三平台同款）；
    //   · 内置 key（token_type=builtin，平台按命名空间自动发的那把）**不可删**，也不显示删除钮；
    //   · 「内置 / 自建」两个标记是门户同款二分（typeBuiltin / typeCustom）。
    // 密钥属于「当前显示账号」：页首写明当前账号（与用量页同款页首），切换账号自动重拉。
    function renderOcKeysTab({ ocKeys, ocAccs, loadOcKeys, ocKeyName, setOcKeyName, ocKeyExpire, setOcKeyExpire, ocKeyBusy, ocKeyMsg, ocKeyCreated, setOcKeyCreated, ocKeyCopied, copyOcCreatedKey, ocKeyConfirm, createOcKey, deleteOcKey, revealOcKey, forgetOcKey, forgetOcKeyOrphans }) {
      const rows = []
      const activeId = ocAccs && typeof ocAccs.activeAccount === 'string' ? ocAccs.activeAccount : ''
      // 页首：当前显示账号 + 手动刷新（与用量页同款骨架）。刷新是真请求（列表口无缓存层）。
      rows.push(pageTopBar({
        left: React.createElement('div', { className: 'dsh-mb-day-title' },
          'API Key（AI Gateway）' + (activeId === '' ? '' : '：' + activeId)),
        at: null,
        onRefresh: () => loadOcKeys(activeId),
      }))
      // 创建表单：名称 + 有效期三选一。名称占位符把「平台要求」说清楚（≤128）。
      rows.push(React.createElement('div', { className: 'dsh-mb-key-create', key: 'create' },
        React.createElement('input', {
          className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
          type: 'text',
          maxLength: 128,
          autoComplete: 'off',
          placeholder: '密钥名称（不超过 128 字符）',
          value: ocKeyName,
          onChange: (e) => setOcKeyName(e.target.value),
        }),
        React.createElement('select', {
          className: 'dsh-mb-ck-int',
          value: ocKeyExpire,
          onChange: (e) => setOcKeyExpire(e.target.value),
          title: '有效期到期后这把密钥自动失效（30/90 天按当天 23:59 计算，门户同口径）',
        },
          React.createElement('option', { value: 'never' }, '长期有效'),
          React.createElement('option', { value: '30d' }, '30 天'),
          React.createElement('option', { value: '90d' }, '90 天')),
        React.createElement('button', {
          className: 'dsh-mb-btn',
          disabled: ocKeyBusy || ocKeyName.trim() === '',
          onClick: createOcKey,
        }, ocKeyBusy ? '创建中…' : '创建密钥'),
      ))
      // 一次性明文（创建响应里的唯一明文出处）
      if (ocKeyCreated) {
        rows.push(React.createElement('div', { className: 'dsh-mb-created', key: 'created' },
          React.createElement('div', { className: 'dsh-mb-created-title' },
            '「' + ocKeyCreated.name + '」已创建，' + (ocKeyCreated.savedLocal === false
              ? '完整密钥只显示这一次，请立即复制保存'
              : '完整密钥已存到本机（历史列表里也能复制）')),
          React.createElement('div', { className: 'dsh-mb-created-key' }, ocKeyCreated.key),
          React.createElement('div', { className: 'dsh-mb-btn-row' },
            React.createElement('button', { className: 'dsh-mb-btn', onClick: copyOcCreatedKey },
              ocKeyCopied === 'created' ? '已复制 ✓' : '复制密钥'),
            React.createElement('button', { className: 'dsh-mb-btn ghost', onClick: () => setOcKeyCreated(null) }, '我已保存'),
          ),
        ))
      }
      // 列表
      if (ocKeys === null || ocKeys.loading) {
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'ld', role: 'status', 'aria-label': '加载中' },
          [38, 62, 50].map((w, i) => React.createElement('div', { className: 'dsh-mb-skel', key: i, style: { width: w + '%' } })),
        ))
      } else if (ocKeys.error && (ocKeys.list || []).length === 0) {
        // 没有旧列表可保（首次加载就失败）：错误 + 重试
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'err' },
          '加载失败：' + ocKeys.error,
          React.createElement('div', { style: { marginTop: '6px' } },
            React.createElement('button', { className: 'dsh-mb-link', onClick: () => loadOcKeys(activeId) }, '重试'))))
      } else if ((ocKeys.list || []).length === 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'empty' }, '这个账号还没有密钥，填个名称创建一把'))
      } else {
        const day = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? fmtIsoDay(ms) : null)
        rows.push(React.createElement('div', { className: 'dsh-mb-keys-list', key: 'ls' },
          (ocKeys.list || []).map((k) => {
            // 有效期：Go 零值已归一成 null = 长期；有值按「到期日」显示（门户 colExpire 同义）
            const exp = day(k.expireMs)
            // 最近调用：行级 last_used_at 或 quotas[].last_used_at 取最大值（协议层已归一）
            const used = k.lastUsedMs !== null && k.lastUsedMs !== undefined ? fmtIsoDay(k.lastUsedMs) : null
            // 两个动作的可见性先算出来——动作行本身也要能整体不渲染：内置 key 且没有本机副本时
            // （理论组合，平台不会给内置 key 落本机）一只空 flex 容器会在卡片脚底留条 4px 空白带
            const canForget = k.hasLocal === true
            const canDelete = k.isBuiltin !== true
            return React.createElement('div', { className: 'dsh-mb-key-card', key: String(k.id) },
              React.createElement('div', { className: 'dsh-mb-key-card-top' },
                React.createElement('span', { className: 'dsh-mb-key-card-name' }, k.name || '未命名'),
                k.isBuiltin ? React.createElement('span', { className: 'dsh-mb-badge on', title: '平台按命名空间自动维护的内置密钥，不可删除' }, '内置') : React.createElement('span', { className: 'dsh-mb-badge', title: '在面板里创建的自建密钥' }, '自建'),
                k.isActive === false ? React.createElement('span', { className: 'dsh-mb-badge off' }, '已停用') : null,
              ),
              React.createElement('div', { className: 'dsh-mb-key-code-row' },
                React.createElement('span', { className: 'dsh-mb-key-card-code' }, k.tokenMasked || '—'),
                // 平台列表只回掩码、没有单取完整值的口；本机留存（用户定稿「新创建的密钥
                // 存到本地」）补上了这条路：创建时落过本机的行有 hasLocal，完整值按需单取
                // （点按钮才发一次请求），界面只见掩码。平台只存掩码的旧钥匙照旧没有复制路。
                k.hasLocal === true
                  ? React.createElement('button', {
                      className: 'dsh-mb-key-copy', title: '复制完整密钥（本机留存的那份）',
                      onClick: () => revealOcKey(k),
                    }, ocKeyCopied === k.id ? '已复制 ✓' : '复制完整值')
                  : React.createElement('span', { className: 'dsh-mb-key-card-none' }, '仅创建时展示过一次'),
              ),
              React.createElement('div', { className: 'dsh-mb-key-card-meta' },
                '创建于 ' + (day(k.createdAtMs) || '—'),
                exp ? ' · ' + exp + ' 到期' : ' · 长期有效',
                used ? ' · 最近调用 ' + used : ' · 从未调用'),
              // 动作行：与阶跃那张卡同一只容器（.dsh-mb-key-actions：右排一列、间距 8px）。
              // 早先这两个按钮是卡片的**直接子节点**——卡片是 block 容器，.dsh-mb-key-copy 的
              // margin-left:auto 在行内级盒上解析成 0，于是「不再在本机保存」靠左、还带一枚
              // marginRight:10px，「删除」跟在它右边——一行的位置全凭面板宽度，宽面板下两个
              // 按钮孤零零挂在 meta 左下角，跟「删除」该待的角落实在两回事。收进 actions 行后
              // 与阶跃逐字同构：次级动作用文字链、主动作用描边钮，右对齐成一列。
              canForget || canDelete ? React.createElement('div', { className: 'dsh-mb-key-actions' },
                // 本机副本的「清副本」入口：只清自己存的那份明文，平台密钥不动（与「删除」区分开）
                canForget ? React.createElement('button', {
                  className: 'dsh-mb-link',
                  disabled: ocKeyBusy,
                  title: '删除本机保存的明文副本（平台上的密钥不受影响，这行回到只显示掩码）',
                  onClick: () => forgetOcKey(k),
                }, '不再在本机保存') : null,
                canDelete ? React.createElement('button', {
                  className: 'dsh-mb-key-copy danger' + (ocKeyConfirm === k.id ? ' armed' : ''),
                  disabled: ocKeyBusy,
                  title: ocKeyConfirm === k.id ? '再点一次确认删除（删除立即失效）' : '删除该密钥',
                  onClick: () => deleteOcKey(k),
                }, ocKeyConfirm === k.id ? '确认删除' : '删除') : null,
              ) : null,
            )
          }),
        ))
        // 带旧列表的失败：一句话提醒，不把列表打回空（与 loadOcKeys 不覆盖旧值同款）
        if (ocKeys.error) {
          rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'stale', style: { color: 'var(--mb-warnTx)' } },
            '上次刷新失败：' + ocKeys.error))
        }
        // 平台已删、本机还留着明文的孤儿副本 → 见下面 if/else 之外那段（空列表时也要提示）
      }
      // 提示放在 if/else 之外：平台上**一把都不剩**时最该清（上面那支只画空态文案），
      // 所以不能只挂在「有列表」的分支里。首帧 ocKeys 还是 null，先挡掉。
      const orphans = ocKeys && Array.isArray(ocKeys.orphanIds) ? ocKeys.orphanIds : []
      if (orphans.length > 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'orphan' },
          '另有 ' + orphans.length + ' 份本机副本对应的密钥已不在平台（在官网删过？）',
          React.createElement('button', {
            className: 'dsh-mb-link', style: { marginLeft: 4 },
            disabled: ocKeyBusy,
            title: '删掉这些已经用不上的本机明文副本（平台上的东西不受影响）',
            onClick: () => forgetOcKeyOrphans(orphans),
          }, '清掉')))
      }
      if (ocKeyMsg) {
        rows.push(React.createElement('div', { className: 'dsh-mb-cookie-msg' + (ocKeyMsg.ok ? '' : ' err') }, ocKeyMsg.text))
      }
      rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
        '平台列表只有服务端掩码；在本面板创建的密钥会存到本机（可随时点「复制完整值」），在官网创建的只有掩码。「内置」那把由平台按命名空间自动维护（AI Gateway 计费走它），不可删除。官网管理：',
        React.createElement('button', { className: 'dsh-mb-link', style: { marginLeft: 4 }, onClick: () => { try { window.open('https://opencsg.com/settings/api-keys', '_blank') } catch { /* 拦截无碍 */ } } }, 'opencsg.com/settings/api-keys ↗')),
      )
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }
    // ---- 清枢「按量 API Key」页签（v0.7.4）。与 OpenCSG 那张密钥页同一只骨架，三处本地化：
    // ① 清枢多「启停」（新-api 的 status 1↔2，官网行内 Switch 同款）；
    // ② 行上有金额（剩余/已用，宿主已按 quota_per_unit 折成「元」，基准拿不到时是 null →「—」，
    //    绝不显示成 0 ——把 0 摆出来是「钱没了」的谎）；
    // ③ 创建表单多「额度」维度（官方表单就是 不限量/定额 二选一 + 金额(元) + 有效期）。----
    function renderTfKeysTab({ tfKeys, tfAccs, loadTfKeys, tfKeyName, setTfKeyName, tfKeyUnlimited, setTfKeyUnlimited, tfKeyQuota, setTfKeyQuota, tfKeyExpire, setTfKeyExpire, tfKeyBusy, tfKeyMsg, tfKeyCreated, setTfKeyCreated, tfKeyCopied, copyTfCreatedKey, tfKeyConfirm, createTfKey, deleteTfKey, revealTfKey, forgetTfKey, forgetTfKeyOrphans, toggleTfKeyStatus }) {
      const rows = []
      const activeId = tfAccs && typeof tfAccs.activeAccount === 'string' ? tfAccs.activeAccount : ''
      rows.push(pageTopBar({
        left: React.createElement('div', { className: 'dsh-mb-day-title' },
          '按量 API Key' + (activeId === '' ? '' : '：' + activeId)),
        at: null,
        onRefresh: () => loadTfKeys(activeId),
      }))
      // 创建表单：名称 + 额度（不限量/定额）+ 有效期。默认「不限量 + 长期有效」= 官方表单默认值。
      rows.push(React.createElement('div', { className: 'dsh-mb-key-create', key: 'create' },
        React.createElement('input', {
          className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px' },
          type: 'text', maxLength: 128, autoComplete: 'off',
          placeholder: '密钥名称（不超过 128 字符）',
          value: tfKeyName,
          onChange: (e) => setTfKeyName(e.target.value),
        }),
        React.createElement('select', {
          className: 'dsh-mb-ck-int',
          value: tfKeyUnlimited ? 'unlimited' : 'quota',
          onChange: (e) => setTfKeyUnlimited(e.target.value === 'unlimited'),
          title: '不限量 = 跟随账户余额扣；定额 = 这把密钥单独封顶',
        },
          React.createElement('option', { value: 'unlimited' }, '不限量'),
          React.createElement('option', { value: 'quota' }, '限额（元）')),
        tfKeyUnlimited ? null : React.createElement('input', {
          className: 'dsh-mb-input', style: { minHeight: 0, padding: '6px 10px', width: 84 },
          type: 'number', min: 0.01, max: 1000000, step: 0.01, autoComplete: 'off',
          placeholder: '如 30',
          value: tfKeyQuota,
          onChange: (e) => setTfKeyQuota(e.target.value),
        }),
        React.createElement('select', {
          className: 'dsh-mb-ck-int',
          value: tfKeyExpire,
          onChange: (e) => setTfKeyExpire(e.target.value),
          title: '到期后密钥自动失效（平台按 expired_time 判定，状态转「已过期」）',
        },
          React.createElement('option', { value: 'never' }, '长期有效'),
          React.createElement('option', { value: '30' }, '30 天'),
          React.createElement('option', { value: '90' }, '90 天')),
        React.createElement('button', {
          className: 'dsh-mb-btn',
          disabled: tfKeyBusy || tfKeyName.trim() === '',
          onClick: createTfKey,
        }, tfKeyBusy ? '创建中…' : '创建密钥'),
      ))
      // 一次性明文（创建响应是清枢全链路唯一的明文出处——官方弹窗自己写明之后再也看不到）
      if (tfKeyCreated) {
        rows.push(React.createElement('div', { className: 'dsh-mb-created', key: 'created' },
          React.createElement('div', { className: 'dsh-mb-created-title' },
            '「' + tfKeyCreated.name + '」已创建，' + (tfKeyCreated.savedLocal === false
              ? '完整密钥只显示这一次，请立即复制保存'
              : '完整密钥已存到本机（历史列表里也能复制）')),
          React.createElement('div', { className: 'dsh-mb-created-key' }, tfKeyCreated.key),
          React.createElement('div', { className: 'dsh-mb-btn-row' },
            React.createElement('button', { className: 'dsh-mb-btn', onClick: copyTfCreatedKey },
              tfKeyCopied === 'created' ? '已复制 ✓' : '复制密钥'),
            React.createElement('button', { className: 'dsh-mb-btn ghost', onClick: () => setTfKeyCreated(null) }, '我已保存'),
          ),
        ))
      }
      // 列表
      if (tfKeys === null || tfKeys.loading) {
        rows.push(React.createElement('div', { className: 'dsh-mb-skel-rows', key: 'ld', role: 'status', 'aria-label': '加载中' },
          [38, 62, 50].map((w, i) => React.createElement('div', { className: 'dsh-mb-skel', key: i, style: { width: w + '%' } })),
        ))
      } else if (tfKeys.error && (tfKeys.list || []).length === 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice err', key: 'err' },
          '加载失败：' + tfKeys.error,
          React.createElement('div', { style: { marginTop: '6px' } },
            React.createElement('button', { className: 'dsh-mb-link', onClick: () => loadTfKeys(activeId) }, '重试'))))
      } else if ((tfKeys.list || []).length === 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'empty' }, '这个账号还没有密钥，填个名称创建一把'))
      } else {
        const day = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? fmtIsoDay(ms) : null)
        const yuan = (v) => (typeof v === 'number' && Number.isFinite(v) ? '¥' + v.toFixed(2) : '—')
        rows.push(React.createElement('div', { className: 'dsh-mb-keys-list', key: 'ls' },
          (tfKeys.list || []).map((k) => {
            // 官网列表把 sk- 前缀挂在掩码外面渲染（前端产物逐字如此）；这里同口径，
            // 但只对**没带前缀**的掩码补——万一平台哪天把前缀放进掩码串里，不致双打。
            const mask = k.keyMask === '' || k.keyMask == null ? '—'
              : (String(k.keyMask).indexOf('sk-') === 0 ? String(k.keyMask) : 'sk-' + k.keyMask)
            const exp = day(k.expiredAtMs)
            const used = k.accessedAtMs != null ? fmtIsoDay(k.accessedAtMs) : null
            const toggleable = k.status === 1 || k.status === 2
            const canForget = k.hasLocal === true
            const act = []
            if (toggleable) {
              act.push(React.createElement('button', {
                className: 'dsh-mb-link', key: 'tg', disabled: tfKeyBusy,
                title: k.status === 1 ? '停用：立即断这个 key 的调用（可再启用）' : '启用：恢复调用',
                onClick: () => toggleTfKeyStatus(k),
              }, k.status === 1 ? '停用' : '启用'))
            }
            if (canForget) {
              act.push(React.createElement('button', {
                className: 'dsh-mb-link', key: 'fg', disabled: tfKeyBusy,
                title: '删除本机保存的明文副本（平台上的密钥不受影响，这行回到只显示掩码）',
                onClick: () => forgetTfKey(k),
              }, '不再在本机保存'))
            }
            act.push(React.createElement('button', {
              className: 'dsh-mb-key-copy danger' + (tfKeyConfirm === k.no ? ' armed' : ''), key: 'del', disabled: tfKeyBusy,
              title: tfKeyConfirm === k.no ? '再点一次确认删除（删除立即失效，本机副本同步清掉）' : '删除该密钥',
              onClick: () => deleteTfKey(k),
            }, tfKeyConfirm === k.no ? '确认删除' : '删除'))
            return React.createElement('div', { className: 'dsh-mb-key-card', key: String(k.no) },
              React.createElement('div', { className: 'dsh-mb-key-card-top' },
                React.createElement('span', { className: 'dsh-mb-key-card-name' }, k.name || '未命名'),
                // 状态 pill：启用是常态不刷存在感；停用/已过期/额度耗尽都要在名字旁边说得清
                k.status === 1 ? null : React.createElement('span', { className: 'dsh-mb-badge off' }, k.statusName || '状态未知'),
              ),
              React.createElement('div', { className: 'dsh-mb-key-code-row' },
                React.createElement('span', { className: 'dsh-mb-key-card-code' }, mask),
                k.hasLocal === true
                  ? React.createElement('button', {
                      className: 'dsh-mb-key-copy', title: '复制完整密钥（本机留存的那份）',
                      onClick: () => revealTfKey(k),
                    }, tfKeyCopied === k.no ? '已复制 ✓' : '复制完整值')
                  : React.createElement('span', { className: 'dsh-mb-key-card-none' }, '仅创建时展示过一次'),
              ),
              React.createElement('div', { className: 'dsh-mb-key-card-meta' },
                k.unlimited ? '不限量' : ('剩余 ' + yuan(k.remainYuan) + ' · 已用 ' + yuan(k.usedYuan)),
                k.modelLimitsEnabled ? ' · 限 ' + (k.modelLimits || []).length + ' 个模型' : '',
                ' · 创建于 ' + (day(k.createdAtMs) || '—'),
                k.neverExpire ? ' · 长期有效' : (exp ? ' · ' + exp + ' 到期' : ''),
                used ? ' · 最近调用 ' + used : ' · 从未调用'),
              React.createElement('div', { className: 'dsh-mb-key-actions' }, act),
            )
          }),
        ))
        if (tfKeys.error) {
          rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'stale', style: { color: 'var(--mb-warnTx)' } },
            '上次刷新失败：' + tfKeys.error))
        }
      }
      // 平台已删、本机还留着明文的孤儿副本：空列表时最该清，故挂在 if/else 之外（OC 同款）。
      const orphans = tfKeys && Array.isArray(tfKeys.orphanIds) ? tfKeys.orphanIds : []
      if (orphans.length > 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'orphan' },
          '另有 ' + orphans.length + ' 份本机副本对应的密钥已不在平台（在官网删过？）',
          React.createElement('button', {
            className: 'dsh-mb-link', style: { marginLeft: 4 },
            disabled: tfKeyBusy,
            title: '删掉这些已经用不上的本机明文副本（平台上的东西不受影响）',
            onClick: () => forgetTfKeyOrphans(orphans),
          }, '清掉')))
      }
      if (tfKeyMsg) {
        rows.push(React.createElement('div', { className: 'dsh-mb-cookie-msg' + (tfKeyMsg.ok ? '' : ' err') }, tfKeyMsg.text))
      }
      rows.push(React.createElement('div', { className: 'dsh-mb-hint', key: 'hint' },
        '平台列表只有服务端掩码；完整密钥只在**创建的那一次**由平台给出，在本面板创建的会存到本机（可随时点「复制完整值」），在官网创建的只有掩码。启停/删除与官网同步生效。官网管理：',
        React.createElement('button', { className: 'dsh-mb-link', style: { marginLeft: 4 }, onClick: () => { try { window.open('https://tierflow.cn/keys', '_blank') } catch { /* 拦截无碍 */ } } }, 'tierflow.cn/keys ↗')),
      )
      return React.createElement('div', { className: 'dsh-mb-section' }, rows)
    }
    // ---- 升级订阅弹窗的正文（定稿「升级订阅直接弹窗」+「升级订阅应该是对应套餐升级的」
    //      +「查看官方源码的升级套餐原理，我们只用余额升级即可，不使用微信和支付宝」）----
    // **按订阅分组**：一组 = 一个生效中的订阅，也就是一个套餐；组里只列「比它贵」的档。
    // 每张目标卡的主动作是**余额升级**：从账户余额扣差价，直接调平台的
    // `POST /api/subscription/upgrade/balance`（官方 zf.js 里 `Yr` 那一个），微信 / 支付宝那条
    // 不接——弹窗里也没有任何微信 / 支付宝入口（用户定稿）。
    // 入口只剩订阅卡上那个「升级套餐」（右上角的「升级订阅」已按定稿删除），所以进来就是
    // 收窄视图；没有可升档位的组整组不列（定稿）。**续费**不在面板里做；**购买**原先也在这里
    // 不做，但用户新定稿「账户的部分添加购买订阅的功能，只能余额买」把它挪到账户页去了（入口挂在
    // 每张账号卡的脚行，见 renderTfBuy / renderTfUserTab）——这层只管升级，两件事别弄混。
    function renderTfUpgrade({ tfPlans, loadTfPlans, askTfUpgrade, scope }) {
      const d = tfPlans && tfPlans.data ? tfPlans.data : null
      const rows = []
      if (d === null) {
        if (tfPlans === null || tfPlans.loading === true) {
          rows.push(React.createElement('div', { className: 'dsh-mb-plan-hint', key: 'wait' }, '正在读取平台的套餐列表…'))
        } else {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'err' },
            (tfPlans && tfPlans.error) || '套餐列表加载失败'))
          rows.push(React.createElement('div', { className: 'dsh-mb-plan-act', key: 'retry' },
            React.createElement('button', { className: 'dsh-mb-btn small', onClick: () => loadTfPlans(true) }, '重新加载')))
        }
        return rows
      }
      const allSubs = Array.isArray(d.subs) ? d.subs : []
      // **只列真能升的**（定稿「把『没有可升档位』的组也从弹窗里去掉，只列真能升的」）：
      // 没有更高档可升的订阅（已在最高档、或这一档在目录里已查不到）整组都不出。
      const upgradable = allSubs.filter((x) => Array.isArray(x.targets) && x.targets.length > 0)
      // 从某张订阅卡进来的：只看那一份。它要是刚好没有可升的档（目录比卡片缓存新），
      // 退回这份「真能升」的清单——不给一个空弹窗。
      const scoped = typeof scope === 'string' && scope !== '' ? upgradable.filter((x) => x.subNo === scope) : []
      const subs = scoped.length > 0 ? scoped : upgradable
      // 标题行：说明句早就删了（定稿），现在「刷新」也删（定稿「升级订阅的 刷新按钮 没用」）——
      // 弹窗是点卡那一刻现开的，套餐用量页首那一下刷新、以及升级成功后的自动重取已经够用；
      // 真怕看到旧差价也不会有坑：host 下单前会**复问一次报价**，对不上就不扣款。
      // 于是这一行只剩「看全部订阅」（收窄视图里才有），连它都没有时整行不出——弹窗直接从
      // 组标题开始。（加载失败时那个「重新加载」在下面 notice 里，那才是错误恢复，不算刷新。）
      if (scoped.length > 0 && upgradable.length > 1) {
        rows.push(React.createElement('div', { className: 'dsh-mb-plan-top', key: 'top' },
          React.createElement('button', {
            className: 'dsh-mb-btn small ghost',
            title: '把' + upgradable.length + '份可升级的订阅都列出来',
            onClick: () => { setTfPlansScope(null) },
          }, '看全部订阅（' + upgradable.length + '）')))
      }
      // 一张目标套餐卡（定稿「样式优化。删除废话」）：三行——卡头是名称 / 标记 / 价格，
      // 第二行只留事实（额度 + Token 池，平台那段副标题宣传语删掉），第三行左边是**升级差价**
      // （橙色；平台的拒绝原话占同一个位置）右边是「余额升级」：钱和动作挨着，不用再上下找。
      const planCard = (p, key, q, qErr, sub) => {
        const dueTip = q === null ? '' : ('目标套餐 ¥' + fmtCny(q.targetPrice)
          + ' − 这档订阅的剩余价值 ¥' + fmtCny(q.remainingValue)
          + '（剩余 ' + fmtCny(q.remainingDays) + ' 天）= 应付差价 ¥' + fmtCny(q.amountDue)
          + (q.minAmountDue === null ? '' : '；低于 ¥' + fmtCny(q.minAmountDue) + ' 的差价平台不允许在线支付'))
        return React.createElement('div', { className: 'dsh-mb-plan', key },
          React.createElement('div', { className: 'dsh-mb-plan-head' },
            React.createElement('span', { className: 'dsh-mb-plan-name' }, p.title === '' ? p.slug : p.title),
            p.recommended === true ? React.createElement('span', { className: 'dsh-mb-plan-tag rec' }, '推荐') : null,
            p.enabled === false ? React.createElement('span', { className: 'dsh-mb-plan-tag off' }, '已停售') : null,
            React.createElement('span', { className: 'dsh-mb-plan-price' },
              (p.priceAmount === null ? '—' : '¥' + fmtCny(p.priceAmount))
                + (p.durationLabel === '' ? '' : ' / ' + p.durationLabel))),
          React.createElement('div', { className: 'dsh-mb-plan-kv' },
            React.createElement('span', null,
              '额度 ' + (p.unlimitedAmount ? '无限量' : tfMoney(p.totalAmount, d.quotaPerUnit))),
            React.createElement('span', null, 'Token 池 ' + tfTokensOf(p.basicTokenTotal))),
          p.enabled === false ? null : React.createElement('div', { className: 'dsh-mb-plan-act' },
            // 左槽二选一：平台不肯升（原话）> 升级差价。都没有就空着，按钮仍贴右。
            qErr ? React.createElement('span', { className: 'dsh-mb-plan-note' }, qErr)
              : (q !== null && q.amountDue !== null
                ? React.createElement('span', { className: 'due', title: dueTip },
                  '升级差价 ¥' + fmtCny(q.amountDue))
                : null),
            React.createElement('button', {
              className: 'dsh-mb-btn small',
              disabled: q === null || q.amountDue === null,
              title: q === null || q.amountDue === null
                ? '平台没给这一档的差价，面板不算也不猜'
                : '从账户余额扣差价，把「' + (sub.planTitle === '' ? sub.planSlug : sub.planTitle)
                  + '」升级到这一档（从余额扣差价，点下去还有一次确认）',
              onClick: () => askTfUpgrade(sub, p, q, d.balance, d.quotaPerUnit),
            }, '余额升级')))
      }
      if (subs.length === 0) {
        // 没有可升的：要么一条生效订阅都没有，要么都在最高档。这里都不列套餐目录——这层弹窗只干
        // 升级；买 / 续费走账户页那层「购买订阅」（见 renderTfBuy），此前「购买。删除」那条定稿
        // 已被「账户的部分添加购买订阅的功能，只能余额买」取代。
        rows.push(React.createElement('div', { className: 'dsh-mb-plan-hint', key: 'none' },
          allSubs.length === 0 ? '没有生效中的订阅。' : '都在最高档，没有可升级的档位。'))
      } else {
        for (const s of subs) {
          const meta = []
          if (typeof s.daysLeft === 'number') meta.push('剩余 ' + s.daysLeft + ' 天')
          meta.push('额度 ' + (s.unlimitedAmount === true ? '无限量' : tfMoney(s.amountTotal, d.quotaPerUnit)))
          rows.push(React.createElement('div', { className: 'dsh-mb-plan-grp', key: 'g:' + s.subNo },
            React.createElement('div', { className: 'dsh-mb-plan-grp-head' },
              React.createElement('span', { className: 'dsh-mb-plan-grp-name' },
                s.planTitle === '' ? s.planSlug : s.planTitle),
              React.createElement('span', { className: 'dsh-mb-plan-tag cur' }, s.statusName === '' ? '生效中' : s.statusName),
              React.createElement('span', { className: 'dsh-mb-plan-grp-meta', title: '订阅 ' + s.subNo }, meta.join(' · ')))))
          // 组里只列「比它贵」的档：这些订阅是按 upgradable 过滤进来的，targets 至少有一个。
          for (const t of s.targets) rows.push(planCard(t, s.subNo + ':' + t.slug, t.quote, t.quoteError, s))
        }
      }
      return rows
    }

    // ---- 购买订阅弹窗（定稿「账户的部分添加购买订阅的功能，只能余额买」＋「不应该是账户的，
    // 不要放在最上面」→ 挪到账号卡片上）----
    // 与升级那层弹窗的分工：**升级** = 把已有的一份订阅换到更贵的档（付差价，入口在订阅卡上）；
    // **购买** = 新开一份订阅（付整价，入口在**每张账号卡的脚行**）。平台这个动作就是
    // `POST /api/subscription/balance/pay {plan_slug}`（官方 zf.js 的 `Ax`），只看这一档自己的
    // `price_amount`——新购没有报价接口，所以这里不摆订阅、不算差价，只列目录里能买的档。
    // **认卡不认「当前显示」**：目录按 `forId` 这个账号取（`tfBuyPlans`，与「当前显示」那份
    // `tfPlans` 分开存），付款账号也用它；从哪张卡进来就是买哪个账号、扣哪个账号的余额。
    // **只用余额**（用户定稿）：平台不让余额付的档（`allow_balance_pay === false`）当场关掉按钮
    // 并写明原因；微信 / 支付宝那条整个不接（付款方式只剩余额这一条路）。余额够不够只当**提示**
    // 写在档上、不当门槛——面板手上的余额是快照，拿它硬拦会在快照旧时挡住正当购买，够不够由
    // 平台判（与 host 侧同一套口径）。
    // **弹窗里不写说明行**（用户定稿：把「用 X 的余额支付…」与「这里是新开一份订阅…」两行都删了）：
    // 付款账号就是点进来那张卡（`forId`），「新开一份 vs 换档」由「购买订阅 / 升级套餐」两个入口名
    // 与二次确认框里的措辞区分——同一个意思不在弹窗里再讲一遍。
    // 免费档（价 0）与平台标记隐藏的档不列：余额购买这条链路要的就是「付多少钱」，没有金额就没有
    // 可确认的东西；隐藏档在平台自己的定价页也不出现。
    function renderTfBuy({ tfBuyPlans, loadTfBuyPlans, askTfBuy, forId }) {
      const rows = []
      const d = tfBuyPlans && tfBuyPlans.data ? tfBuyPlans.data : null
      const qpu = d !== null && Number(d.quotaPerUnit) > 0 ? Number(d.quotaPerUnit) : TF_QPU_FALLBACK
      const b = d === null || d.balance === undefined ? null : d.balance
      // 余额只当档上的**提示**（快照），不当门槛：够不够由平台判。quota 不是有限数（缺失 / 脏数据）
      // → null，下面那句「余额可能不够」整句不出现（宁缺不编）。
      const balCny = b !== null && b !== undefined && typeof b.quota === 'number' && Number.isFinite(b.quota) && b.quota >= 0 ? b.quota / qpu : null
      if (d === null) {
        if (tfBuyPlans === null || tfBuyPlans.loading === true) {
          rows.push(React.createElement('div', { className: 'dsh-mb-plan-hint', key: 'wait' }, '正在读取平台的套餐列表…'))
        } else {
          rows.push(React.createElement('div', { className: 'dsh-mb-notice', key: 'err' },
            (tfBuyPlans && tfBuyPlans.error) || '套餐列表加载失败'))
          rows.push(React.createElement('div', { className: 'dsh-mb-plan-act', key: 'retry' },
            React.createElement('button', {
              className: 'dsh-mb-btn small', onClick: () => loadTfBuyPlans(true, forId),
            }, '重新加载')))
        }
        return rows
      }
      const all = Array.isArray(d.plans) ? d.plans : []
      const buyable = all.filter((p) => p.hidden !== true
        && typeof p.priceAmount === 'number' && Number.isFinite(p.priceAmount) && p.priceAmount > 0)
      if (buyable.length === 0) {
        rows.push(React.createElement('div', { className: 'dsh-mb-plan-hint', key: 'none' }, '平台现在没有可买的套餐档位。'))
        return rows
      }
      for (const p of buyable) {
        const name = p.title === '' ? p.slug : p.title
        // 平台不让余额付（官方弹窗同款判定 `!1 !== plan.allow_balance_pay`）→ 按钮直接关掉。
        // 这是「只能余额买」的硬闸：面板没有微信 / 支付宝那条路可退，所以点都不让它点。
        const noBal = p.allowBalancePay === false
        const limited = typeof p.maxPurchasePerUser === 'number' && p.maxPurchasePerUser > 0
        const short = balCny !== null && balCny < p.priceAmount
        const tip = noBal
          ? '这一档平台不让用余额买（allow_balance_pay = false）；面板只做余额购买，没有别的付款方式'
          : '从账户余额扣 ¥' + fmtCny(p.priceAmount) + '，新开一份「' + name + '」订阅'
            + (limited ? '（平台限购 ' + p.maxPurchasePerUser + ' 份/人）' : '')
            + '；点下去还有一次确认'
        rows.push(React.createElement('div', { className: 'dsh-mb-plan', key: 'p:' + p.slug },
          React.createElement('div', { className: 'dsh-mb-plan-head' },
            React.createElement('span', { className: 'dsh-mb-plan-name' }, name),
            p.recommended === true ? React.createElement('span', { className: 'dsh-mb-plan-tag rec' }, '推荐') : null,
            p.enabled === false ? React.createElement('span', { className: 'dsh-mb-plan-tag off' }, '已停售') : null,
            React.createElement('span', { className: 'dsh-mb-plan-price' },
              '¥' + fmtCny(p.priceAmount) + (p.durationLabel === '' ? '' : ' / ' + p.durationLabel))),
          React.createElement('div', { className: 'dsh-mb-plan-kv' },
            React.createElement('span', null, '额度 ' + (p.unlimitedAmount ? '无限量' : tfMoney(p.totalAmount, qpu))),
            React.createElement('span', null, 'Token 池 ' + tfTokensOf(p.basicTokenTotal))),
          p.enabled === false ? null : React.createElement('div', { className: 'dsh-mb-plan-act' },
            // 左槽：先摆平台的硬规矩（不让余额付），再摆快照层面的提示（余额可能不够）。都只是说明
            // ——能不能点由 allow_balance_pay 定，够不够由平台判。
            noBal
              ? React.createElement('span', { className: 'dsh-mb-plan-note' }, '这一档平台不让用余额付')
              : (short ? React.createElement('span', { className: 'dsh-mb-plan-note' },
                '余额可能不够（快照 ' + tfMoney(b.quota, qpu) + '）') : null),
            React.createElement('button', {
              className: 'dsh-mb-btn small',
              disabled: noBal,
              title: tip,
              onClick: () => askTfBuy(p, d.balance, d.quotaPerUnit, forId),
            }, '余额购买'))))
      }
      return rows
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

    // ---- 对话头部角标：当前对话在用阶跃模型时，显示该 key 的套餐剩余进度条 ----
    // 「当前使用的 key」= DSH 里 id=step 那个 provider 用的 API Key（STEP_API_KEY），
    // 不是面板的「当前显示账号」——两者可能不是同一个账号。host 的 /stepfun/key-plan 拿
    // 这把 key 去账号池里反查归属账号，再用那个账号的会话取套餐（key 本身只够查预付费
    // 余额，查不到 Step Plan 套餐）。
    // 剩余百分比是纯函数：只有拿到正的总量才算百分比，拿不到 → null（渲染「—」，绝不编数）。
    function stepPlanPct(plan) {
      const c = plan && plan.credit && plan.credit.credits ? plan.credit.credits : null
      if (c === null) return null
      if (!Number.isFinite(c.total) || c.total <= 0 || !Number.isFinite(c.residual)) return null
      return Math.max(0, Math.min(100, Math.round((c.residual / c.total) * 1000) / 10))
    }
    // 悬停详情卡的取数格式化：全部**缺了就不编**——fmtInt 非有限给「—」，fmtDay 拿不到给
    // 空串（调用方整行隐藏）。手机号/密钥辨识信息已整体上屏删除（用户点名），所以连打码
    // 函数都不需要——不存在的东西才是最稳的隐私口径。
    function fmtInt(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }
    // Credit 是亿级的数（月池总量 400,000,000 这种）——千分位长串没法一眼读，按中文习惯
    // 折成「万 / 亿」：227,127,615 → 「2.27 亿」；12,345 → 「1.23 万」；一万以下保留原数。
    // 尾零去掉（4.00 亿 → 4 亿）。
    function fmtCredits(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
      const abs = Math.abs(n)
      if (abs >= 1e8) return String(parseFloat((n / 1e8).toFixed(2))) + ' 亿'
      if (abs >= 1e4) return String(parseFloat((n / 1e4).toFixed(2))) + ' 万'
      return fmtInt(n)
    }
    // 秒级 epoch → YYYY-MM-DD（只有月池重置用）。**必须带后缀名**：3078 行已有 function
    // fmtDay（ISO → M-D，密钥/兑换码页在用）——同一闭包里函数声明全部提升，后声明的把先
    // 声明的整体顶掉，node --check 一声不吭。教训固化成机械测试（header-step-plan.spec）。
    function fmtDaySec(ts) {
      if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return ''
      const d = new Date(ts * 1000)
      if (isNaN(d.getTime())) return ''
      const p = (x) => (x < 10 ? '0' + x : String(x))
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    }
    // 只实测确认过 PEAK_VALLEY；其余枚举值原样显示，不猜中文名
    const STEP_BILLING_TEXT = { PEAK_VALLEY: '峰谷计费' }
    // 内置阶跃 provider id 名单。host 回带的 providerId 是权威值（它按同一逻辑找的
    // provider），拿不到时退回这份名单——用户给 provider 改名不该让角标直接消失。
    const STEP_PROVIDER_IDS = ['step', 'stepfun']
    function isStepProvider(provider, hostProviderId) {
      if (typeof provider !== 'string' || provider === '') return false
      if (hostProviderId !== undefined && hostProviderId !== null && hostProviderId !== ''
        && provider === hostProviderId) return true
      return STEP_PROVIDER_IDS.indexOf(provider) !== -1
    }
    // 位置定稿：与「对话 / 轨迹」页签**同一行**，两端对齐（页签居左、角标钉右端）。
    // 页签行是宿主的普通 div（role=tablist，带稳定锚点属性 data-conversation-tabs，
    // display:flex + gap:36px），owner 端**没有**给插件留槽——所以角标用 **portal** 挂进
    // 那一行，就是官方把 chip 挂进编辑器、把弹层挂进 body 的同一手法
    // （react_dom.createPortal(jsx, el)）。注册仍留在 conversation.session.header.utilities
    // 当**无头锚点**（session 作用域：组件输出只有 portal，工具组里不留任何 DOM；切换会话
    // 自动重挂载、重新找行）。`corner` 是 single 槽且被 DSH 右栏按钮占住，本来也进不去。
    // **整枚只在该会话真的选了阶跃模型时才渲染**（用户定稿：「当前对话不是使用的阶跃模型
    // 就不显示整个的」——不是显示成「—」，是根本不出）。也不写「阶跃」二字：能出现就说明在用。
    // 当前模型取自宿主给这个槽的**标准 prop** `useProjection`：modelSelection 投影对外形状
    // { lastUsed, next }，next = pending ?? lastUsed 即当前生效选择——零额外服务依赖、
    // 无渲染期副作用，模型一换跟着重渲染，角标随选随现随隐。
    // useProjection/useState/useLayoutEffect 都是**钩子**，缺 prop 时不能条件调用 →
    // 外面薄壳分流，里面组件无条件调用（同一挂载点上 props 不会来回变，钩子数稳定）。
    // ---- 两枚角标共用的「一轮对话结束」判据与 session hook ----
    // useSession 是 session 作用域 slot 的标准 hook（DSH 的 ui-session 声明
    // hooks:['session']），不是本插件自造；缺它的装配退 no-op：行为与旧版一致，只是少了
    // 这条即时刷新，5 分钟轮询照常兜底。写成常量函数而不是在组件里 `typeof` 分支：保证
    // 「每个 hook 位无条件调用一次」的形状不随 props 变化，槽位装配变了也不会少调一个 hook。
    const NO_SESSION_HOOK = () => false
    // 纯判据：只有「上一帧在跑、这一帧不跑」才算一轮结束。挂载时本来就空闲（切到一个早已
    // 完成的会话）不该被读成「刚结束」——否则每切一次会话就白刷一次。
    // **阶跃与 OpenCSG 两枚共用这一条**（v0.7.3：OpenCSG 先接上，阶跃本轮补齐）。
    const turnJustEnded = (wasRunning, running) => wasRunning === true && running === false
    function findConversationTabsRow() {
      if (typeof document === 'undefined') return null
      try {
        const els = document.querySelectorAll('[data-conversation-tabs]')
        for (let i = 0; i < els.length; i++) {
          const el = els[i]
          if (el !== null && el !== undefined && el.isConnected && el.offsetHeight > 0) return el
        }
      } catch { /* 选择器失败 / 非常规环境 → 当作找不到 */ }
      return null
    }
    // ---- 阶跃角标的即时刷新 ----
    // 两个入口共用这一条（v0.7.3，与 refreshOcKeyAccount 同构）：
    //   · 密钥 / 账号池任何一侧动过 → force=1：归属可能变了，host 侧连 10 分钟指纹表一起作废，
    //     这里把新结论当场拿回来，角标不等那 5 分钟轮询（面板里换 key / 删账号走这条）；
    //   · 一轮对话结束 → refresh=1：刚花掉的 Credit 要马上看见，但「DSH 在用哪把 key」几乎
    //     不会变——只重取套餐快照，复用 host 那 10 分钟指纹缓存。否则每轮都要把各账号的
    //     密钥列表重问一遍（本机没留会话的账号还要先真登一次，是这条链上最贵的一步）。
    // 取失败（网络层给 null）**留着旧值**：后台补充刷新不是用户显式动作，不该把已上屏的数
    // 一抹了之（下一轮 5 分钟轮询兜底）；host 的业务性失败（NO_KEY / NO_MATCH…）仍是对象，
    // 照常写回让角标改口讲原因。
    // 注意「显示账号」切换（useStepAccount）**不**走这里：那只改面板看谁的账，DSH 在用的
    // key 没动、归属没动，反查结果原样有效——多打一次请求只是白打。
    const refreshStepKeyPlan = async (opts) => {
      if (!normalizeSystems(store.systems).step) return
      const reuseMatch = opts !== null && opts !== undefined && opts.reuseMatch === true
      const kp = await jsonGet(API + '/stepfun/key-plan' + (reuseMatch ? '?refresh=1' : '?force=1'))
      if (kp === null) return
      setStore({ stepKeyPlan: kp || null })
    }
    function StepHeaderPlan(props) {
      if (props === null || props === undefined || typeof props.useProjection !== 'function'
        || ReactDOM === null) return null
      return React.createElement(StepHeaderPlanBody, props)
    }
    function StepHeaderPlanBody(props) {
      const s = useStore()
      const proj = props.useProjection('modelSelection')
      const sel = proj !== null && typeof proj === 'object' ? (proj.next || proj.lastUsed || null) : null
      const r = s.stepKeyPlan
      // 「这个会话在不在用阶跃」与「手上有没有数」分开判（与 OpenCSG 那枚同一形状）：
      // 前者决定轮末要不要刷新，后者决定这枚角标出不出。NO_MATCH 时角标是灰的，但数据
      // 仍值得在轮末重试一次——「关掉再开」「隔夜回来」最容易卡住的两种灰。
      const sysOn = !!normalizeSystems(s.systems).step
      const stepConv = sel !== null && typeof sel === 'object'
        && isStepProvider(sel.provider, r !== null && r !== undefined ? r.providerId : '')
      // 门控全部折成一个布尔：钩子无条件跑，effect 里也拿它决定要不要找行。
      const pass = !!normalizeSystems(s.systems).step
        && r !== null && r !== undefined
        && sel !== null && typeof sel === 'object'
        && isStepProvider(sel.provider, r.providerId)
      // 一轮对话结束 = running 落回 false（判据与 useSession 替身在两枚角标上方共用）。
      // 走 refresh=1：只绕套餐那 5 分钟快照，复用 host 的 10 分钟密钥归属指纹缓存；
      // 请求自带 host 侧单飞，连续两轮挨得再近也不会并发打两次平台。
      const useSession = typeof props.useSession === 'function' ? props.useSession : NO_SESSION_HOOK
      const running = useSession((st) => !!(st && st.running)) === true
      const wasRunning = React.useRef(running)
      React.useEffect(() => {
        const was = wasRunning.current
        wasRunning.current = running
        if (!turnJustEnded(was, running) || !sysOn || !stepConv) return
        void refreshStepKeyPlan({ reuseMatch: true })
      }, [running, sysOn, stepConv])
      const [tabsRow, setTabsRow] = React.useState(null)
      // 无 deps 的 useLayoutEffect = 每次 commit 后都找一遍：页签行可能晚一帧才在 DOM 里
      // （developerTools 开关会整行重建）；行被重建后旧节点断开，下一拍自动跟到新行。
      // 找到的与 state 相同就不 setState——同值收敛，不会无限重渲染。
      React.useLayoutEffect(() => {
        const el = pass ? findConversationTabsRow() : null
        if (el !== tabsRow) setTabsRow(el)
      })
      if (!pass) return null
      const k = r.ok === true && r.key ? r.key : null
      // 账户名用平台 UserInfo 的 nickname。**手机号、密钥（连掩码）都不上界面**（用户点名
      // 砍掉了「密钥」「账号」两行辨识信息）。没昵称 → 「未命名账户」，不拿手机号顶。
      const name = typeof r.nickname === 'string' && r.nickname !== '' ? r.nickname : '未命名账户'
      const plan = k && r.plan && r.plan.ok === true ? r.plan : null
      const pct = stepPlanPct(plan)
      const credits = plan && plan.credit && plan.credit.credits ? plan.credit.credits : null
      const tier = plan && plan.plan && plan.plan.tier ? plan.plan.tier : ''
      // 悬停详情卡（用户定稿「鼠标放上去 展示详细的信息」；随后点名砍掉密钥/账号/续费/
      // 有效期行——卡只讲**这个套餐的数**；再后又点名加回「用的是哪把 key」，但只上名字，
      // 掩码/账号依旧不见）。不用原生 title：排不了版、还和自绘卡撞车。
      // 行式 k/v；**拿不到的字段整行不出现**，不放占位符。
      const rows = []
      const row = (kText, vText) => { rows.push([kText, vText]) }
      row('当前对话', sel.provider + '/' + (sel.model || ''))
      // 用的是哪把 key（用户点名要加回）：**只上密钥名字**——平台密钥列表里的那串名，
      // 够定位了。掩码值继续不上界面（上一轮砍「密钥」行定下的隐私口径不变，机械测试盯死）。
      // 只在反查命中时出现：NO_MATCH 根本没有 key 对象，这行宁可不显示也不编。
      if (k !== null) row('使用密钥', typeof k.keyName === 'string' && k.keyName !== '' ? k.keyName : '未命名密钥')
      if (k !== null) {
        if (pct !== null) {
          row('Credit 剩余', fmtCredits(credits.residual) + ' / ' + fmtCredits(credits.total) + '（' + pct + '%）')
        } else if (credits !== null) row('Credit 剩余', '月池没有总量读数，算不出剩余百分比')
        else row('Credit 剩余', '套餐里没有 Credit 月池读数')
        // 月池重置：口径与面板胶囊完全一致——优先 credit.subscriptionResetAt，退化到
        // type=1 桶的 nextResetAt；合理性窗口外**宁可不显示**（平台若哪天改成毫秒，
        // 日期会渲染成公元 5 万年）。
        const crd = plan && plan.credit ? plan.credit : null
        let resetRaw = null
        if (crd && Number.isFinite(crd.subscriptionResetAt) && crd.subscriptionResetAt > 0) resetRaw = crd.subscriptionResetAt
        else if (crd && Array.isArray(crd.buckets)) {
          const b1 = crd.buckets.find((x) => x && x.type === 1 && Number.isFinite(x.nextResetAt) && x.nextResetAt > 0)
          if (b1) resetRaw = b1.nextResetAt
        }
        if (resetRaw !== null) {
          const t0 = Date.now() / 1000
          if (resetRaw > t0 - 31536000 && resetRaw < t0 + 94608000) row('月池重置', fmtDaySec(resetRaw))
        }
        // 档位与计费并成一行，标签只要「套餐档位」（两段先以 `套餐档位 / 计费模式`
        // 并入，用户随后点名：长标签多余——值里 `Mini / 峰谷计费` 已经自解释）。
        // 任一段缺失退回各自的单标签原行；都没有整行不出现——不编占位。
        const pl = plan && plan.plan ? plan.plan : null
        const bill = pl && typeof pl.billingMode === 'string' && pl.billingMode !== ''
          ? (STEP_BILLING_TEXT[pl.billingMode] || pl.billingMode) : ''
        if (tier !== '' && bill !== '') row('套餐档位', tier + ' / ' + bill)
        else if (tier !== '') row('套餐档位', tier)
        else if (bill !== '') row('计费模式', bill)
      } else {
        row('状态', r.error || '读不到当前使用的阶跃密钥对应的套餐')
      }
      if (plan && plan.fetchedAt) row('数据更新于', fmtCheckedAt(plan.fetchedAt))
      const tip = React.createElement('div', { className: 'dsh-mb-hplan-tip' },
        rows.map((pair) => React.createElement('div', { className: 'dsh-mb-hplan-tr' },
          React.createElement('span', { className: 'dsh-mb-hplan-tk' }, pair[0]),
          React.createElement('span', { className: 'dsh-mb-hplan-tv' }, pair[1]))))
      const chip = React.createElement('div', {
        className: 'dsh-mb-hplan' + (k !== null ? '' : ' off') + (pct !== null && pct < 20 ? ' low' : ''),
      },
        // 状态点（v0.7.3 用户定稿的方案 D）：绿 / 琥珀 / 灰三态由 chip 上的 .low / .off 两个类
        // 决定，CSS 那三条规则对三枚同时生效——这里只负责把点摆出来，判据一个字都不重写。
        React.createElement('span', { className: 'dsh-mb-hplan-d' }),
        k !== null ? React.createElement('span', { className: 'dsh-mb-hplan-a' }, name) : null,
        // 进度条只讲剩余比例：条 + 数字都是「还剩多少」。拿不到读数就不画条（只留 —），
        // 免得一根空轨道被读成「剩 0%」；有条时把套餐档位压成**水印**盖在条上（用户定稿）。
        pct !== null ? React.createElement('span', { className: 'dsh-mb-hplan-track' },
          React.createElement('span', { className: 'dsh-mb-hplan-fill', style: { width: pct + '%' } }),
          tier !== '' ? React.createElement('span', { className: 'dsh-mb-hplan-wm' }, tier) : null) : null,
        React.createElement('span', { className: 'dsh-mb-hplan-v' }, pct !== null ? pct + '%' : '—'),
        tip)
      // 页签行没挂出来（developerTools 关着只剩单视图、整行不渲染）→ 本帧先不出角标，
      // 等下一次 commit 的 effect 再找；右上角工具组也不再残留任何视觉占位。
      return tabsRow === null ? null : ReactDOM.createPortal(chip, tabsRow)
    }

    // ---- 对话头部角标（OpenCSG，v0.7.3）：当前对话在用 OpenCSG 模型时，显示该账号的账户余额 ----
    // 与阶跃那枚同一手法、同一格位（页签行 portal 右端），数据来自 host /opencsg/key-account：
    // 按「DSH 真在用的那把 OpenCSG 密钥」反查归属账号，再取那个账号的余额快照。
    // 与阶跃最大的不同是**数**：阶跃是套餐 → 剩余百分比画进度条；OpenCSG 是按量扣费的
    // **钱**——钱没有分母，就不画条（同一条「pct 拿不到不画空轨道」的规矩，永远成立），
    // 数值位直接摆 ¥。低余量提醒吃平台自己的 lowBalanceWarnCents（两个读数都有限且
    // 余额 ≤ 阈值才变红）——不自造「低于 20% 报警」那种没有出处的判断。
    // 隐私口径逐字照抄阶跃定稿：identifier/username/uuid/明文/掩码都不进这个组件——
    // host 载荷里本来就裁掉了（见 index.js ocKeyAccountPayload），前端也就无从泄。
    const OC_PROVIDER_IDS = ['opencsg', 'csghub']
    function isOcProvider(provider, hostProviderId) {
      if (typeof provider !== 'string' || provider === '') return false
      if (hostProviderId !== undefined && hostProviderId !== null && hostProviderId !== ''
        && provider === hostProviderId) return true
      return OC_PROVIDER_IDS.indexOf(provider) !== -1
    }
    // 基元那枚的同款判据（v0.7.3）。内置名单只放产品本名与插件内部代号：host 回带的
    // providerId 才是权威值（它按 baseURL 含 tokenrhythm 找的 provider），用户给 provider
    // 改成别的名字也不该让角标消失——与阶跃/OpenCSG 逐字同一条兜底逻辑。
    const TR_PROVIDER_IDS = ['tokenrhythm', 'tr']
    function isTrProvider(provider, hostProviderId) {
      if (typeof provider !== 'string' || provider === '') return false
      if (hostProviderId !== undefined && hostProviderId !== null && hostProviderId !== ''
        && provider === hostProviderId) return true
      return TR_PROVIDER_IDS.indexOf(provider) !== -1
    }
    // 一轮对话结束的纯判据：只有「上一帧在跑、这一帧不跑」才算结束。挂载时本来就空闲
    // （切到一个早已完成的会话）不该被读成「刚结束」——否则每切一次会话就白刷一次。
    const ocTurnJustEnded = turnJustEnded // 与阶跃那枚共用的判据（本名保留给老调用点与测试）
    function OcHeaderPlan(props) {
      if (props === null || props === undefined || typeof props.useProjection !== 'function'
        || ReactDOM === null) return null
      return React.createElement(OcHeaderPlanBody, props)
    }
    function OcHeaderPlanBody(props) {
      const s = useStore()
      const proj = props.useProjection('modelSelection')
      const sel = proj !== null && typeof proj === 'object' ? (proj.next || proj.lastUsed || null) : null
      const r = s.ocKeyAccount
      const sysOn = !!normalizeSystems(s.systems).oc
      // 「这个会话在不在用 OpenCSG」与「手上有没有数」分开判：前者决定轮末要不要刷新，
      // 后者决定这枚角标出不出。反查 NO_MATCH / 一次取数失败时角标是灰的（甚至不出），
      // 但数据本身仍值得在轮末重试一次——这正是「关掉再开」「隔夜回来」最容易卡住的两种灰。
      const ocConv = sel !== null && typeof sel === 'object'
        && isOcProvider(sel.provider, r !== null && r !== undefined ? r.providerId : '')
      const pass = sysOn && r !== null && r !== undefined && ocConv
      // 一轮对话结束 = 会话快照的 running 由 true 落回 false——与官方 InputBar 同一个判据，
      // 也是本插件压缩按钮用的同一个字段（session 作用域 slot 的标准 hook `useSession`
      // 由 DSH 的 ui-session 提供，不是本插件自造）。判据 turnJustEnded 与替身
      // NO_SESSION_HOOK 与阶跃那枚共用，见 StepHeaderPlan 上方。
      const useSession = typeof props.useSession === 'function' ? props.useSession : NO_SESSION_HOOK
      const running = useSession((st) => !!(st && st.running)) === true
      const wasRunning = React.useRef(running)
      React.useEffect(() => {
        const was = wasRunning.current
        wasRunning.current = running
        if (!turnJustEnded(was, running) || !sysOn || !ocConv) return
        // 归属没变，只要新快照：走 refresh=1（host 侧复用 10 分钟匹配缓存、只绕账户快照缓存）。
        // 请求本身自带 host 侧单飞，连续两轮挨得再近也不会并发打两次平台。
        void refreshOcKeyAccount({ reuseMatch: true })
      }, [running, sysOn, ocConv])
      const [tabsRow, setTabsRow] = React.useState(null)
      // 与阶跃那枚同款：无 deps 的 useLayoutEffect，每次 commit 找一遍页签行（行可能被整行重建）。
      React.useLayoutEffect(() => {
        const el = pass ? findConversationTabsRow() : null
        if (el !== tabsRow) setTabsRow(el)
      })
      if (!pass) return null
      const k = r.ok === true && r.key ? r.key : null
      const acc = r.account && typeof r.account === 'object' ? r.account : null
      // 名字：平台账号资料里的 nickname（fetchOcAccount 带出的那份），拿不到退「未命名账户」；
      // 只在反查命中时出现——与阶跃同一规矩（NO_MATCH 不摆名字，名字行也不该是 identifier）。
      const name = typeof r.nickname === 'string' && r.nickname !== '' ? r.nickname : '未命名账户'
      const cents = (c) => (typeof c === 'number' && Number.isFinite(c) ? '¥' + fmtCny(c / 100) : null)
      const balText = acc === null ? null : cents(acc.balanceCents)
      const low = acc !== null
        && typeof acc.balanceCents === 'number' && Number.isFinite(acc.balanceCents)
        && typeof acc.lowBalanceWarnCents === 'number' && Number.isFinite(acc.lowBalanceWarnCents)
        && acc.balanceCents <= acc.lowBalanceWarnCents
      const rows = []
      const row = (kText, vText) => { rows.push([kText, vText]) }
      // 悬停卡只讲**这个账号的账**（用户 2026-10-19 点名删掉两行）：
      //   · 「当前对话 provider/model」——角标能出现就说明在用 OpenCSG，这一行是重复信息；
      //   · 「其中 现金 / 赠送」——平台两个读数必须都给全才列，缺一个就整行消失；用户认为
      //     半截构成比没构成更误导，干脆不要（要看得去「账户」页，那里本来就是摊开列的）。
      // 阶跃那枚仍保留「当前对话」行（两枚卡不同口径，别顺手改成一样——那边没这个要求）。
      // 用的是哪把 key：只上名字（与阶跃同款隐私口径），反查命中才有这行，NO_MATCH 宁可不显示。
      if (k !== null) row('使用密钥', typeof k.keyName === 'string' && k.keyName !== '' ? k.keyName : '未命名密钥')
      if (k !== null) {
        if (acc === null) row('状态', r.accountError || 'OpenCSG 账户数据暂不可用')
        else {
          row('账户余额', balText === null ? '—' : balText)
          const api = acc.api && typeof acc.api === 'object' ? acc.api : null
          if (api !== null) {
            // 「API 调用量」= 本期账单费用合计，**取绝对值**：平台把扣费记成负数
            // （实测 total_value = -3177.023324），账户卡与用量页都是 Math.abs 后再格式化；
            // 这里原样除 100 会写成「¥-31.77」，同一个数在三处必须是同一种写法。
            const av = typeof api.valueCents === 'number' && Number.isFinite(api.valueCents)
              ? cents(Math.abs(api.valueCents)) : null
            const an = typeof api.apiCount === 'number' && Number.isFinite(api.apiCount) ? fmtTokens(api.apiCount) + ' 条' : null
            if (av !== null && an !== null) row('API 调用量', av + '（' + an + '）')
            else if (av !== null) row('API 调用量', av)
            else if (an !== null) row('API 调用量', an)
          }
          const inv = acc.invite && typeof acc.invite === 'object' ? acc.invite : null
          const pv = inv === null ? null : cents(inv.pendingCreditCents)
          if (pv !== null) row('待发放余额', pv)
          if (typeof acc.atMs === 'number' && acc.atMs > 0) row('数据更新于', fmtCheckedAt(acc.atMs))
        }
      } else {
        row('状态', r.error || '读不到当前使用的 OpenCSG 密钥对应的账号')
      }
      const tip = React.createElement('div', { className: 'dsh-mb-hplan-tip' },
        rows.map((pair) => React.createElement('div', { className: 'dsh-mb-hplan-tr' },
          React.createElement('span', { className: 'dsh-mb-hplan-tk' }, pair[0]),
          React.createElement('span', { className: 'dsh-mb-hplan-tv' }, pair[1]))))
      const chip = React.createElement('div', {
        className: 'dsh-mb-hplan dsh-mb-hplan-oc' + (k !== null ? '' : ' off') + (low ? ' low' : ''),
      },
        // 状态点：与另两枚同一颗、同一套 CSS（low = 可用余额 < ¥10，就是侧栏那颗琥珀点的判据）。
        React.createElement('span', { className: 'dsh-mb-hplan-d' }),
        k !== null ? React.createElement('span', { className: 'dsh-mb-hplan-a' }, name) : null,
        // 没有进度条：钱没有分母（见上）。数值位就是余额本身，拿不到 → 「—」。
        React.createElement('span', { className: 'dsh-mb-hplan-v' }, balText === null ? '—' : balText),
        tip)
      return tabsRow === null ? null : ReactDOM.createPortal(chip, tabsRow)
    }

    // ---- 对话头部角标（基元，v0.7.3）：当前对话在用基元模型时，显示本机绑定账号的账户余额 ----
    // 与阶跃、OpenCSG 两枚同格位（页签行 portal 右端）、同手法、同一条轮末判据。数的口径：
    // **账户余额**（¥）——与入口胶囊默认那档、面板余额页首位数是同一个值（host 侧同一个
    // normalizeBalance 算出来的，不在这条路上另写一套取数）。与 OpenCSG 一样**不画进度条**：
    // 钱没有分母，数值位直接摆 ¥（拿不到就读作「—」，绝不写 ¥0）。
    // 低余量沿用基元自己**已有**的那条预警口径（可用余额 < ¥10）——就是侧栏那颗琥珀点用的
    // 同一个 alertOf，不在这里另发明一个阈值；读数拿不到就不红（不拿 0 顶位）。
    // 这枚角标**也摆名字**（用户 2026-10-21 两轮点名：「基元的怎么没有用户名显示」→ 随后
    // 「账号 放在角标的旁边呀 参考其他的角标」）：名字位与阶跃 / OpenCSG 同格位、同类名
    // （.dsh-mb-hplan-a，CSS 通用、无需按枚另写），平台用户名优先（/api/me 的 name），名字没
    // 读到就退回**打码**手机号，两个都缺则整个名字位不渲染（缺失 ≠ 0）。旧定稿「基元的账号名
    // 就是手机号/邮箱、标识符不上界面」就此作废：实测 /api/me 的 name 是用户名、phoneMasked
    // 才是手机号，是两个独立字段（阶跃与 OpenCSG 摆的昵称走的也是 name 那一路；基元这份名字
    // 由 5 分钟常驻轮询随 provider 名单同步进 store，角标读不到面板组件自己的 manifest state）。
    // 归属（这把 key 是不是这个账号的）只在悬停卡里讲：坐实了才摆
    // 密钥名，明确对不上就多一行说明，列表读不到则只字不提（见 host 侧 fetchTrKeyBalance）。
    function TrHeaderPlan(props) {
      if (props === null || props === undefined || typeof props.useProjection !== 'function'
        || ReactDOM === null) return null
      return React.createElement(TrHeaderPlanBody, props)
    }
    function TrHeaderPlanBody(props) {
      const s = useStore()
      const proj = props.useProjection('modelSelection')
      const sel = proj !== null && typeof proj === 'object' ? (proj.next || proj.lastUsed || null) : null
      const r = s.trKeyBalance
      const sysOn = !!normalizeSystems(s.systems).tr
      // 会话在用的 provider 是不是基元：先认 host 名册那份「可查基元余额」的 id 名单（manifest 的
      // providers 段就是它，多枚共用同一个 baseURL 的短键 jy / jy131 全在里面，用户给 provider
      // 改个名字也不影响），再认 host 回带的权威 id。名单要到首包 manifest 之后才有，所以头一两帧
      // 可能只认后者——store 一更新就会重算，不写「没名单就不出」的死判据。
      const selProvider = sel !== null && typeof sel === 'object' && typeof sel.provider === 'string' ? sel.provider : ''
      const trProviderIds = s.trProviderIds
      const trIdsKnown = Array.isArray(trProviderIds) && trProviderIds.length > 0
      const trCapable = selProvider !== '' && Array.isArray(trProviderIds) && trProviderIds.indexOf(selProvider) !== -1
      // 「要不要问 host」比渲染判据宽一档：名单还没到（首包 manifest 未回，或那一次抓取失败）时
      // 不轻易判死，先问一句——host 认它就是基元，不认它回 NO_PROVIDER（一次上游都不打）。
      // 渲染仍只认 trConv（名单命中或 host 回带的 id 相等），所以这一档不会让非基元会话冒出灰角标。
      const trAsk = selProvider !== '' && (trCapable || !trIdsKnown)
      // 与另两枚逐字同一条分层：「这个会话在不在用基元」决定轮末要不要刷新，「手上有没有数」
      // 决定这枚角标出不出。一次取数失败（灰着、甚至不出）仍值得在轮末重试一次。
      const trConv = sel !== null && typeof sel === 'object'
        && (trCapable || isTrProvider(selProvider, r !== null && r !== undefined ? r.providerId : ''))
      const pass = sysOn && r !== null && r !== undefined && trConv
      // 会话在用的那一枚 provider 变了（jy ↔ jy131 ↔ 别的），立刻按新 id 问一次：角标摆的数与
      // 归属核对都要跟着会话走，不能等下一轮 5 分钟轮询。上报写在共享链的 `trConvProviderId` 上
      // （模块级，不是组件 state）——头部插槽会随会话切换重挂载，用 state / 依赖挡不住重挂载，
      // 「每次挂载都问一句」会拿轮末那档（refresh=1 绕 5 分钟快照）白打平台。所以只在
      // **首次上报**与**真的换了一枚**时取数；之后轮询 / 轮末 / 力刷都用同一个 id。
      React.useEffect(() => {
        if (!sysOn || !trAsk || selProvider === '') return
        const first = trConvProviderId === ''
        const changed = trConvProviderId !== selProvider
        trConvProviderId = selProvider
        if (!first && !changed) return
        // 走 refresh=1：换回的那一枚要**当场**给出新快照，而归属匹配表按密钥指纹分桶
        // （换 provider 就是换指纹，天然不命中），没必要像账号动作那样连表一起清。
        void refreshTrKeyBalance({ provider: selProvider, reuseMatch: true })
      }, [sysOn, trAsk, selProvider])
      // 轮末判据与替身 NO_SESSION_HOOK 与另两枚**共用同一份实现**（见 StepHeaderPlan 上方），
      // 这里只是第三个调用点——绝不新写第二条「上一帧在跑、这一帧不跑」的判据。
      const useSession = typeof props.useSession === 'function' ? props.useSession : NO_SESSION_HOOK
      const running = useSession((st) => !!(st && st.running)) === true
      const wasRunning = React.useRef(running)
      React.useEffect(() => {
        const was = wasRunning.current
        wasRunning.current = running
        if (!turnJustEnded(was, running) || !sysOn || !trConv) return
        // 归属没变，只要新快照：走 refresh=1（host 侧复用 10 分钟归属匹配缓存、只绕余额那
        // 5 分钟）。请求自带 host 侧单飞，连续两轮挨得再近也不会并发打两次平台。
        void refreshTrKeyBalance({ provider: selProvider, reuseMatch: true })
      }, [running, sysOn, trConv, selProvider])
      const [tabsRow, setTabsRow] = React.useState(null)
      // 与另两枚同款：无 deps 的 useLayoutEffect，每次 commit 找一遍页签行（行可能被整行重建）。
      React.useLayoutEffect(() => {
        const el = pass ? findConversationTabsRow() : null
        if (el !== tabsRow) setTabsRow(el)
      })
      if (!pass) return null
      const ok = r.ok === true
      const kh = ok && r.key ? r.key : null
      const acc = r.account && typeof r.account === 'object' ? r.account : null
      const cny = (v) => (typeof v === 'number' && Number.isFinite(v) ? '¥' + fmtCny(v) : null)
      const balText = acc === null ? null : cny(acc.balanceCny)
      // 低余量：复用基元自己的 alertOf（可用余额 < ¥10）——只取它的 low，临期那半与「钱」无关。
      const alert = acc === null ? null : alertOf({
        availableBalanceCny: acc.availableBalanceCny,
        expiringBalanceCny: acc.expiringBalanceCny,
        nextExpiryAt: acc.nextExpiryAt,
      })
      const low = alert !== null && alert.low === true
      const rows = []
      const row = (kText, vText) => { rows.push([kText, vText]) }
      if (!ok) {
        row('状态', r.error || '读不到本机在用的基元密钥')
      } else if (acc === null) {
        row('状态', r.accountError || '基元账户数据暂不可用')
      } else {
        // 悬停卡只讲**这个账号的账**：账户余额是主读数（与 chip 同一个数），限时额度与冻结
        // 只在真有读数且非 0 时才列——「缺失 ≠ 0」，没有的数不摆，也不拿 0 顶位。
        // 「这账是谁的」**不在这张卡里重复**：名字已经摆在 chip 上那个名字位里（与阶跃 /
        // OpenCSG 两枚同款，见下面 chip 构造处）。
        row('账户余额', balText === null ? '—' : balText)
        const exp = cny(acc.expiringBalanceCny)
        if (exp !== null && acc.expiringBalanceCny > 0) row('限时额度（到期失效）', exp)
        const frozen = cny(acc.frozenBalanceCny)
        if (frozen !== null && acc.frozenBalanceCny > 0) row('冻结', frozen)
        // 用的是哪把 key：只上名字（与阶跃/OpenCSG 同款隐私口径），归属坐实才有这行。
        if (kh !== null) row('使用密钥', typeof kh.keyName === 'string' && kh.keyName !== '' ? kh.keyName : '未命名密钥')
        // 明确核对过、但对不上：说明白（余额是本机绑定账号的账，不是这把 key 那个账号的）。
        // unknown（列表没读到）**不写任何一行**——私下的诊断结论不该往界面上摊。
        else if (r.keyLookup === 'miss') row('密钥归属', '不属于当前绑定账号')
        if (typeof acc.atMs === 'number' && acc.atMs > 0) row('数据更新于', fmtCheckedAt(acc.atMs))
      }
      const tip = React.createElement('div', { className: 'dsh-mb-hplan-tip' },
        rows.map((pair) => React.createElement('div', { className: 'dsh-mb-hplan-tr' },
          React.createElement('span', { className: 'dsh-mb-hplan-tk' }, pair[0]),
          React.createElement('span', { className: 'dsh-mb-hplan-tv' }, pair[1]))))
      // 名字位（与阶跃 / OpenCSG 两枚同格位、同类名 .dsh-mb-hplan-a）：平台用户名优先——
      // /api/me 的 name，正是面板「余额」页「数据账号：Ali」用的那一份，由 5 分钟常驻轮询随
      // provider 名单一起同步进 cross-component store（角标读不到面板组件自己的 manifest state）。
      // 名字没读到就退回登录手机号并**打码**（明文标识符一律不上界面）；两个都缺则整个名字位
      // 不渲染——缺失 ≠ 0，既不摆空占位，也不编一个「未命名账户」。
      // 灰 chip（这一帧没读到余额）名字照摆：名字是会话账号的属性，与有没有读到钱无关。
      const whoName = typeof s.trAccountName === 'string' ? s.trAccountName : ''
      const whoAcct = typeof s.trAccount === 'string' ? s.trAccount : ''
      const who = whoName !== ''
        ? whoName
        : whoAcct.replace(/^(\d{3})\d+(\d{4})$/, '$1****$2')
      const chip = React.createElement('div', {
        // 修饰类叫 -trb 不叫 -tr：`.dsh-mb-hplan-tr` 早被**悬停提示行**占用了（下面的
        // `display:flex;gap:…` 那条），拿它当 chip 修饰类会让 chip 吃上提示行的行样式。
        className: 'dsh-mb-hplan dsh-mb-hplan-trb'
          + (balText === null ? ' off' : '') + (low ? ' low' : ''),
      },
        // 状态点：与阶跃 / OpenCSG 同一颗、同一套 CSS。没读到余额时 chip 置灰 → 点也跟着变灰
        // （三态里最没信息量的那一档），正好不会把「没数」误读成「正常」。
        React.createElement('span', { className: 'dsh-mb-hplan-d' }),
        who !== '' ? React.createElement('span', { className: 'dsh-mb-hplan-a' }, who) : null,
        // 钱没有分母：不画进度条（阶跃那枚的像素一字未动）。
        React.createElement('span', { className: 'dsh-mb-hplan-v' }, balText === null ? '—' : balText),
        tip)
      return tabsRow === null ? null : ReactDOM.createPortal(chip, tabsRow)
    }

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
      const profiles = stepAccs.profiles || {}
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
        // 用户资料（devcenter UserInfo）：头像 URL / 昵称（=平台用户名）/ 实名状态。
        // 还没查到（没进 profiles 槽）时三项都不渲染——留空不是编「未实名」；
        // 资料失败也不顶掉旧值（refreshStepAccount 失败不写槽，同 plan 的 stale 口径）。
        const prof = profiles[u] && profiles[u].ok !== false && profiles[u].profile ? profiles[u].profile : null
        const nick = prof && typeof prof.nickname === 'string' && prof.nickname !== '' ? prof.nickname : null
        const rn = prof && prof.realName ? prof.realName : null
        const hasPlan = !!(p && p.ok !== false && (p.plan || p.credit))
        const hasBal = !!(b && b.ok !== false && b.account)
        const queried = hasPlan || hasBal
        const isBusy = busy[u] === true
        const open = stepOpen[u] === true
        const rows = []

        // 顶行：头像 + 名字行（用户名 → 实名徽章）+ 登录手机号 + 密码胶囊（「显示」按钮前）
        // + 显示/删除
        const confirming = stepAccConfirm === u
        rows.push(React.createElement('div', { className: 'dsh-mb-stepacc-top', key: 'top' },
          // 头像：有真头像（host 代理字节）时 img 绝对定位盖住字母兜底；加载失败由
          // onError 加 .off 隐藏破图 → 字母显出来。字母取昵称首字符（无昵称退「阶」）。
          React.createElement('span', {
            className: 'dsh-mb-stepacc-ava',
            title: nick !== null ? '平台用户名：' + nick : '阶跃账号',
          },
            nick !== null ? nick.charAt(0).toUpperCase() : '阶',
            prof && prof.avatarUrl !== ''
              ? React.createElement('img', {
                key: 'img', alt: '',
                src: API + '/stepfun/avatar?username=' + encodeURIComponent(u),
                onError: (e) => { e.currentTarget.classList.add('off') },
              })
              : null),
          // 名字行只放「未查询」角标。「显示中」不在这里重复——右侧按钮位已经写着
          // 「显示中」，同一个词紧挨着出现两遍纯属噪音；显示态的观感由 .cur 的
          // 主色描边 + 淡底 + 左侧竖条承担。
          React.createElement('div', { className: 'dsh-mb-stepacc-id' },
            React.createElement('div', { className: 'dsh-mb-stepacc-name' },
              // 昵称查到 → 昵称为主，登录身份（掩码手机号/邮箱）挪到顶行「密码」前面；
              // 没查到 → 登录身份留在这里顶主位（唯一显示名），不编「—」。
              nick !== null
                ? React.createElement('span', { key: 'nick', className: 'dsh-mb-stepacc-nick', title: '平台用户名（昵称）' }, nick)
                : null,
              // 实名徽章紧跟用户名（用户指定顺序：用户名 → 已实名）。
              // 资料在才画；二态收敛（0.6.2 用户指定：阶跃实名只有已实名和未实名，
              // 颜色与基元徽章同口径）——已实名绿（返回码 2）/ 其余中性灰；返回码 1
              // （审核中）也显示「未实名」、语义进 tooltip；未知码仍显示「状态 N」，
              // 绝不硬编。
              rn && rn.text !== null
                ? React.createElement('span', {
                  key: 'rn',
                  className: 'dsh-mb-stepacc-rn' + (rn.verified ? ' ok' : ' no'),
                  title: '实名认证状态' + (rn.code === 1 ? '：审核中' : '') + (Number.isFinite(rn.code) ? '（平台返回码 ' + rn.code + '）' : ''),
                }, rn.verified ? '已实名' : (rn.code === 1 ? '未实名' : rn.text))
                : null,
              // 登录身份兜底：没查到资料时它就是这张卡的显示名（旧行为），顶主位
              nick !== null ? null : React.createElement('span', {
                key: 'idsec', className: '',
                title: '登录身份',
              }, u),
              queried ? null
                : React.createElement('span', {
                  className: 'dsh-mb-stepacc-unq',
                  title: '这个账号还没查过——点右上角「查询余额」，或卡片上的「查询此账号」',
                }, '未查询'))),
          // 登录手机号（掩码）：顶行「密码」前面（用户指定顺序：手机号 → 密码 → 显示）。
          // 查到昵称才挪出来——没查到资料时它是唯一显示名，留在名字行顶主位。
          nick !== null
            ? React.createElement('span', {
              key: 'idsec', className: 'dsh-mb-stepacc-idsec', title: '登录身份',
            }, u)
            : null,
          // 密码胶囊：「显示」按钮前（上一轮指定），默认打码，点一下才显明文（同一时刻只展开一个）
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
        // 「波峰波谷计价」tag（平台 plan-subscribe 订阅状态旁同款标识，琥珀 tag）：
        // 判据 GetStepPlanStatus 顶层 billing_mode === PEAK_VALLEY（实测用户的 Mini 订阅回 2）。
        // 只有这一态才画——平台对 STANDARD（标准计价）什么都不画，这里一比一。
        // 峰值口径按平台同一页 FAQ「分时段差异计费」原文：高峰时段（北京时间周一至五，
        // 不含法定节假日）9:00-12:00、14:00-18:00，Step-5-Preview 的 credits 消耗速率 ×2。
        const pv = queried && hasPlan && p.plan && p.plan.billingMode === 'PEAK_VALLEY'
        const pvNow = (() => {
          const bj = new Date(Date.now() + 8 * 3600000) // 北京时间 = UTC+8；用 UTC 读数取时/分/星期
          const day = bj.getUTCDay() // 0=周日 … 6=周六
          const hm = bj.getUTCHours() * 60 + bj.getUTCMinutes()
          // 端点按半开区间：12:00 整与 18:00 整进不了高峰（平台写的是 9:00-12:00 / 14:00-18:00）
          const peak = day >= 1 && day <= 5 && ((hm >= 540 && hm < 720) || (hm >= 840 && hm < 1080))
          const hhmm = (n) => (n < 10 ? '0' + n : '' + n)
          return {
            peak,
            at: '北京时间 周' + '日一二三四五六'[day] + ' ' + hhmm(bj.getUTCHours()) + ':' + hhmm(bj.getUTCMinutes()),
          }
        })()
        const pvTip = '波峰波谷计价（平台 Step Plan 的分时段差异计费）\n'
          + '高峰时段（北京时间周一至周五，不含中国法定节假日）：9:00-12:00、14:00-18:00 —— '
          + '调用 Step-5-Preview 时 credits 消耗速率 ×2，空闲时段不变\n'
          + '其余时段（午休、晚间、周末、法定节假日全天）均为空闲时段\n'
          + '现在：' + (pvNow.peak ? '高峰时段' : '空闲时段') + '（' + pvNow.at + '；'
          + '法定节假日插件不判，节假日请以平台为准）'
        // Credit 格次级行：左「到期」右「已用 X · 共 Y」两端对齐。续费开关那一项
        // 整条下架——它是设置项不是用量信息，用户两次要求删它。「已用/共」原先在
        // 卡片级图例行里、与到期分行；用户要求并到到期的同一行、两端对齐。
        // 到期也可能没有（平台没给 expired_at）：此时只剩右半，用量靠
        // margin-left:auto 恒贴右端，位置不漂。两半都没有时整行**不渲染**：
        // 留一行空高度 + margin 反而看着像没加载完。
        const exp = hasPlan && p.plan && p.plan.expireAt ? fmtStepDate(p.plan.expireAt) : null
        const planBits = []
        if (exp) planBits.push(exp + ' 到期')
        const usageTxt = credit ? '已用 ' + fmtTokens(credit.used) + ' · 共 ' + fmtTokens(credit.total) : null
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
            // 「波峰波谷计价」与百分比同排贴右：它是这份月池的「烧速口径」（高峰 ×2），
            // 摆在月池数旁边语义最贴。**不放 krow**：400px 窄格下 krow 三件（标签 + tag +
            // 重置胶囊）会把「Credit 月池」标签挤成省略号（无头 Chrome 实测 45.6px→「Cred…」），
            // 而标签是理解这一格的锚、重置胶囊是既有信息，两者都不该让位。
            // 右缘 margin-left:auto，与上方重置胶囊右缘对齐成一列。
            React.createElement('div', { className: 'vrow', key: 'vrow' },
              React.createElement('span', { className: 'v', title: creditTip }, pct === null ? '—' : pct + '%'),
              pv ? React.createElement('span', { className: 'dsh-mb-stepacc-pv', key: 'pv', title: pvTip }, '波峰波谷计价') : null),
            React.createElement('span', { className: 'bar', title: creditTip },
              React.createElement('i', { style: { width: (share === null ? 0 : share * 100) + '%' } })),
            queried
              ? (planBits.length > 0 || usageTxt
                ? React.createElement('span', { className: 'sub split' },
                  planBits.length > 0 ? React.createElement('span', { className: 'sl' }, planBits.join(' · ')) : null,
                  usageTxt ? React.createElement('span', { className: 'sr', title: creditTip }, usageTxt) : null)
                : null)
              : React.createElement('span', { className: 'sub' }, '尚未查询 · 切换或点查询后显示'))))

        // 图例：只剩加油包——「已用/共」已并入 Credit 格次级行的右端（两端对齐），
        // 再留在图例行就是同一数据两处出现。没有加油包时整行不渲染。
        const legend = []
        if (credit && hasPlan && p.credit && p.credit.hasTopup) {
          const tb = (p.credit.buckets || []).find((x) => x.type === 2)
          if (tb) legend.push('加油包 ' + fmtTokens(tb.residual) + (tb.expireAt ? ' · ' + (fmtStepDate(tb.expireAt) || '') + ' 到期' : ''))
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
    function renderStepKeysTab({ stepKeys, stepKeyName, setStepKeyName, stepKeyBusy, stepKeyMsg, stepKeyCreated, stepKeyCopied, stepKeyConfirm, createStepKey, copyStepCreatedKey, copyStepKey, deleteStepKey, loadStepKeys, stepKeyUseConfirm, useStepKey, stepKeyPlan }) {
      // 「使用中」判定：key-plan 反查出的在用 key（keyId + 归属账号）与本行是同一条。
      const isActiveKey = (k) => !!(stepKeyPlan && stepKeyPlan.ok === true && stepKeyPlan.key
        && String(stepKeyPlan.key.keyId) === String(k.keyId)
        && stepKeyPlan.key.username === ((stepKeys && stepKeys.account) || ''))
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
          (stepKeys.list || []).map((k) => React.createElement('div', { className: 'dsh-mb-key-card' + (isActiveKey(k) ? ' active' : ''), key: k.keyId || k.masked },
            React.createElement('div', { className: 'dsh-mb-key-card-top' },
              React.createElement('span', { className: 'dsh-mb-key-card-name' }, k.name || '未命名'),
              isActiveKey(k) ? React.createElement('span', { className: 'dsh-mb-badge on', title: 'DSH 当前实际使用这一把（凭据文件 STEP_API_KEY 的归属）' }, '使用中') : null,
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
            React.createElement('div', { className: 'dsh-mb-key-actions' },
              isActiveKey(k) ? null : React.createElement('button', {
                className: 'dsh-mb-key-copy' + (stepKeyUseConfirm === k.keyId ? ' armed' : ''),
                disabled: stepKeyBusy,
                title: stepKeyUseConfirm === k.keyId
                  ? '再点一次确认切换——DSH 之后所有阶跃调用立即改走这把 key'
                  : '把 DSH 实际使用的 key 切换为这一把（写入宿主凭据文件，立即生效）',
                onClick: () => useStepKey(k),
              }, stepKeyUseConfirm === k.keyId ? '确认切换' : '设为使用'),
              React.createElement('button', {
                className: 'dsh-mb-key-copy danger' + (stepKeyConfirm === k.keyId ? ' armed' : ''),
                disabled: stepKeyBusy,
                title: stepKeyConfirm === k.keyId ? '再点一次确认删除' : '删除该密钥',
                onClick: () => deleteStepKey(k),
              }, stepKeyConfirm === k.keyId ? '确认删除' : '删除'),
            ),
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

    // ---- 设置页签（右上角齿轮进入）：系统管理 + 账号卡片 + 会话状态 + 折叠的备用粘贴 ----
    function renderSettingsTab({ manifest, sessionConfigured, sessionAccount, cookieInput, setCookieInput, cookieBusy, cookieMsg, saveCookie, accounts, addAcc, setAddAcc, addPw, setAddPw, showAddPw, setShowAddPw, accBusy, accMsg, addAccount, removeAccount, loginStored, showAccPw, accPwVal, revealAccPw, showBackup, setShowBackup, updInfo, updBusy, loadUpdate, copyUpdateCmd, updCopied, ignoreUpdate, entryMode, setEntryBalance, tfEntryMode, setTfEntryMode, ocEntryMode, setOcEntryMode, systems, setSystem, sysMsg, sysOrder, sysDrag, onSysRowDown, settingsTab, setSettingsTab, stepCfg, setStepEntryPref }) {
      // 分组页签跟着「启用的系统」走（用户定稿 2026-10-09：「设置里面的卡不会随着选的系统
      // 增加减少」）。「系统管理」永远第一位、永远在（它是开关本身）；基元 / 阶跃两组都是
      // **条件组**：没勾那家，这一组连同它下面的卡一起消失，不再留一组属于已关系统的设置
      // （原来是硬编码的 `[['sys'], ['tr']]`，取消勾选基元后「基元」组和三张卡还赖着）。
      // 阶跃组是双条件：已配置 + 已勾选（那一组只剩「接管时胶囊显示」，没配/没勾都是空页）。
      // 清枢组同为条件组（已勾选才有）：它只有「接管时胶囊显示」这一张卡——账号维护不在这里，
      // 而在面板「账户」页签（加账号即配置），此处**只放显示口径**，不要往里搬账号管理。
      // 条件组按「设置 → 系统管理」里拖出来的顺序排（orderBySys），但**头尾固定**：
      // 「系统管理」永远第一位（它本身就是那组开关）、「关于」永远最后一位。
      const settingsTabs = [['sys', '系统管理']]
        .concat(orderBySys([
          ['tr', '基元', systems.tr],
          ['step', '阶跃', stepCfg && stepCfg.configured && systems.step],
          ['tf', '清枢', systems.tf],
          ['oc', 'OpenCSG', systems.oc],
        ].filter((r) => r[2]).map((r) => [r[0], r[1]]), normalizeSysOrder(sysOrder)))
        .concat([['about', '关于']])
      // 当前分组若已不存在（另一个窗口刚把这家关掉、或 host 轮询回灌），渲染回落到「系统管理」：
      // 不摆一个空弹窗，也不假装那一组还在。state 不动——那家再勾上时这一组自然回来。
      const tab = settingsTabs.some(([id]) => id === settingsTab) ? settingsTab : 'sys'
      return React.createElement('div', { className: 'dsh-mb-section' },
        React.createElement('div', { className: 'dsh-mb-seg-line', style: { flexWrap: 'wrap' } },
          settingsTabs.map(([id, label]) => React.createElement('button', {
            key: id,
            className: 'dsh-mb-cat' + (tab === id ? ' active' : ''),
            onClick: () => setSettingsTab(id),
          }, label))),
        // ---- 系统管理：哪几家能在面板里出现。默认只勾基元；阶跃 / ZCode / 清枢智汇 / OpenCSG 勾上后
        // 切换器与对应页签才出现。五个开关是「选中」语义（整行可点，勾在框里），至少留一个——
        // 取消最后一个会被拦下并给提示（host 也不接受全关的 prefs）。
        // 每行右侧只列**这家自己的页签**，不再写说明段落（用户定稿 2026-10-09）。
        // 行首把手用来拖动排序：顺序存 prefs.sysOrder，同时决定行序、切换器分段与设置分组页签。
        ...(tab === 'sys' ? [
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'systems' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '启用的系统'),
          // 行序 = 拖出来的顺序（默认仍是 SYS_KEYS 原序，观感与加这个功能之前一致）
          normalizeSysOrder(sysOrder).map((id) => {
            const on = systems[id] === true
            return React.createElement('button', {
              key: id,
              className: 'dsh-mb-sys-row' + (on ? ' on' : '') + (sysDrag === id ? ' dragging' : ''),
              'aria-pressed': on ? 'true' : 'false',
              onPointerDown: (e) => onSysRowDown(e, id),
              onClick: () => {
                // 刚拖过就别把这次松手当成一次勾选（pointerup 之后浏览器必定补一个 click）
                if (sysDragMoved) { sysDragMoved = false; return }
                setSystem(id, !on)
              },
            },
              // 行首那枚「⠿」只是**看得见的提示**（整行都能拖）：它带 touch-action:none，
              // 所以触屏用户抓这里不会被面板滚动抢走。aria-hidden：读屏念「⠿ 按住拖动」既
              // 无意义也打断流水，顺序对读屏用户靠 DOM 顺序即可。
              React.createElement('span', {
                className: 'dsh-mb-sys-grip',
                title: '按住整行拖动调整顺序',
                'aria-hidden': 'true',
              }, '⠿'),
              React.createElement('span', { className: 'dsh-mb-sys-box', 'aria-hidden': 'true' }, on ? '✓' : ''),
              React.createElement('span', { className: 'dsh-mb-sys-name' }, SYS_NAME[id]),
              React.createElement('span', { className: 'dsh-mb-sys-tabs' },
                SYS_TABS[id].map((t) => React.createElement('span', { className: 'dsh-mb-sys-tab', key: t }, t))),
            )
          }),
          sysMsg ? React.createElement('div', { className: 'dsh-mb-cookie-msg err' }, sysMsg) : null,
        ),
        ] : []),
        ...(tab === 'tr' ? [
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
                      // 实名徽章只挂当前会话行（0.6.2）：基元是单会话（state.cookie 一次
                      // 只有一个），别的账号没有各自会话——不渲染、不编数据。
                      cur ? rnBadge((manifest && manifest.session && manifest.session.realname) || null) : null,
                      cur ? React.createElement('span', { className: 'dsh-mb-acc-cur' }, '当前') : null),
                    React.createElement('div', { className: 'dsh-mb-acc-pw' },
                      // 基元池可能有「未存密码」的条目（历史 cookie 粘贴存档）：pwMask 为空就是没有，
                      // 显示文案而不是一排点（与阶跃「未存密码」同一判读）。
                      a.pwMask === '' ? '未存密码' : (showAccPw === a.account ? accPwVal : a.pwMask)),
                  ),
                  React.createElement('button', {
                    className: 'dsh-mb-key-copy icon', disabled: a.pwMask === '',
                    title: a.pwMask === '' ? '该账号没有保存密码' : (showAccPw === a.account ? '隐藏密码' : '显示密码'),
                    onClick: () => revealAccPw(a.account),
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
        ...(tab === 'tr' ? [
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
        ...(tab === 'tr' ? [
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
        ...(tab === 'step' ? [
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
        ...(tab === 'tf' ? [
        // 胶囊接管（清枢智汇）：口径四选一。默认 total —— 平台 /api/user/self 的 quota 折算成 ¥，
        // 也就是这一组出现之前的行为（老存档读到的 entryTfMode 认不出就回落 total）。
        // 「接管 / 不接管」不设开关：与阶跃同款，**接管是唯一行为**（面板切到清枢，胶囊就认清枢）。
        // 四个口径的数据来源与展示方式见 computeTfEntry：后两个读「当前生效套餐」，没有生效套餐
        // 就是空胶囊（不落回基元的钱）。
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'pilltf' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '胶囊接管（清枢智汇）'),
          React.createElement('div', { className: 'dsh-mb-seg-line', key: 'tfmode' },
            React.createElement('span', { className: 'dsh-mb-seg-desc' }, '清枢接管时胶囊显示'),
            // 四个 chip 比阶跃那行宽（「套餐 token」最长），窄面板下让它们自己折一行，
            // 别把卡片撑出去（.dsh-mb-seg-row 是 flex:none，默认不折）
            React.createElement('span', { className: 'dsh-mb-seg-row', style: { flexWrap: 'wrap', justifyContent: 'flex-end' } },
              TF_ENTRY_MODE_LABELS.map(([m, label]) =>
                React.createElement('button', {
                  key: m,
                  className: 'dsh-mb-cat' + (tfEntryMode === m ? ' active' : ''),
                  onClick: () => setTfEntryMode(m),
                }, label)),
            )),
        ),
        ] : []),
        ...(tab === 'oc' ? [
        // 胶囊接管（OpenCSG）：口径三选一（账户余额 / API 调用量 / 待发放余额）。默认 balance
        // ——现金余额（balanceCents ÷ 100），也就是最直白的那个口径（老存档读到的 entryOcMode
        // 认不出就回落 balance，含 0.7.0 那两个已废弃的 vip / usage）。
        // 「接管 / 不接管」同样不设开关：与阶跃 / 清枢同款，**接管是唯一行为**（面板切到
        // OpenCSG，胶囊就认 OpenCSG）。三个口径的数据来源与展示方式见 computeOcEntry：
        // 三者同吃一份 /opencsg/account 快照，拿不到就是空胶囊（不落回基元的钱）。
        React.createElement('div', { className: 'dsh-mb-set-card', key: 'pilloc' },
          React.createElement('div', { className: 'dsh-mb-set-title' }, '胶囊接管（OpenCSG）'),
          React.createElement('div', { className: 'dsh-mb-seg-line', key: 'ocmode' },
            React.createElement('span', { className: 'dsh-mb-seg-desc' }, 'OpenCSG 接管时胶囊显示'),
            // 「API 调用量 / 待发放余额」比原来那三个 chip 都长，窄面板下让它们自己折一行，
            // 别把卡片撑出去（.dsh-mb-seg-row 是 flex:none，默认不折）
            React.createElement('span', { className: 'dsh-mb-seg-row', style: { flexWrap: 'wrap', justifyContent: 'flex-end' } },
              OC_ENTRY_MODE_LABELS.map(([m, label]) =>
                React.createElement('button', {
                  key: m,
                  className: 'dsh-mb-cat' + (ocEntryMode === m ? ' active' : ''),
                  onClick: () => setOcEntryMode(m),
                }, label)),
            )),
        ),
        ] : []),
        ...(tab === 'about' ? [
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
      // 清枢接管时胶囊要的清枢数也走这一轮（面板关着也查）：基元余额正是靠它常驻的，清枢没理由
      // 只在面板打开时才有数——那样面板一关，胶囊上的数就再也不更新了。
      ctx.effect(() => {
        let timer = null
        let stopped = false
        const check = async () => {
          if (stopped) return
          const m = await jsonGet(API + '/manifest')
          // host 名册里「可查基元余额」的 provider id 名单（manifest 的 providers 段就是这一份：
          // 多枚共用同一个 baseURL 的短键 jy / jy131 全在里面）。角标靠它判「这个会话在用的
          // provider 是不是基元」——没有它，用户给 provider 起的短键对不上任何产品名，
          // 角标就会在真的在用基元时整枚不出现（v0.7.3 修的正是这个）。只在真的变了时才写回，
          // 否则每 5 分钟换一个数组引用，角标那个「换 provider 就立刻取一次」的 effect 会空跑。
          if (m && m.ok && Array.isArray(m.providers)) {
            const ids = m.providers.map((x) => (x && typeof x.id === 'string' ? x.id : '')).filter((id) => id !== '')
            const cur = store.trProviderIds
            const same = Array.isArray(cur) && cur.length === ids.length && cur.every((id, i) => id === ids[i])
            if (!same) setStore({ trProviderIds: ids })
          }
          // 当前登录的基元账号（登录手机号）与平台用户名（/api/me 的 name，manifest.session.accountName）：
          // 基元角标的悬停卡要写「这账是谁的」，而面板把 manifest 放在自己组件的 state 里、角标拿不到，
          // 所以随名单一起同步进共享 store。同样只在真的变了时才写回——否则每 5 分钟换一次引用，
          // 白白惊动所有订阅者。
          if (m && m.ok && m.session) {
            const acct = typeof m.session.account === 'string' ? m.session.account : ''
            const acctName = typeof m.session.accountName === 'string' ? m.session.accountName : ''
            if (store.trAccount !== acct || store.trAccountName !== acctName) {
              setStore({ trAccount: acct, trAccountName: acctName })
            }
          }
          // 轻量偏好与「启用的系统」跟基元会话无关，先同步：清枢 / ZCode-only 的用户原先会被
          // 下面那道基元门整段跳过，于是开关与胶囊口径一直停在旧值上（另一个窗口改了也跟不上）。
          const p = await jsonGet(API + '/prefs')
          if (p && p.ok && p.prefs) {
            if (p.prefs.entryBalance === 'total' || p.prefs.entryBalance === 'expiring') {
              setStore({ entryBalMode: p.prefs.entryBalance })
            }
            // 清枢胶囊口径：只在真的变了时重算（否则每 5 分钟白刷一次 store）。这里**只同步**，
            // 不回写 host——回写会拿本机旧值盖掉 host 的新值。
            if (p.prefs.entryTfMode !== undefined && normalizeTfEntryMode(p.prefs.entryTfMode) !== tfPill.mode) {
              applyTfEntryMode(p.prefs.entryTfMode, false)
            }
            // OpenCSG 胶囊口径：同清枢那条——只在真的变了时重算，且只同步不回写
            if (p.prefs.entryOcMode !== undefined && normalizeOcEntryMode(p.prefs.entryOcMode) !== ocPill.mode) {
              applyOcEntryMode(p.prefs.entryOcMode, false)
            }
            setStore({ systems: normalizeSystems(p.prefs.systems, p.prefs.zcode) })
            // 顺序也可能是另一个窗口刚拖过的（这里只同步、不回写）
            if (Array.isArray(p.prefs.sysOrder)) setStore({ sysOrder: normalizeSysOrder(p.prefs.sysOrder) })
          }
          // 当前显示的就是清枢 → 把胶囊要的那份取回来（与两个页签各自的 60s 轮询共用 host 侧
          // 缓存与单飞，这里只保证「面板关着也有数」）。只有口径落「套餐余额 / 套餐 token」时
          // 才多取套餐那一份，别白打一次平台。
          if (normalizeSystems(store.systems).tf && store.provider === 'tf') {
            const u = await jsonGet(API + '/tierflow/user')
            tfPill.user = u && u.ok ? u : null
            const tm = tfPill.mode
            if (tm === 'planMoney' || tm === 'planToken') {
              const sub = await jsonGet(API + '/tierflow/subscription')
              if (sub && sub.ok) tfPill.sub = sub
            }
            setStore({ tfEntry: computeTfEntry(tfPill.user, tfPill.sub, tm) })
          }
          // 当前显示的就是 OpenCSG → 把胶囊要的那份账户快照取回来（与账户页 / 用量页各自的
          // 60s 轮询共用 host 侧 5 分钟缓存与单飞，这里只保证「面板关着也有数」）。
          // 三个口径同吃这一份 /opencsg/account，所以固定只取一次，不按口径分支——比清枢省一次
          // 可能的 /subscription。**这一段必须在下面那道基元门之前**：基元没配好的人也要有数
          // （清枢当初就是踩了这个坑才挪上来的）。
          if (normalizeSystems(store.systems).oc && store.provider === 'oc') {
            const acc = await jsonGet(API + '/opencsg/account')
            ocPill.account = acc && acc.ok ? acc : null
            setStore({ ocEntry: computeOcEntry(ocPill.account, ocPill.mode) })
          }
          // 启用了阶跃 → 取「DSH 当前使用的那把阶跃密钥」对应的套餐（对话头部角标用）。
          // 与清枢 / OpenCSG 同口径：面板关着也有数（否则一关面板角标就停更）；没启用就
          // 清空，绝不留旧值在头部。host 侧带 10 分钟指纹缓存，这轮多数是命中缓存。
          if (normalizeSystems(store.systems).step) {
            const kp = await jsonGet(API + '/stepfun/key-plan')
            setStore({ stepKeyPlan: kp || null })
          } else if (store.stepKeyPlan !== null) {
            setStore({ stepKeyPlan: null })
          }
          // 启用了 OpenCSG → 取「DSH 当前使用的那把 OpenCSG 密钥」归属账号的账户快照
          // （对话头部角标显示余额用，v0.7.3）。上面那段阶跃口径逐字照搬：10 分钟指纹缓存
          // + 5 分钟账户缓存，稳态这轮零上游请求；没启用就清空，绝不留旧值在头部。
          if (normalizeSystems(store.systems).oc) {
            const ka = await jsonGet(API + '/opencsg/key-account')
            setStore({ ocKeyAccount: ka || null })
          } else if (store.ocKeyAccount !== null) {
            setStore({ ocKeyAccount: null })
          }
          // 启用了基元 → 取「DSH 当前使用的那把基元密钥」对应账号的账户余额（对话头部角标
          // 显示余额用，v0.7.3）。与上面三家的口径逐字一致：面板关着也有数（否则一关面板角标
          // 就停更）；没启用就清空，绝不留旧值在头部。host 侧带 10 分钟归属缓存 + 5 分钟余额
          // 缓存（还带单飞），稳态这轮零上游请求。
          // **会话没配好就不问**（这里自带一道门，不靠下面那段 return）：粘贴 Cookie 是
          // 基元的唯一会话来源，清掉之后 host 那条路会拿绑定账号自动重登——用户刚清掉的会话
          // 又被悄悄登回来，那是比「角标少个数据」严重得多的错。没会话就说没会话。
          if (normalizeSystems(store.systems).tr && m && m.ok && m.session && m.session.configured) {
            // 带上「这个会话在用哪一枚基元 provider」（角标记下的那个 id）——名册里可能有多枚
            // 共用同一个 baseURL 的短键，不点名 host 只会查第一枚，归属核对就是核错了钥匙。
            // 角标还没上报过（面板关着开的应用、或这会话压根不是基元）→ 不带，host 退回第一枚。
            const tb = await jsonGet(API + '/tr/key-balance' + trProviderQuery())
            setStore({ trKeyBalance: tb || null })
          } else if (store.trKeyBalance !== null) {
            setStore({ trKeyBalance: null })
          }
          // 基元没启用（或会话没配好）就不查基元的账：省一次请求，也不让旧余额留在胶囊里
          // （胶囊已按 systems 门控）
          if (!m || !m.ok || !m.session || !m.session.configured) {
            setStore({ alert: null, balanceCny: null, expiringItems: [] })
            return
          }
          if (!normalizeSystems(store.systems).tr) {
            setStore({ alert: null, balanceCny: null, expiringItems: [] })
            return
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

      // ---- 对话头部角标：当前对话在用阶跃模型 → 该 key 的套餐剩余进度条 ----
      // 挂 conversation.session.header.utilities（list 槽，可多家共用）。不用 `corner`：
      // 那是 single 槽，已被 DSH 自己的右栏展开按钮占住。宿主没这个槽时 inject 静默不生效，
      // 面板与其它注入照常。
      // 这里**不需要**任何可选服务：该槽把 useProjection 作为标准 prop 交给每个条目，组件
      // 自己就能读到会话的模型选择（见 StepHeaderPlan 上的注释）。所以维持最朴素的注册。
      ctx.effect(() => slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'tokenrhythm-bill-step-plan', order: 50 },
        (props) => React.createElement(StepHeaderPlan, props),
      )), 'tokenrhythm-bill: header step plan');

      // ---- 对话头部角标（OpenCSG，v0.7.3）：当前对话在用 OpenCSG 模型 → 该账号的账户余额 ----
      // 同一 list 槽的第二枚条目：两家的门控都折在「会话当前 provider 是自己家」上，一次
      // 选择只命中一家，页签行右端永远只有**一枚**角标，不抢位也不叠位。
      ctx.effect(() => slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'tokenrhythm-bill-oc-balance', order: 55 },
        (props) => React.createElement(OcHeaderPlan, props),
      )), 'tokenrhythm-bill: header oc balance');

      // ---- 对话头部角标（基元，v0.7.3）：当前对话在用基元模型 → 本机绑定账号的账户余额 ----
      // 同一 list 槽的第三枚条目。三家的门控都折在「会话当前 provider 是自己家」上，一次选择
      // 只命中一家，页签行右端永远只有**一枚**角标，不抢位也不叠位。order 在 OC 之后（60）：
      // 数值本身互不影响，这个次序只是让「三家都注册了、但只有一家的会话在跑」时 list 槽内的
      // 排位稳定可预期（与面板页签里基元排最后一致）。
      ctx.effect(() => slots.inject('conversation.session.header.utilities', () => slots.register(
        { name: 'conversation.session.header.utilities', id: 'tokenrhythm-bill-tr-balance', order: 60 },
        (props) => React.createElement(TrHeaderPlan, props),
      )), 'tokenrhythm-bill: header tr balance');

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
      // 计划模式那一种隐藏——完整论证见本地维护手册「模式切换通知这一条藏不掉」条（README 只列功能，
      // 不展开这类取舍）。
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
      /* .dsh-mb-hplan 是对话头部角标，同样不在面板子树内，也要自己挂变量桥接层。 */
      .dsh-mb-panel,.dsh-mb-entry,.dsh-mb-hov,.dsh-mb-composer,.dsh-mb-hplan{
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
      /* 「数据账号」段：状态圆点 + 账号名。它是页首行（.dsh-mb-topbar）里的左侧内容，
         靠 margin-right:auto 把右侧的「更新于 …」与刷新按钮顶到最右——两者同一行。 */
      .dsh-mb-acct-line{display:flex;align-items:center;gap:var(--mb-sp-2);min-width:0;
        font-size:var(--mb-fs-meta);color:var(--mb-sub);margin-right:auto}
      .dsh-mb-acct-txt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-acct-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--mb-ok)}
      .dsh-mb-acct-line.none .dsh-mb-acct-dot{background:var(--mb-warn)}
      /* 实名徽章（0.6.2）：紧跟数据账号名/设置页账号名——口径与 .dsh-mb-stepacc-rn 一致：
         已实名绿 / 审核中琥珀 / 未实名与未通过中性灰 / 平台实名门禁 blocked 转警示 */
      .dsh-mb-acct-rn{flex:none;font-size:var(--mb-fs-micro);font-weight:600;
        padding:var(--mb-sp-1) var(--mb-sp-2);border-radius:var(--mb-r-xs);
        color:var(--mb-tert);border:1px solid var(--mb-lineSoft);background:transparent}
      .dsh-mb-acct-rn.ok{color:color-mix(in srgb,var(--mb-ok) 80%,var(--mb-txt));
        border-color:color-mix(in srgb,var(--mb-ok) 45%,transparent);
        background:color-mix(in srgb,var(--mb-ok) 10%,transparent)}
      .dsh-mb-acct-rn.pend{color:var(--mb-warnTx);
        border-color:color-mix(in srgb,var(--mb-warn) 45%,transparent);
        background:color-mix(in srgb,var(--mb-warn) 10%,transparent)}
      .dsh-mb-acct-rn.warn{color:var(--mb-warnTx);
        border-color:color-mix(in srgb,var(--mb-warn) 60%,transparent);
        background:color-mix(in srgb,var(--mb-warn) 16%,transparent)}
      .dsh-mb-hero{display:flex;flex-direction:column;gap:var(--mb-sp-2);padding:var(--mb-sp-4);border-radius:var(--mb-r-card);
        border:1px solid color-mix(in srgb, var(--mb-acc) 25%, transparent);
        background:color-mix(in srgb, var(--mb-acc) 7%, transparent)}
      /* 生效中的那一份再抬一档：描边 25% → 55%、底色 7% → 12%，左侧补一条实心蓝轨。
         光靠徽章不够——清枢的「全部订阅」里每一张都是强调卡（hero 本身就是 accent 底），
         徽章只是个小胶囊，扫一屏时还是要有块面上的差别才挑得出来。蓝轨而不是整框加粗：
         整框加粗在两张卡挨着时看不出哪张更重，左轨是**方向性**的，一眼就分得开。 */
      .dsh-mb-hero.is-active{border-color:color-mix(in srgb, var(--mb-acc) 55%, transparent);
        background:color-mix(in srgb, var(--mb-acc) 12%, transparent);
        box-shadow:inset 3px 0 0 0 var(--mb-acc)}
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
      /* 「标签 + 值」并成一行（订阅卡右上的「剩余天数 30 天」，定稿「放在一行显示」）：基线对齐，
       * 12px 的标签挨着 20px 的数字，外层 .right 仍让整行贴右端；下面若有期限行，照旧单独一行。 */
      .dsh-mb-stat-line{display:flex;align-items:baseline;gap:var(--mb-sp-2)}
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
      /* 图例两端对齐：左组是事实（限时占比 / 冻结），右端固定挂「兑换码」入口。
         左组必须 min-width:0 才肯收窄，按钮才会被 space-between 顶到最右；窄面板下
         左组自己换行，按钮不被挤走。 */
      .dsh-mb-legend-bits{display:flex;align-items:center;flex-wrap:wrap;gap:var(--mb-sp-2);min-width:0}
      /* 图例行右端的**主数值 + 次量**（清枢「全部订阅」里两条「剩余 X」都用它，见 client 的
         tfBigVal）：用户定稿「全部订阅（2）的剩下的余额 突出显现」＋「token 的余量 也是 添加的
         颜色」——两个余量原来都跟标签同号同色（都是 11px 灰字），挤在一行里读不出重点。主数给到
         20px/600 **主色** + 等宽数字，字号与订阅卡右上「剩余天数 N 天」同档（--mb-fs-sub）；颜色
         取 --mb-acc，与正下方那条额度条的填充同色——条画的就是这个余量的占比，读数与条同色是
         一件事（不是新语义：主色在本插件里一直是「常规额度」的颜色，橙色才专属「限时」）。
         次量留 11px 灰字，只承担「/ 总额」这种分母说明。两者并排走 .dsh-mb-stat-line（基线对齐）。
         （这块注释不能带反引号：整个样式表是一个模板字符串，反引号会把它截断。） */
      .dsh-mb-legend-v{font-size:var(--mb-fs-sub);font-weight:600;line-height:1.15;white-space:nowrap;
        font-variant-numeric:tabular-nums;color:var(--mb-acc)}
      .dsh-mb-legend-sub{font-size:var(--mb-fs-meta);color:var(--mb-sub);white-space:nowrap;
        font-variant-numeric:tabular-nums}
      /* 「兑换码」入口：品牌色浅底胶囊。用户反馈原来的灰字描边太不显眼——这里给
         品牌色文字 + 12% 浅底 + 42% 描边（提升到 11px/600），够醒目但不抢主卡数字
         （主数字是 32px 实色，粗一层即可分层）。 */
      /* 卡内动作胶囊：兑换码入口（-redeem-btn）、订阅卡的「升级套餐」、清枢账号卡「限时占 x%」
         那一行右端的「购买订阅」（三处都用 -hero-btn）共用同一份配方，只写一处像素值——
         后面用它的地方不再抄一遍，日后改配方几处一起变。
         （这块注释不能带反引号：整个样式表是一个模板字符串，反引号会把它截断。） */
      .dsh-mb-redeem-btn,.dsh-mb-hero-btn{flex:none;cursor:pointer;height:24px;padding:0 var(--mb-sp-3);border-radius:999px;
        border:1px solid color-mix(in srgb,var(--mb-acc) 42%,transparent);
        background:color-mix(in srgb,var(--mb-acc) 12%,transparent);color:var(--mb-acc);font-family:inherit;
        font-size:var(--mb-fs-meta);font-weight:600;letter-spacing:.2px;
        transition:color .12s,background .12s,border-color .12s}
      .dsh-mb-redeem-btn:hover,.dsh-mb-hero-btn:hover{background:color-mix(in srgb,var(--mb-acc) 20%,transparent);
        border-color:color-mix(in srgb,var(--mb-acc) 60%,transparent)}
      .dsh-mb-redeem-btn:active,.dsh-mb-hero-btn:active{background:color-mix(in srgb,var(--mb-acc) 26%,transparent)}
      .dsh-mb-redeem-btn:focus-visible,.dsh-mb-hero-btn:focus-visible{outline:2px solid var(--mb-focus);outline-offset:1px}
      /* 图例行里的按钮永远贴右：左组没内容时也不被 space-between 顶到左边 */
      .dsh-mb-hero-btn{margin-left:auto}
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
      .dsh-mb-stepacc-ava{flex:none;display:inline-flex;align-items:center;justify-content:center;position:relative;overflow:hidden;
        width:28px;height:28px;border-radius:var(--mb-r-ctl);font-size:var(--mb-fs-body);font-weight:600;color:var(--mb-acc);
        background:color-mix(in srgb,var(--mb-acc) 13%,transparent)}
      /* 真头像：img 绝对定位盖住字母兜底；加载失败（防盗链/网络抖动）由 onError 加
         .off 隐藏破图 → 字母显出来，永远不留碎图标 */
      .dsh-mb-stepacc-ava img{position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;object-fit:cover}
      .dsh-mb-stepacc-ava img.off{display:none}
      /* 名字行：平台用户名（昵称）为主、实名徽章紧跟；登录身份（掩码手机号/邮箱）
         查到昵称时在顶行「密码」前（次级灰字），没查到资料时回这里顶主位 */
      .dsh-mb-stepacc-nick{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-stepacc-idsec{flex:none;font-size:var(--mb-fs-meta);font-weight:400;color:var(--mb-tert);
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* 实名徽章（0.6.2 二态收敛）：已实名绿、其余中性灰——审核中等中间态语义进
         tooltip；颜色与基元 .dsh-mb-acct-rn 同口径（那边保留平台四态含琥珀） */
      .dsh-mb-stepacc-rn{flex:none;font-size:var(--mb-fs-micro);font-weight:600;
        padding:var(--mb-sp-1) var(--mb-sp-2);border-radius:var(--mb-r-xs);
        color:var(--mb-tert);border:1px solid var(--mb-lineSoft);background:transparent}
      .dsh-mb-stepacc-rn.ok{color:color-mix(in srgb,var(--mb-ok) 80%,var(--mb-txt));
        border-color:color-mix(in srgb,var(--mb-ok) 45%,transparent);
        background:color-mix(in srgb,var(--mb-ok) 10%,transparent)}
      .dsh-mb-stepacc-id{flex:1;min-width:0;display:flex;flex-direction:column;gap:var(--mb-sp-1)}
      .dsh-mb-stepacc-name{display:flex;align-items:center;gap:var(--mb-sp-2);font-size:var(--mb-fs-body);font-weight:600;
        color:var(--mb-txt);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* 顶行右侧簇（用户定稿「账号密码放在右边」）：登录身份 + 密码胶囊 + 显示控制 + 删除。
         整簇 flex:none——名字可以省略，凭证与动作不行（它们是「这张卡能干什么」的锚）。 */
      .dsh-mb-stepacc-tail{flex:none;display:flex;align-items:center;gap:var(--mb-sp-2);margin-left:auto}
      /* 「当前显示」：借「未查询」那枚小胶囊的几何，但它是**状态**不是待办——实边 + 主色，
         一眼分得开「已经显示这个了」和「这个还没查过」。 */
      .dsh-mb-stepacc-cur{flex:none;font-size:var(--mb-fs-micro);font-weight:600;white-space:nowrap;
        padding:var(--mb-sp-1) var(--mb-sp-2);border-radius:var(--mb-r-xs);
        color:var(--mb-acc);border:1px solid color-mix(in srgb,var(--mb-acc) 45%,transparent);
        background:color-mix(in srgb,var(--mb-acc) 12%,transparent)}
      .dsh-mb-stepacc-kv{display:flex;gap:var(--mb-sp-2);align-items:stretch}
      /* 卡内两格反相成白：卡面是 soft 灰，格面就必须是 card 白，否则两者同色、格子也「看不出来」 */
      .dsh-mb-stepacc-kv>div{flex:1;min-width:0;display:flex;flex-direction:column;gap:var(--mb-sp-1);
        padding:var(--mb-sp-2) var(--mb-sp-2);border-radius:var(--mb-r-ctl);background:var(--mb-card)}
      /* Credit 格宽一档：要多扛一行「到期 ←→ 已用/共」两端对齐的次级行 */
      /* 水印定位父级：position:relative 当锚，isolation 自成层叠上下文，
         负 z-index 的水印停在格底色之上、格内容之下。 */
      .dsh-mb-stepacc-kv>div.wide{flex:1.6 1 0;position:relative;isolation:isolate}
      /* OpenCSG 账户卡原三格版的 .oc3 已删——「API 调用量（本期）」整格撤到「用量」页签后，
         账户卡只剩两格（账户余额 / 待发放余额），与清枢同用默认的两格配方（flex:1），
         无需单独折行。窄面板两格也放得下，不必再留三格那套 wrap/basis。 */
      .dsh-mb-stepacc-kv .k{font-size:var(--mb-fs-meta);color:var(--mb-sub);white-space:nowrap}
      .dsh-mb-stepacc-kv .v{font-size:var(--mb-fs-title);font-weight:650;color:var(--mb-txt);
        font-variant-numeric:tabular-nums;line-height:1.25}
      .dsh-mb-stepacc-kv .sub{margin-top:var(--mb-sp-1);font-size:var(--mb-fs-micro);line-height:1.3;color:var(--mb-tert);
        white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      /* 次级行两端对齐（Credit 格专用）：左「到期」右「已用 X · 共 Y」。
       * 右半 margin-left:auto——平台没给到期、只剩右半时也恒贴右端，位置不漂。
       * 容器的 ellipsis 在 flex 下不作用于子项，左半自带 min-width:0 + 省略，
       * 数字半 nowrap（tabular-nums）宁溢出不折行。 */
      .dsh-mb-stepacc-kv .sub.split{display:flex;align-items:baseline;gap:var(--mb-sp-2)}
      .dsh-mb-stepacc-kv .sub .sl{min-width:0;overflow:hidden;text-overflow:ellipsis}
      .dsh-mb-stepacc-kv .sub .sr{margin-left:auto;white-space:nowrap;font-variant-numeric:tabular-nums}
      /* 月池进度条嵌在 Credit 格里（标签→数值→条→摘要），不单独占一行 */
      .dsh-mb-stepacc-kv .bar{display:block;height:6px;margin-top:var(--mb-sp-1);border-radius:var(--mb-r-xs);
        background:color-mix(in srgb,var(--mb-txt) 9%,transparent);overflow:hidden}
      .dsh-mb-stepacc-kv .bar>i{display:block;height:100%;border-radius:var(--mb-r-xs);background:var(--mb-acc)}
      /* 余额构成那两行（整卡宽的 .dsh-mb-hero-bar.limited + 紧跟其下的 .dsh-mb-hero-legend）
         走的是基元余额主卡那套类名：它们本身就是**卡片级**的块级行，落位靠 .dsh-mb-stepacc
         自己的 8px 竖排 gap，与基元主卡里「统计 → 条 → 图例」的间距一致。
         原先那条「条嵌在格子里、补 4px 上边距」的规则随条搬出格子一起删掉了。
         注意两行的**渲染条件不一样**：条只在「查过 + 不是无限量 + 有到期额度」时出，图例行
         **只要这张卡在就出**——它右端挂着这张卡的「购买订阅」入口（见 -hero-btn 配方那份注释），
         入口不能随数据状态消失。所以别把图例行一起塞回条的那个 if 里。 */
      .dsh-mb-stepacc-kv>div.dim .v{color:var(--mb-tert)}
      .dsh-mb-stepacc-kv>div.dim .bar>i{background:var(--mb-tert)}
      /* Credit 格首行：标签靠左、右上角挂「月池重置」小胶囊。胶囊 flex:none 不收缩，
         挤的时候让 .k 省略——标签是理解这一格的锚，消歧优先。 */
      .dsh-mb-stepacc-kv .krow{display:flex;align-items:center;gap:var(--mb-sp-2);min-width:0}
      .dsh-mb-stepacc-kv .krow .k{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
      .dsh-mb-stepacc-rst{flex:none;font-size:var(--mb-fs-micro);color:var(--mb-tert);white-space:nowrap;
        font-variant-numeric:tabular-nums}
      /* 「波峰波谷计价」tag（平台 plan-subscribe 同名标识）：琥珀小胶囊。平台配色是
         #ad6800/#fffbe6，本插件琥珀**专属「与时段 / 到期有关」的语义**——分时计价正是
         时段语义，沿用 warn 配方（令牌 + color-mix），不抄平台字面色。flex:none 不收缩，
         宽度不够时由别的行让位（它不进 krow，见 vrow 注释）。 */
      .dsh-mb-stepacc-pv{flex:none;margin-left:auto;padding:0 var(--mb-sp-2);border-radius:var(--mb-r-pill);
        font-size:var(--mb-fs-micro);line-height:1.6;color:var(--mb-warnTx);white-space:nowrap;
        background:color-mix(in srgb,var(--mb-warn) 12%,transparent)}
      /* 百分比行加一层 flex 容器：数值靠左、tag 贴右（与上方重置胶囊右缘对齐）。
         数值 flex:none——百分比是这格的主体，不参与压缩；无 tag 时这一行与原先
         单个 .v 一比一（vrow 只是壳，无内距无背景）。 */
      .dsh-mb-stepacc-kv .vrow{display:flex;align-items:center;gap:var(--mb-sp-2);min-width:0}
      .dsh-mb-stepacc-kv .vrow .v{flex:none}
      /* 未查询格没有重置时间可显示（resetChip 为 null），这里兜一层防呆 */
      .dsh-mb-stepacc-kv>div.dim .krow .k{color:var(--mb-tert)}
      /* 图例行：卡片级，只剩加油包（「已用/共」已并入 Credit 格次级行右端） */
      .dsh-mb-stepacc-legend{display:flex;flex-wrap:wrap;gap:var(--mb-sp-1) var(--mb-sp-3);margin-top:-2px;
        font-size:var(--mb-fs-meta);color:var(--mb-tert);font-variant-numeric:tabular-nums}
      .dsh-mb-stepacc-det{border-top:1px solid var(--mb-lineSoft);padding-top:var(--mb-sp-2);
        display:flex;flex-direction:column;gap:var(--mb-sp-2)}
      .dsh-mb-stepacc-foot{display:flex;align-items:center;gap:var(--mb-sp-2)}
      .dsh-mb-stepacc-foot .sp{flex:1}
      .dsh-mb-stepacc-meta{font-size:var(--mb-fs-meta);color:var(--mb-tert);font-variant-numeric:tabular-nums}
      /* 脚行里的「近 N 天合计：…」：紧跟「收起」，宽了不推挤右侧动作——自己省略，
         但 title 里始终是全文（合计是用来对账的数，宁可省略也不能改写口径） */
      .dsh-mb-stepacc-sum{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        font-size:var(--mb-fs-meta);color:var(--mb-tert);font-variant-numeric:tabular-nums}
      /* 增删（v0.5.9 从设置页搬来） */
      .dsh-mb-stepacc-addbar{display:flex;align-items:center;gap:var(--mb-sp-2)}
      .dsh-mb-stepacc-addbar .dsh-mb-hint{margin:0}
      /* addbar 右侧留白：主操作「查询余额」贴右上角，不与低频的「添加账号」并列 */
      .dsh-mb-stepacc-addbar .sp{flex:1}
      /* 密码胶囊：顶行「显示」按钮前面，默认打码（border 虚、字色弱），展开后变实边 + 等宽明文。
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
      /* 删除按钮：**既能当图标用，也能当文字按钮用**（阶跃侧是一个 ✕，清枢侧是「删除」
         两个字）。原先写死 width:22px——两个汉字约 24px，横向溢出盒子，看着就是「删除」
         两个字没有边界。改成 min-width + 自适应宽 + border-box：✕ 仍是 22×22 的方框
         （内容 20px 由最小宽兜住，与改前逐像素一致），文字则随字数长出两枚内边距。
         字号统一到 meta：待删态的「确认」本来就是 meta，图标比它大一号没有道理。 */
      .dsh-mb-stepacc-x{flex:none;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;
        min-width:22px;height:22px;padding:0 var(--mb-sp-2);border:0;border-radius:var(--mb-r-xs);white-space:nowrap;
        background:transparent;color:var(--mb-tert);font-size:var(--mb-fs-meta);line-height:1;cursor:pointer;font-family:inherit}
      /* 悬停铺一层淡警示底，而不是只换字色：删除是破坏性动作，红色必须是**可点的面积**，
         不是一缕颜色（淡底用 color-mix 与主题同源，暗色下不会糊成一块脏红） */
      .dsh-mb-stepacc-x:hover{background:color-mix(in srgb,var(--mb-err) 12%,transparent);color:var(--mb-err)}
      /* 忙碌（正在删 / 正在查）时不再给悬停反馈：看着能点却点不动，最像「点了没反应」 */
      .dsh-mb-stepacc-x:disabled{cursor:default;opacity:.55}
      .dsh-mb-stepacc-x:disabled:hover{background:transparent;color:var(--mb-tert)}
      /* 两段式确认的待删态：换成文字 + 实警示底，别让一个 ✕ 静默吃掉一整个账号 */
      .dsh-mb-stepacc-x.armed{background:var(--mb-err);color:#fff;font-weight:600}
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
      /* 资金明细行：来源名 + 赠送/已用 + 余额 + 到期。已用完的行在建行前就被滤掉
       * （见余额页 stillUsable），所以这里只剩 ACTIVE 与「平台换了状态字」的 .other
       * 两种；.other 压暗来源名，别让它跟正常额度一样抢眼。 */
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
      /* 花费格（OpenCSG 用量页「按接口」）：钱放在条与 token 之间，右对齐等宽数字；
       * 宽度按「¥1,234.56」这种最长形态留，装不下的部分靠悬浮看全量。 */
      .dsh-mb-rank-m{flex:none;min-width:56px;text-align:right;color:var(--mb-txt);font-weight:600;
        font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-rank-c{flex:none;width:52px;text-align:right;color:var(--mb-sub);font-variant-numeric:tabular-nums}
      /* OpenCSG 用量页的「按接口」整行独占，名字列放宽一档：平台侧的模型名会长到
       * 「deepseek-v4.1-flash」（19 字符），92px 那档在此处会被截成省略号。只加宽这一页的
       * 名字列，条与数字都还有富余宽度（条是 flex:1）。 */
      .dsh-mb-ocuse .dsh-mb-rank-k{flex:0 0 118px}
      /* 今日四格（OpenCSG 用量页）：与上面「本月至今」那四格同款，只换一支边框色——两块 kv 网格
       上下相邻，不给区分就是八张灰卡连着，读者得逐格读标题才知道哪一排说的是今天。
       用 accent 与主题同源（暗色下不会糊）；**不动底色**，免得两排的对比度不一致。 */
      .dsh-mb-ocday .dsh-mb-kv{border-color:color-mix(in srgb,var(--mb-acc) 25%,transparent)}
      @keyframes dsh-mb-tip-in{from{opacity:0}}
      .dsh-mb-toggle{align-self:flex-start;border:none;background:transparent;cursor:pointer;padding:var(--mb-sp-1) 0;
        font-size:var(--mb-fs-body);font-weight:600;color:var(--mb-sub);font-family:inherit;
        transition:color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-toggle:hover{color:var(--mb-txt)}
      /* 页首行：更新时间 + 刷新，右对齐贴页面右上角（原先沉在页脚的那行已删） */
      .dsh-mb-topbar{display:flex;align-items:center;justify-content:flex-end;gap:var(--mb-sp-2);
        font-size:var(--mb-fs-meta);color:var(--mb-sub);font-variant-numeric:tabular-nums}
      /* 页首行里的标题（「全部订阅（N）」）：外层是 flex-end，靠 margin-right:auto 把自己
         顶到最左，与右端的「更新于 + 刷新」构成两端对齐；自身的外边距清零——
         .dsh-mb-day-title 那份 margin-top 是给正文里的块级标题用的。 */
      .dsh-mb-topbar .dsh-mb-day-title{margin:0;margin-right:auto;flex:none;min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
      /* ---- 兑换码弹窗：一次性小表单，高度按内容自适应（.tight 覆盖 height:100%）。---- */
      .dsh-mb-modal-card.tight{height:auto;max-width:420px;max-height:calc(100% - 32px)}
      .dsh-mb-redeem-form{display:flex;flex-direction:column;gap:var(--mb-sp-2)}
      .dsh-mb-redeem-hint{margin:0;font-size:var(--mb-fs-meta);color:var(--mb-sub);line-height:1.55}
      .dsh-mb-redeem-label{display:block;font-size:var(--mb-fs-meta);color:var(--mb-sub);margin-bottom:var(--mb-sp-1)}
      /* ---- 二次确认框：平台侧是独立 Modal.confirm（width 400、居中、无 ✕）→ 另起一层遮罩，
       * 比兑换码弹窗(z=30)再暗一档并压在上面(z=40)；卡片高度按内容自适应、宽 400 封顶。---- */
      .dsh-mb-modal.confirm{z-index:40;background:color-mix(in srgb, var(--mb-txt) 34%, transparent)}
      .dsh-mb-modal-card.confirm{height:auto;width:100%;max-width:400px;max-height:calc(100% - 32px);
        padding:var(--mb-sp-4);display:flex;flex-direction:column;gap:var(--mb-sp-3)}
      .dsh-mb-confirm-title{font-size:var(--mb-fs-body);font-weight:600;color:var(--mb-txt);letter-spacing:.2px}
      .dsh-mb-confirm-text{font-size:var(--mb-fs-meta);color:var(--mb-sub);line-height:1.55}
      .dsh-mb-confirm-actions{display:flex;justify-content:flex-end;gap:var(--mb-sp-2)}
      .dsh-mb-redeem-ok{display:flex;flex-direction:column;gap:2px;font-size:var(--mb-fs-meta);color:var(--mb-sub)}
      .dsh-mb-redeem-ok strong{font-size:var(--mb-fs-title);font-weight:600;color:var(--mb-ok)}
      .dsh-mb-redeem-err{font-size:var(--mb-fs-meta);color:var(--mb-err);line-height:1.55;word-break:break-word}
      .dsh-mb-redeem-actions{display:flex;justify-content:flex-end;gap:var(--mb-sp-2);margin-top:var(--mb-sp-1)}
      /* 升级订阅弹窗：照平台 /billing/subscription 的「套餐详情列表 + 升级」——一档一张卡，
       * 三行：卡头（名称 / 标记 / 价格）、事实行（额度 + Token 池）、动作行（升级差价 + 余额升级）。
       * 差价用橙色（全插件「与到期/限时有关」的那个色），已停售的档走灰标记。 */
       /* 标题行只剩动作（看全部 / 刷新），所以右对齐；不再有左边的说明句 */
      .dsh-mb-plan-top{display:flex;align-items:center;justify-content:flex-end;gap:var(--mb-sp-2);
        margin:0 0 var(--mb-sp-3)}
      .dsh-mb-plan{display:flex;flex-direction:column;gap:var(--mb-sp-1);padding:var(--mb-sp-3);
        border:1px solid var(--mb-line);border-radius:var(--mb-r-card);background:var(--mb-soft)}
      .dsh-mb-plan+.dsh-mb-plan{margin-top:var(--mb-sp-2)}
      .dsh-mb-plan.cur{border-color:color-mix(in srgb,var(--mb-ok) 45%,transparent);
        background:color-mix(in srgb,var(--mb-ok) 8%,transparent)}
      .dsh-mb-plan-head{display:flex;align-items:center;gap:var(--mb-sp-2);flex-wrap:wrap}
      .dsh-mb-plan-name{flex:none;font-size:var(--mb-fs-strong);font-weight:600;color:var(--mb-txt)}
      .dsh-mb-plan-tag{flex:none;font-size:var(--mb-fs-micro);font-weight:600;white-space:nowrap;
        padding:var(--mb-sp-1) var(--mb-sp-2);border-radius:var(--mb-r-xs);
        color:var(--mb-acc);border:1px solid color-mix(in srgb,var(--mb-acc) 45%,transparent);
        background:color-mix(in srgb,var(--mb-acc) 12%,transparent)}
      .dsh-mb-plan-tag.cur{color:var(--mb-ok);border-color:color-mix(in srgb,var(--mb-ok) 45%,transparent);
        background:color-mix(in srgb,var(--mb-ok) 12%,transparent)}
      .dsh-mb-plan-tag.off{color:var(--mb-tert);border-color:var(--mb-line);background:transparent}
      .dsh-mb-plan-price{margin-left:auto;flex:none;font-size:var(--mb-fs-strong);font-weight:600;
        color:var(--mb-txt);font-variant-numeric:tabular-nums}
       /* 第二行：只摆事实（额度 + Token 池），三级字色——它不参与决策，别跟差价抢 */
       .dsh-mb-plan-kv{display:flex;align-items:center;gap:var(--mb-sp-3);flex-wrap:wrap;
         font-size:var(--mb-fs-meta);color:var(--mb-tert);font-variant-numeric:tabular-nums}
       /* 第三行：左边是升级差价（橙色，与「限时 / 到期」同一套语义），右边是「余额升级」。
          左槽带 flex:1，没内容时按钮也不会被顶到左边。 */
       .dsh-mb-plan-act{display:flex;align-items:center;justify-content:flex-end;gap:var(--mb-sp-2);
         margin-top:var(--mb-sp-1)}
       .dsh-mb-plan-act .due{flex:1 1 auto;min-width:0;font-size:var(--mb-fs-meta);font-weight:600;
         color:var(--mb-warnTx);font-variant-numeric:tabular-nums}
      .dsh-mb-plan-note{flex:1 1 auto;min-width:0;font-size:var(--mb-fs-meta);color:var(--mb-warnTx);
        line-height:var(--mb-line)}
      .dsh-mb-plan-hint{font-size:var(--mb-fs-meta);color:var(--mb-tert);line-height:var(--mb-line);
        margin-top:var(--mb-sp-3)}
      /* 按订阅分组：组标题＝这一档套餐本身（套餐名 + 生效中 + 剩余天数 · 额度），
       * 组内是「能升到哪些档」。组与组之间用间距分开，组内卡片紧一些；组标题再压一条下边距
       * （用户定稿「添加下边距」），标题与第一张卡之间 8+8=16px。 */
      .dsh-mb-plan-grp{display:flex;flex-direction:column;gap:var(--mb-sp-2)}
      .dsh-mb-plan-grp+.dsh-mb-plan-grp{margin-top:var(--mb-sp-4)}
      .dsh-mb-plan-grp-head{display:flex;align-items:center;gap:var(--mb-sp-2);flex-wrap:wrap;
        margin-bottom:var(--mb-sp-2)}
      .dsh-mb-plan-grp-name{flex:none;font-size:var(--mb-fs-strong);font-weight:600;color:var(--mb-txt)}
      .dsh-mb-plan-grp-meta{margin-left:auto;flex:none;font-size:var(--mb-fs-meta);color:var(--mb-tert);
        font-variant-numeric:tabular-nums}

      /* 密钥页签：新建行 / 创建成功一次性展示 / 密钥卡片列表。 */
      /* 新建行允许换行：OpenCSG 那行是「名称 + 有效期 + 按钮」三件（另两家只有两件），面板拖窄
         时 input 被压到 0 宽、select 与按钮仍然挤着——给 input 一个下限，窄了就整行换到下一行，
         好过三个控件一起被压扁。 */
      .dsh-mb-key-create{display:flex;gap:var(--mb-sp-2);align-items:center;flex-wrap:wrap}
      .dsh-mb-key-create .dsh-mb-input{flex:1;min-width:120px}
      .dsh-mb-key-create .dsh-mb-btn{flex:none}
      .dsh-mb-key-create .dsh-mb-ck-int{flex:none}
      .dsh-mb-created{border:1px solid color-mix(in srgb, var(--mb-acc) 25%, transparent);border-radius:var(--mb-r-card);padding:var(--mb-sp-4);
        background:color-mix(in srgb, var(--mb-acc) 7%, transparent)}
      .dsh-mb-created-title{font-size:var(--mb-fs-body);font-weight:600;color:var(--mb-acc);margin-bottom:var(--mb-sp-2)}
      .dsh-mb-created-key{font-family:var(--mb-codeFont);font-size:var(--mb-fs-body);word-break:break-all;
        background:var(--mb-codeBlock);border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-ctl);padding:var(--mb-sp-2) var(--mb-sp-2);color:var(--mb-txt)}
      .dsh-mb-created .dsh-mb-btn-row{margin-top:var(--mb-sp-2)}
      .dsh-mb-keys-head{display:flex;align-items:center;justify-content:space-between;gap:var(--mb-sp-2)}
      .dsh-mb-keys-list{display:flex;flex-direction:column;gap:var(--mb-sp-2)}
      .dsh-mb-key-card{padding:var(--mb-sp-3);border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-card);background:var(--mb-soft)}
      /* 使用中：整卡高亮（用户定稿「使用中的整个卡片高亮显示」）。描边取主色实值、底色
         8% 混色——全是令牌派生，零漂移测试无新账。平台 isDefault 徽章已删，卡上「使用中」
         是唯一的身份标记。 */
      .dsh-mb-key-card.active{border-color:var(--mb-acc);background:color-mix(in srgb,var(--mb-acc) 8%,var(--mb-soft))}
      .dsh-mb-key-card-top{display:flex;align-items:center;justify-content:space-between;gap:var(--mb-sp-2)}
      .dsh-mb-key-card-name{font-weight:600;font-size:var(--mb-fs-body);color:var(--mb-txt);min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-key-code-row{display:flex;align-items:center;justify-content:space-between;gap:var(--mb-sp-2);margin-top:var(--mb-sp-1)}
      .dsh-mb-key-card-code{font-family:var(--mb-codeFont);font-size:var(--mb-fs-body);color:var(--mb-sub);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-mb-key-card .dsh-mb-key-copy{flex:none}
      .dsh-mb-key-card-meta{font-size:var(--mb-fs-meta);color:var(--mb-sub);margin-top:var(--mb-sp-1)}
      /* 没有本机副本的那一格（「仅创建时展示过一次」）：与 meta 同字号同色，但**不带
         margin-top**——它待在 .dsh-mb-key-code-row 这只 flex 行里，带上就把掩码那行撑高 4px，
         有副本与没副本的卡片掩码文字错着一个位。 */
      .dsh-mb-key-card-none{font-size:var(--mb-fs-meta);color:var(--mb-sub);flex:none}
      /* 密钥卡动作行：「设为使用」+「删除」右排一列；覆盖 .dsh-mb-key-copy 的 margin-left:auto
         （行内自己 justify，两个 auto 会把间距撕散） */
      .dsh-mb-key-actions{display:flex;align-items:center;justify-content:flex-end;gap:var(--mb-sp-2);margin-top:var(--mb-sp-1)}
      .dsh-mb-key-actions .dsh-mb-key-copy{margin-left:0}
      /* 设置页：分区卡片 + 账号行（头像字/当前徽标/明文切换）。 */
      .dsh-mb-set-card{border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-card);background:var(--mb-soft);
        padding:var(--mb-sp-3);display:flex;flex-direction:column;gap:var(--mb-sp-2)}
      /* 系统管理：整行可点的选中行（方框 + 名称 + 该家自己的页签名）。未选中灰、选中描边主题色。
         右侧那串页签名允许换行（窄面板 / 长系统名如「阶跃 Step Plan」时不许溢出）。 */
      .dsh-mb-sys-row{display:flex;align-items:center;gap:var(--mb-sp-2);width:100%;text-align:left;
        border:1px solid var(--mb-lineSoft);border-radius:var(--mb-r-ctl);background:transparent;color:var(--mb-sub);
        padding:var(--mb-sp-2);cursor:pointer;transition:border-color var(--mb-fast) var(--mb-ease),background-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-sys-row:hover{background:color-mix(in srgb,var(--mb-soft) 70%,transparent)}
      /* 拖动排序的行首提示（设置 → 系统管理）：整行都能拖，这枚「⠿」只是看得见的抓手。
         touch-action:none 让触屏用户抓这里时不被面板的竖向滚动抢走（整行不敢设 none，
         会把滚动一起吞掉）；user-select:none 防拖出选区。宽度交给字形自己算，
         钉死像素换个字体就把「⠿」裁一半。 */
      .dsh-mb-sys-grip{flex:none;display:inline-flex;align-items:center;justify-content:center;
        margin-left:-2px;color:var(--mb-sub);cursor:grab;user-select:none;touch-action:none}
      .dsh-mb-sys-grip:active{cursor:grabbing}
      .dsh-mb-sys-row.on{border-color:var(--mb-acc);background:color-mix(in srgb,var(--mb-acc) 10%,transparent);color:var(--mb-txt)}
      .dsh-mb-sys-box{flex:none;width:15px;height:15px;border:1px solid var(--mb-line);border-radius:var(--mb-r-xs);
        display:inline-flex;align-items:center;justify-content:center;font-size:10px;line-height:1;color:#fff}
      .dsh-mb-sys-row.on .dsh-mb-sys-box{background:var(--mb-acc);border-color:var(--mb-acc)}
      /* 正在被拖的那行：描边与底色都提到主色（排在 .on 之后才覆盖得过它——同特异度看先后），
         光标换成「抓着」，并禁掉文字选中。松手前就能看见它落在第几位，不用等回执。 */
      .dsh-mb-sys-row.dragging{border-color:var(--mb-acc);background:color-mix(in srgb,var(--mb-acc) 18%,transparent);cursor:grabbing;user-select:none}
      .dsh-mb-sys-name{flex:none;font-size:var(--mb-fs-strong);font-weight:600;color:var(--mb-txt)}
      /* 只列页签名，不做按钮/不做跳转：这里表达的是「勾上它会多出哪几个页签」。
         可读性按用户反馈（2026-10-09「看得不是很明显」）三处提亮：正文字号（原 10px micro）、
         次级文字色（原 tertiary）、实体描边（原 lineSoft，几乎看不见）+ 描边底色。 */
      .dsh-mb-sys-tabs{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:var(--mb-sp-1);justify-content:flex-end}
      .dsh-mb-sys-tab{flex:none;font-size:var(--mb-fs-body);font-weight:500;line-height:1.75;
        padding:0 7px;border:1px solid var(--mb-line);border-radius:var(--mb-r-xs);
        background:var(--mb-soft);color:var(--mb-sub);white-space:nowrap}
      .dsh-mb-sys-row.on .dsh-mb-sys-tab{color:var(--mb-txt);
        border-color:color-mix(in srgb,var(--mb-acc) 50%,transparent);
        background:color-mix(in srgb,var(--mb-acc) 12%,transparent)}
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
      .dsh-mb-pw-eye:focus-visible,.dsh-mb-sys-row:focus-visible{outline:none;box-shadow:var(--mb-ring)}
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

      /* ---- 对话头部角标：portal 挂进「对话 / 轨迹」页签行，两端对齐 ----
         页签行是 flex（display:flex;gap:36px），角标靠 margin-left:auto 钉到最右端，页签留在
         最左；align-self/margin-top 把胶囊中心对准标签文字的光学中线（原生标签只占行上部
         16px，下面 9px 是下划线留白——不压这一层，胶囊看着就坠得靠下）。账号位显示**昵称**
         （UserInfo nickname），手机号与密钥（连掩码、连打码）一律不上界面——详情卡只讲套餐
         的数（用户点名砍掉辨识行）；进度条上叠一层**套餐档位
         水印**（fill 用半透明 acc 浅底，水印文字用主文字色压在浅底上，任何主题都读得出）。
         整枚只在该会话选了阶跃模型时才渲染，故不写「阶跃」二字。「.off」= key 还没对上账号：
         整枚降透明度、状态点转灰，仍可悬停看原因；「.low」= 剩余不足 20%，条与状态点一起转
         琥珀（与入口琥珀点同语言）。三枚角标共用同一套皮肤与同一颗状态点，彼此的差别只有
         修饰类（-oc / -trb）与「数」本身。 */
      /* 皮肤（v0.7.3 · 用户从 design/badge-variants.html 六套里定稿的方案 D「状态点」）：
         面 = 主文字 5% 的极浅填充，靠 6% 发丝内描边收边 + 1px 外阴影垫一点厚度——不再用实心
         描边，三枚并排时不像三个灰盒子。总高仍是 22px（border-box，含那 1px 透明边），换肤
         **不动几何**：页签行里的位置、与标签文字的光学中线都与上一版逐像素对得上（height 由
         20px+2px 边改成 22px border-box，是同一件事的两种写法）。 */
      .dsh-mb-hplan{position:relative;display:inline-flex;align-items:center;gap:var(--mb-sp-2);min-width:0;max-width:260px;
        box-sizing:border-box;height:22px;align-self:flex-start;margin-top:-2px;margin-left:auto;padding:0 9px;
        border:1px solid transparent;border-radius:var(--mb-r-pill);
        background:color-mix(in srgb,var(--mb-txt) 5%,transparent);
        box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--mb-txt) 6%,transparent),0 1px 2px rgba(0,0,0,.1);
        color:var(--mb-txt);font-size:var(--mb-fs-meta);line-height:1;cursor:default;
        font-variant-numeric:tabular-nums;transition:background-color var(--mb-fast) var(--mb-ease)}
      .dsh-mb-hplan:hover{background:color-mix(in srgb,var(--mb-txt) 9%,transparent)}
      .dsh-mb-hplan.off{opacity:.55}
      /* 状态点（方案 D 的题眼）：绿 = 有读数、琥珀 = 低余量（阶跃剩余 <20% / 钱 <¥10）、灰 =
         没读数。三态**全由 .low / .off 两个类决定**，这里不分辨是哪一枚——三条规则对三枚同时
         生效，不需要再多写两套按枚选择器。点外圈是同色 3px 光晕，22px 高的胶囊里才不会看着像
         一粒孤零零的脏点；状态同时走「点」与「数值颜色」两个通道，色觉障碍也读得到。 */
      .dsh-mb-hplan-d{flex:none;width:6px;height:6px;border-radius:50%;background:var(--mb-ok);
        box-shadow:0 0 0 3px color-mix(in srgb,var(--mb-ok) 16%,transparent)}
      .dsh-mb-hplan.low .dsh-mb-hplan-d{background:var(--mb-warn);
        box-shadow:0 0 0 3px color-mix(in srgb,var(--mb-warn) 18%,transparent)}
      .dsh-mb-hplan.off .dsh-mb-hplan-d{background:var(--mb-tert);box-shadow:none}
      .dsh-mb-hplan-a{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        color:var(--mb-sub);font-weight:500;letter-spacing:.01em}
      .dsh-mb-hplan-track{flex:none;position:relative;width:60px;height:14px;overflow:hidden;
        border-radius:var(--mb-r-pill);background:var(--mb-softAccent)}
      .dsh-mb-hplan-fill{position:absolute;top:0;bottom:0;left:0;border-radius:var(--mb-r-pill);
        background:color-mix(in srgb,var(--mb-acc) 42%,transparent);
        transition:width var(--mb-dur) var(--mb-ease)}
      .dsh-mb-hplan.low .dsh-mb-hplan-fill{background:color-mix(in srgb,var(--mb-warn) 42%,transparent)}
      /* OpenCSG 那枚（v0.7.3）：没有进度条，low 的语义落在**数值文本**上——余额本身就是一串
         钱，红了就是「该充值了」。单开 .dsh-mb-hplan-oc 选择器，阶跃那枚的像素一字不动。 */
      .dsh-mb-hplan-oc.low .dsh-mb-hplan-v{color:var(--mb-warn)}
      /* 基元那枚（v0.7.3）：同样没有进度条，low 落在数值文本上。与 OC 各开各的选择器——
         阶跃那枚的像素一字不动；基元的 low 与侧栏那颗琥珀点同源（同一个 alertOf 判据）。
         类名取 -trb：.dsh-mb-hplan-tr 是悬停提示行的类，chip 借它会被套上 flex 行样式。
         ⚠ 这段 CSS 坐在模板字面量里：注释里**不许出现反引号**（会提前收尾，把后面的 CSS
         当 JS 求值——2026-10-21 检修时就因为写了个反引号把自己炸了：mb is not defined）。 */
      .dsh-mb-hplan-trb.low .dsh-mb-hplan-v{color:var(--mb-warn)}
      /* 套餐档位水印：绝对铺满条面、居中，半透明主文字色——浅填充底与留白底上都读得出 */
      .dsh-mb-hplan-wm{position:absolute;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;
        justify-content:center;font-size:var(--mb-fs-micro);font-weight:700;letter-spacing:.4px;line-height:1;
        color:var(--mb-txt);opacity:.82;pointer-events:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      /* 数值位：比名字大半像素（12 vs 11）、字重 600、数字紧排——一眼先读到钱/百分比，名字只是
         背景信息。三枚共用，故不按枚另写。 */
      .dsh-mb-hplan-v{flex:none;display:inline-flex;align-items:center;font-weight:600;
        font-size:var(--mb-fs-body);letter-spacing:-.01em}
      /* 悬停详情卡（用户定稿「鼠标放上去 展示详细的信息」）：走宿主 tooltip 同款配色
         （--dsw-alias-tooltip-bg 全局可得）。角标钉在行右端 → 卡**右缘对齐、向下展开**，
         往左下长才不会被顶出屏外。display:none↔flex 而非透明层：不必担心看不见的层挡交互，
         再配 pointer-events:none 双保险。k/v 两列，key 列定宽对齐。 */
      .dsh-mb-hplan-tip{position:absolute;top:calc(100% + 8px);right:0;z-index:120;box-sizing:border-box;
        min-width:210px;max-width:300px;padding:var(--mb-sp-2) var(--mb-sp-2);border-radius:var(--mb-r-ctl);
        text-align:left;background:var(--dsw-alias-tooltip-bg,#283142);
        color:var(--dsw-static-neutral-bluish-00,#fff);
        box-shadow:var(--dsw-shadow-lv2,0 4px 12px rgba(0,0,0,.05));
        display:none;flex-direction:column;gap:var(--mb-sp-1);
        font-size:var(--mb-fs-meta);line-height:17px;pointer-events:none;
        animation:dsh-mb-tip-in 150ms var(--mb-ease);font-variant-numeric:normal}
      .dsh-mb-hplan:hover .dsh-mb-hplan-tip{display:flex}
      .dsh-mb-hplan-tr{display:flex;gap:var(--mb-sp-2);min-width:0}
      .dsh-mb-hplan-tk{flex:none;min-width:5.5em;opacity:.62}
      .dsh-mb-hplan-tv{flex:0 1 auto;min-width:0;overflow-wrap:anywhere}

      @media (prefers-reduced-motion:reduce){.dsh-mb-cbtn,.dsh-mb-entry,.dsh-mb-entry-label.wide-in,.dsh-mb-trend-tip,.dsh-mb-hov,.dsh-mb-hplan,.dsh-mb-hplan-fill,.dsh-mb-hplan-tip{transition:none;animation:none}}
`;
        return module.exports;
  }
});
