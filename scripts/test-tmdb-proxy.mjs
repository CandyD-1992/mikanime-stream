// TMDB 代理链路测试：
//   1. 启动本地 server（可指定 TMDB_API_BASE / TMDB_API_KEY 环境变量）
//   2. 验证 /api/tmdb/search 的：镜像可达性、base 参数覆盖、错误详情
// 用法: node scripts/test-tmdb-proxy.mjs [--base https://api.themoviedb.org/3] [--key xxx] [--port 3100]
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const getArg = (name, def) => {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def
}
const PORT = Number(getArg('--port', '3100'))
const BASE = getArg('--base', 'https://api.themoviedb.org/3')
const KEY = getArg('--key', '')

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT), TMDB_API_BASE: BASE, ...(KEY ? { TMDB_API_KEY: KEY } : {}) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let out = ''
server.stdout.on('data', (d) => { out += d })
server.stderr.on('data', (d) => { out += d })

async function waitHealth() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`)
      if (r.ok) return
    } catch (e) { /* 等待 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('服务器启动失败：\n' + out.slice(-2000))
}

async function call(pathname) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`)
  const j = await r.json().catch(() => null)
  return { status: r.status, body: j }
}

try {
  await waitHealth()
  const cfg = await (await fetch(`http://127.0.0.1:${PORT}/api/config`)).json()
  const tok = encodeURIComponent((cfg.wasmnet && cfg.wasmnet.token) || '')

  console.log('[tmdb-proxy] 服务器已启动 | TMDB_API_BASE =', BASE)

  // 1) 镜像可达性：无有效 Key 时应透传 TMDB 的 401；给了真实 Key 则应返回 200 搜索结果
  const r1 = await call(`/api/tmdb/search?q=test&token=${tok}&key=INVALID_KEY`)
  console.log('[1] 镜像转发 ->', r1.status, JSON.stringify(r1.body))
  const ok1 = KEY
    ? r1.status === 200 && Array.isArray(r1.body.results)
    : r1.status === 401 && /invalid api key/i.test(JSON.stringify(r1.body || ''))

  // 2) base 参数覆盖（等价于页面设置里的“TMDB API 地址”）：指向不可达地址时，
  //    应自动换官方/备用镜像并返回有效响应（不再是死 502）
  const r2 = await call(`/api/tmdb/search?q=test&token=${tok}&key=INVALID_KEY&base=http://127.0.0.1:1`)
  console.log('[2] base 覆盖(不可达，自动兜底) ->', r2.status, JSON.stringify(r2.body))
  const ok2 = KEY
    ? r2.status === 200 && Array.isArray(r2.body.results)
    : r2.status === 401 && /invalid api key/i.test(JSON.stringify(r2.body || ''))

  // 3) base 参数覆盖为合法镜像（页面设置里填这个地址也应可用）
  // 3) 真实 Key + base 参数覆盖（等价于页面设置里填镜像地址），应返回 200 和搜索结果
  const r3 = await call(
    `/api/tmdb/search?q=${encodeURIComponent('无职转生')}&token=${tok}&key=${KEY || 'INVALID_KEY'}&base=${encodeURIComponent(BASE)}`,
  )
  console.log('[3] 真实 Key + base 覆盖(镜像) ->', r3.status, 'results:', r3.body && r3.body.results ? r3.body.results.length : JSON.stringify(r3.body))
  const ok3 = KEY
    ? r3.status === 200 && Array.isArray(r3.body.results) && r3.body.results.length > 0
    : r3.status === 401 && /invalid api key/i.test(JSON.stringify(r3.body || ''))

  console.log('=== 结果:', ok1 && ok2 && ok3 ? '全部通过' : '存在问题', '===')
  process.exit(ok1 && ok2 && ok3 ? 0 : 1)
} catch (err) {
  console.error('[tmdb-proxy] 失败:', err.message)
  process.exit(1)
} finally {
  server.kill()
}
