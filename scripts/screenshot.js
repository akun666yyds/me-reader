'use strict';

/**
 * README 截图脚本：npx electron scripts/screenshot.js
 *
 * 在系统临时目录造一个能展示全部图标类型的项目（md / txt / json / xml / html / css / js / 配置），
 * 连同仓库自带的 样例.md 一起启动真实界面，等渲染稳定后抓两张图：
 *   docs/screenshot-preview.png  预览模式 + 左侧文件树（已展开）+ 右侧 Ollab 面板
 *   docs/screenshot-split.png    分屏编辑
 * 说明：Electron 在 Windows 下不吃 APPDATA 环境变量，所以读到的是本机真实设置（只读，不发对话请求）；
 * 截完图会把这次临时项目从项目注册表里摘掉，不给用户留垃圾。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs');
const TMP_BASE = path.join(os.tmpdir(), `mr-shot-${Date.now()}`);
const TMP_PROJECT = path.join(TMP_BASE, '我的笔记');

// 必须在 require main.js 之前把命令行参数就位
fs.mkdirSync(TMP_PROJECT, { recursive: true });

const SAMPLE_DOCS = {
  '项目计划.md': '# 项目计划\n\n## 本周目标\n\n- [x] 打通本地模型对话\n- [ ] 补齐文件树图标\n- [ ] 上下文自动压缩验收\n\n## 待办清单\n\n| 事项 | 负责人 | 状态 |\n| --- | --- | --- |\n| 面板样式走查 | 我 | 进行中 |\n| 索引增量重建 | 我 | 待开始 |\n',
  '会议记录.txt': '2026-10-18 周会\n\n1. 产品改名 MeReader\n2. 助手叫 Ollab，只连本机 Ollama\n3. 所有数据留在本机\n',
  '数据/配置.json': '{\n  "theme": "eye",\n  "fontSize": 16,\n  "model": "qwen3.6:latest"\n}\n',
  '数据/书目.xml': '<?xml version="1.0" encoding="UTF-8"?>\n<books>\n  <book id="1">本机 Markdown 手册</book>\n</books>\n',
  '网页/index.html': '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8" />\n  <title>小工具</title>\n  <link rel="stylesheet" href="style.css" />\n</head>\n<body>\n  <h1>你好</h1>\n  <button id="go">点我</button>\n  <script src="app.js"></script>\n</body>\n</html>\n',
  '网页/style.css': 'body { font-family: system-ui; background: #f6f8fa; padding: 24px; }\nh1 { color: #0f6cbd; }\n',
  '网页/app.js': "document.getElementById('go').addEventListener('click', () => alert('你好'));\n",
  '.eslintrc.json': '{\n  "env": { "browser": true }\n}\n'
};

function buildProject() {
  fs.mkdirSync(TMP_PROJECT, { recursive: true });
  for (const [rel, content] of Object.entries(SAMPLE_DOCS)) {
    const abs = path.join(TMP_PROJECT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  const sample = path.join(ROOT, '样例.md');
  const target = path.join(TMP_PROJECT, '语法样例.md');
  if (fs.existsSync(sample)) fs.copyFileSync(sample, target);
  else fs.writeFileSync(target, '# 语法样例\n\n正文占位。\n', 'utf8');
  return target;
}

const sampleFile = buildProject();
process.argv.push(TMP_PROJECT, sampleFile);

require('../src/main/main.js');

const { app, BrowserWindow } = require('electron');
const { removeTree, unregisterProject } = require('./lib/tmp-clean');

const WAIT_BOOT = Number(process.env.MR_SHOT_WAIT || 5000);
const WAIT_SETTLE = Number(process.env.MR_SHOT_SETTLE || 1200);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function shot(win, file) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(file, image.toPNG());
  console.log(`已写入 ${path.relative(ROOT, file)}（${fs.statSync(file).size} 字节）`);
}

const runUi = (win, code) => win.webContents.executeJavaScript(code).catch((err) => ({ error: err.message }));

app.whenReady().then(async () => {
  await sleep(WAIT_BOOT);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.error('没有窗口，截图失败');
    finish(1);
    return;
  }
  win.focus();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 打开面板与文件树、切到预览，并把这次的项目展开到能看到全部图标
  const setup = await runUi(win, `(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const body = document.body;
    if (body.dataset.agent !== 'on' && window.MeReaderAgent) window.MeReaderAgent.setPanelOpen(true);
    if (body.dataset.tree !== 'on' && document.querySelector('#btn-toggle-tree')) document.querySelector('#btn-toggle-tree').click();
    const previewBtn = document.querySelector('.mode-btn[data-mode="preview"]');
    if (previewBtn) previewBtn.click();
    await wait(400);
    const listed = await window.mreader.ws.ws_list();
    const mine = (listed.data.projects || []).find((p) => p.root === ${JSON.stringify(TMP_PROJECT)});
    // 用 DOM 的 title 属性精确比对（CSS 属性选择器会把路径里的反斜杠当转义，别用）
    const clickRoot = () => {
      const row = [...document.querySelectorAll('.tree-node.tree-root')].find((x) => x.title === ${JSON.stringify(TMP_PROJECT)});
      if (row) row.click();
      return !!row;
    };
    const clickFolder = (name) => {
      const row = [...document.querySelectorAll('.tree-node')].find((x) => (x.querySelector('.tree-label') || {}).textContent?.trim() === name);
      if (row) row.click();
      return !!row;
    };
    const clicked = [];
    clicked.push(['项目根', clickRoot()]);
    await wait(700);
    for (const label of ['数据', '网页']) {
      clicked.push([label, clickFolder(label)]);
      await wait(700);
    }
    return { projectId: mine ? mine.id : null, mode: body.dataset.mode, tree: body.dataset.tree, agent: body.dataset.agent, clicked, nodes: document.querySelectorAll('.tree-node').length };
  })()`);
  await sleep(WAIT_SETTLE);
  await shot(win, path.join(OUT_DIR, 'screenshot-preview.png'));

  await runUi(win, `document.querySelector('.mode-btn[data-mode="split"]').click(); true`);
  await sleep(WAIT_SETTLE);
  await shot(win, path.join(OUT_DIR, 'screenshot-split.png'));

  console.log('SHOT_PROBE ' + JSON.stringify({ ...setup, title: await runUi(win, 'document.title') }));
  finish(0);
});

function finish(code) {
  // 先把这次的项目从注册表里摘掉，再删临时目录（app.exit 不会再触发应用自身的落盘）
  const un = unregisterProject(TMP_PROJECT);
  if (un.removed) console.log(`已从项目注册表摘除截图项目（${un.removed} 条）`);
  else if (un.error) console.warn('清理项目注册表失败（不影响截图）：', un.error);
  if (!removeTree(TMP_BASE)) console.warn(`截图临时目录未清理干净，可手工删除：${TMP_BASE}`);
  app.exit(code);
}
