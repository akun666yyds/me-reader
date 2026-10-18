'use strict';

/**
 * 冒烟测试入口：npm run smoke
 * 真实启动主进程 + 渲染层，收集 console 报错、渲染进程崩溃、DOM 结构探针，
 * 打印 JSON 结论后退出。不改动产品代码，只作为本地验收用。
 *
 * 会在系统临时目录造一份小项目（覆盖各类文件图标），跑完自动从项目注册表摘除并删除目录，
 * 不给 %APPDATA%\MeReader 留垃圾。MR_SMOKE_WAIT=<ms> 可调等待时长。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const { removeTree, unregisterProject } = require('./lib/tmp-clean');

const TMP_PROJECT = path.join(os.tmpdir(), `mr-smoke-project-${Date.now()}`);
const FIXTURE = {
  '说明.md': '# 冒烟项目\n\n这是给 Ollab 的测试文档，里面有一个待办清单。\n\n- [ ] 检查文件树\n- [ ] 检查索引\n',
  'notes.txt': 'plain text note\n',
  'data.json': '{"items":[1,2,3],"note":"fixture"}\n',
  'conf.xml': '<conf><a>1</a></conf>\n',
  'index.html': '<!DOCTYPE html>\n<html><body><p>fixture</p></body></html>\n',
  'app.js': 'console.log(1);\n',
  '笔记/子文档.md': '# 子文档\n\n用于测试懒加载展开。\n'
};

fs.mkdirSync(path.join(TMP_PROJECT, '笔记'), { recursive: true });
for (const [rel, content] of Object.entries(FIXTURE)) fs.writeFileSync(path.join(TMP_PROJECT, rel), content, 'utf8');
process.argv.push(TMP_PROJECT);

require('../src/main/main.js');

const { app, BrowserWindow } = require('electron');

const problems = [];
const logs = [];

app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (_ev, level, message, line, sourceId) => {
    logs.push(`${level >= 2 ? 'ERR' : 'log'} ${String(sourceId || '').split('/').pop()}:${line} ${message}`);
    if (level >= 2) problems.push(`console: ${message}`);
  });
  contents.on('render-process-gone', (_ev, details) => {
    problems.push(`render-process-gone: ${JSON.stringify(details)}`);
  });
  contents.on('preload-error', (_ev, file, error) => {
    problems.push(`preload-error: ${file} ${error.message}`);
  });
});

const WAIT_MS = Number(process.env.MR_SMOKE_WAIT || 4500);

app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    let probe = null;
    if (win) {
      try {
        probe = await win.webContents.executeJavaScript(`(function(){
          const q = (s) => document.querySelector(s);
          return {
            title: document.title,
            layout: { tree: document.body.dataset.tree, agent: document.body.dataset.agent, mode: document.body.dataset.mode },
            globals: {
              MRUI: typeof window.MRUI,
              tree: typeof window.MeReaderTree,
              agent: typeof window.MeReaderAgent,
              bridge: typeof window.mreader,
              agentChannels: window.mreader ? Object.keys(window.mreader.agent || {}).length : 0,
              wsChannels: window.mreader ? Object.keys(window.mreader.ws || {}).length : 0
            },
            counts: {
              tabButtons: document.querySelectorAll('.ag-tab').length,
              treeNodes: document.querySelectorAll('.tree-node').length,
              messages: document.querySelectorAll('#ag-messages .msg').length,
              sessionOptions: document.querySelectorAll('#ag-session option').length,
              settingGroups: document.querySelectorAll('#set-body .set-group').length
            },
            agentStatus: (q('#status-agent') || {}).textContent,
            modelLabel: (q('#ag-model') || {}).textContent
          };
        })();`);
      } catch (err) {
        problems.push(`probe failed: ${err.message}`);
      }
    } else {
      problems.push('no window created');
    }

    console.log('SMOKE_RESULT ' + JSON.stringify({ ok: !problems.length, problems, probe, logs: logs.slice(-40) }, null, 2));
    finish(problems.length ? 1 : 0);
  }, WAIT_MS);
});

function finish(code) {
  // 先把冒烟项目从注册表里摘掉，再删临时目录（app.exit 不会再触发应用自身的落盘）
  const un = unregisterProject(TMP_PROJECT);
  if (un.removed) console.log(`已从项目注册表摘除冒烟项目（${un.removed} 条）`);
  else if (un.error) console.warn('清理项目注册表失败（不影响结论）：', un.error);
  if (!removeTree(TMP_PROJECT)) console.warn(`冒烟临时目录未清理干净，可手工删除：${TMP_PROJECT}`);
  app.exit(code);
}
