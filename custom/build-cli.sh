#!/usr/bin/env bash
# Build the linux-x64 server archive from the custom branch: the same layout the npm
# package @t3code/t3-linux-x64 installs (t3, client/, resource-monitor/, node_modules/).
# Pandora runs that layout. See custom/pandora.md for the deploy.
#
#   custom/build-cli.sh                 # version <last release>-custom.<short sha>
#   custom/build-cli.sh 0.0.45-custom.1 # a version of your choice
#
# Writes release/cli/t3-<version>-linux-x64.tar.gz.
set -euo pipefail
cd "$(dirname "$0")/.."

# The crates use Rust edition 2024. Ubuntu's packaged cargo is too old, so use rustup's.
export PATH="$HOME/.cargo/bin:$PWD/node_modules/.bin:$PATH"
# shellcheck disable=SC1091
source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
nvm use 24 >/dev/null
# npm's registry is unreachable over IPv6 on some networks; pnpm then stalls.
export NODE_OPTIONS="--dns-result-order=ipv4first"

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
  git checkout -q -- pnpm-lock.yaml apps/server/package.json apps/desktop/package.json \
    apps/web/package.json packages/contracts/package.json
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
# The single executable needs a Node with --build-sea (25.7+), as in CI. Only this step uses it.
# Keep in step with SEA_NODE_VERSION in apps/server/vite.config.ts.
nvm install 26.8.2 >/dev/null
nvm use 26.8.2 >/dev/null
node apps/server/scripts/cli.ts build-exe
nvm use 24 >/dev/null

echo "==> Packing release/cli/t3-$version-linux-x64.tar.gz"
rm -rf release/cli
# The archive installs the native externals without a lockfile, so a newer node-pty beta than the
# patched one can resolve. The node-pty patch only touches Windows code.
export npm_config_allow_unused_patches=true pnpm_config_allow_unused_patches=true
node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" \
  --resource-monitor-dir "$monitor_dir" --output-dir release/cli
node scripts/smoke-cli-archive.ts --archive "release/cli/t3-$version-linux-x64.tar.gz" \
  --expect-version "$version"
echo "==> Built release/cli/t3-$version-linux-x64.tar.gz"
