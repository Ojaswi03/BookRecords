"use strict";

/* GitHub update check for the bundled Android app.
 *
 * The app carries its own copy of these files, so a new build can only arrive
 * as a new APK. `npm run release` publishes that APK to GitHub Releases with a
 * tag of v<versionCode>; this script compares it with the installed version and
 * offers the download. Browsers and the desktop app always load the current
 * files from the server, so they skip the check.
 */
(function () {
  const REPO = "Ojaswi03/BookRecords";

  function installedVersion() {
    try {
      if (window.ShelfApp && typeof window.ShelfApp.versionCode === "function") {
        return Number(window.ShelfApp.versionCode()) || 0;
      }
    } catch {
      /* no bridge: running in a browser */
    }
    return 0;
  }

  const current = installedVersion();
  if (!current) return;

  const line = document.getElementById("updateLine");
  if (!line) return;

  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((release) => {
      if (!release || !release.tag_name) return;
      const latest = parseInt(String(release.tag_name).replace(/[^0-9]/g, ""), 10);
      if (!latest || latest <= current) return;

      const assets = release.assets || [];
      const apk = assets.find((a) => /\.apk$/i.test(a.name || ""));
      const url = apk && apk.browser_download_url ? apk.browser_download_url : release.html_url;
      if (!url) return;

      const link = document.createElement("a");
      link.href = url;
      link.rel = "noopener";
      link.textContent = `Update available (v${latest})`;

      const note = document.createElement("span");
      note.textContent = `You have v${current}`;

      line.replaceChildren(link, note);
      line.classList.remove("hidden");
    })
    .catch(() => {
      /* offline or rate limited: no update banner is the right result */
    });
})();
