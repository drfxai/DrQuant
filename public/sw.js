// sw.js — DrFX Quant service worker.
// Purpose: receive Web Push so message notifications (with the OS sound) arrive
// even when the app is fully closed. Deliberately does NOT cache or intercept
// fetch requests, so it can never interfere with the live app.
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { try { data = { body: event.data.text() }; } catch (_) { data = {}; } }
  var title = data.title || "DrFX Quant";
  var options = {
    body: data.body || "New message",
    icon: data.icon || "/icon.svg",
    badge: data.badge || "/icon.svg",
    tag: data.tag || "dq-msg",
    renotify: true,
    vibrate: [80, 40, 80],
    data: { url: data.url || "/", chatId: (data.chatId != null ? data.chatId : null) }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var d = event.notification.data || {};
  var target = d.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ("focus" in c) {
          c.focus();
          if (c.postMessage) { try { c.postMessage({ type: "dq-open-chat", chatId: d.chatId }); } catch (e) {} }
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
