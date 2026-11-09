const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");
const axios = require("axios");

let mainWindow;
const SERVER_URL = "https://api.convoygate.com";

// ConvoyGate Static Master Cypher Seed
const DRM_CIPHER_KEY = Buffer.from([
  0x43, 0x6F, 0x6E, 0x76, 0x6F, 0x79, 0x47, 0x61, // "ConvoyGa"
  0x74, 0x65, 0x53, 0x65, 0x63, 0x75, 0x72, 0x65  // "teSecure"
]);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1060,
    height: 760,
    minWidth: 920,
    minHeight: 620,
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

    // Read filename
    const nameBuf = Buffer.alloc(nameLen);
    fs.readSync(fd, nameBuf, 0, nameLen, cdOffset + pos + 46);
    const fileName = nameBuf.toString("utf8");

    // Don't encrypt manifest.sii or icon so Mod Manager can show name/icon
    const isMetadata = fileName.toLowerCase().includes("manifest.sii") || 
                       fileName.toLowerCase().includes("mod_icon.jpg") ||
                       fileName.toLowerCase().includes("description.txt");

    // 1. Scramble Central Directory
    cdBuf.writeUInt16LE(99, pos + 6); // Version 9.9
    const flags = cdBuf.readUInt16LE(pos + 8);
    cdBuf.writeUInt16LE(flags | 0x0001, pos + 8); // Encrypted bit

    // 2. Read LFH and encrypt actual asset data
    const lfhHeader = Buffer.alloc(30);
    fs.readSync(fd, lfhHeader, 0, 30, lfhOffset);

    if (lfhHeader.readUInt32LE(0) === 0x04034b50) {
      const lfhNameLen = lfhHeader.readUInt16LE(26);
      const lfhExtraLen = lfhHeader.readUInt16LE(28);
      const compressedSize = lfhHeader.readUInt32LE(18);
      const dataOffset = lfhOffset + 30 + lfhNameLen + lfhExtraLen;

      if (!isMetadata && compressedSize > 0) {
        // Read the real asset bytes, encrypt them, write them back!
        const payloadBuf = Buffer.alloc(compressedSize);
        fs.readSync(fd, payloadBuf, 0, compressedSize, dataOffset);

        encryptPayload(payloadBuf);

        fs.writeSync(fd, payloadBuf, 0, compressedSize, dataOffset);
      }

      // Mark LFH header
      lfhHeader.writeUInt16LE(99, 4);
      lfhHeader.writeUInt16LE(flags | 0x0001, 6);
      fs.writeSync(fd, lfhHeader, 0, 30, lfhOffset);
    }

    pos += 46 + nameLen + extraLen + commentLen;
    fileCount++;

    if (onProgress && fileCount % 100 === 0) onProgress(fileCount);
  }

  // Write patched CD
  fs.writeSync(fd, cdBuf, 0, cdSize, cdOffset);
  fs.closeSync(fd);
}

// Low-level recursive folder scanner
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

// Pack folder with encrypted payload bytes
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

async function handleProcessAndUpload(event, arg) {
  let inputPath = "";
  let modId = "";
  let name = "";
  let version = "1.0.0";
  let tier = "All";

  if (typeof arg === "string") {
    inputPath = arg;
    const baseName = path.basename(inputPath).replace(/\.(scs|zip)$/i, "");
    modId = baseName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    name = baseName.replace(/[_-]/g, " ");
  } else if (arg && typeof arg === "object") {
    inputPath = arg.inputPath || arg.filePath || "";
    const baseName = path.basename(inputPath).replace(/\.(scs|zip)$/i, "");
    modId = arg.modId || baseName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    name = arg.name || baseName.replace(/[_-]/g, " ");
    version = arg.version || "1.0.0";
    tier = arg.tier || "All";
  }

  let finalScsFile = null;

  try {
    const stat = fs.statSync(inputPath);
    finalScsFile = path.join(os.tmpdir(), `${modId}_locked.scs`);

    const sendStatus = (message, percent) => {
      event.sender.send("publish-status", { message, percent });
    };

    if (stat.isFile()) {
      sendStatus("Encrypting 3D assets & obfuscating headers...", 0);
      encryptAndLockScsArchive(inputPath, finalScsFile, (count) => {
        sendStatus(`Encrypting assets: ${count} items secured...`);
      });
    } else {
      sendStatus("Compiling folder into encrypted SCS archive...", 0);
      packFolderEncrypted(inputPath, finalScsFile, (current, total) => {
        sendStatus(`Encrypting & packing: ${current} / ${total} files...`);
      });
    }

    sendStatus("Connecting to server stream...", 0);

    const result = await streamUploadToBackend(
      finalScsFile,
      {
        "x-mod-id": encodeURIComponent(modId),
        "x-mod-name": encodeURIComponent(name),
        "x-mod-version": encodeURIComponent(version),
        "x-mod-tier": encodeURIComponent(tier),
      },
      (bytesSent, totalBytes) => {
        const percent = Math.round((bytesSent / totalBytes) * 100);
        const sentMB = (bytesSent / 1024 / 1024).toFixed(1);
        const totalMB = (totalBytes / 1024 / 1024).toFixed(1);

        if (percent >= 100) {
          sendStatus(`Upload complete (${totalMB} MB). Saving to database catalog...`, 100);
        } else {
          sendStatus(`Uploading: ${percent}% (${sentMB} MB / ${totalMB} MB)...`, percent);
        }
      }
    );

    if (fs.existsSync(finalScsFile)) {
      fs.unlinkSync(finalScsFile);
    }

    return result;
  } catch (err) {
    if (finalScsFile && fs.existsSync(finalScsFile)) {
      fs.unlinkSync(finalScsFile);
    }
    return { success: false, error: err.message };
  }
}

// Support both naming conventions so the UI never breaks
ipcMain.handle("process-and-upload", handleProcessAndUpload);
ipcMain.handle("publish-mod", handleProcessAndUpload);

ipcMain.handle("dialog-select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Uncompressed Mod Folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});
ipcMain.handle("browse-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Uncompressed Mod Folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog-select-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Mod File (.scs or .zip)",
    filters: [{ name: "Mod Archives (*.scs, *.zip)", extensions: ["scs", "zip"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});
ipcMain.handle("browse-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select Mod File (.scs or .zip)",
    filters: [{ name: "Mod Archives (*.scs, *.zip)", extensions: ["scs", "zip"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
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
    const res = await axios.delete(`${SERVER_URL}/api/v1/admin/mods/${encodeURIComponent(modId)}`, { timeout: 8000 });
    return res.data;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

app.on("window-all-closed", () => {
  app.quit();
});