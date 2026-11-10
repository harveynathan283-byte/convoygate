const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const axios = require("axios");

let mainWindow;
const SERVER_URL = "https://api.convoygate.com";
let adminSessionToken = null;

// ConvoyGate Static Master Cipher Key
const DRM_CIPHER_KEY = Buffer.from([
  0x43, 0x6F, 0x6E, 0x76, 0x6F, 0x79, 0x47, 0x61, // "ConvoyGa"
  0x74, 0x65, 0x53, 0x65, 0x63, 0x75, 0x72, 0x65  // "teSecure"
]);

const MEGAPACKS_DIR = path.join(app.getPath("userData"), "megapacks_storage");
const REGISTRY_FILE = path.join(app.getPath("userData"), "megapacks_registry.json");

if (!fs.existsSync(MEGAPACKS_DIR)) fs.mkdirSync(MEGAPACKS_DIR, { recursive: true });

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  } catch (e) {}
  return [];
}

function saveRegistry(data) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), "utf8");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 920,
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

// --- Discord Admin Authentication ---
ipcMain.handle("discord-admin-login", async () => {
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

    authWin.loadURL(`${SERVER_URL}/api/v1/auth/discord/admin-login`);

    authWin.webContents.on("did-navigate", (event, url) => {
      if (url.includes("/api/v1/auth/discord/admin-success")) {
        const urlObj = new URL(url);
        adminSessionToken = urlObj.searchParams.get("token");
        const username = urlObj.searchParams.get("username");
        authWin.close();
        resolve({ success: true, user: { username }, token: adminSessionToken });
      }
    });

    authWin.on("closed", () => {
      if (!adminSessionToken) {
        resolve({ success: false, error: "Admin login window closed." });
      }
    });
  });
});

// Encrypt a buffer in place with stream cipher
function encryptPayload(buffer) {
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] ^= DRM_CIPHER_KEY[i % DRM_CIPHER_KEY.length] ^ (i & 0xFF);
  }
}

// Scramble an existing SCS/ZIP archive's contents AND headers
function encryptAndLockScsArchive(inputPath, outputPath, onProgress) {
  fs.copyFileSync(inputPath, outputPath);

  const fd = fs.openSync(outputPath, "r+");
  const stat = fs.fstatSync(fd);
  const fileSize = stat.size;

  const searchLen = Math.min(fileSize, 65557);
  const searchBuf = Buffer.alloc(searchLen);
  fs.readSync(fd, searchBuf, 0, searchLen, fileSize - searchLen);

  let eocdOffsetInBuf = -1;
  for (let i = searchLen - 22; i >= 0; i--) {
    if (searchBuf.readUInt32LE(i) === 0x06054b50) {
      eocdOffsetInBuf = i;
      break;
    }
  }

  if (eocdOffsetInBuf === -1) {
    fs.closeSync(fd);
    throw new Error("Invalid archive: missing EOCD.");
  }

  const cdSize = searchBuf.readUInt32LE(eocdOffsetInBuf + 12);
  const cdOffset = searchBuf.readUInt32LE(eocdOffsetInBuf + 16);

  const cdBuf = Buffer.alloc(cdSize);
  fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

  let pos = 0;
  let fileCount = 0;

  while (pos < cdSize) {
    if (cdBuf.readUInt32LE(pos) !== 0x02014b50) break;

    const nameLen = cdBuf.readUInt16LE(pos + 28);
    const extraLen = cdBuf.readUInt16LE(pos + 30);
    const commentLen = cdBuf.readUInt16LE(pos + 32);
    const lfhOffset = cdBuf.readUInt32LE(pos + 42);

    const nameBuf = Buffer.alloc(nameLen);
    fs.readSync(fd, nameBuf, 0, nameLen, cdOffset + pos + 46);
    const fileName = nameBuf.toString("utf8");

    const isMetadata = fileName.toLowerCase().includes("manifest.sii") || 
                       fileName.toLowerCase().includes("mod_icon.jpg") ||
                       fileName.toLowerCase().includes("description.txt");

    cdBuf.writeUInt16LE(99, pos + 6);
    const flags = cdBuf.readUInt16LE(pos + 8);
    cdBuf.writeUInt16LE(flags | 0x0001, pos + 8);

    const lfhHeader = Buffer.alloc(30);
    fs.readSync(fd, lfhHeader, 0, 30, lfhOffset);

    if (lfhHeader.readUInt32LE(0) === 0x04034b50) {
      const lfhNameLen = lfhHeader.readUInt16LE(26);
      const lfhExtraLen = lfhHeader.readUInt16LE(28);
      const compressedSize = lfhHeader.readUInt32LE(18);
      const dataOffset = lfhOffset + 30 + lfhNameLen + lfhExtraLen;

      if (!isMetadata && compressedSize > 0) {
        const payloadBuf = Buffer.alloc(compressedSize);
        fs.readSync(fd, payloadBuf, 0, compressedSize, dataOffset);
        encryptPayload(payloadBuf);
        fs.writeSync(fd, payloadBuf, 0, compressedSize, dataOffset);
      }

      lfhHeader.writeUInt16LE(99, 4);
      lfhHeader.writeUInt16LE(flags | 0x0001, 6);
      fs.writeSync(fd, lfhHeader, 0, 30, lfhOffset);
    }

    pos += 46 + nameLen + extraLen + commentLen;
    fileCount++;
    if (onProgress && fileCount % 100 === 0) onProgress(fileCount);
  }

  fs.writeSync(fd, cdBuf, 0, cdSize, cdOffset);
  fs.closeSync(fd);
}

function getAllFiles(dir, base = "") {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of list) {
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      results = results.concat(getAllFiles(full, rel));
    } else {
      results.push({ full, rel });
    }
  }
  return results;
}

function copyFolderRecursive(source, target) {
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  const items = fs.readdirSync(source, { withFileTypes: true });
  for (const item of items) {
    const srcPath = path.join(source, item.name);
    const dstPath = path.join(target, item.name);
    if (item.isDirectory()) {
      copyFolderRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

function extractArchiveToDir(archivePath, targetDir) {
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const fd = fs.openSync(archivePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    const searchLen = Math.min(fileSize, 65557);
    const searchBuf = Buffer.alloc(searchLen);
    fs.readSync(fd, searchBuf, 0, searchLen, fileSize - searchLen);

    let eocdOffset = -1;
    for (let i = searchLen - 22; i >= 0; i--) {
      if (searchBuf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) throw new Error("Invalid archive: missing EOCD.");

    const cdSize = searchBuf.readUInt32LE(eocdOffset + 12);
    const cdOffset = searchBuf.readUInt32LE(eocdOffset + 16);
    const cdBuf = Buffer.alloc(cdSize);
    fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

    let pos = 0;
    while (pos < cdSize) {
      if (cdBuf.readUInt32LE(pos) !== 0x02014b50) break;

      const method = cdBuf.readUInt16LE(pos + 10);
      const compressedSize = cdBuf.readUInt32LE(pos + 20);
      const nameLen = cdBuf.readUInt16LE(pos + 28);
      const extraLen = cdBuf.readUInt16LE(pos + 30);
      const commentLen = cdBuf.readUInt16LE(pos + 32);
      const lfhOffset = cdBuf.readUInt32LE(pos + 42);

      const nameBuf = Buffer.alloc(nameLen);
      fs.readSync(fd, nameBuf, 0, nameLen, cdOffset + pos + 46);
      const rawFileName = nameBuf.toString("utf8").replace(/\\/g, "/");

      pos += 46 + nameLen + extraLen + commentLen;
      if (rawFileName.endsWith("/")) continue;

      const lfhHeader = Buffer.alloc(30);
      fs.readSync(fd, lfhHeader, 0, 30, lfhOffset);
      if (lfhHeader.readUInt32LE(0) !== 0x04034b50) continue;

      const lfhNameLen = lfhHeader.readUInt16LE(26);
      const lfhExtraLen = lfhHeader.readUInt16LE(28);
      const dataOffset = lfhOffset + 30 + lfhNameLen + lfhExtraLen;

      const compBuf = Buffer.alloc(compressedSize);
      fs.readSync(fd, compBuf, 0, compressedSize, dataOffset);

      let decompressed;
      if (method === 0) {
        decompressed = compBuf;
      } else if (method === 8) {
        try {
          decompressed = zlib.inflateRawSync(compBuf);
        } catch (e) {
          continue;
        }
      } else {
        continue;
      }

      const destPath = path.join(targetDir, rawFileName);
      const destSubDir = path.dirname(destPath);
      if (!fs.existsSync(destSubDir)) fs.mkdirSync(destSubDir, { recursive: true });
      fs.writeFileSync(destPath, decompressed);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function packFolderEncrypted(sourceFolder, outputPath, onProgress) {
  const files = getAllFiles(sourceFolder);
  if (files.length === 0) throw new Error("Folder contains no mod assets.");

  const outFd = fs.openSync(outputPath, "w");
  let currentOffset = 0;
  const centralEntries = [];

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    let fileBuf = fs.readFileSync(item.full);
    const nameBuf = Buffer.from(item.rel, "utf8");
    const isMetadata = item.rel.toLowerCase().includes("manifest.sii") || 
                       item.rel.toLowerCase().includes("mod_icon.jpg") ||
                       item.rel.toLowerCase().includes("description.txt");

    if (!isMetadata) {
      encryptPayload(fileBuf);
    }

    const size = fileBuf.length;
    if (onProgress && i % 100 === 0) onProgress(i + 1, files.length);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(99, 4);
    lfh.writeUInt16LE(0x0001, 6);
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(0xDEADBEEF, 14);
    lfh.writeUInt32LE(size, 18);
    lfh.writeUInt32LE(size, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    fs.writeSync(outFd, lfh, 0, lfh.length, currentOffset);
    currentOffset += lfh.length;
    fs.writeSync(outFd, nameBuf, 0, nameBuf.length, currentOffset);
    currentOffset += nameBuf.length;
    fs.writeSync(outFd, fileBuf, 0, fileBuf.length, currentOffset);

    const localHeaderOffset = currentOffset - lfh.length - nameBuf.length;
    currentOffset += fileBuf.length;

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x0314, 4);
    cd.writeUInt16LE(99, 6);
    cd.writeUInt16LE(0x0001, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0xDEADBEEF, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(localHeaderOffset, 42);

    centralEntries.push({ cd, nameBuf });
  }

  const cdStartOffset = currentOffset;
  for (const entry of centralEntries) {
    fs.writeSync(outFd, entry.cd, 0, entry.cd.length, currentOffset);
    currentOffset += entry.cd.length;
    fs.writeSync(outFd, entry.nameBuf, 0, entry.nameBuf.length, currentOffset);
    currentOffset += entry.nameBuf.length;
  }
  const cdSize = currentOffset - cdStartOffset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStartOffset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeSync(outFd, eocd, 0, eocd.length, currentOffset);
  fs.closeSync(outFd);
}

function streamUploadToBackend(filePath, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SERVER_URL}/api/v1/admin/upload-stream`);
    const stat = fs.statSync(filePath);
    const client = url.protocol === "https:" ? https : http;

    const authHeaders = {};
    if (adminSessionToken) {
      authHeaders["Authorization"] = `Bearer ${adminSessionToken}`;
    } else {
      authHeaders["x-admin-key"] = "cg_admin_local_fallback";
    }

    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? url.port : (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": stat.size,
          ...authHeaders,
          ...headers,
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(responseBody));
          } catch {
            resolve({ success: res.statusCode >= 200 && res.statusCode < 300, data: responseBody });
          }
        });
      }
    );

    req.on("error", (err) => reject(err));

    const fileStream = fs.createReadStream(filePath);
    let bytesSent = 0;

    const progressTransform = new Transform({
      transform(chunk, encoding, callback) {
        bytesSent += chunk.length;
        if (onProgress) onProgress(bytesSent, stat.size);
        callback(null, chunk);
      },
    });

    pipeline(fileStream, progressTransform, req).catch((err) => reject(err));
  });
}

function updateMegaPackManifest(targetDir, megaPackName, version, includedFiles) {
  const manifestPath = path.join(targetDir, "manifest.sii");
  const descPath = path.join(targetDir, "description.txt");

  const fileListText = includedFiles.map(f => `- ${f}`).join("\n");
  const descContent = `Mega Pack: ${megaPackName}\n` +
    `Version: ${version}\n` +
    `Protected by ConvoyGate DRM\n\n` +
    `Included Packages:\n${fileListText}\n`;

  fs.writeFileSync(descPath, descContent, "utf8");

  const manifestContent = `SiiNunit
{
mod_package : .package_info {
    package_version: "${version}"
    display_name: "${megaPackName}"
    author: "ConvoyGate Suite"
    category[]: "truck"
    category[]: "trailer"
    category[]: "tuning_parts"
    icon: "mod_icon.jpg"
    description_file: "description.txt"
}
}
`;
  fs.writeFileSync(manifestPath, manifestContent, "utf8");
}

ipcMain.handle("get-megapacks", () => loadRegistry());

ipcMain.handle("browse-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Mod Folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("browse-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Single Mod File",
    filters: [{ name: "Mod Archives (*.scs, *.zip)", extensions: ["scs", "zip"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("browse-multiple-files", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Multiple Mod Files for Mega Pack",
    filters: [{ name: "Mod Archives (*.scs, *.zip)", extensions: ["scs", "zip"] }],
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled || !result.filePaths.length) return [];
  return result.filePaths;
});

ipcMain.handle("publish-package-adaptive", async (event, payload) => {
  let tmpFinalScs = null;

  try {
    const { isMegaPack, filePaths, version, tier } = payload;
    const sendStatus = (message, percent) => {
      event.sender.send("publish-status", { message, percent });
    };

    if (!filePaths || filePaths.length === 0) {
      return { success: false, error: "No files provided." };
    }

    if (!isMegaPack) {
      const filePath = filePaths[0];
      const modId = payload.modId;
      const modName = payload.name;
      const stat = fs.statSync(filePath);

      tmpFinalScs = path.join(os.tmpdir(), `${modId}_locked.scs`);

      if (stat.isFile()) {
        sendStatus("Encrypting 3D assets & obfuscating headers...", 0);
        encryptAndLockScsArchive(filePath, tmpFinalScs, (count) => {
          sendStatus(`Secured ${count} assets...`);
        });
      } else {
        sendStatus("Compiling folder into encrypted SCS archive...", 0);
        packFolderEncrypted(filePath, tmpFinalScs, (current, total) => {
          sendStatus(`Compiling: ${current} / ${total} files...`);
        });
      }

      sendStatus("Streaming locked mod to Sydney VPS...", 0);
      const result = await streamUploadToBackend(
        tmpFinalScs,
        {
          "x-mod-id": encodeURIComponent(modId),
          "x-mod-name": encodeURIComponent(modName),
          "x-mod-version": encodeURIComponent(version),
          "x-mod-tier": encodeURIComponent(tier),
        },
        (sent, total) => {
          const pct = Math.round((sent / total) * 100);
          sendStatus(`Uploading: ${pct}% (${(sent / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB)`, pct);
        }
      );

      if (fs.existsSync(tmpFinalScs)) fs.unlinkSync(tmpFinalScs);
      return result;

    } else {
      const megaPackId = payload.megaPackId;
      const megaPackName = payload.megaPackName;
      const packWorkingDir = path.join(MEGAPACKS_DIR, megaPackId);

      if (!fs.existsSync(packWorkingDir)) {
        fs.mkdirSync(packWorkingDir, { recursive: true });
      }

      const registry = loadRegistry();
      let packEntry = registry.find(p => p.id === megaPackId);
      if (!packEntry) {
        packEntry = { id: megaPackId, name: megaPackName, files: [] };
        registry.push(packEntry);
      }

      for (let i = 0; i < filePaths.length; i++) {
        const itemPath = filePaths[i];
        const baseName = path.basename(itemPath);
        sendStatus(`Merging [${i + 1}/${filePaths.length}]: ${baseName}...`, Math.round((i / filePaths.length) * 50));

        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          copyFolderRecursive(itemPath, packWorkingDir);
        } else {
          extractArchiveToDir(itemPath, packWorkingDir);
        }

        if (!packEntry.files.includes(baseName)) {
          packEntry.files.push(baseName);
        }
      }

      saveRegistry(registry);

      sendStatus("Generating master ATS Mega Pack manifest...", 60);
      updateMegaPackManifest(packWorkingDir, megaPackName, version, packEntry.files);

      tmpFinalScs = path.join(os.tmpdir(), `${megaPackId}_megapack_locked.scs`);
      sendStatus("Encrypting combined Mega Pack assets...", 70);
      packFolderEncrypted(packWorkingDir, tmpFinalScs, (curr, total) => {
        sendStatus(`Encrypting Mega Pack: ${curr}/${total} files...`);
      });

      sendStatus("Streaming Mega Pack to Sydney VPS...", 85);
      const result = await streamUploadToBackend(
        tmpFinalScs,
        {
          "x-mod-id": encodeURIComponent(megaPackId),
          "x-mod-name": encodeURIComponent(megaPackName),
          "x-mod-version": encodeURIComponent(version),
          "x-mod-tier": encodeURIComponent(tier),
        },
        (sent, total) => {
          const pct = Math.round((sent / total) * 100);
          sendStatus(`Uploading Mega Pack: ${pct}% (${(sent / 1024 / 1024).toFixed(1)} MB / ${(total / 1024 / 1024).toFixed(1)} MB)`, pct);
        }
      );

      if (fs.existsSync(tmpFinalScs)) fs.unlinkSync(tmpFinalScs);
      return result;
    }

  } catch (err) {
    if (tmpFinalScs && fs.existsSync(tmpFinalScs)) fs.unlinkSync(tmpFinalScs);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fetch-catalog", async () => {
  try {
    const res = await axios.get(`${SERVER_URL}/api/v1/mods`, { timeout: 6000 });
    return res.data;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("delete-mod", async (event, modId) => {
  try {
    const headers = {};
    if (adminSessionToken) {
      headers["Authorization"] = `Bearer ${adminSessionToken}`;
    } else {
      headers["x-admin-key"] = "cg_admin_local_fallback";
    }

    const res = await axios.delete(`${SERVER_URL}/api/v1/admin/mods/${encodeURIComponent(modId)}`, {
      headers,
      timeout: 8000,
    });

    const packWorkingDir = path.join(MEGAPACKS_DIR, modId);
    if (fs.existsSync(packWorkingDir)) {
      fs.rmSync(packWorkingDir, { recursive: true, force: true });
    }
    const registry = loadRegistry().filter(p => p.id !== modId);
    saveRegistry(registry);

    return res.data;
  } catch (err) {
    return { success: false, error: err.response?.data?.error || err.message };
  }
});

app.on("window-all-closed", () => app.quit());