// middleware/permissions.js
// ----------------------------------------------------------------------------
// Granular, module-level permission matrix for DrFX Quantum.
//
// rbac.js answers "what RANK is this role" (coarse hierarchy + escalation
// guard). This module answers "may this role perform this specific ACTION",
// per module (chat / signals / live / explore / users / system / moderation /
// broadcast). The two compose: use requireRole/guardUserMutation for hierarchy
// and account-mutation safety, and requirePermission for feature gating.
//
// Permissions are strings of the form "<module>:<action>". The matrix is the
// single source of truth; routes never re-encode role lists inline.
//
// Object-level authorization (is this user a member/owner of THIS chat, etc.)
// stays in the route — permissions gate capability, ownership gates the object.
// ----------------------------------------------------------------------------

// Capability sets per role. Higher roles INHERIT lower-role capabilities via
// the spread, so the matrix stays DRY and can't accidentally drop a base perm.
const USER = [
  "chat:send",
  "chat:edit_own",
  "chat:delete_own",
  "chat:react",
  "chat:flag",            // report a message to moderators
  "signals:view",
  "live:view",
  "explore:post",
  "explore:comment",
];

const MANAGER = [
  ...USER,
  "chat:delete_any",      // moderate messages
  "signals:publish_manual",
  "signals:view_logs",
  "explore:moderate",
  "moderation:view_flags",
  "moderation:resolve_flags",
  "users:view",
  "system:view_health",
];

const ADMIN = [
  ...MANAGER,
  "chat:create_group",
  "chat:create_channel",
  "signals:manage_channels",  // CRUD signal channels + rotate secrets
  "live:broadcast",
  "broadcast:send",           // admin -> user announcements
  "users:block",
  "users:set_subscription",
  "system:view_audit",
];

const SUPERADMIN = [
  ...ADMIN,
  "users:delete",
  "users:manage_roles",
  "system:settings",
];

// Wizard ("guard"): the normal user capabilities plus the ability to create
// (private) groups/channels. Its MODERATION powers over regular users (block /
// make-Pro / delete) are enforced in routes/wizard.js with an object-level guard
// (target must be role='user'), NOT via this matrix — so a wizard can never reach
// the admin user-management endpoints.
const WIZARD = [
  ...USER,
  "chat:create_group",
  "chat:create_channel",
];

// bot has no interactive permissions.
const MATRIX = Object.freeze({
  bot: Object.freeze([]),
  user: Object.freeze([...new Set(USER)]),
  wizard: Object.freeze([...new Set(WIZARD)]),
  manager: Object.freeze([...new Set(MANAGER)]),
  admin: Object.freeze([...new Set(ADMIN)]),
  superadmin: Object.freeze([...new Set(SUPERADMIN)]),
});

// Set form for O(1) lookups.
const SETS = Object.fromEntries(
  Object.entries(MATRIX).map(([role, perms]) => [role, new Set(perms)])
);

/** can(role, "module:action") -> boolean */
function can(role, permission) {
  const set = SETS[role];
  return set ? set.has(permission) : false;
}

/** All permissions for a role (array). Useful to send to the client so the UI
 *  can show/hide controls — server still enforces on every request. */
function permissionsFor(role) {
  return MATRIX[role] ? [...MATRIX[role]] : [];
}

/**
 * Express guard. Wire AFTER an auth middleware that sets req.user.
 *   router.post("/channels", requirePermission("signals:manage_channels"), handler)
 */
function requirePermission(...required) {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ error: "Unauthenticated" });
    }
    const role = req.user.role;
    const ok = required.every((p) => can(role, p));
    if (!ok) {
      return res.status(403).json({
        error: "Insufficient permissions",
        need: required,
      });
    }
    next();
  };
}

/** Guard that passes if the role has ANY one of the listed permissions. */
function requireAnyPermission(...anyOf) {
  return (req, res, next) => {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ error: "Unauthenticated" });
    }
    if (!anyOf.some((p) => can(req.user.role, p))) {
      return res.status(403).json({ error: "Insufficient permissions", needAnyOf: anyOf });
    }
    next();
  };
}

module.exports = {
  MATRIX,
  can,
  permissionsFor,
  requirePermission,
  requireAnyPermission,
};
