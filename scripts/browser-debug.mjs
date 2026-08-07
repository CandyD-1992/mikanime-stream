// 浏览器自动调试脚本：用无头 Chromium 直接操作页面并收集日志
// 用法：
//   node scripts/browser-debug.mjs
//   node scripts/browser-debug.mjs --keyword "葬送的芙莉莲" --wait 35000
//   node scripts/browser-debug.mjs --no-wasmnet --play-index 0

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const getArg = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] != null ? args[i + 1] : def
}

const PORT = Number(getArg('--port', '3010'))
const KEYWORD = getArg('--keyword', '葬送的芙莉莲')
const WAIT_MS = Number(getArg('--wait', '35000'))
const PLAY_INDEX = Number(getArg('--play-index', '0'))
const USE_WASMNET = !args.includes('--no-wasmnet')
const BASE = `http://127.0.0.1:${PORT}`

const debugDir = path.join(root, '.debug')
fs.mkdirSync(debugDir, { recursive: true })

let serverProc = null

async function ensureServer() {
  try {
    const r = await fetch(`${BASE}/api/health`)
    if (r.ok) return 'reuse'
  } catch {
    /* 未运行则启动 */
  }
  const logPath = path.join(os.tmpdir(), `mikan-debug-server-${Date.now()}.log`)
  serverProc = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
  })
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return 'started'
    } catch {
      /* 等待 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('服务器启动失败，日志：' + logPath)
}

const report = {
  port: PORT,
  keyword: KEYWORD,
  waitMs: WAIT_MS,
  wasmnet: USE_WASMNET,
  server: null,
  initial: {},
  search: {},
  play: {},
  logs: [],
  failedRequests: [],
}

try {
  report.server = await ensureServer()

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  page.on('console', (msg) => {
    report.logs.push(`[${msg.type()}] ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    report.logs.push(`[pageerror] ${err.message}`)
  })
  page.on('requestfailed', (req) => {
    report.failedRequests.push(`${req.method()} ${req.url()} -> ${req.failure()?.errorText || '?'}`)
  })
  page.on('response', (res) => {
    if (res.url().includes('/api/')) {
      report.logs.push(`[api ${res.status()}] ${res.url().replace(BASE, '')}`)
    }
  })

  await page.goto(`${BASE}/p2p/index.html`, { waitUntil: 'networkidle', timeout: 30000 })
  await page.waitForTimeout(2000)

  report.initial.proxyStatus = await page.textContent('#proxy-status')
  report.initial.wasmnetStatus = await page.textContent('#wasmnet-status')
  report.initial.title = await page.title()

  // 搜索
  await page.fill('#search-input', KEYWORD)
  await page.press('#search-input', 'Enter')
  await page.waitForSelector('.result-row', { timeout: 25000 })
  report.search.resultCount = await page.locator('.result-row').count()
  report.search.resultsInfo = await page.textContent('#results-info')
  const firstTitle = await page.locator('.result-title').first().textContent()
  report.search.firstTitle = firstTitle

  // 切换服务器中转
  if (USE_WASMNET) {
    await page.click('#btn-wasmnet')
    await page.waitForTimeout(500)
    report.initial.wasmnetStatusAfterToggle = await page.textContent('#wasmnet-status')
  }

  // 点播放
  const playBtn = page.locator('[data-play]').nth(PLAY_INDEX)
  await playBtn.click()
  await page.waitForTimeout(3000)
  report.play.playerTitle = await page.textContent('#player-title')

  // 打开监控面板
  await page.click('#btn-monitor')
  await page.waitForTimeout(500)

  // 等待观察
  await page.waitForTimeout(WAIT_MS)

  report.play.playerTitle = await page.textContent('#player-title')
  report.play.fileChips = await page.locator('.file-chip').count()
  report.play.monitor = await page.textContent('#monitor-overlay')
  report.play.statPeers = await page.textContent('#stat-peers')
  report.play.statSpeed = await page.textContent('#stat-speed')
  report.play.statProgress = await page.textContent('#stat-progress')
  report.play.note = await page.textContent('#player-note')
  report.play.wasmnetStatus = await page.textContent('#wasmnet-status')

  const shot = path.join(debugDir, 'last-page.png')
  await page.screenshot({ path: shot })
  report.screenshot = shot

  await browser.close()
} catch (err) {
  report.error = err.message
}

if (serverProc) {
  try {
    serverProc.kill()
  } catch {
    /* 忽略 */
  }
}

// 输出报告（文件保存完整日志，控制台只打印最近 120 条）
fs.writeFileSync(path.join(debugDir, 'last-run.json'), JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify({ ...report, logs: report.logs.slice(-120) }, null, 2))
