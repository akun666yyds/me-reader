'use strict';

/**
 * Markdown / 数据文档工具箱（纯函数，可单测、零依赖）
 *
 * agent 的「整理文档」能力全部落在这里：规范化排版、大纲与编号、表格对齐、
 * frontmatter、目录生成、图片与内联资源嵌入、本地链接体检、JSON/XML 校验美化、
 * H5 项目脚手架。规则化处理优先，模型只负责决定「做什么」，不负责逐字符排版。
 */

const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;
const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

function toLf(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n');
}

/** ---------- 规范化排版 ---------- */

function formatMarkdown(src, opts = {}) {
  const o = { headingBlankLine: true, listMarker: '-', tableAlign: true, trailingSpaces: true, finalNewline: true, numberHeadings: false, maxConsecutiveBlankLines: 1, ...opts };
  let text = toLf(src);

  const fences = [];
  text = text.replace(/^(```|~~~)[\s\S]*?^\1[ \t]*$/gm, (m) => {
    fences.push(m);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });
  const tables = [];
  if (o.tableAlign) {
    text = text.replace(/(?:^[ \t]*\|.*\|[ \t]*\n?)+/gm, (m) => {
      if (!m.includes('-')) return m;
      tables.push(m);
      return `\u0000TABLE${tables.length - 1}\u0000`;
    });
  }

  const lines = text.split('\n').map((l) => (o.trailingSpaces ? l.replace(/[ \t]+$/, '') : l.replace(/\s+$/, '')));
  const out = [];
  let prevBlank = true;
  let inFront = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (i === 0 && line === '---') inFront = true;
    if (inFront) {
      out.push(line);
      if (line === '---' && i > 0) inFront = false;
      continue;
    }

    if (/^\s*$/.test(line)) {
      const next = lines.slice(i + 1).find((x) => x.trim() !== '');
      const nextIsList = next != null && /^\s*([-*+]|\d+\.)\s/.test(next);
      const curIsList = i > 0 && /^\s*([-*+]|\d+\.)\s/.test(lines[i - 1]);
      const bothLists = curIsList && nextIsList;
      if (bothLists && /^\s*([-*+]|\d+\.)\s/.test(lines[i - 1] || '')) {
        if (out.length && !/^\s*$/.test(out[out.length - 1])) out.push('');
        continue;
      }
      if (!out.length) continue;
      if (!/^\s*$/.test(out[out.length - 1])) out.push('');
      prevBlank = true;
      continue;
    }

    // 只有「#」紧跟正文（既不是空格也不是 #）时才补空格，避免把 ## 误改成 # #
    if (/^#{1,6}(?=[^#\s])/.test(line)) line = line.replace(/^(#{1,6})/, '$1 ');
    const isHeading = /^#{1,6}\s/.test(line);
    if (isHeading) {
      if (o.headingBlankLine && out.length && !/^\s*$/.test(out[out.length - 1])) out.push('');
    }
    if (/^\s*([*_]{3,}|[-_]{3,})\s*$/.test(line)) line = '---';
    if (/^\s*([-+*])\s+/.test(line) && o.listMarker) line = line.replace(/^(\s*)[-+*](\s+)/, `$1${o.listMarker}$2`);

    const blank = /^\s*$/.test(line);
    if (blank && prevBlank) continue;
    prevBlank = blank;
    out.push(line);

    // 标题后补空行（下一个非空行存在且不是紧邻的标题时）
    if (isHeading && o.headingBlankLine) {
      const next = lines[i + 1];
      if (next != null && !/^\s*$/.test(next) && !/^#{1,6}(\s|$)/.test(next)) {
        out.push('');
        prevBlank = true;
      }
    }
    continue;
  }

  let result = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (o.numberHeadings) result = numberHeadings(result);
  result = result.replace(/\u0000TABLE(\d+)\u0000/g, (_m, i) => alignTable(tables[+i]).trimEnd());
  result = result.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[+i]);
  if (o.finalNewline && !result.endsWith('\n')) result += '\n';
  return result.replace(/^\n+/, '');
}

/** 一级到六级标题依次编号（不改代码块与 frontmatter） */
function numberHeadings(src) {
  const lines = toLf(src).split('\n');
  const counters = [0, 0, 0, 0, 0, 0];
  let inFence = false;
  return lines
    .map((line) => {
      if (/^(```|~~~)/.test(line.trim())) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      if (!m) return line;
      const depth = m[1].length - 1;
      counters[depth] += 1;
      for (let i = depth + 1; i < 6; i++) counters[i] = 0;
      const num = counters.slice(0, depth + 1).join('.');
      const title = m[2].replace(/^\d+(\.\d+)*[\s.、]+/, '');
      return `${m[1]} ${num} ${title}`;
    })
    .join('\n');
}

/** ---------- 大纲 ---------- */

function headings(src) {
  const lines = toLf(src).split('\n');
  const out = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    if (inFence) return;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, title: m[2], line: i + 1 });
  });
  return out;
}

function buildToc(src, { title = '目录', maxLevel = 3, startLevel = 2, numbered = false } = {}) {
  const hs = headings(src).filter((h) => h.level <= maxLevel);
  if (!hs.length) return '';
  const rows = hs.map((h, idx) => {
    const indent = '  '.repeat(Math.max(0, h.level - startLevel));
    const label = h.title.replace(/[[\]]/g, '');
    return `${indent}- ${numbered ? `${idx + 1}. ` : ''}[${label}](#${slug(h.title)})`;
  });
  return `## ${title}\n\n${rows.join('\n')}\n`;
}

/** GitHub 风格锚点：小写、空格转连字符、去掉非字词字符（保留中文与连字符） */
function slug(title) {
  return String(title)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s._-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/** ---------- 表格 ---------- */

function parseTable(block) {
  const rows = toLf(block)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  if (rows.length < 2) return null;
  const sepIdx = rows.findIndex((r) => r.length > 0 && r.every((c) => /^:?-+:?$/.test(c)));
  if (sepIdx < 0) return null;
  const header = rows.slice(0, sepIdx).flat();
  const align = rows[sepIdx].map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'));
  // 记录哪些列显式写了冒号，重排时不能把对齐意图丢掉
  const explicit = rows[sepIdx].map((c) => /^:.*:?$/.test(c) || /^.*:$/.test(c));
  const body = rows.slice(sepIdx + 1);
  return { header, align, explicit, body };
}

function alignTable(block) {
  const t = parseTable(block);
  if (!t) return block;
  const width = Math.max(t.header.length, ...t.body.map((r) => r.length));
  const header = padRow(t.header, width);
  const body = t.body.map((r) => padRow(r, width));
  const widths = [];
  for (let c = 0; c < width; c++) {
    widths[c] = Math.max(displayWidth(header[c]), ...body.map((r) => displayWidth(r[c] || '')), 3);
  }
  const line = (cells, aligns) => `| ${cells.map((c, i) => fill(c || '', widths[i], aligns ? aligns[i] : 'left')).join(' | ')} |`;
  const sep = `| ${widths.map((w, i) => {
    const a = t.align[i] || 'left';
    const has = (t.explicit || [])[i];
    // 冒号算在列宽内，保证整行宽度与其它行一致
    if (a === 'center') return `:${'-'.repeat(Math.max(1, w - 2))}:`;
    if (a === 'right') return `${'-'.repeat(w - 1)}:`;
    return has ? `:${'-'.repeat(w - 1)}` : '-'.repeat(w);
  }).join(' | ')} |`;
  return `${line(header)}\n${sep}\n${body.map((r) => line(r)).join('\n')}\n`;
}

function rowsToTable(rows, { header } = {}) {
  const data = (rows || []).map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : splitRow(String(r))));
  if (!data.length) return '';
  const head = header ? (Array.isArray(header) ? header.map(String) : splitRow(String(header))) : data[0];
  const body = header ? data : data.slice(1);
  const width = Math.max(head.length, ...body.map((r) => r.length));
  const lines = [head, Array.from({ length: width }, () => '---'), ...body].map((r) => `| ${padRow(r, width).join(' | ')} |`);
  return alignTable(`${lines.join('\n')}\n`);
}

function splitRow(s) {
  return s.split(/[,\t]/).map((c) => c.trim());
}

function padRow(row, width) {
  const cells = row.slice(0, width);
  while (cells.length < width) cells.push('');
  return cells;
}
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return Math.max(w, [...String(s)].length === 0 ? 0 : w);
}
function fill(s, width, align) {
  const gap = Math.max(0, width - displayWidth(s));
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + s + ' '.repeat(gap - Math.floor(gap / 2));
  return s + ' '.repeat(gap);
}

/** ---------- frontmatter ---------- */

function splitFrontMatter(src) {
  const text = toLf(src);
  if (!text.startsWith('---\n')) return { data: null, body: text, raw: '' };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { data: null, body: text, raw: '' };
  const raw = text.slice(0, end + 4);
  const body = text.slice(end + 4).replace(/^\n/, '');
  return { data: parseSimpleYaml(raw.replace(/^---\n/, '').replace(/\n---\s*$/, '')), body, raw };
}

/** 只做一层 key: value / 列表 / 嵌套块的轻量解析，避免引入 YAML 依赖 */
function parseSimpleYaml(block) {
  const out = {};
  let currentKey = null;
  for (const line of toLf(block).split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && currentKey) {
      if (!Array.isArray(out[currentKey])) out[currentKey] = [];
      out[currentKey].push(stripQuotes(li[1]));
      continue;
    }
    const kv = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const val = kv[2].trim();
      currentKey = val === '' ? key : null;
      if (val !== '') out[key] = coerce(val);
      else out[key] = [];
    }
  }
  return out;
}

function coerce(v) {
  const s = stripQuotes(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v)) {
    try {
      return JSON.parse(v.replace(/'/g, '"'));
    } catch {
      return s.slice(1, -1).split(',').map((x) => coerce(x.trim()));
    }
  }
  return s;
}
function stripQuotes(s) {
  return String(s).replace(/^["']|["']$/g, '');
}

function dumpFrontMatter(data) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data || {})) {
    if (Array.isArray(v)) {
      if (!v.length) {
        lines.push(`${k}: []`);
        continue;
      }
      lines.push(`${k}:`);
      v.forEach((x) => lines.push(`  - ${fmtScalar(x)}`));
    } else lines.push(`${k}: ${fmtScalar(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}
function fmtScalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v == null ? '' : v);
  return /[:#\n"]/.test(s) ? JSON.stringify(s) : s;
}

function setFrontMatter(src, patch) {
  const { data, body } = splitFrontMatter(src);
  const merged = { ...(data || {}), ...patch };
  for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
  return `${dumpFrontMatter(merged)}\n\n${body.replace(/^---\n[\s\S]*?\n---\n?/, '')}`.trimEnd() + '\n';
}

/** ---------- 链接与图片 ---------- */

/** 收集行内/引用链接与图片的目标（相对路径供体检使用） */
function collectLinks(src) {
  const { body } = splitFrontMatter(src);
  const out = [];
  const re = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  let m;
  while ((m = re.exec(body))) {
    out.push({ image: m[1] === '!', alt: m[2], target: m[3], index: m.index });
  }
  const ref = /^\s*\[([^\]]+)\]:\s*(\S+)/gm;
  while ((m = ref.exec(body))) out.push({ image: false, alt: m[1], target: m[2], reference: true });
  const htmlImg = /<img[^>]+src=["']([^"']+)["']/gi;
  while ((m = htmlImg.exec(body))) out.push({ image: true, alt: '', target: m[1], html: true });
  return out;
}

function isRemote(target) {
  return /^(https?:|data:|mailto:|tel:|#|\/\/)/i.test(target);
}

/** 生成图片引用；inline=true 时输出 base64 内联资源 */
function imageRef(alt, src, { title, width, inline, dataUrl, align } = {}) {
  const text = inline && dataUrl ? dataUrl : String(src || '');
  if (width || align === 'center') {
    const style = [width ? `max-width:${width}px` : '', align === 'center' ? 'display:block;margin:1em auto' : ''].filter(Boolean).join(';');
    return `<img src="${escAttr(text)}" alt="${escAttr(alt)}"${title ? ` title="${escAttr(title)}"` : ''} style="${style}" />`;
  }
  // 路径含空格时用 <> 包裹（CommonMark 支持），标题始终放在空格后的引号里
  const target = !inline && /\s/.test(text) ? `<${text}>` : text;
  return `![${alt}](${target}${title ? ` "${escAttr(title)}"` : ''})`;
}

function toDataUrl(buffer, mime) {
  const type = mime || 'image/png';
  return `data:${type};base64,${buffer.toString('base64')}`;
}

function escAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** ---------- 文本统计与转换 ---------- */

function stripMarkdown(src) {
  const { body } = splitFrontMatter(src);
  return body
    .replace(/^(```|~~~)[\s\S]*?^\1[ \t]*$/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*[-*+]\s+(\[[ xX]\]\s*)?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/^\|.*\|$/gm, '')
    .trim();
}

function countWords(src) {
  const text = stripMarkdown(src);
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9_'-]+/g) || []).length;
  return { total: cjk + latin, cjk, latin, chars: text.replace(/\s/g, '').length, lines: toLf(src).split('\n').length };
}

/** 把文档按标题切成章节（RAG 分块与结构调整复用） */
function sections(src, { maxLevel = 6 } = {}) {
  const lines = toLf(src).split('\n');
  const out = [];
  let cur = { level: 0, title: '', startLine: 1, lines: [] };
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^(```|~~~)/.test(line.trim())) inFence = !inFence;
    const m = !inFence && line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m && m[1].length <= maxLevel) {
      if (cur.lines.length || cur.title) out.push(finishSection(cur, i));
      cur = { level: m[1].length, title: m[2], startLine: i + 1, lines: [line] };
    } else cur.lines.push(line);
  });
  if (cur.lines.length || cur.title) out.push(finishSection(cur, lines.length));
  return out;

  function finishSection(s, endIdx) {
    return { level: s.level, title: s.title, startLine: s.startLine, endLine: endIdx, text: s.lines.join('\n').trim() };
  }
}

/** 按 token 预算把长文本切成带重叠的分块（中文按字、英文按词近似） */
function chunkForEmbedding(text, { tokens = 360, overlap = 60 } = {}) {
  const clean = toLf(text);
  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = [];
  let bufTokens = 0;
  const push = () => {
    if (!buf.length) return;
    chunks.push(buf.join('\n\n'));
    const carry = [];
    let carryTokens = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
      const t = estimateTokens(buf[i]);
      if (carryTokens + t > overlap) break;
      carry.unshift(buf[i]);
      carryTokens += t;
    }
    buf = carry;
    bufTokens = carryTokens;
  };
  for (const p of paragraphs) {
    const t = estimateTokens(p);
    if (t > tokens) {
      const pieces = splitByTokens(p, tokens);
      for (const piece of pieces) {
        if (bufTokens + estimateTokens(piece) > tokens) push();
        buf.push(piece);
        bufTokens += estimateTokens(piece);
      }
      continue;
    }
    if (bufTokens + t > tokens) push();
    buf.push(p);
    bufTokens += t;
  }
  push();
  return chunks;
}

function splitByTokens(text, tokens) {
  const sentences = text.split(/(?<=[。！？；.!?;\n])/);
  const out = [];
  let cur = '';
  for (const s of sentences) {
    if (estimateTokens(cur + s) > tokens && cur) {
      out.push(cur.trim());
      cur = s;
    } else cur += s;
    if (estimateTokens(cur) > tokens * 2) {
      out.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.length ? out : [text];
}

/** 粗略 token 估算：中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token */
function estimateTokens(text) {
  const s = toLf(text);
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const other = s.length - cjk;
  return Math.max(1, Math.round(cjk + other / 4));
}

/** ---------- JSON / XML 数据文档 ---------- */

function tidyJson(src, { indent = 2 } = {}) {
  const text = toLf(src).trim();
  try {
    return JSON.stringify(JSON.parse(text), null, indent) + '\n';
  } catch (err) {
    throw new Error(`JSON 无效：${err.message}`);
  }
}

function validateJson(src) {
  try {
    const data = JSON.parse(toLf(src).trim());
    return { ok: true, type: Array.isArray(data) ? 'array' : typeof data, keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 40) : [], count: Array.isArray(data) ? data.length : undefined };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 轻量 XML 校验：标签配对 + 声明 + 实体，不做完整 DTD 解析 */
function validateXml(src) {
  const text = toLf(src);
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  const stack = [];
  const errors = [];
  const re = /<(\/?)([A-Za-z_][\w.\-]*(?::[\w.\-]+)?)([^>]*?)(\/?)>/g;
  let m;
  let seen = 0;
  while ((m = re.exec(stripped))) {
    seen++;
    const [, close, name, attrs, self] = m;
    const line = stripped.slice(0, m.index).split('\n').length;
    if (close) {
      const top = stack.pop();
      if (!top) errors.push(`第 ${line} 行：多余的结束标签 </${name}>`);
      else if (top.name !== name) errors.push(`第 ${line} 行：标签不匹配，<${top.name}>（第 ${top.line} 行）遇到 </${name}>`);
    } else if (!self) {
      stack.push({ name, line });
    }
    if (/\sxmlns(:[\w.\-]+)?=/.test(attrs)) continue;
  }
  if (!seen && text.trim()) errors.push('未找到任何标签');
  stack.forEach((s) => errors.push(`第 ${s.line} 行：<${s.name}> 没有结束标签`));
  // XML 只允许 5 个预定义命名实体与数字引用；&copy; 之类在 XML 里是非法的
  const entRe = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;
  while ((m = entRe.exec(text))) {
    if (m[1][0] === '#') continue;
    if (!XML_ENTITIES.has(m[1])) errors.push(`实体引用无效：&${m[1]};`);
  }
  return { ok: !errors.length, errors: errors.slice(0, 20), elements: seen };
}

function tidyXml(src) {
  const text = toLf(src).replace(/>\s+</g, (m) => (/^\s*\n/.test(m) ? m : '><'));
  const parts = text.replace(/></g, '>\n<').split('\n').filter((l) => l.trim() !== '');
  let depth = 0;
  return parts
    .map((raw) => {
      const line = raw.trim();
      if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
      const out = '  '.repeat(depth) + line;
      if (/^<[^!?/?][^>]*[^/]>$/.test(line) && !/<\/.+>/.test(line) && !/<[A-Za-z_][^>]*>[^<]+<\/[^>]+>$/.test(line)) depth++;
      return out;
    })
    .join('\n') + '\n';
}

/** ---------- H5 项目脚手架 ---------- */

function h5Scaffold({ title = 'MeReader H5', theme = 'light' }) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escAttr(title)}</title>
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  <main id="app">
    <h1>${escAttr(title)}</h1>
    <p>由 MeReader 的 Ollab 助手生成的本地 H5 页面。</p>
    <button id="action" type="button">点我</button>
    <p id="output" aria-live="polite"></p>
  </main>
  <script src="app.js"></script>
</body>
</html>
`;
  const css = `:root {
  color-scheme: ${theme === 'dark' ? 'dark' : 'light'};
  --bg: ${theme === 'dark' ? '#1e1e1e' : '#ffffff'};
  --fg: ${theme === 'dark' ? '#e4e4e4' : '#24292f'};
  --accent: #0f6cbd;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: system-ui, "Microsoft YaHei UI", sans-serif;
  background: var(--bg);
  color: var(--fg);
}

#app { max-width: 640px; padding: 32px; text-align: center; }
h1 { font-size: 28px; margin: 0 0 12px; }
button {
  font: inherit;
  padding: 8px 20px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}
button:hover { filter: brightness(1.08); }
#output { margin-top: 16px; min-height: 1.5em; }
`;
  const js = `const btn = document.getElementById('action');
const out = document.getElementById('output');
let count = 0;

btn.addEventListener('click', () => {
  count += 1;
  out.textContent = \`已点击 \${count} 次\`;
});
`;
  return { 'index.html': html, 'style.css': css, 'app.js': js };
}

module.exports = {
  MD_EXT_RE,
  toLf,
  formatMarkdown,
  numberHeadings,
  headings,
  buildToc,
  slug,
  parseTable,
  alignTable,
  rowsToTable,
  splitFrontMatter,
  dumpFrontMatter,
  setFrontMatter,
  collectLinks,
  isRemote,
  imageRef,
  toDataUrl,
  stripMarkdown,
  countWords,
  sections,
  chunkForEmbedding,
  estimateTokens,
  tidyJson,
  validateJson,
  validateXml,
  tidyXml,
  h5Scaffold,
  displayWidth
};
