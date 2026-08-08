// 浏览器端 MKV -> fMP4 流式无损封装播放器（不重编码、不落盘）
//
// 原理：
//   1. 用 Mediabunny 把 webtorrent 的 file 做成随机读取源（CustomSource）
//   2. 以与源相同的编码（avc/hevc/vp9/av1 + aac/opus/mp3/flac/ac3/eac3）直拷封装成 fMP4
//      （Mediabunny 检测到编码相同且无需缩放/旋转/裁剪时走"编码包直拷"快路径）
//   3. ftyp/moov 作为 init segment、moof/mdat 作为 media segment 喂给 MediaSource
//   4. 边下载边封装边播放；拖动进度条限制在已缓冲范围内
//
// 依赖：p2p/vendor/mediabunny.iife.min.js（全局 Mediabunny）
'use strict';

(function () {
  const SUPPORTED_VIDEO = new Set(['avc', 'hevc', 'vp9', 'av1']);
  const SUPPORTED_AUDIO = new Set(['aac', 'opus', 'mp3', 'flac', 'ac3', 'eac3']);

  class MikanMsePlayer {
    constructor() {
      this._reset();
    }

    _reset() {
      this._file = null;
      this._video = null;
      this._cb = null;
      this._input = null;
      this._conversion = null;
      this._output = null;
      this._mediaSource = null;
      this._sourceBuffer = null;
      this._objectUrl = null;
      this._stopped = false;
      this._failed = false;
      this._appendChain = Promise.resolve();
      this._initParts = [];
      this._fragParts = [];
      this._initFlushed = false;
      this._finished = false;
      this._streams = new Set();
      this._mime = null;
      this._bufferedEnd = 0;
      this._durationHint = null;
      this._startedAt = 0;
      this._subs = null;
      this._subtitleTrack = null;
      this._discardAudio = false;
      this._droppedAudio = null;
      this._keepBehindSec = 90;   // 播放进度往前保留多少秒的缓冲
      this._evictTimer = null;
      this._bitrateWindow = [];   // [时间戳, 该片段码率 bps]，用于监控面板显示实时码率
    }

    static loaded() {
      return typeof window !== 'undefined' && !!window.Mediabunny;
    }

    static canPlay(file) {
      const n = file && file.name ? file.name.toLowerCase() : '';
      return n.endsWith('.mkv');
    }

    getBufferedEnd() {
      return this._bufferedEnd;
    }

    isActive() {
      return !this._stopped && !!this._input;
    }

    // callbacks: { status(text), progress(fraction), ready(), error(err) }
    async play(file, video, cb) {
      this._reset();
      this._file = file;
      this._video = video;
      this._cb = cb || {};
      this._startedAt = Date.now();
      if (!MikanMsePlayer.loaded()) throw new Error('Mediabunny 加载失败');
      if (!file || typeof file.createReadStream !== 'function') {
        throw new Error('当前文件不支持流式读取');
      }

      const Mediabunny = window.Mediabunny;
      this._status('正在读取视频轨道…');

      // 1) 随机读取源：Mediabunny 按需向 webtorrent 要字节，未下载的分片会自动等待
      const source = new Mediabunny.CustomSource({
        getSize: () => file.length,
        read: (start, end) => this._readRange(start, end),
        maxCacheSize: 16 * 1024 * 1024,
        prefetchProfile: 'network',
      });
      const ext = String(file.name || '').toLowerCase();
      const formats = [];
      if (ext.endsWith('.mkv')) {
        formats.push(Mediabunny.MATROSKA);
      } else if (ext.endsWith('.webm')) {
        formats.push(Mediabunny.WEBM, Mediabunny.MATROSKA);
      } else if (ext.endsWith('.ts')) {
        formats.push(Mediabunny.MPEG_TS);
      } else {
        formats.push(Mediabunny.MP4, Mediabunny.QTFF);
      }
      this._input = new Mediabunny.Input({
        formats,
        source,
      });

      // 2) 解析轨道，判断编码是否支持
      const tracks = await this._input.getTracks();
      let videoTrack = null;
      let audioTrack = null;
      for (const t of tracks) {
        if (t.type === 'video' && !videoTrack) videoTrack = t;
        else if (t.type === 'audio' && !audioTrack) audioTrack = t;
      }
      if (!videoTrack && !audioTrack) {
        throw new Error('文件里没有可播放的视频或音轨');
      }
      if (videoTrack) {
        const codec = await videoTrack.codec;
        if (!SUPPORTED_VIDEO.has(codec)) {
          throw new Error('视频编码 ' + codec + ' 暂不支持网页直放（仅支持 H.264/HEVC/VP9/AV1）');
        }
      }
      let droppedAudio = null;
      if (audioTrack) {
        const codec = await audioTrack.codec;
        if (!SUPPORTED_AUDIO.has(codec)) {
          // 音轨不支持时先尝试“只看画面”的静音播放，而不是直接放弃整个文件
          droppedAudio = codec;
          audioTrack = null;
        }
      }
      const codecStrs = [];
      if (videoTrack) codecStrs.push(await videoTrack.getCodecParameterString());
      if (audioTrack) codecStrs.push(await audioTrack.getCodecParameterString());
      this._mime = (videoTrack ? 'video/mp4' : 'audio/mp4')
        + '; codecs="' + codecStrs.join(',') + '"';

      let mimeSupported = !!(window.MediaSource && window.MediaSource.isTypeSupported(this._mime));
      if (!mimeSupported && audioTrack && videoTrack) {
        // 某些浏览器不支持 AC-3/E-AC-3 等音频进 MSE：退一步只播视频（静音）
        const videoOnlyMime = 'video/mp4; codecs="' + (await videoTrack.getCodecParameterString()) + '"';
        if (window.MediaSource && window.MediaSource.isTypeSupported(videoOnlyMime)) {
          droppedAudio = droppedAudio || '当前浏览器不支持该音频编码组合';
          audioTrack = null;
          this._mime = videoOnlyMime;
          mimeSupported = true;
        }
      }
      if (!mimeSupported) {
        throw new Error('浏览器不支持该编码组合（' + this._mime + '）');
      }
      if (droppedAudio) {
        this._discardAudio = true;
        this._droppedAudio = droppedAudio;
        this._status('音频编码 ' + droppedAudio + ' 暂不支持，已自动静音播放（视频不受影响）');
      }

      // 时长提示（来自 MKV SegmentInfo，读取开销很小）；直播流/未知时长会返回 null
      try {
        const d = await this._input.getDurationFromMetadata();
        if (d && isFinite(d) && d > 0) this._durationHint = d;
      } catch (e) {
        this._durationHint = null;
      }

      // 3) 建立 MediaSource + SourceBuffer
      this._status('正在建立播放通道…');
      await this._openMediaSource(this._mime);
      this._startEvictTimer();

      // 3.5) 并行提取 MKV 内嵌字幕（ASS/SRT/WebVTT -> TextTrack，纯浏览器端）
      this._startSubtitleExtractor();

      // 4) 启动转换（不等待完成，转换过程中边封装边喂给播放器）
      this._conversionPromise = this._runConversion().catch((err) => {
        if (!this._stopped) this._fail(err);
      });

      this._status('正在缓存视频头部…');
      const { ready } = this._cb;
      if (ready) ready();
      return true;
    }

    _status(text) {
      if (this._cb && this._cb.status && !this._stopped) {
        try { this._cb.status(text); } catch (e) { /* 忽略 */ }
      }
    }

    _startSubtitleExtractor() {
      if (typeof window === 'undefined' || !window.MikanMkvSubs || !this._file) return;
      try {
        this._subs = window.MikanMkvSubs.extract({
          createReadStream: (opts) => this._file.createReadStream(opts),
          fileLength: this._file.length,
          onTrack: (info) => {
            if (this._stopped || this._subtitleTrack || !this._video) return;
            try {
              const track = this._video.addTextTrack('subtitles', info.label || '字幕', info.language || 'zh');
              track.mode = 'showing';
              this._subtitleTrack = track;
            } catch (e) { /* 忽略 */ }
          },
          onCue: (cue) => {
            if (this._stopped || !this._subtitleTrack) return;
            try {
              if (typeof VTTCue === 'function') {
                const c = new VTTCue(cue.start, cue.end, cue.text);
                this._subtitleTrack.addCue(c);
              }
            } catch (e) { /* 忽略 */ }
          },
        });
      } catch (e) {
        console.warn('[mse] 字幕提取未启动（不影响播放）:', e && e.message);
      }
    }

    // webtorrent 区间读取 -> WHATWG ReadableStream
    _readRange(start, end) {
      // webtorrent 的 end 是包含的，Mediabunny 的 end 是排他的
      const stream = this._file.createReadStream({ start, end: end - 1 });
      this._streams.add(stream);
      const drop = () => this._streams.delete(stream);
      stream.on('close', drop);
      stream.on('error', drop);
      return new ReadableStream({
        start(controller) {
          stream.on('data', (chunk) => {
            try {
              const view = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
              controller.enqueue(view);
            } catch (e) {
              try { controller.error(e); } catch (e2) { /* 忽略 */ }
            }
          });
          stream.on('end', () => {
            try { controller.close(); } catch (e) { /* 忽略 */ }
          });
          stream.on('error', (err) => {
            try { controller.error(err); } catch (e) { /* 忽略 */ }
          });
        },
        cancel() {
          try { stream.destroy(); } catch (e) { /* 忽略 */ }
        },
      });
    }

    _openMediaSource(mime) {
      return new Promise((resolve, reject) => {
        const ms = new MediaSource();
        this._mediaSource = ms;
        this._objectUrl = URL.createObjectURL(ms);
        this._video.src = this._objectUrl;
        ms.addEventListener('sourceopen', () => {
          try {
            if (this._durationHint && this._durationHint > 0 && isFinite(this._durationHint)) {
              try { ms.duration = this._durationHint; } catch (e) { /* 忽略 */ }
            }
            this._sourceBuffer = ms.addSourceBuffer(mime);
            this._sourceBuffer.mode = 'segments';
            this._sourceBuffer.addEventListener('updateend', () => {
              this._updateBufferedEnd();
            });
            this._sourceBuffer.addEventListener('error', () => {
              if (!this._stopped) this._fail(new Error('MSE 缓冲写入失败'));
            });
            resolve();
          } catch (e) {
            reject(e);
          }
        }, { once: true });
      });
    }

    async _runConversion() {
      const Mediabunny = window.Mediabunny;
      const format = new Mediabunny.Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: 1,
        onFtyp: (data) => { this._initParts.push(data.slice()); },
        onMoov: (data) => { this._initParts.push(data.slice()); },
        onMoof: (data) => {
          this._flushInit();
          this._flushFragment();
          this._fragParts.push(data.slice());
        },
        onMdat: (data) => { this._fragParts.push(data.slice()); },
      });
      this._output = new Mediabunny.Output({
        format,
        target: new Mediabunny.NullTarget(),
      });
      this._conversion = await Mediabunny.Conversion.init({
        input: this._input,
        output: this._output,
        tracks: 'primary',
        video: {},
        audio: this._discardAudio ? { discard: true } : {},
        showWarnings: false,
      });
      if (!this._conversion.isValid) {
        const reason = (this._conversion.discardedTracks || [])
          .map((d) => d.reason)
          .join(', ') || '未知原因';
        throw new Error('无法无损封装（' + reason + '）');
      }
      this._conversion.onProgress = (p) => {
        if (this._cb && this._cb.progress && !this._stopped) {
          try { this._cb.progress(p); } catch (e) { /* 忽略 */ }
        }
      };
      await this._conversion.execute();
      if (this._stopped) return;

      // 转换完成：补上最后的分片和 init，然后结束流
      this._flushInit();
      this._flushFragment();
      await this._drainAppends();
      if (this._stopped) return;
      this._finished = true;
      if (this._mediaSource && this._mediaSource.readyState === 'open') {
        try { this._mediaSource.endOfStream(); } catch (e) { /* 忽略 */ }
      }
      this._status('封装完成');
    }

    _flushInit() {
      if (this._initFlushed || !this._initParts.length || this._stopped) return;
      this._initFlushed = true;
      const parts = this._initParts;
      this._initParts = [];
      this._append(parts.length === 1 ? parts[0] : concatBytes(parts));
    }

    _flushFragment() {
      if (!this._fragParts.length || this._stopped) return;
      const parts = this._fragParts;
      this._fragParts = [];
      this._append(parts.length === 1 ? parts[0] : concatBytes(parts));
    }

    getPlaybackBitrate() {
      if (!this._bitrateWindow.length) return 0;
      const cutoff = Date.now() - 10000;
      const recent = this._bitrateWindow.filter(([t]) => t >= cutoff);
      if (!recent.length) return 0;
      return recent.reduce((s, [, b]) => s + b, 0) / recent.length;
    }

    // 定期清理播放进度之前的旧缓冲，避免 SourceBuffer 占满后 appendBuffer 失败
    _evictOldData() {
      return new Promise((resolve) => {
        const sb = this._sourceBuffer;
        const v = this._video;
        if (!sb || !v || this._stopped) return resolve();
        const t = v.currentTime;
        if (!t || !isFinite(t)) return resolve();
        if (sb.updating) {
          sb.addEventListener('updateend', () => this._evictOldData().then(resolve), { once: true });
          return;
        }
        let removed = false;
        try {
          const ranges = sb.buffered;
          const keepFrom = Math.max(0, t - this._keepBehindSec);
          for (let i = 0; i < ranges.length; i++) {
            const start = ranges.start(i);
            const end = ranges.end(i);
            // 播放点之前的旧缓冲：按时间点部分裁剪，而不是要求整块都在前面
            if (start + 0.5 < keepFrom) {
              sb.remove(start, Math.min(end, keepFrom));
              removed = true;
              break;
            }
          }
        } catch (e) {
          return resolve();
        }
        if (!removed) return resolve();
        sb.addEventListener('updateend', () => resolve(), { once: true });
      });
    }

    _startEvictTimer() {
      this._stopEvictTimer();
      this._evictTimer = setInterval(() => {
        if (this._stopped) return;
        this._appendChain = this._appendChain.then(() => this._evictOldData()).catch(() => {});
      }, 2000);
    }

    _stopEvictTimer() {
      if (this._evictTimer) {
        clearInterval(this._evictTimer);
        this._evictTimer = null;
      }
    }

    // 串行 append，避免 SourceBuffer 同时写入；返回的 Promise 在 updateend 后 resolve
    _append(bytes) {
      const run = this._appendChain
        .then(() => this._evictOldData())
        .then(() => new Promise((resolve) => {
        const sb = this._sourceBuffer;
        if (!sb || this._stopped || this._finished) {
          resolve();
          return;
        }
        const done = () => {
          sb.removeEventListener('updateend', done);
          sb.removeEventListener('error', done);
          const beforeEnd = this._bufferedEnd;
          this._updateBufferedEnd();
          const afterEnd = this._bufferedEnd;
          if (afterEnd > beforeEnd && bytes && bytes.length) {
            const sec = afterEnd - beforeEnd;
            if (sec > 0.01) {
              const now = Date.now();
              this._bitrateWindow.push([now, (bytes.length * 8) / sec]);
              const cutoff = now - 10000;
              this._bitrateWindow = this._bitrateWindow.filter(([t]) => t >= cutoff);
            }
          }
          resolve();
        };
        sb.addEventListener('updateend', done, { once: true });
        sb.addEventListener('error', done, { once: true });
        try {
          sb.appendBuffer(bytes);
        } catch (e) {
          sb.removeEventListener('updateend', done);
          sb.removeEventListener('error', done);
          resolve();
          if (!this._stopped) this._fail(e);
        }
      }));
      this._appendChain = run.catch(() => {});
      return run;
    }

    _drainAppends() {
      return this._appendChain.catch(() => {});
    }

    _updateBufferedEnd() {
      const sb = this._sourceBuffer;
      if (!sb || !sb.buffered || !sb.buffered.length) return;
      try {
        const n = sb.buffered.length;
        this._bufferedEnd = sb.buffered.end(n - 1);
      } catch (e) { /* 忽略 */ }
    }

    _fail(err) {
      if (this._failed || this._stopped) return;
      this._failed = true;
      const msg = (err && err.message) || String(err);
      if (this._cb && this._cb.error) {
        try { this._cb.error(new Error(msg)); } catch (e) { /* 忽略 */ }
      }
    }

    async stop() {
      this._stopped = true;
      this._stopEvictTimer();
      for (const s of this._streams) {
        try { s.destroy(); } catch (e) { /* 忽略 */ }
      }
      this._streams.clear();
      if (this._conversion) {
        try { await this._conversion.cancel(); } catch (e) { /* 忽略 */ }
      }
      this._conversion = null;
      this._output = null;
      if (this._input) {
        try { await this._input.dispose(); } catch (e) { /* 忽略 */ }
      }
      this._input = null;
      this._sourceBuffer = null;
      if (this._subs) {
        try { this._subs.stop(); } catch (e) { /* 忽略 */ }
        this._subs = null;
      }
      this._subtitleTrack = null;
      if (this._objectUrl) {
        URL.revokeObjectURL(this._objectUrl);
        this._objectUrl = null;
      }
      this._mediaSource = null;
    }
  }

  function concatBytes(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  window.MikanMsePlayer = MikanMsePlayer;
})();
