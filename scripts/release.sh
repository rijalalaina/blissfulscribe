#!/bin/bash
# BlissfulScribe release pipeline.
#
# Usage:   scripts/release.sh <version> [release notes]
# Example: scripts/release.sh 3.1 "Fixed dictation lag on macOS 15"
#
# Steps: bump versions → Release build → DMG → Sparkle-sign → update
# website/appcast.xml → GitHub release → commit & push (Pages then serves
# the new appcast at https://scribe.blissfulplan.com/appcast.xml).
#
# Env overrides:
#   BUILD=NNN         build number (default: major*100+minor, e.g. 3.1 → 301)
#   SIGN_IDENTITY=…   codesign identity (default "-" = ad-hoc; Gatekeeper
#                     will warn users until a Developer ID cert is used)
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"
PROJECT="BlissfulScribe.xcodeproj"
SCHEME="BlissfulScribe"
APPCAST="website/appcast.xml"
# Build OUTSIDE the repo: the repo sits in a file-provider-synced folder
# (iCloud/Drive), which stamps FinderInfo xattrs on every written file and
# makes the final codesign fail with "detritus not allowed".
DERIVED="$HOME/Library/Caches/BlissfulScribe-release-build"
DIST="$REPO_ROOT/dist"

VERSION="${1:?Usage: scripts/release.sh <version> [notes]}"
NOTES="${2:-Bug fixes and improvements.}"
BUILD="${BUILD:-$(echo "$VERSION" | awk -F. '{print $1*100+$2}')}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
DMG_NAME="BlissfulScribe-$VERSION.dmg"
TAG="v$VERSION"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

step "Preflight checks"
command -v gh >/dev/null || die "gh CLI not installed"
gh auth status >/dev/null 2>&1 || die "gh not authenticated (run: gh auth login)"
git rev-parse --is-inside-work-tree >/dev/null || die "not a git repository"
[ -f "$APPCAST" ] || die "$APPCAST not found"
gh release view "$TAG" >/dev/null 2>&1 && die "release $TAG already exists on GitHub"
grep -q "sparkle:shortVersionString>$VERSION<" "$APPCAST" && die "$VERSION already in appcast"

SIGN_UPDATE=$(find "$HOME/Library/Developer/Xcode/DerivedData" \
  -path "*artifacts/sparkle/Sparkle/bin/sign_update" 2>/dev/null | head -1)
[ -n "$SIGN_UPDATE" ] || die "Sparkle sign_update not found — open the project in Xcode once so SPM fetches Sparkle"

if [ -n "$(git status --porcelain)" ]; then
  die "working tree not clean — commit or stash first"
fi

step "Bumping versions to $VERSION (build $BUILD)"
CUR_MV=$(xcodebuild -project "$PROJECT" -scheme "$SCHEME" -showBuildSettings 2>/dev/null \
  | awk '$1=="MARKETING_VERSION"{print $3; exit}')
CUR_PV=$(xcodebuild -project "$PROJECT" -scheme "$SCHEME" -showBuildSettings 2>/dev/null \
  | awk '$1=="CURRENT_PROJECT_VERSION"{print $3; exit}')
[ -n "$CUR_MV" ] && [ -n "$CUR_PV" ] || die "could not read current versions from build settings"
sed -i '' "s/MARKETING_VERSION = $CUR_MV;/MARKETING_VERSION = $VERSION;/g" "$PROJECT/project.pbxproj"
sed -i '' "s/CURRENT_PROJECT_VERSION = $CUR_PV;/CURRENT_PROJECT_VERSION = $BUILD;/g" "$PROJECT/project.pbxproj"

step "Building Release ($SCHEME)"
# Finder metadata (xattrs, .DS_Store) on files copied into the bundle makes
# codesign fail with "resource fork … detritus not allowed" — scrub first.
xattr -rc . 2>/dev/null || true
xattr -rc "$HOME/BlissfulScribe-Dependencies/whisper.cpp/build-apple" 2>/dev/null || true
find . "$HOME/BlissfulScribe-Dependencies/whisper.cpp/build-apple" -name ".DS_Store" -delete 2>/dev/null || true
rm -rf "$DERIVED"
if [ "$SIGN_IDENTITY" = "-" ]; then
  # Ad-hoc distribution build — same profile the shipped v3.0 used:
  # sandbox-only entitlements, universal binary, LOCAL_BUILD (no iCloud
  # sync; Sparkle updates still work). Requires no Apple certificate.
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
    -derivedDataPath "$DERIVED" \
    -xcconfig LocalBuild.xcconfig \
    MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
    CODE_SIGN_IDENTITY="-" \
    CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES \
    DEVELOPMENT_TEAM="" \
    CODE_SIGN_ENTITLEMENTS="$REPO_ROOT/BlissfulScribe/BlissfulScribe.local.entitlements" \
    SWIFT_ACTIVE_COMPILATION_CONDITIONS='$(inherited) LOCAL_BUILD' \
    build | tail -5
else
  # Proper Developer ID build with full entitlements (iCloud sync enabled).
  xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
    -derivedDataPath "$DERIVED" \
    MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
    CODE_SIGN_IDENTITY="$SIGN_IDENTITY" \
    CODE_SIGNING_REQUIRED=YES CODE_SIGNING_ALLOWED=YES \
    build | tail -5
fi
APP="$DERIVED/Build/Products/Release/BlissfulScribe.app"
[ -d "$APP" ] || die "build product not found at $APP"

BUILT_V=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP/Contents/Info.plist")
[ "$BUILT_V" = "$VERSION" ] || die "built app reports version $BUILT_V, expected $VERSION"

step "Packaging $DMG_NAME"
mkdir -p "$DIST"
STAGING=$(mktemp -d)
ditto "$APP" "$STAGING/BlissfulScribe.app"
ln -s /Applications "$STAGING/Applications"
rm -f "$DIST/$DMG_NAME"
hdiutil create -volname "BlissfulScribe" -srcfolder "$STAGING" -ov -format UDZO "$DIST/$DMG_NAME" >/dev/null
rm -rf "$STAGING"

step "Sparkle-signing the DMG"
SIG_OUTPUT=$("$SIGN_UPDATE" "$DIST/$DMG_NAME")
ED_SIG=$(echo "$SIG_OUTPUT" | sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p')
LENGTH=$(echo "$SIG_OUTPUT" | sed -n 's/.*length="\([^"]*\)".*/\1/p')
[ -n "$ED_SIG" ] && [ -n "$LENGTH" ] || die "could not parse sign_update output: $SIG_OUTPUT"

step "Updating $APPCAST"
export VERSION BUILD ED_SIG LENGTH NOTES DMG_NAME TAG
python3 - "$APPCAST" <<'PYEOF'
import html, os, sys
from email.utils import formatdate

path = sys.argv[1]
v, b = os.environ["VERSION"], os.environ["BUILD"]
notes = html.escape(os.environ["NOTES"])
url = f"https://github.com/rijalalaina/blissfulscribe/releases/download/{os.environ['TAG']}/{os.environ['DMG_NAME']}"
item = f"""        <item>
            <title>{v}</title>
            <description><![CDATA[
                <h3>BlissfulScribe {v}</h3>
                <p>{notes}</p>
            ]]></description>
            <pubDate>{formatdate(usegmt=True)}</pubDate>
            <sparkle:version>{b}</sparkle:version>
            <sparkle:shortVersionString>{v}</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>14.4</sparkle:minimumSystemVersion>
            <enclosure url="{url}" length="{os.environ['LENGTH']}" type="application/octet-stream" sparkle:edSignature="{os.environ['ED_SIG']}"/>
        </item>
"""
src = open(path).read()
marker = "        <item>"
src = src.replace(marker, item + marker, 1) if marker in src else src.replace("    </channel>", item + "    </channel>", 1)
open(path, "w").write(src)

import xml.etree.ElementTree as ET
ET.parse(path)  # dies loudly if the result is not valid XML
print(f"appcast: added {v} (build {b})")
PYEOF

step "Creating GitHub release $TAG"
gh release create "$TAG" "$DIST/$DMG_NAME" \
  --title "BlissfulScribe $VERSION" --notes "$NOTES"

step "Committing and pushing"
git add "$PROJECT/project.pbxproj" "$APPCAST"
git commit -m "Release $TAG"
git push origin "$(git branch --show-current)"

step "Done"
echo "  • GitHub release: https://github.com/rijalalaina/blissfulscribe/releases/tag/$TAG"
echo "  • Appcast deploys with the Cloudflare Pages build (~1 min):"
echo "      https://scribe.blissfulplan.com/appcast.xml"
echo "  • Existing users get the update via Sparkle within ~4 h (or Check for Updates)."
if [ "$SIGN_IDENTITY" = "-" ]; then
  echo "  • NOTE: ad-hoc signed — new users must right-click → Open on first launch."
  echo "    Get an Apple Developer ID cert and pass SIGN_IDENTITY='Developer ID Application: …' to fix."
fi
