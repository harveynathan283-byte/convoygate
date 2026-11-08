import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.env.DATABASE_URL || "convoygate.db");

// Initialize core tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    discord_id TEXT UNIQUE NOT NULL,
    discord_username TEXT,
    stripe_customer_id TEXT UNIQUE,
    subscription_status TEXT DEFAULT 'inactive',
    current_period_end INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    hwid TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT,
    last_seen INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS mods (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    latest_version TEXT NOT NULL,
    aes_encryption_key TEXT NOT NULL
  );
`);

export default db;