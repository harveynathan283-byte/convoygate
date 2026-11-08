import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

function getWindowsHWID() {
  const cpus = os.cpus().map((c) => c.model).join(",");
  const network = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && !iface.internal && iface.mac !== "00:00:00:00:00:00")
    .map((iface) => iface.mac)
    .sort()
    .join(",");
  const username = os.userInfo().username;
  const platform = `${os.platform()}-${os.arch()}`;
  return crypto.createHash("sha256").update(`${platform}|${cpus}|${network}|${username}`).digest("hex").toUpperCase();
}

function getAtsPaths() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return {
      modDir: path.join(home, "Documents", "American Truck Simulator", "mod"),
      pluginDir: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins",
    };
  }
  return {
    modDir: path.join(home, "Library", "Application Support", "American Truck Simulator", "mod"),
    pluginDir: path.join(home, "Library", "Application Support", "Steam", "steamapps", "common", "American Truck Simulator", "plugins"),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 640,
    backgroundColor: "#0b0f19",
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    autoHideMenuBar: true,
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// IPC Handler: Fetch System Info
ipcMain.handle("get-system-info", () => {
  return {
    hwid: getWindowsHWID(),
    paths: getAtsPaths(),
  };
});

// IPC Handler: Sync Mod & Lease from Backend
ipcMain.handle("sync-mod", async (event, { serverUrl, discordId, modId }) => {
  const hwid = getWindowsHWID();
  const ats = getAtsPaths();

  const response = await fetch(`${serverUrl}/api/v1/license/lease`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ discordId, hwid, modId }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Subscription verification rejected.");
  }

  // 1. Write the rolling lease key file
  fs.mkdirSync(ats.pluginDir, { recursive: true });
  const keyPath = path.join(ats.pluginDir, "convoygate.key");
  fs.writeFileSync(keyPath, JSON.stringify(data.lease, null, 2));

  // 2. Fetch the encrypted .scs mod archive
  const fileResponse = await fetch(`${serverUrl}/api/v1/client/download/${modId}`);
  if (!fileResponse.ok) {
    throw new Error("Failed to download protected mod archive.");
  }

  const arrayBuffer = await fileResponse.arrayBuffer();
  fs.mkdirSync(ats.modDir, { recursive: true });
  const modPath = path.join(ats.modDir, `${modId}.scs`);
  fs.writeFileSync(modPath, Buffer.from(arrayBuffer));

  return { keyPath, modPath };
});