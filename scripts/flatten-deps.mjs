// 把生产依赖拍平成无符号链接的目录（供 Docker 离线构建用）
//   node scripts/flatten-deps.mjs
// 输出：vendor/node_modules/
//   - 每个包按 npm 经典嵌套布局放在各自父包下（版本冲突安全）
//   - 每个真实包同时提升一份到顶层（npm 的 hoisting 行为，作为兜底）

import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const outDir = path.join(root, 'vendor', 'node_modules')
const prodDeps = ['bencode', 'cheerio', 'express', 'ws', 'bittorrent-dht']

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

function resolveReal(p) {
  const st = fs.lstatSync(p)
  return st.isSymbolicLink() ? path.resolve(path.dirname(p), fs.readlinkSync(p)) : p
}

function copyDir(srcDir, destDir) {
  for (const entry of fs.readdirSync(srcDir)) {
    if (entry === 'node_modules' || entry === '.bin') continue
    const s = path.join(srcDir, entry)
    const d = path.join(destDir, entry)
    if (fs.lstatSync(s).isDirectory()) {
      fs.cpSync(s, d, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true })
      fs.copyFileSync(s, d)
    }
  }
}

// 枚举 pnpm 包父目录里的依赖：普通包是符号链接，scoped 包是 @scope 目录下的符号链接
function listPkgs(parent) {
  const out = []
  if (!fs.existsSync(parent)) return out
  for (const entry of fs.readdirSync(parent)) {
    if (entry === '.bin') continue
    const p = path.join(parent, entry)
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) {
      out.push({ name: entry, path: p })
    } else if (st.isDirectory() && entry.startsWith('@')) {
      for (const sub of fs.readdirSync(p)) {
        const sp = path.join(p, sub)
        try {
          if (fs.lstatSync(sp).isSymbolicLink()) {
            out.push({ name: entry + '/' + sub, path: sp })
          }
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return out
}

const pairs = new Set() // "real -> dest" 防止同一目标重复复制
const hoisted = new Set() // 每个真实包只提升一份到顶层
let total = 0

function copyPkg(pkgDir, destDir, depth = 0) {
  if (depth > 50) return
  const real = resolveReal(pkgDir)
  const pairKey = real + ' -> ' + destDir
  if (pairs.has(pairKey)) return
  pairs.add(pairKey)
  total++
  copyDir(real, destDir)

  // hoisting：把该包也放到顶层（scoped 包创建 @scope/name 目录）
  const relName = path.relative(path.dirname(pkgDir), pkgDir)
  const topDest = path.join(outDir, relName)
  if (!hoisted.has(real)) {
    hoisted.add(real)
    copyDir(real, topDest)
  }

  const parent = path.dirname(real)
  for (const dep of listPkgs(parent)) {
    if (resolveReal(dep.path) === real) continue
    copyPkg(dep.path, path.join(destDir, 'node_modules', dep.name), depth + 1)
  }
}

for (const name of prodDeps) {
  const pkgDir = path.join(root, 'node_modules', name)
  if (!fs.existsSync(pkgDir)) {
    console.warn('[warn] 缺少依赖包:', name)
    continue
  }
  copyPkg(pkgDir, path.join(outDir, name))
}

console.log('已拍平', total, '个生产依赖副本 ->', outDir)
