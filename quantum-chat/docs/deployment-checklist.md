# Quantum Chat — Deployment Checklist & Operations

## Pre-flight

- [ ] A domain you control, with edit access to its DNS.
- [ ] A fresh Ubuntu/Debian VPS with a static public IPv4.
- [ ] **UDP 53 and TCP 53** opened in the cloud provider's security group.
- [ ] SSH access confirmed (and you will `ufw allow OpenSSH` before enabling ufw).
- [ ] Decide storage mode: `ram` (default, nothing on disk) vs `postgres`
      (durable; set `QUANTUM_CHAT_POSTGRES_URL` and apply the schema first).

## Install

```bash
# From a checkout of the repo:
cd DrFXQuant/quantum-chat
sudo bash scripts/install-quantum-chat.sh

# Or one-line (clones the repo, builds the quantum-chat subdir):
sudo bash -c "$(curl -Ls https://YOUR_DOMAIN/install-quantum-chat.sh)"
```
The installer is **idempotent**: re-running keeps your existing `.env` and data
unless you pass `--force` (regenerates `.env`/secrets) — it never deletes data.

## Post-install verification

- [ ] `quantum-chat health` exits 0.
- [ ] `systemctl status quantum-chat` shows **active (running)**.
- [ ] `ss -lun | grep ':53'` and `ss -ltn | grep ':53'` show the listeners.
- [ ] From another host: `dig @<IP> <zone> SOA +norecurse` returns AA-flagged SOA.
- [ ] From another host: `dig +tcp @<IP> <zone> SOA` succeeds (TCP path).
- [ ] DNS records created in the parent zone (A glue + NS delegation).
- [ ] `ls -l /etc/quantum-chat/quantum-chat.env` shows `-rw------- quantum-chat`.
- [ ] Secrets present: `grep -c '^QUANTUM_CHAT_ADMIN_TOKEN=.\+' /etc/quantum-chat/quantum-chat.env` → 1.
- [ ] (If applicable) message round-trip test from two client devices.

The installer also performs several of these automatically (distro check, root
check, build, health, firewall, port-squat warning).

## Operational commands

```bash
# Status / logs / health
sudo systemctl status quantum-chat
sudo journalctl -u quantum-chat -f
sudo quantum-chat health

# Restart / stop / start
sudo systemctl restart quantum-chat
sudo systemctl stop quantum-chat
sudo systemctl start quantum-chat

# Update (rebuild + restart; atomic binary swap; data/.env untouched)
sudo bash scripts/update-quantum-chat.sh

# Uninstall (service + binary; data/config/user/firewall kept unless confirmed)
sudo bash scripts/uninstall-quantum-chat.sh
sudo bash scripts/uninstall-quantum-chat.sh --purge   # remove everything, no prompts
```

### Rotate secrets
```bash
sudo bash scripts/install-quantum-chat.sh --force   # regenerates .env secrets, preserves data dirs
# (or hand-edit /etc/quantum-chat/quantum-chat.env, then: sudo systemctl restart quantum-chat)
```

### Backup / restore configuration
```bash
# Backup (config only — RAM-mode message state is intentionally ephemeral):
sudo tar czf quantum-chat-config-$(date +%F).tgz -C /etc quantum-chat
# Restore:
sudo tar xzf quantum-chat-config-YYYY-MM-DD.tgz -C /etc
sudo systemctl restart quantum-chat
```
Keep backups secret: the `.env` contains `QUANTUM_CHAT_ADMIN_TOKEN` and
`QUANTUM_CHAT_SECRET_KEY`.

### Switch storage mode
```bash
# Enable RAM-only (default):
sudo sed -i 's/^QUANTUM_CHAT_STORAGE_MODE=.*/QUANTUM_CHAT_STORAGE_MODE=ram/' /etc/quantum-chat/quantum-chat.env
sudo systemctl restart quantum-chat

# Enable durable (Postgres) mode — apply schema, set URL + mode, restart:
psql "$QUANTUM_CHAT_POSTGRES_URL" -1 -f migrations/001_quantum_chat_schema.sql
sudo sed -i 's/^QUANTUM_CHAT_STORAGE_MODE=.*/QUANTUM_CHAT_STORAGE_MODE=postgres/' /etc/quantum-chat/quantum-chat.env
# also set QUANTUM_CHAT_POSTGRES_URL=... in the env file, then:
sudo systemctl restart quantum-chat   # logs "durable storage: postgres" on success
```

## Security hygiene

- [ ] Keep logs off (`QUANTUM_CHAT_ENABLE_LOGS=false`) unless debugging; content
      is never logged regardless.
- [ ] Run as the dedicated `quantum-chat` user via systemd (do not run as root).
- [ ] Restrict who can read `/etc/quantum-chat` (0600 env, 0750 dir).
- [ ] After any suspected host compromise: rotate the host and inform users to
      re-establish (the node holds no private keys, but treat it as untrusted).
- [ ] Tune `QUANTUM_CHAT_RATE_LIMIT_PER_MINUTE` for your abuse exposure.

## Known limitations to communicate to users

- DNS tunneling is **detectable** by DPI and is a *fallback*, not a stealth
  channel. (See `docs/threat-model.md`.)
- **Forward secrecy is partial on the wire.** A tested X3DH + Double Ratchet
  (`internal/ratchet`) provides full forward secrecy but is not yet wired into
  the live message path. (See `docs/forward-secrecy.md`.)
- A browser-only client uses **DNS-over-HTTPS**, which is itself HTTPS; full
  raw-port-53 operation requires the native client. (See `web/INTEGRATION.md`.)
- `postgres` durable mode persists messages until TTL and stores ciphertext
  only; if the database is unreachable the node falls back to RAM.
