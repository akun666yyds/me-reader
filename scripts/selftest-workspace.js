'use strict';

/**
 * 自检：项目工作区与文件树
 * 运行：node scripts/selftest-workspace.js
 * 覆盖：沙箱越界拦截、符号链接逃逸、图标类型判定、懒加载目录树、glob 过滤检索、写盘换行保持
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const { Workspace, fileKind, isWithin } = require('../src/main/agent/workspace');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mereader-ws-'));
const proj = path.join(root, 'demo');
fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
fs.mkdirSync(path.join(proj, 'node_modules'), { recursive: true });
fs.mkdirSync(path.join(proj, '.omemory'), { recursive: true });
fs.writeFileSync(path.join(proj, 'README.md'), '# 标题\n第二行 关键词 alpha\n');
fs.writeFileSync(path.join(proj, 'notes.txt'), 'plain text\n');
fs.writeFileSync(path.join(proj, 'index.html'), '<html><body>alpha here</body></html>\n');
fs.writeFileSync(path.join(proj, 'data.json'), '{"a":1}\n');
fs.writeFileSync(path.join(proj, 'book.xml'), '<root/>\n');
fs.writeFileSync(path.join(proj, 'app.js'), '// alpha\nconsole.log(1);\n');
fs.writeFileSync(path.join(proj, '.gitignore'), 'node_modules\n');
fs.writeFileSync(path.join(proj, 'docs', 'a.md'), '# A\nalpha alpha\n'.replace(/\n/g, '\r\n'));
fs.writeFileSync(path.join(proj, 'node_modules', 'x.md'), '# 不该出现\n');
fs.writeFileSync(proj + '.txt', '项目外的兄弟文件');

let failures = 0;
function check(name, fn) {
  try {
    const r = fn();
    if (r === 'skip') console.log(`  – ${name}（跳过：环境不支持）`);
    else console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

const ws = new Workspace({ registryFile: path.join(root, 'registry.json') });

console.log('\n[项目登记]');
check('添加项目并激活', () => {
  const p = ws.add(proj);
  assert.strictEqual(ws.activeId(), p.id);
  assert.strictEqual(ws.activeRoot(), fs.realpathSync(proj));
  assert.strictEqual(ws.list().length, 1);
});
check('同目录重复添加不产生第二条记录', () => {
  const a = ws.add(proj);
  const b = ws.add(proj);
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(ws.list().length, 1);
});
check('登记表已持久化到磁盘', () => {
  const again = new Workspace({ registryFile: path.join(root, 'registry.json') });
  assert.strictEqual(again.list().length, 1);
});
check('移除项目不删除磁盘文件', () => {
  const id = ws.list()[0].id;
  ws.remove(id);
  assert.ok(fs.existsSync(proj));
  ws.add(proj);
});

const pid = ws.list()[0].id;

console.log('\n[沙箱边界]');
check('相对路径解析为项目内路径', () => {
  const r = ws.resolve(pid, 'docs/a.md');
  assert.strictEqual(r.rel, 'docs/a.md');
});
check('拒绝 .. 越界', () => {
  assert.throws(() => ws.resolve(pid, '../demo.txt'), /越界/);
  assert.throws(() => ws.resolve(pid, 'docs/../../demo.txt'), /越界/);
});
check('拒绝项目外绝对路径', () => {
  assert.throws(() => ws.resolve(pid, proj + '.txt'), /越界/);
  assert.throws(() => ws.resolve(pid, os.tmpdir()), /越界/);
});
check('空串与点号表示项目根', () => {
  assert.strictEqual(ws.resolve(pid, '').rel, '');
  assert.strictEqual(ws.resolve(pid, '.').rel, '');
});
check('符号链接指向项目外时被拦截', () => {
  const link = path.join(proj, 'escape');
  try {
    fs.symlinkSync(path.dirname(root), link, 'dir');
  } catch {
    return 'skip';
  }
  assert.throws(() => ws.resolve(pid, 'escape/hosts'), /越界/);
  fs.rmSync(link, { recursive: true, force: true });
});
check('写文件同样受限', () => {
  assert.throws(() => ws.write(pid, '../evil.md', 'x'), /越界/);
});

console.log('\n[文件树]');
check('根目录：目录优先、忽略 node_modules 与 .omemory', () => {
  const t = ws.tree(pid, '');
  const names = t.entries.map((e) => e.name);
  assert.ok(!names.includes('node_modules'), 'node_modules 应被忽略');
  assert.ok(!names.includes('.omemory'), '.omemory 应在树中隐藏');
  assert.ok(names.includes('docs'));
  assert.strictEqual(t.entries[0].name, 'docs', '目录应排在最前');
  assert.strictEqual(t.entries.find((e) => e.name === 'docs').kind, 'dir');
});
check('深层目录可展开', () => {
  const t = ws.tree(pid, 'docs');
  assert.deepStrictEqual(t.entries.map((e) => e.name), ['a.md']);
});
check('agent 目录可显式包含', () => {
  const t = ws.tree(pid, '', { includeHiddenAgentDirs: true });
  assert.ok(t.entries.some((e) => e.name === '.omemory'));
});

console.log('\n[图标类型判定]');
const kindCases = [
  ['README.md', 'md'],
  ['a.markdown', 'md'],
  ['notes.txt', 'txt'],
  ['index.html', 'html'],
  ['data.json', 'json'],
  ['config.jsonc', 'json'],
  ['book.xml', 'xml'],
  ['icon.svg', 'xml'],
  ['main.js', 'js'],
  ['App.tsx', 'js'],
  ['theme.css', 'config'],
  ['app.py', 'config'],
  ['config.yaml', 'config'],
  ['.gitignore', 'config'],
  ['.env', 'config'],
  ['photo.png', 'image'],
  ['LICENSE', 'other'],
  ['未知文件', 'other'],
  ['docs', 'dir']
];
for (const [name, expect] of kindCases) {
  check(`${name} -> ${expect}`, () => assert.strictEqual(fileKind(name, name === 'docs'), expect));
}
check('目录一律为 dir', () => {
  assert.strictEqual(fileKind('README.md', true), 'dir');
  assert.strictEqual(fileKind('docs', true), 'dir');
});

console.log('\n[读写]');
check('读取并归一化换行', () => {
  const r = ws.read(pid, 'docs/a.md');
  assert.ok(!r.content.includes('\r'), '读取后应为 LF');
  assert.ok(r.content.includes('# A'));
});
check('写入保持既有 CRLF 风格', () => {
  const before = fs.readFileSync(path.join(proj, 'docs', 'a.md'), 'utf8');
  assert.ok(/\r\n/.test(before), '测试文件本身应为 CRLF');
  ws.write(pid, 'docs/a.md', '# A\nalpha alpha\n');
  const after = fs.readFileSync(path.join(proj, 'docs', 'a.md'), 'utf8');
  assert.ok(/\r\n/.test(after), '写回应保持 CRLF');
});
check('新建嵌套目录文件自动建父目录', () => {
  ws.write(pid, 'docs/sub/deep.md', '# 深\n');
  assert.ok(fs.existsSync(path.join(proj, 'docs', 'sub', 'deep.md')));
});
check('移动与删除', () => {
  ws.move(pid, 'docs/sub/deep.md', 'docs/deep2.md');
  assert.ok(fs.existsSync(path.join(proj, 'docs', 'deep2.md')));
  ws.removeFile(pid, 'docs/deep2.md');
  assert.ok(!fs.existsSync(path.join(proj, 'docs', 'deep2.md')));
});
check('禁止删除/移动项目根', () => {
  assert.throws(() => ws.removeFile(pid, '.'), /根目录/);
});

console.log('\n[检索]');
check('纯文本检索命中多个文件', () => {
  const r = ws.search(pid, 'alpha');
  const files = new Set(r.results.map((x) => x.rel));
  ['README.md', 'index.html', 'app.js', 'docs/a.md'].forEach((f) => assert.ok(files.has(f), `应命中 ${f}，实际 ${[...files]}`));
});
check('正则检索', () => {
  const r = ws.search(pid, 'console\\.log\\((\\d)\\)', { regex: true });
  assert.strictEqual(r.total, 1);
});
check('glob 过滤只搜 md', () => {
  const r = ws.search(pid, 'alpha', { include: '*.md' });
  assert.ok(r.results.every((x) => x.rel.endsWith('.md')), JSON.stringify(r.results));
});
check('检索不进入 node_modules', () => {
  const r = ws.search(pid, '不该出现');
  assert.strictEqual(r.total, 0);
});
check('walk 收集全部可索引文件', () => {
  const files = ws.walk(pid);
  assert.ok(files.some((f) => f.rel === 'README.md'));
  assert.ok(!files.some((f) => f.rel.startsWith('node_modules/')));
  assert.ok(!files.some((f) => f.rel.startsWith('.omemory/')));
});

console.log('\n[辅助函数]');
check('isWithin 判定', () => {
  assert.ok(isWithin(root, path.join(root, 'a', 'b')));
  assert.ok(!isWithin(root, path.join(root, '..', 'x')));
});

fs.rmSync(root, { recursive: true, force: true });
console.log(failures ? `\n${failures} 项失败\n` : '\n全部通过\n');
process.exit(failures ? 1 : 0);
