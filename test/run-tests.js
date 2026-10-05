"use strict";
// 실행: npm test   (API 키 없이 동작. Claude API는 가짜 클라이언트로 대체)
// 한글(.hwp) 읽기 테스트: HWP_SAMPLE_DIR 환경변수에 .hwp 파일이 있는 폴더를 지정하면 함께 검사한다.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const docs = require("../src/documents");
const { Workspace, validateInput, globToRegExp } = require("../src/tools");
const { Agent } = require("../src/agent");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doc-agent-test-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const SAMPLE_MD = `# 2026년 하반기 연수 계획

1. 목적
  가. 교직원 **역량 강화**
  나. 업무 효율 향상
- 대상: 전 교직원

| 구분 | 일정 | 인원 |
| --- | --- | --- |
| 1차 | 10월 | 30 |
| 2차 | 11월 | 1,250 |

붙임  1. 세부 일정 1부.  끝.`;

// ------------------------------------------------------------------ 문서

test("docx 만들기 -> 읽기", async () => {
  const f = path.join(tmp, "a.docx");
  await docs.createDocument(f, SAMPLE_MD);
  const t = await docs.readDocumentText(f);
  assert.match(t, /^# 2026년 하반기 연수 계획/);
  assert.match(t, /가\. 교직원 \*\*역량 강화\*\*/);
  assert.match(t, /\| 2차 \| 11월 \| 1,250 \|/);
  assert.match(t, /끝\./);
});

test("xlsx 만들기 -> 읽기 (표가 시트가 되고 숫자는 숫자로)", async () => {
  const f = path.join(tmp, "a.xlsx");
  await docs.createDocument(f, SAMPLE_MD);
  const t = await docs.readDocumentText(f);
  assert.match(t, /시트: 2026년 하반기 연수 계획/);
  assert.match(t, /3행 \| 2차 \| 11월 \| 1250 \|/);
  await assert.rejects(docs.createDocument(path.join(tmp, "b.xlsx"), "표 없음"), /표가 없습니다/);
});

test("hwpx 만들기: mimetype이 첫 항목, 무압축이고 본문이 읽힌다", async () => {
  const f = path.join(tmp, "a.hwpx");
  await docs.createDocument(f, SAMPLE_MD);
  const buf = fs.readFileSync(f);
  // ZIP 첫 로컬 헤더: 압축 방식(오프셋 8) = 0(STORE), 파일 이름(오프셋 30) = mimetype
  assert.equal(buf.readUInt16LE(8), 0);
  assert.equal(buf.toString("latin1", 30, 38), "mimetype");
  const zip = await JSZip.loadAsync(buf);
  assert.equal(await zip.file("mimetype").async("string"), "application/hwp+zip");
  assert.ok(!Object.keys(zip.files).some((n) => n.endsWith("/")), "폴더 항목이 없어야 한다");
  const xml = await zip.file("Contents/section0.xml").async("string");
  assert.ok(xml.includes("<hp:secPr"), "구역 설정이 남아 있어야 한다");
  const t = await docs.readDocumentText(f);
  assert.match(t, /2026년 하반기 연수 계획/);
  assert.match(t, / {2}가\. 교직원 역량 강화/);
  assert.match(t, /2차\t11월\t1,250/);
});

test("pdf/html/md 만들기", async () => {
  let printed = null;
  await docs.createDocument(path.join(tmp, "a.pdf"), SAMPLE_MD, { printPdf: async (html, out) => { printed = html; fs.writeFileSync(out, "%PDF-1.4"); } });
  assert.match(printed, /<table>/);
  assert.match(printed, /Malgun Gothic/);
  await assert.rejects(docs.createDocument(path.join(tmp, "b.pdf"), "x"), /PDF를 만들 수 없습니다/);
  await docs.createDocument(path.join(tmp, "a.md"), SAMPLE_MD);
  assert.equal(fs.readFileSync(path.join(tmp, "a.md"), "utf8"), SAMPLE_MD);
  await assert.rejects(docs.createDocument(path.join(tmp, "a.hwp"), "x"), /만들 수 없습니다/);
});

test("docx 글자 치환: 여러 런에 걸친 글자, 없는 글자, 다른 이름 저장", async () => {
  const f = path.join(tmp, "r.docx");
  await docs.createDocument(f, SAMPLE_MD);
  const out = path.join(tmp, "r2.docx");
  const counts = await docs.replaceInDocument(f, [{ find: "교직원 역량", replace: "교원 능력" }, { find: "없는글자", replace: "x" }, { find: "교직원", replace: "교원" }], out);
  assert.deepEqual(counts, [1, 0, 1]);
  const t = await docs.readDocumentText(out);
  assert.match(t, /가\. 교원 능력\*\* 강화\*\*/);
  assert.match(t, /대상: 전 교원/);
  assert.match(await docs.readDocumentText(f), /교직원 \*\*역량/, "원본은 그대로");
  const dry = await docs.replaceInDocument(f, [{ find: "연수", replace: "교육" }], null, { dryRun: true });
  assert.deepEqual(dry, [1]);
  assert.match(await docs.readDocumentText(f), /연수 계획/, "dryRun은 파일을 바꾸지 않는다");
});

test("hwpx 글자 치환: 바뀐 문단의 linesegarray만 지운다", async () => {
  const f = path.join(tmp, "r.hwpx");
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(__dirname, "..", "src", "assets", "Skeleton.hwpx")));
  let xml = await zip.file("Contents/section0.xml").async("string");
  const seg = '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>';
  const para = (id, runs) => `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${runs}${seg}</hp:p>`;
  xml = xml.replace("</hs:sec>",
    para(1, '<hp:run charPrIDRef="0"><hp:t>성명: ○○○</hp:t></hp:run>') +
    para(2, '<hp:run charPrIDRef="0"><hp:t>소속: 교</hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>무부 &amp; 행정</hp:t></hp:run>') +
    para(3, '<hp:run charPrIDRef="0"><hp:t>그대로 둘 문단</hp:t></hp:run>') + "</hs:sec>");
  zip.file("Contents/section0.xml", xml);
  fs.writeFileSync(f, await zip.generateAsync({ type: "nodebuffer" }));

  const counts = await docs.replaceInDocument(f, [{ find: "○○○", replace: "홍길동" }, { find: "교무부 & 행정", replace: "행정실" }]);
  assert.deepEqual(counts, [1, 1]);
  const out = await (await JSZip.loadAsync(fs.readFileSync(f))).file("Contents/section0.xml").async("string");
  assert.match(out, /<hp:t>성명: 홍길동<\/hp:t>/);
  assert.match(out, /<hp:t>소속: 행정실<\/hp:t><\/hp:run><hp:run charPrIDRef="1"><hp:t><\/hp:t>/);
  // 원래 문단 4개(구역 설정 문단 + 3개) 중 바뀌지 않은 2개의 linesegarray만 남는다
  assert.equal((out.match(/<hp:linesegarray>/g) || []).length, 2);
  assert.match(out, /그대로 둘 문단<\/hp:t><\/hp:run><hp:linesegarray>/);
});

test("pptx, odt, ods 읽기와 pptx 치환", async () => {
  const pptx = new JSZip();
  pptx.file("ppt/slides/slide2.xml", '<p:sld><a:p><a:r><a:t>둘째 장</a:t></a:r></a:p></p:sld>');
  pptx.file("ppt/slides/slide10.xml", '<p:sld><a:p><a:r><a:t>열째 장</a:t></a:r></a:p></p:sld>');
  pptx.file("ppt/slides/slide1.xml", '<p:sld><a:p><a:r><a:t>추진 </a:t></a:r><a:r><a:t>배경</a:t></a:r></a:p><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>항목</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>금액</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:sld>');
  const pf = path.join(tmp, "a.pptx");
  fs.writeFileSync(pf, await pptx.generateAsync({ type: "nodebuffer" }));
  const t = await docs.readDocumentText(pf);
  assert.match(t, /## 슬라이드 1\n추진 배경\n\| 항목 \| 금액 \|/);
  assert.ok(t.indexOf("둘째 장") < t.indexOf("열째 장"), "슬라이드 번호 순서");
  assert.deepEqual(await docs.replaceInDocument(pf, [{ find: "추진 배경", replace: "개요" }]), [1]);
  assert.match(await docs.readDocumentText(pf), /## 슬라이드 1\n개요\n/);

  const odt = new JSZip();
  odt.file("mimetype", "application/vnd.oasis.opendocument.text");
  odt.file("content.xml", '<office:document-content><office:body><office:text><text:h text:outline-level="1">회의록</text:h><text:p>안건:<text:s text:c="2"/>예산</text:p><table:table><table:table-row><table:table-cell><text:p>항목</text:p></table:table-cell><table:table-cell><text:p>결과</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>');
  const of = path.join(tmp, "a.odt");
  fs.writeFileSync(of, await odt.generateAsync({ type: "nodebuffer" }));
  assert.equal(await docs.readDocumentText(of), "회의록\n안건:  예산\n| 항목 | 결과 |");
});

test("pdf와 이미지는 원본 블록으로, 큰 파일과 구형 형식은 안내 오류", async () => {
  const pdf = path.join(tmp, "x.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4 test");
  const r = await docs.readDocument(pdf);
  assert.equal(r.blocks[0].type, "document");
  assert.equal(r.blocks[0].source.media_type, "application/pdf");
  const png = path.join(tmp, "x.png");
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal((await docs.readDocument(png)).blocks[0].source.media_type, "image/png");
  fs.writeFileSync(path.join(tmp, "old.xls"), "x");
  await assert.rejects(docs.readDocumentText(path.join(tmp, "old.xls")), /\.xlsx 형식으로 저장/);
  fs.writeFileSync(path.join(tmp, "bin.dat"), Buffer.from([1, 0, 2]));
  await assert.rejects(docs.readDocumentText(path.join(tmp, "bin.dat")), /바이너리/);
  fs.writeFileSync(path.join(tmp, "bad.hwp"), "not a hwp");
  await assert.rejects(docs.readDocumentText(path.join(tmp, "bad.hwp")), docs.DocumentError);
});

test("hwp 샘플 읽기 (HWP_SAMPLE_DIR 지정 시)", { skip: !process.env.HWP_SAMPLE_DIR }, async () => {
  const dir = process.env.HWP_SAMPLE_DIR;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".hwp"));
  assert.ok(files.length > 0);
  for (const f of files) {
    const t = await docs.readDocumentText(path.join(dir, f));
    assert.ok(t.length > 0, f);
    assert.doesNotMatch(t, /[\u0001-\u0008]/, `${f}: 제어 문자가 남으면 안 된다`);
  }
});

// ------------------------------------------------------------------ 도구

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(tmp, "ws-"));
  fs.writeFileSync(path.join(root, "notes.md"), "# 메모\n할 일: 장보기\n");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "b.txt"), "예산 300만원");
  return new Workspace(root);
}
const yes = async () => ({ approved: true });

test("작업 폴더 밖 경로 차단 (.., 절대경로, 심볼릭 링크)", async () => {
  const ws = makeWorkspace();
  for (const bad of ["../x.txt", "/etc/passwd", "sub/../../x"]) {
    const r = await ws.execute("read_file", { path: bad }, yes);
    assert.ok(r.isError && /작업 폴더 밖/.test(r.content), bad);
  }
  const outside = fs.mkdtempSync(path.join(tmp, "outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "비밀");
  try {
    fs.symlinkSync(outside, path.join(ws.root, "link"), "dir");
    const r = await ws.execute("read_file", { path: "link/secret.txt" }, yes);
    assert.ok(r.isError && /작업 폴더 밖/.test(r.content));
    const w = await ws.execute("write_file", { path: "link/new.txt", content: "x" }, yes);
    assert.ok(w.isError);
    assert.ok(!fs.existsSync(path.join(outside, "new.txt")));
  } catch (e) {
    if (e.code !== "EPERM") throw e; // Windows에서 심볼릭 링크 권한이 없으면 건너뜀
  }
});

test("목록, glob, 읽기, 문서 포함 검색", async () => {
  const ws = makeWorkspace();
  await docs.createDocument(path.join(ws.root, "sub", "계획.docx"), SAMPLE_MD);
  assert.match(await ws.list_files({}), /^sub\/\nnotes\.md/);
  assert.equal(await ws.list_files({ pattern: "**/*.docx" }), "sub/계획.docx");
  assert.match(await ws.read_file({ path: "sub/계획.docx" }), /docx 문서를 텍스트로 변환한 내용[\s\S]*연수 계획/);
  const s = await ws.search_files({ query: "1,250|300만원" });
  assert.match(s, /sub\/계획\.docx:\d+: \| 2차/);
  assert.match(s, /sub\/b\.txt:1: 예산 300만원/);
  assert.ok(globToRegExp("*.hwp").test("공문.HWP"));
  assert.ok(!globToRegExp("*.hwp").test("a/공문.hwp"));
});

test("승인 거부 피드백이 결과로 돌아가고 파일은 그대로", async () => {
  const ws = makeWorkspace();
  let seen = null;
  const r = await ws.execute("edit_file", { path: "notes.md", old_text: "장보기", new_text: "운동" }, async (name, args, preview) => {
    seen = preview;
    return { approved: false, feedback: "운동은 새 줄로" };
  });
  assert.equal(seen.kind, "diff");
  assert.match(seen.text, /-할 일: 장보기\n\+할 일: 운동/);
  assert.ok(r.isError && r.rejected);
  assert.match(r.content, /사용자 피드백: 운동은 새 줄로/);
  assert.match(fs.readFileSync(path.join(ws.root, "notes.md"), "utf8"), /장보기/);
});

test("항상 허용, 삭제는 휴지통으로, 문서 형식은 write_file 거부", async () => {
  const ws = makeWorkspace();
  let asked = 0;
  const approve = async () => { asked++; return { approved: true, always: true }; };
  await ws.execute("write_file", { path: "a.txt", content: "1" }, approve);
  await ws.execute("write_file", { path: "b.txt", content: "2" }, approve);
  assert.equal(asked, 1);
  const d = await ws.execute("delete_file", { path: "a.txt" }, yes);
  assert.match(d.content, /복구 가능: \.agent-trash\//);
  assert.ok(!fs.existsSync(path.join(ws.root, "a.txt")));
  assert.ok(!(await ws.list_files({})).includes(".agent-trash"));
  const w = await ws.execute("write_file", { path: "x.docx", content: "x" }, yes);
  assert.ok(w.isError && /create_document/.test(w.content));
});

test("문서 만들기/치환 미리보기와 실행", async () => {
  const ws = makeWorkspace();
  let preview = null;
  const capture = async (n, a, p) => { preview = p; return { approved: true }; };
  const c = await ws.execute("create_document", { path: "out/공문.hwpx", content: SAMPLE_MD }, capture);
  assert.equal(preview.kind, "document");
  assert.match(preview.title, /새 문서/);
  assert.match(c.content, /생성 완료: out\/공문\.hwpx/);
  const r = await ws.execute("replace_in_document", { path: "out/공문.hwpx", replacements: [{ find: "연수", replace: "교육" }], output_path: "out/공문2.hwpx" }, capture);
  assert.match(preview.text, /"연수" {2}-> {2}"교육" {3}\[1곳\]/);
  assert.match(r.content, /out\/공문2\.hwpx 저장 \(1곳 변경\)/);
  const none = await ws.execute("replace_in_document", { path: "out/공문.hwpx", replacements: [{ find: "없음", replace: "x" }] }, yes);
  assert.ok(none.isError && /찾지 못했습니다/.test(none.content));
});

test("명령 실행", async () => {
  const ws = makeWorkspace();
  const cmd = process.platform === "win32" ? "Write-Output 안녕" : "echo 안녕";
  const r = await ws.execute("run_command", { command: cmd }, yes);
  assert.match(r.content, /\[종료 코드 0\]\n안녕/);
});

test("도구 입력 검증", () => {
  assert.equal(validateInput("read_file", { path: "a" }), null);
  assert.match(validateInput("read_file", { path: 1 }), /문자열/);
  assert.match(validateInput("read_file", {}), /필수 항목 누락: path/);
  assert.match(validateInput("read_file", { path: "a", x: 1 }), /알 수 없는 항목/);
  assert.match(validateInput("replace_in_document", { path: "a", replacements: [{ find: "a" }] }), /replacements\[0\]\.replace/);
  assert.match(validateInput("nope", {}), /알 수 없는 도구/);
});

// ------------------------------------------------------------------ 에이전트 (가짜 API)

function fakeClient(script, calls) {
  return {
    beta: {
      messages: {
        stream(params, opts) {
          calls.push(JSON.parse(JSON.stringify(params)));
          const msg = script[calls.length - 1];
          return {
            async *[Symbol.asyncIterator]() {
              for (const b of msg.content) {
                if (opts.signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
                if (b.type === "text") {
                  yield { type: "content_block_start", content_block: { type: "text" } };
                  yield { type: "content_block_delta", delta: { type: "text_delta", text: b.text } };
                } else yield { type: "content_block_start", content_block: b };
              }
            },
            async finalMessage() {
              return msg;
            },
          };
        },
      },
    },
  };
}
const usage = (i = 100, o = 50, cw = 0, cr = 0) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });

test("에이전트: 도구 실행, 거부 피드백, 요청 형식, 비용, 거절 시 기록 되돌리기", async () => {
  const ws = makeWorkspace();
  const calls = [];
  const events = [];
  const script = [
    { content: [{ type: "text", text: "확인할게요." }, { type: "tool_use", id: "t1", name: "read_file", input: { path: "notes.md" } }], stop_reason: "tool_use", usage: usage(3000, 80, 2900) },
    { content: [{ type: "tool_use", id: "t2", name: "edit_file", input: { path: "notes.md", old_text: "장보기", new_text: "장보기, 운동" } }], stop_reason: "tool_use", usage: usage(50, 60, 0, 3000) },
    { content: [{ type: "tool_use", id: "t3", name: "edit_file", input: { path: "notes.md", old_text: "장보기", new_text: "장보기\n할 일: 운동" } }, { type: "tool_use", id: "t4", name: "read_file", input: { path: 5 } }], stop_reason: "tool_use", usage: usage(50, 60, 0, 3100) },
    { content: [{ type: "text", text: "추가했습니다." }], stop_reason: "end_turn", usage: usage(50, 30, 0, 3300) },
    { content: [], stop_reason: "refusal", stop_details: { category: "cyber" }, usage: usage(10, 0) },
  ];
  const answers = [{ approved: false, feedback: "새 줄로 추가해줘" }, { approved: true }];
  const agent = new Agent({
    client: fakeClient(script, calls),
    workspace: ws,
    onEvent: (e) => events.push(e),
    approve: async () => answers.shift(),
  });
  await agent.send("메모에 운동 추가해줘");
  assert.equal(fs.readFileSync(path.join(ws.root, "notes.md"), "utf8"), "# 메모\n할 일: 장보기\n할 일: 운동\n");
  assert.deepEqual(agent.messages.map((m) => m.role), ["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
  const rejected = calls[2].messages.at(-1).content[0];
  assert.equal(rejected.is_error, true);
  assert.match(rejected.content, /사용자 피드백: 새 줄로 추가해줘/);
  const invalid = agent.messages[6].content[1];
  assert.match(invalid.content, /INVALID_INPUT: path는 문자열/);
  const p = calls[0];
  assert.equal(p.model, "claude-opus-5-5");
  assert.deepEqual(p.thinking, { type: "adaptive" });
  assert.deepEqual(p.output_config, { effort: "medium" });
  assert.equal(p.fallbacks, "default");
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(p.cache_control, { type: "ephemeral" });
  assert.ok(p.tools.every((t) => t.eager_input_streaming === true));
  const cost = events.filter((e) => e.type === "cost").at(-1);
  // (3150 입력 * 4 + 2900 캐시쓰기 * 5 + 9400 캐시읽기 * 0.2 + 230 출력 * 20) / 1e6
  assert.ok(Math.abs(cost.total - (3150 * 4 + 2900 * 5 + 9400 * 0.2 + 230 * 20) / 1e6) < 1e-9);
  assert.equal(events.filter((e) => e.type === "text").map((e) => e.text).join(""), "확인할게요.추가했습니다.");
  assert.ok(events.some((e) => e.type === "tool_result" && e.name === "edit_file" && e.path === "notes.md" && !e.isError));

  const before = agent.messages.length;
  await agent.send("나쁜 요청");
  assert.equal(agent.messages.length, before);
  assert.match(events.filter((e) => e.type === "notice").at(-1).text, /거절되었습니다 \(분류: cyber\)/);
  assert.equal(agent.busy, false);
});

test("에이전트: 승인 대기 중 중단하면 기록이 완성된 지점까지만 남는다", async () => {
  const ws = makeWorkspace();
  const calls = [];
  const events = [];
  const script = [
    { content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "notes.md" } }], stop_reason: "tool_use", usage: usage() },
    { content: [{ type: "tool_use", id: "t2", name: "delete_file", input: { path: "notes.md" } }], stop_reason: "tool_use", usage: usage() },
  ];
  let agent;
  agent = new Agent({
    client: fakeClient(script, calls),
    workspace: ws,
    onEvent: (e) => events.push(e),
    approve: async () => {
      agent.stop(); // 사용자가 중단 버튼을 누름
      return { approved: false };
    },
  });
  await agent.send("메모 지워줘");
  assert.ok(fs.existsSync(path.join(ws.root, "notes.md")));
  assert.deepEqual(agent.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(agent.interrupted, true);
  assert.match(events.filter((e) => e.type === "notice").at(-1).text, /중단했습니다/);
});

test("에이전트: API 오류는 기록을 되돌리고 안내한다", async () => {
  const ws = makeWorkspace();
  const Anthropic = require("@anthropic-ai/sdk");
  const events = [];
  const client = {
    beta: { messages: { stream() { throw new Anthropic.AuthenticationError(401, { error: { message: "bad key" } }, "bad key", new Headers()); } } },
  };
  const agent = new Agent({ client, workspace: ws, onEvent: (e) => events.push(e), approve: yes });
  await agent.send("안녕");
  assert.equal(agent.messages.length, 0);
  assert.match(events.find((e) => e.type === "notice").text, /API 키가 올바르지 않습니다/);
});
