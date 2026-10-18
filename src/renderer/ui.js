/* =====================================================================
   ui.js —— 渲染层公共小工具：IPC 信封解包、输入弹窗、轻提示、DOM 构造
   CSP 是 script-src 'self'，所以这里一律用 addEventListener，不写内联 on*。
   ===================================================================== */
(() => {
  const api = window.mreader;
  const $ = (id) => document.getElementById(id);

  /** 主进程 handler 统一返回 {ok,data,error}；这里把失败还原成异常 */
  function unwrap(env) {
    if (env && env.ok) return env.data;
    throw new Error((env && env.error) || '请求失败');
  }

  async function call(group, method, ...args) {
    const fn = api[group] && api[group][method];
    if (!fn) throw new Error(`未注册的通道：${group}.${method}`);
    return unwrap(await fn(...args));
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 单例输入弹窗 ----------

  const modal = { root: null, title: null, body: null, ok: null, cancel: null, resolver: null, input: null };

  function closeModal(result) {
    if (!modal.root.classList.contains('show')) return;
    modal.root.classList.remove('show');
    const r = modal.resolver;
    modal.resolver = null;
    modal.input = null;
    if (r) r(result);
  }

  /**
   * 取一段文本输入（Electron 里 window.prompt 不可用，必须自带弹窗）。
   * @returns {Promise<string|null>} 取消返回 null
   */
  function askText({ title = '输入', value = '', placeholder = '', multiline = false, okLabel = '确定' } = {}) {
    return new Promise((resolve) => {
      modal.root.innerHTML = '';
      modal.title.textContent = title;
      const field = multiline
        ? el('textarea', { rows: 6, placeholder })
        : el('input', { type: 'text', placeholder });
      field.value = value;
      modal.input = field;
      modal.body.appendChild(field);
      modal.ok.textContent = okLabel;
      modal.root.appendChild(modal.title);
      modal.root.appendChild(modal.body);
      modal.root.appendChild(modal.actions);
      modal.root.classList.add('show');
      setTimeout(() => { field.focus(); field.select && field.select(); }, 30);
      modal.resolver = resolve;
      modal.onOk = () => {
        const v = field.value;
        closeModal(v);
      };
      field.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !multiline) { e.preventDefault(); modal.onOk(); }
        else if (e.key === 'Escape') closeModal(null);
      });
    });
  }

  /** 只读提示框（等价于消息框） */
  function showAlert({ title = '提示', message = '', okLabel = '知道了' } = {}) {
    return new Promise((resolve) => {
      modal.root.innerHTML = '';
      modal.title.textContent = title;
      modal.body.textContent = message;
      modal.ok.textContent = okLabel;
      modal.root.appendChild(modal.title);
      modal.root.appendChild(modal.body);
      modal.root.appendChild(modal.actions);
      modal.root.classList.add('show');
      modal.onOk = () => closeModal(true);
      modal.resolver = resolve;
    });
  }

  function initModal() {
    modal.root = $('ui-modal');
    modal.title = $('modal-title');
    modal.body = $('modal-body');
    modal.ok = $('modal-ok');
    modal.cancel = $('modal-cancel');
    modal.actions = el('div', { class: 'ui-modal-actions' }, [modal.cancel, modal.ok]);
    modal.ok.addEventListener('click', () => modal.onOk && modal.onOk());
    modal.cancel.addEventListener('click', () => closeModal(null));
    modal.root.addEventListener('click', (e) => { if (e.target === modal.root) closeModal(null); });
  }

  // ---------- 轻提示 ----------

  let toastTimer = null;
  function toast(message, ms = 2600) {
    const t = $('toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  /** 统一错误出口：不打断操作流，只告诉用户哪儿失败了 */
  function fail(err, prefix = '') {
    const msg = (err && err.message) || String(err);
    console.error('[MeReader]', prefix, err);
    toast(prefix ? `${prefix}：${msg}` : msg, 3600);
  }

  document.addEventListener('DOMContentLoaded', initModal);

  window.MRUI = { api, $, unwrap, call, el, esc, askText, showAlert, toast, fail, modal };
})();
