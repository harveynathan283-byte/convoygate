const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");
const axios = require("axios");

let mainWindow;

// 1. Matches GetVolumeInformationA from convoygate_plugin.cpp
function getLocalHWID() {
  if (process.platform === "win32") {
    try {
      const output = execSync("vol C:", { encoding: "utf8" });
      const match = output.match(/([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})/);
      if (match) {
        return `WIN-${match[1]}${match[2]}`.toUpperCase();
      }
    } catch (err) {
      console.error("[HWID] Error reading volume serial:", err);
    }
  }

  // Fallback for macOS development
  const username = os.userInfo().username;
  const hash = crypto.createHash("md5").update(username).digest("hex").substring(0, 8).toUpperCase();
  return `WIN-${hash}`;
}

// 2. Resolve ATS directory structure
function getAtsPaths() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return {
      modDir: path.join(home, "Documents", "American Truck Simulator", "mod"),
      pluginDir: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins",
      binDir: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\American Truck Simulator\\bin\\win_x64",
      rootDir: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\American Truck Simulator",
    };
  } else {
    return {
      modDir: path.join(home, "Library", "Application Support", "American Truck Simulator", "mod"),
      pluginDir: path.join(home, "Library", "Application Support", "Steam", "steamapps", "common", "American Truck Simulator", "plugins"),
      binDir: path.join(home, "Library", "Application Support", "Steam", "steamapps", "common", "American Truck Simulator", "bin", "win_x64"),
      rootDir: path.join(home, "Library", "Application Support", "Steam", "steamapps", "common", "American Truck Simulator"),
    };
  }
}

// 3. Built-in CVG1 Decryptor & Mod Deployer
function unpackCvgPackage(dataBuffer, targetDir, hexKey) {
  const aesKey = Buffer.from(hexKey, "hex");
  const manifestLen = dataBuffer.readUInt32LE(4);
  const manifestJson = dataBuffer.toString("utf-8", 8, 8 + manifestLen);
  const manifest = JSON.parse(manifestJson);

  let offset = 8 + manifestLen;
  fs.mkdirSync(targetDir, { recursive: true });

  for (const item of manifest) {
    const chunk = dataBuffer.subarray(offset, offset + item.packedSize);
    offset += item.packedSize;

    const destPath = path.join(targetDir, item.file);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    if (item.encrypted) {
      const iv = chunk.subarray(0, 12);
      const tag = chunk.subarray(12, 28);
      const ciphertext = chunk.subarray(28);

      const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      fs.writeFileSync(destPath, decrypted);
    } else {
      fs.writeFileSync(destPath, chunk);
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 620,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle("get-hwid", () => {
    return getLocalHWID();
  });

  ipcMain.handle("sync-mod", async (event, { serverUrl, discordId, modId }) => {
    const hwid = getLocalHWID();
    const ats = getAtsPaths();

    // Step A: Request signed 30-day lease
    const leaseRes = await axios.post(`${serverUrl}/api/v1/license/lease`, {
      discordId,
      hwid,
      modId,
    });

    if (!leaseRes.data.success) {
      throw new Error(leaseRes.data.error || "Subscription verification failed.");
    }

    // Step B: Write compact convoygate.key to plugin & root paths
    fs.mkdirSync(ats.pluginDir, { recursive: true });
    const keyPath = path.join(ats.pluginDir, "convoygate.key");
    const compactKey = JSON.stringify(leaseRes.data.lease);
    fs.writeFileSync(keyPath, compactKey);

    try {
      fs.writeFileSync(path.join(ats.binDir, "convoygate.key"), compactKey);
      fs.writeFileSync(path.join(ats.rootDir, "convoygate.key"), compactKey);
    } catch (_) {}

    // Step C: Download encrypted mod package
    fs.mkdirSync(ats.modDir, { recursive: true });
    const downloadRes = await axios.get(`${serverUrl}/api/v1/client/download/${modId}`, {
      responseType: "arraybuffer",
    });
    const packageBuffer = Buffer.from(downloadRes.data);

    // Step D: Detect CVG1 container vs Standard ZIP
    const magic = packageBuffer.length >= 4 ? packageBuffer.toString("utf-8", 0, 4) : "";
    const targetFolder = path.join(ats.modDir, modId);
    const targetScs = path.join(ats.modDir, `${modId}.scs`);

    if (magic === "CVG1") {
      // Remove stale/corrupted binary .scs file if present
      if (fs.existsSync(targetScs)) fs.unlinkSync(targetScs);

      // Decrypt directly into ATS folder-mod format
      const aesKey = leaseRes.data.aesKey || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      unpackCvgPackage(packageBuffer, targetFolder, aesKey);

      return { keyPath, modPath: targetFolder };
    } else {
      // Direct SCS archive
      fs.writeFileSync(targetScs, packageBuffer);
      return { keyPath, modPath: targetScs };
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});