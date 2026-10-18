'use strict';

/**
 * 工具链（langchain 风格的 tool registry）
 *
 * 每个工具是一个自描述对象：JSON Schema 参数 + kind（决定是否审批）+ run(args, ctx)。
 * 所有文件操作都必须经 ctx.workspace 的沙箱解析，路径越界直接抛错；
 * 工具返回值统一为 { ok, content, data }，content 是喂回模型的文本，data 供 UI 渲染。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const md = require('./markdown');
const { ensureDir, readJson, writeJson } = require('./paths');

const READ_KINDS = new Set(['fs-read', 'rag', 'memory-read', 'plan', 'skill-read', 'info']);

function schema(props, required = []) {
  return { type: 'object', properties: props, required, additionalProperties: false };
}
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const arr = (description, items = { type: 'string' }) => ({ type: 'array', description, items });

function ok(content, data = null) {
  return { ok: true, content: typeof content === 'string' ? content : JSON.stringify(content, null, 2), data };
}
function fail(message, data = null) {
  return { ok: false, content: `错误：${message}`, error: message, data };
}

function relOf(ctx, args) {
  const target = args.path != null ? args.path : args.file != null ? args.file : args.rel;
  return String(target == null ? '' : target);
}

function fmtSize(n) {
  if (n == null) return '';
  if (n > 1048576) return `${(n / 1048576).toFixed(1)}MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

function safeStat(abs) {
  try {
    return fs.statSync(abs);
  } catch {
    return null;
  }
}

function lineSlice(content, { from, to, maxLines = 400 }) {
  const lines = content.split('\n');
  const start = Math.max(1, from || 1);
  const end = Math.min(lines.length, to || Math.min(lines.length, start + maxLines - 1));
  return { text: lines.slice(start - 1, end).join('\n'), from: start, to: end, total: lines.length };
}

function diffPreview(before, after, { context = 2, maxLines = 40 } = {}) {
  const a = before.split('\n');
  const b = after.split('\n');
  // 简单 LCS 行级 diff（文件级场景够用，避免引入依赖）
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    return `（文件过大，仅给出长度变化：${n} 行 → ${m} 行）`;
  }
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  let changed = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([' ', a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(['-', a[i]]);
      changed++;
      i++;
    } else {
      out.push(['+', b[j]]);
      changed++;
      j++;
    }
  }
  while (i < n) {
    out.push(['-', a[i++]]);
    changed++;
  }
  while (j < m) {
    out.push(['+', b[j++]]);
    changed++;
  }
  if (!changed) return '（无实际改动）';
  // 只保留改动附近 ±context 行
  const keep = new Set();
  out.forEach(([sign, _l], idx) => {
    if (sign !== ' ') for (let k = idx - context; k <= idx + context; k++) if (k >= 0 && k < out.length) keep.add(k);
  });
  const shown = [...keep].sort((x, y) => x - y).slice(0, maxLines);
  const body = shown.map((k) => `${out[k][0]} ${out[k][1]}`);
  const omitted = out.length - shown.length;
  return body.join('\n') + (omitted > 0 ? `\n…（省略 ${omitted} 行未改动内容，共 ${changed} 行变更）` : '');
}

/** 把长输出裁剪为模型可读片段 */
function clip(text, max = 4000) {
  const t = String(text || '');
  if (t.length <= max) return t;
  return `${t.slice(0, max * 0.75)}\n…（截断，共 ${t.length} 字）…\n${t.slice(-Math.floor(max * 0.2))}`;
}

const TOOLS = [
  // ---------- 文件系统（读） ----------
  {
    name: 'list_directory',
    kind: 'fs-read',
    description: '列出项目内某目录的文件与子目录（树状懒加载，一层）。',
    parameters: schema({ path: str('目录相对路径，空串或 . 表示项目根') }),
    run: (args, ctx) => {
      const t = ctx.workspace.tree(ctx.projectId, relOf(ctx, args));
      const lines = t.entries.map((e) => `${e.dir ? '📂' : '·'} ${e.name}${e.dir ? '/' : ` (${fmtSize(e.size)})`} [${e.kind}]`);
      return ok(`目录：/${t.rel}\n${lines.join('\n') || '（空目录）'}`, { entries: t.entries, rel: t.rel });
    }
  },
  {
    name: 'tree',
    kind: 'fs-read',
    description: '递归列出项目文件树（带深度与数量限制），用于快速了解项目结构。',
    parameters: schema({ path: str('起始目录，默认项目根'), max_depth: int('最大深度，默认 4'), max_files: int('最多列出多少文件，默认 300') }),
    run: (args, ctx) => {
      const base = relOf(ctx, args);
      const all = ctx.workspace.walk(ctx.projectId, { maxDepth: args.max_depth || 4, maxFiles: args.max_files || 300 });
      const prefix = base ? `${base}/` : '';
      const filtered = prefix ? all.filter((f) => f.rel.startsWith(prefix)) : all;
      const lines = filtered.map((f) => `${'  '.repeat(Math.max(0, f.rel.split('/').length - 1))}${path.basename(f.rel)} [${f.kind}] ${fmtSize(f.size)}`);
      return ok(`共 ${filtered.length} 个文件\n${clip(lines.join('\n'), 6000)}`, { files: filtered.map((f) => f.rel) });
    }
  },
  {
    name: 'read_file',
    kind: 'fs-read',
    description: '读取项目内文本文件（md/txt/json/xml/html/js/css…），可只读某一段行。',
    parameters: schema({ path: str('文件相对路径'), from: int('起始行（1 起）'), to: int('结束行') }, ['path']),
    run: (args, ctx) => {
      const r = ctx.workspace.read(ctx.projectId, args.path);
      const slice = lineSlice(r.content, { from: args.from, to: args.to });
      ctx.noteActivity?.({ type: 'read', rel: r.rel });
      return ok(`/${r.rel}（${slice.from}-${slice.to} / 共 ${slice.total} 行，${fmtSize(r.size)}）\n\n${clip(slice.text, 12000)}`, { rel: r.rel, lines: slice.total });
    }
  },
  {
    name: 'search_text',
    kind: 'fs-read',
    description: '在项目内做文本检索，支持正则与 glob 过滤（如 *.md）。',
    parameters: schema({ query: str('检索词或正则'), regex: bool('按正则处理'), include: str('glob 过滤，如 *.md 或 docs/**'), max_results: int('最多返回多少条，默认 40') }, ['query']),
    run: (args, ctx) => {
      const r = ctx.workspace.search(ctx.projectId, args.query, { regex: !!args.regex, include: args.include, maxResults: args.max_results || 40 });
      if (!r.total) return ok(`未命中「${args.query}」${r.truncated ? '（已截断）' : ''}`);
      const lines = r.results.map((x) => `${x.rel}:${x.line}: ${x.text.trim()}`);
      return ok(`命中 ${r.total} 处\n${clip(lines.join('\n'), 8000)}`, r);
    }
  },
  {
    name: 'file_info',
    kind: 'fs-read',
    description: '查看文件大小、类型、修改时间与是否存在。',
    parameters: schema({ path: str('相对路径') }, ['path']),
    run: (args, ctx) => {
      const s = ctx.workspace.stat(ctx.projectId, args.path);
      return ok(`/${s.rel} 类型=${s.kind} ${s.dir ? '目录' : fmtSize(s.size)} 修改于 ${new Date(s.mtime).toLocaleString('zh-CN')}`, s);
    }
  },

  // ---------- 文件系统（写，需审批） ----------
  {
    name: 'write_file',
    kind: 'fs-write',
    approval: 'write',
    description: '新建或整体覆盖写入文件；会自动创建父目录。小改动请优先用 edit_file。',
    parameters: schema({ path: str('相对路径'), content: str('完整文件内容'), summary: str('一句话说明这次写入做了什么') }, ['path', 'content']),
    run: (args, ctx) => {
      const before = ctx.workspace.exists(ctx.projectId, args.path) ? ctx.workspace.read(ctx.projectId, args.path).content : '';
      const r = ctx.workspace.write(ctx.projectId, args.path, args.content);
      void ctx.queueReindex?.(r.rel);
      return ok(`已写入 /${r.rel}（${fmtSize(r.size)}，${before ? '覆盖' : '新建'}）${args.summary ? `\n说明：${args.summary}` : ''}\n\n差异预览：\n${diffPreview(before, String(args.content))}`, { rel: r.rel, diff: diffPreview(before, String(args.content)), before, after: String(args.content) });
    }
  },
  {
    name: 'edit_file',
    kind: 'fs-write',
    approval: 'write',
    description: '按「原文片段 → 新片段」精确替换，一次可给多处；找不到或命中多处会报错而不是猜。',
    parameters: schema({ path: str('相对路径'), edits: arr('替换项', { type: 'object', properties: { old_text: str('要被替换的原文，需唯一'), new_text: str('替换后的文本') }, required: ['old_text', 'new_text'], additionalProperties: false }), dry_run: bool('只预览不落盘') }, ['path', 'edits']),
    run: (args, ctx) => {
      const r = ctx.workspace.read(ctx.projectId, args.path);
      let text = r.content;
      const log = [];
      for (const [i, e] of (args.edits || []).entries()) {
        const oldText = String(e.old_text);
        const hits = text.split(oldText).length - 1;
        if (hits === 0) return fail(`第 ${i + 1} 处未找到原文片段：\n${oldText.slice(0, 80)}`);
        if (hits > 1 && !e.all) return fail(`第 ${i + 1} 处原文命中 ${hits} 次，请扩大片段使其唯一`);
        text = text.split(oldText).join(String(e.new_text));
        log.push(`第 ${i + 1} 处：替换 ${hits || 1} 次`);
      }
      if (args.dry_run) return ok(`（dry_run，未落盘）/${r.rel}\n${log.join('\n')}\n\n${diffPreview(r.content, text)}`, { diff: diffPreview(r.content, text) });
      ctx.workspace.write(ctx.projectId, args.path, text);
      void ctx.queueReindex?.(r.rel);
      return ok(`已按 ${log.length} 处替换更新 /${r.rel}\n\n${diffPreview(r.content, text)}`, { rel: r.rel, diff: diffPreview(r.content, text), before: r.content, after: text });
    }
  },
  {
    name: 'replace_in_file',
    kind: 'fs-write',
    approval: 'write',
    description: '对整个文件做正则/文本批量替换（全局），返回命中数与差异预览。',
    parameters: schema({ path: str('相对路径'), find: str('文本或正则'), replace: str('替换内容'), regex: bool('按正则处理'), dry_run: bool('只预览') }, ['path', 'find', 'replace']),
    run: (args, ctx) => {
      const r = ctx.workspace.read(ctx.projectId, args.path);
      let re;
      try {
        re = args.regex ? new RegExp(args.find, 'gm') : new RegExp(String(args.find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      } catch (err) {
        return fail(`表达式无效：${err.message}`);
      }
      const count = (r.content.match(re) || []).length;
      if (!count) return ok(`未命中，文件未改动。`);
      const after = r.content.replace(re, args.replace);
      if (args.dry_run) return ok(`（dry_run）将替换 ${count} 处\n\n${diffPreview(r.content, after)}`);
      ctx.workspace.write(ctx.projectId, args.path, after);
      void ctx.queueReindex?.(r.rel);
      return ok(`已替换 ${count} 处 /${r.rel}\n\n${diffPreview(r.content, after)}`, { rel: r.rel, count });
    }
  },
  {
    name: 'create_directory',
    kind: 'fs-write',
    approval: 'write',
    description: '在项目内新建目录（可多级）。',
    parameters: schema({ path: str('目录相对路径') }, ['path']),
    run: (args, ctx) => {
      const r = ctx.workspace.mkdir(ctx.projectId, args.path);
      return ok(`已创建目录 /${r.rel}`);
    }
  },
  {
    name: 'move_file',
    kind: 'fs-write',
    approval: 'write',
    description: '移动或重命名文件/目录。',
    parameters: schema({ from: str('原路径'), to: str('新路径') }, ['from', 'to']),
    run: (args, ctx) => {
      const r = ctx.workspace.move(ctx.projectId, args.from, args.to);
      void ctx.queueReindex?.(r.to);
      ctx.onFileMoved?.(r.from, r.to);
      return ok(`已移动 /${r.from} → /${r.to}`);
    }
  },
  {
    name: 'delete_file',
    kind: 'fs-destructive',
    approval: 'always',
    description: '删除文件或目录（目录为递归删除）。此操作无论审批模式如何都会要求确认。',
    parameters: schema({ path: str('相对路径'), reason: str('为什么需要删除') }, ['path']),
    run: (args, ctx) => {
      const s = ctx.workspace.stat(ctx.projectId, args.path);
      const r = ctx.workspace.removeFile(ctx.projectId, args.path);
      ctx.onDeleted?.(r.rel);
      return ok(`已删除 /${r.rel}${r.dir ? '（含其下全部内容）' : `（${fmtSize(s.size)}）`}${args.reason ? `\n原因：${args.reason}` : ''}`, { danger: true });
    }
  },
  {
    name: 'import_asset',
    kind: 'fs-write',
    approval: 'write',
    description: '把外部图片等素材复制进项目 assets/ 目录，返回项目内相对路径。',
    parameters: schema({ source: str('外部文件绝对路径'), subdir: str('目标子目录，默认 assets') }, ['source']),
    run: (args, ctx) => {
      const r = ctx.workspace.importAsset(ctx.projectId, args.source, args.subdir || 'assets');
      return ok(`已导入 /${r.rel}（${fmtSize(r.size)}）`, r);
    }
  },
  {
    name: 'open_in_browser',
    kind: 'fs-read',
    description: '用系统默认浏览器打开项目内的 HTML 文件（本地 H5 预览）。',
    parameters: schema({ path: str('HTML 相对路径') }, ['path']),
    run: (args, ctx) => {
      const r = ctx.workspace.resolve(ctx.projectId, args.path);
      if (!/\.html?$/i.test(r.abs)) return fail('只允许打开 HTML 文件');
      ctx.shell.openPath(r.abs);
      return ok(`已在系统浏览器打开 /${r.rel}`);
    }
  },
  {
    name: 'reveal_in_folder',
    kind: 'fs-read',
    description: '在资源管理器中定位某个文件。',
    parameters: schema({ path: str('相对路径') }, ['path']),
    run: (args, ctx) => {
      const r = ctx.workspace.resolve(ctx.projectId, args.path);
      ctx.shell.showItemInFolder(r.abs);
      return ok(`已在资源管理器定位 /${r.rel}`);
    }
  },

  // ---------- Markdown / 数据文档 ----------
  {
    name: 'format_markdown',
    kind: 'fs-write',
    approval: 'write',
    description: '规范化 Markdown 排版：标题前后空行、列表符号统一、表格对齐、去行尾空格、折叠多余空行；代码块与 frontmatter 原样保留。',
    parameters: schema({ path: str('md 文件相对路径'), list_marker: str('列表符号，默认 -'), number_headings: bool('是否为标题编号'), dry_run: bool('只预览不落盘') }, ['path']),
    run: (args, ctx) => {
      const r = ctx.workspace.read(ctx.projectId, args.path);
      const out = md.formatMarkdown(r.content, { listMarker: args.list_marker || '-', numberHeadings: !!args.number_headings });
      if (args.dry_run) return ok(`（dry_run）/${r.rel} 规范化预览\n\n${diffPreview(r.content, out)}`, { before: r.content, after: out });
      ctx.workspace.write(ctx.projectId, args.path, out);
      void ctx.queueReindex?.(r.rel);
      return ok(`已规范化 /${r.rel}\n\n${diffPreview(r.content, out)}`, { rel: r.rel, before: r.content, after: out });
    }
  },
  {
    name: 'outline',
    kind: 'fs-read',
    description: '输出文档标题大纲与行号，可选各章节字数。',
    parameters: schema({ path: str('md 相对路径'), counts: bool('是否统计每节字数') }, ['path']),
    run: (args, ctx) => {
      const r = ctx.workspace.read(ctx.projectId, args.path);
      const hs = md.headings(r.content);
      if (!hs.length) return ok(`/${r.rel} 没有标题`);
      const lines = hs.map((h) => {
        const pad = '  '.repeat(h.level - 1);
        const c = args.counts ? ` （约 ${md.countWords(sectionText(r.content, h, hs)).total} 字）` : '';
        return `${pad}${'#'.repeat(h.level)} ${h.title}  ← 第 ${h.line} 行${c}`;
      });
      return ok(`/${r.rel} 大纲：\n${lines.join('\n')}`, { headings: hs });
    }
  },
  {
    name: 'add_toc',
    kind: 'fs-write',
    approval: 'write',
    description: '为文档生成/更新「目录」小节（GitHub 风格锚点）。',
    parameters: schema({ path: str('md 相对路径'), title: str('目录标题，默认「目录」'), max_level: int('最深层级，默认 3'), at_line: int('插入位置行号，默认第一个标题之后') }, ['path']),
    run: (args, ctx) => {
      const r = ctx.workspace.read(ctx.projectId, args.path);
      const toc = md.buildToc(r.content, { title: args.title || '目录', maxLevel: args.max_level || 3 });
      if (!toc) return fail('没有可用于生成目录的标题');
      const cleaned = removeExistingToc(r.content, args.title || '目录');
      const lines = cleaned.split('\n');
      const insertAt = args.at_line || (lines.findIndex((l) => /^#\s/.test(l)) + 1 || 0) + 1;
      const out = [...lines.slice(0, insertAt), '', ...toc.split('\n'), ...lines.slice(insertAt)].join('\n');
      ctx.workspace.write(ctx.projectId, args.path, md.formatMarkdown(out));
      void ctx.queueReindex?.(r.rel);
      return ok(`已在第 ${insertAt + 1} 行写入目录（${(toc.match(/^-/gm) || []).length} 项）/${r.rel}`, { rel: r.rel, after: out });
    }
  },
  {
    name: 'count_words',
    kind: 'fs-read',
    description: '统计字数（中文字数 + 英文单词数分别给出）、行数、标题数、图片与链接数。',
    parameters: schema({ path: str('相对路径') }, ['path']),
    run: (args, ctx) => {
      const r = ctx.workspace.read(ctx.projectId, args.path);
      const c = md.countWords(r.content);
      const links = md.collectLinks(r.content);
      return ok(`/${r.rel}：${c.total} 字（中文 ${c.cjk}、英文 ${c.latin}）· ${c.lines} 行 · 标题 ${md.headings(r.content).length} 个 · 链接/图片 ${links.length} 个`, { ...c, links: links.length });
    }
  },
  {
    name: 'insert_image',
    kind: 'fs-write',
    approval: 'write',
    description: '在 Markdown 中插入图片：可用项目内路径、外链，或把本地文件内联为 base64。可指定宽度、居中、说明文字与目标位置。',
    parameters: schema({ path: str('目标 md 文件'), source: str('图片：项目内相对路径 / 外链 / 绝对路径（配合 inline 或先 import_asset）'), alt: str('替代文字'), title: str('悬浮标题'), width: int('显示宽度 px'), center: bool('居中'), inline: bool('以 base64 内联'), at_line: int('插入行号，默认追加到文末'), caption: str('图片下方说明文字') }, ['path', 'source']),
    run: (args, ctx) => {
      const r = ctx.workspace.read(ctx.projectId, args.path).content;
      let ref;
      let sizeNote = '';
      if (args.inline) {
        const abs = path.isAbsolute(args.source) ? args.source : ctx.workspace.resolve(ctx.projectId, args.source).abs;
        const buf = fs.readFileSync(abs);
        if (buf.length > 6 * 1024 * 1024) return fail('内联图片过大（>6MB），建议改用相对路径引用');
        const mime = /\.png$/i.test(abs) ? 'image/png' : /\.jpe?g$/i.test(abs) ? 'image/jpeg' : /\.gif$/i.test(abs) ? 'image/gif' : /\.svg$/i ? 'image/svg+xml' : 'image/png';
        ref = md.imageRef(args.alt || '图片', abs, { inline: true, dataUrl: md.toDataUrl(buf, mime), width: args.width, align: args.center ? 'center' : undefined });
        sizeNote = `（内联 ${(buf.length / 1024).toFixed(0)}KB，会让文档体积明显变大）`;
      } else {
        ref = md.imageRef(args.alt || '图片', args.source, { title: args.title, width: args.width, align: args.center ? 'center' : undefined });
      }
      const block = args.caption ? `${ref}\n\n*${args.caption}*` : ref;
      const lines = r.split('\n');
      const at = args.at_line && args.at_line > 0 ? args.at_line - 1 : lines.length;
      const out = [...lines.slice(0, at), '', block, '', ...lines.slice(at)].join('\n');
      ctx.workspace.write(ctx.projectId, args.path, out);
      void ctx.queueReindex?.(path.basename(args.path) === args.path ? args.path : args.path);
      return ok(`已在 /${args.path} 第 ${at + 2} 行插入图片${sizeNote}`, { rel: args.path, block });
    }
  },
  {
    name: 'check_links',
    kind: 'fs-read',
    description: '体检文档内的本地图片与相对链接是否存在，列出失效项与建议。',
    parameters: schema({ path: str('md 相对路径') }, ['path']),
    run: (args, ctx) => {
      const { rel, content } = ctx.workspace.read(ctx.projectId, args.path);
      const links = md.collectLinks(content);
      const dir = path.posix.dirname(rel);
      const bad = [];
      const remote = [];
      for (const l of links) {
        if (md.isRemote(l.target)) {
          if (/^https?:/i.test(l.target)) remote.push(l.target);
          continue;
        }
        const abs = path.posix.join(dir === '.' ? '' : dir, decodeURIComponent(l.target.split('#')[0]));
        if (!ctx.workspace.exists(ctx.projectId, abs)) bad.push({ target: l.target, image: l.image, alt: l.alt });
      }
      const lines = [];
      lines.push(`/${rel}：共 ${links.length} 个引用，外链 ${remote.length} 个`);
      if (bad.length) {
        lines.push(`\n失效 ${bad.length} 处：`);
        bad.forEach((b) => lines.push(`- ${b.image ? '图片' : '链接'} ${b.target}${b.alt ? `（替代文字「${b.alt}」）` : ''} → 建议用 import_asset 把文件放入项目或修正路径`));
      } else lines.push('本地引用全部有效 ✓');
      return ok(lines.join('\n'), { broken: bad, remote });
    }
  },
  {
    name: 'table_from_rows',
    kind: 'fs-read',
    description: '把 CSV/TSV 或数组转成对齐好的 Markdown 表格文本（不落盘，供后续写入使用）。',
    parameters: schema({ rows: arr('每行一个字符串（逗号/制表符分隔）或字符串数组'), header: arr('表头，缺省用第一行') }, ['rows']),
    run: (args) => ok(md.rowsToTable(args.rows, { header: args.header }))
  },
  {
    name: 'validate_json',
    kind: 'fs-read',
    description: '校验 JSON 并给出结构概览；format=true 时返回美化后的文本。',
    parameters: schema({ path: str('json 相对路径'), format: bool('返回美化结果') }, ['path']),
    run: (args, ctx) => {
      const { content, rel } = ctx.workspace.read(ctx.projectId, args.path);
      const v = md.validateJson(content);
      if (!v.ok) return fail(`/${rel} JSON 无效：${v.error}`);
      const head = `/${rel} JSON 合法（${v.type}${v.count != null ? `，${v.count} 项` : ''}）顶层键：${(v.keys || []).join(', ') || '—'}`;
      return ok(args.format ? `${head}\n\n美化结果：\n${clip(md.tidyJson(content), 6000)}` : head);
    }
  },
  {
    name: 'tidy_data_file',
    kind: 'fs-write',
    approval: 'write',
    description: '美化并校验 JSON/XML 数据文件（键序稳定、缩进统一）。',
    parameters: schema({ path: str('相对路径') }, ['path']),
    run: (args, ctx) => {
      const { content, rel } = ctx.workspace.read(ctx.projectId, args.path);
      let out;
      if (/\.(json|jsonc|json5)$/i.test(rel)) {
        const v = md.validateJson(content);
        if (!v.ok) return fail(`/${rel} 本身 JSON 无效，先修复再美化：${v.error}`);
        out = md.tidyJson(content);
      } else if (/\.(xml|svg|xsl|plist)$/i.test(rel)) {
        const v = md.validateXml(content);
        if (!v.ok) return fail(`/${rel} XML 有问题，先修复：\n${v.errors.join('\n')}`);
        out = md.tidyXml(content);
      } else return fail('只支持 .json/.jsonc/.xml/.svg/.xsl/.plist');
      ctx.workspace.write(ctx.projectId, rel, out);
      void ctx.queueReindex?.(rel);
      return ok(`已美化 /${rel}（${out.split('\n').length} 行），校验通过 ✓`);
    }
  },
  {
    name: 'validate_xml',
    kind: 'fs-read',
    description: '校验 XML/SVG 的标签配对、实体与结构，返回错误行号。',
    parameters: schema({ path: str('相对路径'), text: str('或直接给一段 XML 文本') }),
    run: (args, ctx) => {
      const text = args.text || ctx.workspace.read(ctx.projectId, args.path).content;
      const v = md.validateXml(text);
      return ok(v.ok ? `XML 合法 ✓（${v.elements} 个标签）` : `XML 有 ${v.errors.length} 个问题：\n${v.errors.join('\n')}`, v);
    }
  },
  {
    name: 'scaffold_h5',
    kind: 'fs-write',
    approval: 'write',
    description: '在项目内生成轻量 H5 页面脚手架（index.html + style.css + app.js），无构建依赖。',
    parameters: schema({ dir: str('子目录，默认 h5'), title: str('页面标题'), theme: str('light 或 dark，默认 light') }, ['dir']),
    run: (args, ctx) => {
      const files = md.h5Scaffold({ title: args.title || 'MeReader H5', theme: args.theme || 'light' });
      const written = [];
      for (const [name, content] of Object.entries(files)) {
        const rel = `${String(args.dir).replace(/^\/+/, '')}/${name}`;
        if (ctx.workspace.exists(ctx.projectId, rel)) return fail(`${rel} 已存在，改用其它目录或先删除`);
        written.push(ctx.workspace.write(ctx.projectId, rel, content).rel);
      }
      written.forEach((r) => void ctx.queueReindex?.(r));
      return ok(`已创建 H5 脚手架 /${args.dir}：\n${written.map((w) => `- ${w}`).join('\n')}\n可用 open_in_browser 预览 index.html`, { files: written });
    }
  },
  {
    name: 'validate_html',
    kind: 'fs-read',
    description: '检查 HTML 的关键结构（doctype、charset、viewport、标签配对）。',
    parameters: schema({ path: str('相对路径') }, ['path']),
    run: (args, ctx) => {
      const { content, rel } = ctx.workspace.read(ctx.projectId, args.path);
      const issues = [];
      if (!/<!DOCTYPE html>/i.test(content)) issues.push('缺少 <!DOCTYPE html>');
      if (!/charset=["']?utf-?8/i.test(content)) issues.push('缺少 <meta charset="UTF-8">');
      if (!/name=["']viewport["']/i.test(content)) issues.push('缺少 viewport meta');
      if (!/lang=/i.test(content)) issues.push('<html> 缺少 lang 属性');
      const stack = [];
      const re = /<(\/)?(div|section|main|article|header|footer|nav|ul|ol|table|body|head|html|form|button|a|p|span)(\s[^>]*)?>/gi;
      let m;
      while ((m = re.exec(content))) {
        const closing = !!m[1];
        const tag = m[2].toLowerCase();
        if (m[3] && /\/\s*$/.test(m[3])) continue;
        if (closing) {
          const top = stack.pop();
          if (!top || top.tag !== tag) issues.push(`标签不匹配：期望 </${top ? top.tag : tag}>，实际 </${tag}>`);
        } else stack.push({ tag });
      }
      stack.forEach((s) => issues.push(`<${s.tag}> 未闭合`));
      return ok(issues.length ? `/${rel} 发现 ${issues.length} 个问题：\n${issues.slice(0, 15).join('\n')}` : `/${rel} 结构检查通过 ✓`, { issues });
    }
  },
  {
    name: 'diff_text',
    kind: 'fs-read',
    description: '对比两个文件，或一个文件与一段文本，输出行级差异。',
    parameters: schema({ path: str('文件 A'), path_b: str('文件 B（与 text 二选一）'), text: str('直接给一段文本作为 B') }, ['path']),
    run: (args, ctx) => {
      const a = ctx.workspace.read(ctx.projectId, args.path).content;
      const b = args.text != null ? String(args.text) : ctx.workspace.read(ctx.projectId, args.path_b).content;
      return ok(diffPreview(a, b, { context: 3, maxLines: 80 }));
    }
  },

  // ---------- 记忆（.omemory / 全局） ----------
  {
    name: 'memory_add',
    kind: 'memory-write',
    approval: 'memory',
    description: '记住一条长期有效的结论（命名约定、用户偏好、踩过的坑）。一条只写一个事实。',
    parameters: schema({ text: str('要记住的内容，一到两句'), kind: str('fact / preference / decision / entity / warning'), scope: str('project（写入 .omemory）或 global'), tags: arr('标签'), pinned: bool('固定，注入每次会话') }, ['text']),
    run: (args, ctx) => {
      const store = args.scope === 'global' ? ctx.memory.global : ctx.memory.project || ctx.memory.global;
      const { item, merged } = store.add({ text: args.text, kind: args.kind || 'fact', tags: args.tags || [], pinned: !!args.pinned, source: 'agent' });
      return ok(`${merged ? '已合并到既有记忆' : '已记住'}（${store.scope}）：${item.id} — ${item.text}`, item);
    }
  },
  {
    name: 'memory_search',
    kind: 'memory-read',
    description: '检索已保存的记忆（项目 .omemory 与全局）。',
    parameters: schema({ query: str('检索词'), scope: str('project / global / all，默认 all'), top_k: int('返回条数，默认 8') }, ['query']),
    run: (args, ctx) => {
      const stores = args.scope === 'global' ? [ctx.memory.global] : args.scope === 'project' ? [ctx.memory.project].filter(Boolean) : [ctx.memory.project, ctx.memory.global].filter(Boolean);
      const hits = stores.flatMap((s) => s.search(args.query, { topK: args.top_k || 8 }).results.map((r) => ({ ...r, scope: s.scope, label: s.label })));
      if (!hits.length) return ok(`没有与「${args.query}」相关的记忆`);
      return ok(hits.map((h) => `[${h.scope}:${h.label}] ${h.id} · ${h.kind} · ${h.text}`).join('\n'), { hits });
    }
  },
  {
    name: 'memory_list',
    kind: 'memory-read',
    description: '列出记忆条目与统计。',
    parameters: schema({ scope: str('project / global / all，默认 all'), kind: str('只看某一类') }),
    run: (args, ctx) => {
      const stores = args.scope === 'global' ? [ctx.memory.global] : args.scope === 'project' ? [ctx.memory.project].filter(Boolean) : [ctx.memory.project, ctx.memory.global].filter(Boolean);
      const blocks = stores.map((s) => {
        const st = s.stats();
        const items = s.list({ kind: args.kind || null, limit: 60 });
        return `【${st.scope}·${st.label}】${st.total} 条（${JSON.stringify(st.byKind)}）\n${items.map((i) => `- ${i.id} ${i.pinned ? '📌' : ''} ${i.kind}: ${i.text.slice(0, 90)}`).join('\n') || '（空）'}`;
      });
      return ok(blocks.join('\n\n'));
    }
  },
  {
    name: 'memory_update',
    kind: 'memory-write',
    approval: 'memory',
    description: '修改或废弃一条记忆（结论被推翻时使用）。',
    parameters: schema({ id: str('条目 id'), text: str('新内容'), pinned: bool('是否固定'), remove: bool('设为 true 则删除'), scope: str('project / global，默认 project') }, ['id']),
    run: (args, ctx) => {
      const store = args.scope === 'global' ? ctx.memory.global : ctx.memory.project || ctx.memory.global;
      if (args.remove) return ok(store.remove(args.id) ? `已删除记忆 ${args.id}` : `未找到 ${args.id}`);
      const item = store.update(args.id, { text: args.text, pinned: args.pinned });
      return ok(`已更新记忆 ${item.id}：${item.text}`, item);
    }
  },

  // ---------- RAG ----------
  {
    name: 'rag_search',
    kind: 'rag',
    description: '在向量索引里做语义检索，返回最相关的文档片段与出处。',
    parameters: schema({ query: str('检索问题或关键词'), top_k: int('返回片段数，默认 5'), scope: str('project / global / all，默认 project') }, ['query']),
    run: async (args, ctx) => {
      const stores = [args.scope !== 'global' && ctx.rag.project, args.scope !== 'project' && ctx.rag.global].filter(Boolean);
      const all = [];
      for (const s of stores) {
        const r = await s.query(args.query, { topK: args.top_k || 5 });
        if (r.results.length) all.push(...r.results.map((x) => ({ ...x, scope: s.scope, label: s.label })));
      }
      if (!all.length) return ok('语义检索没有命中（索引可能为空，可先执行 rag_index_project）');
      all.sort((a, b) => b.score - a.score);
      const picked = all.slice(0, args.top_k || 5);
      return ok(picked.map((p) => `### ${p.rel} · 片段 ${p.chunkIndex}（相关度 ${p.score}，${p.scope}·${p.label}）\n${p.text}`).join('\n\n'), { hits: picked.map((p) => ({ rel: p.rel, score: p.score })) });
    }
  },
  {
    name: 'rag_index_project',
    kind: 'rag-write',
    approval: 'write',
    description: '为当前项目建立/刷新向量索引（增量，按文件哈希跳过未变更文件）。',
    parameters: schema({ include: str('glob 过滤，默认文本类文件'), limit: int('最多索引多少文件，默认 400') }),
    run: async (args, ctx) => {
      const files = ctx.workspace.walk(ctx.projectId, { maxFiles: args.limit || 400 }).filter((f) => md.countWords && ['md', 'txt', 'json', 'xml', 'html', 'js', 'config'].includes(f.kind));
      const res = await ctx.rag.project.rebuild(
        { list: files, read: (item) => ctx.workspace.read(ctx.projectId, item.rel).content },
        { onProgress: (p) => ctx.emit?.('rag:progress', { ...p, label: ctx.rag.project.label }) }
      );
      return ok(`项目「${ctx.rag.project.label}」索引完成：新增/更新 ${res.indexed}，跳过 ${res.skipped}，清理 ${res.removed}${res.errors.length ? `，失败 ${res.errors.length}：\n${res.errors.map((e) => `- ${e.rel}: ${e.error}`).join('\n')}` : ''}`, res);
    }
  },
  {
    name: 'rag_stats',
    kind: 'rag',
    description: '查看索引状态（文件数、分块数、向量维度、更新时间、索引文件位置）。',
    parameters: schema({}),
    run: (args, ctx) => {
      const rows = [ctx.rag.project, ctx.rag.global].filter(Boolean).map((s) => {
        const st = s.stats();
        return `【${st.scope}·${st.label}】文件 ${st.files} · 分块 ${st.chunks} · 维度 ${st.dim} · 模型 ${st.model}\n  ${st.file}`;
      });
      return ok(rows.join('\n\n') || '尚无索引');
    }
  },

  // ---------- 技能 ----------
  {
    name: 'skill_list',
    kind: 'skill-read',
    description: '列出已启用/停用的技能（内置 + 全局 + 项目 .oskill）。',
    parameters: schema({ include_disabled: bool('包含停用项') }),
    run: (args, ctx) => {
      const items = ctx.skills.list().filter((s) => args.include_disabled || s.enabled);
      return ok(items.map((s) => `${s.enabled ? '✓' : '×'} ${s.title}（${s.name}｜${s.scope}${s.builtin ? '·内置' : ''}）— ${s.description}`).join('\n') || '（无技能）', { items: items.map((s) => ({ name: s.name, enabled: s.enabled, scope: s.scope })) });
    }
  },
  {
    name: 'skill_read',
    kind: 'skill-read',
    description: '读取某技能的完整规程文本。',
    parameters: schema({ name: str('技能名') }, ['name']),
    run: (args, ctx) => {
      const s = ctx.skills.get(args.name);
      return s ? ok(`# ${s.title}（${s.name}，${s.scope}）\n触发词：${s.when.join('、') || '—'}\n允许工具：${s.tools.join(', ') || '未限制'}\n\n${s.body}`) : fail(`未找到技能：${args.name}`);
    }
  },
  {
    name: 'skill_save',
    kind: 'skill-write',
    approval: 'skill',
    description: '新建或修订一个技能（写入 .oskill 项目技能或全局技能目录）。',
    parameters: schema({ name: str('技能英文名'), title: str('中文名'), description: str('一句话用途'), when: arr('触发关键词'), tools: arr('该技能允许的工具'), body: str('规程正文（markdown）'), scope: str('project / global，默认 project') }, ['name', 'body']),
    run: (args, ctx) => {
      const s = ctx.skills.save({ ...args, scope: args.scope || 'project' });
      return ok(`技能「${s.title}」已保存到 ${s.file}（版本 ${s.version}）`, { name: s.name, file: s.file });
    }
  },
  {
    name: 'skill_toggle',
    kind: 'skill-write',
    approval: 'skill',
    description: '启用或停用某个技能。内置技能只能停用。',
    parameters: schema({ name: str('技能名'), enabled: bool('true 启用 / false 停用') }, ['name', 'enabled']),
    run: (args, ctx) => {
      if (!ctx.skills.get(args.name)) return fail(`未找到技能：${args.name}`);
      const r = ctx.skills.setEnabled(args.name, args.enabled);
      ctx.onSkillsChanged?.(r.disabled);
      return ok(`技能「${args.name}」已${r.enabled ? '启用' : '停用'}`);
    }
  },

  // ---------- 联网 ----------
  {
    name: 'web_search',
    kind: 'net',
    description: '免密钥联网搜索（自动多引擎降级）。返回标题、链接、摘要。',
    parameters: schema({ query: str('搜索词'), top_k: int('结果数，默认 6'), engine: str('指定引擎 bing / baidu / sogou / ddg，默认自动') }, ['query']),
    run: async (args, ctx) => {
      const r = await ctx.webSearch.searchResolved(args.query, { topK: args.top_k || 6, engine: args.engine });
      if (!r.ok) return fail(`${r.error}\n引擎尝试记录：${(r.attempts || []).map((a) => `${a.engine}:${a.ok ? a.count : a.error}`).join('，')}`);
      const lines = r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${(x.snippet || '（无摘要）').slice(0, 200)}`);
      return ok(`搜索引擎：${r.engine}\n${lines.join('\n')}`, { results: r.results, engine: r.engine });
    }
  },
  {
    name: 'web_fetch',
    kind: 'net',
    description: '抓取一个网址的正文文本（自动去标签、SPA 页面会提示取不到正文）。',
    parameters: schema({ url: str('http(s) 网址'), max_chars: int('最多返回多少字，默认 6000') }, ['url']),
    run: async (args, ctx) => {
      const r = await ctx.webSearch.fetch(args.url, { maxChars: args.max_chars || 6000 });
      if (!r.ok) return fail(`抓取失败：HTTP ${r.status} ${r.url}`);
      return ok(`【${r.title || args.url}】${r.contentType}\n${r.text}${r.note ? `\n\n提示：${r.note}` : ''}${r.truncated ? '\n\n（正文已截断）' : ''}`, { url: r.url, title: r.title });
    }
  },

  // ---------- 计划 / 反思 ----------
  {
    name: 'set_plan',
    kind: 'plan',
    description: '为多步骤任务写下有序步骤清单（plan 阶段使用）。每步一句话、可验证。',
    parameters: schema({ goal: str('一句话目标'), steps: arr('步骤文本，按执行顺序') }, ['goal', 'steps']),
    run: (args, ctx) => {
      ctx.setPlan({ goal: args.goal, steps: (args.steps || []).map((s) => ({ text: String(s), status: 'pending' })) });
      return ok(`已建立计划（${args.steps.length} 步）：\n${args.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`);
    }
  },
  {
    name: 'update_plan_step',
    kind: 'plan',
    description: '更新某一步的状态：pending / doing / done / failed，可附一句话结果。',
    parameters: schema({ index: int('第几步，从 1 开始'), status: str('pending / doing / done / failed'), note: str('结果说明') }, ['index', 'status']),
    run: (args, ctx) => {
      const p = ctx.getPlan();
      if (!p || !p.steps || !p.steps.length) return fail('当前没有计划，先调用 set_plan');
      const i = (args.index | 0) - 1;
      if (i < 0 || i >= p.steps.length) return fail(`步骤序号超出范围（1-${p.steps.length}）`);
      p.steps[i] = { ...p.steps[i], status: args.status, note: args.note || p.steps[i].note };
      ctx.setPlan(p);
      return ok(`计划进度：${p.steps.map((s, k) => `${k + 1}.${s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'doing' ? '▶' : '·'} ${s.text}`).join('\n')}`, { plan: p });
    }
  },
  {
    name: 'ask_user',
    kind: 'plan',
    description: '向用户提一个必须回答的问题（缺少关键信息、需要二选一时使用），会暂停本轮执行。',
    parameters: schema({ question: str('问题'), options: arr('可选项，供用户直接点选') }, ['question']),
    run: (args, ctx) => {
      ctx.requestUserInput({ question: args.question, options: args.options || [] });
      return ok('已向用户提问，等待回答后继续。');
    }
  },
  {
    name: 'reflect',
    kind: 'plan',
    description: '收尾自查：逐条核对用户需求是否满足、改动是否都在项目内、有无半途失败的文件。',
    parameters: schema({ checks: arr('自查项文本，逐条给出结论'), conclusion: str('一句话总体结论'), followups: arr('建议的后续动作') }, ['checks', 'conclusion']),
    run: (args, ctx) => {
      const report = `## 复盘\n${(args.checks || []).map((c) => `- ${c}`).join('\n')}\n结论：${args.conclusion}${args.followups && args.followups.length ? `\n后续建议：\n${args.followups.map((f) => `- ${f}`).join('\n')}` : ''}`;
      ctx.onReflect?.(report);
      return ok(report);
    }
  },

  // ---------- 环境信息 ----------
  {
    name: 'session_info',
    kind: 'info',
    description: '查看当前项目、模型、上下文占用、时间与系统信息，便于判断预算与路径。',
    parameters: schema({}),
    run: (args, ctx) => {
      const usage = ctx.getUsage();
      return ok(`项目：${ctx.projectName}（${ctx.workspace.getRoot(ctx.projectId)}）\n模型：${ctx.model}\n上下文：${usage.tokens}/${usage.budget} token（${usage.percent}%，${usage.level}）\n时间：${new Date().toLocaleString('zh-CN')}\n系统：${os.platform()} ${os.arch()} · ${os.hostname()}`);
    }
  }
];

function sectionText(content, heading, all) {
  const idx = all.indexOf(heading);
  const next = all.slice(idx + 1).find((h) => h.level <= heading.level);
  const lines = content.split('\n');
  const end = next ? next.line - 1 : lines.length;
  return lines.slice(heading.line - 1, end).join('\n');
}

function removeExistingToc(content, title) {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{2,3}\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(l));
  if (start < 0) return content;
  let end = start + 1;
  while (end < lines.length && !/^#{1,3}\s/.test(lines[end])) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Ollama tools 需要的 {type:'function',function:{name,description,parameters}} 形态 */
function toOllamaTools(list) {
  return (list || TOOLS).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function findTool(name) {
  return TOOLS.find((t) => t.name === name) || null;
}

function needsApproval(tool, args) {
  if (!tool) return false;
  if (tool.approval === 'always') return true;
  if (tool.approval === 'write' || tool.approval === 'memory' || tool.approval === 'skill') return true;
  return false;
}

module.exports = { TOOLS, toOllamaTools, findTool, needsApproval, diffPreview, clip, READ_KINDS, fmtSize, schema };
