#!/bin/sh
# Packages the app into /Applications/Onebox.app (or $OUT). It must be a real .app:
# macOS does not show notifications from a bare Electron.
set -e
cd "$(dirname "$0")"
npm install --no-audit --no-fund
# with ignore-scripts the Electron binary is not downloaded by npm
[ -d node_modules/electron/dist/Electron.app ] || node node_modules/electron/install.js
OUT="${OUT:-/Applications/Onebox.app}" # one place only: a second copy elsewhere would show up as a second icon
rm -rf "$OUT"
ditto node_modules/electron/dist/Electron.app "$OUT"
mkdir -p "$OUT/Contents/Resources/app"
cp package.json main.js preload.js filter.js i18n.js tabs.html settings.html "$OUT/Contents/Resources/app/"
cp -R assets "$OUT/Contents/Resources/app/"
P="$OUT/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string dev.stek.onebox "$P"
plutil -insert LSUIElement -bool true "$P" # no Dock icon
plutil -replace CFBundleName -string Onebox "$P"
plutil -replace CFBundleDisplayName -string Onebox "$P"
# app icon = logo (it is what notifications show)
ICONSET="$(mktemp -d)/onebox.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s assets/logo.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) assets/logo.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$OUT/Contents/Resources/electron.icns"
# a local "Onebox Dev" certificate keeps one identity across builds, so macOS remembers folder permissions
ID=-; security find-identity -p codesigning | grep -q '"Onebox Dev"' && ID="Onebox Dev"
codesign --force --deep --sign "$ID" "$OUT"
echo "ok: $OUT"
