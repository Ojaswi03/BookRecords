# ShelfScout (BookRecords)

Home library for barcode-scanned books: genre sections, A-Z inside, sorted by the author's last name.
Runs on your computer, in a browser, or entirely on an Android phone with no server.

## Requirements

- Node.js 18 or newer
- For the Android app: JDK 17 or newer, Android SDK platform 34, build-tools 35, and `ANDROID_HOME` set
- ngrok on your PATH only if you want the phone link

## Commands

| Command | What it does |
| --- | --- |
| `npm start` | Start the server. Prints the computer link and the phone link. |
| `Ctrl+C` | Stop the server and its ngrok tunnel. |
| `pkill -f "node server.js"` | Stop it when the terminal is gone. |
| `npm run apk` | Rebuild `public/download/ShelfScout.apk` with the current web files. |
| `npm run release` | Bump the Android version, rebuild the APK, and publish it to GitHub Releases. |
| `npm run link -- <domain>` | Save a permanent ngrok domain (`npm run link -- --clear` to remove it). |
| `npm run icons` | Regenerate the PWA and launcher icons from `scripts/make-icons.mjs`. |

Ports: 8420 is the app, 8421 is the loopback mirror ngrok forwards to, 4040 is ngrok's own API.

## What to run after a change

| You changed | Run | Where it appears |
| --- | --- | --- |
| `public/index.html`, `styles.css`, `app.js`, `offline.js`, `covercache.js`, `sw.js`, `manifest.webmanifest` | `npm run release` to publish | Browser and desktop app on reload. Phone app after tapping **Update app files**, no reinstall. |
| `server.js` | Restart: `Ctrl+C`, then `npm start` | Every connected device. |
| `public/icons/*` | `npm run icons`, then `npm run apk` | PWA and APK. |
| `android/AndroidManifest.xml`, `android/src/**`, app name or icon | `npm run apk` (or `npm run release` to publish) | APK only. |
| `scripts/release.mjs`, `README.md`, `LICENSE`, `TERMS.md`, `PRIVACY.md` | Nothing | Repository only. |
| Books in the app | Nothing | Live on every device while the server runs. The APK picks up `data/library.json` the next time it is built. |

The Android version lives in `android/AndroidManifest.xml`. `npm run release` raises `versionCode` and `versionName` for you and tags the release `v<versionCode>`. Bump `versionCode` on every `npm run apk` that you install over an older copy.

## Never commit

- `data/library.json` and `data/settings.json` (your books and your phone link)
- `certs/` (the HTTPS private key)
- `*.keystore` (the APK signing key)
- `public/download/*.apk` (build output, published as a release asset instead)

All of these are in `.gitignore`.

## GitHub releases and phone updates

`npm run release` builds the APK, packs the current web files into `ShelfScout-web.zip`, and publishes both on a GitHub release tagged `v<versionCode>`. Installed apps read `https://api.github.com/repos/Ojaswi03/BookRecords/releases/latest`, compare the tag with the web files they already have, and show **Update app files (vN)** in the footer. Tapping it downloads the bundle into the app's private storage and reloads: no APK install, and the library is untouched because the page origin never changes. If a download goes wrong, long-press the app and choose **Reset app files** to go back to the copy inside the APK.

An APK install is only needed when the Java code, the manifest or the icon changes, or once on a build older than v6, whose updater only knows how to download an APK.

The repository must be public for this to work, because the app has no GitHub token and private releases return 404. To make it public:

```bash
gh repo edit Ojaswi03/BookRecords --visibility public --accept-visibility-change-consequences
```

If you would rather keep the source private, put the release (the `.apk` file) in a separate public repository and change `REPO` at the top of `public/update.js`, then rebuild.

Users can also update by rebuilding from source: `npm run apk`, then install over the existing app. The signing key must stay the same, or Android rejects the update and the old app has to be uninstalled first.

## Data

The server library is `data/library.json`. The phone app keeps its books in the WebView local storage. With no server, each device has its own shelf; with the server running, every device syncs live.

## Backup and restore

Use the **Backup** button to save the library as JSON (covers included) or as CSV for a spreadsheet. Restoring reads a JSON backup and adds the books it does not already have, so importing the same file twice changes nothing.

On the phone the file is written to `Downloads/ShelfScout/`. In a browser or the desktop app it goes to your normal download folder. Copy the JSON to the other device and import it there to move a phone library to the computer with no server.

## Loans

Open a book and fill in **Lent to** and, if you want, **Due back**. The book keeps its shelf position, and its row shows who has it and the due date. **Mark returned** clears the loan.

Covers are cached on each device after they first load, so the shelf still shows them with no internet. Covers uploaded from a file are stored small to keep the library file lean.

## Free PDFs

When a book is added, ShelfScout looks for a free, legal copy: public-domain scans on Internet Archive and PDFs published by Project Gutenberg. A public-domain PDF is downloaded once into `data/pdfs/` and served with the app, and the book gets a PDF badge. Books with no free copy say so in the book view; borrowable or paid titles are never downloaded, and copyrighted copies on file-sharing sites are not searched for.

Tapping a book opens its cover, with **Read PDF** (only when a copy exists) and **Edit info**. On Android the PDF opens in ShelfScout's own full-screen reader; in a browser or the desktop app it opens in an overlay inside the app. For a book added before this feature, use **Find a free PDF** to try again.

Deleting a book removes its PDF from `data/pdfs/`, its cached copy on each device, its cached cover and the book's entries in the automatic backups.

## Refreshing

Drag down from the top of the shelf and release to reload the app on a phone, without closing it.

## Licence and legal

This is paid, proprietary software. Reading the source does not grant the right to use it.

- [LICENSE](LICENSE) - what is and is not permitted
- [TERMS.md](TERMS.md) - terms and conditions of use
- [PRIVACY.md](PRIVACY.md) - what the app does with your data

For a licence, contact the copyright holder listed in `LICENSE`.
