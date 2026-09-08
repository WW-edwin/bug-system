# 本地修改环境

此目录是日常修改和调试版本，与上线打包目录及线上数据库完全隔离。

## 环境标识

- 数据库：`tracebug_local`
- PostgreSQL 端口：`127.0.0.1:5433`
- 前端地址：`http://127.0.0.1:4173`
- 后端地址：`http://127.0.0.1:3101`
- 图片目录：`local-data/uploads`
- Compose 项目：`tracebug-local`

## 启动

```powershell
npm ci
docker compose --env-file .env -f docker-compose.local.yml up -d
npm run dev
```

## 从已下载快照重新导入

```powershell
npx tsx tools/import-snapshot.ts imports/online-20260901
```

导入操作只允许目标数据库名为 `tracebug_local`，并会覆盖该本地数据库中的现有内容。

`imports/`、`local-data/` 和 `.env` 均不会进入上线包。

## 使用线上数据调试的强制规则

当本地前端通过 `VITE_API_PROXY` 连接线上后端时，线上已有数据一律只读，不得修改或删除既有用户、项目、缺陷、活动、状态、负责人、评论和附件。

- 自测数据只能在本次测试中创建，并使用 `SELFTEST-YYYYMMDD-HHMMSS` 作为统一标识。
- 测试前记录所有待创建数据；测试中记录实际生成的 ID、附件和依赖关系。
- 测试结束后按依赖关系反向删除全部自测数据及附件，并通过刷新、搜索或 API 查询确认零残留。
- 无法保证完整清理，或测试必须修改既有数据时，停止使用线上数据，改用本地快照或专用测试环境。
