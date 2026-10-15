#!/bin/sh
# Builds the two release assets into dist/:
#  - the full dmg: first install, Homebrew, and updates that change Electron
#  - the app zip: only Onebox's own code, which the in-app updater takes when Electron did not change.
#    Its name carries the Electron version; the updater only uses it when that matches the running one.
set -e
cd "$(dirname "$0")/.."
V=$(node -p "require('./package.json').version")
E=$(node -p "require('./package.json').devDependencies.electron")
rm -rf dist && mkdir -p dist/stage
OUT="$PWD/dist/stage/Onebox.app" ./build.sh
ln -s /Applications dist/stage/Applications
hdiutil create -quiet -volname "Onebox $V" -srcfolder dist/stage -ov -format UDZO "dist/Onebox-$V-arm64.dmg"
ditto -c -k --keepParent dist/stage/Onebox.app/Contents/Resources/app "dist/Onebox-app-$V-electron$E.zip"
shasum -a 256 dist/*.dmg dist/*.zip
