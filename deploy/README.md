# home 服务器部署

2026-10-25 已部署。SSH：`ssh home`（192.168.40.39），项目 `/opt/oi`，数据 `/var/lib/oi`，systemd 服务 `oi`，监听 `127.0.0.1:3001`。服务器 Node.js 为 22.23.2。

本地数据库通过 SQLite `VACUUM INTO` 导出，包含 WAL 中已提交的数据，原数据库保留。账号、密码哈希、会话、对话、图片和模型配置均迁移；共享笔记目录同时复制。初始备份在服务器 `/root/oi-backups/`。迁移后服务器数据独立保存，后续本地修改不会自动同步。

## 添加公网域名（待在 Cloudflare 控制台操作）

`wenyan` 已通过 Cloudflare Tunnel 将 `wyan.liucx.cc.cd` 转发到 `http://127.0.0.1:8878`。Tunnel 使用控制台管理的配置，服务器仅持有连接 token，没有 DNS 或修改路由的管理权限。

1. 登录管理现有域名的 Cloudflare 账号，打开 Zero Trust 的网络 / 连接器 / Cloudflare Tunnel 页面（不同界面的入口名称可能略有差异）。
2. 打开当前包含 `wyan.liucx.cc.cd` 的 Tunnel，进入已发布应用路由或 Public Hostnames。
3. **新增**路由，保留原有的 wenyan 路由。填写子域名 `oi`、域名 `liucx.cc.cd`，路径留空；服务类型 **HTTP**、地址 **127.0.0.1:3001**。
4. 保存。高级设置的 HTTP Host Header 保持为空；如果必须填写，设为 `oi.liucx.cc.cd`。不要填 `localhost` 或 `127.0.0.1`，否则浏览器请求会被同源检查拒绝。
5. 确认 DNS 中已创建 `oi.liucx.cc.cd` 指向该 Tunnel 的 CNAME。如果界面没有自动创建，在现有域名的 DNS 管理处添加，目标与 `wyan.liucx.cc.cd` 使用的 Tunnel CNAME 相同，通常为 `<Tunnel UUID>.cfargotunnel.com`。若使用 Cloudflare 代理，保持开启。
6. 等待 DNS 生效，打开 `https://oi.liucx.cc.cd`。使用原来的用户名和密码登录；浏览器在新域名下需要重新登录。

不需要开放公网 3001 端口，也不需要新增 Tunnel 或手动安装服务器证书。网站的 HTTPS 由现有 Cloudflare 接入提供。Tunnel 连到本机时使用 HTTP，应用仅信任来自本机代理的协议和客户端 IP 信息。

检查：

```sh
ssh home
systemctl status oi --no-pager
curl -fsS http://127.0.0.1:3001/api/health
# 路由和 DNS 设置完成后：
curl -fsS https://oi.liucx.cc.cd/api/health
# 预期：{"ok":true}
```

## 日常维护

```sh
ssh home
systemctl restart oi
journalctl -u oi -n 100 --no-pager
```

程序以独立 `oi` 用户运行，代码只读，持久数据位于 `/var/lib/oi`。模型配置已从数据库迁移；需要服务器默认模型时可创建 `/etc/oi/oi.env`，填写 `AI_BASE_URL`、`AI_MODEL`、`AI_API_KEY`，权限设为 600 后重启服务。

## 更新代码（保留服务器数据库）

在本地 PowerShell 的项目目录运行：

```powershell
npm run build
tar -czf "$env:TEMP/oi-update.tar.gz" dist server package.json package-lock.json
scp "$env:TEMP/oi-update.tar.gz" home:/tmp/oi-update.tar.gz
```

在 `ssh home` 中运行：

```sh
set -eu
systemctl stop oi
tar -xzf /tmp/oi-update.tar.gz -C /opt/oi
cd /opt/oi
npm ci --omit=dev --no-audit --no-fund
chown -R root:oi /opt/oi
chmod -R g+rX,o-rwx /opt/oi
systemctl start oi
curl -fsS http://127.0.0.1:3001/api/health
```

更新包不要包含 `data/`，不要用本地数据库覆盖服务器后续产生的数据。

## 备份数据

服务器停止服务后备份整个数据目录，以包含 SQLite、运行时 WAL 和笔记：

```sh
set -eu
install -d -m 700 /root/oi-backups
systemctl stop oi
trap 'systemctl start oi' EXIT
umask 077
tar -czf "/root/oi-backups/data-$(date +%Y%m%d-%H%M%S).tar.gz" -C /var/lib/oi .
systemctl start oi
trap - EXIT
```

本地也可以用 `node deploy/snapshot.mjs data <不存在的备份目录>` 在线导出数据库和笔记。为确保笔记在复制期间一致，避免同时编辑知识库。`node deploy/verify.mjs <数据目录>` 只输出数据计数、完整性和哈希，可用于核对迁移，不输出密码或密钥。
