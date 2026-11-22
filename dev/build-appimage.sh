#!/usr/bin/env bash
set -euo pipefail

deb=$1
output=$2
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
appdir="$temporary/Strata.AppDir"
tool="$temporary/appimagetool"

case $(uname -m) in
    x86_64) checksum=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0 ;;
    *) echo "The Strata AppImage targets Linux x64." >&2; exit 1 ;;
esac
curl -fsSL --retry 3 https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage -o "$tool"
printf '%s  %s\n' "$checksum" "$tool" | sha256sum -c -
chmod +x "$tool"

dpkg-deb --extract "$deb" "$appdir"
# Match Tauri's AppImage bundle marker so the updater selects the AppImage asset
# even though this executable was originally packaged for Debian.
binary="$appdir/usr/bin/strata"
grep -aFq '__TAURI_BUNDLE_TYPE_VAR_DEB' "$binary"
LC_ALL=C sed -i 's/__TAURI_BUNDLE_TYPE_VAR_DEB/__TAURI_BUNDLE_TYPE_VAR_APP/g' "$binary"
ln -s usr/share/applications/Strata.desktop "$appdir/Strata.desktop"
ln -s usr/share/icons/hicolor/128x128/apps/strata.png "$appdir/strata.png"
cat > "$appdir/AppRun" <<'RUN'
#!/bin/sh
set -eu
appdir=$(dirname "$(readlink -f "$0")")
exec "$appdir/usr/bin/strata" "$@"
RUN
chmod +x "$appdir/AppRun"

ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$tool" --no-appstream "$appdir" "$temporary/Strata.AppImage"
size=$(stat -c %s "$temporary/Strata.AppImage")
if ((size >= 35000000)); then
    echo "The Strata AppImage is $size bytes and exceeds the 35 MB budget." >&2
    exit 1
fi
install -m 755 "$temporary/Strata.AppImage" "$output"
printf 'AppImage size %s bytes\n' "$size"
