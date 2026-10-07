"use strict";
// Gemini API 에이전트 루프. Agent(src/agent.js)와 같은 인터페이스로 main.js에서 바꿔 끼운다.
// 무료 티어 키로도 쓸 수 있지만, 무료 티어는 입력 내용이 구글의 모델 개선에 쓰일 수 있다.

const { TOOLS, validateInput, IS_WINDOWS, osInfo } = require("./tools");
const { SYSTEM_PROMPT, toolDetail, createdPath } = require("./agent");

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// 가격 표시는 하지 않는다(무료 키가 기본). 모델 이름은 구글이 바꿀 수 있어 설정에서 직접 입력도 받는다.
const GEMINI_MODELS = {
  "gemini-3.8-flash": { label: "Gemini 3.8 Flash (권장)" },
  "gemini-3.5-flash-lite": { label: "Gemini 3.5 Flash-Lite (가장 가볍고 한도 큼)" },
};
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const MAX_OUTPUT_TOKENS = 32000;
const MAX_STEPS = 40; // 도구 호출 반복 상한 (무한 반복·한도 소진 방지)

/** Gemini가 받는 JSON 스키마 부분집합으로 바꾼다. */
function geminiSchema(s) {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "additionalProperties" || k === "default" || k === "$schema") continue;
    out[k] = k === "properties" ? Object.fromEntries(Object.entries(v).map(([n, x]) => [n, geminiSchema(x)])) : geminiSchema(v);
  }
  return out;
}

const FUNCTION_DECLARATIONS = TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.input_schema) }));

class GeminiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class GeminiAgent {
  constructor({ apiKey, workspace, model = DEFAULT_GEMINI_MODEL, onEvent, approve, onModelChange, baseUrl = BASE_URL, fetchImpl }) {
    this.onModelChange = onModelChange;
    this.apiKey = apiKey;
    this.ws = workspace;
    this.model = model;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl || fetch;
    this.onEvent = onEvent;
    this.approve = approve;
    this.cost = { usd: 0, tokens: { input: 0, cache_write: 0, cache_read: 0, output: 0 } };
    this.messages = []; // Gemini contents 형식 { role: "user"|"model", parts }
    this.interrupted = false;
    this.abort = null;
    this.busy = false;
    this.warned = false;
    this.system = SYSTEM_PROMPT.replace("{root}", workspace.root).replace("{os}", osInfo() + (IS_WINDOWS ? " (명령은 PowerShell)" : ""));
  }

  setOptions({ model }) {
    if (model) this.model = model;
  }

  reset() {
    this.messages = [];
    this.interrupted = false;
  }

  stop() {
    if (this.abort) this.abort.abort();
  }

  /** 요청 한 번을 스트리밍으로 보내 모델 응답 parts와 종료 사유를 돌려준다. */
  async streamTurn() {
    const body = {
      systemInstruction: { parts: [{ text: this.system }] },
      contents: this.messages,
      tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    };
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
    const res = await this.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify(body),
      signal: this.abort.signal,
    });
    if (!res.ok) {
      let msg = "";
      try {
        const j = await res.json();
        msg = (j.error && j.error.message) || "";
      } catch { /* 본문 없음 */ }
      throw new GeminiError(res.status, msg);
    }

    const parts = [];
    let finish = null;
    let usage = null;
    let blockedReason = null;
    let textOpen = false;
    const decoder = new TextDecoder();
    let buf = "";
    const handle = (chunk) => {
      if (chunk.promptFeedback && chunk.promptFeedback.blockReason) blockedReason = chunk.promptFeedback.blockReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
      const cand = chunk.candidates && chunk.candidates[0];
      if (!cand) return;
      if (cand.finishReason) finish = cand.finishReason;
      for (const part of (cand.content && cand.content.parts) || []) {
        if (part.thought && part.text !== undefined) continue; // 생각 요약은 화면에 보이지 않는다
        if (part.text !== undefined && !part.functionCall) {
          if (!textOpen) {
            this.onEvent({ type: "text_start" });
            textOpen = true;
          }
          if (part.text) this.onEvent({ type: "text", text: part.text });
        } else if (part.functionCall) {
          textOpen = false;
          this.onEvent({ type: "tool_start", id: part.functionCall.id || `call_${parts.length}`, name: part.functionCall.name });
        }
        parts.push(part);
      }
    };
    for await (const value of res.body) {
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, "");
        const data = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
        if (data && data !== "[DONE]") handle(JSON.parse(data));
      }
    }
    if (buf.trim().startsWith("data:")) {
      const data = buf.trim().slice(5).trim();
      if (data) handle(JSON.parse(data));
    }
    return { parts: mergeText(parts), finish, usage, blockedReason };
  }

  /** 사용자 메시지 하나를 처리한다 (도구 호출이 끝날 때까지 반복). */
  async send(userText) {
    if (this.busy) return;
    this.busy = true;
    this.abort = new AbortController();
    this.onEvent({ type: "status", busy: true });
    if (!this.warned) {
      this.warned = true;
      this.onEvent({ type: "notice", level: "warn", text: "Gemini 무료 키는 입력한 내용이 구글의 모델 개선에 쓰일 수 있습니다. 공개해도 되는 문서에만 쓰세요." });
    }
    if (this.interrupted) {
      userText = "(직전 작업은 사용자가 중간에 중단했습니다.)\n" + userText;
      this.interrupted = false;
    }
    const turnStart = this.messages.length;
    this.messages.push({ role: "user", parts: [{ text: userText }] });
    const rollback = () => this.messages.splice(turnStart);
    let switched = false;
    try {
      for (let step = 0; ; step++) {
        if (step >= MAX_STEPS) {
          this.onEvent({ type: "notice", level: "warn", text: `도구를 ${MAX_STEPS}번 쓰고 멈췄습니다. 이어서 하려면 '계속'이라고 입력하세요.` });
          return;
        }
        let turn;
        try {
          turn = await this.streamTurn();
        } catch (e) {
          // 구글이 모델 이름을 바꿨으면(예: "use models/gemini-3.8-flash") 안내된 모델로 한 번 바꿔서 다시 시도한다
          const next = e instanceof GeminiError && e.status === 404 && /models\/([\w.\-]+)/.exec((e.message || "").replace(/This model models\/[\w.\-]+/, ""));
          if (!next || next[1] === this.model || switched) throw e;
          switched = true;
          this.model = next[1];
          if (this.onModelChange) this.onModelChange(this.model);
          this.onEvent({ type: "notice", level: "info", text: `모델 이름이 바뀌어 ${this.model}(으)로 자동 전환했습니다.` });
          step--;
          continue;
        }
        const u = turn.usage || {};
        const t = { input: u.promptTokenCount || 0, cache_write: 0, cache_read: u.cachedContentTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) };
        for (const k of Object.keys(t)) this.cost.tokens[k] += t[k];
        this.onEvent({ type: "cost", spent: 0, total: 0, tokens: { ...this.cost.tokens } });

        if (turn.blockedReason || turn.finish === "SAFETY" || turn.finish === "PROHIBITED_CONTENT") {
          rollback();
          this.onEvent({ type: "notice", level: "error", text: "요청이 안전 정책에 의해 거절되었습니다. 다르게 요청해 주세요." });
          return;
        }
        const calls = turn.parts.filter((p) => p.functionCall);
        if (!calls.length) {
          if (!turn.parts.length) {
            rollback();
            this.onEvent({ type: "notice", level: "error", text: "모델이 빈 응답을 보냈습니다. 다시 시도해 주세요." });
            return;
          }
          this.messages.push({ role: "model", parts: turn.parts });
          if (turn.finish === "MAX_TOKENS") this.onEvent({ type: "notice", level: "warn", text: "응답 길이 한도에 도달해 잘렸습니다. '계속'이라고 입력하면 이어서 작성합니다." });
          return;
        }
        if (turn.finish === "MAX_TOKENS") {
          rollback();
          this.onEvent({ type: "notice", level: "error", text: "응답이 길이 한도에 걸려 도구 입력이 잘렸습니다. 작업을 더 작게 나눠 요청해 주세요." });
          return;
        }

        const responses = [];
        const extra = []; // pdf·이미지 원본은 함수 응답이 아니라 별도 부분으로 붙인다
        for (let i = 0; i < calls.length; i++) {
          const fc = calls[i].functionCall;
          const block = { id: fc.id || `call_${i}`, name: fc.name, input: fc.args || {} };
          const respond = (output, isError) => {
            const response = isError ? { error: output } : { output };
            const part = { functionResponse: { name: fc.name, response } };
            if (fc.id) part.functionResponse.id = fc.id;
            responses.push(part);
          };
          const problem = validateInput(block.name, block.input);
          if (problem) {
            respond(`INVALID_INPUT: ${problem}`, true);
            this.onEvent({ type: "tool_result", id: block.id, name: block.name, detail: toolDetail(block), summary: problem, isError: true });
            continue;
          }
          const r = await this.ws.execute(block.name, block.input, (name, args, preview) => this.approve(name, args, preview), this.abort.signal);
          if (this.abort.signal.aborted) {
            const e = new Error("aborted");
            e.name = "AbortError";
            throw e;
          }
          const text = flattenResult(r.content, extra);
          this.onEvent({
            type: "tool_result",
            id: block.id,
            name: block.name,
            detail: toolDetail(block),
            summary: text.split("\n")[0].slice(0, 160),
            isError: r.isError,
            rejected: !!r.rejected,
            path: !r.isError ? createdPath(block) : undefined,
          });
          respond(text, r.isError);
        }
        // 모델 응답(생각 서명 포함)과 도구 결과는 항상 한 쌍으로 기록한다
        this.messages.push({ role: "model", parts: turn.parts });
        this.messages.push({ role: "user", parts: [...responses, ...extra] });
      }
    } catch (e) {
      if ((e && e.name === "AbortError") || (this.abort && this.abort.signal.aborted)) {
        this.interrupted = this.messages.length > turnStart + 1;
        if (!this.interrupted) rollback();
        this.onEvent({ type: "notice", level: "warn", text: "중단했습니다." });
      } else {
        rollback();
        this.onEvent({ type: "notice", level: "error", text: describeError(e) });
      }
    } finally {
      this.busy = false;
      this.abort = null;
      this.onEvent({ type: "turn_end" });
      this.onEvent({ type: "status", busy: false });
    }
  }
}

/** 이어지는 text 조각을 하나로 합친다 (기록을 작게 유지). 서명이 붙은 조각은 그대로 둔다. */
function mergeText(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    const plain = (x) => x && x.text !== undefined && !x.functionCall && !x.thoughtSignature && !x.thought;
    if (plain(p) && plain(last)) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

/** 도구 결과(Anthropic 형식)를 글자로 바꾸고, pdf·이미지는 extra에 inlineData로 모은다. */
function flattenResult(content, extra) {
  if (typeof content === "string") return content;
  const texts = [];
  for (const c of content || []) {
    if (c.type === "text") texts.push(c.text);
    else if ((c.type === "image" || c.type === "document") && c.source && c.source.type === "base64") {
      extra.push({ inlineData: { mimeType: c.source.media_type, data: c.source.data } });
      texts.push(`(${c.type === "image" ? "이미지" : "문서"} 원본을 아래에 첨부했습니다)`);
    }
  }
  return texts.join("\n");
}

function describeError(e) {
  if (e instanceof GeminiError) {
    const m = e.message || "";
    if (e.status === 400 && /API key/i.test(m)) return "Gemini API 키가 올바르지 않습니다. 설정에서 키를 다시 입력하세요.";
    if (e.status === 401 || e.status === 403) return `Gemini 키 권한 오류: ${m || e.status}. 키가 맞는지, 학교 계정이라 막힌 건 아닌지 확인하세요.`;
    if (e.status === 404) return `모델을 찾을 수 없습니다: ${m}. 설정에서 모델을 바꿔 보세요.`;
    if (e.status === 429) return "무료 한도를 넘었습니다. 1분쯤 기다렸다 다시 시도하거나, 더 가벼운 모델(Flash-Lite)로 바꿔 보세요.";
    if (e.status >= 500) return "Gemini 서버가 잠시 불안정합니다. 잠시 후 다시 시도하세요.";
    return `Gemini 요청 오류 ${e.status}: ${m}`;
  }
  if (e && (e.name === "TypeError" || e.code === "ECONNRESET")) {
    const why = (e.cause && (e.cause.code || e.cause.message)) || e.message || "";
    return `Gemini 서버와 연결하지 못했습니다${why ? ` (${why})` : ""}. 인터넷 연결을 확인하고 다시 시도하세요.`;
  }
  return `오류: ${(e && e.message) || e}`;
}

module.exports = { GeminiAgent, GEMINI_MODELS, DEFAULT_GEMINI_MODEL, geminiSchema };
