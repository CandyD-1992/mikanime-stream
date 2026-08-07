// Node `net` 模块的浏览器垫片：用 wasmnet 中继建立真实的 TCP 连接。
// 实现 WebTorrent 需要的 net.connect / net.createServer 两个入口。

// 用 streamx 的原生 Duplex（webtorrent 自己使用的流库），
// 避免 Node 流垫片（stream-browserify）与 streamx 管道之间的背压兼容问题。
import { Duplex } from 'streamx'
import { EventEmitter } from 'events'
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

function splitRemote(remote) {
  const i = remote.lastIndexOf(':')
  if (i <= 0) return { host: remote, port: 0 }
  return { host: remote.slice(0, i), port: Number(remote.slice(i + 1)) }
}

class WasmnetSocket extends Duplex {
  constructor() {
    super()
    this._id = null
    this.remoteAddress = null
    this.remotePort = null
    this.connecting = false
  }

  // 兼容 net.connect(opts) 与 net.connect(port, host)
  connect(opts, host, port) {
    if (typeof opts === 'number') {
      port = opts
      opts = { port, host }
    } else if (typeof opts === 'string') {
      host = opts
      opts = { port, host }
    } else if (opts == null) {
      opts = { port, host }
    }
    this.remoteAddress = opts.host
    this.remotePort = opts.port
    this.connecting = true

    getClient()
      .then(async (client) => {
        const id = await withTimeout(
          client.connect(opts.host, opts.port),
          8000,
          '中继 TCP 连接超时（可能中继已断开，将自动重连）',
        )
        if (this.destroyed) {
          client.close(id)
          return
        }
        this._attach(client, id, opts.host, opts.port)
        console.log('[mikan] tcp connected:', opts.host + ':' + opts.port, '(relay id ' + id + ')')
      })
      .catch((err) => {
        // 只有中继整体超时（ETIMEDOUT，说明 WebSocket 层断了）才重置；
        // 单个做种者连接失败（如 connect timeout）不打扰其他连接
        if (err && err.code === 'ETIMEDOUT') resetClient()
        console.warn('[mikan] tcp connect failed:', opts.host + ':' + opts.port, '-', err && (err.stack || err.message))
        this.destroy(err)
      })
    return this
  }

  _attach(client, id, host, port) {
    this._client = client
    this._id = id
    this.connecting = false
    this.remoteAddress = host
    this.remotePort = port

    client.onData(id, (data) => {
      if (!this.destroyed) this.push(Buffer.from(data))
    })
    client.onClose(id, () => {
      if (this.destroyed) return
      this.push(null)
      this.destroy()
    })
    this._flushPending()
    this.emit('connect')
  }

  // 入站连接（由 createServer 收到 accept 后创建）
  _attachIncoming(client, id, remote) {
    const { host, port } = splitRemote(remote)
    this._client = client
    this._id = id
    this.remoteAddress = host
    this.remotePort = port

    client.onData(id, (data) => {
      if (!this.destroyed) this.push(Buffer.from(data))
    })
    client.onClose(id, () => {
      if (this.destroyed) return
      this.push(null)
      this.destroy()
    })
    console.log('[mikan] tcp connected (incoming):', remote)
    this._flushPending()
    // 入站连接直接可用
    queueMicrotask(() => this.emit('connect'))
  }

  _write(chunk, cb) {
    if (!this._id) {
      // 连接尚未就绪，缓存写入
      if (!this._pendingWrites) this._pendingWrites = []
      this._pendingWrites.push(Buffer.from(chunk))
      return cb()
    }
    try {
      this._client.send(this._id, chunk)
    } catch (err) {
      return cb(err)
    }
    cb()
  }

  _flushPending() {
    if (!this._pendingWrites || !this._pendingWrites.length) return
    const pending = this._pendingWrites
    this._pendingWrites = []
    for (const chunk of pending) {
      try {
        this._client.send(this._id, chunk)
      } catch {
        /* 忽略 */
      }
    }
  }

  _final(cb) {
    if (this._id) {
      try {
        this._client.close(this._id)
      } catch {
        /* 忽略 */
      }
    }
    cb()
  }

  _destroy(cb) {
    if (this._id && this._client) {
      try {
        this._client.close(this._id)
      } catch {
        /* 忽略 */
      }
      this._id = null
    }
    cb()
  }

  // ---- net.Socket 常用方法的空实现 ----
  setNoDelay() { return this }
  setKeepAlive() { return this }
  setTimeout() { return this }
  ref() { return this }
  unref() { return this }
  address() {
    return { address: '0.0.0.0', port: 0 }
  }
}

function connect(...args) {
  return new WasmnetSocket().connect(...args)
}

class WasmnetServer extends EventEmitter {
  constructor(onConnection) {
    super()
    if (typeof onConnection === 'function') this.on('connection', onConnection)
    this._id = null
    this._port = 0
    this.listening = false
  }

  listen(port, host, cb) {
    if (typeof host === 'function') {
      cb = host
      host = undefined
    }
    if (typeof port === 'function') {
      cb = port
      port = 0
    }
    const bindHost = host || '0.0.0.0'
    getClient()
      .then(async (client) => {
        const { id, port: actual } = await client.bind(bindHost, port || 0)
        this._id = id
        this._port = actual
        this._client = client
        // 先注册 accept 回调，再开始监听，避免丢连接
        client.onAccept(id, (connId, remote) => {
          const sock = new WasmnetSocket()
          sock._attachIncoming(client, connId, remote)
          this.emit('connection', sock)
        })
        client.listen(id, 128)
        this.listening = true
        this.address = () => ({ address: bindHost, port: actual })
        this.emit('listening')
        if (cb) cb()
      })
      .catch((err) => this.emit('error', err))
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
    this.listening = false
    this.emit('close')
    if (cb) cb()
    return this
  }

  address() {
    return { address: '0.0.0.0', port: this._port }
  }
}

function createServer(onConnection) {
  return new WasmnetServer(onConnection)
}

function isIP() {
  return 0
}

export { connect, createServer, isIP }
export default { connect, createServer, isIP }
