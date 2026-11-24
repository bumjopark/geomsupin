# Installation and operations

[한국어](README.ko.md) · English

Run the server commands from the Geomsupin host. Reviewers use a bookmark in their desktop browser. [English README](../../README.md) · [한국어 README](../../README.ko.md) · [Illustrated user guide](../../docs/usage.en.md)

## Prepare the server

Use a regular Linux account with write access to the checkout, `.env`, `data/`, `.local/`, and its user systemd configuration. Install system packages with administrator privileges. Run Git, npm, database initialization, Geomsupin, and its HTTPS service as the regular account. The first installation needs access to GitHub and the npm registry.

Install Node.js **22.12 or later** with npm and PostgreSQL **16**. The following package commands are for Ubuntu 24.04. On another distribution, use its PostgreSQL 16 packages or the official PostgreSQL repository. The setup script looks in `/usr/lib/postgresql/16/bin` for PostgreSQL executables. If yours are elsewhere, export `PG_BIN` with their directory before installation. [PostgreSQL downloads](https://www.postgresql.org/download/) · [Node.js downloads](https://nodejs.org/en/download)

```bash
sudo apt update
sudo apt install git curl ca-certificates xz-utils postgresql-16 postgresql-client-16 nginx openssl
```

If you need to install Node.js for the service account, download the Node.js 22 LTS Linux standalone archive (`.tar.xz`). Use x64 for `uname -m` output `x86_64` and arm64 for `aarch64`. Place the archive on the server, then enter its absolute path in Bash.

```bash
read -r -p 'Absolute path to the Node.js .tar.xz archive: ' GEOMSUPIN_NODE_ARCHIVE
mkdir -p "$HOME/.local/opt/geomsupin-node"
tar -xJf "$GEOMSUPIN_NODE_ARCHIVE" --strip-components=1 -C "$HOME/.local/opt/geomsupin-node"
export PATH="$HOME/.local/opt/geomsupin-node/bin:$PATH"
```

Add that `export PATH` line to the login shell configuration or repeat it in new sessions. Check the installed versions and access to user systemd.

```bash
node --version
npm --version
"${PG_BIN:-/usr/lib/postgresql/16/bin}/postgres" --version
systemctl --user show-environment >/dev/null
```

If the last command cannot connect to the user bus, log in directly as the installation account on a systemd host and try again. To keep the services running after logout and reboot, run `sudo loginctl enable-linger "$(id -un)"` as the installation account or ask the server administrator to enable linger for it.

Clone the public repository. Run the rest of this guide from the checkout containing `package.json`.

```bash
git clone https://github.com/bumjopark/geomsupin.git && cd geomsupin
npm ci --include=dev
```

The default setup uses a fixed server IPv4 address reachable from reviewers' PCs. Use a static IP or a DHCP reservation. Allow inbound `3443/tcp` from the review team's network. The user nginx service listens on `0.0.0.0:3443` for HTTPS and proxies to the API at `127.0.0.1:3200`. Keep the API and the dedicated database port `55433` on loopback.

The site under review must also use HTTPS and have a different origin. Confirm both addresses open from the reviewer's PC. If the site uses a Content Security Policy, check with its administrator whether it permits the Geomsupin scripts and API connections.

## First installation

### Set up HTTPS on the server IP

Enter the fixed IPv4 address that reviewers will use. The first command creates user services for the API, dedicated PostgreSQL, and backup timer. The TLS command issues certificates and starts the user nginx service.

```bash
read -r -p 'Server IPv4 address reachable by reviewers: ' GEOMSUPIN_IP
npm run onprem:setup -- --url "https://${GEOMSUPIN_IP}:3443" --bind 127.0.0.1 --port 3200 --services &&
  node scripts/tls-setup.mjs --host "$GEOMSUPIN_IP" --port 3443
```

Check the user services and the HTTPS connection from the server. A response of `{"ok":true}` from `/healthz` verifies that the HTTPS proxy reaches the API and the API can query the database.

```bash
systemctl --user status --no-pager geomsupin-api geomsupin-db geomsupin-tls geomsupin-backup.timer
curl --fail --show-error --cacert .local/tls/ca.crt "https://${GEOMSUPIN_IP}:3443/healthz"
```

### Trust the internal CA on reviewers' PCs

1. Distribute only the **public CA certificate** at `.local/tls/ca.crt` through an approved internal channel. Share the SHA-256 fingerprint printed by the TLS script through a separate trusted channel and compare it before trusting the certificate. Keep `ca.key` and `gp.key` on the server.
2. Follow your organization's certificate procedure. On **Windows**, use **Trusted Root Certification Authorities** for the current user. On **macOS**, use Keychain Access. On **Linux**, check the trust store used by the distribution and browser.
3. Reopen the browser that will be used for review and visit `https://SERVER-IP:3443/healthz`. Look for `{"ok":true}` with no certificate warning. Confirm that the site under review also opens without a warning in the same browser.

The installed HTTPS server also serves the public certificate at `/gp-ca.crt`. Use an approved distribution channel on PCs that have yet to trust the CA. Renew the server certificate before expiry by rerunning the TLS command for the current IP and TLS directory with `--renew`.

### Use an existing PostgreSQL database

Use these commands in place of the default setup commands above. Prepare an empty database and a dedicated login that can create the migration schema and tables. Allow connections from the Geomsupin host and install PostgreSQL 16's `pg_dump` and `pg_restore` on that host for backup and recovery.

```bash
read -r -p 'Server IPv4 address reachable by reviewers: ' GEOMSUPIN_IP
read -r -s -p 'PostgreSQL connection URL: ' GEOMSUPIN_DATABASE_URL
printf '\n'
node scripts/onprem-setup.mjs --url "https://${GEOMSUPIN_IP}:3443" --bind 127.0.0.1 --port 3200 --services --database-url "$GEOMSUPIN_DATABASE_URL" &&
  node scripts/tls-setup.mjs --host "$GEOMSUPIN_IP" --port 3443
unset GEOMSUPIN_DATABASE_URL
```

The URL has the form `postgresql://USER:PASSWORD@HOST:5432/DATABASE`. This setup skips the dedicated `geomsupin-db` service. Check the API, TLS, and backup timer services, then verify HTTPS and set up CA trust on reviewers' PCs as described above.

### Team-managed domain and external HTTPS proxy

If your team already manages DNS, a trusted public certificate, and an HTTPS proxy, use its actual domain address as `--url`. Have the team proxy forward requests to the internal API and preserve the original `Host`. Keep server-sent events unbuffered and uncached, allow capture uploads, and exclude invitation URLs from access logs. The team proxy handles TLS in this configuration.

### Installer options

| Option | Use |
| --- | --- |
| `--database-url URL` | Use an existing empty PostgreSQL database and skip the dedicated DB service. |
| `--bind`, `--port` | Set the API listener when it differs from the public address. |
| `--services` | Manage the API and backup timer with user systemd. Omit it to start the API with `npm start` after setup. |
| `--issue-admin` | Issue an administrator link during setup. |
| `--rebuild` | Rebuild the web app and widget from the current checkout. |
| `--force` | Overwrite existing `.env` values written by the installer. This also regenerates `AUTH_SECRET`, which invalidates previously signed file links. |

## Administrator access and public address changes

Once the API is running, issue the first management link from the checkout. `--name` names the workspace on the first installation.

```sh
npm run manage -- --name "Our team"
```

Open the complete `/#manage=…` URL in the administrator's browser. The link can be used once within 15 minutes. Choose **New project**, open **Settings**, and save the staging URL under **Review site**. Use **Copy link** to invite reviewers. On a reviewer's desktop, open the invitation, drag the bookmark to the bookmarks bar, and click it on the staging site tab. Choose **Leave a request**, select a location, add a name and feedback, and submit. Confirm that the request and screenshot appear under **Requests** in the management browser. [First pin walkthrough](../../README.md#4-leave-the-first-pin) · [한국어 사용법](../../README.ko.md#4-첫-핀-남기기)

Run `npm run manage` again if you lose the session or need to manage from another browser. A new link invalidates the previous link and management sessions for that workspace. If multiple workspaces exist, list them and select one by ID.

```bash
npm run manage -- --list
read -r -p 'Workspace ID: ' GEOMSUPIN_WORKSPACE_ID
npm run manage -- --workspace "$GEOMSUPIN_WORKSPACE_ID"
```

`PUBLIC_URL` is the address reviewers open. `ALLOWED_HOSTS` controls the accepted hosts, and `HOST` and `PORT` control the API listener. Keep the installation's actual `DATABASE_URL`, `DATA_DIR`, and `AUTH_SECRET`. If PostgreSQL tools are outside the standard path, add `PG_BIN` to `.env` for the backup service and export it in the shell before a restore. [Environment variable example](../../.env.example)

If the server IP changes, the old CA's permitted name range will not cover the new IP. Generate certificates in a new TLS directory, update the public address, and restart the API.

```bash
read -r -p 'New server IPv4 address: ' GEOMSUPIN_NEW_IP
node scripts/tls-setup.mjs --host "$GEOMSUPIN_NEW_IP" --port 3443 --dir ".local/tls-${GEOMSUPIN_NEW_IP}" &&
  npm run set-hosts -- "https://${GEOMSUPIN_NEW_IP}:3443" &&
  systemctl --user restart geomsupin-api
```

Distribute the public CA certificate from the new TLS directory and verify the new HTTPS address in the browser reviewers actually use. Check that `3443/tcp` on the new address is reachable from the team's network. Update the staging site's CSP and any installed preview connection script, reissue the administrator link, and share new invitation links so reviewers can save fresh bookmarks. If the internal API port changes too, update `PORT` in `.env` and the TLS proxy's upstream port.

## Check services and deploy updates

```sh
systemctl --user status geomsupin-api geomsupin-backup.timer
journalctl --user -u geomsupin-api -n 50 --no-pager
curl --fail --show-error http://127.0.0.1:3200/healthz
```

Expect `active (running)` for the API and `active (waiting)` for the backup timer. Check `systemctl --user status geomsupin-db` for the dedicated database and `systemctl --user status geomsupin-tls` for the internal-IP HTTPS proxy. Check the public `/healthz` URL from a reviewer's PC too. Use the API listener address and port configured for this installation when checking it locally.

For a trial without user services, omit `--services` during setup. Run `npm start` in one terminal and check `/healthz` from a second terminal or a reviewer's PC. If the dedicated PostgreSQL cluster is stopped, start it with `npm run pg:start`.

### Prepare and activate a release

Before pulling the first update, confirm that the checkout matches the running version. Initialize the release baseline once with `npm run deploy -- --baseline "$(git rev-parse HEAD)"`. Preparing a release requires a separate `TEST_DATABASE_URL` whose database name ends in `_test`, Chromium and Firefox for Playwright, and PostgreSQL tools. [Development and testing](../../README.md#development-and-testing)

```bash
git pull --ff-only
npm ci --include=dev
npx playwright install chromium firefox
```

If the browser runtime libraries are missing on Linux, run `npx playwright install --with-deps chromium firefox` from the checkout with permission to install system packages.

If PostgreSQL tools are outside `/usr/lib/postgresql/16/bin`, export `PG_BIN` again in the current shell before regenerating services. The backup service uses the value in `.env`. The service generator reads the shell environment.

```bash
read -r -p 'Directory containing the PostgreSQL 16 executables: ' PG_BIN
export PG_BIN
```

Run **only the command for your database type**. Omitting `--no-db` on an external database installation adds a dependency on the dedicated `geomsupin-db` service.

| Database | Regenerate the service definitions |
| --- | --- |
| Dedicated PostgreSQL created by the installer | `npm run services:install` |
| External PostgreSQL installed with `--database-url` | `npm run services:install -- --no-db` |

```bash
npm run deploy -- --prepare
read -r -p 'Release ID printed by the prepare command: ' GEOMSUPIN_RELEASE_ID
npm run deploy -- --activate "$GEOMSUPIN_RELEASE_ID"
```

Prepare builds and tests a clean Git commit in a separate release directory. Use `--prepare --offline` when dependencies and browser binaries are already cached. To omit static files from the previous release, add `--current-assets-only` to `--prepare`. Users who still have the previous app open may need to refresh. Activation creates a backup, stops the API, switches to the verified release, and checks the running API and static files.

### Roll back a release

Use the ID of the **currently running** release to return to its predecessor. Check `.local/current` for the running release and `.local/deploy-current.json` for deployment records.

```bash
read -r -p 'Currently running release ID: ' GEOMSUPIN_RELEASE_ID
npm run deploy -- --rollback "$GEOMSUPIN_RELEASE_ID"
```

Rollback switches the application code and static files. Database migrations remain applied. If the old version cannot use the migrated schema, recover from a compatible backup.

## Backup and recovery

A backup includes the database dump, referenced original screenshots, thumbnails and proposal images, and installation settings. The default directory is `DATA_DIR/backups/`. Set `BACKUP_DIR` to override it and `BACKUP_MIRROR_DIR` to write a second copy to an already mounted location. Restrict access to backups because they include secrets. Local retention keeps the most recent 14 backups of each type: scheduled, manual, and pre-deployment.

```bash
npm run backup
read -r -p 'Absolute path to the backup directory to verify: ' GEOMSUPIN_BACKUP_PATH
npm run backup -- --verify "$GEOMSUPIN_BACKUP_PATH"
systemctl --user start geomsupin-backup.service
systemctl --user status geomsupin-backup.service
```

The scheduled timer runs at 04:40 server time with up to two minutes of delay. The management screen reports recent failure, a stalled run, or a last successful backup older than 36 hours. To back up immediately using the deployed release's runtime from the checkout, run `node scripts/serve-release.mjs --backup`.

Prepare an **empty database** and an **empty data directory** for recovery. If the tools are in a nonstandard directory, export `PG_BIN` first. Set `RESTORE_DATABASE_URL` for the destination database and run the restore.

```bash
read -r -s -p 'PostgreSQL URL of the empty restore database: ' RESTORE_DATABASE_URL
printf '\n'
export RESTORE_DATABASE_URL
read -r -p 'Absolute path to the backup directory: ' GEOMSUPIN_BACKUP_PATH
read -r -p 'Absolute path to the empty restore data directory: ' GEOMSUPIN_RESTORE_PATH
npm run restore -- "$GEOMSUPIN_BACKUP_PATH" "$GEOMSUPIN_RESTORE_PATH"
unset RESTORE_DATABASE_URL
```

Update `DATABASE_URL` and `DATA_DIR` in the recovered `recovered.env` to point at the restored resources, then use that file as `.env` in the installation directory. Retain the original `AUTH_SECRET` to preserve existing signed file URLs. Restart the API and verify the public health endpoint, a management session, and a restored request with a screenshot.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `421 Unknown host` | Compare the browser's host and port with `PUBLIC_URL`, `ALLOWED_HOSTS`, and the original `Host` forwarded by the proxy. |
| The app only opens on the server | Check the API bind address, firewall and proxy. Test both the staging and Geomsupin addresses from the reviewer's PC. |
| HTTPS certificate warning | Check that the certificate covers the actual IP or hostname and that the reviewer's browser trusts the issuing CA. |
| Screenshot upload returns `413` | Check the proxy's body size limit and the capture size. |
| Changes arrive late | Check the proxy for caching or buffering of server-sent events. |
| Invitation asks to connect a site | Save the staging URL under **Settings → Review site**. |
| The built-in preview is blank | Open the original site in a tab to check access and certificate trust. If you use the preview, check that staging permits framing by the Geomsupin origin. |
| The site opens and the bookmark cannot leave pins | Click the bookmark on the original site's tab and check that its origin matches the saved address. Check the staging site's script, API, and Trusted Types policies with its administrator. |
| A public staging site cannot reach an internal Geomsupin address | Check the browser's Local Network Access permission and the organization's managed browser policy. [Chrome Local Network Access](https://developer.chrome.com/blog/local-network-access) |
| Some images are missing from a capture | Check whether the browser can read cross-origin images. The image proxy is limited to publicly reachable HTTP and HTTPS images by default. |
| An invitation is closed | Check whether the project ended, the link was revoked, or it expired. |
| A management link cannot be reused | On the installation server, issue a new link with `npm run manage`. |
| PostgreSQL tools are missing | Confirm that PostgreSQL 16 is installed and `PG_BIN` points at the executables. |
