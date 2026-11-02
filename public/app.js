"use strict";

const $ = (s) => document.querySelector(s);

// Used only when this APK is too old for the native reader.
const APK_URL = "https://github.com/Ojaswi03/BookRecords/releases/latest/download/ShelfScout.apk";

const state = {
  books: [],
  genres: [],
  mode: "genre",
  query: "",
  highlightId: null,
  banner: null, // { id, phase }
  ranks: new Map(),
  detailCover: null, // data URL of a cover uploaded in the detail editor
  detailEditing: false,
};

// State for the manual form's ISBN autofill.
const manual = { cover: "", lookedUp: "", timer: 0 };

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&#38;";
    if (c === "<") return "&#60;";
    if (c === ">") return "&#62;";
    if (c === '"') return "&#34;";
    return "'";
  });
}

// Identifies this tab, so live updates it triggered itself can be skipped.
const clientId = (window.crypto && crypto.randomUUID)
  ? crypto.randomUUID()
  : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

async function api(path, opts = {}) {
  // No server reachable: the whole library runs on this device.
  if (window.ShelfOffline && ShelfOffline.active) return ShelfOffline.handle(path, opts);

  const headers = { ...(opts.headers || {}), "X-Client-Id": clientId };
  let res;
  try {
    res = await fetch(path, { ...opts, headers });
  } catch (err) {
    // The server went away mid-session: keep working from the on-device books.
    if (window.ShelfOffline) {
      await ShelfOffline.init(true);
      return ShelfOffline.handle(path, opts);
    }
    throw err;
  }
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.message || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4500);
}

function lastName(name) {
  const n = String(name || "").trim();
  if (!n) return "unknown";
  if (n.includes(",")) return n.split(",")[0].trim().toLowerCase();
  const parts = n.split(/\s+/);
  let last = parts[parts.length - 1].replace(/\.$/, "");
  if (/^(jr|sr|ii|iii|iv)$/i.test(last) && parts.length > 1) last = parts[parts.length - 2].replace(/\.$/, "");
  return last.toLowerCase();
}

// A-Z key: author's last name, then title.
function sortKey(b) {
  return lastName((b.authors && b.authors[0]) || "") + "\u0000" + (b.title || "").toLowerCase();
}

function sortedAll() {
  return [...state.books].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

function normalizeGenre(g) {
  return state.genres.includes(g) ? g : "Other";
}

const STATUS_LABELS = {
  unread: "Unread",
  reading: "Reading",
  finished: "Finished",
  abandoned: "Abandoned",
};

function bookStatus(b) {
  return STATUS_LABELS[b.status] ? b.status : "";
}

function statusChip(b) {
  const status = bookStatus(b);
  return status ? `<span class="status-chip st-${status}">${STATUS_LABELS[status]}</span>` : "";
}

function stars(rating) {
  const n = Math.max(0, Math.min(5, Math.trunc(Number(rating) || 0)));
  return n ? `<span class="stars" title="${n} out of 5">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>` : "";
}

function bookTags(b) {
  return Array.isArray(b.tags) ? b.tags.map((t) => String(t).trim()).filter(Boolean) : [];
}

function tagChips(b, limit = 0) {
  const tags = limit > 0 ? bookTags(b).slice(0, limit) : bookTags(b);
  return tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join("");
}

function matches(b, q) {
  if (!q) return true;
  const hay = [
    b.title,
    (b.authors || []).join(" "),
    b.genre,
    b.isbn,
    b.loanedTo,
    (b.subjects || []).join(" "),
    b.notes,
    b.quotes,
    bookTags(b).join(" "),
    b.status ? STATUS_LABELS[b.status] || "" : "",
    b.rating ? `${b.rating} stars` : "",
  ]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

// Covers are cached on the device; fall back to the remote URL when not.
function coverSrc(url) {
  return window.CoverCache ? CoverCache.src(url) : (url || "");
}

function shortDate(value) {
  const d = new Date(value);
  return isNaN(d) ? String(value || "") : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

// <input type="date"> only accepts yyyy-mm-dd.
function dateValue(value) {
  const d = value ? new Date(value) : null;
  if (!d || isNaN(d)) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loanLine(b) {
  if (!b.loanedTo) return "";
  const due = b.dueAt ? ` · due ${esc(shortDate(b.dueAt))}` : "";
  return `<p class="loan-line">On loan to ${esc(b.loanedTo)}${due}</p>`;
}

// Absolute URL of the free copy, if this book has one. On-device mode can only
// open a remote link; a server path only works while the server is in use.
function pdfHref(b) {
  const local = String(b.pdf || "");
  const remote = String(b.pdfUrl || "");
  if (window.ShelfOffline && ShelfOffline.active) return /^https?:/i.test(remote) ? remote : "";
  if (local.startsWith("/")) return location.origin + local;
  if (/^https?:/i.test(local)) return local;
  return /^https?:/i.test(remote) ? remote : "";
}

function pdfStatus(b) {
  if (pdfHref(b)) return `Free copy from ${b.pdfSource || "the web"}.`;
  return b.pdfNote || "No free legal copy checked yet.";
}

// The native reader stores the last page. Older APKs have no bridge, so the
// progress simply stays hidden there.
function pdfProgress(b, url) {
  const bridge = window.ShelfApp;
  if (!url || !bridge || typeof bridge.readProgress !== "function") return null;
  try {
    const raw = bridge.readProgress(b.id, url);
    if (!raw) return null;
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    const page = Number(data && data.page);
    const pages = Number(data && data.pages);
    if (!Number.isFinite(page) || page < 1) return null;
    return { page, pages: Number.isFinite(pages) && pages > 0 ? pages : 0 };
  } catch {
    return null;
  }
}

// The in-app reader is native code: a web-file update cannot supply it.
function pdfNeedsAppUpdate() {
  return Boolean(window.ShelfApp) && typeof window.ShelfApp.openPdf !== "function";
}

function openPdfViewer(b, url) {
  $("#pdfTitle").textContent = b.title || "PDF";
  $("#pdfOpen").href = url;
  $("#pdfModal").classList.remove("hidden");
  $("#pdfFrame").src = url;
}

// Clearing the frame releases the PDF the browser was holding in memory.
function closePdfViewer() {
  const frame = $("#pdfFrame");
  if (frame) frame.src = "about:blank";
  const modal = $("#pdfModal");
  if (modal) modal.classList.add("hidden");
}

function readPDF(b) {
  const url = pdfHref(b);
  if (!url) return;
  const bridge = window.ShelfApp;
  if (bridge) {
    if (typeof bridge.openPdf === "function") {
      bridge.openPdf(url, b.id, b.title || "");
      return;
    }
    // Never hand the PDF to Chrome from inside the app.
    toast("Install the latest app once to read PDFs inside ShelfScout.", true);
    return;
  }
  openPdfViewer(b, url);
}

async function findPDF(id) {
  const note = $("#pdfStatus");
  if (note) note.textContent = "Looking for a free copy...";
  try {
    const data = await api(`/api/books/${id}/pdf`, { method: "POST" });
    state.books = (await api("/api/books")).books;
    render();
    openDetail(id);
    const book = data.book || state.books.find((b) => b.id === id) || {};
    const found = Boolean(pdfHref(book));
    toast(found ? "Free PDF added." : (book.pdfNote || "No free legal download found."), !found);
  } catch (err) {
    toast(err.message, true);
    openDetail(id);
  }
}

// The exact order books appear on screen, so placement advice matches the view.
function displayOrder(all) {
  if (state.mode !== "genre") return all;
  const groups = new Map(state.genres.map((g) => [g, []]));
  for (const b of all) {
    const key = normalizeGenre(b.genre);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const used = [...groups.entries()].filter(([, list]) => list.length);
  used.sort((a, b) => a[0].localeCompare(b[0]));
  return used.flatMap(([, list]) => list);
}

function labelOf(b) {
  const author = (b.authors && b.authors[0]) || "Unknown author";
  return `${author} - ${b.title}`;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function rowHTML(b) {
  const rank = state.ranks.get(b.id) ?? "";
  const author = (b.authors || []).join(", ");
  // Genre first: it's what the shelf is organised by, so it survives truncation
  // on narrow phone rows.
  const sub = [b.genre, b.year, b.isbn ? `ISBN ${b.isbn}` : ""].filter(Boolean).join(" · ");
  const cover = coverSrc(b.cover);
  const thumb = cover
    ? `<img src="${esc(cover)}" alt="" loading="lazy" onerror="this.remove()">`
    : "📖";
  const badges = [statusChip(b), stars(b.rating), tagChips(b, 3)].filter(Boolean).join("");
  return `<article class="row" data-id="${b.id}">
    <div class="idx">${rank}</div>
    <div class="thumb">${thumb}</div>
    <div class="meta">
      <h3>${esc(b.title)}${(b.count || 1) > 1 ? ` <span class="count-badge">×${b.count}</span>` : ""}${pdfHref(b) ? ' <span class="pdf-badge">PDF</span>' : ""}</h3>
      <p class="author">${esc(author)}</p>
      <p class="sub">${esc(sub)}</p>
      ${badges ? `<p class="row-badges">${badges}</p>` : ""}
      ${loanLine(b)}
    </div>
    <button class="del" data-del="${b.id}" aria-label="Remove ${esc(b.title)}" title="Remove">×</button>
  </article>`;
}

function sectionHTML(title, books) {
  return `<div class="section-head"><h2>${esc(title)}</h2><span>${books.length} book${books.length === 1 ? "" : "s"}</span></div>`
    + books.map(rowHTML).join("");
}

function render() {
  const all = sortedAll();
  state.ranks = new Map(all.map((b, i) => [b.id, i + 1]));
  const list = all.filter((b) => matches(b, state.query));

  const genreCount = new Set(all.map((b) => normalizeGenre(b.genre))).size;
  $("#stats").textContent = `${state.books.length} book${state.books.length === 1 ? "" : "s"}`
    + (state.books.length ? ` · ${genreCount} genre${genreCount === 1 ? "" : "s"}` : "");

  const lib = $("#library");
  if (!list.length) {
    lib.innerHTML = state.books.length
      ? `<div class="empty"><h2>No matches</h2><p>Nothing on the shelf matches "${esc(state.query)}".</p></div>`
      : `<div class="empty"><h2>Your shelf is empty</h2>
           <p>Tap <strong>Scan barcode</strong> and point your camera at the barcode on the back of a book.<br>
           ShelfScout looks it up online, shows the cover, and tells you exactly where it goes.</p></div>`;
    renderBanner();
    return;
  }

  let html = "";
  if (state.mode === "genre") {
    const groups = new Map();
    for (const b of list) {
      const g = normalizeGenre(b.genre);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(b);
    }
    for (const g of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
      html += sectionHTML(g, groups.get(g));
    }
  } else {
    html += sectionHTML("A-Z by author", list);
  }

  lib.innerHTML = html;
  applyHighlight();
  renderBanner();
}

let highlightTimer;
function applyHighlight() {
  if (!state.highlightId) return;
  const el = document.querySelector(`.row[data-id="${state.highlightId}"]`);
  if (!el) return;
  el.classList.add("flash");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const id = state.highlightId;
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => {
    const node = document.querySelector(`.row[data-id="${id}"]`);
    if (node) node.classList.remove("flash");
    if (state.highlightId === id) state.highlightId = null;
  }, 6000);
}

/* ------------------------------------------------------------------ *
 * Placement banner: above / below / where in the stack
 * ------------------------------------------------------------------ */

/* Pill text for each post-scan state of the banner. */
function pillText(phase, count) {
  switch (phase) {
    case "confirm": return `Already on your shelf · ${count} cop${count === 1 ? "y" : "ies"}`;
    case "addedCopy": return `Right - you now have ${count} copies`;
    case "ignored": return `Rescan ignored · count stays at ${count}`;
    default: return "Found online · added";
  }
}

function renderBanner() {
  const wrap = $("#banner");
  const b = state.banner ? state.books.find((x) => x.id === state.banner.id) : null;
  if (!b) {
    wrap.classList.add("hidden");
    wrap.innerHTML = "";
    return;
  }

  const all = sortedAll();
  const order = displayOrder(all);
  const idx = order.findIndex((x) => x.id === b.id);
  const above = idx > 0 ? order[idx - 1] : null;
  const below = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;

  const genre = normalizeGenre(b.genre);
  const sectionBooks = all.filter((x) => normalizeGenre(x.genre) === genre);
  const secIdx = sectionBooks.findIndex((x) => x.id === b.id) + 1;
  const rank = state.ranks.get(b.id);
  const phase = state.banner.phase || "added";
  const count = b.count || 1;

  const where = state.mode === "genre"
    ? `${esc(genre)} section · A-Z inside`
    : "Flat A-Z list";

  wrap.innerHTML = `<div class="banner-card">
    <button class="icon-btn" data-banner-close aria-label="Close">×</button>
    <div class="banner-top">
      ${b.cover
        ? `<img class="cover" src="${esc(coverSrc(b.cover))}" alt="Cover of ${esc(b.title)}" onerror="this.remove()">`
        : `<div class="cover"></div>`}
      <div>
        <span class="pill ${phase === "added" || phase === "addedCopy" ? "ok" : "warn"}">${esc(pillText(phase, count))}</span>
        <h2>${esc(b.title)}</h2>
        <p>${esc((b.authors || []).join(", "))}<span class="chip">${esc(genre)}</span>${count > 1 ? `<span class="chip copy">×${count} copies</span>` : ""}</p>
      </div>
    </div>

    <div class="placement">
      <div class="place-label">${where}</div>
      <div class="stack">
        <div class="nb">${above ? `▲ Put it <strong>under</strong> ${esc(labelOf(above))}` : "▲ Top of this section"}</div>
        <div class="me">
          <span class="marker">▼ THIS BOOK GOES HERE</span>
          <span class="pos">slot ${secIdx} of ${sectionBooks.length} in ${esc(genre)} · #${rank} of ${state.books.length} overall</span>
        </div>
        <div class="nb">${below ? `▼ Put it <strong>above</strong> ${esc(labelOf(below))}` : "▼ Bottom of this section"}</div>
      </div>
    </div>

    ${phase === "confirm" ? `
    <div class="confirm-box">
      <p><strong>Is that right?</strong> You already have ${count === 1 ? "this book" : `×${count} of this book`} on the shelf. Tap <strong>Yes</strong> only if you really own another copy - otherwise you rescanned it by mistake.</p>
      <div class="banner-actions">
        <button class="btn primary" data-add-copy>Yes - I have another copy</button>
        <button class="btn ghost" data-not-copy>No - rescanned by mistake</button>
      </div>
    </div>` : `
    ${phase === "addedCopy" ? `<p class="outcome ok">✓ Count increased to ${count} - the extra copy sits with the rest of this title.</p>` : ""}
    ${phase === "ignored" ? `<p class="outcome">✓ Nothing changed - count left at ${count}.</p>` : ""}
    <div class="banner-actions">
      <button class="btn primary" data-scan-again>Scan next book</button>
      <button class="btn ghost" data-banner-close>Done</button>
    </div>`}
  </div>`;
  wrap.classList.remove("hidden");
}

/* ------------------------------------------------------------------ *
 * Barcode scanning
 * ------------------------------------------------------------------ */

const scan = { active: false, stream: null, reader: null, timer: null, detector: null, busy: false, lastCode: "", lastAt: 0, added: 0, lastId: null };

function multiScanOn() {
  const box = $("#multiScan");
  return Boolean(box && box.checked);
}

function multiPref() {
  try { return localStorage.getItem("shelfscout.multiscan") === "1"; } catch { return false; }
}

function saveMultiPref(on) {
  try { localStorage.setItem("shelfscout.multiscan", on ? "1" : "0"); } catch { /* private mode */ }
}

function scanError(msg) {
  const el = $("#scanError");
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function openScanner() {
  scan.added = 0;
  scan.lastId = null;
  $("#scanModal").classList.remove("hidden");
  $("#scanError").classList.add("hidden");
  $("#scanHint").textContent = "Hold the barcode on the back of the book inside the frame.";
  const multiBox = $("#multiScan");
  if (multiBox) multiBox.checked = multiPref();
  const multiCount = $("#multiCount");
  if (multiCount) {
    multiCount.textContent = "";
    multiCount.classList.add("hidden");
  }
  const video = $("#video");

  if ("BarcodeDetector" in window && !scan.detector) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39"].filter((f) => supported.includes(f));
      if (formats.length) scan.detector = new window.BarcodeDetector({ formats });
    } catch {
      scan.detector = null;
    }
  }

  try {
    scan.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
    video.srcObject = scan.stream;
    await video.play();
    scan.active = true;

    if (scan.detector) {
      scan.timer = setInterval(async () => {
        if (!scan.active || scan.busy) return;
        try {
          const codes = await scan.detector.detect(video);
          if (codes && codes.length) onCode(codes[0].rawValue);
        } catch { /* frame not ready yet */ }
      }, 350);
    } else if (window.ZXing) {
      scan.reader = new window.ZXing.BrowserMultiFormatReader();
      scan.reader.decodeFromConstraints(
        { video: { facingMode: { ideal: "environment" } } },
        video,
        (result) => { if (result && scan.active) onCode(result.getText()); }
      );
    } else {
      scanError("This browser can't decode barcodes - type the ISBN below instead.");
    }
  } catch (err) {
    scanError(err && err.name === "NotAllowedError"
      ? "Camera permission was blocked. Allow camera access for this site, or type the ISBN below."
      : "Camera unavailable - type the ISBN below instead.");
  }
}

function closeScanner(finalize = true) {
  scan.active = false;
  if (scan.timer) { clearInterval(scan.timer); scan.timer = null; }
  if (scan.reader) { try { scan.reader.reset(); } catch { /* ignore */ } scan.reader = null; }
  if (scan.stream) { scan.stream.getTracks().forEach((t) => t.stop()); scan.stream = null; }
  const v = $("#video");
  if (v) v.srcObject = null;
  $("#scanModal").classList.add("hidden");
  if (finalize) finishMultiScan();
}

async function finishMultiScan() {
  const id = scan.lastId;
  const count = scan.added;
  scan.added = 0;
  scan.lastId = null;
  if (!id) return;
  try {
    await reload(id, "added");
    if (count > 1) toast(`Added ${count} books. The last one is highlighted.`);
  } catch {
    /* the shelf catches up on the next load */
  }
}

function onCode(raw) {
  if (scan.busy) return;
  const now = Date.now();
  if (raw === scan.lastCode && now - scan.lastAt < 3000) return;
  scan.lastCode = raw;
  scan.lastAt = now;
  submitISBN(raw);
}

async function submitISBN(raw) {
  if (scan.busy) return;
  scan.busy = true;
  let keptScanning = false;
  $("#scanHint").textContent = "Looking that book up online...";
  try {
    const data = await api("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isbn: raw }),
    });

    if (multiScanOn() && !data.existed) {
      keptScanning = true;
      scan.added += 1;
      scan.lastId = data.book.id;
      state.books = (await api("/api/books")).books;
      state.highlightId = null;
      state.banner = null;
      render();
      const count = $("#multiCount");
      if (count) {
        count.textContent = `${scan.added} book${scan.added === 1 ? "" : "s"} added. Keep scanning, or close when done.`;
        count.classList.remove("hidden");
      }
      $("#scanHint").textContent = `Added "${data.book.title}". Point at the next barcode.`;
      if (window.CoverCache) CoverCache.warm(state.books.map((b) => b.cover));
      return;
    }

    if (multiScanOn() && data.existed) {
      const already = scan.added;
      closeScanner(false);
      scan.added = 0;
      scan.lastId = null;
      await reload(data.book.id, "confirm");
      if (already) toast(`${already} book${already === 1 ? "" : "s"} added before this duplicate.`);
      return;
    }

    closeScanner(false);
    await reload(data.book.id, data.existed ? "confirm" : "added");
  } catch (err) {
    if (err.status === 404) {
      closeScanner(true);
      openManual({ isbn: String(raw).replace(/\D/g, "") });
      toast("No online record for that barcode - add the details yourself.");
    } else if (err.status === 400) {
      scanError(err.message);
    } else {
      scanError(err.message || "Lookup failed. Try again.");
    }
  } finally {
    scan.busy = false;
    if (!keptScanning) {
      const hint = $("#scanHint");
      if (hint) hint.textContent = "Hold the barcode on the back of the book inside the frame.";
    }
  }
}

async function reload(highlightId, phase) {
  const data = await api("/api/books");
  state.books = data.books;
  state.highlightId = highlightId;
  state.banner = { id: highlightId, phase: phase || "added" };
  render();
  if (window.CoverCache) CoverCache.warm(state.books.map((b) => b.cover));
}

/* ------------------------------------------------------------------ *
 * Live sync - a scan on the phone redraws the shelf on the desktop
 * ------------------------------------------------------------------ */

function setLive(on, label) {
  const badge = $("#liveBadge");
  if (!badge) return;
  badge.classList.toggle("on", on);
  badge.classList.toggle("off", !on);
  badge.textContent = label || (on ? "Live" : "Offline");
}

async function refreshFromServer() {
  const data = await api("/api/books");
  state.books = data.books || [];
  if (state.detailId && !state.books.some((b) => b.id === state.detailId)) closeDetail();
  if (state.banner && !state.books.some((b) => b.id === state.banner.id)) state.banner = null;
  render();
}

function initLive() {
  // With no server there is nothing to stream: the shelf is this device only.
  if (window.ShelfOffline && ShelfOffline.active) {
    setLive(false, "On this device");
    return;
  }
  if (!("EventSource" in window)) return;
  const stream = new EventSource(`/api/events?client=${encodeURIComponent(clientId)}`);

  stream.addEventListener("open", () => setLive(true));
  stream.addEventListener("error", () => setLive(false)); // EventSource retries on its own

  stream.addEventListener("library", async (e) => {
    let data = {};
    try { data = JSON.parse(e.data); } catch { /* ignore malformed frame */ }
    if (data.origin === clientId) return; // this device already applied the change
    try {
      await refreshFromServer();
      if (data.reason === "added") toast(`"${data.book ? data.book.title : "A book"}" scanned on another device - shelf updated.`);
      else if (data.reason === "removed") toast("A book was removed on another device.");
      else toast("Library updated from another device.");
    } catch { /* the stream reconnects and the next event retries */ }
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  // The bundled phone app already has its files on the device.
  if (location.host === "appassets.androidplatform.net") return;
  // updateViaCache: "none" keeps the browser from serving an old sw.js from HTTP
  // cache, so an updated app shell replaces the cached one on the next load.
  navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => { /* the offline shell is a bonus, not a requirement */ });
}

/* ------------------------------------------------------------------ *
 * Manual entry
 * ------------------------------------------------------------------ */

function setLookupHint(text) {
  const hint = $("#mLookupHint");
  if (!hint) return;
  hint.textContent = text || "";
  hint.classList.toggle("hidden", !text);
}

function setManualPreview(book) {
  const box = $("#mPreview");
  if (!box) return;
  if (!book) {
    box.classList.add("hidden");
    return;
  }
  const img = $("#mCover");
  if (img) {
    if (book.cover) {
      img.src = coverSrc(book.cover);
      img.classList.remove("hidden");
    } else {
      img.removeAttribute("src");
      img.classList.add("hidden");
    }
  }
  $("#mPreviewTitle").textContent = book.title || "";
  const meta = [(book.authors || []).join(", "), book.genre, book.year].filter(Boolean).join(" · ");
  $("#mPreviewMeta").textContent = meta;
  box.classList.remove("hidden");
}

// A typed or scanned ISBN fills the form before the user submits it.
async function lookupForManual(raw) {
  const isbn = String(raw || "").replace(/[^0-9Xx]/g, "");
  if (!isbn) {
    manual.cover = "";
    setLookupHint("");
    setManualPreview(null);
    return;
  }
  if (isbn.length !== 10 && isbn.length !== 13) {
    manual.cover = "";
    setLookupHint("An ISBN is 10 or 13 digits.");
    setManualPreview(null);
    return;
  }
  if (isbn === manual.lookedUp) return;
  manual.lookedUp = isbn;
  setLookupHint("Looking this ISBN up...");

  try {
    const data = await api(`/api/lookup?isbn=${encodeURIComponent(isbn)}`);
    const rec = data.record || {};
    if (!$("#mTitle").value.trim()) $("#mTitle").value = rec.title || "";
    if (!$("#mAuthor").value.trim()) $("#mAuthor").value = (rec.authors || []).join(", ");
    const genre = data.genre || rec.genre || "";
    if (genre && !$("#mGenre").value) $("#mGenre").value = genre;
    manual.cover = rec.cover || "";
    setManualPreview({ ...rec, genre });
    setLookupHint(`Found on ${rec.source || "the web"}. Change anything that is wrong.`);
  } catch (err) {
    manual.cover = "";
    setManualPreview(null);
    setLookupHint(
      err.status === 404
        ? "No record found for that ISBN. Fill in the details yourself."
        : err.message || "Lookup failed. You can still add the book."
    );
  }
}

// Genre pickers: a fixed list plus a free-text option for a brand new genre.
function wireGenrePicker(selectId, inputId) {
  const sel = $(`#${selectId}`);
  const inp = $(`#${inputId}`);
  if (!sel || !inp) return;
  sel.addEventListener("change", () => {
    const isNew = sel.value === "__new";
    inp.classList.toggle("hidden", !isNew);
    if (isNew) inp.focus();
  });
}

function genreValue(selectId, inputId) {
  const sel = $(`#${selectId}`);
  if (!sel) return "";
  if (sel.value !== "__new") return sel.value;
  const inp = $(`#${inputId}`);
  return inp ? inp.value.trim().slice(0, 60) : "";
}

async function refreshGenres() {
  try {
    const data = await api("/api/genres");
    if (!data || !Array.isArray(data.genres) || !data.genres.length) return;
    state.genres = data.genres;
    const m = $("#mGenre");
    if (!m) return;
    const current = m.value;
    m.innerHTML = `<option value="">Detect from the book</option>`
      + state.genres.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("")
      + `<option value="__new">+ Add a new genre</option>`;
    if ([...m.options].some((o) => o.value === current)) m.value = current;
  } catch {
    /* keep the list we already have */
  }
}

function openManual(prefill = {}) {
  $("#manualModal").classList.remove("hidden");
  $("#mIsbn").value = prefill.isbn || "";
  $("#mTitle").value = prefill.title || "";
  $("#mAuthor").value = prefill.author || "";
  $("#mGenre").value = "";
  manual.cover = "";
  manual.lookedUp = "";
  setLookupHint("");
  setManualPreview(null);
  if (prefill.isbn) {
    $("#mTitle").focus();
    lookupForManual(prefill.isbn);
  }
}

// Downscale an uploaded image so it fits in the library file.
function toCoverDataURL(file, max = 480) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("not an image"));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ *
 * Backup and restore
 * ------------------------------------------------------------------ */

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function booksToJSON() {
  return JSON.stringify({ app: "ShelfScout", version: 1, exportedAt: new Date().toISOString(), books: state.books }, null, 2);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Spreadsheet copy. Uploaded covers are data URLs and would make the file huge,
// so they are described here - the JSON backup keeps them.
function booksToCSV() {
  const head = ["Title", "Author(s)", "Genre", "ISBN", "Year", "Publisher", "Pages", "Copies", "Status", "Rating (0-5)", "Tags", "Notes", "Quotes", "Loaned to", "Loaned on", "Due back", "Subjects", "Cover", "Source", "Added"];
  const rows = state.books.map((b) => [
    b.title,
    (b.authors || []).join(", "),
    b.genre,
    b.isbn,
    b.year,
    b.publisher,
    b.pages || "",
    b.count || 1,
    STATUS_LABELS[b.status] || "",
    Number(b.rating) || "",
    bookTags(b).join(", "),
    b.notes || "",
    b.quotes || "",
    b.loanedTo || "",
    String(b.loanedAt || "").slice(0, 10),
    String(b.dueAt || "").slice(0, 10),
    (b.subjects || []).join(", "),
    String(b.cover || "").startsWith("data:") ? "uploaded image" : b.cover || "",
    b.source || "",
    String(b.addedAt || "").slice(0, 10),
  ]);
  return [head, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

// The Android app exposes a bridge that writes into Downloads; browsers and the
// desktop app use a normal download.
function saveFile(name, text, mime) {
  const bridge = window.ShelfApp;
  if (bridge && typeof bridge.saveFile === "function") {
    const where = bridge.saveFile(name, text);
    if (where) {
      toast(`Saved to ${where}`);
      return;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Saved ${name}`);
}

let pendingImport = [];

function openData() {
  pendingImport = [];
  $("#importFile").value = "";
  $("#importHint").textContent = "";
  $("#importBtn").disabled = true;
  const n = state.books.length;
  $("#dataMeta").textContent = `${n} book${n === 1 ? "" : "s"} in this library · covers are included in the JSON file`;
  $("#dataModal").classList.remove("hidden");
}

async function readImportFile(file) {
  const hint = $("#importHint");
  pendingImport = [];
  $("#importBtn").disabled = true;
  try {
    const parsed = JSON.parse(await file.text());
    const list = Array.isArray(parsed) ? parsed : parsed.books;
    if (!Array.isArray(list)) throw new Error("no books");
    pendingImport = list.filter((b) => b && String(b.title || "").trim());
    if (!pendingImport.length) throw new Error("no books");
    hint.textContent = `${pendingImport.length} book${pendingImport.length === 1 ? "" : "s"} found. Books already on the shelf are skipped.`;
    $("#importBtn").disabled = false;
  } catch {
    hint.textContent = "That file is not a ShelfScout JSON backup.";
  }
}

async function runImport() {
  if (!pendingImport.length) return;
  const btn = $("#importBtn");
  btn.disabled = true;
  try {
    const data = await api("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ books: pendingImport }),
    });
    state.books = (await api("/api/books")).books;
    await refreshGenres();
    render();
    if (window.CoverCache) CoverCache.warm(state.books.map((b) => b.cover));
    $("#importHint").textContent = `Added ${data.added} book${data.added === 1 ? "" : "s"}`
      + (data.skipped ? `, skipped ${data.skipped} already on the shelf` : "") + ".";
    pendingImport = [];
    $("#importFile").value = "";
    toast(`Restored ${data.added} book${data.added === 1 ? "" : "s"}.`);
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * QR code for phone access
 * ------------------------------------------------------------------ */

function initQR(urls) {
  // The APK button does not depend on the QR code. On a phone the QR image is
  // pointless, but the download button is the whole reason this panel exists -
  // so reveal it even if the QR library or a phone URL is unavailable.
  const apk = $("#apkLink");
  const hasApk = Boolean(apk && urls && urls.apk);
  if (hasApk) {
    apk.href = urls.apk;
    apk.classList.remove("hidden");
  }

  const url = urls && urls.phones && urls.phones[0];
  if (url) {
    const link = $("#qrLink");
    if (link) link.textContent = url;
    const note = $("#qrNote");
    if (note) {
      note.textContent = urls.permanent
        ? "Permanent link - stays the same after every restart."
        : "Temporary link - it changes when the server restarts. Run `npm run link` to make it permanent.";
    }
  }

  try {
    if (url && window.qrcode) {
      const qr = window.qrcode(0, "M");
      qr.addData(url);
      qr.make();
      let svg;
      try { svg = qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true }); }
      catch { svg = qr.createSvgTag(4, 3); }
      $("#qrCode").innerHTML = svg;
    } else {
      const box = $(".qr-img");
      if (box) box.classList.add("hidden");
    }
  } catch {
    /* QR is a convenience; the printed link still works */
  }

  const panel = $("#qrPanel");
  if (panel && (url || hasApk)) panel.classList.remove("hidden");
}

/* ------------------------------------------------------------------ *
 * Book detail / edit
 * ------------------------------------------------------------------ */

// The screen a tapped book opens: cover first, then reading or editing.
function renderBookView(b) {
  const all = sortedAll();
  const order = displayOrder(all);
  const idx = order.findIndex((x) => x.id === b.id);
  const above = idx > 0 ? order[idx - 1] : null;
  const below = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  const rank = state.ranks.get(b.id);
  const genre = normalizeGenre(b.genre);
  const sectionBooks = all.filter((x) => normalizeGenre(x.genre) === genre);
  const secIdx = sectionBooks.findIndex((x) => x.id === b.id) + 1;
  const cover = coverSrc(b.cover);
  const pdf = pdfHref(b);
  const progress = pdf ? pdfProgress(b, pdf) : null;
  const pct = progress && progress.pages
    ? Math.min(100, Math.max(0, Math.round((progress.page / progress.pages) * 100)))
    : 0;

  $("#detailBody").innerHTML = `
    <div class="book-view">
      <div class="book-hero">
        <div class="book-cover-wrap">
          <img class="book-cover${cover ? "" : " hidden"}" alt="Cover of ${esc(b.title)}"
               ${cover ? `src="${esc(cover)}"` : ""} onerror="this.classList.add('hidden')">
          <div class="book-cover placeholder${cover ? " hidden" : ""}">📖</div>
        </div>
        <div class="book-info">
          <h2 class="book-title">${esc(b.title)}</h2>
          <p class="book-author">${esc((b.authors || []).join(", ") || "Unknown author")}</p>
          <p class="chips">
            <span class="chip">${esc(genre)}</span>
            ${b.year ? `<span class="chip">${esc(b.year)}</span>` : ""}
            ${(b.count || 1) > 1 ? `<span class="chip copy">×${b.count} copies</span>` : ""}
          </p>
          ${(statusChip(b) || stars(b.rating) || bookTags(b).length)
            ? `<p class="book-badges">${statusChip(b)}${stars(b.rating)}${tagChips(b)}</p>`
            : ""}
          <p class="sub">#${rank} of ${state.books.length} · slot ${secIdx} of ${sectionBooks.length} in ${esc(genre)}</p>
          <p class="sub">${above ? `▲ Put it under ${esc(labelOf(above))}` : "▲ Top of this section"}</p>
          <p class="sub">${below ? `▼ Put it above ${esc(labelOf(below))}` : "▼ Bottom of this section"}</p>
          ${b.loanedTo ? `<p class="loan-line">On loan to ${esc(b.loanedTo)}${b.dueAt ? ` · due ${esc(shortDate(b.dueAt))}` : ""}</p>` : ""}
        </div>
      </div>

      <p class="pdf-status" id="pdfStatus">${esc(pdfStatus(b))}${progress ? ` <span class="pdf-progress">Saved on page ${progress.page}${progress.pages ? ` of ${progress.pages}` : ""}.</span>` : ""}</p>
      ${progress ? `<div class="read-progress" aria-label="Reading progress">
        <span class="read-track"><span style="width:${pct}%"></span></span>
        <span class="read-label">Page ${progress.page}${progress.pages ? ` of ${progress.pages}` : ""}${pct ? ` · ${pct}% read` : ""}</span>
      </div>` : ""}
      ${pdf && pdfNeedsAppUpdate() ? `<p class="pdf-warn">This app build opens PDFs in Chrome. <a href="${APK_URL}" target="_blank" rel="noopener">Install the latest app once</a> to read them inside ShelfScout.</p>` : ""}
      ${pdf ? "" : `<p class="pdf-find"><button class="link-btn" type="button" data-find-pdf="${b.id}">Find a free PDF</button></p>`}

      <div class="banner-actions">
        ${pdf ? `<button class="btn primary" data-read="${b.id}">${progress ? "Continue reading" : "Read PDF"}</button>` : ""}
        <button class="btn ${pdf ? "ghost" : "primary"}" data-edit="${b.id}">Edit info</button>
      </div>

      ${b.notes ? `<section class="book-note"><h3>Notes</h3><p>${esc(b.notes)}</p></section>` : ""}
      ${b.quotes ? `<section class="book-note"><h3>Quotes</h3><p>${esc(b.quotes)}</p></section>` : ""}
    </div>`;

  $("#detailModal").classList.remove("hidden");
}

function openDetail(id, edit = false) {
  const b = state.books.find((x) => x.id === id);
  if (!b) return;
  state.detailId = id;
  state.detailCover = null;
  state.detailEditing = Boolean(edit);

  if (!edit) {
    renderBookView(b);
    return;
  }

  const all = sortedAll();
  const order = displayOrder(all);
  const idx = order.findIndex((x) => x.id === id);
  const above = idx > 0 ? order[idx - 1] : null;
  const below = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
  const rank = state.ranks.get(id);
  const genre = normalizeGenre(b.genre);
  const sectionBooks = all.filter((x) => normalizeGenre(x.genre) === genre);
  const secIdx = sectionBooks.findIndex((x) => x.id === id) + 1;

  $("#detailBody").innerHTML = `
    <div class="detail-top">
      <div class="detail-cover-wrap" id="coverPick" role="button" tabindex="0" title="Click to change the cover">
        <img class="detail-cover${b.cover ? "" : " hidden"}" id="detailCoverImg" alt="Cover of ${esc(b.title)}"
             ${b.cover ? `src="${esc(coverSrc(b.cover))}"` : ""} onerror="this.classList.add('hidden')">
        <div class="detail-cover${b.cover ? " hidden" : ""}" id="coverEmpty">📖</div>
        <span class="cover-edit">Change cover</span>
      </div>
      <div class="detail-pos">
        <p class="place-label">Shelf position</p>
        <p><strong>#${rank}</strong> of ${state.books.length} overall</p>
        <p>${esc(genre)} section · slot <strong>${secIdx}</strong> of ${sectionBooks.length}</p>
        <p>${above ? `▲ Put it under ${esc(labelOf(above))}` : "▲ Top of this section"}</p>
        <p>${below ? `▼ Put it above ${esc(labelOf(below))}` : "▼ Bottom of this section"}</p>
      </div>
    </div>

    <form class="form" id="detailForm">
      <label>Title <input id="dTitle" value="${esc(b.title)}" required></label>
      <label>Author(s) <input id="dAuthor" value="${esc((b.authors || []).join(", "))}"></label>
      <label>Genre
        <select id="dGenre">${state.genres
          .map((g) => `<option value="${esc(g)}"${g === genre ? " selected" : ""}>${esc(g)}</option>`)
          .join("")}<option value="__new">+ Add a new genre</option></select>
        <input id="dGenreNew" class="hidden" placeholder="Type the new genre" maxlength="60">
      </label>
      <div class="grid2">
        <label>ISBN <input id="dIsbn" inputmode="numeric" value="${esc(b.isbn || "")}"></label>
        <label>Year <input id="dYear" value="${esc(b.year || "")}"></label>
        <label>Publisher <input id="dPublisher" value="${esc(b.publisher || "")}"></label>
        <label>Pages <input id="dPages" inputmode="numeric" value="${b.pages ?? ""}"></label>
        <label>Copies <input id="dCount" inputmode="numeric" min="1" value="${b.count || 1}"></label>
      </div>
      <fieldset class="reading-fieldset">
        <legend>Reading</legend>
        <div class="grid2">
          <label>Status
            <select id="dStatus">
              <option value="">Not set</option>
              ${Object.entries(STATUS_LABELS).map(([key, label]) => `<option value="${key}"${bookStatus(b) === key ? " selected" : ""}>${label}</option>`).join("")}
            </select>
          </label>
          <label>Rating
            <select id="dRating">
              <option value="0"${Number(b.rating) ? "" : " selected"}>No rating</option>
              ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}"${Number(b.rating) === n ? " selected" : ""}>${"★".repeat(n)} (${n})</option>`).join("")}
            </select>
          </label>
        </div>
        <label>Tags <input id="dTags" value="${esc(bookTags(b).join(", "))}" placeholder="signed, reference, to read next"></label>
        <label>Notes <textarea id="dNotes" rows="3" maxlength="5000" placeholder="What you thought, where it came from...">${esc(b.notes || "")}</textarea></label>
        <label>Quotes <textarea id="dQuotes" rows="3" maxlength="5000" placeholder="Lines worth keeping">${esc(b.quotes || "")}</textarea></label>
      </fieldset>
      <fieldset class="loan-fieldset">
        <legend>On loan</legend>
        <div class="grid2">
          <label>Lent to <input id="dLoanedTo" value="${esc(b.loanedTo || "")}" placeholder="Name"></label>
          <label>Due back <input id="dDueAt" type="date" value="${dateValue(b.dueAt)}"></label>
        </div>
        <label>Lent on <input id="dLoanedAt" type="date" value="${dateValue(b.loanedAt)}"></label>
        <p class="hint">Leave "Lent to" empty to mark the book as back on the shelf.</p>
        ${b.loanedTo ? `<div class="banner-actions"><button class="btn ghost" type="button" data-return="${b.id}">Mark returned</button></div>` : ""}
      </fieldset>
      <label>Cover image URL
        <input id="dCover" value="${b.cover && !String(b.cover).startsWith("data:") ? esc(b.cover) : ""}"
               placeholder="${b.cover && String(b.cover).startsWith("data:") ? "Using the uploaded image" : "https://example.com/cover.jpg"}">
      </label>
      <input type="file" id="coverFile" accept="image/*" class="hidden">
      <label>Subjects / topics <input id="dSubjects" value="${esc((b.subjects || []).join(", "))}"></label>
      <p class="detail-meta">Source: ${esc(b.source || "-")} · Added ${esc(String(b.addedAt || "").slice(0, 10))}</p>
      <div class="banner-actions">
        <button class="btn primary" type="submit">Save changes</button>
        <button class="btn ghost" type="button" data-back="${b.id}">Back</button>
      </div>
    </form>`;

  wireGenrePicker("dGenre", "dGenreNew");

  $("#detailModal").classList.remove("hidden");

  // Click the cover to upload a different image.
  const picker = $("#coverPick");
  const fileInput = $("#coverFile");
  if (picker && fileInput) {
    picker.addEventListener("click", () => fileInput.click());
    picker.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
      }
    });
    fileInput.addEventListener("change", async () => {
      const chosen = fileInput.files && fileInput.files[0];
      if (!chosen) return;
      try {
        const dataUrl = await toCoverDataURL(chosen);
        state.detailCover = dataUrl;
        const img = $("#detailCoverImg");
        if (img) {
          img.src = dataUrl;
          img.classList.remove("hidden");
        }
        const empty = $("#coverEmpty");
        if (empty) empty.classList.add("hidden");
        const url = $("#dCover");
        if (url) {
          url.value = "";
          url.placeholder = "Using the uploaded image";
        }
        toast("Cover updated. Tap Save changes to keep it.");
      } catch {
        toast("That image could not be read.", true);
      }
    });
  }

  const coverField = $("#dCover");
  if (coverField) coverField.addEventListener("input", () => { state.detailCover = null; });
}

$("#detailBody").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = state.detailId;
  if (!id) return;
  const current = state.books.find((b) => b.id === id) || {};
  try {
    await api(`/api/books/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: $("#dTitle").value,
        author: $("#dAuthor").value,
        genre: genreValue("dGenre", "dGenreNew") || current.genre || "",
        isbn: $("#dIsbn").value,
        year: $("#dYear").value,
        publisher: $("#dPublisher").value,
        pages: $("#dPages").value,
        count: $("#dCount").value,
        cover: state.detailCover || $("#dCover").value,
        subjects: $("#dSubjects").value.split(",").map((s) => s.trim()).filter(Boolean),
        status: $("#dStatus").value,
        rating: $("#dRating").value,
        tags: $("#dTags").value.split(",").map((s) => s.trim()).filter(Boolean),
        notes: $("#dNotes").value,
        quotes: $("#dQuotes").value,
        loanedTo: $("#dLoanedTo").value,
        loanedAt: $("#dLoanedAt").value,
        dueAt: $("#dDueAt").value,
      }),
    });
    state.books = (await api("/api/books")).books;
    await refreshGenres();
    render();
    openDetail(id);
    toast("Saved - shelf position recalculated.");
  } catch (err) {
    toast(err.message, true);
  }
});

function closeDetail() {
  state.detailId = null;
  state.detailEditing = false;
  $("#detailModal").classList.add("hidden");
}

// Coming back from the native reader? Refresh the visible book so its saved
// page and progress bar are current. Never redraw an edit form in progress.
function refreshOpenBook() {
  if (document.hidden || !state.detailId || state.detailEditing) return;
  const modal = $("#detailModal");
  if (modal && !modal.classList.contains("hidden")) openDetail(state.detailId);
}

window.addEventListener("focus", refreshOpenBook);
document.addEventListener("visibilitychange", refreshOpenBook);

$("#detailClose").addEventListener("click", closeDetail);
$("#detailBody").addEventListener("click", async (e) => {
  if (e.target.closest("[data-detail-close]")) {
    closeDetail();
    return;
  }

  const edit = e.target.closest("[data-edit]");
  if (edit) {
    openDetail(edit.getAttribute("data-edit"), true);
    return;
  }

  const read = e.target.closest("[data-read]");
  if (read) {
    const book = state.books.find((x) => x.id === read.getAttribute("data-read"));
    if (book) readPDF(book);
    return;
  }

  const find = e.target.closest("[data-find-pdf]");
  if (find) {
    findPDF(find.getAttribute("data-find-pdf"));
    return;
  }

  const back = e.target.closest("[data-back]");
  if (back) {
    openDetail(back.getAttribute("data-back"));
    return;
  }

  const returnBtn = e.target.closest("[data-return]");
  if (!returnBtn) return;
  const id = returnBtn.getAttribute("data-return");
  try {
    await api(`/api/books/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loanedTo: "", loanedAt: "", dueAt: "" }),
    });
    state.books = (await api("/api/books")).books;
    render();
    openDetail(id);
    toast("Marked as returned to the shelf.");
  } catch (err) {
    toast(err.message, true);
  }
});

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

async function init() {
  // Decide between the server library and the on-device library first.
  if (window.ShelfOffline) await ShelfOffline.init();

  const [books, genres, urls] = await Promise.all([
    api("/api/books"),
    api("/api/genres"),
    api("/api/urls").catch(() => null),
  ]);
  state.books = books.books || [];
  state.genres = genres.genres || [];

  // Covers stored on this device are used first, so the shelf works offline.
  if (window.CoverCache) await CoverCache.load();

  $("#mGenre").innerHTML = `<option value="">Detect from the book</option>`
    + state.genres.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join("")
    + `<option value="__new">+ Add a new genre</option>`;
  wireGenrePicker("mGenre", "mGenreNew");

  render();
  initQR(urls);
  initLive();
  registerServiceWorker();
  initPullRefresh();
  initAppMenu();
  if (window.CoverCache) CoverCache.warm(state.books.map((b) => b.cover));
}

// Connect to a computer and reset app files, without stealing long-press from
// text fields (the old APK did that, which broke paste).
function initAppMenu() {
  const link = $("#appMenu");
  if (!link) return;
  const bridge = window.ShelfApp;
  if (!bridge || typeof bridge.appMenu !== "function") return;
  link.classList.remove("hidden");
  if (!link.dataset.wired) {
    link.addEventListener("click", () => {
      if (window.ShelfApp && typeof window.ShelfApp.appMenu === "function") window.ShelfApp.appMenu();
    });
    link.dataset.wired = "1";
  }
}

// Drag down from the top of the shelf, release, and the app reloads.
function initPullRefresh() {
  const el = $("#pull");
  if (!el) return;
  const label = el.querySelector(".pull-text");
  const threshold = 70;
  let startY = 0;
  let pulling = false;
  let distance = 0;

  document.addEventListener("touchstart", (e) => {
    if (window.scrollY > 0 || e.touches.length !== 1) return;
    if (e.target.closest(".modal, input, textarea, select, .viewfinder")) return;
    startY = e.touches[0].clientY;
    pulling = true;
    distance = 0;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    const delta = e.touches[0].clientY - startY;
    if (delta <= 0) {
      distance = 0;
      el.classList.remove("visible", "ready");
      return;
    }
    distance = Math.min(130, delta);
    if (distance > 12) e.preventDefault();
    el.classList.add("visible");
    el.classList.toggle("ready", distance >= threshold);
    if (label) label.textContent = distance >= threshold ? "Release to refresh" : "Pull to refresh";
  }, { passive: false });

  const finish = () => {
    if (!pulling) return;
    pulling = false;
    const refresh = distance >= threshold;
    el.classList.remove("visible", "ready");
    distance = 0;
    if (!refresh) return;
    el.classList.add("visible", "busy");
    if (label) label.textContent = "Refreshing...";
    setTimeout(() => location.reload(), 250);
  };

  document.addEventListener("touchend", finish);
  document.addEventListener("touchcancel", finish);
}

const multiBox = $("#multiScan");
if (multiBox) {
  multiBox.checked = multiPref();
  multiBox.addEventListener("change", () => saveMultiPref(multiBox.checked));
}

$("#scanBtn").addEventListener("click", openScanner);
$("#scanClose").addEventListener("click", () => closeScanner(true));

$("#isbnForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("#isbnInput").value.trim();
  if (!value) return;
  $("#scanError").classList.add("hidden");
  submitISBN(value);
  $("#isbnInput").value = "";
});

$("#manualBtn").addEventListener("click", () => openManual());

// Typing a valid ISBN fills the form, and a scan that found nothing also lands here.
$("#mIsbn").addEventListener("input", (e) => {
  clearTimeout(manual.timer);
  const value = e.target.value;
  manual.timer = setTimeout(() => lookupForManual(value), 650);
});
$("#mIsbn").addEventListener("blur", () => {
  clearTimeout(manual.timer);
  lookupForManual($("#mIsbn").value);
});
$("#manualClose").addEventListener("click", () => $("#manualModal").classList.add("hidden"));

$("#manualForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const data = await api("/api/books", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        isbn: $("#mIsbn").value,
        title: $("#mTitle").value,
        author: $("#mAuthor").value,
        genre: genreValue("mGenre", "mGenreNew"),
        cover: manual.cover || undefined,
      }),
    });
    $("#manualModal").classList.add("hidden");
    $("#manualForm").reset();
    manual.cover = "";
    manual.lookedUp = "";
    setLookupHint("");
    setManualPreview(null);
    await refreshGenres();
    await reload(data.book.id, data.existed ? "confirm" : "added");
  } catch (err) {
    toast(err.message, true);
  }
});

$("#dataBtn").addEventListener("click", openData);
$("#dataClose").addEventListener("click", () => $("#dataModal").classList.add("hidden"));
$("#pdfClose").addEventListener("click", closePdfViewer);
$("#exportJson").addEventListener("click", () => saveFile(`shelfscout-${stamp()}.json`, booksToJSON(), "application/json"));
$("#exportCsv").addEventListener("click", () => saveFile(`shelfscout-${stamp()}.csv`, booksToCSV(), "text/csv"));
$("#importFile").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) readImportFile(file);
});
$("#importBtn").addEventListener("click", runImport);

$("#search").addEventListener("input", (e) => {
  state.query = e.target.value.trim().toLowerCase();
  render();
});

document.querySelectorAll(".seg button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.mode = btn.dataset.mode;
    render();
  });
});

$("#library").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-del]");
  if (btn) {
    const id = btn.getAttribute("data-del");
    const book = state.books.find((b) => b.id === id);
    if (!window.confirm(`Remove "${book ? book.title : "this book"}" from the library?`)) return;
    try {
      await api(`/api/books/${id}`, { method: "DELETE" });
      // Drop everything this device kept for the book.
      if (book && window.CoverCache) CoverCache.forget(book.cover);
      if (window.ShelfApp && typeof window.ShelfApp.deleteBookData === "function") {
        window.ShelfApp.deleteBookData(id);
      }
      closePdfViewer();
      if (state.detailId === id) closeDetail();
      state.books = (await api("/api/books")).books;
      if (state.banner && state.banner.id === id) state.banner = null;
      if (state.highlightId === id) state.highlightId = null;
      render();
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }

  const row = e.target.closest(".row");
  if (row) openDetail(row.getAttribute("data-id"));
});

$("#banner").addEventListener("click", async (e) => {
  if (e.target.closest("[data-add-copy]")) {
    const id = state.banner && state.banner.id;
    if (!id) return;
    try {
      const data = await api(`/api/books/${id}/copy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delta: 1 }),
      });
      state.books = (await api("/api/books")).books;
      state.banner = { id, phase: "addedCopy" };
      render();
      toast(`Right - count increased to ${data.book.count}.`);
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  if (e.target.closest("[data-not-copy]")) {
    const id = state.banner && state.banner.id;
    const book = state.books.find((x) => x.id === id);
    state.banner = { id, phase: "ignored" };
    render();
    toast(`No problem - count left at ${book ? book.count || 1 : 1}.`);
    return;
  }
  if (e.target.closest("[data-banner-close]")) {
    state.banner = null;
    renderBanner();
  }
  if (e.target.closest("[data-scan-again]")) {
    state.banner = null;
    renderBanner();
    openScanner();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeScanner();
  $("#manualModal").classList.add("hidden");
  $("#dataModal").classList.add("hidden");
  closePdfViewer();
});

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  const btn = $("#installBtn");
  if (btn) btn.classList.remove("hidden");
});

const installBtn = $("#installBtn");
if (installBtn) {
  installBtn.addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    installBtn.classList.add("hidden");
  });
}

window.addEventListener("appinstalled", () => toast("ShelfScout installed - open it from your home screen or desktop."));

init().catch((err) => toast(err.message || "Could not load the library.", true));