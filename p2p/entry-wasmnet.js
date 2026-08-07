// wasmnet 版 WebTorrent 浏览器入口：
// 与 entry.js 相同，但打包时把 net/dgram 替换为 wasmnet 中继垫片，
// 使浏览器端可以连接普通 BitTorrent（TCP/UDP）做种者。
import WebTorrent from 'webtorrent'
import MemoryChunkStore from 'memory-chunk-store'

window.WebTorrentWasmnet = WebTorrent
window.WebTorrentWasmnet.MemoryChunkStore = MemoryChunkStore

export default WebTorrent
