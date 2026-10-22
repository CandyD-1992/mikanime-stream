// 构建 WebRTC 版浏览器 WebTorrent 包：
//   pnpm build:webrtc
//
// 产物 p2p/vendor/webtorrent.iife.min.js 是页面默认加载的那个包
// （p2p/index.html 的 WT_CDNS），只走 WebRTC（WebSocket tracker + PEX），
// 不含 wasmnet 中继垫片；需要连普通 BT 做种者时页面会改用
// p2p/vendor/webtorrent-wasmnet.iife.min.js（见 build-wasmnet.mjs）。
//
// 这个脚本此前缺失，产物只能靠手工构建，导致「bundle 里到底有没有
// fsa-chunk-store 补丁」无法复现、无法验证。现在两个 bundle 都由脚本
// 构建，并统一走 p2p/fsa-patch-plugin.mjs 的补丁逻辑。
//
// 用法：
//   node p2p/build-webrtc.mjs             # 写入 p2p/vendor/webtorrent.iife.min.js
//   node p2p/build-webrtc.mjs --out x.js  # 输出到别处（用于对比/校验）

import { build } from 'esbuild'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fsaPatchPlugin } from './fsa-patch-plugin.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)) // .../p2p
const root = path.dirname(here) // 项目根目录

// pnpm 严格模式：间接依赖不在根 node_modules，从 .pnpm 存储里按名字找。
// 给出 version 时精确匹配（store 里同名多版本时必须给，否则产物不可复现）。
function pnpmResolve(name, version) {
  const storeDir = path.join(root, 'node_modules', '.pnpm')
  const prefix = version ? `${name}@${version}` : `${name}@`
  const entry = fs
    .readdirSync(storeDir)
    .sort()
    .find((d) => (version ? d === prefix || d.startsWith(prefix + '_') : d.startsWith(prefix)))
  if (!entry) throw new Error('pnpm store entry not found: ' + prefix)
  const pkgDir = path.join(storeDir, entry, 'node_modules', name)
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const main =
    (pkg.exports && typeof pkg.exports === 'object' && pkg.exports.import) ||
    pkg.module ||
    pkg.main ||
    'index.js'
  return path.join(pkgDir, String(main))
}

const outIndex = process.argv.indexOf('--out')
const outfile =
  outIndex >= 0 && process.argv[outIndex + 1]
    ? path.resolve(process.argv[outIndex + 1])
    : path.join(here, 'vendor', 'webtorrent.iife.min.js')

await build({
  entryPoints: [path.join(here, 'entry.js')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: true,
  target: ['es2020'],
  outfile,
  define: {
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
  },
  inject: [path.join(here, 'process-shim.js')],
  // 与 wasmnet 版保持同一套 Node 核心模块垫片，差别只有：
  // 这里不接管 net/dgram（走 WebRTC），也不接管 dns 与 cross-fetch-ponyfill
  // （那两个是经服务器中继/代发用的，只有 wasmnet 版需要）。
  alias: {
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
    // 固定版本：store 里同时存在 2.22.1 与 2.28.0，
    // 不指定版本会随目录读取顺序变化，导致产物不可复现。
    // 2.22.1 是 webtorrent 实际链接的版本。
    streamx: pnpmResolve('streamx', '2.22.1'),
  },
  plugins: [fsaPatchPlugin()],
  logLevel: 'info',
})

console.log('WebRTC 版 WebTorrent 构建完成 -> ' + outfile)
