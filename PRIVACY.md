<!-- BEFORE PUBLISHING: fill in the contact address and the country in the last
     section. This is a template, not legal advice. -->

# Privacy Policy

Last updated: 1 November 2026

ShelfScout (also published as BookRecords) is a local-first book library. It has
no user accounts, no analytics, no advertising and no tracking. This policy
describes the only data the app touches.

## What stays on your device

- **Your library.** Titles, authors, genres, ISBNs, covers, subjects, copy counts
  and notes are stored in `data/library.json` on the computer running the server,
  or in the app's local storage on a phone that runs without a server. They are
  not sent anywhere except as described below.
- **Camera images.** The scanner reads the barcode in memory and closes the
  camera. Frames are never recorded, stored or uploaded.
- **Your phone link and settings.** `data/settings.json` and `certs/` stay on the
  computer. The HTTPS certificate is generated locally.

## What is sent to third parties

- **ISBN lookups.** When you scan or add a book, the ISBN is sent to Open Library
  (`openlibrary.org`) and, if that fails, Google Books (`googleapis.com`) to fetch
  the title, author, cover and subjects. Those requests come from your device or
  your computer, so those services see your IP address and the ISBN. Their own
  privacy policies apply.
- **Cover images.** Covers are loaded from the URL those services return, usually
  `covers.openlibrary.org`. That request also reveals your IP address to that
  host.
- **Remote phone access (optional).** If you use the printed phone link, traffic
  between the phone and the computer passes through an ngrok tunnel, which is
  operated by ngrok. The library data in that traffic is encrypted by HTTPS, but
  ngrok can see connection metadata. If you do not want this, use the app on the
  same Wi-Fi network or use the on-device library with no server.
- **GitHub (optional).** The Android app checks GitHub Releases for a newer
  version. That request reveals your IP address to GitHub and nothing else.
  You can ignore updates; the app works without that check.

## What is not collected

No names, no email addresses, no accounts, no passwords, no location, no contact
list, no advertising identifiers. No analytics SDK, no crash reporting service,
no tracking pixels.

The server prints request information to its own terminal while it runs. That log
stays on your computer and is not uploaded.

## Children

The app is not directed at children and does not knowingly collect personal
information from anyone.

## Data retention and deletion

Your library stays until you delete it. Remove `data/library.json` on the
computer, or clear the app's storage on the phone, and the records are gone.
Uninstalling the Android app removes its on-device library. Because there is no
account or server-side copy, deletion is immediate and cannot be undone.

Export anything you want to keep before clearing it.

## Your rights

Because the app holds no personal data on any server operated by the copyright
holder, there is nothing for that party to export, correct or erase on your
behalf. Requests about data held by Open Library, Google, ngrok or GitHub should
go to those providers.

## Changes

This policy may be updated. The current version is always in this repository,
with the date at the top.

## Contact

Privacy enquiries: REPLACE-WITH-YOUR-EMAIL
