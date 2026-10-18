'use strict';

/**
 * 会话持久化（append-only JSONL）
 *
 * 位置：userData/agent/sessions/<id>.jsonl，一行一个事件：
 *   {"t":"meta", ...}   会话元信息，可多次追加，读回时后者覆盖前者（日志结构，避免改写首行）
 *   {"t":"msg",  ...}   一条消息（含 tool_calls / tool 结果 / 图片引用 / 统计）
 *   {"t":"state", ...}  派生状态：上下文压缩状态、计划、用量水位
 *
 * 纪律：
 *   - 消息只追加、不修改。上下文压缩永远作用在「派生视图」上，回滚只需丢弃 state。
 *   - 图片不内联进 jsonl（会把会话文件撑爆），落盘到 sessions/assets/<hash>.<ext>，消息里只存引用。
 *   - 只有用户显式删除/截断会话时才整体重写文件，且原子替换。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { ensureDir } = require('./paths');

const SCHEMA = 1;
const MAX_STORED_TOOL_CHARS = 40000;
const IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif'
};

function newSessionId() {
  return `s-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function parseDataUrl(url) {
  const m = /^data:([\w.+-]+\/[\w.+-]+)?[;]?[^,]*;base64,([\s\S]+)$/i.exec(String(url || '').trim());
  if (!m) return null;
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length) return null;
  return { mime: m[1] || 'application/octet-stream', buffer };
}

function toDataUrl(buffer, mime) {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function guessName(mime) {
  const ext = IMAGE_EXT[String(mime).toLowerCase()] || 'img';
  return `image-${Date.now().toString(36)}.${ext}`;
}

function stripLine(obj) {
  const { t, ...rest } = obj;
  return rest;
}

class SessionStore {
  /** @param {{paths: import('./paths').DataPaths}} opts */
  constructor({ paths }) {
    this.paths = paths;
    ensureDir(this.sessionsDir);
    ensureDir(this.assetsDir);
    this.cache = new Map();
  }

  get sessionsDir() {
    return this.paths.sessionsDir;
  }

  get assetsDir() {
    return path.join(this.paths.sessionsDir, 'assets');
  }

  fileOf(id) {
    return this.paths.sessionFile(safeId(id));
  }

  /** 读盘并回放日志；损坏行直接跳过，绝不因为一行坏数据丢掉整个会话 */
  readFromDisk(id) {
    const file = this.fileOf(id);
    const session = { id, meta: null, messages: [], state: null, seq: 0, dirty: false };
    if (!fs.existsSync(file)) return session;
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      console.warn('[MeReader] 会话读取失败：', file, err.message);
      return session;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || !obj.t) continue;
      if (obj.t === 'meta') session.meta = { ...(session.meta || {}), ...stripLine(obj) };
      else if (obj.t === 'msg') {
        const msg = stripLine(obj);
        if (!msg.role) continue;
        session.messages.push(msg);
        const n = Number(msg.id);
        if (Number.isFinite(n) && n > session.seq) session.seq = n;
      } else if (obj.t === 'state') session.state = { ...(session.state || {}), ...stripLine(obj) };
    }
    if (!session.meta) return session;
    session.meta.messageCount = session.messages.length;
    return session;
  }

  load(id) {
    const key = safeId(id);
    if (this.cache.has(key)) return this.cache.get(key);
    const session = this.readFromDisk(key);
    this.cache.set(key, session);
    return session;
  }

  reload(id) {
    this.cache.delete(safeId(id));
    return this.load(id);
  }

  /** 列出会话元信息（IDE 左侧「历史会话」用） */
  list({ projectId = null, limit = 200 } = {}) {
    let files = [];
    try {
      files = fs.readdirSync(this.sessionsDir).filter((f) => /\.jsonl$/i.test(f));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      const id = f.replace(/\.jsonl$/i, '');
      const s = this.load(id);
      if (!s.meta) continue;
      if (projectId && s.meta.projectId !== projectId) continue;
      out.push(this.summary(s));
    }
    return out
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit);
  }

  summary(session) {
    const m = session.meta || {};
    const last = session.messages[session.messages.length - 1];
    return {
      id: m.id,
      title: m.title || '未命名会话',
      projectId: m.projectId || null,
      projectName: m.projectName || '',
      model: m.model || '',
      createdAt: m.createdAt || 0,
      updatedAt: m.updatedAt || 0,
      pinned: !!m.pinned,
      messageCount: session.messages.length,
      compactCount: (session.state && session.state.contextState && session.state.contextState.compactCount) || 0,
      preview: clipText(last && typeof last.content === 'string' ? last.content : '', 80),
      hasImages: session.messages.some((x) => Array.isArray(x.images) && x.images.length)
    };
  }

  create({ projectId = null, projectName = '', title = '新会话', model = '', approval = null } = {}) {
    const id = newSessionId();
    const now = Date.now();
    const meta = {
      id,
      schema: SCHEMA,
      agent: 'Ollab',
      title: String(title || '新会话'),
      projectId: projectId || null,
      projectName: projectName || '',
      model: model || '',
      approval: approval || null,
      createdAt: now,
      updatedAt: now,
      pinned: false
    };
    this.appendLine(id, { t: 'meta', ...meta });
    const session = this.load(id);
    session.meta = meta;
    session.messages = [];
    session.state = null;
    session.seq = 0;
    return meta;
  }

  appendLine(id, obj) {
    const file = this.fileOf(id);
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
    return file;
  }

  /** 追加一条消息；自动编号（编号即压缩覆盖水位依据），返回落盘后的消息 */
  appendMessage(id, msg) {
    const session = this.load(id);
    if (!session.meta) throw new Error(`会话不存在：${id}`);
    session.seq += 1;
    const stored = {
      id: String(session.seq),
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : String(msg.content == null ? '' : msg.content),
      at: msg.at || Date.now(),
      ...('tool_call_id' in msg ? { tool_call_id: msg.tool_call_id } : {}),
      ...(msg.name ? { name: msg.name } : {}),
      ...(Array.isArray(msg.tool_calls) && msg.tool_calls.length ? { tool_calls: normalizeToolCalls(msg.tool_calls) } : {}),
      ...(msg.reasoning ? { reasoning: String(msg.reasoning) } : {}),
      ...(Array.isArray(msg.images) && msg.images.length ? { images: msg.images } : {}),
      ...(msg.stats ? { stats: msg.stats } : {}),
      ...(msg.error ? { error: true } : {}),
      ...(msg.denied ? { denied: true } : {})
    };
    if (stored.role === 'tool' && stored.content.length > MAX_STORED_TOOL_CHARS) {
      stored.content = `${stored.content.slice(0, MAX_STORED_TOOL_CHARS)}\n……（工具输出过长，已在会话记录中截断）`;
      stored.truncated = true;
    }
    this.appendLine(session.meta.id, { t: 'msg', ...stored });
    session.messages.push(stored);
    session.meta.updatedAt = stored.at;
    session.meta.messageCount = session.messages.length;
    this.appendLine(session.meta.id, { t: 'meta', id: session.meta.id, updatedAt: session.meta.updatedAt, messageCount: session.meta.messageCount });
    return stored;
  }

  /** 派生状态：{contextState, plan, usage} —— 覆盖式写入最后一条 state 行 */
  saveState(id, patch) {
    const session = this.load(id);
    if (!session.meta) throw new Error(`会话不存在：${id}`);
    session.state = { ...(session.state || {}), ...patch, updatedAt: Date.now() };
    this.appendLine(session.meta.id, { t: 'state', ...session.state });
    return session.state;
  }

  updateMeta(id, patch) {
    const session = this.load(id);
    if (!session.meta) throw new Error(`会话不存在：${id}`);
    session.meta = { ...session.meta, ...patch, updatedAt: Date.now() };
    this.appendLine(session.meta.id, { t: 'meta', ...session.meta });
    return session.meta;
  }

  /** 截断到某条消息之后（“从这里重新问”）：唯一会重写文件的常规操作 */
  cutAfter(id, msgId, { inclusive = false } = {}) {
    const session = this.load(id);
    if (!session.meta) throw new Error(`会话不存在：${id}`);
    const idx = session.messages.findIndex((m) => String(m.id) === String(msgId));
    if (idx < 0) throw new Error(`未找到消息：${msgId}`);
    const keep = session.messages.slice(0, inclusive ? idx : idx + 1);
    session.messages = keep;
    session.seq = keep.length ? Number(keep[keep.length - 1].id) || keep.length : 0;
    // 截断后压缩水位必须重来，否则 coversUpTo 指向已不存在的消息
    if (session.state) session.state = { ...session.state, contextState: null, usage: null };
    this.rewrite(id);
    return keep;
  }

  rewrite(id) {
    const session = this.load(id);
    if (!session.meta) return false;
    const lines = [JSON.stringify({ t: 'meta', ...session.meta })];
    for (const m of session.messages) lines.push(JSON.stringify({ t: 'msg', ...m }));
    if (session.state) lines.push(JSON.stringify({ t: 'state', ...session.state }));
    const file = this.fileOf(id);
    const tmp = `${file}.tmp-${process.pid}`;
    ensureDir(path.dirname(file));
    fs.writeFileSync(tmp, `${lines.join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  }

  remove(id) {
    const key = safeId(id);
    const file = this.fileOf(key);
    this.cache.delete(key);
    const existed = fs.existsSync(file);
    if (existed) fs.rmSync(file, { force: true });
    return { removed: existed, file };
  }

  /** 图片落盘：返回消息里存放的引用（不含 base64，会话文件保持轻） */
  saveImage(dataUrlOrBuffer, { name = '', mime = '' } = {}) {
    let parsed;
    if (Buffer.isBuffer(dataUrlOrBuffer)) parsed = { mime: mime || 'image/png', buffer: dataUrlOrBuffer };
    else parsed = parseDataUrl(dataUrlOrBuffer);
    if (!parsed) throw new Error('图片数据无法识别（需要 data:image/…;base64 或 Buffer）');
    if (parsed.buffer.length > 12 * 1024 * 1024) throw new Error(`图片过大（${Math.round(parsed.buffer.length / 1048576)}MB），单张上限 12MB`);
    const hash = crypto.createHash('sha1').update(parsed.buffer).digest('hex').slice(0, 20);
    const ext = IMAGE_EXT[String(parsed.mime).toLowerCase()] || 'img';
    const file = path.join(this.assetsDir, `${hash}.${ext}`);
    ensureDir(this.assetsDir);
    if (!fs.existsSync(file)) fs.writeFileSync(file, parsed.buffer);
    return { file, name: name || guessName(parsed.mime), mime: parsed.mime, bytes: parsed.buffer.length, hash };
  }

  /** 引用 → base64（喂给视觉模型 / 给前端预览） */
  imageBase64(ref) {
    if (!ref) return null;
    if (ref.base64) return ref.base64;
    if (ref.dataUrl) {
      const p = parseDataUrl(ref.dataUrl);
      return p ? p.buffer.toString('base64') : null;
    }
    if (!ref.file) return null;
    const abs = path.resolve(ref.file);
    if (!isWithin(this.assetsDir, abs)) throw new Error(`图片不在会话资源目录内：${abs}`);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs).toString('base64');
  }

  imageDataUrl(ref) {
    const b64 = this.imageBase64(ref);
    if (!b64) return null;
    return toDataUrl(Buffer.from(b64, 'base64'), ref.mime || 'image/png');
  }

  /** 清理没有会话引用的图片（删除会话后调用，避免 assets 无限增长） */
  pruneOrphanAssets() {
    const used = new Set();
    for (const s of this.list({ limit: 100000 })) {
      const session = this.load(s.id);
      for (const m of session.messages) for (const img of m.images || []) if (img.file) used.add(path.resolve(img.file));
    }
    const removed = [];
    let files = [];
    try {
      files = fs.readdirSync(this.assetsDir);
    } catch {
      return { removed: [], scanned: 0 };
    }
    for (const f of files) {
      const abs = path.join(this.assetsDir, f);
      try {
        if (!fs.statSync(abs).isFile()) continue;
        if (used.has(path.resolve(abs))) continue;
        fs.rmSync(abs, { force: true });
        removed.push(abs);
      } catch {}
    }
    return { removed, scanned: files.length };
  }

  /** 导出为 Markdown，便于把会话当文档存档 */
  exportMarkdown(id) {
    const session = this.load(id);
    if (!session.meta) throw new Error(`会话不存在：${id}`);
    const lines = [`# ${session.meta.title || '会话记录'}`, '', `- 项目：${session.meta.projectName || '未绑定'}`, `- 模型：${session.meta.model || '-'}`, `- 时间：${new Date(session.meta.createdAt || Date.now()).toLocaleString('zh-CN')}`, `- 消息：${session.messages.length} 条`, ''];
    for (const m of session.messages) {
      if (m.role === 'tool') {
        lines.push(`> 🔧 \`${m.name || 'tool'}\` 返回：\n${clipText(String(m.content || '').replace(/\n/g, '\n> '), 1200)}\n`);
      } else if (m.role === 'assistant') {
        if (m.content) lines.push(`**Ollab**：\n\n${m.content}\n`);
        for (const c of m.tool_calls || []) lines.push(`- 调用工具 \`${c.function ? c.function.name : c.name}\`：\`${JSON.stringify(c.function ? c.function.arguments : c.arguments)}\``);
        if ((m.tool_calls || []).length) lines.push('');
      } else if (m.role === 'user') {
        const imgs = (m.images || []).map((i) => `![${i.name}](${i.file ? pathToFileHref(i.file) : ''})`).join('\n');
        lines.push(`**我**：\n\n${m.content || ''}${imgs ? `\n\n${imgs}` : ''}\n`);
      }
    }
    return lines.join('\n');
  }
}

function pathToFileHref(p) {
  return `file:///${String(p).replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

/** 工具调用形态归一：模型可能给字符串参数，落盘统一成对象，避免下次请求再判 */
function normalizeToolCalls(list) {
  return (list || []).map((c, i) => {
    const fn = c.function || {};
    let args = fn.arguments != null ? fn.arguments : c.arguments;
    if (typeof args === 'string') {
      try {
        args = args.trim() ? JSON.parse(args) : {};
      } catch {
        args = { _raw: args.slice(0, 2000) };
      }
    }
    if (!args || typeof args !== 'object') args = {};
    return { id: c.id || `call_${Date.now().toString(36)}_${i}`, type: 'function', function: { name: fn.name || c.name || '', arguments: args } };
  });
}

function clipText(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function isWithin(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function safeId(id) {
  const s = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!s) throw new Error('非法会话编号');
  return s;
}

module.exports = { SessionStore, normalizeToolCalls, parseDataUrl, toDataUrl };
