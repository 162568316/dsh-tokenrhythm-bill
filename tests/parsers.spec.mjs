import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSettingsProviders,
  extractCredentialFromText,
  normalizeModels,
  normalizePlatformModels,
  categoryCounts,
  normalizeBalance,
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
