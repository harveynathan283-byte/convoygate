const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const { execSync } = require("child_process");
const axios = require("axios");

let mainWindow;
const SERVER_URL = "https://api.convoygate.com";

let sessionToken = null;
const settingsPath = path.join(app.getPath("userData"), "convoygate_settings.json");

function getDefaultModDir() {
  const p = path.join(os.homedir(), "Documents", "American Truck Simulator", "mod");
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function getDefaultGameDir() {
  const common = [
    "C:\\Program Files (x86)\\Steam\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins",
    "C:\\Program Files\\Steam\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins",
    "D:\\SteamLibrary\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins",
  ];
  for (const p of common) {
    if (fs.existsSync(path.dirname(p))) {
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      return p;
    }
  }
  return path.join(os.homedir(), "Documents");
}

function loadSettingsData() {
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    }
  } catch (e) {}
  return {
    modDir: getDefaultModDir(),
    gameDir: getDefaultGameDir(),
    autoUpdate: true,
    autoInstall: false,
  };
}

function saveSettingsData(data) {
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), "utf8");
}

function getSystemHwid() {
  try {
    const raw = execSync('reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: "utf8" });
    const match = raw.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
    if (match && match[1]) return match[1].replace(/[^a-zA-Z0-9]/g, "").toLowerCase().trim();
  } catch (e) {}
  return os.hostname().replace(/[^a-zA-Z0-9]/g, "").toLowerCase().trim();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 740,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: "#060a12",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);

// --- IPC Handlers ---

ipcMain.handle("discord-login", async () => {
  return new Promise((resolve) => {
    const authWin = new BrowserWindow({
      width: 500,
      height: 750,
      parent: mainWindow,
      modal: true,
      autoHideMenuBar: true,
      backgroundColor: "#0d0f17",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    authWin.loadURL(`${SERVER_URL}/api/v1/auth/discord/login`);

    authWin.webContents.on("did-navigate", (event, url) => {
      if (url.includes("/api/v1/auth/discord/success")) {
        const urlObj = new URL(url);
        sessionToken = urlObj.searchParams.get("token");
        const username = urlObj.searchParams.get("username");
        authWin.close();
        resolve({ success: true, user: { username }, token: sessionToken });
      }
    });

    authWin.on("closed", () => {
      if (!sessionToken) {
        resolve({ success: false, error: "Authentication window closed." });
      }
    });
  });
});

ipcMain.handle("get-hwid", () => getSystemHwid());
ipcMain.handle("load-settings", () => loadSettingsData());
ipcMain.handle("save-settings", (event, data) => {
  saveSettingsData(data);
  return true;
});

ipcMain.handle("dialog-browse-dir", async (event, type) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: type === "mod" ? "Select Mod Installation Directory" : "Select ATS bin_x64\\plugins Directory",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("audit-plugin", () => {
  const settings = loadSettingsData();
  const pluginFile = path.join(settings.gameDir, "convoygate.dll");
  return {
    valid: fs.existsSync(pluginFile),
    path: pluginFile,
  };
});

ipcMain.handle("reinstall-plugin", () => {
  try {
    const settings = loadSettingsData();
    const target = path.join(settings.gameDir, "convoygate.dll");

    // Look for convoygate.dll across all possible packaged locations
    const candidates = [
      path.join(process.resourcesPath || "", "convoygate.dll"),
      path.join(__dirname, "..", "convoygate.dll"),
      path.join(__dirname, "convoygate.dll"),
      path.join(app.getAppPath(), "convoygate.dll"),
    ];

    let foundSource = null;
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        foundSource = p;
        break;
      }
    }

    if (!foundSource) {
      return { success: false, error: "convoygate.dll binary missing from app package." };
    }

    if (!fs.existsSync(settings.gameDir)) {
      fs.mkdirSync(settings.gameDir, { recursive: true });
    }

    fs.copyFileSync(foundSource, target);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fetch-catalog", async () => {
  try {
    const settings = loadSettingsData();
    const res = await axios.get(`${SERVER_URL}/api/v1/mods`, { timeout: 6000 });
    const mods = res.data.mods || [];

    const installed = {};
    for (const mod of mods) {
      const localPath = path.join(settings.modDir, `${mod.id}.scs`);
      if (fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        installed[mod.id] = {
          installed: true,
          needsUpdate: stat.size !== mod.file_size,
        };
      } else {
        installed[mod.id] = { installed: false, needsUpdate: false };
      }
    }

    return { success: true, mods, installed };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

async function downloadModPackage(modId, onProgress) {
  if (!sessionToken) throw new Error("No active session. Please log in with Discord.");

  const settings = loadSettingsData();
  const targetPath = path.join(settings.modDir, `${modId}.scs`);
  const tempPath = path.join(settings.modDir, `${modId}.scs.download`);

  const response = await axios({
    url: `${SERVER_URL}/api/v1/client/download/${modId}?token=${sessionToken}`,
    method: "GET",
    responseType: "stream",
    timeout: 30000,
  });

  const totalBytes = parseInt(response.headers["content-length"] || "0", 10);
  let bytesReceived = 0;

  const progressStream = new Transform({
    transform(chunk, enc, cb) {
      bytesReceived += chunk.length;
      if (totalBytes > 0 && onProgress) {
        onProgress(bytesReceived, totalBytes);
      }
      cb(null, chunk);
    },
  });

  const writer = fs.createWriteStream(tempPath);
  await pipeline(response.data, progressStream, writer);

  if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  fs.renameSync(tempPath, targetPath);
}

ipcMain.handle("install-single-mod", async (event, modId) => {
  try {
    if (!sessionToken) return { success: false, error: "Please log in with Discord first." };

    const settings = loadSettingsData();
    const hwid = getSystemHwid();

    // 1. Acquire cryptographic lease key
    const leaseRes = await axios.post(
      `${SERVER_URL}/api/v1/license/lease`,
      { hwid, modId },
      { headers: { Authorization: `Bearer ${sessionToken}` } }
    );

    if (!leaseRes.data || !leaseRes.data.success) {
      return { success: false, error: leaseRes.data?.error || "License denied by server." };
    }

    const keyPath = path.join(settings.gameDir, "convoygate.key");
    fs.writeFileSync(keyPath, JSON.stringify(leaseRes.data.lease, null, 2), "utf8");

    // 2. Download Mod
    await downloadModPackage(modId, (cur, total) => {
      const pct = Math.round((cur / total) * 100);
      event.sender.send("queue-progress", {
        message: `Downloading ${modId}.scs: ${(cur / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB`,
        percent: pct,
      });
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err.response?.data?.error || err.message };
  }
});

ipcMain.handle("install-all-mods", async (event) => {
  try {
    if (!sessionToken) return { success: false, error: "Please log in with Discord first." };

    const res = await axios.get(`${SERVER_URL}/api/v1/mods`, { timeout: 6000 });
    const mods = res.data.mods || [];

    for (let i = 0; i < mods.length; i++) {
      const mod = mods[i];
      event.sender.send("queue-progress", {
        message: `Installing [${i + 1}/${mods.length}]: ${mod.name}...`,
        percent: Math.round((i / mods.length) * 100),
      });

      await downloadModPackage(mod.id, (cur, total) => {
        const filePct = (cur / total) * (100 / mods.length);
        const overallPct = Math.round((i / mods.length) * 100 + filePct);
        event.sender.send("queue-progress", {
          message: `Downloading [${i + 1}/${mods.length}] ${mod.name}: ${(cur / 1024 / 1024).toFixed(1)} MB`,
          percent: overallPct,
        });
      });
    }

    // Refresh master rolling lease
    const hwid = getSystemHwid();
    const leaseRes = await axios.post(
      `${SERVER_URL}/api/v1/license/lease`,
      { hwid, modId: "all-access" },
      { headers: { Authorization: `Bearer ${sessionToken}` } }
    );

    const settings = loadSettingsData();
    const keyPath = path.join(settings.gameDir, "convoygate.key");
    fs.writeFileSync(keyPath, JSON.stringify(leaseRes.data.lease, null, 2), "utf8");

    return { success: true };
  } catch (err) {
    return { success: false, error: err.response?.data?.error || err.message };
  }
});

app.on("window-all-closed", () => app.quit());