import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSettingsProviders,
  extractCredentialFromText,
  normalizeModels,
  normalizePlatformModels,
  normalizeStatus,
  categoryCounts,
  normalizeBalance,
  normalizeExpiringCredits,
  extractExpiringItems,
  sanitizeEntryBalance,
  isNewerVersion,
  normalizeDistTags,
  sanitizeUpdate,
  detectInstallMode,
  accountNameFromMe,
  summarizeDailyLogs,
  maskSecret,
  extractSessionCookie,
  extractCsrfCookie,
  stripYamlComments,
} from '../lib/index.js'

// ---- 测试夹具：flow 布局照抄 ~/.dsh/settings.yaml 的真实形态（多行大括号） ----
const FLOW_SETTINGS = `llm-pi-ai:
  providers:
    {
      jy:
        {
          displayName: 基元,
          apiKeyEnv: JY_API_KEY,
          api: openai-completions,
          baseURL: https://tokenrhythm.studio/v1,
          models:
            [
              { id: glm-5.3-flash, name: glm-5.3-flash },
              { id: deepseek-v4-flash, name: deepseek-v4-flash, contextWindow: 1000000 },
              { id: deepseek-v4-pro, name: deepseek-v4-pro, contextWindow: 1000000 }
            ]
        },
      step:
        {
          displayName: 阶跃,
          apiKeyEnv: STEP_API_KEY,
          api: anthropic-messages,
          baseURL: https://api.stepfun.com/step_plan,
          models: [ { id: step-3.7-flash, name: step-3.7-flash } ]
        },
      minmax:
        {
          displayName: minmax,
          apiKeyEnv: MINMAX_API_KEY,
          api: openai-completions,
          baseURL: https://api.gmi-serving.com/v1,
          models: [ { id: MiniMaxAI/MiniMax-M3, name: MiniMax-M3 } ]
        }
    }
agent-default-model:
  provider: jy
  model: glm-5.3-flash
`

// block 布局：缩进式 + `- id:` 列表项。
const BLOCK_SETTINGS = `llm-pi-ai:
  providers:
    jy:
      displayName: 基元
      apiKeyEnv: JY_API_KEY
      baseURL: https://tokenrhythm.studio/v1
      models:
        - id: glm-5.3-flash
          name: GLM
          contextWindow: 1000000
        - id: deepseek-v4-pro
          name: DS Pro
    step:
      displayName: 阶跃
      apiKeyEnv: STEP_API_KEY
      baseURL: https://api.stepfun.com/step_plan
      models:
        - id: step-3.7-flash
`

const CREDENTIALS = `version: 1
refs:
  {
    DEEPSEEK_API_KEY: sk_tr_r-g3-PLwrnWWshZVaKLrdgaEYx-pmpwptlREPCAM6-w,
    JY_API_KEY: sk_tr_r-g3-PLwrnWWshZVaKLrdgaEYx-pmpwptlREPCAM6-w,
    STEP_API_KEY: 6w3HJo8lpGEfF3pLhBxNGP6S19j4k7O8l8Uw5ysNNexTdcTGwQwQfgjoLjUkafTJv
  }
records:
  client-connection/browser-session:
    kind: grant
`

const CREDENTIALS_BLOCK = `refs:
  JY_API_KEY: sk_block-nested-key-123456
  STEP_API_KEY:
`
const CREDENTIALS_FLAT = 'JY_API_KEY: sk_flat-legacy-key-98765\nOTHER: x'

test('parseSettingsProviders: flow 布局（真实 settings.yaml 形态）', () => {
  const list = parseSettingsProviders(FLOW_SETTINGS)
  assert.equal(list.length, 3)
  const jy = list[0]
  assert.equal(jy.id, 'jy')
  assert.equal(jy.displayName, '基元')
  assert.equal(jy.apiKeyEnv, 'JY_API_KEY')
  assert.equal(jy.baseURL, 'https://tokenrhythm.studio/v1')
  assert.equal(jy.balanceCapable, true)
  assert.equal(jy.models.length, 3)
  assert.deepEqual(jy.models[1], { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', contextWindow: 1000000 })
  const step = list[1]
  assert.equal(step.displayName, '阶跃')
  assert.equal(step.balanceCapable, false)
  assert.equal(step.models.length, 1)
  assert.equal(step.models[0].id, 'step-3.7-flash')
  assert.equal(list[2].id, 'minmax')
  assert.equal(list[2].models[0].id, 'MiniMaxAI/MiniMax-M3')
})

test('parseSettingsProviders: block 布局（缩进式 + - id: 列表项）', () => {
  const list = parseSettingsProviders(BLOCK_SETTINGS)
  assert.equal(list.length, 2)
  const jy = list[0]
  assert.equal(jy.id, 'jy')
  assert.equal(jy.apiKeyEnv, 'JY_API_KEY')
  assert.equal(jy.balanceCapable, true)
  assert.equal(jy.models.length, 2)
  assert.equal(jy.models[0].id, 'glm-5.3-flash')
  assert.equal(jy.models[0].contextWindow, 1000000)
  assert.equal(jy.models[1].contextWindow, null)
  assert.equal(list[1].models[0].id, 'step-3.7-flash')
})

test('parseSettingsProviders: 带 # 注释与空行不干扰', () => {
  const text = FLOW_SETTINGS.replace('llm-pi-ai:', 'llm-pi-ai: # 我的提供商\n')
    + '\n# 全行注释 { providers: { fake: {} } }\n'
  const list = parseSettingsProviders(text)
  assert.equal(list.length, 3)
  assert.equal(list[0].id, 'jy')
})

test('parseSettingsProviders: 空/损坏输入返回空数组不抛错', () => {
  assert.deepEqual(parseSettingsProviders(''), [])
  assert.deepEqual(parseSettingsProviders(null), [])
  assert.deepEqual(parseSettingsProviders('foo: { bar'), [])
  assert.deepEqual(parseSettingsProviders('providers: { jy: { baseURL: x '), [])
})

test('extractCredentialFromText: refs flow 布局', () => {
  assert.equal(extractCredentialFromText('JY_API_KEY', CREDENTIALS), 'sk_tr_r-g3-PLwrnWWshZVaKLrdgaEYx-pmpwptlREPCAM6-w')
  assert.equal(extractCredentialFromText('STEP_API_KEY', CREDENTIALS), '6w3HJo8lpGEfF3pLhBxNGP6S19j4k7O8l8Uw5ysNNexTdcTGwQwQfgjoLjUkafTJv')
})

test('extractCredentialFromText: 嵌套 block 与旧平铺布局', () => {
  assert.equal(extractCredentialFromText('JY_API_KEY', CREDENTIALS_BLOCK), 'sk_block-nested-key-123456')
  assert.equal(extractCredentialFromText('JY_API_KEY', CREDENTIALS_FLAT), 'sk_flat-legacy-key-98765')
})

test('extractCredentialFromText: 带引号值 / 缺失 / 注释行', () => {
  assert.equal(extractCredentialFromText('K', 'refs: { K: "sk_quoted-v" }'), 'sk_quoted-v')
  assert.equal(extractCredentialFromText('MISSING_KEY', CREDENTIALS), null)
  assert.equal(extractCredentialFromText('K', '# K: sk_commented\nrefs: { K: sk_real }'), 'sk_real')
  assert.equal(extractCredentialFromText('STEP_API_KEY', CREDENTIALS_BLOCK), null) // 空值视为缺失
  assert.equal(extractCredentialFromText('', CREDENTIALS), null)
})

test('normalizeModels: {data:[]} 信封与字段归一化', () => {
  const json = {
    data: [
      {
        id: 'glm-5',
        context_length: 1000000,
        max_output_tokens: 96000,
        currency: 'CNY',
        input_price_per_million: 6,
        output_price_per_million: 22,
        cache_price_per_million: 1.5,
        effective_input_price_per_million: 3,
        effective_output_price_per_million: 11,
        effective_cache_price_per_million: 0.75,
        supports_tools: true,
        supports_reasoning: true,
        supports_vision: false,
        responses_capabilities: { webSearch: true },
      },
      { id: 'minimal' },
      { no_id: true },
      'junk',
    ],
  }
  const list = normalizeModels(json)
  assert.equal(list.length, 2)
  const glm = list[0]
  assert.equal(glm.id, 'glm-5')
  assert.equal(glm.contextLength, 1000000)
  assert.equal(glm.maxOutput, 96000)
  assert.equal(glm.inPrice, 6)
  assert.equal(glm.outPrice, 22)
  assert.equal(glm.cachePrice, 1.5)
  assert.equal(glm.effInPrice, 3)
  assert.equal(glm.effOutPrice, 11)
  assert.equal(glm.effCachePrice, 0.75)
  assert.equal(glm.hasDiscount, true)
  assert.equal(glm.tools, true)
  assert.equal(glm.reasoning, true)
  assert.equal(glm.vision, false)
  assert.equal(glm.responses, true)
  assert.equal(glm.webSearch, true)
  const minimal = list[1]
  assert.equal(minimal.id, 'minimal')
  assert.equal(minimal.contextLength, null)
  assert.equal(minimal.inPrice, null)
  assert.equal(minimal.hasDiscount, false)
  assert.equal(minimal.currency, 'CNY')
})

test('normalizeModels: 裸数组 / 非法输入 / 字符串数字', () => {
  const bare = normalizeModels([{ id: 'm1', input_price_per_million: '8.5' }])
  assert.equal(bare.length, 1)
  assert.equal(bare[0].inPrice, 8.5)
  assert.deepEqual(normalizeModels({ data: 'nope' }), [])
  assert.deepEqual(normalizeModels(null), [])
  assert.deepEqual(normalizeModels({ data: [{ id: 'x', context_length: 'abc' }] })[0].contextLength, null)
})

test('normalizeBalance: 信封 + snake_case + me 账户名', () => {
  const b = normalizeBalance(
    { data: { availableBalanceCny: 123.45, input_tokens: 1000000, outputTokens: 2500, total_cost_cny: 66.6 } },
    { data: { nickname: '李四', email: 'l@example.com' } },
  )
  assert.equal(b.balanceCny, 123.45)
  assert.equal(b.inputTokens, 1000000)
  assert.equal(b.outputTokens, 2500)
  assert.equal(b.costCny, 66.6)
  assert.equal(b.account, '李四')
  assert.equal(typeof b.fetchedAt, 'number')
})

test('accountNameFromMe: 信封 / 字段优先级 / 脏数据', () => {
  assert.equal(accountNameFromMe({ data: { name: 'alice' } }), 'alice')
  assert.equal(accountNameFromMe({ name: 'a', nickname: 'b', username: 'c', email: 'd', id: 5 }), 'a')
  assert.equal(accountNameFromMe({ nickname: '昵称', username: 'u1' }), '昵称')
  assert.equal(accountNameFromMe({ username: 'u1', email: 'e@x.com' }), 'u1')
  assert.equal(accountNameFromMe({ email: 'e@x.com', id: 5 }), 'e@x.com')
  assert.equal(accountNameFromMe({ id: 12345 }), '12345')
  assert.equal(accountNameFromMe(null), '')
  assert.equal(accountNameFromMe('garbage'), '')
  assert.equal(accountNameFromMe({ data: {} }), '')
  assert.equal(accountNameFromMe({ data: { name: '   ' } }), '')
})

test('normalizeBalance: 限时额度 / 冻结 / 到期时间 / 调用统计', () => {
  const b = normalizeBalance({
    code: 0,
    data: {
      balanceCny: 53.50849612,
      availableBalanceCny: 53.50849612,
      frozenBalanceCny: 0,
      expiringBalanceCny: 53.50849612,
      nextExpiryAt: '2026-09-03T03:20:12.302Z',
      calls: 691, successCalls: 651,
      inputTokens: 96740434, outputTokens: 210554, costCny: 14.49150388, currency: 'CNY',
    },
  }, null)
  assert.equal(b.balanceCny, 53.50849612)
  assert.equal(b.availableBalanceCny, 53.50849612)
  assert.equal(b.frozenBalanceCny, 0)
  assert.equal(b.expiringBalanceCny, 53.50849612)
  assert.equal(b.nextExpiryAt, '2026-09-03T03:20:12.302Z')
  assert.equal(b.calls, 691)
  assert.equal(b.successCalls, 651)
  assert.equal(b.currency, 'CNY')
})

test('summarizeDailyLogs: 聚合当日调用日志', () => {
  const r = summarizeDailyLogs({
    data: {
      list: [
        { status: 200, inputTokens: 1000, outputTokens: 200, costCny: 0.5 },
        { status: 200, inputTokens: 500, outputTokens: 100, costCny: 0.25 },
        { status: 429, inputTokens: 10, outputTokens: 0, costCny: 0 },
      ],
    },
  })
  assert.equal(r.calls, 3)
  assert.equal(r.successCalls, 2)
  assert.equal(r.inputTokens, 1510)
  assert.equal(r.outputTokens, 300)
  assert.equal(r.costCny, 0.75)
  assert.equal(r.fetched, 3)
})

test('summarizeDailyLogs: 空响应 / 裸数组 / 脏数据不抛错', () => {
  assert.deepEqual(
    { ...summarizeDailyLogs(null), fetched: 0 },
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costCny: 0, calls: 0, successCalls: 0, fetched: 0 },
  )
  const bare = summarizeDailyLogs([{ inputTokens: 'abc', outputTokens: 5, cacheReadTokens: 7, costCny: null, status: 'x' }])
  assert.equal(bare.inputTokens, 0) // 非法数值按 0 计
  assert.equal(bare.outputTokens, 5)
  assert.equal(bare.cacheReadTokens, 7)
  assert.equal(bare.calls, 1)
})


test('normalizeBalance: 字段缺失记 null 不抛错', () => {
  const b = normalizeBalance({}, null)
  assert.equal(b.balanceCny, null)
  assert.equal(b.costCny, null)
  assert.equal(b.account, '')
})

test('extractExpiringItems: 候选键直取 + 按到期时间升序 + 名称可选', () => {
  const items = extractExpiringItems({ data: { expiringItems: [
    { amountCny: 119.3, expireAt: '2026-09-28T00:00:00.000Z' },
    { amountCny: 200, expireAt: '2026-09-04T00:00:00.000Z', name: '新人礼' },
    { amountCny: 150, expireAt: '2026-09-15T00:00:00.000Z' },
  ] } })
  assert.equal(items.length, 3)
  assert.equal(Date.parse(items[0].expireAt) < Date.parse(items[1].expireAt), true)
  assert.equal(items[0].amountCny, 200)
  assert.equal(items[0].name, '新人礼')
})

test('extractExpiringItems: snake_case 候选键 + 信封 + 字符串金额', () => {
  const items = extractExpiringItems({ data: { expiring_list: [
    { amount_cny: '88.5', expire_at: '2026-09-10T00:00:00Z' },
  ] } })
  assert.equal(items.length, 1)
  assert.equal(items[0].amountCny, 88.5)
  assert.equal(items[0].expireAt, '2026-09-10T00:00:00.000Z')
})

test('extractExpiringItems: 深度扫描兜底（未知键名）', () => {
  const items = extractExpiringItems({ data: { whatever: { rows: [
    { quota: 30, deadline: '2026-12-01T00:00:00Z', title: '活动赠送' },
    { quota: 10, deadline: '2026-12-20T00:00:00Z' },
    { note: '不是钱', expireAt: '2026-12-22' },
    { amount: 5 },
  ] } } })
  assert.equal(items.length, 2)
  assert.equal(items[0].amountCny, 30)
  assert.equal(items[0].name, '活动赠送')
  assert.equal(Date.parse(items[0].expireAt) < Date.parse(items[1].expireAt), true)
})

test('extractExpiringItems: 缺失/空/脏数据 → []', () => {
  assert.deepEqual(extractExpiringItems(null), [])
  assert.deepEqual(extractExpiringItems({}), [])
  assert.deepEqual(extractExpiringItems({ data: { expiringItems: [] } }), [])
  assert.deepEqual(extractExpiringItems({ data: { expiringItems: [{ amount: 'x' }] } }), [])
  assert.deepEqual(extractExpiringItems({ data: { expiringItems: 'nope' } }), [])
})

test('normalizeExpiringCredits: 平台实测形态 → 剩余额升序 + sourceLabel 作名', () => {
  const items = normalizeExpiringCredits({ code: 0, data: {
    summary: { expiringBalanceCny: '147.99603126', nextExpiryAt: '2026-09-14T17:21:02.054Z' },
    list: [
      { id: 'b', source: 'REFERRAL_INVITER_REWARD', sourceLabel: '邀请奖励', grantedCny: '68.00000000', remainingCny: '68.00000000', grantedAt: '2026-08-26T07:46:03.210Z', expiresAt: '2026-09-26T07:46:03.210Z' },
      { id: 'a', source: 'REFERRAL_INVITER_REWARD', sourceLabel: '邀请奖励', grantedCny: '68.00000000', remainingCny: '11.99603126', grantedAt: '2026-08-14T17:21:02.054Z', expiresAt: '2026-09-14T17:21:02.054Z' },
    ],
    total: 2, page: 1, pageSize: 20,
  } })
  assert.equal(items.length, 2)
  assert.equal(Date.parse(items[0].expireAt) < Date.parse(items[1].expireAt), true, '应按到期时间升序')
  assert.equal(items[0].amountCny, 11.99603126, '金额应取剩余额 remainingCny')
  assert.equal(items[0].name, '邀请奖励')
})

test('normalizeExpiringCredits: 剩余 0 丢弃 / 坏数据丢弃 / 不可用返回 null', () => {
  const items = normalizeExpiringCredits({ data: { list: [
    { sourceLabel: 'x', remainingCny: '0.00000000', expiresAt: '2026-09-14T00:00:00Z' },
    { sourceLabel: 'y', remainingCny: '5', expiresAt: '垃圾时间' },
    { sourceLabel: 'z', remainingCny: '8', expiresAt: '2026-10-01T00:00:00Z' },
    'junk',
  ] } })
  assert.equal(items.length, 1)
  assert.equal(items[0].amountCny, 8)
  assert.equal(normalizeExpiringCredits(null), null, '不可用 → null（调用方回退深扫）')
  assert.equal(normalizeExpiringCredits({}), null)
  assert.equal(normalizeExpiringCredits({ data: { nope: true } }), null)
})

test('normalizeBalance: expiringJson 为权威，失败回退 usage-summary 深扫', () => {
  const summary = { data: { expiringItems: [{ amountCny: 5, expireAt: '2026-09-04T00:00:00Z' }] } }
  const credits = { data: { list: [
    { sourceLabel: '邀请奖励', remainingCny: '11.99603126', expiresAt: '2026-09-14T17:21:02.054Z' },
  ] } }
  const fromCredits = normalizeBalance(summary, null, credits)
  assert.equal(fromCredits.expiringItems.length, 1)
  assert.equal(fromCredits.expiringItems[0].amountCny, 11.99603126)
  const fallback = normalizeBalance(summary, null, null)
  assert.equal(fallback.expiringItems[0].amountCny, 5)
  const empty = normalizeBalance({}, null)
  assert.deepEqual(empty.expiringItems, [])
})

test('normalizeBalance: 附带 expiringItems 字段', () => {
  const b = normalizeBalance({ data: { balanceCny: 10, expiringItems: [{ amountCny: 5, expireAt: '2026-09-04T00:00:00Z' }] } }, null)
  assert.equal(b.expiringItems.length, 1)
  assert.equal(b.expiringItems[0].amountCny, 5)
  const empty = normalizeBalance({}, null)
  assert.deepEqual(empty.expiringItems, [])
})

test('maskSecret: 前 5 位…(长度)', () => {
  assert.equal(maskSecret('sk_tr_r-g3-PLwrnWWshZVaKLrdgaEYx-pmpwptlREPCAM6-w'), 'sk_tr…(49)')
  assert.equal(maskSecret(''), '')
  assert.equal(maskSecret(null), '')
})

test('extractSessionCookie: 整段 Cookie / 键值对 / 裸值 / 垃圾输入', () => {
  assert.equal(extractSessionCookie('tr_session=sess_abc123'), 'sess_abc123')
  assert.equal(extractSessionCookie('other=x; tr_session = sess_def456 ; more=y'), 'sess_def456')
  assert.equal(extractSessionCookie('sess_plain789'), 'sess_plain789')
  assert.equal(extractSessionCookie(''), '')
  assert.equal(extractSessionCookie('随便一句话'), '')
})

test('extractCsrfCookie: 整段 Cookie 提取 tr_csrf / 裸 session 不含则空', () => {
  assert.equal(extractCsrfCookie('tr_csrf=tok123; tr_session=sess_abc'), 'tok123')
  assert.equal(extractCsrfCookie('tr_session=sess_abc; tr_csrf = tok_xyz ; x=1'), 'tok_xyz')
  assert.equal(extractCsrfCookie('sess_plain789'), '')
  assert.equal(extractCsrfCookie(''), '')
})

test('normalizePlatformModels: 透传来源显示名与平台状态（online/testing）', () => {
  const list = normalizePlatformModels({
    data: [
      { id: 'glm-5.1', name: 'GLM-5.1', type: 'chat', status: 'online', provider: 'infini', providerDisplayName: '无问芯穹', inputPrice: '8', outputPrice: '28' },
      { id: 'glm-5.3', name: 'GLM-5.3', type: 'chat', status: 'testing', provider: 'bailian', providerDisplayName: '百炼', inputPrice: '8', outputPrice: '28' },
    ],
  })
  assert.equal(list[0].provider, '无问芯穹')
  assert.equal(list[0].platformStatus, 'online')
  assert.equal(list[1].provider, '百炼')
  assert.equal(list[1].platformStatus, 'testing')
})

test('normalizePlatformModels: 多上游来源合并为品牌列表（providerBrands）', () => {
  const list = normalizePlatformModels({
    data: [{
      id: 'deepseek-v3', name: 'DeepSeek V3', type: 'chat', status: 'online',
      provider: 'deepseek', providerDisplayName: 'DeepSeek',
      providerBrands: [
        { provider: 'deepseek', providerBrandName: 'DeepSeek' },
        { provider: 'bailian', providerBrandName: '阿里云' },
        { provider: 'infini', providerBrandName: '无问' },
      ],
      inputPrice: '4', outputPrice: '16',
    }],
  })
  assert.equal(list[0].provider, 'DeepSeek / 阿里云 / 无问')
})

test('平台变更请求 CSRF 防护：统一头与 403 自愈（源码断言）', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  // 变更请求需 CSRF 双提交 + fetch-metadata 校验（浏览器自动带，node 须手动补）
  assert.ok(src.includes("'X-CSRF-Token'"), 'trHeaders 应支持 X-CSRF-Token 双提交头')
  assert.ok(src.includes("'Sec-Fetch-Site': 'same-origin'"), '平台请求应带 Sec-Fetch-Site（fetch-metadata 校验）')
  assert.ok(src.includes('Origin: TOKENRHYTHM_BASE'), '平台请求应带 Origin')
  // 403 CSRF_INVALID 自愈：/auth/me 刷新 cookie 对后重试一次
  assert.ok(src.includes('CSRF_INVALID'), '变更封装应识别 CSRF_INVALID')
  assert.ok(src.includes('/api/auth/me'), '自愈应经 /api/auth/me 刷新 cookie 对')
  assert.ok(src.includes('const trMutate'), '变更类请求应走 trMutate 自愈封装')
  // tr_csrf 与 tr_session 一同持久化（0600）
  assert.ok(src.includes('csrf: state.csrf'), 'state 应持久化 csrf')
})

test('stripYamlComments: 引号内 # 与行中 # 的边界', () => {
  assert.equal(stripYamlComments('a: "x # y" # note'), 'a: "x # y" ')
  assert.equal(stripYamlComments('a: 1 #c\nb: 2'), 'a: 1 \nb: 2')
})

test('normalizePlatformModels: 平台模型列表归一化 + 分类口径', () => {
  const list = normalizePlatformModels({
    data: [
      {
        id: 'glm-5', name: 'GLM-5', type: 'chat',
        contextWindow: 1000000, maxOutputTokens: 128000,
        inputPrice: '0.80000000', outputPrice: '2.80000000', cacheReadPrice: '0.23000000',
        discountInputPrice: '0.40000000', discountOutputPrice: '1.40000000',
        hasDiscount: true, effectiveInputPrice: '0.40000000', effectiveOutputPrice: '1.40000000',
        capabilities: { tools: true, reasoning: true, vision: false, audio: false, video: false, embeddings: false, responses: false },
        modalities: ['text'],
      },
      {
        id: 'vid-u1', name: 'Video U1', type: 'chat',
        inputPrice: null, outputPrice: null,
        capabilities: { tools: false, reasoning: false, vision: true, audio: false, video: true, embeddings: false, responses: false },
        modalities: ['text', 'image', 'video'],
      },
      {
        id: 'img-x1', name: 'Image X1', type: 'image',
        pricePerImage: '0.20000000',
        capabilities: { tools: false, reasoning: false, vision: false, audio: false, video: false, embeddings: false, responses: false },
        modalities: ['text', 'image'],
      },
      { id: 'emb-e1', name: 'Embed E1', type: 'chat', capabilities: { embeddings: true, audio: false } },
      { no_id: true }, 'junk',
    ],
  })
  assert.equal(list.length, 4)
  const glm = list[0]
  assert.equal(glm.name, 'GLM-5')
  assert.equal(glm.contextLength, 1000000)
  assert.equal(glm.inPrice, 0.8)
  assert.equal(glm.effInPrice, 0.4)
  assert.equal(glm.hasDiscount, true)
  assert.equal(glm.categories.includes('text'), true)
  assert.deepEqual(list[1].categories, ['text', 'video'])
  assert.deepEqual(list[2].categories, ['image'])
  assert.equal(list[2].perImagePrice, 0.2)
  assert.deepEqual(list[3].categories, ['text', 'vector'])
  const counts = categoryCounts(list)
  assert.equal(counts.all, 4)
  assert.equal(counts.text, 3)
  assert.equal(counts.image, 1)
  assert.equal(counts.video, 1)
  assert.equal(counts.audio, 0)
  assert.equal(counts.vector, 1)
})

test('normalizePlatformModels: 空响应 / 裸数组不抛错', () => {
  assert.deepEqual(normalizePlatformModels(null), [])
  assert.deepEqual(normalizePlatformModels({ data: { list: [] } }), [])
  const bare = normalizePlatformModels([{ id: 'm1', type: 'chat' }])
  assert.equal(bare.length, 1)
  assert.equal(bare[0].categories.includes('text'), true)
})

test('normalizePlatformKeys / sanitizeAccounts: 平台密钥与账号列表', async () => {
  const { normalizePlatformKeys, sanitizeAccounts } = await import('../lib/index.js')
  const list = normalizePlatformKeys({ data: [
    { id: 'k1', name: '新 Key 3', maskedKey: 'sk_tr_r-****CAM6-w', keyPrefix: 'sk_tr_r-g3-P', status: 'enabled', lastUsedAt: '2026-08-29T15:59:03Z', createdAt: '2026-08-08T01:47:30Z' },
    { id: 'k2', name: '', keyPrefix: 'sk_tr_9cGuPn', status: 'disabled' },
    { junk: true },
  ] })
  assert.equal(list.length, 2)
  assert.equal(list[0].masked, 'sk_tr_r-****CAM6-w') // maskedKey 自含前缀，不重复拼接
  assert.equal(list[0].name, '新 Key 3')
  assert.equal(list[1].name, '未命名密钥')
  assert.equal(list[1].masked, 'sk_tr_9cGuPn****')
  const accs = sanitizeAccounts([
    { account: 'A', password: 'p1' },
    { account: 'a', password: 'p2' },       // 同账号（大小写）去重，保留先者
    { account: '', password: 'x' },         // 空账号丢弃
    { account: 'B' },                        // 密码缺失视为空串，保留
    'junk',
  ])
  assert.equal(accs.length, 2)
  assert.equal(accs[0].account, 'A')
  assert.equal(accs[0].password, 'p1')
  assert.equal(accs[1].account, 'B')
  assert.deepEqual(sanitizeAccounts(null), [])
})

// ---- 更新检测纯函数 ----

test('isNewerVersion: 三元逐段比较，忽略 prerelease，脏输入 false', () => {
  assert.equal(isNewerVersion('0.3.2', '0.4.0'), true)
  assert.equal(isNewerVersion('0.4.0', '0.3.2'), false)
  assert.equal(isNewerVersion('0.3.2', '0.3.2'), false)
  assert.equal(isNewerVersion('0.3.2', '0.3.10'), true, '逐段数值比较，不是字符串比较')
  assert.equal(isNewerVersion('0.3.2', '1.0.0'), true)
  assert.equal(isNewerVersion('0.3.2', '0.4.0-beta.1'), true, 'prerelease 后缀被忽略')
  assert.equal(isNewerVersion('v0.3.2', 'v0.4.0'), true, '容忍 v 前缀')
  assert.equal(isNewerVersion('0.3.2', '0.4'), false, '缺 patch 位不解析')
  assert.equal(isNewerVersion('', '0.4.0'), false)
  assert.equal(isNewerVersion('x.y.z', '0.4.0'), false)
  assert.equal(isNewerVersion(null, null), false)
})

test('normalizeDistTags: 裸 tags / dist-tags 信封 / 脏数据', () => {
  assert.equal(normalizeDistTags({ latest: '0.4.0' }), '0.4.0')
  assert.equal(normalizeDistTags({ 'dist-tags': { latest: '1.2.3' } }), '1.2.3')
  assert.equal(normalizeDistTags({}), null)
  assert.equal(normalizeDistTags({ latest: 'not-a-version' }), null)
  assert.equal(normalizeDistTags(null), null)
})

test('sanitizeUpdate: 只留合法字段，版本串必须可解析', () => {
  const clean = sanitizeUpdate({ latestVersion: '0.4.0', checkedAt: 1700000000000, currentAtCheck: '0.3.2', ignoredVersion: '0.4.0', junk: 'x' })
  assert.deepEqual(clean, { latestVersion: '0.4.0', checkedAt: 1700000000000, currentAtCheck: '0.3.2', ignoredVersion: '0.4.0' })
  assert.deepEqual(sanitizeUpdate({ latestVersion: 'garbage', checkedAt: -5, currentAtCheck: '0.4' }), {})
  assert.deepEqual(sanitizeUpdate(null), {})
  assert.deepEqual(sanitizeUpdate('nope'), {})
})

test('detectInstallMode: 默认 npm / 显式 home 无链接时 npm', () => {
  assert.equal(detectInstallMode('C:\nonexistent-dsh-home-for-test'), 'npm')
  assert.equal(typeof detectInstallMode(), 'string')
})

test('sanitizeEntryBalance: 只认 total / expiring', () => {
  assert.equal(sanitizeEntryBalance('total'), 'total')
  assert.equal(sanitizeEntryBalance('expiring'), 'expiring')
  assert.equal(sanitizeEntryBalance('bogus'), null)
  assert.equal(sanitizeEntryBalance(''), null)
  assert.equal(sanitizeEntryBalance(undefined), null)
  assert.equal(sanitizeEntryBalance(null), null)
})

// ---- normalizeStatus：status.moonlink.top 90d 聚合 → 面板轻量结构 ----
// 夹具形态照抄真实响应：latest.models 是 {id: item}；incidents 是 {events: [...]}
// （90d 档实测形态）；days 三天、'@api' 无逐日记录。
const ST_RAW = {
  latest: {
    checked_at: 1788484594,
    overall: 'partial_outage',
    model_count: 3,
    models: {
      '@api': { model: '@api', status: 'up', http: 200, ttfb: 525, error: null },
      'glm-5.3-flash': { model: 'glm-5.3-flash', status: 'up', http: 200, ttfb: 8167, error: null },
      'qwen3.7-max': { model: 'qwen3.7-max', status: 'down', http: 503, ttfb: 1240, error: 'HTTP 503: API Key 鉴权服务暂时不可用' },
    },
  },
  history: {
    days: {
      '2026-09-01': { 'glm-5.3-flash': { ok: 286, t: 288 }, 'qwen3.7-max': { ok: 100, t: 100 } },
      '2026-09-02': { 'glm-5.3-flash': { ok: 288, t: 288 }, 'qwen3.7-max': { ok: 90, t: 100 } },
      '2026-09-03': { 'glm-5.3-flash': { ok: 280, t: 288 }, 'qwen3.7-max': { ok: 80, t: 100 } },
    },
  },
  catalog: {
    models: {
      'glm-5.3-flash': { context_length: 132000, input_price: 0.5, output_price: 2 },
      'qwen3.7-max': { context_length: 262144, input_price: 2, output_price: 8 },
    },
  },
  incidents: {
    events: [
      { title: 'qwen3.7-max 服务中断', detail: 'HTTP 503', started_at: 100, resolved_at: 200 },
      { title: 'glm-5.3 服务中断', detail: '', started_at: 300, resolved_at: 0 },
    ],
  },
}

test('normalizeStatus: 可用率聚合 / 事故排序 / 汇总指标', () => {
  const d = normalizeStatus(ST_RAW)
  assert.ok(d)
  assert.equal(d.overall, 'partial_outage')
  assert.equal(d.checkedAt, 1788484594)
  assert.equal(d.modelCount, 3)
  assert.equal(d.upCount, 2)
  assert.equal(d.historyDays, 3)
  const glm = d.models.find((m) => m.id === 'glm-5.3-flash')
  const qwen = d.models.find((m) => m.id === 'qwen3.7-max')
  const api = d.models.find((m) => m.id === '@api')
  assert.ok(glm && qwen && api)
  // a24 = 今天（days 最大 key 2026-09-03）逐模型成功率，%保留 1 位
  assert.equal(glm.a24, Math.round((280 / 288) * 1000) / 10)
  assert.equal(qwen.a24, 80)
  assert.equal(qwen.status, 'down')
  assert.equal(qwen.http, 503)
  // a7 / a90：夹具只有 3 天 → 两个窗口相同（全量）
  const glmAll = Math.round(((286 + 288 + 280) / (288 + 288 + 288)) * 1000) / 10
  assert.equal(glm.a7, glmAll)
  assert.equal(glm.a90, glmAll)
  // '@api' 无逐日记录 → 三个窗口都 null
  assert.equal(api.a24, null)
  assert.equal(api.a7, null)
  assert.equal(api.a90, null)
  // 逐模型逐日（千分比整数、对齐 days 键序；'@api' 全 null）+ meta 文案（ctx · ¥in/out）
  assert.deepEqual(d.days, ['2026-09-01', '2026-09-02', '2026-09-03'])
  assert.deepEqual(d.modelDaily['glm-5.3-flash'], [993, 1000, 972])
  assert.deepEqual(d.modelDaily['qwen3.7-max'], [1000, 900, 800])
  assert.deepEqual(d.modelDaily['@api'], [null, null, null])
  assert.equal(d.meta['glm-5.3-flash'], '132K · ¥0.5/2')
  assert.equal(d.meta['qwen3.7-max'], '262.144K · ¥2/8')
  assert.equal(d.meta['@api'], undefined)
  // daily 全通道合并：第一天 (286+100)/(288+100)=99.48
  assert.equal(d.daily.length, 3)
  assert.equal(d.daily[0].d, '2026-09-01')
  assert.equal(d.daily[0].v, Math.round((386 / 388) * 10000) / 100)
  // todayAvail = 今天全通道合并 (280+80)/(288+100)
  assert.equal(d.todayAvail, Math.round((360 / 388) * 10000) / 100)
  // avgTtfb 只统计 up 通道（@api 525 + glm 8167；down 的 qwen 不计）
  assert.equal(d.avgTtfb, Math.round((525 + 8167) / 2))
  // incidents：{events:[…]} 实测形态 → 数组、started_at 降序、resolved_at=0 视为未解决
  assert.equal(d.incidents.length, 2)
  assert.equal(d.incidents[0].title, 'glm-5.3 服务中断')
  assert.equal(d.incidents[0].resolvedAt, 0)
  assert.equal(d.incidents[1].resolvedAt, 200)
  assert.equal(d.unresolvedCount, 1)
})

test('normalizeStatus: 裸数组 / 平铺对象 incidents / 未知状态归 down / 坏输入 → null', () => {
  const arr = normalizeStatus({
    ...ST_RAW,
    incidents: [
      { title: 'x 服务中断', detail: 'timeout', started_at: 5, resolved_at: 6 },
      { title: 'y 服务中断', started_at: 9 },
    ],
  })
  assert.equal(arr.incidents.length, 2)
  assert.equal(arr.incidents[0].title, 'y 服务中断', '无 resolved_at 视为未解决且按 started_at 降序')
  assert.equal(arr.unresolvedCount, 1)
  // 平铺 {id: item} 形态（防御）
  const flat = normalizeStatus({
    ...ST_RAW,
    incidents: { k1: { title: 'f 服务中断', started_at: 7, resolved_at: 8 } },
  })
  assert.equal(flat.incidents.length, 1)
  assert.equal(flat.incidents[0].title, 'f 服务中断')
  // status 未知值 → down（白名单外兜底）
  const bad = normalizeStatus({ latest: { checked_at: 1, overall: 'weird', models: { m: { model: 'm', status: '???' } } } })
  assert.equal(bad.models[0].status, 'down')
  assert.equal(bad.overall, 'weird', 'overall 原样透传，映射交给前端')
  // 无 days → 窗口可用率全 null、daily 空
  assert.equal(bad.daily.length, 0)
  assert.equal(bad.todayAvail, null)
  // 不可解析入参
  assert.equal(normalizeStatus(null), null)
  assert.equal(normalizeStatus('nope'), null)
  assert.equal(normalizeStatus({}), null)
  assert.equal(normalizeStatus({ latest: {} }), null)
  assert.equal(normalizeStatus({ latest: { models: [] } }), null, 'latest.models 必须是对象')
})

test('normalizeStatus: 24h/7d 档 slots → 官方式细格子（grid + 每模型状态码串）', () => {
  const d = normalizeStatus({
    ...ST_RAW,
    range: '24h',
    slots: {
      '2026-09-03': {
        '10:05': { 'glm-5.3-flash': { s: 'degraded', ttfb: 3000, err: null } },
        '10:00': { 'glm-5.3-flash': { s: 'up', ttfb: 500, err: null }, 'qwen3.7-max': { s: 'down', ttfb: null, err: 'HTTP 503' } },
      },
    },
  }, '24h')
  assert.equal(d.range, '24h')
  // grid 展平序 = 日期 × 时刻 双排序（官方同款）；'@api' 无记录 → '-'
  assert.deepEqual(d.slotGrid, [['2026-09-03', ['10:00', '10:05']]])
  assert.equal(d.slotCodes['glm-5.3-flash'], 'ug')
  assert.equal(d.slotCodes['qwen3.7-max'], 'd-')
  assert.equal(d.slotCodes['@api'], '--')
  // 90d 默认档不产细格子字段
  const d90 = normalizeStatus(ST_RAW)
  assert.equal(d90.range, '90d')
  assert.equal(d90.slotGrid, null)
  assert.equal(d90.slotCodes, null)
})
