// 发布前校验：保证「会被浏览器加载的东西」真的带着 fsa-chunk-store 兼容补丁
//
// 这个脚本的存在理由：补丁失效时的故障很难查——OPFS 写入抛
// "(intermediate value).write is not a function"，表现为下载/缓存莫名卡住，
// 而代码里看不出任何问题。所以每次发版前跑一次，失败就阻断发布。
//
// 用法：node scripts/verify-bundles.mjs
// 退出码 0 = 全部通过；1 = 有问题（不发布）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFsaPatched, FSA_PACKAGE } from '../p2p/fsa-patch-plugin.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const problems = []
const notes = []

function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

// ---------- 1. pnpm 声明式补丁是不是还在 ----------
const workspaceYaml = readIfExists(path.join(root, 'pnpm-workspace.yaml'))
const patchFile = path.join(root, 'patches', `${FSA_PACKAGE}@1.3.0.patch`)
if (!fs.existsSync(patchFile)) {
  problems.push('缺少 patches/' + FSA_PACKAGE + '@1.3.0.patch（pnpm 补丁文件）')
} else {
  const patch = fs.readFileSync(patchFile, 'utf8')
  if (!patch.includes('file.stream.then')) {
    problems.push(patchFile + ' 里找不到 file.stream 守卫，补丁内容可能被改坏')
  }
}
if (!workspaceYaml || !/patchedDependencies:/.test(workspaceYaml) || !workspaceYaml.includes(FSA_PACKAGE)) {
  problems.push('pnpm-workspace.yaml 里缺少 patchedDependencies 的 ' + FSA_PACKAGE + ' 条目')
}

// ---------- 2. 本地 node_modules 里的包（如果装了）是不是补丁态 ----------
const storeDir = path.join(root, 'node_modules', '.pnpm')
if (fs.existsSync(storeDir)) {
  let checked = 0
  for (const entry of fs.readdirSync(storeDir)) {
    if (!entry.startsWith(FSA_PACKAGE + '@')) continue
    const file = path.join(storeDir, entry, 'node_modules', FSA_PACKAGE, 'index.js')
    if (!fs.existsSync(file)) continue
    checked++
    if (!isFsaPatched(fs.readFileSync(file, 'utf8'))) {
      problems.push('node_modules 里的 ' + entry + ' 未打补丁（跑一下 pnpm install 或 node scripts/ensure-fsa-patch.mjs）')
    }
  }
  if (!checked) notes.push('node_modules 里没找到 ' + FSA_PACKAGE + '（未安装依赖也能校验产物）')
}

// ---------- 3. 两个浏览器 bundle 是不是带着补丁 ----------
const bundles = [
  {
    file: path.join(root, 'p2p', 'vendor', 'webtorrent.iife.min.js'),
    // WebRTC 版：只走 WebRTC，不应包含中继相关代码
    mustContain: ['window.WebTorrent', 'MemoryChunkStore'],
    mustNotContain: ['/api/fetch'],
  },
  {
    file: path.join(root, 'p2p', 'vendor', 'webtorrent-wasmnet.iife.min.js'),
    mustContain: ['window.WebTorrentWasmnet', 'MemoryChunkStore', '/api/fetch'],
    mustNotContain: [],
  },
]

for (const { file, mustContain, mustNotContain } of bundles) {
  const name = path.relative(root, file)
  const code = readIfExists(file)
  if (code == null) {
    problems.push('缺少产物 ' + name + '（跑 pnpm build:frontend）')
    continue
  }
  // bundle 是压缩过的，变量名会被改写；这里查的是补丁留下的结构性特征
  if (!/typeof\s+[A-Za-z_$][\w$]*\.stream\.then/.test(code)) {
    problems.push(name + ' 里没有 fsa-chunk-store 守卫（typeof X.stream.then），补丁没进产物')
  }
  if (!/await\(await\s+[A-Za-z_$][\w$]*\.stream\)\.write/.test(code)) {
    problems.push(name + ' 里没有 await(await X.stream).write，写入前未 await 流')
  }
  for (const need of mustContain) {
    if (!code.includes(need)) problems.push(name + ' 里缺少 ' + need)
  }
  for (const bad of mustNotContain) {
    if (code.includes(bad)) problems.push(name + ' 里出现了不该有的 ' + bad + '（可能被另一个构建覆盖了）')
  }
}

// ---------- 输出 ----------
for (const n of notes) console.log('[verify] 提示：' + n)
if (problems.length) {
  console.error('\n[verify] 校验失败：')
  for (const p of problems) console.error('  - ' + p)
  console.error('\n不要发布；先修好再打包。\n')
  process.exit(1)
}
console.log('[verify] 通过：' + FSA_PACKAGE + ' 补丁在声明、安装与两个产物里都存在')
