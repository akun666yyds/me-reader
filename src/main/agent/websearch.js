'use strict';

/**
 * 健壮的免密钥 web-search 与网页读取
 *
 * 引擎按「本机实测可达性」排序：cn.bing.com / baidu / sogou 可达，
 * DuckDuckGo 在部分网络环境不可达（实测 HTTP 000），因此只作为可选兜底。
 * 任一引擎解析失败即自动切换下一个，全部失败时返回结构化错误而不是抛异常，
 * 让 agent 能把「搜索不可用」如实告诉用户。
 */

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ENGINES = [
  {
    id: 'bing',
    label: 'Bing 中国',
    build: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`,
    parse: (html) => {
      const out = [];
      const re = /<li class="b_algo[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>|([\s\S]{0,600}?))<\/li>/gi;
      let m;
      while ((m = re.exec(html)) && out.length < 12) {
        const url = decodeHtmlEntities(m[1]);
        if (!/^https?:/i.test(url) || url.includes('bing.com')) continue;
        out.push({ title: cleanText(m[2]).slice(0, 200), url, snippet: cleanText(m[3] || m[4] || '').slice(0, 400) });
      }
      return out;
    }
  },
  {
    id: 'baidu',
    label: '百度',
    build: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=10`,
    parse: (html) => {
      const out = [];
      const re = /<div[^>]*class="[^"]*(?:result|c-container)[^"]*"[\s\S]*?<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:data-desc=|aria-label=|<\/h3>)([\s\S]{0,900}?)<\/div>/gi;
      let m;
      while ((m = re.exec(html)) && out.length < 12) {
        const url = decodeHtmlEntities(m[1]);
        if (!/^https?:/i.test(url)) continue;
        const snippet = cleanText(m[3].replace(/<[^>]+>/g, ' ')).slice(0, 400);
        out.push({ title: cleanText(m[2]).slice(0, 200), url, snippet });
      }
      return out;
    }
  },
  {
    id: 'sogou',
    label: '搜狗',
    build: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
    parse: (html) => {
      const out = [];
      const re = /<h3 class="[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)/gi;
      let m;
      while ((m = re.exec(html)) && out.length < 12) {
        const url = absolutize(decodeHtmlEntities(m[1]), 'https://www.sogou.com');
        if (!/^https?:/i.test(url)) continue;
        if (/sogou\.com\/(web|link\?url=$)/i.test(url) && !/link\?url=/i.test(url)) continue;
        out.push({ title: cleanText(m[2]).slice(0, 200), url, snippet: cleanText(m[3] || '').slice(0, 400) });
      }
      return out;
    }
  },
  {
    id: 'ddg',
    label: 'DuckDuckGo',
    optional: true,
    build: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: (html) => {
      const out = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
      let m;
      while ((m = re.exec(html)) && out.length < 12) {
        let url = decodeHtmlEntities(m[1]);
        const mm = url.match(/[?&]uddg=([^&]+)/);
        if (mm) url = decodeURIComponent(mm[1]);
        if (!/^https?:/i.test(url)) continue;
        out.push({ title: cleanText(m[2]).slice(0, 200), url, snippet: cleanText(m[3] || '').slice(0, 400) });
      }
      return out;
    }
  }
];

async function httpGet(url, { timeoutMs = 12000, headers = {}, maxBytes = MAX_PAGE_BYTES } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6', Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', ...headers }
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const charset = detectCharset(res.headers.get('content-type'), buf);
    let text = buf.subarray(0, maxBytes).toString(charset === 'utf-8' ? 'utf8' : 'binary');
    if (charset !== 'utf-8') {
      try {
        text = new TextDecoder(charset).decode(buf.subarray(0, maxBytes));
      } catch {
        text = buf.subarray(0, maxBytes).toString('utf8');
      }
    }
    return { ok: res.ok, status: res.status, url: res.url, contentType: res.headers.get('content-type') || '', text, bytes: buf.length };
  } finally {
    clearTimeout(timer);
  }
}

function detectCharset(contentType, buf) {
  const m = /charset=([\w-]+)/i.exec(contentType || '');
  let cs = m ? m[1].toLowerCase() : '';
  if (!cs) {
    const head = buf.subarray(0, 2048).toString('latin1');
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
    cs = meta ? meta[1].toLowerCase() : '';
  }
  if (/^(gb2312|gbk|gb18030)$/.test(cs)) return 'gbk';
  if (/^(utf-8|utf8)$/.test(cs)) return 'utf-8';
  return 'utf-8';
}

function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** 去标签、解码实体、压缩空白 */
function cleanText(html) {
  return decodeHtmlEntities(
    String(html == null ? '' : html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '', zwj: '', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', dagger: '†', Dagger: '‡', permling: '‰', prime: '′', Prime: '″', saquo: '‹', sdquo: '›', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', times: '×', divide: '÷', deg: '°', plusmn: '±', laquo: '«', raquo: '»', rarr: '→', larr: '←', harr: '↔', arrows: '⇔', lArr: '⇒', rArr: '⇐', ne: '≠', le: '≤', ge: '≥', pm: '±', inset: '⊂', sup: '⊃', euro: '€', yen: '¥', ldquor: '”', rdquor: '”' };
function decodeHtmlEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] || m);
}
function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/** 提取网页正文（粗略但够用：去导航/脚本，保留段落与标题结构） */
function extractReadable(html, { maxChars = 6000 } = {}) {
  const title = cleanText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  const toText = (fragment) =>
    decodeHtmlEntities(
      String(fragment)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<(nav|footer|aside|header)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<h([1-6])[^>]*>/gi, (_m, l) => `\n${'#'.repeat(Number(l))} `)
        .replace(/<[^>]+>/g, ' ')
    )
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l && !/^(function|var |\.|\{|\}|@media)/.test(l))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');

  // <article>/<main> 有时只包住一小块内容，取信息量更大的那一版
  const scoped = /<article[\s\S]*?<\/article>/i.exec(html) || /<main[\s\S]*?<\/main>/i.exec(html);
  const variants = scoped ? [toText(scoped[0]), toText(html)] : [toText(html)];
  let text = variants[0];
  for (const v of variants) {
    if (v.length > text.length) text = v;
    if (text.length >= 600) break;
  }
  return { title, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

/** 百度/搜狗常给出 /link?url= 中转链，需要跟随一次才能拿到真实地址 */
function needsResolve(url) {
  return /\/link\?/i.test(url) || /^https?:\/\/[^/]*(baidu|sogou|so)\.com\/(link|shenghuo\/baidu|url)/i.test(url);
}

const NOISE_URL_RE = /(image\.baidu\.com|v\.baidu\.com\/video|\/baidu\/(tbk|xingtu)|360totalsecurity|adsense|\/ad\?|somarts\.cn)/i;

function dropNoise(results) {
  return results.filter((r) => r.url && !NOISE_URL_RE.test(r.url) && !/百度图片|广告|下载百度APP/.test(r.title || ''));
}

async function resolveRedirects(results, timeoutMs = 6000) {
  return Promise.all(
    results.map(async (r) => {
      if (!needsResolve(r.url)) return r;
      try {
        const res = await httpGet(r.url, { timeoutMs });
        if (res.url && res.url !== r.url && /^https?:/i.test(res.url) && !needsResolve(res.url)) {
          return { ...r, url: res.url, resolved: true };
        }
        // 部分引擎不发 HTTP 跳转，而是 JS/meta 跳转（搜狗即如此），从响应体里取真实地址
        const js = pickRedirectFromBody(res.text);
        if (js && !needsResolve(js)) return { ...r, url: js, resolved: true };
      } catch {}
      return { ...r, unresolved: true };
    })
  );
}

function pickRedirectFromBody(html) {
  const patterns = [
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["']\s*0\s*;\s*url=['"]?([^"'>\s]+)/i,
    /window\.location(?:\.replace|\.href)\s*=\s*["']([^"']+)["']/i,
    /(?:var|const|let)\s+(?:url|target_url)\s*=\s*["']([^"']+)["']/i
  ];
  for (const re of patterns) {
    const m = re.exec(html || '');
    if (m && /^https?:/i.test(m[1])) return decodeHtmlEntities(m[1]);
  }
  return null;
}

class WebSearch {
  constructor({ engines = ENGINES, timeoutMs = 12000, includeOptional = true } = {}) {
    this.engines = engines.filter((e) => (includeOptional ? true : !e.optional));
    this.timeoutMs = timeoutMs;
    this.attempts = [];
  }

  engineList() {
    return this.engines.map((e) => ({ id: e.id, label: e.label, optional: !!e.optional }));
  }

  /** 单引擎搜索 */
  async searchWith(engineId, query) {
    const engine = this.engines.find((e) => e.id === engineId);
    if (!engine) throw new Error(`未知搜索引擎：${engineId}`);
    const res = await httpGet(engine.build(query), { timeoutMs: this.timeoutMs });
    if (!res.ok) throw new Error(`${engine.label} 返回 ${res.status}`);
    const results = engine.parse(res.text) || [];
    return dropNoise(results).map((r) => ({ ...r, source: engine.id }));
  }

  /** 解析并还原中转链接（百度/搜狗），失败时保留原地址 */
  async searchResolved(query, { topK = 8, engine, timeoutMs } = {}) {
    const s = await this.search(query, { topK, engine, timeoutMs });
    if (!s.ok) return s;
    s.results = await resolveRedirects(s.results, timeoutMs || 6000);
    return s;
  }

  /**
   * 多引擎依次尝试；返回 { ok, results, engine, attempts, note }
   * 全失败不抛异常，便于 agent 优雅降级。
   */
  async search(query, { topK = 8, engine, timeoutMs } = {}) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: '搜索词为空', results: [] };
    const order = engine ? this.engines.filter((e) => e.id === engine) : this.engines;
    if (!order.length) return { ok: false, error: `搜索引擎不可用：${engine}`, results: [] };
    const attempts = [];
    const savedTimeout = this.timeoutMs;
    if (timeoutMs) this.timeoutMs = timeoutMs;
    try {
      for (const e of order) {
        try {
          const results = await this.searchWith(e.id, q);
          attempts.push({ engine: e.id, ok: true, count: results.length });
          if (results.length) {
            return { ok: true, query: q, engine: e.id, results: results.slice(0, topK), attempts };
          }
          attempts.push({ engine: e.id, ok: true, count: 0, note: '无结果，尝试下一个引擎' });
        } catch (err) {
          attempts.push({ engine: e.id, ok: false, error: String(err.message || err).slice(0, 200) });
        }
      }
    } finally {
      this.timeoutMs = savedTimeout;
    }
    const blocked = attempts.every((a) => !a.ok) && attempts.some((a) => /超时|status|返回 \d|fetch failed|ENOT/i.test(a.error || ''));
    return {
      ok: false,
      query: q,
      results: [],
      attempts,
      error: '所有搜索引擎均未返回结果。可能是网络不可达或被目标站点拦截，可尝试在设置里更换引擎或改用 web_fetch 直接读取已知网址。',
      hint: blocked ? 'connection-blocked' : 'empty'
    };
  }

  /** 搜索并抓取前 N 个页面正文，产出可直接进上下文的资料块 */
  async research(query, { topK = 5, readCount = 3, perPageChars = 2500 } = {}) {
    const s = await this.searchResolved(query, { topK });
    if (!s.ok) return s;
    const pages = [];
    for (const r of s.results.slice(0, readCount)) {
      try {
        const res = await httpGet(r.url, { timeoutMs: this.timeoutMs });
        if (!res.ok) {
          pages.push({ ...r, fetchError: `HTTP ${res.status}` });
          continue;
        }
        const isJson = /json/i.test(res.contentType);
        const extracted = isJson ? { title: r.title, text: res.text.slice(0, perPageChars) } : extractReadable(res.text, { maxChars: perPageChars });
        pages.push({ ...r, pageTitle: extracted.title, text: extracted.text, truncated: extracted.isJson ? false : extracted.truncated });
      } catch (err) {
        pages.push({ ...r, fetchError: String(err.message || err).slice(0, 160) });
      }
    }
    return { ...s, pages };
  }

  async fetch(url, { maxChars = 6000 } = {}) {
    const res = await httpGet(url, { timeoutMs: this.timeoutMs });
    const title = cleanText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(res.text) || [])[1] || '');
    if (/json/i.test(res.contentType)) return { ok: res.ok, status: res.status, url: res.url, contentType: res.contentType, title, text: res.text.slice(0, maxChars) };
    if (!/html|xml|text/i.test(res.contentType) && res.contentType) {
      return { ok: res.ok, status: res.status, url: res.url, contentType: res.contentType, title, text: '', note: `非文本内容（${res.contentType}，${res.bytes} 字节），未内联` };
    }
    const extracted = extractReadable(res.text, { maxChars });
    const note = extracted.text.length < 400 && /<div id="app"|window\.__NUXT__|__INITIAL_STATE__|<script[^>]*src="\/(assets|js)\//i.test(res.text)
      ? '该页面为前端渲染（SPA），静态抓取几乎取不到正文，建议换用其它来源或直接读取其接口/JSON。'
      : undefined;
    return { ok: res.ok, status: res.status, url: res.url, contentType: res.contentType, title: extracted.title || title, text: extracted.text, truncated: extracted.truncated, note };
  }
}

module.exports = { WebSearch, ENGINES, httpGet, extractReadable, cleanText, decodeHtmlEntities, needsResolve, resolveRedirects, pickRedirectFromBody, dropNoise, UA };
