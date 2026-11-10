# Run the custom build on pandora

Pandora runs the npm package `t3` (`/usr/lib/node_modules/t3`, started by `/usr/bin/t3`).
The package is a small wrapper. It starts the self-contained executable from
`@t3code/t3-linux-x64`. `custom/build-cli.sh` builds that same executable from this branch.

The custom build goes next to the npm install, in `/opt/t3-fork`. A systemd drop-in moves one
service to it. The npm install stays as it is, so a rollback is one file removed.

Restarting a T3 service stops the threads that run in it. Do it only when nobody works in that
instance, and only after Cyrille says yes.

## 1. Build (on the laptop)

```bash
custom/build-cli.sh
```

The script needs a clean tree, rustup and nvm with Node 24. It installs Node 26.8.2 with nvm
once: the single executable needs a Node that can build one (25.7+). The result is `release/cli/t3-<version>-linux-x64.tar.gz`, where the
version is `<last release>-custom.<commit>`, for example `0.0.45-custom.ceec37c060`.

Build from the same release that pandora runs (`t3 --version` there). A newer base migrates the
state database in `~/.t3`, and the npm install may then not open it after a rollback.

## 2. Install next to the npm package

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

## 3. Move one service to the custom build

Start with one family instance. For Jessica, create
`/etc/systemd/system/t3-person@jessica.service.d/fork.conf`:

```ini
[Service]
ExecStart=
ExecStart=/opt/t3-fork/current/t3 serve --host 127.0.0.1 --port ${PORT} --no-browser --base-dir /home/fam-%i/.t3 --auto-bootstrap-project-from-cwd /srv/people/%i
```

The `ExecStart` line is the one from `t3-person@.service` with only the binary changed. Copy it
again from `systemctl cat t3-person@.service` if the unit changed since.

When no thread runs in that instance:

```bash
systemctl daemon-reload
systemctl restart t3-person@jessica
journalctl -u t3-person@jessica -n 50
```

To check: open the instance, open a thread that made a page, open the right panel and pick
**Artifacts** (key R in the empty panel).

For all family instances, put the same file in `/etc/systemd/system/t3-person@.service.d/` instead.
For the main and topic instances, copy the `ExecStart` line of `t3code.service` or
`t3-topic@.service` the same way. Both already have an `artifacts.conf` drop-in; add a second
file, do not edit that one.

## 4. Update

Build again, unpack the new archive next to the old one, point `current` at it, restart the
services that use it. Keep the previous folder until the new one has run for a day.

## 5. Roll back

```bash
rm /etc/systemd/system/t3-person@jessica.service.d/fork.conf
systemctl daemon-reload
systemctl restart t3-person@jessica
```

The service is back on `/usr/bin/t3`. `/opt/t3-fork` can stay.

## What sees the Artifacts panel

- A browser on the instance's tailnet URL: yes. The server serves its own web client.
- The desktop app: only a build from this branch (`custom/update.sh`). The desktop app shows
  its own bundled client, also when it connects to pandora.
- The mobile app: no. The panel is web only.
