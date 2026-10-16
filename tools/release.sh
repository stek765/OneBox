#!/bin/sh
# Builds the release assets into dist/:
#  - the full dmg: first install, Homebrew, and updates that change Electron
#  - the app zip: only Onebox's own code, which the in-app updater takes when Electron did not change.
#    Its name carries the Electron version; the updater only uses it when that matches the running one.
#  - the signed zip, when built with the "Onebox Dev" certificate: the whole bundle minus Electron, signature included,
#    so a certificate-signed app updates without re-signing and keeps its identity. The app zip stays for <= 0.3.7.
set -e
cd "$(dirname "$0")/.."
V=$(node -p "require('./package.json').version")
E=$(node -p "require('./package.json').devDependencies.electron")
rm -rf dist && mkdir -p dist/stage
OUT="$PWD/dist/stage/Onebox.app" ./build.sh
ln -s /Applications dist/stage/Applications
hdiutil create -quiet -volname "Onebox $V" -srcfolder dist/stage -ov -format UDZO "dist/Onebox-$V-arm64.dmg"
ditto -c -k --keepParent dist/stage/Onebox.app/Contents/Resources/app "dist/Onebox-app-$V-electron$E.zip"
if codesign -dr - dist/stage/Onebox.app 2>&1 | grep -q 'certificate leaf'; then
  mkdir dist/signed && rsync -a --exclude Frameworks dist/stage/Onebox.app/Contents dist/signed/
  ditto -c -k --keepParent dist/signed/Contents "dist/Onebox-signed-$V-electron$E.zip"
fi
shasum -a 256 dist/*.dmg dist/*.zip
