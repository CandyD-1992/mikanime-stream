import * as cheerio from 'cheerio';

// 蜜柑站点的多个可用域名：一个解析不了/被墙时自动换下一个。
// 可用环境变量覆盖：
//   MIKAN_BASE=https://mikanani.me          只用一个地址
//   MIKAN_BASES=https://a.tv,https://b.me   按顺序尝试多个地址
const DEFAULT_BASES = ['https://mikanime.tv', 'https://mikanani.me'];
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function envBases() {
  const single = (process.env.MIKAN_BASE || '').trim().replace(/\/+$/, '');
  if (single) return [single];
  const many = (process.env.MIKAN_BASES || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return many.length ? many : DEFAULT_BASES;
}

function buildBases(preferred) {
  const bases = [];
  const push = (b) => {
    const clean = String(b || '').trim().replace(/\/+$/, '');
    if (clean && !bases.includes(clean)) bases.push(clean);
  };
  push(preferred);
  for (const b of envBases()) push(b);
  if (!bases.length) bases.push(...DEFAULT_BASES);
  return bases;
}

function withTimeout(ms, promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('请求超时');
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

function errDetail(err) {
  const cause = err && err.cause;
  const raw =
    (cause && (cause.code || cause.message)) ||
    (err && err.code) ||
    (err && err.message) ||
    String(err || '未知错误');
  return String(raw);
}

function extractHash(magnet) {
  const m = /btih:([0-9a-f]{40})/i.exec(magnet || '');
  return m ? m[1].toLowerCase() : null;
}

function parseMikanHtml(html, base) {
  const $ = cheerio.load(html);
  const items = [];

  $('tr.js-search-results-row').each((_i, tr) => {
    const $tr = $(tr);
    const magnet = $tr.find('input.js-episode-select').attr('data-magnet');
    const $title = $tr.find('a.magnet-link-wrap').first();
    const title = $title.text().trim();
    const href = $title.attr('href') || '';
    const hash = extractHash(href) || extractHash(magnet);
    const size = $tr.find('td').eq(2).text().trim();
    const date = $tr.find('td').eq(3).text().trim();
    const torrentHref = $tr.find('a[href*="/Download/"]').attr('href') || null;

    if (!magnet || !title || !hash) return;
    items.push({
      hash,
      title,
      size,
      date,
      magnet,
      torrentUrl: torrentHref ? base + torrentHref : null,
    });
  });

  return items;
}

export async function searchMikan(query, { limit = 300, base } = {}) {
  const bases = buildBases(base);

  const errors = [];
  let sawOkPage = false;
  let lastOkBase = bases[0];

  for (const b of bases) {
    try {
      const url = `${b}/Home/Search?searchstr=${encodeURIComponent(query)}`;
      const res = await withTimeout(15000, fetch(url, {
        headers: {
          'user-agent': UA,
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      }));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const items = parseMikanHtml(html, b);
      sawOkPage = true;
      lastOkBase = b;
      if (items.length) {
        return { items: items.slice(0, limit), source: b };
      }
      // 页面正常但 0 条结果：继续试下一个域名，避免单个域名返回“空结果页”误判
    } catch (err) {
      errors.push(`${b} -> ${errDetail(err)}`);
    }
  }

  // 至少有一个域名正常返回过页面（只是没有匹配结果），按正常空结果处理
  if (sawOkPage) return { items: [], source: lastOkBase };

  const message = '蜜柑站点全部不可达：' + errors.join('；');
  const err = new Error(message);
  err.details = errors;
  throw err;
}

export async function fetchMikanEpisode(hash, { base } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(String(hash || ''))) {
    throw new Error('无效的 infoHash');
  }
  const bases = buildBases(base);
  const errors = [];
  for (const b of bases) {
    try {
      const url = `${b}/Home/Episode/${hash}`;
      const res = await withTimeout(15000, fetch(url, {
        headers: {
          'user-agent': UA,
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      }));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const $ = cheerio.load(html);
      const magnet = $('a[href^="magnet:"]').first().attr('href') || null;
      if (!magnet) {
        errors.push(`${b} -> 页面没有磁力链接`);
        continue;
      }
      const title = $('p.bangumi-title').first().text().trim() || null;
      const episodeTitle = $('p.episode-title').first().text().trim() || null;
      const info = {};
      $('p.bangumi-info').each((_i, el) => {
        const t = $(el).text().replace(/\s+/g, ' ').trim();
        let m;
        if ((m = /^字幕组：\s*(.+)$/.exec(t))) info.group = m[1].trim();
        if ((m = /^发布日期：\s*(.+)$/.exec(t))) info.date = m[1].trim();
        if ((m = /^文件大小：\s*(.+)$/.exec(t))) info.size = m[1].trim();
      });
      let image = null;
      $('img[src*="_lg.jpg"]').each((_i, el) => {
        if (!image) image = $(el).attr('src');
      });
      if (image && !/^https?:/.test(image)) image = b + image;
      return {
        hash: String(hash).toLowerCase(),
        base: b,
        title,
        episodeTitle,
        group: info.group || null,
        date: info.date || null,
        size: info.size || null,
        image,
        magnet,
      };
    } catch (err) {
      errors.push(`${b} -> ${errDetail(err)}`);
    }
  }
  const message = '蜜柑详情页全部不可达：' + errors.join('；');
  const err = new Error(message);
  err.details = errors;
  throw err;
}
