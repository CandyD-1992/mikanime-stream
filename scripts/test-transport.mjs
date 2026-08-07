// 传输层自测：按浏览器打包方式（stream-browserify 等垫片）构建 wasmnet 垫片，
// 在 Node 里通过中继连接本地 TCP 回显服务，验证数据双向流动。
// 用法：先启动 server（任意端口），再 node scripts/test-transport.mjs --port 3010

import { build } from 'esbuild'
import fs from 'node:fs'
import netnode from 'node:net'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const portIdx = process.argv.indexOf('--port')
const PORT = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 3010
const outfile = path.join(root, '.debug', 'transport-bundle.js')
fs.mkdirSync(path.dirname(outfile), { recursive: true })

// 与生产 bundle 相同的垫片配置
await build({
  stdin: {
    contents: "import net from './p2p/wasmnet-net.js'; globalThis.__testNet = net;",
    resolveDir: root,
    sourcefile: 'transport-entry.js',
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: false,
  target: ['es2020'],
  outfile,
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  inject: [path.join(root, 'p2p', 'process-shim.js')],
  alias: {
    'cross-fetch-ponyfill': path.join(root, 'p2p', 'fetch-proxy.js'),
    dns: path.join(root, 'p2p', 'wasmnet-dns.js'),
    events: 'events',
    path: 'path-browserify',
    stream: 'stream-browserify',
    buffer: 'buffer',
    util: 'util',
    timers: 'timers-browserify',
    url: 'url',
    querystring: 'querystring-es3',
    assert: 'assert',
    string_decoder: 'string_decoder',
    os: 'os-browserify',
    process: 'process/browser',
    crypto: 'crypto-browserify',
    streamx: path.join(root, 'node_modules', '.pnpm', 'streamx@2.22.1', 'node_modules', 'streamx', 'index.js'),
  },
  logLevel: 'silent',
})

// 浏览器环境模拟
globalThis.window = globalThis
globalThis.self = globalThis
globalThis.location = { protocol: 'http:', host: `127.0.0.1:${PORT}`, port: String(PORT), search: '' }
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'transport-test' }, configurable: true })

vm.runInThisContext(fs.readFileSync(outfile, 'utf8'), { filename: outfile })

const net = globalThis.__testNet

// 本地 TCP 回显
const echo = netnode.createServer((s) => s.pipe(s))
await new Promise((r) => echo.listen(0, '127.0.0.1', r))
const echoPort = echo.address().port

const result = await new Promise((resolve) => {
  const sock = net.connect({ host: '127.0.0.1', port: echoPort })
  let received = ''
  const timer = setTimeout(() => { try { sock.destroy() } catch {} resolve('FAIL: 回显超时') }, 15000)
  sock.on('connect', () => sock.write('transport-check-123'))
  sock.on('data', (d) => {
    received += d.toString()
    if (received.length >= 18) {
      clearTimeout(timer)
      try { sock.destroy() } catch {}
      resolve(received === 'transport-check-123' ? 'PASS: 数据双向流动正常' : 'FAIL: 回显内容不符 ' + received)
    }
  })
  sock.on('error', (e) => { clearTimeout(timer); try { sock.destroy() } catch {}; resolve('FAIL: ' + e.message) })
})

echo.close()
console.log('stream-browserify 传输测试:', result)
process.exit(result.startsWith('PASS') ? 0 : 1)
