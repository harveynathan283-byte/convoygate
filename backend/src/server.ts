import express, { Request, Response } from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import multer from "multer";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
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

// Multer Storage Configuration (Handles up to 10 GB mod files)
const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 },
});

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

// Ed25519 Cryptographic Keys for Lease Signing
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
// API Routes: Licensing
// ---------------------------------------------------------------------------

// Issues signed 30-day hardware leases to client launcher
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
    const expiresAt = now + (30 * 24 * 60 * 60); // 30-day lease expiration

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

    // Track active lease in database
    const leaseId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO leases (id, user_id, hwid, mod_id, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(leaseId, userId, hwid, modId || "all-access", now, expiresAt);

    console.log(`[License] Issued 30-day lease for HWID: ${hwid} (${userId})`);

    return res.json({
      success: true,
      lease: {
        data: dataBase64,
        signature: signatureBase64,
      },
    });
  } catch (err: any) {
    console.error("[Lease Error]:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API Routes: Mod Catalog & Distribution
// ---------------------------------------------------------------------------

// Returns all uploaded mods to Launcher and Admin Panel
app.get("/api/v1/mods", (_req: Request, res: Response) => {
  try {
    const mods = db.prepare("SELECT * FROM mods ORDER BY name ASC").all();
    return res.json({ success: true, count: mods.length, mods });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Admin upload route: saves locked .scs and registers it in database
app.post("/api/v1/admin/upload", upload.single("file"), (req: Request, res: Response) => {
  try {
    const { modId, name, version, tier } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, error: "No mod file received." });
    }

    if (!modId) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: "Missing modId parameter." });
    }

    const finalPath = path.join(DIST_DIR, `${modId}.scs`);

    // Move uploaded file from temp to distribution directory
    if (fs.existsSync(finalPath)) {
      fs.unlinkSync(finalPath);
    }
    fs.renameSync(req.file.path, finalPath);

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

    stmt.run(modId, name || modId, version || "1.0.0", tier || "All", fileSize, updatedAt);

    console.log(`[Admin] Mod registered: ${name} (${modId}) - ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
    return res.json({ success: true, modId, fileSize });
  } catch (err: any) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error("[Upload Error]:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Admin delete route: removes mod from DB and deletes .scs from disk
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

// Client download endpoint: streams locked .scs to launcher
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

// ---------------------------------------------------------------------------
// Server Command Center Web Dashboard
// ---------------------------------------------------------------------------
app.get("/", (_req: Request, res: Response) => {
  const mods = db.prepare("SELECT * FROM mods ORDER BY name ASC").all();
  const leaseCount = (db.prepare("SELECT COUNT(*) as count FROM leases").get() as any).count;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>ConvoyGate Command Center</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f111a; color: #fff; padding: 40px; margin: 0; }
        .container { max-width: 1000px; margin: 0 auto; }
        h1 { color: #8a2be2; margin-bottom: 5px; }
        .sub { color: #888; margin-bottom: 30px; }
        .stats { display: flex; gap: 20px; margin-bottom: 30px; }
        .card { background: #1a1d2e; border: 1px solid #2a2e45; border-radius: 8px; padding: 20px; flex: 1; }
        .card h3 { margin: 0 0 10px 0; color: #aaa; font-size: 0.9em; text-transform: uppercase; }
        .card p { margin: 0; font-size: 2em; font-weight: bold; color: #00e676; }
        table { width: 100%; border-collapse: collapse; background: #1a1d2e; border-radius: 8px; overflow: hidden; }
        th, td { padding: 14px 18px; text-align: left; border-bottom: 1px solid #2a2e45; }
        th { background: #22263d; color: #aaa; font-size: 0.85em; text-transform: uppercase; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>ConvoyGate Cloud Master</h1>
        <p class="sub">Central Distribution & DRM Licensing Authority</p>

        <div class="stats">
          <div class="card">
            <h3>Active Catalog Mods</h3>
            <p>${mods.length}</p>
          </div>
          <div class="card">
            <h3>Active Leases Issued</h3>
            <p>${leaseCount}</p>
          </div>
        </div>

        <h2>Uploaded Mod Catalog</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Version</th>
              <th>Tier</th>
              <th>File Size</th>
            </tr>
          </thead>
          <tbody>
            ${mods.map((m: any) => `
              <tr>
                <td><code>${m.id}</code></td>
                <td><strong>${m.name}</strong></td>
                <td>${m.version}</td>
                <td>${m.tier}</td>
                <td>${(m.file_size / 1024 / 1024).toFixed(2)} MB</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </body>
    </html>
  `;
  res.send(html);
});

// Start Server
app.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(` ConvoyGate Command Center running on port: ${PORT}`);
  console.log(` Health URL: http://localhost:${PORT}/api/v1/mods`);
  console.log(` Dashboard:  http://localhost:${PORT}/`);
  console.log(`==================================================\n`);
});