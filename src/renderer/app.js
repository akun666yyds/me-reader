(() => {
  const api = window.mreader;
  const $ = (id) => document.getElementById(id);

  const els = {
    body: document.body,
    editor: $('editor'),
    preview: $('preview'),
    tabs: $('tabs'),
    zoomLabel: $('zoom-label'),
    statusPosition: $('status-position'),
    statusCount: $('status-count'),
    statusFile: $('status-file'),
    statusDirty: $('status-dirty'),
    dropOverlay: $('drop-overlay'),
    splitter: $('splitter'),
    contextMenu: $('tab-context-menu')
  };

  // ---------- 文档模型（记事本式多标签） ----------

  let docs = [];
  let activeId = null;
  let nextDocId = 1;
  let settings = null;
  let closing = false;

  const base = (p) => p.replace(/^.*[\\/]/, '');
  const normPath = (p) => p.replace(/\\/g, '/').toLowerCase();
  const isDirty = (d) => d.text !== d.saved;
  const active = () => docs.find((d) => d.id === activeId) || null;
  const dirtyDocs = () => docs.filter(isDirty);

  function newDoc({ filePath = null, name = '未命名', text = '', saved = '' }) {
    const d = { id: nextDocId++, filePath, name, text, saved, scrollTop: 0, previewScroll: 0 };
    docs.push(d);
    return d;
  }

  function flushEditor() {
    const d = active();
    if (!d) return;
    d.text = els.editor.value;
    d.scrollTop = els.editor.scrollTop;
    d.previewScroll = $('preview-pane').scrollTop;
  }

  function loadEditor() {
    const d = active();
    els.editor.value = d ? d.text : '';
    updateTitle();
    updateStatus();
    renderTabs();
    if (settings.viewMode !== 'edit') renderPreview();
    els.editor.scrollTop = d ? d.scrollTop : 0;
    $('preview-pane').scrollTop = d ? d.previewScroll : 0;
  }

  function activateDoc(id) {
    if (id === activeId) return;
    flushEditor();
    activeId = id;
    loadEditor();
    if (settings.viewMode === 'edit') els.editor.focus();
  }

  function activateRelative(step) {
    if (docs.length < 2) return;
    const idx = docs.findIndex((d) => d.id === activeId);
    activateDoc(docs[(idx + step + docs.length) % docs.length].id);
  }

  // ---------- 标题 / 状态栏 ----------

  function updateTitle() {
    const d = active();
    document.title = `${d && isDirty(d) ? '● ' : ''}${d ? d.name : 'MeReader'} - MeReader`;
    els.statusFile.textContent = d ? (d.filePath || '未保存的副本') : '';
    els.statusDirty.textContent = d && isDirty(d) ? '未保存' : '';
    notifyEditorChanged();
  }

  function updateStatus() {
    const v = els.editor.value;
    const pos = els.editor.selectionStart;
    const before = v.slice(0, pos);
    const line = before.split('\n').length;
    const col = pos - before.lastIndexOf('\n');
    const chars = v.replace(/\s/g, '').length;
    const lines = v ? v.split('\n').length : 0;
    els.statusPosition.textContent = `行 ${line}，列 ${col}`;
    els.statusCount.textContent = `${chars} 字 · ${lines} 行`;
  }

  // ---------- 标签栏 ----------

  function renderTabs() {
    els.tabs.innerHTML = '';
    for (const d of docs) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (d.id === activeId ? ' active' : '');
      tab.dataset.id = d.id;
      tab.title = d.filePath || d.name;

      const label = document.createElement('span');
      label.className = 'tab-name';
      label.textContent = d.name;
      tab.appendChild(label);

      if (isDirty(d)) {
        const dot = document.createElement('span');
        dot.className = 'tab-dirty';
        dot.textContent = '●';
        tab.appendChild(dot);
      }

      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = '关闭标签页';
      tab.appendChild(close);

      els.tabs.appendChild(tab);
    }
    updateTitle();
  }

  els.tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const id = Number(tab.dataset.id);
    if (e.target.classList.contains('tab-close')) closeTab(id);
    else activateDoc(id);
  });

  els.tabs.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tab = e.target.closest('.tab');
    if (tab) {
      e.preventDefault();
      closeTab(Number(tab.dataset.id));
    }
  });

  els.tabs.addEventListener('contextmenu', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    e.preventDefault();
    showTabMenu(Number(tab.dataset.id), e.clientX, e.clientY);
  });

  function showTabMenu(id, x, y) {
    const d = docs.find((dd) => dd.id === id);
    if (!d) return;
    const items = [
      ['重命名', () => startRename(d)],
      ['另存为...', () => saveAsDoc(d)],
      d.filePath ? ['打开所在文件夹', () => api.reveal(d.filePath)] : null,
      d.filePath ? ['复制文件路径', () => navigator.clipboard.writeText(d.filePath)] : null,
      ['关闭标签页', () => closeTab(id)]
    ].filter(Boolean);

    els.contextMenu.innerHTML = '';
    for (const [label, fn] of items) {
      const item = document.createElement('div');
      item.className = 'context-item';
      item.textContent = label;
      item.addEventListener('click', () => {
        hideTabMenu();
        fn();
      });
      els.contextMenu.appendChild(item);
    }
    els.contextMenu.style.left = x + 'px';
    els.contextMenu.style.top = y + 'px';
    els.contextMenu.classList.add('show');
  }

  function hideTabMenu() {
    els.contextMenu.classList.remove('show');
  }
  document.addEventListener('click', hideTabMenu);
  window.addEventListener('blur', hideTabMenu);

  // ---------- 重命名（对齐记事本：有路径则直接重命名磁盘文件） ----------

  function startRename(d) {
    const tab = els.tabs.querySelector(`.tab[data-id="${d.id}"] .tab-name`);
    if (!tab) return;
    const input = document.createElement('input');
    input.className = 'tab-rename-input';
    input.value = d.filePath ? d.name.replace(/\.[^.]+$/, '') : d.name;
    tab.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const newName = input.value.trim();
      if (newName && newName !== d.name) {
        if (d.filePath) {
          try {
            const newPath = await api.rename(d.filePath, newName);
            d.filePath = newPath;
            d.name = base(newPath);
          } catch (err) {
            await api.confirm({ title: '重命名失败', message: String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), buttons: ['确定'] });
          }
        } else {
          d.name = /\.(md|markdown|txt|mdown|mkd)$/i.test(newName) ? newName : newName + '.md';
        }
      }
      renderTabs();
      scheduleAutosave();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') { done = true; renderTabs(); }
    });
    input.addEventListener('blur', commit);
  }

  // ---------- Markdown 渲染 ----------

  marked.setOptions({ gfm: true, breaks: false, pedantic: false });

  let renderTimer = null;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderPreview, 120);
  }

  function renderPreview() {
    const d = active();
    const raw = d ? d.text : '';
    els.preview.innerHTML = DOMPurify.sanitize(marked.parse(raw), { ADD_ATTR: ['target'] });

    els.preview.querySelectorAll('a[href]').forEach((a) => {
      if (!/^#/.test(a.getAttribute('href'))) a.target = '_blank';
    });

    if (d && d.filePath) {
      const dir = d.filePath.replace(/[\\/][^\\/]*$/, '/');
      els.preview.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') || '';
        if (/^(https?:|data:|file:)/i.test(src)) return;
        const abs = src.startsWith('/') ? 'file://' + src.replace(/^\/+/, '') : dir + src;
        img.src = encodeURI(abs).replace(/#/g, '%23');
      });
    }

    els.preview.querySelectorAll('pre code').forEach((block) => hljs.highlightElement(block));
  }

  // ---------- 文件操作（均针对指定文档） ----------

  async function openPath(p) {
    const existing = docs.find((d) => d.filePath && normPath(d.filePath) === normPath(p));
    if (existing) {
      activateDoc(existing.id);
      return;
    }
    try {
      const { content } = await api.readFile(p);
      const d = newDoc({ filePath: p, name: base(p), text: content, saved: content });
      activateDoc(d.id);
    } catch (err) {
      await api.confirm({ title: '打开失败', message: `无法打开文件：\n${p}\n\n${err.message || err}`, buttons: ['确定'] });
    }
  }

  async function openDialogAndOpen() {
    const p = await api.openDialog();
    if (p) await openPath(p);
  }

  async function saveDoc(d) {
    flushEditor();
    if (!d.filePath) {
      const target = await api.saveDialog(d.name === '未命名' ? '未命名.md' : d.name);
      if (!target) return false;
      d.filePath = target;
      d.name = base(target);
    }
    try {
      await api.writeFile(d.filePath, d.text);
      d.saved = d.text;
      updateTitle();
      renderTabs();
      return true;
    } catch (err) {
      await api.confirm({ title: '保存失败', message: `无法保存文件：\n${err.message || err}`, buttons: ['确定'] });
      return false;
    }
  }

  async function saveAsDoc(d) {
    flushEditor();
    const target = await api.saveDialog(d.filePath ? d.name : d.name + (d.name.endsWith('.md') ? '' : '.md'));
    if (!target) return false;
    try {
      await api.writeFile(target, d.text);
      d.filePath = target;
      d.name = base(target);
      d.saved = d.text;
      updateTitle();
      renderTabs();
      scheduleAutosave();
      return true;
    } catch (err) {
      await api.confirm({ title: '保存失败', message: `无法保存文件：\n${err.message || err}`, buttons: ['确定'] });
      return false;
    }
  }

  function newTab() {
    const d = newDoc({ text: '', saved: '' });
    activateDoc(d.id);
    els.editor.focus();
  }

  async function closeTab(id) {
    const d = docs.find((x) => x.id === id);
    if (!d) return;
    if (id === activeId) flushEditor();
    if (isDirty(d)) {
      const action = await api.confirmClose(d.name);
      if (action === 'cancel') return;
      if (action === 'save' && !(await saveDoc(d))) return;
    }
    const idx = docs.indexOf(d);
    const wasActive = id === activeId;
    docs.splice(idx, 1);
    if (!docs.length) {
      api.forceClose();
      return;
    }
    if (wasActive) {
      activeId = docs[Math.min(idx, docs.length - 1)].id;
      loadEditor();
    } else {
      renderTabs();
    }
    snapshotAutosave();
  }

  // ---------- 会话缓存（自动的软件机制，对齐记事本自动保存） ----------

  let autosaveTimer = null;
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(snapshotAutosave, 1500);
  }

  function snapshotAutosave() {
    flushEditor();
    if (!dirtyDocs().length) {
      api.clearAutosave();
      return;
    }
    api.autosave({
      docs: docs.map((d) => ({ filePath: d.filePath, name: d.name, text: d.text, saved: d.saved })),
      activeIndex: Math.max(0, docs.findIndex((d) => d.id === activeId)),
      updatedAt: Date.now()
    });
  }

  async function restoreSession(snap) {
    for (const sd of snap.docs) {
      let saved = sd.saved === undefined ? '' : sd.saved;
      if (sd.filePath) {
        try {
          saved = (await api.readFile(sd.filePath)).content;
        } catch {
          saved = sd.text;
        }
      }
      newDoc({ filePath: sd.filePath || null, name: sd.name || (sd.filePath ? base(sd.filePath) : '未命名'), text: sd.text, saved });
    }
    activeId = docs[Math.min(snap.activeIndex || 0, docs.length - 1)].id;
  }

  // ---------- 与文件树 / agent 面板的联动 ----------

  /** 当前编辑位置与选区：agent 需要知道用户正盯着哪一段 */
  function notifyEditorChanged() {
    const d = active();
    document.dispatchEvent(new CustomEvent('mr:doc-changed', {
      detail: {
        filePath: d ? d.filePath : null,
        name: d ? d.name : '',
        selection: els.editor ? els.editor.value.slice(els.editor.selectionStart, els.editor.selectionEnd) : ''
      }
    }));
  }

  function insertAtCursor(text) {
    if (!text) return;
    const d = active();
    if (!d) return;
    const start = els.editor.selectionStart;
    const end = els.editor.selectionEnd;
    d.text = `${d.text.slice(0, start)}${text}${d.text.slice(end)}`;
    els.editor.value = d.text;
    els.editor.selectionStart = els.editor.selectionEnd = start + text.length;
    updateTitle();
    renderTabs();
    scheduleRender();
    scheduleAutosave();
    els.editor.focus();
  }

  /** agent 改了正在编辑的文件：未改动过就直接同步磁盘内容，改过则只提示，绝不覆盖用户输入 */
  async function syncExternalChange(rel) {
    const d = active();
    if (!d || !d.filePath) return;
    const norm = (p) => String(p).replace(/\\/g, '/');
    if (!rel || !norm(d.filePath).toLowerCase().endsWith(norm(rel).toLowerCase())) return;
    if (isDirty(d)) {
      window.MRUI.toast(`Ollab 更新了 ${d.name}，你有未保存修改，已保留你的版本`, 4200);
      return;
    }
    try {
      const { content } = await api.readFile(d.filePath);
      d.text = content;
      d.saved = content;
      loadEditor();
    } catch (err) {
      await api.confirm({ title: '文件已被外部修改', message: `无法重新读取：\n${d.filePath}\n\n${err.message || err}`, buttons: ['确定'] });
    }
  }

  document.addEventListener('mr:open-file', (e) => e.detail && openPath(e.detail));
  document.addEventListener('mr:insert-text', (e) => insertAtCursor(e.detail));
  document.addEventListener('mr:file-changed-externally', (e) => syncExternalChange((e.detail || {}).rel));
  document.addEventListener('mr:file-deleted', (e) => {
    const d = active();
    const rel = (e.detail || {}).rel;
    if (d && d.filePath && rel && String(d.filePath).replace(/\\/g, '/').toLowerCase().endsWith(String(rel).toLowerCase())) {
      closeTab(d.id);
    }
  });

  // ---------- 面板开关与拖拽宽度 ----------

  function applyPanelSettings(s) {
    els.body.dataset.tree = s.fileTreeOpen === false ? 'off' : 'on';
    els.body.dataset.agent = s.agentPanelOpen ? 'on' : 'off';
    document.querySelectorAll('#panel-switch .tool-btn').forEach((b) => {
      const key = b.id === 'btn-toggle-agent' ? 'agentPanelOpen' : 'fileTreeOpen';
      b.classList.toggle('active', !!s[key]);
    });
    if (s.agentPanelOpen && window.MeReaderAgent) window.MeReaderAgent.setPanelOpen(true);
  }

  function togglePanel(key) {
    api.setSettings({ [key]: !settings[key] });
  }

  (function initVSplitters() {
    const setup = (handleId, targetId, dir, min, max) => {
      const handle = $(handleId);
      const target = $(targetId);
      if (!handle || !target) return;
      let dragging = false;
      handle.addEventListener('pointerdown', (e) => {
        dragging = true;
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const w = dir === 'left' ? e.clientX : window.innerWidth - e.clientX;
        target.style.flexBasis = `${Math.min(max, Math.max(min, w))}px`;
      });
      handle.addEventListener('pointerup', (e) => {
        dragging = false;
        handle.releasePointerCapture(e.pointerId);
      });
    };
    setup('vs-tree', 'sidebar', 'left', 150, 520);
    setup('vs-agent', 'agent-panel', 'right', 300, 760);
  })();

  // ---------- 视图与设置 ----------

  function setMode(mode, persist = true) {
    if (settings) settings.viewMode = mode;
    els.body.dataset.mode = mode;
    document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    if (mode !== 'edit') renderPreview();
    if (mode === 'edit') els.editor.focus();
    if (persist) api.setSettings({ viewMode: mode });
  }

  function applySettings(s) {
    settings = s;
    document.documentElement.style.setProperty('--content-font', s.fontFamily);
    document.documentElement.style.setProperty('--content-size', s.fontSize + 'px');
    document.documentElement.style.setProperty('--content-line-height', s.lineHeight);
    els.body.dataset.theme = s.theme;
    const dark = s.theme === 'dark';
    $('hljs-light').disabled = dark;
    $('hljs-dark').disabled = !dark;
    els.zoomLabel.textContent = Math.round(s.zoom * 100) + '%';
    setMode(s.viewMode, false);
    applyPanelSettings(s);
  }

  // ---------- 分屏滚动同步 ----------

  let syncingScroll = false;
  function syncScroll(from, to) {
    if (syncingScroll || els.body.dataset.mode !== 'split') return;
    syncingScroll = true;
    const max = from.scrollHeight - from.clientHeight;
    const ratio = max > 0 ? from.scrollTop / max : 0;
    to.scrollTop = ratio * Math.max(0, to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => { syncingScroll = false; });
  }

  // ---------- 分隔条拖拽 ----------

  (function initSplitter() {
    let dragging = false;
    els.splitter.addEventListener('pointerdown', (e) => {
      dragging = true;
      els.splitter.setPointerCapture(e.pointerId);
    });
    els.splitter.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const rect = $('content').getBoundingClientRect();
      const pct = Math.min(80, Math.max(20, ((e.clientX - rect.left) / rect.width) * 100));
      $('editor-pane').style.flexBasis = pct + '%';
    });
    els.splitter.addEventListener('pointerup', (e) => {
      dragging = false;
      els.splitter.releasePointerCapture(e.pointerId);
    });
  })();

  // ---------- 窗口关闭 ----------

  async function handleBeforeClose() {
    if (closing) return;
    closing = true;
    flushEditor();
    const dirty = dirtyDocs();
    if (!dirty.length) {
      api.clearAutosave();
      api.forceClose();
      return;
    }
    const action = dirty.length === 1
      ? await api.confirmClose(dirty[0].name)
      : await api.confirmCloseMulti(dirty.map((d) => d.name));
    if (action === 'cancel') {
      closing = false;
      return;
    }
    if (action === 'save' || action === 'saveAll') {
      for (const d of dirty) {
        if (!(await saveDoc(d))) {
          closing = false;
          return;
        }
      }
    }
    api.clearAutosave();
    api.forceClose();
  }

  // ---------- 拖放打开（新标签） ----------

  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    els.dropOverlay.classList.add('show');
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (--dragDepth <= 0) {
      dragDepth = 0;
      els.dropOverlay.classList.remove('show');
    }
  });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropOverlay.classList.remove('show');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const p = api.pathForFile(file);
    if (/\.(png|jpe?g|gif|bmp|webp|ico|avif|svg)$/i.test(p)) {
      // 图片：面板开着就作为上下文附件，否则导入当前项目并插入引用
      if (window.MeReaderAgent && window.MeReaderAgent.isOpen()) {
        window.MeReaderAgent.attachFiles([file]);
        window.MRUI.toast('图片已作为上下文附件加入输入区');
      } else if (window.MeReaderTree) {
        window.MeReaderTree.importIntoProject(file);
      }
      return;
    }
    if (/\.(md|markdown|txt|mdown|mkd)$/i.test(p)) await openPath(p);
  });

  // ---------- 事件绑定 ----------

  els.editor.addEventListener('input', () => {
    const d = active();
    if (!d) return;
    d.text = els.editor.value;
    updateTitle();
    updateStatus();
    renderTabs();
    scheduleRender();
    scheduleAutosave();
  });
  els.editor.addEventListener('click', () => { updateStatus(); notifyEditorChanged(); });
  els.editor.addEventListener('keyup', () => { updateStatus(); notifyEditorChanged(); });
  els.editor.addEventListener('scroll', () => syncScroll(els.editor, $('preview-pane')));
  $('preview-pane').addEventListener('scroll', () => syncScroll($('preview-pane'), els.editor));

  $('btn-open').addEventListener('click', openDialogAndOpen);
  $('btn-save').addEventListener('click', () => { const d = active(); if (d) saveDoc(d); });
  $('btn-new-tab').addEventListener('click', newTab);
  document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('btn-zoom-in').addEventListener('click', () => api.setSettings({ zoom: Math.min(3, Math.round((settings.zoom + 0.1) * 10) / 10) }));
  $('btn-zoom-out').addEventListener('click', () => api.setSettings({ zoom: Math.max(0.5, Math.round((settings.zoom - 0.1) * 10) / 10) }));
  $('btn-toggle-tree').addEventListener('click', () => togglePanel('fileTreeOpen'));
  $('btn-toggle-agent').addEventListener('click', () => togglePanel('agentPanelOpen'));

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      activateRelative(e.shiftKey ? -1 : 1);
    } else if (e.ctrlKey && (e.key === 's' || e.key === 'S') && !e.shiftKey) {
      e.preventDefault();
      const d = active();
      if (d) saveDoc(d);
    }
  });

  api.on('menu:action', async ({ action, payload }) => {
    const d = active();
    switch (action) {
      case 'new-tab': newTab(); break;
      case 'open': await openDialogAndOpen(); break;
      case 'save': if (d) await saveDoc(d); break;
      case 'saveAs': if (d) await saveAsDoc(d); break;
      case 'close-tab': if (d) await closeTab(d.id); break;
      case 'mode': setMode(payload); break;
      case 'reveal': if (d) await api.reveal(d.filePath); break;
      case 'add-project': window.MeReaderTree.addProject(); break;
      case 'toggle-panel': break; // 开关状态由 settings:changed 统一落地，避免两处改 DOM
      case 'agent-help': showAgentHelp(); break;
    }
  });
  api.on('file:open-path', openPath);
  api.on('settings:changed', applySettings);
  api.on('window:before-close', handleBeforeClose);
  api.on('project:added', () => window.MeReaderTree.refresh());

  async function showAgentHelp() {
    await window.MRUI.showAlert({
      title: 'Ollab 使用说明',
      message: [
        '1. 先在「设置 → 本地服务端」确认 Ollama 已启动（默认 http://127.0.0.1:11434），并选好对话模型；需要向量检索再选一个 embedding 模型。',
        '2. 左侧添加项目文件夹，agent 的所有读写都被限制在该目录内；隐藏的 .omemory / .oskill / .orag 分别是项目记忆、项目技能与向量索引。',
        '3. 右侧面板「需要确认 / 自动审批」控制写类工具是否逐项询问；删除类操作任何时候都会询问。',
        '4. 上下文接近水位会自动压缩：原始记录只追加，压缩只影响发给模型的视图，可随时手动压缩或从这里重来。',
        '5. 图片可直接粘贴或点 🖼 上传，视觉模型会收到像素，非视觉模型只收到文件名说明。'
      ].join('\n')
    });
  }

  // ---------- 启动 ----------

  (async function init() {
    const s = await api.getState();
    applySettings(s.settings);

    if (s.initialProject && window.MeReaderTree) {
      try {
        await window.MeReaderTree.addPathAsProject(s.initialProject);
      } catch (err) {
        window.MRUI.fail(err, '打开项目失败');
      }
    }

    if (s.recovery) await restoreSession(s.recovery);
    if (s.initialFile) await openPath(s.initialFile);
    if (!docs.length) newDoc({ text: '', saved: '' });
    if (!docs.find((d) => d.id === activeId)) activeId = docs[0].id;
    loadEditor();

    // 面板最后启动：它依赖 settings 落好的布局状态与当前项目
    if (window.MeReaderAgent) window.MeReaderAgent.boot(s.agent);
  })();
})();
