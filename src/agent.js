"use strict";
// Claude API 에이전트 루프. Electron 메인 프로세스에서 돌고, 화면과는 이벤트로 주고받는다.

const Anthropic = require("@anthropic-ai/sdk");
const { TOOLS, validateInput, IS_WINDOWS, osInfo } = require("./tools");

// 가격: USD / 100만 토큰 (출처: https://platform.claude.com/docs/en/about-claude/pricing, 2026-10 확인)
const MODELS = {
  "claude-opus-5-5": { label: "Opus 5.5 (가장 정확)", input: 4.0, cache_write: 5.0, cache_read: 0.2, output: 20.0 },
  "claude-sonnet-5-5": { label: "Sonnet 5.5 (약 절반 가격)", input: 2.0, cache_write: 2.5, cache_read: 0.2, output: 10.0 },
  "claude-haiku-4-5": { label: "Haiku 4.5 (가장 저렴)", input: 1.0, cache_write: 1.25, cache_read: 0.1, output: 5.0 },
};
const DEFAULT_MODEL = "claude-opus-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]); // 서버측 거절 대체 지원
const EFFORT_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]); // effort / adaptive thinking 지원
const MAX_TOKENS = 64000;

const SYSTEM_PROMPT = `당신은 사용자의 컴퓨터에서 동작하는 문서 작업 도우미입니다.
사용자와 한국어로 대화하며, 작업 폴더 안의 파일을 도구로 읽고, 찾고, 요약하고, 새 문서를 만들고, 기존 문서를 고칩니다.

작업 폴더: {root}
운영체제: {os}

원칙:
- 파일을 고치거나 요약하기 전에 해당 파일을 먼저 읽으세요. 읽지 않은 내용을 추측해서 쓰지 마세요.
- 변경 도구(create_document, replace_in_document, write_file, edit_file, move_file, delete_file, run_command)는 실행 전에 사용자가 승인합니다. 사용자가 거부하고 피드백을 주면 그 피드백을 반영해 방법을 바꾸세요. 같은 작업을 그대로 다시 요청하지 마세요.
- 요청이 모호하거나, 되돌리기 어려운 큰 변경이면 실행 전에 짧게 계획을 말하고 확인을 받으세요.
- 원본 문서를 고칠 때는 사용자가 원본 수정을 원한다고 분명히 하지 않은 이상 replace_in_document의 output_path로 새 파일에 저장하세요.
- 작업이 끝나면 무엇을 했는지와 만든 파일 경로를 짧게 정리하세요. 확인하지 못한 부분은 확인하지 못했다고 말하세요.
- 답변은 간결하게, 마크다운으로 쓰세요.

요약할 때:
- 문서의 목적, 핵심 내용, 일정·금액·대상 같은 구체적 사실, 요청 사항(해야 할 일)을 구분해 정리하세요.
- 숫자, 날짜, 기관명은 원문 그대로 옮기세요.

공문서를 작성할 때 (사용자가 준 양식이나 지시가 있으면 그것을 우선합니다):
- 항목 기호는 1. → 가. → 1) → 가) → (1) → (가) → ① → ㉮ 순서로 씁니다.
- 날짜는 "2026. 10. 5." 처럼 연·월·일 뒤에 마침표를 찍고, 시간은 "14:30" 처럼 씁니다.
- 본문이 끝나면 한 칸 띄우고 "끝."을 씁니다. 붙임이 있으면 "붙임  1. ○○○ 1부." 뒤에 "끝."을 씁니다.
- 금액은 "금113,560원(금일십일만삼천오백육십원)" 처럼 씁니다.
- 기관 양식 파일(.hwpx, .docx)이 있으면 새로 만들지 말고 양식을 복사하는 방식(replace_in_document + output_path)으로 채우세요.
- 한글(.hwp) 파일은 읽기만 가능합니다. 한글 문서로 저장해야 하면 .hwpx로 만드세요.`;

class CostMeter {
  constructor(model) {
    this.setModel(model);
    this.tokens = { input: 0, cache_write: 0, cache_read: 0, output: 0 };
    this.usd = 0;
  }
  setModel(model) {
    this.price = MODELS[model];
  }
  add(usage) {
    const t = {
      input: usage.input_tokens || 0,
      cache_write: usage.cache_creation_input_tokens || 0,
      cache_read: usage.cache_read_input_tokens || 0,
      output: usage.output_tokens || 0,
    };
    let spent = 0;
    for (const k of Object.keys(t)) {
      this.tokens[k] += t[k];
      spent += (t[k] * this.price[k]) / 1e6;
    }
    this.usd += spent;
    return spent;
  }
}

/**
 * onEvent(evt): 화면으로 보낼 이벤트
 *   { type: "status", busy } | { type: "text", text } | { type: "tool_start", id, name }
 *   | { type: "tool_result", id, name, summary, isError, path } | { type: "cost", spent, total, tokens }
 *   | { type: "notice", level, text } | { type: "turn_end" }
 * approve(name, args, preview): Promise<{ approved, always, feedback }>
 */
class Agent {
  constructor({ client, workspace, model = DEFAULT_MODEL, effort = "medium", onEvent, approve }) {
    this.client = client;
    this.ws = workspace;
    this.model = model;
    this.effort = effort;
    this.onEvent = onEvent;
    this.approve = approve;
    this.cost = new CostMeter(model);
    this.messages = [];
    this.interrupted = false;
    this.abort = null;
    this.busy = false;
    // system/tools는 대화 내내 바꾸지 않는다 (프롬프트 캐시 유지)
    this.system = SYSTEM_PROMPT.replace("{root}", workspace.root).replace("{os}", osInfo() + (IS_WINDOWS ? " (명령은 PowerShell)" : ""));
  }

  setOptions({ model, effort }) {
    // 모델이 바뀌면 캐시가 새로 쓰이지만 대화 기록은 이어간다
    if (model && MODELS[model]) {
      this.model = model;
      this.cost.setModel(model);
    }
    if (effort && EFFORTS.includes(effort)) this.effort = effort;
  }

  reset() {
    this.messages = [];
    this.interrupted = false;
  }

  stop() {
    if (this.abort) this.abort.abort();
  }

  requestParams() {
    const params = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: this.system,
      tools: TOOLS,
      messages: this.messages,
      cache_control: { type: "ephemeral" },
    };
    if (EFFORT_MODELS.has(this.model)) {
      params.thinking = { type: "adaptive" };
      params.output_config = { effort: this.effort };
    }
    if (FALLBACK_MODELS.has(this.model)) {
      // 안전 분류기가 요청을 거절하면 서버가 다른 모델로 자동 재시도한다
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    return params;
  }

  /** API 요청 한 번을 스트리밍으로 보내고 최종 메시지를 돌려준다. */
  async streamTurn() {
    for (let attempt = 0; ; attempt++) {
      try {
        const stream = this.client.beta.messages.stream(this.requestParams(), { signal: this.abort.signal });
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            this.onEvent({ type: "text", text: event.delta.text });
          } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
            this.onEvent({ type: "tool_start", id: event.content_block.id, name: event.content_block.name });
          } else if (event.type === "content_block_start" && event.content_block.type === "text") {
            this.onEvent({ type: "text_start" });
          }
        }
        return await stream.finalMessage();
      } catch (e) {
        // 스트리밍된 도구 입력 JSON을 해석하지 못한 경우만 같은 요청을 재시도 (최대 2번)
        if (e instanceof Anthropic.APIError || this.abort.signal.aborted || attempt >= 2) throw e;
        if (!(e instanceof SyntaxError) && !/JSON/i.test(String(e && e.message))) throw e;
        this.onEvent({ type: "notice", level: "info", text: "도구 입력을 해석하지 못해 다시 시도합니다" });
      }
    }
  }

  /** 사용자 메시지 하나를 처리한다 (도구 호출이 끝날 때까지 반복). */
  async send(userText) {
    if (this.busy) return;
    this.busy = true;
    this.abort = new AbortController();
    this.onEvent({ type: "status", busy: true });
    if (this.interrupted) {
      userText = "(직전 작업은 사용자가 중간에 중단했습니다.)\n" + userText;
      this.interrupted = false;
    }
    const turnStart = this.messages.length;
    this.messages.push({ role: "user", content: userText });
    const rollback = () => this.messages.splice(turnStart);
    try {
      for (;;) {
        const message = await this.streamTurn();
        const spent = this.cost.add(message.usage);
        this.onEvent({ type: "cost", spent, total: this.cost.usd, tokens: { ...this.cost.tokens } });

        if (message.stop_reason === "refusal") {
          // 거절된 요청은 기록에서 빼서 다음 대화에 다시 보내지 않는다
          rollback();
          const category = message.stop_details && message.stop_details.category;
          this.onEvent({ type: "notice", level: "error", text: `요청이 안전 정책에 의해 거절되었습니다${category ? ` (분류: ${category})` : ""}. 다르게 요청해 주세요.` });
          return;
        }
        if (message.stop_reason === "pause_turn") {
          this.messages.push({ role: "assistant", content: message.content });
          continue;
        }
        const toolUses = message.content.filter((b) => b.type === "tool_use");
        if (!toolUses.length) {
          this.messages.push({ role: "assistant", content: message.content });
          if (message.stop_reason === "max_tokens") this.onEvent({ type: "notice", level: "warn", text: "응답 길이 한도에 도달해 잘렸습니다. '계속'이라고 입력하면 이어서 작성합니다." });
          return;
        }
        if (message.stop_reason === "max_tokens") {
          rollback();
          this.onEvent({ type: "notice", level: "error", text: "응답이 길이 한도에 걸려 도구 입력이 잘렸습니다. 작업을 더 작게 나눠 요청해 주세요." });
          return;
        }

        const results = [];
        for (const block of toolUses) {
          const problem = validateInput(block.name, block.input);
          if (problem) {
            results.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: `INVALID_INPUT: ${problem}` });
            this.onEvent({ type: "tool_result", id: block.id, name: block.name, detail: toolDetail(block), summary: problem, isError: true });
            continue;
          }
          const r = await this.ws.execute(block.name, block.input, (name, args, preview) => this.approve(name, args, preview), this.abort.signal);
          if (this.abort.signal.aborted) {
            const e = new Error("aborted");
            e.name = "AbortError";
            throw e;
          }
          const text = typeof r.content === "string" ? r.content : r.content.filter((c) => c.type === "text").map((c) => c.text).join(" ");
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
          results.push({ type: "tool_result", tool_use_id: block.id, content: r.content, is_error: r.isError });
        }
        // 어시스턴트 응답과 도구 결과는 항상 한 쌍으로 기록한다
        this.messages.push({ role: "assistant", content: message.content });
        this.messages.push({ role: "user", content: results });
      }
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError || (e && e.name === "AbortError") || this.abort.signal.aborted) {
        // 마지막으로 완성된 지점까지만 남는다. 기록이 사용자 쪽으로 끝나면 다음 입력이 같은 차례로 합쳐진다.
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

/** 화면에 보여줄 도구 대상 (경로, 검색어, 명령) */
function toolDetail(block) {
  const i = block.input || {};
  const d = i.path || i.query || i.command || i.source || i.pattern || "";
  return typeof d === "string" ? d.slice(0, 80) : "";
}

/** 결과 화면에 "열기" 버튼을 붙일 파일 경로 */
function createdPath(block) {
  const i = block.input;
  if (["create_document", "write_file", "edit_file"].includes(block.name)) return i.path;
  if (block.name === "replace_in_document") return i.output_path || i.path;
  return undefined;
}

function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않습니다. 설정에서 키를 다시 입력하세요.";
  if (e instanceof Anthropic.PermissionDeniedError) return `권한 오류: ${e.message}`;
  if (e instanceof Anthropic.RateLimitError) return "요청 한도를 넘었습니다. 잠시 후 다시 시도하세요.";
  if (e instanceof Anthropic.BadRequestError) {
    if (/credit balance/i.test(e.message)) return "API 크레딧이 부족합니다. https://platform.claude.com 에서 충전하세요.";
    return `요청 오류: ${e.message}`;
  }
  if (e instanceof Anthropic.APIConnectionError) return "인터넷 연결을 확인하세요.";
  if (e instanceof Anthropic.APIError) return `API 오류 ${e.status ?? ""}: ${e.message}`;
  return `오류: ${(e && e.message) || e}`;
}

module.exports = { Agent, MODELS, DEFAULT_MODEL, EFFORTS };
