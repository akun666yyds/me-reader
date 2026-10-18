'use strict';

/**
 * 轻量 RAG：分块 → Ollama 嵌入 → JSON 向量库 → 余弦 top-k + MMR 去重
 *
 * 索引落盘位置：
 *   项目：<项目根>/.orag/index.json          （跟着项目走，可随项目提交）
 *   全局：<userData>/agent/rag/global-<模型>.json
 * 向量按 Float32 → base64 存储，单文件小、读取快，无需任何数据库依赖。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ensureDir, readJson, writeJson } = require('./paths');
const { chunkForEmbedding, estimateTokens, sections } = require('./markdown');

const INDEX_VERSION = 1;

function b64Encode(vec) {
  const f = new Float32Array(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64');
}

function b64Decode(str) {
  const buf = Buffer.from(str, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 关键词命中（给向量分数做加性修正，中文场景下非常有效且零成本） */
function lexicalScore(queryTokens, text) {
  if (!queryTokens.length) return 0;
  const lower = text.toLowerCase();
  let hit = 0;
  for (const t of queryTokens) if (t && lower.includes(t)) hit++;
  return hit / queryTokens.length;
}

function queryTokensOf(q) {
  return String(q)
    .toLowerCase()
    .split(/[\s,，。.、;；:：!！?？()（）\[\]{}\-_/\\]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 || /[\u4e00-\u9fff]{2,}/.test(s))
    .slice(0, 12);
}

class RagStore {
  /**
   * @param {{file: string, model: string, client: OllamaClient, scope: 'project'|'global', label?: string}} opts
   */
  constructor(opts) {
    this.file = opts.file;
    this.model = opts.model;
    this.client = opts.client;
    this.scope = opts.scope || 'global';
    this.label = opts.label || '';
    this.data = readJson(this.file, null) || { version: INDEX_VERSION, scope: this.scope, model: this.model, label: this.label, docs: {}, updated_at: 0 };
    if (this.data.model !== this.model) {
      // 换嵌入模型等于换向量空间，旧向量不可复用
      this.data = { version: INDEX_VERSION, scope: this.scope, model: this.model, label: this.label, docs: {}, updated_at: 0 };
    }
  }

  stats() {
    const docs = Object.values(this.data.docs);
    return {
      scope: this.data.scope,
      label: this.data.label,
      model: this.data.model,
      files: docs.length,
      chunks: docs.reduce((s, d) => s + d.chunks.length, 0),
      dim: (docs[0] && docs[0].chunks[0] && docs[0].chunks[0].dim) || 0,
      updatedAt: this.data.updated_at,
      file: this.file
    };
  }

  save() {
    this.data.updated_at = Date.now();
    writeJson(this.file, this.data);
  }

  /** 清空（可选只清某个文件） */
  clear(rel) {
    if (rel) delete this.data.docs[rel];
    else this.data.docs = {};
    this.save();
  }

  has(rel) {
    return !!this.data.docs[rel];
  }

  /** 单文件入库：内容未变化则跳过 */
  async indexFile(rel, text, { mtime = Date.now(), kind = 'md' } = {}) {
    const hash = crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
    const prev = this.data.docs[rel];
    if (prev && prev.hash === hash) return { rel, skipped: true, chunks: prev.chunks.length };

    const chunks = chunkForEmbedding(text, { tokens: 320, overlap: 48 });
    if (!chunks.length) {
      delete this.data.docs[rel];
      this.save();
      return { rel, chunks: 0 };
    }
    const vectors = await this.embedBatch(chunks);
    this.data.docs[rel] = {
      rel,
      kind,
      hash,
      mtime,
      indexed_at: Date.now(),
      chunks: chunks.map((content, i) => ({
        i,
        content,
        tokens: estimateTokens(content),
        dim: vectors[i].length,
        v: b64Encode(vectors[i]),
        title: firstHeading(content)
      }))
    };
    this.save();
    return { rel, chunks: chunks.length, reindexed: !!prev };
  }

  async embedBatch(texts, { batchSize = 32 } = {}) {
    const out = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const slice = texts.slice(i, i + batchSize);
      const vectors = await this.client.embed(slice, this.model);
      // 某些模型对空输入返回空向量，补零避免索引错位
      for (let j = 0; j < slice.length; j++) out.push(vectors[j] && vectors[j].length ? vectors[j] : new Array(vectors[0] ? vectors[0].length || 768 : 768).fill(0));
    }
    return out;
  }

  /** 移除已删除文件 */
  prune(existingRels) {
    const keep = new Set(existingRels);
    let removed = 0;
    for (const rel of Object.keys(this.data.docs)) {
      if (!keep.has(rel)) {
        delete this.data.docs[rel];
        removed++;
      }
    }
    if (removed) this.save();
    return removed;
  }

  /**
   * 检索。score = 0.8 * 余弦 + 0.2 * 关键词命中；MMR 式去重避免同一段落刷屏。
   * 返回 [{ rel, text, score, chunkIndex, title, tokens }]
   */
  async query(queryText, { topK = 5, kindFilter = null, minScore = 0.12 } = {}) {
    const qTokens = queryTokensOf(queryText);
    const entries = [];
    for (const doc of Object.values(this.data.docs)) {
      if (kindFilter && !kindFilter.includes(doc.kind)) continue;
      for (const c of doc.chunks) {
        entries.push({ doc, chunk: c });
      }
    }
    if (!entries.length) return { results: [], indexed: this.stats(), reason: '索引为空，请先建立索引' };

    const [qv] = await this.embedBatch([queryText]);
    const scored = entries.map(({ doc, chunk }) => {
      const vec = b64Decode(chunk.v);
      const cos = cosine(qv, vec);
      const lex = lexicalScore(qTokens, `${doc.rel} ${chunk.title} ${chunk.content}`);
      return {
        rel: doc.rel,
        kind: doc.kind,
        title: chunk.title,
        chunkIndex: chunk.i,
        tokens: chunk.tokens,
        text: chunk.content,
        score: Math.round((cos * 0.8 + lex * 0.2) * 1000) / 1000,
        cos: Math.round(cos * 1000) / 1000,
        lexical: Math.round(lex * 100) / 100
      };
    });
    scored.sort((a, b) => b.score - a.score);

    const picked = [];
    const seenRel = new Map();
    for (const s of scored) {
      if (s.score < minScore) break;
      const sameFile = seenRel.get(s.rel) || 0;
      if (sameFile >= 2) continue; // 同一文件最多贡献两块
      seenRel.set(s.rel, sameFile + 1);
      if (picked.length && nearDuplicate(picked[picked.length - 1].text, s.text)) continue;
      picked.push(s);
      if (picked.length >= topK) break;
    }
    return { results: picked, indexed: this.stats() };
  }

  /**
   * 全量/增量重建：由调用方给出文件清单与读取函数，便于沙箱化与进度回调。
   * @param {{list: Array<{rel:string, abs?:string, mtime:number}>, read: (item)=>string, onProgress?: fn}} plan
   */
  async rebuild(plan, { onProgress, concurrency = 4, limit = 800 } = {}) {
    const items = plan.list.slice(0, limit);
    let done = 0;
    let indexed = 0;
    let skipped = 0;
    const errors = [];
    const queue = [...items];
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          const text = plan.read(item);
          const r = await this.indexFile(item.rel, text, { mtime: item.mtime, kind: item.kind || 'md' });
          if (r.skipped) skipped++;
          else indexed++;
        } catch (err) {
          errors.push({ rel: item.rel, error: String(err.message || err).slice(0, 160) });
        }
        done++;
        if (onProgress) onProgress({ done, total: items.length, indexed, skipped, current: item.rel });
      }
    });
    await Promise.all(workers);
    const removed = this.prune(items.map((i) => i.rel));
    this.save();
    return { done: items.length, indexed, skipped, removed, errors };
  }
}

function firstHeading(content) {
  const m = /^#{1,6}\s+(.+)$/m.exec(content);
  if (m) return m[1].trim().slice(0, 80);
  const sec = sections(content, { maxLevel: 2 })[0];
  if (sec && sec.title) return sec.title.slice(0, 80);
  return String(content).split('\n')[0].trim().slice(0, 60);
}

function nearDuplicate(a, b) {
  const na = String(a).replace(/\s+/g, '').slice(0, 200);
  const nb = String(b).replace(/\s+/g, '').slice(0, 200);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb.slice(0, 80)) || nb.includes(na.slice(0, 80));
}

/** 项目库与全局库的工厂，路径统一由 DataPaths 提供 */
function projectRagStore(paths, root, { model, client }) {
  ensureDir(paths.projectDir(root).orag);
  return new RagStore({ file: paths.projectRagFile(root), model, client, scope: 'project', label: path.basename(root) });
}

function globalRagStore(paths, { model, client }) {
  return new RagStore({ file: paths.globalRagFile(model), model, client, scope: 'global', label: '全局' });
}

module.exports = { RagStore, projectRagStore, globalRagStore, cosine, b64Encode, b64Decode, queryTokensOf, INDEX_VERSION };
