// wasmnet 转发服务
//
// 浏览器里无法直接建立 TCP/UDP 连接，本模块在服务端提供一个 WebSocket
// 中继：前端把“要连的地址和要发的字节”发过来，服务端用真实网络帮它收发，
// 然后把收到的数据原样转发回去。
//
// 设计约束（按需求）：
//  - 只做转发，不在磁盘上保存任何数据；
//  - 不缓存、不落盘、会话结束后立即销毁所有连接；
//  - 默认需要 token 才能使用（防止 NAS 变成任人使用的开放代理）。
//
// 协议与 npm 包 wasmnet（0.1.4）的浏览器客户端完全兼容，支持
// JSON 文本帧与二进制帧两种模式（前端使用二进制帧以减小开销）。

import net from 'node:net'
import dgram from 'node:dgram'
import tls from 'node:tls'
import dns from 'node:dns/promises'
import { WebSocketServer } from 'ws'

const BINARY_HEADER = 9 // 1 字节类型 + 8 字节大端 id

// 与 wasmnet 客户端保持一致的消息类型
const MSG = {
  // 请求（前端 -> 服务端）
  CONNECT: 0x01, // 建立出站 TCP 连接
  BIND: 0x02, // 绑定 TCP 监听端口（用于接收入站连接）
  LISTEN: 0x03, // 开始监听（兼容保留，绑定后即监听）
  SEND: 0x04, // 发送数据
  CLOSE: 0x05, // 关闭 socket / 监听器
  CONNECT_UDP: 0x06, // 建立 UDP socket
  SEND_TO: 0x07, // UDP 发送到指定地址
  RESOLVE: 0x08, // DNS 解析
  CONNECT_TLS: 0x09, // 建立 TLS 连接（握手由服务端完成，数据透传明文）
  // 事件（服务端 -> 前端）
  CONNECTED: 0x81,
  DATA: 0x82,
  LISTENING: 0x83,
  ACCEPTED: 0x84,
  CLOSED: 0x85,
  ERROR: 0x86,
  DENIED: 0x87,
  DATA_FROM: 0x88,
  RESOLVED: 0x89,
  UDP_BOUND: 0x8a,
}

function binFrame(type, id, payload = new Uint8Array(0)) {
  const frame = new Uint8Array(BINARY_HEADER + payload.length)
  frame[0] = type
  new DataView(frame.buffer).setBigUint64(1, BigInt(id))
  frame.set(payload, BINARY_HEADER)
  return frame
}

function readBinFrame(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return {
    type: buf[0],
    id: Number(view.getBigUint64(1)),
    payload: buf.subarray(BINARY_HEADER),
  }
}

function u16be(n) {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, n)
  return b
}

function isIpv4(s) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s)
}

function looksLikeIp(s) {
  return isIpv4(s) || (s.includes(':') && !/[a-z]/i.test(s.replace(/:/g, '')))
}

function sameToken(a, b) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * 把一个 wasmnet WebSocket 会话接入 HTTP 服务器。
 * @param {import('node:http').Server} httpServer
 * @param {{path?: string, token?: string}} opts
 */
export function attachWasmnetRelay(httpServer, { path = '/wasmnet', token = '' } = {}) {
  const wss = new WebSocketServer({ noServer: true })
  const allowed = token ? (t) => sameToken(t, token) : () => true

  httpServer.on('upgrade', (req, socket, head) => {
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== path) {
      socket.destroy()
      return
    }
    if (!allowed(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })

  wss.on('connection', (ws) => {
    const state = {
      ws,
      sockets: new Map(), // id -> { kind, sock, ended, sent }
      nextId: 1,
      closed: false,
    }

    const send = (frame) => {
      if (state.closed || ws.readyState !== ws.OPEN) return
      ws.send(frame, { binary: true })
    }
    const sendJson = (obj) => {
      if (state.closed || ws.readyState !== ws.OPEN) return
      ws.send(JSON.stringify(obj))
    }

    function cleanup(id) {
      const entry = state.sockets.get(id)
      if (!entry) return
      state.sockets.delete(id)
      if (entry.ended) return
      entry.ended = true
      try {
        if (entry.kind === 'listener') entry.sock.close()
        else entry.sock.destroy ? entry.sock.destroy() : entry.sock.close()
      } catch {
        /* 忽略 */
      }
    }

    function notifyClosed(id) {
      send(binFrame(MSG.CLOSED, id))
    }

    function notifyDenied(id, msg) {
      send(binFrame(MSG.DENIED, id, new TextEncoder().encode(String(msg || 'denied'))))
    }

    function notifyError(id, msg) {
      send(binFrame(MSG.ERROR, id, new TextEncoder().encode(String(msg || 'error'))))
    }

    // ---------- 出站 TCP / TLS ----------
    function handleConnect(id, addr, port, useTls) {
      if (!addr || !port) return notifyDenied(id, 'missing addr/port')
      let sock
      try {
        const opts = { host: addr, port }
        if (useTls) {
          if (!looksLikeIp(addr)) opts.servername = addr
          sock = tls.connect(opts)
        } else {
          sock = net.connect(opts)
        }
      } catch (err) {
        return notifyDenied(id, err.message)
      }
      const entry = { id, kind: useTls ? 'tls' : 'tcp', sock, ended: false }
      state.sockets.set(id, entry)

      // 连接超时：避免对不可达的做种者一直挂着，超时后通知前端并清理
      entry.connectTimer = setTimeout(() => {
        if (!entry.ended && state.sockets.has(id)) {
          entry.ended = true
          state.sockets.delete(id)
          notifyDenied(id, 'connect timeout')
          try {
            sock.destroy()
          } catch {
            /* 忽略 */
          }
        }
      }, 6000)

      sock.once('connect', () => {
        clearTimeout(entry.connectTimer)
        if (entry.ended) return
        send(binFrame(MSG.CONNECTED, id))
      })
      sock.on('data', (d) => {
        if (!entry.ended) send(binFrame(MSG.DATA, id, d))
      })
      sock.on('error', (err) => {
        clearTimeout(entry.connectTimer)
        if (!entry.ended) {
          entry.ended = true
          if (state.sockets.has(id)) {
            notifyError(id, err.message)
            state.sockets.delete(id)
          }
        }
      })
      sock.on('close', () => {
        clearTimeout(entry.connectTimer)
        if (state.sockets.has(id) && !entry.ended) {
          notifyClosed(id)
          cleanup(id)
        } else if (state.sockets.has(id)) {
          state.sockets.delete(id)
        }
      })
    }

    // ---------- UDP ----------
    function handleConnectUdp(id, addr, port) {
      if (!addr || !port) return notifyDenied(id, 'missing addr/port')
      let sock
      try {
        sock = dgram.createSocket(looksLikeIp(addr) && !isIpv4(addr) ? 'udp6' : 'udp4')
      } catch (err) {
        return notifyDenied(id, err.message)
      }
      const entry = { id, kind: 'udp', sock, ended: false }
      entry.targetHost = addr
      entry.targetPort = port
      state.sockets.set(id, entry)

      sock.on('error', (err) => {
        if (!entry.ended && state.sockets.has(id)) {
          notifyError(id, err.message)
          cleanup(id)
        }
      })
      sock.on('message', (msg, rinfo) => {
        if (entry.ended) return
        const addrBytes = new TextEncoder().encode(rinfo.address)
        const payload = new Uint8Array(4 + addrBytes.length + msg.length)
        const dv = new DataView(payload.buffer)
        dv.setUint16(0, rinfo.port)
        dv.setUint16(2, addrBytes.length)
        payload.set(addrBytes, 4)
        payload.set(msg, 4 + addrBytes.length)
        send(binFrame(MSG.DATA_FROM, id, payload))
      })
      sock.bind(() => {
        send(binFrame(MSG.UDP_BOUND, id, u16be(sock.address().port)))
      })
    }

    // ---------- TCP 监听（入站连接） ----------
    function handleBind(id, addr, port) {
      let server
      try {
        server = net.createServer()
      } catch (err) {
        return notifyDenied(id, err.message)
      }
      const entry = { id, kind: 'listener', sock: server, ended: false }
      state.sockets.set(id, entry)

      server.on('connection', (conn) => {
        if (entry.ended) {
          conn.destroy()
          return
        }
        const connId = state.nextId++
        const connEntry = { id: connId, kind: 'tcp', sock: conn, ended: false }
        state.sockets.set(connId, connEntry)

        const remote = String(conn.remoteAddress || '') + ':' + (conn.remotePort || 0)
        const remoteBytes = new TextEncoder().encode(remote)
        const payload = new Uint8Array(8 + remoteBytes.length)
        new DataView(payload.buffer).setBigUint64(0, BigInt(connId))
        payload.set(remoteBytes, 8)
        send(binFrame(MSG.ACCEPTED, id, payload))

        conn.on('data', (d) => {
          if (!connEntry.ended) send(binFrame(MSG.DATA, connId, d))
        })
        conn.on('error', () => {})
        conn.on('close', () => {
          if (state.sockets.has(connId) && !connEntry.ended) {
            notifyClosed(connId)
            state.sockets.delete(connId)
          }
        })
      })
      server.on('error', (err) => {
        if (!entry.ended) notifyError(id, err.message)
      })
      server.listen(port || 0, () => {
        if (!entry.ended) send(binFrame(MSG.LISTENING, id, u16be(server.address().port)))
      })
    }

    // ---------- 消息分发 ----------
    function handleJson(msg) {
      if (!msg || typeof msg !== 'object') return
      const id = Number(msg.id) || 0
      const addr = msg.addr
      const port = Number(msg.port)
      switch (msg.op) {
        case 'connect':
          handleConnect(id, addr, port, false)
          break
        case 'connect_tls':
          handleConnect(id, addr, port, true)
          break
        case 'connect_udp':
          handleConnectUdp(id, addr, port)
          break
        case 'bind':
          handleBind(id, addr, port)
          break
        case 'listen':
          // 绑定后即监听，这里无需额外处理
          break
        case 'send': {
          const entry = state.sockets.get(id)
          if (!entry || entry.kind === 'listener') return
          let data
          try {
            data = Buffer.from(msg.data || '', 'base64')
          } catch {
            return
          }
          if (entry.kind === 'udp') {
            if (entry.sock.send) entry.sock.send(data, entry.targetPort, entry.targetHost)
          } else {
            entry.sock.write(data)
          }
          break
        }
        case 'send_to': {
          const entry = state.sockets.get(id)
          if (!entry || entry.kind !== 'udp') return
          try {
            entry.sock.send(Buffer.from(msg.data || '', 'base64'), Number(msg.port), msg.addr)
          } catch {
            /* 忽略 */
          }
          break
        }
        case 'close':
          cleanup(id)
          break
        case 'resolve': {
          dns.lookup(msg.name, { all: true })
            .then((res) => {
              const addrs = res.map((r) => r.address)
              sendJson({ ev: 'resolved', id, addrs })
            })
            .catch((err) => {
              sendJson({ ev: 'error', id, msg: err.message })
            })
          break
        }
        default:
          break
      }
    }

    function handleBinary(buf) {
      if (buf.length < BINARY_HEADER) return
      const { type, id, payload } = readBinFrame(buf)
      switch (type) {
        case MSG.CONNECT: {
          const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
          const port = dv.getUint16(0)
          const addr = new TextDecoder().decode(payload.subarray(2))
          handleConnect(id, addr, port, false)
          break
        }
        case MSG.CONNECT_TLS: {
          const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
          const port = dv.getUint16(0)
          const addr = new TextDecoder().decode(payload.subarray(2))
          handleConnect(id, addr, port, true)
          break
        }
        case MSG.CONNECT_UDP: {
          const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
          const port = dv.getUint16(0)
          const addr = new TextDecoder().decode(payload.subarray(2))
          handleConnectUdp(id, addr, port)
          break
        }
        case MSG.BIND: {
          const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
          const port = dv.getUint16(0)
          const addr = new TextDecoder().decode(payload.subarray(2))
          handleBind(id, addr, port)
          break
        }
        case MSG.LISTEN:
          break
        case MSG.SEND: {
          const entry = state.sockets.get(id)
          if (!entry || entry.kind === 'listener') return
          if (entry.kind === 'udp') {
            if (entry.sock.send) entry.sock.send(payload, entry.targetPort, entry.targetHost)
          } else {
            entry.sock.write(payload)
          }
          break
        }
        case MSG.SEND_TO: {
          const entry = state.sockets.get(id)
          if (!entry || entry.kind !== 'udp') return
          const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
          const port = dv.getUint16(0)
          const addrLen = dv.getUint16(2)
          const addr = new TextDecoder().decode(payload.subarray(4, 4 + addrLen))
          const data = payload.subarray(4 + addrLen)
          try {
            entry.sock.send(data, port, addr)
          } catch {
            /* 忽略 */
          }
          break
        }
        case MSG.CLOSE:
          cleanup(id)
          break
        case MSG.RESOLVE: {
          const name = new TextDecoder().decode(payload)
          dns.lookup(name, { all: true })
            .then((res) => {
              send(binFrame(MSG.RESOLVED, id, new TextEncoder().encode(JSON.stringify(res.map((r) => r.address)))))
            })
            .catch((err) => {
              notifyError(id, err.message)
            })
          break
        }
        default:
          break
      }
    }

    ws.on('message', (data, isBinary) => {
      if (state.closed) return
      try {
        if (isBinary) handleBinary(new Uint8Array(data))
        else handleJson(JSON.parse(data.toString()))
      } catch {
        /* 忽略无法解析的消息 */
      }
    })

    ws.on('close', () => {
      state.closed = true
      // 会话结束：销毁本会话所有连接，不保留任何数据
      for (const id of [...state.sockets.keys()]) cleanup(id)
      state.sockets.clear()
    })
    ws.on('error', () => {})
  })

  return wss
}
