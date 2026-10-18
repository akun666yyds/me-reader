'use strict';

/**
 * Ollab 引擎：plan-act-reflect 主循环
 *
 * 一轮用户输入 = 若干次「模型请求 → 工具执行 → 结果回填」迭代，直到模型给出不再调用工具的回答。
 * 三条硬纪律（都来自实测踩坑）：
 *   1. 会话原始记录只追加；上下文压缩只生成派生视图，回滚 = 丢派生态，不丢数据。
 *   2. assistant.tool_calls 与 role:tool 结果必须成对；取消、拒绝、报错也都要补一条 tool 结果，
 *      否则下一次请求在 Ollama 侧直接非法。
 *   3. num_ctx 必须显式下发（默认 4096 且从 prompt 头部静默截断，system 与工具 schema 会先被丢掉）。
 *
 * 审批门控：会话内两态「需要确认 / 自动审批」。写类工具在需要确认态下逐项询问；
 * delete_file 这类不可逆操作即使在自动审批态也强制询问（tool.approval === 'always'）。
 */

const path = require('path');

const { readJson, writeJson, ensureDir } = require('./paths');
const { OllamaClient, DEFAULT_BASE_URL } = require('./ollama');
const { ContextManager, emptyState } = require('./context');
const { fileKind } = require('./workspace');
const { TOOLS, toOllamaTools, findTool, needsApproval, diffPreview } = require('./tools');
const { SkillLibrary } = require('./skills');
const { globalMemoryStore, projectMemoryStore } = require('./memory');
const { projectRagStore, globalRagStore } = require('./rag');
const { WebSearch } = require('./websearch');
const { normalizeToolCalls } = require('./sessions');

const AGENT_NAME = 'Ollab';
const DEFAULT_CONFIG = {
  baseUrl: DEFAULT_BASE_URL,
  chatModel: '',
  embeddingModel: 'nomic-embed-text',
  numCtx: 16384,
  reserveOutput: 1500,
  temperature: 0.3,
  topP: 0.9,
  thinking: 'off', // off / on / auto（auto = 不干预，交给模型默认）
  toolsEnabled: true,
  maxToolRounds: 12,
  autoCompact: true,
  approvalMode: 'confirm', // confirm = 需要确认，auto = 自动审批
  ragEnabled: true,
  ragAutoIndex: true,
  ragTopK: 4,
  useGlobalRag: false,
  memoryEnabled: true,
  skillEnabled: true,
  includeCurrentFile: true,
  currentFileChars: 12000,
  skillsDisabled: [],
  toolsDisabled: [],
  persona: '',
  indexDebounceMs: 1500,
  panelOpen: false,
  thresholds: {}
};

const BASE_PROMPT = `你是 ${AGENT_NAME}，MeReader 内置的本地助手，由用户自己电脑上的 Ollama 模型驱动。

## 职责
- 整理 Markdown / txt 文档：新建、改写、删除、排版、嵌入图片或内联资源、生成目录。
- 管理 md / txt 文档项目，维护 json / xml 等数据文档，编写轻量本地 H5（html / css / js）。
- 需要外部资料时用 web_search / web_fetch，并在回答中给出来源链接。

## 工作方式（plan → act → reflect）
1. 涉及两个以上动作或多个文件时，先 set_plan 写出可验证的步骤；执行中每步用 update_plan_step 更新状态。
2. 动手前先看清现状：写文件前用 read_file / list_directory / search_text 确认，绝不凭想象覆盖已有内容。
3. 收尾用 reflect 自查：需求是否逐条满足、改动是否都在项目内、有没有半成品文件。
4. 缺关键信息且无法合理假设时用 ask_user 提问；能合理假设就直接做，别反复确认。

## 边界
- 一切读写都限定在「当前项目根目录」内，路径一律使用相对根目录的写法；越界调用会失败，不要尝试绕过。
- 删除不可恢复：先说清要删什么、为什么，再调 delete_file，由用户确认。
- 修改已有文件优先用 edit_file / replace_in_file 做局部改动；整文件重写用 write_file。
- 回答用简体中文，简洁、结论先行，不堆与任务无关的解释。

## 工具与上下文
- 工具返回值是事实来源；报错时先读错误信息再换思路，不要用同样参数反复重试。
- 超长工具输出会被裁剪并落盘，需要细节时用 read_file 读取提示中给出的缓存文件路径。
- 上下文水位由系统管理，接近上限时会自动压缩；重要结论请及时写进文件或记忆。`;

function shortRel(p) {
  return String(p || '').replace(/\\/g, '/');
}

function oneLine(s, n = 90) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function guessTitle(text, images) {
  if (text) return oneLine(text, 26);
  if (images && images.length) return `图片问答（${images.length} 张）`;
  return '新会话';
}

/** 摘要提示词整体过长时做中间裁剪：保住指令头部与最近对话尾部 */
function middleOutClip(prompt, maxChars) {
  if (prompt.length <= maxChars) return prompt;
  const headLen = Math.min(1400, Math.max(200, Math.floor(maxChars * 0.3)));
  const tailLen = Math.max(400, maxChars - headLen);
  return `${prompt.slice(0, headLen)}\n\n……（中间历史过长已省略，结论见上方摘要）……\n\n${prompt.slice(prompt.length - tailLen)}`;
}

class AgentEngine {
  /**
   * @param {{paths, workspace, sessions, shell, send?:Function}} opts
   *   send(channel, payload) 由主进程注入，负责把事件推给渲染层
   */
  constructor({ paths, workspace, sessions, shell, send = () => {} }) {
    this.paths = paths;
    this.workspace = workspace;
    this.sessions = sessions;
    this.shell = shell;
    this.rawSend = send;
    this.config = { ...DEFAULT_CONFIG, ...(readJson(paths.agentConfigFile, null) || {}) };
    this.runtimes = new Map();
    this.storeCache = new Map();
    this.indexTimers = new Map();
    this.indexQueue = new Map();
    this.modelCache = { at: 0, list: [] };
    this.webSearch = new WebSearch({ timeoutMs: 12000 });
    this._client = null;
    this._version = '';
    this.configFallback = null;
    this.streamBuffers = new Map();
  }

  // ---------------- 基础设施 ----------------

  send(type, payload = {}) {
    try {
      this.rawSend('agent:event', { type, ...payload });
    } catch (err) {
      console.warn('[MeReader] agent 事件推送失败：', type, err.message);
    }
  }

  client() {
    const url = String(this.config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (!this._client || this._client.baseUrl !== url) this._client = new OllamaClient({ baseUrl: url });
    return this._client;
  }

  saveConfig() {
    writeJson(this.paths.agentConfigFile, this.config);
  }

  getConfig() {
    return {
      ...this.config,
      agentName: AGENT_NAME,
      dataDir: this.paths.agentDir,
      projectDataDirs: { memory: '.omemory', skills: '.oskill', rag: '.orag' },
      toolCount: TOOLS.length,
      tools: TOOLS.map((t) => ({ name: t.name, kind: t.kind, approval: t.approval || null, description: t.description }))
    };
  }

  setConfig(patch = {}) {
    const before = { ...this.config };
    // 顺序很关键：已有配置必须盖住默认值，否则改任一项设置都会把用户选的模型 / 开关冲回默认。
    this.config = { ...DEFAULT_CONFIG, ...this.config, ...patch };
    if (patch.thresholds) {
      // 传空对象 = 恢复内置默认（ContextManager 会用 defaultThresholds 补齐）
      this.config.thresholds = Object.keys(patch.thresholds).length
        ? { ...DEFAULT_CONFIG.thresholds, ...this.config.thresholds, ...patch.thresholds }
        : {};
    }
    this.config.baseUrl = String(this.config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') || DEFAULT_BASE_URL;
    this.config.numCtx = Math.max(4096, Math.min(1_000_000, Math.round(Number(this.config.numCtx) || 16384)));
    this.config.reserveOutput = Math.max(256, Math.round(Number(this.config.reserveOutput) || 1500));
    this.config.temperature = Math.min(2, Math.max(0, Number(this.config.temperature) || 0));
    this.config.topP = Math.min(1, Math.max(0.1, Number(this.config.topP) || 0.9));
    this.config.ragTopK = Math.min(12, Math.max(1, Number(this.config.ragTopK) || 4));
    this.config.maxToolRounds = Math.min(40, Math.max(1, Number(this.config.maxToolRounds) || 12));
    this.saveConfig();
    // 服务端 / 模型 / 阈值变化都会让既有派生对象失效
    if (before.baseUrl !== this.config.baseUrl) this._client = null;
    if (before.baseUrl !== this.config.baseUrl || before.chatModel !== this.config.chatModel || before.numCtx !== this.config.numCtx || before.reserveOutput !== this.config.reserveOutput || before.thresholds !== this.config.thresholds) {
      for (const rt of this.runtimes.values()) rt.cm = null;
    }
    if (before.embeddingModel !== this.config.embeddingModel || before.baseUrl !== this.config.baseUrl) this.storeCache.clear();
    return this.getConfig();
  }

  /** 连接自检 + 模型清单（面板顶部的「检测」按钮） */
  async checkConnection({ force = false } = {}) {
    const now = Date.now();
    this.configFallback = null;
    if (!force && this.modelCache.list.length && now - this.modelCache.at < 8000) {
      return { ok: true, cached: true, version: this._version, models: this.modelCache.list, baseUrl: this.config.baseUrl };
    }
    try {
      const version = await this.client().getVersion();
      const models = await this.client().listModels();
      this._version = version;
      this.modelCache = { at: now, list: models };
      const chat = models.filter((m) => m.canChat);
      const embList = models.filter((m) => m.isEmbedding);
      const pickChat = () => {
        const withTools = chat.find((m) => m.canTools);
        return (withTools || chat[0] || {}).name || '';
      };
      // 未选模型，或选过的模型已被 ollama rm（modelInfo 支持短名匹配，nomic-embed-text 这种写法不会被误判）
      if ((!this.config.chatModel || this.modelInfo(this.config.chatModel) === null) && chat.length) {
        const prev = this.config.chatModel;
        this.config.chatModel = pickChat();
        this.configFallback = prev ? `对话模型 ${prev} 本机已不存在，已改用 ${this.config.chatModel}` : `已自动选择对话模型 ${this.config.chatModel}`;
        this.saveConfig();
        for (const rt of this.runtimes.values()) rt.cm = null;
      }
      if ((!this.config.embeddingModel || this.modelInfo(this.config.embeddingModel) === null) && embList.length) {
        const prev = this.config.embeddingModel;
        this.config.embeddingModel = embList[0].name;
        if (prev) this.configFallback = `${this.configFallback ? this.configFallback + '；' : ''}嵌入模型 ${prev} 本机已不存在，已改用 ${this.config.embeddingModel}`;
        this.saveConfig();
        this.storeCache.clear();
      }
      return { ok: true, version, models: chat, embeddingModels: embList, all: models, baseUrl: this.config.baseUrl, fallback: this.configFallback || null };
    } catch (err) {
      return { ok: false, error: err.message, baseUrl: this.config.baseUrl };
    }
  }

  async listModels({ force = false } = {}) {
    const r = await this.checkConnection({ force });
    if (!r.ok) throw new Error(r.error);
    return r.all || r.models;
  }

  modelInfo(name) {
    return this.modelCache.list.find((m) => m.name === name || m.name.startsWith(`${name}:`)) || null;
  }

  async ensureModelInfo(name) {
    const known = this.modelInfo(name);
    if (known && Date.now() - this.modelCache.at < 60000) return known;
    try {
      await this.checkConnection({ force: true });
    } catch {
      /* 拿不到能力清单时按“能用就行”处理，工具能力默认允许 */
    }
    return this.modelInfo(name);
  }

  /** 每个会话一套 ContextManager（numCtx / 阈值 / 摘要函数都跟模型绑定） */
  contextManager(model, info) {
    const numCtx = this.config.numCtx || (info && info.contextLength) || 8192;
    return new ContextManager({
      numCtx,
      reserveOutput: this.config.reserveOutput,
      thresholds: this.config.thresholds,
      cacheDir: this.paths.toolCacheDir,
      summarize: (prompt) => this.summarizeWithModel(prompt, model, numCtx)
    });
  }

  async summarizeWithModel(prompt, model, numCtx) {
    const budgetChars = Math.max(6000, Math.floor(numCtx * 2.2));
    const clipped = middleOutClip(prompt, budgetChars);
    const info = this.modelInfo(model);
    const res = await this.client().chat({
      model,
      messages: [{ role: 'user', content: clipped }],
      options: { num_ctx: numCtx, temperature: 0.1, top_p: 0.9 },
      ...(info && info.canThinking && this.config.thinking === 'off' ? { think: false } : {}),
      onEvent: () => {}
    });
    if (!res.content.trim()) throw new Error('模型未返回摘要内容');
    return res.content;
  }

  // ---------------- 项目级存储（记忆 / 技能 / RAG） ----------------

  stores(projectId) {
    const id = projectId || this.workspace.activeId();
    if (!id) throw new Error('请先添加项目文件夹');
    const root = this.workspace.getRoot(id);
    const key = `${id}|${this.config.embeddingModel}|${this.config.baseUrl}|${this.config.ragEnabled ? 1 : 0}`;
    if (this.storeCache.has(key)) return this.storeCache.get(key);
    const skills = new SkillLibrary({
      globalDir: this.paths.globalSkillsDir,
      projectDir: this.paths.projectSkillsDir(root),
      disabled: this.config.skillsDisabled
    });
    const rag = {
      project: this.config.ragEnabled && this.config.embeddingModel ? projectRagStore(this.paths, root, { model: this.config.embeddingModel, client: this.client() }) : null,
      global: this.config.ragEnabled && this.config.useGlobalRag && this.config.embeddingModel ? globalRagStore(this.paths, { model: this.config.embeddingModel, client: this.client() }) : null
    };
    const stores = {
      projectId: id,
      root,
      memory: { global: globalMemoryStore(this.paths), project: projectMemoryStore(this.paths, root) },
      rag,
      skills
    };
    this.storeCache.set(key, stores);
    return stores;
  }

  /** 内置技能落盘（启动时调用一次） */
  prepareSkills() {
    ensureDir(this.paths.globalSkillsDir);
    const lib = new SkillLibrary({ globalDir: this.paths.globalSkillsDir, projectDir: null, disabled: [] });
    const written = lib.ensureBuiltins();
    if (written.length) console.log('[MeReader] 已写入内置技能：', written.join(', '));
    return written;
  }

  // ---------------- 运行态 ----------------

  runtime(sessionId) {
    if (sessionId) {
      let rt = this.runtimes.get(sessionId);
      if (!rt) {
        const meta = this.sessions.load(sessionId).meta;
        rt = {
          sessionId,
          busy: false,
          controller: null,
          cancelled: false,
          approval: (meta && meta.approval) || this.config.approvalMode || 'confirm',
          pending: new Map(),
          plan: null,
          usage: null,
          activity: [],
          round: 0,
          cm: null
        };
        this.runtimes.set(sessionId, rt);
      }
      return rt;
    }
    return { approval: this.config.approvalMode, pending: new Map() };
  }

  statusOf(sessionId) {
    const rt = this.runtime(sessionId);
    return { sessionId, busy: rt.busy, approval: rt.approval, plan: rt.plan, usage: rt.usage, round: rt.round, pendingApprovals: rt.pending.size, model: this.config.chatModel };
  }

  setApprovalMode(sessionId, mode) {
    const rt = this.runtime(sessionId);
    rt.approval = mode === 'auto' ? 'auto' : 'confirm';
    this.sessions.updateMeta(sessionId, { approval: rt.approval });
    this.send('status', { ...this.statusOf(sessionId) });
    return rt.approval;
  }

  /** 中断：终止流 + 把等待中的审批/提问按「取消」落地 */
  async stop(sessionId) {
    const rt = this.runtime(sessionId);
    rt.cancelled = true;
    for (const [id, entry] of rt.pending) {
      rt.pending.delete(id);
      entry.resolve({ decision: 'cancel' });
      this.send('approval-resolved', { sessionId, requestId: id, decision: 'cancel' });
    }
    if (rt.controller) rt.controller.abort(new Error('用户已停止'));
    this.send('status', { ...this.statusOf(sessionId), stopped: true });
    return true;
  }

  /** 渲染层对审批请求的回应 */
  decide({ requestId, decision, note }) {
    for (const rt of this.runtimes.values()) {
      const entry = rt.pending.get(requestId);
      if (!entry) continue;
      rt.pending.delete(requestId);
      const kind = decision === 'allow' || decision === 'once' ? 'allow' : decision === 'auto' ? 'auto' : decision === 'cancel' ? 'cancel' : 'deny';
      if (kind === 'auto') {
        rt.approval = 'auto';
        // 门控状态跟着会话落盘，重启后仍然是「本会话自动批准」
        this.sessions.updateMeta(rt.sessionId, { approval: 'auto' });
      }
      entry.resolve({ decision: kind, note: note || '' });
      this.send('approval-resolved', { sessionId: rt.sessionId, requestId, decision: kind, note: note || '' });
      if (kind === 'auto') this.send('status', this.statusOf(rt.sessionId));
      return { ok: true, decision: kind };
    }
    return { ok: false, error: '该确认请求已过期' };
  }

  // ---------------- 系统提示组装 ----------------

  async buildSystem({ projectId, currentFile, selection, query, stores }) {
    const blocks = [BASE_PROMPT];
    const root = this.workspace.getRoot(projectId);
    const proj = this.workspace.get(projectId);
    blocks.push(
      [
        '## 当前工作环境',
        `- 项目：${(proj && proj.name) || path.basename(root)}`,
        `- 根目录：${root}`,
        `- 约定：项目记忆在 .omemory/，项目技能在 .oskill/，向量索引在 .orag/；这些目录在文件树中隐藏，但你可以在任务需要时读写。`,
        selection ? `- 用户在编辑器中选中的文本（可能就是要处理的内容）：\n\n\`\`\`\n${String(selection).slice(0, 2000)}\n\`\`\`` : '',
        this.config.persona ? `- 用户给你的额外设定：${this.config.persona}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    );

    if (this.config.includeCurrentFile && currentFile) {
      try {
        const r = this.workspace.read(projectId, currentFile);
        const limit = this.config.currentFileChars;
        const text = r.content.length > limit ? `${r.content.slice(0, limit)}\n\n（文件较长，此处截断；需要后半部分请用 read_file 指定行区间）` : r.content;
        blocks.push(`## 用户当前打开的文件：${shortRel(r.rel)}\n\n\`\`\`\n${text}\n\`\`\``);
      } catch (err) {
        blocks.push(`## 用户当前打开的文件：${shortRel(currentFile)}\n（读取失败：${err.message}）`);
      }
    }

    if (this.config.skillEnabled) {
      const skillBlock = stores.skills.promptBlock(query || '', { maxFull: 2, fullCharBudget: 5200 });
      if (skillBlock) blocks.push(skillBlock);
    }

    const mem = [];
    if (this.config.memoryEnabled) {
      const project = stores.memory.project.forPrompt({ query: query || '', max: 8 });
      const global = stores.memory.global.forPrompt({ query: query || '', max: 5 });
      if (project.length) mem.push(`### 项目记忆（${stores.memory.project.label}）\n${project.map((m) => `- [${m.kind}] ${m.text}${m.note ? `（${m.note}）` : ''}`).join('\n')}`);
      if (global.length) mem.push(`### 全局记忆\n${global.map((m) => `- [${m.kind}] ${m.text}`).join('\n')}`);
    }
    if (mem.length) blocks.push(`## 记忆\n\n${mem.join('\n\n')}`);

    const rag = await this.retrieveRag({ query, stores, projectId });
    if (rag) blocks.push(rag);

    return blocks.filter(Boolean).join('\n\n---\n\n');
  }

  async retrieveRag({ query, stores, projectId }) {
    if (!this.config.ragEnabled || !query || !query.trim()) return '';
    const stores_ = stores || this.stores(projectId);
    const hits = [];
    for (const store of [stores_.rag.project, stores_.rag.global].filter(Boolean)) {
      if (!store || !Object.keys(store.data.docs || {}).length) continue;
      try {
        const r = await store.query(query.slice(0, 600), { topK: this.config.ragTopK });
        for (const h of r.results) hits.push({ ...h, label: store.label, scope: store.scope });
      } catch (err) {
        this.send('notice', { level: 'warn', message: `RAG 检索失败（${store.label}）：${err.message}` });
      }
    }
    if (!hits.length) return '';
    hits.sort((a, b) => b.score - a.score);
    const picked = hits.slice(0, this.config.ragTopK);
    const lines = picked.map((h) => `【${h.score.toFixed(3)}】${shortRel(h.rel)}${h.title ? ` · ${h.title}` : ''}\n${String(h.text).slice(0, 900)}`);
    return `## 项目内相关片段（向量+词面混合检索，可能过时，使用前请 read_file 核对）\n\n${lines.join('\n\n')}`;
  }

  // ---------------- 消息形态转换 ----------------

  toApiMessages(view, { canVision, maxImages = 2 }) {
    const out = [];
    let imageBudget = Math.max(0, Number(maxImages) || 0);
    // 从后往前数，保留最近的图片（与「最近窗口逐字保留」的压缩策略一致）
    const keep = new Set();
    for (let i = view.length - 1; i >= 0; i--) {
      const m = view[i];
      if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
        if (imageBudget <= 0) break;
        imageBudget -= 1;
        keep.add(m.id);
      }
    }
    for (const m of view) {
      const msg = { role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content == null ? '' : m.content) };
      if (m.role === 'user' && Array.isArray(m.images) && m.images.length) {
        if (canVision && keep.has(m.id)) {
          const images = [];
          for (const ref of m.images) {
            try {
              const b64 = this.sessions.imageBase64(ref);
              if (b64) images.push(b64);
            } catch (err) {
              this.send('notice', { level: 'warn', message: `图片读取失败：${err.message}` });
            }
          }
          if (images.length) msg.images = images;
        }
        if (!msg.images) {
          const names = m.images.map((i) => i.name || '图片').join('、');
          msg.content += `\n\n（本条消息附了 ${m.images.length} 张图片：${names}${canVision ? '，但图片内容本次未随行发送' : '；当前模型不支持图像输入，只能看到文件名'}）`;
        }
      }
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        msg.tool_calls = normalizeToolCalls(m.tool_calls);
        if (!msg.content) msg.content = '';
      }
      if (m.role === 'tool') {
        if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
        if (m.name) msg.name = m.name;
      }
      out.push(msg);
    }
    return out;
  }

  /** 计划的结构化文本（进 pinned 段，压缩时永不丢） */
  planText(plan) {
    if (!plan || !Array.isArray(plan.steps) || !plan.steps.length) return '';
    const marks = { done: '✓', failed: '✗', doing: '▶', pending: '·' };
    return `目标：${plan.goal}\n${plan.steps.map((s, i) => `${i + 1}.[${marks[s.status] || '·'}] ${s.text}${s.note ? ` —— ${s.note}` : ''}`).join('\n')}`;
  }

  // ---------------- 主循环 ----------------

  /**
   * 发送一轮用户输入。
   * @param {{sessionId, text, images?, projectId?, currentFile?, selection?}} req
   */
  async sendUserMessage(req = {}) {
    const { sessionId, text = '', images = [], currentFile = null, selection = '' } = req;
    const session = this.sessions.load(sessionId);
    if (!session.meta) throw new Error('会话不存在，请先新建会话');
    const rt = this.runtime(sessionId);
    if (rt.busy) throw new Error(`${AGENT_NAME} 正在处理上一条请求，可点「停止」中断`);

    const projectId = req.projectId || session.meta.projectId || this.workspace.activeId();
    if (!projectId) throw new Error('请先在左侧添加项目文件夹，agent 只能在项目目录内工作');
    const model = session.meta.model || this.config.chatModel;
    if (!model) throw new Error('请先在 agent 设置里选择对话模型（需已 ollama pull）');

    rt.busy = true;
    rt.cancelled = false;
    rt.controller = new AbortController();
    rt.activity = [];
    rt.round = 0;
    this.send('status', this.statusOf(sessionId));

    let savedImages = [];
    try {
      savedImages = images.map((im) => this.sessions.saveImage(im.dataUrl || im.buffer || im, { name: im.name, mime: im.mime })).filter(Boolean);
    } catch (err) {
      rt.busy = false;
      this.send('status', this.statusOf(sessionId));
      throw new Error(`图片处理失败：${err.message}`);
    }

    const userMsg = this.sessions.appendMessage(sessionId, {
      role: 'user',
      content: String(text || ''),
      ...(savedImages.length ? { images: savedImages } : {})
    });
    if (!session.meta.title || session.meta.title === '新会话') this.sessions.updateMeta(sessionId, { title: guessTitle(text, savedImages) });
    this.sessions.updateMeta(sessionId, {
      projectId,
      projectName: (this.workspace.get(projectId) || {}).name || '',
      model,
      ...(savedImages.length ? { hasImages: true } : {})
    });
    this.send('message', { sessionId, message: userMsg });

    try {
      return await this.runTurn({ sessionId, projectId, model, rt, currentFile, selection, query: String(text || '') });
    } catch (err) {
      const aborted = rt.cancelled || /取消|abort|超时/i.test(String(err.message));
      if (aborted) this.send('notice', { sessionId, level: 'info', message: '本轮已停止' });
      else this.send('error', { sessionId, message: err.message, stack: String(err.stack || '').split('\n').slice(0, 3).join(' | ') });
      if (!aborted) this.sessions.appendMessage(sessionId, { role: 'assistant', content: `（本轮失败：${err.message}）`, error: true });
      return { ok: false, error: err.message, cancelled: aborted };
    } finally {
      rt.busy = false;
      rt.controller = null;
      this.flushStream(sessionId);
      this.send('status', this.statusOf(sessionId));
    }
  }

  async runTurn({ sessionId, projectId, model, rt, currentFile, selection, query }) {
    const stores = this.stores(projectId);
    const info = await this.ensureModelInfo(model);
    const cm = this.contextManager(model, info);
    rt.cm = cm;
    const toolsAllowed = this.config.toolsEnabled !== false && (!info || info.canTools !== false);
    const ollamaTools = toolsAllowed ? toOllamaTools(this.visibleTools()) : undefined;
    if (info && this.config.toolsEnabled !== false && info.canTools === false) {
      this.send('notice', { sessionId, level: 'warn', message: `模型 ${model} 不支持工具调用，本轮只能纯文本交流` });
    }

    const persistState = (patch) => this.sessions.saveState(sessionId, patch);
    const stateOf = () => {
      const s = this.sessions.load(sessionId).state || {};
      return { contextState: s.contextState || emptyState(), plan: s.plan || null };
    };

    let { contextState, plan } = stateOf();
    rt.plan = plan;
    const system = await this.buildSystem({ projectId, currentFile, selection, query, stores });
    rt.lastSystem = system;
    const history = () => this.sessions.load(sessionId).messages;
    const finalStats = { rounds: 0, toolCalls: 0, promptTokens: 0, evalTokens: 0 };

    for (let round = 0; round < this.config.maxToolRounds; round++) {
      rt.round = round + 1;
      if (rt.cancelled) return { ok: false, cancelled: true, ...finalStats };

      // ---- 组装视图并按水位决定是否压缩 ----
      let view = cm.buildView({ system, history: history(), plan: this.planText(plan), state: contextState });
      let usage = cm.usage(contextState, view.view);
      if (this.config.autoCompact && usage.level !== 'ok') {
        const comp = await cm.ensureWithinBudget({ system, history: history(), plan: this.planText(plan), state: contextState, pinnedExtra: '' });
        contextState = comp.state;
        persistState({ contextState });
        if (comp.needed) {
          view = cm.buildView({ system, history: history(), plan: this.planText(plan), state: contextState });
          usage = cm.usage(contextState, view.view);
          this.send('compact', { sessionId, auto: true, before: comp.before, after: comp.after, actions: comp.actions });
        }
      }
      if (usage.level === 'hard') {
        // 水位仍要落盘并推给面板，否则 UI 不知道「为什么这一轮没发出去」
        rt.usage = usage;
        persistState({ usage: { percent: usage.percent, tokens: usage.tokens, budget: usage.budget, level: usage.level, numCtx: usage.numCtx } });
        this.send('usage', { sessionId, usage, context: cm.snapshot() });
        // 分两种情况：历史太长（压缩有用）／固定部分本身就装不下（压缩无用，只能调大 num_ctx 或关掉技能工具）
        const baseTokens =
          cm.measure([{ role: 'system', content: system }], contextState).tokens +
          cm.tokenCost(contextState, ollamaTools && ollamaTools.length ? JSON.stringify(ollamaTools) : '');
        const baselineOnly = baseTokens >= usage.budget;
        const maxCtx = info && info.contextLength ? info.contextLength : 0;
        const suggest = Math.max(cm.numCtx, Math.ceil((baseTokens + cm.reserveOutput + 2048) / 2048) * 2048);
        const message = baselineOnly
          ? `固定开销装不下：${AGENT_NAME} 的工具清单 + 技能 + 记忆 + 摘要就占约 ${baseTokens} token，已超过当前可用预算 ${usage.budget} token（num_ctx ${cm.numCtx} − 生成预留 ${cm.reserveOutput}）。压缩历史解决不了，请在设置里把 num_ctx 提到 ${suggest}${maxCtx ? `（${model} 上限 ${maxCtx}）` : ''}，或关掉部分技能 / 工具。`
          : `上下文已达 ${usage.percent}%，自动压缩仍不够。请点「压缩」或新建会话后继续。`;
        this.send('error', { sessionId, message });
        return { ok: false, error: 'context-full', reason: baselineOnly ? 'baseline' : 'history', baselineTokens: baseTokens, suggestNumCtx: suggest, ...finalStats };
      }
      rt.usage = usage;
      persistState({ usage: { percent: usage.percent, tokens: usage.tokens, budget: usage.budget, level: usage.level, numCtx: usage.numCtx } });
      this.send('usage', { sessionId, usage, context: cm.snapshot() });

      // ---- 请求模型（流式） ----
      const apiMessages = this.toApiMessages(view.view, { canVision: info ? !!info.canVision : true, maxImages: cm.thresholds.maxImagesInWindow });
      this.send('turn-start', { sessionId, round: rt.round, messages: apiMessages.length, tools: toolsAllowed });
      const res = await this.client().chat({
        model,
        messages: apiMessages,
        tools: ollamaTools,
        options: { num_ctx: cm.numCtx, num_predict: -1, temperature: this.config.temperature, top_p: this.config.topP },
        ...(info && info.canThinking && this.config.thinking !== 'auto' ? { think: this.config.thinking === 'on' } : {}),
        signal: rt.controller.signal,
        onEvent: (evt) => this.onStreamEvent(sessionId, evt)
      });
      this.flushStream(sessionId);

      if (res.stats) {
        contextState = cm.calibrate(contextState, view.view, res.stats.promptTokens);
        persistState({ contextState });
        finalStats.promptTokens += res.stats.promptTokens || 0;
        finalStats.evalTokens += res.stats.evalTokens || 0;
        this.send('stats', { sessionId, stats: res.stats, round: rt.round });
      }

      const toolCalls = res.toolCalls && res.toolCalls.length ? normalizeToolCalls(res.toolCalls) : [];
      const assistant = this.sessions.appendMessage(sessionId, {
        role: 'assistant',
        content: res.content || '',
        ...(res.reasoning ? { reasoning: res.reasoning } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(res.stats ? { stats: res.stats } : {})
      });
      this.send('message', { sessionId, message: assistant });

      if (!toolCalls.length) {
        const done = { ok: true, rounds: rt.round, toolCalls: finalStats.toolCalls, content: assistant.content, stats: res.stats, usage };
        this.send('turn-end', { sessionId, rounds: rt.round, toolCalls: finalStats.toolCalls, usage, activity: rt.activity.slice(-20) });
        return done;
      }

      // ---- act：执行本轮工具调用（结果必须逐条回填，保持成对） ----
      let asked = null;
      for (const call of toolCalls) {
        if (rt.cancelled) {
          this.appendToolResult(sessionId, call, { ok: false, content: '用户已停止，本轮工具调用未执行。' });
          continue;
        }
        const outcome = await this.execTool({ call, sessionId, projectId, model, rt, stores, cm, getState: () => contextState });
        finalStats.toolCalls++;
        if (outcome.ask) asked = outcome.ask;
      }

      // 计划/记忆/文件等状态可能已被工具更新
      plan = rt.plan;
      contextState = stateOf().contextState || contextState;

      if (asked) {
        this.send('ask', { sessionId, requestId: asked.requestId, question: asked.question, options: asked.options });
        return { ok: true, paused: 'ask', rounds: rt.round, question: asked.question, options: asked.options };
      }
      if (rt.cancelled) return { ok: false, cancelled: true, ...finalStats };
    }

    this.send('notice', { sessionId, level: 'warn', message: `本轮工具调用已达上限（${this.config.maxToolRounds} 次），先停下来汇报进展。` });
    return { ok: true, limited: true, rounds: rt.round, toolCalls: finalStats.toolCalls };
  }

  visibleTools() {
    const disabled = new Set(this.config.toolsDisabled || []);
    return TOOLS.filter((t) => !disabled.has(t.name));
  }

  onStreamEvent(sessionId, evt) {
    if (evt.type === 'text' || evt.type === 'reasoning') {
      const key = `${sessionId}|${evt.type}`;
      const buf = this.streamBuffers.get(key) || { text: '', timer: null };
      buf.text += evt.delta || '';
      if (buf.text.length >= 120) {
        this.send('delta', { sessionId, kind: evt.type, delta: buf.text });
        buf.text = '';
        if (buf.timer) {
          clearTimeout(buf.timer);
          buf.timer = null;
        }
      } else if (!buf.timer) {
        buf.timer = setTimeout(() => {
          const cur = this.streamBuffers.get(key);
          if (cur && cur.text) {
            this.send('delta', { sessionId, kind: evt.type, delta: cur.text });
            cur.text = '';
          }
          if (cur) cur.timer = null;
          this.streamBuffers.set(key, cur || { text: '', timer: null });
        }, 60);
      }
      this.streamBuffers.set(key, buf);
      return;
    }
    if (evt.type === 'error') this.send('error', { sessionId, message: evt.error ? evt.error.message || String(evt.error) : '模型返回错误' });
  }

  flushStream(sessionId) {
    for (const [key, buf] of this.streamBuffers) {
      if (!key.startsWith(`${sessionId}|`)) continue;
      if (buf.text) this.send('delta', { sessionId, kind: key.split('|')[1], delta: buf.text });
      if (buf.timer) clearTimeout(buf.timer);
      this.streamBuffers.delete(key);
    }
  }

  appendToolResult(sessionId, call, result) {
    const name = call.function ? call.function.name : call.name;
    return this.sessions.appendMessage(sessionId, {
      role: 'tool',
      tool_call_id: call.id,
      name,
      content: typeof result.content === 'string' ? result.content : JSON.stringify(result),
      ...(result.ok === false ? { error: true } : {}),
      ...(result.denied ? { denied: true } : {})
    });
  }

  /** 单个工具调用的执行：审批 → 运行 → 回填 → 通知 UI */
  async execTool({ call, sessionId, projectId, model, rt, stores, cm, getState }) {
    const name = call.function ? call.function.name : call.name;
    let args = (call.function && call.function.arguments) || call.arguments || {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    const tool = findTool(name);
    if (!tool) {
      const msg = `未知工具：${name}。可用工具见系统提示，请先确认工具名。`;
      this.appendToolResult(sessionId, call, { ok: false, content: msg });
      this.send('tool', { sessionId, event: 'result', callId: call.id, name, ok: false, error: msg });
      return { ok: false };
    }

    this.send('tool', { sessionId, event: 'start', callId: call.id, name, kind: tool.kind, args, summary: this.toolSummary(tool, args) });

    // ---- 审批门控 ----
    const gate = await this.gate({ tool, args, call, sessionId, projectId, rt });
    if (gate.decision === 'deny') {
      const msg = `用户拒绝了本次操作${gate.note ? `（原因：${gate.note}）` : ''}。请换一种不需要该操作的方式继续，或向用户说明你的下一步打算。`;
      const m = this.appendToolResult(sessionId, call, { ok: false, content: msg, denied: true });
      this.send('tool', { sessionId, event: 'result', callId: call.id, name, ok: false, denied: true, content: msg, message: m });
      return { ok: false, denied: true };
    }
    if (gate.decision === 'cancel') {
      const m = this.appendToolResult(sessionId, call, { ok: false, content: '用户在确认环节取消了本轮操作。' });
      this.send('tool', { sessionId, event: 'result', callId: call.id, name, ok: false, cancelled: true, content: '已取消', message: m });
      rt.cancelled = true;
      return { ok: false, cancelled: true };
    }

    const started = Date.now();
    let result;
    try {
      const ctx = this.toolContext({ sessionId, projectId, model, rt, stores, cm, getState, call });
      result = await tool.run(args, ctx);
    } catch (err) {
      result = { ok: false, content: `错误：${err.message}`, error: err.message };
    }
    const content = typeof result.content === 'string' ? result.content : JSON.stringify(result, null, 2);
    const message = this.appendToolResult(sessionId, call, { ...result, content });
    this.send('tool', {
      sessionId,
      event: 'result',
      callId: call.id,
      name,
      kind: tool.kind,
      ok: result.ok !== false,
      error: result.error || null,
      durationMs: Date.now() - started,
      args,
      contentPreview: content.slice(0, 4000),
      data: result.data || null,
      message
    });
    if (name === 'ask_user') {
      const requestId = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      return { ok: true, ask: { requestId, question: String(args.question || '需要你补充信息'), options: Array.isArray(args.options) ? args.options : [] } };
    }
    return { ok: result.ok !== false, result };
  }

  /** 需要确认态：逐项询问；自动审批态：只拦不可逆操作 */
  async gate({ tool, args, call, sessionId, projectId, rt }) {
    const required = needsApproval(tool, args);
    if (!required) return { decision: 'allow' };
    if (tool.approval !== 'always' && rt.approval === 'auto') return { decision: 'allow', auto: true };
    const requestId = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const preview = this.approvalPreview({ tool, args, projectId });
    return new Promise((resolve) => {
      rt.pending.set(requestId, { resolve, call });
      this.send('approval', {
        sessionId,
        requestId,
        tool: { name: tool.name, kind: tool.kind, description: tool.description },
        irreversible: tool.approval === 'always',
        args,
        summary: this.toolSummary(tool, args),
        preview,
        mode: rt.approval
      });
    });
  }

  toolSummary(tool, args) {
    const keys = ['path', 'from', 'to', 'query', 'url', 'scope', 'name', 'goal'];
    const bits = [];
    for (const k of keys) if (args[k] != null) bits.push(`${k}=${oneLine(args[k], 60)}`);
    if (typeof args.content === 'string') bits.push(`内容 ${args.content.length} 字符`);
    return `${tool.name}${bits.length ? `（${bits.join('，')}）` : ''}`;
  }

  /** 审批面板里的可读预览：写类工具尽量给出差异 */
  approvalPreview({ tool, args, projectId }) {
    const rel = args.path || args.file || args.rel || args.to || '';
    const info = { rel: rel ? shortRel(rel) : '', before: null, diff: null, note: '' };
    if (!rel && !args.text && !args.rows && !args.title) return null;
    try {
      if (['write_file', 'edit_file', 'replace_in_file', 'format_markdown', 'add_toc', 'tidy_data_file', 'insert_image'].includes(tool.name)) {
        if (this.workspace.exists(projectId, rel)) {
          const before = this.workspace.read(projectId, rel).content;
          info.before = { chars: before.length, lines: before.split('\n').length };
          if (tool.name === 'write_file' && typeof args.content === 'string') {
            info.diff = diffPreview(before, args.content, { context: 2, maxLines: 30 });
          } else if (tool.name === 'replace_in_file') {
            info.note = `查找：${oneLine(args.find || args.pattern || '', 80)}\n替换为：${oneLine(args.replace || args.replacement || '', 80)}`;
          } else {
            info.note = '该操作会按工具规程改写此文件（格式化 / 补目录 / 插图片）。';
          }
        } else {
          info.note = '文件尚不存在，将新建。';
          if (tool.name === 'write_file' && typeof args.content === 'string') info.diff = diffPreview('', args.content, { context: 1, maxLines: 24 });
        }
      } else if (tool.name === 'delete_file') {
        const st = this.workspace.stat(projectId, rel);
        info.before = { chars: st.size, lines: st.dir ? null : '目录' };
        info.note = `${st.dir ? '删除目录（须为空）' : '删除文件'}：${shortRel(rel)}，${st.dir ? '' : `${st.size} 字节，`}不可恢复`;
      } else if (tool.name === 'move_file') {
        info.note = `${shortRel(args.from)} → ${shortRel(args.to)}`;
      } else if (tool.name === 'scaffold_h5') {
        info.note = `在 ${shortRel(rel || '.')} 下创建 index.html / style.css / app.js 三件套`;
      } else if (tool.name === 'rag_index_project') {
        info.note = '为整个项目建立向量索引，只写 .orag/，不改项目文件。';
      } else if (tool.name.startsWith('memory_')) {
        info.note = `${args.text ? oneLine(args.text, 120) : ''}${args.id ? `（条目 ${args.id}）` : ''} → ${args.scope || 'project'} 记忆`;
      } else if (tool.name.startsWith('skill_')) {
        info.note = `技能 ${args.name || ''}${args.title ? `（${args.title}）` : ''} → ${args.scope || 'project'} 技能库`;
      }
      return info;
    } catch (err) {
      info.note = `（预览生成失败：${err.message}）`;
      return info;
    }
  }

  /** 交给工具的执行上下文；文件访问全部经 workspace 沙箱 */
  toolContext({ sessionId, projectId, model, rt, stores, cm, getState, call }) {
    void call;
    const self = this;
    return {
      projectId,
      projectName: (this.workspace.get(projectId) || {}).name || path.basename(stores.root),
      model,
      workspace: this.workspace,
      shell: this.shell,
      memory: stores.memory,
      rag: stores.rag,
      skills: stores.skills,
      webSearch: this.webSearch,
      emit: (type, payload = {}) => self.send(type, { sessionId, ...payload }),
      getUsage: () => rt.usage || self.contextManager(model).usage(emptyState(), []),
      getPlan: () => rt.plan,
      setPlan: (plan) => {
        rt.plan = plan;
        this.sessions.saveState(sessionId, { plan });
        this.send('plan', { sessionId, plan, text: this.planText(plan) });
      },
      noteActivity: (a) => {
        rt.activity.push({ ...a, at: Date.now() });
        if (rt.activity.length > 400) rt.activity.shift();
        this.send('activity', { sessionId, activity: a, list: rt.activity.slice(-30) });
      },
      onDeleted: (rel) => this.send('files-changed', { sessionId, projectId, op: 'delete', rel: shortRel(rel) }),
      onFileMoved: (from, to) => this.send('files-changed', { sessionId, projectId, op: 'move', from: shortRel(from), to: shortRel(to) }),
      onSkillsChanged: (disabledList) => {
        this.config.skillsDisabled = Array.from(new Set(disabledList || []));
        this.saveConfig();
        this.storeCache.clear();
        this.send('skills-changed', { sessionId, projectId, disabled: this.config.skillsDisabled });
      },
      onReflect: (report) => this.send('reflect', { sessionId, report }),
      requestUserInput: () => {
        /* ask_user 由引擎在主循环里统一收尾，这里只占位，工具返回值已说明已提问 */
      },
      queueReindex: (rel) => self.scheduleIndex(projectId, rel),
      // 供工具在长任务中检查中断
      isCancelled: () => rt.cancelled
    };
  }

  // ---------------- 增量索引 ----------------

  scheduleIndex(projectId, rel) {
    if (!this.config.ragEnabled || !this.config.ragAutoIndex || !this.config.embeddingModel) return;
    if (!rel) return;
    const key = projectId;
    if (!this.indexQueue.has(key)) this.indexQueue.set(key, new Set());
    this.indexQueue.get(key).add(shortRel(rel));
    if (this.indexTimers.has(key)) clearTimeout(this.indexTimers.get(key));
    this.indexTimers.set(
      key,
      setTimeout(() => {
        this.indexTimers.delete(key);
        const rels = [...(this.indexQueue.get(key) || [])];
        this.indexQueue.delete(key);
        this.runIndex(projectId, rels).catch((err) => this.send('notice', { level: 'warn', message: `索引更新失败：${err.message}` }));
      }, this.config.indexDebounceMs || 1500)
    );
  }

  async runIndex(projectId, rels) {
    const stores = this.stores(projectId);
    if (!stores.rag.project) return { skipped: true, reason: '未启用嵌入模型' };
    const out = [];
    for (const rel of rels) {
      try {
        if (!this.workspace.exists(projectId, rel)) {
          stores.rag.project.clear(rel);
          out.push({ rel, removed: true });
          continue;
        }
        const st = this.workspace.stat(projectId, rel);
        if (st.dir || st.size > 512 * 1024) continue;
        const r = this.workspace.read(projectId, rel);
        const res = await stores.rag.project.indexFile(r.rel, r.content, { mtime: st.mtime, kind: fileKind(path.basename(r.rel), false) });
        out.push({ rel: r.rel, chunks: res.chunks, skipped: !!res.skipped });
      } catch (err) {
        out.push({ rel, error: err.message });
      }
    }
    if (out.length) this.send('rag', { projectId, updated: out, label: stores.rag.project.label, stats: stores.rag.project.stats() });
    return { updated: out };
  }

  // ---------------- 面板 API ----------------

  usageOf(sessionId) {
    const rt = this.runtime(sessionId);
    const meta = this.sessions.load(sessionId).meta;
    const model = (meta && meta.model) || this.config.chatModel;
    const cm = rt.cm || this.contextManager(model);
    const state = (this.sessions.load(sessionId).state || {}).contextState || emptyState();
    const view = cm.buildView({ system: rt.lastSystem || '', history: this.sessions.load(sessionId).messages, plan: this.planText(rt.plan || (this.sessions.load(sessionId).state || {}).plan), state });
    const usage = cm.usage(state, view.view);
    return { usage, context: cm.snapshot(), state, estimated: !rt.lastSystem, compactable: view.view.length > 0 };
  }

  /** 手动压缩（面板按钮），focus 用于「请特别保留……」 */
  async compressNow({ sessionId, focus = '' }) {
    const rt = this.runtime(sessionId);
    if (rt.busy) throw new Error('Ollab 正在工作，稍后再压缩');
    const session = this.sessions.load(sessionId);
    if (!session.meta) throw new Error('会话不存在');
    const model = session.meta.model || this.config.chatModel;
    if (!model) throw new Error('未选择模型，无法生成摘要');
    const cm = this.contextManager(model);
    const state = (session.state || {}).contextState || emptyState();
    const res = await cm.compressNow({ system: '（压缩专用：以下历史属于同一任务）', history: session.messages, plan: this.planText(rt.plan || (session.state || {}).plan), state, focus });
    this.sessions.saveState(sessionId, { contextState: res.state });
    this.send('compact', { sessionId, auto: false, before: res.before, after: res.after, actions: res.actions, ok: res.ok });
    return res;
  }

  /** 回滚派生态：原始历史不动，摘要/清理记录清零 */
  resetContext(sessionId) {
    const rt = this.runtime(sessionId);
    const cm = rt.cm || this.contextManager(this.config.chatModel);
    const session = this.sessions.load(sessionId);
    const state = (session.state || {}).contextState || emptyState();
    const next = cm.resetDerived(state);
    this.sessions.saveState(sessionId, { contextState: next });
    this.send('notice', { sessionId, level: 'info', message: '已清除压缩派生状态（摘要与清理记录），原始会话未改动' });
    return next;
  }

  sessionContextSnapshot(sessionId) {
    const rt = this.runtime(sessionId);
    const session = this.sessions.load(sessionId);
    const model = (session.meta && session.meta.model) || this.config.chatModel;
    const cm = rt.cm || this.contextManager(model);
    const state = (session.state || {}).contextState || emptyState();
    const view = cm.buildView({ system: rt.lastSystem || '', history: session.messages, plan: this.planText(rt.plan || (session.state || {}).plan), state });
    return {
      usage: cm.usage(state, view.view),
      meta: view.meta,
      view: view.view.map((m) => ({
        role: m.role,
        id: m.id,
        tokens: cm.tokenCost(state, typeof m.content === 'string' ? m.content : ''),
        flags: { pinned: !!m._pinned, folded: !!m._folded, cleared: !!m._cleared, budgeted: !!m._budgeted },
        preview: String(typeof m.content === 'string' ? m.content : '').replace(/\s+/g, ' ').slice(0, 90),
        tool_calls: (m.tool_calls || []).map((c) => (c.function ? c.function.name : c.name))
      }))
    };
  }

  /** 全量重建项目索引（面板按钮） */
  async reindexProject(projectId, { limit = 800 } = {}) {
    const stores = this.stores(projectId);
    if (!stores.rag.project) throw new Error('未配置嵌入模型：请在设置里选择 embedding 模型');
    const files = this.workspace.walk(projectId, { maxFiles: limit }).filter((f) => !f.dir && ['md', 'txt', 'json', 'xml', 'html', 'js'].includes(f.kind));
    this.send('rag', { projectId, started: true, total: files.length, label: stores.rag.project.label });
    const res = await stores.rag.project.rebuild(
      { list: files, read: (item) => this.workspace.read(projectId, item.rel).content },
      { onProgress: (p) => this.send('rag', { projectId, progress: p, label: stores.rag.project.label }), concurrency: 4, limit }
    );
    this.send('rag', { projectId, done: true, result: res, stats: stores.rag.project.stats() });
    return res;
  }

  ragStats(projectId) {
    const stores = this.stores(projectId);
    return { project: stores.rag.project ? stores.rag.project.stats() : null, global: stores.rag.global ? stores.rag.global.stats() : null };
  }

  clearRag(projectId, { scope = 'project' } = {}) {
    const stores = this.stores(projectId);
    const store = scope === 'global' ? stores.rag.global : stores.rag.project;
    if (!store) throw new Error('该范围没有索引库');
    const file = store.file;
    store.data = { version: 1, scope: store.scope, model: store.model, label: store.label, docs: {}, updated_at: Date.now() };
    store.save();
    return { cleared: file };
  }

  memorySnapshot(projectId) {
    const stores = this.stores(projectId);
    return {
      project: { stats: stores.memory.project.stats(), items: stores.memory.project.list({ limit: 200 }) },
      global: { stats: stores.memory.global.stats(), items: stores.memory.global.list({ limit: 200 }) }
    };
  }

  skillSnapshot(projectId) {
    const stores = projectId ? this.stores(projectId) : { skills: new SkillLibrary({ globalDir: this.paths.globalSkillsDir, projectDir: null, disabled: this.config.skillsDisabled }) };
    return stores.skills.list().map((s) => ({ name: s.name, title: s.title, description: s.description, scope: s.scope, builtin: !!s.builtin, enabled: s.enabled !== false, version: s.version, when: s.when, tools: s.tools, body: s.body, file: s.file }));
  }
}

module.exports = { AgentEngine, DEFAULT_CONFIG, BASE_PROMPT, AGENT_NAME, middleOutClip };
