'use strict';

/**
 * Ollama 本地服务端客户端（仅依赖 Node 内置 fetch，Electron 主进程原生可用）
 *
 * 实测接口形态（Ollama 0.40.6）：
 *   GET  /api/tags    -> { models: [{ name, details:{parameter_size,quantization_level,context_length},
 *                                     capabilities: ["completion","vision","tools","thinking"] , size, modified_at }] }
 *   POST /api/embed   -> { model, embeddings: [[...], ...] }（nomic-embed-text 768 维，实测可用）
 *   POST /api/chat    -> NDJSON 流：每行 { message:{role,content,tool_calls?}, done, done_reason,
 *                                         prompt_eval_count, eval_count, total_duration, load_duration }
 *                        tool_calls[].function = { name, arguments: <对象> }（实测直接给出对象，非字符串）
 *
 * 注意：Ollama 不传 options.num_ctx 时默认只有 4096，并且从 prompt 开头静默截断
 * （system 与工具 schema 会先被丢掉且不报错），因此这里始终显式下发 num_ctx。
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

class OllamaClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 300000 } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async request(pathname, { method = 'GET', body, signal, timeoutMs } = {}) {
    const controller = new AbortController();
    const ms = timeoutMs || this.timeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(`请求超时（${ms}ms）`)), ms);
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Ollama ${pathname} 返回 ${res.status}${text ? `：${text.slice(0, 300)}` : ''}`);
      }
      return res;
    } catch (err) {
      const cause = err && err.cause && err.cause.cause ? `（${err.cause.cause.message || err.cause.cause.code}）` : '';
      if (err.name === 'AbortError') throw new Error(`已取消或超时${cause}`);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|could not be found/i.test(String(err.message) + cause)) {
        throw new Error(`无法连接 Ollama 服务端 ${this.baseUrl}。请确认已安装并启动（命令行执行 ollama serve）。${cause}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async getVersion() {
    const res = await this.request('/api/version', { timeoutMs: 8000 });
    return (await res.json()).version || '';
  }

  /** 列出模型并归一化为 UI 需要的形态 */
  async listModels() {
    const res = await this.request('/api/tags', { timeoutMs: 20000 });
    const data = await res.json();
    return (data.models || []).map((m) => {
      const caps = m.capabilities || [];
      const family = (m.details && (m.details.family || (m.details.families || [])[0])) || '';
      const isEmbed = caps.includes('embedding') || family.includes('embed') || /embed/i.test(m.name);
      return {
        name: m.name,
        size: m.size || 0,
        parameterSize: (m.details && m.details.parameter_size) || '',
        quantization: (m.details && m.details.quantization_level) || '',
        contextLength: (m.details && m.details.context_length) || 0,
        family,
        capabilities: caps,
        canChat: !isEmbed && (caps.length ? caps.includes('completion') : true),
        canTools: caps.includes('tools'),
        canVision: caps.includes('vision'),
        canThinking: caps.includes('thinking'),
        isEmbedding: isEmbed,
        modifiedAt: m.modified_at || ''
      };
    });
  }

  /** 文本向量化：/api/embed 支持批量 */
  async embed(input, model) {
    const arr = Array.isArray(input) ? input : [input];
    const res = await this.request('/api/embed', { method: 'POST', body: { model, input: arr } });
    const data = await res.json();
    const vectors = data.embeddings || [];
    if (!vectors.length) throw new Error(`嵌入模型 ${model} 未返回向量`);
    return vectors;
  }

  /**
   * 流式对话。回调 onEvent 收到 {type,...}：
   *   text / reasoning / tool_calls / done(stats) / error
   * 返回聚合结果 { content, reasoning, toolCalls, stats }
   */
  async chat({ model, messages, tools, options = {}, think, format, signal, onEvent = () => {} }) {
    const body = {
      model,
      messages,
      stream: true,
      options: {
        temperature: options.temperature ?? 0.3,
        top_p: options.top_p ?? 0.9,
        num_ctx: options.num_ctx || 8192,
        num_predict: options.num_predict ?? -1,
        ...(options.seed ? { seed: options.seed } : {})
      }
    };
    if (tools && tools.length) body.tools = tools;
    if (think !== undefined) body.think = think;
    if (format) body.format = format;

    const res = await this.request('/api/chat', { method: 'POST', body, signal });
    if (!res.body) throw new Error('Ollama 未返回可读取的响应流');

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    let reasoning = '';
    let toolCalls = null;
    let stats = null;

    const handle = (chunk) => {
      if (chunk.error) {
        const e = new Error(chunk.error);
        onEvent({ type: 'error', error: e });
        throw e;
      }
      const msg = chunk.message || {};
      if (msg.tool_calls && msg.tool_calls.length) {
        toolCalls = msg.tool_calls;
        onEvent({ type: 'tool_calls', toolCalls });
      }
      if (msg.reasoning) {
        reasoning += msg.reasoning;
        onEvent({ type: 'reasoning', delta: msg.reasoning });
      }
      if (msg.content) {
        content += msg.content;
        onEvent({ type: 'text', delta: msg.content });
      }
      if (chunk.done) {
        stats = {
          promptTokens: chunk.prompt_eval_count || 0,
          evalTokens: chunk.eval_count || 0,
          loadMs: Math.round((chunk.load_duration || 0) / 1e6),
          totalMs: Math.round((chunk.total_duration || 0) / 1e6)
        };
        onEvent({ type: 'done', stats, content, reasoning });
      }
    };

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handle(JSON.parse(line));
      }
    }
    if (buffer.trim()) handle(JSON.parse(buffer.trim()));
    return { content, reasoning, toolCalls, stats };
  }
}

module.exports = { OllamaClient, DEFAULT_BASE_URL };
