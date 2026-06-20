# DrFX Quant — Server Migration Runbook

Move the entire platform to a stronger server with **zero data loss** and a
**provably intact ledger**. Works whether the target is a bigger VPS, a
dedicated machine, or a cloud instance — the procedure is identical.

This runbook is written for the platform exactly as it is deployed:

| Thing | Where it lives (current server) |
|---|---|
| Running app (PM2 `cwd`) | `/var/www/drfx-quantum` (a **copy target**, not a git repo) |
| Git checkout (deploy source) | `/root/DrFXQuant` (`~/DrFXQuant`) |
| Database | one PostgreSQL DB `drfx_quantum`, owned by role `drfx`, on `localhost:5432` |
| Ledger tables | same DB (`wallets`, `transactions`, `ledger_entries`, `audit_log`, `escrows`, …) |
| App tables | same DB (`users`, `chats`, `messages`, `products`, `product_purchases`, `payments`, `posts`, …) |
| Environment | `/var/www/drfx-quantum/.env` (mode `600`) |
| Uploads / files | `/var/www/drfx-quantum/uploads` |
| Process manager | PM2 process **`drfx-quantum`** (`pm2 start server.js --name drfx-quantum --cwd /var/www/drfx-quantum`) |
| Reverse proxy | `/etc/nginx/sites-available/drfx-quantum` (+ symlink in `sites-enabled`) |
| TLS certs | `/etc/letsencrypt/…` (Let's Encrypt, via certbot) |

> The host app and the qntm-ledger engine **share one database**. There is no
> second DB to migrate — but that one DB is sacred. Treat every step that
> touches it as all-or-nothing.

---

## 0. The five golden rules (read first)

1. **The old server is your rollback.** During the entire migration you only
   ever *read* from it. Do not delete, re-image, or reconfigure it until the new
   server has fully passed validation **and** has served live traffic for a few
   days. As long as the old box is intact, any failure is recoverable.
2. **Stop writes before the final dump.** `pg_dump` is internally consistent
   even under load (it never captures a half-written transaction), but anything
   written *after* the dump snapshot is not in it. Stopping the app guarantees
   nothing is written after the snapshot, so nothing can be lost.
3. **Restore all-or-nothing.** Always restore inside a single transaction
   (`pg_restore --single-transaction --exit-on-error`, or
   `psql --single-transaction -v ON_ERROR_STOP=1`). A partial restore of a
   double-entry ledger is worse than no restore — it must never be left half-done.
4. **Prove it before you cut over.** Run `scripts/verify-ledger.sql` on both
   servers and diff. The two integrity invariants must read exactly `0`, and the
   counts/hashes must match, *before* you switch DNS.
5. **Cut over by DNS only after validation.** Test the new server against the
   real domain via a local `hosts` override first. Switch public DNS last.

---

## 1. Migration goal

A repeatable procedure delivering: zero data loss · preserved ledger integrity ·
preserved wallet balances · preserved user accounts · preserved marketplace data
· minimal downtime. Downtime is confined to a single short cutover window
(final dump → transfer → restore → verify → DNS), typically 10–30 minutes for a
small/moderate database, because everything heavy is staged in advance (Phase A).

Set these shell variables on both servers as you go (adjust to your values):

```bash
OLD_IP=203.0.113.10            # current server
NEW_IP=198.51.100.20           # target server
DOMAIN=chat.drfx.com           # your real domain (must match .env DOMAIN/ALLOWED_ORIGINS)
ADMIN_EMAIL=admin@drfx.com     # for certbot
APP_DIR=/var/www/drfx-quantum
DB=drfx_quantum
DB_USER=drfx
```

---

## 2. Components to migrate (what → how)

| Component | Source | Migration method |
|---|---|---|
| Node app, `qntm-ledger/`, `routes/`, `realtime/`, `middleware/`, `services/`, `migrations/`, frontend `public/` | `/var/www/drfx-quantum` | `rsync` the whole tree (minus `node_modules`), then `npm install` to rebuild native modules |
| Database (app + ledger tables) | PostgreSQL `drfx_quantum` | `pg_dump -Fc` → `pg_restore --single-transaction` |
| DB role + password | PostgreSQL globals | `pg_dumpall --roles-only` → restore (keeps `DATABASE_URL` valid) |
| `.env` (JWT secret, DB creds, API keys, NOWPayments secrets, TV secret) | `/var/www/drfx-quantum/.env` | copy verbatim, `chmod 600` |
| Uploads (product files, user uploads, images, avatars) | `/var/www/drfx-quantum/uploads` | `rsync` / tarball |
| PM2 process | runtime | re-create with one command + `pm2 save` + `pm2 startup` |
| nginx | `/etc/nginx/sites-available/drfx-quantum` | copy the site file (edit IP/domain if needed) |
| TLS | `/etc/letsencrypt` | **re-issue** with certbot after DNS cutover (recommended) |

> **Why `.env` must be copied verbatim:** it holds `JWT_SECRET` (changing it logs
> every user out — annoying, not data loss), the `DATABASE_URL`/`DB_PASS`, the
> `NOWPAYMENTS_IPN_SECRET` (changing it breaks webhook signature verification on
> in-flight top-ups), and `TRADINGVIEW_WEBHOOK_SECRET`. Keep them identical.

---

## 3. Recommended method & why

**Database → `pg_dump` custom-format + `pg_restore` (single transaction).**
Preferred over a filesystem copy of PostgreSQL's data directory or over plain
`scp` of files because:

- It is **version-portable** (you can restore into an equal-or-newer PostgreSQL
  major version, which is what you get on a fresh box).
- The custom format (`-Fc`) is compressed, and `pg_restore` can restore it
  **atomically** (`--single-transaction`) so the ledger can never be left
  half-loaded.
- `pg_dump` captures a **single consistent MVCC snapshot** — no partial
  transactions, FK-consistent, and it preserves **sequence positions** so new
  IDs continue from where they left off (no collisions).

We also take a **plain-SQL gzip twin** (`-Fp`) as a universally-restorable
fallback, and dump **roles** separately so the `drfx` login is recreated with the
same password (keeping `DATABASE_URL` valid unchanged).

**Code + uploads + `.env` → `rsync` over SSH.** `rsync` is restartable, verifies
by checksum, and transfers only deltas — ideal for re-syncing right before
cutover after a bulk pre-sync.

The canonical flow (expanded in §5): maintenance mode → dump DB → transfer →
restore DB → deploy app + `.env` → `npm install` → start services → validate →
switch DNS.

---

## 4. Procedure

### Phase A — Stage the new server (no downtime; do this in advance)

Everything here happens while the old server keeps serving traffic.

**A1. Provision the OS + stack on the new server.** Match or exceed the old
versions (check the old box first: `node -v`, `psql --version`).

```bash
# On NEW server (Ubuntu), as root:
apt update -y && apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -   # Node 20 (>=18 required)
apt install -y nodejs build-essential python3 git nginx postgresql postgresql-contrib
npm install -g pm2
systemctl enable --now postgresql
```

> **PostgreSQL version:** the new server's major version must be **>= the old
> server's** (a dump restores forward, not backward). `psql --version` on both;
> if the new repo gives you an older major, install the matching/newer PGDG
> package before continuing.

**A2. Pre-sync code + uploads** (a bulk copy now means a tiny delta at cutover):

```bash
# On NEW server:
mkdir -p "$APP_DIR"
rsync -avzP --exclude node_modules -e ssh root@$OLD_IP:/var/www/drfx-quantum/ "$APP_DIR/"
git clone https://github.com/drfxai/DrFXQuant.git /root/DrFXQuant   # for future deploys
```

**A3. Build dependencies on the new arch** (rebuilds `bcrypt`, `pg`, optional
`mediasoup` for this machine — do not copy `node_modules` between machines):

```bash
cd "$APP_DIR" && rm -rf node_modules && npm install --production
```

Do **not** start the app yet — its database does not exist on the new box.

---

### Phase B — Cutover (the short downtime window)

**B1. Enter maintenance mode on the OLD server — stop writes.** The Node app is
the only writer, so stopping it freezes all state.

```bash
# On OLD server:
pm2 stop drfx-quantum
```

*(Optional, to show visitors a friendly page instead of a dead port during the
window, add a temporary `location / { return 503; }` server block or a static
maintenance root in nginx and `systemctl reload nginx`. Revert it after cutover.)*

**B2. Take the final, consistent backup on the OLD server.**

```bash
# On OLD server:
TS=$(date +%Y%m%d-%H%M%S); BK=/root/drfx-migration-$TS; mkdir -p "$BK"

# Roles/globals (recreates the drfx login with its existing password)
sudo -u postgres pg_dumpall --roles-only > "$BK/roles.sql"

# Primary DB dump — custom format, atomic-restorable
sudo -u postgres pg_dump -Fc --verbose -d "$DB" -f "$BK/$DB.dump"

# Plain-SQL gzip twin — universal fallback
sudo -u postgres pg_dump -Fp --no-owner --no-privileges -d "$DB" | gzip > "$BK/$DB.sql.gz"

# App config + uploads + nginx site
cp "$APP_DIR/.env"                              "$BK/env.backup"
tar -czf "$BK/uploads.tgz" -C "$APP_DIR" uploads
cp /etc/nginx/sites-available/drfx-quantum      "$BK/nginx-drfx-quantum.conf"

# Integrity fingerprint of the SOURCE (save it to compare after restore)
sudo -u postgres psql -d "$DB" -At -f /root/DrFXQuant/scripts/verify-ledger.sql | tee "$BK/fingerprint-OLD.txt"

# Checksums of every artifact
cd "$BK" && sha256sum * > SHA256SUMS && cat SHA256SUMS
```

Confirm `fingerprint-OLD.txt` shows `INVARIANT.ledger_signed_sum [MUST=0] | 0`
and `INVARIANT.wallet_conservation [MUST=0] | 0`. If either is non-zero, the
**source** is inconsistent — stop and investigate before migrating.

**B3. Transfer the backup to the new server, and re-sync the file deltas.**

```bash
# On NEW server:
mkdir -p /root/drfx-restore
rsync -avzP -e ssh root@$OLD_IP:/root/drfx-migration-*/ /root/drfx-restore/
cd /root/drfx-restore && sha256sum -c SHA256SUMS    # MUST say OK for every file

# Pull the tiny delta written since the Phase-A bulk sync (app is stopped, so this is final)
rsync -avzP --exclude node_modules -e ssh root@$OLD_IP:/var/www/drfx-quantum/ "$APP_DIR/"
```

**B4. Restore the database on the NEW server — atomically.**

```bash
# On NEW server:
BK=/root/drfx-restore

# 1) Recreate the drfx role with its original password (keeps DATABASE_URL valid)
sudo -u postgres psql -f "$BK/roles.sql"

# 2) Create an empty DB owned by drfx, then restore ALL-OR-NOTHING
sudo -u postgres createdb -O "$DB_USER" "$DB"
sudo -u postgres pg_restore --single-transaction --exit-on-error -d "$DB" "$BK/$DB.dump"

#    Fallback (only if the custom-format restore is unavailable):
#    zcat "$BK/$DB.sql.gz" | sudo -u postgres psql --single-transaction -v ON_ERROR_STOP=1 -d "$DB"

# 3) Re-grant table privileges to drfx (migrations create postgres-owned tables;
#    this mirrors install.sh so the app user can read/write everything)
sudo -u postgres psql -d "$DB" <<'SQL'
GRANT USAGE ON SCHEMA public TO drfx;
GRANT ALL ON ALL TABLES IN SCHEMA public TO drfx;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO drfx;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO drfx;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO drfx;
SQL
```

If `pg_restore` prints any error, the `--single-transaction` flag has already
rolled the whole thing back — fix the cause and re-run; never proceed on a
partial DB.

**B5. Put `.env` + uploads in place** (already covered by the rsync in B3, but
verify explicitly):

```bash
# On NEW server:
test -f "$APP_DIR/.env" || cp "$BK/env.backup" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
# If you migrated uploads by tarball instead of rsync:
# tar -xzf "$BK/uploads.tgz" -C "$APP_DIR"
ls "$APP_DIR/uploads" | head        # sanity: files are present
```

**B6. Start the app + reverse proxy on the NEW server.**

```bash
# On NEW server:
cp "$BK/nginx-drfx-quantum.conf" /etc/nginx/sites-available/drfx-quantum
ln -sf /etc/nginx/sites-available/drfx-quantum /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

cd "$APP_DIR"
pm2 start server.js --name drfx-quantum --cwd "$APP_DIR"
pm2 save
pm2 startup systemd -u root --hp /root      # then run the exact line it prints
pm2 logs drfx-quantum --lines 50            # confirm a clean boot (no MODULE_NOT_FOUND / DB errors)
```

On boot the app runs its **idempotent** schema setup (`initDB()` +
`setupQntmSchema()`): every statement is `CREATE … IF NOT EXISTS` /
`ALTER … IF NOT EXISTS` / `INSERT … ON CONFLICT`, so it sees the restored schema
and data and changes nothing. (It will re-sync the admin password from
`ADMIN_PASSWORD` in `.env` — which is the same value, so the admin login is
unchanged.)

**B7. VALIDATE before touching DNS — run §5 below.** Only proceed once the
fingerprints match and the smoke tests pass.

**B8. Cut over DNS.** Lower the record's TTL to ~300s a day in advance so this
propagates fast. Point the `A` record (and `AAAA` if used) for `$DOMAIN` from
`$OLD_IP` to `$NEW_IP`. The NOWPayments IPN callback and TradingView webhooks are
addressed by domain, so they follow automatically once DNS moves.

**B9. Issue fresh TLS on the new server** (do this once DNS resolves to it):

```bash
# On NEW server:
apt install -y certbot python3-certbot-nginx
certbot --nginx -d "$DOMAIN" --agree-tos -m "$ADMIN_EMAIL" --non-interactive
```

**B10.** Leave the old server **stopped but intact** for a few days as the
rollback. Only after you are confident: decommission it.

---

## 5. Verification

### 5a. Ledger / data integrity (the proof)

Run the **same** fingerprint on the new server and diff against the old one:

```bash
# On NEW server:
sudo -u postgres psql -d "$DB" -At -f /root/DrFXQuant/scripts/verify-ledger.sql > /root/fingerprint-NEW.txt

# Compare (copy fingerprint-OLD.txt over from the old box first):
scp root@$OLD_IP:/root/drfx-migration-*/fingerprint-OLD.txt /root/
diff /root/fingerprint-OLD.txt /root/fingerprint-NEW.txt && echo "✅ IDENTICAL — ledger intact"
```

`diff` must report **no differences**. In particular:

- `INVARIANT.ledger_signed_sum [MUST=0]` → `0` on both (no half-written txns).
- `INVARIANT.wallet_conservation [MUST=0]` → `0` on both (supply conserved).
- `supply.total_issued` identical (e.g. the 1,000,000,000 QNTM from bootstrap).
- `count.ledger_entries`, `count.transactions`, `count.wallets`, etc. identical.
- `hash.wallet_balances`, `hash.ledger_entries`, `hash.transactions` identical
  (every balance and entry survived byte-for-byte).

The exact invariant queries, if you want to eyeball them directly:

```sql
-- Double-entry: every debit has its credit. MUST be 0.
SELECT COALESCE(SUM(signed_amount),0) AS ledger_signed_sum FROM ledger_entries;

-- Conservation: genesis holds -(issued), so all balances net to 0. MUST be 0.
SELECT COALESCE(SUM(available_balance+pending_balance+locked_balance),0) AS conservation FROM wallets;

-- Total issued (compare old vs new):
SELECT -SUM(available_balance) AS total_issued FROM wallets WHERE wallet_type='genesis';

-- Per-wallet balances (if a hash mismatches, this finds the offending wallet):
SELECT id, wallet_type, owner_id, available_balance, pending_balance, locked_balance
FROM wallets ORDER BY id;
```

### 5b. Functional smoke test (against the real domain, before DNS switch)

Point your **local** machine at the new IP without changing public DNS, then run
the app's own flows:

```bash
# On your laptop: temporarily map the domain to the new box
echo "$NEW_IP  $DOMAIN" | sudo tee -a /etc/hosts
# ...test in a browser / curl, then REMOVE that line afterwards.

# Or one-off with curl (no hosts edit), e.g. health + login:
curl --resolve $DOMAIN:443:$NEW_IP https://$DOMAIN/ -I
curl --resolve $DOMAIN:443:$NEW_IP https://$DOMAIN/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"'"$ADMIN_EMAIL"'","password":"<admin-password>"}'
```

Checklist — confirm each:

- [ ] **Users can log in** (existing account returns a token; password unchanged).
- [ ] **Wallet balances match** — open a known user's QNTM wallet; the number
      equals the old server's, and the Control Deck `summary` pools match.
- [ ] **Marketplace works** — product list loads; a test purchase debits the
      buyer and credits the seller (writes a new ledger transaction).
- [ ] **Admin economy endpoints respond** — `GET /api/qntm/admin/economy/summary`
      and `/payment-orders` return 200 for an admin token.
- [ ] **Ledger writes correctly** — perform a small Control-Deck grant/reclaim
      (then reclaim it back) and confirm a new `ledger_entries` pair appears and
      `ledger_signed_sum` is still `0`.
- [ ] **Uploads serve** — an existing avatar/product image loads; a new upload
      saves to `/var/www/drfx-quantum/uploads` and displays.
- [ ] **Realtime works** — a chat message delivers over Socket.io.
- [ ] **PM2 boot clean** — `pm2 logs drfx-quantum` shows no `MODULE_NOT_FOUND`,
      no DB permission errors.

---

## 6. Optional: near-zero-downtime strategy

Two ladders, in increasing sophistication. The §4 stop-the-world flow is the
safest and is recommended unless a maintenance window is unacceptable.

### 6a. Brief read-only window (simple)

Instead of fully stopping the app, hold it read-only just long enough to dump.
The cleanest lever here is still **stopping the writer** (the Node app), because
the platform has no application-level read-only mode. If you must keep reads
serving, you can additionally set the database to refuse writes:

```sql
ALTER DATABASE drfx_quantum SET default_transaction_read_only = on;
-- ...take the dump...   then on rollback/abort:
ALTER DATABASE drfx_quantum SET default_transaction_read_only = off;
```

This narrows downtime to the dump+transfer+restore, not the whole validation.

### 6b. Streaming replication, then promote (true near-zero downtime)

Stand the new server up as a **physical replica** of the old primary, let it
stream until it is caught up, then promote it and cut over. Downtime shrinks to
just the promote + DNS step (seconds to a minute).

Outline (PostgreSQL 12+):

1. **Primary (old):** allow a replication connection — create a role
   `CREATE ROLE repl WITH REPLICATION LOGIN PASSWORD '…';`, add a `host
   replication repl <new_ip>/32 scram-sha-256` line to `pg_hba.conf`, ensure
   `wal_level=replica` (default) and `listen_addresses` includes the NIC, then
   reload.
2. **Replica (new):** stop its empty PostgreSQL, wipe its data dir, and clone the
   primary:
   ```bash
   sudo -u postgres pg_basebackup -h $OLD_IP -U repl -D /var/lib/postgresql/<ver>/main -R -P --wal-method=stream
   ```
   The `-R` writes `standby.signal` + `primary_conninfo`. Start it; it now streams
   and stays current. Verify lag with `SELECT * FROM pg_stat_replication;` on the
   primary.
3. **Cutover:** briefly `pm2 stop drfx-quantum` on the old box (so the last writes
   flush), confirm the replica has caught up (`pg_last_wal_replay_lsn()` matches
   the primary's flush LSN), then promote: `sudo -u postgres pg_ctl promote -D
   /var/lib/postgresql/<ver>/main` (or `SELECT pg_promote();`). Start the app on
   the new server, run §5 verification, switch DNS.

The uploads/code are kept current the same way as §4 (a final `rsync` delta at
cutover, which is tiny). Replication covers only the database.

> Replication requires the same PostgreSQL **major version** on both ends and is
> more moving parts; if in doubt, the §4 dump/restore with a short window is the
> dependable choice and is what this runbook treats as primary.

---

## 7. Disaster recovery & rollback

### 7a. If migration fails *before* DNS cutover

Nothing was lost — the new server never took traffic. Recovery:

```bash
# On OLD server: bring the platform back exactly as it was
pm2 start drfx-quantum
# (revert any temporary nginx maintenance/read-only changes; if you set the DB
#  read-only in 6a, run: ALTER DATABASE drfx_quantum SET default_transaction_read_only = off;)
```

DNS still points at the old server, so users are served immediately. Fix the
issue on the new box and retry the cutover later.

### 7b. If a problem appears *after* DNS cutover

Revert DNS `A`/`AAAA` back to `$OLD_IP` and `pm2 start drfx-quantum` on the old
server. Note: any writes made on the new server after cutover live only on the
new server — that is exactly why §5 validation happens **before** the DNS switch
(using the `hosts`/`--resolve` trick), so you cut over only once you are
confident. If you must roll back after real traffic hit the new box, reverse the
migration (dump the **new** DB, restore onto the old) rather than lose those
writes.

### 7c. Restore the whole system from the backup set (clean-room DR)

The artifacts produced in **B2** (`$DB.dump`, `$DB.sql.gz`, `roles.sql`,
`uploads.tgz`, `env.backup`, `nginx-drfx-quantum.conf`, `SHA256SUMS`) are a
complete recovery kit. On any fresh Ubuntu box:

```bash
# 1) Stack (as in Phase A)
apt update -y && apt install -y nodejs build-essential git nginx postgresql postgresql-contrib && npm i -g pm2

# 2) Verify the kit, then restore the database (atomic)
cd /root/drfx-restore && sha256sum -c SHA256SUMS
sudo -u postgres psql -f roles.sql
sudo -u postgres createdb -O drfx drfx_quantum
sudo -u postgres pg_restore --single-transaction --exit-on-error -d drfx_quantum drfx_quantum.dump
#   or: zcat drfx_quantum.sql.gz | sudo -u postgres psql --single-transaction -v ON_ERROR_STOP=1 -d drfx_quantum
sudo -u postgres psql -d drfx_quantum -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO drfx; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO drfx;"

# 3) Application code
git clone https://github.com/drfxai/DrFXQuant.git /root/DrFXQuant
mkdir -p /var/www/drfx-quantum && cp -r /root/DrFXQuant/{server.js,database.js,package.json,routes,public,middleware,services,migrations,realtime,qntm-ledger,scripts} /var/www/drfx-quantum/

# 4) Config + uploads
cp /root/drfx-restore/env.backup /var/www/drfx-quantum/.env && chmod 600 /var/www/drfx-quantum/.env
tar -xzf /root/drfx-restore/uploads.tgz -C /var/www/drfx-quantum

# 5) Dependencies + start
cd /var/www/drfx-quantum && npm install --production
pm2 start server.js --name drfx-quantum --cwd /var/www/drfx-quantum && pm2 save

# 6) nginx + TLS
cp /root/drfx-restore/nginx-drfx-quantum.conf /etc/nginx/sites-available/drfx-quantum
ln -sf /etc/nginx/sites-available/drfx-quantum /etc/nginx/sites-enabled/ && rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d "$DOMAIN" --agree-tos -m "$ADMIN_EMAIL" --non-interactive

# 7) Prove integrity
sudo -u postgres psql -d drfx_quantum -At -f /root/DrFXQuant/scripts/verify-ledger.sql
```

### 7d. Ongoing backups (so DR is always possible)

Schedule the same dump nightly and keep several days offsite. Minimal cron:

```bash
# /etc/cron.d/drfx-backup  — nightly 03:17, keep 14 days
17 3 * * * postgres pg_dump -Fc -d drfx_quantum -f /var/backups/drfx/drfx_quantum-$(date +\%F).dump && \
           tar -czf /var/backups/drfx/uploads-$(date +\%F).tgz -C /var/www/drfx-quantum uploads && \
           find /var/backups/drfx -type f -mtime +14 -delete
```

(Create `/var/backups/drfx`, ensure the `postgres` user can write it, and ship a
copy offsite — e.g. `rclone`/`aws s3 cp` — so a lost server doesn't lose backups.)

---

## 8. Deliverables checklist (what this runbook gives you)

- ✅ **Complete migration guide** — §4 (staged Phase A + short-window Phase B).
- ✅ **Exact commands** — provision, dump, transfer, restore, deploy, start, DNS,
  TLS — all with the real paths (`/var/www/drfx-quantum`), DB (`drfx_quantum`),
  role (`drfx`), and process name (`drfx-quantum`).
- ✅ **Verification SQL** — `scripts/verify-ledger.sql` + the inline invariant
  queries in §5; the two `[MUST=0]` rows and the content hashes are the integrity
  proof.
- ✅ **Rollback strategy** — §0 rule 1 (old server is the rollback) + §7a/§7b for
  before/after cutover + §7c full clean-room restore.

Follow it top to bottom and the ledger, wallet balances, user accounts, and
marketplace data move with zero loss — and you can *prove* it before a single
user is sent to the new server.
