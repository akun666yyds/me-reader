'use strict';

/**
 * 技能库：内置技能落盘 + 全局技能目录 + 项目 .oskill 目录
 *
 * 一个技能就是一个 md 文件：frontmatter 是元数据（name/title/description/when/tools/enabled），
 * 正文是要注入系统提示的操作说明。项目技能覆盖同名全局技能，
 * 停用状态记录在 agent/config.json 的 skillsDisabled 里，不改技能文件本身。
 */

const fs = require('fs');
const path = require('path');

const { ensureDir, readJson, writeJson } = require('./paths');
const { splitFrontMatter, dumpFrontMatter, toLf } = require('./markdown');
const { BUILTIN_SKILLS } = require('./builtin-skills');

const FRONT = ['name', 'title', 'description', 'when', 'tools', 'enabled', 'scope', 'version'];

function slugName(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5._-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, 48);
}

function toMarkdown(skill) {
  const meta = {
    name: skill.name,
    title: skill.title || skill.name,
    description: skill.description || '',
    when: skill.when || [],
    tools: skill.tools || [],
    enabled: skill.enabled !== false,
    version: skill.version || 1
  };
  if (skill.builtin) meta.builtin = true;
  return `${dumpFrontMatter(meta)}\n\n${toLf(skill.body || '').trim()}\n`;
}

function parseSkillFile(file, scope) {
  const raw = fs.readFileSync(file, 'utf8');
  const { data, body } = splitFrontMatter(raw);
  const name = slugName((data && data.name) || path.basename(file, '.md'));
  if (!name) return null;
  const when = asArray(data && data.when);
  const tools = asArray(data && data.tools);
  return {
    name,
    title: (data && data.title) || name,
    description: (data && data.description) || firstLine(body),
    when,
    tools,
    enabled: !(data && (data.enabled === false || data.enabled === 'false')),
    body: body.trim(),
    scope,
    file,
    mtime: fs.statSync(file).mtimeMs,
    builtin: !!(data && data.builtin)
  };
}

function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  return String(v)
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function firstLine(s) {
  const line = toLf(s || '')
    .split('\n')
    .find((l) => l.trim() && !l.startsWith('#'));
  return (line || '').slice(0, 120);
}

class SkillLibrary {
  /**
   * @param {{globalDir: string, projectDir: string|null, stateFile: string|null}} opts
   *   stateFile 存放停用开关（agent/config.json 的 skillsDisabled 字段由外部合并传入也可）
   */
  constructor(opts) {
    this.globalDir = opts.globalDir;
    this.projectDir = opts.projectDir || null;
    this.disabled = new Set((opts.disabled || []).map(String));
  }

  /** 首次运行把内置技能写成可编辑的 md 文件；已存在则不覆盖用户改动 */
  ensureBuiltins() {
    ensureDir(this.globalDir);
    const written = [];
    for (const s of BUILTIN_SKILLS) {
      const file = path.join(this.globalDir, `${s.name}.md`);
      if (fs.existsSync(file)) continue;
      fs.writeFileSync(file, toMarkdown({ ...s, enabled: true, builtin: true }), 'utf8');
      written.push(s.name);
    }
    return written;
  }

  dirFor(scope) {
    if (scope === 'project') {
      if (!this.projectDir) throw new Error('当前没有活动项目，无法写入项目技能');
      return this.projectDir;
    }
    return this.globalDir;
  }

  loadDir(dir, scope) {
    if (!dir || !fs.existsSync(dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      if (!/\.md$/i.test(f)) continue;
      try {
        const s = parseSkillFile(path.join(dir, f), scope);
        if (s) out.push(s);
      } catch (err) {
        console.warn('[MeReader] 技能文件解析失败：', f, err.message);
      }
    }
    return out;
  }

  /** 项目技能覆盖同名全局技能；内置技能始终排在前面 */
  list() {
    const globals = this.loadDir(this.globalDir, 'global');
    const projects = this.loadDir(this.projectDir, 'project');
    const byName = new Map();
    for (const s of globals) byName.set(s.name, s);
    for (const s of projects) byName.set(s.name, { ...s, scope: 'project', overrides: byName.has(s.name) });
    const items = [...byName.values()].map((s) => ({ ...s, enabled: s.enabled !== false && !this.disabled.has(s.name) }));
    items.sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin) || a.title.localeCompare(b.title, 'zh-Hans-CN'));
    return items;
  }

  get(name) {
    return this.list().find((s) => s.name === slugName(name)) || null;
  }

  setEnabled(name, enabled) {
    const key = slugName(name);
    if (enabled) this.disabled.delete(key);
    else this.disabled.add(key);
    return { name: key, enabled: !!enabled, disabled: [...this.disabled] };
  }

  save({ name, title, description, when = [], tools = [], body, scope = 'global', enabled = true }) {
    const key = slugName(name);
    if (!key) throw new Error('技能名称无效');
    const dir = this.dirFor(scope);
    ensureDir(dir);
    const file = path.join(dir, `${key}.md`);
    const existing = fs.existsSync(file) ? parseSkillFile(file, scope) : null;
    const skill = {
      name: key,
      title: title || (existing && existing.title) || key,
      description: description || (existing && existing.description) || '',
      when: when.length ? when : (existing && existing.when) || [],
      tools: tools.length ? tools : (existing && existing.tools) || [],
      body: body != null ? body : (existing && existing.body) || '',
      enabled,
      version: ((existing && existing.version) || 1) + (existing ? 1 : 0),
      builtin: existing ? !!existing.builtin : false
    };
    fs.writeFileSync(file, toMarkdown(skill), 'utf8');
    return { ...skill, scope, file };
  }

  remove(name) {
    const key = slugName(name);
    const skill = this.get(key);
    if (!skill) return false;
    if (skill.builtin) {
      // 内置技能只允许停用，不允许删除，避免误删后无法恢复
      this.setEnabled(key, false);
      return 'disabled';
    }
    fs.rmSync(skill.file, { force: true });
    return true;
  }

  /** 按触发词匹配技能，返回带命中数的排序结果 */
  match(query, { topK = 3 } = {}) {
    const q = String(query || '').toLowerCase();
    return this.list()
      .filter((s) => s.enabled)
      .map((s) => {
        let hits = 0;
        for (const w of s.when) if (w && q.includes(String(w).toLowerCase())) hits++;
        if (q.includes(s.name.toLowerCase())) hits += 2;
        const inTitle = s.title && q.includes(String(s.title).toLowerCase());
        return { skill: s, hits: hits + (inTitle ? 2 : 0) };
      })
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, topK)
      .map((x) => ({ ...x.skill, hits: x.hits }));
  }

  /**
   * 生成注入系统提示的技能段：
   * 命中技能给全文，其余启用技能只给一行索引，让模型知道还能用什么。
   */
  promptBlock(query, { maxFull = 2, fullCharBudget = 6000 } = {}) {
    const all = this.list().filter((s) => s.enabled);
    if (!all.length) return '';
    const matched = this.match(query, { topK: maxFull });
    const matchedNames = new Set(matched.map((s) => s.name));
    let budget = fullCharBudget;
    const full = [];
    for (const s of matched) {
      const text = `### 技能：${s.title}（${s.name}${s.scope === 'project' ? '，项目级' : ''}）\n${s.body}`;
      if (text.length > budget && full.length) break;
      full.push(text);
      budget -= text.length;
    }
    const rest = all.filter((s) => !matchedNames.has(s.name)).map((s) => `- ${s.title}（${s.name}）：${s.description}`);
    const lines = ['## 可用技能'];
    if (full.length) lines.push('以下技能与本次任务直接相关，按其中的规程执行：', '', ...full);
    if (rest.length) lines.push('', '其余已启用技能（需要时说明你要用哪个，我会展开其规程）：', ...rest);
    return lines.join('\n');
  }

  exportAll(dir) {
    ensureDir(dir);
    const out = [];
    for (const s of this.list()) {
      const file = path.join(dir, `${s.scope}--${s.name}.md`);
      fs.writeFileSync(file, toMarkdown(s), 'utf8');
      out.push(file);
    }
    return out;
  }
}

module.exports = { SkillLibrary, toMarkdown, parseSkillFile, slugName, BUILTIN_SKILLS, FRONT };
