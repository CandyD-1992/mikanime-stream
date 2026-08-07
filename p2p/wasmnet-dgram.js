// Node `dgram` 模块的浏览器垫片：用 wasmnet 中继收发 UDP 数据报。
// 主要用于 UDP tracker 的 announce / scrape 请求。

import { EventEmitter } from 'events'
import { Buffer } from 'buffer'
import { getClient, resetClient } from './wasmnet-core.js'

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message || 'timeout')), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

class WasmnetDgramSocket extends EventEmitter {
  constructor() {
    super()
    this._id = null
    this._target = null
    this._port = 0
    this._client = null
  }

  send(buf, offset, length, port, host, cb) {
    if (typeof offset === 'function') {
      cb = offset
      offset = 0
      length = buf.length
      port = length
      host = port
    }
    const data = buf.subarray(offset, offset + length)
    getClient()
      .then(async (client) => {
        if (!this._id) {
          const { id, port: localPort } = await withTimeout(
            client.connectUdp(host, port),
            8000,
            '中继 UDP 连接超时（可能中继已断开，将自动重连）',
          )
          this._client = client
          this._id = id
          this._port = localPort
          this._target = host + ':' + port
          client.onDataFrom(id, (raw, addr, srcPort) => {
            if (!this.destroyed) this.emit('message', Buffer.from(raw), { address: addr, port: srcPort })
          })
          client.onClose(id, () => {
            this._id = null
            this._client = null
            this.emit('close')
          })
        }
        const key = host + ':' + port
        if (key === this._target) client.send(this._id, data)
        else client.sendTo(this._id, host, port, data)
        if (cb) cb(null, data.length)
      })
      .catch((err) => {
        if (err && err.code === 'ETIMEDOUT') resetClient()
        this.emit('error', err)
        if (cb) cb(err)
      })
    return this
  }

  close(cb) {
    if (this._id && this._client) {
      try {
        this._client.close(this._id)
      } catch {
        /* 忽略 */
      }
    }
    this._id = null
    this._client = null
    this.emit('close')
    if (cb) cb()
    return this
  }

  bind(...args) {
    const cb = args.find((a) => typeof a === 'function')
    // 我们的 UDP 通道通过中继建立（首个 send 时 connectUdp），
    // 这里直接视为“已绑定”，发出 listening 事件，供 k-rpc / DHT 使用
    queueMicrotask(() => {
      this.emit('listening')
      if (cb) cb()
    })
    return this
  }

  address() {
    return { address: '0.0.0.0', port: this._port }
  }

  setMulticastTTL() { return this }
  setMulticastInterface() { return this }
  setBroadcast() { return this }
  addMembership() {}
  dropMembership() {}
  ref() { return this }
  unref() { return this }
}

function createSocket(typeOrOpts, callback) {
  const sock = new WasmnetDgramSocket()
  if (typeof callback === 'function') sock.on('message', callback)
  return sock
}

export { createSocket }
export default { createSocket }
