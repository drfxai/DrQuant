// public/js/longpress.js
// ----------------------------------------------------------------------------
// Message interaction layer for the SPA.
//   Desktop: right-click (contextmenu) opens the action menu.
//   Touch:   2-second long-press opens it, with accidental-trigger guards:
//            - cancels if the finger moves > MOVE_TOLERANCE px (it's a scroll)
//            - cancels on a second touch (pinch/zoom)
//            - light haptic + scale animation as the press is recognized
//   Accessibility: each message is focusable; Enter/Space or the dedicated
//   "menu" button opens the same menu, so the feature works without a pointer.
//
// Usage:
//   import { attachMessageActions } from './js/longpress.js';
//   attachMessageActions(document.querySelector('#messages'), {
//     onAction: (action, messageEl) => { ... }   // reply|copy|edit|delete
//   });
// The container is delegated, so messages added later are covered automatically.
// Each message element needs: data-message-id, data-own="true|false".
// Set document.body.dataset.role to the current user's role for moderation.
// ----------------------------------------------------------------------------

const HOLD_MS = 2000;          // 2-second hold per spec
const MOVE_TOLERANCE = 10;     // px of finger travel before we treat it as scroll
const PROGRESS_FROM = 250;     // ms before we start showing visual "charging"

export function attachMessageActions(container, { onAction } = {}) {
  let timer = null;
  let startX = 0, startY = 0;
  let activeEl = null;
  let activeTouches = 0;

  const isMessage = (el) => el && el.closest && el.closest("[data-message-id]");

  function clearPress(restore = true) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (activeEl && restore) activeEl.classList.remove("msg--pressing");
    activeEl = null;
  }

  function fire(el) {
    clearPress(true);
    openMenu(el, onAction);
  }

  // ---- touch (mobile / tablet) ----
  container.addEventListener("touchstart", (e) => {
    activeTouches = e.touches.length;
    if (activeTouches > 1) { clearPress(); return; }   // multi-touch => not a long-press
    const el = isMessage(e.target);
    if (!el) return;
    activeEl = el;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    // delay the visual cue so a quick tap shows nothing
    timer = setTimeout(() => {
      el.classList.add("msg--pressing");
      if (navigator.vibrate) navigator.vibrate(10);
      timer = setTimeout(() => fire(el), HOLD_MS - PROGRESS_FROM);
    }, PROGRESS_FROM);
  }, { passive: true });

  container.addEventListener("touchmove", (e) => {
    if (!activeEl) return;
    const dx = Math.abs(e.touches[0].clientX - startX);
    const dy = Math.abs(e.touches[0].clientY - startY);
    if (dx > MOVE_TOLERANCE || dy > MOVE_TOLERANCE) clearPress();  // user is scrolling
  }, { passive: true });

  container.addEventListener("touchend", () => clearPress());
  container.addEventListener("touchcancel", () => clearPress());

  // ---- desktop (right-click) ----
  container.addEventListener("contextmenu", (e) => {
    const el = isMessage(e.target);
    if (!el) return;
    e.preventDefault();
    openMenu(el, onAction, { x: e.clientX, y: e.clientY });
  });

  // ---- keyboard / explicit button (accessibility) ----
  container.addEventListener("keydown", (e) => {
    const el = isMessage(e.target);
    if (!el) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu(el, onAction);
    }
  });
  container.addEventListener("click", (e) => {
    if (e.target.matches("[data-msg-menu-btn]")) {
      const el = isMessage(e.target);
      if (el) openMenu(el, onAction);
    }
  });
}

// ---- the menu itself (single reusable element) ----
let menuEl = null;
function openMenu(messageEl, onAction, pos) {
  closeMenu();
  const own = messageEl.dataset.own === "true";     // route sets this for the sender
  const role = document.body.dataset.role;
  const canModerate = role === "admin" || role === "superadmin";

  const items = [
    { action: "reply", label: "Reply", always: true },
    { action: "copy", label: "Copy", always: true },
    { action: "edit", label: "Edit", show: own },
    { action: "delete", label: "Delete", show: own || canModerate },
  ].filter((i) => i.always || i.show);

  menuEl = document.createElement("div");
  menuEl.className = "msg-menu";
  menuEl.setAttribute("role", "menu");
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.textContent = it.label;
    b.onclick = () => { closeMenu(); onAction && onAction(it.action, messageEl); };
    menuEl.appendChild(b);
  }
  document.body.appendChild(menuEl);

  // Position: at cursor on desktop, anchored to the bubble on touch.
  const r = messageEl.getBoundingClientRect();
  const x = pos ? pos.x : Math.min(r.left + 12, window.innerWidth - 180);
  const y = pos ? pos.y : Math.min(r.bottom + 6, window.innerHeight - 10);
  menuEl.style.left = x + "px";
  menuEl.style.top = y + "px";
  menuEl.querySelector("button")?.focus();

  setTimeout(() => {
    document.addEventListener("click", closeMenu, { once: true });
    document.addEventListener("keydown", onEsc);
  }, 0);
}

function onEsc(e) { if (e.key === "Escape") closeMenu(); }
function closeMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
  document.removeEventListener("keydown", onEsc);
}

/* Minimal CSS to drop into your stylesheet:

.msg--pressing { transform: scale(0.97); transition: transform .15s ease; }
.msg-menu {
  position: fixed; z-index: 9999; min-width: 160px;
  background: var(--surface, #1c1f26); border: 1px solid rgba(255,255,255,.08);
  border-radius: 12px; padding: 6px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
  animation: menuIn .12s ease;
}
.msg-menu button {
  display: block; width: 100%; text-align: left; padding: 10px 14px;
  background: none; border: 0; color: inherit; border-radius: 8px; cursor: pointer;
  font-size: 15px;
}
.msg-menu button:hover, .msg-menu button:focus { background: rgba(255,255,255,.08); outline: none; }
@keyframes menuIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; } }
*/
