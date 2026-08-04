// Background fetch proxy. Content scripts run in the page's world where
// eBay's CSP and CORS rules apply; the background context fetches
// localhost with the extension's own host permissions instead. Firefox
// uses the "scripts" background entry (event page), Chrome the
// "service_worker" one — both load this file.
const api = typeof browser !== "undefined" ? browser : chrome;

async function getConfig() {
  return await api.storage.local.get(["endpointUrl", "sharedSecret"]);
}

function baseUrl(cfg) {
  return (cfg.endpointUrl || "http://localhost:17381").replace(/\/+$/, "");
}

async function post(cfg, path, payload) {
  const r = await fetch(baseUrl(cfg) + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.sharedSecret || ""}`,
    },
    body: JSON.stringify(payload),
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const cfg = await getConfig();
      if (msg.type === "health") {
        const r = await fetch(baseUrl(cfg) + "/health");
        sendResponse({ ok: r.ok });
      } else if (msg.type === "preview") {
        sendResponse(await post(cfg, "/match/preview", msg.payload));
      } else if (msg.type === "watch") {
        sendResponse(await post(cfg, "/listings/watch", msg.payload));
      } else if (msg.type === "confirm") {
        sendResponse(await post(cfg, "/match/confirm", msg.payload));
      } else if (msg.type === "reject") {
        sendResponse(await post(cfg, "/match/reject", msg.payload));
      } else {
        sendResponse({ ok: false, error: `unknown message type ${msg.type}` });
      }
    } catch (e) {
      // Typically "connection refused" — the desktop app isn't running.
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // keep the channel open for the async response
});
