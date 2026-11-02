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
| `android/AndroidManifest.xml`, `android/src/**`, `android/libs/**`, app name or icon | `npm run apk` (or `npm run release` to publish) | APK only. |
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

The Android reading page, listening sentence, voice, style and speed are kept in the phone's private app storage. Deleting a book removes them. PDF text used for reading aloud stays on the phone.

## Backup and restore

Use the **Backup** button to save the library as JSON (covers included) or as CSV for a spreadsheet. Restoring reads a JSON backup and adds the books it does not already have, so importing the same file twice changes nothing.

On the phone the file is written to `Downloads/ShelfScout/`. In a browser or the desktop app it goes to your normal download folder. Copy the JSON to the other device and import it there to move a phone library to the computer with no server.

## Loans

Open a book and fill in **Lent to** and, if you want, **Due back**. The book keeps its shelf position, and its row shows who has it and the due date. **Mark returned** clears the loan.

## Reading tracker

Edit a book to set its **status** (Unread, Reading, Finished or Abandoned), a **rating** from one to five stars, any number of **free tags** such as `signed`, `reference` or `to read next`, plus **notes** and **quotes**. Status, rating and the first few tags appear on the shelf row, and all of them can be searched. Tags are separate from genre, so one book can be both "Science Fiction" and "signed".

When a book has a PDF, the book screen shows how far you have read: the saved page, the total pages, and a progress bar. The button changes to **Continue reading**. The native reader saves the page on every turn, so closing and reopening returns to that page. In the reader, the page counter is a button: tap it, type a page number and press **Go** to jump straight there. Deleting the book removes its saved reading position too.

## Scanning several books

In the scan window, turn on **Keep scanning after each book**. After a book is added, the camera stays open and a running count shows how many you have added. Point at the next barcode, and close the window when the stack is done; the last book is highlighted with its shelf position. If a barcode is a book you already own, scanning pauses for the "another copy or a mistake?" question rather than silently changing the count.

Covers are cached on each device after they first load, so the shelf still shows them with no internet. Covers uploaded from a file are stored small to keep the library file lean.

## Free PDFs

When a book is added, ShelfScout looks for a free, legal copy: public-domain scans on Internet Archive and PDFs published by Project Gutenberg. A public-domain PDF is downloaded once into `data/pdfs/` and served with the app, and the book gets a PDF badge. Books with no free copy say so in the book view; borrowable or paid titles are never downloaded, and copyrighted copies on file-sharing sites are not searched for.

Tapping a book opens its cover, with **Read PDF** (only when a copy exists) and **Edit info**. On Android the PDF opens in ShelfScout's own full-screen reader; in a browser or the desktop app it opens in an overlay inside the app. For a book added before this feature, use **Find a free PDF** to try again.

Deleting a book removes its PDF from `data/pdfs/`, its cached copy on each device, its cached cover and the book's entries in the automatic backups.

If **Read PDF** opens Chrome, the phone is running an older APK. The reader is native code and cannot arrive through **Update app files**. Install the latest APK once. In the Android app the footer shows `App vN · files vN`, so the two versions are easy to compare.

Long-pressing a text field in the app selects text and opens Android's Copy / Paste menu. The app's own options (connect to a computer, use this phone, reset app files) are on **App settings** in the footer, so the WebView no longer intercepts long presses.

The PDF reader remembers the page you stopped on for each book, and opens there next time. The book screen shows that page in a progress bar, and the reader's page counter can be tapped to jump to any page. Deleting a book removes that saved position too.

CSV backups include the reading status, rating, tags, notes and quotes, so the spreadsheet copy matches what the app shows.

## Offline reading aloud

The Android app can read a PDF aloud with the phone's own text-to-speech engine. It is free, works without internet, and needs no account or API key. Open a book with a PDF and tap **Listen**, from the book screen or from the PDF reader.

The first tap asks for an installed English offline voice, a style and a speed. The styles are Normal, Gentle, Calm, Explaining and Aggressive. They change the pace and pitch of the phone's voice; they are not acted emotions like a paid cloud voice. Male and female labels appear only when the phone's voice names include that information. Android decides which voices are installed, and a missing voice can be added from **Voice settings**.

Playback continues with the screen off and shows controls in the notification and on the lock screen. Headphones and Bluetooth are handled, and unplugging headphones pauses the book. The current page and sentence are saved, the PDF page turns as the audio moves, and the book resumes there next time.

A long PDF can take a few seconds to prepare the first time. The app extracts the text layer on the phone. Image-only scans have no text layer and are not supported yet; OCR is the next step. Deleting a book stops playback and removes its saved listening position.

`PdfBox-Android`, an Apache 2.0 library, extracts the text. The full notice is in [THIRD-PARTY.md](THIRD-PARTY.md).

## Refreshing

Drag down from the top of the shelf and release to reload the app on a phone, without closing it.

## Licence and legal

This is paid, proprietary software. Reading the source does not grant the right to use it.

- [LICENSE](LICENSE) - what is and is not permitted
- [TERMS.md](TERMS.md) - terms and conditions of use
- [PRIVACY.md](PRIVACY.md) - what the app does with your data
- [THIRD-PARTY.md](THIRD-PARTY.md) - the PDF text library and its Apache 2.0 license

For a licence, contact the copyright holder listed in `LICENSE`.
