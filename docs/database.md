# Database

PostgreSQL. The original v5.x tables (`users`, `chats`, `chat_members`,
`messages`, `payments`) are unchanged except for additive columns. Migration
`migrations/001_ecosystem_schema.sql` adds everything below. It is idempotent and
transactional.

## Existing (extended)

- **users** — added `superadmin` to the role check; `totp_secret`,
  `totp_enabled`, `last_login_ip`, `last_login_at`, `failed_logins`,
  `locked_until`, `deleted_at` (soft delete).
- **messages** — added `parent_message_id` (self-FK, replies), `type`
  (`text|image|voice|file|system`), `file_*` / `voice_duration`, `deleted_at`.

## New tables

| Table | Purpose | Notable constraints / indexes |
|---|---|---|
| `refresh_tokens` | rotation + revocation; stores `sha256` only | unique `token_hash`; `family_id` for reuse detection |
| `message_reads` | per-recipient delivered/read receipts | PK `(message_id,user_id)` |
| `signals` | normalized TradingView signals | `side` enum; index on `symbol`, `created_at` |
| `webhook_logs` | every webhook attempt (incl. rejects) | unique `dedupe_key` (replay) |
| `audit_logs` | admin/superadmin sensitive actions | indexed by actor & action |
| `media` | images/video/live archives in object store | `status` processing/ready/failed; stores keys, not URLs |
| `posts` | Explore feed items | partial index on `(visibility,created_at)` where not deleted |
| `comments` | post comments | indexed by `(post_id,created_at)` |
| `likes` | one like per user per post | PK `(post_id,user_id)` |
| `live_sessions` | live trading sessions | `status` live/ended/archived |
| `ai_usage_logs` | AI vision/chat cost + abuse control | indexed by `(user_id,created_at)` |
| `economic_events` | ForexFactory cache | unique `source_id` |

## Design decisions

- **Soft delete** (`deleted_at`) on messages, posts, comments, users so moderation
  and "deleted for everyone" don't destroy audit history. List queries filter
  `WHERE deleted_at IS NULL`.
- **Denormalized counters** (`posts.like_count`, `comment_count`) to avoid
  `COUNT(*)` on hot feed reads; update them in the same transaction as the
  like/comment.
- **Hash-only token storage** — a DB leak never exposes usable refresh tokens.
- **Object-store keys, not URLs**, in `media` so access goes through signed-URL
  generation and storage can be relocated without a data migration.
- **Replay safety at the DB layer** — `webhook_logs.dedupe_key` uniqueness means
  duplicate suppression holds even with multiple app instances.

## Known follow-ups

- Fix the N+1 in the chat-list endpoint (per-chat `lastMessage`/`partner` loop) —
  replace with a single `DISTINCT ON` / lateral-join query.
- Consider partitioning `messages` and `ai_usage_logs` by month at scale.
