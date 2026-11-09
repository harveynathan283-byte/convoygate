const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const axios = require("axios");
const FormData = require("form-data");
const AdmZip = require("adm-zip");

let mainWindow;
const SERVER_URL = "http://192.168.86.111:3000";

// IEEE 802.3 CRC32 Implementation (Compatible with all Node / Electron versions)
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i >>> 0;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? ((0xEDB88320 ^ (c >>> 1)) >>> 0) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function calculateCrc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

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

// Collect all files recursively
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

// Low-level ZIP writer that sets ATS-readable, WinRAR-blocking flags
function lockDirectoryToScs(sourceFolder, outputPath) {
  const files = getAllFiles(sourceFolder);
  if (files.length === 0) {
    throw new Error("Folder contains no mod assets.");
  }

  const outFd = fs.openSync(outputPath, "w");
  let currentOffset = 0;
  const centralEntries = [];

  for (let i = 0; i < files.length; i++) {
    const item = files[i];
    const fileBuf = fs.readFileSync(item.full);
    const nameBuf = Buffer.from(item.rel, "utf8");
    const crc = calculateCrc32(fileBuf);
    const size = fileBuf.length;

    // Local Header (Store mode for native ATS engine streaming)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(0, 8);          // Compression: Store (0)
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
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

    // Central Directory Entry (Flags configured to block WinRAR / 7-Zip extraction)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);  // PK\x01\x02
    cd.writeUInt16LE(0x0314, 4);
    cd.writeUInt16LE(99, 6);          // Flagged for v9.9
    cd.writeUInt16LE(0x0001, 8);      // Bit 0: Encrypted flag
    cd.writeUInt16LE(0, 10);          // Method: Store
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
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

  // End of Central Directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
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

// Native Windows Browse Dialogs
ipcMain.handle("dialog-select-folder", async () => {
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

// Process Mod (Folder, .zip, or .scs) and Stream to Server
ipcMain.handle("process-and-upload", async (event, { inputPath, modId, name, version, tier, directUpload }) => {
  let tempExtractDir = null;
  let finalScsFile = null;

  try {
    const stat = fs.statSync(inputPath);

    if (directUpload && stat.isFile() && inputPath.toLowerCase().endsWith(".scs")) {
      finalScsFile = inputPath;
    } else {
      let folderToPack = inputPath;

      if (stat.isFile()) {
        tempExtractDir = path.join(os.tmpdir(), `cg_extract_${Date.now()}`);
        fs.mkdirSync(tempExtractDir, { recursive: true });

        const zip = new AdmZip(inputPath);
        zip.extractAllTo(tempExtractDir, true);
        folderToPack = tempExtractDir;
      }

      finalScsFile = path.join(os.tmpdir(), `${modId}_locked.scs`);
      lockDirectoryToScs(folderToPack, finalScsFile);
    }

    const form = new FormData();
    form.append("modId", modId);
    form.append("name", name);
    form.append("version", version);
    form.append("tier", tier);
    form.append("file", fs.createReadStream(finalScsFile));

    const res = await axios.post(`${SERVER_URL}/api/v1/admin/upload`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    if (tempExtractDir && fs.existsSync(tempExtractDir)) {
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
    }
    if (finalScsFile !== inputPath && fs.existsSync(finalScsFile)) {
      fs.unlinkSync(finalScsFile);
    }

    return res.data;
  } catch (err) {
    if (tempExtractDir && fs.existsSync(tempExtractDir)) {
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
    }
    return { success: false, error: err.message };
  }
});

ipcMain.handle("fetch-catalog", async () => {
  try {
    const res = await axios.get(`${SERVER_URL}/api/v1/mods`, { timeout: 4000 });
    return res.data;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("delete-mod", async (event, modId) => {
  try {
    const res = await axios.delete(`${SERVER_URL}/api/v1/admin/mods/${modId}`);
    return res.data;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

app.on("window-all-closed", () => {
  app.quit();
});