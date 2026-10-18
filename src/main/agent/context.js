'use strict';

/**
 * 上下文管理与压缩
 *
 * 采纳业界主流的分层做法（Claude Code 五级管线 / Anthropic context editing 的
 * clear_tool_uses / LangChain SummarizationMiddleware / MemGPT 分页记忆）：
 *
 *   L0 pinned   系统提示 + 工具 schema + 当前文件/选区 + 计划状态    纯规则，永不压缩
 *   L1 budget   超长工具输出→头尾摘录 + 全文落盘，视图里只留引用     纯规则
 *   L2 clearing 最旧的已完成工具结果替换为占位符（保留最近 N 组）     纯规则
 *   L3 summary  对「尚未被摘要覆盖」的旧轮次做增量滚动摘要           需要模型（1 次）
 *   L4 recent   最近 N 轮原文逐字保留                                纯规则
 *   L5 facts    路径/标识符/数字/错误码抽取，独立于摘要注入           纯规则
 *   L6 recall   原始历史 append-only 落盘 + 向量召回，需要旧细节时取回 需要嵌入模型
 *
 * 关键纪律：
 *   - 原始历史只追加、不改写；压缩是「派生视图」，回滚=删派生状态，不丢数据。
 *   - 绝不做「摘要的摘要」：增量摘要始终从原始消息重算未覆盖部分。
 *   - 防抖动：一次至少回收 clearAtLeast 预算、两次压缩之间至少间隔 minTurns 轮、失败只重试一次。
 *   - 计量以 Ollama 返回的 prompt_eval_count 为真值校准字符估算器。
 *   - 工具调用与工具结果必须成对出现，孤立 tool_result 会让下一次请求非法。
 */

const crypto = require('crypto');
const path = require('path');

const { estimateTokens, toLf } = require('./markdown');
const { ensureDir, writeJson } = require('./paths');

const CLEARED_PLACEHOLDER = '[该工具结果已超长，内容已写入上下文缓存文件，结论见上一步的执行摘要]';
const SUMMARY_TEMPLATE = ['目标', '已完成', '关键决策', '涉及文件', '未决问题', '用户偏好'].join('/');

function defaultThresholds() {
  return {
    manualHintRatio: 0.6, // 面板提示「建议手动压缩」的水位
    autoRatio: 0.8, // 自动压缩触发水位
    targetRatio: 0.45, // 压缩后目标占用
    hardRatio: 0.95, // 超过即拒绝再发请求，必须先压缩
    keepRecentTurns: 3, // L4 原文保留轮数
    keepToolGroups: 3, // L2 保留最近几组工具调用
    toolOutputTokenLimit: 700, // L1 单条工具输出预算
    summaryTokenCap: 900, // L3 摘要硬上限
    clearAtLeastTokens: 800, // 防抖：预计回收不足则跳过
    minTurnsBetweenCompacts: 2,
    cooldownMs: 20000,
    maxImagesInWindow: 2
  };
}

function emptyState() {
  return {
    summary: '',
    coversUpTo: null, // 已被摘要覆盖的最后一条消息 id
    facts: [],
    cleared: [], // { id, replacedWith }
    budgets: [], // L1 落盘记录 { id, file, tokens }
    lastCompactAt: 0,
    lastCompactTurn: -999,
    compactCount: 0,
    calib: null // { charsPerToken } 由 prompt_eval_count 校准
  };
}

class ContextManager {
  /**
   * @param {{summarize: (prompt:string)=>Promise<string>, cacheDir?: string, thresholds?, numCtx?, reserveOutput?}} opts
   *   summarize 由引擎注入（一次模型调用），单测时可传假函数
   */
  constructor(opts = {}) {
    this.summarize = opts.summarize;
    this.cacheDir = opts.cacheDir || null;
    this.thresholds = { ...defaultThresholds(), ...(opts.thresholds || {}) };
    this.numCtx = opts.numCtx || 8192;
    this.reserveOutput = opts.reserveOutput ?? 1500;
  }

  configure({ numCtx, reserveOutput, thresholds }) {
    if (numCtx) this.numCtx = numCtx;
    if (reserveOutput != null) this.reserveOutput = reserveOutput;
    if (thresholds) this.thresholds = { ...this.thresholds, ...thresholds };
    return this.snapshot();
  }

  snapshot() {
    const t = this.thresholds;
    const budget = this.budget();
    return {
      numCtx: this.numCtx,
      reserveOutput: this.reserveOutput,
      budget,
      autoAt: Math.round(budget * t.autoRatio),
      manualHintAt: Math.round(budget * t.manualHintRatio),
      targetAt: Math.round(budget * t.targetRatio),
      hardAt: Math.round(budget * t.hardRatio),
      thresholds: t
    };
  }

  /** 可发送预算 = 窗口 - 生成预留 */
  budget() {
    return Math.max(1024, this.numCtx - this.reserveOutput);
  }

  /** 校准字符/词元比：以服务端返回的真实 prompt_eval_count 为准 */
  calibrate(state, viewMessages, actualPromptTokens) {
    if (!actualPromptTokens || actualPromptTokens <= 0) return state;
    const est = this.measure(viewMessages);
    if (!est.tokens) return state;
    const ratio = actualPromptTokens / est.tokens;
    // 平滑更新，避免单次抖动
    const next = state.calib ? { charsPerToken: state.calib.charsPerToken * 0.7 + ratio * 0.3 } : { charsPerToken: ratio };
    return { ...state, calib: next };
  }

  tokenCost(state, text) {
    const base = estimateTokens(text);
    return Math.round(base * (state.calib && state.calib.charsPerToken ? state.calib.charsPerToken : 1));
  }

  /** 估算一段消息的占用；图片按固定成本计（本地视觉模型通常是 几百 token 起） */
  measure(messages, state = emptyState()) {
    let tokens = 0;
    let images = 0;
    const parts = [];
    for (const m of messages || []) {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      const own = this.tokenCost(state, content) + (m.tool_calls ? this.tokenCost(state, JSON.stringify(m.tool_calls)) : 0);
      tokens += own;
      if (m.images && m.images.length) {
        images += m.images.length;
        tokens += m.images.length * 800;
      }
      if (m.role === 'tool') tokens += 8; // 配对标记成本
      parts.push({ id: m.id, role: m.role, tokens: own, preview: content.slice(0, 60) });
    }
    return { tokens, images, parts };
  }

  usage(state, viewMessages) {
    const m = this.measure(viewMessages, state);
    const budget = this.budget();
    const ratio = m.tokens / budget;
    const t = this.thresholds;
    return {
      tokens: m.tokens,
      images: m.images,
      budget,
      numCtx: this.numCtx,
      reserveOutput: this.reserveOutput,
      percent: Math.round(ratio * 100),
      level: ratio >= t.hardRatio ? 'hard' : ratio >= t.autoRatio ? 'auto' : ratio >= t.manualHintRatio ? 'hint' : 'ok',
      message:
        ratio >= t.hardRatio
          ? '上下文已接近上限，必须先压缩才能继续发送'
          : ratio >= t.autoRatio
            ? '达到自动压缩水位，将在下一次请求前压缩'
            : ratio >= t.manualHintRatio
              ? '可以使用「压缩上下文」手动整理，建议尽早'
              : '占用健康'
    };
  }

  /** ---------- L1：超长工具输出落盘 ---------- */
  applyOutputBudget(messages, state, { now = () => Date.now() } = {}) {
    const limit = this.thresholds.toolOutputTokenLimit;
    let changed = 0;
    const out = (messages || []).map((m) => {
      if (m.role !== 'tool') return m;
      const text = toLf(m.content || '');
      const tokens = this.tokenCost(state, text);
      if (tokens <= limit) return m;
      const existing = (state.budgets || []).find((b) => b.id === m.id);
      const lines = text.split('\n');
      const head = lines.slice(0, 20).join('\n');
      const tail = lines.slice(-20).join('\n');
      let file = existing && existing.file;
      if (!file && this.cacheDir) {
        const hash = crypto.createHash('sha1').update(`${m.id}|${text}`).digest('hex').slice(0, 16);
        file = path.join(this.cacheDir, `${hash}.md`);
        ensureDir(path.dirname(file));
        if (!require('fs').existsSync(file)) {
          writeJson(file + '.meta.json', { saved_at: now(), tokens, tool: m.name || '', original: file });
          require('fs').writeFileSync(file, text, 'utf8');
        }
      }
      changed++;
      const view = {
        ...m,
        content:
          `${head}\n\n…… 省略 ${lines.length - 40} 行（约 ${tokens} token）……\n\n${tail}` +
          (file ? `\n\n${CLEARED_PLACEHOLDER}\n完整内容：${file}` : `\n\n${CLEARED_PLACEHOLDER}`),
        _budgeted: true
      };
      state.budgets = [...(state.budgets || []).filter((b) => b.id !== m.id), { id: m.id, file: file || null, tokens }];
      return view;
    });
    return { messages: out, changed, state };
  }

  /** ---------- L2：清理陈旧工具结果（保持 tool_calls 与结果成对） ---------- */
  clearStaleToolResults(messages, state, { keep = this.thresholds.keepToolGroups } = {}) {
    const groups = [];
    let current = null;
    (messages || []).forEach((m, idx) => {
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
        current = { assistantIndex: idx, toolIndices: [] };
        groups.push(current);
      } else if (m.role === 'tool' && current) {
        current.toolIndices.push(idx);
      }
    });
    const stale = groups.slice(0, Math.max(0, groups.length - keep));
    const clearedIds = new Set(state.cleared.map((c) => c.id));
    const toClear = [];
    for (const g of stale) {
      for (const i of g.toolIndices) {
        const m = messages[i];
        if (!m || clearedIds.has(m.id)) continue;
        if (this.tokenCost(state, toLf(m.content || '')) < 60) continue;
        toClear.push({ index: i, id: m.id, tokens: this.tokenCost(state, toLf(m.content || '')) });
      }
    }
    const recovered = toClear.reduce((s, x) => s + x.tokens, 0);
    if (recovered < this.thresholds.clearAtLeastTokens && toClear.length) {
      return { messages, cleared: 0, recovered: 0, reason: '预计回收过小，跳过以避免抖动' };
    }
    const out = (messages || []).map((m) => {
      const hit = toClear.find((t) => t.id === m.id);
      return hit ? { ...m, content: '[工具结果已清理]', _cleared: true } : m;
    });
    state.cleared = [...state.cleared, ...toClear.map((t) => ({ id: t.id, at: Date.now() }))].slice(-200);
    return { messages: out, cleared: toClear.length, recovered };
  }

  /** ---------- L5：关键事实抽取（摘要会丢实体，这里单独保住） ---------- */
  extractFacts(messages, state, { max = 60 } = {}) {
    const found = new Map((state.facts || []).map((f) => [f.value, f]));
    // 路径实体必须整段保住：早期写法把 docs/sub/b.md 截成 /sub/b.md，模型照着补全就会写错文件。
    // 字符类内容单独拼：把带方括号的片段塞进另一个方括号里，第一个 ] 就会提前闭合整个字符类。
    const CH = '\\-\\w.+\\u4e00-\\u9fa5\\\\/';
    const SEG = `[${CH}]`;
    const SEP = '[\\\\/]';
    const ext = 'md|markdown|mdown|mkd|txt|json5|jsonc|json|xml|html|htm|css|jpe?g|png|gif|svg|webp|ico|jsx|ts|tsx|js|py|go|rs|yml|yaml|toml|csv|log|ini|env|sh|ps1|bat';
    const pathRe = new RegExp(
      `(?<![\\w:])[A-Za-z]:${SEP}${SEG}+(?:${SEP}${SEG}+)*` + // 盘符：C:\Users\demo\docs、C:/a/b.json
        `|${SEP}${SEP}${SEG}+(?:${SEP}${SEG}+)+` + // UNC：\\server\share\x
        `|${SEP}${SEG}+(?:${SEP}${SEG}+)+` + // POSIX 绝对：/var/log/app.log
        `|${SEG}+(?:${SEP}${SEG}+)+\\.(?:${ext})\\b`, // 带扩展名的相对路径：docs/sub/b.md、./notes/a.md
      'gi'
    );
    const patterns = [
      { re: pathRe, kind: 'path', stripUrl: true },
      { re: /[\w.\u4e00-\u9fa5-]+\.(?:md|markdown|txt|json|xml|html?|css|jpe?g|png|gif|svg|js|ts)\b/gi, kind: 'file' },
      { re: /(?:错误|error|Error|异常|失败)[:：]?\s*[\w\s'"\-_.:]{0,60}/g, kind: 'error' },
      { re: /\b\d+(?:\.\d+)?\s*(?:%|px|ms|s|MB|KB|GB|tokens?|字|行)\b/gi, kind: 'number' }
    ];
    for (const m of messages || []) {
      const text = toLf(typeof m.content === 'string' ? m.content : '');
      if (!text) continue;
      for (const p of patterns) {
        // 网址不是项目路径，先挖掉再抽，否则 https://x.com/a.md 会被当成相对路径
        const src = p.stripUrl ? text.replace(/https?:\/\/\S+/gi, ' ') : text;
        const hits = src.match(p.re) || [];
        for (const h of hits) {
          const v = String(h).trim().slice(0, 120);
          if (v.length < 3) continue;
          const prev = found.get(v);
          found.set(v, { value: v, kind: p.kind, count: (prev ? prev.count : 0) + 1, lastRole: m.role });
        }
      }
    }
    const facts = [...found.values()].sort((a, b) => b.count - a.count).slice(0, max);
    state.facts = facts;
    return facts;
  }

  /** 事实清单文本（进 pinned 段） */
  factsBlock(facts, { max = 24 } = {}) {
    if (!facts || !facts.length) return '';
    const byKind = {};
    for (const f of facts) (byKind[f.kind] = byKind[f.kind] || []).push(f.value);
    const lines = [];
    const order = ['file', 'path', 'error', 'number'];
    for (const k of order) {
      if (!byKind[k]) continue;
      lines.push(`- ${k === 'file' ? '文件' : k === 'path' ? '路径' : k === 'error' ? '错误' : '数值'}：${byKind[k].slice(0, max).join('、')}`);
    }
    return lines.length ? `### 会话中反复出现的关键实体（压缩时必须保留）\n${lines.join('\n')}` : '';
  }

  /** ---------- L3：增量滚动摘要 ---------- */
  buildSummaryPrompt(pendingMessages, { previous = '', focus = '' } = {}) {
    const transcript = (pendingMessages || [])
      .map((m) => {
        const content = toLf(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
        const clipped = content.length > 1200 ? `${content.slice(0, 900)}\n……（截断）\n${content.slice(-200)}` : content;
        const tools = m.tool_calls ? ` [调用工具：${m.tool_calls.map((t) => (t.function ? t.function.name : t.name)).join(', ')}]` : '';
        return `[${m.role}${m.id ? `#${m.id}` : ''}]${tools}\n${clipped}`;
      })
      .join('\n\n');
    return `请把下面的对话历史压缩成结构化摘要，供后续继续同一任务使用。

严格按以下六个小节输出，每节 1–5 条短句，总长度不超过 ${this.thresholds.summaryTokenCap} token；文件路径、标识符、数字、错误码必须原样保留，不得改写：
${SUMMARY_TEMPLATE.split('/').map((s) => `## ${s}`).join('\n')}
${previous ? `\n已有摘要（与之合并，不要重复表述）：\n${previous}\n` : ''}${focus ? `\n本次压缩请特别保留：${focus}\n` : ''}
对话历史：
${transcript}
`;
  }

  async summarizeOlder({ messages, state, keepRecentTurns = this.thresholds.keepRecentTurns, focus = '' }) {
    if (!this.summarize) throw new Error('未注入摘要函数');
    const { pending, kept } = splitForSummary(messages, keepRecentTurns);
    if (!pending.length) return { state, summarized: 0, kept: kept.length, reason: '没有可摘要的旧轮次' };
    const cap = this.thresholds.summaryTokenCap;
    let summary = '';
    try {
      summary = toLf(await this.summarize(this.buildSummaryPrompt(pending, { previous: state.summary, focus })));
    } catch (err) {
      return { state, summarized: 0, kept: kept.length, error: `摘要失败，退回规则裁剪：${err.message}` };
    }
    // 摘要硬上限：模型不听话时按行截断，绝不放任它吃掉整个窗口
    const tokens = this.tokenCost(state, summary);
    if (tokens > cap) {
      const lines = summary.split('\n');
      let acc = '';
      for (const l of lines) {
        if (this.tokenCost(state, `${acc}\n${l}`) > cap) break;
        acc = acc ? `${acc}\n${l}` : l;
      }
      summary = `${acc}\n（摘要已按长度上限截断）`;
    }
    const lastPending = pending[pending.length - 1];
    return {
      state: { ...state, summary, coversUpTo: lastPending.id || state.coversUpTo, compactCount: (state.compactCount || 0) + 1, lastCompactAt: Date.now(), lastCompactTurn: turnIndexOf(messages) },
      summarized: pending.length,
      kept: kept.length,
      tokens
    };
  }

  /** ---------- 组装发送视图 ---------- */
  buildView({ system, history, plan, state, pinnedExtra = '', now }) {
    const t = this.thresholds;
    let working = (history || []).slice();
    const budgetInfo = [];

    const cleared = this.clearStaleToolResults(working, state, { keep: t.keepToolGroups });
    working = cleared.messages;
    budgetInfo.push({ level: 'L2 工具结果清理', detail: `清理 ${cleared.cleared} 条，回收约 ${cleared.recovered} token${cleared.reason ? `（${cleared.reason}）` : ''}` });

    const budgeted = this.applyOutputBudget(working, state, { now });
    working = budgeted.messages;
    budgetInfo.push({ level: 'L1 超长输出落盘', detail: `${budgeted.changed} 条工具输出被裁剪为头尾摘录` });

    const facts = this.extractFacts(history || [], state);
    const recentCount = keepRecentMessageCount(working, t.keepRecentTurns);
    const pinned = [
      system,
      pinnedExtra,
      plan ? `## 当前计划状态（不可丢弃）\n${plan}` : '',
      state.summary ? `## 更早对话的结构化摘要\n${state.summary}` : '',
      this.factsBlock(facts)
    ].filter(Boolean);

    const keptOld = working.slice(0, working.length - recentCount);
    const tail = working.slice(working.length - recentCount);
    // 摘要覆盖到的旧消息不再进视图（信息已在 pinned 的摘要段里）；未覆盖的旧消息保持原文。
    // coversUpTo 按轮次推进，被覆盖的必然是完整的工具组，因此工具结果可整条撤下而不留孤立配对。
    const covered = keptOld.filter((m) => covers(state, m));
    const visibleOld = keptOld.filter((m) => !covers(state, m));
    const folded = covered.filter((m) => m.role !== 'tool').map(foldMessage);
    const dropped = covered.length - folded.length;

    const view = [...toSystemMessages(pinned), ...folded, ...visibleOld, ...tail];
    return { view, state, meta: { pipeline: budgetInfo, folded: folded.length, droppedToolResults: dropped, pinnedBlocks: pinned.length, recentKept: tail.length, facts: facts.length } };
  }

  /**
   * 自动压缩入口：返回 { state, actions, before, after }
   * 规则层先跑（零模型成本），仍超水位才调模型摘要。
   */
  async ensureWithinBudget({ system, history, plan, state, pinnedExtra = '' }) {
    const t = this.thresholds;
    const before = this.usage(state, this.buildView({ system, history, plan, state, pinnedExtra }).view);
    if (before.percent < t.autoRatio * 100) return { state, actions: [], before, after: before, needed: false };

    const actions = [];
    let workingState = { ...state };
    const snapshotTurns = turnIndexOf(history);
    const tooSoon = snapshotTurns - (workingState.lastCompactTurn || -999) < t.minTurnsBetweenCompacts && Date.now() - (workingState.lastCompactAt || 0) < t.cooldownMs;

    // 先走规则层：清理 + 落盘 + 折叠
    let view = this.buildView({ system, history, plan, state: workingState, pinnedExtra });
    let after = this.usage(workingState, view.view);
    actions.push({ level: 'L1+L2 规则层', detail: `${before.percent}% → ${after.percent}%` });
    if (after.percent < t.targetRatio * 100) return { state: workingState, actions, before, after, needed: true };

    if (tooSoon) {
      return { state: workingState, actions: [...actions, { level: 'L3 摘要', detail: '距上次压缩过近，本轮跳过（防抖动）' }], before, after, needed: true };
    }

    const res = await this.summarizeOlder({ messages: history, state: workingState, focus: '' });
    if (res.error) {
      actions.push({ level: 'L3 摘要', detail: res.error });
    } else {
      workingState = res.state;
      view = this.buildView({ system, history, plan, state: workingState, pinnedExtra });
      after = this.usage(workingState, view.view);
      actions.push({ level: 'L3 摘要', detail: `合并 ${res.summarized} 条旧消息，摘要约 ${res.tokens} token，视图降至 ${after.percent}%` });
    }
    return { state: workingState, actions, before, after, needed: true };
  }

  /** 手动压缩（面板按钮）：无条件走 L3，并允许指定保留重点 */
  async compressNow({ system, history, plan, state, focus = '' }) {
    const before = this.usage(state, this.buildView({ system, history, plan, state }).view);
    const res = await this.summarizeOlder({ messages: history, state, focus });
    if (res.error) {
      const view = this.buildView({ system, history, plan, state });
      return { state, before, after: this.usage(state, view.view), actions: [{ level: 'L3 摘要', detail: res.error }], ok: false };
    }
    const view = this.buildView({ system, history, plan, state: res.state });
    return {
      state: res.state,
      before,
      after: this.usage(res.state, view.view),
      ok: true,
      actions: [{ level: 'L3 摘要', detail: `摘要覆盖 ${res.summarized} 条消息，保留最近 ${res.kept} 条原文` }]
    };
  }

  /** 回滚：丢弃派生摘要状态，原始历史未受影响 */
  resetDerived(state) {
    return { ...emptyState(), calib: state.calib || null };
  }
}

function toSystemMessages(blocks) {
  // pinned 各块合并成单条 system 消息，避免多条 system 在不同后端行为不一致
  const text = blocks.join('\n\n---\n\n');
  return text ? [{ role: 'system', content: text, _pinned: true }] : [];
}

/** 摘要覆盖到的消息不再进视图；coversUpTo 之后的消息为未覆盖 */
function covers(state, message) {
  if (!state.coversUpTo) return false;
  const order = Number(String(message.id || '').split('-')[0]);
  const covered = Number(String(state.coversUpTo).split('-')[0]);
  if (!Number.isFinite(order) || !Number.isFinite(covered)) return false;
  return order <= covered;
}

function foldMessage(m) {
  const isTool = m.role === 'tool';
  return {
    role: isTool ? 'tool' : m.role,
    tool_call_id: m.tool_call_id,
    name: m.name,
    content: `[已折叠的${m.role}消息 #${m.id}：${(toLf(typeof m.content === 'string' ? m.content : '').split('\n')[0] || '').slice(0, 40)}……内容已并入摘要]`,
    _folded: true
  };
}

/** 按「轮」切分：一轮 = user 消息 + 其后所有 assistant/tool 消息 */
function turnGroups(messages) {
  const groups = [];
  for (const m of messages || []) {
    if (m.role === 'user' || !groups.length) groups.push([m]);
    else groups[groups.length - 1].push(m);
  }
  return groups;
}

function splitForSummary(messages, keepRecentTurns) {
  const groups = turnGroups(messages);
  const keep = Math.max(1, keepRecentTurns);
  const keepGroups = groups.slice(-keep);
  const pending = groups.slice(0, groups.length - keep).flat();
  return { pending, kept: keepGroups.flat() };
}

function keepRecentMessageCount(messages, keepRecentTurns) {
  const groups = turnGroups(messages);
  const tail = groups.slice(-Math.max(1, keepRecentTurns)).flat();
  return Math.min(messages.length, tail.length);
}

function turnIndexOf(messages) {
  return turnGroups(messages || []).length;
}

module.exports = { ContextManager, defaultThresholds, emptyState, turnGroups, splitForSummary, CLEARED_PLACEHOLDER };
