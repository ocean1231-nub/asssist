"use strict";
// Electron 메인 프로세스: 창, 설정 저장, 에이전트 실행, 화면과의 IPC

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu, screen } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { Agent, MODELS, DEFAULT_MODEL, EFFORTS } = require("./src/agent");
const { GeminiAgent, GEMINI_MODELS, DEFAULT_GEMINI_MODEL } = require("./src/gemini");
const { Workspace } = require("./src/tools");

const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");
const ATTACH_DIR = "첨부";

let win = null;
let settings = { provider: "anthropic", geminiModel: DEFAULT_GEMINI_MODEL, geminiKeyEnc: null, geminiKeyPlain: null, model: DEFAULT_MODEL, effort: "medium", workspace: null, apiKeyEnc: null, apiKeyPlain: null, dock: false };
let agent = null;
let normalBounds = null; // 옆에 붙이기 전의 창 위치·크기
const DOCK_WIDTH = 420;
const SNAP_DISTANCE = 24; // 창 오른쪽 끝이 화면 오른쪽 끝에서 이만큼 안쪽이면 자동으로 붙는다
let dockBusyUntil = 0; // 프로그램이 창을 옮기는 동안(자동 붙임 판정 무시)
let snapTimer = null;
const pendingApprovals = new Map();
let approvalSeq = 0;

// ------------------------------------------------------------------ 설정

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8")) };
  } catch { /* 첫 실행 */ }
  if (!MODELS[settings.model]) settings.model = DEFAULT_MODEL;
  if (!["anthropic", "gemini"].includes(settings.provider)) settings.provider = "anthropic";
  if (typeof settings.geminiModel !== "string" || !settings.geminiModel) settings.geminiModel = DEFAULT_GEMINI_MODEL;
  if (!EFFORTS.includes(settings.effort)) settings.effort = "medium";
  if (settings.workspace && !fs.existsSync(settings.workspace)) settings.workspace = null;
}

function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
}

function readKey(enc, plain) {
  if (enc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, "base64"));
    } catch { /* 다른 컴퓨터에서 복사된 설정 등 */ }
  }
  return plain || null;
}

function getApiKey() {
  return readKey(settings.apiKeyEnc, settings.apiKeyPlain) || process.env.ANTHROPIC_API_KEY || null;
}

function getGeminiKey() {
  return readKey(settings.geminiKeyEnc, settings.geminiKeyPlain) || process.env.GEMINI_API_KEY || null;
}

/** 선택한 제공자의 키 */
function activeKey() {
  return settings.provider === "gemini" ? getGeminiKey() : getApiKey();
}

function storeKey(prefix, key) {
  if (safeStorage.isEncryptionAvailable()) {
    settings[prefix + "Enc"] = safeStorage.encryptString(key).toString("base64");
    settings[prefix + "Plain"] = null;
  } else {
    // 암호화 저장소가 없는 환경(일부 Linux)에서는 사용자 폴더의 설정 파일에 저장
    settings[prefix + "Enc"] = null;
    settings[prefix + "Plain"] = key;
  }
}

function setApiKey(key) {
  storeKey(settings.provider === "gemini" ? "geminiKey" : "apiKey", key);
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
  const key = activeKey();
  if (!key || !settings.workspace) return;
  const common = {
    workspace: new Workspace(settings.workspace, { printPdf }),
    onEvent: (evt) => send("agent:event", evt),
    approve: (name, args, preview) => new Promise((resolve) => {
      const id = ++approvalSeq;
      pendingApprovals.set(id, resolve);
      send("agent:approval", { id, name, preview });
    }),
  };
  agent = settings.provider === "gemini"
    ? new GeminiAgent({ ...common, apiKey: key, model: settings.geminiModel })
    : new Agent({ ...common, client: new Anthropic({ apiKey: key }), model: settings.model, effort: settings.effort });
}

function state() {
  const gemini = settings.provider === "gemini";
  const list = (m) => Object.entries(m).map(([id, v]) => ({ id, label: v.label }));
  return {
    provider: settings.provider,
    providers: {
      anthropic: { models: list(MODELS), model: settings.model, hasKey: !!getApiKey() },
      gemini: { models: list(GEMINI_MODELS), model: settings.geminiModel, hasKey: !!getGeminiKey() },
    },
    model: gemini ? settings.geminiModel : settings.model,
    effort: settings.effort,
    workspace: settings.workspace,
    hasKey: !!activeKey(),
    keyFromEnv: gemini
      ? !settings.geminiKeyEnc && !settings.geminiKeyPlain && !!process.env.GEMINI_API_KEY
      : !settings.apiKeyEnc && !settings.apiKeyPlain && !!process.env.ANTHROPIC_API_KEY,
    models: list(gemini ? GEMINI_MODELS : MODELS),
    efforts: EFFORTS,
    dock: !!settings.dock,
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

  ipcMain.handle("settings:save", (_e, { provider, model, effort, apiKey }) => {
    let rebuild = false;
    if ((provider === "anthropic" || provider === "gemini") && provider !== settings.provider) {
      settings.provider = provider;
      rebuild = true;
    }
    if (typeof apiKey === "string" && apiKey.trim()) {
      setApiKey(apiKey.trim());
      rebuild = true;
    }
    if (settings.provider === "gemini") {
      if (typeof model === "string" && /^[\w.\-]{1,80}$/.test(model)) settings.geminiModel = model;
    } else if (model && MODELS[model]) settings.model = model;
    if (effort && EFFORTS.includes(effort)) settings.effort = effort;
    saveSettings();
    if (rebuild || !agent) buildAgent();
    else agent.setOptions({ model: settings.provider === "gemini" ? settings.geminiModel : settings.model, effort: settings.effort });
    return state();
  });

  ipcMain.handle("window:dock", (_e, on) => {
    settings.dock = !!on;
    saveSettings();
    applyDock(settings.dock);
    return state();
  });

  ipcMain.handle("workspace:choose", async () => {
    const r = await dialog.showOpenDialog(win, { title: "작업 폴더 선택", properties: ["openDirectory", "createDirectory"] });
    refocus();
    if (r.canceled || !r.filePaths[0]) return state();
    settings.workspace = r.filePaths[0];
    saveSettings();
    buildAgent();
    return state();
  });

  ipcMain.handle("chat:send", (_e, text) => {
    if (!agent) return { ok: false, error: !activeKey() ? "API 키를 먼저 입력하세요" : "작업 폴더를 먼저 선택하세요" };
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

// 네이티브 대화상자가 닫힌 뒤 입력(한글 IME 포함)이 먹통이 되는 문제 방지
function refocus() {
  if (!win || win.isDestroyed()) return;
  win.blur();
  win.focus();
  win.webContents.focus();
}

/** 화면 오른쪽 가장자리에 좁게 붙여 항상 위에 띄운다(브라우저 옆에 두고 쓰는 용도). */
function applyDock(on) {
  if (!win) return;
  let target;
  if (on) {
    if (!normalBounds && !win.isAlwaysOnTop()) normalBounds = win.getBounds();
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    // 크롬북(X11)은 보이지 않는 창 테두리 때문에 실제 창이 더 커져 아래쪽(입력창)이 잘려서 여유를 둔다.
    const margin = process.platform === "linux" ? 48 : 0;
    target = { x: wa.x + wa.width - DOCK_WIDTH, y: wa.y + margin / 2, width: DOCK_WIDTH, height: wa.height - margin };
    win.setMinimumSize(320, 420);
    win.setAlwaysOnTop(true, "floating");
  } else {
    target = normalBounds || (() => {
      const wa = screen.getDisplayMatching(win.getBounds()).workArea;
      return { x: wa.x + Math.round((wa.width - 1120) / 2), y: wa.y + Math.round((wa.height - 800) / 2), width: 1120, height: 800 };
    })();
    normalBounds = null;
    // 화면 끝에 붙은 채 풀리면 살짝만 건드려도 다시 붙으므로 안쪽으로 민다.
    const wa = screen.getDisplayMatching(target).workArea;
    const limit = wa.x + wa.width - (SNAP_DISTANCE + 60);
    if (target.x + target.width > limit) target = { ...target, x: Math.max(wa.x, limit - target.width) };
    win.setAlwaysOnTop(false);
    win.setMinimumSize(720, 520);
  }
  // X11(크롬북)에서는 크기 변경이 비동기라 한 번 더 적용해야 안정적이다.
  dockBusyUntil = Date.now() + 1200;
  win.setBounds(target);
  setTimeout(() => {
    if (win && settings.dock === on) win.setBounds(target);
  }, 250);
}

/** 창을 끌어서 화면 오른쪽 끝에 대면 자동으로 옆에 붙인다. */
function maybeSnapToEdge() {
  if (!win || settings.dock || Date.now() < dockBusyUntil) return;
  if (win.isMaximized() || win.isFullScreen() || win.isMinimized()) return;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  if (b.x + b.width < wa.x + wa.width - SNAP_DISTANCE) return;
  if (b.width >= wa.width - 40) return; // 화면 거의 전체를 덮는 창은 대상이 아니다
  settings.dock = true;
  saveSettings();
  applyDock(true);
  win.webContents.send("window:dock-changed", state());
}

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
  win.webContents.once("did-finish-load", () => {
    if (settings.dock) setTimeout(() => applyDock(true), 300);
  });
  // 끌기가 끝나길(0.5초 동안 더 안 움직이길) 기다렸다가 판정한다. Linux는 'moved'가 없어 'move'를 쓴다.
  win.on("move", () => {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(maybeSnapToEdge, 500);
  });
  win.on("closed", () => {
    clearTimeout(snapTimer);
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
  if (process.platform === "linux") {
    // 크롬북(Crostini)의 한글 입력기(cros-im)는 Wayland text-input으로만 연결된다. X11로 띄우면 입력기가 아예 안 붙는다.
    // (확인: WAYLAND_DEBUG로 보면 이 옵션에서만 zwp_text_input_v1이 생성된다)
    app.commandLine.appendSwitch("ozone-platform", "wayland");
    app.commandLine.appendSwitch("enable-wayland-ime");
    app.commandLine.appendSwitch("wayland-text-input-version", "1");
    // 크롬북 가상GPU(virgl)에서 GPU 프로세스가 segfault로 죽어 창이 안 뜬다. 소프트웨어(swiftshader)로 그린다.
    app.commandLine.appendSwitch("use-gl", "angle");
    app.commandLine.appendSwitch("use-angle", "swiftshader");
    app.commandLine.appendSwitch("enable-unsafe-swiftshader");
    app.commandLine.appendSwitch("in-process-gpu");
  }
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
