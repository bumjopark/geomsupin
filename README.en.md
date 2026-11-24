# Geomsupin

[한국어](README.md) · English

Geomsupin lets a team pin feedback to a page while reviewing a website in its usual browser. Run it on your server, invite reviewers, and follow their requests and screenshots in one project.

**One-minute walkthrough · Create a project, invite a teammate, and reply to their pin**

https://github.com/user-attachments/assets/6994f722-b646-4e3c-9d6f-d8021c9805b6

[MP4 video](admin/public/tutorial/review-guide.mp4?raw=true) · [English captions](admin/public/tutorial/review-guide.en.vtt?raw=true) · [Korean captions](admin/public/tutorial/review-guide.ko.vtt?raw=true) · [Korean operations guide](deploy/onprem/README.md)

The video shows the Korean interface. For English captions and chapters, select **EN** in the installed app and open the tutorial, or download the MP4 and load the English captions in your video player.

## 1. Prepare the Linux server

Use a regular Linux account that can write to the checkout and run `systemctl --user`. Use administrator privileges for operating-system packages and the system reverse proxy. Run Git, npm, the Geomsupin installer, and the app as the regular account. The server needs access to GitHub and the npm registry during installation.

Install Git, curl, Node.js **22.12 or newer** with npm, and PostgreSQL **16**. For Ubuntu 24.04, install the system packages below and install Node.js from its official Linux downloads. If PostgreSQL is installed at a different path, export `PG_BIN` with the directory that contains `postgres` and `initdb`. [Node.js downloads](https://nodejs.org/en/download) · [PostgreSQL Linux downloads](https://www.postgresql.org/download/)

```bash
sudo apt update
sudo apt install git curl ca-certificates xz-utils postgresql-16 postgresql-client-16
```

If you need to install Node.js for the service account, choose the official Node.js 22 LTS **Linux Standalone Binary (`.tar.xz`)**. Run `uname -m` to check the architecture. Choose x64 for `x86_64` or arm64 for `aarch64`. Save the archive on the server, then enter its absolute path below.

```bash
read -r -p 'Absolute path to the Node.js .tar.xz file: ' GEOMSUPIN_NODE_ARCHIVE
mkdir -p "$HOME/.local/opt/geomsupin-node"
tar -xJf "$GEOMSUPIN_NODE_ARCHIVE" --strip-components=1 -C "$HOME/.local/opt/geomsupin-node"
export PATH="$HOME/.local/opt/geomsupin-node/bin:$PATH"
```

Add that `export PATH` line to your login shell configuration or rerun it in a new shell. Verify the versions and user systemd before continuing.

```bash
node --version
npm --version
/usr/lib/postgresql/16/bin/postgres --version
systemctl --user show-environment >/dev/null
```

Run the last command from a login session for the account that will own the service. To keep user services running after logout or a reboot, run `sudo loginctl enable-linger "$(id -un)"` as that account, or ask the server administrator to enable linger for it.

On GitHub, copy the repository URL from **Code → HTTPS**. Paste it when prompted in Bash.

```bash
read -r -p 'Repository HTTPS URL from GitHub: ' GEOMSUPIN_REPO_URL
git clone "$GEOMSUPIN_REPO_URL" geomsupin && cd geomsupin
npm ci --include=dev
```

Reviewers' browsers must be able to reach Geomsupin and the site under review. The two sites must use the same scheme and have distinct origins. For an HTTPS staging site, serve Geomsupin over HTTPS. If the staging site has a Content Security Policy, its administrator must allow scripts and API connections to the Geomsupin origin.

## 2. Install and verify

Choose the network setup that matches your staging site. Run the commands from the checkout. The installer builds the web app and widget, writes `.env`, and initializes a dedicated PostgreSQL cluster by default. `--services` starts the API and the backup timer under user systemd.

### HTTPS domain and reverse proxy

Replace `review.example.com` with a domain that resolves to your reverse proxy. Use a certificate trusted by the reviewers' browsers.

```bash
npm run onprem:setup -- --url https://review.example.com --bind 127.0.0.1 --port 3200 --services
curl --fail --show-error http://127.0.0.1:3200/healthz
```

Publish the HTTPS port through your firewall. Keep the API on loopback and the dedicated database on its default loopback port, `55433`. This nginx example assumes that nginx runs on the same host as the API. Replace the domain and certificate paths with your own. In an existing virtual host, merge the settings into that host. [nginx proxy directives](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)

```nginx
server {
    listen 443 ssl;
    server_name review.example.com;
    ssl_certificate /etc/ssl/review/fullchain.pem;
    ssl_certificate_key /etc/ssl/review/privkey.pem;
    client_max_body_size 20m;
    access_log off;

    location / {
        proxy_pass http://127.0.0.1:3200;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP $remote_addr;
        proxy_buffering off;
        proxy_read_timeout 60s;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
curl --fail --show-error https://review.example.com/healthz
```

The proxy preserves the original `Host`, keeps the live event stream unbuffered, and allows screenshot uploads. Keep invitation URLs out of proxy access logs. Check the same HTTPS health URL from a reviewer's PC. It should return `{"ok":true}` with a trusted certificate.

### HTTPS on an internal IP address

Use this when your team can install a private CA certificate. On Ubuntu, install OpenSSL and nginx with `sudo apt install openssl nginx`. Open `3443/tcp` to the reviewers' network.

```bash
read -r -p 'Internal IPv4 address of the Geomsupin server: ' GEOMSUPIN_IP
npm run onprem:setup -- --url "https://${GEOMSUPIN_IP}:3443" --bind 127.0.0.1 --port 3200 --services
node scripts/tls-setup.mjs --host "$GEOMSUPIN_IP" --port 3443
curl --fail --show-error --cacert .local/tls/ca.crt "https://${GEOMSUPIN_IP}:3443/healthz"
```

Distribute only the public CA certificate, `.local/tls/ca.crt`, over a trusted channel. Compare its SHA-256 fingerprint with the installer's output before adding it to the trusted roots on reviewer PCs. Keep `ca.key` and `gp.key` on the server. Reopen the browser and check that both sites load over HTTPS. To renew the server certificate, rerun `tls-setup.mjs` with the same address and `--renew`.

### Internal HTTP only

Use this when both sites run on HTTP within your network. Allow access to `3200/tcp` from the reviewers' network.

```bash
read -r -p 'Internal IPv4 address of the Geomsupin server: ' GEOMSUPIN_IP
npm run onprem:setup -- --url "http://${GEOMSUPIN_IP}:3200" --services
curl --fail --show-error "http://${GEOMSUPIN_IP}:3200/healthz"
```

### Use an existing PostgreSQL database

Have your database administrator prepare an empty database and a dedicated login that can create the schema and tables. The server needs PostgreSQL 16 client tools for backup and restore. Use `--database-url` with your chosen network setup. This example uses the HTTPS proxy setup above.

```bash
read -r -s -p 'PostgreSQL connection URL: ' GEOMSUPIN_DATABASE_URL
printf '\n'
node scripts/onprem-setup.mjs --url https://review.example.com --bind 127.0.0.1 --port 3200 --services --database-url "$GEOMSUPIN_DATABASE_URL"
unset GEOMSUPIN_DATABASE_URL
```

### Confirm services

```bash
systemctl --user status geomsupin-api geomsupin-backup.timer
journalctl --user -u geomsupin-api -n 50 --no-pager
```

For the dedicated database, also check `systemctl --user status geomsupin-db`. For the internal-IP HTTPS option, check `systemctl --user status geomsupin-tls`. If you installed without `--services` for a trial, run `npm start` in the checkout and leave the terminal open while checking `/healthz`. Use `npm run pg:start` if the dedicated database is stopped.

## 3. Open the administrator link and invite the team

Run this in the checkout as the installation account. `--name` names the workspace on first install.

```bash
npm run manage -- --name "Our team"
```

Paste the complete `/#manage=…` link into your browser. It is good for one use within 15 minutes. Keep it for the administrator. Issuing a new management link invalidates the previous link and administrator sessions for that workspace. If the installation has multiple workspaces, use `npm run manage -- --list` to find the ID, then run the command below.

```bash
read -r -p 'Workspace ID: ' GEOMSUPIN_WORKSPACE_ID
npm run manage -- --workspace "$GEOMSUPIN_WORKSPACE_ID"
```

1. Create a project and open its settings. Save the staging URL under **Review site** (**검수할 사이트**).
2. Choose **Copy link** (**링크 복사**) and send the invitation to reviewers. They can open it directly or paste it in the Geomsupin home page and choose **Open invitation**.

## 4. Leave the first pin

1. On a desktop browser, open the invitation and drag the project bookmark onto the browser's bookmarks bar. Use the shortcut shown on that page if the bar is hidden. Open the help below the drag control for keyboard-only installation. On a phone, copy the invitation and open it on a desktop instead.
2. Open the site in a normal tab and sign in as usual. On the page you want to review, click the saved bookmark.
3. Choose **Leave a request** (**요청 남기기**), click the element you want to review, and enter your nickname and feedback. Check the screenshot preview and choose **Submit**.
4. Open **Requests** (**요청**) in the management browser. Confirm that the new request and screenshot appear. Open the row to reply, set its status, or assign it to someone. The Excel export includes the filtered list and screenshots.

If the bookmark does not open the widget, check that the current tab matches the registered site's origin. If the administrator has changed the registered site or invitation, save the bookmark again from the current invitation. If a `421 Unknown host` error appears, check `PUBLIC_URL`, `ALLOWED_HOSTS`, and the reverse proxy's `Host` forwarding.

## Run and maintain the installation

The app serves `/tutorial/review-guide-poster.jpg` and `/tutorial/review-guide.mp4`. The `/tutorial/review-guide.en.vtt` and `/tutorial/review-guide.ko.vtt` tracks include captions and chapter markers.

`npm run backup` creates a backup of the database, referenced capture files, and installation configuration. Protect `.env`, `data/`, and backup copies. If you installed PostgreSQL outside the default path, keep `PG_BIN` in `.env` for scheduled backups and export it in the shell before running a restore. For release updates, recovery, and more diagnostics, see the [operations guide](deploy/onprem/README.md). For development checks, see [developer verification](README.md#개발과-검증) and use a separate test database whose name ends in `_test`.

## License

Geomsupin is available under the [MIT License](LICENSE). Third-party packages and the [test font](tests/fixtures/LICENSE.txt) retain their own licenses.
