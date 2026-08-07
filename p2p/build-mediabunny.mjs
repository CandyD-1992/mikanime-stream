// 构建 Mediabunny 浏览器包（MKV -> fMP4 无损封装用到）：
//   node p2p/build-mediabunny.mjs
// 产物: p2p/vendor/mediabunny.iife.min.js（全局 Mediabunny）
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

function pnpmResolve(name) {
  const storeDir = path.join(root, 'node_modules', '.pnpm')
  const entry = fs.readdirSync(storeDir).find((d) => d.startsWith(name + '@'))
  if (!entry) throw new Error('pnpm store entry not found: ' + name)
  return path.join(storeDir, entry, 'node_modules', name)
}

const mbDir = pnpmResolve('mediabunny')
const src = (m) => path.join(mbDir, 'dist', 'modules', 'src', m)

await build({
  stdin: {
    // 只引入需要的模块，避免把编码器/WebCodecs 等无关代码打进包
    contents: `
      export { Input } from '${src('input.js').replaceAll('\\', '/')}'
      export { Output } from '${src('output.js').replaceAll('\\', '/')}'
      export { Conversion } from '${src('conversion.js').replaceAll('\\', '/')}'
      export { MATROSKA } from '${src('input-format.js').replaceAll('\\', '/')}'
      export { Mp4OutputFormat } from '${src('output-format.js').replaceAll('\\', '/')}'
      export { NullTarget } from '${src('target.js').replaceAll('\\', '/')}'
      export { CustomSource } from '${src('source.js').replaceAll('\\', '/')}'
    `,
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  globalName: 'Mediabunny',
  minify: true,
  target: ['es2021'],
  platform: 'browser',
  outfile: path.join(here, 'vendor', 'mediabunny.iife.min.js'),
  logLevel: 'info',
})

console.log('Mediabunny 浏览器包构建完成 -> p2p/vendor/mediabunny.iife.min.js')
