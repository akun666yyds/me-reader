/* =====================================================================
   filetree.js —— 左侧项目文件树
   每个根目录就是一个项目文件夹，可展开/收缩，子目录懒加载（IDE 那种）。
   .omemory / .oskill / .orag 默认不显示，但 agent 仍然能读写它们。
   ===================================================================== */
(() => {
  const { $, call, el, fail, askText } = window.MRUI;
  const api = window.mreader;

  const KIND_ICON = {
    dir: { emoji: '📂' },
    md: { emoji: '📝' },
    txt: { emoji: '📃' },
    html: { emoji: '🌐' },
    json: { badge: '{}', cls: 'json' },
    xml: { badge: '</>', cls: 'xml' },
    js: { badge: 'JS', cls: 'js' },
    image: { badge: '🖼', cls: 'image' },
    config: { emoji: '⚙️' },
    other: { emoji: '📄' }
  };

  const state = {
    projects: [],
    activeId: null,
    expanded: new Set(),      // `${projectId}|${rel}`
    children: new Map(),      // key -> entries
    loading: new Set(),
    selected: ''
  };

  const key = (projectId, rel) => `${projectId}|${rel}`;

  function iconFor(entry) {
    const conf = KIND_ICON[entry.kind] || KIND_ICON.other;
    // 以 . 开头的后缀配置文件统一用齿轮，其它未识别文件用通用文档图标
    if (!conf.badge && entry.kind === 'other' && /^[^.].*\.[a-z0-9_+-]+$/i.test(entry.name)) return el('span', { class: 'tree-icon', text: '⚙️' });
    if (conf.badge) return el('span', { class: 'tree-icon' }, [el('span', { class: `badge ${conf.cls}`, text: conf.badge })]);
    return el('span', { class: 'tree-icon', text: conf.emoji });
  }

  function openFile(abs) {
    document.dispatchEvent(new CustomEvent('mr:open-file', { detail: abs }));
  }

  // ---------------- 数据 ----------------

  async function loadChildren(projectId, rel) {
    const entries = await call('ws', 'ws_tree', { projectId, rel });
    state.children.set(key(projectId, rel), entries.entries || []);
    return entries;
  }

  async function ensureChildren(projectId, rel) {
    const k = key(projectId, rel);
    if (state.children.has(k)) return;
    if (state.loading.has(k)) return;
    state.loading.add(k);
    paintStatus(`正在读取 ${rel || '/'} …`);
    try {
      await loadChildren(projectId, rel);
    } catch (err) {
      fail(err, '读取目录失败');
    } finally {
      state.loading.delete(k);
      paintStatus('');
      render();
    }
  }

  /** 目录被 agent 或编辑器改动后，只重取已展开的那条路径 */
  async function refreshPath(projectId, rel) {
    const k = key(projectId, rel);
    try {
      if (state.children.has(k)) await loadChildren(projectId, rel);
      render();
    } catch (err) {
      fail(err, '刷新文件树失败');
    }
  }

  async function refreshAll({ keepExpanded = true } = {}) {
    try {
      const r = await call('ws', 'ws_list');
      state.projects = r.projects || [];
      state.activeId = r.activeId || (state.projects[0] || {}).id || null;
      if (!keepExpanded) state.expanded.clear();
      state.children.clear();
      for (const k of [...state.expanded]) {
        const [projectId, rel] = k.split('|');
        try {
          await loadChildren(projectId, rel);
        } catch {
          state.expanded.delete(k);
        }
      }
      render();
    } catch (err) {
      fail(err, '项目列表读取失败');
    }
  }

  function paintStatus(text) {
    const box = $('tree-status');
    if (box) box.textContent = text || '';
  }

  // ---------------- 渲染 ----------------

  function render() {
    const body = $('tree-body');
    if (!body) return;
    document.body.dataset.hasProject = state.projects.length ? 'yes' : 'no';
    body.innerHTML = '';
    for (const p of state.projects) body.appendChild(renderRoot(p));
    document.dispatchEvent(new CustomEvent('mr:tree-ready', { detail: { projects: state.projects, activeId: state.activeId } }));
  }

  function renderRoot(p) {
    const wrap = el('div', { class: 'tree-root-wrap' });
    const k = key(p.id, '');
    const isOpen = state.expanded.has(k);
    // 目录被移走/删掉的项目：标灰并给出可执行提示，不要再去读盘（否则只会抛一句「目录不存在：/」）
    const missing = p.exists === false;
    const row = el('div', {
      class: `tree-node tree-root${missing ? ' missing' : ''}`,
      title: missing ? `${p.root}（目录已不存在，右键「移除项目」清理）` : p.root,
      style: '--depth:0'
    }, [
      el('span', { class: `tree-caret${isOpen ? ' open' : ''}`, text: '▸' }),
      el('span', { class: 'tree-icon', text: missing ? '⚠️' : '📂' }),
      el('span', { class: 'tree-label', text: p.name + (missing ? ' ·目录不存在' : p.id === state.activeId ? ' ·当前' : '') })
    ]);
    row.addEventListener('click', async () => {
      setActiveProject(p.id);
      if (missing) {
        window.MRUI.toast(`项目目录已不存在：${p.root}，右键「移除项目」可清理`, 6000);
        return;
      }
      if (isOpen) state.expanded.delete(k);
      else {
        state.expanded.add(k);
        await ensureChildren(p.id, '');
      }
    });
    row.addEventListener('contextmenu', (e) => showProjectMenu(e, p));
    wrap.appendChild(row);

    const kids = el('div', { class: `tree-children${isOpen ? ' open' : ''}` });
    if (isOpen) fillChildren(kids, p.id, '', 1);
    wrap.appendChild(kids);
    return wrap;
  }

  function fillChildren(container, projectId, rel, depth) {
    const entries = state.children.get(key(projectId, rel)) || [];
    if (state.loading.has(key(projectId, rel))) {
      container.appendChild(el('div', { class: 'tree-loading', style: `--depth:${depth}`, text: '读取中…' }));
      return;
    }
    if (!entries.length) {
      container.appendChild(el('div', { class: 'tree-loading', style: `--depth:${depth}`, text: '（空目录）' }));
      return;
    }
    for (const entry of entries) container.appendChild(renderEntry(projectId, entry, depth));
  }

  function renderEntry(projectId, entry, depth) {
    const wrap = el('div', { class: 'tree-item-wrap' });
    const k = key(projectId, entry.rel);
    const isOpen = state.expanded.has(k);
    const row = el('div', {
      class: `tree-node${state.selected === k ? ' active' : ''}`,
      style: `--depth:${depth}`,
      title: `${entry.rel}${entry.size != null ? ` · ${fmtSize(entry.size)}` : ''}`
    }, [
      entry.dir ? el('span', { class: `tree-caret${isOpen ? ' open' : ''}`, text: '▸' }) : el('span', { class: 'tree-caret', text: '' }),
      iconFor(entry),
      el('span', { class: 'tree-label', text: entry.name })
    ]);

    row.addEventListener('click', async () => {
      if (!entry.dir) {
        state.selected = k;
        try {
          const r = await call('ws', 'ws_abs', { projectId, target: entry.rel });
          openFile(r.abs);
        } catch (err) {
          fail(err, '打开失败');
        }
        render();
        return;
      }
      if (isOpen) state.expanded.delete(k);
      else {
        state.expanded.add(k);
        await ensureChildren(projectId, entry.rel);
      }
      render();
    });
    row.addEventListener('contextmenu', (e) => showNodeMenu(e, projectId, entry));
    row.addEventListener('dragover', (e) => { if (entry.dir) { e.preventDefault(); row.classList.add('drop-target'); } });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', async (e) => {
      if (!entry.dir) return;
      e.preventDefault();
      row.classList.remove('drop-target');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      await importTo(projectId, file, entry.rel);
    });

    wrap.appendChild(row);
    const kids = el('div', { class: `tree-children${isOpen ? ' open' : ''}` });
    if (isOpen) fillChildren(kids, projectId, entry.rel, depth + 1);
    wrap.appendChild(kids);
    return wrap;
  }

  function fmtSize(n) {
    if (n > 1048576) return `${(n / 1048576).toFixed(1)}MB`;
    if (n > 1024) return `${(n / 1024).toFixed(0)}KB`;
    return `${n}B`;
  }

  async function setActiveProject(id) {
    if (!id || id === state.activeId) return;
    try {
      await call('ws', 'ws_activate', id);
      state.activeId = id;
      state.children.clear();
      for (const k of [...state.expanded]) {
        const [projectId] = k.split('|');
        if (projectId !== id) state.expanded.delete(k);
      }
      await refreshAll();
      document.dispatchEvent(new CustomEvent('mr:project-changed', { detail: { projectId: id } }));
    } catch (err) {
      fail(err, '切换项目失败');
    }
  }

  async function importTo(projectId, file, intoRel) {
    const sourceAbs = api.pathForFile(file);
    if (!/\.(png|jpe?g|gif|bmp|webp|ico|svg|avif)$/i.test(sourceAbs)) return false;
    try {
      const subdir = [intoRel, 'assets'].filter(Boolean).join('/');
      const r = await call('ws', 'ws_import_asset', { projectId, sourceAbs, subdir });
      await refreshPath(projectId, intoRel);
      const rel = (r.rel || `${subdir}/${r.name}` || '').replace(/\\/g, '/');
      document.dispatchEvent(new CustomEvent('mr:insert-text', { detail: `![图片](${encodeURI(rel)})` }));
      window.MRUI.toast(`图片已放入 ${rel}，引用已插入光标处`);
      return true;
    } catch (err) {
      fail(err, '导入图片失败');
      return false;
    }
  }

  // ---------------- 右键菜单 ----------------

  const menuEl = () => $('tree-context-menu');

  function showMenu(e, items) {
    e.preventDefault();
    e.stopPropagation();
    const m = menuEl();
    m.innerHTML = '';
    for (const [label, fn] of items) {
      m.appendChild(el('div', { class: 'context-item', text: label, onclick: () => { hideMenu(); fn(); } }));
    }
    m.style.left = `${e.clientX}px`;
    m.style.top = `${e.clientY}px`;
    m.classList.add('show');
  }

  function hideMenu() {
    menuEl().classList.remove('show');
  }
  document.addEventListener('click', hideMenu);
  window.addEventListener('blur', hideMenu);

  function showProjectMenu(e, p) {
    const items = [
      ['设为当前项目', () => setActiveProject(p.id)],
      ['在文件夹中打开', async () => openFileFolder(p.root)],
      ['重命名项目', async () => {
        const name = await askText({ title: '重命名项目', value: p.name });
        if (!name) return;
        try { await call('ws', 'ws_rename', p.id, name); await refreshAll(); } catch (err) { fail(err, '重命名失败'); }
      }],
      ['从列表移除（不删文件）', async () => {
        const c = await api.confirm({ title: '移除项目', message: `仅从项目列表移除「${p.name}」，磁盘文件不会删除。` });
        if (c !== 0) return;
        try { await call('ws', 'ws_remove', p.id); await refreshAll(); } catch (err) { fail(err, '移除失败'); }
      }]
    ];
    showMenu(e, items);
  }

  async function openFileFolder(abs) {
    try { await api.reveal(abs); } catch (err) { fail(err, '无法打开文件夹'); }
  }

  function showNodeMenu(e, projectId, entry) {
    const rel = entry.rel;
    const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const items = [];
    if (!entry.dir) items.push(['打开', () => openFileTarget(projectId, rel)]);
    items.push(['新建文件', () => createNode(projectId, rel, 'file', entry.dir ? rel : parentRel)]);
    items.push(['新建文件夹', () => createNode(projectId, rel, 'dir', entry.dir ? rel : parentRel)]);
    items.push(['重命名', () => renameNode(projectId, entry)]);
    if (!entry.dir) items.push(['复制相对路径', () => navigator.clipboard.writeText(rel)]);
    if (!entry.dir) items.push(['打开所在文件夹', () => openFileTarget(projectId, rel, true)]);
    items.push(['删除', () => deleteNode(projectId, entry)]);
    showMenu(e, items);
  }

  async function openFileTarget(projectId, rel, revealOnly = false) {
    try {
      const r = await call('ws', 'ws_abs', { projectId, target: rel });
      if (revealOnly) await api.reveal(r.abs);
      else openFile(r.abs);
    } catch (err) {
      fail(err, '操作失败');
    }
  }

  async function createNode(projectId, rel, what, baseRel) {
    const name = await askText({ title: what === 'file' ? '新建文件（含扩展名）' : '新建文件夹', value: what === 'file' ? '新建文档.md' : '' });
    if (!name || /[/\\]/.test(name)) return;
    const target = [baseRel, name].filter(Boolean).join('/');
    try {
      if (what === 'file') {
        const heading = name.replace(/\.[^.]+$/, '');
        const seed = /\.(md|markdown|mdown|mkd)$/i.test(name) ? `# ${heading}\n` : '';
        await call('ws', 'ws_create_file', { projectId, target, content: seed });
        await refreshPath(projectId, baseRel);
        openFileTarget(projectId, target);
      } else {
        await call('ws', 'ws_mkdir', { projectId, target });
        await refreshPath(projectId, baseRel);
      }
    } catch (err) {
      fail(err, '新建失败');
    }
  }

  async function renameNode(projectId, entry) {
    const name = await askText({ title: '重命名', value: entry.name });
    if (!name || name === entry.name) return;
    const parent = entry.rel.includes('/') ? entry.rel.slice(0, entry.rel.lastIndexOf('/')) : '';
    const to = [parent, name].filter(Boolean).join('/');
    try {
      await call('ws', 'ws_move', { projectId, from: entry.rel, to });
      await refreshPath(projectId, parent);
      document.dispatchEvent(new CustomEvent('mr:file-renamed', { detail: { from: entry.rel, to } }));
    } catch (err) {
      fail(err, '重命名失败');
    }
  }

  async function deleteNode(projectId, entry) {
    // 删除不可恢复：先把目标与体量摆出来，让用户能核对
    const sizeText = entry.size != null ? `（${fmtSize(entry.size)}）` : '';
    const c = await api.confirm({
      title: '删除确认',
      message: `即将永久删除项目内的${entry.dir ? '文件夹' : '文件'}：\n${entry.rel}${sizeText}\n\n该操作不可恢复。`,
      buttons: ['删除', '取消']
    });
    if (c !== 0) return;
    try {
      await call('ws', 'ws_remove_file', { projectId, target: entry.rel });
      const parent = entry.rel.includes('/') ? entry.rel.slice(0, entry.rel.lastIndexOf('/')) : '';
      await refreshPath(projectId, parent);
      document.dispatchEvent(new CustomEvent('mr:file-deleted', { detail: { rel: entry.rel, projectId } }));
    } catch (err) {
      fail(err, '删除失败');
    }
  }

  // ---------------- 对外接口 ----------------

  async function addProject() {
    try {
      const r = await call('ws', 'ws_pick');
      if (!r) return;
      state.projects = r.projects;
      state.activeId = r.activeId;
      await refreshAll();
      document.dispatchEvent(new CustomEvent('mr:project-added', { detail: r.project }));
    } catch (err) {
      if (!/cancel/i.test(err.message)) fail(err, '添加项目失败');
    }
  }

  function init() {
    $('tree-add').addEventListener('click', addProject);
    $('tree-refresh').addEventListener('click', () => refreshAll());
    document.addEventListener('mr:agent-files-changed', (e) => {
      const { projectId, rel } = e.detail || {};
      if (!projectId) return;
      const dir = rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      refreshPath(projectId, dir);
    });
    refreshAll();
  }

  window.MeReaderTree = {
    init,
    refresh: refreshAll,
    refreshPath,
    addProject,
    importIntoProject(file) {
      if (!state.activeId) {
        window.MRUI.toast('请先添加项目文件夹');
        return;
      }
      importTo(state.activeId, file, '');
    },
    async addPathAsProject(abs) {
      const r = await call('ws', 'ws_add', abs);
      state.projects = r.projects;
      state.activeId = r.activeId;
      await refreshAll();
      document.dispatchEvent(new CustomEvent('mr:project-added', { detail: r.project }));
      return r.project;
    },
    state,
    activeProjectId: () => state.activeId,
    projects: () => state.projects,
    status: paintStatus,
    highlightFile(abs) {
      state.selectedAbs = abs;
      render();
    }
  };

  document.addEventListener('DOMContentLoaded', init);
})();
