const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const axios = require("axios");
const FormData = require("form-data");

let mainWindow;

// Central Backend Server
const SERVER_URL = "http://localhost:3000";

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#12131a",
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

// 1. Pack and lock mod into standard ATS ZIP with WinRAR-blocking flags
ipcMain.handle("pack-mod", async (event, { sourceFolder, outputPath }) => {
  try {
    const files = getAllFiles(sourceFolder);
    if (files.length === 0) {
      return { success: false, error: "The selected folder is empty." };
    }

    const outFd = fs.openSync(outputPath, "w");
    let currentOffset = 0;
    const centralEntries = [];

    for (let i = 0; i < files.length; i++) {
      const item = files[i];
      const fileBuf = fs.readFileSync(item.full);
      const nameBuf = Buffer.from(item.rel, "utf8");
      const crc = zlib.crc32(fileBuf);
      const size = fileBuf.length;

      // Local File Header (Standard Store mode for ATS zipfs)
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

      // Central Directory Entry (Flags set to block WinRAR/7-Zip extraction)
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);  // PK\x01\x02
      cd.writeUInt16LE(0x0314, 4);
      cd.writeUInt16LE(99, 6);          // Requires Version 9.9
      cd.writeUInt16LE(0x0001, 8);      // General Flag: Bit 0 (Encrypted)
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

    return { success: true, size: fs.statSync(outputPath).size };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 2. Stream locked package to server
ipcMain.handle("upload-mod", async (event, { filePath, modId, name, version, tier }) => {
  try {
    const form = new FormData();
    form.append("modId", modId);
    form.append("name", name);
    form.append("version", version);
    form.append("tier", tier);
    form.append("file", fs.createReadStream(filePath));

    const res = await axios.post(`${SERVER_URL}/api/v1/admin/upload`, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    return res.data;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 3. Fetch server catalog
ipcMain.handle("fetch-catalog", async () => {
  try {
    const res = await axios.get(`${SERVER_URL}/api/v1/mods`);
    return res.data;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 4. Delete mod from cloud
ipcMain.handle("delete-mod", async (event, modId) => {
  try {
    const res = await axios.delete(`${SERVER_URL}/api/v1/admin/mods/${modId}`);
    return res.data;
  } catch (err) {
    return { success: false, error: err.message };
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});