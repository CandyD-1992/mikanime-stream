// 完整链路测试：加载真实 wasmnet 打包产物，连接本地假 BT 做种者，
// 验证 TCP 建连 -> BT 握手 -> wire 事件是否打通。
// 用法：node scripts/test-wire.mjs --port 3010

import fs from 'node:fs'
import netnode from 'node:net'
import { Buffer as NodeBuffer } from 'node:buffer'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { searchMikan } from '../lib/mikan.js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const portIdx = process.argv.indexOf('--port')
const PORT = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 3010

// 1) 假 BT 做种者：回应握手 + keep-alive
const items = await searchMikan('葬送的芙莉莲')
const magnet = items[0].magnet
const hashHex = /btih:([0-9a-f]{40})/i.exec(magnet)[1]
const infoHash = NodeBuffer.from(hashHex, 'hex')

let handshakeSeen = false
const fakeSeeder = netnode.createServer((sock) => {
  let buf = NodeBuffer.alloc(0)
  let replied = false
  sock.on('data', (d) => {
    buf = NodeBuffer.concat([buf, d])
    if (!replied && buf.length >= 68) {
      const hs = buf.subarray(0, 68)
      const theirHash = hs.subarray(28, 48)
      const same = NodeBuffer.from(theirHash).equals(infoHash)
      const resp = NodeBuffer.alloc(68)
      resp[0] = 19
      resp.write('BitTorrent protocol', 1)
      resp.writeUInt32BE(0x00000010, 24)
      infoHash.copy(resp, 28)
      NodeBuffer.from('--FAKE0001-0123456789ab', 'latin1').copy(resp, 48)
      sock.write(resp)
      sock.write(NodeBuffer.alloc(4)) // keep-alive
      replied = true
      handshakeSeen = true
      console.log('[fake] 收到握手，info_hash 匹配:', same)
    }
  })
})
await new Promise((r) => fakeSeeder.listen(0, '127.0.0.1', r))
const fakePort = fakeSeeder.address().port
console.log('[fake] 假做种者监听:', fakePort)

// 2) 浏览器环境模拟 + 加载真实 wasmnet 打包产物
globalThis.window = globalThis
globalThis.self = globalThis
globalThis.location = { protocol: 'http:', host: `127.0.0.1:${PORT}`, port: String(PORT), search: '' }
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'wire-test' }, configurable: true })

const bundlePath = path.join(root, 'p2p', 'vendor', 'webtorrent-wasmnet.iife.min.js')
vm.runInThisContext(fs.readFileSync(bundlePath, 'utf8'), { filename: bundlePath })

const client = new globalThis.WebTorrentWasmnet({ torrentPort: 0 })
const t = client.add(magnet)
const events = []
t.on('wire', (wire, addr) => {
  events.push('wire:' + addr)
  console.log('[browser-bundle] WIRE 触发:', addr)
  wire.on('handshake', (infoHash, peerId) => console.log('[browser-bundle] 握手完成 peerId=', peerId.toString('hex').slice(0, 12)))
})
t.on('ready', () => { events.push('ready'); console.log('[browser-bundle] torrent READY') })
t.on('warning', (w) => console.log('[browser-bundle] warning:', w && w.message))
t.on('error', (e) => console.log('[browser-bundle] error:', e && e.message))
t.on('noPeers', () => console.log('[browser-bundle] noPeers'))

// 3) 手动加入假做种者
await new Promise((r) => setTimeout(r, 2000))
console.log('[test] addPeer 127.0.0.1:' + fakePort)
t.addPeer('127.0.0.1:' + fakePort)

await new Promise((r) => setTimeout(r, 20000))

console.log('---')
console.log('握手被假做种者收到:', handshakeSeen)
console.log('wire 事件:', events.filter((e) => e.startsWith('wire')).length)
console.log('ready:', events.includes('ready'))
fakeSeeder.close()
client.destroy(() => {})
process.exit(handshakeSeen && events.some((e) => e.startsWith('wire')) ? 0 : 1)
