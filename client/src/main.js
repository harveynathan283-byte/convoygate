const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, Notification } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const axios = require("axios");

let mainWindow = null;
let tray = null;
let isQuitting = false;
let syncInterval = null;
let watchdogInterval = null;

const SERVER_URL = "https://api.convoygate.com";
const SESSION_FILE = path.join(app.getPath("userData"), "session.json");
const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");
const MANAGED_MODS_FILE = path.join(app.getPath("userData"), "managed_mods.json");

function getDefaultModDir() {
  const home = os.homedir();
  const atsMod = path.join(home, "Documents", "American Truck Simulator", "mod");
  const etsMod = path.join(home, "Documents", "Euro Truck Simulator 2", "mod");
  if (fs.existsSync(path.join(home, "Documents", "American Truck Simulator"))) return atsMod;
  if (fs.existsSync(path.join(home, "Documents", "Euro Truck Simulator 2"))) return etsMod;
  return atsMod;
}

function getDefaultGameDir() {
  return "C:\\Program Files (x86)\\Steam\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins";
}

let userSettings = {
  modDir: getDefaultModDir(),
  gameDir: getDefaultGameDir(),
  startOnBoot: true,
  backgroundSync: true,
  autoUpdate: true,
  autoInstall: false,
  syncIntervalMinutes: 15
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      userSettings = { ...userSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) };
    }
  } catch (e) {}
  if (!fs.existsSync(userSettings.modDir)) fs.mkdirSync(userSettings.modDir, { recursive: true });
}

function saveSettings(newSettings) {
  userSettings = { ...userSettings, ...newSettings };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(userSettings, null, 2), "utf8");
  } catch (e) {}

  app.setLoginItemSettings({
    openAtLogin: userSettings.startOnBoot !== false,
    openAsHidden: true,
  });
}

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
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

function loadManagedMods() {
  try {
    if (fs.existsSync(MANAGED_MODS_FILE)) return JSON.parse(fs.readFileSync(MANAGED_MODS_FILE, "utf8"));
  } catch (e) {}
  return [];
}

function recordManagedMod(modId) {
  const list = loadManagedMods();
  if (!list.includes(modId)) {
    list.push(modId);
    try {
      fs.writeFileSync(MANAGED_MODS_FILE, JSON.stringify(list, null, 2), "utf8");
    } catch (e) {}
  }
}

function removeManagedModRecord(modId) {
  let list = loadManagedMods();
  list = list.filter(id => id !== modId);
  try {
    fs.writeFileSync(MANAGED_MODS_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (e) {}
}

function getHWID() {
  const network = JSON.stringify(os.networkInterfaces());
  const raw = `${os.hostname()}_${os.platform()}_${os.arch()}_${network}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function purgeAllManagedMods(reason) {
  const trackedMods = loadManagedMods();
  const destDir = userSettings.modDir;
  let purgedCount = 0;

  trackedMods.forEach((modId) => {
    const filePath = path.join(destDir, `${modId}.scs`);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        purgedCount++;
      } catch (e) {}
    }
  });

  try {
    fs.writeFileSync(MANAGED_MODS_FILE, JSON.stringify([], null, 2), "utf8");
  } catch (e) {}

  const keyPath = path.join(userSettings.gameDir, "convoygate.key");
  if (fs.existsSync(keyPath)) {
    try { fs.unlinkSync(keyPath); } catch (e) {}
  }

  if (purgedCount > 0 && Notification.isSupported()) {
    new Notification({
      title: "ConvoyGate Security Action",
      body: reason || "Subscription role or core plugin removed. Managed mods uninstalled."
    }).show();
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("sync-completed");
  }
}

// Active Watchdog: Audits Discord role, lease validity, and DLL presence
async function auditSubscriberStatusAndEnforce() {
  const session = loadSession();
  const pluginFile = path.join(userSettings.gameDir, "convoygate.dll");

  // Rule 1: User deleted or uninstalled convoygate.dll
  if (!fs.existsSync(pluginFile)) {
    purgeAllManagedMods("convoygate.dll was deleted from the game plugins directory. All managed mods removed.");
    return false;
  }

  // Rule 2: No active session
  if (!session || !session.token) {
    purgeAllManagedMods("No active Discord login found. All managed mods removed.");
    return false;
  }

  // Rule 3: Active Discord role validation with VPS
  try {
    const res = await axios.post(
      `${SERVER_URL}/api/v1/license/lease`,
      { hwid: getHWID() },
      { headers: { Authorization: `Bearer ${session.token}` }, timeout: 6000 }
    );

    if (res.data && res.data.success) {
      if (fs.existsSync(userSettings.gameDir)) {
        const keyPath = path.join(userSettings.gameDir, "convoygate.key");
        fs.writeFileSync(keyPath, JSON.stringify(res.data.lease), "utf8");
      }
      return true;
    } else {
      purgeAllManagedMods("Discord subscriber role is no longer active. Mods de-authorized.");
      return false;
    }
  } catch (err) {
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
      purgeAllManagedMods("Discord subscriber role revoked. All managed mods deleted.");
      return false;
    }
    return true;
  }
}

// Background sync & cloud catalog pruning
async function runSilentBackgroundUpdate(notifyUser = false) {
  const isAuthorized = await auditSubscriberStatusAndEnforce();
  if (!isAuthorized) return;

  const session = loadSession();
  if (!session || !session.token) return;

  try {
    const res = await axios.get(`${SERVER_URL}/api/v1/mods`, { timeout: 8000 });
    if (!res.data || !res.data.success) return;

    const remoteMods = res.data.mods || [];
    const remoteModIds = new Set(remoteMods.map(m => m.id));
    const destDir = userSettings.modDir;
    const trackedMods = loadManagedMods();

    // Rule 4: If a mod is removed by admin from publisher, delete it on client system
    for (const localModId of trackedMods) {
      if (!remoteModIds.has(localModId)) {
        const localFile = path.join(destDir, `${localModId}.scs`);
        if (fs.existsSync(localFile)) {
          try {
            fs.unlinkSync(localFile);
          } catch (e) {}
        }
        removeManagedModRecord(localModId);
      }
    }

    let updatedCount = 0;
    for (const mod of remoteMods) {
      const localFile = path.join(destDir, `${mod.id}.scs`);
      let needsDownload = false;

      if (!fs.existsSync(localFile)) {
        if (userSettings.autoInstall) needsDownload = true;
      } else {
        const stat = fs.statSync(localFile);
        if (userSettings.autoUpdate && stat.size !== mod.file_size) {
          needsDownload = true;
        }
      }

      if (needsDownload) {
        const tempFile = path.join(destDir, `${mod.id}.scs.download`);
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
          recordManagedMod(mod.id);
          updatedCount++;
        } catch (e) {
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }
      }
    }

    if (updatedCount > 0 && Notification.isSupported()) {
      new Notification({
        title: "ConvoyGate Mods Synchronized",
        body: `Updated/installed ${updatedCount} mod package(s).`
      }).show();
    } else if (notifyUser && Notification.isSupported()) {
      new Notification({
        title: "ConvoyGate",
        body: "All mods are up to date."
      }).show();
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("sync-completed");
    }
  } catch (err) {}
}

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
    width: 1080,
    height: 780,
    minWidth: 860,
    minHeight: 580,
    backgroundColor: "#060a12",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.on("close", (event) => {
    if (!isQuitting && userSettings.backgroundSync) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
  });
}

function createTray() {
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

app.whenReady().then(() => {
  loadSettings();
  createWindow();
  createTray();

  setTimeout(auditSubscriberStatusAndEnforce, 2000);
  watchdogInterval = setInterval(auditSubscriberStatusAndEnforce, 30 * 1000);

  syncInterval = setInterval(() => {
    if (userSettings.backgroundSync) {
      runSilentBackgroundUpdate(false);
    }
  }, (userSettings.syncIntervalMinutes || 15) * 60 * 1000);

  setTimeout(() => runSilentBackgroundUpdate(false), 5000);
});

async function handleDiscordLogin() {
  return new Promise((resolve) => {
    const authWin = new BrowserWindow({
      width: 520,
      height: 750,
      parent: mainWindow,
      modal: true,
      show: true,
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
        auditSubscriberStatusAndEnforce();
        resolve({ success: true, ...sessionData });
      }
    });

    authWin.on("closed", () => {
      const session = loadSession();
      if (!session) {
        resolve({ success: false, error: "Discord authentication was closed." });
      }
    });
  });
}

ipcMain.handle("discord-login", handleDiscordLogin);
ipcMain.handle("discord-client-login", handleDiscordLogin);

ipcMain.handle("get-stored-session", async () => {
  const session = loadSession();
  if (!session) return { hasSession: false };
  return { hasSession: true, session };
});

ipcMain.handle("logout", () => {
  clearSession();
  purgeAllManagedMods("Logged out of Discord session.");
  return { success: true };
});

ipcMain.handle("get-hwid", () => getHWID());

ipcMain.handle("load-settings", () => userSettings);
ipcMain.handle("get-settings", () => userSettings);
ipcMain.handle("save-settings", (event, newSettings) => {
  saveSettings(newSettings);
  return userSettings;
});
ipcMain.handle("update-settings", (event, newSettings) => {
  saveSettings(newSettings);
  return userSettings;
});

ipcMain.handle("audit-plugin", () => {
  const pluginFile = path.join(userSettings.gameDir, "convoygate.dll");
  const exists = fs.existsSync(pluginFile);
  return { valid: exists, path: pluginFile };
});

ipcMain.handle("reinstall-plugin", () => {
  try {
    fs.mkdirSync(userSettings.gameDir, { recursive: true });
    const targetPath = path.join(userSettings.gameDir, "convoygate.dll");
    const bundledPath = path.join(__dirname, "..", "assets", "convoygate.dll");
    if (fs.existsSync(bundledPath)) {
      fs.copyFileSync(bundledPath, targetPath);
    }
    return { success: true, path: targetPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("dialog-browse-dir", async (event, type) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: type === "mod" ? "Select Mod Directory" : "Select Game Plugins Directory",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("fetch-catalog", async () => {
  try {
    const res = await axios.get(`${SERVER_URL}/api/v1/mods`, { timeout: 8000 });
    const mods = res.data?.mods || [];
    const remoteModIds = new Set(mods.map(m => m.id));
    const destDir = userSettings.modDir;
    const trackedMods = loadManagedMods();

    for (const localModId of trackedMods) {
      if (!remoteModIds.has(localModId)) {
        const localFile = path.join(destDir, `${localModId}.scs`);
        if (fs.existsSync(localFile)) {
          try { fs.unlinkSync(localFile); } catch (e) {}
        }
        removeManagedModRecord(localModId);
      }
    }

    const installed = {};
    mods.forEach(mod => {
      const localPath = path.join(userSettings.modDir, `${mod.id}.scs`);
      if (fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        installed[mod.id] = {
          installed: true,
          needsUpdate: stat.size !== mod.file_size
        };
      } else {
        installed[mod.id] = {
          installed: false,
          needsUpdate: false
        };
      }
    });

    return { success: true, mods, installed };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("get-single-mod-details", async (event, mod) => {
  const targetPath = path.join(userSettings.modDir, `${mod.id}.scs`);
  let description = `Package: ${mod.name}\nVersion: ${mod.version}\nTier: ${mod.tier || "All Tiers"}\n\nSynced via ConvoyGate.`;
  let iconBase64 = null;

  if (fs.existsSync(targetPath)) {
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

ipcMain.handle("install-single-mod", async (event, modId) => {
  const session = loadSession();
  const token = session ? session.token : "";
  const targetFile = path.join(userSettings.modDir, `${modId}.scs`);
  const tempFile = path.join(userSettings.modDir, `${modId}.scs.download`);

  try {
    event.sender.send("queue-progress", { message: `Requesting stream for ${modId}...`, percent: 20 });

    const res = await axios({
      method: "GET",
      url: `${SERVER_URL}/api/v1/client/download/${encodeURIComponent(modId)}?token=${token}`,
      responseType: "stream",
      timeout: 600000,
    });

    const writer = fs.createWriteStream(tempFile);
    await new Promise((resolve, reject) => {
      res.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
    fs.renameSync(tempFile, targetFile);
    recordManagedMod(modId);

    event.sender.send("queue-progress", { message: `Installed ${modId}.scs`, percent: 100 });
    return { success: true };
  } catch (err) {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    return { success: false, error: err.response?.data?.error || err.message };
  }
});

ipcMain.handle("install-all-mods", async (event) => {
  const session = loadSession();
  const token = session ? session.token : "";

  try {
    const res = await axios.get(`${SERVER_URL}/api/v1/mods`, { timeout: 8000 });
    const mods = res.data?.mods || [];
    let processed = 0;

    for (const mod of mods) {
      const targetFile = path.join(userSettings.modDir, `${mod.id}.scs`);
      const tempFile = path.join(userSettings.modDir, `${mod.id}.scs.download`);
      const pct = Math.round((processed / mods.length) * 100);

      event.sender.send("queue-progress", {
        message: `[${processed + 1}/${mods.length}] Downloading ${mod.name}...`,
        percent: pct
      });

      const downloadRes = await axios({
        method: "GET",
        url: `${SERVER_URL}/api/v1/client/download/${encodeURIComponent(mod.id)}?token=${token}`,
        responseType: "stream",
        timeout: 600000,
      });

      const writer = fs.createWriteStream(tempFile);
      await new Promise((resolve, reject) => {
        downloadRes.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
      fs.renameSync(tempFile, targetFile);
      recordManagedMod(mod.id);
      processed++;
    }

    event.sender.send("queue-progress", { message: "All mods successfully installed!", percent: 100 });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("uninstall-mod", (event, modId) => {
  const p = path.join(userSettings.modDir, `${modId}.scs`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  removeManagedModRecord(modId);
  return { success: true };
});

ipcMain.handle("uninstall-all-mods", () => {
  purgeAllManagedMods("User triggered clean uninstall.");
  return { success: true };
});

ipcMain.handle("sync-now", async () => {
  await runSilentBackgroundUpdate(true);
  return { success: true };
});

app.on("session-end", () => {
  isQuitting = true;
  app.exit(0);
});

app.on("before-quit", () => {
  isQuitting = true;
});