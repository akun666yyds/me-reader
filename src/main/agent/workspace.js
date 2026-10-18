'use strict';

/**
 * 项目工作区：项目登记表 + 沙箱化文件访问
 *
 * 安全边界：agent 与文件树的一切读写都被限制在项目根目录内。
 * 解析路径时先做词法归一化，再对已存在的父目录取 realpath，
 * 以阻断 ..\ 穿越与符号链接逃逸；.omemory/.oskill/.orag 在树中隐藏但 agent 可读写。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { HIDDEN_DIR_RE, readJson, writeJson, ensureDir } = require('./paths');

const MD_RE = /\.(md|markdown|mdown|mkd|mkdn)$/i;
const TXT_RE = /\.(txt|text|log|csv|tsv)$/i;
const HTML_RE = /\.(html?|xhtml|vue|svelte)$/i;
const JSON_RE = /\.(json|jsonc|json5|jsonl|ndjson)$/i;
const XML_RE = /\.(xml|xsl|svg|plist|xsd|rss|atom)$/i;
const JS_RE = /\.(js|mjs|cjs|jsx|ts|tsx|coffee)$/i;
const CSS_RE = /\.(css|scss|sass|less|styl)$/i;
const IMG_RE = /\.(png|jpe?g|gif|bmp|webp|ico|avif|tiff?)$/i;
const CODE_RE = /\.(py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|sh|bash|zsh|ps1|sql|lua|toml|ini|conf|yaml|yml|env|make|dockerfile|bat|cmd)$/i;

/**
 * 图标类型（与文件树渲染一一对应）：
 *   dir 📂 / md 📝 / txt 📃 / html 🌐 / json {} / xml </> / js系 JS / image 🖼
 *   其余带「.」后缀（css、yaml、py、.gitignore…）统一 config ⚙️，无后缀文件 other
 */
function fileKind(name, isDir) {
  if (isDir) return 'dir';
  if (MD_RE.test(name)) return 'md';
  if (HTML_RE.test(name)) return 'html';
  if (JS_RE.test(name)) return 'js';
  if (JSON_RE.test(name)) return 'json';
  if (XML_RE.test(name)) return 'xml';
  if (IMG_RE.test(name)) return 'image';
  if (TXT_RE.test(name)) return 'txt';
  if (name.startsWith('.') || /\.[a-z0-9_+-]+$/i.test(name)) return 'config';
  return 'other';
}

/** 语言标识，供 agent 写代码与编辑器高亮使用（与图标类型解耦） */
function codeLang(name) {
  if (JS_RE.test(name)) return 'javascript';
  if (CSS_RE.test(name)) return 'css';
  if (HTML_RE.test(name)) return 'html';
  if (JSON_RE.test(name)) return 'json';
  if (XML_RE.test(name)) return 'xml';
  if (/\.(py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|swift|sh|bash|ps1|sql|lua)$/i.test(name)) return name.split('.').pop();
  if (/\.(ya?ml|toml|ini|conf|env)$/i.test(name)) return 'ini';
  return 'text';
}

const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'build', 'out', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'target', '.next', '.cache']);

class Workspace {
  /** @param {{registryFile: string}} opts 项目登记表位置（userData/agent/projects.json） */
  constructor(opts) {
    this.registryFile = opts.registryFile;
    this.projects = readJson(this.registryFile, { items: [], activeId: null });
    if (!Array.isArray(this.projects.items)) this.projects = { items: [], activeId: null };
  }

  save() {
    writeJson(this.registryFile, this.projects);
  }

  list() {
    return this.projects.items.map(publicProject);
  }

  get(id) {
    return this.projects.items.find((p) => p.id === id) || null;
  }

  getRoot(id) {
    const p = this.get(id);
    if (!p) throw new Error(`项目不存在：${id}`);
    return p.root;
  }

  activeId() {
    return this.projects.activeId && this.get(this.projects.activeId) ? this.projects.activeId : null;
  }

  /** 当前活动项目根（供「在当前工作目录内工作」使用） */
  activeRoot() {
    const id = this.activeId();
    return id ? this.getRoot(id) : null;
  }

  setActive(id) {
    if (!this.get(id)) throw new Error(`项目不存在：${id}`);
    this.projects.activeId = id;
    const p = this.get(id);
    p.lastOpenedAt = Date.now();
    this.save();
    return publicProject(p);
  }

  /** 添加项目文件夹；同一物理目录不会重复登记 */
  add(root, name) {
    const abs = path.resolve(root);
    const stat = fs.statSync(abs);
    if (!stat.isDirectory()) throw new Error(`不是目录：${abs}`);
    const real = fs.realpathSync(abs);
    const dup = this.projects.items.find((p) => normKey(p.root) === normKey(real));
    if (dup) {
      dup.root = real;
      if (name) dup.name = name;
      dup.lastOpenedAt = Date.now();
      this.save();
      return publicProject(dup);
    }
    const item = {
      id: crypto.randomUUID(),
      name: name || path.basename(real),
      root: real,
      addedAt: Date.now(),
      lastOpenedAt: Date.now()
    };
    this.projects.items.push(item);
    if (!this.projects.activeId) this.projects.activeId = item.id;
    this.save();
    return publicProject(item);
  }

  rename(id, name) {
    const p = this.get(id);
    if (!p) throw new Error(`项目不存在：${id}`);
    p.name = String(name).trim() || p.name;
    this.save();
    return publicProject(p);
  }

  /** 仅从列表移除，不删除磁盘文件 */
  remove(id) {
    const before = this.projects.items.length;
    this.projects.items = this.projects.items.filter((p) => p.id !== id);
    if (this.projects.activeId === id) this.projects.activeId = (this.projects.items[0] || {}).id || null;
    this.save();
    return before !== this.projects.items.length;
  }

  /**
   * 把用户/agent 给出的路径解析为项目内绝对路径。
   * 允许：项目内相对路径、项目内绝对路径、'.' 或空串表示项目根。
   */
  resolve(projectId, target) {
    const root = this.getRoot(projectId);
    const realRoot = safeRealpath(root);
    const raw = String(target == null ? '' : target).trim();
    if (raw === '' || raw === '.' || raw === './') return { root, abs: root, rel: '', kind: 'dir' };

    const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
    const rel = path.relative(realRoot, candidate);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`路径越界：${raw} 不在项目「${path.basename(root)}」内`);
    }
    const existingParent = safeRealpath(path.dirname(candidate)) || safeRealpath(realRoot);
    if (existingParent && !isWithin(existingParent, candidate) && existingParent !== realRoot) {
      throw new Error(`路径越界（符号链接）：${raw}`);
    }
    const posixRel = rel.split(path.sep).join('/');
    return { root, abs: candidate, rel: posixRel, kind: 'unknown' };
  }

  /** 目录树（单层，供懒加载展开） */
  tree(projectId, rel = '', { includeHiddenAgentDirs = false, ignoreFilter = true } = {}) {
    const { abs, root } = this.resolve(projectId, rel);
    if (!fs.existsSync(abs)) {
      if (!rel && !fs.existsSync(root)) throw new Error(`项目目录已不存在：${root}（可在文件树右键「移除项目」）`);
      throw new Error(`目录不存在：${rel || '/'}`);
    }
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    const out = [];
    for (const ent of entries) {
      const name = ent.name;
      if (ignoreFilter && IGNORE_DIRS.has(name)) continue;
      if (!includeHiddenAgentDirs && HIDDEN_DIR_RE.test(name)) continue;
      let isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        try {
          isDir = fs.statSync(path.join(abs, name)).isDirectory();
        } catch {
          continue;
        }
      }
      const childRel = rel ? `${rel}/${name}` : name;
      let size = null;
      let mtime = null;
      try {
        const st = isDir ? null : fs.statSync(path.join(abs, name));
        size = st ? st.size : null;
        mtime = (st || fs.statSync(path.join(abs, name))).mtimeMs;
      } catch {}
      out.push({
        name,
        rel: childRel,
        dir: isDir,
        kind: fileKind(name, isDir),
        size,
        mtime,
        hasChildren: isDir ? this.mayHaveChildren(path.join(abs, name)) : false
      });
    }
    out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
    return { rel, parent: rel ? path.posix.dirname(rel) : '', entries: out };
  }

  mayHaveChildren(dir) {
    try {
      return fs.readdirSync(dir).some((n) => !IGNORE_DIRS.has(n) && !HIDDEN_DIR_RE.test(n));
    } catch {
      return false;
    }
  }

  read(projectId, target, { maxBytes = 2 * 1024 * 1024 } = {}) {
    const r = this.resolve(projectId, target);
    const st = fs.statSync(r.abs);
    if (st.isDirectory()) throw new Error(`目标是目录：${target}`);
    if (st.size > maxBytes) throw new Error(`文件过大（${fmtBytes(st.size)} > ${fmtBytes(maxBytes)}），请指定片段读取`);
    let text = fs.readFileSync(r.abs, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { rel: r.rel, abs: r.abs, content: normalizeNewlines(text), size: st.size, mtime: st.mtimeMs };
  }

  readBuffer(projectId, target, { maxBytes = 8 * 1024 * 1024 } = {}) {
    const r = this.resolve(projectId, target);
    const st = fs.statSync(r.abs);
    if (st.size > maxBytes) throw new Error(`文件过大（${fmtBytes(st.size)}）`);
    return { rel: r.rel, abs: r.abs, buffer: fs.readFileSync(r.abs), size: st.size, mtime: st.mtimeMs };
  }

  /** 写文件：自动建父目录，保持 CRLF 风格；可要求「仅在未变更时写入」 */
  write(projectId, target, content, { append = false } = {}) {
    const r = this.resolve(projectId, target);
    if (!r.rel) throw new Error('不能直接写入项目根目录本身');
    if (fs.existsSync(r.abs) && fs.statSync(r.abs).isDirectory()) throw new Error(`目标是目录：${target}`);
    ensureDir(path.dirname(r.abs));
    const text = String(content);
    // 保持既有文件的换行风格；新文件按平台默认（Windows 用 CRLF，与编辑器写盘一致）
    const hadCrlf = fs.existsSync(r.abs) ? /\r\n/.test(fs.readFileSync(r.abs, 'utf8')) : process.platform === 'win32';
    const out = hadCrlf ? text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : text;
    if (append) fs.appendFileSync(r.abs, out, 'utf8');
    else fs.writeFileSync(r.abs, out, 'utf8');
    const st = fs.statSync(r.abs);
    return { rel: r.rel, abs: r.abs, size: st.size, mtime: st.mtimeMs, created: !append };
  }

  removeFile(projectId, target) {
    const r = this.resolve(projectId, target);
    if (!r.rel) throw new Error('不能删除项目根目录');
    if (!fs.existsSync(r.abs)) throw new Error(`文件不存在：${target}`);
    const st = fs.statSync(r.abs);
    if (st.isDirectory()) fs.rmSync(r.abs, { recursive: true, force: true });
    else fs.unlinkSync(r.abs);
    return { rel: r.rel, dir: st.isDirectory() };
  }

  move(projectId, from, to) {
    const a = this.resolve(projectId, from);
    const b = this.resolve(projectId, to);
    if (!a.rel) throw new Error('不能移动项目根目录');
    if (fs.existsSync(b.abs)) throw new Error(`目标已存在：${to}`);
    ensureDir(path.dirname(b.abs));
    fs.renameSync(a.abs, b.abs);
    return { from: a.rel, to: b.rel, abs: b.abs };
  }

  mkdir(projectId, target) {
    const r = this.resolve(projectId, target);
    ensureDir(r.abs);
    return { rel: r.rel, abs: r.abs };
  }

  exists(projectId, target) {
    try {
      const r = this.resolve(projectId, target);
      return fs.existsSync(r.abs);
    } catch {
      return false;
    }
  }

  stat(projectId, target) {
    const r = this.resolve(projectId, target);
    const st = fs.statSync(r.abs);
    return {
      rel: r.rel,
      abs: r.abs,
      dir: st.isDirectory(),
      kind: fileKind(path.basename(r.abs), st.isDirectory()),
      size: st.size,
      mtime: st.mtimeMs
    };
  }

  /** 列出项目内全部受索引关注的文件（跳过依赖目录与隐藏 agent 目录） */
  walk(projectId, { maxFiles = 5000, maxDepth = 12 } = {}) {
    const root = this.getRoot(projectId);
    const realRoot = safeRealpath(root);
    const files = [];
    const stack = [{ dir: realRoot, rel: '' }];
    while (stack.length) {
      const { dir, rel } = stack.pop();
      let ents;
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of ents) {
        if (IGNORE_DIRS.has(ent.name) || HIDDEN_DIR_RE.test(ent.name)) continue;
        const absChild = path.join(dir, ent.name);
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        let isDir = ent.isDirectory();
        if (ent.isSymbolicLink()) {
          try {
            const real = fs.realpathSync(absChild);
            if (!isWithin(realRoot, real)) continue;
            isDir = fs.statSync(real).isDirectory();
          } catch {
            continue;
          }
        }
        if (isDir) {
          if (childRel.split('/').length <= maxDepth) stack.push({ dir: absChild, rel: childRel });
        } else if (files.length < maxFiles) {
          try {
            const st = fs.statSync(absChild);
            files.push({ rel: childRel, abs: absChild, size: st.size, mtime: st.mtimeMs, kind: fileKind(ent.name, false) });
          } catch {}
        }
      }
      if (files.length >= maxFiles) break;
    }
    return files;
  }

  /** 在项目内做纯文本检索（agent 的 grep 能力，规则实现、零依赖） */
  search(projectId, needle, { regex = false, caseSensitive = false, maxResults = 80, include, file = 0 } = {}) {
    const root = this.getRoot(projectId);
    const flags = caseSensitive ? 'g' : 'gi';
    let re;
    try {
      re = regex ? new RegExp(needle, flags) : new RegExp(escapeRe(needle), flags);
    } catch (err) {
      throw new Error(`检索表达式无效：${err.message}`);
    }
    // include 用 glob 语义（*.md、src/**\/*.ts、docs/），避免用户写正则时被转义规则绊住
    const includeRe = include ? globToRe(include) : null;
    const candidates = this.walk(projectId).filter((f) => (includeRe ? includeRe.test(f.rel) : textLike(f.kind)));
    const results = [];
    for (const f of candidates) {
      if (results.length >= maxResults) break;
      if (f.size > 4 * 1024 * 1024) continue;
      let text;
      try {
        text = normalizeNewlines(fs.readFileSync(f.abs, 'utf8'));
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        if (re.test(lines[i])) {
          results.push({ rel: f.rel, line: i + 1, text: lines[i].slice(0, 400) });
          re.lastIndex = 0;
        }
      }
    }
    return { query: needle, total: results.length, truncated: results.length >= maxResults, results };
  }

  /** 把外部图片复制进项目（agent 插图时使用），返回项目内相对路径 */
  importAsset(projectId, sourceAbs, subdir = 'assets') {
    const root = this.getRoot(projectId);
    if (!fs.existsSync(sourceAbs)) throw new Error(`源文件不存在：${sourceAbs}`);
    const st = fs.statSync(sourceAbs);
    if (st.size > 32 * 1024 * 1024) throw new Error('图片过大（>32MB）');
    const ext = path.extname(sourceAbs) || '.png';
    const base = path.basename(sourceAbs, ext).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(0, 48);
    const dirRel = subdir.split(path.sep).join('/');
    const targetDir = path.join(root, dirRel);
    ensureDir(targetDir);
    let name = `${base}${ext}`;
    let n = 2;
    while (fs.existsSync(path.join(targetDir, name))) {
      name = `${base}-${n++}${ext}`;
    }
    const targetAbs = path.join(targetDir, name);
    fs.copyFileSync(sourceAbs, targetAbs);
    return { rel: `${dirRel}/${name}`, abs: targetAbs, size: st.size };
  }
}

const TEXT_KINDS = new Set(['md', 'txt', 'html', 'json', 'xml', 'js', 'config', 'other']);
const textLike = (kind) => TEXT_KINDS.has(kind);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function globToRe(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '.*')
    .replace(/\u0002/g, '.*');
  return new RegExp(`(^|/)${escaped}$`, 'i');
}
function normalizeNewlines(s) {
  return s.replace(/\r\n/g, '\n');
}
function fmtBytes(n) {
  if (n > 1024 * 1024) return `${(n / 1048576).toFixed(1)}MB`;
  if (n > 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}
function normKey(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}
function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
function safeRealpath(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return null;
      tail.unshift(path.basename(cur));
      cur = up;
    }
  }
}
function publicProject(p) {
  return { id: p.id, name: p.name, root: p.root, addedAt: p.addedAt, lastOpenedAt: p.lastOpenedAt, exists: fs.existsSync(p.root) };
}

module.exports = { Workspace, fileKind, codeLang, IGNORE_DIRS, isWithin, safeRealpath, normalizeNewlines, fmtBytes };
