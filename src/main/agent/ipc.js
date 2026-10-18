'use strict';

/**
 * agent IPC 接线层
 *
 * 主进程只做三件事：装配存储对象（路径/工作区/会话/引擎）、注册通道、把引擎事件转发给窗口。
 * 所有 handler 统一经 wrap() 包装：异常转成 { ok:false, error }，渲染层拿不到
 * "Error invoking remote method ..." 这种长前缀，界面提示才干净。
 *
 * 通道命名约定：ws/* = 项目与文件树；agent/* = Ollab 引擎与会话。
 */

const { dialog } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * ipcMain.handle 的第一个实参是 IpcMainInvokeEvent，必须剥掉再交给业务函数，
 * 否则 handler 里的「第一个参数」会变成 Event 对象。
 */
function wrap(fn) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  };
}

function registerAgentIpc({ ipcMain, paths, engine, workspace, sessions, sendToWindow, getWindow }) {
  const on = (channel, fn) => ipcMain.handle(channel, wrap(fn));

  const rootName = (projectId) => {
    const p = projectId ? workspace.get(projectId) : workspace.get(workspace.activeId());
    return p ? p.name : '';
  };

  // ---------------- 项目与工作区 ----------------

  on('ws/list', () => ({ projects: workspace.list(), activeId: workspace.activeId() }));

  on('ws/pick', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: '添加项目文件夹',
      buttonLabel: '添加',
      properties: ['openDirectory', 'createDirectory']
    });
    if (r.canceled || !r.filePaths.length) return null;
    const project = workspace.add(r.filePaths[0]);
    workspace.setActive(project.id);
    return { project, projects: workspace.list(), activeId: workspace.activeId() };
  });

  on('ws/add', (root, name) => {
    const project = workspace.add(root, name);
    workspace.setActive(project.id);
    return { project, projects: workspace.list(), activeId: workspace.activeId() };
  });

  on('ws/activate', (id) => ({ activeId: workspace.activeId(), project: workspace.setActive(id) }));

  on('ws/rename', (id, name) => workspace.rename(id, name));

  on('ws/remove', (id) => {
    workspace.remove(id);
    return { projects: workspace.list(), activeId: workspace.activeId() };
  });

  on('ws/tree', ({ projectId = null, rel = '' } = {}) => {
    const id = projectId || workspace.activeId();
    if (!id) return { rel: '', parent: '', entries: [] };
    return workspace.tree(id, rel || '');
  });

  on('ws/mkdir', ({ projectId = null, target }) => workspace.mkdir(projectId || workspace.activeId(), target));

  /** 新建文件：可给初始内容，已存在则报错，避免误覆盖 */
  on('ws/create-file', ({ projectId = null, target, content = '' }) => {
    const id = projectId || workspace.activeId();
    if (workspace.exists(id, target)) throw new Error(`已存在同名文件：${target}`);
    const r = workspace.write(id, target, content);
    engine.scheduleIndex(id, r.rel || target);
    return r;
  });

  on('ws/move', ({ projectId = null, from, to }) => {
    const id = projectId || workspace.activeId();
    const r = workspace.move(id, from, to);
    // 改名后旧路径要从索引里撤下、新路径补进去，scheduleIndex 会按「文件是否存在」自动区分
    engine.scheduleIndex(id, r.from);
    engine.scheduleIndex(id, r.to);
    return r;
  });

  on('ws/remove-file', ({ projectId = null, target }) => {
    const id = projectId || workspace.activeId();
    const r = workspace.removeFile(id, target);
    engine.scheduleIndex(id, r.rel || target);
    return r;
  });

  /** 树节点 → 绝对路径（渲染层拿它调用既有 file:read 打开编辑器） */
  on('ws/abs', ({ projectId = null, target }) => {
    const id = projectId || workspace.activeId();
    const r = workspace.resolve(id, target);
    return { abs: r.abs, rel: r.rel, kind: r.kind };
  });

  on('ws/search', ({ projectId = null, needle, regex = false, caseSensitive = false, maxResults = 80 }) =>
    workspace.search(projectId || workspace.activeId(), needle, { regex, caseSensitive, maxResults }));

  /** 把外部图片拖进项目：复制到项目 assets/ 下并返回相对路径 */
  on('ws/import-asset', ({ projectId = null, sourceAbs, subdir = 'assets' }) =>
    workspace.importAsset(projectId || workspace.activeId(), sourceAbs, subdir));

  on('ws/stat', ({ projectId = null, target }) => workspace.stat(projectId || workspace.activeId(), target));

  // ---------------- 配置与服务端 ----------------

  on('agent/config', () => engine.getConfig());

  on('agent/config-set', (patch) => engine.setConfig(patch || {}));

  on('agent/check', ({ force = false } = {}) => engine.checkConnection({ force }));

  on('agent/models', ({ force = false } = {}) => engine.listModels({ force }));

  on('agent/data-dir', () => ({ dataDir: paths.userData, agentDir: paths.agentDir }));

  // ---------------- 会话 ----------------

  on('agent/sessions', ({ projectId = null, all = false } = {}) =>
    sessions.list({ projectId: all ? null : projectId || workspace.activeId(), limit: 300 }));

  on('agent/session/create', ({ projectId = null, title = '新会话', model = '' } = {}) => {
    const id = projectId || workspace.activeId();
    const meta = sessions.create({ projectId: id, projectName: rootName(id), title, model, approval: engine.config.approvalMode });
    return meta;
  });

  on('agent/session/load', (sessionId) => {
    const s = sessions.reload(sessionId);
    return {
      meta: s.meta,
      messages: s.messages,
      state: s.state,
      status: engine.statusOf(sessionId),
      context: engine.sessionContextSnapshot(sessionId)
    };
  });

  on('agent/session/rename', (sessionId, title) => {
    sessions.updateMeta(sessionId, { title: String(title || '').trim() || '未命名会话' });
    return sessions.load(sessionId).meta;
  });

  on('agent/session/pin', (sessionId, pinned) => {
    sessions.updateMeta(sessionId, { pinned: !!pinned });
    return sessions.load(sessionId).meta;
  });

  on('agent/session/delete', (sessionId) => sessions.remove(sessionId));

  /** 截断重来：保留 msgId 之前的消息，派生压缩态清零 */
  on('agent/session/cut', ({ sessionId, msgId, inclusive = false }) => {
    sessions.cutAfter(sessionId, msgId, { inclusive });
    engine.resetContext(sessionId);
    return { messages: sessions.reload(sessionId).messages };
  });

  on('agent/session/export', async (sessionId) => {
    const md = sessions.exportMarkdown(sessionId);
    const win = getWindow();
    const r = await dialog.showSaveDialog(win, {
      title: '导出会话',
      defaultPath: `${String(sessions.load(sessionId).meta.title || '会话').replace(/[\\/:*?"<>|]/g, '_')}.md`,
      filters: [{ name: 'Markdown 文件', extensions: ['md'] }]
    });
    if (r.canceled || !r.filePath) return { saved: false };
    fs.writeFileSync(r.filePath, md.replace(/\n/g, '\r\n'), 'utf8');
    return { saved: true, filePath: r.filePath };
  });

  /** 消息里的图片只存引用，预览时按引用取 dataURL */
  on('agent/image', (ref) => {
    try {
      return sessions.imageDataUrl(ref);
    } catch {
      return null;
    }
  });

  // ---------------- 一轮对话 ----------------

  on('agent/send', (req) => engine.sendUserMessage(req || {}));

  on('agent/stop', (sessionId) => engine.stop(sessionId));

  on('agent/decide', ({ requestId, decision, note = '' }) => engine.decide({ requestId, decision, note }));

  on('agent/approval', ({ sessionId, mode }) => engine.setApprovalMode(sessionId, mode));

  on('agent/status', (sessionId) => engine.statusOf(sessionId));

  // ---------------- 上下文与压缩 ----------------

  on('agent/usage', (sessionId) => engine.usageOf(sessionId));

  on('agent/context', (sessionId) => engine.sessionContextSnapshot(sessionId));

  on('agent/compress', ({ sessionId, focus = '' }) => engine.compressNow({ sessionId, focus }));

  on('agent/context-reset', (sessionId) => engine.resetContext(sessionId));

  // ---------------- 记忆 / 技能 / RAG ----------------

  on('agent/memory', ({ projectId = null } = {}) => engine.memorySnapshot(projectId || workspace.activeId()));

  on('agent/memory-add', ({ projectId = null, text, kind = 'fact', tags = [], scope = 'project', note = '' }) => {
    const stores = engine.stores(projectId || workspace.activeId());
    const store = scope === 'global' ? stores.memory.global : stores.memory.project;
    return store.add({ text, kind, tags, source: 'panel', note });
  });

  on('agent/memory-update', ({ projectId = null, id, patch = {}, scope = 'project' }) => {
    const stores = engine.stores(projectId || workspace.activeId());
    const store = scope === 'global' ? stores.memory.global : stores.memory.project;
    return store.update(id, patch);
  });

  on('agent/memory-remove', ({ projectId = null, id, scope = 'project' }) => {
    const stores = engine.stores(projectId || workspace.activeId());
    const store = scope === 'global' ? stores.memory.global : stores.memory.project;
    return store.remove(id);
  });

  on('agent/skills', ({ projectId = null } = {}) => engine.skillSnapshot(projectId || workspace.activeId()));

  on('agent/skill-toggle', ({ projectId = null, name, enabled }) => {
    const stores = engine.stores(projectId || workspace.activeId());
    const res = stores.skills.setEnabled(name, !!enabled);
    engine.storeCache.clear();
    sendToWindow('agent:event', { type: 'skills-changed', projectId: projectId || workspace.activeId(), disabled: engine.config.skillsDisabled });
    return res;
  });

  on('agent/skill-save', ({ projectId = null, skill }) => {
    const stores = engine.stores(projectId || workspace.activeId());
    const res = stores.skills.save({ ...skill, scope: skill.scope || 'project' });
    engine.storeCache.clear();
    return res;
  });

  on('agent/skill-remove', ({ projectId = null, name }) => {
    const stores = engine.stores(projectId || workspace.activeId());
    const res = stores.skills.remove(name);
    engine.storeCache.clear();
    return res;
  });

  on('agent/rag-stats', ({ projectId = null } = {}) => engine.ragStats(projectId || workspace.activeId()));

  on('agent/reindex', ({ projectId = null, limit = 800 } = {}) => engine.reindexProject(projectId || workspace.activeId(), { limit }));

  on('agent/rag-clear', ({ projectId = null, scope = 'project' } = {}) => engine.clearRag(projectId || workspace.activeId(), { scope }));

  on('agent/rag-query', async ({ projectId = null, query, topK = 6 } = {}) => {
    const stores = engine.stores(projectId || workspace.activeId());
    if (!stores.rag.project) throw new Error('未配置嵌入模型：请先在设置里选择 embedding 模型并重建索引');
    return stores.rag.project.query(query, { topK });
  });

  return {
    /** 引擎事件统一出口：主进程只需要在窗口就绪后调用 */
    forward: (channel, payload) => sendToWindow(channel, payload),
    projectOf: (id) => (id ? workspace.get(id) : workspace.get(workspace.activeId())) || null,
    defaultProjectId: () => workspace.activeId(),
    docsDirName: path.basename(paths.userData)
  };
}

module.exports = { registerAgentIpc, wrap };
