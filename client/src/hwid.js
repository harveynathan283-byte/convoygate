import os from "node:os";
import crypto from "node:crypto";

export function getMachineHWID() {
  const cpus = os.cpus().map((c) => c.model).join(",");
  const network = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface && !iface.internal && iface.mac !== "00:00:00:00:00:00")
    .map((iface) => iface.mac)
    .sort()
    .join(",");
  const username = os.userInfo().username;
  const platform = `${os.platform()}-${os.arch()}`;

  const rawFingerprint = `${platform}|${cpus}|${network}|${username}`;
  return crypto.createHash("sha256").update(rawFingerprint).digest("hex").toUpperCase();
}