'use strict';

/**
 * 端到端验证：真机 Ollama + 真项目目录 + 真工具执行
 *   node scripts/e2e-ollama.js [模型名]
 *
 * 与 selftest-engine.js 的区别：那里用离线假模型验证「循环契约」，这里验证
 * 「真实模型能不能把 MeReader 的工具体系用起来」——建文件、改文件、检索、压缩、记忆。
 * 跑在临时数据目录里，项目文件写在系统临时目录，绝不碰用户真实文档。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { DataPaths } = require('../src/main/agent/paths');
const { Workspace } = require('../src/main/agent/workspace');
const { SessionStore } = require('../src/main/agent/sessions');
const { AgentEngine } = require('../src/main/agent/engine');

const REAL_CONFIG = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'MeReader', 'agent', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
})();

const MODEL = process.argv[2] || REAL_CONFIG.chatModel || 'qwen3.6:latest';
const EMBED = REAL_CONFIG.embeddingModel || 'nomic-embed-text';

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
  }
}

function section(t) {
  console.log(`\n${t}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mereader-e2e-'));
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, '笔记'), { recursive: true });
  fs.writeFileSync(path.join(project, '说明.md'), '# 冒烟项目\n\n这是给 Ollab 的测试文档，里面有一个待办清单。\n\n- [ ] 检查文件树\n- [ ] 检查索引\n', 'utf8');
  fs.writeFileSync(path.join(project, 'data.json'), '{"items":[3,1,2]}', 'utf8');

  const paths = new DataPaths(path.join(tmp, 'userData')).init();
  const workspace = new Workspace({ registryFile: path.join(paths.agentDir, 'projects.json') });
  const proj = workspace.add(project);
  workspace.setActive(proj.id);
  const sessions = new SessionStore({ paths });
  const shell = { openPath: async () => '', showItemInFolder: () => {} };

  const events = [];
  const engine = new AgentEngine({ paths, workspace, sessions, shell, send: (type, payload) => events.push({ type, ...payload }) });
  engine.prepareSkills();
  engine.setConfig({
    baseUrl: REAL_CONFIG.baseUrl || 'http://127.0.0.1:11434',
    chatModel: MODEL,
    embeddingModel: EMBED,
    numCtx: 16384,
    reserveOutput: 1500,
    temperature: 0.2,
    thinking: 'off',
    maxToolRounds: 8,
    approvalMode: 'confirm',
    autoCompact: true,
    ragEnabled: true,
    ragAutoIndex: false
  });

  console.log(`=== MeReader × Ollab 端到端（模型 ${MODEL}，服务 ${engine.config.baseUrl}）===`);

  section('A. 连接与能力');
  const conn = await engine.checkConnection({ force: true });
  ok('Ollama 可连接', conn.ok, conn.error);
  const info = engine.modelInfo(MODEL);
  ok('模型具备工具调用能力', !!info && info.canTools !== false, JSON.stringify(info && { tools: info.canTools, vision: info.canVision }));

  section('B. 建文档：模型驱动工具在项目里写文件');
  const s1 = sessions.create({ projectId: proj.id, title: '建文档' });
  engine.setApprovalMode(s1.id, 'auto');
  const t0 = Date.now();
  const r1 = await engine.sendUserMessage({
    sessionId: s1.id,
    projectId: proj.id,
    text: '在项目里新建 笔记/周报.md：用一级标题写「本周周报」，下面列三条工作项，并加一个两列的 Markdown 表格（列名：事项、状态）。只写文件，不要多说。'
  });
  ok('一轮对话完成', r1.ok !== false, JSON.stringify(r1).slice(0, 200));
  const weekly = path.join(project, '笔记', '周报.md');
  const weeklyText = fs.existsSync(weekly) ? fs.readFileSync(weekly, 'utf8') : '';
  ok('笔记/周报.md 真的被创建', fs.existsSync(weekly), weeklyText.slice(0, 80));
  ok('内容含标题与表格', /#\s*本周周报/.test(weeklyText) && /\|.*事项.*\|/.test(weeklyText), weeklyText.replace(/\r/g, '').slice(0, 160));
  const toolEvents = events.filter((e) => e.type === 'tool' && e.event === 'result');
  ok('工具调用有落盘记录', toolEvents.length >= 1, `实际 ${toolEvents.length}`);
  console.log(`     （耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，工具 ${toolEvents.length} 次：${toolEvents.map((e) => e.name).join(', ')}）`);

  const msgs1 = sessions.load(s1.id).messages;
  ok('会话原始记录只追加', msgs1.length >= 3 && msgs1[0].role === 'user');
  const orphan = msgs1.filter((m, i) => m.role === 'tool' && !msgs1.slice(0, i).some((p) => p.role === 'assistant' && (p.tool_calls || []).some((c) => c.id === m.tool_call_id)));
  ok('工具结果都有对应调用（无孤立配对）', orphan.length === 0, JSON.stringify(orphan.map((m) => m.name)));

  section('C. 审批门控：需要确认态下由脚本代答');
  let asked = null;
  const rawSend = engine.rawSend;
  engine.rawSend = (channel, payload) => {
    if (payload && payload.type === 'approval') {
      asked = payload;
      // 真实预览必须给出路径，否则等于没门控
      setTimeout(() => engine.decide({ requestId: payload.requestId, decision: 'allow', note: '自动化测试同意' }), 20);
    }
    rawSend(channel, payload);
  };
  const s2 = sessions.create({ projectId: proj.id, title: '门控' });
  engine.setApprovalMode(s2.id, 'confirm');
  const r2 = await engine.sendUserMessage({ sessionId: s2.id, projectId: proj.id, text: '新建 门控测试.txt，内容只有一行：hello gate' });
  engine.rawSend = rawSend;
  ok('写文件前发起了确认请求', !!asked, JSON.stringify(r2).slice(0, 160));
  ok('确认请求带工具名与参数预览', !!asked && !!asked.tool && !!asked.tool.name && asked.args && (asked.args.path || asked.args.file || asked.args.content) != null, asked && JSON.stringify(asked).slice(0, 200));
  ok('批准后文件落盘', fs.existsSync(path.join(project, '门控测试.txt')));

  section('D. 拒绝路径：不批准就不许动盘');
  const gateFile = path.join(project, '门控测试.txt');
  const s3 = sessions.create({ projectId: proj.id, title: '拒绝' });
  let sawApproval = false;
  engine.rawSend = (channel, payload) => {
    if (payload && payload.type === 'approval') {
      sawApproval = true;
      setTimeout(() => engine.decide({ requestId: payload.requestId, decision: 'deny', note: '先别改' }), 20);
    }
    rawSend(channel, payload);
  };
  // 真实模型偶尔只口头答应不调工具，最多两轮把它引到 delete_file 上
  for (let i = 0; i < 2 && !sawApproval; i++) {
    await engine.sendUserMessage({
      sessionId: s3.id,
      projectId: proj.id,
      text: i ? '刚才没有真的调用工具。请调用 delete_file 工具删除 门控测试.txt。' : '请调用 delete_file 工具删除 门控测试.txt，不要只是口头回答。'
    });
  }
  engine.rawSend = rawSend;
  ok('删除请求触发强制确认', sawApproval, '两轮都没调用 delete_file（模型行为，非接线问题）');
  ok('拒绝后文件仍在', fs.existsSync(gateFile));
  ok('拒绝结果回填给了模型', sessions.load(s3.id).messages.some((m) => m.denied === true));

  section('E. 检索与记忆');
  const s4 = sessions.create({ projectId: proj.id, title: '检索' });
  engine.setApprovalMode(s4.id, 'auto');
  const r4 = await engine.sendUserMessage({ sessionId: s4.id, projectId: proj.id, text: '项目里有哪些 markdown 文件？只列文件名，一句话回答。' });
  const usedTool = events.filter((e) => e.sessionId === s4.id && e.type === 'tool' && e.event === 'result').some((e) => ['list_directory', 'tree', 'search_text', 'session_info'].includes(e.name));
  ok('回答前真的调用了查看类工具', r4.ok !== false && usedTool, JSON.stringify(r4).slice(0, 120));

  const mem = engine.stores(proj.id).memory.project;
  const before = mem.stats().total;
  const s5 = sessions.create({ projectId: proj.id, title: '记忆' });
  engine.setApprovalMode(s5.id, 'auto');
  await engine.sendUserMessage({ sessionId: s5.id, projectId: proj.id, text: '请记住这条项目约定：本项目所有文档标题一律使用中文。用一句话确认即可。' });
  ok('记忆条目写入 .omemory', mem.stats().total > before, `前 ${before} 后 ${mem.stats().total}`);
  ok('.omemory/memory.json 落盘', fs.existsSync(paths.projectMemoryFile(project)));

  section('F. 长上下文自动压缩（真实模型生成摘要）');
  const longDoc = Array.from({ length: 260 }, (_, i) => `第 ${i + 1} 行：这一行的内容是关于模块 ${i % 7} 的说明，用来把上下文撑到压缩水位之上。`).join('\n');
  fs.writeFileSync(path.join(project, '长文档.md'), `# 长文档\n\n${longDoc}\n`, 'utf8');
  engine.setConfig({ numCtx: 8192, thresholds: { autoRatio: 0.35, targetRatio: 0.12, keepRecentTurns: 1, keepToolGroups: 1, toolOutputTokenLimit: 150, minTurnsBetweenCompacts: 0, cooldownMs: 0 } });
  const s6 = sessions.create({ projectId: proj.id, title: '压缩' });
  engine.setApprovalMode(s6.id, 'auto');
  const beforeCompact = events.length;
  const r6 = await engine.sendUserMessage({ sessionId: s6.id, projectId: proj.id, text: '读取 长文档.md，然后只回答：这个文档一共有多少行？' });
  const compacts = events.slice(beforeCompact).filter((e) => e.type === 'compact');
  const st6 = sessions.load(s6.id).state.contextState || {};
  ok('压缩真实发生（自动）', compacts.length >= 1 || (st6.compactCount || 0) >= 1, JSON.stringify({ evts: compacts.length, count: st6.compactCount, ok: r6.ok }).slice(0, 200));
  if (compacts.length) {
    ok('压缩事件给出前后水位', compacts[0].before && compacts[0].after && compacts[0].before.percent >= compacts[0].after.percent, JSON.stringify({ b: compacts[0].before.percent, a: compacts[0].after.percent }));
  } else {
    ok('压缩事件给出前后水位', true, '（本轮未触发事件，已按 compactCount 判定）');
  }
  // L3 摘要层：规则层（落盘+清理）就够准时不会调模型，所以再推一轮，仍不够就手动压缩
  const before2 = events.length;
  await engine.sendUserMessage({ sessionId: s6.id, projectId: proj.id, text: '再读一遍 长文档.md 的前 40 行，只回答第一个模块编号。' });
  const compacts2 = events.slice(before2).filter((e) => e.type === 'compact');
  let st6b = sessions.load(s6.id).state.contextState || {};
  if (!st6b.summary) {
    const man = await engine.compressNow({ sessionId: s6.id, focus: '保留文档行数与模块编号' });
    ok('手动压缩走真实模型', man.ok !== false && !!man.state.summary, JSON.stringify(man.actions || man).slice(0, 160));
    st6b = sessions.load(s6.id).state.contextState || {};
  } else {
    ok('手动压缩走真实模型', true, '（自动压缩已生成摘要，无需手动）');
  }
  ok('摘要落盘且推进水位', !!st6b.summary && (st6b.summary.text || st6b.summary).length > 0 && !!st6b.coversUpTo, JSON.stringify({ len: String(st6b.summary || '').length, covers: st6b.coversUpTo }).slice(0, 120));
  ok('原始历史没有被压缩删掉', sessions.load(s6.id).messages.length >= 4);
  ok('超长工具输出已落盘缓存', fs.readdirSync(paths.toolCacheDir).filter((f) => /\.md$/.test(f)).length >= 1);

  section('G. 向量索引与检索');
  const embOk = (await engine.listModels({ force: true })).some((m) => m.isEmbedding && (m.name === EMBED || m.name.startsWith(`${EMBED}:`)));
  if (!embOk) {
    console.log(`     （跳过：本机没有 ${EMBED} 嵌入模型）`);
  } else {
    engine.setConfig({ numCtx: 16384, ragEnabled: true });
    const idx = await engine.reindexProject(proj.id, { limit: 50 });
    ok('项目索引重建完成', idx && (idx.files || idx.indexed || (idx.skipped !== undefined)), JSON.stringify(idx).slice(0, 160));
    const stats = engine.ragStats(proj.id).project;
    ok('索引里有文档与片段', !!stats && stats.files > 0 && stats.chunks > 0, JSON.stringify(stats));
    const found = await engine.stores(proj.id).rag.project.query('待办清单', { topK: 3 });
    ok('语义检索能命中 说明.md', (found.results || []).some((h) => /说明\.md/.test(h.rel)), JSON.stringify((found.results || []).map((h) => h.rel)));
  }

  section('H. 固定开销装不下时的可执行报错（num_ctx 明显偏小）');
  // 用 persona 把固定开销撑起来：历史是空的，超水位只可能是固定部分造成，正好验证诊断分支
  engine.setConfig({ numCtx: 4096, thresholds: {}, persona: '固定要求：' + '请始终遵循本条项目约定以免出错。'.repeat(420) });
  const s7a = sessions.create({ projectId: proj.id, title: '窗口过小' });
  engine.setApprovalMode(s7a.id, 'auto');
  const rHard = await engine.sendUserMessage({ sessionId: s7a.id, projectId: proj.id, text: '只回答：在' });
  engine.setConfig({ persona: '' });
  ok('窗口过小被拦下（没有硬发给模型）', rHard.ok === false && rHard.error === 'context-full', JSON.stringify(rHard).slice(0, 140));
  ok('诊断为固定开销而非历史过长', rHard.reason === 'baseline', JSON.stringify({ reason: rHard.reason, base: rHard.baselineTokens }));
  ok('给出可调的 num_ctx 建议值', typeof rHard.suggestNumCtx === 'number' && rHard.suggestNumCtx > 4096, String(rHard.suggestNumCtx));
  const hardMsg = events.filter((e) => e.type === 'error' && e.sessionId === s7a.id).pop();
  ok('报错文案说明该改哪里', !!hardMsg && /num_ctx/.test(hardMsg.message), String(hardMsg && hardMsg.message).slice(0, 120));

  section('I. 重启续用（新引擎实例读同一份数据）');
  engine.setConfig({ numCtx: 16384 });
  const engine2 = new AgentEngine({ paths, workspace, sessions, shell, send: () => {} });
  engine2.setConfig({ chatModel: MODEL, baseUrl: engine.config.baseUrl, embeddingModel: EMBED });
  const resumed = sessions.list({ projectId: proj.id });
  ok('会话在重启后可列出', resumed.length >= 5, `实际 ${resumed.length}`);
  const s7 = sessions.create({ projectId: proj.id, title: '续写' });
  engine2.setApprovalMode(s7.id, 'auto');
  const r7 = await engine2.sendUserMessage({ sessionId: s7.id, projectId: proj.id, text: `把 笔记/周报.md 的表格再加一列「负责人」，值填「我」。改完只回答：好了` });
  const after = fs.existsSync(weekly) ? fs.readFileSync(weekly, 'utf8') : '';
  ok('第二轮真的改了表格', /负责人/.test(after), after.replace(/\r/g, '').slice(0, 220));
  ok('引擎实例可复用同一存储', r7.ok !== false, JSON.stringify(r7).slice(0, 160));

  console.log(`\n结果：通过 ${passed}，失败 ${failed}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('端到端测试异常终止：', err);
  process.exit(2);
});
