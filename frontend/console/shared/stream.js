"use strict";
// Console push client (ARCHITECTURE.md, push). Every GET the page makes through
// PolyPreview's request() is noted here; the pushable ones are subscribed on one
// EventSource to /api/stream. While the stream is open, request() answers those
// paths from the latest pushed body (the server renders it with the same GET
// handler), and onUpdate listeners hear about a new body at once, so a page can
// re-render the moment data changes instead of waiting for its poll timer.
// If the stream is down nothing changes: request() goes to the network as before.
(() => {
  const PUSHABLE = ["/api/markets", "/api/runtime/status", "/api/rounds", "/api/fills", "/api/settlements",
    "/api/events", "/api/account/snapshot", "/api/metrics/summary", "/api/account/status",
    "/api/runtime/market-pool", "/api/strategy/config", "/api/reversals", "/api/diagnostics/health"];
  // A path the page stopped requesting drops out after this. Longer than the
  // slowest poll (account status every 30 s): at 30 s that path left and
  // rejoined the set, and every change reopened the stream.
  const WANT_TTL_MS = 120000;
  const RESUBSCRIBE_DELAY_MS = 300; // batch the paths a page notes while it starts up
  const pushable = (path) => {
    const route = String(path).split("?", 1)[0];
    return PUSHABLE.some((prefix) => route === prefix || route.startsWith(`${prefix}/`));
  };
  const wanted = new Map();  // path -> last time the page asked for it
  const bodies = new Map();  // path -> latest pushed body
  const listeners = [];
  let source = null;
  let subscribedKey = "";
  let open = false;
  let timer = null;
  const desired = () => [...wanted].filter(([, at]) => Date.now() - at < WANT_TTL_MS).map(([path]) => path).sort();
  const connect = () => {
    timer = null;
    const paths = desired();
    const key = paths.join("\n");
    if (key === subscribedKey && source) return;
    if (source) source.close();
    // Keep the bodies of paths still wanted: the new stream re-sends them first,
    // and until then the page keeps answering from push instead of polling.
    for (const path of [...bodies.keys()]) if (!paths.includes(path)) bodies.delete(path);
    source = null; subscribedKey = key;
    if (!paths.length || typeof window.EventSource !== "function") return;
    const base = window.PolyPreview?.config?.apiBase || "";
    source = new window.EventSource(`${base}/api/stream?${paths.map((path) => `p=${encodeURIComponent(path)}`).join("&")}`);
    source.onopen = () => { open = true; };
    // EventSource reconnects by itself; until then request() polls the network.
    source.onerror = () => { open = false; };
    source.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message.path !== "string" || !message.body || typeof message.body !== "object") return;
      open = true;
      bodies.set(message.path, message.body);
      const route = message.path.split("?", 1)[0];
      for (const listener of listeners) {
        if (route === listener.prefix || route.startsWith(listener.prefix)) {
          try { listener.fn(message.path); } catch { /* one page block never breaks the others */ }
        }
      }
    };
  };
  const schedule = () => { if (!timer) timer = window.setTimeout(connect, RESUBSCRIBE_DELAY_MS); };
  window.setInterval(() => { if (desired().join("\n") !== subscribedKey) schedule(); }, 5000);
  window.PolyPreviewStream = Object.freeze({
    note(path) {
      if (!pushable(path)) return;
      const known = wanted.has(path);
      wanted.set(path, Date.now());
      if (!known) schedule();
    },
    cached(path) {
      if (!open || !bodies.has(path)) return null;
      return JSON.parse(JSON.stringify(bodies.get(path)));  // callers may mutate what they get
    },
    onUpdate(prefix, fn) { listeners.push({ prefix, fn }); },
    get connected() { return open; },
  });
})();
