#!/usr/bin/env node
/**
 * Publishes a new Android build to GitHub Releases.
 *
 *   1. bumps versionCode and versionName in android/AndroidManifest.xml
 *   2. rebuilds public/download/ShelfScout.apk
 *   3. creates (or updates) the release v<versionCode> with the APK attached
 *
 * Installed apps then show "Update available" from public/update.js.
 *
 *   npm run release
 *   npm run release -- --notes "Fixed the genre dropdown"
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(root, "android", "AndroidManifest.xml");
const apkPath = path.join(root, "public", "download", "ShelfScout.apk");

const args = process.argv.slice(2);
const notesIndex = args.indexOf("--notes");
const notes = notesIndex !== -1 ? args[notesIndex + 1] || "" : "";

try {
  execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
} catch {
  console.error("GitHub CLI is not signed in. Run `gh auth login`, then try again.");
  process.exit(1);
}

let xml = fs.readFileSync(manifestPath, "utf8");
const codeMatch = xml.match(/android:versionCode="(\d+)"/);
const nameMatch = xml.match(/android:versionName="([^"]+)"/);
if (!codeMatch || !nameMatch) {
  console.error("Could not read versionCode/versionName from android/AndroidManifest.xml");
  process.exit(1);
}

const nextCode = Number(codeMatch[1]) + 1;
const parts = nameMatch[1].split(".").map((n) => Number(n) || 0);
while (parts.length < 3) parts.push(0);
parts[parts.length - 1] += 1;
const nextName = parts.join(".");

xml = xml
  .replace(/android:versionCode="\d+"/, `android:versionCode="${nextCode}"`)
  .replace(/android:versionName="[^"]+"/, `android:versionName="${nextName}"`);
fs.writeFileSync(manifestPath, xml);

console.log(`Building ShelfScout ${nextName} (versionCode ${nextCode})`);
execFileSync("bash", [path.join(root, "android", "build.sh")], { stdio: "inherit" });

if (!fs.existsSync(apkPath)) {
  console.error("The build finished but the APK is missing. Nothing was published.");
  process.exit(1);
}

// The same app files, packed for the in-app updater. Installed phones download
// this instead of a new APK, so the library and the page origin never change.
const bundleDir = path.join(root, "android", "build", "web");
const zipPath = path.join(root, "android", "build", "ShelfScout-web.zip");
fs.rmSync(bundleDir, { recursive: true, force: true });
fs.cpSync(path.join(root, "public"), bundleDir, {
  recursive: true,
  filter: (src) => path.basename(src) !== "download",
});
fs.writeFileSync(path.join(bundleDir, ".webversion"), String(nextCode));
fs.rmSync(zipPath, { force: true });
execFileSync("zip", ["-qr", zipPath, "."], { cwd: bundleDir, stdio: "inherit" });

const tag = `v${nextCode}`;
const title = `ShelfScout ${nextName}`;
const body = notes || `ShelfScout ${nextName}. Open the app and tap Update app files - no reinstall needed.`;

try {
  execFileSync("gh", ["release", "create", tag, apkPath, zipPath, "--title", title, "--notes", body], {
    stdio: "inherit",
    cwd: root,
  });
} catch {
  execFileSync("gh", ["release", "upload", tag, apkPath, zipPath, "--clobber"], { stdio: "inherit", cwd: root });
}

console.log(`Published ${tag} with the APK and the web bundle. Installed apps will offer the update.`);
console.log("Commit the version bump:");
console.log(`  git add android/AndroidManifest.xml && git commit -m "Release ${nextName}"`);
