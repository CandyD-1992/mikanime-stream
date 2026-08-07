// Node `dns` 模块的浏览器垫片：解析主机名时通过中继的 DNS 解析接口。
// 目前只需要 k-rpc-socket 用到的 dns.lookup。

import { getClient } from './wasmnet-core.js'

function isIpv4(s) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s)
}

export function lookup(hostname, opts, cb) {
  if (typeof opts === 'function') {
    cb = opts
    opts = {}
  }
  if (isIpv4(hostname)) {
    cb(null, hostname, 4)
    return
  }
  getClient()
    .then((client) => client.resolve(hostname))
    .then((addrs) => {
      if (!addrs || !addrs.length) return cb(null, hostname, 0)
      const v4 = addrs.find((a) => isIpv4(a))
      cb(null, v4 || addrs[0], v4 ? 4 : 0)
    })
    .catch(() => {
      // 解析失败时把主机名原样返回，让底层 UDP send 再尝试（中继端可解析）
      cb(null, hostname, 0)
    })
}

export default { lookup }
