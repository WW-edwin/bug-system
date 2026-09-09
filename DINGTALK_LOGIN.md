# 钉钉网页登录

当前统一使用网页里的钉钉授权登录，支持已有账号首次关联，以及本企业新员工自动开户并强制设置系统登录密码。自动开户的配置、资料保存和验收说明见 [DINGTALK_ONBOARDING.md](DINGTALK_ONBOARDING.md)。不按姓名或邮箱直接合并已有账号。

根据用户在 2026-09-08 确认的需求，已撤下钉钉客户端内自动免登，不再加载客户端 SDK 或按设备系统分流。普通浏览器以及钉钉中打开的网页都使用同一登录页面和授权流程。通知继续提供普通网页链接；页面在外部浏览器或客户端网页窗口中打开由钉钉客户端控制，不强行唤起手机系统浏览器。

## 已有账号关联方式

1. 登录页点击“钉钉登录”，整页进入钉钉官方授权页。
2. 后端以一次性授权码获取用户身份，再使用企业应用凭据确认其为本企业已激活的内部成员；试用模式还会检查名单。
3. 首次使用时，在“关联已有账号”页输入原 Bug 系统账号的姓名和密码。
4. 验证成功后，保留原账号的 UUID、角色、密码及所有历史引用，保存独立的钉钉登录身份，并将该账号的通知绑定标记为 `self_service`。
5. 后续完成钉钉授权后直接登录同一个系统账号，并恢复原缺陷链接。

原有密码登录、注册和忘记密码入口仍可用。已有账号继续由本人验证原姓名和密码；没有账号的员工在开启自动开户后无需预先注册。密码由使用者自行设置，不应发送到聊天或写入文档。

已有 `manual` 或 `email_sync` 通知绑定不自动获得登录权限。若钉钉身份已被其他账号占用，系统拒绝关联并提示管理员核对，不覆盖他人绑定。邮箱匹配不会覆盖 `self_service` 绑定。

## 配置

沿用企业内部应用的 Client ID、Client Secret 和 Corp ID；登录不依赖通知开关，也不以通知 Dry Run 伪造身份。

```env
DINGTALK_LOGIN_ENABLED=true
DINGTALK_LOGIN_SCOPE=pilot
DINGTALK_AUTO_REGISTER_ENABLED=false
DINGTALK_LOGIN_CALLBACK_URL=http://127.0.0.1:4183/api/auth/dingtalk/callback
DINGTALK_LOGIN_ALLOWED_USER_IDS=填写徐浩雯的真实钉钉userId
PUBLIC_ORIGIN=http://127.0.0.1:4183
```

以上为保留的试用模式配置。试用模式的允许名单为逗号分隔的精确 userId。省略 `DINGTALK_LOGIN_ALLOWED_USER_IDS` 时回退到 `DINGTALK_TEST_USER_ID`；显式留空表示无人可试用，登录不可用。`DINGTALK_LOGIN_SCOPE=company` 则开放本企业已激活且应用有权限核验的成员，不再检查试用名单。配置错误或凭据不全时，仅禁用钉钉登录，密码登录仍可用。

钉钉后台需核对“登录与分享”中的回调地址、用户个人身份信息读取权限、根据 unionId 获取企业 userId 的权限、成员详情读取权限，以及应用可使用范围。使用真实账号授权后，才能完整验证用户授权权限和回调地址是否生效。

本地电脑浏览器使用的完整回调地址：

`http://127.0.0.1:4183/api/auth/dingtalk/callback`

回调必须与 `PUBLIC_ORIGIN` 的第一个地址同源，路径为 `/api/auth/dingtalk/callback`。正式环境应使用正确的 HTTPS 地址与安全 Cookie。这里的 `127.0.0.1` 只用于本机浏览器登录测试；其他设备需要访问可达的部署地址。当前不启用客户端内免登。

可保持消息通知关闭：

```env
DINGTALK_ENABLED=false
DINGTALK_DRY_RUN=true
```

## 当前本机启动

目录：`D:\项目\bug系统-钉钉开发`。

```powershell
cd 'D:\项目\bug系统-钉钉开发'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\启动钉钉开发.ps1'
```

本机启动脚本调用忽略上传的 `载入钉钉凭据.ps1`，仅从原目录 `.env` 读取钉钉应用凭据与测试 userId，注入子进程。它不改写原文件、不复制数据库连接、不复制通知开关，也不输出凭据。前端依旧是 4183，后端 3111，数据库 5434。

## 安全与当前边界

同一 IP 的不同端口会共享浏览器 Cookie。灰度环境应单独配置 `SESSION_COOKIE_NAME=tb_sid_dingtalk_staging`；登录会话和钉钉授权流程 Cookie 都会使用灰度专用名称，避免覆盖正式环境的登录状态。

- 授权流程有效期 10 分钟，随机 state 与同一浏览器的 HttpOnly Cookie 共同验证；数据库只存它们的哈希。流程 Cookie 使用 SameSite=Lax 以接收钉钉站点的 GET 回调，普通会话仍使用原有 Cookie 策略。
- 回调在调用钉钉前以原子更新领取 state，重复回调不再交换授权码；取消、过期或完成后不能再绑定。
- 应用密钥、授权码和钉钉访问令牌不写入登录身份表、不返回前端、不记录原始上游错误。上游响应需逐项核验，拒绝外部联系人、身份不一致或未激活成员。
- `dingtalk_login_identities` 与可变的通知绑定分离，数据库唯一约束和事务防止并发串号。角色授权继续由 Bug 系统控制。
- 回到系统的地址仅允许本站根页面及查询参数，拒绝外站与 API 路径；错误提示不会携带钉钉令牌。
- 关闭钉钉登录或移出试用名单只阻止新的钉钉登录/关联，已经签发的系统会话仍按原有效期工作。立即停止访问须停用本地账号并撤销会话。离职同步、登录身份解绑管理和全员迁移属于后续阶段。

## 验收

```powershell
npm run build
npm test
```

单元测试包含钉钉客户端的成功链路、权限失败、外部成员、缺失字段、身份不一致、网络失败与超时。整合测试默认跳过；只能显式在本目录的专用数据库运行：

```powershell
$env:TRACEBUG_DINGTALK_AUTH_TEST = 'true'
npm run test:dingtalk-login
Remove-Item Env:TRACEBUG_DINGTALK_AUTH_TEST
```

整合测试会断言数据库为 `127.0.0.1:5434/tracebug_local` 且无 `DATABASE_URL` 覆盖，仅使用内存模拟钉钉身份。它验证 state 与浏览器隔离、重放、通知绑定不能直接登录、原密码验证、历史归属与角色、再次登录、企业与试用名单、过期取消和并发关联，并按记录的 ID 清理全部 SELFTEST 数据。

本地页面验收脚本和截图保存在 `分支资料_codex-dingtalk-message-integration\生成资料`。页面测试模拟钉钉路由，不访问真实钉钉、不改数据库。

## 官方依据

- [统一授权登录第三方网站](https://open.dingtalk.com/document/orgapp-server/use-dingtalk-account-to-log-on-to-third-party-websites-1)
- [获取用户 token](https://open.dingtalk.com/document/orgapp-server/obtain-user-token)
- [获取用户通讯录个人信息](https://open.dingtalk.com/document/orgapp-server/dingtalk-retrieve-user-information)
- [根据 unionId 获取企业 userId](https://open.dingtalk.com/document/orgapp-server/query-a-user-by-the-union-id)

实现参数同时核对了官方 `@alicloud/dingtalk` SDK 和 `com.aliyun/alibaba-dingtalk-service-sdk` 的请求/响应模型。
