import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('the modular H5 SDK supplies the current page URL to the real PC API adapter', () => {
  // Exercise the installed SDK and its real middleware in an isolated process.
  // Only the final native bridge is stubbed; it cannot reach DingTalk or the app.
  const child = spawnSync(process.execPath, ['--import', 'tsx', '-e', `
    Object.defineProperty(globalThis, 'navigator', {value: {userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DingTalk/7.6.0', language: 'zh-CN'}, configurable: true});
    globalThis.window = globalThis; globalThis.self = globalThis; globalThis.top = globalThis;
    globalThis.name = JSON.stringify({containerId: 'SELFTEST-NATIVE-STUB', hostVersion: '7.6.0', hostOrigin: 'https://desktop.dingtalk.com'});
    globalThis.location = {href: 'http://127.0.0.1:4183/?issue=SELFTEST-PC-PARAMS#details'};
    globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
    globalThis.document = {addEventListener() {}, removeEventListener() {}};
    const bridgePath = require.resolve('dingtalk-jsapi/lib/packages/frame-talk-client-pc/index.js');
    const calls = [];
    require.cache[bridgePath] = {id: bridgePath, filename: bridgePath, loaded: true, exports: {
      invokeAPI(method, params) {
        calls.push({method, keys: Object.keys(params), url: params.url});
        return {result: Promise.resolve({code: 'SELFTEST-MOCK-ONLY'})};
      }
    }};
    import('./src/dingtalkClientSdk.ts').then(async (client) => {
      await client.requestAuthCode({corpId: 'SELFTEST-MOCK-CORP'});
      process.stdout.write(JSON.stringify({platform: client.environment.platform, calls}));
    }).catch((error) => { process.stderr.write(String(error)); process.exit(1); });
  `], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), {
    platform: 'pc',
    calls: [{ method: 'runtime.permission.requestAuthCode', keys: ['corpId', 'url'], url: 'http://127.0.0.1:4183/?issue=SELFTEST-PC-PARAMS' }],
  })
})
