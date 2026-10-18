/* =====================================================================
   agent.js —— 右侧 Ollab 面板
   对话流 / 工具时间线 / 审批门控 / 上下文水位与压缩 / 记忆 / 技能 / 设置。
   面板只做展示与决策，一切状态都以主进程落盘的会话为准。
   ===================================================================== */
(() => {
  const { $, call, el, esc, fail, toast, askText, showAlert } = window.MRUI;
  const api = window.mreader;

  const S = {
    cfg: null,
    models: [],
    connOk: false,
    version: '',
    sessionId: null,
    sessions: [],
    messages: [],
    status: { busy: false, approval: 'confirm', plan: null, usage: null, round: 0 },
    usage: null,
    ctx: null,
    stream: null,          // 正在流式接收的 assistant 节点
    streamText: '',
    streamReason: '',
    tools: new Map(),      // callId -> 卡片元素
    approvals: new Map(),  // requestId -> 卡片元素
    attachments: [],       // {dataUrl,name,mime}
    currentFile: null,     // 项目内相对路径
    selection: '',
    projectId: null,
    projectRoot: '',
    page: 'chat',
    booted: false
  };

  // ---------------- 小工具 ----------------

  function relOf(abs) {
    if (!abs || !S.projectRoot) return null;
    const a = String(abs).replace(/\\/g, '/').toLowerCase();
    const root = S.projectRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    if (!a.startsWith(root + '/')) return null;
    return String(abs).replace(/\\/g, '/').slice(root.length + 1);
  }

  const mdReady = () => window.marked && window.DOMPurify;

  function md(text) {
    const raw = String(text == null ? '' : text);
    if (!mdReady()) return esc(raw);
    try {
      return DOMPurify.sanitize(marked.parse(raw), { ADD_ATTR: ['target'] });
    } catch {
      return esc(raw);
    }
  }

  /** 消息正文：助手/用户走 markdown，纯文本兜底 */
  function bodyNode(role, text) {
    const node = el('div', { class: 'msg-body' });
    if (role === 'assistant' || role === 'user') node.innerHTML = md(text);
    else node.textContent = text;
    return node;
  }

  function shortMid(s, n = 90) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ');
    return t.length > n ? `${t.slice(0, n)}…` : t;
  }

  function isOpen() {
    return document.body.dataset.agent === 'on';
  }

  // ---------------- 启动 ----------------

  async function boot(agentState) {
    if (S.booted) return;
    S.booted = true;
    bindUI();
    try {
      S.cfg = (agentState && agentState.config) || await call('agent', 'agent_config');
    } catch (err) {
      fail(err, 'agent 配置读取失败');
      S.cfg = null;
    }
    if (!S.cfg) {
      setStatus('agent 未就绪');
      return;
    }
    await refreshProjects();
    renderSettings();
    await loadSessions();
    await checkConnection(false);
    renderSkills();
    renderMemory();
    if (S.sessionId) await selectSession(S.sessionId);
  }

  async function refreshProjects() {
    try {
      const r = await call('ws', 'ws_list');
      S.projectId = r.activeId;
      const p = (r.projects || []).find((x) => x.id === r.activeId) || (r.projects || [])[0];
      S.projectRoot = p ? p.root : '';
      S.projectName = p ? p.name : '';
    } catch {
      S.projectId = null;
      S.projectRoot = '';
    }
  }

  async function checkConnection(force = true) {
    setDot('busy');
    try {
      const r = await call('agent', 'agent_check', { force });
      S.connOk = !!r.ok;
      S.version = r.version || '';
      S.models = r.all || r.models || [];
      if (!r.ok) {
        setDot('bad');
        setStatus(`连不上 ${r.baseUrl}：${r.error}`);
        toast('Ollama 未响应，请确认已启动 ollama serve', 4000);
      } else {
        setDot('ok');
        setStatus(`Ollama ${r.version} 已连接 · ${S.models.filter((m) => m.canChat).length} 个对话模型`);
        if (r.fallback) toast(`模型已自动纠正：${r.fallback}`, 6000);
        S.cfg = await call('agent', 'agent_config');
        $('ag-model').textContent = S.cfg.chatModel || '未选择模型';
        renderSettings();
      }
    } catch (err) {
      setDot('bad');
      fail(err, '连接检测失败');
    }
  }

  function setDot(kind) {
    const dot = $('ag-conn-dot');
    dot.className = `ag-dot${kind ? ` ${kind}` : ''}`;
  }

  function setStatus(text) {
    const box = $('status-agent');
    if (box) box.textContent = text;
  }

  // ---------------- 会话 ----------------

  async function loadSessions() {
    try {
      const list = await call('agent', 'agent_sessions', { projectId: S.projectId, all: !S.projectId });
      S.sessions = list || [];
      const sel = $('ag-session');
      sel.innerHTML = '';
      if (!S.sessions.length) {
        sel.appendChild(el('option', { value: '', text: '（暂无会话）' }));
      }
      for (const s of S.sessions) {
        sel.appendChild(el('option', { value: s.id, text: `${s.pinned ? '★ ' : ''}${s.title}（${s.messageCount} 条）` }));
      }
      if (!S.sessionId && S.sessions.length) S.sessionId = S.sessions[0].id;
      sel.value = S.sessionId || '';
    } catch (err) {
      fail(err, '会话列表读取失败');
    }
  }

  async function selectSession(id) {
    if (!id) return;
    S.sessionId = id;
    S.stream = null;
    S.tools.clear();
    S.approvals.clear();
    try {
      const data = await call('agent', 'agent_session_load', id);
      S.messages = data.messages || [];
      S.status = data.status || S.status;
      S.ctx = data.context || null;
      S.usage = (S.ctx && S.ctx.usage) || null;
      renderMessages();
      renderPlan();
      renderUsage();
      renderContextPage();
      $('ag-approval').dataset.mode = S.status.approval || 'confirm';
      $('ag-approval').textContent = S.status.approval === 'auto' ? '自动审批' : '需要确认';
      $('ag-session').value = id;
    } catch (err) {
      fail(err, '会话加载失败');
    }
  }

  async function newSession() {
    if (!S.projectId) {
      toast('请先添加项目文件夹，agent 需要在项目内工作');
      return;
    }
    try {
      const meta = await call('agent', 'agent_session_create', { projectId: S.projectId, title: '新会话' });
      await loadSessions();
      await selectSession(meta.id);
      $('ag-input').focus();
    } catch (err) {
      fail(err, '新建会话失败');
    }
  }

  async function renameSession() {
    if (!S.sessionId) return;
    const cur = (S.sessions.find((s) => s.id === S.sessionId) || {}).title || '';
    const name = await askText({ title: '重命名会话', value: cur });
    if (!name) return;
    try {
      await call('agent', 'agent_session_rename', S.sessionId, name);
      await loadSessions();
    } catch (err) {
      fail(err, '重命名失败');
    }
  }

  async function deleteSession() {
    if (!S.sessionId) return;
    const s = S.sessions.find((x) => x.id === S.sessionId) || {};
    const c = await api.confirm({
      title: '删除会话',
      message: `即将删除会话「${s.title || ''}」及其记录文件：\n${s.messageCount || 0} 条消息、${s.compactCount || 0} 次压缩\n\n项目文件与记忆不受影响。`,
      buttons: ['删除', '取消']
    });
    if (c !== 0) return;
    try {
      await call('agent', 'agent_session_delete', S.sessionId);
      S.sessionId = null;
      await loadSessions();
      await selectSession((S.sessions[0] || {}).id);
    } catch (err) {
      fail(err, '删除失败');
    }
  }

  // ---------------- 消息渲染 ----------------

  function renderMessages() {
    const box = $('ag-messages');
    box.innerHTML = '';
    for (const m of S.messages) box.appendChild(messageNode(m));
    box.scrollTop = box.scrollHeight;
  }

  function messageNode(m) {
    if (m.role === 'tool') return toolCard({ callId: m.tool_call_id, name: m.name, content: m.content, ok: !m.error && !m.denied, denied: m.denied, args: null });
    const wrap = el('div', { class: `msg ${m.role === 'user' ? 'user' : 'assistant'}${m.error ? ' error' : ''}`, 'data-id': m.id });
    wrap.appendChild(el('div', { class: 'msg-role', text: m.role === 'user' ? '你' : 'Ollab' }));
    if (m.reasoning) {
      const r = el('details', { class: 'msg-reasoning' }, [el('summary', { text: '思考过程' }), el('div', { text: m.reasoning })]);
      wrap.appendChild(r);
    }
    if (m.images && m.images.length) {
      const row = el('div', { class: 'msg-images' });
      for (const ref of m.images) row.appendChild(el('img', { src: '', 'data-ref': ref.path || ref, alt: ref.name || '图片', title: ref.name || '' }));
      wrap.appendChild(row);
      hydrateImages(row);
    }
    if (m.content) wrap.appendChild(bodyNode(m.role, m.content));
    if (m.tool_calls && m.tool_calls.length) {
      for (const c of m.tool_calls) {
        const name = (c.function && c.function.name) || c.name;
        wrap.appendChild(toolCard({ callId: c.id, name, content: null, ok: null, args: (c.function && c.function.arguments) || c.arguments }));
      }
    }
    const actions = el('div', { class: 'msg-actions' }, [
      el('button', { text: '复制', onclick: () => { navigator.clipboard.writeText(m.content || ''); toast('已复制'); } }),
      el('button', { text: '从这里重来', onclick: () => cutFrom(m.id) })
    ]);
    wrap.appendChild(actions);
    return wrap;
  }

  async function hydrateImages(row) {
    for (const img of row.querySelectorAll('img[data-ref]')) {
      try {
        const url = await call('agent', 'agent_image', img.getAttribute('data-ref'));
        if (url) img.src = url;
      } catch {}
    }
  }

  function toolCard({ callId, name, content, ok, args, denied, durationMs }) {
    const line = el('div', { class: 'tool-line', 'data-call': callId || '' });
    const state = ok === null || ok === undefined ? 'run' : ok ? 'ok' : 'bad';
    const label = state === 'run' ? '执行中' : state === 'ok' ? '完成' : denied ? '已拒绝' : '失败';
    const head = el('div', { class: 'tool-head' }, [
      el('span', { class: `tool-state ${state}`, text: label }),
      el('span', { class: 'tool-name', text: name || 'tool' }),
      el('span', { class: 'tool-sum', text: args ? shortMid(argHint(args), 60) : '' }),
      durationMs ? el('span', { class: 'tool-time', text: `${durationMs}ms` }) : null
    ]);
    const body = el('div', { class: 'tool-body' });
    const parts = [];
    if (args) parts.push(`参数：${JSON.stringify(args, null, 2).slice(0, 1200)}`);
    if (content) parts.push(String(content).slice(0, 6000));
    body.textContent = parts.join('\n\n');
    head.addEventListener('click', () => line.classList.toggle('open'));
    line.appendChild(head);
    line.appendChild(body);
    return line;
  }

  function argHint(args) {
    const keys = ['path', 'from', 'to', 'query', 'url', 'goal', 'text', 'name', 'pattern'];
    for (const k of keys) if (args[k] != null && args[k] !== '') return `${k}: ${args[k]}`;
    return Object.keys(args).join(', ');
  }

  function noteNode(level, text) {
    return el('div', { class: 'msg system-note' }, [el('div', { class: `msg-body${level === 'error' ? ' err' : ''}`, text })]);
  }

  function pushNode(node) {
    const box = $('ag-messages');
    box.appendChild(node);
    box.scrollTop = box.scrollHeight;
    return node;
  }

  async function cutFrom(msgId) {
    if (!S.sessionId) return;
    const c = await api.confirm({ title: '从这里重来', message: '将删除这条消息之后的所有内容（原始记录会重写），压缩派生状态清零。', buttons: ['确定', '取消'] });
    if (c !== 0) return;
    try {
      await call('agent', 'agent_session_cut', { sessionId: S.sessionId, msgId, inclusive: false });
      await selectSession(S.sessionId);
    } catch (err) {
      fail(err, '截断失败');
    }
  }

  // ---------------- 计划 / 水位 ----------------

  function renderPlan(plan) {
    if (plan) S.status.plan = plan;
    const box = $('ag-plan');
    const p = S.status.plan;
    if (!p || !p.steps || !p.steps.length) {
      box.hidden = true;
      return;
    }
    const marks = { done: '✓', failed: '✗', doing: '▶', pending: '·' };
    box.hidden = false;
    box.textContent = `计划：${p.goal}\n${(p.steps || []).map((s, i) => `${i + 1}. [${marks[s.status] || '·'}] ${s.text}${s.note ? ` —— ${s.note}` : ''}`).join('\n')}`;
  }

  function renderUsage() {
    const u = S.usage;
    const fill = $('usage-fill');
    const label = $('usage-label');
    if (!u) {
      label.textContent = '上下文 —';
      fill.style.width = '0';
      return;
    }
    label.textContent = `上下文 ${u.percent}% · ${u.tokens}/${u.budget} 词元 · 窗口 ${u.numCtx}`;
    label.title = u.message || '';
    fill.style.width = `${Math.min(100, u.percent)}%`;
    fill.className = u.level === 'hard' ? 'hard' : u.level === 'auto' || u.level === 'hint' ? 'warn' : '';
    renderContextPage();
  }

  function renderContextPage() {
    const card = $('ctx-summary');
    const list = $('ctx-detail');
    if (!card || !list) return;
    const c = S.ctx;
    if (!c) {
      card.textContent = '打开一个会话后，这里显示发往模型的实际视图：哪些消息被摘要折叠、哪些工具结果被清理、哪些内容落盘只留引用。';
      list.innerHTML = '';
      return;
    }
    const u = c.usage || {};
    const meta = c.meta || {};
    card.innerHTML = `
      <div><b>${u.percent || 0}%</b> 占用（${u.tokens || 0} / ${u.budget || 0} 词元，窗口 ${u.numCtx || 0}，预留输出 ${u.reserveOutput || 0}）</div>
      <div>${esc(u.message || '')}</div>
      <div>折叠进摘要 ${meta.folded || 0} 条 · 撤下工具结果 ${meta.droppedToolResults || 0} 条 · 固定段 ${meta.pinnedBlocks || 0} · 保留最近 ${meta.recentKept || 0} 条 · 关键事实 ${meta.facts || 0}</div>`;
    list.innerHTML = '';
    for (const row of c.view || []) {
      const flags = Object.entries(row.flags || {}).filter(([, v]) => v).map(([k]) => k);
      list.appendChild(
        el('div', { class: 'ctx-row', title: row.preview }, [
          el('span', { class: 'ctx-role', text: row.role }),
          el('span', { class: 'ctx-prev', text: row.preview }),
          ...flags.map((f) => el('span', { class: 'flag', text: f })),
          el('span', { class: 'ctx-tk', text: `${row.tokens}` })
        ])
      );
    }
  }

  // ---------------- 发送与流式 ----------------

  async function send() {
    if (!S.sessionId) {
      await newSession();
      if (!S.sessionId) return;
    }
    const input = $('ag-input');
    const text = input.value.trim();
    if (!text && !S.attachments.length) return;
    const images = S.attachments.map((a) => ({ dataUrl: a.dataUrl, name: a.name, mime: a.mime }));
    input.value = '';
    S.attachments = [];
    renderAttachments();
    S.stream = null;
    S.streamText = '';
    S.streamReason = '';
    $('ag-send').disabled = true;
    try {
      const payload = { sessionId: S.sessionId, text, images, projectId: S.projectId, currentFile: S.currentFile, selection: S.selection };
      await call('agent', 'agent_send', payload);
    } catch (err) {
      pushNode(noteNode('error', err.message));
    } finally {
      $('ag-send').disabled = false;
      input.focus();
    }
  }

  function ensureStreamNode() {
    if (S.stream) return S.stream;
    const wrap = el('div', { class: 'msg assistant typing' });
    wrap.appendChild(el('div', { class: 'msg-role', text: 'Ollab' }));
    const reason = el('div', { class: 'msg-reasoning', hidden: true });
    const body = el('div', { class: 'msg-body' });
    wrap.appendChild(reason);
    wrap.appendChild(body);
    S.stream = { wrap, body, reason };
    pushNode(wrap);
    return S.stream;
  }

  function onDelta(kind, delta) {
    const s = ensureStreamNode();
    if (kind === 'reasoning') {
      S.streamReason += delta;
      s.reason.hidden = false;
      s.reason.textContent = S.streamReason;
    } else {
      S.streamText += delta;
      s.body.textContent = S.streamText;
    }
    $('ag-messages').scrollTop = $('ag-messages').scrollHeight;
  }

  function closeStream(replaceWith) {
    if (!S.stream) return;
    if (replaceWith) {
      S.stream.wrap.replaceWith(replaceWith);
    } else {
      S.stream.wrap.classList.remove('typing');
    }
    S.stream = null;
    S.streamText = '';
    S.streamReason = '';
  }

  // ---------------- 审批 ----------------

  function approvalCard(evt) {
    const { requestId, tool, args, summary, preview, irreversible } = evt;
    const card = el('div', { class: 'approval', 'data-req': requestId });
    card.appendChild(el('div', { class: 'ap-title', text: `${irreversible ? '不可逆操作：' : ''}Ollab 请求执行 ${tool.name}` }));
    const detail = [];
    if (summary) detail.push(summary);
    if (preview && preview.rel) detail.push(`路径：${preview.rel}`);
    if (preview && preview.before) detail.push(`现有内容：${preview.before.chars} 字符${preview.before.lines != null ? ` / ${preview.before.lines} 行` : ''}`);
    if (preview && preview.note) detail.push(preview.note);
    if (preview && preview.diff) detail.push(preview.diff);
    const body = el('div', { class: 'ap-detail', text: detail.filter(Boolean).join('\n') });
    card.appendChild(body);

    const note = el('input', { class: 'ap-note', type: 'text', placeholder: '附言（可选，会回告诉模型）' });
    const decide = (decision) => {
      card.classList.add(decision === 'allow' || decision === 'auto' ? '' : 'deny');
      resolveCard(card, decision);
      call('agent', 'agent_decide', { requestId, decision, note: note.value }).catch((err) => fail(err, '确认失败'));
    };
    const row = el('div', { class: 'ap-row' }, [
      note,
      el('button', { class: 'tool-btn primary', text: '允许', onclick: () => decide('allow') }),
      irreversible ? null : el('button', { class: 'tool-btn', text: '本会话自动批准', title: '之后的写操作不再逐项询问（删除类仍会询问）', onclick: () => decide('auto') }),
      el('button', { class: 'tool-btn', text: '拒绝', onclick: () => decide('deny') })
    ]);
    card.appendChild(row);
    S.approvals.set(requestId, card);
    pushNode(card);
    note.focus();
    return card;
  }

  function resolveCard(card, decision) {
    const label = { allow: '已允许', auto: '已允许并改为自动批准', deny: '已拒绝', cancel: '已取消' }[decision] || '已处理';
    card.innerHTML = '';
    card.classList.add('system-note');
    card.appendChild(el('div', { class: 'ap-title', text: `${card.dataset.req ? '' : ''}${label}` }));
  }

  function askCard(evt) {
    const card = el('div', { class: 'approval' });
    card.appendChild(el('div', { class: 'ap-title', text: 'Ollab 需要你先确认一件事' }));
    card.appendChild(el('div', { class: 'ap-detail', text: evt.question || '' }));
    const row = el('div', { class: 'ap-row' });
    for (const opt of evt.options || []) {
      row.appendChild(el('button', { class: 'tool-btn', text: opt, onclick: () => { card.remove(); answer(opt); } }));
    }
    const free = el('input', { type: 'text', placeholder: '或直接输入你的想法' });
    free.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        card.remove();
        answer(free.value);
      }
    });
    row.appendChild(free);
    card.appendChild(row);
    pushNode(card);
  }

  async function answer(text) {
    if (!text) return;
    $('ag-input').value = text;
    await send();
  }

  // ---------------- 事件总线 ----------------

  function onEvent(evt) {
    if (!evt || !evt.type) return;
    if (evt.sessionId && evt.sessionId !== S.sessionId && ['delta', 'usage', 'compact'].includes(evt.type)) return;
    switch (evt.type) {
      case 'status':
        S.status = { ...S.status, ...evt };
        setDot(S.status.busy ? 'busy' : S.connOk ? 'ok' : 'bad');
        $('ag-stop').hidden = !S.status.busy;
        $('ag-send').disabled = S.status.busy;
        $('ag-approval').dataset.mode = S.status.approval || 'confirm';
        $('ag-approval').textContent = S.status.approval === 'auto' ? '自动审批' : '需要确认';
        renderPlan(evt.plan);
        break;
      case 'turn-start':
        ensureStreamNode();
        break;
      case 'delta':
        onDelta(evt.kind, evt.delta);
        break;
      case 'message': {
        const m = evt.message;
        S.messages.push(m);
        if (m.role === 'assistant' && S.stream) closeStream(messageNode(m));
        else pushNode(messageNode(m));
        break;
      }
      case 'tool':
        onToolEvent(evt);
        break;
      case 'usage':
        S.usage = evt.usage;
        S.ctx = { usage: evt.usage, meta: (S.ctx && S.ctx.meta) || {}, view: (S.ctx && S.ctx.view) || [] };
        renderUsage();
        break;
      case 'stats':
        if (S.usage) {
          S.usage = { ...S.usage, lastPromptTokens: evt.stats && evt.stats.promptTokens };
          renderUsage();
        }
        break;
      case 'compact': {
        const actions = (evt.actions || []).map((a) => a.label || a.action || a).join('、');
        pushNode(noteNode('info', `${evt.auto ? '自动压缩' : '手动压缩'}：${evt.before && evt.after ? `${evt.before.percent}% → ${evt.after.percent}%` : '完成'}${actions ? ` · ${actions}` : ''}`));
        selectSession(S.sessionId);
        break;
      }
      case 'approval':
        approvalCard(evt);
        break;
      case 'approval-resolved': {
        const card = S.approvals.get(evt.requestId);
        if (card) {
          resolveCard(card, evt.decision);
          S.approvals.delete(evt.requestId);
        }
        break;
      }
      case 'ask':
        askCard(evt);
        break;
      case 'plan':
        renderPlan(evt.plan);
        break;
      case 'reflect':
        pushNode(el('div', { class: 'msg system-note' }, [el('div', { class: 'msg-body', text: `复盘：${evt.report}` })]));
        break;
      case 'activity':
        break;
      case 'notice':
        pushNode(noteNode(evt.level || 'info', evt.message || ''));
        break;
      case 'error':
        pushNode(noteNode('error', evt.message || '发生错误'));
        break;
      case 'turn-end':
        closeStream();
        pushNode(noteNode('info', `本轮结束：${evt.rounds} 轮请求，${evt.toolCalls} 次工具调用`));
        loadSessions();
        break;
      case 'files-changed':
        document.dispatchEvent(new CustomEvent('mr:agent-files-changed', { detail: { projectId: evt.projectId, rel: evt.rel, op: evt.op } }));
        document.dispatchEvent(new CustomEvent('mr:file-changed-externally', { detail: { rel: evt.rel, op: evt.op } }));
        break;
      case 'rag':
        if (evt.progress && evt.total) setStatus(`索引中 ${evt.progress}/${evt.total}`);
        if (evt.done) {
          setStatus('索引重建完成');
          renderSettings();
        }
        break;
      case 'skills-changed':
        renderSkills();
        break;
      default:
        break;
    }
  }

  function onToolEvent(evt) {
    if (evt.event === 'start') {
      closeStream();
      const card = toolCard({ callId: evt.callId, name: evt.name, content: null, ok: null, args: evt.args });
      card.querySelector('.tool-sum').textContent = evt.summary || shortMid(argHint(evt.args || {}), 60);
      S.tools.set(evt.callId, card);
      pushNode(card);
      return;
    }
    const card = S.tools.get(evt.callId) || (() => {
      const c = toolCard({ callId: evt.callId, name: evt.name, content: null, ok: null, args: evt.args });
      pushNode(c);
      S.tools.set(evt.callId, c);
      return c;
    })();
    const state = evt.ok ? 'ok' : evt.denied ? 'bad' : 'bad';
    const label = evt.ok ? '完成' : evt.denied ? '已拒绝' : evt.cancelled ? '已取消' : '失败';
    const badge = card.querySelector('.tool-state');
    badge.className = `tool-state ${state}`;
    badge.textContent = label;
    if (evt.durationMs) {
      let t = card.querySelector('.tool-time');
      if (!t) {
        t = el('span', { class: 'tool-time' });
        card.querySelector('.tool-head').appendChild(t);
      }
      t.textContent = `${evt.durationMs}ms`;
    }
    const body = card.querySelector('.tool-body');
    body.textContent = String(evt.contentPreview || evt.content || evt.error || '').slice(0, 6000);
    if (!evt.ok) card.classList.add('open');
    // 工具改动了文件：让文件树与编辑器同步
    const data = evt.data || {};
    if (data.rel || data.to) {
      document.dispatchEvent(new CustomEvent('mr:agent-files-changed', { detail: { projectId: S.projectId, rel: data.rel || data.to } }));
    }
  }

  // ---------------- 附件（图片上下文） ----------------

  function addFiles(files) {
    for (const f of files || []) {
      if (!/^image\//.test(f.type)) continue;
      const reader = new FileReader();
      reader.onload = () => {
        S.attachments.push({ dataUrl: reader.result, name: f.name, mime: f.type });
        renderAttachments();
      };
      reader.readAsDataURL(f);
    }
  }

  function renderAttachments() {
    const box = $('ag-attach');
    box.innerHTML = '';
    box.hidden = !S.attachments.length;
    S.attachments.forEach((a, i) => {
      const item = el('div', { class: 'att', title: a.name }, [
        el('img', { src: a.dataUrl, alt: a.name }),
        el('button', { text: '×', title: '移除', onclick: () => { S.attachments.splice(i, 1); renderAttachments(); } })
      ]);
      box.appendChild(item);
    });
  }

  // ---------------- 记忆 ----------------

  async function renderMemory() {
    const list = $('mem-list');
    if (!list) return;
    const scope = $('mem-scope').value;
    list.innerHTML = '';
    list.appendChild(el('div', { class: 'set-hint', text: '加载中…' }));
    try {
      const snap = await call('agent', 'agent_memory', { projectId: S.projectId });
      const side = scope === 'global' ? snap.global : snap.project;
      const items = side.items || [];
      list.innerHTML = '';
      list.appendChild(el('div', { class: 'set-hint', text: `${scope === 'global' ? '全局记忆' : '项目记忆（.omemory/memory.json）'}：共 ${(side.stats && side.stats.total) || items.length} 条` }));
      for (const it of items) {
        const node = el('div', { class: 'mem-item' }, [
          el('div', { class: 'mem-top' }, [
            el('span', { class: 'mem-kind', text: it.kind || 'fact' }),
            it.pinned ? el('span', { class: 'flag', text: '固定' }) : null,
            el('span', { text: new Date(it.updatedAt || it.createdAt || Date.now()).toLocaleString('zh-CN') })
          ]),
          el('div', { class: 'mem-text', text: it.text }),
          el('div', { class: 'mem-ops' }, [
            el('button', { text: '编辑', onclick: async () => {
              const v = await askText({ title: '编辑记忆', value: it.text, multiline: true });
              if (v == null) return;
              await call('agent', 'agent_memory_update', { projectId: S.projectId, id: it.id, patch: { text: v }, scope }).catch((e) => fail(e, '保存失败'));
              renderMemory();
            } }),
            el('button', { text: it.pinned ? '取消固定' : '固定', onclick: async () => {
              await call('agent', 'agent_memory_update', { projectId: S.projectId, id: it.id, patch: { pinned: !it.pinned }, scope }).catch((e) => fail(e, '操作失败'));
              renderMemory();
            } }),
            el('button', { text: '删除', onclick: async () => {
              const c = await api.confirm({ title: '删除记忆', message: `将删除：\n${it.text}`, buttons: ['删除', '取消'] });
              if (c !== 0) return;
              await call('agent', 'agent_memory_remove', { projectId: S.projectId, id: it.id, scope }).catch((e) => fail(e, '删除失败'));
              renderMemory();
            } })
          ])
        ]);
        list.appendChild(node);
      }
    } catch (err) {
      list.innerHTML = '';
      list.appendChild(el('div', { class: 'set-hint', text: err.message }));
    }
  }

  async function addMemory() {
    const scope = $('mem-scope').value;
    const text = await askText({ title: scope === 'global' ? '新增全局记忆' : '新增项目记忆', multiline: true, placeholder: '例如：文档标题一律用中文，代码块保持原始语言标注' });
    if (!text || !text.trim()) return;
    try {
      await call('agent', 'agent_memory_add', { projectId: S.projectId, text: text.trim(), scope });
      toast('已写入记忆');
      renderMemory();
    } catch (err) {
      fail(err, '写入记忆失败');
    }
  }

  // ---------------- 技能 ----------------

  async function renderSkills() {
    const list = $('skill-list');
    if (!list) return;
    list.innerHTML = '';
    try {
      const skills = await call('agent', 'agent_skills', { projectId: S.projectId });
      if (!skills.length) {
        list.appendChild(el('div', { class: 'set-hint', text: '没有可用技能。' }));
        return;
      }
      for (const sk of skills) {
        const input = el('input', { type: 'checkbox' });
        input.checked = sk.enabled;
        input.addEventListener('change', () => {
          call('agent', 'agent_skill_toggle', { projectId: S.projectId, name: sk.name, enabled: input.checked })
            .then(() => toast(`${sk.title} ${input.checked ? '已启用' : '已停用'}`))
            .catch((e) => fail(e, '切换失败'));
        });
        const item = el('div', { class: 'skill-item' }, [
          el('div', { class: 'skill-top' }, [
            el('label', { class: 'switch' }, [input, el('i')]),
            el('span', { class: 'skill-title', text: sk.title || sk.name }),
            el('span', { class: 'skill-scope', text: sk.scope === 'project' ? '项目 .oskill' : '全局' })
          ]),
          el('div', { class: 'skill-desc', text: sk.description || '' }),
          el('div', { class: 'skill-body', text: sk.body || '' })
        ]);
        item.querySelector('.skill-title').addEventListener('click', () => item.classList.toggle('open'));
        list.appendChild(item);
      }
    } catch (err) {
      list.appendChild(el('div', { class: 'set-hint', text: err.message }));
    }
  }

  // ---------------- 设置 ----------------

  const NUM = (v, min, max, dflt) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  };

  async function applyConfig(patch, note = '') {
    try {
      S.cfg = await call('agent', 'agent_config_set', patch);
      $('ag-model').textContent = S.cfg.chatModel || '未选择模型';
      if (note) toast(note);
      return true;
    } catch (err) {
      fail(err, '设置保存失败');
      return false;
    }
  }

  async function renderSettings() {
    const body = $('set-body');
    if (!body || !S.cfg) return;
    const c = S.cfg;
    body.innerHTML = '';

    // 服务端
    const urlInput = el('input', { type: 'text', value: c.baseUrl });
    urlInput.addEventListener('change', () => applyConfig({ baseUrl: urlInput.value.trim() }, '服务端地址已更新').then(() => checkConnection(true)));
    const verRow = el('div', { class: 'set-row' }, [el('label', { text: 'Ollama' }), el('span', { class: 'set-path', text: S.connOk ? `已连接 · ${S.version}` : '未连接' })]);
    const checkBtn = el('button', { class: 'tool-btn', text: '重新检测', onclick: () => checkConnection(true) });
    body.appendChild(el('div', { class: 'set-group' }, [el('h4', { text: '本地服务端' }), el('div', { class: 'set-row' }, [el('label', { text: '地址' }), urlInput, checkBtn]), verRow]));

    // 模型
    const chatSel = el('select');
    chatSel.appendChild(el('option', { value: '', text: '（未选择）' }));
    for (const m of S.models.filter((x) => x.canChat !== false)) {
      const caps = [m.canTools && '工具', m.canVision && '视觉', m.canThinking && '思考', m.isEmbedding && '嵌入'].filter(Boolean).join('/');
      chatSel.appendChild(el('option', { value: m.name, text: `${m.name}${caps ? ` · ${caps}` : ''}` }));
    }
    chatSel.value = c.chatModel || '';
    chatSel.addEventListener('change', () => applyConfig({ chatModel: chatSel.value }, '对话模型已切换'));

    const embSel = el('select');
    embSel.appendChild(el('option', { value: '', text: '（不启用向量检索）' }));
    for (const m of S.models.filter((x) => x.isEmbedding)) embSel.appendChild(el('option', { value: m.name, text: m.name }));
    embSel.value = c.embeddingModel || '';
    embSel.addEventListener('change', () => applyConfig({ embeddingModel: embSel.value }, '嵌入模型已切换，建议重建索引'));

    const ctxInput = el('input', { type: 'number', value: c.numCtx, min: 4096, max: 1048576, step: 1024 });
    ctxInput.addEventListener('change', () => applyConfig({ numCtx: NUM(ctxInput.value, 4096, 1048576, c.numCtx) }, '上下文窗口已更新'));
    const reserveInput = el('input', { type: 'number', value: c.reserveOutput, min: 256, max: 32768, step: 128 });
    reserveInput.addEventListener('change', () => applyConfig({ reserveOutput: NUM(reserveInput.value, 256, 32768, c.reserveOutput) }));
    const tempInput = el('input', { type: 'number', value: c.temperature, min: 0, max: 2, step: 0.05 });
    tempInput.addEventListener('change', () => applyConfig({ temperature: NUM(tempInput.value, 0, 2, c.temperature) }));
    const roundsInput = el('input', { type: 'number', value: c.maxToolRounds, min: 1, max: 40 });
    roundsInput.addEventListener('change', () => applyConfig({ maxToolRounds: NUM(roundsInput.value, 1, 40, c.maxToolRounds) }));

    const thinkSel = el('select');
    for (const [v, t] of [['off', '关闭'], ['on', '开启'], ['auto', '交给模型默认']]) thinkSel.appendChild(el('option', { value: v, text: t }));
    thinkSel.value = c.thinking;
    thinkSel.addEventListener('change', () => applyConfig({ thinking: thinkSel.value }));

    body.appendChild(el('div', { class: 'set-group' }, [
      el('h4', { text: '模型与生成' }),
      el('div', { class: 'set-row' }, [el('label', { text: '对话模型' }), chatSel]),
      el('div', { class: 'set-row' }, [el('label', { text: '嵌入模型' }), embSel]),
      el('div', { class: 'set-row' }, [el('label', { text: '上下文窗口' }), ctxInput, el('span', { class: 'set-hint', text: 'num_ctx，必须显式下发' })]),
      el('div', { class: 'set-row' }, [el('label', { text: '预留输出' }), reserveInput]),
      el('div', { class: 'set-row' }, [el('label', { text: '温度' }), tempInput]),
      el('div', { class: 'set-row' }, [el('label', { text: '思考模式' }), thinkSel]),
      el('div', { class: 'set-row' }, [el('label', { text: '工具轮数上限' }), roundsInput])
    ]));

    // 上下文压缩
    const autoCompact = el('input', { type: 'checkbox' });
    autoCompact.checked = !!c.autoCompact;
    autoCompact.addEventListener('change', () => applyConfig({ autoCompact: autoCompact.checked }));
    const ratios = c.thresholds || {};
    const autoRatio = el('input', { type: 'number', value: ratios.autoRatio != null ? ratios.autoRatio : 0.7, min: 0.1, max: 0.95, step: 0.05 });
    autoRatio.addEventListener('change', () => applyConfig({ thresholds: { ...ratios, autoRatio: NUM(autoRatio.value, 0.1, 0.95, 0.7) } }));
    const keepTurns = el('input', { type: 'number', value: ratios.keepRecentTurns != null ? ratios.keepRecentTurns : 3, min: 1, max: 12 });
    keepTurns.addEventListener('change', () => applyConfig({ thresholds: { ...ratios, keepRecentTurns: NUM(keepTurns.value, 1, 12, 3) } }));
    body.appendChild(el('div', { class: 'set-group' }, [
      el('h4', { text: '上下文压缩' }),
      el('div', { class: 'set-row' }, [el('label', { text: '自动压缩' }), autoCompact]),
      el('div', { class: 'set-row' }, [el('label', { text: '触发水位' }), autoRatio, el('span', { class: 'set-hint', text: '占用比例达到即压缩' })]),
      el('div', { class: 'set-row' }, [el('label', { text: '保留最近轮数' }), keepTurns]),
      el('div', { class: 'set-hint', text: '压缩只作用于发往模型的视图，会话原始记录始终只追加、不删除。' })
    ]));

    // 能力开关
    const mk = (key, label) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = !!c[key];
      box.addEventListener('change', () => applyConfig({ [key]: box.checked }, `${label}${box.checked ? ' 已开启' : ' 已关闭'}`));
      return el('div', { class: 'set-row' }, [el('label', { text: label }), box]);
    };
    body.appendChild(el('div', { class: 'set-group' }, [
      el('h4', { text: '能力开关' }),
      mk('toolsEnabled', '工具调用'),
      mk('memoryEnabled', '记忆'),
      mk('skillEnabled', '技能'),
      mk('ragEnabled', '向量检索 RAG'),
      mk('ragAutoIndex', '文件改动自动索引'),
      mk('includeCurrentFile', '带上当前打开的文件')
    ]));

    // 索引
    const ragStats = await safeRagStats();
    const reindexBtn = el('button', { class: 'tool-btn', text: '重建项目索引' });
    reindexBtn.addEventListener('click', async () => {
      reindexBtn.disabled = true;
      setStatus('索引重建中…');
      try {
        await call('agent', 'agent_reindex', { projectId: S.projectId });
        toast('索引重建完成');
        renderSettings();
      } catch (err) {
        fail(err, '索引失败');
      } finally {
        reindexBtn.disabled = false;
      }
    });
    const clearBtn = el('button', { class: 'tool-btn', text: '清空项目索引' });
    clearBtn.addEventListener('click', () => {
      call('agent', 'agent_rag_clear', { projectId: S.projectId }).then(() => { toast('已清空'); renderSettings(); }).catch((e) => fail(e, '清空失败'));
    });
    body.appendChild(el('div', { class: 'set-group' }, [
      el('h4', { text: '向量索引（.orag/）' }),
      el('div', { class: 'set-hint', text: ragStats || '未启用嵌入模型。' }),
      el('div', { class: 'set-actions' }, [reindexBtn, clearBtn])
    ]));

    // 人设
    const persona = el('textarea', { rows: 3, placeholder: '给 Ollab 的额外设定，例如：回答保持三句话内、文件名用中文' });
    persona.value = c.persona || '';
    persona.addEventListener('change', () => applyConfig({ persona: persona.value }, '设定已保存'));
    const approvalSel = el('select');
    for (const [v, t] of [['confirm', '需要确认'], ['auto', '自动审批']]) approvalSel.appendChild(el('option', { value: v, text: t }));
    approvalSel.value = c.approvalMode;
    approvalSel.addEventListener('change', () => applyConfig({ approvalMode: approvalSel.value }, `默认审批策略：${approvalSel.options[approvalSel.selectedIndex].text}`));
    body.appendChild(el('div', { class: 'set-group' }, [
      el('h4', { text: '偏好' }),
      el('div', { class: 'set-row' }, [el('label', { text: '默认审批' }), approvalSel]),
      el('div', { class: 'set-row' }, [el('label', { text: '额外设定' }), persona])
    ]));

    // 工具清单
    const tools = c.tools || [];
    const disabled = new Set(c.toolsDisabled || []);
    const toolDetails = el('details', { class: 'set-group' });
    const toolSummary = el('summary', { class: 'set-h4', text: `工具清单（${tools.length - disabled.size}/${tools.length} 启用）` });
    const grid = el('div', { class: 'tool-grid' });
    for (const t of tools) {
      const box = el('input', { type: 'checkbox' });
      box.checked = !disabled.has(t.name);
      box.addEventListener('change', () => {
        const set = new Set(S.cfg.toolsDisabled || []);
        if (box.checked) set.delete(t.name);
        else set.add(t.name);
        applyConfig({ toolsDisabled: [...set] }).then(renderSkills);
      });
      grid.appendChild(el('div', { class: 'set-row', title: t.description }, [el('label', { class: 'tool-check' }, [box, el('span', { text: t.name })])]));
    }
    toolDetails.appendChild(toolSummary);
    toolDetails.appendChild(grid);
    body.appendChild(toolDetails);

    // 数据位置
    let dir = { dataDir: '', agentDir: '' };
    try {
      dir = await call('agent', 'agent_data_dir');
    } catch {}
    body.appendChild(el('div', { class: 'set-group' }, [
      el('h4', { text: '数据存放' }),
      el('div', { class: 'set-path', text: dir.dataDir }),
      el('div', { class: 'set-hint', text: 'agent 配置 / 会话 / 全局记忆 / 全局技能 / 工具缓存都在 agent/ 目录；项目记忆 .omemory、项目技能 .oskill、项目索引 .orag 跟着项目文件夹走。' }),
      el('div', { class: 'set-actions' }, [el('button', { class: 'tool-btn', text: '打开数据目录', onclick: () => api.reveal(dir.agentDir) })])
    ]));
  }

  async function safeRagStats() {
    try {
      const r = await call('agent', 'agent_rag_stats', { projectId: S.projectId });
      const p = r.project;
      if (!p) return '未启用嵌入模型。';
      return `已索引 ${p.files || 0} 个文档 / ${p.chunks || 0} 个片段 · 模型 ${p.model || '-'} · 维度 ${p.dim || 0}`;
    } catch (err) {
      return err.message;
    }
  }

  // ---------------- 绑定 ----------------

  function bindUI() {
    $('ag-close').addEventListener('click', () => api.setSettings({ agentPanelOpen: false }));
    for (const tab of document.querySelectorAll('.ag-tab')) {
      tab.addEventListener('click', () => {
        S.page = tab.dataset.tab;
        document.querySelectorAll('.ag-tab').forEach((b) => b.classList.toggle('active', b === tab));
        document.querySelectorAll('.ag-page').forEach((p) => p.classList.toggle('active', p.dataset.page === S.page));
        if (S.page === 'settings') renderSettings();
        if (S.page === 'memory') renderMemory();
        if (S.page === 'skills') renderSkills();
        if (S.page === 'context') renderContextPage();
      });
    }

    $('ag-session').addEventListener('change', (e) => selectSession(e.target.value));
    $('ag-new-session').addEventListener('click', newSession);
    $('ag-export').addEventListener('click', async () => {
      if (!S.sessionId) return;
      try {
        await call('agent', 'agent_session_export', S.sessionId);
      } catch (err) {
        fail(err, '导出失败');
      }
    });
    $('ag-approval').addEventListener('click', async () => {
      const mode = $('ag-approval').dataset.mode === 'auto' ? 'confirm' : 'auto';
      if (!S.sessionId) {
        await applyConfig({ approvalMode: mode });
        toast(`默认策略已改为${mode === 'auto' ? '自动审批' : '需要确认'}`);
        $('ag-approval').dataset.mode = mode;
        $('ag-approval').textContent = mode === 'auto' ? '自动审批' : '需要确认';
        return;
      }
      try {
        await call('agent', 'agent_approval', { sessionId: S.sessionId, mode });
      } catch (err) {
        fail(err, '切换失败');
      }
    });
    $('ag-send').addEventListener('click', send);
    $('ag-stop').addEventListener('click', () => {
      if (S.sessionId) call('agent', 'agent_stop', S.sessionId).catch((e) => fail(e, '停止失败'));
    });
    $('ag-compress').addEventListener('click', async () => {
      if (!S.sessionId) return;
      const focus = await askText({ title: '压缩上下文', multiline: true, placeholder: '想特别保留什么？留空则按标准六段结构压缩' });
      if (focus === null) return;
      $('ag-compress').disabled = true;
      try {
        await call('agent', 'agent_compress', { sessionId: S.sessionId, focus });
        toast('压缩完成');
      } catch (err) {
        fail(err, '压缩失败');
      } finally {
        $('ag-compress').disabled = false;
      }
    });

    const input = $('ag-input');
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        send();
      }
    });
    input.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.files) || [];
      if (items.length) {
        e.preventDefault();
        addFiles(items);
      }
    });
    $('ag-attach-btn').addEventListener('click', () => $('ag-file').click());
    $('ag-file').addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = '';
    });
    $('mem-add').addEventListener('click', addMemory);
    $('mem-scope').addEventListener('change', renderMemory);
    $('skill-refresh').addEventListener('click', renderSkills);

    // 消息里的链接交给系统浏览器，图片点击放大
    $('ag-messages').addEventListener('click', (e) => {
      const a = e.target.closest('a[href]');
      if (a) {
        e.preventDefault();
        api.openExternal(a.href);
        return;
      }
      const img = e.target.closest('img[data-ref]');
      if (img) showAlert({ title: img.alt || '图片', message: img.getAttribute('data-ref') });
    });

    // 编辑器联动：当前文件与选区传给 agent
    document.addEventListener('mr:doc-changed', (e) => {
      const d = e.detail || {};
      S.currentFile = relOf(d.filePath);
      S.selection = d.selection || '';
    });
    document.addEventListener('mr:project-changed', async () => {
      await refreshProjects();
      await loadSessions();
      if (S.sessions.length) await selectSession(S.sessions[0].id);
      else {
        S.sessionId = null;
        S.messages = [];
        renderMessages();
      }
      renderSettings();
    });
    document.addEventListener('mr:project-added', async () => {
      await refreshProjects();
      await loadSessions();
      renderSettings();
    });

    api.on('agent:event', onEvent);
  }

  window.MeReaderAgent = {
    boot,
    isOpen,
    checkConnection,
    refreshProjects,
    newSession,
    attachFiles: addFiles,
    /** 文件树插图等场景把文本塞回输入框 */
    insertText(text) {
      const input = $('ag-input');
      input.value += text;
      input.focus();
    },
    setPanelOpen(open) {
      if (!open) return;
      if (!S.booted) boot();
      else if (!S.sessions.length) loadSessions();
    }
  };
})();
