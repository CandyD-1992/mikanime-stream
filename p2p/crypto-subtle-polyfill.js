// crypto.subtle 的 SHA-1 纯 JS 兜底实现。
//
// 原因：页面通过 http://局域网IP:端口 打开时（如 http://192.168.3.21:12348），
// 浏览器认为这不是“安全上下文”，不会提供 window.crypto.subtle。
// WebTorrent 用 SHA-1 校验种子元数据和每个分片，缺少 subtle 会导致：
//   连接数很多、但元数据永远收不到、下载速度恒为 0（控制台反复报 no web crypto support）。
// 本文件必须在 webtorrent / webtorrent-wasmnet 加载前执行，把 subtle 补上。
(function () {
  'use strict';

  function sha1Bytes(u8) {
    const len = u8.length;
    const ml = len * 8;
    const paddedLen = (((len + 1 + 8 + 63) >>> 6) << 6);
    const m = new Uint8Array(paddedLen);
    m.set(u8);
    m[len] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(paddedLen - 8, Math.floor(ml / 0x100000000));
    dv.setUint32(paddedLen - 4, ml >>> 0);

    let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    const w = new Uint32Array(80);

    for (let off = 0; off < paddedLen; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 80; i++) {
        const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (v << 1) | (v >>> 31);
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) {
          f = (b & c) | (~b & d);
          k = 0x5A827999;
        } else if (i < 40) {
          f = b ^ c ^ d;
          k = 0x6ED9EBA1;
        } else if (i < 60) {
          f = (b & c) | (b & d) | (c & d);
          k = 0x8F1BBCDC;
        } else {
          f = b ^ c ^ d;
          k = 0xCA62C1D6;
        }
        const temp = ((a << 5) | (a >>> 27)) + f + e + k + w[i];
        e = d;
        d = c;
        c = (b << 30) | (b >>> 2);
        b = a;
        a = temp;
      }
      h0 = (h0 + a) | 0;
      h1 = (h1 + b) | 0;
      h2 = (h2 + c) | 0;
      h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0;
    }

    const out = new Uint8Array(20);
    const odv = new DataView(out.buffer);
    odv.setUint32(0, h0);
    odv.setUint32(4, h1);
    odv.setUint32(8, h2);
    odv.setUint32(12, h3);
    odv.setUint32(16, h4);
    return out;
  }

  function polyfillSubtle() {
    return {
      digest(algorithm, data) {
        const name = (typeof algorithm === 'string' ? algorithm : (algorithm && algorithm.name) || '').toUpperCase();
        return Promise.resolve().then(() => {
          const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
          if (name !== 'SHA-1') throw new Error('Unsupported digest algorithm: ' + name);
          return sha1Bytes(bytes).buffer.slice(0);
        });
      },
    };
  }

  try {
    const has = typeof crypto !== 'undefined' && crypto;
    if (!has || !crypto.subtle || !crypto.subtle.digest) {
      const orig = has ? crypto : {};
      const replacement = {
        getRandomValues: orig.getRandomValues ? orig.getRandomValues.bind(orig) : null,
        randomUUID: orig.randomUUID ? orig.randomUUID.bind(orig) : undefined,
        subtle: polyfillSubtle(),
      };
      try {
        Object.defineProperty(self, 'crypto', { value: replacement, configurable: true, writable: true });
      } catch (e) {
        try { self.crypto = replacement; } catch (e2) { /* 忽略 */ }
      }
    }
  } catch (e) {
    /* 忽略 */
  }
})();
