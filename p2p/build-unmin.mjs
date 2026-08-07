import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
await build({
  stdin: { contents: "import WebTorrent from 'webtorrent'; console.log(WebTorrent)", resolveDir: root, sourcefile: 'x.js' },
  bundle: true, platform: 'browser', format: 'iife', minify: false,
  outfile: path.join(root, '.debug', 'bundle-unmin.js'),
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  inject: [path.join(here, 'process-shim.js')],
  alias: {
    'cross-fetch-ponyfill': path.join(here, 'fetch-proxy.js'),
    dns: path.join(here, 'wasmnet-dns.js'),
    events: 'events', path: 'path-browserify', stream: 'stream-browserify', buffer: 'buffer',
    util: 'util', timers: 'timers-browserify', url: 'url', querystring: 'querystring-es3',
    assert: 'assert', string_decoder: 'string_decoder', os: 'os-browserify',
    process: 'process/browser', crypto: 'crypto-browserify',
    streamx: path.join(root, 'node_modules', '.pnpm', 'streamx@2.22.1', 'node_modules', 'streamx', 'index.js'),
  },
  logLevel: 'silent',
})
console.log('built')
