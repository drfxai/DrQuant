# Changelog

## Renamed to DrFX Quant

The platform's public name is now **DrFX Quant** (formerly *DrFX Quantum*). This is a branding change only: internal identifiers (the PostgreSQL database name, the PM2/systemd service name, and install paths under `/var/www/drfx-quantum`) and the GitHub repository are intentionally unchanged, so existing deployments keep working after a normal `git pull && sudo bash update.sh`. The separate **Quantum Chat** feature keeps its name.

## v5.2 — Chat Actions, Analysis Memory & Live Trading (2026-02-27)

### Chat: Full Message Actions for All Users
- Copy, Edit, Delete, and Reply now available to all users on all messages
- Reply system with visual quote preview (sender name + snippet, click to scroll)
- Reply bar appears above input when replying, with cancel button
- Backend permissions updated: any chat member can edit/delete any message
- `reply_to` column added to messages table with full migration support

### Manual Trading: Analysis Memory
- New 📝 Analysis Notes panel (side panel on desktop, full overlay on mobile)
- Save analysis per symbol with direction (Long/Short/Neutral) and timeframe
- Notes automatically filter by current chart symbol
- Notes refresh when switching symbols
- Full CRUD: create, view, delete personal trading notes
- `trading_notes` database table with user/symbol indexing

### Live Trading: Admin Screen Share
- New 🔴 Live Trading section accessible from sidebar
- Admin can broadcast screen via WebRTC `getDisplayMedia()`
- Users see real-time stream with auto-connect when going live
- Live status indicator with red pulsing dot and viewer count
- Stream timer showing duration (MM:SS)
- WebRTC signaling via Socket.io (offer/answer/ICE candidates)
- Auto-cleanup: stream ends if admin disconnects or stops sharing
- Professional UI: idle state, streaming state, responsive layout
- STUN servers for NAT traversal (Google STUN)

## v5.1 — Manual Trading (2026-02-27)

### Manual Trading Section
- Full TradingView Advanced Chart embedded in-app
- Quick symbol switcher: EUR/USD, GBP/USD, USD/JPY, XAU/USD, BTC/USD, ETH/USD, SPX 500, NAS 100, US30, and more
- Timeframe selector: 1m, 5m, 15m, 1H, 4H, 1D, 1W
- Built-in indicators: SMA and RSI loaded by default, full indicator library available
- Native full-screen mode (browser Fullscreen API) with toggle button
- Landscape mode support with auto-resize chart redraw
- Symbol and interval preferences saved to localStorage
- Keyboard shortcut: Escape to close chart view
- Dark/Light theme auto-sync with app theme
- Accessible from sidebar menu for all users

## v5.0 — Public Release (2026-02-26)

### Core Platform
- Telegram-style DMs, groups, and channels with public/private visibility
- Real-time messaging via Socket.io with typing indicators and read receipts
- Image sharing with drag-and-drop upload
- Message edit and delete (long-press on mobile)
- Emoji picker, markdown formatting (bold, italic, code blocks)
- Unread message badges with sound notifications

### AI Trading Assistant
- Auto-created AI bot DM for every new user
- OpenRouter integration (Claude, GPT, and other models)
- Configurable free-tier daily message limits
- Trading-focused system prompt: technical analysis, risk management, Pine Script

### User System
- Unique @username for users and chats
- Login via email or @username
- Editable profile: name, bio, avatar
- Global search across users, groups, and channels

### Public/Private Join Rules
- Public groups and channels: users can search and self-join freely
- Private groups and channels: admin invitation only
- Full-screen join preview for public chats (Telegram-style)
- Visibility badges (🌐 / 🔒) in search results

### Admin Dashboard
- Live statistics: users, messages, chats, subscriptions, daily activity
- Search, block/unblock, delete users
- Grant Pro subscriptions
- Admin-only group and channel creation

### Payments
- Crypto subscriptions via NowPayments
- Free and Pro tiers with automatic expiry checking

### Mobile
- Keyboard-safe layout (position:fixed, width-only resize rebuild)
- 16px font-size on inputs (prevents iOS auto-zoom)
- Touch-optimized: long-press menus, swipe-safe tap targets
- Safe-area support for notched devices

### Deployment
- One-command VPS installer (Node.js, PostgreSQL, Nginx, PM2, SSL)
- Interactive setup with domain, admin credentials, API keys
- Clean uninstaller with optional dependency removal
- Auto-migration on startup (database schema versioning)

### Design
- Dual themes: Galaxy Dark and Crystal Light
- Professional login page with chart logo and quote card
- Responsive layout: phone, tablet, desktop

---

Built by **Dr. Pouria** — [t.me/Drfxai](https://t.me/Drfxai)
