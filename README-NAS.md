# 在群晖 NAS 上部署 Mikan 边下边播

新版架构：**服务端只做搜索代理 + wasmnet 转发，BT 下载和播放全部在浏览器里完成**。
服务端不做转码、不做下载、不保存任何数据。

## 前提

- 群晖 DSM 7.2+，已安装「Container Manager」套件（旧版 DSM 6.x 在套件中心安装「Docker」）
- NAS 架构为 x86_64（Intel/AMD）或 arm64 均可
- NAS 能正常访问 mikanime.tv / mikanani.me（搜索依赖它们，默认自动切换）

## 第一步：把项目传到群晖

1. 在电脑上打包 `mikanime-stream` 文件夹。**推荐直接运行** `scripts\make-zip.ps1`
   （自动排除 Windows 专用目录，避免长路径丢文件）。
   手动打包请务必包含 `vendor/` 下的三个单文件压缩包：`deps.tar.gz`、
   `node-amd64.tar.gz`、`node-arm64.tar.gz`——项目已内置 **Linux 版 Node.js 运行时**
   和生产依赖，**构建时不需要联网装 Node、不需要 npm install**。
   **不要**把 `vendor/node_modules` 和 `vendor/node` 目录打进 zip（嵌套路径超过
   Windows 260 字符上限，资源管理器打包会静默丢文件）；Windows 的 `node_modules`、`bin` 也不用打包。
   > `make-zip.ps1` 生成的发布包默认只带 **amd64** 运行时（适配绝大多数群晖型号）；
   > 如果你的 NAS 是 ARM 型号，把 `vendor/node-arm64.tar.gz` 也放进 `vendor/` 再打包即可。
2. 打开群晖 **File Station**，上传到某个共享文件夹（例如 `/volume1/docker/`），右键解压。
3. 确认解压后的目录里有 `Dockerfile`、`docker-compose.yml`、`server.mjs`、`p2p/`、
   `vendor/deps.tar.gz` 等。

也可以用 SSH 直接传：

```bash
scp -r mikanime-stream/* admin@群晖IP:/volume1/docker/mikanime-stream/
```

## 第二步：用 Container Manager 图形界面部署

1. 打开「Container Manager」→「项目」→「新增」。
2. 项目名称填 `mikanime-stream`，来源选择「从 docker-compose.yml 构建」。
3. 路径选择刚才解压的项目文件夹（如 `/volume1/docker/mikanime-stream`），系统会自动识别目录里的
   `docker-compose.yml` 和 `Dockerfile`。
4. 点击「下一步」→「完成」。构建只需要拉取一个很小的 Debian 基础镜像（Node 和依赖都已内置，
   不需要其他网络下载），通常一两分钟完成。
5. 构建并启动成功后，浏览器打开：

```
http://群晖IP:12348/p2p/index.html
```

> 如果界面里找不到“从文件夹构建”的入口，也可以在“项目”里直接粘贴 `docker-compose.yml` 的内容，
> 把 `build: .` 改为项目文件夹路径即可。

## 第二步备选：SSH 命令行

```bash
ssh admin@群晖IP
cd /volume1/docker/mikanime-stream
sudo docker compose up -d --build
sudo docker compose logs -f
```

## 第三步：放行防火墙

如果群晖「控制面板 → 安全性 → 防火墙」已启用，需要放行 **TCP 12348**（或你改过的端口），否则局域网设备访问不到。

## 使用说明

打开页面后，搜索会走 NAS 的搜索代理；点“播放”默认用**服务器中转（TCP/UDP）**连接做种者
（WebRTC 默认不开启，可在设置里手动切换）。

- 中转模式下 NAS 用真实网络代为建立 TCP/UDP 连接去连普通 BitTorrent 做种者，数据仅转发、不落盘。
- 搜索结果里点 **“加入队列”** 可以把资源加入下载队列，按设置的并行任务数下载（默认 1，设置里可调 1-5），
  支持暂停/继续，下载完成后自动保存到本地并存入网页缓存；
- 右上角 **“队列”** 按钮可查看/移除队列项；下载中或已完成的队列项点“播放”会**复用队列的下载进度**播放，
  播放进度也会记在队列里，下次打开页面还能看到；完成项会直接读取本地网页缓存播放。
- mkv / HEVC 等格式走**浏览器内流式无损封装**（MKV → fMP4 + MSE）：边下载边封装边播放，
  不重编码、画质无损、大文件也能播，NAS 完全不参与；只有编码不受浏览器支持时才回退到网页内
  ffmpeg（首次需联网下载约 30MB 引擎，仍由浏览器设备计算）。

## 参数配置

可以在 `docker-compose.yml` 里设置环境变量：

- `WASMNET_TOKEN`：固定中继令牌。不设置则每次启动随机生成，页面会自动获取，一般无需改动。
- `WASMNET_OPEN=1`：关闭中继令牌。**不建议**，除非你的 NAS 只在内网且完全可信——否则任何人都能把
  NAS 当开放代理使用。
- `TMDB_API_KEY`：可选。设置后番剧搜索/选集可用（在 TMDB 官网免费申请）；不设置也可以让用户在
  页面 **⚙ 设置** 里自己填 Key（保存在浏览器本地）。
- `TMDB_API_BASE`：可选。默认官方 `https://api.themoviedb.org/3`；NAS 连不上官方地址时改成
  可用的镜像/代理，也可以在页面设置里填，优先级更高。
  代理模板用 `{url}` 占位。
- `TMDB_API_FALLBACKS`：可选，逗号分隔的备用地址列表。主地址解析失败（`EAI_AGAIN`）或连不上时
  会自动按顺序换下一个；默认还会兜底官方地址。
- `MIKAN_BASE` / `MIKAN_BASES`：可选，指定蜜柑站点地址。默认自动尝试 `mikanime.tv`、
  `mikanani.me`，一个域名解析失败会自动换下一个。
- `dns`：`docker-compose.yml` 里已默认加了公共 DNS（223.5.5.5 等）。NAS 容器报
  `getaddrinfo EAI_AGAIN` 时，大多数是容器 DNS 解析不了外网域名，改这个最有效。
- `PORT`、`HOST`：监听端口和地址，默认 `3000`、`0.0.0.0`。

也可以在群晖 Container Manager 的容器「环境」里直接加 `TMDB_API_KEY` 变量，或在项目里
编辑 `docker-compose.yml` 取消 `environment` 注释后填写。

## 番剧搜索与选集

页面右上角 **⚙ 设置** 收纳了说明、WebRTC 探测开关、代理搜索、服务器中转、tracker 诊断和
TMDB API Key。搜索番剧时，页面会同时查 TMDB 并展示海报、简介、季与集数；点击某一集会用该集
关键词在蜜柑模糊搜索（番剧简称/原名/集数等多个关键词合并），自动排除其他季（如 S2、S3），
按 `[字幕组]` 分类展示，并可用“字幕组”筛选条只看某个组的资源，直接点播放。

MKV 内嵌字幕（ASS / SRT / WebVTT）会在浏览器里边下载边提取并实时显示，NAS 不参与处理。

## 构建参数（可选）

默认使用官方 Debian 基础镜像。**国内网络拉不动 Docker Hub 时**，在 Container Manager 构建参数里
加一个构建参数，改用国内镜像源：

```
BASE_IMAGE=docker.m.daocloud.io/library/debian:bookworm-slim
```

SSH 命令行等价写法：

```bash
sudo docker compose build --build-arg BASE_IMAGE=docker.m.daocloud.io/library/debian:bookworm-slim
sudo docker compose up -d
```

架构会自动匹配（x86_64 用内置的 linux-x64 运行时，ARM 型号用 linux-arm64）。
如果 ARM 机型构建出来的镜像无法运行（提示 exec format error），手动加一个构建参数
`TARGETARCH=arm64` 后重新构建即可。

## 常见问题

**页面打不开？**
先确认容器状态为“运行中”，再检查端口是否被占用（可把 `3000:3000` 改成 `8080:3000`）以及防火墙规则。

**创建项目时报错 “Incorrect type. Expected 'Compose Specification | array'”？**
这是 Container Manager 没能在你选择的路径下解析出合法的 compose 文件，通常不是代码问题。按顺序排查：

1. 用 File Station 打开项目文件夹，确认**根目录下**确实有一个 `docker-compose.yml`（不是 `.txt` 后缀、不是子文件夹里），双击用“文本编辑器”打开，内容应是以 `services:` 开头的 YAML。
2. 在“新增项目”向导里，来源选 **“从 docker-compose.yml 构建”**，路径选到**直接包含该文件的文件夹**；点“下一步”后编辑器里应能看到 YAML 内容。如果编辑器是空的，说明路径选错了。
3. 如果编辑器里有内容但仍然报错，把内容替换成项目里精简后的最小配置（`services:` 块即可）再试一次。
4. 还是不行就升级 Container Manager（套件中心 → 检查更新），或直接用 SSH 命令行方式构建（见下面“备选：SSH 命令行”），绕开图形界面的解析器。

**搜索不到结果？**
NAS 需要能访问 mikanime.tv / mikanani.me。如果搜索报 `getaddrinfo EAI_AGAIN` 或
`fetch failed`，说明容器 DNS 解析不了外网域名：先确认 `docker-compose.yml` 里有 `dns:` 配置并
重新构建；也可以在页面「设置 → 蜜柑站点地址」里手动换到 `https://mikanani.me` 再搜。
实在访问不了时，也可以直接在页面里粘贴磁力链接播放。

**一直连不上做种者？**
先看页面工具栏的“中转可用”状态；中转模式下能否连上取决于 NAS 的网络环境（NAT、运营商）和种子热度。
如果中转显示不可用，检查容器是否运行、`/api/health` 是否能访问。
如果中转显示“可用”但播放时连不上，打开「设置 → 测试中继」看具体报错：
- 报“WebSocket 连接失败”且你用了群晖反向代理/HTTPS 访问，多半是反向代理没开启 WebSocket 转发，
  可以在「中继地址覆盖」里直接填 `ws://群晖IP:12348/wasmnet` 绕过反向代理；
- 报 401/403 是令牌问题，刷新页面重试（服务重启后令牌会变）；
- 报“连接超时”说明 NAS 出站到做种者的 TCP 被网络阻断，属于运营商/NAT 问题，和中继本身无关。

**连接数很多但下载速度一直是 0？**
这是页面用 `http://局域网IP:端口` 打开时的典型问题：非安全上下文下浏览器不提供
`crypto.subtle`，WebTorrent 无法校验种子元数据和分片，表现为连上一堆做种者、
但元数据永远拿不到、速度恒为 0（控制台会反复报 `no web crypto support`）。
新版页面已内置纯 JS 的 SHA-1 兜底（`p2p/crypto-subtle-polyfill.js`），重新部署后
**强制刷新（Ctrl+F5）**即可。如果仍无速度，打开 F12 看是否还有 `no web crypto support`；
用群晖反向代理开 HTTPS 访问也能原生解决这个问题。

**MKV 播放很慢 / 转码很久？**
MKV 默认走“流式无损封装”（不重编码、边下边播），不需要转码；只有少数编码（如 MPEG-4 Part 2、
Vorbis）才会回退到 ffmpeg，且计算发生在浏览器设备上，NAS 不参与。

**我的群晖是 ARM 型号？**
镜像支持 arm64，可以部署；浏览器端转码与 NAS 架构无关，NAS 只负责转发，性能要求很低。

**如何升级？**
把新代码重新上传覆盖。如果依赖有变化，先在电脑上执行 `node scripts/pack-vendor.mjs`
（重新拍平并打包 `vendor/deps.tar.gz`），重新上传 `vendor/` 目录，然后在 Container Manager 里
「构建」或执行 `docker compose up -d --build`。

## 安全说明

中继默认带令牌，令牌只通过同源接口 `/api/config` 提供给页面。请勿把 NAS 的 12348 端口直接暴露到公网；
如确需外网访问，建议用群晖反向代理 + HTTPS，并设置固定 `WASMNET_TOKEN`。
