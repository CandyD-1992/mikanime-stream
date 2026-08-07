// 浏览器 fetch 包装：HTTP tracker 的 announce 请求改由服务器代发。
//
// 浏览器直接 fetch tracker 会因 CORS 被拦截（tracker 不返回跨域头），
// 而 bittorrent-tracker 的 http-tracker 用的是原生 fetch，无法解析响应。
// 这里把包含 /announce 的请求转到服务器的 /api/fetch（服务器代发，仅转发不存储）。

import { serverBase, getConfig } from './wasmnet-core.js'

const nativeFetch = self.fetch.bind(self)

async function proxyTracker(url, init) {
  const cfg = await getConfig()
  const proxyUrl =
    serverBase() +
    '/api/fetch?token=' + encodeURIComponent(cfg.wasmnet.token || '') +
    '&url=' + encodeURIComponent(url)
  return nativeFetch(proxyUrl, init)
}

export default async function fetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url) || ''
  if (typeof url === 'string' && url.includes('/announce')) {
    try {
      return await proxyTracker(url, init)
    } catch (err) {
      console.warn('[mikan] tracker proxy failed:', err && err.message)
      throw err
    }
  }
  return nativeFetch(input, init)
}
