/* app-native.js — only does anything inside the Capacitor iOS/Android shell.
 * Registers the device for native push, keeps the Worker in sync with the
 * user's followed parks + disaster-alert preference, routes notification taps
 * to the right park page, and opens outbound links in an in-app browser. */
(function () {
  var Cap = window.Capacitor;
  if (!Cap || !Cap.isNativePlatform || !Cap.isNativePlatform()) return;

  var API = "https://parkstatus-api.parkstatus.workers.dev";
  var P = Cap.Plugins || {};
  var Push = P.PushNotifications, App = P.App, Browser = P.Browser, Prefs = P.Preferences;

  document.documentElement.classList.add("in-app"); // CSS can hide web-only signup chrome

  // ---- stable per-install id -------------------------------------------------
  function installId(cb) {
    if (!Prefs) { cb(mk()); return; }
    Prefs.get({ key: "ps_install_id" }).then(function (r) {
      if (r && r.value) return cb(r.value);
      var id = mk();
      Prefs.set({ key: "ps_install_id", value: id });
      cb(id);
    }).catch(function () { cb(mk()); });
    function mk() {
      try { return crypto.randomUUID(); }
      catch (_) { return "ins-" + Date.now() + "-" + Math.random().toString(36).slice(2); }
    }
  }

  // ---- current subscription scope from what the web UI already stores -------
  function currentScope() {
    var follows = [];
    try { follows = JSON.parse(localStorage.getItem("ps_follows") || "[]"); } catch (_) {}
    var prefs = {};
    try { prefs = JSON.parse(localStorage.getItem("ps_alert_prefs") || "{}"); } catch (_) {}
    return {
      kind: "parks",
      parks: follows.map(function (f) { return f.id; }).filter(Boolean).slice(0, 100),
      disasters: prefs.disasters !== false, // default on
      label: "iOS app",
    };
  }

  var STATE = { id: null, token: null, lastSent: "" };

  function sync() {
    if (!STATE.id || !STATE.token) return;
    var scope = currentScope();
    var body = JSON.stringify({ platform: Cap.getPlatform(), installId: STATE.id, token: STATE.token, scope: scope });
    if (body === STATE.lastSent) return;
    STATE.lastSent = body;
    fetch(API + "/push/native/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: body,
    }).catch(function () { STATE.lastSent = ""; /* retry next trigger */ });
  }

  // ---- push registration ---------------------------------------------------
  function registerPush() {
    if (!Push) return;
    Push.checkPermissions().then(function (p) {
      if (p.receive === "prompt" || p.receive === "prompt-with-rationale") return Push.requestPermissions();
      return p;
    }).then(function (p) {
      if (p && p.receive === "granted") Push.register();
    }).catch(function () {});

    Push.addListener("registration", function (t) {
      STATE.token = t && t.value;
      sync();
    });
    Push.addListener("registrationError", function (e) { console.warn("push reg error", e); });

    Push.addListener("pushNotificationActionPerformed", function (a) {
      var url = a && a.notification && a.notification.data && a.notification.data.url;
      if (url) {
        try { var u = new URL(url); location.href = u.pathname + u.search + u.hash; }
        catch (_) { location.href = url; }
      }
    });
  }

  // ---- keep the Worker in sync when follows / prefs change ----------------
  var _set = localStorage.setItem.bind(localStorage);
  var t;
  localStorage.setItem = function (k, v) {
    _set(k, v);
    if (k === "ps_follows" || k === "ps_alert_prefs") { clearTimeout(t); t = setTimeout(sync, 400); }
  };
  if (App) App.addListener("appStateChange", function (s) { if (s.isActive) sync(); });

  // ---- outbound links open in an in-app browser, not the webview ---------
  if (Browser) {
    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest('a[target="_blank"], a[rel~="noopener"]');
      if (!a) return;
      var href = a.getAttribute("href") || "";
      if (!/^https?:\/\//.test(href)) return;
      if (href.indexOf("parkstatus.today") > -1) return; // keep our own pages in the app
      e.preventDefault();
      Browser.open({ url: href });
    }, true);
  }

  // ---- go --------------------------------------------------------------------
  installId(function (id) { STATE.id = id; registerPush(); });
})();
