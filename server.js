import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8420);
const PUB_DIR = path.join(__dirname, "public");
const CERT_DIR = path.join(__dirname, "certs");
const DATA_DIR = path.join(__dirname, "data");
const LIB_FILE = path.join(DATA_DIR, "library.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

// Optional permanent link: a domain reserved on your ngrok account (free) or a
// full public URL. Both can come from the environment or data/settings.json.
function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

const settings = loadSettings();
const NGROK_DOMAIN = normalizeDomain(process.env.NGROK_DOMAIN || settings.ngrokDomain || "");

function loadSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ *
 * Genres
 * ------------------------------------------------------------------ */

export const GENRES = [
  "Art",
  "Biography & Memoir",
  "Business",
  "Children's",
  "Comics & Graphic Novels",
  "Cooking",
  "Essays",
  "Fantasy",
  "Fiction",
  "History",
  "Horror",
  "Mystery & Thriller",
  "Philosophy",
  "Poetry",
  "Psychology",
  "Religion & Spirituality",
  "Romance",
  "Science",
  "Science Fiction",
  "Self-Help",
  "Travel",
  "Other",
];

// Order matters: the first rule whose keyword appears in the book's
// subjects (or, failing that, its title) wins.
const GENRE_RULES = [
  ["Comics & Graphic Novels", ["graphic novel", "comics", "comic book", "manga"]],
  ["Science Fiction", ["science fiction", "sci-fi", "space opera", "dystopian", "spaceship", "time travel", "cyberpunk"]],
  ["Fantasy", ["fantasy", "magic", "wizard", "dragon", "faerie", "fairy tale"]],
  ["Horror", ["horror", "ghost story", "zombie", "vampire", "supernatural"]],
  ["Mystery & Thriller", ["mystery", "thriller", "suspense", "detective", "crime", "whodunit", "noir"]],
  ["Romance", ["romance", "love story", "love stories", "courtship", "romantic"]],
  // Broad audience labels come after genre fiction, so "juvenile fiction"
  // doesn't steal fantasy/horror books away from their genre section.
  ["Children's", ["children", "picture book", "early learning", "middle grade", "young adult", "ya fiction", "kids"]],
  ["Poetry", ["poetry", "poem", "poet"]],
  ["Biography & Memoir", ["biography", "autobiography", "memoir"]],
  ["History", ["history", "historical", "world war", "revolution", "ancient"]],
  ["Science", ["physics", "chemistry", "biology", "astronomy", "mathematics", "nature", "science", "medicine", "evolution", "cosmology"]],
  ["Business", ["business", "economics", "investing", "entrepreneur", "management", "finance"]],
  ["Self-Help", ["self-help", "self help", "personal development", "productivity", "self improvement"]],
  ["Psychology", ["psychology", "psychiatry"]],
  ["Religion & Spirituality", ["religion", "spiritual", "christianity", "islam", "buddhism", "theology", "mythology"]],
  ["Philosophy", ["philosophy", "ethics", "logic"]],
  ["Cooking", ["cooking", "recipe", "cookbook", "food", "culinary"]],
  ["Travel", ["travel", "guidebook", "guide book"]],
  ["Art", ["art", "architecture", "design", "photography"]],
  ["Essays", ["essay", "letters"]],
  ["Fiction", ["fiction", "novel", "stories"]],
];

// Genres so broad that almost every book's subjects contain them - they are
// only used when nothing specific matched.
const BROAD_GENRES = new Set(["Fiction"]);

function classifyGenre(subjects = [], title = "") {
  const subs = subjects.map((s) => String(s).toLowerCase());
  const hits = ([, keywords]) => subs.filter((s) => keywords.some((k) => s.includes(k))).length;

  // Score every specific genre by how many of the book's subjects match it and
  // take the highest score - a book with 14 fantasy subjects and one stray
  // "comic books" subject is clearly Fantasy, not a graphic novel.
  let best = null;
  let bestScore = 0;
  for (const rule of GENRE_RULES) {
    if (BROAD_GENRES.has(rule[0])) continue;
    const score = hits(rule);
    if (score > bestScore) {
      bestScore = score;
      best = rule[0];
    }
  }
  if (best && bestScore > 0) return best;

  // Nothing specific: fall back to broad genres, then the title.
  for (const rule of GENRE_RULES) {
    if (BROAD_GENRES.has(rule[0]) && hits(rule) > 0) return rule[0];
  }
  const t = String(title).toLowerCase();
  for (const [genre, keywords] of GENRE_RULES) {
    if (keywords.some((k) => t.includes(k))) return genre;
  }
  return "Other";
}

/* ------------------------------------------------------------------ *
 * Storage (a small JSON "database" on disk, shared by every device)
 * ------------------------------------------------------------------ */

function loadBooks() {
  try {
    const raw = fs.readFileSync(LIB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Entries saved before the copy counter existed default to one copy.
    return parsed.map((b) => (
      Number.isFinite(b.count) && b.count >= 1 ? b : { ...b, count: 1 }
    ));
  } catch {
    return [];
  }
}

function saveBooks(books) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Keep the previous version of the library before every write. A bad edit or
  // an accidental delete can then be undone from data/backups.
  try {
    if (fs.existsSync(LIB_FILE)) {
      const dir = path.join(DATA_DIR, "backups");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.copyFileSync(LIB_FILE, path.join(dir, `library-${stamp}.json`));
      const keep = fs.readdirSync(dir).filter((f) => f.startsWith("library-")).sort();
      for (const old of keep.slice(0, Math.max(0, keep.length - 10))) {
        fs.unlinkSync(path.join(dir, old));
      }
    }
  } catch {
    /* a failed backup must never block the save */
  }
  const tmp = LIB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(books, null, 2));
  fs.renameSync(tmp, LIB_FILE);
}

// Default genres plus every genre already used in the library, so a custom
// genre typed by the user stays available for new and existing books.
function allGenres() {
  const used = loadBooks().map((b) => b.genre).filter(Boolean);
  const extra = [...new Set(used)].filter((g) => !GENRES.includes(g)).sort((a, b) => a.localeCompare(b));
  return [...GENRES, ...extra];
}

function cleanGenre(value) {
  const genre = String(value || "").trim().replace(/\s+/g, " ");
  return genre ? genre.slice(0, 60) : "";
}

/* ------------------------------------------------------------------ *
 * ISBN helpers
 * ------------------------------------------------------------------ */

function cleanISBN(value) {
  let isbn = String(value || "").replace(/[^0-9Xx]/g, "").toUpperCase();
  // UPC-A barcodes (12 digits, leading 0) and ISBN-10s become ISBN-13 so
  // the same book always dedupes to one shelf entry.
  if (isbn.length === 12 && isbn.startsWith("0")) {
    // Bookland UPC-A: drop the leading 0, prefix 978, recompute the ISBN check digit.
    const core = "978" + isbn.slice(1, 10);
    isbn = core + checkDigit13(core);
  }
  if (isbn.length === 10 && /^\d{9}[\dX]$/.test(isbn)) {
    const core = "978" + isbn.slice(0, 9);
    isbn = core + checkDigit13(core);
  }
  return isbn;
}

function checkDigit13(twelve) {
  let sum = 0;
  for (let i = 0; i < twelve.length; i++) sum += Number(twelve[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}

function isValidISBN(raw) {
  const isbn = cleanISBN(raw);
  if (isbn.length === 13) {
    if (!/^\d{13}$/.test(isbn)) return false;
    let sum = 0;
    for (let i = 0; i < 13; i++) sum += Number(isbn[i]) * (i % 2 ? 3 : 1);
    return sum % 10 === 0;
  }
  if (isbn.length === 10) {
    if (!/^\d{9}[\dX]$/.test(isbn)) return false;
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += (isbn[i] === "X" ? 10 : Number(isbn[i])) * (10 - i);
    return sum % 11 === 0;
  }
  return false;
}

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(9000), headers: { "User-Agent": "ShelfScout/1.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/* ------------------------------------------------------------------ *
 * Online lookup: Open Library first, Google Books as a backstop
 * ------------------------------------------------------------------ */

async function lookupISBN(isbn13) {
  const rec = await lookupISBNRaw(isbn13);
  if (!rec) return null;
  rec.cover = await resolveCover(rec);
  return rec;
}

async function urlOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "User-Agent": "ShelfScout/1.0" } });
    if (res.ok) {
      if (res.body) await res.body.cancel();
      return true;
    }
  } catch {
    /* not usable */
  }
  return false;
}

// Search the web for a front cover when the barcode lookup didn't return a working one.
async function googleCoverURL(title, authors = []) {
  if (!title) return "";
  try {
    const q = encodeURIComponent(`intitle:${title}${authors[0] ? ` inauthor:${authors[0]}` : ""}`);
    const data = await fetchJSON(`https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=1`);
    const links = data.items?.[0]?.volumeInfo?.imageLinks;
    const link = links?.thumbnail || links?.smallThumbnail;
    if (link) return link.replace("http:", "https:").replace("&edge=curl", "&zoom=2");
  } catch {
    /* fall through */
  }
  return "";
}

// A readable cover drawn from the title, used only when no service has an image.
function generatedCover(title, authors) {
  const clean = (v) => String(v || "").replace(/[<>&]/g, "").trim();
  const wrap = (text, size) => {
    const words = clean(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      if ((line + " " + word).trim().length > size) {
        if (line) lines.push(line);
        line = word;
      } else {
        line = (line + " " + word).trim();
      }
      if (lines.length === 3) break;
    }
    if (line && lines.length < 4) lines.push(line);
    return lines.slice(0, 4);
  };
  const titleLines = wrap(title || "Untitled", 18);
  const authorLine = clean((authors || [])[0] || "");
  const tspans = titleLines
    .map((line, i) => `<tspan x="150" dy="${i === 0 ? 0 : 26}">${line}</tspan>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">`
    + `<stop offset="0" stop-color="#332c21"/><stop offset="1" stop-color="#1b1712"/></linearGradient></defs>`
    + `<rect width="300" height="450" fill="url(#g)"/>`
    + `<rect x="16" y="16" width="268" height="418" fill="none" stroke="#d9a15c" stroke-opacity="0.45"/>`
    + `<text x="150" y="200" fill="#f2ebdf" font-family="Georgia,serif" font-size="20" text-anchor="middle">${tspans}</text>`
    + `<text x="150" y="390" fill="#a99c88" font-family="Arial,sans-serif" font-size="13" text-anchor="middle">${authorLine}</text>`
    + `</svg>`;
  return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

async function openLibraryCoverByIsbn(isbn) {
  try {
    const data = await fetchJSON(
      `https://openlibrary.org/search.json?q=isbn:${isbn}&fields=cover_i&limit=1`
    );
    const id = data.docs?.[0]?.cover_i;
    return id ? `https://covers.openlibrary.org/b/id/${id}-L.jpg` : "";
  } catch {
    return "";
  }
}

async function googleCoverByQuery(query) {
  if (!query) return "";
  try {
    const data = await fetchJSON(
      `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5`
    );
    for (const item of data.items || []) {
      const links = item.volumeInfo?.imageLinks || {};
      const url = links.extraLarge || links.large || links.medium || links.thumbnail || links.smallThumbnail;
      if (url) return String(url).replace(/^http:/, "https:").replace(/&edge=curl/g, "");
    }
  } catch {
    /* fall through */
  }
  return "";
}

async function resolveCover(rec) {
  const authors = rec.authors || [];
  if (rec.cover && (await urlOk(rec.cover))) return rec.cover;

  const candidates = [
    rec.isbn ? `https://covers.openlibrary.org/b/isbn/${rec.isbn}-L.jpg?default=false` : "",
    rec.coverId ? `https://covers.openlibrary.org/b/id/${rec.coverId}-L.jpg?default=false` : "",
    rec.isbn ? await openLibraryCoverByIsbn(rec.isbn) : "",
    await googleCoverURL(rec.title, authors),
    await googleCoverByQuery([rec.title, authors[0]].filter(Boolean).join(" ")),
    rec.isbn ? await googleCoverByQuery(`isbn:${rec.isbn}`) : "",
    rec.isbn ? coverURL(rec.isbn) : "",
    rec.cover,
  ].filter(Boolean);

  for (const url of candidates) {
    if (await urlOk(url)) return url;
  }

  // No service had an image: draw one so the book never shows an empty cover.
  return generatedCover(rec.title, authors);
}

async function lookupISBNRaw(isbn13) {
  // 1. Open Library Books API
  try {
    const data = await fetchJSON(
      `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn13}&format=json&jscmd=data`
    );
    const b = data[`ISBN:${isbn13}`];
    if (b && b.title) {
      return {
        isbn: isbn13,
        title: b.title,
        authors: (b.authors || []).map((a) => a.name).filter(Boolean),
        subjects: (b.subjects || []).map((s) => s.name).filter(Boolean),
        cover: b.cover?.large || b.cover?.medium || b.cover?.small || coverURL(isbn13),
        year: (b.publish_date || "").match(/\d{4}/)?.[0] || "",
        publisher: b.publishers?.[0]?.name || "",
        pages: b.number_of_pages || null,
        source: "Open Library",
      };
    }
  } catch {
    /* fall through */
  }

  // 2. Open Library search (works when the Books API has no record)
  try {
    const data = await fetchJSON(
      `https://openlibrary.org/search.json?isbn=${isbn13}&limit=1&fields=title,author_name,subject,first_publish_year,cover_i,publisher`
    );
    const d = data.docs?.[0];
    if (d && d.title) {
      return {
        isbn: isbn13,
        title: d.title,
        authors: d.author_name || [],
        subjects: d.subject || [],
        cover: d.cover_i
          ? `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`
          : coverURL(isbn13),
        coverId: d.cover_i || null,
        year: d.first_publish_year ? String(d.first_publish_year) : "",
        publisher: d.publisher?.[0] || "",
        pages: null,
        source: "Open Library",
      };
    }
  } catch {
    /* fall through */
  }

  // 3. Google Books
  try {
    const data = await fetchJSON(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn13}`);
    const v = data.items?.[0]?.volumeInfo;
    if (v && v.title) {
      return {
        isbn: isbn13,
        title: v.title,
        authors: v.authors || [],
        subjects: v.categories || [],
        cover: v.imageLinks?.thumbnail?.replace("http:", "https:") || coverURL(isbn13),
        year: (v.publishedDate || "").match(/\d{4}/)?.[0] || "",
        publisher: v.publisher || "",
        pages: v.pageCount || null,
        source: "Google Books",
      };
    }
  } catch {
    /* fall through */
  }

  return null;
}

function coverURL(isbn) {
  return `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg`;
}

// If the barcode record carries no subjects, ask Open Library for them by title
// so the book still lands in a sensible genre section.
async function subjectsByTitle(title) {
  if (!title) return [];
  try {
    const data = await fetchJSON(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(title)}&limit=1&fields=title,subject`
    );
    const doc = data.docs?.[0];
    if (doc && doc.subject?.length) return doc.subject.slice(0, 12);
  } catch {
    /* fall through */
  }
  return [];
}

function makeBook(record) {
  return {
    id: crypto.randomUUID(),
    isbn: record.isbn || "",
    title: record.title || "Untitled",
    authors: record.authors?.length ? record.authors : ["Unknown author"],
    genre: record.genre || classifyGenre(record.subjects || [], record.title || ""),
    subjects: record.subjects || [],
    cover: record.cover || generatedCover(record.title, record.authors),
    year: record.year || "",
    publisher: record.publisher || "",
    pages: record.pages ?? null,
    source: record.source || "Manual entry",
    count: 1,
    addedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Self-signed certificate (needed so phones allow camera access)
 * ------------------------------------------------------------------ */

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function ensureCert() {
  const keyFile = path.join(CERT_DIR, "key.pem");
  const certFile = path.join(CERT_DIR, "cert.pem");
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const san = [
    "DNS:localhost",
    `DNS:${os.hostname()}`,
    "IP:127.0.0.1",
    ...lanAddresses().map((a) => `IP:${a.address}`),
  ].join(",");
  console.log("Generating a self-signed certificate for HTTPS (one-time)...");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "825", "-nodes",
    "-keyout", keyFile,
    "-out", certFile,
    "-subj", "/CN=ShelfScout",
    "-addext", `subjectAltName=${san}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".apk": "application/vnd.android.package-archive",
};

function sendJSON(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "https://x").pathname);
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const filePath = path.join(PUB_DIR, rel);
  if (!filePath.startsWith(PUB_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
  // The service worker and app shell must never be served stale.
  if (rel === "sw.js" || rel === "index.html" || rel === "manifest.webmanifest") headers["Cache-Control"] = "no-cache";
  if (ext === ".apk") headers["Content-Disposition"] = 'attachment; filename="ShelfScout.apk"';
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

/* ------------------------------------------------------------------ *
 * Live sync - every open device gets a Server-Sent Events stream, so a scan
 * on the phone redraws the shelf on the desktop within a moment.
 * ------------------------------------------------------------------ */

const eventClients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of eventClients) {
    try {
      client.write(frame);
    } catch {
      eventClients.delete(client);
    }
  }
}

setInterval(() => {
  for (const client of eventClients) {
    try {
      client.write(": ping\n\n");
    } catch {
      eventClients.delete(client);
    }
  }
}, 25000).unref();

function streamEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  eventClients.add(res);
  req.on("close", () => eventClients.delete(res));
}

async function handleAPI(req, res, pathname) {
  const origin = String(req.headers["x-client-id"] || "");

  // GET /api/events - live library updates for every open device
  if (req.method === "GET" && pathname === "/api/events") return streamEvents(req, res);

  // GET /api/health - lets the app tell a live server from a missing one, so it
  // can fall back to the on-device library instead of showing an empty shelf.
  if (req.method === "GET" && pathname === "/api/health") {
    return sendJSON(res, 200, { ok: true, mode: "server" });
  }

  // GET /api/books
  if (req.method === "GET" && pathname === "/api/books") {
    return sendJSON(res, 200, { books: loadBooks() });
  }

  // GET /api/genres
  if (req.method === "GET" && pathname === "/api/genres") {
    return sendJSON(res, 200, { genres: allGenres() });
  }

  // GET /api/lookup?isbn=... - details only, without adding the book. Used by
  // the manual form to fill the fields as soon as a valid ISBN is typed.
  if (req.method === "GET" && pathname === "/api/lookup") {
    const query = new URL(req.url, "https://x").searchParams;
    const isbn = cleanISBN(query.get("isbn"));
    if (!isValidISBN(isbn)) {
      return sendJSON(res, 400, { error: "That barcode is not a valid ISBN." });
    }
    const found = await lookupISBN(isbn);
    if (!found) return sendJSON(res, 404, { found: false, isbn });
    if (!found.subjects.length) found.subjects = await subjectsByTitle(found.title);
    return sendJSON(res, 200, {
      found: true,
      record: found,
      genre: classifyGenre(found.subjects, found.title),
    });
  }

  // GET /api/urls - the links to open on a phone (used for the QR code)
  if (req.method === "GET" && pathname === "/api/urls") {
    const apkPath = path.join(PUB_DIR, "download", "ShelfScout.apk");
    return sendJSON(res, 200, {
      local: `https://localhost:${PORT}`,
      public: publicUrl || null,
      permanent: Boolean(NGROK_DOMAIN && publicUrl === `https://${NGROK_DOMAIN}`),
      apk: fs.existsSync(apkPath) ? "/download/ShelfScout.apk" : null,
      phones: [
        ...(publicUrl ? [publicUrl] : []),
        ...lanAddresses().map((a) => `https://${a.address}:${PORT}`),
      ],
    });
  }

  // POST /api/scan { isbn }
  if (req.method === "POST" && pathname === "/api/scan") {
    const body = await readBody(req);
    const isbn = cleanISBN(body.isbn);
    if (!isValidISBN(isbn)) {
      return sendJSON(res, 400, { error: "That barcode is not a valid ISBN." });
    }
    const books = loadBooks();
    const existing = books.find((b) => b.isbn === isbn);
    // Rescanning never changes the count by itself - the client asks the user
    // first and only then calls POST /api/books/:id/copy.
    if (existing) return sendJSON(res, 200, { book: existing, existed: true, needsConfirm: true });

    const found = await lookupISBN(isbn);
    if (!found) {
      return sendJSON(res, 404, { error: "not_found", isbn, message: "No online record for this ISBN." });
    }
    if (!found.subjects.length) found.subjects = await subjectsByTitle(found.title);
    const book = makeBook(found);
    books.push(book);
    saveBooks(books);
    broadcast("library", { reason: "added", book, origin });
    return sendJSON(res, 201, { book, existed: false });
  }

  // POST /api/books - manual entry
  if (req.method === "POST" && pathname === "/api/books") {
    const body = await readBody(req);
    if (!body.title || !String(body.title).trim()) {
      return sendJSON(res, 400, { error: "A title is required." });
    }
    const isbn = cleanISBN(body.isbn);
    const authors = String(body.author || "")
      .split(/[,;&]| and /)
      .map((a) => a.trim())
      .filter(Boolean);

    let record = {
      isbn: isValidISBN(isbn) ? isbn : "",
      title: String(body.title).trim(),
      authors,
      subjects: [],
      cover: "",
      year: body.year || "",
      publisher: "",
      source: "Manual entry",
    };

    // If an ISBN was supplied, enrich the manual entry with online details.
    if (record.isbn && !body.skipLookup) {
      const found = await lookupISBN(record.isbn);
      if (found) {
        record = {
          ...found,
          title: record.title || found.title,
          authors: record.authors.length ? record.authors : found.authors,
          genre: found.genre,
        };
        record.subjects = found.subjects;
      }
    }
    if (!record.subjects.length) record.subjects = await subjectsByTitle(record.title);
    if (typeof body.cover === "string" && body.cover.trim()) record.cover = body.cover.trim();
    const manualGenre = cleanGenre(body.genre);
    if (manualGenre) record.genre = manualGenre;

    const books = loadBooks();
    if (record.isbn) {
      const dup = books.find((b) => b.isbn === record.isbn);
      if (dup) return sendJSON(res, 200, { book: dup, existed: true, needsConfirm: true });
    }
    const book = makeBook(record);
    books.push(book);
    saveBooks(books);
    broadcast("library", { reason: "added", book, origin });
    return sendJSON(res, 201, { book, existed: false });
  }

  // POST /api/books/:id/copy { delta } - adjust how many physical copies you own.
  const copyMatch = pathname.match(/^\/api\/books\/([\w-]+)\/copy$/);
  if (req.method === "POST" && copyMatch) {
    const body = await readBody(req);
    const books = loadBooks();
    const idx = books.findIndex((b) => b.id === copyMatch[1]);
    if (idx === -1) return sendJSON(res, 404, { error: "Book not found." });
    const delta = Number(body.delta);
    const step = Number.isFinite(delta) && delta !== 0 ? Math.trunc(delta) : 1;
    const count = Math.max(1, (books[idx].count || 1) + step);
    books[idx] = { ...books[idx], count };
    saveBooks(books);
    broadcast("library", { reason: "copy", book: books[idx], origin });
    return sendJSON(res, 200, { book: books[idx] });
  }

  // PUT /api/books/:id - edit every field of a book
  const idMatch = pathname.match(/^\/api\/books\/([\w-]+)$/);
  if (req.method === "PUT" && idMatch) {
    const body = await readBody(req);
    const books = loadBooks();
    const idx = books.findIndex((b) => b.id === idMatch[1]);
    if (idx === -1) return sendJSON(res, 404, { error: "Book not found." });
    const book = books[idx];
    const patch = {};
    if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
    if (typeof body.author === "string") {
      patch.authors = body.author.split(/[,;&]| and /).map((a) => a.trim()).filter(Boolean);
      if (!patch.authors.length) patch.authors = ["Unknown author"];
    }
    const editedGenre = cleanGenre(body.genre);
    if (editedGenre) patch.genre = editedGenre;
    if (typeof body.isbn === "string") {
      const isbn = cleanISBN(body.isbn);
      patch.isbn = isValidISBN(isbn) ? isbn : "";
    }
    if (typeof body.year === "string") patch.year = body.year.trim();
    if (typeof body.publisher === "string") patch.publisher = body.publisher.trim();
    if (body.pages !== undefined) {
      const pages = Number(body.pages);
      patch.pages = Number.isFinite(pages) && pages > 0 ? pages : null;
    }
    if (Array.isArray(body.subjects)) patch.subjects = body.subjects.map((s) => String(s).trim()).filter(Boolean);
    if (typeof body.cover === "string") patch.cover = body.cover.trim();
    if (body.count !== undefined) {
      const count = Number(body.count);
      if (Number.isFinite(count) && count >= 1) patch.count = Math.trunc(count);
    }
    books[idx] = { ...book, ...patch, editedAt: new Date().toISOString() };
    saveBooks(books);
    broadcast("library", { reason: "edited", book: books[idx], origin });
    return sendJSON(res, 200, { book: books[idx] });
  }

  // DELETE /api/books/:id
  if (req.method === "DELETE" && idMatch) {
    const books = loadBooks();
    const next = books.filter((b) => b.id !== idMatch[1]);
    if (next.length === books.length) return sendJSON(res, 404, { error: "Book not found." });
    saveBooks(next);
    broadcast("library", { reason: "removed", id: idMatch[1], origin });
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { error: "Unknown endpoint" });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

const creds = ensureCert();

// The public side is always HTTPS; the tunnel forwards plain HTTP to this
// loopback-only mirror, so ngrok never has to handshake with our self-signed cert.
const TUNNEL_PORT = PORT + 1;

const handler = async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    if (pathname.startsWith("/api/")) {
      await handleAPI(req, res, pathname);
    } else {
      serveStatic(req, res);
    }
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJSON(res, 500, { error: err.message || "Server error" });
    else res.end();
  }
};

const server = https.createServer(creds, handler);

// The tunnel forwards plain HTTP to this loopback-only mirror, so ngrok never
// has to handshake with our self-signed certificate. If the preferred port is
// taken (a stale copy of the app, or anything else), fall back to a free port
// instead of crashing with EADDRINUSE on startup.
const mirror = http.createServer(handler);
let mirrorPort = 0;

function startMirror() {
  return new Promise((resolve) => {
    const attempt = (port, mayFallBack) => {
      const onError = (err) => {
        mirror.removeListener("listening", onListening);
        if (mayFallBack && err.code === "EADDRINUSE") {
          console.warn(`  Local port ${port} is busy - the tunnel will use another port.`);
          attempt(0, false); // let the OS pick a free port
        } else {
          console.error(`  Could not start the local tunnel mirror: ${err.message}`);
          resolve(0);
        }
      };
      const onListening = () => {
        mirror.removeListener("error", onError);
        mirrorPort = mirror.address().port;
        resolve(mirrorPort);
      };
      mirror.once("error", onError);
      mirror.once("listening", onListening);
      mirror.listen(port, "127.0.0.1");
    };
    attempt(TUNNEL_PORT, true);
  });
}

// A public tunnel makes the app reachable from a phone on any network and
// gives it a real certificate, so the camera works with no warning screen.
let publicUrl = process.env.SHELFSCOUT_PUBLIC_URL || "";
let ngrokChild = null;

function reportLinks() {
  const addrs = lanAddresses();
  console.log("");
  console.log("  ShelfScout is running");
  console.log("  ----------------------");
  console.log(`  On this computer:  https://localhost:${PORT}`);
  if (publicUrl) {
    const permanent = NGROK_DOMAIN && publicUrl === `https://${NGROK_DOMAIN}`;
    console.log(`  On your phone:     ${publicUrl}${permanent ? "   (permanent)" : ""}`);
    console.log("");
    console.log("  Scan the QR code in the app, or open the phone link directly.");
  } else {
    for (const a of addrs) console.log(`  On your phone:     https://${a.address}:${PORT}   (${a.name})`);
    if (addrs.length) {
      console.log("");
      console.log("  (Same network required; accept the certificate warning to enable the camera.)");
    }
  }
  console.log("");
}

async function existingTunnelURL() {
  try {
    const res = await fetch("http://127.0.0.1:4040/api/tunnels", { signal: AbortSignal.timeout(1500) });
    const data = await res.json();
    const tunnel = (data.tunnels || []).find((t) => t.public_url && t.public_url.startsWith("https://"));
    return tunnel ? tunnel.public_url : "";
  } catch {
    return "";
  }
}

async function waitForTunnel(deadlineMs = 20000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    const url = await existingTunnelURL();
    if (url) return url;
    await new Promise((r) => setTimeout(r, 500));
  }
  return "";
}

async function startNgrok(domain) {
  const args = ["http", `127.0.0.1:${mirrorPort || TUNNEL_PORT}`];
  if (domain) args.push(`--url=https://${domain}`);
  let child;
  try {
    child = spawn("ngrok", args, { stdio: "ignore" });
    ngrokChild = child;
    child.on("exit", () => { if (ngrokChild === child) ngrokChild = null; });
  } catch {
    return "";
  }
  // Don't wait the full timeout if ngrok rejects the domain and exits.
  const exited = new Promise((resolve) => child.once("exit", () => resolve("")));
  const url = await Promise.race([waitForTunnel(), exited]);
  if (!url) stopTunnel();
  return url;
}

async function ensureTunnel() {
  if (process.env.SHELFSCOUT_TUNNEL === "0" || process.env.SHELFSCOUT_PUBLIC_URL) return reportLinks();
  try {
    execFileSync("which", ["ngrok"], { stdio: "ignore" });
  } catch {
    return reportLinks(); // no ngrok: fall back to LAN links
  }

  // With a reserved domain, ask ngrok for exactly that URL every time.
  let url = NGROK_DOMAIN ? "" : await existingTunnelURL();
  if (NGROK_DOMAIN) {
    url = await startNgrok(NGROK_DOMAIN);
    if (!url) {
      console.warn("");
      console.warn(`  Could not claim ${NGROK_DOMAIN}.`);
      console.warn("  Is that domain reserved on the ngrok account this machine is logged into?");
      console.warn("  Falling back to a temporary link for now (npm run link fixes this).");
      url = await startNgrok("");
    }
  } else if (!url) {
    url = await startNgrok("");
  }
  if (url) publicUrl = url;
  reportLinks();
}

function stopTunnel() {
  if (ngrokChild) {
    try { ngrokChild.kill("SIGTERM"); } catch { /* already gone */ }
    ngrokChild = null;
  }
}
process.on("exit", stopTunnel);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopTunnel(); process.exit(0); });


// Fail with a clear, actionable message instead of a raw stack trace.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("");
    console.error(`  ShelfScout can't start: port ${PORT} is already in use.`);
    console.error("  Another copy is probably still running.");
    console.error('  Stop it with:   pkill -f "node server.js"');
    console.error(`  Or use another port:   PORT=${PORT + 10} npm start`);
    console.error("");
  } else {
    console.error(`  ShelfScout failed to start: ${err.message}`);
  }
  stopTunnel();
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", async () => {
  // The tunnel target has to be listening before ngrok is pointed at it.
  await startMirror();
  if (mirrorPort) ensureTunnel().catch(() => reportLinks());
  else reportLinks();
});