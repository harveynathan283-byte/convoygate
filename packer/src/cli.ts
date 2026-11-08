import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

// Drag-and-drop on Windows passes the directory as the first positional argument
const targetDir = path.resolve(values.input || positionals[0] || "./mod_input");
const outputFile = path.resolve(values.output || positionals[1] || `${path.basename(targetDir)}.scs`);
const hexKey = (values.key || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").trim();

if (!fs.existsSync(targetDir)) {
  console.log("=====================================================");
  console.log("             ConvoyGate Mod Packer v1.0              ");
  console.log("=====================================================");
  console.log("Usage: ConvoyGate-Packer.exe <mod_folder> [output.scs] [aes_key]");
  console.log("Or: Drag-and-drop a mod directory directly onto this .exe\n");
  console.error(`[Error] Target folder does not exist: ${targetDir}`);
  process.exit(1);
}

const aesKey = Buffer.from(hexKey, "hex");
const manifestItems: any[] = [];
const encryptedBlobs: Buffer[] = [];
const ENCRYPT_EXTS = new Set([".pmd", ".pmg", ".pmc", ".dds", ".tobj", ".bank"]);

function scanDir(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(targetDir, full).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      scanDir(full);
    } else {
      const raw = fs.readFileSync(full);
      const ext = path.extname(entry.name).toLowerCase();

      if (ENCRYPT_EXTS.has(ext)) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
        const enc = Buffer.concat([cipher.update(raw), cipher.final()]);
        const tag = cipher.getAuthTag();
        const packed = Buffer.concat([iv, tag, enc]);

        manifestItems.push({ file: rel, encrypted: true, size: raw.length, packedSize: packed.length });
        encryptedBlobs.push(packed);
      } else {
        manifestItems.push({ file: rel, encrypted: false, size: raw.length, packedSize: raw.length });
        encryptedBlobs.push(raw);
      }
    }
  }
}

console.log(`[ConvoyGate Packer] Scanning and encrypting: ${targetDir}`);
scanDir(targetDir);

const manifestBuffer = Buffer.from(JSON.stringify(manifestItems));
const header = Buffer.alloc(8);
header.write("CVG1", 0);
header.writeUInt32LE(manifestBuffer.length, 4);

const archive = Buffer.concat([header, manifestBuffer, ...encryptedBlobs]);
fs.writeFileSync(outputFile, archive);

console.log(`[ConvoyGate Packer] Success! Encrypted archive compiled.`);
console.log(`• Protected Assets: ${manifestItems.length}`);
console.log(`• Package Size:     ${archive.length} bytes`);
console.log(`• Destination:      ${outputFile}\n`);