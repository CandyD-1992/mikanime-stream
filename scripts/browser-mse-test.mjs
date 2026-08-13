// MKV -> fMP4 -> MSE 浏览器端到端测试：
//   - 本地 HTTP 服务静态页面 + Mediabunny/MikanMsePlayer
//   - 迷你 BT 做种者（真实 ut_metadata + 分片数据）
//   - 浏览器内 WebTorrent 下载 -> MikanMsePlayer 流式无损封装 -> <video> 播放
// 用法: 先启动 server（任意端口），再 node scripts/browser-mse-test.mjs [--port 3010] [--file 路径] [--no-seed]
import { chromium } from 'playwright'
import crypto from 'node:crypto'
import netnode from 'node:net'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { Buffer as NodeBuffer } from 'node:buffer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import createTorrent from '../node_modules/.pnpm/create-torrent@6.1.3/node_modules/create-torrent/index.js'
import bencode from '../node_modules/.pnpm/bencode@4.0.1/node_modules/bencode/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const logFile = path.join(here, 'testdata', 'mse-test.log')
try { fs.rmSync(logFile, { force: true }) } catch (e) { /* 忽略 */ }
const log = (...args) => {
  const line = args.map(String).join(' ')
  console.log(line)
  fs.appendFileSync(logFile, line + '\n')
}
process.on('unhandledRejection', (e) => log('[mse-test] unhandledRejection:', e && (e.stack || e.message)))
const portIdx = process.argv.indexOf('--port')
const PORT = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 3010
const fileIdx = process.argv.indexOf('--file')
const mkvPath = fileIdx >= 0
  ? path.resolve(process.argv[fileIdx + 1])
  : path.join(root, 'scripts', 'testdata', 'annex-b-avc.mkv')
const magnetIdx = process.argv.indexOf('--magnet')
const userMagnet = magnetIdx >= 0 ? process.argv[magnetIdx + 1] : null
const WITH_SEEDER = !process.argv.includes('--no-seed')
const PAGE_MODE = process.argv.includes('--page')
const START_SERVER = process.argv.includes('--server')
const channelIdx = process.argv.indexOf('--channel')
const CHANNEL = channelIdx >= 0 ? process.argv[channelIdx + 1] : null
const playIdx = process.argv.indexOf('--play-seconds')
const PLAY_SECONDS = playIdx >= 0 ? Number(process.argv[playIdx + 1]) || 0 : 0

let serverProc = null
if (START_SERVER) {
  serverProc = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  })
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      if (r.ok) break
    } catch (e) { /* 等待 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
}

// ---------- 1) 用目标 MKV 生成真实种子（或使用用户提供的磁力链） ----------
let fileData = null
let fileName = ''
let infoBytes = null
let pieceLength = 0
let totalSize = 0
let numPieces = 0
let magnet = null
if (userMagnet) {
  magnet = userMagnet
  log('[mse-test] using user-provided magnet:', magnet)
} else {
  fileData = fs.readFileSync(mkvPath)
  fileName = path.basename(mkvPath)
  const torrentBuf = await new Promise((resolve, reject) => {
    createTorrent([fileData], { name: fileName }, (err, buf) => (err ? reject(err) : resolve(buf)))
  })
  const meta = bencode.decode(torrentBuf)
  infoBytes = NodeBuffer.from(bencode.encode(meta.info))
  const infoHash = crypto.createHash('sha1').update(infoBytes).digest('hex')
  pieceLength = meta.info['piece length']
  totalSize = fileData.length
  numPieces = Math.ceil(totalSize / pieceLength)
  magnet = 'magnet:?xt=urn:btih:' + infoHash + '&dn=' + encodeURIComponent(fileName)
  log('[mse-test] file:', fileName, '| size:', totalSize, '| pieces:', numPieces, '| piece:', pieceLength)
}

// ---------- 2) 迷你 BT 做种者 ----------
const u32 = (n) => { const b = NodeBuffer.alloc(4); b.writeUInt32BE(n); return b }
const wrap = (body) => NodeBuffer.concat([u32(NodeBuffer.from(body).length), NodeBuffer.from(body)])
const sendBitfieldAndUnchoke = (sock) => {
  sock.write(wrap([1]))
  const bitfield = NodeBuffer.alloc(Math.ceil(numPieces / 8))
  for (let i = 0; i < numPieces; i++) bitfield[Math.floor(i / 8)] |= 0x80 >> (i % 8)
  sock.write(wrap(NodeBuffer.concat([NodeBuffer.from([5]), bitfield])))
}
let seederPort = 0
let servedPieces = 0
let conns = 0
const seeder = netnode.createServer((sock) => {
  conns++
  log('[seeder] connection #' + conns)
  let buf = NodeBuffer.alloc(0)
  let handshaked = false
  sock.on('data', (d) => {
    buf = NodeBuffer.concat([buf, d])
    for (;;) {
      if (!handshaked) {
        if (buf.length < 68) return
        handshaked = true
        const resp = NodeBuffer.alloc(68)
        resp[0] = 19
        resp.write('BitTorrent protocol', 1)
        resp[25] |= 0x10
        buf.subarray(28, 48).copy(resp, 28)
        NodeBuffer.from('--MSE0001-0123456789ab', 'latin1').copy(resp, 48)
        sock.write(resp)
        const extPayload = NodeBuffer.from(bencode.encode({ m: { ut_metadata: 1 }, metadata_size: infoBytes.length }))
        sock.write(wrap(NodeBuffer.concat([NodeBuffer.from([20, 0]), extPayload])))
        sendBitfieldAndUnchoke(sock)
        buf = buf.subarray(68)
        continue
      }
      if (buf.length < 4) return
      const len = buf.readUInt32BE(0)
      if (buf.length < 4 + len) return
      const msg = buf.subarray(4, 4 + len)
      buf = buf.subarray(4 + len)
      const id = msg[0]
      if (id === 20 && msg[1] === 1) {
        const req = bencode.decode(msg.subarray(2))
        if (req.msg_type === 0) {
          const start = req.piece * 16384
          const end = Math.min(infoBytes.length, start + 16384)
          const payload = bencode.encode({ msg_type: 1, piece: req.piece, total_size: infoBytes.length })
          sock.write(wrap(NodeBuffer.concat([
            NodeBuffer.from([20, 1]), NodeBuffer.from(payload), infoBytes.subarray(start, end),
          ])))
        }
      } else if (id === 2) {
        sendBitfieldAndUnchoke(sock)
      } else if (id === 6 && msg.length >= 13) {
        const idx = msg.readUInt32BE(1)
        const begin = msg.readUInt32BE(5)
        const length = msg.readUInt32BE(9)
        servedPieces++
        sock.write(wrap(NodeBuffer.concat([
          NodeBuffer.from([7]), u32(idx), u32(begin),
          fileData.subarray(idx * pieceLength + begin, idx * pieceLength + begin + length),
        ])))
      }
    }
  })
})
if (WITH_SEEDER && !userMagnet) {
  await new Promise((r) => seeder.listen(0, '127.0.0.1', r))
  seederPort = seeder.address().port
  log('[mse-test] 做种者监听', seederPort)
}

// ---------- 4) 浏览器内测试 ----------
const browser = await chromium.launch({ headless: true, ...(CHANNEL ? { channel: CHANNEL } : {}) })
log('[mse-test] 浏览器已启动')
const page = await browser.newPage()
log('[mse-test] 页面已创建')
const logs = []
page.on('console', (m) => {
  const line = '[' + m.type() + '] ' + m.text()
  logs.push(line)
  log('[page]', line)
})
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message))
await page.goto(
  PAGE_MODE
    ? `http://127.0.0.1:${PORT}/p2p/index.html`
    : `http://127.0.0.1:${PORT}/p2p/mse-test.html`,
  { waitUntil: 'networkidle' },
)
log('[mse-test] 页面已加载')
for (let i = 0; i < 30 && !(await page.evaluate(() => typeof window.MikanMsePlayer === 'function')); i++) {
  await new Promise((r) => setTimeout(r, 300))
}

const result = PAGE_MODE ? await page.evaluate(async ({ magnet, seederPort, fileName, playSeconds }) => {
  const out = { started: false, readyState: 0, duration: 0, currentTime: 0, error: null, mseStatus: '', playbackKind: '' }
  const video = document.getElementById('video')
  // 页面是懒加载 wasmnet 包的，先手动加载，确保能拦截客户端创建
  if (typeof WebTorrentWasmnet !== 'function') {
    await new Promise((res, rej) => {
      const s = document.createElement('script')
      s.src = 'vendor/webtorrent-wasmnet.iife.min.js'
      s.onload = res
      s.onerror = () => rej(new Error('wasmnet bundle load failed'))
      document.head.appendChild(s)
    })
  }
  // 拦截 WebTorrentWasmnet 类的赋值：一旦页面加载 wasmnet 包（同步重新定义全局类），
  // 立刻给 prototype.add 打补丁，把本地做种者注入到该客户端创建的所有种子。
  let realW = window.WebTorrentWasmnet
  const makePatched = (W) => {
    console.log('[mse] patching WebTorrentWasmnet.add')
    const origAdd = W.prototype.add
    W.prototype.add = function (m, opts) {
      const t = origAdd.call(this, m, opts)
      setTimeout(() => {
        try {
          console.log('[mse] adding peer ' + seederPort)
          if (seederPort && !t.destroyed) t.addPeer('127.0.0.1:' + seederPort)
        } catch (e) { console.log('[mse] addPeer error: ' + e.message) }
      }, 600)
      return t
    }
    return W
  }
  if (realW) makePatched(realW)
  Object.defineProperty(window, 'WebTorrentWasmnet', {
    configurable: true,
    get: () => realW,
    set: (v) => { realW = v ? makePatched(v) : v },
  })
  // 打开“服务器中转”模式
  const btn = document.getElementById('btn-wasmnet')
  console.log('[mse] wasmnet btn active before: ' + (btn && btn.classList.contains('active')))
  if (btn && !btn.classList.contains('active')) btn.click()
  console.log('[mse] wasmnet btn active after: ' + (btn && btn.classList.contains('active')))
  console.log('[mse] wasmnet status: ' + document.getElementById('wasmnet-status').textContent)
  // 走页面真实的“粘贴磁力链”流程
  document.getElementById('paste-input').value = magnet
  document.getElementById('paste-form').requestSubmit()
  console.log('[mse] magnet submitted')
  // 等文件列表或直接开播（单文件种子页面会自动播放，不显示选择条）
  for (let i = 0; i < 120
    && !document.querySelector('.file-chip')
    && !document.getElementById('player-title').textContent.trim(); i++) {
    if (i === 20) {
      console.log('[mse] diag title=' + document.getElementById('player-title').textContent
        + ' | loading=' + document.getElementById('loading-text').textContent
        + ' | err=' + document.getElementById('player-error').textContent
        + ' | wt=' + typeof WebTorrentWasmnet)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  const chips = [...document.querySelectorAll('.file-chip')]
  if (chips.length) {
    const chip = chips.find((c) => c.textContent.toLowerCase().includes('.mkv'))
      || chips.find((c) => c.textContent.includes(fileName))
      || chips[0]
    console.log('[mse] file chip: ' + chip.textContent)
    chip.click()
  }
  if (!chips.length && !document.getElementById('player-title').textContent.trim()) {
    out.error = '既没有文件列表也没有自动开播'
    return out
  }
  out.started = true
  // 等播放器建立 + 出画
  for (let i = 0; i < 160 && !out.error; i++) {
    out.mseStatus = (document.getElementById('transcode-status') || {}).textContent || ''
    if (video.readyState >= 2 && video.currentTime >= 1) break
    if (document.getElementById('player-error') && !document.getElementById('player-error').classList.contains('hidden')) {
      out.error = document.getElementById('player-error').textContent
      break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  out.readyState = video.readyState
  out.duration = video.duration
  out.currentTime = video.currentTime
  const mono = document.getElementById('monitor-overlay').textContent
  out.playbackKind = mono.match(/播放方式[^\n]*/)?.[0] || ''
  out.mseStatus = (document.getElementById('transcode-status') || {}).textContent || ''
  out.title = (document.getElementById('player-title') || {}).textContent || ''
  out.subtitleOptions = [...(document.querySelector('#subtitle-select') || { options: [] }).options].map((o) => o.textContent)
  out.torrentName = (document.getElementById('stat-name') || {}).textContent || ''
  out.lastMseError = (window.__state && window.__state.lastMseError) || null
  out.errorText = (document.getElementById('player-error') || {}).textContent || ''
  // 等字幕 cue 挂上视频轨（最多 ~15s）
  for (let i = 0; i < 30; i++) {
  // 需要时继续播放指定秒数，观察 SourceBuffer 是否写满
  if (playSeconds > 0) {
    for (let i = 0; i < playSeconds * 4 && !out.error; i++) {
      const errEl = document.getElementById('player-error')
      if (errEl && !errEl.classList.contains('hidden')) {
        out.error = errEl.textContent
        break
      }
      if (video.currentTime >= playSeconds) break
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  out.textTracks = [...(video.textTracks || [])].map((tr) => ({
      label: tr.label,
      mode: tr.mode,
      cues: tr.cues ? tr.cues.length : 0,
      first: tr.cues && tr.cues[0] ? tr.cues[0].text : null,
    }))
    if (out.textTracks.some((t) => t.cues > 0)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  try {
    const ranges = []
    for (let i = 0; i < video.buffered.length; i++) ranges.push([Math.round(video.buffered.start(i) * 10) / 10, Math.round(video.buffered.end(i) * 10) / 10])
    out.bufferedRanges = ranges
  } catch (e) { out.bufferedRanges = null }
  console.log('[mse] readyState=' + video.readyState + ' currentTime=' + video.currentTime + ' status=' + out.mseStatus)
  return out
}, { magnet, seederPort, fileName, playSeconds: PLAY_SECONDS }) : await page.evaluate(async ({ magnet, seederPort, fileName }) => {
  const out = { started: false, readyState: 0, duration: 0, currentTime: 0, bufferedEnd: 0, error: null, done: false, seekOk: null }
  const video = document.getElementById('v')
  const logEl = document.getElementById('log')
  const log = (s) => { logEl.textContent += s + '\n'; console.log('[mse]', s) }
  const client = new WebTorrentWasmnet({ dht: false, lsd: false })
  const t = client.add(magnet, { store: WebTorrentWasmnet.MemoryChunkStore })
  await new Promise((r) => setTimeout(r, 300))
  if (seederPort) t.addPeer('127.0.0.1:' + seederPort)
  await new Promise((r) => t.on('ready', r))
  const file = t.files[0]
  log('torrent ready: ' + file.name + ' | ' + file.length + ' bytes')
  const player = new MikanMsePlayer()
  window.__player = player
  player.play(file, video, {
    status: (s) => log('status: ' + s),
    progress: (p) => { window.__prog = Math.round(p * 100) },
    error: (e) => { out.error = e.message; log('ERROR: ' + e.message) },
  }).then(() => {
    out.started = true
    log('player.play resolved')
  }).catch((e) => {
    out.error = e.message
    log('play failed: ' + e.message)
  })

  // 等 metadata
  for (let i = 0; i < 120 && video.readyState < 1 && !out.error; i++) {
    await new Promise((r) => setTimeout(r, 250))
  }
  out.readyState = video.readyState
  out.duration = video.duration
  log('readyState=' + video.readyState + ' duration=' + video.duration)
  if (video.readyState >= 1) {
    await video.play().catch(() => {})
    // 播放推进 + 缓冲增长
    for (let i = 0; i < 60 && video.currentTime < 2 && !out.error; i++) {
      await new Promise((r) => setTimeout(r, 250))
    }
    out.currentTime = video.currentTime
    // 在缓冲区内尝试 seek
    const sb = player._sourceBuffer
    if (sb && sb.buffered && sb.buffered.length) {
      const end = sb.buffered.end(sb.buffered.length - 1)
      if (end > 2) {
        try {
          video.currentTime = Math.min(end - 1, 5)
          await new Promise((r) => setTimeout(r, 1500))
          out.seekOk = video.currentTime > 1 && video.currentTime < end + 1
          log('seek -> ' + video.currentTime)
        } catch (e) {
          out.seekOk = 'seek threw: ' + e.message
        }
      }
    }
  }
  // 等下载完成 + 封装结束
  for (let i = 0; i < 240 && !out.error; i++) {
    if (t.done && player._finished) break
    await new Promise((r) => setTimeout(r, 250))
  }
  out.done = t.done && player._finished
  out.bufferedEnd = player.getBufferedEnd()
  out.durationFinal = video.duration
  out.progress = window.__prog
  log('torrent.done=' + t.done + ' player.finished=' + player._finished + ' bufferedEnd=' + out.bufferedEnd)
  // 字幕验证：等字幕轨和 cue 出现
  out.subtitles = { cues: 0, first: null }
  for (let i = 0; i < 80; i++) {
    const entries = player._subTracks ? [...player._subTracks.values()] : []
    const active = entries.find((e) => e.track && e.track.mode === 'showing') || entries[0]
    if (active && active.track && active.track.cues && active.track.cues.length > 0) {
      out.subtitles = { cues: active.track.cues.length, first: active.track.cues[0] ? active.track.cues[0].text : null }
      break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  log('subtitles cues=' + out.subtitles.cues + ' tracks=' + (player._subTracks ? player._subTracks.size : 0))
  await player.stop()
  return out
}, { magnet, seederPort, fileName })

log('=== 浏览器内结果 ===')
log(JSON.stringify(result, null, 2))
log('=== 关键日志 ===')
log(logs.filter((l) => /\[mse\]|ERROR|pageerror/.test(l)).slice(-40).join('\n'))
log('[mse-test] servedPieces:', servedPieces)
fs.mkdirSync(path.join(root, '.debug'), { recursive: true })
fs.writeFileSync(path.join(root, '.debug', 'last-mse-test.json'), JSON.stringify(result, null, 2))
seeder.close()
await browser.close()
if (serverProc) serverProc.kill()
const ok = result.started && result.readyState >= 2 && result.duration > 0 && result.currentTime >= 1
process.exit(ok ? 0 : 1)
