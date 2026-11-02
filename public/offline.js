"use strict";

/* ShelfScout on-device mode.
 *
 * When no server is reachable the library runs entirely on this device:
 * books live in localStorage and lookups go straight to Open Library and
 * Google Books, both of which allow cross-origin requests. app.js keeps
 * calling api() as usual; this file answers those calls locally.
 */
window.ShelfOffline = (function () {
  const KEY = "shelfscout.library.v1";
  const SEED = "seed.json";

  const GENRES = [
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

  // Same order as the server: the first rule with the most subject hits wins.
  const RULES = [
    ["Comics & Graphic Novels", ["graphic novel", "comics", "comic book", "manga"]],
    ["Science Fiction", ["science fiction", "sci-fi", "space opera", "dystopian", "spaceship", "time travel", "cyberpunk"]],
    ["Fantasy", ["fantasy", "magic", "wizard", "dragon", "faerie", "fairy tale"]],
    ["Horror", ["horror", "ghost story", "zombie", "vampire", "supernatural"]],
    ["Mystery & Thriller", ["mystery", "thriller", "suspense", "detective", "crime", "whodunit", "noir"]],
    ["Romance", ["romance", "love story", "love stories", "courtship", "romantic"]],
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

  let active = false;

  /* ---------------- storage ---------------- */

  function readBooks() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || "{}");
      return Array.isArray(parsed.books) ? parsed.books : [];
    } catch {
      return [];
    }
  }

  function writeBooks(books) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ books, savedAt: new Date().toISOString() }));
    } catch {
      /* private mode or a full quota: the session still works in memory */
    }
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "b-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function fail(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
  }

  /* ---------------- genres ---------------- */

  function classify(subjects, title) {
    const subs = (subjects || []).map((s) => String(s).toLowerCase());
    let best = "";
    let bestScore = 0;
    for (const [genre, words] of RULES) {
      if (genre === "Fiction") continue;
      let score = 0;
      for (const s of subs) if (words.some((w) => s.includes(w))) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = genre;
      }
    }
    if (best) return best;

    const text = String(title || "").toLowerCase();
    for (const [genre, words] of RULES) {
      if (words.some((w) => text.includes(w))) return genre;
    }
    return "Other";
  }

  /* ---------------- online lookup ---------------- */

  async function getJSON(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || 9000);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function coverFor(isbn) {
    const base = `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;
    try {
      const res = await fetch(`${base}?default=false`, { cache: "no-store" });
      const type = res.headers.get("content-type") || "";
      if (res.ok && type.indexOf("image") === 0) return base;
    } catch {
      /* no cover, keep the placeholder */
    }
    return "";
  }

  // Drawn locally when no service has a cover, so a book never looks blank.
  function generatedCover(title, author) {
    const clean = (v) => String(v || "").replace(/[<>&]/g, "").trim();
    const words = clean(title || "Untitled").split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
      if ((line + " " + word).trim().length > 18) {
        if (line) lines.push(line);
        line = word;
      } else {
        line = (line + " " + word).trim();
      }
      if (lines.length === 3) break;
    }
    if (line && lines.length < 4) lines.push(line);
    const tspans = lines
      .slice(0, 4)
      .map((l, i) => `<tspan x="150" dy="${i === 0 ? 0 : 26}">${l}</tspan>`)
      .join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">`
      + `<rect width="300" height="450" fill="#241f18"/>`
      + `<rect x="16" y="16" width="268" height="418" fill="none" stroke="#d9a15c" stroke-opacity="0.45"/>`
      + `<text x="150" y="200" fill="#f2ebdf" font-family="Georgia,serif" font-size="20" text-anchor="middle">${tspans}</text>`
      + `<text x="150" y="390" fill="#a99c88" font-family="Arial,sans-serif" font-size="13" text-anchor="middle">${clean(author)}</text>`
      + `</svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  async function lookupOpenLibrary(isbn) {
    const fields = "title,author_name,first_publish_year,publisher,subject,cover_i";
    const url = `https://openlibrary.org/search.json?q=isbn:${isbn}&fields=${fields}&limit=1`;
    const data = await getJSON(url);
    const doc = (data.docs || [])[0];
    if (!doc || !doc.title) return null;
    const cover = doc.cover_i
      ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg`
      : await coverFor(isbn) || generatedCover(doc.title, (doc.author_name || [])[0]);
    return {
      isbn,
      title: doc.title,
      authors: (doc.author_name || []).slice(0, 3),
      subjects: (doc.subject || []).slice(0, 40),
      cover,
      year: doc.first_publish_year ? String(doc.first_publish_year) : "",
      publisher: (doc.publisher || [])[0] || "",
      pages: null,
      source: "Open Library",
    };
  }

  async function lookupGoogleBooks(isbn) {
    const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;
    const data = await getJSON(url);
    const item = (data.items || [])[0];
    if (!item) return null;
    const v = item.volumeInfo || {};
    let cover = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || "";
    if (cover.indexOf("http://") === 0) cover = "https://" + cover.slice(7);
    if (!cover) cover = generatedCover(v.title, (v.authors || [])[0]);
    return {
      isbn,
      title: v.title ? v.title + (v.subtitle ? ": " + v.subtitle : "") : "",
      authors: v.authors || [],
      subjects: v.categories || [],
      cover,
      year: v.publishedDate ? String(v.publishedDate).slice(0, 4) : "",
      publisher: v.publisher || "",
      pages: v.pageCount || null,
      source: "Google Books",
    };
  }

  // The device cannot store a whole PDF, so it only keeps a link to a legal
  // free copy. Same rules as the server: public-domain scans and Gutenberg.
  function titleMatch(a, b) {
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return false;
    return x === y || (x.length > 8 && y.includes(x)) || (y.length > 8 && x.includes(y));
  }

  async function findFreePDFOnline(book) {
    const title = String(book.title || "").trim();
    const isbn = cleanISBN(book.isbn);
    let access = "";
    let scans = [];

    if (isbn && isValidISBN(isbn)) {
      try {
        const data = await getJSON(`https://openlibrary.org/search.json?q=isbn:${isbn}&fields=title,ebook_access,ia&limit=1`);
        const doc = (data.docs || [])[0];
        if (doc) {
          access = String(doc.ebook_access || "");
          scans = Array.isArray(doc.ia) ? doc.ia.slice(0, 2) : [];
        }
      } catch {
        /* try the title below */
      }
    }

    if (access !== "public" && title) {
      try {
        const data = await getJSON(`https://openlibrary.org/search.json?q=${encodeURIComponent(title)}&fields=title,ebook_access,ia&limit=5`);
        const doc = (data.docs || []).find(
          (d) => d.ebook_access === "public" && Array.isArray(d.ia) && d.ia.length && titleMatch(d.title, title)
        );
        if (doc) {
          access = "public";
          scans = doc.ia.slice(0, 2);
        }
      } catch {
        /* no free copy */
      }
    }

    if (access === "public" && scans.length) {
      return {
        pdf: "",
        pdfUrl: `https://archive.org/download/${encodeURIComponent(scans[0])}/${encodeURIComponent(scans[0])}.pdf`,
        pdfSource: "Internet Archive",
        pdfNote: "Free public-domain scan. Opens online.",
      };
    }

    try {
      const query = [title, (book.authors || [])[0] || ""].filter(Boolean).join(" ");
      const data = await getJSON(`https://gutendex.com/books?search=${encodeURIComponent(query)}`);
      const hit = (data.results || []).find((r) => titleMatch(r.title, title));
      const pdf = hit && hit.formats ? Object.entries(hit.formats).find(([k]) => k.startsWith("application/pdf")) : null;
      if (pdf && pdf[1]) {
        return { pdf: "", pdfUrl: pdf[1], pdfSource: "Project Gutenberg", pdfNote: "Free public-domain PDF. Opens online." };
      }
    } catch {
      /* no Gutenberg copy */
    }

    if (access === "borrowable") {
      return { pdf: "", pdfUrl: "", pdfSource: "", pdfNote: "Free to borrow on Open Library, but not downloadable." };
    }
    return { pdf: "", pdfUrl: "", pdfSource: "", pdfNote: "No free legal download found." };
  }

  async function lookupISBN(isbn) {
    try {
      const found = await lookupOpenLibrary(isbn);
      if (found) return found;
    } catch {
      /* try the next source */
    }
    try {
      const found = await lookupGoogleBooks(isbn);
      if (found && found.title) return found;
    } catch {
      /* both sources failed */
    }
    return null;
  }

  /* ---------------- book shape ---------------- */

  function cleanISBN(value) {
    return String(value || "").replace(/[^0-9Xx]/g, "").toUpperCase();
  }

  function isValidISBN(isbn) {
    return isbn.length === 10 || isbn.length === 13;
  }

  function makeBook(record) {
    const subjects = record.subjects || [];
    const title = String(record.title || "Untitled");
    return {
      id: uid(),
      isbn: record.isbn || "",
      title,
      authors: record.authors && record.authors.length ? record.authors : ["Unknown author"],
      genre: record.genre ? String(record.genre).slice(0, 60) : classify(subjects, title),
      year: record.year || "",
      publisher: record.publisher || "",
      pages: record.pages || null,
      cover: record.cover || generatedCover(title, (record.authors || [])[0]),
      subjects,
      source: record.source || "Manual entry",
      loanedTo: record.loanedTo || "",
      loanedAt: record.loanedAt || "",
      dueAt: record.dueAt || "",
      pdf: record.pdf || "",
      pdfUrl: record.pdfUrl || "",
      pdfSource: record.pdfSource || "",
      pdfNote: record.pdfNote || "",
      status: ["unread", "reading", "finished", "abandoned"].includes(record.status) ? record.status : "",
      rating: Math.max(0, Math.min(5, Math.trunc(Number(record.rating) || 0))),
      tags: Array.isArray(record.tags)
        ? record.tags.map((t) => String(t).trim().slice(0, 30)).filter(Boolean).slice(0, 20)
        : [],
      notes: String(record.notes || "").slice(0, 5000),
      quotes: String(record.quotes || "").slice(0, 5000),
      addedAt: new Date().toISOString(),
      count: 1,
      shelf: String(record.shelf || "").trim().slice(0, 24),
      row: String(record.row || "").trim().slice(0, 24),
      slot: String(record.slot || "").trim().slice(0, 24),
    };
  }

  function normalize(book) {
    return {
      ...book,
      id: book.id || uid(),
      authors: book.authors && book.authors.length ? book.authors : ["Unknown author"],
      genre: book.genre || "Other",
      subjects: book.subjects || [],
      count: Math.max(1, Number(book.count) || 1),
      shelf: String(book.shelf || "").trim().slice(0, 24),
      row: String(book.row || "").trim().slice(0, 24),
      slot: String(book.slot || "").trim().slice(0, 24),
    };
  }

  /* ---------------- first run: adopt the books bundled with the app ------- */

  async function seedOnce() {
    if (localStorage.getItem(KEY)) return;
    try {
      const res = await fetch(SEED, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.books) && data.books.length) writeBooks(data.books.map(normalize));
    } catch {
      /* no bundled library, start empty */
    }
  }

  /* ---------------- api ---------------- */

  function parseBody(opts) {
    if (!opts || !opts.body) return {};
    if (typeof opts.body === "string") {
      try {
        return JSON.parse(opts.body);
      } catch {
        return {};
      }
    }
    return opts.body;
  }

  async function handle(path, opts) {
    const method = String((opts && opts.method) || "GET").toUpperCase();
    const body = parseBody(opts);
    const books = readBooks();

    if (method === "GET" && path === "/api/health") return { ok: true, mode: "device" };
    if (method === "GET" && path === "/api/features") {
      return {
        needsPin: false,
        announcement: null,
        features: [
          { key: "audiobook", label: "Read aloud", description: "Offline voice narration in the PDF reader.", enabled: false },
          { key: "loans", label: "Loans", description: "Who borrowed a book, the dates and an on-loan badge.", enabled: true },
          { key: "readingTracker", label: "Reading tracker", description: "Status, rating, tags, notes and quotes.", enabled: true },
          { key: "multiScan", label: "Multi-scan", description: "Keep the camera open and add several books in a row.", enabled: true },
          { key: "pdfLookup", label: "Free PDF copies", description: "Find, download and read free legal PDFs.", enabled: true },
          { key: "filters", label: "Filter and sort", description: "Filter by genre, status or loan, and sort the shelf.", enabled: true },
          { key: "shelfLocation", label: "Shelf location", description: "Shelf, row and slot for each physical copy.", enabled: true },
        ],
      };
    }
    if (path.indexOf("/api/dev/") === 0) throw fail("Developer controls need the computer.", 403);
    if (method === "GET" && path === "/api/books") return { books };
    if (method === "GET" && path === "/api/genres") {
      const used = books.map((b) => b.genre).filter(Boolean);
      const extra = used.filter((g, i) => GENRES.indexOf(g) === -1 && used.indexOf(g) === i)
        .sort((a, b) => a.localeCompare(b));
      return { genres: GENRES.concat(extra) };
    }

    if (method === "GET" && path === "/api/export") {
      return { app: "ShelfScout", version: 1, exportedAt: new Date().toISOString(), books };
    }

    if (method === "POST" && path === "/api/import") {
      const incoming = Array.isArray(body.books) ? body.books : [];
      const byId = new Set(books.map((b) => b.id));
      const byKey = new Set(books.map((b) => `${b.isbn || ""}|${String(b.title || "").toLowerCase()}`));
      const next = books.slice();
      let added = 0;
      let skipped = 0;
      for (const raw of incoming) {
        if (!raw || !String(raw.title || "").trim()) {
          skipped += 1;
          continue;
        }
        const key = `${raw.isbn || ""}|${String(raw.title).toLowerCase()}`;
        if (byKey.has(key) || (raw.id && byId.has(String(raw.id)))) {
          skipped += 1;
          continue;
        }
        const book = normalize({
          ...raw,
          id: raw.id && !byId.has(String(raw.id)) ? String(raw.id) : uid(),
          title: String(raw.title).trim(),
          count: Math.max(1, Math.trunc(Number(raw.count) || 1)),
          addedAt: raw.addedAt || new Date().toISOString(),
        });
        next.push(book);
        byId.add(book.id);
        byKey.add(key);
        added += 1;
      }
      if (added) writeBooks(next);
      return { added, skipped, total: next.length };
    }

    if (method === "GET" && path.indexOf("/api/lookup") === 0) {
      const query = new URL(path, "https://x").searchParams;
      const isbn = cleanISBN(query.get("isbn"));
      if (!isValidISBN(isbn)) throw fail("That barcode is not a valid ISBN.", 400);
      const found = await lookupISBN(isbn);
      if (!found) throw fail("No online record for this ISBN.", 404);
      return { found: true, record: found, genre: classify(found.subjects, found.title) };
    }
    if (method === "GET" && path === "/api/urls") {
      return { local: null, public: null, permanent: false, apk: null, phones: [] };
    }

    if (method === "POST" && path === "/api/scan") {
      const isbn = cleanISBN(body.isbn);
      if (!isValidISBN(isbn)) throw fail("That barcode is not a valid ISBN.", 400);
      const existing = books.find((b) => b.isbn === isbn);
      if (existing) return { book: existing, existed: true, needsConfirm: true };
      const found = await lookupISBN(isbn);
      if (!found) throw fail("No online record for this ISBN.", 404);
      const book = makeBook(found);
      Object.assign(book, await findFreePDFOnline(book));
      writeBooks(books.concat(book));
      return { book, existed: false };
    }

    if (method === "POST" && path === "/api/books") {
      if (!body.title || !String(body.title).trim()) throw fail("A title is required.", 400);
      const isbn = cleanISBN(body.isbn);
      let record = {
        isbn: isValidISBN(isbn) ? isbn : "",
        title: String(body.title).trim(),
        authors: String(body.author || "")
          .split(/[,;&]| and /)
          .map((a) => a.trim())
          .filter(Boolean),
        subjects: [],
        cover: "",
        year: "",
        publisher: "",
        source: "Manual entry",
      };
      if (record.isbn) {
        const dup = books.find((b) => b.isbn === record.isbn);
        if (dup) return { book: dup, existed: true, needsConfirm: true };
        const found = await lookupISBN(record.isbn);
        if (found) {
          record = {
            ...found,
            title: record.title || found.title,
            authors: record.authors.length ? record.authors : found.authors,
          };
        }
      }
      if (typeof body.cover === "string" && body.cover.trim()) record.cover = body.cover.trim();
      const manualGenre = String(body.genre || "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (manualGenre) record.genre = manualGenre;
      const book = makeBook(record);
      Object.assign(book, await findFreePDFOnline(book));
      writeBooks(books.concat(book));
      return { book, existed: false };
    }

    const pdfMatch = path.match(/^\/api\/books\/([\w-]+)\/pdf$/);
    if (method === "POST" && pdfMatch) {
      const idx = books.findIndex((b) => b.id === pdfMatch[1]);
      if (idx === -1) throw fail("Book not found.", 404);
      if (!books[idx].pdf && !books[idx].pdfUrl) {
        books[idx] = { ...books[idx], ...(await findFreePDFOnline(books[idx])) };
        writeBooks(books);
      }
      return { book: books[idx] };
    }

    let match = path.match(/^\/api\/books\/([\w-]+)\/copy$/);
    if (method === "POST" && match) {
      const idx = books.findIndex((b) => b.id === match[1]);
      if (idx === -1) throw fail("Book not found.", 404);
      const delta = Number(body.delta);
      const step = Number.isFinite(delta) && delta !== 0 ? Math.trunc(delta) : 1;
      const count = Math.max(1, (books[idx].count || 1) + step);
      books[idx] = { ...books[idx], count };
      writeBooks(books);
      return { book: books[idx] };
    }

    match = path.match(/^\/api\/books\/([\w-]+)$/);
    if (method === "PUT" && match) {
      const idx = books.findIndex((b) => b.id === match[1]);
      if (idx === -1) throw fail("Book not found.", 404);
      const patch = {};
      if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
      if (typeof body.author === "string") {
        patch.authors = body.author
          .split(/[,;&]| and /)
          .map((a) => a.trim())
          .filter(Boolean);
        if (!patch.authors.length) patch.authors = ["Unknown author"];
      }
      const editedGenre = String(body.genre || "").trim().replace(/\s+/g, " ").slice(0, 60);
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
      if (Array.isArray(body.subjects)) {
        patch.subjects = body.subjects.map((s) => String(s).trim()).filter(Boolean);
      }
      if (typeof body.cover === "string") patch.cover = body.cover.trim();
      if (typeof body.shelf === "string") patch.shelf = body.shelf.trim().slice(0, 24);
      if (typeof body.row === "string") patch.row = body.row.trim().slice(0, 24);
      if (typeof body.slot === "string") patch.slot = body.slot.trim().slice(0, 24);
      if (body.count !== undefined) {
        const count = Number(body.count);
        if (Number.isFinite(count) && count >= 1) patch.count = Math.trunc(count);
      }
      if (typeof body.loanedTo === "string") {
        const who = body.loanedTo.trim().slice(0, 80);
        patch.loanedTo = who;
        if (!who) {
          patch.loanedAt = "";
          patch.dueAt = "";
        }
      }
      if (typeof body.loanedAt === "string") patch.loanedAt = body.loanedAt.trim().slice(0, 10);
      if (typeof body.dueAt === "string") patch.dueAt = body.dueAt.trim().slice(0, 10);
      if (typeof body.status === "string" && ["", "unread", "reading", "finished", "abandoned"].includes(body.status)) {
        patch.status = body.status;
      }
      if (body.rating !== undefined) {
        const rating = Number(body.rating);
        patch.rating = Number.isFinite(rating) ? Math.max(0, Math.min(5, Math.trunc(rating))) : 0;
      }
      if (Array.isArray(body.tags)) {
        patch.tags = body.tags.map((t) => String(t).trim().slice(0, 30)).filter(Boolean).slice(0, 20);
      }
      if (typeof body.notes === "string") patch.notes = body.notes.slice(0, 5000);
      if (typeof body.quotes === "string") patch.quotes = body.quotes.slice(0, 5000);
      books[idx] = { ...books[idx], ...patch, editedAt: new Date().toISOString() };
      writeBooks(books);
      return { book: books[idx] };
    }

    if (method === "DELETE" && match) {
      const next = books.filter((b) => b.id !== match[1]);
      if (next.length === books.length) throw fail("Book not found.", 404);
      writeBooks(next);
      return { ok: true };
    }

    throw fail("Unknown endpoint", 404);
  }

  /* ---------------- boot ---------------- */

  async function probing() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch("/api/health", { signal: ctrl.signal, cache: "no-store" });
      if (!res.ok) return false;
      const data = await res.json();
      return Boolean(data && data.ok && (data.mode === "server" || data.mode === undefined));
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get active() {
      return active;
    },
    get genres() {
      return GENRES.slice();
    },
    handle,
    async init(forceOffline) {
      if (forceOffline) {
        active = true;
        return active;
      }
      active = !(await probing());
      if (active) await seedOnce();
      return active;
    },
  };
})();
