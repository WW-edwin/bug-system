# 字典管理测试

使用项目 `.env` 中的本地 PostgreSQL 连接（通常为 `127.0.0.1:5433`）。测试会另建随机名称的临时数据库，结束后删除并确认不存在；不会修改 `tracebug_local` 或线上数据库。

```powershell
npm run test:dictionaries
npm run test:dictionaries:ui
```

接口测试验证历史数据迁移、字典权限与输入校验、并发冲突、新建和编辑缺陷、批量修改及停用兼容。状态测试验证延迟刷新的响应不会覆盖刚保存的字典。

浏览器测试需要 Python 的 `playwright` 包和系统安装的 Chrome，使用独立 API `3191` / 前端 `4191` 端口；截图保存到已忽略的 `artifacts/dictionary-ui/`。仅截图保留作为测试证据，临时数据库、上传目录和进程会在测试结束时清理。

接口测试独占 `3192` 端口。运行测试前应确保这些端口没有其他开发进程占用。
