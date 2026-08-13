// MKV 内嵌字幕提取器（纯浏览器端，不落盘）
//
// Mediabunny 的 Matroska 解封装目前不暴露字幕轨，所以这里单独做一个轻量 EBML 扫描器：
// 边下载边扫描 Cluster/Block，把 S_TEXT/UTF8(SRT)、S_TEXT/ASS、S_TEXT/WEBVTT 转成
// WebVTT 时间轴数据，通过 onCue 实时回调（播放器用 VTTCue 挂到 <video> 的 TextTrack 上）。
//
// 用法：
//   const subs = MikanMkvSubs.extract({
//     createReadStream: (opts) => file.createReadStream(opts),
//     fileLength: file.length,
//     onTrack: (info) => { ... },  // 每个字幕轨回调一次 { trackNumber, codecId, language, label }
//     onCue: (cue, trackNumber) => { ... },  // { start, end, text }
//     onDone: () => { ... },
//   });
//   subs.stop();
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.MikanMkvSubs = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const EBML = {
    EBML: 0x1a45dfa3,
    Segment: 0x18538067,
    SeekHead: 0x114d9b74,
    Info: 0x1549a966,
    TimecodeScale: 0x2ad7b1,
    Tracks: 0x1654ae6b,
    TrackEntry: 0xae,
    TrackNumber: 0xd7,
    TrackType: 0x83,
    FlagDefault: 0x88,
    CodecID: 0x86,
    CodecPrivate: 0x63a2,
    Language: 0x22b59c,
    Cluster: 0x1f43b675,
    Timestamp: 0xe7,
    SimpleBlock: 0xa3,
    BlockGroup: 0xa0,
    Block: 0xa1,
    BlockDuration: 0x9b,
    Cues: 0x1c53bb6b,
    Attachments: 0x1941a469,
    Chapters: 0x1043a770,
    Tags: 0x1254c367,
    Void: 0xec,
  }

  // 只读 vint：len 由首字节的标记位决定；id 返回原始字节整数（含标记位），size 返回掩码后的数值
  function readVint(buf, pos, opts) {
    const b0 = buf[pos]
    if (b0 == null) return null
    let mask = 0x80
    let len = 1
    while (len <= 8 && !(b0 & mask)) {
      mask >>= 1
      len++
    }
    if (len > 8) return null
    if (pos + len > buf.length) return null
    let value = 0
    for (let i = 0; i < len; i++) value = value * 256 + buf[pos + i]
    if (opts && opts.mask) {
      value = b0 & (mask - 1)
      for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i]
    }
    const allOnes = (1 << (7 * len)) - 1
    return { value, len, unknown: opts && opts.mask ? value === allOnes : false }
  }

  const CN_DIGIT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

  function hmsToSec(h, m, s, ms) {
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms || 0) / 1000
  }

  function assTsToSec(str) {
    const m = /^(\d+):(\d{2}):(\d{2})[.:](\d{2})$/.exec(String(str).trim())
    if (!m) return null
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 100
  }

  function cleanAssText(text) {
    return text
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\h/g, ' ')
      .trim()
  }

  function escapeVtt(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  class MkvSubtitleExtractor {
    constructor(opts) {
      this.opts = opts
      this.debug = !!(opts && opts.debug)
      this.buf = new Uint8Array(0)
      this.pos = 0
      this.stopped = false
      this.timecodeScale = 1000000
      this.subtitleTracks = new Map() // trackNumber -> { codecId, language, label }
      this.selectedTrack = null
      this.inCluster = false
      this.clusterTs = 0
      this.clusterEnd = null // 已知大小 Cluster 的结束偏移（未知大小时为 null）
      this.pendingCues = new Map() // trackNumber -> 待收口的 cue
      this.cueCount = 0
      this.sawTracks = false
      this.stream = null
      this.done = false
    }

    start() {
      const { createReadStream, fileLength } = this.opts
      this.stream = createReadStream({ start: 0, end: fileLength > 0 ? fileLength - 1 : 0 })
      this.stream.on('data', (chunk) => {
        if (this.stopped) return
        this.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      })
      this.stream.on('error', () => this._finish())
      this.stream.on('end', () => this._finish())
      return this
    }

    stop() {
      this.stopped = true
      if (this.stream && typeof this.stream.destroy === 'function') {
        try { this.stream.destroy() } catch (e) { /* 忽略 */ }
      }
    }

    push(chunk) {
      if (this.stopped || this.done) return
      const next = new Uint8Array(this.buf.length + chunk.length)
      next.set(this.buf, 0)
      next.set(chunk, this.buf.length)
      this.buf = next
      this._parse(false)
    }

    _finish() {
      if (this.stopped || this.done) return
      this.done = true
      this._parse(true)
      this._flushPending()
      if (this.opts.onDone) {
        try { this.opts.onDone() } catch (e) { /* 忽略 */ }
      }
    }

    _parse(forceEnd) {
      for (;;) {
        const before = this.pos
        this._scanOne(forceEnd)
        if (this.pos === before) break
      }
      if (this.pos > 262144) {
        this.buf = this.buf.slice(this.pos)
        this.pos = 0
      }
    }

    _need(n) {
      return this.pos + n > this.buf.length
    }

    _scanOne(forceEnd) {
      if (this.inCluster) {
        this._scanClusterChild(forceEnd)
        return
      }
      if (this._need(2)) return
      const idR = readVint(this.buf, this.pos)
      if (!idR || this._need(idR.len + 1)) return
      const sizeR = readVint(this.buf, this.pos + idR.len, { mask: true })
      if (!sizeR || this._need(idR.len + sizeR.len)) return
      const id = idR.value
      const headerLen = idR.len + sizeR.len
      const dataStart = this.pos + headerLen
      const dataLen = sizeR.unknown ? null : sizeR.value
      // Segment/Cluster 是流式容器：数据边到边解析，不需要等整个元素到齐；
      // 其余元素（含要跳过的叶子）等数据齐了再处理，避免解析半个元素。
      const streamingContainer = id === EBML.Segment || id === EBML.Cluster
      if (!streamingContainer && !sizeR.unknown && dataStart + sizeR.value > this.buf.length) {
        if (!forceEnd) return
        // 文件结束处被截断：直接停
        this.pos = this.buf.length
        return
      }

      if (this.debug) console.log('[subs] id=' + id.toString(16) + ' len=' + dataLen + ' pos=' + this.pos)
      if (id === EBML.Info) {
        this._parseInfo(dataStart, dataLen)
      } else if (id === EBML.Tracks) {
        this._parseTracks(dataStart, dataLen)
      } else if (id === EBML.Cluster) {
        // 无论大小是否已知，都进入子元素增量扫描状态；
        // 已知大小时用 clusterEnd 标记边界，扫描到边界即退出。
        this.inCluster = true
        this.clusterTs = 0
        this.clusterEnd = sizeR.unknown ? null : dataStart + sizeR.value
        this.pos = dataStart
        return
      } else if (dataLen != null && this._skippable(id)) {
        // 叶子元素直接跳过（Cues/Attachments/Chapters/Tags/SeekHead/Void/CRC 等）
      } else {
        // 容器（Segment 等）或未知大小的元素：继续按子元素扫描
      }

      if (dataLen != null) {
        // Segment 是容器：进入其内部继续扫描；其余（Info/Tracks/Cluster 等）子扫描后整体跳过
        this.pos = id === EBML.Segment ? dataStart : dataStart + dataLen
      }
      else this.pos = dataStart
    }

    _scanClusterChild(forceEnd) {
      if (this.clusterEnd != null && this.pos >= this.clusterEnd) {
        this.inCluster = false
        this.clusterEnd = null
        return
      }
      if (this._need(2)) return
      const idR = readVint(this.buf, this.pos)
      if (!idR || this._need(idR.len + 1)) return
      const sizeR = readVint(this.buf, this.pos + idR.len, { mask: true })
      if (!sizeR || this._need(idR.len + sizeR.len)) return
      const id = idR.value
      const headerLen = idR.len + sizeR.len
      const valueStart = this.pos + headerLen
      if (this._isTopLevel(id)) {
        // 未知大小 Cluster 结束：交还给外层扫描
        this.inCluster = false
        this.clusterEnd = null
        return
      }
      const hasData = sizeR.unknown || valueStart + sizeR.value <= this.buf.length
      if (!hasData) {
        if (!forceEnd) return
        this.pos = this.buf.length
        this.inCluster = false
        this.clusterEnd = null
        return
      }
      if (id === EBML.Timestamp && sizeR.value <= 8) {
        let v = 0
        for (let i = 0; i < sizeR.value; i++) v = v * 256 + this.buf[valueStart + i]
        this.clusterTs = v
      } else if (id === EBML.SimpleBlock) {
        this._parseBlock(valueStart, sizeR.value, this.clusterTs, null)
      } else if (id === EBML.BlockGroup) {
        this._parseBlockGroup(valueStart, sizeR.value, this.clusterTs)
      }
      if (sizeR.value == null) this.pos = valueStart
      else this.pos = valueStart + sizeR.value
      if (this.clusterEnd != null && this.pos >= this.clusterEnd) {
        this.inCluster = false
        this.clusterEnd = null
      }
    }

    _skippable(id) {
      return id === EBML.SeekHead || id === EBML.Cues || id === EBML.Attachments ||
        id === EBML.Chapters || id === EBML.Tags || id === EBML.Void || id === EBML.EBML
    }

    _parseInfo(dataStart, dataLen) {
      if (dataLen == null) return
      const end = Math.min(this.buf.length, dataStart + dataLen)
      let p = dataStart
      while (p + 2 <= end) {
        const idR = readVint(this.buf, p)
        if (!idR || p + idR.len + 1 > end) break
        const sizeR = readVint(this.buf, p + idR.len, { mask: true })
        if (!sizeR || p + idR.len + sizeR.len + sizeR.value > end) break
        if (idR.value === EBML.TimecodeScale && sizeR.value <= 8) {
          let v = 0
          for (let i = 0; i < sizeR.value; i++) v = v * 256 + this.buf[p + idR.len + sizeR.len + i]
          this.timecodeScale = v || 1000000
        }
        p += idR.len + sizeR.len + sizeR.value
      }
    }

    _parseTracks(dataStart, dataLen) {
      if (dataLen == null) return
      const end = Math.min(this.buf.length, dataStart + dataLen)
      let p = dataStart
      while (p + 2 <= end) {
        const idR = readVint(this.buf, p)
        if (!idR || p + idR.len + 1 > end) break
        const sizeR = readVint(this.buf, p + idR.len, { mask: true })
        if (!sizeR || p + idR.len + sizeR.len + sizeR.value > end) break
        if (idR.value === EBML.TrackEntry && sizeR.value != null) {
          this._parseTrackEntry(p + idR.len + sizeR.len, sizeR.value)
        }
        p += idR.len + sizeR.len + (sizeR.value == null ? 0 : sizeR.value)
      }
      this._selectTrack()
    }

    _parseTrackEntry(dataStart, dataLen) {
      const end = Math.min(this.buf.length, dataStart + dataLen)
      const entry = {}
      let p = dataStart
      while (p + 2 <= end) {
        const idR = readVint(this.buf, p)
        if (!idR || p + idR.len + 1 > end) break
        const sizeR = readVint(this.buf, p + idR.len, { mask: true })
        if (!sizeR || p + idR.len + sizeR.len + sizeR.value > end) break
        const valueStart = p + idR.len + sizeR.len
        if (idR.value === EBML.TrackNumber && sizeR.value <= 8) {
          let v = 0
          for (let i = 0; i < sizeR.value; i++) v = v * 256 + this.buf[valueStart + i]
          entry.trackNumber = v
        } else if (idR.value === EBML.TrackType && sizeR.value > 0) {
          entry.trackType = this.buf[valueStart]
        } else if (idR.value === EBML.FlagDefault && sizeR.value > 0) {
          entry.default = this.buf[valueStart] === 1
        } else if (idR.value === EBML.CodecID) {
          entry.codecId = this._decode(this.buf.subarray(valueStart, valueStart + sizeR.value))
        } else if (idR.value === EBML.CodecPrivate) {
          entry.codecPrivate = this.buf.slice(valueStart, valueStart + sizeR.value)
        } else if (idR.value === EBML.Language) {
          entry.language = this._decode(this.buf.subarray(valueStart, valueStart + sizeR.value))
        }
        p += idR.len + sizeR.len + sizeR.value
      }
      if (entry.trackNumber != null && entry.trackType === 0x11 && entry.codecId && /^S_TEXT\//.test(entry.codecId)) {
        const info = {
          codecId: entry.codecId,
          language: entry.language || 'und',
          label: entry.codecId === 'S_TEXT/ASS' ? 'ASS 字幕' : '字幕',
          isDefault: !!entry.default,
        }
        this.subtitleTracks.set(entry.trackNumber, info)
        this.sawTracks = true
        if (this.opts.onTrack) {
          try { this.opts.onTrack({ ...info, trackNumber: entry.trackNumber }) } catch (e) { /* 忽略 */ }
        }
      }
    }

    _selectTrack() {
      if (this.selectedTrack != null || !this.subtitleTracks.size) return
      const tracks = [...this.subtitleTracks.entries()]
      const byLang = (re) => tracks.find(([, t]) => re.test(t.language))
      const pick = byLang(/^(zh|chi|zho|cmn)/i) || byLang(/^(en|eng)/i) || tracks[0]
      this.selectedTrack = pick[0]
      if (this.debug) console.log('[subs] selected subtitle track', pick[0], pick[1].codecId, pick[1].language)
      if (this.opts.onDefaultTrack) {
        try { this.opts.onDefaultTrack(pick[0]) } catch (e) { /* 忽略 */ }
      }
    }

    _decode(bytes) {
      try { return new TextDecoder('utf-8').decode(bytes) } catch (e) { return '' }
    }

    _isTopLevel(id) {
      return id === EBML.Cluster || id === EBML.Cues || id === EBML.Chapters ||
        id === EBML.Tags || id === EBML.Attachments || id === EBML.Tracks ||
        id === EBML.Info || id === EBML.SeekHead
    }

    _parseCluster(dataStart, dataLen) {
      let p = dataStart
      let clusterTs = 0
      const end = Math.min(this.buf.length, dataStart + dataLen)
      while (p + 2 <= end) {
        const idR = readVint(this.buf, p)
        if (!idR || p + idR.len + 1 > end) break
        const sizeR = readVint(this.buf, p + idR.len, { mask: true })
        if (!sizeR || p + idR.len + sizeR.len > end) break
        const id = idR.value
        const headerLen = idR.len + sizeR.len
        const valueStart = p + headerLen
        const hasData = sizeR.unknown || valueStart + sizeR.value <= end
        if (!hasData) break
        if (id === EBML.Timestamp && sizeR.value <= 8) {
          let v = 0
          for (let i = 0; i < sizeR.value; i++) v = v * 256 + this.buf[valueStart + i]
          clusterTs = v
          if (this.debug) console.log('[subs] cluster ts=' + v)
        } else if (id === EBML.SimpleBlock) {
          this._parseBlock(valueStart, sizeR.value, clusterTs, null)
        } else if (id === EBML.BlockGroup) {
          this._parseBlockGroup(valueStart, sizeR.value, clusterTs)
        }
        if (sizeR.value == null) p = valueStart
        else p = valueStart + sizeR.value
      }
    }

    _parseBlockGroup(dataStart, dataLen, clusterTs) {
      const end = Math.min(this.buf.length, dataStart + dataLen)
      let p = dataStart
      let duration = null
      let blockStart = null
      let blockLen = null
      while (p + 2 <= end) {
        const idR = readVint(this.buf, p)
        if (!idR || p + idR.len + 1 > end) break
        const sizeR = readVint(this.buf, p + idR.len, { mask: true })
        if (!sizeR || p + idR.len + sizeR.len + sizeR.value > end) break
        if (idR.value === EBML.Block) {
          blockStart = p + idR.len + sizeR.len
          blockLen = sizeR.value
        } else if (idR.value === EBML.BlockDuration && sizeR.value <= 8) {
          let v = 0
          for (let i = 0; i < sizeR.value; i++) v = v * 256 + this.buf[p + idR.len + sizeR.len + i]
          duration = v
        }
        p += idR.len + sizeR.len + sizeR.value
      }
      if (blockStart != null && blockLen != null) this._parseBlock(blockStart, blockLen, clusterTs, duration)
    }

    _parseBlock(dataStart, dataLen, clusterTs, blockDuration) {
      if (dataLen < 4) return
      const trackR = readVint(this.buf, dataStart, { mask: true })
      if (!trackR || trackR.len + 2 > dataLen) return
      const trackNumber = trackR.value
      const info = this.subtitleTracks.get(trackNumber)
      if (!info) return
      // Block/SimpleBlock 头：TrackNumber(vint) -> Timestamp(2 字节有符号) -> Flags(1 字节)
      const tsOffset = dataStart + trackR.len
      const flags = this.buf[tsOffset + 2]
      const rel = (this.buf[tsOffset] << 8) | this.buf[tsOffset + 1]
      const relSigned = rel > 0x7fff ? rel - 0x10000 : rel
      const lacing = (flags >> 1) & 0x03
      let p = tsOffset + 3
      const blockEnd = dataStart + dataLen
      const frames = []
      if (lacing === 0) {
        frames.push(this.buf.subarray(p, blockEnd))
      } else if (p < blockEnd) {
        const frameCount = this.buf[p] + 1
        p++
        if (lacing === 1) { // Xiph
          const sizes = []
          let sp = p
          for (let i = 0; i < frameCount - 1 && sp < blockEnd; i++) {
            let size = 0
            for (;;) {
              if (sp >= blockEnd) break
              const b = this.buf[sp++]
              size += b
              if (b !== 255) break
            }
            sizes.push(size)
          }
          p = sp
          for (let i = 0; i < frameCount; i++) {
            const len = i < frameCount - 1 ? sizes[i] : Math.max(0, blockEnd - p)
            frames.push(this.buf.subarray(p, Math.min(blockEnd, p + len)))
            p += len
          }
        } else if (lacing === 2) { // 固定长度
          const size = Math.max(1, Math.floor((blockEnd - p) / frameCount))
          for (let i = 0; i < frameCount; i++) {
            frames.push(this.buf.subarray(p, Math.min(blockEnd, p + size)))
            p += size
          }
        } else { // EBML 差分
          const sizes = []
          let prev = null
          for (let i = 0; i < frameCount && p < blockEnd; i++) {
            const szR = readVint(this.buf, p, { mask: true })
            if (!szR) break
            p += szR.len
            if (i === 0) {
              prev = szR.value
              sizes.push(prev)
            } else {
              const dataBits = 7 * szR.len - 1
              const signMask = 1 << dataBits
              let delta = szR.value
              if (delta & signMask) delta = -(delta & (signMask - 1))
              prev = Math.max(0, prev + delta)
              sizes.push(prev)
            }
          }
          for (let i = 0; i < sizes.length; i++) {
            const len = i < sizes.length - 1 ? sizes[i] : Math.max(0, blockEnd - p)
            frames.push(this.buf.subarray(p, Math.min(blockEnd, p + len)))
            p += len
          }
        }
      }
      const start = (clusterTs + relSigned) * this.timecodeScale / 1e9
      let end = blockDuration != null
        ? start + blockDuration * this.timecodeScale / 1e9
        : start + 3
      if (this.debug) console.log('[subs] block track=' + trackNumber + ' ts=' + clusterTs + ' rel=' + relSigned + ' lacing=' + lacing + ' start=' + start.toFixed(3) + ' frames=' + frames.length)
      for (const payload of frames) {
        const cue = this._toCue(info, payload, start, end)
        if (!cue) continue
        const pending = this.pendingCues.get(trackNumber)
        if (pending) {
          // 用下一条的开始时间收口上一条（SRT 常见）
          if (cue.start > pending.start && cue.start < pending.end) {
            pending.end = cue.start
          }
          this._emit(pending, trackNumber)
        }
        this.pendingCues.set(trackNumber, cue)
      }
    }

    _toCue(info, payload, fallbackStart, fallbackEnd) {
      const text = this._decode(payload)
      if (!text || !text.trim()) return null
      if (info.codecId === 'S_TEXT/ASS') {
        let found = null
        for (const line of text.split(/\r?\n/)) {
          const cue = this._assLine(line, fallbackStart, fallbackEnd)
          if (cue) found = cue
        }
        return found
      }
      // SRT：某些封装会连时间轴一起存；大多数只存纯文本
      const timing = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(text)
      if (timing) {
        const start = hmsToSec(timing[1], timing[2], timing[3], timing[4].padEnd(3, '0'))
        const end = hmsToSec(timing[5], timing[6], timing[7], timing[8].padEnd(3, '0'))
        const body = text.split(/\r?\n/)
          .filter((l) => !/^\d+$/.test(l.trim()) && !/-->/.test(l))
          .join('\n')
          .replace(/\|/g, '\n')
          .trim()
        if (!body) return null
        return { start, end: end > start ? end : fallbackEnd, text: escapeVtt(body) }
      }
      const t = escapeVtt(text.trim().replace(/\|/g, '\n'))
      if (!t) return null
      return { start: fallbackStart, end: fallbackEnd > fallbackStart ? fallbackEnd : fallbackStart + 3, text: t }
    }

    _assLine(line, fallbackStart, fallbackEnd) {
      const m = /^Dialogue\s*:\s*(.*)$/.exec(line)
      if (m) {
        const parts = m[1].split(',')
        if (parts.length < 10) return null
        const start = assTsToSec(parts[1])
        const end = assTsToSec(parts[2])
        const text = cleanAssText(parts.slice(9).join(','))
        if (!text) return null
        const s = start != null ? start : fallbackStart
        const e = end != null && end > s ? end : (fallbackEnd > s ? fallbackEnd : s + 3)
        return { start: s, end: e, text: escapeVtt(text) }
      }
      const parts = line.split(',')
      // 带时间戳但没有 Dialogue 前缀：Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
      if (parts.length >= 10 && assTsToSec(parts[1]) != null && assTsToSec(parts[2]) != null) {
        const start = assTsToSec(parts[1])
        const end = assTsToSec(parts[2])
        const text = cleanAssText(parts.slice(9).join(','))
        if (!text) return null
        const s = start != null ? start : fallbackStart
        const e = end != null && end > s ? end : (fallbackEnd > s ? fallbackEnd : s + 3)
        return { start: s, end: e, text: escapeVtt(text) }
      }
      // mkvmerge 封装：去掉 "Dialogue:" 前缀和时间戳，时间移入 MKV Block 时间码，
      // 载荷格式为 ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
      if (parts.length >= 9 && !/\d+:\d{2}:\d{2}[.:]\d{2}/.test(line)) {
        const text = cleanAssText(parts.slice(8).join(','))
        if (!text) return null
        const s = fallbackStart
        const e = fallbackEnd > s ? fallbackEnd : s + 3
        return { start: s, end: e, text: escapeVtt(text) }
      }
      return null
    }

    _emit(cue, trackNumber) {
      if (this.stopped || !cue || cue.end <= cue.start) return
      this.cueCount++
      if (this.opts.onCue) {
        try { this.opts.onCue(cue, trackNumber) } catch (e) { /* 忽略 */ }
      }
    }

    _flushPending() {
      for (const [trackNumber, cue] of this.pendingCues) {
        this._emit(cue, trackNumber)
      }
      this.pendingCues.clear()
    }
  }

  return {
    extract(opts) {
      return new MkvSubtitleExtractor(opts).start()
    },
  }
})
