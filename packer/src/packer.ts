import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Command } from "commander";

interface ManifestItem {
  relativePath: string;
  originalSize: number;
  packedSize: number;
  originalSha256: string;
  isEncrypted: boolean;
}

const program = new Command();

program
  .name("convoygate-packer")
  .description("Sign and encrypt SCS assets for ConvoyGate rolling distribution")
  .requiredOption("-i, --input <dir>", "Path to unzipped raw SCS mod folder")
  .requiredOption("-o, --output <dir>", "Path to destination output folder")
  .requiredOption("-k, --key <hex>", "32-byte (64 hex characters) AES encryption key")
  .action(async (options) => {
    const inputDir = path.resolve(options.input);
    const outputDir = path.resolve(options.output);
    const hexKey = options.key.trim();

    if (hexKey.length !== 64) {
      console.error("Error: Key must be exactly 64 hex characters (32 bytes).");
      process.exit(1);
    }

    if (!fs.existsSync(inputDir)) {
      console.error(`Error: Input directory does not exist: ${inputDir}`);
      process.exit(1);
    }

    const aesKey = Buffer.from(hexKey, "hex");
    const manifestItems: ManifestItem[] = [];

    // Proprietary game assets to encrypt (models, collisions, textures, sounds)
    const ENCRYPT_EXTENSIONS = new Set([
      ".pmd",
      ".pmg",
      ".pmc",
      ".dds",
      ".tobj",
      ".bank",
      ".sound",
    ]);

    function processFolder(currentDir: string) {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullSourcePath = path.join(currentDir, entry.name);
        const relPath = path.relative(inputDir, fullSourcePath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          processFolder(fullSourcePath);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          const targetDestPath = path.join(outputDir, relPath);

          fs.mkdirSync(path.dirname(targetDestPath), { recursive: true });

          const rawData = fs.readFileSync(fullSourcePath);
          const originalHash = crypto.createHash("sha256").update(rawData).digest("hex");

          if (ENCRYPT_EXTENSIONS.has(ext)) {
            // Encrypt using AES-256-GCM: IV (12 bytes) + Auth Tag (16 bytes) + Encrypted Payload
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
            const encryptedBytes = Buffer.concat([cipher.update(rawData), cipher.final()]);
            const authTag = cipher.getAuthTag();

            const packedBlob = Buffer.concat([iv, authTag, encryptedBytes]);
            fs.writeFileSync(targetDestPath, packedBlob);

            manifestItems.push({
              relativePath: relPath,
              originalSize: rawData.length,
              packedSize: packedBlob.length,
              originalSha256: originalHash,
              isEncrypted: true,
            });
          } else {
            // Leave definition files (.sii, .mat) unencrypted for ATS mod detection
            fs.copyFileSync(fullSourcePath, targetDestPath);

            manifestItems.push({
              relativePath: relPath,
              originalSize: rawData.length,
              packedSize: rawData.length,
              originalSha256: originalHash,
              isEncrypted: false,
            });
          }
        }
      }
    }

    console.log(`\n[ConvoyGate Packer] Scanning: ${inputDir}`);
    fs.mkdirSync(outputDir, { recursive: true });
    processFolder(inputDir);

    const manifestData = {
      format: "convoygate_v1",
      packedAt: Math.floor(Date.now() / 1000),
      fileCount: manifestItems.length,
      files: manifestItems,
    };

    fs.writeFileSync(
      path.join(outputDir, "convoygate_manifest.json"),
      JSON.stringify(manifestData, null, 2)
    );

    console.log(`[ConvoyGate Packer] Success: Processed ${manifestItems.length} files.`);
    console.log(`[ConvoyGate Packer] Signed package saved to: ${outputDir}\n`);
  });

program.parse(process.argv);