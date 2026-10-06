#!/usr/bin/env bash
# Rebase the custom patches onto an upstream release, build the AppImage and install it.
#
#   custom/update.sh            # newest stable release tag
#   custom/update.sh v0.0.46    # a specific tag or ref
#
# The `custom` branch is the patch: every commit on top of the upstream tag is ours.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTALL_PATH="${T3CODE_CUSTOM_INSTALL_PATH:-$HOME/Applications/T3-Code-custom.AppImage}"

# The crates use Rust edition 2024. Ubuntu's packaged cargo is too old, so use rustup's.
export PATH="$HOME/.cargo/bin:$PATH"

missing=()
if ! command -v rustup >/dev/null; then
  echo "rustup is missing. Install it with:" >&2
  echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal" >&2
  exit 1
fi
command -v pkg-config >/dev/null || missing+=(pkg-config)
pkg-config --exists libsecret-1 2>/dev/null || missing+=(libsecret-1-dev)
command -v magick >/dev/null || command -v convert >/dev/null || missing+=(imagemagick)
if ((${#missing[@]})); then
  echo "Missing build tools. Install them with:" >&2
  echo "  sudo apt-get install ${missing[*]}" >&2
  exit 1
fi

# shellcheck disable=SC1091
source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
nvm use 24 >/dev/null
# npm's registry is unreachable over IPv6 on some networks; pnpm then stalls.
export NODE_OPTIONS="--dns-result-order=ipv4first"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash first." >&2
  exit 1
fi

# pnpm rewrites deprecation notes in the lockfile during the build. That is never part of the patch.
trap 'git checkout -q -- pnpm-lock.yaml' EXIT

git fetch upstream --tags --prune
target="${1:-$(git tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1)}"
echo "==> Rebasing custom onto $target"
git checkout -q custom
if ! git rebase "$target"; then
  echo "Rebase stopped on a conflict. Fix it, run 'git rebase --continue', then run this script again." >&2
  exit 1
fi

echo "==> Installing dependencies"
CI=true pnpm install --frozen-lockfile

echo "==> Building AppImage"
rm -rf release
# The release pipeline stamps the version at build time; do the same for a release tag.
if [[ "$target" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  export T3CODE_DESKTOP_VERSION="${target#v}"
fi
node scripts/build-desktop-artifact.ts --platform linux --target AppImage --arch x64

appimage="$(find release -maxdepth 1 -name '*.AppImage' | head -n1)"
if [[ -z "$appimage" ]]; then
  echo "No AppImage found in release/." >&2
  exit 1
fi
mkdir -p "$(dirname "$INSTALL_PATH")"
install -m 755 "$appimage" "$INSTALL_PATH"
echo "==> Installed $INSTALL_PATH"
echo "Quit T3 Code and start it from that path once. It rewrites its own desktop entry and icon."
