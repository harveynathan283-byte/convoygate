import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LicenseTokenPayload {
  userId: string;
  hwid: string;
  modId: string;
  issuedAt: number;
  expiresAt: number;
}

export class KeyAuthority {
  private privateKey: string;
  public publicKey: string;

  constructor(keyDir = "./keys") {
    const privPath = path.join(keyDir, "master_private.pem");
    const pubPath = path.join(keyDir, "master_public.pem");

    if (!fs.existsSync(privPath) || !fs.existsSync(pubPath)) {
      fs.mkdirSync(keyDir, { recursive: true });
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      fs.writeFileSync(privPath, privateKey);
      fs.writeFileSync(pubPath, publicKey);
      this.privateKey = privateKey;
      this.publicKey = publicKey;
    } else {
      this.privateKey = fs.readFileSync(privPath, "utf-8");
      this.publicKey = fs.readFileSync(pubPath, "utf-8");
    }
  }

  /**
   * Generates a signed, hardware-locked 30-day token.
   */
  public signLease(userId: string, hwid: string, modId: string): string {
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysInSeconds = 30 * 24 * 60 * 60;

    const payload: LicenseTokenPayload = {
      userId,
      hwid,
      modId,
      issuedAt: now,
      expiresAt: now + thirtyDaysInSeconds,
    };

    const payloadStr = JSON.stringify(payload);
    const signature = crypto.sign(null, Buffer.from(payloadStr), this.privateKey);

    return JSON.stringify({
      data: Buffer.from(payloadStr).toString("base64"),
      signature: signature.toString("base64"),
    });
  }

  /**
   * Validates token authenticity, HWID lock, and 30-day expiration window.
   */
  public verifyLease(
    tokenString: string,
    currentHwid: string
  ): { valid: boolean; reason?: string; payload?: LicenseTokenPayload } {
    try {
      const parsed = JSON.parse(tokenString);
      const rawPayload = Buffer.from(parsed.data, "base64");
      const signature = Buffer.from(parsed.signature, "base64");

      const isSignatureValid = crypto.verify(null, rawPayload, this.publicKey, signature);
      if (!isSignatureValid) {
        return { valid: false, reason: "Cryptographic signature check failed (forged token)." };
      }

      const payload: LicenseTokenPayload = JSON.parse(rawPayload.toString("utf-8"));
      const now = Math.floor(Date.now() / 1000);

      if (payload.hwid !== currentHwid) {
        return { valid: false, reason: "Hardware ID mismatch. Token belongs to another PC." };
      }

      if (now > payload.expiresAt) {
        return { valid: false, reason: "Subscription lease has expired." };
      }

      return { valid: true, payload };
    } catch {
      return { valid: false, reason: "Malformed token payload." };
    }
  }
}