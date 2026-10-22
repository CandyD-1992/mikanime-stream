// fsa-chunk-store 兼容补丁（单一来源）
//
// 背景（README「已知坑」记录过的问题）：
//   fsa-chunk-store@1.3.0 的 _put() 会缓存 `file.stream` 供后续 chunk 复用。
//   如果缓存值不是 thenable，`await file.stream` 会原样返回该值，紧接着的
//   `.write(...)` 就抛 "(intermediate value).write is not a function"，
//   表现是 OPFS 写入（存入网页缓存）失败。
//
// 补丁有三个入口，全部复用本文件的 FSA_PATCHES，避免各处手改漏改：
//   1. pnpm 声明式补丁：patches/fsa-chunk-store@1.3.0.patch
//      （记录在 pnpm-workspace.yaml 的 patchedDependencies，重装自动生效）
//   2. scripts/ensure-fsa-patch.mjs：postinstall 兜底，非 pnpm 安装也能修好
//   3. 打包期 onLoad 插件：p2p/build-webrtc.mjs / p2p/build-wasmnet.mjs
//      直接改写入 bundle 的源码，保证产物在任何安装状态下都是安全的
//
// 所有替换都是幂等的：已打过补丁的源码不会被重复修改。

export const FSA_PACKAGE = 'fsa-chunk-store'

/** 替换表：find 必须是全局正则，replace 为替换文本 */
export const FSA_PATCHES = [
  {
    id: 'stream-thenable-guard',
    find: /if \(!file\.stream\) \{/g,
    replace: "if (!file.stream || typeof file.stream.then !== 'function') {",
  },
  {
    // 兜底：写入前必须 await 出真正的 writable 流
    id: 'await-stream-before-write',
    find: /await file\.stream\.write/g,
    replace: 'await (await file.stream).write',
  },
]

/** 判断源码是否已经带上关键补丁 */
export function isFsaPatched(code) {
  return code.includes('typeof file.stream.then') || code.includes('await (await file.stream).write')
}

/**
 * 对源码应用全部补丁。
 * @param {string} code
 * @returns {{ code: string, applied: string[] }}
 */
export function applyFsaPatches(code) {
  const applied = []
  let out = code
  for (const patch of FSA_PATCHES) {
    if (patch.find.test(out)) {
      out = out.replace(patch.find, patch.replace)
      applied.push(patch.id)
    }
  }
  return { code: out, applied }
}

/**
 * esbuild 插件：在打包时强制补丁，不依赖 node_modules 是否被改过。
 * @returns {import('esbuild').Plugin}
 */
export function fsaPatchPlugin() {
  return {
    name: 'fsa-chunk-store-patch',
    setup(build) {
      build.onLoad({ filter: /fsa-chunk-store[\\/]index\.js$/ }, async (args) => {
        const fs = await import('node:fs/promises')
        const original = await fs.readFile(args.path, 'utf8')
        const { code, applied } = applyFsaPatches(original)
        if (applied.length) {
          console.log(`  [fsa-patch] ${args.path} <- ${applied.join(', ')}`)
        }
        return { contents: code, loader: 'js' }
      })
    },
  }
}
