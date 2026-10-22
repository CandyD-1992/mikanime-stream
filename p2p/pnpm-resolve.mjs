// pnpm 严格安装下的依赖解析工具（打包脚本共用）
//
// pnpm 把间接依赖放在 node_modules/.pnpm/<name>@<version>/node_modules/<name>，
// 根目录不提升，所以打包脚本要按名字去 .pnpm 里找真实路径。
//
// 注意：同名多版本时不能只按前缀取第一个——目录顺序变了产物就会跟着变，
// 导致 bundle 不可复现（streamx 在本仓库就同时存在 2.22.1 与 2.28.0）。
// 因此这里要求显式传 version，或者由调用方确认只有唯一版本。

import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {string} root 项目根目录
 * @param {string} name 包名
 * @param {string} [version] 精确版本；不传且存在多个版本时会抛错
 * @returns {string} 包的入口文件绝对路径
 */
export function pnpmResolve(root, name, version) {
  const storeDir = path.join(root, 'node_modules', '.pnpm')
  const entries = fs.readdirSync(storeDir).sort()
  let candidates = entries.filter((d) => d === `${name}@${version}` || d.startsWith(`${name}@${version}_`))
  if (!version) {
    candidates = entries.filter((d) => d === name || d.startsWith(`${name}@`))
  }
  if (!candidates.length) {
    throw new Error(`pnpm store entry not found: ${name}${version ? '@' + version : ''}`)
  }
  if (!version && candidates.length > 1) {
    throw new Error(
      `pnpm store 里有多个 ${name} 版本（${candidates.join(', ')}），` +
        `请在打包脚本里显式指定版本，否则产物不可复现`,
    )
  }
  const pkgDir = path.join(storeDir, candidates[0], 'node_modules', name)
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const main =
    (pkg.exports && typeof pkg.exports === 'object' && pkg.exports.import) ||
    pkg.module ||
    pkg.main ||
    'index.js'
  return path.join(pkgDir, String(main))
}

/** webtorrent 实际链接的 streamx 版本（写死以免随目录顺序漂移） */
export const STREAMX_VERSION = '2.22.1'
