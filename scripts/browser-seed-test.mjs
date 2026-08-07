// 浏览器内做种测试：
//   默认：迷你假做种者，验证浏览器完整下载链路
//   --real：真实做种者（内存存储 + 可关 DHT），对照定位浏览器特有差异
// 用法：先启动 server，再 node scripts/browser-seed-test.mjs --port 3010 [--real] [--no-dht]

import { chromium } from 'playwright'
import crypto from 'node:crypto'
import netnode from 'node:net'
import { Buffer as NodeBuffer } from 'node:buffer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import createTorrent from '../node_modules/.pnpm/create-torrent@6.1.3/node_modules/create-torrent/index.js'
import bencode from '../node_modules/.pnpm/bencode@4.0.1/node_modules/bencode/index.js'
import { searchMikan } from '../lib/mikan.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const portIdx = process.argv.indexOf('--port')
const PORT = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 3010
const REAL = process.argv.includes('--real')
const NO_DHT = process.argv.includes('--no-dht')
const FORCE_POLYFILL = process.argv.includes('--polyfill')

let magnet, realPeers = [], files = [], infoBytes, pieceLength, totalSize, numPieces

if (REAL) {
  const items = await searchMikan('葬送的芙莉莲')
  magnet = items[0].magnet
  const hashHex = /btih:([0-9a-f]{40})/i.exec(magnet)[1]
  const infoHash = NodeBuffer.from(hashHex, 'hex')
  const peerId = NodeBuffer.from('-MK0001-0123456789ab', 'latin1')
  const binEnc = (buf) => [...buf].map((b) => '%' + b.toString(16).padStart(2, '0')).join('')
  const q = 'info_hash=' + binEnc(infoHash) + '&peer_id=' + binEnc(peerId) + '&port=6881&uploaded=0&downloaded=0&left=104857600&compact=1&event=started&numwant=50&key=12345678'
  const cfg = await (await fetch(`http://127.0.0.1:${PORT}/api/config`)).json()
  const r = await fetch(`http://127.0.0.1:${PORT}/api/fetch?token=` + cfg.wasmnet.token + '&url=' + encodeURIComponent('http://tracker.renfei.net:8080/announce?' + q))
  const meta = bencode.decode(NodeBuffer.from(await r.arrayBuffer()))
  const p = meta['peers']
  if (Array.isArray(p)) realPeers.push(...p.map((x) => NodeBuffer.from(x.ip).join('.') + ':' + (x.port || 0)))
  else if (p && p.length) { for (let i = 0; i + 6 <= p.length; i += 6) realPeers.push(p[i] + '.' + p[i+1] + '.' + p[i+2] + '.' + p[i+3] + ':' + ((p[i+4] << 8) | p[i+5])) }
  console.log('[seed] 真实模式 | dht=' + (!NO_DHT) + ' | 做种者:', realPeers.slice(0, 5).join(' '))
} else {
  files = Array.from({ length: 900 }, (_, i) => NodeBuffer.from('file-' + i + ' content payload. ' + i, 'utf8'))
  const torrentBuf = await new Promise((resolve, reject) => {
    createTorrent(files, { name: 'test-payload' }, (err, buf) => (err ? reject(err) : resolve(buf)))
  })
  const meta = bencode.decode(torrentBuf)
  infoBytes = NodeBuffer.from(bencode.encode(meta.info))
  const infoHash = crypto.createHash('sha1').update(infoBytes).digest('hex')
  pieceLength = meta.info['piece length']
  totalSize = files.reduce((s, f) => s + f.length, 0)
  numPieces = Math.ceil(totalSize / pieceLength)
  magnet = 'magnet:?xt=urn:btih:' + infoHash + '&dn=test-payload'
  console.log('[seed] 假做种者 infoHash:', infoHash, '| 元数据:', infoBytes.length, '| 数据:', totalSize)
}

const u32 = (n) => { const b = NodeBuffer.alloc(4); b.writeUInt32BE(n); return b }
const wrap = (body) => NodeBuffer.concat([u32(NodeBuffer.from(body).length), NodeBuffer.from(body)])
const sendBitfieldAndUnchoke = (sock) => {
  sock.write(wrap([1]))
  const bitfield = NodeBuffer.alloc(Math.ceil(numPieces / 8))
  for (let i = 0; i < numPieces; i++) bitfield[Math.floor(i / 8)] |= 0x80 >> (i % 8)
  sock.write(wrap(NodeBuffer.concat([NodeBuffer.from([5]), bitfield])))
}
const seeder = netnode.createServer((sock) => {
  if (REAL) { sock.destroy(); return }
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
        NodeBuffer.from('--FAKE0001-0123456789ab', 'latin1').copy(resp, 48)
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
          const METADATA_PIECE = 16384
          const start = req.piece * METADATA_PIECE
          const end = Math.min(infoBytes.length, start + METADATA_PIECE)
          const pieceData = infoBytes.subarray(start, end)
          const payload = bencode.encode({ msg_type: 1, piece: req.piece, total_size: infoBytes.length })
          const msgOut = wrap(NodeBuffer.concat([NodeBuffer.from([20, 1]), NodeBuffer.from(payload), pieceData]))
          for (let i = 0; i < msgOut.length; i += 1400) sock.write(msgOut.subarray(i, i + 1400))
        }
      } else if (id === 2) {
        sendBitfieldAndUnchoke(sock)
      } else if (id === 6 && msg.length >= 13) {
        const idx = msg.readUInt32BE(1)
        const begin = msg.readUInt32BE(5)
        const length = msg.readUInt32BE(9)
        const content = NodeBuffer.concat(files)
        const piece = content.subarray(idx * pieceLength + begin, idx * pieceLength + begin + length)
        sock.write(wrap(NodeBuffer.concat([NodeBuffer.from([7]), u32(idx), u32(begin), piece])))
      }
    }
  })
})
let seederPort = 0
if (!REAL) {
  await new Promise((r) => seeder.listen(0, '127.0.0.1', r))
  seederPort = seeder.address().port
  console.log('[seed] 做种者监听:', seederPort)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
if (FORCE_POLYFILL) {
  // 在页面脚本执行前删掉原生 createWritable，强制 bundle 安装降级 polyfill
  await page.addInitScript(() => {
    try {
      delete FileSystemFileHandle.prototype.createWritable
    } catch (e) { /* 忽略 */ }
  })
  console.log('[seed] 已强制 polyfill 路径')
}
const logs = []
page.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()))
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message))
await page.goto(`http://127.0.0.1:${PORT}/p2p/index.html?probe=1`, { waitUntil: 'networkidle' })
for (let i = 0; i < 40 && !(await page.evaluate(() => typeof window.WebTorrentWasmnet === 'function')); i++) {
  await new Promise((r) => setTimeout(r, 500))
}

const result = await page.evaluate(async ({ magnet, seederPort, realPeers, NO_DHT }) => {
  const clientOpts = NO_DHT ? { dht: false, lsd: false } : {}
  const client = new window.WebTorrentWasmnet(clientOpts)
  const t = client.add(magnet, { store: window.WebTorrentWasmnet.MemoryChunkStore })
  window.__testTorrent = t
  window.__testResult = { wire: false, ready: false, done: false, downloaded: 0 }
  t.on('wire', (w, a) => { window.__testResult.wire = true; console.log('wire:', a) })
  t.on('ready', () => { window.__testResult.ready = true; t.files[0].select() })
  t.on('done', () => { window.__testResult.done = true })
  t.on('warning', (w) => console.log('warning:', w && w.message))
  await new Promise((r) => setTimeout(r, 1500))
  if (realPeers.length) for (const addr of realPeers.slice(0, 5)) t.addPeer(addr)
  else t.addPeer('127.0.0.1:' + seederPort)
  return 'started'
}, { magnet, seederPort, realPeers, NO_DHT })
console.log('browser 内已开始:', result)

for (let i = 0; i < 45; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const st = await page.evaluate(() => ({
    ...window.__testResult,
    downloaded: window.__testTorrent ? window.__testTorrent.downloaded : -1,
  }))
  if (st.done) { console.log('DONE at', i + 1, 's'); break }
}
const final = await page.evaluate(() => ({
  ...window.__testResult,
  downloaded: window.__testTorrent ? window.__testTorrent.downloaded : -1,
  numPeers: window.__testTorrent ? window.__testTorrent.numPeers : -1,
}))
console.log('=== 浏览器内结果 ===', JSON.stringify(final))
console.log('=== 关键日志 ===')
console.log(logs.filter((l) => /wire|metadata|ready|extended|warning/.test(l)).slice(-20).join('\n'))
if (!REAL) seeder.close()
await browser.close()
process.exit(final.ready && final.downloaded > 0 ? 0 : 1)
