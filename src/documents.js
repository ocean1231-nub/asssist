"use strict";
// 문서 파일 읽기/쓰기 변환기.
// 읽기: txt/md/csv 등 텍스트, docx, doc, xlsx, csv, pptx, hwp, hwpx, odt/ods/odp, pdf, 이미지
// 쓰기: docx, xlsx, hwpx, pdf(Electron 인쇄 함수 주입), md/txt/html
// 수정: docx, hwpx, pptx 의 텍스트 치환 (서식 유지)

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".json", ".xml", ".html", ".htm", ".css", ".js", ".ts", ".py",
  ".java", ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".bat", ".ps1",
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".log", ".sql", ".tsv", ".srt", ".rtf",
]);
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const DOC_EXTS = new Set([".docx", ".doc", ".xlsx", ".xlsm", ".csv", ".pptx", ".hwp", ".hwpx", ".odt", ".ods", ".odp", ".pdf"]);
const CREATE_EXTS = new Set([".docx", ".xlsx", ".hwpx", ".pdf", ".md", ".txt", ".html"]);
const REPLACE_EXTS = new Set([".docx", ".hwpx", ".pptx"]);

const PDF_MAX_BYTES = 30 * 1024 * 1024;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

class DocumentError extends Error {}

// ------------------------------------------------------------------ XML 유틸

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 간단한 XML 토크나이저로 문단 단위 텍스트를 뽑는다.
 * opts.para: 문단 태그 또는 태그 배열(접두어 포함), opts.text: 텍스트 태그 (null이면 문단 안의 모든 텍스트),
 * opts.row / opts.cell: 표 행/셀 태그, opts.tab / opts.br: 탭/줄바꿈 태그
 */
function xmlToText(xml, opts) {
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*:?[\w.-]*)([^>]*?)(\/?)>|([^<]+)/g;
  const paraTags = new Set([].concat(opts.para));
  const out = [];
  let line = "";
  let paraDepth = 0;
  let textDepth = 0;
  let cells = null;
  const rowStack = [];
  let m;
  const flushLine = () => {
    const t = line.replace(/[ \t]+$/, "");
    if (cells) cells[cells.length - 1] += (cells[cells.length - 1] ? " " : "") + t;
    else out.push(t);
    line = "";
  };
  while ((m = tagRe.exec(xml))) {
    if (m[5] !== undefined) {
      if (paraDepth > 0 && (opts.text ? textDepth > 0 : true)) line += decodeEntities(m[5]);
      continue;
    }
    const closing = m[1] === "/";
    const selfClosing = m[4] === "/";
    const name = m[2];
    if (paraTags.has(name)) {
      if (!closing && !selfClosing) paraDepth++;
      if (closing || selfClosing) {
        if (closing) paraDepth = Math.max(0, paraDepth - 1);
        flushLine();
      }
    } else if (opts.text && name === opts.text) {
      if (!closing && !selfClosing) textDepth++;
      else if (closing) textDepth = Math.max(0, textDepth - 1);
    } else if (name === opts.tab && (paraDepth > 0)) {
      line += "\t";
    } else if (name === opts.br && (paraDepth > 0)) {
      line += "\n";
    } else if (opts.space && name === opts.space && paraDepth > 0) {
      const c = /c="(\d+)"/.exec(m[3]);
      line += " ".repeat(c ? Number(c[1]) : 1);
    } else if (opts.row && name === opts.row) {
      if (!closing && !selfClosing) {
        if (line) flushLine();
        rowStack.push(cells);
        cells = [];
      } else if (closing) {
        const row = cells || [];
        cells = rowStack.pop() || null;
        const text = "| " + row.map((c) => c.replace(/\n+/g, " ").trim()).join(" | ") + " |";
        if (cells) cells[cells.length - 1] += (cells[cells.length - 1] ? " " : "") + text;
        else out.push(text);
      }
    } else if (opts.cell && name === opts.cell && cells && !closing) {
      if (!selfClosing) cells.push("");
      else cells.push("");
    }
  }
  if (line) flushLine();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ------------------------------------------------------------------ 읽기

async function loadZip(buf) {
  const JSZip = require("jszip");
  try {
    return await JSZip.loadAsync(buf);
  } catch {
    throw new DocumentError("파일이 손상되었거나 형식이 올바르지 않습니다");
  }
}

function sortedParts(zip, re) {
  return Object.keys(zip.files)
    .filter((n) => re.test(n))
    .sort((a, b) => Number((a.match(/(\d+)\.xml$/) || [0, 0])[1]) - Number((b.match(/(\d+)\.xml$/) || [0, 0])[1]));
}

async function readDocx(buf) {
  const mammoth = require("mammoth");
  const { value } = await mammoth.convertToHtml({ buffer: buf });
  return htmlToText(value);
}

function htmlToText(html) {
  // 표는 먼저 행 단위 "| a | b |" 로 바꾼다 (셀 안의 문단은 공백으로 잇는다)
  html = html.replace(/<table[^>]*>([\s\S]*?)<\/table>/g, (m, inner) => {
    const rows = [];
    inner.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/g, (r, tr) => {
      const cells = [];
      tr.replace(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g, (c, td) => {
        cells.push(decodeEntities(td.replace(/<\/p>\s*<p[^>]*>/g, " ").replace(/<[^>]+>/g, "")).trim().replace(/\|/g, "/"));
        return "";
      });
      rows.push("| " + cells.join(" | ") + " |");
      return "";
    });
    return "<p>" + rows.map(escapeXml).join("<br />") + "</p>";
  });
  let s = html
    .replace(/<h([1-6])[^>]*>/g, (m, n) => "\n" + "#".repeat(Number(n)) + " ")
    .replace(/<\/h[1-6]>/g, "\n")
    .replace(/<li[^>]*>/g, "\n- ")
    .replace(/<\/(p|li|ul|ol)>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<(strong|b)>/g, "**")
    .replace(/<\/(strong|b)>/g, "**")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/^(#+ .*)$/gm, (line) => line.replace(/\*\*/g, ""));
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function readDoc(file) {
  const WordExtractor = require("word-extractor");
  const doc = await new WordExtractor().extract(file);
  return [doc.getHeaders({ includeFooters: false }), doc.getBody(), doc.getFootnotes(), doc.getFooters()]
    .map((s) => (s || "").trim()).filter(Boolean).join("\n\n");
}

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((r) => r.text).join("");
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return cellText(v.result);
    if (v.error) return String(v.error);
    return "";
  }
  return String(v);
}

async function readSpreadsheet(file, ext) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  try {
    if (ext === ".csv") await wb.csv.readFile(file);
    else await wb.xlsx.readFile(file);
  } catch (e) {
    throw new DocumentError(`스프레드시트를 읽지 못했습니다: ${e.message}`);
  }
  const parts = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (rows.length >= 5000) return;
      const values = [];
      for (let c = 1; c <= row.cellCount; c++) values.push(cellText(row.getCell(c).value).replace(/\|/g, "/").replace(/\n/g, " "));
      rows.push(`${n}행 | ${values.join(" | ")} |`);
    });
    parts.push(`## 시트: ${ws.name}\n` + (rows.join("\n") || "(빈 시트)"));
  });
  return parts.join("\n\n");
}

async function readPptx(buf) {
  const zip = await loadZip(buf);
  const slides = sortedParts(zip, /^ppt\/slides\/slide\d+\.xml$/);
  const parts = [];
  for (let i = 0; i < slides.length; i++) {
    const xml = await zip.file(slides[i]).async("string");
    const text = xmlToText(xml, { para: "a:p", text: "a:t", br: "a:br", row: "a:tr", cell: "a:tc" });
    parts.push(`## 슬라이드 ${i + 1}\n${text}`);
  }
  return parts.join("\n\n");
}

async function readHwpx(buf) {
  const zip = await loadZip(buf);
  const sections = sortedParts(zip, /^Contents\/section\d+\.xml$/);
  if (!sections.length) throw new DocumentError("HWPX 본문을 찾지 못했습니다");
  const parts = [];
  for (const s of sections) {
    const xml = await zip.file(s).async("string");
    parts.push(xmlToText(xml, { para: "hp:p", text: "hp:t", tab: "hp:tab", br: "hp:lineBreak", row: "hp:tr", cell: "hp:tc" }));
  }
  return parts.join("\n\n");
}

async function readOpenDocument(buf) {
  const zip = await loadZip(buf);
  const content = zip.file("content.xml");
  if (!content) throw new DocumentError("본문(content.xml)을 찾지 못했습니다");
  const xml = await content.async("string");
  const base = { text: null, tab: "text:tab", br: "text:line-break", space: "text:s", row: "table:table-row", cell: "table:table-cell" };
  return xmlToText(xml, { ...base, para: ["text:p", "text:h"] });
}

// HWP 5.0 (바이너리) 본문 텍스트 추출
function readHwp(buf) {
  const CFB = require("cfb");
  let cfb;
  try {
    cfb = CFB.read(buf, { type: "buffer" });
  } catch {
    throw new DocumentError("HWP 파일을 열지 못했습니다 (HWP 5.0 이상만 지원, 구버전 HWP 3.x는 미지원)");
  }
  const header = CFB.find(cfb, "FileHeader");
  if (!header) throw new DocumentError("HWP 파일 헤더가 없습니다");
  const props = Buffer.from(header.content).readUInt32LE(36);
  const compressed = (props & 1) !== 0;
  if (props & 2) throw new DocumentError("암호가 걸린 HWP 문서는 읽을 수 없습니다");
  if (props & 4) throw new DocumentError("배포용 HWP 문서는 읽을 수 없습니다. 한글에서 PDF로 저장한 뒤 읽어 주세요");

  const sections = cfb.FullPaths
    .map((p, i) => ({ p, i, m: /BodyText\/Section(\d+)$/.exec(p) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
  if (!sections.length) throw new DocumentError("HWP 본문을 찾지 못했습니다");

  const lines = [];
  for (const s of sections) {
    let data = Buffer.from(cfb.FileIndex[s.i].content);
    if (compressed) {
      try {
        data = zlib.inflateRawSync(data);
      } catch {
        throw new DocumentError("HWP 본문 압축을 풀지 못했습니다");
      }
    }
    let pos = 0;
    while (pos + 4 <= data.length) {
      const h = data.readUInt32LE(pos);
      pos += 4;
      const tag = h & 0x3ff;
      let size = (h >>> 20) & 0xfff;
      if (size === 0xfff) {
        if (pos + 4 > data.length) break;
        size = data.readUInt32LE(pos);
        pos += 4;
      }
      if (tag === 67) lines.push(decodeHwpParaText(data.subarray(pos, pos + size))); // HWPTAG_PARA_TEXT
      pos += size;
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeHwpParaText(b) {
  let out = "";
  for (let i = 0; i + 1 < b.length; ) {
    const c = b.readUInt16LE(i);
    if (c >= 32) {
      out += String.fromCharCode(c);
      i += 2;
    } else if (c === 0 || c === 10 || c === 13 || (c >= 24 && c <= 31)) {
      // 문자 컨트롤 (1글자 크기)
      if (c === 10) out += "\n";
      else if (c === 30 || c === 31) out += " ";
      else if (c === 24) out += "-";
      i += 2;
    } else {
      // 인라인/확장 컨트롤 (8글자 크기)
      if (c === 9) out += "\t";
      i += 16;
    }
  }
  return out;
}

/**
 * 파일을 읽어 { text } 또는 { blocks }(PDF/이미지, Claude에 그대로 전달)로 돌려준다.
 */
async function readDocument(file) {
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  if (IMAGE_TYPES[ext]) {
    if (stat.size > IMAGE_MAX_BYTES) throw new DocumentError("이미지가 5MB보다 커서 읽을 수 없습니다");
    return { blocks: [{ type: "image", source: { type: "base64", media_type: IMAGE_TYPES[ext], data: fs.readFileSync(file).toString("base64") } }] };
  }
  if (ext === ".pdf") {
    if (stat.size > PDF_MAX_BYTES) throw new DocumentError("PDF가 30MB보다 커서 읽을 수 없습니다");
    return {
      blocks: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: fs.readFileSync(file).toString("base64") }, title: path.basename(file) }],
    };
  }
  return { text: await readDocumentText(file) };
}

/** 문서를 텍스트로 변환 (PDF/이미지 제외). */
async function readDocumentText(file) {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".docx": return readDocx(fs.readFileSync(file));
    case ".doc": return readDoc(file);
    case ".xlsx": case ".xlsm": case ".csv": return readSpreadsheet(file, ext);
    case ".pptx": return readPptx(fs.readFileSync(file));
    case ".hwpx": return readHwpx(fs.readFileSync(file));
    case ".hwp": return readHwp(fs.readFileSync(file));
    case ".odt": case ".ods": case ".odp": return readOpenDocument(fs.readFileSync(file));
    case ".xls": case ".ppt":
      throw new DocumentError(`${ext} (구형 오피스 형식)은 지원하지 않습니다. 원본 프로그램에서 ${ext}x 형식으로 저장해 주세요`);
    default: {
      const buf = fs.readFileSync(file);
      if (buf.subarray(0, 8192).includes(0)) throw new DocumentError("지원하지 않는 바이너리 파일입니다");
      return buf.toString("utf8");
    }
  }
}

// ------------------------------------------------------------------ 마크다운 파싱 (쓰기용)

/**
 * 문서 작성용 간단한 마크다운 파서.
 * 지원: # 제목(1~3), 표(| a | b |), 글머리표(- 또는 *), 구분선(---), 일반 문단(앞 공백은 들여쓰기).
 * "1." "가." 같은 공문 번호는 자동 번호가 아니라 글자 그대로 둔다.
 */
function parseMarkdown(md) {
  const blocks = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      blocks.push({ type: "blank" });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ type: "heading", level: Math.min(h[1].length, 3), text: h[2] });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      const width = Math.max(...rows.map((r) => r.length));
      blocks.push({ type: "table", rows: rows.map((r) => r.concat(Array(width - r.length).fill(""))) });
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      continue;
    }
    const indent = Math.floor((raw.match(/^ */)[0].length) / 2);
    const b = /^\s*[-*]\s+(.*)$/.exec(line);
    if (b) {
      blocks.push({ type: "bullet", level: indent, text: b[1] });
      continue;
    }
    blocks.push({ type: "para", indent, text: line.trim() });
  }
  // 앞뒤 빈 줄과 연속 빈 줄 정리
  return blocks.filter((b, i, a) => !(b.type === "blank" && (i === 0 || i === a.length - 1 || a[i - 1].type === "blank")));
}

/** "**굵게**" 를 [{text, bold}] 조각으로 나눈다. */
function inlineRuns(text) {
  const runs = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index), bold: false });
    runs.push({ text: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ text: text.slice(last), bold: false });
  return runs.length ? runs : [{ text: "", bold: false }];
}

const plain = (text) => text.replace(/\*\*(.+?)\*\*/g, "$1");

// ------------------------------------------------------------------ 쓰기

async function createDocx(file, md) {
  const d = require("docx");
  const FONT = "맑은 고딕";
  const runs = (text, extra = {}) => inlineRuns(text).map((r) => new d.TextRun({ text: r.text, bold: r.bold || extra.bold, font: FONT, size: extra.size }));
  const children = [];
  for (const b of parseMarkdown(md)) {
    if (b.type === "blank") children.push(new d.Paragraph({ children: [] }));
    else if (b.type === "heading") {
      const level = [d.HeadingLevel.HEADING_1, d.HeadingLevel.HEADING_2, d.HeadingLevel.HEADING_3][b.level - 1];
      children.push(new d.Paragraph({ heading: level, children: runs(b.text, { bold: true, size: [32, 28, 24][b.level - 1] }) }));
    } else if (b.type === "bullet") {
      children.push(new d.Paragraph({ bullet: { level: Math.min(b.level, 8) }, children: runs(b.text) }));
    } else if (b.type === "rule") {
      children.push(new d.Paragraph({ border: { bottom: { style: d.BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, children: [] }));
    } else if (b.type === "table") {
      children.push(new d.Table({
        width: { size: 100, type: d.WidthType.PERCENTAGE },
        rows: b.rows.map((row, ri) => new d.TableRow({
          tableHeader: ri === 0,
          children: row.map((cell) => new d.TableCell({
            shading: ri === 0 ? { fill: "EEEEEE", type: d.ShadingType.CLEAR, color: "auto" } : undefined,
            children: [new d.Paragraph({ children: runs(cell, { bold: ri === 0 }) })],
          })),
        })),
      }));
    } else {
      children.push(new d.Paragraph({ indent: b.indent ? { left: 400 * b.indent } : undefined, children: runs(b.text) }));
    }
  }
  const doc = new d.Document({
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    sections: [{ properties: {}, children }],
  });
  fs.writeFileSync(file, await d.Packer.toBuffer(doc));
}

async function createXlsx(file, md) {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const blocks = parseMarkdown(md);
  const tables = blocks.filter((b) => b.type === "table");
  if (!tables.length) throw new DocumentError("엑셀로 만들 표가 없습니다. 내용을 마크다운 표(| 열1 | 열2 |)로 작성하세요");
  // 표 바로 앞의 제목을 시트 이름으로 쓴다
  let pendingName = null;
  let n = 0;
  for (const b of blocks) {
    if (b.type === "heading") pendingName = plain(b.text);
    if (b.type !== "table") continue;
    n++;
    const name = (pendingName || `시트${n}`).replace(/[\\/?*[\]:]/g, " ").slice(0, 31);
    pendingName = null;
    const ws = wb.addWorksheet(wb.getWorksheet(name) ? `${name.slice(0, 28)}_${n}` : name);
    b.rows.forEach((row, ri) => {
      const values = row.map((c) => {
        const t = plain(c);
        return ri > 0 && /^-?\d+(\.\d+)?$/.test(t.replace(/,/g, "")) ? Number(t.replace(/,/g, "")) : t;
      });
      const r = ws.addRow(values);
      if (ri === 0) r.font = { bold: true };
    });
    ws.columns.forEach((col) => {
      let w = 8;
      col.eachCell({ includeEmpty: false }, (c) => { w = Math.max(w, [...String(c.value ?? "")].reduce((s, ch) => s + (ch.charCodeAt(0) > 255 ? 2 : 1), 0) + 2); });
      col.width = Math.min(w, 60);
    });
  }
  await wb.xlsx.writeFile(file);
}

const HWPX_SKELETON = path.join(__dirname, "assets", "Skeleton.hwpx");

function hwpxParagraph(id, text, { indent = 0 } = {}) {
  const t = escapeXml(" ".repeat(indent * 2) + plain(text));
  return `<hp:p id="${id}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p>`;
}

async function createHwpx(file, md) {
  const JSZip = require("jszip");
  const zip = await JSZip.loadAsync(fs.readFileSync(HWPX_SKELETON));
  const secPath = "Contents/section0.xml";
  let xml = await zip.file(secPath).async("string");
  const paras = [];
  let id = 1;
  for (const b of parseMarkdown(md)) {
    if (b.type === "blank") paras.push(hwpxParagraph(id++, ""));
    else if (b.type === "heading") paras.push(hwpxParagraph(id++, b.text));
    else if (b.type === "bullet") paras.push(hwpxParagraph(id++, "- " + b.text, { indent: b.level }));
    else if (b.type === "rule") paras.push(hwpxParagraph(id++, "─".repeat(30)));
    else if (b.type === "table") for (const row of b.rows) paras.push(hwpxParagraph(id++, row.map(plain).join("\t")));
    else paras.push(hwpxParagraph(id++, b.text, { indent: b.indent }));
  }
  xml = xml.replace(/<\/hs:sec>\s*$/, paras.join("") + "</hs:sec>");
  zip.file(secPath, xml);
  const preview = parseMarkdown(md).filter((b) => b.text).map((b) => plain(b.text)).join("\r\n").slice(0, 1000);
  if (zip.file("Preview/PrvText.txt")) zip.file("Preview/PrvText.txt", preview);
  fs.writeFileSync(file, await writeZip(zip));
}

/** ZIP을 다시 쓸 때 mimetype 항목은 맨 앞, 무압축으로 둔다 (HWPX/ODF 규칙). */
async function writeZip(zip) {
  const mimetype = zip.file("mimetype");
  if (mimetype) {
    const content = await mimetype.async("uint8array");
    const JSZip = require("jszip");
    const out = new JSZip();
    out.file("mimetype", content, { compression: "STORE" });
    for (const name of Object.keys(zip.files)) {
      const f = zip.files[name];
      if (name === "mimetype" || f.dir) continue;
      out.file(name, await f.async("uint8array"), { compression: "DEFLATE", date: f.date, createFolders: false });
    }
    return out.generateAsync({ type: "nodebuffer" });
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function markdownToHtml(md, title) {
  const { marked } = require("marked");
  const body = marked.parse(md, { async: false });
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeXml(title)}</title>
<style>
@page { size: A4; margin: 20mm 18mm; }
body { font-family: "Malgun Gothic", "맑은 고딕", "Noto Sans KR", "Noto Sans CJK KR", sans-serif; font-size: 11pt; line-height: 1.6; color: #000; }
h1 { font-size: 18pt; text-align: center; margin: 0 0 12pt; }
h2 { font-size: 14pt; margin: 14pt 0 6pt; }
h3 { font-size: 12pt; margin: 12pt 0 4pt; }
table { border-collapse: collapse; width: 100%; margin: 8pt 0; }
th, td { border: 1px solid #555; padding: 4pt 6pt; text-align: left; vertical-align: top; }
th { background: #eee; }
p { margin: 4pt 0; white-space: pre-wrap; }
</style></head><body>${body}</body></html>`;
}

/**
 * 마크다운 내용으로 새 문서를 만든다.
 * printPdf(html, outPath): PDF 생성 함수 (Electron 메인 프로세스에서 주입).
 */
async function createDocument(file, md, { printPdf } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (!CREATE_EXTS.has(ext)) throw new DocumentError(`${ext || "확장자 없음"} 형식은 만들 수 없습니다. 가능: ${[...CREATE_EXTS].join(", ")}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  switch (ext) {
    case ".docx": return createDocx(file, md);
    case ".xlsx": return createXlsx(file, md);
    case ".hwpx": return createHwpx(file, md);
    case ".html": return fs.writeFileSync(file, markdownToHtml(md, path.basename(file, ext)), "utf8");
    case ".pdf":
      if (!printPdf) throw new DocumentError("이 환경에서는 PDF를 만들 수 없습니다");
      return printPdf(markdownToHtml(md, path.basename(file, ext)), file);
    default: return fs.writeFileSync(file, md, "utf8");
  }
}

// ------------------------------------------------------------------ 텍스트 치환 (서식 유지)

const REPLACE_SPEC = {
  ".docx": { parts: /^word\/(document|header\d*|footer\d*)\.xml$/, para: "w:p", text: "w:t" },
  ".hwpx": { parts: /^Contents\/section\d+\.xml$/, para: "hp:p", text: "hp:t", lineseg: "hp:linesegarray" },
  ".pptx": { parts: /^ppt\/slides\/slide\d+\.xml$/, para: "a:p", text: "a:t" },
};

/**
 * XML 한 파트에서 문단별로 텍스트를 이어 붙여 치환한다.
 * 찾는 글자가 여러 런(서식 조각)에 걸쳐 있으면 첫 런에 바꾼 글자를 넣고 나머지 런에서 지운다.
 * 반환: { xml, counts }
 */
function replaceInXml(xml, spec, replacements, counts) {
  const tagRe = /<(\/?)([A-Za-z_][\w.-]*:?[\w.-]*)([^>]*?)(\/?)>/g;
  const paraStack = [];
  const paras = [];
  const textNodes = [];
  const linesegs = [];
  let open = null;
  let m;
  while ((m = tagRe.exec(xml))) {
    const [full, slash, name, , self] = m;
    if (name === spec.para) {
      if (!slash && !self) {
        const p = { nodes: [], linesegs: [] };
        paras.push(p);
        paraStack.push(p);
      } else if (slash) paraStack.pop();
    } else if (name === spec.text && paraStack.length) {
      const owner = paraStack[paraStack.length - 1];
      if (self) {
        const node = { start: m.index, end: m.index + full.length, openTag: full.replace(/\s*\/>$/, ">"), text: "", selfClosing: true, para: owner };
        owner.nodes.push(node);
        textNodes.push(node);
      } else if (!slash) {
        open = { start: m.index, openTag: full, contentStart: m.index + full.length, para: owner };
      } else if (open) {
        const node = { start: open.start, end: m.index + full.length, openTag: open.openTag, text: decodeEntities(xml.slice(open.contentStart, m.index)), para: open.para };
        open.para.nodes.push(node);
        textNodes.push(node);
        open = null;
      }
    } else if (spec.lineseg && name === spec.lineseg && paraStack.length && !slash) {
      const owner = paraStack[paraStack.length - 1];
      let end = m.index + full.length;
      if (!self) {
        const close = xml.indexOf(`</${spec.lineseg}>`, end);
        if (close === -1) continue;
        end = close + spec.lineseg.length + 3;
        tagRe.lastIndex = end;
      }
      const ls = { start: m.index, end, para: owner };
      owner.linesegs.push(ls);
      linesegs.push(ls);
    }
  }

  const changedParas = new Set();
  for (const p of paras) {
    if (!p.nodes.length) continue;
    for (let ri = 0; ri < replacements.length; ri++) {
      const { find, replace } = replacements[ri];
      if (!find) continue;
      let joined = p.nodes.map((n) => n.text).join("");
      let idx = joined.lastIndexOf(find);
      while (idx !== -1) {
        // 뒤에서부터 바꿔야 앞쪽 위치가 유지된다
        const endIdx = idx + find.length;
        let acc = 0;
        let sNode = -1, sOff = 0, eNode = -1, eOff = 0;
        for (let k = 0; k < p.nodes.length; k++) {
          const len = p.nodes[k].text.length;
          if (sNode === -1 && idx < acc + len) { sNode = k; sOff = idx - acc; }
          if (eNode === -1 && endIdx <= acc + len) { eNode = k; eOff = endIdx - acc; }
          acc += len;
        }
        const sn = p.nodes[sNode];
        if (sNode === eNode) {
          sn.text = sn.text.slice(0, sOff) + replace + sn.text.slice(eOff);
        } else {
          sn.text = sn.text.slice(0, sOff) + replace;
          for (let k = sNode + 1; k < eNode; k++) p.nodes[k].text = "";
          p.nodes[eNode].text = p.nodes[eNode].text.slice(eOff);
        }
        for (let k = sNode; k <= eNode; k++) p.nodes[k].changed = true;
        changedParas.add(p);
        counts[ri]++;
        joined = p.nodes.map((n) => n.text).join("");
        idx = idx > 0 ? joined.lastIndexOf(find, idx - 1) : -1;
      }
    }
  }
  if (!changedParas.size) return xml;

  const edits = [];
  for (const n of textNodes) {
    if (!n.changed) continue;
    let openTag = n.openTag;
    const tagName = spec.text;
    if (tagName === "w:t" && /^\s|\s$/.test(n.text) && !/xml:space=/.test(openTag)) openTag = openTag.replace(/>$/, ' xml:space="preserve">');
    edits.push({ start: n.start, end: n.end, value: `${openTag}${escapeXml(n.text)}</${tagName}>` });
  }
  // 한글은 줄 배치 정보(linesegarray)를 캐시하므로, 바뀐 문단은 지워서 다시 계산하게 한다
  for (const ls of linesegs) if (changedParas.has(ls.para)) edits.push({ start: ls.start, end: ls.end, value: "" });
  edits.sort((a, b) => b.start - a.start);
  let out = xml;
  for (const e of edits) out = out.slice(0, e.start) + e.value + out.slice(e.end);
  return out;
}

/**
 * docx/hwpx/pptx 안의 글자를 바꾼다. outFile이 있으면 다른 이름으로 저장, dryRun이면 횟수만 센다.
 * 반환: 치환 항목별 바뀐 횟수 배열
 */
async function replaceInDocument(file, replacements, outFile, { dryRun = false } = {}) {
  const ext = path.extname(file).toLowerCase();
  const spec = REPLACE_SPEC[ext];
  if (!spec) throw new DocumentError(`${ext} 형식은 글자 치환을 지원하지 않습니다. 가능: ${[...REPLACE_EXTS].join(", ")}`);
  const zip = await loadZip(fs.readFileSync(file));
  const counts = replacements.map(() => 0);
  for (const name of Object.keys(zip.files).filter((n) => spec.parts.test(n))) {
    const xml = await zip.file(name).async("string");
    const next = replaceInXml(xml, spec, replacements, counts);
    if (next !== xml) zip.file(name, next);
  }
  if (!dryRun && counts.some((c) => c > 0)) fs.writeFileSync(outFile || file, await writeZip(zip));
  return counts;
}

module.exports = {
  DocumentError,
  TEXT_EXTS, DOC_EXTS, IMAGE_TYPES, CREATE_EXTS, REPLACE_EXTS,
  readDocument, readDocumentText, createDocument, replaceInDocument,
  parseMarkdown, markdownToHtml, xmlToText,
};
