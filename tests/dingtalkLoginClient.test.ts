import assert from 'node:assert/strict'
import test from 'node:test'
import { DingTalkLoginClient, DingTalkLoginError, type DingTalkLoginClientSettings, type DingTalkLoginErrorCode } from '../server/dingtalkLoginClient.js'

const settings: DingTalkLoginClientSettings = {
  clientId: 'test-client',
  clientSecret: 'secret-never-exposed',
  corpId: 'test-corp',
  requestTimeoutMs: 1000,
}

function responses(): unknown[] {
  return [
    { accessToken: 'user-token-never-exposed', refreshToken: 'refresh-never-exposed', expireIn: 7200 },
    { unionId: 'union-1', nick: '个人昵称' },
    { accessToken: 'corp-token-never-exposed', expireIn: 7200 },
    { errcode: 0, result: { contact_type: 0, userid: 'employee-1' } },
    { errcode: 0, result: { userid: 'employee-1', unionid: 'union-1', name: '企业员工', active: true } },
  ]
}

function mockClient(payloads = responses()) {
  const calls: { url: string; init: RequestInit }[] = []
  const mockFetch: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init })
    const body = payloads[calls.length - 1]
    assert.notEqual(body, undefined, 'unexpected extra provider call')
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 })
  }
  return { client: new DingTalkLoginClient(settings, mockFetch), calls }
}

function errorCode(expected: DingTalkLoginErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof DingTalkLoginError)
    assert.equal(error.code, expected)
    assert.doesNotMatch(String(error), /never-exposed|employee-1|union-1|auth-code/)
    assert.equal(Object.hasOwn(error, 'cause'), false)
    return true
  }
}

test('OAuth login verifies the same active internal identity with enterprise credentials', async () => {
  const { client, calls } = mockClient()
  assert.deepEqual(await client.exchangeCode('auth-code'), {
    corpId: 'test-corp', userId: 'employee-1', unionId: 'union-1', name: '企业员工',
  })
  assert.equal(calls.length, 5)
  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    '/v1.0/oauth2/userAccessToken', '/v1.0/contact/users/me', '/v1.0/oauth2/accessToken',
    '/topapi/user/getbyunionid', '/topapi/v2/user/get',
  ])
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    clientId: settings.clientId, clientSecret: settings.clientSecret, code: 'auth-code', grantType: 'authorization_code',
  })
  assert.equal(new Headers(calls[1].init.headers).get('x-acs-dingtalk-access-token'), 'user-token-never-exposed')
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { appKey: settings.clientId, appSecret: settings.clientSecret })
  assert.deepEqual(JSON.parse(String(calls[3].init.body)), { unionid: 'union-1' })
  assert.deepEqual(JSON.parse(String(calls[4].init.body)), { userid: 'employee-1', language: 'zh_CN' })
  for (const call of calls) {
    assert.equal(call.init.redirect, 'error')
    assert.equal(new URL(call.url).protocol, 'https:')
    assert.ok(call.init.signal instanceof AbortSignal)
  }
  assert.equal(new URL(calls[3].url).searchParams.get('access_token'), 'corp-token-never-exposed')
  assert.equal(new URL(calls[4].url).searchParams.get('access_token'), 'corp-token-never-exposed')
})

test('OAuth login accepts legacy documented string representations of success and active employee', async () => {
  const payloads = responses()
  payloads[3] = { errcode: '0', result: { contact_type: '0', userid: 'employee-1' } }
  payloads[4] = { errcode: '0', result: { userid: 'employee-1', unionid: 'union-1', name: '企业员工', active: 'true' } }
  assert.equal((await mockClient(payloads).client.exchangeCode('auth-code')).userId, 'employee-1')
})

test('missing real credentials and invalid authorization codes fail before network access', async () => {
  let calls = 0
  const mockFetch: typeof fetch = async () => { calls += 1; throw new Error('must not fetch') }
  for (const invalid of [{ clientId: '' }, { clientSecret: '' }, { corpId: '' }, { requestTimeoutMs: 0 }, { requestTimeoutMs: NaN }]) {
    await assert.rejects(new DingTalkLoginClient({ ...settings, ...invalid }, mockFetch).exchangeCode('auth-code'), errorCode('LOGIN_NOT_CONFIGURED'))
  }
  for (const code of ['', ' ', ' auth-code', 'x'.repeat(4097)]) {
    await assert.rejects(new DingTalkLoginClient(settings, mockFetch).exchangeCode(code), errorCode('INVALID_AUTH_CODE'))
  }
  assert.equal(calls, 0)
})

const rejectedResponses: { label: string; index: number; body: unknown; code: DingTalkLoginErrorCode }[] = [
  { label: 'missing user token', index: 0, body: {}, code: 'PROVIDER_INVALID_RESPONSE' },
  { label: 'missing personal unionId', index: 1, body: { nick: 'name' }, code: 'PROVIDER_INVALID_RESPONSE' },
  { label: 'missing enterprise token', index: 2, body: {}, code: 'PROVIDER_INVALID_RESPONSE' },
  { label: 'missing legacy success marker', index: 3, body: { result: { contact_type: 0, userid: 'employee-1' } }, code: 'PROVIDER_INVALID_RESPONSE' },
  { label: 'missing contact type', index: 3, body: { errcode: 0, result: { userid: 'employee-1' } }, code: 'PROVIDER_INVALID_RESPONSE' },
  { label: 'external contact', index: 3, body: { errcode: 0, result: { contact_type: 1, userid: 'employee-1' } }, code: 'NOT_CORP_MEMBER' },
  { label: 'boolean contact type cannot coerce to internal', index: 3, body: { errcode: 0, result: { contact_type: false, userid: 'employee-1' } }, code: 'NOT_CORP_MEMBER' },
  { label: 'unknown enterprise member', index: 3, body: { errcode: 60121, errmsg: 'secret-never-exposed' }, code: 'NOT_CORP_MEMBER' },
  { label: 'different unionId', index: 4, body: { errcode: 0, result: { userid: 'employee-1', unionid: 'union-other', name: 'name', active: true } }, code: 'IDENTITY_MISMATCH' },
  { label: 'different userId', index: 4, body: { errcode: 0, result: { userid: 'employee-other', unionid: 'union-1', name: 'name', active: true } }, code: 'IDENTITY_MISMATCH' },
  { label: 'missing verified unionId', index: 4, body: { errcode: 0, result: { userid: 'employee-1', name: 'name', active: true } }, code: 'PROVIDER_INVALID_RESPONSE' },
  { label: 'inactive employee', index: 4, body: { errcode: 0, result: { userid: 'employee-1', unionid: 'union-1', name: 'name', active: false } }, code: 'INACTIVE_USER' },
  { label: 'unknown activation state', index: 4, body: { errcode: 0, result: { userid: 'employee-1', unionid: 'union-1', name: 'name' } }, code: 'INACTIVE_USER' },
  { label: 'empty enterprise name', index: 4, body: { errcode: 0, result: { userid: 'employee-1', unionid: 'union-1', name: '', active: true } }, code: 'PROVIDER_INVALID_RESPONSE' },
  { label: 'non-object payload', index: 0, body: null, code: 'PROVIDER_INVALID_RESPONSE' },
  { label: 'rejected authorization code', index: 0, body: { code: 'InvalidAuthCode', message: 'auth-code secret-never-exposed' }, code: 'AUTH_CODE_REJECTED' },
  { label: 'provider business rejection', index: 3, body: { errcode: 40014, errmsg: 'corp-token-never-exposed' }, code: 'PROVIDER_REJECTED' },
  { label: 'HTTP unavailable', index: 0, body: new Response('secret-never-exposed', { status: 503 }), code: 'PROVIDER_UNAVAILABLE' },
  { label: 'HTTP permission denial', index: 1, body: new Response('secret-never-exposed', { status: 403 }), code: 'PROVIDER_PERMISSION_DENIED' },
  { label: 'invalid JSON', index: 0, body: new Response('secret-never-exposed'), code: 'PROVIDER_INVALID_RESPONSE' },
]

for (const scenario of rejectedResponses) {
  test(`OAuth login fails closed for ${scenario.label}`, async () => {
    const payloads = responses()
    payloads[scenario.index] = scenario.body
    const { client, calls } = mockClient(payloads)
    await assert.rejects(client.exchangeCode('auth-code'), errorCode(scenario.code))
    assert.equal(calls.length, scenario.index + 1)
  })
}

test('network errors never disclose the provider URL or credentials', async () => {
  const mockFetch: typeof fetch = async () => { throw new Error('https://provider.test/?token=secret-never-exposed') }
  await assert.rejects(new DingTalkLoginClient(settings, mockFetch).exchangeCode('auth-code'), errorCode('PROVIDER_UNAVAILABLE'))
})

test('provider requests time out and expose a safe error', async () => {
  const mockFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('secret-never-exposed')), { once: true })
  })
  await assert.rejects(new DingTalkLoginClient({ ...settings, requestTimeoutMs: 10 }, mockFetch).exchangeCode('auth-code'), errorCode('REQUEST_TIMEOUT'))
})

test('the timeout remains active while reading the provider response body', async () => {
  const mockFetch: typeof fetch = async (_input, init) => new Response(new ReadableStream({
    start(controller) {
      init!.signal!.addEventListener('abort', () => controller.error(new Error('secret-never-exposed')), { once: true })
    },
  }))
  await assert.rejects(new DingTalkLoginClient({ ...settings, requestTimeoutMs: 10 }, mockFetch).exchangeCode('auth-code'), errorCode('REQUEST_TIMEOUT'))
})

test('safe diagnostics identify personal profile permission denial without returning provider data', async () => {
  const payloads = responses()
  payloads[1] = new Response(JSON.stringify({ code: 'provider-secret-never-exposed', message: 'user-token-never-exposed', accessToken: 'never-exposed' }), { status: 403 })
  await assert.rejects(mockClient(payloads).client.exchangeCode('auth-code'), (error: unknown) => {
    assert.ok(error instanceof DingTalkLoginError)
    assert.deepEqual(error.safeDiagnostic(), { code: 'PROVIDER_PERMISSION_DENIED', stage: 'user-profile', httpStatus: 403 })
    assert.doesNotMatch(JSON.stringify(error), /never-exposed|auth-code|message|accessToken/)
    return true
  })
})

test('non-success HTTP responses still classify recognized business errors safely', async () => {
  const payloads = responses()
  payloads[3] = new Response(JSON.stringify({ errcode: 60121, errmsg: 'secret-never-exposed' }), { status: 400 })
  await assert.rejects(mockClient(payloads).client.exchangeCode('auth-code'), (error: unknown) => {
    assert.ok(error instanceof DingTalkLoginError)
    assert.deepEqual(error.safeDiagnostic(), { code: 'NOT_CORP_MEMBER', stage: 'corp-member', httpStatus: 400 })
    return true
  })
})

test('missing OAuth fields identify the stage even after a successful HTTP response', async () => {
  for (const [index, stage] of [[0, 'user-token'], [1, 'user-profile'], [2, 'corp-token'], [3, 'corp-member'], [4, 'corp-profile']] as const) {
    const payloads = responses()
    payloads[index] = index >= 3 ? { errcode: 0, result: {} } : {}
    await assert.rejects(mockClient(payloads).client.exchangeCode('auth-code'), (error: unknown) => {
      assert.ok(error instanceof DingTalkLoginError)
      assert.equal(error.code, 'PROVIDER_INVALID_RESPONSE')
      assert.equal(error.stage, stage)
      assert.doesNotMatch(JSON.stringify(error.safeDiagnostic()), /never-exposed/)
      return true
    })
  }
})

test('personal profile network timeout retains the correct stage without exposing a token', async () => {
  let calls = 0
  const mockFetch: typeof fetch = async (_input, init) => {
    if (++calls === 1) return new Response(JSON.stringify(responses()[0]))
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('user-token-never-exposed')), { once: true })
    })
  }
  await assert.rejects(new DingTalkLoginClient({ ...settings, requestTimeoutMs: 10 }, mockFetch).exchangeCode('auth-code'), (error: unknown) => {
    assert.ok(error instanceof DingTalkLoginError)
    assert.deepEqual(error.safeDiagnostic(), { code: 'REQUEST_TIMEOUT', stage: 'user-profile' })
    return true
  })
})

test('personal profile error-body timeout retains both stage and HTTP status', async () => {
  let calls = 0
  const mockFetch: typeof fetch = async (_input, init) => {
    if (++calls === 1) return new Response(JSON.stringify(responses()[0]))
    return new Response(new ReadableStream({
      start(controller) {
        init!.signal!.addEventListener('abort', () => controller.error(new Error('user-token-never-exposed')), { once: true })
      },
    }), { status: 403 })
  }
  await assert.rejects(new DingTalkLoginClient({ ...settings, requestTimeoutMs: 10 }, mockFetch).exchangeCode('auth-code'), (error: unknown) => {
    assert.ok(error instanceof DingTalkLoginError)
    assert.deepEqual(error.safeDiagnostic(), { code: 'REQUEST_TIMEOUT', stage: 'user-profile', httpStatus: 403 })
    return true
  })
})

function employeeResponses(detailFields: Record<string, unknown>, profileFields: Record<string, unknown> = {}) {
  const payloads = responses()
  payloads[1] = { unionId: 'union-1', ...profileFields }
  payloads[4] = { errcode: 0, result: { userid: 'employee-1', unionid: 'union-1', name: '企业员工', active: true, ...detailFields } }
  return payloads
}

test('verified enterprise employee fields are allowlisted and take precedence over OAuth profile data', async () => {
  const { client, calls } = mockClient(employeeResponses({
    org_email: ' employee@corp.example ', email: 'work@corp.example', mobile: '+86 13800000000',
    avatar: 'https://images.example.test/company-avatar.png', job_number: ' EMP-42 ', dept_id_list: [1, 23, 23],
    accessToken: 'detail-access-never-exposed', refreshToken: 'detail-refresh-never-exposed', password: 'detail-password-never-exposed',
  }, {
    email: 'private@example.test', loginEmail: 'login@example.test', mobile: '13900000000',
    avatarUrl: 'https://images.example.test/personal-avatar.png', accessToken: 'profile-access-never-exposed',
  }))
  const result = await client.exchangeCode('auth-code')
  assert.deepEqual(result, {
    corpId: 'test-corp', userId: 'employee-1', unionId: 'union-1', name: '企业员工',
    orgEmail: 'employee@corp.example', email: 'work@corp.example', mobile: '+86 13800000000',
    avatarUrl: 'https://images.example.test/company-avatar.png', jobNumber: 'EMP-42', departmentIds: [1, 23],
  })
  assert.equal(calls.length, 5, 'optional fields use existing identity requests only')
  assert.doesNotMatch(JSON.stringify(result), /never-exposed|private@|login@|accessToken|refreshToken|password/)
})

test('only phone and avatar may fall back to the OAuth personal profile', async () => {
  const result = await mockClient(employeeResponses({}, {
    email: 'private@example.test', loginEmail: 'private-login@example.test', mobile: '13900000000',
    avatarUrl: 'http://images.example.test/avatar.png',
  })).client.exchangeCode('auth-code')
  assert.deepEqual(result, {
    corpId: 'test-corp', userId: 'employee-1', unionId: 'union-1', name: '企业员工',
    mobile: '13900000000', avatarUrl: 'http://images.example.test/avatar.png',
  })
  assert.equal(Object.hasOwn(result, 'email'), false)
  assert.equal(Object.hasOwn(result, 'orgEmail'), false)
})

test('missing or malformed optional employee fields never block a verified identity', async () => {
  for (const fields of [
    { org_email: null, email: undefined, mobile: null, avatar: undefined, job_number: null, dept_id_list: undefined },
    { org_email: 'not-an-email', email: ['work@corp.example'], mobile: 13800000000, avatar: 'javascript:alert(1)', job_number: {}, dept_id_list: ['1'] },
    { org_email: 'x'.repeat(245) + '@corp.example', email: 'work@corp.example\n', mobile: '1'.repeat(33), avatar: 'https://images.example.test/' + 'a'.repeat(2048), job_number: 'x'.repeat(101), dept_id_list: Array(101).fill(1) },
  ]) {
    assert.deepEqual(await mockClient(employeeResponses(fields)).client.exchangeCode('auth-code'), {
      corpId: 'test-corp', userId: 'employee-1', unionId: 'union-1', name: '企业员工',
    })
  }
})

test('invalid avatar schemes, credentials and malformed department identifiers are omitted', async () => {
  for (const avatar of ['//images.example.test/avatar.png', 'data:image/png;base64,aaa', 'https://user:secret@images.example.test/a.png', 'https://images.example.test/\navatar.png', 'https:\\images.example.test\\avatar.png']) {
    const result = await mockClient(employeeResponses({ avatar })).client.exchangeCode('auth-code')
    assert.equal(Object.hasOwn(result, 'avatarUrl'), false)
  }
  for (const dept_id_list of [[0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], [1, null], { id: 1 }]) {
    const result = await mockClient(employeeResponses({ dept_id_list })).client.exchangeCode('auth-code')
    assert.equal(Object.hasOwn(result, 'departmentIds'), false)
  }
})

test('optional employee metadata cannot override strict enterprise identity validation', async () => {
  const payloads = employeeResponses({
    userid: 'other-user', email: 'work@corp.example', org_email: 'work@corp.example',
    mobile: '13800000000', avatar: 'https://images.example.test/avatar.png', dept_id_list: [1],
  })
  await assert.rejects(mockClient(payloads).client.exchangeCode('auth-code'), errorCode('IDENTITY_MISMATCH'))
})
