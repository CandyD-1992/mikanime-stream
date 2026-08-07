// 重新生成 Docker 自包含所需的所有 vendor 压缩包：
//   1. 拍平生产依赖 -> vendor/node_modules/
//   2. 依赖打包   -> vendor/deps.tar.gz
//   3. Node 运行时 -> vendor/node-amd64.tar.gz / vendor/node-arm64.tar.gz
// 依赖有更新时执行：node scripts/pack-vendor.mjs

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = process.cwd()

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status || 1)
}

console.log('[1/3] 拍平生产依赖...')
run(process.execPath, [path.join('scripts', 'flatten-deps.mjs')])

console.log('[2/3] 打包依赖 -> vendor/deps.tar.gz')
run('tar', ['-czf', path.join('vendor', 'deps.tar.gz'), '-C', path.join('vendor', 'node_modules'), '.'])

console.log('[3/3] 打包 Node 运行时 -> vendor/node-{amd64,arm64}.tar.gz')
run('tar', ['-czf', path.join('vendor', 'node-amd64.tar.gz'), '-C', path.join('vendor', 'node', 'linux-x64'), '.'])
run('tar', ['-czf', path.join('vendor', 'node-arm64.tar.gz'), '-C', path.join('vendor', 'node', 'linux-arm64'), '.'])

console.log('打包完成：vendor/deps.tar.gz + vendor/node-amd64.tar.gz + vendor/node-arm64.tar.gz')
