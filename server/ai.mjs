/**
 * server/ai.mjs — Gemini 后台代理（零 npm 依赖）。
 *
 * ## 为什么不用 @google/genai
 * 官方 JS SDK 解包 11.11 MB，而本项目只需要 1 个端点 + 3 个参数。用 Node 内置的
 * `fetch` 直连 REST，与本项目"后台零运行时依赖"的架构一致，也不必把 11MB 塞进
 * 依赖树。
 *
 * ## 依据（全部来自官方文档原文，经本机代理抓取，非记忆）
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   header: x-goog-api-key: $GEMINI_API_KEY
 *   header: Api-Revision: 2026-05-20
 *   body:   { model, input, stream, system_instruction, thinking_level, response_format }
 *   input:  "文本" | [{ type:'text', text } | { type:'image', data:<base64>, mime_type }]
 *   SSE:    event: step.delta → data: { delta: { type:'text', text } } … interaction.completed
 *   JSON:   { response_format: { type:'text', mime_type:'application/json', schema } }
 *
 * 注意几个**已变更**的点（写错就跑不起来）：
 *   · 现行是 Interactions API，不是 generateContent
 *   · temperature / top_p / top_k 已删除；思考强度用 thinking_level: minimal|low|medium|high
 *   · 现行模型名是 gemini-3.8-flash 这一代，gemini-2.5-* / 1.5-* 已废弃
 *
 * ## 安全边界
 * 密钥只在本模块内从环境变量/配置文件读取，**绝不出现在任何 HTTP 响应里**
 * （见 config.mjs 的 publicConfig()）。浏览器只能通过本代理间接使用 AI。
 */

import { readConfig, resolveApiKey } from './config.mjs';

/* ------------------------------------------------------------- 任务定义 --- */

const ONLY_LATEX = '只输出 LaTeX 公式本体，不要 $ 或 $$ 定界符，不要代码围栏，不要任何解释。';
const ONLY_MARKDOWN = '只输出应当写入文档的 Markdown 片段本身，不要代码围栏，不要解释你在做什么。';

/**
 * 五项能力。stream 表示走流式（长文本、边生成边显示）；
 * 非流式的两项刻意用**结构化输出**换取可靠性（要"一键替换"，就必须只有一个确定答案）。
 */
export const AI_TASKS = {
  complete: {
    id: 'complete',
    label: '智能补全',
    stream: true,
    maxInput: 24000,
    system: `你是严谨的数学写作助手，帮助作者续写 Markdown + LaTeX 文档。
规则：
- 严格延续作者的记号、术语与语气；中文文本用中文，英文用英文。
- 数学公式用 $...$（行内）与 $$...$$（行间）；不要改写已有内容。
- ${ONLY_MARKDOWN}
- 只写一小段（最多 2~3 句或一个公式），够接上就行，不要长篇大论。`,
  },
  formula: {
    id: 'formula',
    label: '文本转公式',
    stream: true,
    maxInput: 4000,
    system: `你是 LaTeX 公式专家。把用户的中文/英文描述转写成**规范的 LaTeX 数学表达式**。
规则：
- 使用标准宏包可用的命令（amsmath / amssymb 范围内）。
- 多字母变量用 \\mathit{} 或 \\mathrm{}；函数名用 \\operatorname{} 或标准命令（\\sin, \\log, \\lim…）。
- 矩阵用 pmatrix/bmatrix，分段函数用 cases，多行推导用 aligned。
- ${ONLY_LATEX}`,
  },
  polish: {
    id: 'polish',
    label: '润色',
    stream: true,
    maxInput: 12000,
    system: `你是中文/英文技术文档编辑。润色用户给出的 Markdown 片段。
规则：
- 修正错别字、语病、标点与中英文间距；让表达更准确、更简洁。
- **保持全部数学公式原样**（除非公式本身写错），保持 Markdown 结构（标题层级、列表、表格、容器语法）。
- 不要增删事实性内容，不要加入"以下是润色后的版本"之类的话。
- ${ONLY_MARKDOWN}`,
  },
  image: {
    id: 'image',
    label: '截图转公式',
    stream: false, // 结构化输出：必须给出可直接插入的确定结果
    system: `你是公式识别专家。识别图片中的数学公式，转写成可编辑的 LaTeX。
规则：
- 只转写图片里的公式内容，忽略题号、页眉页脚、无关正文。
- 保留公式中的中文（用 \\text{中文} 包裹）。
- 判断应作为行内还是行间公式，填到 display 字段。
- 若图片中没有可识别的公式，latex 留空字符串并在 note 里说明原因。`,
    schema: {
      type: 'object',
      properties: {
        latex: { type: 'string', description: 'LaTeX 公式本体，不含 $ 定界符' },
        display: { type: 'boolean', description: 'true 表示应作为行间公式（$$...$$）' },
        note: { type: 'string', description: '可选的说明或不确定之处' },
      },
      required: ['latex', 'display'],
    },
  },
  fix: {
    id: 'fix',
    label: '公式纠错',
    stream: false, // 结构化输出：要"一键替换"，就得有唯一确定答案
    system: `你是 KaTeX 语法专家。用户会给你一段**渲染失败**的 LaTeX 与 KaTeX 的报错信息。
规则：
- 给出修正后的 LaTeX，使其能被 KaTeX 成功渲染（注意：KaTeX 只支持 amsmath 子集，
  不支持 \\begin{equation}、\\label、\\def、tikz、\\usepackage 等）。
- 尽量保留原意，只改必要的部分。
- explanation 用一句中文说明错在哪、怎么改。`,
    schema: {
      type: 'object',
      properties: {
        fixed: { type: 'string', description: '修正后的 LaTeX 本体，不含 $ 定界符' },
        explanation: { type: 'string', description: '一句中文说明' },
        impossible: { type: 'boolean', description: '若 KaTeX 根本无法表达，置 true' },
      },
      required: ['fixed', 'explanation'],
    },
  },
};

/* --------------------------------------------------------------- 状态 --- */

export function aiStatus() {
  const c = readConfig();
  const key = resolveApiKey();
  const mock = Boolean(c.ai.mock) || process.env.MDP_AI_MOCK === '1';
  return {
    enabled: Boolean(c.ai.enabled),
    ready: Boolean(c.ai.enabled) && (Boolean(key) || mock),
    mock,
    hasKey: Boolean(key),
    keySource: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? 'env' : (c.ai.apiKey ? 'config' : null),
    model: c.ai.model,
    thinkingLevel: c.ai.thinkingLevel,
    baseUrl: c.ai.baseUrl,
    tasks: c.ai.tasks,
  };
}

export class AiError extends Error {
  constructor(message, { status = 500, retryable = false, detail = null } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.detail = detail;
  }
}

/* ----------------------------------------------------------- 单次调用 --- */

/**
 * 调一次 Interactions API。
 * @param {{input:any, task:object, stream?:boolean, signal?:AbortSignal}} o
 * @returns {Promise<{res:Response}>} 原始响应（由调用方决定怎么消费）
 */
async function callInteraction({ input, task, stream, signal, model, thinkingLevel, baseUrl, apiKey }) {
  const body = {
    model,
    input,
    ...(stream ? { stream: true } : {}),
    ...(task.system ? { system_instruction: task.system } : {}),
    ...(thinkingLevel ? { thinking_level: thinkingLevel } : {}),
    ...(task.schema && !stream
      ? { response_format: { type: 'text', mime_type: 'application/json', schema: task.schema } }
      : {}),
  };
  const url = `${baseUrl.replace(/\/$/, '')}/interactions`;
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
      'Api-Revision': '2026-05-20',
    },
    body: JSON.stringify(body),
    signal,
  });
}

/** 把 HTTP 错误翻译成人能看懂的提示。 */
async function describeHttpError(res, model) {
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  let apiMessage = '';
  try {
    const j = JSON.parse(text);
    apiMessage = j?.error?.message || j?.message || '';
  } catch { apiMessage = text.slice(0, 400); }

  if (res.status === 401 || res.status === 403) {
    return new AiError('Gemini API 拒绝了这个密钥（401/403）。请在设置里检查密钥是否有效、是否启用了 Generative Language API。',
      { status: 401, detail: apiMessage });
  }
  if (res.status === 404) {
    return new AiError(`模型 ${model} 不存在或该密钥无权访问（404）。现行模型名形如 gemini-3.8-flash / gemini-3.1-pro-preview。`,
      { status: 404, detail: apiMessage });
  }
  if (res.status === 429) {
    return new AiError('触发配额限制（429）。稍后重试，或在设置里换用更轻的模型（如 gemini-3.5-flash-lite）。',
      { status: 429, retryable: true, detail: apiMessage });
  }
  if (res.status >= 500) {
    return new AiError(`Gemini 服务端错误（${res.status}），已重试仍然失败。`, { status: 502, retryable: true, detail: apiMessage });
  }
  return new AiError(`Gemini 请求失败（HTTP ${res.status}）`, { status: 502, detail: apiMessage });
}

/* ------------------------------------------------- text 提取 / SSE 解析 --- */

/** 从非流式响应里取出文本（兼容 output_text 便捷字段与 steps 结构）。 */
export function extractText(json) {
  if (!json) return '';
  if (typeof json.output_text === 'string') return json.output_text;
  const steps = json.steps || json.interaction?.steps || [];
  let out = '';
  for (const s of steps) {
    if (s?.type !== 'model_output') continue;
    for (const c of s.content || []) {
      if (c?.type === 'text' && typeof c.text === 'string') out += c.text;
    }
  }
  return out;
}

/**
 * 解析官方 SSE 流，产出增量事件。
 * @param {ReadableStream} body
 * @param {(evt:{type:string,text?:string,raw?:any})=>void} onEvent
 */
export async function parseSseStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let sawText = false;

  const handleBlock = (block) => {
    let eventName = '';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let payload;
    try { payload = JSON.parse(dataLines.join('\n')); } catch { return; }

    const type = payload.event_type || eventName;
    if (type === 'step.delta' && payload.delta?.type === 'text' && typeof payload.delta.text === 'string') {
      sawText = true;
      onEvent({ type: 'delta', text: payload.delta.text, raw: payload });
    } else if (type === 'step.delta' && payload.delta?.type === 'thought_summary') {
      onEvent({ type: 'thinking', text: String(payload.delta.text || ''), raw: payload });
    } else if (type === 'interaction.completed') {
      onEvent({ type: 'completed', raw: payload.interaction || payload });
    } else if (type === 'interaction.failed' || payload.error) {
      onEvent({ type: 'failed', raw: payload });
    } else if (type === 'interaction.created' || type === 'step.start' || type === 'step.stop' || type === 'interaction.status_update') {
      onEvent({ type, raw: payload });
    } else {
      onEvent({ type: type || 'unknown', raw: payload });
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.trim()) handleBlock(block);
    }
  }
  if (buf.trim()) handleBlock(buf);
  return { sawText };
}

/* --------------------------------------------------------- 提示词组装 --- */

function buildInput(taskId, params = {}) {
  switch (taskId) {
    case 'complete': {
      const { before = '', after = '', docTitle = '' } = params;
      return [
        docTitle ? `文档标题：${docTitle}` : '',
        '以下是文档中光标之前的内容（末尾即光标位置）：',
        '<<<BEFORE',
        before,
        'BEFORE',
        after ? '以下是光标之后的内容（供你参考，不要重复它）：\n<<<AFTER\n' + after + '\nAFTER' : '',
        '请给出应当插入到光标位置的续写内容。',
      ].filter(Boolean).join('\n');
    }
    case 'formula':
      return `把下面的描述转写成 LaTeX 数学表达式：\n\n${params.text || ''}`;
    case 'polish':
      return `请润色下面这段 Markdown（保持公式与结构）：\n\n<<<TEXT\n${params.text || ''}\nTEXT`;
    case 'image': {
      const input = [{ type: 'text', text: '识别这张截图中的数学公式并转成 LaTeX。' }];
      if (params.image) {
        input.push({ type: 'image', data: params.image, mime_type: params.mimeType || 'image/png' });
      }
      return input;
    }
    case 'fix':
      return [
        '下面这段 LaTeX 在 KaTeX 中渲染失败：',
        '<<<TEX',
        params.tex || '',
        'TEX',
        'KaTeX 报错信息：',
        params.error || '(未提供具体报错)',
        params.context ? `它所在的上下文片段：\n${String(params.context).slice(0, 800)}` : '',
        '请给出修正后的 LaTeX。',
      ].filter(Boolean).join('\n');
    default:
      throw new AiError(`未知 AI 任务：${taskId}`, { status: 400 });
  }
}

/* ----------------------------------------------------------------- 假模式 --- */

/**
 * mock 模式：没有密钥也能把「后台 SSE → 前端流式渲染 → 一键替换」整条链路跑通并测到。
 * 它走的是与真实调用**同一套事件形状**，因此 E2E 测试是有意义的。
 */
async function* mockStream(taskId, params) {
  const canned = {
    complete: ' 其中 $A$ 为对称矩阵，$\\beta\\in\\mathbb R^n$。',
    formula: '\\nabla f(x)=Ax+\\beta,\\qquad A=A^{\\mathsf T}',
    polish: String(params.text || '').trim().replace(/\s+/g, ' ') + '（已润色）',
  }[taskId] ?? '（mock）';
  const chunks = canned.match(/[\s\S]{1,8}/g) || [canned];
  for (const c of chunks) {
    await new Promise((r) => setTimeout(r, 18));
    yield { type: 'delta', text: c };
  }
  yield { type: 'completed', usage: { total_tokens: canned.length } };
}

function mockStructured(taskId, params) {
  if (taskId === 'image') {
    return { latex: '\\int_{0}^{1} x^{2}\\,\\mathrm{d}x=\\frac{1}{3}', display: true, note: '（mock 识别结果）' };
  }
  if (taskId === 'fix') {
    return {
      fixed: String(params.tex || '\\frac{a}{b}').replace(/\\d?frac\{([^}]*)\}\{?([^}]*)\}?/, '\\frac{$1}{$2}'),
      explanation: '（mock）已把非法的分数写法修正为 \\frac{分子}{分母}。',
      impossible: false,
    };
  }
  return { text: '（mock）' };
}

/* ------------------------------------------------------------ 对外接口 --- */

/**
 * 请求前置校验：**必须在写 SSE 响应头之前调用**。
 *
 * 否则「未启用 / 密钥缺失 / 输入超长」这类错误只能在已经发出的 200 流里以事件形式
 * 告知前端，HTTP 状态码全成了 200，客户端逻辑与服务端日志都会被误导。
 * 校验通过之后，流式过程中的真实失败仍只能走 in-band 的 error 事件——HTTP 头已经
 * 发出，这是 SSE 协议决定的，无法避免。
 *
 * @throws {AiError}
 */
export function preflightAi(taskId, params = {}) {
  const task = AI_TASKS[taskId];
  if (!task) throw new AiError(`未知 AI 任务：${taskId}`, { status: 404 });

  const status = aiStatus();
  if (!status.enabled) {
    throw new AiError('AI 功能未启用。在「设置 → AI」里打开，或设置环境变量 GEMINI_API_KEY 后重启。', { status: 409 });
  }
  if (status.tasks && status.tasks[taskId] === false) {
    throw new AiError(`「${task.label}」已被单独关闭。`, { status: 409 });
  }
  if (!status.hasKey && !status.mock) {
    throw new AiError('未配置 Gemini API 密钥。在「设置 → AI」里填入，或导出 GEMINI_API_KEY 环境变量后重启后台。',
      { status: 409 });
  }
  // 输入长度护栏：超长请求会让延迟与费用失控
  const raw = typeof params.text === 'string' ? params.text
    : typeof params.before === 'string' ? params.before : '';
  if (task.maxInput && raw.length > task.maxInput) {
    throw new AiError(`输入过长（${raw.length} 字符 > 上限 ${task.maxInput}）。请缩小选区。`, { status: 413 });
  }
  if (taskId === 'image' && !params.image) {
    throw new AiError('缺少图片数据（image 字段应为 base64）。', { status: 400 });
  }
  if (taskId === 'fix' && !params.tex) {
    throw new AiError('缺少待修正的 LaTeX（tex 字段）。', { status: 400 });
  }
  return { task, status };
}

/**
 * 执行一个 AI 任务。
 * @param {string} taskId
 * @param {object} params
 * @param {{onEvent:(e:object)=>void, signal?:AbortSignal}} io
 * @returns {Promise<{text?:string, structured?:object, model:string, mock:boolean, usage?:object}>}
 */
export async function runTask(taskId, params, io = {}) {
  // 二次校验：本函数也可能被 CLI / 内部直接调用，不能只依赖路由层
  const { task, status } = preflightAi(taskId, params);
  const mock = status.mock;
  const input = buildInput(taskId, params);

  if (task.stream) {
    if (mock) {
      let acc = '';
      for await (const ev of mockStream(taskId, params)) {
        if (ev.type === 'delta') acc += ev.text;
        io.onEvent?.({ ...ev, mock: true });
      }
      return { text: acc, model: `${status.model} (mock)`, mock: true };
    }
    return await streamTask({ task, taskId, input, status, io });
  }

  if (mock) {
    const structured = mockStructured(taskId, params);
    io.onEvent?.({ type: 'completed', structured, mock: true });
    return { structured, model: `${status.model} (mock)`, mock: true };
  }
  return await structuredTask({ task, taskId, input, status, io });
}

/** 流式：把官方 SSE 逐段转发给前端。 */
async function streamTask({ task, input, status, io }) {
  const attempt = async () => {
    const res = await callInteraction({
      input, task, stream: true, signal: io.signal,
      model: status.model, thinkingLevel: status.thinkingLevel, baseUrl: status.baseUrl, apiKey: resolveApiKey(),
    });
    if (!res.ok) throw await describeHttpError(res, status.model);
    let acc = '';
    let usage = null;
    await parseSseStream(res.body, (ev) => {
      if (ev.type === 'delta') acc += ev.text;
      if (ev.type === 'completed') usage = ev.raw?.usage || null;
      io.onEvent?.(ev);
    });
    return { text: acc, usage };
  };
  const out = await withRetry(attempt, io.signal);
  return { ...out, model: status.model, mock: false };
}

/** 非流式：结构化输出，取 JSON。 */
async function structuredTask({ task, input, status, io }) {
  const attempt = async () => {
    const res = await callInteraction({
      input, task, stream: false, signal: io.signal,
      model: status.model, thinkingLevel: status.thinkingLevel, baseUrl: status.baseUrl, apiKey: resolveApiKey(),
    });
    if (!res.ok) throw await describeHttpError(res, status.model);
    const json = await res.json();
    const text = extractText(json);
    let structured = null;
    if (text) {
      try { structured = JSON.parse(text); } catch { structured = null; }
    }
    // 某些实现会把结构化结果放在 steps 的 content 里；退化路径保证不至于全空
    if (!structured) structured = { raw: text };
    return { structured, usage: json.usage || null, text };
  };
  const out = await withRetry(attempt, io.signal);
  io.onEvent?.({ type: 'completed', structured: out.structured });
  return { ...out, model: status.model, mock: false };
}

/** 429/5xx 指数退避重试（最多 3 次）。 */
async function withRetry(fn, signal, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (signal?.aborted) throw err;
      const retryable = err?.retryable || err?.name === 'TypeError' /* fetch 网络错误 */;
      if (!retryable || i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, 600 * 2 ** i));
    }
  }
  throw lastErr;
}
