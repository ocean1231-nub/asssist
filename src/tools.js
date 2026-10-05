"use strict";
// 에이전트가 쓰는 도구: 작업 폴더 안에서만 동작한다.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const Diff = require("diff");
const docs = require("./documents");

const TRASH_DIR = ".agent-trash";
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", TRASH_DIR]);
const READ_CHAR_LIMIT = 100000;
const OUTPUT_CHAR_LIMIT = 30000;
const COMMAND_TIMEOUT_MS = 120000;
const IS_WINDOWS = process.platform === "win32";

class ToolError extends Error {}

// ------------------------------------------------------------------ 도구 정의 (Claude에 전달)

const STR = { type: "string" };
const INT = { type: "integer" };

function tool(name, description, properties, required) {
  return {
    name,
    description,
    eager_input_streaming: true,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
}

const TOOLS = [
  tool("list_files",
    "작업 폴더 안의 파일과 폴더 목록을 본다. pattern을 주면 하위 폴더까지 찾는다 (예: '**/*.hwp').",
    { path: { ...STR, description: "작업 폴더 기준 상대 경로. 기본 '.'" }, pattern: { ...STR, description: "선택. glob 패턴" } },
    []),
  tool("read_file",
    "파일을 읽는다. 텍스트 파일뿐 아니라 hwp, hwpx, docx, doc, xlsx, csv, pptx, odt/ods/odp 문서는 텍스트로 변환해 읽고, " +
    "pdf와 이미지(png/jpg/gif/webp)는 원본 그대로 본다. 긴 텍스트는 offset/limit(줄 단위)로 나눠 읽는다.",
    { path: STR, offset: { ...INT, description: "시작 줄 (1부터). 기본 1" }, limit: { ...INT, description: "읽을 줄 수. 기본 2000" } },
    ["path"]),
  tool("search_files",
    "작업 폴더의 텍스트 파일과 문서(hwp, hwpx, docx, xlsx, pptx 등) 내용을 정규식으로 검색한다. pdf와 이미지는 검색하지 않는다.",
    { query: { ...STR, description: "정규식 (잘못된 정규식이면 일반 문자열로 검색)" }, path: { ...STR, description: "검색할 하위 폴더. 기본 '.'" }, glob: { ...STR, description: "선택. 파일 이름 필터 (예: '*.hwpx')" } },
    ["query"]),
  tool("create_document",
    "마크다운으로 쓴 내용으로 새 문서를 만든다. 확장자로 형식이 정해진다: .docx(워드), .hwpx(한글), .xlsx(엑셀, 마크다운 표가 시트가 됨), .pdf, .html, .md, .txt. " +
    "지원하는 마크다운: # 제목, | 표 |, - 글머리표, **굵게**, 앞 공백 2칸당 들여쓰기 1단계. '1.' '가.' 같은 번호는 글자 그대로 들어간다. " +
    "hwpx는 표와 굵게를 지원하지 않아 표는 탭으로 구분된 줄이 된다. 기존 파일이 있으면 덮어쓴다. 사용자 승인이 필요하다.",
    { path: STR, content: { ...STR, description: "마크다운 내용" } },
    ["path", "content"]),
  tool("replace_in_document",
    "docx, hwpx, pptx 문서 안의 글자를 찾아 바꾼다. 원래 서식(글꼴, 표, 양식)은 유지된다. 양식 파일의 빈칸이나 자리표시를 채울 때 쓴다. " +
    "output_path를 주면 원본은 두고 다른 이름으로 저장한다. 사용자 승인이 필요하다.",
    {
      path: STR,
      replacements: {
        type: "array",
        description: "바꿀 목록",
        items: { type: "object", properties: { find: STR, replace: STR }, required: ["find", "replace"], additionalProperties: false },
      },
      output_path: { ...STR, description: "선택. 다른 이름으로 저장할 경로" },
    },
    ["path", "replacements"]),
  tool("write_file",
    "텍스트 파일(.txt, .md, .csv, .json 등)을 새로 만들거나 전체 내용을 덮어쓴다. 문서 형식(docx, hwpx 등)은 create_document를 쓴다. 사용자 승인이 필요하다.",
    { path: STR, content: STR },
    ["path", "content"]),
  tool("edit_file",
    "텍스트 파일에서 old_text를 찾아 new_text로 바꾼다. old_text는 파일 안에서 정확히 한 번만 나와야 한다. 사용자 승인이 필요하다.",
    { path: STR, old_text: STR, new_text: STR },
    ["path", "old_text", "new_text"]),
  tool("move_file",
    "파일이나 폴더를 옮기거나 이름을 바꾼다. 사용자 승인이 필요하다.",
    { source: STR, destination: STR },
    ["source", "destination"]),
  tool("delete_file",
    `파일이나 폴더를 삭제한다. 실제로는 작업 폴더의 ${TRASH_DIR}/ 로 옮겨서 복구할 수 있다. 사용자 승인이 필요하다.`,
    { path: STR },
    ["path"]),
  tool("run_command",
    (IS_WINDOWS ? "PowerShell" : "셸") + ` 명령을 작업 폴더에서 실행하고 출력을 돌려받는다 (제한 시간 ${COMMAND_TIMEOUT_MS / 1000}초). 사용자 승인이 필요하다.`,
    { command: STR },
    ["command"]),
];

const TOOL_SCHEMAS = Object.fromEntries(TOOLS.map((t) => [t.name, t.input_schema]));
const NEEDS_APPROVAL = new Set(["create_document", "replace_in_document", "write_file", "edit_file", "move_file", "delete_file", "run_command"]);

/** 스트리밍된 도구 입력을 스키마와 대조한다. 문제가 없으면 null. */
function validateInput(name, args) {
  const schema = TOOL_SCHEMAS[name];
  if (!schema) return `알 수 없는 도구: ${name}`;
  return checkObject(schema, args, "");
}

function checkObject(schema, value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${where || "입력"}이 객체가 아닙니다`;
  for (const key of schema.required) if (!(key in value)) return `필수 항목 누락: ${where}${key}`;
  for (const [key, v] of Object.entries(value)) {
    const prop = schema.properties[key];
    if (!prop) return `알 수 없는 항목: ${where}${key}`;
    if (prop.type === "string" && typeof v !== "string") return `${where}${key}는 문자열이어야 합니다`;
    if (prop.type === "integer" && !Number.isInteger(v)) return `${where}${key}는 정수여야 합니다`;
    if (prop.type === "array") {
      if (!Array.isArray(v)) return `${where}${key}는 배열이어야 합니다`;
      for (let i = 0; i < v.length; i++) {
        const err = checkObject(prop.items, v[i], `${where}${key}[${i}].`);
        if (err) return err;
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------ 유틸

function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield { full, dir: true };
      yield* walk(full);
    } else if (e.isFile()) yield { full, dir: false };
  }
}

const timestamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

function truncateMiddle(s, limit) {
  if (s.length <= limit) return s;
  return s.slice(0, limit / 2) + "\n... (중략) ...\n" + s.slice(-limit / 2);
}

// ------------------------------------------------------------------ 작업 폴더

class Workspace {
  constructor(root, { printPdf } = {}) {
    this.root = fs.realpathSync(path.resolve(root));
    this.printPdf = printPdf;
    this.alwaysAllow = new Set();
    this.textCache = new Map(); // 문서 변환 결과 캐시: 경로 -> { mtimeMs, text }
  }

  /** 모델이 준 경로를 작업 폴더 안으로 제한한다 (.., 절대경로, 심볼릭 링크 탈출 차단). */
  resolve(rel) {
    if (typeof rel !== "string" || rel.includes("\0")) throw new ToolError("잘못된 경로입니다");
    const target = path.resolve(this.root, rel);
    let real = target;
    // 존재하는 가장 가까운 상위 경로의 실제 위치로 확인 (심볼릭 링크 탈출 방지)
    let probe = target;
    const rest = [];
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) {
      rest.unshift(path.basename(probe));
      probe = path.dirname(probe);
    }
    try {
      real = path.join(fs.realpathSync(probe), ...rest);
    } catch {
      real = target;
    }
    const inside = (p) => p === this.root || p.startsWith(this.root + path.sep);
    if (!inside(target) || !inside(real)) throw new ToolError(`작업 폴더 밖의 경로는 사용할 수 없습니다: ${rel}`);
    return real;
  }

  rel(p) {
    return path.relative(this.root, p).split(path.sep).join("/") || ".";
  }

  async docText(p) {
    const st = fs.statSync(p);
    const hit = this.textCache.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.text;
    const text = await docs.readDocumentText(p);
    this.textCache.set(p, { mtimeMs: st.mtimeMs, text });
    return text;
  }

  // --- 읽기 (승인 없음)

  list_files({ path: rel = ".", pattern }) {
    const base = this.resolve(rel);
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) throw new ToolError(`폴더가 아닙니다: ${rel}`);
    if (pattern) {
      const re = globToRegExp(pattern.replace(/\\/g, "/"));
      const hits = [];
      for (const e of walk(base)) {
        const r = path.relative(base, e.full).split(path.sep).join("/");
        if (re.test(r)) hits.push(this.rel(e.full) + (e.dir ? "/" : ""));
        if (hits.length >= 500) break;
      }
      return hits.sort().join("\n") || "(일치하는 파일 없음)";
    }
    const entries = fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => !SKIP_DIRS.has(e.name))
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name, "ko"));
    const lines = entries.slice(0, 500).map((e) => {
      if (e.isDirectory()) return `${e.name}/`;
      let size = 0;
      try { size = fs.statSync(path.join(base, e.name)).size; } catch { /* 무시 */ }
      return `${e.name}  (${size.toLocaleString()} bytes)`;
    });
    return lines.join("\n") || "(빈 폴더)";
  }

  async read_file({ path: rel, offset = 1, limit = 2000 }) {
    const p = this.resolve(rel);
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new ToolError(`파일이 없습니다: ${rel}`);
    const ext = path.extname(p).toLowerCase();
    if (ext === ".pdf" || docs.IMAGE_TYPES[ext]) {
      const { blocks } = await docs.readDocument(p);
      return [{ type: "text", text: `${this.rel(p)} 의 원본 내용입니다.` }, ...blocks];
    }
    let text;
    try {
      text = await this.docText(p);
    } catch (e) {
      if (e instanceof docs.DocumentError) throw new ToolError(e.message);
      throw e;
    }
    const lines = text.split(/\r?\n/);
    const start = Math.max(offset, 1) - 1;
    const chunk = lines.slice(start, start + Math.max(limit, 1));
    let out = chunk.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
    if (out.length > READ_CHAR_LIMIT) out = out.slice(0, READ_CHAR_LIMIT) + "\n... (글자 수 제한으로 잘림 - offset/limit로 나눠 읽으세요)";
    if (start + chunk.length < lines.length) out += `\n... (전체 ${lines.length}줄 중 ${start + 1}-${start + chunk.length}줄)`;
    if (docs.DOC_EXTS.has(ext)) out = `(${ext} 문서를 텍스트로 변환한 내용. 서식, 그림은 빠져 있음)\n` + out;
    return out || "(빈 파일)";
  }

  async search_files({ query, path: rel = ".", glob }) {
    let rx;
    try {
      rx = new RegExp(query, "i");
    } catch {
      rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }
    const nameRe = glob ? globToRegExp(glob) : null;
    const base = this.resolve(rel);
    const results = [];
    let docsScanned = 0;
    for (const e of walk(base)) {
      if (e.dir) continue;
      const name = path.basename(e.full);
      if (nameRe && !nameRe.test(name)) continue;
      const ext = path.extname(name).toLowerCase();
      if (ext === ".pdf" || docs.IMAGE_TYPES[ext]) continue;
      let text;
      try {
        const st = fs.statSync(e.full);
        if (docs.DOC_EXTS.has(ext)) {
          if (st.size > 30 * 1024 * 1024 || ++docsScanned > 300) continue;
          text = await this.docText(e.full);
        } else {
          if (st.size > 2 * 1024 * 1024) continue;
          const buf = fs.readFileSync(e.full);
          if (buf.subarray(0, 8192).includes(0)) continue;
          text = buf.toString("utf8");
        }
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (rx.test(lines[i])) {
          results.push(`${this.rel(e.full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (results.length >= 200) return results.join("\n") + "\n... (200개에서 중단)";
        }
      }
    }
    return results.join("\n") || "(일치하는 내용 없음)";
  }

  // --- 변경 (승인 후 실행)

  async create_document({ path: rel, content }) {
    const p = this.resolve(rel);
    const existed = fs.existsSync(p);
    try {
      await docs.createDocument(p, content, { printPdf: this.printPdf });
    } catch (e) {
      if (e instanceof docs.DocumentError) throw new ToolError(e.message);
      throw e;
    }
    return `${existed ? "덮어씀" : "생성 완료"}: ${this.rel(p)}`;
  }

  async replace_in_document({ path: rel, replacements, output_path }) {
    const p = this.resolve(rel);
    if (!fs.existsSync(p)) throw new ToolError(`파일이 없습니다: ${rel}`);
    const out = output_path ? this.resolve(output_path) : p;
    if (output_path && path.extname(out).toLowerCase() !== path.extname(p).toLowerCase()) throw new ToolError("output_path의 확장자는 원본과 같아야 합니다");
    if (out !== p) fs.mkdirSync(path.dirname(out), { recursive: true });
    let counts;
    try {
      counts = await docs.replaceInDocument(p, replacements, out);
    } catch (e) {
      if (e instanceof docs.DocumentError) throw new ToolError(e.message);
      throw e;
    }
    const lines = replacements.map((r, i) => `"${r.find}" -> "${r.replace}": ${counts[i]}곳`);
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) throw new ToolError("바꿀 글자를 찾지 못했습니다. 문서를 먼저 read_file로 읽고 정확한 글자를 확인하세요.\n" + lines.join("\n"));
    return `${this.rel(out)} 저장 (${total}곳 변경)\n` + lines.join("\n");
  }

  write_file({ path: rel, content }) {
    const p = this.resolve(rel);
    const ext = path.extname(p).toLowerCase();
    if (docs.DOC_EXTS.has(ext) && ext !== ".csv") throw new ToolError(`${ext} 문서는 write_file로 만들 수 없습니다. create_document를 쓰세요`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    return `저장 완료: ${this.rel(p)} (${content.length.toLocaleString()}자)`;
  }

  edit_file({ path: rel, old_text, new_text }) {
    const p = this.resolve(rel);
    if (!fs.existsSync(p)) throw new ToolError(`파일이 없습니다: ${rel}`);
    const ext = path.extname(p).toLowerCase();
    if (docs.DOC_EXTS.has(ext) && ext !== ".csv") throw new ToolError(`${ext} 문서는 edit_file로 고칠 수 없습니다. replace_in_document를 쓰세요`);
    const text = fs.readFileSync(p, "utf8");
    const count = text.split(old_text).length - 1;
    if (count !== 1) throw new ToolError(`old_text가 ${count}번 나옵니다. 정확히 한 번 나오도록 앞뒤 문맥을 더 넣으세요.`);
    fs.writeFileSync(p, text.replace(old_text, () => new_text), "utf8");
    return `수정 완료: ${this.rel(p)}`;
  }

  move_file({ source, destination }) {
    const src = this.resolve(source);
    const dst = this.resolve(destination);
    if (!fs.existsSync(src)) throw new ToolError(`없는 경로: ${source}`);
    if (src === this.root) throw new ToolError("작업 폴더 자체는 옮길 수 없습니다");
    if (fs.existsSync(dst)) throw new ToolError(`대상이 이미 있습니다: ${destination}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return `이동 완료: ${this.rel(src)} -> ${this.rel(dst)}`;
  }

  delete_file({ path: rel }) {
    const p = this.resolve(rel);
    if (p === this.root) throw new ToolError("작업 폴더 자체는 삭제할 수 없습니다");
    if (!fs.existsSync(p)) throw new ToolError(`없는 경로: ${rel}`);
    const dest = path.join(this.root, TRASH_DIR, timestamp(), this.rel(p));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(p, dest);
    return `삭제 완료 (복구 가능: ${this.rel(dest)})`;
  }

  run_command({ command }, signal) {
    return new Promise((resolve, reject) => {
      const [exe, args] = IS_WINDOWS
        ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; " + command]]
        : ["/bin/sh", ["-c", command]];
      const child = spawn(exe, args, { cwd: this.root, windowsHide: true, signal });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS);
      child.stdout.on("data", (d) => { if (out.length < OUTPUT_CHAR_LIMIT * 2) out += d; });
      child.stderr.on("data", (d) => { if (err.length < OUTPUT_CHAR_LIMIT * 2) err += d; });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new ToolError(e.name === "AbortError" ? "사용자가 중단했습니다" : `명령을 실행하지 못했습니다: ${e.message}`));
      });
      child.on("close", (code, sig) => {
        clearTimeout(timer);
        if (sig && !signal?.aborted) return reject(new ToolError(`${COMMAND_TIMEOUT_MS / 1000}초 안에 끝나지 않아 중단했습니다`));
        const text = out + (err ? "\n[stderr]\n" + err : "");
        resolve(`[종료 코드 ${code}]\n${truncateMiddle(text, OUTPUT_CHAR_LIMIT).trim()}`);
      });
    });
  }

  // --- 승인 화면용 미리보기

  async preview(name, args) {
    switch (name) {
      case "run_command":
        return { kind: "command", text: args.command };
      case "move_file":
        return { kind: "text", text: `${args.source}  ->  ${args.destination}` };
      case "delete_file":
        return { kind: "text", text: `삭제: ${args.path}  (${TRASH_DIR}/ 로 옮겨 복구 가능)` };
      case "create_document": {
        const p = this.resolve(args.path);
        const head = fs.existsSync(p) ? `기존 파일을 덮어씁니다: ${args.path}` : `새 문서: ${args.path}`;
        return { kind: "document", title: head, text: args.content };
      }
      case "replace_in_document": {
        const p = this.resolve(args.path);
        let counts = null;
        if (fs.existsSync(p)) {
          try {
            counts = await docs.replaceInDocument(p, args.replacements, null, { dryRun: true });
          } catch { /* 실행 단계에서 같은 오류를 돌려준다 */ }
        }
        const target = args.output_path ? `${args.path} -> ${args.output_path} (새 파일로 저장)` : `${args.path} (원본 수정)`;
        const lines = args.replacements.map((r, i) => `"${r.find}"  ->  "${r.replace}"${counts ? `   [${counts[i]}곳]` : ""}`);
        return { kind: "text", text: `${target}\n\n${lines.join("\n")}` };
      }
      case "write_file":
      case "edit_file": {
        const p = this.resolve(args.path);
        const old = fs.existsSync(p) && fs.statSync(p).isFile() ? fs.readFileSync(p, "utf8") : "";
        let next;
        if (name === "write_file") next = args.content;
        else {
          if (old.split(args.old_text).length - 1 !== 1) return { kind: "text", text: `${args.path} 수정 (old_text를 찾지 못해 실행 시 오류가 납니다)` };
          next = old.replace(args.old_text, () => args.new_text);
        }
        const patch = Diff.createTwoFilesPatch(`${args.path} (현재)`, `${args.path} (변경 후)`, old, next, "", "", { context: 2 });
        return { kind: "diff", text: patch.split("\n").slice(2).join("\n") };
      }
      default:
        return { kind: "text", text: JSON.stringify(args, null, 2) };
    }
  }

  /** 도구를 실행하고 { content, isError } 를 돌려준다. approve(name, args, preview) 는 Promise<{approved, always, feedback}> */
  async execute(name, args, approve, signal) {
    if (NEEDS_APPROVAL.has(name) && !this.alwaysAllow.has(name)) {
      let preview;
      try {
        preview = await this.preview(name, args);
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        return { content: `오류: ${e.message}`, isError: true };
      }
      const answer = await approve(name, args, preview);
      if (answer.always) this.alwaysAllow.add(name);
      if (!answer.approved) {
        let msg = "사용자가 이 작업을 거부했습니다.";
        if (answer.feedback) msg += ` 사용자 피드백: ${answer.feedback}`;
        return { content: msg, isError: true, rejected: true };
      }
    }
    try {
      return { content: await this[name](args, signal), isError: false };
    } catch (e) {
      if (e instanceof ToolError) return { content: `오류: ${e.message}`, isError: true };
      if (e && e.code && typeof e.message === "string") return { content: `오류: ${e.message}`, isError: true };
      throw e;
    }
  }
}

module.exports = { TOOLS, NEEDS_APPROVAL, Workspace, ToolError, validateInput, globToRegExp, TRASH_DIR, IS_WINDOWS, osInfo: () => `${os.type()} ${os.release()}` };
