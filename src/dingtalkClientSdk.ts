// Keep the H5 auth API isolated: the full SDK also registers mini-app getAuthCode
// under the same internal name and overwrites the PC URL parameter adapter.
import sdk from 'dingtalk-jsapi/entry/union'
import authCodeModule from 'dingtalk-jsapi/api/runtime/permission/requestAuthCode'

// Node ESM and browser bundlers expose this CommonJS default differently.
export const requestAuthCode = typeof authCodeModule === 'function'
  ? authCodeModule
  : (authCodeModule as unknown as { default: typeof authCodeModule }).default
export const environment = sdk.env
