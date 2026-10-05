"use strict";
/* global marked, DOMPurify */

const api = window.api;
const $ = (id) => document.getElementById(id);

const TOOL_LABELS = {
  list_files: "파일 목록",
  read_file: "읽기",
  search_files: "검색",
  create_document: "문서 만들기",
  replace_in_document: "문서 고치기",
  write_file: "파일 저장",
  edit_file: "파일 수정",
  move_file: "이동",
  delete_file: "삭제",
  run_command: "명령 실행",
};

const els = {
  scroller: $("scroller"),
  conversation: $("conversation"),
  welcome: $("welcome"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  attachBtn: $("attachBtn"),
  fileInput: $("fileInput"),
  attachments: $("attachments"),
  workspaceBtn: $("workspaceBtn"),
  workspaceLabel: $("workspaceLabel"),
  openFolderBtn: $("openFolderBtn"),
  modelSelect: $("modelSelect"),
  costLabel: $("costLabel"),
  newChatBtn: $("newChatBtn"),
  settingsBtn: $("settingsBtn"),
  settingsDialog: $("settingsDialog"),
  settingsForm: $("settingsForm"),
  apiKeyInput: $("apiKeyInput"),
  apiKeyHint: $("apiKeyHint"),
  settingsModel: $("settingsModel"),
  settingsEffort: $("settingsEffort"),
  dropOverlay: $("dropOverlay"),
};

let state = null;
let busy = false;
let current = null; // 현재 스트리밍 중인 어시스턴트 글 { el, text }
let thinkingEl = null;
let pendingFiles = [];
const toolRows = new Map();
const openApprovals = new Set();

marked.setOptions({ gfm: true, breaks: true });

// ------------------------------------------------------------------ 공통

function nearBottom() {
  const s = els.scroller;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
}

function scrollDown(force) {
  if (force || nearBottom()) els.scroller.scrollTop = els.scroller.scrollHeight;
}

function add(el) {
  const stick = nearBottom();
  els.welcome.hidden = true;
  if (thinkingEl && thinkingEl.parentNode) els.conversation.insertBefore(el, thinkingEl);
  else els.conversation.appendChild(el);
  scrollDown(stick);
  return el;
}

function div(cls, text) {
  const el = document.createElement("div");
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function renderMarkdown(el, text) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ["img", "style", "form", "input"] });
}

function setThinking(on) {
  if (on && openApprovals.size) return; // 승인을 기다리는 동안에는 표시하지 않는다
  if (on && !thinkingEl) {
    thinkingEl = div("thinking", "작업 중");
    els.conversation.appendChild(thinkingEl);
    scrollDown(true);
  } else if (!on && thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

function setBusy(b) {
  busy = b;
  els.sendBtn.textContent = b ? "중단" : "보내기";
  els.sendBtn.className = b ? "danger" : "primary";
  setThinking(b);
}

// ------------------------------------------------------------------ 상태 / 설정

function applyState(s) {
  state = s;
  els.workspaceLabel.textContent = s.workspace || "작업 폴더 선택";
  els.workspaceBtn.title = s.workspace ? `작업 폴더: ${s.workspace} (클릭해서 바꾸기)` : "작업 폴더 선택";
  els.openFolderBtn.hidden = !s.workspace;
  for (const sel of [els.modelSelect, els.settingsModel]) {
    sel.innerHTML = "";
    for (const m of s.models) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.label;
      sel.appendChild(o);
    }
    sel.value = s.model;
  }
  els.settingsEffort.value = s.effort;
  if (s.cost) els.costLabel.textContent = `$${s.cost.total.toFixed(4)}`;
}

function openSettings() {
  els.apiKeyInput.value = "";
  els.apiKeyInput.placeholder = state.hasKey ? "저장된 키가 있습니다 (바꿀 때만 입력)" : "sk-ant-...";
  els.settingsModel.value = state.model;
  els.settingsEffort.value = state.effort;
  els.settingsDialog.showModal();
  if (!state.hasKey) els.apiKeyInput.focus();
}

els.settingsForm.addEventListener("submit", async (e) => {
  if (e.submitter && e.submitter.value === "cancel") return;
  e.preventDefault();
  const apiKey = els.apiKeyInput.value.trim();
  if (!apiKey && !state.hasKey) {
    els.apiKeyInput.focus();
    return;
  }
  applyState(await api.saveSettings({ apiKey, model: els.settingsModel.value, effort: els.settingsEffort.value }));
  els.settingsDialog.close();
  if (apiKey) notice("info", "API 키를 저장했습니다. 대화를 새로 시작합니다.");
  if (!state.workspace) chooseWorkspace();
});

async function chooseWorkspace() {
  if (busy) return;
  const before = state.workspace;
  applyState(await api.chooseWorkspace());
  if (state.workspace && state.workspace !== before) {
    clearConversation();
    notice("info", `작업 폴더: ${state.workspace}`);
  }
}

function clearConversation() {
  for (const el of [...els.conversation.children]) if (el !== els.welcome) el.remove();
  els.welcome.hidden = false;
  current = null;
  thinkingEl = null;
  toolRows.clear();
}

els.workspaceBtn.addEventListener("click", chooseWorkspace);
els.openFolderBtn.addEventListener("click", () => api.openFolder());
els.settingsBtn.addEventListener("click", openSettings);
els.modelSelect.addEventListener("change", async () => {
  applyState(await api.saveSettings({ model: els.modelSelect.value }));
});
els.newChatBtn.addEventListener("click", async () => {
  await api.reset();
  setBusy(false);
  clearConversation();
});

// ------------------------------------------------------------------ 보내기

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + "px";
}

async function sendMessage(text) {
  if (busy) return;
  text = text.trim();
  if (!text && !pendingFiles.length) return;
  if (!state.hasKey) return openSettings();
  if (!state.workspace) return chooseWorkspace();
  if (pendingFiles.length) {
    text = (text || "첨부한 파일을 확인해줘") + "\n\n[첨부 파일] " + pendingFiles.join(", ");
  }
  const r = await api.send(text);
  if (!r.ok) {
    notice("error", r.error);
    return;
  }
  add(div("msg user", text));
  scrollDown(true);
  els.input.value = "";
  pendingFiles = [];
  renderAttachments();
  autoGrow();
  current = null;
}

els.input.addEventListener("input", autoGrow);
els.input.addEventListener("keydown", (e) => {
  // 한글 조합 중 Enter는 무시 (조합 완료용)
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    sendMessage(els.input.value);
  }
});
els.sendBtn.addEventListener("click", () => {
  if (busy) api.stop();
  else sendMessage(els.input.value);
});
for (const b of document.querySelectorAll(".example")) {
  b.addEventListener("click", () => {
    els.input.value = b.textContent;
    autoGrow();
    els.input.focus();
  });
}

// ------------------------------------------------------------------ 첨부

function renderAttachments() {
  els.attachments.innerHTML = "";
  pendingFiles.forEach((f, i) => {
    const chip = div("chip");
    chip.appendChild(document.createTextNode(f));
    chip.appendChild(button("x", "", () => {
      pendingFiles.splice(i, 1);
      renderAttachments();
    }));
    els.attachments.appendChild(chip);
  });
}

async function attachFiles(fileList) {
  if (!state.workspace) {
    notice("warn", "작업 폴더를 먼저 선택하세요.");
    return;
  }
  const paths = [...fileList].map((f) => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const r = await api.attach(paths);
  if (r.error) return notice("error", r.error);
  for (const f of r.files) if (!pendingFiles.includes(f)) pendingFiles.push(f);
  renderAttachments();
  els.input.focus();
}

els.attachBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  attachFiles(els.fileInput.files);
  els.fileInput.value = "";
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (![...e.dataTransfer.types].includes("Files")) return;
  e.preventDefault();
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropOverlay.hidden = true;
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  if (e.dataTransfer.files.length) attachFiles(e.dataTransfer.files);
});

// 대화 안의 링크는 기본 브라우저로 연다
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a) return;
  e.preventDefault();
  api.openLink(a.href);
});

// ------------------------------------------------------------------ 에이전트 이벤트

function notice(level, text) {
  add(div(`notice ${level}`, text));
}

// 글 조각이 올 때마다 다시 그리지 않고, 화면 갱신 때 바뀐 글 상자만 모아서 그린다
const dirty = new Set();
function queueRender(block) {
  const first = dirty.size === 0;
  dirty.add(block);
  if (!first) return;
  requestAnimationFrame(() => {
    const stick = nearBottom();
    for (const b of dirty) renderMarkdown(b.el, b.text);
    dirty.clear();
    scrollDown(stick);
  });
}

api.onEvent((evt) => {
  switch (evt.type) {
    case "status":
      setBusy(evt.busy);
      break;
    case "text_start":
      current = null;
      break;
    case "text":
      if (!current) current = { el: add(div("msg assistant")), text: "" };
      current.text += evt.text;
      queueRender(current);
      break;
    case "tool_start": {
      current = null;
      const row = div("tool running");
      row.appendChild(div("dot"));
      const summary = div("summary", `${TOOL_LABELS[evt.name] || evt.name} 준비 중`);
      row.appendChild(summary);
      toolRows.set(evt.id, { row, summary, name: evt.name });
      add(row);
      break;
    }
    case "tool_result": {
      let t = toolRows.get(evt.id);
      if (!t) {
        const row = div("tool");
        row.appendChild(div("dot"));
        const summary = div("summary");
        row.appendChild(summary);
        t = { row, summary, name: evt.name };
        add(row);
      }
      t.row.className = `tool ${evt.isError ? "err" : "ok"}`;
      const label = TOOL_LABELS[evt.name] || evt.name;
      t.summary.textContent = `${label}${evt.detail ? ` · ${evt.detail}` : ""} — ${evt.summary}`;
      t.summary.title = t.summary.textContent;
      if (evt.path) t.row.appendChild(button("열기", "ghost small", () => api.openFile(evt.path)));
      break;
    }
    case "cost":
      els.costLabel.textContent = `$${evt.total.toFixed(4)}`;
      els.costLabel.title = `이번 요청 약 $${evt.spent.toFixed(4)} · 입력 ${evt.tokens.input.toLocaleString()} / 캐시 쓰기 ${evt.tokens.cache_write.toLocaleString()} / 캐시 읽기 ${evt.tokens.cache_read.toLocaleString()} / 출력 ${evt.tokens.output.toLocaleString()} 토큰`;
      break;
    case "notice":
      notice(evt.level, evt.text);
      break;
    case "turn_end":
      current = null;
      break;
  }
});

// ------------------------------------------------------------------ 승인

const APPROVAL_TITLES = {
  create_document: "문서를 만들까요?",
  replace_in_document: "문서의 글자를 바꿀까요?",
  write_file: "파일을 저장할까요?",
  edit_file: "파일을 수정할까요?",
  move_file: "파일을 옮길까요?",
  delete_file: "삭제할까요?",
  run_command: "이 명령을 실행할까요?",
};

function renderPreview(pre, preview) {
  if (preview.kind === "diff") {
    for (const line of preview.text.split("\n")) {
      const span = document.createElement("span");
      if (line.startsWith("+") && !line.startsWith("+++")) span.className = "add";
      else if (line.startsWith("-") && !line.startsWith("---")) span.className = "del";
      else if (line.startsWith("@@")) span.className = "hunk";
      span.textContent = line + "\n";
      if (!span.className) span.textContent = line + "\n";
      pre.appendChild(span);
    }
  } else if (preview.kind === "command") {
    pre.textContent = (state && /Windows/i.test(navigator.userAgent) ? "PS> " : "$ ") + preview.text;
  } else {
    pre.textContent = preview.text;
  }
}

api.onApproval((req) => {
  current = null;
  setThinking(false);
  const card = div("approval");
  const header = document.createElement("header");
  header.textContent = APPROVAL_TITLES[req.name] || `${req.name} 실행 승인`;
  card.appendChild(header);
  if (req.preview.title) card.appendChild(div("preview-title", req.preview.title));
  const pre = document.createElement("pre");
  pre.className = "preview";
  renderPreview(pre, req.preview);
  card.appendChild(pre);

  const fb = div("feedback");
  const ta = document.createElement("textarea");
  ta.placeholder = "거부 이유나 원하는 방향을 적어 주세요 (비워도 됩니다)";
  fb.appendChild(ta);
  card.appendChild(fb);

  const actions = div("actions");
  const finish = (approved, always, feedback, label) => {
    if (!openApprovals.has(card)) return;
    openApprovals.delete(card);
    api.respondApproval({ id: req.id, approved, always, feedback });
    card.classList.add("done");
    card.classList.remove("rejecting");
    actions.remove();
    fb.remove();
    card.appendChild(div("result", label + (feedback ? ` — "${feedback}"` : "")));
    if (busy && !openApprovals.size) setThinking(true);
  };
  card.cancel = () => {
    if (!openApprovals.has(card)) return;
    openApprovals.delete(card);
    card.classList.add("done");
    actions.remove();
    fb.remove();
    card.appendChild(div("result", "취소됨"));
  };
  const allow = button("허용", "primary", () => finish(true, false, "", "허용함"));
  const always = button("이번 실행 동안 항상 허용", "ghost", () => finish(true, true, "", `허용함 (이번 실행 동안 "${TOOL_LABELS[req.name] || req.name}" 자동 허용)`));
  const reject = button("거부", "ghost", () => {
    if (!card.classList.contains("rejecting")) {
      card.classList.add("rejecting");
      reject.textContent = "거부 보내기";
      ta.focus();
      return;
    }
    finish(false, false, ta.value.trim(), "거부함");
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      finish(false, false, ta.value.trim(), "거부함");
    }
  });
  actions.append(allow, always, reject);
  card.appendChild(actions);
  openApprovals.add(card);
  add(card);
  setThinking(false);
  scrollDown(true);
  allow.focus();
});

api.onApprovalCancel(() => {
  for (const card of [...openApprovals]) card.cancel();
});

// ------------------------------------------------------------------ 시작

(async () => {
  applyState(await api.getState());
  if (state.keyFromEnv) els.apiKeyHint.textContent = "환경변수 ANTHROPIC_API_KEY 의 키를 쓰고 있습니다. 여기 입력하면 이 키를 대신 씁니다.";
  if (!state.hasKey) openSettings();
  else if (!state.workspace) notice("info", "위쪽의 \"작업 폴더 선택\"을 눌러 문서가 있는 폴더를 고르세요.");
  els.input.focus();
})();
