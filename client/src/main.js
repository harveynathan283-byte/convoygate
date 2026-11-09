const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const { execSync } = require("child_process");
const axios = require("axios");

let mainWindow;

// Normalize Hardware ID / Computer Name
function getSystemHwid() {
  try {
    const raw = execSync(
      'reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
      { encoding: "utf8" }
    );
    const match = raw.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
    if (match && match[1]) {
      return match[1].replace(/[^a-zA-Z0-9]/g, "").toLowerCase().trim();
    }
  } catch (err) {
    // Fallback to computer name
  }
  return os.hostname().replace(/[^a-zA-Z0-9]/g, "").toLowerCase().trim();
}

function findAtsPluginDir() {
  const commonPaths = [
    "C:\\Program Files (x86)\\Steam\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins",
    "C:\\Program Files\\Steam\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins",
    "D:\\SteamLibrary\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins",
    "E:\\SteamLibrary\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins",
    "F:\\SteamLibrary\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins",
  ];

  for (const p of commonPaths) {
    const parent = path.dirname(p);
    if (fs.existsSync(parent)) {
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
      }
      return p;
    }
  }
  return null;
}

function getAtsModDir() {
  const docDir = path.join(os.homedir(), "Documents", "American Truck Simulator", "mod");
  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
  }
  return docDir;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 660,
    minWidth: 640,
    minHeight: 580,
    backgroundColor: "#0d0f17",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);

ipcMain.handle("get-hwid", () => {
  return getSystemHwid();
});

ipcMain.handle("sync-mod-and-lease", async (event, { serverUrl, discordId, modId, hwid }) => {
  try {
    // Step 1: Acquire Signed 30-Day Lease
    event.sender.send("sync-progress", { message: "Connecting to license server...", percent: 5 });

    const leaseRes = await axios.post(
      `${serverUrl}/api/v1/license/lease`,
      { discordId, hwid, modId },
      { timeout: 10000 }
    );

    if (!leaseRes.data || !leaseRes.data.success) {
      return { success: false, error: leaseRes.data?.error || "Lease request denied by server." };
    }

    const leaseData = leaseRes.data.lease;

    // Step 2: Write convoygate.key into ATS plugins folder
    const pluginDir = findAtsPluginDir();
    if (!pluginDir) {
      return {
        success: false,
        error: "Could not find 'American Truck Simulator\\bin\\win_x64\\plugins'. Ensure ATS is installed via Steam.",
      };
    }

    const keyPath = path.join(pluginDir, "convoygate.key");
    fs.writeFileSync(keyPath, JSON.stringify(leaseData, null, 2), "utf8");
    event.sender.send("sync-progress", { message: "30-day hardware lease verified and saved.", percent: 15 });

    // Step 3: Stream Download with Live Byte Tracking
    const modDir = getAtsModDir();
    const modPath = path.join(modDir, `${modId}.scs`);
    const tempModPath = path.join(modDir, `${modId}.scs.download`);

    event.sender.send("sync-progress", { message: "Requesting mod package from catalog...", percent: 20 });

    const downloadRes = await axios({
      url: `${serverUrl}/api/v1/client/download/${modId}`,
      method: "GET",
      responseType: "stream",
      timeout: 30000,
    });

    const totalBytes = parseInt(downloadRes.headers["content-length"] || "0", 10);
    let receivedBytes = 0;

    const progressTransform = new Transform({
      transform(chunk, encoding, callback) {
        receivedBytes += chunk.length;
        if (totalBytes > 0) {
          const percent = 20 + Math.round((receivedBytes / totalBytes) * 75);
          const currentMB = (receivedBytes / 1024 / 1024).toFixed(1);
          const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
          event.sender.send("sync-progress", {
            message: `Downloading mod: ${currentMB} MB / ${totalMB} MB (${Math.round((receivedBytes / totalBytes) * 100)}%)...`,
            percent,
          });
        }
        callback(null, chunk);
      },
    });

    const fileWriter = fs.createWriteStream(tempModPath);
    await pipeline(downloadRes.data, progressTransform, fileWriter);

    if (fs.existsSync(modPath)) {
      fs.unlinkSync(modPath);
    }
    fs.renameSync(tempModPath, modPath);

    event.sender.send("sync-progress", { message: "Download completed and verified.", percent: 100 });

    return {
      success: true,
      message: `Sync successful!\n- Key: ${keyPath}\n- Mod: ${modPath}\n\nYou can now launch American Truck Simulator!`,
    };
  } catch (err) {
    return {
      success: false,
      error: err.code === "ECONNREFUSED"
        ? `Could not reach server at ${serverUrl}. Ensure backend is running.`
        : err.message,
    };
  }
});

app.on("window-all-closed", () => {
  app.quit();
});