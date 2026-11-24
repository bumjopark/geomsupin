# Geomsupin

English · [한국어](README.ko.md)

Leave Figma-style feedback on the website you're building. A designer can pin a comment to a button on a signed-in checkout page, and a developer can see the screenshot, reply, and mark the issue resolved in the same thread. Host Geomsupin on your team's server and share an invitation. Reviewers use their usual desktop browser and keep their existing sign-in on the site.

**One-minute walkthrough · Create a project, invite a teammate, and reply to their pin**

https://github.com/user-attachments/assets/6994f722-b646-4e3c-9d6f-d8021c9805b6

[Download the MP4](admin/public/tutorial/review-guide.mp4?raw=true) · [English captions](admin/public/tutorial/review-guide.en.vtt?raw=true) · [Korean captions](admin/public/tutorial/review-guide.ko.vtt?raw=true)

The video shows the Korean interface. In the app, select **EN** and open the tutorial for English captions and chapters. The illustrated guide includes the English button names. [User guide](docs/usage.en.md)

## 1. Install on your server

This setup serves Geomsupin at **`https://YOUR_SERVER_IP:3443`** on your team's network. Choose a stable IPv4 address that reviewers can reach and allow TCP port `3443` from their network. You need Linux with user systemd, Git, Node.js **22.12 or newer**, npm, PostgreSQL **16**, nginx, and OpenSSL. Run the commands as the Linux user who will own the service. [Ubuntu prerequisites and installation guide](deploy/onprem/README.md)

```sh
git clone https://github.com/bumjopark/geomsupin.git
cd geomsupin
npm ci --include=dev
```

In the same Bash session, enter the server's IPv4 address. The installer starts the API, database, and backup timer. The TLS helper starts nginx, which accepts HTTPS on `0.0.0.0:3443` and forwards requests to `http://127.0.0.1:3200`. For example, if the server's address is `192.168.1.50`, reviewers open `https://192.168.1.50:3443`.

```bash
read -r -p 'Server IPv4 address reachable by reviewers: ' GEOMSUPIN_IP
npm run onprem:setup -- --url "https://${GEOMSUPIN_IP}:3443" --bind 127.0.0.1 --port 3200 --services &&
  node scripts/tls-setup.mjs --host "$GEOMSUPIN_IP" --port 3443 &&
  curl --fail --show-error --cacert .local/tls/ca.crt "https://${GEOMSUPIN_IP}:3443/healthz"
```

Send the public certificate `.local/tls/ca.crt` to reviewers through a trusted channel. On each reviewer's computer, verify its SHA-256 fingerprint against the one the TLS helper printed, then trust the CA in the browser or operating system. Open `https://YOUR_SERVER_IP:3443/healthz` there. You should see `{"ok":true}` without a certificate warning. The site under review must also open over HTTPS on a different origin. Teams that prefer a domain manage their own DNS, certificate, and reverse proxy. [Certificate setup and operations](deploy/onprem/README.md)

## 2. Open the administrator link

On the server, run the following command from the checkout. On first use it creates a workspace with the name you provide.

```sh
npm run manage -- --name "Our team"
```

Open the printed link in the administrator's browser. It can be used once within 15 minutes. The secret disappears from the address bar after sign-in. Issuing a new link for the same workspace invalidates its earlier administrator link and sessions. For an installation with several workspaces, list them and choose the one to manage.

```bash
npm run manage -- --list
read -r -p 'Workspace ID: ' GEOMSUPIN_WORKSPACE_ID
npm run manage -- --workspace "$GEOMSUPIN_WORKSPACE_ID"
```

## 3. Invite your team

1. Create a project. In **Settings → Review site**, save the URL you want to review.
2. Under **Invite reviewers**, select **Copy link** and share it with your team. Each reviewer opens the invitation and drags their own project bookmark onto their desktop browser's bookmarks bar. **Can't drag the bookmark?** shows the manual steps.

## 4. Leave the first pin

1. From the invitation, select **Open review site**, or switch to the tab where you already use the site. Sign in to the site as usual and click the saved bookmark.
2. Select **Leave a request**, click the element you want to discuss, and enter your nickname and feedback. Check the screenshot preview and select **Submit**.
3. A teammate can open the numbered pin and reply. In the administrator's **Requests** view, open the same request to see the screenshot, assign it, or update its status. **Export to Excel** downloads the filtered list with screenshots. [Illustrated user guide](docs/usage.en.md)

People invited to the same project can see its screenshots, page titles, and URLs. Use test data and avoid reviewing URLs that contain secrets. If the review site restricts external scripts or API connections, its administrator may need to allow the Geomsupin origin. [Sharing and bookmark troubleshooting](docs/usage.en.md)

## Development and testing

Prepare a development checkout using the installation steps above. The dedicated PostgreSQL installer creates a separate test database. For an external database, create a separate database whose name ends in `_test` and set `TEST_DATABASE_URL` in `.env`. Tests reset the schema in that database and write captures to a temporary directory.

```sh
npx playwright install chromium firefox
npm run check
```

The check runs TypeScript, builds the admin app and widget in `dist-test/`, then runs Vitest and Playwright. The browser report is in `test-results/report/`. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use a particular Chromium build. Set `PLAYWRIGHT_EDGE_EXECUTABLE` to add Edge to the modal tests. With LibreOffice and `python3-uno` installed, `npm run test:spreadsheet` checks that screenshot links survive sorting, filtering, and resaving an export.

| Directory | What it contains |
| --- | --- |
| `admin/` | React dashboard, reviewer invitations, and the tutorial player |
| `widget/` | Bookmark and script entry points, pins, comments, layout proposals, and screenshot capture |
| `server/` | Fastify API, PostgreSQL access, review sessions, live updates, files, Excel exports, and backups |
| `server/migrations/` | Versioned SQL migrations |
| `shared/` | Review types, browser and URL helpers, and shared validation |
| `demo/`, `tests/` | Sample staging site and unit, database, and browser tests |
| `scripts/` | Build, installation, administrator access, deployment, and recovery commands |

For the path from clicking a page element to receiving a team update, see the [architecture guide](docs/architecture.en.md).

## Operations

`npm run backup` saves the database, referenced captures, and installation configuration. Set `BACKUP_MIRROR_DIR` to keep another copy on a mounted volume. The operations guide covers service updates, restoration, and troubleshooting. [Installation and operations guide](deploy/onprem/README.md)

## License

Geomsupin is available under the MIT License. Third-party packages and the test font retain their own licenses. [MIT License](LICENSE) · [Test font notice](tests/fixtures/LICENSE.txt)
