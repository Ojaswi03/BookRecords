"use strict";

/* Cover cache - keeps a small copy of every cover on this device.
 *
 * Covers point at Open Library or Google Books, so a phone with no internet
 * showed empty boxes. Each cover is fetched once, shrunk to 280px and stored
 * in IndexedDB (not localStorage, which caps out at 5 MB). Rendering then uses
 * the local copy. Uploaded covers are already data URLs and are skipped.
 */
window.CoverCache = (function () {
  const DB = "shelfscout-covers";
  const STORE = "covers";
  const LIMIT = 300;
  const mem = new Map();
  const failed = new Set();
  let opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("no IndexedDB"));
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "url" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opening;
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function readAll(db) {
    return new Promise((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function load() {
    try {
      for (const row of await readAll(await open())) mem.set(row.url, row.data);
    } catch {
      /* private mode: remote covers still work while online */
    }
  }

  function src(url) {
    if (!url) return "";
    return mem.get(url) || url;
  }

  // Keep the cache under the cap by dropping the oldest covers.
  async function trim(db) {
    try {
      const rows = await readAll(db);
      if (rows.length <= LIMIT) return;
      rows.sort((a, b) => a.at - b.at);
      const tx = db.transaction(STORE, "readwrite");
      for (const row of rows.slice(0, rows.length - LIMIT)) {
        mem.delete(row.url);
        tx.objectStore(STORE).delete(row.url);
      }
      await done(tx);
    } catch {
      /* the cap is housekeeping, never a reason to fail */
    }
  }

  async function put(url, data) {
    mem.set(url, data);
    try {
      const db = await open();
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ url, data, at: Date.now() });
      await done(tx);
      await trim(db);
    } catch {
      /* the in-memory copy still helps this session */
    }
  }

  function shrink(blob) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("bad image"));
      };
      img.onload = () => {
        try {
          const max = 280;
          const scale = Math.min(1, max / Math.max(img.width || 1, img.height || 1));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.78));
        } catch (err) {
          reject(err);
        } finally {
          URL.revokeObjectURL(objectUrl);
        }
      };
      img.src = objectUrl;
    });
  }

  // Delete one cover when its book is removed from the library.
  async function forget(url) {
    if (!url) return;
    mem.delete(url);
    try {
      const db = await open();
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(url);
      await done(tx);
    } catch {
      /* the in-memory entry is already gone */
    }
  }

  async function remember(url) {
    if (!url || String(url).startsWith("data:") || mem.has(url) || failed.has(url)) return;
    try {
      const res = await fetch(url, { mode: "cors", cache: "force-cache" });
      const type = res.headers.get("content-type") || "";
      if (!res.ok || type.indexOf("image") !== 0) {
        failed.add(url);
        return;
      }
      await put(url, await shrink(await res.blob()));
    } catch {
      // No CORS or no internet: keep the remote URL, do not retry every render.
      failed.add(url);
    }
  }

  async function warm(urls) {
    const list = [...new Set(urls)]
      .filter((u) => u && !String(u).startsWith("data:") && !mem.has(u) && !failed.has(u))
      .slice(0, 200);
    let next = 0;
    const worker = async () => {
      while (next < list.length) await remember(list[next++]);
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  return { load, src, remember, warm, forget };
})();
