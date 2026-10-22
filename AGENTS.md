# Mikanime Stream 发布工作流

## 项目约束（不可违背）
- 服务端（server.mjs）不做 BT 下载、不转码、不落盘；只做蜜柑/TMDB 搜索代理 + wasmnet TCP/UDP 中继 + DHT 查询。
- 下载/播放全部在浏览器端（p2p/index.html + Mediabunny MSE 无损封装）。

## 每次代码修改后必须完成的发布流程

1. 语法检查：
   - `node --check server.mjs p2p/mkv-mse.js p2p/mkv-subs.js p2p/wasmnet-core.js`
   - 改动过 p2p/scripts 下的模块时也要检查：`node --check p2p/build-webrtc.mjs p2p/build-wasmnet.mjs p2p/fsa-patch-plugin.mjs p2p/pnpm-resolve.mjs scripts/ensure-fsa-patch.mjs scripts/verify-bundles.mjs scripts/browser-seed-test.mjs`
   - index.html 的内联脚本提取出来逐段 `node --check`。
2. 如果改过 `p2p/wasmnet-core.js`、垫片或打包脚本，重新打包浏览器端 bundle：
   - `pnpm build:frontend`（依次重建 webrtc / wasmnet / mediabunny 三个产物）
   - 然后必须跑 `pnpm verify:bundles`：它会校验 fsa-chunk-store 兼容补丁在声明、
     安装目录和两个 bundle 里都在，缺一个就退出码 1，**不要在这种情况下发布**。
   - 改了存储/下载相关代码时，再跑一次 OPFS 回归用例（先 `node server.mjs` 起服务）：
     `pnpm test:seed:opfs`
3. 本地重新生成发布包：
   - `powershell -ExecutionPolicy Bypass -File scripts\make-zip.ps1`
4. 提交并推送到 GitHub：
   - `git add -A && git commit -m "改动说明"`
   - `git push origin main`
5. 更新 Oracle Cloud（anime.youmifamily.top）：
   - **当前服务器 IP：`134.185.93.131`**（Oracle 临时公网 IP，实例停机/重建后会变；
     旧记录的 `161.118.211.164` 已被 Oracle 回收分给他人，**不要再连**）
   - 主机：`instance-20260820-1425`，Oracle Linux 9.8 **aarch64**，密钥 `C:\Users\cdd\.ssh\id_ed25519`
   - 把改动文件 scp 到服务器 `/tmp`，再 `sudo install` 到 `/opt/mikanime-stream` 对应位置；
   - `cd /opt/mikanime-stream && sudo docker compose build && sudo docker compose up -d`
   - 注意：服务器上 docker-compose.yml 的端口是 `127.0.0.1:3000:3000`（前面有 Caddy），本地是 `12348:3000`；如果 scp 覆盖了 compose，必须重新 sed 回服务器版本。
   - 运行时是 **aarch64**：只需更新 `vendor/node-arm64.tar.gz`（国内上传慢时，可在服务器上直接下载官方
     `node-vX-linux-arm64.tar.xz` 后按「只保留 bin/node + share/LICENSE」的精简布局重打包）。
   - 回滚：镜像已打标签 `mikanime-stream:before-oct22`；旧源码在 `/root/*.bak-20261022`，
     旧运行时 `/root/node-arm64-v20.19.0.tar.gz`。
6. 验证线上：
   - `curl https://anime.youmifamily.top/api/health` 确认服务健康（`dht:true` 需要等 10–30 秒启动）；
   - 确认新代码标记出现在线上页面文件里（如 `curl https://anime.youmifamily.top/p2p/index.html`）。

## 安全基线（2026-10-22 起）

- **Node 运行时必须 ≥ 22.23.4**：`vendor/node/linux-{x64,arm64}` 与两个 tar 包一起更新。
  20.x 已 EOL，不接收 2026-10-21 那批安全修复（含 Brotli 解码器 OOB 写 → RCE，CVE-2026-111497）。
  升级后务必确认容器内 `node -v`，并注意 `vendor/deps.tar.gz` 里的原生模块是按旧 ABI 预编译的
  （arm64 本来就没有 bufferutil 预编译，`ws` 会自动退回纯 JS，功能不受影响）。
- 容器以 **非 root（USER node）** 运行，`docker inspect --format '{{.Config.User}}'` 应为 `node`。
- **SSRF 防护**：`/api/search` 的 `base` 只允许蜜柑域名（`MIKAN_BASE` / `MIKAN_BASES` 可扩展）；
  `/api/fetch`、`/api/torrent-trackers` 与 wasmnet 中继的出站目标统一走 `assertPublicHost`，
  拒绝内网/回环/链路本地/CGNAT/组播与 IPv4-mapped IPv6。
  - 本地端到端测试（假做种者在 127.0.0.1）需临时 `WASMNET_ALLOW_PRIVATE=1`，**生产环境禁止设置**。
  - 中继的 BIND 只允许临时端口；要固定端口（让 tracker 把连接打回来）用 `WASMNET_BIND_PORTS=51413`。
- `/api/config` 在无 `Origin` 时仍会返回中继 token（页面同源取用需要），这是已知设计缺口：
  拿到 token 只能当中继客户端，但目标已被 SSRF 防护限制在公网地址。


## 关键信息
- 服务器：`opc@134.185.93.131`（**临时公网 IP，会变**；旧 IP `161.118.211.164` 已不是你的），密钥 `C:\Users\cdd\.ssh\id_ed25519`
- 服务器部署目录：`/opt/mikanime-stream`（git clone，工作区可能被 scp 覆盖成脏状态）
- 服务器环境变量：`/opt/mikanime-stream/.env`（TMDB_API_KEY 等，已 gitignore，勿提交）
- GitHub：`https://github.com/CandyD-1992/mikanime-stream.git`，分支 main
- 域名现在走 **Cloudflare 代理**（A 记录指向 CF，非直连甲骨文）；源站：Caddy 监听 80/443 →
  `anime.youmifamily.top` 反代 `127.0.0.1:3000`，另有 speedtest / vpn / subscribe 三个站点
- 源站 80/443 对公网直接可达（可绕过 CF），如需更严格可只放行 Cloudflare 回源段
- 发布包：`mikanime-stream-release.zip`（已 gitignore）
