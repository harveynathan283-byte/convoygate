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
const ADMIN_SESSION_FILE = path.join(app.getPath("userData"), "admin_session.json");
let adminSessionToken = null;

const MEGAPACKS_DIR = path.join(app.getPath("userData"), "megapacks_storage");
const REGISTRY_FILE = path.join(app.getPath("userData"), "megapacks_registry.json");

if (!fs.existsSync(MEGAPACKS_DIR)) fs.mkdirSync(MEGAPACKS_DIR, { recursive: true });

const yieldEventLoop = () => new Promise(resolve => setImmediate(resolve));

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  } catch (e) {}
  return [];
}

function saveRegistry(data) {
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), "utf8");
}

function loadAdminSession() {
  try {
    if (fs.existsSync(ADMIN_SESSION_FILE)) return JSON.parse(fs.readFileSync(ADMIN_SESSION_FILE, "utf8"));
  } catch (e) {}
  return null;
}

function saveAdminSession(session) {
  try {
    fs.writeFileSync(ADMIN_SESSION_FILE, JSON.stringify(session, null, 2), "utf8");
  } catch (e) {}
}

function clearAdminSession() {
  try {
    if (fs.existsSync(ADMIN_SESSION_FILE)) fs.unlinkSync(ADMIN_SESSION_FILE);
  } catch (e) {}
  adminSessionToken = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 820,
    minWidth: 880,
    minHeight: 580,
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

ipcMain.handle("get-stored-admin-session", async () => {
  const session = loadAdminSession();
  if (!session || !session.token) return { hasSession: false };
  adminSessionToken = session.token;
  return { hasSession: true, user: session.user, token: session.token };
});

ipcMain.handle("admin-logout", () => {
  clearAdminSession();
  return { success: true };
});

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
        const sessionData = { token: adminSessionToken, user: { username } };
        saveAdminSession(sessionData);
        authWin.close();
        resolve({ success: true, ...sessionData });
      }
    });

    authWin.on("closed", () => {
      if (!adminSessionToken) {
        resolve({ success: false, error: "Admin login window closed." });
      }
    });
  });
});

function getAllFiles(dir, base = "") {
  let results = [];
  if (!fs.existsSync(dir)) return results;
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

async function copyFolderRecursive(source, target) {
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  const items = fs.readdirSync(source, { withFileTypes: true });
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const srcPath = path.join(source, item.name);
    const dstPath = path.join(target, item.name);
    if (item.isDirectory()) {
      await copyFolderRecursive(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
    if (i % 50 === 0) await yieldEventLoop();
  }
}

async function extractArchiveToDir(archivePath, targetDir, onProgress) {
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const fd = fs.openSync(archivePath, "r");
  try {
    const magicBuf = Buffer.alloc(4);
    fs.readSync(fd, magicBuf, 0, 4, 0);
    if (magicBuf.toString("ascii") === "SCS#") {
      throw new Error(`'${path.basename(archivePath)}' is an SCS HashFS package and cannot be extracted into a Mega Pack. Publish it as a Single Mod.`);
    }

    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    const searchLen = Math.min(fileSize, 2 * 1024 * 1024);
    const searchBuf = Buffer.alloc(searchLen);
    fs.readSync(fd, searchBuf, 0, searchLen, fileSize - searchLen);

    let eocdOffset = -1;
    for (let i = searchLen - 22; i >= 0; i--) {
      if (searchBuf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) throw new Error(`'${path.basename(archivePath)}' is missing a valid ZIP EOCD directory.`);

    const cdSize = searchBuf.readUInt32LE(eocdOffset + 12);
    const cdOffset = searchBuf.readUInt32LE(eocdOffset + 16);
    const cdBuf = Buffer.alloc(cdSize);
    fs.readSync(fd, cdBuf, 0, cdSize, cdOffset);

    let pos = 0;
    let extractedCount = 0;

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

      extractedCount++;
      if (extractedCount % 25 === 0) {
        if (onProgress) onProgress(extractedCount);
        await yieldEventLoop();
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function packFolderToSCS(sourceFolder, outputPath, onProgress) {
  const files = getAllFiles(sourceFolder);
  if (files.length === 0) throw new Error("Folder contains no mod assets.");

  const outFd = fs.openSync(outputPath, "w");
  let currentOffset = 0;
  const centralEntries = [];
  const CHUNK_SIZE = 1024 * 1024;
  const chunkBuf = Buffer.alloc(CHUNK_SIZE);

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    const stat = fs.statSync(item.full);
    const size = stat.size;
    const nameBuf = Buffer.from(item.rel, "utf8");

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(0x00000000, 14);
    lfh.writeUInt32LE(size, 18);
    lfh.writeUInt32LE(size, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);

    fs.writeSync(outFd, lfh, 0, lfh.length, currentOffset);
    currentOffset += lfh.length;
    fs.writeSync(outFd, nameBuf, 0, nameBuf.length, currentOffset);
    currentOffset += nameBuf.length;

    const localHeaderOffset = currentOffset - lfh.length - nameBuf.length;

    const inFd = fs.openSync(item.full, "r");
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(inFd, chunkBuf, 0, CHUNK_SIZE, null)) > 0) {
      fs.writeSync(outFd, chunkBuf, 0, bytesRead, currentOffset);
      currentOffset += bytesRead;
    }
    fs.closeSync(inFd);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x0314, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(0x00000000, 16);
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

    if (i % 20 === 0) {
      if (onProgress) onProgress(`Archiving: ${i + 1}/${files.length} assets...`, Math.round((i / files.length) * 40));
      await yieldEventLoop();
    }
  }

  const cdStartOffset = currentOffset;
  for (let j = 0; j < centralEntries.length; j++) {
    const entry = centralEntries[j];
    fs.writeSync(outFd, entry.cd, 0, entry.cd.length, currentOffset);
    currentOffset += entry.cd.length;
    fs.writeSync(outFd, entry.nameBuf, 0, entry.nameBuf.length, currentOffset);
    currentOffset += entry.nameBuf.length;

    if (j % 50 === 0) await yieldEventLoop();
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

// Single-attempt stream upload with dedicated socket & response capture
function performSingleStreamUpload(filePath, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SERVER_URL}/api/v1/admin/upload-stream`);
    const stat = fs.statSync(filePath);
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;

    // Dedicated agent with keepAlive: false prevents recycled socket drops
    const agent = new client.Agent({ keepAlive: false });

    const authHeaders = {};
    if (adminSessionToken) {
      authHeaders["Authorization"] = `Bearer ${adminSessionToken}`;
    } else {
      authHeaders["x-admin-key"] = "cg_admin_local_fallback";
    }

    const fileStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    let settled = false;
    let serverRes = null;
    let responseBody = "";

    const finish = (result, isError = false) => {
      if (settled) return;
      settled = true;
      try { fileStream.destroy(); } catch (_) {}
      if (isError) reject(result);
      else resolve(result);
    };

    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? url.port : (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        agent,
        headers: {
          "Connection": "close",
          "Content-Type": "application/octet-stream",
          "Content-Length": stat.size,
          ...authHeaders,
          ...headers,
        },
        timeout: 3600000,
      },
      (res) => {
        serverRes = res;
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          let parsed = null;
          try { parsed = JSON.parse(responseBody); } catch (_) {}
          if (parsed) {
            finish(parsed);
          } else if (res.statusCode >= 200 && res.statusCode < 300) {
            finish({ success: true, data: responseBody });
          } else {
            finish(new Error(`Server returned HTTP ${res.statusCode}: ${responseBody || res.statusMessage}`), true);
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      finish(new Error("Upload request timed out after 60 minutes"), true);
    });

    req.on("error", (err) => {
      setTimeout(() => {
        if (!settled) {
          if (serverRes) {
            finish(new Error(`Server closed (${serverRes.statusCode}): ${responseBody || err.message}`), true);
          } else {
            finish(err, true);
          }
        }
      }, 500);
    });

    let bytesSent = 0;
    const progressTransform = new Transform({
      transform(chunk, encoding, callback) {
        bytesSent += chunk.length;
        if (onProgress) onProgress(bytesSent, stat.size);
        callback(null, chunk);
      },
    });

    pipeline(fileStream, progressTransform, req).catch((err) => {
      // If server sent an early response (e.g. 413 Payload Too Large) and dropped socket,
      // allow res.on('end') a chance to resolve with the server's error message
      setTimeout(() => {
        if (!settled) {
          if (serverRes) {
            finish(new Error(`Server error (${serverRes.statusCode}): ${responseBody || err.message}`), true);
          } else {
            finish(err, true);
          }
        }
      }, 500);
    });
  });
}

// Automatic retry with backoff for network drops / premature close
async function streamUploadWithRetry(filePath, headers, onProgress, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1 && onProgress) {
        onProgress(0, 100);
      }
      const result = await performSingleStreamUpload(filePath, headers, onProgress);
      if (result && result.success) return result;
      if (result && result.error && !result.error.includes("Premature close") && !result.error.includes("ECONNRESET")) {
        return result;
      }
      lastErr = new Error(result?.error || "Upload rejected");
    } catch (err) {
      lastErr = err;
      const isRetryable = err.message.includes("Premature close") ||
                          err.message.includes("ECONNRESET") ||
                          err.message.includes("ETIMEDOUT") ||
                          err.message.includes("EPIPE");
      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }
    }
    // Pause before retrying
    await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
  }
  throw lastErr;
}

function updateMegaPackManifest(targetDir, megaPackName, version, includedFiles) {
  const manifestPath = path.join(targetDir, "manifest.sii");
  const descPath = path.join(targetDir, "description.txt");

  const fileListText = includedFiles.map(f => `- ${f}`).join("\n");
  const descContent = `Mega Pack: ${megaPackName}\n` +
    `Version: ${version}\n` +
    `Distributed via ConvoyGate\n\n` +
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

ipcMain.handle("clean-megapack-cache", () => {
  try {
    fs.rmSync(MEGAPACKS_DIR, { recursive: true, force: true });
    fs.mkdirSync(MEGAPACKS_DIR, { recursive: true });
    saveRegistry([]);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

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
    title: "Select Multiple Mod Files",
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

    if (isMegaPack) {
      for (const itemPath of filePaths) {
        const stat = fs.statSync(itemPath);
        if (stat.isFile()) {
          const fd = fs.openSync(itemPath, "r");
          const magicBuf = Buffer.alloc(4);
          fs.readSync(fd, magicBuf, 0, 4, 0);
          fs.closeSync(fd);
          if (magicBuf.toString("ascii") === "SCS#") {
            return {
              success: false,
              error: `'${path.basename(itemPath)}' is an SCS HashFS container and cannot be extracted into a Mega Pack. Publish it as a Single Mod.`
            };
          }
        }
      }
    }

    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    if (!isMegaPack) {
      const filePath = filePaths[0];
      const modId = payload.modId;
      const modName = payload.name;
      const stat = fs.statSync(filePath);

      let fileToUpload = filePath;

      if (stat.isDirectory()) {
        tmpFinalScs = path.join(os.tmpdir(), `${modId}_${uniqueSuffix}.scs`);
        sendStatus("Compiling folder into SCS archive...", 10);
        await packFolderToSCS(filePath, tmpFinalScs, (msg, pct) => {
          sendStatus(msg, pct !== undefined ? pct : 30);
        });
        fileToUpload = tmpFinalScs;
      }

      sendStatus("Streaming package to Sydney VPS...", 30);
      const result = await streamUploadWithRetry(
        fileToUpload,
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

      return result;

    } else {
      const megaPackId = payload.megaPackId;
      const megaPackName = payload.megaPackName;
      const packBaseDir = path.join(MEGAPACKS_DIR, megaPackId);
      const sourcesDir = path.join(packBaseDir, "sources");
      const assembledDir = path.join(packBaseDir, "assembled");

      fs.mkdirSync(sourcesDir, { recursive: true });
      fs.mkdirSync(assembledDir, { recursive: true });

      const registry = loadRegistry();
      let packEntry = registry.find(p => p.id === megaPackId);
      if (!packEntry) {
        packEntry = { id: megaPackId, name: megaPackName, files: [], version, tier };
        registry.push(packEntry);
      } else {
        packEntry.name = megaPackName;
        packEntry.version = version;
        packEntry.tier = tier;
      }

      for (let i = 0; i < filePaths.length; i++) {
        const itemPath = filePaths[i];
        const baseName = path.basename(itemPath);
        sendStatus(`Staging [${i + 1}/${filePaths.length}]: ${baseName}...`, Math.round((i / filePaths.length) * 20));

        const targetSource = path.join(sourcesDir, baseName);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory()) {
          await copyFolderRecursive(itemPath, targetSource);
        } else {
          fs.copyFileSync(itemPath, targetSource);
        }

        if (!packEntry.files.includes(baseName)) {
          packEntry.files.push(baseName);
        }
        await yieldEventLoop();
      }

      saveRegistry(registry);

      fs.rmSync(assembledDir, { recursive: true, force: true });
      fs.mkdirSync(assembledDir, { recursive: true });

      const validFiles = [];
      for (let i = 0; i < packEntry.files.length; i++) {
        const fileName = packEntry.files[i];
        const srcPath = path.join(sourcesDir, fileName);
        if (!fs.existsSync(srcPath)) continue;

        const stat = fs.statSync(srcPath);
        if (stat.isFile()) {
          const testFd = fs.openSync(srcPath, "r");
          const testBuf = Buffer.alloc(4);
          fs.readSync(testFd, testBuf, 0, 4, 0);
          fs.closeSync(testFd);
          if (testBuf.toString("ascii") === "SCS#") {
            try { fs.rmSync(srcPath, { force: true }); } catch (e) {}
            continue;
          }
        }

        sendStatus(`Merging truck assets: ${fileName}...`, 20 + Math.round((i / packEntry.files.length) * 25));
        if (stat.isDirectory()) {
          await copyFolderRecursive(srcPath, assembledDir);
        } else {
          await extractArchiveToDir(srcPath, assembledDir);
        }
        validFiles.push(fileName);
        await yieldEventLoop();
      }

      packEntry.files = validFiles;
      saveRegistry(registry);

      sendStatus("Generating master Mega Pack dealer manifest...", 50);
      updateMegaPackManifest(assembledDir, megaPackName, version, packEntry.files);
      await yieldEventLoop();

      tmpFinalScs = path.join(os.tmpdir(), `${megaPackId}_${uniqueSuffix}_megapack.scs`);
      sendStatus("Compiling merged Mega Pack container...", 55);
      await packFolderToSCS(assembledDir, tmpFinalScs, (msg, pct) => {
        sendStatus(msg, 55 + Math.round((pct / 100) * 25));
      });

      sendStatus("Streaming Mega Pack to Sydney VPS...", 75);
      const result = await streamUploadWithRetry(
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

      return result;
    }

  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (tmpFinalScs && fs.existsSync(tmpFinalScs)) {
      try { fs.unlinkSync(tmpFinalScs); } catch (e) {}
    }
  }
});

ipcMain.handle("remove-megapack-item", async (event, { megaPackId, fileName }) => {
  let tmpFinalScs = null;
  const sendStatus = (message, percent) => {
    event.sender.send("publish-status", { message, percent });
  };

  try {
    const registry = loadRegistry();
    const packEntry = registry.find(p => p.id === megaPackId);
    if (!packEntry) throw new Error("Mega Pack not found in local registry.");

    const packBaseDir = path.join(MEGAPACKS_DIR, megaPackId);
    const sourcesDir = path.join(packBaseDir, "sources");
    const assembledDir = path.join(packBaseDir, "assembled");

    const targetSource = path.join(sourcesDir, fileName);
    if (fs.existsSync(targetSource)) {
      fs.rmSync(targetSource, { recursive: true, force: true });
    }

    packEntry.files = packEntry.files.filter(f => f !== fileName);
    saveRegistry(registry);

    if (packEntry.files.length === 0) {
      sendStatus("Mega Pack is empty. Removing from cloud catalog...", 50);
      const headers = {};
      if (adminSessionToken) headers["Authorization"] = `Bearer ${adminSessionToken}`;
      else headers["x-admin-key"] = "cg_admin_local_fallback";

      await axios.delete(`${SERVER_URL}/api/v1/admin/mods/${encodeURIComponent(megaPackId)}`, { headers, timeout: 8000 });
      fs.rmSync(packBaseDir, { recursive: true, force: true });
      saveRegistry(registry.filter(p => p.id !== megaPackId));

      return { success: true, deletedPack: true };
    }

    sendStatus(`Rebuilding ${packEntry.name} without ${fileName}...`, 20);
    fs.rmSync(assembledDir, { recursive: true, force: true });
    fs.mkdirSync(assembledDir, { recursive: true });

    for (let i = 0; i < packEntry.files.length; i++) {
      const remainingFile = packEntry.files[i];
      const srcPath = path.join(sourcesDir, remainingFile);
      if (!fs.existsSync(srcPath)) continue;

      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        await copyFolderRecursive(srcPath, assembledDir);
      } else {
        await extractArchiveToDir(srcPath, assembledDir);
      }
      await yieldEventLoop();
    }

    sendStatus("Regenerating manifest...", 50);
    updateMegaPackManifest(assembledDir, packEntry.name, packEntry.version || "1.0.0", packEntry.files);
    await yieldEventLoop();

    const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    tmpFinalScs = path.join(os.tmpdir(), `${megaPackId}_${uniqueSuffix}_megapack.scs`);

    sendStatus("Packaging updated Mega Pack...", 65);
    await packFolderToSCS(assembledDir, tmpFinalScs);

    sendStatus("Syncing updated Mega Pack to Sydney VPS...", 80);
    const result = await streamUploadWithRetry(
      tmpFinalScs,
      {
        "x-mod-id": encodeURIComponent(megaPackId),
        "x-mod-name": encodeURIComponent(packEntry.name),
        "x-mod-version": encodeURIComponent(packEntry.version || "1.0.0"),
        "x-mod-tier": encodeURIComponent(packEntry.tier || "All"),
      },
      (sent, total) => {
        const pct = Math.round((sent / total) * 100);
        sendStatus(`Uploading updated pack: ${pct}%`, pct);
      }
    );

    return { success: true, deletedPack: false, remainingFiles: packEntry.files };

  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    if (tmpFinalScs && fs.existsSync(tmpFinalScs)) {
      try { fs.unlinkSync(tmpFinalScs); } catch (e) {}
    }
  }
});

ipcMain.handle("fetch-catalog", async () => {
  try {
    const res = await axios.get(`${SERVER_URL}/api/v1/mods`, { timeout: 6000 });
    if (res.data && res.data.success && Array.isArray(res.data.mods)) {
      const cloudIds = new Set(res.data.mods.map(m => m.id));
      const localRegistry = loadRegistry();
      const updatedRegistry = [];

      for (const pack of localRegistry) {
        if (cloudIds.has(pack.id)) {
          updatedRegistry.push(pack);
        } else {
          const packBaseDir = path.join(MEGAPACKS_DIR, pack.id);
          if (fs.existsSync(packBaseDir)) {
            try { fs.rmSync(packBaseDir, { recursive: true, force: true }); } catch (e) {}
          }
        }
      }
      saveRegistry(updatedRegistry);
    }
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

    const packBaseDir = path.join(MEGAPACKS_DIR, modId);
    if (fs.existsSync(packBaseDir)) {
      fs.rmSync(packBaseDir, { recursive: true, force: true });
    }
    const registry = loadRegistry().filter(p => p.id !== modId);
    saveRegistry(registry);

    return res.data;
  } catch (err) {
    return { success: false, error: err.response?.data?.error || err.message };
  }
});

app.on("window-all-closed", () => app.quit());