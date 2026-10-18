'use strict';

/**
 * 测试脚本共用的临时目录工具：Windows 上刚写完文件的目录常被杀软/索引器短暂占用，
 * 直接 rmSync 会 EBUSY/EPERM，所以带几次重试；实在删不掉就打印路径让人手工清理。
 */

const fs = require('fs');

function removeTree(dir, { tries = 5, delay = 250 } = {}) {
  for (let i = 1; i <= tries; i++) {
    try {
      if (!fs.existsSync(dir)) return true;
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      return !fs.existsSync(dir);
    } catch (err) {
      if (i === tries) {
        console.warn(`[cleanup] 删不掉临时目录（${err.code || err.message}）：${dir}`);
        return false;
      }
      const until = Date.now() + delay;
      while (Date.now() < until) { /* 同步等待，脚本马上要退出，不用事件循环 */ }
    }
  }
  return false;
}

/** 从 %APPDATA%\MeReader\agent\projects.json 里摘掉指向 dir 的项目注册（测试跑完不留垃圾） */
function unregisterProject(dir, { appData = process.env.APPDATA } = {}) {
  if (!appData) return { removed: 0, error: '没有 APPDATA' };
  const file = require('path').join(appData, 'MeReader', 'agent', 'projects.json');
  try {
    if (!fs.existsSync(file)) return { removed: 0, error: null };
    const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = reg.items || [];
    // 路径大小写与分隔符都可能被不同来源改写，规范化后再比
    const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
    const keep = items.filter((x) => norm(x.root) !== norm(dir) && !norm(x.root).startsWith(`${norm(dir)}\\`));
    reg.items = keep;
    if (!keep.some((x) => x.id === reg.activeId)) reg.activeId = keep.length ? keep[0].id : null;
    fs.writeFileSync(file, JSON.stringify(reg, null, 2), 'utf8');
    return { removed: items.length - keep.length, error: null };
  } catch (err) {
    return { removed: 0, error: err.message };
  }
}

module.exports = { removeTree, unregisterProject };
