🇺🇸 English | [🇧🇷 Português](README.md)

# Korrelo

A Web OS to manage a VPS without needing SSH/CLI. Import repositories from
GitHub, deploy with one click, manage databases, cron jobs, domains, and
monitor everything from your browser.

- **Core** (`apps/api` + `apps/web`) runs directly on the VPS via [PM2](https://pm2.keymetrics.io/), no root privileges required.
- **Hosted projects** run in isolated Docker containers, each with its own database (optional), domain, and cron.
- Authentication with 2FA (TOTP), rotating refresh tokens, and revocable sessions.

## Before you start

- A clean Ubuntu 22.04+ VPS, with SSH key access (not password).
- At least **1 GB of RAM** (2 GB+ recommended if hosting more than 1-2 projects, since each container consumes its own memory on top of the Core).
- A domain (optional). You can access it by IP alone, but with a domain Korrelo can issue automatic HTTPS (Let's Encrypt) for itself and for each deployed project.

## 1. Install on the VPS

```bash
ssh your-user@YOUR_IP
curl -fsSL https://raw.githubusercontent.com/claudiojc030/Korrelo/main/scripts/install.sh | bash
```

Prefer to review the script before running it (recommended if you don't
blindly trust `curl | bash`)? Download and read it first:

```bash
curl -fsSL https://raw.githubusercontent.com/claudiojc030/Korrelo/main/scripts/install.sh -o install.sh
less install.sh
bash install.sh
```

Or clone it by hand, without the installer:

```bash
git clone https://github.com/claudiojc030/Korrelo.git korrelo
cd korrelo
bash scripts/setup-vps.sh
```

Any of the three paths above ends up running `setup-vps.sh`, which does
everything on its own: updates the system,
creates swap (if RAM is low), installs Node 20, Docker, PM2, nginx, certbot,
configures the firewall (ufw), hardens SSH (fail2ban + disables password
login, **only** if it detects a key already registered), disables
unnecessary OS services, builds the Core, runs the migrations, brings
everything up via PM2, and schedules a daily backup.

At two points it **stops and asks for your input**:

1. **Domain (optional)**: leave it blank to access by IP only.
2. **GitHub App**: can be left for later, no problem — see below.

## 2. Connecting GitHub

The GitHub App is what lets Korrelo list your repositories and receive push
webhooks (automatic deploy). Without it, you can still use the rest of
Korrelo normally, only import/auto-deploy via GitHub becomes unavailable.
No need to configure this during `setup-vps.sh` — just press ENTER to skip
the domain prompt and take care of this later, at your own pace.

**Easy way (recommended)**: on Korrelo's dashboard, under "First steps",
click **"Create GitHub App automatically"**. This takes you straight to
GitHub with the name, permissions and webhook already filled in (GitHub's
"manifest" flow) — you just confirm the creation, Korrelo gets the
credentials back automatically (App ID, private key, webhook secret), and
sends you straight to installing the App on whichever repositories you
want. Nothing to copy by hand.

**Manual way** (if you'd rather control every field):

1. Go to **github.com/settings/apps/new** (personal account) or
   `github.com/organizations/YOUR_ORG/settings/apps/new` (organization).
2. Fill in:
   - **GitHub App name**: any unique name (e.g. `korrelo-your-username`).
   - **Homepage URL**: your Korrelo's URL (`https://YOUR_DOMAIN` or `http://YOUR_IP:3000`).
   - **Callback URL**: same URL as above.
   - **Setup URL (optional)**: check "Redirect on update" and set it to
     `https://YOUR_DOMAIN/api/github/callback` (or `http://YOUR_IP:3001/github/callback` without a domain) —
     without this, GitHub won't send you back to Korrelo after installing the App.
   - **Webhook → Active**: check it, and under **Webhook URL** put
     `https://YOUR_DOMAIN/api/github/webhook` (or `http://YOUR_IP:3001/github/webhook` without a domain).
   - **Webhook secret**: generate any random value and note it down, it'll become `GITHUB_APP_WEBHOOK_SECRET`.
   - **Permissions → Repository permissions**: `Contents: Read-only` (this is what unlocks the `Push` event below; `Metadata: Read-only` gets checked automatically).
   - **Subscribe to events**: check `Push` (only appears after checking the Contents permission above).
   - **Where can this GitHub App be installed?**: "Only on this account" is enough.
3. Create the App. On its page:
   - Note the **App ID** (top of the page) → `GITHUB_APP_ID`.
   - Note the **slug** (appears in the URL, e.g. `korrelo-your-username`) → `GITHUB_APP_SLUG`.
   - Under **Private keys**, click **Generate a private key**. This downloads a `.pem` file.
4. Install the App on your account/organization (**Install App** button), authorizing the repositories you want Korrelo to manage (or all of them).
5. In `apps/api/.env`, fill in:
   ```
   GITHUB_APP_SLUG=korrelo-your-username
   GITHUB_APP_ID=123456
   GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----"
   GITHUB_APP_WEBHOOK_SECRET=the-secret-you-generated
   ```
   The `.pem` content needs to become **a single line**, with `\n` in place
   of each real line break. Quick way to generate that:
   ```bash
   awk 'BEGIN{ORS="\\n"} {print}' path/to/your-key.pem
   ```
6. Restart the API so it re-reads the file: `pm2 restart korrelo-api`.

## 3. Accessing Korrelo

At the end of the script, it shows the access URL:

- **With a domain**: `https://YOUR_DOMAIN`
- **Without a domain**: `http://YOUR_IP:3000`

Open that URL in your browser. Since no account exists yet, you land
directly on the admin account creation screen (username + password). This is
the **only account** that exists in Korrelo today (single-admin), so keep
that password safe.

**Recommended right away**: go to **Security** and turn on 2FA (TOTP). It
takes 1 minute and prevents a leaked password from being enough for someone
to get in.

From there:
- **Projects** → "Import from GitHub" (if you configured the App) or create one manually with the repository URL.
- Each project has its own tabs: Summary, Environment Variables, Database, Terminal, Logs, Files, Cron, Settings.
- **Dashboard** shows the server's CPU/memory/disk (with history) and per-project usage.
- `Ctrl+K` (or `Cmd+K` on Mac) opens a quick search to navigate between pages and projects.

## Updating Korrelo

**Easy way**: when an update is available, a banner shows up on the
dashboard with an **"Update now"** button that runs the whole thing by
itself (with a progress bar and live log) and restarts the panel at the end.

**Manual way** (via SSH, e.g. to run once before the button exists on your install):

```bash
cd korrelo
git pull
npm install
npm run build --workspace=packages/shared-types
npm run build --workspace=apps/api
npm run build --workspace=apps/web
cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
(cd apps/api && npx prisma migrate deploy)
pm2 restart ecosystem.config.js
```

## Security

- **Two-factor login (2FA)**: turn it on under Security → Two-factor
  authentication. Recommended right after creating your account.
- **Project environment variables** are encrypted at rest in the database
  (AES-256-GCM, a key of its own per install). If a variable was written
  before encryption existed, Korrelo encrypts it by itself the next time it's read.
- **JWT_SECRET and ENV_ENCRYPTION_KEY** are generated automatically on first
  install (`setup-vps.sh`), and as an extra safety net, the API itself
  generates a fresh value on its own if either is missing when it starts —
  you can never end up without these keys by accident.
- **Connecting GitHub** (manual or automatic) is protected against forged
  links: Korrelo only completes that flow if it was started by your own
  logged-in session, so nobody can trick you into hijacking your GitHub
  integration by clicking a link.

## Backup

Automatically configured by `setup-vps.sh`: every day at 3am, it runs
`scripts/backup.sh` (Core database + project-managed databases) and keeps
the last 7 days in `~/korrelo-backups`. To run it by hand:

```bash
bash scripts/backup.sh
```

Configurable via `apps/api/.env` (`BACKUP_DIR`, `BACKUP_RETENTION_DAYS`,
`BACKUP_ALERT_NTFY_TOPIC` to get notified on your phone if it fails,
`BACKUP_RCLONE_REMOTE` to copy off the VPS, e.g. Google Drive).

## Troubleshooting

```bash
pm2 status                  # both processes (korrelo-api, korrelo-web) should be "online"
pm2 logs korrelo-api        # API logs in real time
pm2 logs korrelo-web        # frontend logs
pm2 restart ecosystem.config.js
```

- **Can't access via the URL**: check `sudo ufw status` (ports 80/443 and 3000/3001 must be open) and `pm2 status`.
- **Automatic deploy on push isn't working**: check whether `GITHUB_APP_WEBHOOK_SECRET` in `apps/api/.env` matches exactly the one in the GitHub App's settings, and whether the Webhook URL there points to your correct domain/IP.
- **Database error after updating**: run `cd apps/api && npx prisma migrate deploy` again.

## Try it locally (no VPS needed)

The "real" way to use Korrelo is on a VPS (section 1 above), but you can run
everything on your own machine (**Windows, Mac, or Linux**) in
development mode, just to try out the interface before deciding to host it
on a VPS.

**Prerequisites:**
- [Node.js 20+](https://nodejs.org)
- Git
- Docker Desktop (optional, only needed if you want to test a real project
  deploy; just browsing Korrelo's interface doesn't require it)

**Step by step:**

1. Clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/Korrelo.git korrelo
   cd korrelo
   ```
2. Install the dependencies:
   ```bash
   npm install
   ```
3. Copy the environment files:
   ```bash
   cp apps/api/.env.example apps/api/.env
   cp apps/web/.env.example apps/web/.env
   ```
   Open `apps/api/.env` and fill in `JWT_SECRET` and `ENV_ENCRYPTION_KEY`
   with random values (works the same on Windows, Mac, or Linux, just run it
   in a terminal where Node.js is available):
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # ENV_ENCRYPTION_KEY
   ```
4. Run the migrations (local SQLite, no need to install Postgres or Docker
   for the Core's database):
   ```bash
   npm run build --workspace=packages/shared-types
   cd apps/api && npx prisma migrate dev && cd ../..
   ```
5. Bring up both processes, each in its own terminal:
   ```bash
   npm run dev:api    # apps/api in watch mode (port 3001)
   npm run dev:web    # apps/web in dev mode (port 3000)
   ```
6. Open **http://localhost:3000** and create the admin account.

In this mode the GitHub App and automatic backup aren't configured (that's
what `setup-vps.sh` is for), but you can browse everything, create projects
manually with a repository URL, and see the dashboard working. To test a
real project deploy, Docker needs to be running.

Running the tests:

```bash
npm run test --workspace=apps/api
```

## License

[PolyForm Internal Use License 1.0.0](LICENSE): you can use, modify, and run
it freely on your own VPS or within your company. What you can't do is
distribute the software or offer a product/service to third parties whose
value comes from it (e.g. reselling it, or hosting it as a paid service).
