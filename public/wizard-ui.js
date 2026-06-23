/* ============================================================================
   DrFX Quant — Wizard ("guard") UI  (window.dqWizard)
   ----------------------------------------------------------------------------
   - openWizardPanel()  : wizards + admins. Three segments (Joined / Pro /
                          Wizards), reduced view (username + status, no emails),
                          with block / make-Pro / delete on regular users only.
   - openAddWizard()    : ADMIN ONLY. Appoint or remove wizards.
   - badge(user)        : the "Wizard" pill shown on profiles (visible to all).
   - isWizard()/isAdmin(): role helpers off S.user.

   All powers are also enforced server-side (routes/wizard.js); this UI only
   shows controls the caller is allowed to use. Reuses page globals:
   t, esc, ic, api, S, modal, showToast, avatar.
   ========================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  function role() { try { return (S.user && S.user.role) || "user"; } catch (e) { return "user"; } }
  function isAdmin() { var r = role(); return r === "admin" || r === "superadmin"; }
  function isWizard() { return role() === "wizard"; }
  function canUsePanel() { return isWizard() || isAdmin(); }

  function av(u, size) {
    try { if (typeof avatar === "function") return avatar(u, size || 38); } catch (e) {}
    var s = size || 38;
    return '<div style="width:' + s + 'px;height:' + s + 'px;border-radius:50%;background:' + t.bl +
      ';display:flex;align-items:center;justify-content:center;color:' + t.t2 + ';font-weight:700">' +
      esc(((u && (u.name || u.username)) || "?").slice(0, 1).toUpperCase()) + '</div>';
  }

  // "Wizard" badge — shown on a profile for everyone to see who is a wizard.
  function badge(u) {
    if (!u || u.role !== "wizard") return "";
    return '<span class="dqwz-badge" style="display:inline-flex;align-items:center;gap:4px;vertical-align:middle;' +
      'padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;' +
      'color:#fff;background:linear-gradient(135deg,#7c4dff,#5b8def);box-shadow:0 1px 4px rgba(91,141,239,.4)">' +
      ic('<path d="M12 2l2.4 6.9H22l-6 4.6 2.3 7L12 16.9 5.7 20.5 8 13.5 2 8.9h7.6z"/>', 11) + 'Wizard</span>';
  }

  // ── shared overlay shell ──
  function overlay(title, sub) {
    var ov = document.createElement("div");
    ov.className = "dqwz-ov";
    ov.style.cssText = "position:fixed;inset:0;z-index:4000;background:" + (t.bg || "#0a0f1f") +
      ";display:flex;flex-direction:column;overflow:hidden";
    ov.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid ' + t.bd + '">' +
        '<button class="dqwz-x" style="background:none;border:none;color:' + t.t2 + ';cursor:pointer;display:flex;padding:4px">' +
          ic('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 22) + '</button>' +
        '<div style="min-width:0"><div style="font-size:17px;font-weight:800;color:' + t.t1 + '">' + esc(title) + '</div>' +
          (sub ? '<div style="font-size:12px;color:' + t.t3 + ';margin-top:1px">' + esc(sub) + '</div>' : '') + '</div>' +
      '</div>' +
      '<div class="dqwz-body" style="flex:1;overflow-y:auto;padding:14px 16px;max-width:760px;width:100%;margin:0 auto"></div>';
    ov.querySelector(".dqwz-x").onclick = function () { ov.remove(); };
    document.body.appendChild(ov);
    return ov;
  }

  function statusPills(u) {
    var out = "";
    if (u.role === "wizard") out += badge(u) + " ";
    if (u.subscription_status === "active")
      out += '<span style="padding:1px 8px;border-radius:999px;font-size:10px;font-weight:700;color:#0a0f1f;background:#f5c451">PRO</span> ';
    if (u.blocked)
      out += '<span style="padding:1px 8px;border-radius:999px;font-size:10px;font-weight:700;color:#fff;background:#e0556b">BLOCKED</span> ';
    return out;
  }

  // ====================== WIZARD PANEL ======================
  function openWizardPanel() {
    if (!canUsePanel()) { try { showToast("Not allowed", "The wizard panel is for wizards and admins."); } catch (e) {} return; }
    var ov = overlay("Wizard Panel", "Guard tools — manage regular and Pro members");
    var body = ov.querySelector(".dqwz-body");
    var state = { segment: "joined", q: "", page: 1, loading: false };

    var segs = [["joined", "Joined"], ["pro", "Pro"], ["wizards", "Wizards"]];
    var tabs = '<div class="dqwz-tabs" style="display:flex;gap:8px;margin-bottom:12px">' + segs.map(function (s) {
      return '<button class="dqwz-tab" data-s="' + s[0] + '" style="flex:1;padding:9px;border-radius:11px;border:1px solid ' +
        t.bd + ';background:transparent;color:' + t.t2 + ';font-weight:700;font-size:13px;cursor:pointer">' + s[1] + '</button>';
    }).join("") + '</div>';
    var search = '<input class="dqwz-q" placeholder="Search name or @username…" style="width:100%;box-sizing:border-box;' +
      'padding:11px 13px;border-radius:11px;border:1px solid ' + t.bd + ';background:' + t.inp + ';color:' + t.t1 +
      ';font-size:13px;margin-bottom:12px;font-family:inherit">';
    body.innerHTML = tabs + search + '<div class="dqwz-list"></div><div class="dqwz-more" style="text-align:center;padding:12px"></div>';

    var listEl = body.querySelector(".dqwz-list");
    var moreEl = body.querySelector(".dqwz-more");

    function paintTabs() {
      body.querySelectorAll(".dqwz-tab").forEach(function (b) {
        var on = b.dataset.s === state.segment;
        b.style.background = on ? (t.act || t.bl) : "transparent";
        b.style.color = on ? (t.ac || t.t1) : t.t2;
        b.style.borderColor = on ? (t.ba || t.bd) : t.bd;
      });
    }

    function row(u) {
      var actions = "";
      if (state.segment !== "wizards") {
        // only regular/pro users (role==='user') get actions
        var pro = u.subscription_status === "active";
        actions =
          '<button class="dqwz-act" data-act="pro" data-id="' + u.id + '" data-on="' + (pro ? 1 : 0) + '" style="' + btn(pro ? t.t3 : "#f5c451") + '">' + (pro ? "Remove Pro" : "Make Pro") + '</button>' +
          '<button class="dqwz-act" data-act="block" data-id="' + u.id + '" data-on="' + (u.blocked ? 1 : 0) + '" style="' + btn(u.blocked ? t.t3 : "#e0a23b") + '">' + (u.blocked ? "Unblock" : "Block") + '</button>' +
          '<button class="dqwz-act" data-act="delete" data-id="' + u.id + '" style="' + btn("#e0556b") + '">Delete</button>';
      }
      return '<div class="dqwz-row" data-id="' + u.id + '" style="display:flex;align-items:center;gap:11px;padding:10px 4px;border-bottom:1px solid ' + t.bd + '">' +
        av(u, 40) +
        '<div style="flex:1;min-width:0">' +
          '<div style="color:' + t.t1 + ';font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(u.name || u.username || ("User " + u.id)) + '</div>' +
          '<div style="color:' + t.t3 + ';font-size:12px">' + (u.username ? "@" + esc(u.username) : "") + '</div>' +
          '<div style="margin-top:3px">' + statusPills(u) + '</div>' +
        '</div>' +
        (actions ? '<div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">' + actions + '</div>' : '') +
        '</div>';
    }
    function btn(color) {
      return "padding:5px 10px;border-radius:8px;border:1px solid " + t.bd + ";background:transparent;color:" + color +
        ";font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap";
    }

    function load(reset) {
      if (state.loading) return;
      state.loading = true;
      if (reset) { state.page = 1; listEl.innerHTML = ""; }
      moreEl.textContent = "Loading…";
      api("/wizard/users?segment=" + state.segment + "&page=" + state.page + "&q=" + encodeURIComponent(state.q))
        .then(function (d) {
          state.loading = false;
          var users = (d && d.users) || [];
          if (!users.length && state.page === 1) { listEl.innerHTML = '<div style="color:' + t.t3 + ';text-align:center;padding:30px;font-size:13px">No users here.</div>'; moreEl.innerHTML = ""; return; }
          listEl.insertAdjacentHTML("beforeend", users.map(row).join(""));
          if (d && d.page < d.pages) {
            moreEl.innerHTML = '<button class="dqwz-loadmore" style="' + btn(t.t2) + '">Load more</button>';
            moreEl.querySelector(".dqwz-loadmore").onclick = function () { state.page++; load(false); };
          } else moreEl.innerHTML = "";
        })
        .catch(function () { state.loading = false; moreEl.innerHTML = '<span style="color:' + t.t3 + ';font-size:12px">Could not load.</span>'; });
    }

    paintTabs(); load(true);

    body.querySelectorAll(".dqwz-tab").forEach(function (b) {
      b.onclick = function () { state.segment = b.dataset.s; paintTabs(); load(true); };
    });
    var qEl = body.querySelector(".dqwz-q"), qTimer = null;
    qEl.oninput = function () { clearTimeout(qTimer); qTimer = setTimeout(function () { state.q = qEl.value.trim(); load(true); }, 300); };

    listEl.addEventListener("click", function (e) {
      var b = e.target.closest(".dqwz-act"); if (!b) return;
      var id = b.dataset.id, act = b.dataset.act, on = b.dataset.on === "1";
      if (act === "delete") {
        if (typeof modal === "function") {
          modal("Delete user", function (mb, close) {
            mb.innerHTML = '<div style="color:' + t.t2 + ';font-size:14px;line-height:1.5;margin-bottom:16px">Permanently delete this user and their messages? This cannot be undone.</div>' +
              '<button class="dqwz-confirm pb" style="width:100%;background:#e0556b">Delete permanently</button>';
            mb.querySelector(".dqwz-confirm").onclick = function () { close(); doAct(id, "delete", b); };
          });
        } else { doAct(id, "delete", b); }
        return;
      }
      doAct(id, act, b, on);
    });

    function doAct(id, act, b, on) {
      b.disabled = true; b.style.opacity = ".5";
      var p;
      if (act === "delete") p = api("/wizard/users/" + id, { method: "DELETE" });
      else if (act === "block") p = api("/wizard/users/" + id + "/" + (on ? "unblock" : "block"), { method: "POST" });
      else if (act === "pro") p = api("/wizard/users/" + id + "/subscription", { method: "POST", body: JSON.stringify({ status: on ? "free" : "active", days: 30 }) });
      p.then(function () {
        try { showToast("Done", "Action applied."); } catch (e) {}
        if (act === "delete") { var r = listEl.querySelector('.dqwz-row[data-id="' + id + '"]'); if (r) r.remove(); }
        else load(true);
      }).catch(function (err) {
        b.disabled = false; b.style.opacity = "1";
        try { showToast("Failed", (err && err.message) || "Could not apply."); } catch (e) {}
      });
    }
  }

  // ====================== ADD WIZARD (admin only) ======================
  function openAddWizard() {
    if (!isAdmin()) { try { showToast("Admins only", "Only an admin can appoint wizards."); } catch (e) {} return; }
    var ov = overlay("Add Wizard", "Appoint a member as a wizard (guard). Wizards get Pro access.");
    var body = ov.querySelector(".dqwz-body");
    body.innerHTML =
      '<input class="dqwz-q" placeholder="Search a member by name or @username…" style="width:100%;box-sizing:border-box;padding:11px 13px;border-radius:11px;border:1px solid ' + t.bd + ';background:' + t.inp + ';color:' + t.t1 + ';font-size:13px;margin-bottom:8px;font-family:inherit">' +
      '<div style="color:' + t.t3 + ';font-size:11px;margin-bottom:12px">Only regular members can be made wizards. Switch to the “Current wizards” tab to remove one.</div>' +
      '<div class="dqwz-seg" style="display:flex;gap:8px;margin-bottom:12px"></div>' +
      '<div class="dqwz-list"></div>';
    var listEl = body.querySelector(".dqwz-list");
    var segEl = body.querySelector(".dqwz-seg");
    var seg = "joined";
    segEl.innerHTML = [["joined", "Members"], ["wizards", "Current wizards"]].map(function (s) {
      return '<button class="dqwz-seg-b" data-s="' + s[0] + '" style="flex:1;padding:9px;border-radius:11px;border:1px solid ' + t.bd + ';background:transparent;color:' + t.t2 + ';font-weight:700;font-size:13px;cursor:pointer">' + s[1] + '</button>';
    }).join("");
    function paintSeg() { segEl.querySelectorAll(".dqwz-seg-b").forEach(function (b) { var onb = b.dataset.s === seg; b.style.background = onb ? (t.act || t.bl) : "transparent"; b.style.color = onb ? (t.ac || t.t1) : t.t2; }); }

    var qEl = body.querySelector(".dqwz-q"), qTimer = null, q = "";
    function load() {
      api("/wizard/users?segment=" + seg + "&q=" + encodeURIComponent(q))
        .then(function (d) {
          var users = (d && d.users) || [];
          if (!users.length) { listEl.innerHTML = '<div style="color:' + t.t3 + ';text-align:center;padding:24px;font-size:13px">No members found.</div>'; return; }
          listEl.innerHTML = users.map(function (u) {
            var action = seg === "wizards"
              ? '<button class="dqwz-grant" data-id="' + u.id + '" data-mode="revoke" style="padding:6px 12px;border-radius:9px;border:1px solid ' + t.bd + ';background:transparent;color:#e0556b;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Remove</button>'
              : '<button class="dqwz-grant" data-id="' + u.id + '" data-mode="grant" style="padding:6px 12px;border-radius:9px;border:none;background:linear-gradient(135deg,#7c4dff,#5b8def);color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Make Wizard</button>';
            return '<div style="display:flex;align-items:center;gap:11px;padding:10px 4px;border-bottom:1px solid ' + t.bd + '">' + av(u, 38) +
              '<div style="flex:1;min-width:0"><div style="color:' + t.t1 + ';font-weight:600;font-size:14px">' + esc(u.name || u.username || ("User " + u.id)) + '</div>' +
              '<div style="color:' + t.t3 + ';font-size:12px">' + (u.username ? "@" + esc(u.username) : "") + ' ' + statusPills(u) + '</div></div>' + action + '</div>';
          }).join("");
        })
        .catch(function () { listEl.innerHTML = '<div style="color:' + t.t3 + ';text-align:center;padding:24px">Could not load.</div>'; });
    }
    qEl.oninput = function () { clearTimeout(qTimer); qTimer = setTimeout(function () { q = qEl.value.trim(); load(); }, 300); };
    segEl.querySelectorAll(".dqwz-seg-b").forEach(function (b) { b.onclick = function () { seg = b.dataset.s; paintSeg(); load(); }; });
    listEl.addEventListener("click", function (e) {
      var b = e.target.closest(".dqwz-grant"); if (!b) return;
      var id = b.dataset.id, mode = b.dataset.mode;
      b.disabled = true; b.style.opacity = ".5";
      api("/wizard/" + (mode === "revoke" ? "revoke" : "grant") + "/" + id, { method: "POST" })
        .then(function () { try { showToast(mode === "revoke" ? "Wizard removed" : "Wizard added", ""); } catch (e) {} load(); })
        .catch(function (err) { b.disabled = false; b.style.opacity = "1"; try { showToast("Failed", (err && err.message) || ""); } catch (e) {} });
    });
    paintSeg(); load();
  }

  window.dqWizard = {
    openWizardPanel: openWizardPanel,
    openAddWizard: openAddWizard,
    badge: badge,
    isWizard: isWizard,
    isAdmin: isAdmin,
    canUsePanel: canUsePanel,
  };
  window.openWizardPanel = openWizardPanel;
  window.openAddWizard = openAddWizard;
})();
