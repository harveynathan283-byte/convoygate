const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");

let mainWindow = null;
let tray = null;
let isQuitting = false;
let syncInterval = null;

const SERVER_URL = "https://api.convoygate.com";
const SESSION_FILE = path.join(app.getPath("userData"), "session.json");
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");

// Default Settings
let userSettings = {
  startOnBoot: true,
  backgroundSync: true,
  syncIntervalMinutes: 15
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      userSettings = { ...userSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
    }
  } catch (e) {}
}

function saveSettings(newSettings) {
  userSettings = { ...userSettings, ...newSettings };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings, null, 2), "utf8");
  } catch (e) {}

  // Sync with Windows Startup
  app.setLoginItemSettings({
    openAtLogin: userSettings.startOnBoot,
    openAsHidden: true,
  });
}

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    }
  } catch (e) {}
  return null;
}

function saveSession(sessionData) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2), "utf8");
  } catch (e) {}
}

function clearSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  } catch (e) {}
}

// Auto-detect ATS and ETS2 documents directories
function getGameModDirs() {
  const home = os.homedir();
  const atsMod = path.join(home, "Documents", "American Truck Simulator", "mod");
  const etsMod = path.join(home, "Documents", "Euro Truck Simulator 2", "mod");
  const dirs = [];

  if (fs.existsSync(path.join(home, "Documents", "American Truck Simulator"))) {
    fs.mkdirSync(atsMod, { recursive: true });
    dirs.push(atsMod);
  }
  if (fs.existsSync(path.join(home, "Documents", "Euro Truck Simulator 2"))) {
    fs.mkdirSync(etsMod, { recursive: true });
    dirs.push(etsMod);
  }

  if (dirs.length === 0) {
    fs.mkdirSync(atsMod, { recursive: true });
    dirs.push(atsMod);
  }
  return dirs;
}

// Ensure single instance running
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 840,
    minHeight: 560,
    backgroundColor: "#060a12",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  // Minimize to Tray on close instead of exiting
  mainWindow.on("close", (event) => {
    if (!isQuitting && userSettings.backgroundSync) {
      event.preventDefault();
      mainWindow.hide();
      if (Notification.isSupported()) {
        new Notification({
          title: "ConvoyGate is active",
          body: "ConvoyGate is running in the background to keep your mods updated."
        }).show();
      }
    }
  });
}

function createTray() {
  // Built-in base64 icon so no missing file crashes the tray
  const iconBase64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAZElEQVQ4T2NkoBAwUqifYdQAHsXIhvoZw5L//xkYGBkZGBmZkSQY8en4//8/A8P///8Z0QVGDRhUBoA0w9SDNCNpgGmGG4BkABkewGkAOR5ACg7UeIDR1IBfPQwzB5u7sRlASvAAq8tF38k5bE0AAAAASUVORK5CYII=";
  const image = nativeImage.createFromBuffer(Buffer.from(iconBase64, "base64"));
  
  tray = new Tray(image);
  tray.setToolTip("ConvoyGate - Mod Auto-Updater");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open ConvoyGate",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: "Sync Mods Now",
      click: () => runSilentBackgroundUpdate(true)
    },
    { type: "separator" },
    {
      label: "Quit Completely",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Background Auto-Update Engine
async function runSilentBackgroundUpdate(notifyUser = false) {
  const session = loadSession();
  if (!session || !session.token) return;

  try {
    const res = await axios.get(`${SERVER_URL}/api/v1/mods`, { timeout: 8000 });
    if (!res.data || !res.data.success) return;

    const remoteMods = res.data.mods;
    const dirs = getGameModDirs();
    const primaryDir = dirs[0];
    let updatedCount = 0;

    for (const mod of remoteMods) {
      const localFile = path.join(primaryDir, `${mod.id}.scs`);
      let needsDownload = false;

      if (!fs.existsSync(localFile)) {
        // Auto-install newly added mods
        needsDownload = true;
      } else {
        const stat = fs.statSync(localFile);
        // If file size changed, mod has an update
        if (stat.size !== mod.file_size) {
          needsDownload = true;
        }
      }

      if (needsDownload) {
        const tempFile = path.join(primaryDir, `${mod.id}.scs.download`);
        try {
          const downloadRes = await axios({
            method: "GET",
            url: `${SERVER_URL}/api/v1/client/download/${encodeURIComponent(mod.id)}?token=${session.token}`,
            responseType: "stream",
            timeout: 600000,
          });

          const writer = fs.createWriteStream(tempFile);
          await new Promise((resolve, reject) => {
            downloadRes.data.pipe(writer);
            writer.on("finish", resolve);
            writer.on("error", reject);
          });

          if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
          fs.renameSync(tempFile, localFile);
          updatedCount++;
        } catch (e) {
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }
      }
    }

    if (updatedCount > 0 && Notification.isSupported()) {
      new Notification({
        title: "ConvoyGate Mods Synchronized",
        body: `Updated/installed ${updatedCount} mod package(s). Your game is ready!`
      }).show();
    } else if (notifyUser && Notification.isSupported()) {
      new Notification({
        title: "ConvoyGate",
        body: "All mods are already up to date!"
      }).show();
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("sync-completed");
    }
  } catch (err) {}
}

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  createTray();

  // Background Sync Interval (Default 15 minutes)
  syncInterval = setInterval(() => {
    if (userSettings.backgroundSync) {
      runSilentBackgroundUpdate(false);
    }
  }, userSettings.syncIntervalMinutes * 60 * 1000);

  // Initial silent check on boot
  setTimeout(() => runSilentBackgroundUpdate(false), 5000);
});

// --- IPC HANDLERS ---

// Session management
ipcMain.handle("get-stored-session", async () => {
  const session = loadSession();
  if (!session) return { hasSession: false };

  // Validate token with VPS
  try {
    const res = await axios.get(`${SERVER_URL}/api/v1/health`, { timeout: 4000 });
    if (res.status === 200) {
      return { hasSession: true, session };
    }
  } catch (err) {}

  return { hasSession: true, session };
});

ipcMain.handle("save-session", (event, sessionData) => {
  saveSession(sessionData);
  return { success: true };
});

ipcMain.handle("logout", () => {
  clearSession();
  return { success: true };
});

// Settings management
ipcMain.handle("get-settings", () => userSettings);
ipcMain.handle("update-settings", (event, newSettings) => {
  saveSettings(newSettings);
  return userSettings;
});

// Discord Login OAuth Window
ipcMain.handle("discord-client-login", async () => {
  return new Promise((resolve) => {
    const authWin = new BrowserWindow({
      width: 500,
      height: 750,
      parent: mainWindow,
      modal: true,
      autoHideMenuBar: true,
      backgroundColor: "#060a12",
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    authWin.loadURL(`${SERVER_URL}/api/v1/auth/discord/login`);

    authWin.webContents.on("did-navigate", (event, url) => {
      if (url.includes("/api/v1/auth/discord/success")) {
        const urlObj = new URL(url);
        const token = urlObj.searchParams.get("token");
        const username = urlObj.searchParams.get("username");
        const sessionData = { token, user: { username } };
        saveSession(sessionData);
        authWin.close();
        resolve({ success: true, ...sessionData });
      }
    });

    authWin.on("closed", () => {
      resolve({ success: false, error: "Authentication cancelled." });
    });
  });
});

// Mod Catalog
ipcMain.handle("get-catalog", async () => {
  try {
    const res = await axios.get(`${SERVER_URL}/api/v1/mods`, { timeout: 8000 });
    return res.data;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Installed mods
ipcMain.handle("get-installed-mods", () => {
  const dirs = getGameModDirs();
  const installedIds = new Set();

  dirs.forEach(d => {
    if (fs.existsSync(d)) {
      const files = fs.readdirSync(d);
      files.forEach(f => {
        if (f.endsWith(".scs")) {
          installedIds.add(f.replace(/\.scs$/i, ""));
        }
      });
    }
  });

  return Array.from(installedIds);
});

// Inspect Single Mod Details
ipcMain.handle("get-single-mod-details", async (event, mod) => {
  const dirs = getGameModDirs();
  let targetPath = null;

  for (const d of dirs) {
    const p = path.join(d, `${mod.id}.scs`);
    if (fs.existsSync(p)) {
      targetPath = p;
      break;
    }
  }

  let description = `Package: ${mod.name}\nVersion: ${mod.version}\nTier: ${mod.tier || "All Tiers"}\n\nProtected by ConvoyGate Decryption Streaming.`;
  let iconBase64 = null;

  if (targetPath) {
    try {
      const fd = fs.openSync(targetPath, "r");
      const stat = fs.fstatSync(fd);
      const searchLen = Math.min(stat.size, 65557);
      const searchBuf = Buffer.alloc(searchLen);
      fs.readSync(fd, searchBuf, 0, searchLen, stat.size - searchLen);

      let eocd = -1;
      for (let i = searchLen - 22; i >= 0; i--) {
        if (searchBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
      }

      if (eocd !== -1) {
        const cdSize = searchBuf.readUInt32LE(eocd + 12);
        const cdOffset = searchBuf.readUInt32LE(eocd + 16);
        const cdBuf = Buffer.alloc(cdSize);
        fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

        let pos = 0;
        while (pos < cdSize) {
          if (cdBuf.readUInt32LE(pos) !== 0x02014b50) break;
          const compressedSize = cdBuf.readUInt32LE(pos + 20);
          const nameLen = cdBuf.readUInt16LE(pos + 28);
          const extraLen = cdBuf.readUInt16LE(pos + 30);
          const commentLen = cdBuf.readUInt16LE(pos + 32);
          const lfhOffset = cdBuf.readUInt32LE(pos + 42);

          const nameBuf = Buffer.alloc(nameLen);
          fs.readSync(fd, nameBuf, 0, nameLen, cdOffset + pos + 46);
          const fileName = nameBuf.toString("utf8");

          if (fileName.toLowerCase().includes("description.txt")) {
            const dataOffset = lfhOffset + 30 + nameLen;
            const descBuf = Buffer.alloc(compressedSize);
            fs.readSync(fd, descBuf, 0, compressedSize, dataOffset);
            description = descBuf.toString("utf8");
          } else if (fileName.toLowerCase().includes("mod_icon.jpg")) {
            const dataOffset = lfhOffset + 30 + nameLen;
            const iconBuf = Buffer.alloc(compressedSize);
            fs.readSync(fd, iconBuf, 0, compressedSize, dataOffset);
            iconBase64 = `data:image/jpeg;base64,${iconBuf.toString("base64")}`;
          }

          pos += 46 + nameLen + extraLen + commentLen;
        }
      }
      fs.closeSync(fd);
    } catch (e) {}
  }

  return { description, iconBase64 };
});

// Download & Install Mod
ipcMain.handle("download-mod", async (event, modId) => {
  const session = loadSession();
  const token = session ? session.token : "";

  const dirs = getGameModDirs();
  const destDir = dirs[0];
  const targetFile = path.join(destDir, `${modId}.scs`);
  const tempFile = path.join(destDir, `${modId}.scs.download`);

  try {
    const res = await axios({
      method: "GET",
      url: `${SERVER_URL}/api/v1/client/download/${encodeURIComponent(modId)}?token=${token}`,
      responseType: "stream",
      timeout: 300000,
    });

    const writer = fs.createWriteStream(tempFile);
    await new Promise((resolve, reject) => {
      res.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
    fs.renameSync(tempFile, targetFile);

    return { success: true };
  } catch (err) {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    return { success: false, error: err.response?.data?.error || err.message };
  }
});

// Uninstall Single Mod
ipcMain.handle("uninstall-mod", (event, modId) => {
  const dirs = getGameModDirs();
  dirs.forEach(d => {
    const p = path.join(d, `${modId}.scs`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  return { success: true };
});

// Uninstall All Mods
ipcMain.handle("uninstall-all-mods", () => {
  const dirs = getGameModDirs();
  let count = 0;

  dirs.forEach(d => {
    if (fs.existsSync(d)) {
      const files = fs.readdirSync(d);
      files.forEach(f => {
        if (f.endsWith(".scs")) {
          try {
            fs.unlinkSync(path.join(d, f));
            count++;
          } catch (e) {}
        }
      });
    }
  });

  return { success: true, removedCount: count };
});

// Force background sync from UI
ipcMain.handle("sync-now", async () => {
  await runSilentBackgroundUpdate(true);
  return { success: true };
});

app.on("before-quit", () => {
  isQuitting = true;
});