// 真实做种者调试测试：加载 wasmnet 打包产物，连接真实做种者，
// 包住 wire.emit 捕获所有扩展消息，定位元数据响应去向。
// 用法：先启动 server，再 node scripts/test-real-peer.mjs --port 3010

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { searchMikan } from '../lib/mikan.js'
import bencode from '../node_modules/.pnpm/bencode@4.0.1/node_modules/bencode/index.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const portIdx = process.argv.indexOf('--port')
const PORT = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 3010

// 从可达 tracker 拿真实做种者
const items = await searchMikan('葬送的芙莉莲')
const magnet = items[0].magnet
const hashHex = /btih:([0-9a-f]{40})/i.exec(magnet)[1]
const infoHash = Buffer.from(hashHex, 'hex')
const peerId = Buffer.from('-MK0001-0123456789ab', 'latin1')
const binEnc = (buf) => [...buf].map((b) => '%' + b.toString(16).padStart(2, '0')).join('')
const q = 'info_hash=' + binEnc(infoHash) + '&peer_id=' + binEnc(peerId) + '&port=6881&uploaded=0&downloaded=0&left=104857600&compact=1&event=started&numwant=50&key=12345678'
const cfg = await (await fetch(`http://127.0.0.1:${PORT}/api/config`)).json()
const r = await fetch(`http://127.0.0.1:${PORT}/api/fetch?token=` + cfg.wasmnet.token + '&url=' + encodeURIComponent('http://tracker.renfei.net:8080/announce?' + q))
const meta = bencode.decode(Buffer.from(await r.arrayBuffer()))
const p = meta['peers']
const peers = []
if (Array.isArray(p)) peers.push(...p.map((x) => Buffer.from(x.ip).join('.') + ':' + (x.port || 0)))
else if (p && p.length) { for (let i = 0; i + 6 <= p.length; i += 6) peers.push(p[i] + '.' + p[i+1] + '.' + p[i+2] + '.' + p[i+3] + ':' + ((p[i+4] << 8) | p[i+5])) }
console.log('[test] 真实做种者:', peers.slice(0, 6).join(' '))

globalThis.window = globalThis
globalThis.self = globalThis
globalThis.location = { protocol: 'http:', host: `127.0.0.1:${PORT}`, port: String(PORT), search: '' }
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'real-peer-test' }, configurable: true })

const bundlePath = path.join(root, 'p2p', 'vendor', 'webtorrent-wasmnet.iife.min.js')
vm.runInThisContext(fs.readFileSync(bundlePath, 'utf8'), { filename: bundlePath })

const client = new globalThis.WebTorrentWasmnet({ dht: false, lsd: false })
const t = client.add(magnet, { store: globalThis.WebTorrentWasmnet.MemoryChunkStore })

t.on('wire', (wire, addr) => {
  console.log('[test] wire:', addr)
  // 包住 emit，捕获所有 extended 事件（无论监听器注册时机）
  const origEmit = wire.emit.bind(wire)
  wire.emit = (ev, ...args) => {
    if (ev === 'extended') {
      const buf = args[1]
      console.log('[test] EMIT extended name=' + args[0] + ' len=' + (buf && buf.length ? buf.length : 0) +
        ' head=' + (buf && buf.length ? Buffer.from(buf).subarray(0, 8).toString('hex') : ''))
    }
    return origEmit(ev, ...args)
  }
  if (wire.ut_metadata) {
    wire.ut_metadata.on('warning', (e) => console.warn('[test] ut_metadata warning:', e && e.message))
    wire.ut_metadata.on('metadata', () => console.log('[test] metadata received!'))
  }
})
t.on('ready', () => console.log('[test] torrent READY'))
t.on('warning', (w) => console.log('[test] warning:', w && w.message))

await new Promise((r) => setTimeout(r, 2000))
for (const addr of peers.slice(0, 4)) t.addPeer(addr)
console.log('[test] 已加入 4 个真实做种者')

await new Promise((r) => setTimeout(r, 30000))
console.log('[test] 结束，numPeers=' + t.numPeers)
client.destroy(() => {})
process.exit(t.ready ? 0 : 1)
