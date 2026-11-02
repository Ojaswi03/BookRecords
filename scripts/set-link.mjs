/* Saves a permanent public link in data/settings.json.
 * Usage:
 *   npm run link -- your-name.ngrok-free.app
 *   npm run link -- --clear
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const file = path.join(dataDir, "settings.json");
const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(file, "utf8"));
} catch {
  settings = {};
}

if (process.argv.includes("--clear")) {
  delete settings.ngrokDomain;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log("Permanent link cleared - the next start will use a temporary ngrok URL.");
  process.exit(0);
}

if (!arg) {
  console.error("Usage: npm run link -- your-name.ngrok-free.app");
  console.error("       npm run link -- --clear");
  process.exit(1);
}

const domain = String(arg)
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\/.*$/, "")
  .toLowerCase();

if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
  console.error(`"${arg}" doesn't look like a domain. Example: humble-otter-42.ngrok-free.app`);
  process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });
settings.ngrokDomain = domain;
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");

console.log(`Permanent link saved: https://${domain}`);
console.log("Restart the app (Ctrl+C, then npm start) - the phone link will stay the same from now on.");
console.log(`Settings file: ${path.relative(root, file)}`);
