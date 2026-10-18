'use strict';

/**
 * 自检：Markdown / 数据文档工具箱
 * 运行：node scripts/selftest-markdown.js
 */

const assert = require('assert');
const md = require('../src/main/agent/markdown');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log('\n[规范化排版]');
check('标题补空格、列表统一符号、去行尾空格', () => {
  const out = md.formatMarkdown('#标题   \n内容  \n* a\n+ b\n');
  assert.ok(/^# 标题$/m.test(out), JSON.stringify(out));
  assert.ok(out.includes('- a'), out);
  assert.ok(!/ +\n/.test(out), '不应残留行尾空格');
});
check('标题前后自动空行', () => {
  const out = md.formatMarkdown('段落一\n## 小节\n段落二\n');
  assert.strictEqual(out, '段落一\n\n## 小节\n\n段落二\n');
});
check('多个空行折叠为一个', () => {
  const out = md.formatMarkdown('a\n\n\n\n\nb\n');
  assert.strictEqual(out, 'a\n\nb\n');
});
check('代码块内容不被改动', () => {
  const src = '```js\nconst   x = 1;   \n\n\n```\n';
  const out = md.formatMarkdown(src);
  assert.ok(out.includes('const   x = 1;   '), JSON.stringify(out));
});
check('任务列表与嵌套列表项之间的空行不破坏结构', () => {
  const out = md.formatMarkdown('- [ ] 一\n- [ ] 二\n\n  - 子项\n');
  assert.ok(out.includes('- [ ] 一'), out);
});
check('分割线统一为 ---', () => {
  assert.ok(md.formatMarkdown('a\n***\nb\n').includes('---'));
});
check('frontmatter 原样保留', () => {
  const out = md.formatMarkdown('---\ntitle: 我的文档\ntags:\n  - a\n  - b\n---\n\n# 正文\n');
  assert.ok(out.startsWith('---\ntitle: 我的文档'), JSON.stringify(out.slice(0, 40)));
  assert.ok(out.includes('# 正文'));
});

console.log('\n[标题编号 / 大纲 / 目录]');
check('标题编号跳过代码块', () => {
  const out = md.numberHeadings('# 概述\n```\n# 不是标题\n```\n## 细节\n## 另一节\n# 第二个一级\n');
  assert.ok(out.includes('# 1 概述'), out);
  assert.ok(out.includes('## 1.1 细节'), out);
  assert.ok(out.includes('## 1.2 另一节'), out);
  assert.ok(out.includes('# 2 第二个一级'), out);
  assert.ok(out.includes('# 不是标题'), '代码块内不得编号');
});
check('大纲带行号', () => {
  const hs = md.headings('# A\n正文\n## B 小节\n');
  assert.deepStrictEqual(hs.map((h) => h.title), ['A', 'B 小节']);
  assert.strictEqual(hs[1].line, 3);
});
check('目录锚点对中文与标点可用', () => {
  assert.strictEqual(md.slug('你好，World！'), '你好world');
  assert.strictEqual(md.slug('Getting Started'), 'getting-started');
});
check('生成目录只含 <=maxLevel', () => {
  const toc = md.buildToc('# 顶层\n## 一级\n### 深层\n', { maxLevel: 2 });
  assert.ok(toc.includes('- [一级](#一级)'), toc);
  assert.ok(!toc.includes('深层'), toc);
});

console.log('\n[表格]');
check('对齐表格且中文宽度正确', () => {
  const out = md.alignTable('|名称|数量|\n|-|-|\n|坦克|3|\n|战斗机|10|\n');
  const rows = out.trim().split('\n');
  const widths = rows.map((r) => md.displayWidth(r));
  assert.strictEqual(new Set(widths).size, 1, `各行显示宽度应一致：${JSON.stringify(rows)} -> ${JSON.stringify(widths)}`);
  assert.ok(rows[1].startsWith('| ---'), rows[1]);
});
check('保留对齐冒号', () => {
  const out = md.alignTable('|a|b|\n|:--|--:|\n|1|2|\n');
  assert.ok(/\|\s*:-+\s*\|\s*-+:\s*\|/.test(out), out);
});
check('CSV 文本转表格', () => {
  const t = md.rowsToTable(['名称,数量', '坦克,3', '导弹,5']);
  assert.ok(t.includes('| 名称 | 数量 |'), t);
  assert.ok(t.includes('| 坦克 | 3    |') || t.includes('| 坦克 | 3  |'), t);
});
check('表格解析出表头与对齐', () => {
  const p = md.parseTable('|a|b|\n|:-|:-:|\n|1|2|\n');
  assert.deepStrictEqual(p.header, ['a', 'b']);
  assert.deepStrictEqual(p.align, ['left', 'center']);
});

console.log('\n[frontmatter]');
check('读写 frontmatter', () => {
  const { data, body } = md.splitFrontMatter('---\ntitle: 标题\ncount: 3\ndraft: false\ntags:\n  - x\n  - y\n---\n正文在此\n');
  assert.strictEqual(data.title, '标题');
  assert.strictEqual(data.count, 3);
  assert.strictEqual(data.draft, false);
  assert.deepStrictEqual(data.tags, ['x', 'y']);
  assert.strictEqual(body, '正文在此\n');
});
check('合并/删除字段', () => {
  const out = md.setFrontMatter('---\ntitle: A\nkeep: 1\n---\n正文\n', { title: 'B', keep: null, added: ['m', 'n'] });
  assert.ok(/title: B/.test(out), out);
  assert.ok(!/keep:/.test(out), out);
  assert.ok(out.includes('added:'), out);
  assert.ok(out.includes('正文'), out);
});

console.log('\n[链接 / 图片]');
check('收集行内链接、引用式与 HTML img', () => {
  const links = md.collectLinks('![图](pic/a.png "标题")\n[链接](https://x.cn)\n[1]: ref.md\n<img src="i.svg" />\n');
  assert.strictEqual(links.length, 4);
  assert.ok(links[0].image && links[0].target === 'pic/a.png');
  assert.ok(md.isRemote(links[1].target) && !md.isRemote(links[0].target));
  assert.ok(links[2].reference);
  assert.ok(links[3].html);
});
check('图片引用：普通/带宽度/内联/base64', () => {
  assert.strictEqual(md.imageRef('封面', 'assets/cover.png'), '![封面](assets/cover.png)');
  assert.strictEqual(md.imageRef('封 面', 'assets/my cover.png'), '![封 面](<assets/my cover.png>)');
  assert.ok(md.imageRef('c', 'x.png', { width: 320 }).startsWith('<img src="x.png"'));
  assert.ok(md.imageRef('c', null, { inline: true, dataUrl: 'data:image/png;base64,AAA' }).includes('data:image/png;base64,AAA'));
});

console.log('\n[统计与分块]');
check('中日英混合字数统计', () => {
  const c = md.countWords('# 标题\n\nhello world 你好世界\n');
  assert.strictEqual(c.cjk, 6, JSON.stringify(c));
  assert.strictEqual(c.latin, 2, JSON.stringify(c));
  assert.strictEqual(c.total, 8, JSON.stringify(c));
});
check('按标题切分章节', () => {
  const secs = md.sections('# A\n1\n## B\n2\n');
  assert.strictEqual(secs.length, 2);
  assert.strictEqual(secs[0].title, 'A');
  assert.ok(secs[1].text.includes('## B'));
});
check('嵌入分块遵守 token 预算', () => {
  const long = Array.from({ length: 40 }, (_x, i) => `第${i}段内容，这里放一些中文文本用于测试长度。`).join('\n\n');
  const chunks = md.chunkForEmbedding(long, { tokens: 200, overlap: 40 });
  assert.ok(chunks.length >= 2, `应切成多块，实际 ${chunks.length}`);
  chunks.forEach((c, i) => assert.ok(md.estimateTokens(c) <= 260, `第${i}块超预算：${md.estimateTokens(c)}`));
});
check('短文本只出一块', () => {
  assert.strictEqual(md.chunkForEmbedding('只有一句话。', { tokens: 300 }).length, 1);
});

console.log('\n[JSON / XML]');
check('JSON 美化与报错', () => {
  assert.strictEqual(md.tidyJson('{"a":1,"b":[2,3]}'), '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
  assert.throws(() => md.tidyJson('{"a":'), /无效/);
  assert.ok(md.validateJson('[1,2]').ok);
  assert.strictEqual(md.validateJson('{bad').ok, false);
});
check('XML 标签配对校验', () => {
  assert.ok(md.validateXml('<?xml version="1.0"?><root><a>1</a><b/></root>').ok);
  const bad = md.validateXml('<root><a>1</b></root>');
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.length, '应报告不匹配');
  assert.strictEqual(md.validateXml('<a>未闭合').ok, false);
  assert.strictEqual(md.validateXml('<x>&amp; &#65; &oops;</x>').ok, false, '无效实体应报错');
});
check('XML 缩进美化', () => {
  const out = md.tidyXml('<root><item id="1">甲</item><item>乙</item></root>');
  assert.ok(out.includes('<root>'), out);
  assert.ok(/\n\s+<item/.test(out), out);
});

console.log('\n[H5 脚手架]');
check('生成 index.html/style.css/app.js', () => {
  const files = md.h5Scaffold({ title: '坦克大战' });
  assert.deepStrictEqual(Object.keys(files).sort(), ['app.js', 'index.html', 'style.css']);
  assert.ok(files['index.html'].includes('<title>坦克大战</title>'));
  assert.ok(files['app.js'].includes("getElementById('action')"));
  assert.ok(files['style.css'].includes(':root'));
});

console.log(failures ? `\n${failures} 项失败\n` : '\n全部通过\n');
process.exit(failures ? 1 : 0);
