import { KeyAuthority } from "./crypto.js";

const authority = new KeyAuthority();

console.log("--- ConvoyGate Authority Initialized ---");
console.log("Public Key generated:\n", authority.publicKey);

const testUser = "usr_discord_987654321";
const validHWID = "PC-MAC-ADDR-B4:2E:99:A1";
const attackerHWID = "PC-PIRATE-C8:11:00:FF";
const modId = "w900_custom_rig";

// 1. Issue signed 30-day rolling token
console.log("\n[1] Issuing 30-day lease for active subscriber...");
const token = authority.signLease(testUser, validHWID, modId);
console.log("Generated Token Blob:\n", token);

// 2. Validate valid user on their own PC
console.log("\n[2] Testing validation on authorized subscriber machine:");
const validCheck = authority.verifyLease(token, validHWID);
console.log("Result:", validCheck);

// 3. Test piracy attempt (Token copied to another machine)
console.log("\n[3] Testing piracy attempt (shared token on different HWID):");
const pirateCheck = authority.verifyLease(token, attackerHWID);
console.log("Result:", pirateCheck);