# Build environment for custom/build-cli.sh where the host is too old (pandora: Debian 11,
# glibc 2.31; the repo's dev tools need glibc 2.34). See custom/pandora.md, step 1.
# Keep Node equal to package.json "engines" and pnpm equal to "packageManager".
FROM node:26.12.1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends patchelf \
  && rm -rf /var/lib/apt/lists/*
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
# Node 26 no longer ships corepack.
RUN npm install -g pnpm@12.14.0
RUN git config --system --add safe.directory '*'
