# TraceBug 钉钉通知接入

当前分支：`codex/dingtalk-message-integration`

本功能默认关闭。未配置钉钉时，现有 Bug 创建、更新和登录流程保持不变。

浏览器钉钉登录及首次账号关联已另行实现，配置与试用步骤见 [DINGTALK_LOGIN.md](DINGTALK_LOGIN.md)。登录开关与消息通知开关相互独立。

## 一、本地 Dry Run

确认 `.env` 连接本地数据库：

```env
PGPORT=5433
PGDATABASE=tracebug_local
DINGTALK_ENABLED=true
DINGTALK_DRY_RUN=true
```

执行：

```powershell
npm run verify:dingtalk-schema
npm test
npm run test:dingtalk
npm run test:dingtalk-outbox
npm run dev
```

Dry Run 不访问钉钉，也不需要真实凭证。创建 Bug 时会写入 Outbox，并完整执行领取、模拟发送、进度查询和结果确认。页面会提示排队人数。

## 二、创建钉钉测试应用

需要本企业钉钉管理员完成：

1. 在钉钉开发者后台创建企业内部 H5 应用，名称建议为 `TraceBug`。
2. 可见范围先只包含管理员和一名测试员工。
3. 记录 Client ID、Client Secret、Agent ID 和 Corp ID。
4. 配置 TraceBug 服务器的稳定公网出口 IP。
5. 确认消息通知权限可用。
6. 若使用管理员手工绑定并在线验证 `userId`，申请成员信息读权限。
7. 若使用邮箱自动同步，申请以下权限：
   - `qyapi_get_department_list`：通讯录部门信息读权限。
   - `qyapi_get_department_member`：通讯录部门成员读权限。
   - `qyapi_get_member`：成员信息读权限。
   - `fieldEmail`：邮箱等个人信息。
8. 确认测试电脑或手机能够访问 `PUBLIC_ORIGIN`。

Client Secret 只填写到服务器 `.env`，不要发到聊天、提交到 Git 或填写到前端变量。

## 三、只测试一条真实消息

先保持自动通知关闭：

```env
DINGTALK_ENABLED=false
DINGTALK_DRY_RUN=false
DINGTALK_CLIENT_ID=本地填写
DINGTALK_CLIENT_SECRET=本地填写
DINGTALK_AGENT_ID=本地填写
DINGTALK_CORP_ID=本地填写
DINGTALK_TEST_USER_ID=测试员工的钉钉userId
PUBLIC_ORIGIN=https://可访问的TraceBug地址
```

执行：

```powershell
npm run test:dingtalk
```

这个脚本只向 `DINGTALK_TEST_USER_ID` 发送一条带 `SELFTEST-时间戳` 编号的测试通知，不会开启 Bug 自动通知。输出只包含任务 ID、进度和结果统计，不输出 Client Secret 或 accessToken。

## 四、绑定负责人

真实消息测试成功后启动系统，由管理员进入“成员管理”：

1. 找到测试负责人。
2. 点击链条图标。
3. 输入该员工的钉钉 `userId`。
4. 系统向钉钉查询用户详情，验证有效后才保存绑定。

绑定与解绑均记录审计；绑定变化发生在通知排队后时，Worker 会在发送前重新核对当前负责人和最新绑定。

## 五、按邮箱同步负责人

管理员进入“成员管理”，单击“同步钉钉”。系统会：

1. 遍历应用权限范围内的钉钉部门与成员。
2. 读取 `email` 和 `org_email`，统一去空格并转为小写。
3. 与 TraceBug 公司邮箱做完整值匹配。
4. 只有一对一唯一匹配才创建 `email_sync` 绑定。
5. 重复邮箱、多候选、无邮箱和无匹配进入冲突或未匹配状态。
6. `manual` 和 `self_service` 绑定不会被自动同步覆盖。
7. 钉钉没有返回任何邮箱时，同步直接失败，不修改已有绑定。

每次同步都会保存部门数、钉钉用户数、有邮箱用户数、匹配数、更新数、未匹配数、冲突数和人工保留数。

## 六、开启 Bug 自动通知

至少一名测试负责人绑定成功后：

```env
DINGTALK_ENABLED=true
DINGTALK_DRY_RUN=false
```

重启服务，再创建一个只分配给测试负责人的 Bug。预期行为：

1. Bug 立即创建成功。
2. 页面提示钉钉通知已排队。
3. Worker 在数据库事务提交后调用钉钉。
4. 钉钉异常不会回滚 Bug。
5. 通知按钮打开 `${PUBLIC_ORIGIN}/?issue=<issueKey>` 对应缺陷。

初次验证不要把应用可见范围直接扩大到全员。

## 七、停止与回退

设置并重启：

```env
DINGTALK_ENABLED=false
```

关闭后不会创建新的通知任务。数据库中的绑定、Outbox 和审计表会保留，不影响现有业务数据。

## 八、当前边界

- 已实现企业内部应用工作通知、ActionCard、Token 缓存、进度/结果查询。
- 已实现按负责人投递状态、批量部分失败处理、退避重试、租约恢复和未知结果保护。
- 已实现管理员手工绑定、解绑和通讯录邮箱自动匹配。
- 已使用本企业真实凭证完成单人消息、Bug 创建触发通知和失败清理验证。
- 钉钉免登自助绑定留到后续阶段。
