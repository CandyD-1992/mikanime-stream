# Mikanime Stream 发布工作流

## 项目约束（不可违背）
- 服务端（server.mjs）不做 BT 下载、不转码、不落盘；只做蜜柑/TMDB 搜索代理 + wasmnet TCP/UDP 中继 + DHT 查询。
- 下载/播放全部在浏览器端（p2p/index.html + Mediabunny MSE 无损封装）。

## 每次代码修改后必须完成的发布流程

1. 语法检查：
   - `node --check server.mjs p2p/mkv-mse.js p2p/mkv-subs.js p2p/wasmnet-core.js`
   - index.html 的内联脚本提取出来逐段 `node --check`。
2. 如果改过 `p2p/wasmnet-core.js` 或中继相关代码，重新打包浏览器端 bundle：
   - `node p2p/build-wasmnet.mjs`（生成 `p2p/vendor/webtorrent-wasmnet.iife.min.js`）
3. 本地重新生成发布包：
   - `powershell -ExecutionPolicy Bypass -File scripts\make-zip.ps1`
4. 提交并推送到 GitHub：
   - `git add -A && git commit -m "改动说明"`
   - `git push origin main`
5. 更新 Oracle Cloud（anime.youmifamily.top / 161.118.211.164）：
   - 把改动文件 scp 到服务器 `/tmp`，再 `sudo install` 到 `/opt/mikanime-stream` 对应位置；
   - `cd /opt/mikanime-stream && sudo docker compose up -d --build` 重建容器；
   - 注意：服务器上 docker-compose.yml 的端口是 `127.0.0.1:3000:3000`（前面有 Caddy），本地是 `12348:3000`；如果 scp 覆盖了 compose，必须重新 sed 回服务器版本。
6. 验证线上：
   - `curl https://anime.youmifamily.top/api/config` 确认服务健康；
   - 确认新代码标记出现在线上页面文件里（如 `curl https://anime.youmifamily.top/p2p/index.html`）。

## 关键信息
- 服务器：`opc@161.118.211.164`，密钥 `C:\Users\cdd\.ssh\id_ed25519`
- 服务器部署目录：`/opt/mikanime-stream`（git clone，工作区可能被 scp 覆盖成脏状态）
- 服务器环境变量：`/opt/mikanime-stream/.env`（TMDB_API_KEY 等，已 gitignore，勿提交）
- GitHub：`https://github.com/CandyD-1992/mikanime-stream.git`，分支 main
- 域名 DNS-only 直连甲骨文；Caddy 负责 Let's Encrypt 证书；Oracle 安全列表放行 80/443
- 发布包：`mikanime-stream-release.zip`（已 gitignore）
