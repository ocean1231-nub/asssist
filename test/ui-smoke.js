"use strict";
// 화면(renderer)만 Chromium에서 띄워 가짜 window.api로 동작을 확인한다. (Electron 없이 실행)
// 실행: node test/ui-smoke.js [스크린샷 저장 폴더]   (playwright 필요)

const path = require("path");
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.log("playwright가 없어 화면 테스트를 건너뜁니다 (npm i -D playwright)");
  process.exit(0);
}

const outDir = process.argv[2];
const fileUrl = "file://" + path.join(__dirname, "..", "renderer", "index.html");

function mockApi(hasKey) {
  const calls = [];
  const listeners = { event: [], approval: [], cancel: [] };
  const st = {
    model: "claude-opus-5-5", effort: "medium", workspace: hasKey ? "C:\\Users\\me\\Documents\\공문" : null, hasKey, keyFromEnv: false,
    models: [{ id: "claude-opus-5-5", label: "Opus 5.5 (가장 정확)" }, { id: "claude-sonnet-5-5", label: "Sonnet 5.5 (약 절반 가격)" }],
    efforts: ["low", "medium", "high", "xhigh", "max"], cost: null,
  };
  const emit = (e) => listeners.event.forEach((f) => f(e));
  window.__calls = calls;
  window.__emit = emit;
  window.__approval = (r) => listeners.approval.forEach((f) => f(r));
  window.api = {
    getState: async () => st,
    saveSettings: async (s) => { calls.push(["save", s]); if (s.apiKey) st.hasKey = true; return st; },
    chooseWorkspace: async () => { calls.push(["choose"]); st.workspace = "/home/me/docs"; return st; },
    send: async (t) => { calls.push(["send", t]); emit({ type: "status", busy: true }); return { ok: true }; },
    stop: async () => calls.push(["stop"]),
    reset: async () => calls.push(["reset"]),
    respondApproval: async (r) => calls.push(["approval", r]),
    attach: async (p) => ({ files: p }),
    openFile: async (p) => calls.push(["open", p]),
    openFolder: async () => calls.push(["openFolder"]),
    openLink: async (u) => calls.push(["link", u]),
    pathForFile: (f) => f.name,
    onEvent: (cb) => listeners.event.push(cb),
    onApproval: (cb) => listeners.approval.push(cb),
    onApprovalCancel: (cb) => listeners.cancel.push(cb),
  };
}

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const check = (cond, msg) => { if (!cond) throw new Error("실패: " + msg); console.log("ok -", msg); };

  // 1) 첫 실행: 키가 없으면 설정 창이 뜬다
  {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.addInitScript(mockApi, false);
    await page.goto(fileUrl);
    check(await page.locator("#settingsDialog").evaluate((d) => d.open), "키가 없으면 설정 창이 열린다");
    if (outDir) await page.screenshot({ path: path.join(outDir, "1-settings.png") });
    await page.fill("#apiKeyInput", "sk-ant-test");
    await page.click("#settingsSave");
    const calls = await page.evaluate(() => window.__calls);
    check(calls[0][0] === "save" && calls[0][1].apiKey === "sk-ant-test", "키 저장 요청");
    check(calls.some((c) => c[0] === "choose"), "키 저장 후 작업 폴더 선택으로 넘어간다");
    await page.close();
  }

  // 2) 대화, 도구, 승인, 거부 피드백
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: scheme });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(mockApi, true);
    await page.goto(fileUrl);
    if (scheme === "light" && outDir) await page.screenshot({ path: path.join(outDir, "2-welcome.png") });

    await page.fill("#input", "공문.hwp 요약하고 결과를 문서로 만들어줘");
    await page.keyboard.press("Enter");
    check((await page.locator(".msg.user").count()) === 1, `[${scheme}] Enter로 보내기`);
    check((await page.textContent("#sendBtn")) === "중단", `[${scheme}] 작업 중에는 중단 버튼`);

    await page.evaluate(() => {
      const e = window.__emit;
      e({ type: "text_start" });
      e({ type: "text", text: "공문을 먼저 읽겠습니다." });
      e({ type: "tool_start", id: "t1", name: "read_file" });
      e({ type: "tool_result", id: "t1", name: "read_file", detail: "공문.hwp", summary: "(.hwp 문서를 텍스트로 변환한 내용. 서식, 그림은 빠져 있음)", isError: false });
      e({ type: "cost", spent: 0.0123, total: 0.0123, tokens: { input: 3000, cache_write: 2900, cache_read: 0, output: 80 } });
      e({ type: "text_start" });
      e({ type: "text", text: "## 요약\n\n| 항목 | 내용 |\n|---|---|\n| 기한 | 2026. 10. 20. |\n\n<img src=x onerror=alert(1)> [링크](https://example.com)" });
      e({ type: "tool_start", id: "t2", name: "create_document" });
    });
    await page.waitForTimeout(100);
    check(await page.locator(".msg.assistant table").count() === 1, `[${scheme}] 마크다운 표 렌더링`);
    check(await page.locator(".msg.assistant img[onerror]").count() === 0, `[${scheme}] 위험한 HTML 제거`);
    check((await page.textContent("#costLabel")) === "$0.0123", `[${scheme}] 비용 표시`);

    await page.evaluate(() => window.__approval({ id: 7, name: "create_document", preview: { kind: "document", title: "새 문서: 요약/공문요약.hwpx", text: "# 공문 요약\n\n1. 기한: 2026. 10. 20.\n2. 제출 서류: 신청서 1부.  끝." } }));
    check(await page.locator(".approval").count() === 1, `[${scheme}] 승인 카드 표시`);
    if (outDir) await page.screenshot({ path: path.join(outDir, `3-approval-${scheme}.png`) });

    await page.click(".approval .actions button:has-text('거부')");
    await page.fill(".approval .feedback textarea", "제목을 더 짧게");
    await page.click(".approval .actions button:has-text('거부 보내기')");
    let calls = await page.evaluate(() => window.__calls);
    const resp = calls.find((c) => c[0] === "approval");
    check(resp && resp[1].id === 7 && resp[1].approved === false && resp[1].feedback === "제목을 더 짧게", `[${scheme}] 거부 피드백 전달`);

    await page.evaluate(() => {
      window.__emit({ type: "tool_result", id: "t2", name: "create_document", detail: "요약/공문요약.hwpx", summary: "사용자가 이 작업을 거부했습니다.", isError: true, rejected: true });
      window.__approval({ id: 8, name: "edit_file", preview: { kind: "diff", text: "@@ -1,2 +1,2 @@\n # 메모\n-할 일: 장보기\n+할 일: 장보기, 운동" } });
    });
    await page.click(".approval:not(.done) button:has-text('허용')");
    await page.evaluate(() => {
      window.__emit({ type: "tool_result", id: "t3", name: "edit_file", detail: "notes.md", summary: "수정 완료: notes.md", isError: false, path: "notes.md" });
      window.__emit({ type: "notice", level: "warn", text: "중단했습니다." });
      window.__emit({ type: "turn_end" });
      window.__emit({ type: "status", busy: false });
    });
    check(await page.locator(".approval .add").count() === 1 && await page.locator(".approval .del").count() === 1, `[${scheme}] diff 색상 줄`);
    await page.click(".tool button:has-text('열기')");
    await page.click(".msg.assistant a");
    calls = await page.evaluate(() => window.__calls);
    check(calls.some((c) => c[0] === "open" && c[1] === "notes.md"), `[${scheme}] 열기 버튼`);
    check(calls.some((c) => c[0] === "link" && c[1] === "https://example.com/"), `[${scheme}] 링크는 외부 브라우저로`);
    check((await page.textContent("#sendBtn")) === "보내기", `[${scheme}] 작업이 끝나면 보내기 버튼`);
    if (outDir) await page.screenshot({ path: path.join(outDir, `4-done-${scheme}.png`), fullPage: true });

    // 한글 조합 중 Enter는 보내지 않는다
    const before = (await page.evaluate(() => window.__calls)).filter((c) => c[0] === "send").length;
    await page.evaluate(() => {
      const i = document.getElementById("input");
      i.value = "조합중";
      i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
    });
    const after = (await page.evaluate(() => window.__calls)).filter((c) => c[0] === "send").length;
    check(before === after, `[${scheme}] 한글 조합 중 Enter 무시`);
    await page.close();
  }

  // 3) 좁은 창
  {
    const page = await browser.newPage({ viewport: { width: 720, height: 600 } });
    await page.addInitScript(mockApi, true);
    await page.goto(fileUrl);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(!overflow, "최소 창 너비에서 가로 스크롤 없음");
    if (outDir) await page.screenshot({ path: path.join(outDir, "5-narrow.png") });
    await page.close();
  }

  await browser.close();
  if (errors.length) {
    console.error("화면 오류:", errors);
    process.exit(1);
  }
  console.log("화면 테스트 통과");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
