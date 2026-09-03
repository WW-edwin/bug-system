# TraceBug

公司内部共享缺陷管理系统。

- 前端：React + Vite
- 后端：Node.js + Express
- 数据库：PostgreSQL 17
- 部署：Docker Compose
- 身份：公司邮箱注册，真实姓名与密码登录

## 一、服务器要求

- 已安装 Docker Engine 或 Docker Desktop
- 已安装 Docker Compose v2
- 至少 2 核 CPU、4GB 内存、20GB 可用磁盘
- 内网开放 TCP 80；数据库端口 5432 不应对外开放

使用 Docker 部署时，服务器不需要单独安装 Node.js 或 PostgreSQL。

## 二、首次部署

在项目目录执行：

```bash
cp .env.example .env
```

编辑 `.env`，至少修改：

```env
POSTGRES_PASSWORD=替换为足够长的随机密码
COMPOSE_PUBLIC_ORIGIN=http://服务器内网IP
```

启动系统：

```bash
docker compose up -d --build
docker compose ps
```

当 `app` 和 `db` 均显示 `healthy` 后，访问：

```text
http://服务器内网IP
```

空数据库中的第一位注册用户会自动成为管理员。注册邮箱必须以 `@kando.com.cn` 结尾，真实姓名仅允许中文，密码至少 6 个字符。

## 三、自动启动

`docker-compose.yml` 已为应用和数据库配置：

```yaml
restart: unless-stopped
```

只要 Docker 服务随服务器开机启动，TraceBug 会自动恢复，无需每日手动启动。

## 四、持久化数据

- PostgreSQL 数据：Compose 卷 `tracebug_db`
- 富文本图片：Compose 卷 `tracebug_uploads`

普通的容器重建或升级不会删除数据。不要执行：

```bash
docker compose down -v
```

其中 `-v` 会删除数据库和图片卷。

## 五、备份

```bash
mkdir -p backups

docker compose exec -T db \
  pg_dump -U tracebug -Fc tracebug \
  > backups/tracebug.dump

docker compose exec -T app \
  tar czf - -C /app/uploads . \
  > backups/uploads.tar.gz
```

数据库和图片必须同时备份。

## 六、更新版本

替换源码后执行：

```bash
docker compose up -d --build
docker compose ps
```

## 七、常用运维命令

```bash
# 查看状态
docker compose ps

# 查看应用日志
docker compose logs --tail 200 app

# 查看数据库日志
docker compose logs --tail 200 db

# 重启应用
docker compose restart app

# 健康检查
curl http://127.0.0.1/api/health
```

## 八、本地开发

复制 `.env.example` 为 `.env` 后：

```bash
docker compose up -d db
npm ci
npm run dev
```

开发地址：`http://127.0.0.1:4173`

## 九、HTTPS

通过 Nginx、Caddy 或公司网关配置 HTTPS 后，修改：

```env
COMPOSE_PUBLIC_ORIGIN=https://正式域名
COMPOSE_COOKIE_SECURE=true
```

系统应部署在公司内网或 VPN 环境，不要直接暴露到公网。

## 十、钉钉负责人通知（实验分支）

`codex/dingtalk-message-integration` 分支提供默认关闭的钉钉工作通知实验实现。首次接入、Dry Run、真实单人测试和回退步骤见 [DINGTALK_SETUP.md](./DINGTALK_SETUP.md)。
