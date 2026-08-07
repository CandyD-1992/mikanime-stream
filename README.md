# Mikan 边下边播（浏览器版 + NAS 中转）

一个动漫种子“边下边播”网页：搜索蜜柑计划（mikanime.tv）的种子，选中任意磁力链接后在**浏览器里**边下载边播放。
![首页截图](docs/prtsc.png)
## 架构

服务端（`server.mjs`）只做两件事，**不做 BT 下载、不做转码、不保存任何数据**：

1. **搜索代理**：代理 mikanime.tv 的搜索请求（浏览器直接请求会被 CORS 拦截）；
2. **wasmnet 中继**：一个 WebSocket 转发通道，让浏览器端能借助服务器（NAS / 本机）的真实网络建立 **TCP/UDP** 连接去连普通 BitTorrent 做种者。

下载与播放全部发生在前端（`p2p/index.html`）：

- 默认通过 **WebRTC** 连接做种者（WebTorrent 浏览器版）；
- 若种子没有 WebRTC 节点（蜜柑的种子大多由普通 BT 客户端做种），页面会**自动切换**（或手动点“服务器中转”）到 wasmnet 模式：
  浏览器内仍由 WebTorrent 完成下载和边下边播，只是底层 TCP/UDP 连接经由服务器转发，数据只经过、不落盘。
- mp4/webm 边下边播；mkv 走**浏览器内流式无损封装**（MKV → fMP4 + MSE，边下载边封装边播，
  不重编码、画质无损、没有文件大小上限）；只有编码不受浏览器支持（如 MPEG-4 Part 2、Vorbis）
  时才回退到网页内 ffmpeg 无损封装/转码。
- MKV 内嵌字幕（ASS / SRT / WebVTT）会在浏览器里**边下载边提取**并实时显示，不需要转码或外挂字幕。
- 右上角 **⚙ 设置**：说明、WebRTC 探测开关、代理搜索、服务器中转、tracker 诊断、
  TMDB API Key 都收在悬浮面板里。
- 搜索番剧时同步查 **TMDB**：展示海报、简介、季/集数，点击某一集直接通过蜜柑搜索该集资源，
  自动用“番剧简称 / 原名 / 集数”等多个关键词模糊搜索，再按季/集关键字筛选（排除 S2、S3 等），
  最后按字幕组分类，并可用“字幕组”筛选条只看某个组的资源（需 TMDB v3 API Key，见下方说明）。

## 快速开始

需要 Node.js 18+（Windows 上双击 `start.bat` 会自动查找 Node，不需要手动安装依赖）。

**方式一（推荐）：双击 `start.bat`**，会自动启动服务器并打开浏览器。

**方式二：命令行**

```bash
node server.mjs
```

（依赖未安装时先执行 `pnpm install` 或 `npm install`，之后仍用 `node server.mjs` 启动；
本项目不依赖 npm，装好 Node.js 即可。）

浏览器打开 <http://127.0.0.1:3000/p2p/index.html>。
服务器默认监听 `0.0.0.0:3000`，同一局域网设备可访问 `http://<本机IP>:3000/p2p/index.html`。

> 注意：页面必须由服务器提供（访问 `http://127.0.0.1:3000/p2p/index.html`），
> 不要直接双击打开 `p2p/index.html`——那样搜索和“服务器中转”都会失效。

## 部署到群晖 NAS

推荐用群晖 Container Manager（Docker）部署，步骤见 [README-NAS.md](./README-NAS.md)。
项目内置 Linux 版 Node.js 运行时与生产依赖（`vendor/` 下的三个 tar.gz 单文件），Docker 构建时不需要 npm install；
国内网络拉不动 Docker Hub 时加构建参数 `BASE_IMAGE=docker.m.daocloud.io/library/debian:bookworm-slim` 即可。

## wasmnet 中继说明

- 页面通过 `/api/config` 获取中继地址和令牌（同源才可读）；
- 中继默认要求令牌，防止 NAS 被当成开放代理。可用环境变量固定令牌：
  - `WASMNET_TOKEN=xxx`：设置固定令牌；
  - `WASMNET_OPEN=1`：关闭令牌（仅建议在完全可信的内网使用）。
  - `TMDB_API_KEY=xxx`：设置 TMDB API Key（也可只在页面设置里填写，保存在浏览器本地）。
- 会话结束或网页关闭后，服务器立即销毁所有转发连接，不保留任何数据。

## TMDB 番剧搜索说明

- 在 [themoviedb.org](https://www.themoviedb.org/) 免费申请一个 v3 API Key；
- 两种配置方式任选：服务器环境变量 `TMDB_API_KEY`，或页面 **⚙ 设置 → TMDB API Key** 里填写
  （后者只保存在浏览器 localStorage，请求时带给本服务器转发，不会写进静态页面）；
- 默认请求官方 `api.themoviedb.org`；连不上（报 “TMDB 请求失败：…”）时，可以在页面
  **⚙ 设置 → TMDB API 地址** 或服务器环境变量 `TMDB_API_BASE` 换成可用的镜像/代理。
  若代理需要完整 URL 模板，
  用 `{url}` 占位（如 `https://corsproxy.io/?url={url}`）；
- 搜索番剧后上方会列出 TMDB 的海报/简介/季与集数；点某一集，页面会用该集关键词在蜜柑搜索，
  并按 `[字幕组]` 分类展示、可直接播放。

## 重新打包前端库（开发用）

`p2p/vendor/webtorrent.iife.min.js` 是 WebRTC 版，`p2p/vendor/webtorrent-wasmnet.iife.min.js` 是支持 TCP/UDP 的版本（把 `net`/`dgram` 替换为 wasmnet 中继垫片）。改完垫片后执行：
`p2p/vendor/mediabunny.iife.min.js` 是 MKV 流式封装引擎（Mediabunny），配合 `p2p/mkv-mse.js`
把 MKV 无损转成 fMP4 喂给浏览器播放。前端库构建命令：

wasmnet 版额外启用了浏览器默认关闭的能力：

- **HTTP tracker**：经服务器 `/api/fetch` 代发（绕开浏览器 CORS 限制）；
- **UDP tracker**：经中继转发真实 UDP 报文；
- **DHT / PEX**：不需要 tracker 也能通过分布式哈希表发现做种者（国内网络 tracker 不通时主要靠它）。

```bash
pnpm build:wasmnet
pnpm build:mediabunny
```

（或一次性执行 `pnpm build:frontend` 同时构建两个包。）

> 注意：`node_modules` 里的 `fsa-chunk-store@1.3.0` 有一个必须保留的兼容补丁（否则 OPFS 写入会报
> `(intermediate value).write is not a function`）：在 `_put` 中把 `if (!file.stream) {` 改为
> `if (!file.stream || typeof file.stream.then !== 'function') {`。重新 `pnpm install` 后如被覆盖，
> 请重新打上该补丁再执行上面的打包命令。

## 注意事项

- 本项目仅用于个人学习和研究，请尊重版权，只播放你有权观看的内容。
- 服务端不参与下载、不缓存数据，BT 数据始终在浏览器内存 / OPFS 缓存中。
- 中转模式能否连上做种者取决于 NAS 的网络环境和种子热度；TCP/UDP 直连普通 BT 客户端的成功率远高于纯 WebRTC。
