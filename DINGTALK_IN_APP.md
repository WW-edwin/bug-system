# 钉钉内免登：第二阶段

本阶段让已关联员工在钉钉客户端内打开灰度 Bug 链接时，自动验证当前钉钉身份并进入对应缺陷。试用名单仍仅为徐浩雯，不自动注册、批量关联或扩大员工访问范围。

第一阶段浏览器扫码登录和本人验证旧账号关联仍然保留，见 [DINGTALK_LOGIN.md](DINGTALK_LOGIN.md)。

## 使用行为

- 普通浏览器维持原有扫码或密码登录入口，不加载钉钉客户端 SDK。
- 钉钉客户端内先验证当前钉钉身份，再显示工作台。已有系统会话也需要核验，避免钉钉切换账号后看到前一个账号的数据。
- 服务端发起免登时只撤销本请求携带的旧会话，不影响其他浏览器的会话。
- 已完成第一阶段关联的员工直接进入原账号，保留角色、项目和缺陷归属。
- 尚未关联的员工需验证原系统姓名和密码；通知邮箱匹配记录不能替代登录身份。
- 缺陷链接 `/?issue=<issueKey>` 在免登和关联过程中保留，完成后打开对应缺陷详情。
- 免登失败显示重试、账号登录和扫码授权入口；切换登录方式会先清理当前流程和旧会话。SDK 原始错误、授权码不显示或记录。
- 本页退出登录后停留在账号登录页面，需要本人点击“使用当前钉钉账号登录”才能再次免登，不会立即循环登录。重新打开应用视为一次新的身份验证。

## 配置与部署

```env
DINGTALK_LOGIN_ENABLED=true
DINGTALK_IN_APP_LOGIN_ENABLED=true
DINGTALK_LOGIN_ALLOWED_USER_IDS=徐浩雯的真实userId
COMPOSE_PUBLIC_ORIGIN=http://192.168.50.201:18081
DINGTALK_LOGIN_CALLBACK_URL=http://192.168.50.201:18081/api/auth/dingtalk/callback
SESSION_COOKIE_NAME=tb_sid_dingtalk_staging
```

`DINGTALK_IN_APP_LOGIN_ENABLED` 默认关闭，只控制钉钉客户端免登。关闭后浏览器扫码入口仍由原登录开关控制；已有会话按原有效期工作。

复用原企业内部应用的 Client ID、Client Secret、Corp ID 和成员信息读取权限。原浏览器登录所需个人信息权限保留。首阶段真实账号关联已由用户确认通过。

灰度地址为内网地址，测试电脑或手机必须能访问 `192.168.50.201:18081`。手机需要公司网络或可达该内网的 VPN；单纯登录钉钉不会使内网地址在公网可访问。

可从钉钉客户端打开既有通知链接，或用手机钉钉“扫一扫”打开对应灰度链接。若需固定工作台入口，在测试应用的开发管理中配置相应应用首页和 PC 首页；安全域名等配置按钉钉后台提示添加并保留已有配置。本阶段不自动更改钉钉后台或正式应用入口。

## 实现

使用固定版本 `dingtalk-jsapi@3.2.9`，只在检测到钉钉客户端后动态加载随网站构建的 SDK，不引入远程脚本或放宽 CSP。采用官方推荐的按需导入：`entry/union` 加 `api/runtime/permission/requestAuthCode`，避免完整 SDK 中同名别名注册覆盖电脑版必需的 URL 参数处理。

1. `POST /api/auth/dingtalk/in-app/start` 创建随机 state 和浏览器 HttpOnly 流程 Cookie，流程有效期 3 分钟。
2. 调用按需导入的官方 H5 `runtime.permission.requestAuthCode({corpId})` 获取一次性免登码。SDK 的 Promise 会等待桥初始化，初始化失败也可捕获；该接口无需 `dd.config`。
3. `POST /api/auth/dingtalk/in-app/complete` 在同一浏览器提交 state 和 code。服务端以原子更新领取 `flow_kind=in_app` 的流程，防止重放以及与浏览器 OAuth 流程混用。
4. 服务端以企业应用凭据获取 token，通过 `/topapi/v2/user/getuserinfo` 交换免登码，查询企业成员详情，并根据 unionId 复核内部员工类型及 userId。
5. 使用独立登录身份表关联到原系统账号，再签发系统会话；失败不会创建身份关联或显示旧账号工作台。

前端 UA 检测只用于决定是否调用客户端桥，服务端不信任 UA、前端传入姓名或 userId。SDK 等待和服务端交换都有超时，React StrictMode 下共用一次验证请求；组件卸载后迟到的 SDK 回调不会提交免登码。

客户端桥失败时，使用当前 state 和浏览器 Cookie 向 `/in-app/client-error` 提交安全诊断并结束本次流程。服务端仅接受固定阶段、白名单平台、数字错误码和桥存在性布尔值；拒绝错误原文、URL、UA、令牌及额外字段。这些客户端信息仅供排查，不能作为身份凭证。

`getuserinfo` 返回的 `sys`、`sys_level` 是钉钉管理身份，不能提升 Bug 系统权限；`associated_unionid` 不是登录匹配依据。最终要求企业详情中的 userId、unionId 有效，且内部员工类型为 0、成员已激活。

## 验证与边界

`npm test` 覆盖客户端免登成功、外部成员、未激活、错 ID、缺字段、超时和权限拒绝。`npm run test:dingtalk-login` 在显式启用的隔离数据库中补充真实路由和事务检查。

页面自动化模拟钉钉客户端桥与后端，不替代真实钉钉客户端验收。灰度部署后需由徐浩雯在钉钉内打开链接，确认直接进入原账号并显示对应缺陷。不要把网页扫码授权成功当作客户端免登成功。

本次真实只读目标：`http://192.168.50.201:18081/?issue=BUG-0907-001`。无需修改该缺陷或创建新通知。

## 官方依据

- [钉钉官方 H5 免登示例](https://github.com/open-dingtalk/h5app-auth-demo)
- [H5 免登流程](https://open.dingtalk.com/document/orgapp/logon-free-process)
- [通过免登码获取用户信息](https://open.dingtalk.com/document/development/obtain-the-userid-of-a-user-by-using-the-log-free)

本阶段使用官方示例中明确配套的传统 H5 API；新版 `dd.requestAuthCode` 与其他授权流程的码不混用。
