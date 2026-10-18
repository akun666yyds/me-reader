'use strict';

/**
 * 记忆存储：全局记忆 + 项目记忆（<项目根>/.omemory/）
 *
 * .omemory/ 里同时保存两种形态：
 *   memory.json   结构化条目，agent 与 UI 读写
 *   notes/*.md    人类可读副本，方便在项目里直接查看/手改
 * notes 里的正文改动会在下次 load 时按 id 回填，因此用户可以直接编辑 md 文件。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ensureDir, readJson, writeJson } = require('./paths');
const { splitFrontMatter, dumpFrontMatter } = require('./markdown');

const KINDS = ['fact', 'preference', 'decision', 'entity', 'warning'];

function nowId(text) {
  return crypto.createHash('sha1').update(`${Date.now()}${text}${Math.random()}`).digest('hex').slice(0, 12);
}

class MemoryStore {
  /**
   * @param {{file: string, scope: 'global'|'project', label?: string, notesDir?: string}} opts
   */
  constructor(opts) {
    this.file = opts.file;
    this.scope = opts.scope;
    this.label = opts.label || (opts.scope === 'project' ? path.basename(path.dirname(path.dirname(opts.file))) : '全局');
    this.notesDir = opts.notesDir || null;
    this.data = readJson(this.file, null) || { version: 1, scope: this.scope, label: this.label, items: [], updated_at: 0 };
    if (!Array.isArray(this.data.items)) this.data.items = [];
  }

  save() {
    this.data.updated_at = Date.now();
    writeJson(this.file, this.data);
    this.syncNotes();
  }

  list({ kind = null, limit = 200 } = {}) {
    const items = this.data.items.filter((i) => !kind || i.kind === kind);
    return items.slice(-limit).reverse();
  }

  all() {
    return this.data.items.slice();
  }

  stats() {
    const byKind = {};
    this.data.items.forEach((i) => {
      byKind[i.kind] = (byKind[i.kind] || 0) + 1;
    });
    return { scope: this.scope, label: this.label, total: this.data.items.length, byKind, updatedAt: this.data.updated_at, file: this.file };
  }

  add({ text, kind = 'fact', tags = [], source = 'agent', pinned = false, note = '' }) {
    const body = String(text || '').trim();
    if (!body) throw new Error('记忆内容不能为空');
    const dup = this.data.items.find((i) => normalize(i.text) === normalize(body));
    if (dup) {
      dup.updatedAt = Date.now();
      dup.hits = (dup.hits || 0) + 1;
      dup.tags = Array.from(new Set([...(dup.tags || []), ...tags]));
      if (pinned) dup.pinned = true;
      this.save();
      return { item: dup, merged: true };
    }
    const item = {
      id: nowId(body),
      text: body,
      kind: KINDS.includes(kind) ? kind : 'fact',
      tags: tags.slice(0, 8),
      source,
      pinned: !!pinned,
      note,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      hits: 0
    };
    this.data.items.push(item);
    this.save();
    return { item, merged: false };
  }

  update(id, patch) {
    const item = this.data.items.find((i) => i.id === id);
    if (!item) throw new Error(`记忆条目不存在：${id}`);
    Object.assign(item, patch, { updatedAt: Date.now() });
    if (patch.kind && !KINDS.includes(patch.kind)) item.kind = 'fact';
    this.save();
    return item;
  }

  remove(id) {
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((i) => i.id !== id);
    if (before !== this.data.items.length) this.save();
    return before - this.data.items.length;
  }

  clear() {
    const n = this.data.items.length;
    this.data.items = [];
    this.save();
    return n;
  }

  /** 关键词打分检索（记忆条目短，纯规则足够；需要语义召回时由 RAG 层补强） */
  search(query, { topK = 8 } = {}) {
    const tokens = tokenize(query);
    if (!tokens.length) return { results: this.list({ limit: topK }), tokens: [] };
    const scored = this.data.items.map((i) => {
      const hay = normalize(`${i.text} ${(i.tags || []).join(' ')} ${i.note || ''}`);
      let hit = 0;
      for (const t of tokens) if (hay.includes(t)) hit++;
      return { item: i, score: hit + (i.pinned ? 0.5 : 0) + Math.min(2, (i.hits || 0) * 0.1) };
    });
    const results = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, topK).map((s) => ({ ...s.item, score: Math.round(s.score * 100) / 100 }));
    return { results, tokens };
  }

  /** 注入系统提示：固定项优先，其余按最近使用 */
  forPrompt({ query = '', max = 12 } = {}) {
    const pinned = this.data.items.filter((i) => i.pinned);
    const searched = query ? this.search(query, { topK: max }).results : [];
    const recent = this.data.items
      .filter((i) => !i.pinned)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, max);
    const seen = new Set();
    const out = [];
    for (const i of [...pinned, ...searched, ...recent]) {
      if (seen.has(i.id) || out.length >= max) continue;
      seen.add(i.id);
      out.push(i);
    }
    return out;
  }

  /** 结构化条目 → notes/*.md，方便用户在项目里直接看与改 */
  syncNotes() {
    if (!this.notesDir) return;
    try {
      ensureDir(this.notesDir);
      const ids = new Set(this.data.items.map((i) => i.id));
      for (const f of fs.readdirSync(this.notesDir)) {
        if (!/\.md$/i.test(f)) continue;
        const id = f.replace(/\.md$/i, '').split('__')[1];
        if (id && !ids.has(id)) fs.rmSync(path.join(this.notesDir, f), { force: true });
      }
      for (const i of this.data.items) {
        const file = path.join(this.notesDir, `${i.kind}__${i.id}.md`);
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const { data, body } = splitFrontMatter(existing);
        // 用户直接编辑过正文时以 md 为准回填 JSON
        if (data && body && normalize(body) !== normalize(i.text)) {
          i.text = body.trim();
          i.updatedAt = Date.now();
        } else if (data) {
          fs.writeFileSync(file, noteMarkdown(i), 'utf8');
          continue;
        }
        fs.writeFileSync(file, noteMarkdown(i), 'utf8');
      }
    } catch (err) {
      console.warn('[MeReader] 记忆笔记同步失败：', err.message);
    }
  }

  /** 读取 notes/*.md 的手工新增条目（无 id 的新文件会被登记） */
  importNotes() {
    if (!this.notesDir || !fs.existsSync(this.notesDir)) return 0;
    let added = 0;
    for (const f of fs.readdirSync(this.notesDir)) {
      if (!/\.md$/i.test(f)) continue;
      const known = this.data.items.some((i) => f === `${i.kind}__${i.id}.md`);
      if (known) continue;
      const { data, body } = splitFrontMatter(fs.readFileSync(path.join(this.notesDir, f), 'utf8'));
      const text = (body || '').trim();
      if (!text) continue;
      const kindFromData = data && KINDS.includes(data.kind) ? data.kind : null;
      const kindFromFile = KINDS.find((k) => f.startsWith(`${k}__`)) || null;
      this.add({ text, kind: kindFromData || kindFromFile || 'fact', tags: (data && Array.isArray(data.tags) ? data.tags : []) , pinned: !!(data && data.pinned), source: 'user' });
      added++;
    }
    if (added) this.save();
    return added;
  }
}

function noteMarkdown(i) {
  return `${dumpFrontMatter({
    id: i.id,
    kind: i.kind,
    tags: i.tags || [],
    pinned: !!i.pinned,
    source: i.source || 'agent',
    created_at: new Date(i.createdAt).toISOString(),
    updated_at: new Date(i.updatedAt || i.createdAt).toISOString()
  })}\n\n${i.text}\n`;
}

function normalize(s) {
  return String(s).replace(/\s+/g, '').toLowerCase();
}

function tokenize(q) {
  return String(q || '')
    .toLowerCase()
    .split(/[\s,，。.、;；:：!！?？()（）\[\]{}\-_/\\]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 12);
}

function globalMemoryStore(paths) {
  return new MemoryStore({ file: paths.agentMemoryFile, scope: 'global', label: '全局' });
}

function projectMemoryStore(paths, root) {
  ensureDir(path.join(root, '.omemory'));
  return new MemoryStore({ file: paths.projectMemoryFile(root), scope: 'project', label: path.basename(root), notesDir: paths.projectNotesDir(root) });
}

module.exports = { MemoryStore, globalMemoryStore, projectMemoryStore, KINDS };
