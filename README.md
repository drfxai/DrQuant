<p align="center">
  <img src="https://raw.githubusercontent.com/drfxai/DrFXQuant/main/docs/logo.svg" width="80" alt="DrFX Quant"/>
</p>

<h1 align="center">DrFX Quant</h1>

<p align="center">
  <strong>Open-source, Telegram-style trading communication platform</strong><br/>
  Real-time messaging · AI assistant · Live screen sharing · Crypto payments · One-command deploy
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-5.2-blue?style=flat-square" alt="Version"/>
  <img src="https://img.shields.io/badge/node-%3E%3D18-green?style=flat-square&logo=node.js" alt="Node"/>
  <img src="https://img.shields.io/badge/database-PostgreSQL-336791?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL"/>
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" alt="License"/>
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs"/>
</p>

---

## What is DrFX Quant?

A self-hosted, real-time messaging platform built for trading communities. Think of it as your own private Telegram — with a built-in AI trading assistant, live screen-share sessions, crypto subscription payments, TradingView webhook signals, and full admin control. Deploy on any Ubuntu/Debian VPS in a few minutes with a single script.

## Features

**Messaging**
- Direct messages, groups, and channels (public and private)
- Real-time delivery via WebSocket (Socket.io)
- Image sharing, emoji picker, message edit & delete
- Typing indicators, read receipts, unread badges with sound notifications
- Markdown formatting (bold, italic, code blocks)

**Chat actions**
- Reply, Copy, Edit, and Delete on messages
- Members can edit/delete their own messages; admins and managers can moderate any message
- Reply quotes the sender name and a preview, and tapping it scrolls to the original

**AI trading assistant**
- Built-in AI bot auto-created for every new user
- Powered by OpenRouter (Claude, GPT, and others) — bring your own API key
- Technical analysis, chart patterns, risk management, Pine Script help
- Configurable daily limits for free-tier users

**Telegram-style UX**
- Public groups/channels: anyone can search and join freely
- Private groups/channels: admin invitation only
- Full-screen join preview before entering public chats
- Global search across users, groups, and channels by name, email, or @username
- Unique @username system for users and chats

**Manual trading**
- Full TradingView Advanced Chart embedded in-app, with the professional tool set
- Quick symbol switcher: Forex, Crypto, Indices (EUR/USD, BTC/USD, SPX 500, and more)
- Timeframe selector from 1m to 1W with one-click switching
- Full-screen and landscape modes for immersive charting
- Analysis Notes: save personal notes per symbol with direction and timeframe tags
- Theme-synced (Galaxy Dark / Crystal Light), preferences saved between sessions

**Live trading**
- Admin screen share to all users for real-time trading sessions
- High-FPS (30–60) WebRTC streaming via a built-in SFU (mediasoup) + TURN (coturn), installed and activated by default; gracefully falls back to a low-FPS relay if disabled
- Users automatically see the stream when entering the section
- Live status indicator with viewer count, stream timer, and auto-cleanup on disconnect
- Adjustable quality (frame rate) for bandwidth control

**TradingView webhooks & signals**
- Receive TradingView alerts at `/api/webhooks/tradingview` using a per-deployment shared secret
- Broadcast incoming signals to a designated channel (e.g. `signals`)
- Webhook secret is auto-generated at install time and stored in `.env`

**Quantum Chat (optional)**
- A separate, DNS-resilient, end-to-end-encrypted "emergency" messenger, reachable from the in-app menu
- Keys, contacts, and messages stay in the browser — they are never sent to the backend or database
- Designed to keep working when the main site is blocked (and vice-versa)
- Best-effort by design: it routes over DNS-over-HTTPS and **requires running the optional node with a delegated DNS subdomain** (see [Quantum Chat](#quantum-chat) below). Always compare a contact's safety number out of band before trusting it.

**Admin dashboard**
- Live stats: users, messages, chats, subscriptions, daily activity
- Search, block/unblock, and delete users
- Grant Pro subscriptions
- Admin-only group and channel creation

**Payments**
- Crypto subscriptions via NowPayments
- Free tier with daily AI message limits; Pro tier unlocks unlimited AI access

**Mobile-first design**
- Fully responsive: phone, tablet, desktop
- Keyboard-safe layout and native mobile keyboard handling
- Dual themes: Galaxy Dark and Crystal Light
- Touch-optimized interactions

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ |
| Framework | Express.js |
| Real-time | Socket.io |
| Database | PostgreSQL (schema + idempotent SQL migrations) |
| Auth | JWT + bcrypt |
| AI | OpenRouter API |
| Payments | NowPayments |
| Uploads | Multer |
| Frontend | Vanilla JS SPA (zero framework dependencies) |
| Process Manager | PM2 |
| Reverse Proxy | Nginx |
| SSL | Let's Encrypt (Certbot) |
| Quantum Chat node | Go (optional, separate service) |

## Quick Start

### One-command install (Ubuntu/Debian VPS)

```bash
git clone https://github.com/drfxai/DrFXQuant.git
cd DrFXQuant
sudo bash install.sh
```

The installer handles everything: Node.js, PostgreSQL, Nginx, PM2, SSL, database schema and migrations, and an interactively-created admin account. It also installs and activates the high-FPS **Live Trading** stack — the WebRTC **SFU (mediasoup) + TURN (coturn)** for smooth 30–60 FPS screen sharing — **on by default**; just press Enter at the prompt. On a small (1 GB) box, skip it by running `sudo INSTALL_SFU=no bash install.sh` instead. It can also optionally install the Quantum Chat node.

### Manual setup

```bash
# 1. Clone and install dependencies
git clone https://github.com/drfxai/DrFXQuant.git
cd DrFXQuant
npm install

# 2. Configure environment
cp .env.example .env
nano .env  # Edit with your settings

# 3. Ensure PostgreSQL is running with credentials matching .env

# 4. Start
npm start
```

Open `http://localhost:3000` — the database schema and admin account are created automatically on first run.

### Updating (in place, no full reinstall)

```bash
cd DrFXQuant
git pull
sudo bash update.sh
```

`update.sh` refreshes the application code and dependencies and applies only **new** database migrations (already-applied ones are tracked and skipped). It preserves your `.env`, the database and all its data, and the `uploads/` folder, and it stops before restarting if a migration fails.

### Everyday management

```bash
sudo bash /var/www/drfx-quant/manage.sh
```

`manage.sh` is a read-only reference card: it prints the current configuration, live resource usage, and the exact commands to change each part of the deployment (domain, admin, port, database, SSL, firewall, logs).

### Uninstall

```bash
sudo bash uninstall.sh
```

Removes the app, Nginx config, and PM2 process, and optionally the database.

## Configuration

Copy `.env.example` to `.env` and configure:

```env
PORT=3000
JWT_SECRET=generate_with_openssl_rand_hex_32
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=your_secure_password

# PostgreSQL
DB_USER=drfx
DB_PASS=your_db_password
DB_HOST=localhost
DB_PORT=5432
DB_NAME=drfx_quant

# AI (optional — get a key at openrouter.ai)
OPENROUTER_API_KEY=sk-or-...

# Payments (optional — get keys at nowpayments.io)
NOWPAYMENTS_API_KEY=...
NOWPAYMENTS_IPN_SECRET=...

# TradingView webhooks — generate with: openssl rand -hex 32
TRADINGVIEW_WEBHOOK_SECRET=generate_with_openssl_rand_hex_32
SIGNAL_CHANNEL_USERNAME=signals
```

The admin account is created (and re-synced) from `ADMIN_EMAIL` / `ADMIN_PASSWORD` on every boot. See `.env.example` for the full list of options.

## Project Structure

```
DrFXQuant/
├── server.js              # Express + Socket.io entry point
├── database.js            # PostgreSQL schema, base tables, seeding
├── package.json
├── .env.example
├── routes/
│   ├── auth.js            # Register, login, profile, username/email auth
│   ├── chats.js           # Chats, messages, members, search, AI bot, trading notes
│   ├── admin.js           # Dashboard stats, user management
│   ├── payment.js         # NowPayments crypto subscriptions
│   ├── upload.js          # Image upload via Multer
│   ├── webhooks.js        # TradingView webhook receiver
│   └── manage.js          # Role-based management console
├── middleware/            # Optional RBAC + permissions (opt-in, see INTEGRATION.md)
├── services/              # Supporting services
├── realtime/              # Socket.io messaging + live screen-share signaling
├── migrations/            # Idempotent SQL migrations (signals, webhooks, reactions, …)
├── public/
│   ├── index.html         # Complete single-file SPA frontend
│   └── quantum-chat.html  # Quantum Chat browser panel
├── quantum-chat/          # Optional Go DNS messenger node + browser client (web/)
├── docs/                  # Architecture, database, security, webhooks, logo
├── install.sh             # One-command VPS installer
├── update.sh              # In-place updater (preserves data, applies new migrations)
├── manage.sh              # Read-only management reference card
├── uninstall.sh           # Clean removal script
├── nginx.conf             # Nginx reference config
└── INSTALL.txt            # Full setup & troubleshooting guide
```

## Permissions

| Action | User | Admin |
|--------|------|-------|
| Send DMs | ✅ | ✅ |
| Join public groups/channels | ✅ | ✅ |
| Join private groups/channels | ❌ | ✅ (invite) |
| Create groups/channels | ❌ | ✅ |
| Edit/delete own messages | ✅ | ✅ |
| Edit/delete any message | ❌ | ✅ |
| View private member list | ❌ | ✅ |
| Start a live stream | ❌ | ✅ |
| Admin dashboard | ❌ | ✅ |

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/register` | Create account |
| `POST` | `/api/auth/login` | Sign in (email or @username) |
| `GET` | `/api/auth/me` | Current user profile |
| `PUT` | `/api/auth/profile` | Update name, bio, avatar, username |
| `GET` | `/api/chats` | List user's chats |
| `POST` | `/api/chats` | Create DM / group / channel |
| `GET` | `/api/chats/:id` | Chat details (public viewable by non-members) |
| `PUT` | `/api/chats/:id` | Update chat (admin) |
| `DELETE` | `/api/chats/:id` | Delete chat (admin) |
| `POST` | `/api/chats/:id/members` | Join public chat or add member (admin) |
| `DELETE` | `/api/chats/:id/members/:uid` | Leave or remove member |
| `GET` | `/api/chats/:id/messages` | Get messages (paginated) |
| `POST` | `/api/chats/:id/messages` | Send message (text and/or image) |
| `PUT` | `/api/chats/:cid/messages/:mid` | Edit message |
| `DELETE` | `/api/chats/:cid/messages/:mid` | Delete message |
| `GET` | `/api/chats/users/search?q=` | Global search (users + chats) |
| `GET` | `/api/chats/trading-notes/:symbol` | Personal analysis notes for a symbol |
| `POST` | `/api/chats/trading-notes` | Save an analysis note |
| `GET` | `/api/admin/stats` | Dashboard statistics |
| `GET` | `/api/admin/users` | User list with search |
| `POST` | `/api/payment/create` | Create crypto invoice |
| `GET` | `/api/payment/status` | Subscription status |
| `POST` | `/api/upload` | Upload image |
| `POST` | `/api/webhooks/tradingview` | TradingView alert receiver (shared-secret auth) |

## Socket.io Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `chat_message` | Server → Client | New message in a chat |
| `message_edited` | Server → Client | Message was edited |
| `message_deleted` | Server → Client | Message was deleted |
| `online_users` | Server → Client | Updated list of online user IDs |
| `typing` | Both | Typing indicator |
| `live_*` | Both | Live screen-share start/stop/frame and status events |

## Quantum Chat

Quantum Chat is an **optional**, separate, end-to-end-encrypted messenger that routes over DNS so it can keep working when ordinary web access is blocked. The in-app panel is always available, but to actually connect it needs a running node:

1. **Install the node** (offered by `install.sh`, or run later):
   ```bash
   sudo bash quantum-chat/scripts/install-quantum-chat.sh
   ```
2. **Delegate a DNS subdomain to the server** — this step is outside any installer. At your DNS host, point an `NS` record for e.g. `qc.yourdomain.com` to `ns1.yourdomain.com`, with an `A` record for `ns1` pointing at the server's public IP.
3. **Open UDP and TCP port 53** at your hosting provider's firewall.
4. Verify from another machine: `dig qc.yourdomain.com SOA` should answer from your node.

Keys and messages never leave the browser. The browser client is reference code that mirrors the Go node byte-for-byte; treat Emergency Mode as best-effort (it works when DNS-over-HTTPS is reachable, not when all HTTPS is blocked). See `docs/` and `quantum-chat/web/INTEGRATION.md` for details.

## Security Notes

- Secrets live only in `.env` (chmod 600) and are **not** committed — `.env` and `uploads/` are gitignored. Set a strong, unique `JWT_SECRET` and `TRADINGVIEW_WEBHOOK_SECRET` (e.g. `openssl rand -hex 32`).
- Always run behind HTTPS in production (the installer can obtain a Let's Encrypt certificate).
- Change the default admin credentials and use a strong password.
- Keep your dependencies and server packages up to date.

## Disclaimer

DrFX Quant is communication and charting software. It does not execute trades, and nothing in the app — including output from the AI assistant or any signals broadcast through it — is financial advice. Trading carries risk; do your own research and use at your own risk.

## Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE) — free for personal and commercial use.

---

<p align="center">
  Built by <strong>Dr. Pouria</strong> · <a href="https://t.me/Drfxai">t.me/Drfxai</a>
</p>
