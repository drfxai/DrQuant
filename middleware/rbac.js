// middleware/rbac.js
// ----------------------------------------------------------------------------
// Centralized Role-Based Access Control. Replaces scattered inline
// `req.user.role !== 'admin'` checks with a single, auditable policy layer.
//
// Hierarchy (numeric rank — higher governs lower):
//   superadmin (3) > admin (2) > user (1) > bot (0)
//
// Wire AFTER authMiddleware so req.user is populated.
// ----------------------------------------------------------------------------

const RANK = { bot: 0, user: 1, admin: 2, superadmin: 3 };

function rankOf(role) {
  return RANK[role] ?? -1;
}

// Require a minimum role rank. requireRole('admin') => admin OR superadmin.
function requireRole(minRole) {
  const min = rankOf(minRole);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    if (rankOf(req.user.role) < min) {
      return res.status(403).json({ error: "Insufficient privileges" });
    }
    next();
  };
}

// Require one of an explicit set of roles.
function requireAnyRole(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthenticated" });
    if (!allowed.has(req.user.role)) {
      return res.status(403).json({ error: "Insufficient privileges" });
    }
    next();
  };
}

// ----------------------------------------------------------------------------
// Privilege-escalation guard. Use on any endpoint that mutates another user's
// role, ownership, or account. Enforces the boundaries from the spec:
//   - Only SuperAdmin may assign/remove Admins or touch SuperAdmins.
//   - Admins may act on Users only — never on peers or SuperAdmins.
//   - No one may elevate a target ABOVE their own rank.
//   - No one may self-demote the last SuperAdmin (checked in the route via DB).
//
// Expects req.targetUser to be loaded by the route (the user being modified)
// and, for role changes, req.body.role to be the desired new role.
// ----------------------------------------------------------------------------
function guardUserMutation(req, res, next) {
  const actor = req.user;
  const target = req.targetUser;
  if (!actor) return res.status(401).json({ error: "Unauthenticated" });
  if (!target) return res.status(404).json({ error: "Target user not found" });

  const actorRank = rankOf(actor.role);
  const targetRank = rankOf(target.role);

  // You can never act on someone at or above your own rank (except yourself).
  const isSelf = actor.id === target.id;
  if (!isSelf && targetRank >= actorRank) {
    return res.status(403).json({ error: "Cannot modify a peer or higher-ranked account" });
  }

  // Role assignment specifics.
  const desired = req.body?.role;
  if (desired) {
    if (!(desired in RANK)) {
      return res.status(400).json({ error: "Invalid role" });
    }
    const desiredRank = rankOf(desired);
    // Cannot grant a role higher than your own.
    if (desiredRank >= actorRank) {
      return res.status(403).json({ error: "Cannot grant a role at or above your own" });
    }
    // Only superadmin may mint/remove admins.
    if ((desired === "admin" || target.role === "admin") && actor.role !== "superadmin") {
      return res.status(403).json({ error: "Only SuperAdmin can manage Admin roles" });
    }
  }

  next();
}

module.exports = {
  RANK,
  rankOf,
  requireRole,
  requireAnyRole,
  guardUserMutation,
  // convenience shorthands
  requireUser: requireRole("user"),
  requireAdmin: requireRole("admin"),
  requireSuperAdmin: requireRole("superadmin"),
};
