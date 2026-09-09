// 阶跃（StepFun）Step Plan：协议层（lib/step.js）+ host 净化器（lib/index.js 导出）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as step from '../lib/step.js'
import { sanitizeStepAccounts, sanitizeStepPrefs, pickStepAccount } from '../lib/index.js'

// ---- protobuf / grpc-web 帧 ----

test('step codec：字符串/整型/嵌套字段编码后可完整解回', () => {
  const inner = Buffer.concat([step.pbString(2, 'Flash Pro'), step.pbVarint(6, 1789999999), step.pbVarint(7, 1)])
  const buf = Buffer.concat([step.pbVarint(1, 0), step.pbString(2, 'OK'), step.pbMessage(3, inner), step.pbVarint(6, 1)])
  const f = step.pbDecode(buf)
  assert.equal(step.pbNum(f, 1), 0)
  assert.equal(step.pbStr(f, 2), 'OK')
  const sub = step.pbSub(f, 3)
  assert.equal(step.pbStr(sub, 2), 'Flash Pro')
  assert.equal(step.pbNum(sub, 6), 1789999999)
  assert.equal(step.pbNum(sub, 7), 1)
  assert.equal(step.pbNum(f, 6), 1)
})

test('step codec：int64 大额 Credit（>2^32）经 varint 往返不丢精度', () => {
  const n = 40000000000 // 400 亿 Credit
  const f = step.pbDecode(step.pbVarint(2, n))
  assert.equal(step.pbNum(f, 2), n)
})

test('step codec：repeated 子消息 pbSubs 取回全部；未知 wiretype 提前截断不抛', () => {
  const m = Buffer.concat([step.pbMessage(4, step.pbVarint(1, 1)), step.pbMessage(4, step.pbVarint(1, 2))])
  const f = step.pbDecode(m)
  assert.deepEqual(step.pbSubs(f, 4).map((b) => step.pbNum(b, 1)), [1, 2])
  // wiretype 3/4（group，未支持）→ 防御性截断为已解出的前缀
  const bad = Buffer.from([0x1b, 0x01])
  assert.deepEqual(step.pbDecode(bad), [])
})

test('step 帧：encodeFrame/parseGrpcWeb 数据帧与 trailer 帧共存的完整响应', () => {
  const data = step.encodeFrame(step.pbString(1, 'tok'))
  const tr = Buffer.from('grpc-status:0\r\ngrpc-message:\r\n', 'utf8')
  const lb = Buffer.alloc(4)
  lb.writeUInt32BE(tr.length)
  const all = Buffer.concat([data, Buffer.from([0x80]), lb, tr])
  const p = step.parseGrpcWeb(all)
  assert.equal(p.grpcStatus, 0)
  assert.equal(step.pbStr(p.data, 1), 'tok')
})

test('step 帧：trailer 报错 grpc-message URL 解码；空 body 不崩', () => {
  const tr = Buffer.from('grpc-status:16\r\ngrpc-message:token%20is%20illegal\r\n', 'utf8')
  const lb = Buffer.alloc(4)
  lb.writeUInt32BE(tr.length)
  const p = step.parseGrpcWeb(Buffer.concat([Buffer.from([0x80]), lb, tr]))
  assert.equal(p.grpcStatus, 16)
  assert.equal(p.grpcMessage, 'token is illegal')
  assert.equal(step.parseGrpcWeb(Buffer.alloc(0)).data, null)
})

test('step 请求编码：SignInByPassword 字段 1/2 与注册/查询请求字节形态', () => {
  const p = step.parseGrpcWeb(step.encodeSignInByPassword('18200000000', 'pw-123'))
  assert.equal(step.pbStr(p.data, 1), '18200000000')
  assert.equal(step.pbStr(p.data, 2), 'pw-123')
  assert.equal(step.parseGrpcWeb(step.encodeRegisterDevice()).dataRaw.length, 0)
  const q = step.parseGrpcWeb(step.encodeQueryUsages({ startTime: 100, toTime: 200 }))
  assert.equal(step.pbNum(q.data, 1), 100)
  assert.equal(step.pbNum(q.data, 2), 200)
  assert.equal(step.pbNum(q.data, 3), 1) // page 默认
  assert.equal(step.pbNum(q.data, 4), 100) // pageSize 默认
})

test('step 登录响应解析：access/refresh token 与 deviceID', () => {
  const at = step.pbMessage(1, step.pbString(1, 'AAA'))
  const rt = step.pbMessage(2, step.pbString(1, 'BBB'))
  const dev = step.pbMessage(3, step.pbString(2, 'dev-40-hex'))
  const a = step.parseAuthResponse(step.pbDecode(Buffer.concat([at, rt])))
  assert.equal(a.accessToken.raw, 'AAA')
  assert.equal(a.refreshToken.raw, 'BBB')
  const r = step.parseRegisterDeviceResponse(step.pbDecode(Buffer.concat([at, dev])))
  assert.equal(r.deviceId, 'dev-40-hex')
  assert.equal(r.refreshToken, null)
})

test('step jwtExpiry：合法 payload 取 exp；垃圾串返回 null', () => {
  const seg = Buffer.from(JSON.stringify({ exp: 123456 })).toString('base64url')
  assert.equal(step.jwtExpiry('h.' + seg + '.s'), 123456)
  assert.equal(step.jwtExpiry('garbage'), null)
})

// ---- 响应归一（JSON 通道：2026-09 CDP 抓包坐实同款 URL application/json + status:1） ----

test('normalizeStepPlanStatus：档位/到期/自动续费/可重签全量解出（真实抓包 fixture）', () => {
  const n = step.normalizeStepPlanStatus({
    status: 1, desc: '',
    subscription: { plan_type: 4, name: 'Mini', status: 1, pay_channel: 6, activated_at: '1782299354', expired_at: '1815131354', auto_renew: false, plan_id: '28', plan_family: 2 },
    plan_definition: { type: 4, price: '45600', duration_days: 365, plan_id: '28', billing_cycle: 3 },
    can_resign: false,
  })
  assert.deepEqual(
    { ok: n.ok, tier: n.tier, expireAt: n.expireAt, activatedAt: n.activatedAt, autoRenew: n.autoRenew, canResign: n.canResign, priceCny: n.priceCny, durationDays: n.durationDays, planId: n.planId },
    { ok: true, tier: 'Mini', expireAt: 1815131354, activatedAt: 1782299354, autoRenew: false, canResign: false, priceCny: 45600, durationDays: 365, planId: '28' },
  )
})

test('normalizeStepPlanStatus：残缺消息全部降级 null，绝不抛出；status≠1 → ok:false', () => {
  const n = step.normalizeStepPlanStatus({ status: 1, desc: 'partial' })
  assert.equal(n.tier, null)
  assert.equal(n.expireAt, null)
  assert.equal(n.autoRenew, null)
  assert.equal(step.normalizeStepPlanStatus(null), null)
  assert.equal(step.normalizeStepPlanStatus('string'), null)
  assert.equal(step.normalizeStepPlanStatus({ status: 2, desc: '无权限' }).ok, false)
})

test('normalizeStepCredit：月池+加油包 bucket 聚合出 total/used/residual（字符串大数照收）', () => {
  const n = step.normalizeStepCredit({
    status: 1, desc: '',
    plan_credit_rate_limit: {
      subscription_credit_left_rate: 0.9782602, subscription_credit_reset_time: '1790075400', topup_credit_left_rate: 0,
      credit_buckets: [
        { type: 1, credit_total: '400000000', credit_residual: '391304100', expire_at: '1815131354', next_reset_at: '1790075400' },
        { type: 2, credit_total: '50000000', credit_residual: '49000000', expire_at: '1799999999' },
      ],
    },
  })
  assert.equal(n.credits.total, 450000000)
  assert.equal(n.credits.residual, 440304100)
  assert.equal(n.credits.used, 9695900)
  assert.equal(n.hasTopup, true)
  assert.equal(n.subscriptionLeftRate, 0.9782602) // 0~1 小数（实测）
  assert.equal(n.subscriptionResetAt, 1790075400)
  assert.equal(n.buckets.length, 2)
  assert.equal(step.normalizeStepCredit({ status: 1 }), null) // 无 plan_credit_rate_limit → null
  assert.equal(step.normalizeStepCredit(null), null)
})

test('normalizeStepUsages：记录逐条映射；proto 字段名 from_time/to_time + 毫秒归秒 + camel/snake 防漂移；空记录 → []', () => {
  const n = step.normalizeStepUsages({ status: 1, records: [{ from_time: 1000, to_time: 2000, model_id: 'step-3.7-flash', calls: 7, credit_consumed: 1234 }], total: 1 })
  assert.deepEqual(n, [{ from: 1000, to: 2000, model: 'step-3.7-flash', calls: 7, credit: 1234 }])
  // 官方页面实证：from_time/to_time 为毫秒字符串粒度（当地日界）
  const ms = step.normalizeStepUsages({ records: [{ from_time: '1786118400000', to_time: '1786204799999', model_id: 'step-3.7-flash', calls: 140, credit_consumed: 6470000 }] })
  assert.deepEqual(ms, [{ from: 1786118400, to: 1786204799, model: 'step-3.7-flash', calls: 140, credit: 6470000 }])
  const alt = step.normalizeStepUsages({ records: [{ from: 1, to: 2, modelId: 'm', total_calls: 3, credit: 4 }] })
  assert.deepEqual(alt, [{ from: 1, to: 2, model: 'm', calls: 3, credit: 4 }])
  assert.deepEqual(step.normalizeStepUsages({ status: 1, records: [], total: 0 }), [])
  assert.deepEqual(step.normalizeStepUsages(null), [])
})

test('normalizeStepAccounts：官方 /v1/accounts JSON 归一（非数值降级 null）', () => {
  const n = step.normalizeStepAccounts({ object: 'account', type: 'prepaid', balance: 0, total_cash_balance: 0, total_voucher_balance: 12.5 })
  assert.deepEqual(n, { type: 'prepaid', balance: 0, totalCash: 0, totalVoucher: 12.5 })
  assert.equal(step.normalizeStepAccounts('junk'), null)
  assert.equal(step.normalizeStepAccounts({ balance: 'NaN?' }).balance, null)
})

test('normalizeStepWallet：控制台钱包单位为分，归一后换成元', () => {
  const n = step.normalizeStepWallet({ voucher: '1396', payment: '0', balance: '1396', cost_yesterday: '0', cost_month: '0', cost_total: '763', credit: '0', voucher_api: '1396', voucher_plan: '0' })
  assert.deepEqual(
    { type: n.type, balance: n.balance, totalCash: n.totalCash, totalVoucher: n.totalVoucher, costTotal: n.costTotal, voucherApi: n.voucherApi },
    { type: 'prepaid', balance: 13.96, totalCash: 0, totalVoucher: 13.96, costTotal: 7.63, voucherApi: 13.96 },
  )
  assert.equal(step.normalizeStepWallet(null), null)
  assert.equal(step.normalizeStepWallet('junk'), null)
})

// ---- 平台端点（焊死常量；「端点导入」功能已按用户要求整体移除） ----

test('STEP_DEV_SERVICE：控制台 F12 坐实的真实服务名焊死（无 Service 后缀）', () => {
  assert.equal(step.STEP_DEV_SERVICE, 'step.openapi.devcenter.Dashboard')
  assert.equal(step.stepRpcUrl('/api/' + step.STEP_DEV_SERVICE + '/GetStepPlanStatus'),
    'https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus')
})

// ---- 胶囊仲裁 ----

test('pickStepEntryDisplay：auto=Credit% → API 余额 → 回落基元；takeover=false 永不接管', () => {
  const credit = { credits: { total: 400, residual: 300 } }
  assert.deepEqual(step.pickStepEntryDisplay({ activeProvider: 'step', credit, account: { balance: 9 }, prefs: {} }), { provider: 'step', label: '阶跃', value: '75%' })
  assert.equal(step.pickStepEntryDisplay({ activeProvider: 'step', credit: null, account: { balance: 3.5 }, prefs: {} }).value, '¥3.50')
  assert.deepEqual(step.pickStepEntryDisplay({ activeProvider: 'step', credit: null, account: null, prefs: {} }), { provider: 'tr' })
  assert.deepEqual(step.pickStepEntryDisplay({ activeProvider: 'step', credit, prefs: { takeover: false } }), { provider: 'tr' })
  assert.deepEqual(step.pickStepEntryDisplay({ activeProvider: 'tr', credit, prefs: {} }), { provider: 'tr' })
  assert.equal(step.pickStepEntryDisplay({ activeProvider: 'step', credit, account: { balance: 3.5 }, prefs: { mode: 'balance' } }).value, '¥3.50')
})

// ---- host 净化器（lib/index.js 导出） ----

test('sanitizeStepAccounts：形状/长度/去重/限量（密码直登单轨，浏览器轨条目不再放行）', () => {
  const out = sanitizeStepAccounts([
    { username: ' 18200000000 ', password: 'pw1', addedAt: 1 },
    { username: '18200000000', password: 'dup' }, // 大小写同键去重
    { username: 'ab', password: 'pw' }, // 过短
    { username: 'x@y.dev', password: '' }, // 空密码
    'junk',
    { username: 'ok@x.dev', password: 'pw2' },
  ])
  assert.deepEqual(out.map((a) => a.username), ['18200000000', 'ok@x.dev']) // 空密码同样被剔
  assert.ok(out.every((a) => a.login === undefined), '单轨后不再写 login 字段')
  // 浏览器时代残留：login:'browser' 条目一律按密码轨要求处理，无密码 → 剔
  const legacy = sanitizeStepAccounts([
    { username: '工作号', password: '', login: 'browser' },
    { username: 'x@y.dev', password: '', login: 'nope' },
  ])
  assert.equal(legacy.length, 0)
  assert.equal(sanitizeStepAccounts(undefined).length, 0)
  assert.equal(sanitizeStepAccounts(Array.from({ length: 30 }, (_, i) => ({ username: 'user-' + i + 'xxxx', password: 'p' }))).length, 20)
})

test('sanitizeStepPrefs：非法值全落默认（takeover=true/auto/tr）', () => {
  assert.deepEqual(sanitizeStepPrefs({}), { takeover: true, mode: 'auto', provider: 'tr' })
  assert.deepEqual(sanitizeStepPrefs({ takeover: false, mode: 'credits', provider: 'step' }), { takeover: false, mode: 'credits', provider: 'step' })
  assert.deepEqual(sanitizeStepPrefs({ mode: 'hax', provider: 'x' }), { takeover: true, mode: 'auto', provider: 'tr' })
})

test('pickStepAccount：活跃账号必须与带密码条目同名才可用（密码直登单轨）', () => {
  const step0 = { accounts: [{ username: 'A@x.dev', password: 'p' }, { username: 'b@x.dev', password: 'p' }], activeAccount: 'a@x.dev' }
  assert.equal(pickStepAccount(step0).username, 'A@x.dev')
  assert.equal(pickStepAccount({ ...step0, activeAccount: '' }), null)
  assert.equal(pickStepAccount({ accounts: [], activeAccount: 'zz@x.dev' }), null)
  // 浏览器轨已摘除：无密码条目一律不可用
  assert.equal(pickStepAccount({ accounts: [{ username: 'B', password: '', login: 'browser' }], activeAccount: 'B' }), null)
})

test('step URL 常量与拼装：账号域两步 + 平台域 RPC 前缀', () => {
  assert.equal(step.stepRegisterUrl(), 'https://account.stepfun.com/passport/proto.api.passport.v1.PassportService/RegisterDevice')
  assert.equal(step.stepSignInUrl(), 'https://account.stepfun.com/passport/proto.api.passport.v1.PassportService/SignInByPassword')
  assert.ok(step.stepRpcUrl('/api/step.openapi.devcenter.Foo/Get').startsWith('https://platform.stepfun.com/api/'))
  assert.equal(step.STEP_OASIS_HEADERS['oasis-appid'], '10300')
})
