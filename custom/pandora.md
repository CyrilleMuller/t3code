# Run the custom build on pandora

Since 0.1.x the npm package `t3` (`/usr/bin/t3`) is only a launcher. On first run it downloads
the release asset `t3-<version>-linux-x64.tar.gz` from GitHub into the user's `~/.t3` and starts
the `t3` executable in it. `custom/build-cli.sh` builds that same archive from this branch.

The custom build goes next to the npm install, in `/opt/t3-fork`. A systemd drop-in moves a
service to it. Keep the npm package on the same release as the custom build's base, so a
rollback is one file removed.

Restarting a T3 service stops the threads that run in it. Do it only when nobody works in that
instance, and only after Cyrille says yes.

## 1. Build

The result is `release/cli/t3-<version>-linux-x64.tar.gz`, where the version is
`<last release>-custom.<commit>`, for example `0.1.8-custom.31ce8e8fb5`. The script needs a
clean tree, the Node version in `package.json` `engines` (nvm installs it), rustup's cargo and
patchelf.

On the laptop:

```bash
custom/build-cli.sh
```

On pandora, in a container: the repo's dev tools need glibc 2.34, pandora has 2.31. The archive
itself runs on pandora (its natives need glibc 2.30 at most). Use `--network host`: TLS from
Docker's default network times out there. Give the clone its own pnpm store on disk, not `/tmp`
(a RAM disk on pandora).

```bash
docker build --network host -t t3code-build -f custom/build.Dockerfile custom
docker run --rm --network host --memory 5g -v "$PWD:/w" -w /w \
  -v /root/.cache/t3code-build/pnpm-store:/store -e npm_config_store_dir=/store -e CI=1 \
  t3code-build custom/build-cli.sh
```

Commit inside the same image too: the repo's pre-commit hook needs git 2.32.

The resource monitor (`resource-monitor/linux-x64/t3-resource-monitor`) needs glibc 2.34 in
every build, upstream's included, so it has never run on pandora. T3 runs without it.

## 2. Install next to the npm package

From the laptop:

```bash
scp -i ~/.ssh/id_pandora release/cli/t3-<version>-linux-x64.tar.gz root@192.168.0.3:/tmp/
```

On pandora:

```bash
mkdir -p /opt/t3-fork
tar -xzf /tmp/t3-<version>-linux-x64.tar.gz -C /opt/t3-fork
ln -sfn /opt/t3-fork/t3-<version>-linux-x64 /opt/t3-fork/current
/opt/t3-fork/current/t3 --version
```

The family units run as `fam-<name>` with `ProtectSystem=strict`. `/opt` stays readable for them,
so nothing else is needed.

## 3. Move a service to the custom build

For one family instance, Jessica, create
`/etc/systemd/system/t3-person@jessica.service.d/fork.conf`:

```ini
[Service]
ExecStart=
ExecStart=/opt/t3-fork/current/t3 serve --host 127.0.0.1 --port ${PORT} --no-browser --base-dir /home/fam-%i/.t3 --auto-bootstrap-project-from-cwd /srv/people/%i
```

The `ExecStart` line is the one from `t3-person@.service` with only the binary changed. Copy it
again from `systemctl cat t3-person@.service` if the unit changed since.

For all family instances, put the file in `/etc/systemd/system/t3-person@.service.d/` instead.
For the main and topic instances, copy the `ExecStart` line of `t3code.service` or
`t3-topic@.service` the same way. Both already have an `artifacts.conf` drop-in; add a second
file, do not edit that one.

When no thread runs in that instance:

```bash
systemctl daemon-reload
systemctl restart t3-person@jessica
journalctl -u t3-person@jessica -n 50
```

To check: open the instance, open a thread that made a page, open the right panel and pick
**Artifacts** (key R in the empty panel).

## 4. Update to a new upstream release

1. Back up each instance's `userdata` (`state*.sqlite` with the SQLite backup API, not `cp`,
   while it runs; plus `settings.json` and `keybindings.json`).
2. Rebase this branch onto the new tag, build, unpack next to the old folder, point `current`
   at it.
3. Update the npm package to the same release: `npm i -g t3@<release>`.
4. Restart the services that use it. Keep the previous folder until the new one has run a day.

What 0.0.45 → 0.1.8 does to the data, measured on a copy of the main instance:

- 0.1.8 keeps its threads in a new `userdata/statev2.sqlite`. On first start it imports the
  threads from `state.sqlite` (32 threads, 281 user and assistant messages; reasoning is no
  longer stored as messages) and leaves `state.sqlite` as it was.
- It rewrites `settings.json` (adds `idleCompaction`, drops `enabled: false` of providers that
  are not installed) and `keybindings.json`. Custom provider instances stay.
- 0.0.45 still starts on the folder afterwards. It reads `state.sqlite`, so it does not see
  threads made under 0.1.8.

## 5. Roll back

```bash
rm /etc/systemd/system/t3-person@jessica.service.d/fork.conf
systemctl daemon-reload
systemctl restart t3-person@jessica
```

The service is back on `/usr/bin/t3`. `/opt/t3-fork` can stay. Going back to an older release
than the custom build's base: restore the `userdata` backup from step 4.1 first.

## What sees the Artifacts panel

- A browser on the instance's tailnet URL: yes. The server serves its own web client.
- The desktop app: only a build from this branch (`custom/update.sh`). The desktop app shows
  its own bundled client, also when it connects to pandora.
- The mobile app: no. The panel is web only.
