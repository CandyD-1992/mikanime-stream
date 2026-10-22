// fsa-chunk-store 兼容补丁兜底（postinstall）
//
// 主机制是 pnpm 声明式补丁（pnpm-workspace.yaml 的 patchedDependencies +
// patches/fsa-chunk-store@1.3.0.patch），pnpm install 会自动应用。
// 但 README 也允许用 npm install，而 npm 不认识 pnpm 的 patchedDependencies，
// 所以这里做一次幂等兜底：发现包没打补丁就地补上，装完即可用。
//
// 打包产物另有 p2p/fsa-patch-plugin.mjs 在 esbuild 阶段强制补丁，
// 所以即使这里没生效，前端 bundle 也是安全的；这里保证的是
// node_modules 里的代码与仓库声明一致。
//
// 用法：pnpm install 后自动执行（package.json 的 postinstall）；
//       也可手动 node scripts/ensure-fsa-patch.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyFsaPatches, isFsaPatched, FSA_PACKAGE } from '../p2p/fsa-patch-plugin.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const storeDir = path.join(root, 'node_modules', '.pnpm')

function findInstalled() {
  if (!fs.existsSync(storeDir)) return []
  const found = []
  for (const entry of fs.readdirSync(storeDir)) {
    // 跳过 pnpm patch 的暂存目录（那里是待编辑副本，不是最终安装位置）
    if (!entry.startsWith(FSA_PACKAGE + '@')) continue
    const file = path.join(storeDir, entry, 'node_modules', FSA_PACKAGE, 'index.js')
    if (fs.existsSync(file)) found.push({ entry, file })
  }
  return found
}

const targets = findInstalled()
if (!targets.length) {
  // 生产安装（Docker 镜像只装 express/cheerio/ws/bencode）里没有这个包，属正常
  console.log('[fsa-patch] 未安装 ' + FSA_PACKAGE + '，跳过')
  process.exit(0)
}

let changed = 0
let already = 0
let unknown = 0
for (const { entry, file } of targets) {
  const code = fs.readFileSync(file, 'utf8')
  if (isFsaPatched(code)) {
    already++
    continue
  }
  const { code: patched, applied } = applyFsaPatches(code)
  if (!applied.length) {
    unknown++
    console.warn('[fsa-patch] !! ' + entry + ' 里没有找到预期的代码形态，补丁未应用')
    console.warn('           可能是依赖升级了：请核对 patches/' + FSA_PACKAGE + '@1.3.0.patch')
    continue
  }
  fs.writeFileSync(file, patched)
  changed++
  console.log('[fsa-patch] ' + entry + ' <- ' + applied.join(', '))
}

console.log(
  `[fsa-patch] 完成：新打补丁 ${changed} 个，已是补丁态 ${already} 个` +
    (unknown ? `，无法识别 ${unknown} 个` : ''),
)
// 兜底脚本不因为「包升级导致形态不认识」而中断安装，但会显著告警；
// 发布前的强校验在 scripts/verify-bundles.mjs。
process.exit(0)
