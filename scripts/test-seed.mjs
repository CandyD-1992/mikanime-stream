// 端到端下载测试（完全本地、不依赖外网）：
//   - 迷你 BT 做种者：真实元数据（ut_metadata）+ 数据分片，纯 Node 实现
//   - 浏览器 wasmnet 打包产物通过中继连接它
//   - 验证：TCP 建连 -> BT 握手 -> 扩展握手 -> ut_metadata -> 数据分片下载
// 用法：先启动 server（任意端口），再 node scripts/test-seed.mjs --port 3010

import crypto from 'node:crypto'
import fs from 'node:fs'
import netnode from 'node:net'
import { Buffer as NodeBuffer } from 'node:buffer'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import createTorrent from '../node_modules/.pnpm/create-torrent@6.1.3/node_modules/create-torrent/index.js'
import bencode from '../node_modules/.pnpm/bencode@4.0.1/node_modules/bencode/index.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const portIdx = process.argv.indexOf('--port')
const PORT = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 3010

// ---------- 1) 构造真实元数据（多文件，info 约 60KB，模拟真实种子） ----------
const files = Array.from({ length: 900 }, (_, i) =>
  NodeBuffer.from('file-' + i + ' content payload. ' + i, 'utf8'))
const torrentBuf = await new Promise((resolve, reject) => {
  createTorrent(files, { name: 'test-payload' }, (err, buf) => (err ? reject(err) : resolve(buf)))
})
const meta = bencode.decode(torrentBuf)
const infoBytes = NodeBuffer.from(bencode.encode(meta.info))
const infoHash = crypto.createHash('sha1').update(infoBytes).digest('hex')
const pieceLength = meta.info['piece length']
const totalSize = files.reduce((s, f) => s + f.length, 0)
const numPieces = Math.ceil(totalSize / pieceLength)
console.log('[seed] infoHash:', infoHash, '| 元数据:', infoBytes.length, '字节 | 数据:', totalSize, '字节')

// ---------- 2) 迷你 BT 做种者 ----------
const u32 = (n) => {
  const b = NodeBuffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
const wrap = (body) => {
  const b = NodeBuffer.from(body)
  return NodeBuffer.concat([u32(b.length), b])
}
const sendBitfieldAndUnchoke = (sock) => {
  sock.write(wrap([1])) // unchoke
  const bitfield = NodeBuffer.alloc(Math.ceil(numPieces / 8))
  for (let i = 0; i < numPieces; i++) bitfield[Math.floor(i / 8)] |= 0x80 >> (i % 8)
  sock.write(wrap(NodeBuffer.concat([NodeBuffer.from([5]), bitfield])))
}

let handshakeCount = 0
const seeder = netnode.createServer((sock) => {
  let buf = NodeBuffer.alloc(0)
  let handshaked = false
  sock.on('data', (d) => {
    buf = NodeBuffer.concat([buf, d])
    for (;;) {
      if (!handshaked) {
        if (buf.length < 68) return
        const hs = buf.subarray(0, 68)
        handshaked = true
        handshakeCount++
        // 回复握手（带扩展协议位）
        const resp = NodeBuffer.alloc(68)
        resp[0] = 19
        resp.write('BitTorrent protocol', 1)
        resp[25] |= 0x10 // 保留字节第 6 字节的 0x10 = 支持扩展消息（BEP 10）
        hs.subarray(28, 48).copy(resp, 28)
        NodeBuffer.from('--FAKE0001-0123456789ab', 'latin1').copy(resp, 48)
        sock.write(resp)
        // 发送扩展握手：m { ut_metadata: 1 }
        const extPayload = NodeBuffer.from(bencode.encode({ m: { ut_metadata: 1 }, metadata_size: infoBytes.length }))
        sock.write(wrap(NodeBuffer.concat([NodeBuffer.from([20, 0]), extPayload])))
        sendBitfieldAndUnchoke(sock) // 主动宣告自己是全量做种者
        buf = buf.subarray(68)
        continue
      }
      if (buf.length < 4) return
      const len = buf.readUInt32BE(0)
      if (buf.length < 4 + len) return
      const msg = buf.subarray(4, 4 + len)
      buf = buf.subarray(4 + len)
      console.log('[seeder] 收到消息 id=' + (msg.length ? msg[0] : 'keepalive') + ' len=' + msg.length + ' hex=' + msg.subarray(0, 8).toString('hex'))
      handle(msg)
    }
  })

  function handle(msg) {
    if (msg.length === 0) return // keep-alive
    const id = msg[0]
    if (id === 20 && msg.length >= 2) {
      const extId = msg[1]
      if (extId === 1) {
        // ut_metadata 请求
        const req = bencode.decode(msg.subarray(2))
        console.log('[seeder] ut_metadata 请求:', JSON.stringify(req))
        if (req.msg_type === 0) {
          const METADATA_PIECE = 16384
          const numMetaPieces = Math.ceil(infoBytes.length / METADATA_PIECE)
          // 模拟真实做种者：收到请求后一次性把全部分片发出去
          for (let p = 0; p < numMetaPieces; p++) {
            const start = p * METADATA_PIECE
            const end = Math.min(infoBytes.length, start + METADATA_PIECE)
            const pieceData = infoBytes.subarray(start, end)
            const payload = bencode.encode({ msg_type: 1, piece: p, total_size: infoBytes.length })
            console.log('[seeder] 突发回复元数据分片', p, '长度', pieceData.length)
            const msg = wrap(NodeBuffer.concat([NodeBuffer.from([20, 1]), NodeBuffer.from(payload), pieceData]))
            // 模拟真实 TCP：拆成 1400 字节小片逐个发送
            for (let i = 0; i < msg.length; i += 1400) {
              sock.write(msg.subarray(i, i + 1400))
            }
          }
        }
      }
    } else if (id === 2) {
      // interested -> unchoke + bitfield（全部分片都有）
      sendBitfieldAndUnchoke(sock)
    } else if (id === 6 && msg.length >= 13) {
      // request(id=6) -> piece(id=7)
      const idx = msg.readUInt32BE(1)
      const begin = msg.readUInt32BE(5)
      const length = msg.readUInt32BE(9)
      const content = NodeBuffer.concat(files)
      const piece = content.subarray(idx * pieceLength + begin, idx * pieceLength + begin + length)
      sock.write(wrap(NodeBuffer.concat([NodeBuffer.from([7]), u32(idx), u32(begin), piece])))
    }
  }
})
await new Promise((r) => seeder.listen(0, '127.0.0.1', r))
const seederPort = seeder.address().port
console.log('[seed] 迷你做种者监听:', seederPort)

// ---------- 3) 浏览器环境模拟 + 加载真实打包产物 ----------
globalThis.window = globalThis
globalThis.self = globalThis
globalThis.location = { protocol: 'http:', host: `127.0.0.1:${PORT}`, port: String(PORT), search: '' }
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'seed-test' }, configurable: true })

const bundlePath = path.join(root, 'p2p', 'vendor', 'webtorrent-wasmnet.iife.min.js')
vm.runInThisContext(fs.readFileSync(bundlePath, 'utf8'), { filename: bundlePath })

const client = new globalThis.WebTorrentWasmnet({ dht: false, lsd: false })
const magnet = 'magnet:?xt=urn:btih:' + infoHash + '&dn=test-payload.bin'
const t = client.add(magnet, { store: globalThis.WebTorrentWasmnet.MemoryChunkStore })

const events = []
t.on('wire', (wire, addr) => { events.push('wire'); console.log('[bundle] wire 触发:', addr) })
t.on('ready', () => {
  events.push('ready')
  console.log('[bundle] torrent READY，文件:', t.files.map((f) => f.name).join(','))
  t.files[0].select() // 选择文件开始下载
})
t.on('done', () => { events.push('done'); console.log('[bundle] torrent DONE，下载:', t.downloaded, 'bytes') })
t.on('warning', (w) => console.log('[bundle] warning:', w && w.message))
t.on('error', (e) => console.log('[bundle] error:', e && e.message))

await new Promise((r) => setTimeout(r, 2000))
t.addPeer('127.0.0.1:' + seederPort)
console.log('[test] 已加入种子源 127.0.0.1:' + seederPort)

for (let i = 0; i < 30 && !events.includes('ready'); i++) await new Promise((r) => setTimeout(r, 1000))
if (events.includes('ready')) {
  for (let i = 0; i < 20 && !events.includes('done') && t.downloaded < content.length; i++) {
    await new Promise((r) => setTimeout(r, 1000))
  }
}

console.log('---')
console.log('握手次数:', handshakeCount, '| wire:', events.includes('wire'), '| ready:', events.includes('ready'), '| done:', events.includes('done'))
console.log('downloaded:', t.downloaded, '/', content.length, '| speed:', Math.round(t.downloadSpeed / 1024) + ' KB/s')
seeder.close()
client.destroy(() => {})
process.exit(events.includes('ready') && t.downloaded > 0 ? 0 : 1)
