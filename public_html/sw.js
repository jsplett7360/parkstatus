/* parkstatus.today service worker — receives Web Push and shows a notification. */
self.addEventListener("push", function (event) {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch (_) { d = { title: "Park Status Today", body: event.data ? event.data.text() : "" }; }
  const title = d.title || "A park changed status";
  const options = { body: d.body || "", data: { url: d.url || "https://parkstatus.today/" }, tag: d.tag || undefined, renotify: !!d.tag };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "https://parkstatus.today/";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (const c of list) { if (c.url === url && "focus" in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
