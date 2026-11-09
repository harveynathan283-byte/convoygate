import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import axios from "axios";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Environment & Security Config
const SERVER_URL = process.env.SERVER_URL || "https://api.convoygate.com";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "cg_admin_local_fallback";
const JWT_SECRET = process.env.JWT_SECRET || "convoygate_default_jwt_secret";
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || "";
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || "";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const DISCORD_SUBSCRIBER_ROLE_ID = process.env.DISCORD_SUBSCRIBER_ROLE_ID || "";

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
// Middleware & Discord Verification
// ---------------------------------------------------------------------------

const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const key = req.headers["x-admin-key"] || req.headers.authorization?.replace("Bearer ", "");
  if (key !== ADMIN_API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized: Invalid admin key" });
  }
  next();
};

async function verifyDiscordSubscriber(discordUserId: string): Promise<boolean> {
  try {
    const res = await axios.get(
      `https://discord.com/api/v10/guilds/${DISCORD_GUILD_ID}/members/${discordUserId}`,
      { headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }, timeout: 5000 }
    );
    const roles: string[] = res.data.roles || [];
    return roles.includes(DISCORD_SUBSCRIBER_ROLE_ID);
  } catch (err: any) {
    console.error(`[Discord Auth] Error fetching member ${discordUserId}:`, err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// API: Discord Authentication Flow
// ---------------------------------------------------------------------------

app.get("/api/v1/auth/discord/login", (req: Request, res: Response) => {
  const redirectUri = encodeURIComponent(`${SERVER_URL}/api/v1/auth/discord/callback`);
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=identify`);
});

app.get("/api/v1/auth/discord/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) return res.status(400).send("No code provided.");

  try {
    // 1. Exchange code for access token
    const tokenRes = await axios.post("https://discord.com/api/v10/oauth2/token",
      new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code: code,
        redirect_uri: `${SERVER_URL}/api/v1/auth/discord/callback`,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    // 2. Fetch User Identity
    const userRes = await axios.get("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });
    const user = userRes.data;

    // 3. Verify they are currently a subscriber
    const isSub = await verifyDiscordSubscriber(user.id);
    if (!isSub) {
      return res.send(`
        <html><body style="background:#0d0f17;color:#f87171;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
          <div style="text-align:center;">
            <h2>Access Denied</h2>
            <p>Your Discord account does not have the active subscriber role.</p>
          </div>
        </body></html>
      `);
    }

    // 4. Issue JWT and redirect to a success route the Electron app is listening for
    const sessionToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
    res.redirect(`/api/v1/auth/discord/success?token=${sessionToken}&username=${encodeURIComponent(user.username)}`);

  } catch (err: any) {
    res.status(500).send("Discord authentication failed.");
  }
});

// Dummy route for Electron to intercept
app.get("/api/v1/auth/discord/success", (req: Request, res: Response) => {
  res.send(`
    <html><body style="background:#0d0f17;color:#52b788;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;">
      <div style="text-align:center;">
        <h2>Authentication Successful</h2>
        <p>You can now return to the ConvoyGate Launcher.</p>
      </div>
    </body></html>
  `);
});

// ---------------------------------------------------------------------------
// API: Licensing (Requires JWT & Live Discord Role)
// ---------------------------------------------------------------------------

app.post("/api/v1/license/lease", async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, error: "Missing session token." });
    
    const token = authHeader.replace("Bearer ", "");
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    // Live subscription check (Revokes access immediately if they stopped paying)
    const isSub = await verifyDiscordSubscriber(decoded.id);
    if (!isSub) {
      return res.status(403).json({ success: false, error: "Subscription expired or canceled." });
    }

    const { hwid, modId } = req.body;
    if (!hwid) return res.status(400).json({ success: false, error: "Missing required HWID." });

    const userId = `usr_${decoded.id}`;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + (30 * 24 * 60 * 60);

    const payload = {
      userId,
      hwid: hwid.toLowerCase().trim(),
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
    `).run(leaseId, userId, hwid, payload.modId, now, expiresAt);

    return res.json({ success: true, lease: { data: dataBase64, signature: signatureBase64 } });
  } catch (err: any) {
    return res.status(401).json({ success: false, error: "Invalid or expired session. Please log in again." });
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

app.post("/api/v1/admin/upload-stream", requireAdmin, async (req: Request, res: Response) => {
  const modId = decodeURIComponent((req.headers["x-mod-id"] as string) || "");
  const name = decodeURIComponent((req.headers["x-mod-name"] as string) || modId);
  const version = decodeURIComponent((req.headers["x-mod-version"] as string) || "1.0.0");
  const tier = decodeURIComponent((req.headers["x-mod-tier"] as string) || "All");

  if (!modId) return res.status(400).json({ success: false, error: "Missing mod identifier." });

  const finalPath = path.join(DIST_DIR, `${modId}.scs`);
  const tempPath = path.join(TEMP_DIR, `${Date.now()}_${modId}.scs`);
  const writeStream = fs.createWriteStream(tempPath);

  try {
    await pipeline(req, writeStream);
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    fs.renameSync(tempPath, finalPath);

    const fileSize = fs.statSync(finalPath).size;
    const updatedAt = Math.floor(Date.now() / 1000);

    db.prepare(`
      INSERT INTO mods (id, name, version, tier, file_size, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, version=excluded.version, tier=excluded.tier, file_size=excluded.file_size, updated_at=excluded.updated_at
    `).run(modId, name, version, tier, fileSize, updatedAt);

    console.log(`[Admin] Mod saved: ${name} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
    return res.json({ success: true, modId, fileSize, name });
  } catch (err: any) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete("/api/v1/admin/mods/:id", requireAdmin, (req: Request, res: Response) => {
  try {
    const modId = req.params.id;
    const filePath = path.join(DIST_DIR, `${modId}.scs`);
    db.prepare("DELETE FROM mods WHERE id = ?").run(modId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return res.json({ success: true, modId });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Download Route (Requires JWT & Valid Role)
app.get("/api/v1/client/download/:modId", async (req: Request, res: Response) => {
  try {
    const token = (req.query.token as string) || req.headers.authorization?.replace("Bearer ", "");
    if (!token) return res.status(401).json({ success: false, error: "Missing session token." });

    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const isSub = await verifyDiscordSubscriber(decoded.id);
    if (!isSub) return res.status(403).json({ success: false, error: "Active subscription required to download files." });

    const modId = req.params.modId;
    const filePath = path.join(DIST_DIR, `${modId}.scs`);

    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: "Mod package missing on server." });

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${modId}.scs"`,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err: any) {
    return res.status(403).json({ success: false, error: "Invalid session. Please relogin." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ConvoyGate Hub online on port ${PORT}`);
});