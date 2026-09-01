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
