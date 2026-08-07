// wasmnet 浏览器端公共模块：管理到服务器中继的单个 WebSocket 连接。
// net / dgram 垫片都通过这里拿同一个 WasmnetClient 实例。

import { WasmnetClient } from 'wasmnet'

const PORT = 3000

let client = null
let connecting = null
let configCache = null

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(message || 'timeout')
      err.code = 'ETIMEDOUT'
      reject(err)
    }, ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

export function isHttpPage() {
  // 只要页面是通过 http/https 打开的（无论端口、域名、反向代理），
  // 服务器地址一律取页面本身的地址（同源），避免写死端口导致连不上
  return location.protocol === 'http:' || location.protocol === 'https:'
}

export function serverBase() {
  return isHttpPage()
    ? location.protocol + '//' + location.host
    : 'http://127.0.0.1:' + PORT
}

export async function getConfig() {
  if (configCache) return configCache
  const r = await fetch(serverBase() + '/api/config', { cache: 'no-store' })
  if (!r.ok) throw new Error('无法读取服务器中继配置（HTTP ' + r.status + '）')
  const j = await r.json()
  if (!j || !j.ok || !j.wasmnet) throw new Error('服务器未启用中继')
  configCache = j
  return j
}

function emitStatus(detail) {
  try {
    window.dispatchEvent(new CustomEvent('mikan-wasmnet', { detail }))
  } catch {
    /* 忽略 */
  }
}

function relayOverride() {
  try {
    return (localStorage.getItem('p2p_relay_url') || '').trim()
  } catch {
    return ''
  }
}

function buildWsUrl(cfg) {
  const override = relayOverride()
  if (override) {
    if (!/^wss?:\/\//i.test(override)) {
      throw new Error('中继地址需以 ws:// 或 wss:// 开头')
    }
    const token = (cfg.wasmnet && cfg.wasmnet.token) || ''
    if (token && !/[?&]token=/.test(override)) {
      return override + (override.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token)
    }
    return override
  }
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
  const host = isHttpPage() ? location.host : '127.0.0.1:' + PORT
  const q = cfg.wasmnet.token ? '?token=' + encodeURIComponent(cfg.wasmnet.token) : ''
  return proto + host + cfg.wasmnet.path + q
}

async function connectOnce() {
  const cfg = await getConfig()
  const c = new WasmnetClient(buildWsUrl(cfg), { binary: true })
  await withTimeout(c.ready(), 10000, '中继 WebSocket 连接超时')
  return c
}

export async function getClient() {
  if (client) return client
  if (!connecting) {
    connecting = connectOnce()
      .then((c) => {
        client = c
        connecting = null
        emitStatus({ status: 'connected' })
        return c
      })
      .catch((err) => {
        connecting = null
        configCache = null // 配置可能已过期（例如服务重启换了 token），下次重取
        emitStatus({ status: 'error', error: err && err.message })
        throw err
      })
  }
  return connecting
}

export async function resetClient() {
  try {
    if (client) client.disconnect()
  } catch {
    /* 忽略 */
  }
  client = null
  connecting = null
  configCache = null
}
