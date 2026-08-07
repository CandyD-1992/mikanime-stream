import WebTorrent from 'webtorrent';
import MemoryChunkStore from 'memory-chunk-store';

window.WebTorrent = WebTorrent;
window.WebTorrent.MemoryChunkStore = MemoryChunkStore;

export default WebTorrent;
