import fastify from "fastify";
import cors from "@fastify/cors";
import rawBody from "fastify-raw-body";
import dotenv from "dotenv";
import Stripe from "stripe";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import db from "./db.js";
import { KeyAuthority } from "./crypto.js";
import { DiscordManager } from "./services/discord.js";

dotenv.config();

const app = fastify({ logger: false });
const authority = new KeyAuthority();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder", {
  apiVersion: "2024-11-20.acacia" as any,
});

const discord = new DiscordManager(
  process.env.DISCORD_BOT_TOKEN,
  process.env.DISCORD_GUILD_ID,
  process.env.DISCORD_SUBSCRIBER_ROLE_ID
);

await app.register(cors, { origin: true });
await app.register(rawBody, {
  field: "rawBody",
  global: false,
  encoding: false,
  runFirst: true,
});

// Storage directories for mods and compiled distribution archives
const MODS_DIR = path.resolve("./storage/mods");
const DIST_DIR = path.resolve("./storage/dist");
fs.mkdirSync(MODS_DIR, { recursive: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

// Seed default mod if missing from database
const existingMod = db.prepare("SELECT * FROM mods WHERE id = ?").get("w900_custom_rig");
if (!existingMod) {
  db.prepare(`
    INSERT INTO mods (id, name, latest_version, aes_encryption_key)
    VALUES ('w900_custom_rig', 'Kenworth W900 Custom Highway Edition', 'v1.0.4', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')
  `).run();
}

// Generate consistent HWID for the host machine
function getLocalHWID(): string {
  const cpus = os.cpus().map((c) => c.model).join(",");
  const network = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && !iface.internal && iface.mac !== "00:00:00:00:00:00")
    .map((iface) => iface.mac)
    .sort()
    .join(",");
  const username = os.userInfo().username;
  const platform = `${os.platform()}-${os.arch()}`;
  return crypto.createHash("sha256").update(`${platform}|${cpus}|${network}|${username}`).digest("hex").toUpperCase();
}

// Resolve ATS mod and plugin directories across Windows and macOS
function getAtsPaths() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return {
      modDir: path.join(home, "Documents", "American Truck Simulator", "mod"),
      pluginDir: "C:\\Program Files (x86)\\Steam\\steamapps\\common\\American Truck Simulator\\bin\\win_x64\\plugins",
    };
  } else {
    return {
      modDir: path.join(home, "Library", "Application Support", "American Truck Simulator", "mod"),
      pluginDir: path.join(home, "Library", "Application Support", "Steam", "steamapps", "common", "American Truck Simulator", "plugins"),
    };
  }
}

// Mod Packing Engine (AES-256-GCM encryption on game assets)
function packModFolder(modId: string, hexKey: string) {
  const rawModPath = path.join(MODS_DIR, modId);
  const outPath = path.join(DIST_DIR, `${modId}.scs`);
  const aesKey = Buffer.from(hexKey, "hex");

  // Create mock mod assets if folder is empty
  if (!fs.existsSync(rawModPath)) {
    fs.mkdirSync(path.join(rawModPath, "vehicle/truck/kenworth_w900"), { recursive: true });
    fs.mkdirSync(path.join(rawModPath, "def/vehicle/truck"), { recursive: true });
    fs.writeFileSync(path.join(rawModPath, "manifest.sii"), 'SiiNunit { mod_package : .package_info { name: "Kenworth W900 Custom" } }');
    fs.writeFileSync(path.join(rawModPath, "vehicle/truck/kenworth_w900/interior.pmd"), "CONVOYGATE_BINARY_3D_MODEL_MESH_DATA");
    fs.writeFileSync(path.join(rawModPath, "vehicle/truck/kenworth_w900/skin_highres.dds"), "CONVOYGATE_RAW_TEXTURE_RGBA_BUFFER");
  }

  const manifestItems: any[] = [];
  const encryptedBlobs: Buffer[] = [];
  const ENCRYPT_EXTS = new Set([".pmd", ".pmg", ".pmc", ".dds", ".tobj", ".bank"]);

  function scanDir(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(rawModPath, full).replace(/\\/g, "/");

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

  scanDir(rawModPath);

  const manifestBuffer = Buffer.from(JSON.stringify(manifestItems));
  const header = Buffer.alloc(8);
  header.write("CVG1", 0);
  header.writeUInt32LE(manifestBuffer.length, 4);

  const archive = Buffer.concat([header, manifestBuffer, ...encryptedBlobs]);
  fs.writeFileSync(outPath, archive);

  return { fileCount: manifestItems.length, packageSize: archive.length, outPath };
}

// 1. Web Dashboard & Command Center UI
app.get("/", async (request, reply) => {
  const hwid = getLocalHWID();
  const mods = db.prepare("SELECT id, name, latest_version FROM mods").all() as any[];
  const user = db.prepare("SELECT * FROM users WHERE discord_id = 'discord_user_123'").get() as any;
  const subStatus = user ? user.subscription_status : "none";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ConvoyGate Command Center</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0b0f19; color: #f1f5f9; padding: 36px; max-width: 960px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1e293b; padding-bottom: 20px; }
    h1 { font-size: 22px; font-weight: 700; color: #38bdf8; }
    .badge { background: #1e293b; color: #94a3b8; font-size: 11px; padding: 6px 12px; border-radius: 6px; font-family: monospace; }
    .status-active { color: #4ade80; font-weight: 700; }
    .status-inactive { color: #f87171; font-weight: 700; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 24px; }
    .card { background: #131c2e; border: 1px solid #1e293b; border-radius: 10px; padding: 22px; }
    h2 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; margin-bottom: 14px; }
    label { font-size: 12px; font-weight: 600; text-transform: uppercase; color: #64748b; display: block; margin-bottom: 6px; }
    input { width: 100%; background: #0b0f19; border: 1px solid #334155; color: #fff; padding: 10px 14px; border-radius: 6px; font-size: 14px; margin-bottom: 14px; outline: none; }
    .btn { background: #0284c7; color: #fff; border: none; padding: 10px 16px; border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer; transition: 0.2s; }
    .btn:hover { background: #0369a1; }
    .btn-red { background: #ef4444; }
    .btn-red:hover { background: #dc2626; }
    .btn-green { background: #10b981; }
    .btn-green:hover { background: #059669; }
    .btn-purple { background: #8b5cf6; }
    .btn-purple:hover { background: #7c3aed; }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    #console { margin-top: 24px; font-family: monospace; font-size: 12px; line-height: 1.6; padding: 18px; border-radius: 8px; background: #060911; border: 1px solid #1e293b; color: #38bdf8; min-height: 120px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div class="header">
    <h1>ConvoyGate Command Center</h1>
    <div class="badge">HWID: ${hwid.substring(0, 18)}...</div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Subscriber View</h2>
      <label>Subscriber Discord ID</label>
      <input type="text" id="discordId" value="discord_user_123">

      <label>Subscription Status</label>
      <div style="font-size: 14px; margin-bottom: 16px;">
        Database Record: <span id="subLabel" class="${subStatus === "active" ? "status-active" : "status-inactive"}">${subStatus.toUpperCase()}</span>
      </div>

      <button class="btn" style="width: 100%;" onclick="syncMod('w900_custom_rig')">Sync 30-Day License & Deploy Mod</button>
    </div>

    <div class="card">
      <h2>Security & Anti-Piracy Testing</h2>
      <p style="font-size: 13px; color: #94a3b8; margin-bottom: 14px;">Toggle entitlements instantly to test client verification and lease blocking.</p>

      <div class="actions">
        <button class="btn btn-green" onclick="toggleSub('active')">Set Active</button>
        <button class="btn btn-red" onclick="toggleSub('inactive')">Revoke / Expire</button>
      </div>

      <div style="margin-top: 20px; border-top: 1px solid #1e293b; padding-top: 16px;">
        <label>Mod Packer Tool</label>
        <button class="btn btn-purple" style="width: 100%;" onclick="triggerPacker('w900_custom_rig')">Build & Encrypt .SCS Package (AES-256)</button>
      </div>
    </div>
  </div>

  <div id="console">System ready. Current machine HWID locked. Select an action above.</div>

  <script>
    async function syncMod(modId) {
      const consoleBox = document.getElementById("console");
      const discordId = document.getElementById("discordId").value;
      consoleBox.innerText = "[ConvoyGate] Requesting rolling 30-day lease for " + modId + "...\\n";

      try {
        const res = await fetch("/api/v1/client/sync-local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ discordId, modId })
        });
        const data = await res.json();
        if (data.success) {
          consoleBox.innerText = "[ConvoyGate] SUCCESS: License Granted!\\n\\n" +
            "• 30-Day Lease Saved: " + data.keyPath + "\\n" +
            "• Mod Package Deployed: " + data.modPath + "\\n\\n" +
            "Lease Data:\\n" + JSON.stringify(data.leaseData, null, 2);
        } else {
          consoleBox.innerText = "[ConvoyGate] ACCESS DENIED: " + data.error;
        }
      } catch (err) {
        consoleBox.innerText = "[ConvoyGate] Network error: " + err.message;
      }
    }

    async function toggleSub(status) {
      const discordId = document.getElementById("discordId").value;
      const res = await fetch("/api/v1/admin/toggle-sub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ discordId, status })
      });
      const data = await res.json();
      const label = document.getElementById("subLabel");
      label.innerText = status.toUpperCase();
      label.className = status === 'active' ? 'status-active' : 'status-inactive';
      document.getElementById("console").innerText = "[ConvoyGate Security] " + data.message;
    }

    async function triggerPacker(modId) {
      const consoleBox = document.getElementById("console");
      consoleBox.innerText = "[ConvoyGate Packer] Encrypting asset stream with AES-256-GCM...\\n";
      const res = await fetch("/api/v1/admin/pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modId })
      });
      const data = await res.json();
      if (data.success) {
        consoleBox.innerText = "[ConvoyGate Packer] SUCCESS: Package Compiled!\\n" +
          "• Total Assets: " + data.fileCount + "\\n" +
          "• Encrypted Package Size: " + data.packageSize + " bytes\\n" +
          "• Output: " + data.outPath;
      }
    }
  </script>
</body>
</html>`;

  reply.type("text/html");
  return reply.send(html);
});

// 2. Client Sync & Deployment Endpoint (Local dev runner)
app.post("/api/v1/client/sync-local", async (request, reply) => {
  const { discordId, modId } = request.body as { discordId: string; modId: string };
  const hwid = getLocalHWID();
  const ats = getAtsPaths();

  const user = db.prepare("SELECT * FROM users WHERE discord_id = ?").get(discordId) as any;
  if (!user || user.subscription_status !== "active") {
    return reply.status(403).send({ error: "Access Rejected: Subscription is inactive or revoked." });
  }

  const leaseToken = authority.signLease(user.id, hwid, modId);
  fs.mkdirSync(ats.pluginDir, { recursive: true });
  const keyPath = path.join(ats.pluginDir, "convoygate.key");
  fs.writeFileSync(keyPath, JSON.stringify(leaseToken, null, 2));

  // Build and copy encrypted archive
  const modRecord = db.prepare("SELECT aes_encryption_key FROM mods WHERE id = ?").get(modId) as any;
  const packed = packModFolder(modId, modRecord.aes_encryption_key);

  fs.mkdirSync(ats.modDir, { recursive: true });
  const modPath = path.join(ats.modDir, `${modId}.scs`);
  fs.copyFileSync(packed.outPath, modPath);

  return reply.send({
    success: true,
    keyPath,
    modPath,
    leaseData: JSON.parse(Buffer.from(JSON.parse(leaseToken).data, "base64").toString("utf-8")),
  });
});

// 3. Admin: Toggle Subscription Status
app.post("/api/v1/admin/toggle-sub", async (request, reply) => {
  const { discordId, status } = request.body as { discordId: string; status: "active" | "inactive" };
  const now = Math.floor(Date.now() / 1000);
  const end = status === "active" ? now + 30 * 86400 : 0;

  db.prepare(`
    INSERT INTO users (id, discord_id, discord_username, subscription_status, current_period_end, created_at)
    VALUES ('usr_test', ?, 'Subscriber_Test', ?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET subscription_status = excluded.subscription_status, current_period_end = excluded.current_period_end
  `).run(discordId, status, end, now);

  await discord.setSubscriberRole(discordId, status === "active");
  return reply.send({ success: true, message: `Subscription for ${discordId} updated to ${status.toUpperCase()}` });
});

// 4. Admin: Trigger Asset Encryption & Packing
app.post("/api/v1/admin/pack", async (request, reply) => {
  const { modId } = request.body as { modId: string };
  const modRecord = db.prepare("SELECT aes_encryption_key FROM mods WHERE id = ?").get(modId) as any;
  const result = packModFolder(modId, modRecord.aes_encryption_key);
  return reply.send({ success: true, ...result });
});

// 5. Licensing: Public Key Retrieval
app.get("/api/v1/license/public-key", async () => {
  return { publicKey: authority.publicKey };
});

// 6. Licensing: Standard Remote Lease Request (Used by Windows Client .exe)
app.post("/api/v1/license/lease", async (request, reply) => {
  const { discordId, hwid, modId } = request.body as { discordId: string; hwid: string; modId: string };

  if (!discordId || !hwid || !modId) {
    return reply.status(400).send({ error: "Missing required parameters: discordId, hwid, modId" });
  }

  const user = db.prepare("SELECT * FROM users WHERE discord_id = ?").get(discordId) as any;
  if (!user || user.subscription_status !== "active") {
    return reply.status(403).send({ error: "Subscription is not active or user not found." });
  }

  db.prepare(`
    INSERT INTO devices (hwid, user_id, last_seen) VALUES (?, ?, ?)
    ON CONFLICT(hwid) DO UPDATE SET last_seen = excluded.last_seen
  `).run(hwid, user.id, Math.floor(Date.now() / 1000));

  const leaseToken = authority.signLease(user.id, hwid, modId);
  return reply.send({ success: true, lease: JSON.parse(leaseToken) });
});

// 7. Mod Archive Download Endpoint for Windows Client Application
app.get("/api/v1/client/download/:modId", async (request, reply) => {
  const { modId } = request.params as { modId: string };
  const filePath = path.join(DIST_DIR, `${modId}.scs`);

  // If mod is not packed yet, auto-pack it from storage
  if (!fs.existsSync(filePath)) {
    const modRecord = db.prepare("SELECT aes_encryption_key FROM mods WHERE id = ?").get(modId) as any;
    if (modRecord) {
      packModFolder(modId, modRecord.aes_encryption_key);
    } else {
      return reply.status(404).send({ error: "Mod archive not found on server." });
    }
  }

  const stream = fs.createReadStream(filePath);
  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Disposition", `attachment; filename="${modId}.scs"`);
  return reply.send(stream);
});

// 8. Stripe: Checkout Session Creator
app.post("/api/v1/billing/create-checkout", async (request, reply) => {
  const { discordId, email } = request.body as { discordId: string; email: string };

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: email,
      metadata: { discordId },
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "ConvoyGate Mod Vault Subscription",
              description: "Access to all encrypted ATS truck mods and rolling 30-day updates.",
            },
            unit_amount: 999, // $9.99/mo
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      success_url: "http://localhost:3000/?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "http://localhost:3000/",
    });

    return reply.send({ url: session.url });
  } catch (err: any) {
    return reply.status(500).send({ error: err.message });
  }
});

// 9. Stripe: Customer Billing Portal
app.post("/api/v1/billing/customer-portal", async (request, reply) => {
  const { discordId } = request.body as { discordId: string };
  const user = db.prepare("SELECT stripe_customer_id FROM users WHERE discord_id = ?").get(discordId) as any;

  if (!user?.stripe_customer_id) {
    return reply.status(404).send({ error: "No active Stripe customer found for this Discord ID." });
  }

  try {
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: "http://localhost:3000/",
    });

    return reply.send({ url: portal.url });
  } catch (err: any) {
    return reply.status(500).send({ error: err.message });
  }
});

// 10. Stripe: Webhook Listener
app.post("/webhook/stripe", { config: { rawBody: true } }, async (request, reply) => {
  const sig = request.headers["stripe-signature"] as string;
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      (request as any).rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET || ""
    );
  } catch (err: any) {
    return reply.status(400).send(`Webhook signature failed: ${err.message}`);
  }

  if (event.type === "invoice.payment_succeeded") {
    const invoice = event.data.object as Stripe.Invoice;
    const customerId = invoice.customer as string;

    const user = db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?").get(customerId) as any;
    if (user) {
      db.prepare("UPDATE users SET subscription_status = 'active', current_period_end = ? WHERE id = ?")
        .run(Math.floor(Date.now() / 1000) + 30 * 86400, user.id);
      await discord.setSubscriberRole(user.discord_id, true);
    }
  }

  if (event.type === "customer.subscription.deleted" || event.type === "invoice.payment_failed") {
    const customerId = (event.data.object as any).customer as string;
    const user = db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?").get(customerId) as any;
    if (user) {
      db.prepare("UPDATE users SET subscription_status = 'inactive' WHERE id = ?").run(user.id);
      await discord.setSubscriberRole(user.discord_id, false);
    }
  }

  return reply.status(200).send({ received: true });
});

// 11. Server Initialization
const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`\n ConvoyGate Command Center running at: http://localhost:${port}\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();