// 构建 wasmnet 版浏览器 WebTorrent 包：
//   pnpm build:wasmnet
//
// 默认的浏览器构建把 TCP 连接池、HTTP/UDP tracker 都关掉了（只能走 WebRTC）。
// 这里通过 esbuild 插件把这些模块重新启用，并把 net/dgram 指向 wasmnet
// 中继垫片，让浏览器端也能建立真实的 TCP/UDP 连接。

import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url)) // .../p2p
const root = path.dirname(here) // 项目根目录

// pnpm 严格模式：间接依赖不在根 node_modules，从 .pnpm 存储里按名字找
function pnpmResolve(name) {
  const storeDir = path.join(root, 'node_modules', '.pnpm')
  const entry = fs.readdirSync(storeDir).find((d) => d.startsWith(name + '@'))
  if (!entry) throw new Error('pnpm store entry not found: ' + name)
  const pkgDir = path.join(storeDir, entry, 'node_modules', name)
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const main =
    (pkg.exports && typeof pkg.exports === 'object' && pkg.exports.import) ||
    pkg.module ||
    pkg.main ||
    'index.js'
  return path.join(pkgDir, String(main))
}

const reenable = [
  // 匹配实际写在各包里的相对导入路径（./lib/...），绕开 browser 字段的禁用映射
  /\.\/lib\/conn-pool\.js$/,
  /\.\/common-node\.js$/, // common.js 在 lib/ 目录内，导入路径是 ./common-node.js
  /\.\/lib\/client\/http-tracker\.js$/,
  /\.\/lib\/client\/udp-tracker\.js$/,
]

const wasmnetPlugin = {
  name: 'wasmnet-tcp',
  setup(build) {
    // 把 net / dgram 直接指向 wasmnet 中继垫片。
    // 不能只用 --alias：webtorrent 的 browser 字段里 "net": false 会覆盖别名。
    build.onResolve({ filter: /^net$/ }, (args) => ({
      path: path.join(here, 'wasmnet-net.js'),
      namespace: 'file',
    }))
    build.onResolve({ filter: /^dgram$/ }, (args) => ({
      path: path.join(here, 'wasmnet-dgram.js'),
      namespace: 'file',
    }))
    // DHT / PEX 在浏览器构建里默认被禁用，这里重新启用（走 wasmnet 的 UDP 中继）
    build.onResolve({ filter: /^bittorrent-dht$/ }, (args) => ({
      path: pnpmResolve('bittorrent-dht'),
      namespace: 'file',
    }))
    build.onResolve({ filter: /^ut_pex$/ }, (args) => ({
      path: pnpmResolve('ut_pex'),
      namespace: 'file',
    }))

    for (const filter of reenable) {
      build.onResolve({ filter }, (args) => {
        // 绕开 package.json browser 字段里的 false（禁用）映射，直接解析真实文件
        return { path: path.resolve(path.dirname(args.importer), args.path), namespace: 'file' }
      })
    }
  },
}

// fsa-chunk-store 兼容补丁（README 里记录过的坑）：
// pnpm 重新安装会冲掉 node_modules 里的手改补丁，导致 OPFS 写入时
// 对 Promise 直接调用 .write 报 "(intermediate value).write is not a function"。
// 这里在打包时强制应用，保证任何安装状态下产物都是安全的。
const fsaChunkStorePatch = {
  name: 'fsa-chunk-store-patch',
  setup(build) {
    build.onLoad({ filter: /fsa-chunk-store[\\/]index\.js$/ }, async (args) => {
      let code = await fs.promises.readFile(args.path, 'utf8')
      // 1) file.stream 已是在途 Promise 时不再重复创建 writable 流
      code = code.replace(
        /if \(!file\.stream\) \{/g,
        "if (!file.stream || typeof file.stream.then !== 'function') {",
      )
      // 2) 兜底：写入前必须 await 流（防止任何版本退化）
      code = code.replace(/await file\.stream\.write/g, 'await (await file.stream).write')
      return { contents: code, loader: 'js' }
    })
  },
}

await build({
  entryPoints: [path.join(here, 'entry-wasmnet.js')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: true,
  target: ['es2020'],
  outfile: path.join(here, 'vendor', 'webtorrent-wasmnet.iife.min.js'),
  define: {
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
  },
  inject: [path.join(here, 'process-shim.js')],
  alias: {
    // HTTP tracker 的 fetch 走服务器代发，绕开浏览器 CORS
    'cross-fetch-ponyfill': path.join(here, 'fetch-proxy.js'),
    dns: path.join(here, 'wasmnet-dns.js'),
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
    streamx: pnpmResolve('streamx'),
  },
  plugins: [wasmnetPlugin, fsaChunkStorePatch],
  logLevel: 'info',
})

console.log('wasmnet 版 WebTorrent 构建完成 -> p2p/vendor/webtorrent-wasmnet.iife.min.js')
