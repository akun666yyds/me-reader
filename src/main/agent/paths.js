'use strict';

/**
 * 数据路径规划（单一事实源）
 *
 * 全局数据（跟着程序走）：%APPDATA%/MeReader/
 *   settings.json                     界面与阅读设置（沿用旧版本）
 *   autosave.json                     未保存标签页快照（沿用旧版本）
 *   agent/config.json                 agent 全局配置：服务端、模型、模式、审批策略
 *   agent/sessions/<id>.jsonl         会话，追加式原始历史（压缩只作用于派生视图）
 *   agent/memory/global.json          跨项目长期记忆
 *   agent/skills/<name>.md            全局技能（内置技能的文件形态）
 *   agent/rag/global-<hash>.json      全局向量索引
 *   agent/cache/tools/<hash>.md       超长工具输出落盘，上下文只留引用
 *
 * 项目数据（跟着项目走，可随项目一起提交/同步）：
 *   <项目根>/.omemory/memory.json     项目记忆
 *   <项目根>/.omemory/notes/*.md      项目记忆条目（人类可读）
 *   <项目根>/.oskill/<name>.md        项目技能
 *   <项目根>/.orag/index.json         项目向量索引
 *
 * .omemory/.oskill/.orag 在文件树中隐藏，agent 仍可读写。
 */

const path = require('path');
const fs = require('fs');

const AGENT_DIRS = ['.omemory', '.oskill', '.orag'];
const HIDDEN_DIR_RE = /^\.(omemory|oskill|orag|cache)$/i;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

class DataPaths {
  constructor(userDataDir) {
    this.userData = userDataDir;
  }

  get agentDir() {
    return path.join(this.userData, 'agent');
  }

  get settingsFile() {
    return path.join(this.userData, 'settings.json');
  }

  get autosaveFile() {
    return path.join(this.userData, 'autosave.json');
  }

  get agentConfigFile() {
    return path.join(this.agentDir, 'config.json');
  }

  get agentMemoryFile() {
    return path.join(this.agentDir, 'memory', 'global.json');
  }

  get sessionsDir() {
    return path.join(this.agentDir, 'sessions');
  }

  get globalSkillsDir() {
    return path.join(this.agentDir, 'skills');
  }

  get globalRagDir() {
    return path.join(this.agentDir, 'rag');
  }

  get toolCacheDir() {
    return path.join(this.agentDir, 'cache', 'tools');
  }

  sessionFile(id) {
    return path.join(this.sessionsDir, `${id}.jsonl`);
  }

  globalRagFile(model) {
    const safe = String(model || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.globalRagDir, `global-${safe}.json`);
  }

  projectDir(root) {
    return { omemory: path.join(root, '.omemory'), oskill: path.join(root, '.oskill'), orag: path.join(root, '.orag') };
  }

  projectMemoryFile(root) {
    return path.join(root, '.omemory', 'memory.json');
  }

  projectNotesDir(root) {
    return path.join(root, '.omemory', 'notes');
  }

  projectSkillsDir(root) {
    return path.join(root, '.oskill');
  }

  projectRagFile(root) {
    return path.join(root, '.orag', 'index.json');
  }

  init() {
    ensureDir(this.agentDir);
    ensureDir(this.sessionsDir);
    ensureDir(this.globalSkillsDir);
    ensureDir(this.globalRagDir);
    ensureDir(path.dirname(this.agentMemoryFile));
    ensureDir(this.toolCacheDir);
    return this;
  }
}

/**
 * 从旧版本（mereader-lite / MeReader-Lite）迁移既有数据，避免改名后设置丢失。
 * 只在目标不存在时复制，绝不删除源目录，迁移失败不影响启动。
 */
function migrateLegacyUserData(userDataRoot, currentName) {
  const legacyNames = ['mereader-lite', 'MeReader-Lite', 'mereader'].filter((n) => n !== currentName);
  const moved = [];
  for (const name of legacyNames) {
    const from = path.join(userDataRoot, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(userDataRoot, currentName);
    try {
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from)) {
        if (entry === currentName) continue;
        const src = path.join(from, entry);
        const dst = path.join(to, entry);
        if (fs.existsSync(dst)) continue;
        fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
        moved.push(entry);
      }
    } catch (err) {
      console.warn('[MeReader] 旧数据迁移跳过：', name, err && err.message);
    }
  }
  return moved;
}

module.exports = { DataPaths, AGENT_DIRS, HIDDEN_DIR_RE, ensureDir, readJson, writeJson, migrateLegacyUserData };
