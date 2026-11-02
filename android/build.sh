#!/usr/bin/env bash
# Builds a signed ShelfScout APK with the Android build tools directly -
# no Gradle, no Android Studio required.
#
# Needs: JDK 17+, Android SDK platform 34 + build-tools 34.0.0.
# Set ANDROID_HOME (or ANDROID_SDK_ROOT) to the SDK path; /tmp/sdk is used if not set.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/tmp/sdk}}"
# d8 in build-tools 34 crashes on classes produced by JDK 21; 35+ handles them.
BT="$SDK/build-tools/35.0.0"
[ -x "$BT/aapt2" ] || BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"

if [ ! -x "$BT/aapt2" ] || [ ! -f "$PLATFORM" ]; then
  echo "Android SDK 34 not found at: $SDK" >&2
  echo "Install it, or point ANDROID_HOME at your SDK, then run again." >&2
  exit 1
fi

WORK="$ROOT/android/build"
rm -rf "$WORK" "$ROOT/android/assets"
mkdir -p "$WORK/gen" "$WORK/classes" "$WORK/dex" "$ROOT/android/res/mipmap" "$ROOT/public/download" "$ROOT/android/assets"

# PDF text extraction library, used by the offline reader. The AAR also has
# font resources that PDFBox loads from assets.
PDFBOX_AAR="$ROOT/android/libs/pdfbox-android-2.0.27.0.aar"
if [ ! -f "$PDFBOX_AAR" ]; then
  echo "Missing PDF text library: $PDFBOX_AAR" >&2
  exit 1
fi
mkdir -p "$WORK/pdfbox"
unzip -q "$PDFBOX_AAR" -d "$WORK/pdfbox"
PDFBOX_JAR="$WORK/pdfbox/classes.jar"
if [ ! -f "$PDFBOX_JAR" ]; then
  echo "The PDF text library has no classes.jar" >&2
  exit 1
fi
cp -R "$WORK/pdfbox/assets/." "$ROOT/android/assets/"

# The whole web app ships inside the APK, so the phone needs no server.
cp -R "$ROOT/public" "$ROOT/android/assets/www"
rm -rf "$ROOT/android/assets/www/download"
# Start the phone with the books already in the computer's library.
if [ -f "$ROOT/data/library.json" ]; then
  cp "$ROOT/data/library.json" "$ROOT/android/assets/www/seed.json"
fi
# Which app files are inside this build. The updater compares this number.
# A normal filename, because aapt2 skips dotfiles in assets.
VCODE="$(sed -n 's/.*android:versionCode="\([0-9]*\)".*/\1/p' "$ROOT/android/AndroidManifest.xml" | head -1)"
printf '%s' "$VCODE" > "$ROOT/android/assets/www/webversion.txt"

# The address a fresh install tries by itself, so it goes Live as soon as the
# server is reachable. SHELFSCOUT_SERVER_URL wins; otherwise the permanent
# ngrok link from data/settings.json is used. Empty means phone only.
SERVER_URL="${SHELFSCOUT_SERVER_URL:-}"
if [ -z "$SERVER_URL" ] && [ -f "$ROOT/data/settings.json" ]; then
  SERVER_URL="$(node -e 'const fs=require("fs");try{const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const d=String(s.ngrokDomain||"").trim().replace(/^https?:\/\//i,"").replace(/\/.*$/,"");if(d)process.stdout.write("https://"+d)}catch(e){}' "$ROOT/data/settings.json")"
fi
case "$SERVER_URL" in
  http://*|https://*) ;;
  *) SERVER_URL="" ;;
esac
SERVER_URL="${SERVER_URL%/}"
# Auto-connect is paused for now: every install starts on its own copy. The
# manual Connect to computer button still turns the server on for that session.
SERVER_URL=""
printf '%s' "$SERVER_URL" > "$ROOT/android/assets/www/serverurl.txt"
echo "Live server baked into the app: ${SERVER_URL:-none}"

# Reuse the PWA icon as the launcher icon.
cp "$ROOT/public/icons/icon-512.png" "$ROOT/android/res/mipmap/ic_launcher.png"

echo "1/5  Compiling resources"
"$BT/aapt2" compile --dir "$ROOT/android/res" -o "$WORK/res.zip"

echo "2/5  Linking resources"
"$BT/aapt2" link \
  -o "$WORK/base.apk" \
  -I "$PLATFORM" \
  --manifest "$ROOT/android/AndroidManifest.xml" \
  -R "$WORK/res.zip" \
  -A "$ROOT/android/assets" \
  --java "$WORK/gen" \
  --auto-add-overlay

echo "3/5  Compiling Java + dexing"
javac --release 8 \
  -classpath "$PLATFORM:$PDFBOX_JAR" \
  -d "$WORK/classes" \
  $(find "$WORK/gen" "$ROOT/android/src" -name '*.java')

"$BT/d8" --lib "$PLATFORM" --min-api 24 --output "$WORK/dex" \
  $(find "$WORK/classes" -name '*.class') \
  "$PDFBOX_JAR"

(cd "$WORK/dex" && zip -q "$WORK/base.apk" classes.dex)

echo "4/5  Aligning"
"$BT/zipalign" -f 4 "$WORK/base.apk" "$WORK/aligned.apk"

echo "5/5  Signing"
KS="$ROOT/android/shelfscout.keystore"
# The password never lives in git: put it in android/keystore.pass (ignored) or
# export KEYSTORE_PASS before running the build.
KSPASS="${KEYSTORE_PASS:-$(cat "$ROOT/android/keystore.pass" 2>/dev/null)}"
if [ -z "${KSPASS}" ]; then
  echo "Keystore password missing. Create android/keystore.pass or set KEYSTORE_PASS." >&2
  exit 1
fi

if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -alias shelfscout \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KSPASS" -keypass "$KSPASS" \
    -dname "CN=ShelfScout, OU=Personal, O=ShelfScout, L=Home, ST=Home, C=IN" \
    -noprompt >/dev/null 2>&1
fi

"$BT/apksigner" sign \
  --ks "$KS" --ks-pass "pass:$KSPASS" --key-pass "pass:$KSPASS" \
  --out "$ROOT/public/download/ShelfScout.apk" \
  "$WORK/aligned.apk"

"$BT/apksigner" verify "$ROOT/public/download/ShelfScout.apk"
echo ""
echo "APK ready: public/download/ShelfScout.apk ($(du -h "$ROOT/public/download/ShelfScout.apk" | cut -f1))"
