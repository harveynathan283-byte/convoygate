import express, { Request, Response } from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";

const app = express();
const PORT = 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Storage Directories
const STORAGE_DIR = path.resolve("./storage");
const DIST_DIR = path.join(STORAGE_DIR, "dist");
const TEMP_DIR = path.join(STORAGE_DIR, "temp");
const KEYS_DIR = path.join(STORAGE_DIR, "keys");

fs.mkdirSync(DIST_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(KEYS_DIR, { recursive: true });

// Database Initialization
const db = new Database(path.join(STORAGE_DIR, "convoygate.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    discord_id TEXT UNIQUE,
    tier TEXT DEFAULT 'All',
    created_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS mods (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    tier TEXT DEFAULT 'All',
    file_size INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS leases (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    hwid TEXT,
    mod_id TEXT,
    issued_at INTEGER,
    expires_at INTEGER
  );
`);

// Cryptographic Keys for Lease Signing
const privateKeyPath = path.join(KEYS_DIR, "ed25519_private.pem");
const publicKeyPath = path.join(KEYS_DIR, "ed25519_public.pem");

let privateKey: crypto.KeyObject;
let publicKey: crypto.KeyObject;

if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
  privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyPath));
  publicKey = crypto.createPublicKey(fs.readFileSync(publicKeyPath));
} else {
  const keyPair = crypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  fs.writeFileSync(privateKeyPath, keyPair.privateKey);
  fs.writeFileSync(publicKeyPath, keyPair.publicKey);
  privateKey = crypto.createPrivateKey(keyPair.privateKey);
  publicKey = crypto.createPublicKey(keyPair.publicKey);
}

// ---------------------------------------------------------------------------
// API: Licensing
// ---------------------------------------------------------------------------
app.post("/api/v1/license/lease", (req: Request, res: Response) => {
  try {
    const { discordId, hwid, modId } = req.body;
    if (!hwid) {
      return res.status(400).json({ success: false, error: "Missing required HWID." });
    }

    const userId = discordId 
      ? `usr_${crypto.createHash("md5").update(discordId).digest("hex").substring(0, 12)}`
      : "usr_guest_subscriber";

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (30 * 24 * 60 * 60);

    const payload = {
      userId,
      hwid,
      modId: modId || "all-access",
      issuedAt: now,
      expiresAt,
    };

    const dataJson = JSON.stringify(payload);
    const dataBase64 = Buffer.from(dataJson).toString("base64");
    const signatureBuffer = crypto.sign(null, Buffer.from(dataBase64), privateKey);
    const signatureBase64 = signatureBuffer.toString("base64");

    const leaseId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO leases (id, user_id, hwid, mod_id, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(leaseId, userId, hwid, modId || "all-access", now, expiresAt);

    return res.json({
      success: true,
      lease: { data: dataBase64, signature: signatureBase64 },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Mod Catalog & Distribution
// ---------------------------------------------------------------------------
app.get("/api/v1/mods", (_req: Request, res: Response) => {
  try {
    const mods = db.prepare("SELECT * FROM mods ORDER BY name ASC").all();
    return res.json({ success: true, count: mods.length, mods });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// High-speed binary upload handler with stream pipeline
app.post("/api/v1/admin/upload-stream", async (req: Request, res: Response) => {
  const modId = decodeURIComponent((req.headers["x-mod-id"] as string) || (req.query.modId as string) || "");
  const name = decodeURIComponent((req.headers["x-mod-name"] as string) || (req.query.name as string) || modId);
  const version = decodeURIComponent((req.headers["x-mod-version"] as string) || (req.query.version as string) || "1.0.0");
  const tier = decodeURIComponent((req.headers["x-mod-tier"] as string) || (req.query.tier as string) || "All");

  if (!modId) {
    return res.status(400).json({ success: false, error: "Missing mod identifier." });
  }

  const finalPath = path.join(DIST_DIR, `${modId}.scs`);
  const tempPath = path.join(TEMP_DIR, `${Date.now()}_${modId}.scs`);
  const writeStream = fs.createWriteStream(tempPath);

  try {
    // Pipeline waits until all bytes are flushed and the file descriptor is closed
    await pipeline(req, writeStream);

    if (fs.existsSync(finalPath)) {
      fs.unlinkSync(finalPath);
    }
    fs.renameSync(tempPath, finalPath);

    const fileSize = fs.statSync(finalPath).size;
    const updatedAt = Math.floor(Date.now() / 1000);

    const stmt = db.prepare(`
      INSERT INTO mods (id, name, version, tier, file_size, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        version = excluded.version,
        tier = excluded.tier,
        file_size = excluded.file_size,
        updated_at = excluded.updated_at
    `);

    stmt.run(modId, name, version, tier, fileSize, updatedAt);

    console.log(`[Admin] Mod saved to catalog: ${name} (${modId}) - ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
    return res.json({ success: true, modId, fileSize, name });
  } catch (err: any) {
    console.error("[Upload Error]:", err);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/v1/admin/mods/:id", (req: Request, res: Response) => {
  try {
    const modId = req.params.id;
    const filePath = path.join(DIST_DIR, `${modId}.scs`);

    db.prepare("DELETE FROM mods WHERE id = ?").run(modId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    console.log(`[Admin] Deleted mod: ${modId}`);
    return res.json({ success: true, modId });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/v1/client/download/:modId", (req: Request, res: Response) => {
  try {
    const modId = req.params.modId;
    const filePath = path.join(DIST_DIR, `${modId}.scs`);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: `Mod package not found for: ${modId}` });
    }

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${modId}.scs"`,
    });

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n==================================================`);
  console.log(` ConvoyGate Command Center running on port: ${PORT}`);
  console.log(` Local Network Access: http://192.168.86.111:${PORT}`);
  console.log(`==================================================\n`);
});

server.timeout = 0;
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;