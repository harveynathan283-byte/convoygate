import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    input: { type: "string", short: "i" },
    output: { type: "string", short: "o" },
    key: { type: "string", short: "k" },
  },
});

const targetPath = path.resolve(values.input || positionals[0] || "");
const hexKey = (values.key || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").trim();

console.log("=====================================================");
console.log("       ConvoyGate DRM Mod Packer (ATS Edition)       ");
console.log("=====================================================\n");

if (!targetPath || !fs.existsSync(targetPath)) {
  console.log("Drag & drop an .scs file or a mod folder directly onto this .exe.\n");
  console.log("Usage: ConvoyGate-Packer.exe <input.scs | folder> [-o output.scs] [-k <aes_hex_key>]");
  exitApp(1);
}

const stats = fs.statSync(targetPath);
const isDirectory = stats.isDirectory();

// Determine output file location
let outputFile: string;
if (values.output) {
  outputFile = path.resolve(values.output);
} else if (isDirectory) {
  outputFile = path.join(path.dirname(targetPath), `${path.basename(targetPath)}.scs`);
} else {
  // If user dropped an existing .scs file, do not overwrite original
  const ext = path.extname(targetPath);
  const base = path.basename(targetPath, ext);
  outputFile = path.join(path.dirname(targetPath), `${base}_protected.scs`);
}

if (hexKey.length !== 64) {
  console.error("[Error] AES key must be exactly 64 hexadecimal characters (32 bytes).");
  exitApp(1);
}

const aesKey = Buffer.from(hexKey, "hex");
const ENCRYPT_EXTS = new Set([".pmd", ".pmg", ".pmc", ".dds", ".tobj", ".bank"]);

interface ModFileEntry {
  path: string;
  data: Buffer;
}

// Extract entries if an .scs / .zip archive was dropped
function extractZipEntries(buffer: Buffer): ModFileEntry[] {
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdPos = buffer.lastIndexOf(eocdSig);
  if (eocdPos === -1) {
    throw new Error("Invalid .scs file. Not a valid PKZip-compatible archive.");
  }

  const totalEntries = buffer.readUInt16LE(eocdPos + 10);
  const cdOffset = buffer.readUInt32LE(eocdPos + 16);

  const files: ModFileEntry[] = [];
  let pos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    const sig = buffer.readUInt32LE(pos);
    if (sig !== 0x02014b50) break;

    const method = buffer.readUInt16LE(pos + 10);
    const compSize = buffer.readUInt32LE(pos + 20);
    const uncompSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);

    const fileName = buffer.toString("utf8", pos + 46, pos + 46 + nameLen).replace(/\\/g, "/");
    pos += 46 + nameLen + extraLen + commentLen;

    // Skip directory entries
    if (fileName.endsWith("/") || (uncompSize === 0 && compSize === 0)) continue;

    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const rawData = buffer.subarray(dataStart, dataStart + compSize);

    let fileData: Buffer;
    if (method === 0) {
      fileData = rawData;
    } else if (method === 8) {
      fileData = zlib.inflateRawSync(rawData);
    } else {
      console.warn(`[Skip] Unsupported compression method (${method}) for: ${fileName}`);
      continue;
    }

    files.push({ path: fileName, data: fileData });
  }

  return files;
}

// Scan entries if a folder was dropped
function scanFolder(dir: string, baseDir: string = dir): ModFileEntry[] {
  const files: ModFileEntry[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...scanFolder(full, baseDir));
    } else {
      const rel = path.relative(baseDir, full).replace(/\\/g, "/");
      files.push({ path: rel, data: fs.readFileSync(full) });
    }
  }
  return files;
}

// 1. Ingest files
let modFiles: ModFileEntry[] = [];
try {
  if (isDirectory) {
    console.log(`[Source] Reading mod folder: ${targetPath}`);
    modFiles = scanFolder(targetPath);
  } else {
    console.log(`[Source] Extracting SCS archive: ${targetPath}`);
    const archiveBuffer = fs.readFileSync(targetPath);
    modFiles = extractZipEntries(archiveBuffer);
  }
} catch (err: any) {
  console.error(`[Error] Failed to read source files: ${err.message}`);
  exitApp(1);
}

if (modFiles.length === 0) {
  console.error("[Error] No assets found in the provided mod package.");
  exitApp(1);
}

// 2. Encrypt proprietary assets with AES-256-GCM
const manifestItems: any[] = [];
const encryptedBlobs: Buffer[] = [];
let encryptedCount = 0;
let preservedCount = 0;

for (const file of modFiles) {
  const ext = path.extname(file.path).toLowerCase();

  if (ENCRYPT_EXTS.has(ext)) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
    const enc = Buffer.concat([cipher.update(file.data), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, tag, enc]);

    manifestItems.push({
      file: file.path,
      encrypted: true,
      size: file.data.length,
      packedSize: packed.length,
    });
    encryptedBlobs.push(packed);
    encryptedCount++;
  } else {
    manifestItems.push({
      file: file.path,
      encrypted: false,
      size: file.data.length,
      packedSize: file.data.length,
    });
    encryptedBlobs.push(file.data);
    preservedCount++;
  }
}

// 3. Compile CVG1 binary package
const manifestBuffer = Buffer.from(JSON.stringify(manifestItems));
const header = Buffer.alloc(8);
header.write("CVG1", 0);
header.writeUInt32LE(manifestBuffer.length, 4);

const archive = Buffer.concat([header, manifestBuffer, ...encryptedBlobs]);
fs.writeFileSync(outputFile, archive);

console.log("\n=====================================================");
console.log("            ENCRYPTION PACKAGE COMPLETE              ");
console.log("=====================================================");
console.log(`• Total Assets:      ${modFiles.length}`);
console.log(`• Encrypted 3D/Tex:  ${encryptedCount} files (AES-256-GCM)`);
console.log(`• Open Metadata:     ${preservedCount} files (definitions & manifest)`);
console.log(`• Output File:       ${outputFile}`);
console.log(`• Protected Size:    ${(archive.length / 1024 / 1024).toFixed(2)} MB`);
console.log("=====================================================\n");

exitApp(0);

function exitApp(code: number) {
  if (process.stdin.isTTY && !process.env.CI) {
    console.log("Press Enter to close...");
    process.stdin.resume();
    process.stdin.on("data", () => process.exit(code));
  } else {
    process.exit(code);
  }
}