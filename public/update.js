"use strict";

/* In-app update for the bundled Android app.
 *
 * The installed APK cannot be changed, so the app keeps its web files in its
 * own storage and serves those when they exist. This script compares the web
 * version it already has with the newest GitHub release, and hands the bundle
 * URL to the Android bridge, which downloads and unpacks it. One tap, no APK
 * install, and the library stays because the page origin never changes.
 *
 * Browsers and the desktop app always load the current files from the server,
 * so they have no bridge and skip all of this.
 */
(function () {
  const REPO = "Ojaswi03/BookRecords";
  const bridge = window.ShelfApp;

  if (!bridge || typeof bridge.webVersion !== "function" || typeof bridge.installWebUpdate !== "function") return;

  const line = document.getElementById("updateLine");
  if (!line) return;

  let current = 0;
  let native = 0;
  try {
    current = Number(bridge.webVersion()) || 0;
    native = Number(typeof bridge.versionCode === "function" ? bridge.versionCode() : 0) || 0;
  } catch {
    return;
  }

  // Web files cannot add native code. If this APK predates the in-app PDF
  // reader, say so plainly instead of offering another web-only update.
  const canReadInApp = typeof bridge.openPdf === "function";

  const build = document.getElementById("buildInfo");
  if (build) {
    build.textContent = `App v${native} · files v${current}`;
    build.classList.remove("hidden");
  }

  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    cache: "no-store",
  })
    .then((res) => (res.ok ? res.json() : null))
    .then((release) => {
      if (!release || !release.tag_name) return;
      const latest = parseInt(String(release.tag_name).replace(/[^0-9]/g, ""), 10);
      if (!latest) return;

      const assets = release.assets || [];
      const apk = assets.find((a) => /\.apk$/i.test(a.name || ""));
      const apkUrl = apk && apk.browser_download_url
        ? apk.browser_download_url
        : `https://github.com/${REPO}/releases/latest/download/ShelfScout.apk`;

      if (!canReadInApp) {
        const install = document.createElement("a");
        install.href = apkUrl;
        install.rel = "noopener";
        install.textContent = `Install app update (v${latest})`;

        const why = document.createElement("span");
        why.textContent = "Needed once to read PDFs inside the app";

        line.replaceChildren(install, why);
        line.classList.remove("hidden");
        return;
      }

      if (latest <= current) return;

      const bundle = assets.find((a) => /^ShelfScout-web.*\.zip$/i.test(a.name || ""));
      if (!bundle || !bundle.browser_download_url) return;

      const link = document.createElement("a");
      link.href = "#";
      link.textContent = `Update app files (v${latest})`;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        line.textContent = "Updating...";

        let reply = "";
        try {
          reply = bridge.installWebUpdate(bundle.browser_download_url, latest);
        } catch {
          reply = "";
        }

        if (reply === "ok") {
          line.textContent = "Updated - reloading...";
          // A fresh URL sidesteps the WebView's memory cache.
          setTimeout(() => {
            const next = new URL(location.href);
            next.searchParams.set("u", String(Date.now()));
            location.replace(next.toString());
          }, 300);
          return;
        }

        line.textContent = "";
        const note = document.createElement("span");
        note.textContent = "Update failed. Check your internet, then try again.";
        if (!canReadInApp) {
          const install = document.createElement("a");
          install.href = apkUrl;
          install.rel = "noopener";
          install.textContent = `Install app update (v${latest})`;
          line.appendChild(install);
        }
        line.appendChild(note);
        line.classList.remove("hidden");
      });

      const note = document.createElement("span");
      note.textContent = `You have v${current}`;

      line.replaceChildren(link, note);
      line.classList.remove("hidden");
    })
    .catch(() => {
      /* offline or rate limited: no banner is the right result */
    });
})();
