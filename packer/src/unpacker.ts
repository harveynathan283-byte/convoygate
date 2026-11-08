import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";

// Parse CLI flags using Node's built-in parser
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    input: { type: "string", short: "i" },
    output: { type: "string", short: "o" },
    key: { type: "string", short: "k" },
  },
});

const archivePath = path.resolve(values.input || "../backend/storage/dist/w900_custom_rig.scs");
const outputDir = path.resolve(values.output || "./extracted_test");
const hexKey = (values.key || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef").trim();

if (!fs.existsSync(archivePath)) {
  console.error(`[Error] Archive file not found at: ${archivePath}`);
  process.exit(1);
}

if (hexKey.length !== 64) {
  console.error("[Error] AES key must be exactly 64 hex characters (32 bytes).");
  process.exit(1);
}

const aesKey = Buffer.from(hexKey, "hex");
const buffer = fs.readFileSync(archivePath);

// 1. Verify ConvoyGate header magic
const magic = buffer.toString("utf-8", 0, 4);
if (magic !== "CVG1") {
  console.error("[Error] Invalid package header. Expected 'CVG1'.");
  process.exit(1);
}

// 2. Read manifest length & parse manifest table
const manifestLen = buffer.readUInt32LE(4);
const manifestJson = buffer.toString("utf-8", 8, 8 + manifestLen);
const manifest: Array<{ file: string; encrypted: boolean; size: number; packedSize: number }> = JSON.parse(manifestJson);

console.log(`\n[ConvoyGate Unpacker] Header validated. Found ${manifest.length} embedded assets.`);

// 3. Extract and decrypt assets
let offset = 8 + manifestLen;
fs.mkdirSync(outputDir, { recursive: true });

for (const item of manifest) {
  const chunk = buffer.subarray(offset, offset + item.packedSize);
  offset += item.packedSize;

  const destPath = path.join(outputDir, item.file);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  if (item.encrypted) {
    // Unpack: 12-byte IV + 16-byte GCM Tag + Ciphertext
    const iv = chunk.subarray(0, 12);
    const tag = chunk.subarray(12, 28);
    const ciphertext = chunk.subarray(28);

    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAuthTag(tag);

    try {
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      fs.writeFileSync(destPath, decrypted);
      console.log(`  Decrypted: ${item.file} (${decrypted.length} bytes)`);
    } catch {
      console.error(`  Tamper Check Failed: ${item.file} authentication tag rejected.`);
    }
  } else {
    fs.writeFileSync(destPath, chunk);
    console.log(`  Restored:  ${item.file} (${chunk.length} bytes)`);
  }
}

console.log(`\n[ConvoyGate Unpacker] Success. Restored mod files in: ${outputDir}\n`);