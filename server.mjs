// Mikan 搜索代理 + wasmnet 转发服务
//
// 本服务只做两件事：
//  1. 代理蜜柑计划（mikanime.tv）的搜索请求（浏览器直接请求会被 CORS 拦截）；
//  2. 提供 wasmnet WebSocket 中继，让浏览器端的 WebTorrent 能通过 NAS
//     建立真实的 TCP/UDP 连接去连普通 BitTorrent 做种者。
//
// 服务端不做 BT 下载、不做转码、不保存任何数据。
// BT 边下边播全部发生在浏览器里（p2p/index.html）。

import express from 'express'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import bencode from 'bencode'
import { searchMikan, fetchMikanEpisode } from './lib/mikan.js'
import { attachWasmnetRelay } from './server/wasmnet-relay.mjs'
import DHT from 'bittorrent-dht'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 3000)
const HOST = process.env.HOST || '0.0.0.0'
const DHT_PORT = Number(process.env.DHT_PORT || 0) // 0 = 随机端口
const WASMNET_PATH = '/wasmnet'
// DHT 引导节点：多放几个，哪个网络通就用哪个
const DHT_BOOTSTRAP = [
  'router.bittorrent.com:6881',
  'router.utorrent.com:6881',
  'dht.transmissionbt.com:6881',
  'dht.aelitis.com:6881',
  'dht.libtorrent.org:25401',
  'router.bitcomet.com:6881',
]

// wasmnet 中继的访问令牌：
//  - 设置了 WASMNET_TOKEN 则使用该固定值；
//  - 否则每次启动随机生成（页面通过 /api/config 同源获取）；
//  - 显式设置 WASMNET_OPEN=1 可关闭令牌（仅建议在完全可信的内网使用）。
const WASMNET_TOKEN =
  process.env.WASMNET_OPEN === '1' ? '' : (process.env.WASMNET_TOKEN || crypto.randomBytes(24).toString('hex'))
// TMDB API Key（可选）：用于番剧搜索/选集。可在服务器环境变量 TMDB_API_KEY 配置，
// 也可以在页面“设置”里填写（仅存浏览器 localStorage，随请求带给本服务器转发）。
const TMDB_API_KEY = process.env.TMDB_API_KEY || ''
// TMDB API 地址（可选）：默认官方地址；国内网络连不上时可以改成可用的镜像/代理。
// 也支持在页面“设置”里填写（优先级：页面设置 > 环境变量 > 官方地址）。
// 若地址里含 {url}，则把它当作代理模板，{url} 会被替换为完整的官方 TMDB URL（如 corsproxy）。
const TMDB_API_BASE = process.env.TMDB_API_BASE || 'https://api.themoviedb.org/3'
// TMDB 备用地址（可选，逗号分隔）：主地址解析失败/连不上时按顺序自动重试。
// 默认还会兜底官方地址 https://api.themoviedb.org/3。
const TMDB_API_FALLBACKS = (process.env.TMDB_API_FALLBACKS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
// 设成 1 可关闭 TMDB 自动兜底（只使用配置/页面指定的那一个地址）
const TMDB_NO_FALLBACK = process.env.TMDB_NO_FALLBACK === '1'

const app = express()
app.use(express.json({ limit: '1mb' }))

// ---------- API ----------

// 搜索代理：允许任意来源调用（file:// 打开的纯网页版也需要跨域使用）
app.get('/api/search', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const q = String(req.query.q || '').trim()
  if (!q) return res.json({ items: [] })
  const base = String(req.query.base || '').trim()
  try {
    const result = await searchMikan(q, { base })
    res.json({ items: result.items, source: result.source || null })
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.details || [] })
  }
})

// 蜜柑详情页：按 infoHash 返回番剧名、字幕组、发布日期、图片、磁力链接等
app.get('/api/mikan-detail', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const token = String(req.query.token || '')
  if (WASMNET_TOKEN && token !== WASMNET_TOKEN) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const hash = String(req.query.hash || '').trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(hash)) {
    return res.status(400).json({ error: '无效的 infoHash' })
  }
  try {
    const info = await fetchMikanEpisode(hash)
    res.json({ ok: true, ...info })
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.details || [] })
  }
})

app.get('/api/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.json({
    ok: true,
    searchProxy: true,
    wasmnetRelay: true,
    tmdbProxy: true,
    dht: dhtReady,
    dhtNodes: dhtNode && dhtReady && dhtNode.nodes && typeof dhtNode.nodes.count === 'function'
      ? dhtNode.nodes.count()
      : -1,
    mode: 'frontend-streaming',
  })
})

// ---------- DHT 做种者发现节点（只查询、不下载、不落盘、不做种） ----------
// 浏览器端为了稳定连接中继关闭了 DHT；这里让 NAS 跑一个 DHT 节点，
// 帮浏览器找到 tracker 发现不到的做种者，再通过 /api/dht-peers 返回给前端去连接。
const dhtPeersCache = new Map() // infoHash -> { peers:Set, lastLookup, lookupActive }
let dhtNode = null
let dhtReady = false

function startDhtNode() {
  try {
    dhtNode = new DHT({ bootstrap: DHT_BOOTSTRAP })
    dhtNode.on('warning', () => { /* 静默，避免刷日志 */ })
    dhtNode.on('error', (err) => console.warn('[dht] 节点错误:', err && err.message))
    dhtNode.on('ready', () => {
      dhtReady = true
      console.log('  DHT 节点就绪（只做种者发现，不落盘）')
    })
    dhtNode.on('peer', (peer, infoHash) => {
      if (!peer || !peer.host || !peer.port) return
      const key = Buffer.isBuffer(infoHash) ? infoHash.toString('hex') : String(infoHash).toLowerCase()
      const entry = dhtPeersCache.get(key)
      if (entry && entry.peers.size < 500) entry.peers.add(peer.host + ':' + peer.port)
    })
    dhtNode.listen(DHT_PORT, HOST, () => {
      console.log('  DHT 节点监听 UDP ' + (dhtNode.address() && dhtNode.address().port))
    })
  } catch (err) {
    console.warn('[dht] 节点启动失败（不影响其他功能）:', err && err.message)
    dhtNode = null
  }
}

function dhtLookup(infoHashHex) {
  const now = Date.now()
  let entry = dhtPeersCache.get(infoHashHex)
  if (!entry) {
    entry = { peers: new Set(), lastLookup: 0, lookupActive: false }
    dhtPeersCache.set(infoHashHex, entry)
  }
  // 同一 hash 至少间隔 15 秒才重新全网查询；查询期间后续请求直接返回已有结果
  if (!entry.lookupActive && now - entry.lastLookup > 15000) {
    entry.lookupActive = true
    entry.lastLookup = now
    const timer = setTimeout(() => { entry.lookupActive = false }, 10000)
    try {
      dhtNode.lookup(infoHashHex, () => {
        clearTimeout(timer)
        entry.lookupActive = false
      })
    } catch (err) {
      clearTimeout(timer)
      entry.lookupActive = false
    }
  }
  return [...entry.peers].slice(0, 300)
}

app.get('/api/dht-peers', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const token = String(req.query.token || '')
  if (WASMNET_TOKEN && token !== WASMNET_TOKEN) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const infoHash = String(req.query.infoHash || '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(infoHash)) {
    return res.status(400).json({ error: 'infoHash 格式不正确' })
  }
  if (!dhtNode || !dhtReady) {
    return res.status(503).json({ error: 'DHT 节点未就绪' })
  }
  res.json({ ok: true, infoHash, peers: dhtLookup(infoHash) })
})

// TMDB 番剧数据代理：浏览器直连 api.themoviedb.org 会被 CORS 拦截，
// 这里由服务器转发（API Key 只存在服务器环境变量或页面 localStorage，不写进静态页面）。
async function tmdbProxy(req, res, apiPath) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const token = String(req.query.token || '')
  if (WASMNET_TOKEN && token !== WASMNET_TOKEN) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const key = TMDB_API_KEY || String(req.query.key || '').trim()
  if (!key) {
    return res.status(400).json({
      error: '未配置 TMDB API Key：请在服务器环境变量 TMDB_API_KEY 设置，或在页面“设置”里填写',
    })
  }
  const rawBase = String(req.query.base || '').trim()
  // 候选地址顺序：页面设置 > 环境变量 > TMDB_API_FALLBACKS > 官方地址。
  // 主地址 DNS 解析失败（EAI_AGAIN）或连不上时，自动换下一个，不再一锤子报错。
  const candidates = []
  const push = (b) => {
    const clean = String(b || '').trim().replace(/\/+$/, '')
    if (clean && !candidates.includes(clean)) candidates.push(clean)
  }
  push(rawBase)
  push(TMDB_API_BASE)
  if (!TMDB_NO_FALLBACK) {
    for (const f of TMDB_API_FALLBACKS) push(f)
    push('https://api.themoviedb.org/3')
  }

  const explicit = rawBase || TMDB_API_BASE
  let u
  try {
    u = new URL(explicit)
  } catch {
    return res.status(400).json({ error: 'TMDB API 地址格式不正确' })
  }
  if (!/^https?:$/.test(u.protocol)) {
    return res.status(400).json({ error: 'TMDB API 地址只支持 http/https' })
  }

  const sep = apiPath.includes('?') ? '&' : '?'
  const params = 'api_key=' + encodeURIComponent(key) + '&language=zh-CN'
  const officialUrl = 'https://api.themoviedb.org/3' + apiPath + sep + params
  const errors = []
  for (const base of candidates) {
    const target = base.includes('{url}')
      ? base.replace('{url}', encodeURIComponent(officialUrl))
      : base + apiPath + sep + params
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12000)
      const r = await fetch(target, {
        signal: ctrl.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
        },
      })
      clearTimeout(timer)
      // API Key 或站点鉴权问题：换镜像也没用，直接返回给用户看真实错误
      if (r.status === 401 || r.status === 403) {
        const j = await r.json().catch(() => null)
        res.status(r.status)
        return res.json(j || { error: 'TMDB 鉴权失败（HTTP ' + r.status + '）' })
      }
      if (!r.ok) {
        errors.push(base + ' -> HTTP ' + r.status)
        continue
      }
      const j = await r.json().catch(() => null)
      if (!j) {
        errors.push(base + ' -> 返回内容不是 JSON')
        continue
      }
      res.status(r.status)
      return res.json(j)
    } catch (err) {
      const cause = err && err.cause
      const detail = (cause && (cause.code || cause.message)) || (err && err.code) || (err && err.message) || '未知错误'
      errors.push(base + ' -> ' + detail)
    }
  }
  res.status(502).json({ error: 'TMDB 请求失败：' + (errors.join('；') || '所有地址均不可用') })
}

app.get('/api/tmdb/search', (req, res) => {
  const q = String(req.query.q || '').trim()
  if (!q) return res.json({ results: [] })
  tmdbProxy(req, res, '/search/tv?query=' + encodeURIComponent(q) + '&include_adult=false')
})

app.get('/api/tmdb/tv/:id', (req, res) => {
  tmdbProxy(req, res, '/tv/' + encodeURIComponent(req.params.id))
})

app.get('/api/tmdb/tv/:id/season/:num', (req, res) => {
  tmdbProxy(
    req,
    res,
    '/tv/' + encodeURIComponent(req.params.id) + '/season/' + encodeURIComponent(req.params.num),
  )
})

// 前端配置：给出 wasmnet 中继的路径和令牌。
// 令牌只允许同源（或本地 file:// 页面）读取，避免第三方网站拿到后把
// NAS 当中继代理使用。
function sameHost(origin, req) {
  try {
    const o = new URL(origin)
    const host = req.headers['x-forwarded-host'] || req.headers.host
    return o.host === host
  } catch {
    return false
  }
}

app.get('/api/config', (req, res) => {
  const origin = req.headers.origin
  if (origin && origin !== 'null' && !sameHost(origin, req)) {
    return res.status(403).json({ error: 'forbidden' })
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'false')
  }
  res.json({
    ok: true,
    wasmnet: {
      path: WASMNET_PATH,
      token: WASMNET_TOKEN,
    },
  })
})

// HTTP tracker 转发：浏览器直接请求 tracker 会被 CORS 拦截，
// 这里由服务器代发 announce 请求，把 tracker 的原始响应原样转回。
// 只允许 /announce 类型的 URL，仅转发、不缓存、不落盘。
app.get('/api/fetch', async (req, res) => {
  const token = String(req.query.token || '')
  if (WASMNET_TOKEN && token !== WASMNET_TOKEN) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const target = String(req.query.url || '')
  let url
  try {
    url = new URL(target)
  } catch {
    return res.status(400).json({ error: 'invalid url' })
  }
  if (!/^https?:$/.test(url.protocol)) {
    return res.status(400).json({ error: 'invalid protocol' })
  }
  if (!url.pathname.includes('/announce')) {
    return res.status(400).json({ error: 'not a tracker announce url' })
  }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    const r = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      },
    })
    clearTimeout(timer)
    const buf = Buffer.from(await r.arrayBuffer())
    res.status(r.status)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream')
    res.send(buf)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// 读取种子文件里的 tracker 列表（磁力链通常只带少量 tracker，
// 而蜜柑的种子文件里嵌了几十个，其中不少是可达的）
app.get('/api/torrent-trackers', async (req, res) => {
  const token = String(req.query.token || '')
  if (WASMNET_TOKEN && token !== WASMNET_TOKEN) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const target = String(req.query.url || '')
  let url
  try {
    url = new URL(target)
  } catch {
    return res.status(400).json({ error: 'invalid url' })
  }
  if (!/^https?:$/.test(url.protocol)) {
    return res.status(400).json({ error: 'invalid protocol' })
  }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    const r = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
      },
    })
    clearTimeout(timer)
    if (!r.ok) {
      return res.status(502).json({ error: '种子文件下载失败（HTTP ' + r.status + '）' })
    }
    const buf = Buffer.from(await r.arrayBuffer())
    let meta
    try {
      meta = bencode.decode(buf)
    } catch {
      return res.status(502).json({ error: '不是有效的种子文件' })
    }
    const dec = (v) => (v == null ? '' : Buffer.from(v).toString('utf8'))
    const trackers = []
    if (meta['announce']) {
      const s = dec(meta['announce'])
      if (s) trackers.push(s)
    }
    for (const list of meta['announce-list'] || []) {
      for (const item of list) {
        const s = dec(item)
        if (s && !trackers.includes(s)) trackers.push(s)
      }
    }
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.json({ ok: true, trackers })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

// ---------- 静态页面 ----------

// 根路径直接进纯网页版
app.get('/', (req, res) => res.redirect('/p2p/index.html'))

// 纯网页版（含打包好的浏览器 WebTorrent 与 wasmnet 版本）
app.use('/p2p', express.static(path.join(__dirname, 'p2p')))

// 浏览器端渐进播放用的 Service Worker（随页面提供，不依赖 node_modules）
app.get('/sw.min.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript')
  res.setHeader('Cache-Control', 'no-cache')
  res.sendFile(path.join(__dirname, 'p2p', 'vendor', 'sw.min.js'))
})

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求体格式错误' })
  }
  console.error(err)
  res.status(500).json({ error: '服务器内部错误' })
})

const server = app.listen(PORT, HOST, () => {
  const lanIps = []
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) lanIps.push(ni.address)
    }
  }
  console.log('')
  console.log('  Mikan Stream server is running (search proxy + wasmnet relay)')
  console.log(`  Local:  http://127.0.0.1:${PORT}/p2p/index.html`)
  if (lanIps.length) {
    console.log(`  LAN:    ${lanIps.map((ip) => `http://${ip}:${PORT}/p2p/index.html`).join('  ')}`)
  }
  if (WASMNET_TOKEN) {
    console.log('  wasmnet relay token: ' + WASMNET_TOKEN + ' （页面会自动获取，仅调试用）')
  }
  console.log('')
})

startDhtNode()

// 挂载 wasmnet 中继（WebSocket）
attachWasmnetRelay(server, { path: WASMNET_PATH, token: WASMNET_TOKEN })

function shutdown() {
  if (dhtNode) {
    try { dhtNode.destroy(() => {}) } catch (e) { /* 忽略 */ }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
