'use strict';

/**
 * Ollab 引擎自测（离线：脚本化假模型）
 *
 * 覆盖 loop 机制本身，而不是模型智商：
 *   工具调用与结果配对 / 审批门控两态 / 不可逆操作强制确认 / 计划持久化 / ask_user 暂停
 *   自动压缩（原始历史不被改写）/ prompt_eval_count 校准 / 上下文爆满拒绝 / 中途取消补配对 / 图片窗口策略
 *
 * 运行：node scripts/selftest-engine.js         离线自测
 *       node scripts/selftest-engine.js --live  追加真实 Ollama 端到端一轮（首次加载权重较慢）
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const { DataPaths } = require('../src/main/agent/paths');
const { Workspace } = require('../src/main/agent/workspace');
const { SessionStore } = require('../src/main/agent/sessions');
const { AgentEngine } = require('../src/main/agent/engine');

let passed = 0;
const fails = [];
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fails.push(`${name} → ${err.message}`);
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fails.push(`${name} → ${err.message}`);
    console.log(`  ✗ ${name}\n    ${err.message}${err.stack ? `\n${err.stack.split('\n').slice(1, 3).join('\n')}` : ''}`);
  }
}

/** 用与引擎一致的估算器回报 promptTokens，使校准系数≈1（否则假数据会把水位算歪） */
function promptTokensOf(messages) {
  const { estimateTokens } = require('../src/main/agent/markdown');
  let sum = 0;
  for (const m of messages || []) {
    sum += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''));
    if (m.tool_calls) sum += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return Math.max(1, sum);
}

// ---------------- 假模型：按脚本逐轮返回 ----------------
class FakeClient {
  constructor(script, { canVision = false, contextLength = 8192 } = {}) {
    this.script = script;
    this.i = 0;
    this.calls = [];
    this.canVision = canVision;
    this.contextLength = contextLength;
    this.emitted = [];
  }
  async getVersion() {
    return '0.0-fake';
  }
  async listModels() {
    return [
      {
        name: 'fake-model',
        size: 1,
        parameterSize: '1B',
        quantization: 'q4',
        contextLength: this.contextLength,
        family: 'fake',
        capabilities: ['completion', 'tools'],
        canChat: true,
        canTools: true,
        canVision: this.canVision,
        canThinking: false,
        isEmbedding: false,
        modifiedAt: ''
      }
    ];
  }
  async embed(input) {
    const arr = Array.isArray(input) ? input : [input];
    return arr.map((t, i) => {
      const v = new Array(8).fill(0);
      const seed = String(t).length + i;
      for (let k = 0; k < 8; k++) v[k] = ((seed * (k + 3)) % 17) / 17;
      return v;
    });
  }
  async chat({ model, messages, tools, options, onEvent = () => {} }) {
    this.calls.push({ model, messages, tools, options });
    // 摘要请求特征：单条 user 消息 + 固定指令，直接回喂结构化摘要，不参与脚本
    if (messages.length === 1 && /压缩成结构化摘要/.test(messages[0].content || '')) {
      this.summaries = (this.summaries || 0) + 1;
      return {
        content: '## 目标\n（假摘要）任务进行中\n## 已完成\n- 读取目录\n## 关键决策\n- 无\n## 涉及文件\n- docs/a.md\n## 未决问题\n- 无\n## 用户偏好\n- 简洁',
        reasoning: '',
        toolCalls: null,
        stats: { promptTokens: 300, evalTokens: 60, loadMs: 1, totalMs: 2 }
      };
    }
    const step = this.script[this.i++];
    if (!step) throw new Error(`假模型脚本用完（第 ${this.i} 次请求）`);
    if (step.error) throw new Error(step.error);
    const content = step.content || '';
    if (content) onEvent({ type: 'text', delta: content });
    if (step.reasoning) onEvent({ type: 'reasoning', delta: step.reasoning });
    const stats = step.stats || { promptTokens: promptTokensOf(messages), evalTokens: 20, loadMs: 1, totalMs: 2 };
    return { content, reasoning: step.reasoning || '', toolCalls: step.toolCalls || null, stats };
  }
}

function makeEnv({ script, cfg = {}, files = {}, canVision = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mreader-engine-'));
  const userData = path.join(tmp, 'userData');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(project, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(project, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  const paths = new DataPaths(userData).init();
  const workspace = new Workspace({ registryFile: path.join(userData, 'agent', 'projects.json') });
  const proj = workspace.add(project, '测试项目');
  workspace.setActive(proj.id);
  const sessions = new SessionStore({ paths });
  const events = [];
  const engine = new AgentEngine({
    paths,
    workspace,
    sessions,
    shell: { openPath: async () => {}, showItemInFolder: () => {} },
    send: (channel, payload) => events.push({ channel, ...payload })
  });
  engine.prepareSkills();
  engine.setConfig({ baseUrl: 'http://fake', chatModel: 'fake-model', embeddingModel: '', ragEnabled: false, memoryEnabled: true, skillEnabled: true, autoCompact: true, approvalMode: 'auto', numCtx: 4096, reserveOutput: 800, maxToolRounds: 6, ...cfg });
  const fake = new FakeClient(script, { canVision });
  engine.client = () => fake;
  return { tmp, paths, workspace, sessions, engine, events, fake, project, proj, sessionId: sessions.create({ projectId: proj.id, projectName: proj.name, model: 'fake-model' }).id };
}

function eventsOf(env, type) {
  return env.events.filter((e) => e.type === type);
}
function messagesOf(env) {
  return env.sessions.load(env.sessionId).messages;
}
/** 校验 assistant.tool_calls 与 tool 结果一一配对（下一次请求合法的前提） */
function assertPairing(messages) {
  const callIds = [];
  const resultIds = [];
  for (const m of messages) {
    for (const c of m.tool_calls || []) callIds.push(c.id);
    if (m.role === 'tool') resultIds.push(m.tool_call_id);
  }
  assert.deepStrictEqual([...callIds].sort(), [...resultIds].sort(), '工具调用与结果必须成对');
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    const expect = m.tool_calls.map((c) => c.id);
    const got = [];
    for (let k = i + 1; k < messages.length && messages[k].role === 'tool'; k++) got.push(messages[k].tool_call_id);
    assert.deepStrictEqual(got, expect, `第 ${i} 条 assistant 的工具结果顺序/数量不符`);
  }
}

async function main() {
  console.log('=== Ollab 引擎自测（离线假模型）===\n');

  // ---------- A. 工具循环与配对 ----------
  console.log('A. 工具链循环');
  {
    const env = makeEnv({
      script: [
        { content: '我先看目录。', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'list_directory', arguments: { path: 'docs' } } }], stats: { promptTokens: 1600, evalTokens: 30, loadMs: 5, totalMs: 40 } },
        { content: 'docs 里有 a.md 与 b.md。' }
      ],
      files: { 'docs/a.md': '# A\n', 'docs/b.md': '# B\n' }
    });
    await env.engine.sendUserMessage({ sessionId: env.sessionId, text: '列出 docs 目录' });
    const msgs = messagesOf(env);
    await okAsync('用户/助手/工具/助手 四条消息按序落盘', async () => {
      assert.strictEqual(msgs.length, 4, `消息数=${msgs.length}`);
      assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
      assert.strictEqual(msgs[2].name, 'list_directory');
      assert.ok(msgs[2].content.includes('a.md'), '工具结果应含目录内容');
    });
    await okAsync('工具调用与结果成对', async () => assertPairing(msgs));
    await okAsync('只读工具在自动审批态不询问', async () => assert.strictEqual(eventsOf(env, 'approval').length, 0));
    await okAsync('工具事件带出参数与耗时', async () => {
      const t = eventsOf(env, 'tool');
      assert.ok(t.find((x) => x.event === 'start' && x.name === 'list_directory'));
      assert.ok(t.find((x) => x.event === 'result' && x.ok && typeof x.durationMs === 'number'));
    });
    await okAsync('prompt_eval_count 用于校准字符/词元比', async () => {
      const st = env.sessions.load(env.sessionId).state.contextState;
      assert.ok(st.calib && st.calib.charsPerToken > 0, '应有校准系数');
    });
    await okAsync('回合结束发出 turn-end 且带用量', async () => {
      const e = eventsOf(env, 'turn-end');
      assert.strictEqual(e.length, 1);
      assert.ok(e[0].usage && e[0].usage.budget > 0);
    });
    await okAsync('会话文件为追加式 jsonl，未被改写', async () => {
      const raw = fs.readFileSync(env.paths.sessionFile(env.sessionId), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      assert.ok(lines.every((l) => l.startsWith('{')), '每行都是 JSON');
      assert.ok(lines.filter((l) => /"t":"msg"/.test(l)).length >= 4);
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }

  // ---------- B. 审批门控 ----------
  console.log('\nB. 审批门控（需要确认 / 自动审批）');
  {
    const env = makeEnv({
      cfg: { approvalMode: 'confirm' },
      script: [
        { content: '我要写文件。', toolCalls: [{ id: 'w1', function: { name: 'write_file', arguments: { path: 'docs/new.md', content: '# 新建\n' } } }] },
        { content: '已按你的意见跳过。' }
      ],
      files: {}
    });
    const p = env.engine.sendUserMessage({ sessionId: env.sessionId, text: '新建 docs/new.md' });
    // 等审批事件出现后拒绝
    await waitFor(() => eventsOf(env, 'approval').length > 0, 1500);
    const ap = eventsOf(env, 'approval')[0];
    await okAsync('写类工具在需要确认态下发起询问，并带路径与差异预览', async () => {
      assert.ok(ap, '应有审批事件');
      assert.strictEqual(ap.tool.name, 'write_file');
      assert.strictEqual(ap.preview.rel, 'docs/new.md');
      assert.ok(ap.preview.diff.includes('+ # 新建'), '新建文件应给出差异');
      assert.strictEqual(ap.irreversible, false);
    });
    env.engine.decide({ requestId: ap.requestId, decision: 'deny', note: '先别动' });
    const res = await p;
    await okAsync('拒绝后文件未创建，且回填了拒绝说明', async () => {
      assert.strictEqual(fs.existsSync(path.join(env.project, 'docs', 'new.md')), false, '不应写入文件');
      const tool = messagesOf(env).find((m) => m.role === 'tool');
      assert.ok(tool.content.includes('拒绝'), '工具结果应写明被拒绝');
      assert.ok(tool.content.includes('先别动'), '应带上用户理由');
      assertPairing(messagesOf(env));
      assert.ok(res.ok, '被拒后本轮仍能正常收尾');
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    const env = makeEnv({
      cfg: { approvalMode: 'auto' },
      script: [
        { content: '删除。', toolCalls: [{ id: 'd1', function: { name: 'delete_file', arguments: { path: 'docs/a.md' } } }] },
        { content: '已删除。' }
      ],
      files: { 'docs/a.md': '# A\n' }
    });
    const p = env.engine.sendUserMessage({ sessionId: env.sessionId, text: '删掉 docs/a.md' });
    await waitFor(() => eventsOf(env, 'approval').length > 0, 1500);
    await okAsync('删除类操作即使在自动审批态也强制确认', async () => {
      const ap = eventsOf(env, 'approval')[0];
      assert.strictEqual(ap.tool.name, 'delete_file');
      assert.strictEqual(ap.irreversible, true);
      assert.ok(ap.preview.note.includes('不可恢复'));
    });
    env.engine.decide({ requestId: eventsOf(env, 'approval')[0].requestId, decision: 'allow' });
    await p;
    await okAsync('确认后真的删除了文件', async () => {
      assert.strictEqual(fs.existsSync(path.join(env.project, 'docs', 'a.md')), false);
      assertPairing(messagesOf(env));
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    const env = makeEnv({
      cfg: { approvalMode: 'confirm' },
      script: [
        { content: '写。', toolCalls: [{ id: 'w1', function: { name: 'write_file', arguments: { path: 'x.md', content: 'x\n' } } }] },
        { content: '继续写。', toolCalls: [{ id: 'w2', function: { name: 'write_file', arguments: { path: 'y.md', content: 'y\n' } } }] },
        { content: '完成。' }
      ]
    });
    const p = env.engine.sendUserMessage({ sessionId: env.sessionId, text: '写两个文件' });
    await waitFor(() => eventsOf(env, 'approval').length > 0, 1500);
    env.engine.decide({ requestId: eventsOf(env, 'approval')[0].requestId, decision: 'auto' });
    await p;
    await okAsync('选择「本会话自动批准」后同会话不再询问', async () => {
      assert.strictEqual(eventsOf(env, 'approval').length, 1, '只应询问一次');
      assert.strictEqual(env.engine.runtime(env.sessionId).approval, 'auto');
      assert.ok(fs.existsSync(path.join(env.project, 'x.md')) && fs.existsSync(path.join(env.project, 'y.md')));
      assertPairing(messagesOf(env));
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }

  // ---------- C. 计划 / ask_user / 反思 ----------
  console.log('\nC. plan-act-reflect');
  {
    const env = makeEnv({
      script: [
        { content: '先规划。', toolCalls: [{ id: 'p1', function: { name: 'set_plan', arguments: { goal: '整理 docs', steps: ['清点文件', '统一标题'] } } }] },
        { content: '执行第一步。', toolCalls: [{ id: 'p2', function: { name: 'update_plan_step', arguments: { index: 1, status: 'done', note: '2 个文件' } } }] },
        { content: '收尾自查。', toolCalls: [{ id: 'p3', function: { name: 'reflect', arguments: { checks: ['改动都在项目内'], conclusion: '完成' } } }] },
        { content: '全部完成。' }
      ],
      files: { 'docs/a.md': '# a\n', 'docs/b.md': '# b\n' }
    });
    await env.engine.sendUserMessage({ sessionId: env.sessionId, text: '整理 docs' });
    await okAsync('计划持久化在会话 state 里并可渲染', async () => {
      const st = env.sessions.load(env.sessionId).state;
      assert.ok(st.plan && st.plan.steps.length === 2, '计划应落盘');
      assert.strictEqual(st.plan.steps[0].status, 'done');
      const planEvents = eventsOf(env, 'plan');
      assert.ok(planEvents.length >= 2, '计划变化应有事件');
      assert.ok(planEvents[planEvents.length - 1].text.includes('[✓] 清点文件'), '计划文本带状态标记');
    });
    await okAsync('reflect 生成复盘文本', async () => {
      const r = eventsOf(env, 'reflect');
      assert.ok(r.length === 1 && r[0].report.includes('复盘'));
    });
    assertPairing(messagesOf(env));
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    const env = makeEnv({
      script: [
        { content: '需要确认一下。', toolCalls: [{ id: 'q1', function: { name: 'ask_user', arguments: { question: '目录用 docs 还是 notes？', options: ['docs', 'notes'] } } }] }
      ]
    });
    const res = await env.engine.sendUserMessage({ sessionId: env.sessionId, text: '建个目录' });
    await okAsync('ask_user 暂停本轮并抛出问题选项', async () => {
      assert.strictEqual(res.paused, 'ask');
      assert.strictEqual(res.question, '目录用 docs 还是 notes？');
      const ask = eventsOf(env, 'ask')[0];
      assert.deepStrictEqual(ask.options, ['docs', 'notes']);
      const msgs = messagesOf(env);
      assert.strictEqual(msgs[msgs.length - 1].role, 'tool', '暂停前必须已回填工具结果');
      assertPairing(msgs);
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }

  // ---------- D. 上下文压缩 ----------
  console.log('\nD. 上下文自动压缩');
  {
    const longToolOut = Array.from({ length: 400 }, (_, i) => `第 ${i} 行 一些很长的工具输出内容，用于撑满上下文窗口`).join('\n');
    const env = makeEnv({
      cfg: { numCtx: 4096, reserveOutput: 800, thresholds: { autoRatio: 0.4, targetRatio: 0.01, keepRecentTurns: 1, keepToolGroups: 1, toolOutputTokenLimit: 200, clearAtLeastTokens: 100, minTurnsBetweenCompacts: 0, cooldownMs: 0, summaryTokenCap: 200 } },
      script: [
        { content: '读取。', toolCalls: [{ id: 'r1', function: { name: 'read_file', arguments: { path: 'big.md' } } }] },
        { content: '再读。', toolCalls: [{ id: 'r2', function: { name: 'read_file', arguments: { path: 'big.md' } } }] },
        { content: '第三轮。', toolCalls: [{ id: 'r3', function: { name: 'read_file', arguments: { path: 'big.md' } } }] },
        { content: '读完了。' }
      ],
      files: { 'big.md': longToolOut }
    });
    const before = messagesOf(env).length;
    await env.engine.sendUserMessage({ sessionId: env.sessionId, text: '读三次大文件' });
    await okAsync('超长工具输出落盘并在视图里只留引用', async () => {
      const st = env.sessions.load(env.sessionId).state.contextState;
      assert.ok(st.budgets && st.budgets.length > 0, '应有落盘记录');
      const cached = fs.readdirSync(env.paths.toolCacheDir).filter((f) => f.endsWith('.md'));
      assert.ok(cached.length > 0, '缓存目录应有全文文件');
    });
    await okAsync('同一轮内多工具：规则层清理陈旧工具结果（保住调用配对）', async () => {
      const st = env.sessions.load(env.sessionId).state.contextState;
      assert.ok(st.cleared && st.cleared.length > 0, `应有被清理的旧工具结果：${JSON.stringify(st.cleared)}`);
      // 单轮内没有「更早的轮次」，L3 不该乱动工具配对
      assert.strictEqual(env.fake.summaries || 0, 0, '单轮内不应发起摘要请求');
      assertPairing(messagesOf(env));
    });
    await okAsync('发往模型的每一个请求里都不存在孤立工具结果', async () => {
      assert.ok(env.fake.calls.length >= 2, '应有多次请求可供检查');
      for (const call of env.fake.calls) {
        const ids = new Set();
        for (const m of call.messages) for (const c of m.tool_calls || []) ids.add(c.id);
        const orphan = call.messages.filter((m) => m.role === 'tool' && !ids.has(m.tool_call_id));
        assert.strictEqual(orphan.length, 0, `孤立工具结果：${orphan.map((o) => o.tool_call_id).join(',')}`);
        call.messages.forEach((m, i) => {
          if (m.role !== 'assistant' || !m.tool_calls) return;
          const got = [];
          for (let k = i + 1; k < call.messages.length && call.messages[k].role === 'tool'; k++) got.push(call.messages[k].tool_call_id);
          assert.deepStrictEqual(got, m.tool_calls.map((c) => c.id), 'assistant 之后必须紧跟等量且同序的工具结果');
        });
      }
    });
    await okAsync('压缩只作用派生视图，原始历史只增不减', async () => {
      const after = messagesOf(env).length;
      assert.ok(after > before, `原始历史必须更多（${before} → ${after}）`);
      const raw = fs.readFileSync(env.paths.sessionFile(env.sessionId), 'utf8');
      assert.ok(raw.includes('第 399 行'), '原始全文仍在会话文件中');
    });
    await okAsync('压缩事件把前后水位与分层动作告诉 UI', async () => {
      const c = eventsOf(env, 'compact');
      assert.ok(c.length >= 1 && c[0].auto === true);
      assert.ok(c[0].before.percent >= c[0].after.percent || c[0].actions.length >= 1);
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    // 多轮长对话：L3 增量摘要必须接手，并且只覆盖「更早的轮次」
    const filler = (n) => `${n} 号需求：请把这段很长的说明写进文档并检查格式。`.repeat(28);
    const env = makeEnv({
      cfg: {
        numCtx: 4096,
        reserveOutput: 800,
        memoryEnabled: false,
        skillEnabled: false,
        thresholds: { autoRatio: 0.35, targetRatio: 0.01, hardRatio: 0.99, keepRecentTurns: 1, toolOutputTokenLimit: 5000, clearAtLeastTokens: 100000, minTurnsBetweenCompacts: 0, cooldownMs: 0, summaryTokenCap: 200 }
      },
      script: [{ content: '收到一。' }, { content: '收到二。' }, { content: '收到三。' }, { content: '收到四。' }]
    });
    for (let i = 1; i <= 4; i++) await env.engine.sendUserMessage({ sessionId: env.sessionId, text: filler(i) });
    const st = env.sessions.load(env.sessionId).state.contextState;
    await okAsync('多轮长对话触发 L3 增量摘要并落盘', async () => {
      assert.ok(env.fake.summaries >= 1, `应发起摘要请求（实际 ${env.fake.summaries || 0}）`);
      assert.ok(st.summary.includes('假摘要'), '摘要文本应持久化');
      assert.ok(st.coversUpTo, '摘要必须推进 coversUpTo');
      assert.ok(st.compactCount >= 1);
    });
    await okAsync('摘要请求走独立单条消息，不携带工具', async () => {
      const call = env.fake.calls.find((c) => /压缩成结构化摘要/.test(c.messages[0].content));
      assert.ok(call, '应能定位到摘要请求');
      assert.strictEqual(call.messages.length, 1);
      assert.ok(!call.tools, '摘要请求不应带工具');
    });
    await okAsync('视图里被摘要覆盖的旧轮次退出，最近轮仍是原文', async () => {
      const snap = env.engine.sessionContextSnapshot(env.sessionId);
      const folded = snap.view.filter((m) => m.flags.folded);
      assert.ok(snap.usage.percent <= 100, '压缩后必须仍在窗口内');
      assert.ok(snap.meta.pinnedBlocks >= 2, '摘要应作为 pinned 段注入');
      assert.ok(folded.length >= 1, `被摘要覆盖的旧消息应折叠为占位，实际折叠 ${folded.length}`);
      const tail = snap.view[snap.view.length - 1];
      assert.ok(!tail.flags.folded && tail.role === 'assistant', '最近一条必须是原文回答');
      assert.ok(tail.preview.includes('收到四'), `最近轮应保持原文：${tail.preview}`);
    });
    await okAsync('原始历史始终完整（压缩只减视图不减记录）', async () => {
      const raw = fs.readFileSync(env.paths.sessionFile(env.sessionId), 'utf8');
      const msgLines = raw.split('\n').filter((l) => /"t":"msg"/.test(l));
      assert.strictEqual(msgLines.length, 8, `原始消息应为 8 条，实际 ${msgLines.length}`);
      assert.ok(raw.includes('1 号需求') && raw.includes('4 号需求'), '四轮原文都要还在');
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    // 用超长 persona 把「不可压缩的 pinned 段」撑爆，验证硬水位保护
    const env = makeEnv({
      cfg: { numCtx: 2048, reserveOutput: 500, autoCompact: false, persona: '用户偏好说明。'.repeat(900), thresholds: { autoRatio: 0.4, hardRatio: 0.5 } },
      script: [{ content: '不该发出这次请求', error: '不应发出' }]
    });
    env.engine.setApprovalMode(env.sessionId, 'auto');
    const res = await env.engine.sendUserMessage({ sessionId: env.sessionId, text: '继续' });
    await okAsync('关闭自动压缩且超硬水位时拒绝请求并提示', async () => {
      assert.strictEqual(res.ok, false);
      assert.ok(res.error === 'context-full' || /context/.test(String(res.error)), String(res.error));
      assert.ok(eventsOf(env, 'error').some((e) => /压缩/.test(e.message)), '应提示需要压缩');
      assert.strictEqual(env.fake.calls.length, 0, '超限不应发出请求');
    });
    await okAsync('压缩关闭时不留请求痕迹，但会话仍可手动压缩', async () => {
      const snap = env.engine.usageOf(env.sessionId);
      assert.strictEqual(snap.usage.level, 'hard');
      assert.ok(snap.usage.percent >= 50);
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }

  // ---------- E. 图片与取消 ----------
  console.log('\nE. 图片上下文与中途取消');
  {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const env = makeEnv({ script: [{ content: '我看到文件名但模型不支持视觉。' }] });
    await env.engine.sendUserMessage({ sessionId: env.sessionId, text: '这张图是什么', images: [{ dataUrl: png, name: 'shot.png' }] });
    await okAsync('图片落盘为会话资源，消息只存引用', async () => {
      const m = messagesOf(env)[0];
      assert.strictEqual(m.images.length, 1);
      assert.ok(m.images[0].file.startsWith(env.sessions.assetsDir), '引用路径必须在 assets 目录内');
      assert.ok(fs.existsSync(m.images[0].file));
      assert.ok(!JSON.stringify(m).includes('iVBORw0'), 'jsonl 不应内联 base64');
    });
    await okAsync('非视觉模型只带文件名说明，不发送像素', async () => {
      const sent = env.fake.calls[0].messages.find((m) => m.role === 'user');
      assert.ok(sent, '应发出含用户消息的请求');
      assert.ok(!sent.images, '不应带 images 字段');
      assert.ok(sent.content.includes('shot.png') && sent.content.includes('不支持图像输入'), sent.content.slice(-160));
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const env = makeEnv({ canVision: true, script: [{ content: '图收到了。' }] });
    await env.engine.sendUserMessage({ sessionId: env.sessionId, text: '看图', images: [{ dataUrl: png, name: 'a.png' }] });
    await okAsync('视觉模型收到 base64 图片', async () => {
      const sent = env.fake.calls[0].messages.find((m) => m.role === 'user');
      assert.ok(Array.isArray(sent.images) && sent.images[0].length > 30, '应带 base64 图片');
      assert.strictEqual(sent.images.length, 1);
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    const env = makeEnv({
      cfg: { approvalMode: 'confirm' },
      script: [
        { content: '要写。', toolCalls: [{ id: 'w1', function: { name: 'write_file', arguments: { path: 'z.md', content: 'z\n' } } }] },
        { content: '不该走到这里', error: '不该走到这里' }
      ]
    });
    const p = env.engine.sendUserMessage({ sessionId: env.sessionId, text: '写文件' });
    await waitFor(() => eventsOf(env, 'approval').length > 0, 1500);
    await env.engine.stop(env.sessionId);
    const res = await p;
    await okAsync('确认环节点停止：补配对结果、取消本轮、不写文件', async () => {
      assert.strictEqual(res.cancelled, true);
      assert.strictEqual(fs.existsSync(path.join(env.project, 'z.md')), false);
      const msgs = messagesOf(env);
      assertPairing(msgs);
      const tool = msgs.find((m) => m.role === 'tool');
      assert.ok(/取消/.test(tool.content), '工具结果应说明取消');
      assert.strictEqual(env.fake.calls.length, 1, '取消后不应再请求模型');
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }

  // ---------- F. 边界与健壮性 ----------
  console.log('\nF. 边界与健壮性');
  {
    const env = makeEnv({ script: [{ content: '越界尝试。', toolCalls: [{ id: 'e1', function: { name: 'write_file', arguments: { path: '../escape.md', content: 'x' } } }] }, { content: '越界失败已知悉。' }] });
    env.engine.setApprovalMode(env.sessionId, 'auto');
    await env.engine.sendUserMessage({ sessionId: env.sessionId, text: '试着越界' });
    await okAsync('越界路径被沙箱拒绝且错误回填给模型', async () => {
      assert.strictEqual(fs.existsSync(path.join(env.tmp, 'escape.md')), false);
      const tool = messagesOf(env).find((m) => m.role === 'tool');
      assert.ok(tool.error === true && /越界|不在项目/.test(tool.content), tool.content);
      assertPairing(messagesOf(env));
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    const env = makeEnv({ script: [{ content: '乱来。', toolCalls: [{ id: 'x1', function: { name: 'no_such_tool', arguments: {} } }] }, { content: '好的。' }] });
    await env.engine.sendUserMessage({ sessionId: env.sessionId, text: '调用不存在的工具' });
    await okAsync('未知工具名回填可用提示且不崩循环', async () => {
      const tool = messagesOf(env).find((m) => m.role === 'tool');
      assert.ok(/未知工具/.test(tool.content));
      assertPairing(messagesOf(env));
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    const env = makeEnv({ files: { 'docs/a.md': '# a\n' }, script: [{ content: '参数是字符串。', toolCalls: [{ id: 's1', function: { name: 'list_directory', arguments: '{"path":"docs"}' } }] }, { content: '完成。' }] });
    await env.engine.sendUserMessage({ sessionId: env.sessionId, text: '兼容字符串参数' });
    await okAsync('模型给出字符串形式 arguments 时自动解析', async () => {
      const tool = messagesOf(env).find((m) => m.role === 'tool');
      assert.ok(!/错误/.test(tool.content), tool.content.slice(0, 80));
      const assistantWithCalls = messagesOf(env).find((m) => m.tool_calls);
      assert.deepStrictEqual(assistantWithCalls.tool_calls[0].function.arguments, { path: 'docs' });
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    const env = makeEnv({ script: [{ content: 'a' }, { content: 'b' }] });
    const p1 = env.engine.sendUserMessage({ sessionId: env.sessionId, text: '第一条' });
    let busyError = null;
    const p2 = env.engine
      .sendUserMessage({ sessionId: env.sessionId, text: '第二条' })
      .catch((err) => {
        busyError = err;
        return { ok: false, error: err.message };
      });
    const [r1, r2] = await Promise.all([p1, p2]);
    await okAsync('同一会话并发请求被拒绝（busy 保护）', async () => {
      assert.ok(r1.ok, '第一条应成功');
      assert.strictEqual(r2.ok, false);
      assert.ok(busyError && /正在处理/.test(busyError.message), String(busyError && busyError.message));
      assert.strictEqual(env.fake.calls.length, 1, '第二条不应发出请求');
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    const env = makeEnv({ script: [] });
    const orphan = env.sessions.create({ projectId: env.proj.id, model: 'fake-model' });
    env.sessions.appendMessage(orphan.id, { role: 'user', content: '历史消息' });
    env.sessions.appendMessage(orphan.id, { role: 'assistant', content: '好的' });
    const before = env.sessions.load(orphan.id).messages.length;
    env.sessions.cutAfter(orphan.id, '1', { inclusive: false });
    await okAsync('截断重来：只保留指定消息之前，派生状态清零', async () => {
      const s = env.sessions.reload(orphan.id);
      assert.strictEqual(s.messages.length, 1);
      assert.strictEqual(s.messages[0].content, '历史消息');
      assert.strictEqual(before, 2);
      assert.ok(!s.state || !s.state.contextState, '截断后不应残留压缩水位');
      const raw = fs.readFileSync(env.paths.sessionFile(orphan.id), 'utf8');
      assert.strictEqual(raw.split('\n').filter(Boolean).length, 2, '重写后文件应为 meta+1 条消息');
    });
    const removed = env.sessions.remove(orphan.id);
    await okAsync('删除会话只删自己的 jsonl', async () => {
      assert.strictEqual(removed.removed, true);
      assert.strictEqual(fs.existsSync(env.paths.sessionFile(orphan.id)), false);
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }
  {
    const env = makeEnv({ script: [{ content: '看目录。', toolCalls: [{ id: 'c1', function: { name: 'tree', arguments: { path: '' } } }] }, { content: '完毕。' }] });
    await env.engine.sendUserMessage({ sessionId: env.sessionId, text: '树' });
    await okAsync('会话可被第二个引擎实例（重启）继续', async () => {
      const sessions2 = new SessionStore({ paths: env.paths });
      const engine2 = new AgentEngine({ paths: env.paths, workspace: env.workspace, sessions: sessions2, shell: env.engine.shell, send: () => {} });
      engine2.client = () => new FakeClient([{ content: '续上了。' }]);
      engine2.setConfig({ ...env.engine.config, chatModel: 'fake-model', ragEnabled: false });
      const msgs0 = sessions2.load(env.sessionId).messages.slice();
      assert.ok(msgs0.length >= 4, '重启后应能读回全部历史');
      const r = await engine2.sendUserMessage({ sessionId: env.sessionId, text: '继续' });
      assert.ok(r.ok && sessions2.load(env.sessionId).messages.length === msgs0.length + 2, `续聊后消息数应为 ${msgs0.length + 2}，实际 ${sessions2.load(env.sessionId).messages.length}（r.ok=${r.ok} ${r.error || ''}）`);
    });
    fs.rmSync(env.tmp, { recursive: true, force: true });
  }

  {
    const { ContextManager, emptyState } = require('../src/main/agent/context');
    const cm = new ContextManager({ numCtx: 8192, summarize: async () => '' });
    const pathsOf = (t) => cm.extractFacts([{ role: 'user', content: t, id: '1' }], emptyState()).filter((f) => f.kind === 'path').map((f) => f.value);
    const bs = String.fromCharCode(92);
    await okAsync('关键事实保住整段路径（盘符 / POSIX / 相对 / UNC），且网址不算路径', async () => {
      const a = pathsOf(`整理 C:${bs}Users${bs}demo${bs}docs 下的 README.md，参考 ./notes/a.md 与 docs/sub/b.md，还有 /var/log/app.log 与 .${bs}local${bs}x.json`);
      assert.ok(a.includes(`C:${bs}Users${bs}demo${bs}docs`), `盘符目录没整段保住：${JSON.stringify(a)}`);
      assert.ok(a.includes('docs/sub/b.md'), `相对路径被截断：${JSON.stringify(a)}`);
      assert.ok(a.includes('./notes/a.md') && a.includes('/var/log/app.log') && a.includes(`.${bs}local${bs}x.json`), JSON.stringify(a));
      const b = pathsOf('比较 输入/输出 比例，文档见 docs/readme.md，网页 https://example.com/a.md 只是链接');
      assert.deepStrictEqual(b, ['docs/readme.md'], JSON.stringify(b));
      const c = pathsOf(`读取 D:${bs}Temp${bs}我的笔记${bs}项目计划.md`);
      assert.ok(c.includes(`D:${bs}Temp${bs}我的笔记${bs}项目计划.md`), JSON.stringify(c));
    });
  }

  if (process.argv.includes('--live')) {
    console.log('\nG. 真实 Ollama 端到端');
    const live = await liveRound();
    await okAsync('真实模型完成一次工具调用与收尾', async () => {
      assert.ok(live.ok, live.error || '本轮失败');
      assert.ok(live.toolCalls >= 1, '应至少调用一次工具');
      assert.ok(live.content && live.content.length > 4, `收尾回答过短：${live.content}`);
      assertPairing(live.messages);
    });
    console.log(`    模型=${live.model} 轮次=${live.rounds} 工具=${live.toolCalls} prompt_tokens=${live.promptTokens} 用时=${live.ms}ms`);
    if (live.tmp) fs.rmSync(live.tmp, { recursive: true, force: true });
  }

  console.log(`\n结果：通过 ${passed}，失败 ${fails.length}`);
  if (fails.length) {
    console.log('失败明细：');
    fails.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✓');
  }
}

function waitFor(cond, ms) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('等待条件超时'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** 真实 Ollama：确认服务在线才跑，否则跳过 */
async function liveRound() {
  const baseUrl = process.env.OLLAMA_BASE || 'http://127.0.0.1:11434';
  const reachable = await new Promise((resolve) => {
    const req = http.get(`${baseUrl}/api/tags`, (res) => resolve(res.statusCode === 200));
    req.on('error', () => resolve(false));
    req.setTimeout(4000, () => {
      req.destroy();
      resolve(false);
    });
  });
  if (!reachable) {
    console.log('    – 跳过：Ollama 未在线（' + baseUrl + '）');
    return { ok: true, skipped: true, messages: [], toolCalls: 0, rounds: 0, content: '', model: '', ms: 0, promptTokens: 0 };
  }
  const model = process.env.OLLAMA_MODEL || 'qwen3-coder:30b';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mreader-live-'));
  const userData = path.join(tmp, 'userData');
  const project = path.join(tmp, 'project');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(project, 'docs', 'note.md'), '# 便签\n\n第一行\n', 'utf8');
  const paths = new DataPaths(userData).init();
  const workspace = new Workspace({ registryFile: path.join(userData, 'agent', 'projects.json') });
  const proj = workspace.add(project, '实测项目');
  const sessions = new SessionStore({ paths });
  const events = [];
  const engine = new AgentEngine({ paths, workspace, sessions, shell: { openPath: async () => {}, showItemInFolder: () => {} }, send: (c, p) => events.push({ channel: c, ...p }) });
  engine.prepareSkills();
  engine.setConfig({ baseUrl, chatModel: model, embeddingModel: '', ragEnabled: false, memoryEnabled: false, skillEnabled: true, approvalMode: 'auto', numCtx: 8192, reserveOutput: 1200, maxToolRounds: 4, temperature: 0.1 });
  const sessionId = sessions.create({ projectId: proj.id, projectName: proj.name, model }).id;
  engine.setApprovalMode(sessionId, 'auto');
  const t = Date.now();
  let res;
  try {
    res = await engine.sendUserMessage({ sessionId, projectId: proj.id, text: '必须调用 tree 工具查看项目文件，然后用一句话告诉我 docs 目录下有什么文件。不要凭空回答。' });
  } catch (err) {
    return { ok: false, error: err.message, messages: sessions.load(sessionId).messages, toolCalls: 0, rounds: 0, content: '', model, ms: Date.now() - t, promptTokens: 0, tmp };
  }
  const msgs = sessions.load(sessionId).messages;
  const asst = msgs.filter((m) => m.role === 'assistant');
  return {
    ok: res.ok,
    rounds: res.rounds,
    toolCalls: res.toolCalls || 0,
    content: asst.length ? asst[asst.length - 1].content : '',
    promptTokens: (msgs.find((m) => m.stats) || {}).stats?.promptTokens || 0,
    messages: msgs,
    model,
    events,
    tmp,
    ms: Date.now() - t
  };
}

main().catch((err) => {
  console.error('自测崩溃：', err);
  process.exitCode = 1;
});
