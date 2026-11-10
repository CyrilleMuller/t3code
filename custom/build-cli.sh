#!/usr/bin/env bash
# Build the linux-x64 server archive from the custom branch: the layout of the upstream
# release asset t3-<version>-linux-x64.tar.gz (t3, client/, lib/, resource-monitor/,
# node_modules/). Pandora runs that layout. See custom/pandora.md for the deploy.
#
#   custom/build-cli.sh                 # version <last release>-custom.<short sha>
#   custom/build-cli.sh 0.1.8-custom.1  # a version of your choice
#
# Writes release/cli/t3-<version>-linux-x64.tar.gz.
#
# Needs: Node exactly as in package.json "engines" (the single executable embeds it),
# pnpm (corepack), rustup's cargo, patchelf. With nvm, the right Node is installed for you.
set -euo pipefail
cd "$(dirname "$0")/.."

# The crates use Rust edition 2024. Ubuntu's packaged cargo is too old, so use rustup's.
export PATH="$HOME/.cargo/bin:$PWD/node_modules/.bin:$PATH"
# npm's registry is unreachable over IPv6 on some networks; pnpm then stalls.
export NODE_OPTIONS="--dns-result-order=ipv4first"

node_version="$(sed -n 's/.*"node": *"\([0-9.]*\)".*/\1/p' package.json | head -1)"
if [[ "$(node --version 2>/dev/null)" != "v$node_version" ]]; then
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm install "$node_version" >/dev/null
    nvm use "$node_version" >/dev/null
  else
    echo "Need Node $node_version (package.json engines), found $(node --version 2>/dev/null || echo none)." >&2
    exit 1
  fi
fi
for tool in cargo patchelf; do
  command -v "$tool" >/dev/null || { echo "$tool is missing." >&2; exit 1; }
done

base="$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*')"
version="${1:-${base#v}-custom.$(git rev-parse --short HEAD)}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or stash first." >&2
  exit 1
fi

# The build stamps the version into the package manifests, and pnpm rewrites deprecation
# notes in the lockfile. Neither is ever part of the patch.
monitor_dir="$(mktemp -d)"
restore() {
  git checkout -q -- pnpm-lock.yaml pnpm-workspace.yaml apps/server/package.json \
    apps/desktop/package.json apps/web/package.json packages/contracts/package.json
  rm -rf "$monitor_dir"
}
trap restore EXIT

echo "==> Installing dependencies"
CI=true pnpm install --frozen-lockfile

# The server reports this version to clients, as a release build does.
node scripts/update-release-package-versions.ts "$version"

echo "==> Building the web client and the server bundle"
vp run --filter t3 build

echo "==> Building the resource monitor"
cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
mkdir -p "$monitor_dir/linux-x64"
cp native/resource-monitor/target/release/t3-resource-monitor "$monitor_dir/linux-x64/"

echo "==> Building the single executable"
node apps/server/scripts/cli.ts build-exe

echo "==> Packing release/cli/t3-$version-linux-x64.tar.gz"
rm -rf release/cli
node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
  --resource-monitor-dir "$monitor_dir" --output-dir release/cli
node scripts/smoke-cli-archive.ts --archive "release/cli/t3-$version-linux-x64.tar.gz" \
  --expect-version "$version"
echo "==> Built release/cli/t3-$version-linux-x64.tar.gz"
