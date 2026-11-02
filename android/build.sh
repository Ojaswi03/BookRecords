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

# The whole web app ships inside the APK, so the phone needs no server.
cp -R "$ROOT/public" "$ROOT/android/assets/www"
rm -rf "$ROOT/android/assets/www/download"
# Start the phone with the books already in the computer's library.
if [ -f "$ROOT/data/library.json" ]; then
  cp "$ROOT/data/library.json" "$ROOT/android/assets/www/seed.json"
fi

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
  -classpath "$PLATFORM" \
  -d "$WORK/classes" \
  $(find "$WORK/gen" "$ROOT/android/src" -name '*.java')

"$BT/d8" --lib "$PLATFORM" --min-api 24 --output "$WORK/dex" \
  $(find "$WORK/classes" -name '*.class')

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
