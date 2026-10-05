"use strict";
// Electron 메인 프로세스: 창, 설정 저장, 에이전트 실행, 화면과의 IPC

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { Agent, MODELS, DEFAULT_MODEL, EFFORTS } = require("./src/agent");
const { Workspace } = require("./src/tools");

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");
const ATTACH_DIR = "첨부";

let win = null;
let settings = { model: DEFAULT_MODEL, effort: "medium", workspace: null, apiKeyEnc: null, apiKeyPlain: null };
let agent = null;
const pendingApprovals = new Map();
let approvalSeq = 0;

// ------------------------------------------------------------------ 설정

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")) };
  } catch { /* 첫 실행 */ }
  if (!MODELS[settings.model]) settings.model = DEFAULT_MODEL;
  if (!EFFORTS.includes(settings.effort)) settings.effort = "medium";
  if (settings.workspace && !fs.existsSync(settings.workspace)) settings.workspace = null;
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
}

function getApiKey() {
  if (settings.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(settings.apiKeyEnc, "base64"));
    } catch { /* 다른 컴퓨터에서 복사된 설정 등 */ }
  }
  return settings.apiKeyPlain || process.env.ANTHROPIC_API_KEY || null;
}

function setApiKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    settings.apiKeyEnc = safeStorage.encryptString(key).toString("base64");
    settings.apiKeyPlain = null;
  } else {
    // 암호화 저장소가 없는 환경(일부 Linux)에서는 사용자 폴더의 설정 파일에 저장
    settings.apiKeyEnc = null;
    settings.apiKeyPlain = key;
  }
}

// ------------------------------------------------------------------ 에이전트

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function rejectPendingApprovals() {
  for (const [, resolve] of pendingApprovals) resolve({ approved: false, always: false, feedback: "" });
  pendingApprovals.clear();
  send("agent:approval-cancel", null);
}

async function printPdf(html, outPath) {
  const tmp = path.join(os.tmpdir(), `doc-agent-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, html, "utf8");
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    await pdfWin.loadFile(tmp);
    const data = await pdfWin.webContents.printToPDF({ pageSize: "A4", printBackground: true, preferCSSPageSize: true });
    fs.writeFileSync(outPath, data);
  } finally {
    pdfWin.destroy();
    fs.rmSync(tmp, { force: true });
  }
}

/** 작업 폴더나 키가 바뀌면 에이전트를 새로 만든다 (대화 기록도 새로 시작). */
function buildAgent() {
  rejectPendingApprovals();
  if (agent) agent.stop();
  agent = null;
  const key = getApiKey();
  if (!key || !settings.workspace) return;
  agent = new Agent({
    client: new Anthropic({ apiKey: key }),
    workspace: new Workspace(settings.workspace, { printPdf }),
    model: settings.model,
    effort: settings.effort,
    onEvent: (evt) => send("agent:event", evt),
    approve: (name, args, preview) => new Promise((resolve) => {
      const id = ++approvalSeq;
      pendingApprovals.set(id, resolve);
      send("agent:approval", { id, name, preview });
    }),
  });
}

function state() {
  return {
    model: settings.model,
    effort: settings.effort,
    workspace: settings.workspace,
    hasKey: !!getApiKey(),
    keyFromEnv: !settings.apiKeyEnc && !settings.apiKeyPlain && !!process.env.ANTHROPIC_API_KEY,
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label })),
    efforts: EFFORTS,
    cost: agent ? { total: agent.cost.usd, tokens: agent.cost.tokens } : null,
  };
}

/** 작업 폴더 안의 경로인지 확인하고 절대 경로를 돌려준다. */
function insideWorkspace(rel) {
  if (!settings.workspace || typeof rel !== "string") return null;
  const root = fs.realpathSync(settings.workspace);
  const p = path.resolve(root, rel);
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle("state:get", () => state());

  ipcMain.handle("settings:save", (_e, { model, effort, apiKey }) => {
    let rebuild = false;
    if (typeof apiKey === "string" && apiKey.trim()) {
      setApiKey(apiKey.trim());
      rebuild = true;
    }
    if (model && MODELS[model]) settings.model = model;
    if (effort && EFFORTS.includes(effort)) settings.effort = effort;
    saveSettings();
    if (rebuild || !agent) buildAgent();
    else agent.setOptions({ model: settings.model, effort: settings.effort });
    return state();
  });

  ipcMain.handle("workspace:choose", async () => {
    const r = await dialog.showOpenDialog(win, { title: "작업 폴더 선택", properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return state();
    settings.workspace = r.filePaths[0];
    saveSettings();
    buildAgent();
    return state();
  });

  ipcMain.handle("chat:send", (_e, text) => {
    if (!agent) return { ok: false, error: !getApiKey() ? "API 키를 먼저 입력하세요" : "작업 폴더를 먼저 선택하세요" };
    if (agent.busy) return { ok: false, error: "이전 작업이 끝나지 않았습니다" };
    agent.send(String(text));
    return { ok: true };
  });

  ipcMain.handle("chat:stop", () => {
    rejectPendingApprovals();
    if (agent) agent.stop();
  });

  ipcMain.handle("chat:reset", () => {
    rejectPendingApprovals();
    if (agent) {
      agent.stop();
      agent.reset();
    }
  });

  ipcMain.handle("approval:respond", (_e, { id, approved, always, feedback }) => {
    const resolve = pendingApprovals.get(id);
    if (!resolve) return;
    pendingApprovals.delete(id);
    resolve({ approved: !!approved, always: !!always, feedback: typeof feedback === "string" ? feedback.slice(0, 2000) : "" });
  });

  // 끌어다 놓은 파일: 작업 폴더 밖에 있으면 "첨부" 폴더로 복사한다
  ipcMain.handle("files:attach", (_e, paths) => {
    if (!settings.workspace) return { error: "작업 폴더를 먼저 선택하세요" };
    const root = fs.realpathSync(settings.workspace);
    const out = [];
    for (const src of Array.isArray(paths) ? paths : []) {
      if (typeof src !== "string" || !fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
      const real = fs.realpathSync(src);
      if (real.startsWith(root + path.sep)) {
        out.push(path.relative(root, real).split(path.sep).join("/"));
        continue;
      }
      const dir = path.join(root, ATTACH_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const dest = uniquePath(dir, path.basename(real));
      fs.copyFileSync(real, dest);
      out.push(path.relative(root, dest).split(path.sep).join("/"));
    }
    return { files: out };
  });

  ipcMain.handle("file:open", async (_e, rel) => {
    const p = insideWorkspace(rel);
    if (!p || !fs.existsSync(p)) return "파일이 없습니다";
    return shell.openPath(p);
  });

  ipcMain.handle("folder:open", async () => (settings.workspace ? shell.openPath(settings.workspace) : ""));

  ipcMain.handle("link:open", (_e, url) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
  });
}

// ------------------------------------------------------------------ 창

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    title: "문서 에이전트",
    backgroundColor: "#f7f7f5",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.on("closed", () => {
    win = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    loadSettings();
    registerIpc();
    buildAgent();
    createWindow();
  });
  app.on("window-all-closed", () => {
    if (agent) agent.stop();
    app.quit();
  });
}
