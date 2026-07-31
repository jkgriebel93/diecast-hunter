// Injected on eBay item pages. Extracts the title/price from the DOM,
// asks the background script to call the desktop app's /match/preview,
// and renders a small panel with the DCR match + valuation. All scoring
// happens in the app — this script only extracts and displays.
const api = typeof browser !== "undefined" ? browser : chrome;

const DCR_BASE = "https://www.diecastregistry.com";

function extractTitle() {
  const selectors = [
    "h1.x-item-title__mainTitle span",
    "h1.x-item-title__mainTitle",
    "[data-testid='x-item-title'] span",
    "h1[itemprop='name']",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  // og:title / document.title carry "... | eBay" suffixes.
  const og = document.querySelector("meta[property='og:title']");
  const raw = (og && og.getAttribute("content")) || document.title || "";
  return raw.replace(/\s*\|\s*eBay\s*$/i, "").trim();
}

function parseCents(text) {
  const m = text && text.replace(/,/g, "").match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Math.round(parseFloat(m[1]) * 100) : null;
}

function extractPriceCents() {
  const selectors = [
    "[data-testid='x-price-primary']",
    ".x-price-primary",
    "[itemprop='price']",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const cents = parseCents(el.getAttribute("content") || el.textContent);
      if (cents !== null) return cents;
    }
  }
  return null;
}

function fmtCents(cents) {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

const CSS = `
  .dh-panel {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
    width: 300px; padding: 12px 14px; border-radius: 10px;
    background: #1c1f26; color: #e6e8ec; font: 13px/1.45 system-ui, sans-serif;
    box-shadow: 0 6px 24px rgba(0,0,0,.45); border: 1px solid #333845;
  }
  .dh-title { font-weight: 600; font-size: 12px; letter-spacing: .04em;
    text-transform: uppercase; color: #9aa2b1; display: flex;
    justify-content: space-between; align-items: center; }
  .dh-close { cursor: pointer; color: #9aa2b1; background: none; border: none;
    font-size: 14px; line-height: 1; padding: 2px; }
  .dh-close:hover { color: #fff; }
  .dh-body { margin-top: 8px; }
  .dh-muted { color: #9aa2b1; }
  .dh-strong { font-weight: 600; }
  .dh-badge { display: inline-block; padding: 1px 7px; border-radius: 9px;
    font-size: 12px; font-weight: 600; }
  .dh-badge.good { background: #123b2a; color: #4ade80; }
  .dh-badge.meh { background: #3b2f12; color: #fbbf24; }
  .dh-row { margin-top: 4px; display: flex; justify-content: space-between; gap: 8px; }
  .dh-actions { margin-top: 10px; display: flex; gap: 8px; align-items: center; }
  .dh-btn { cursor: pointer; border: 1px solid #3d4352; background: #262b36;
    color: #e6e8ec; padding: 4px 10px; border-radius: 7px; font-size: 12px; }
  .dh-btn:hover { background: #303748; }
  .dh-btn[disabled] { opacity: .5; cursor: default; }
  .dh-link { color: #7ab8ff; text-decoration: none; font-size: 12px; }
  .dh-link:hover { text-decoration: underline; }
`;

let shadowBody = null;

function mountPanel() {
  const host = document.createElement("div");
  host.id = "diecast-hunter-panel";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);
  const panel = document.createElement("div");
  panel.className = "dh-panel";
  panel.innerHTML = `
    <div class="dh-title">
      <span>Diecast Hunter</span>
      <button class="dh-close" title="Hide">✕</button>
    </div>
    <div class="dh-body dh-muted">Checking registry…</div>
  `;
  shadow.appendChild(panel);
  panel.querySelector(".dh-close").addEventListener("click", () => host.remove());
  document.documentElement.appendChild(host);
  shadowBody = panel.querySelector(".dh-body");
  return panel;
}

function render(html) {
  if (shadowBody) shadowBody.innerHTML = html;
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    try {
      api.runtime.sendMessage(msg, (resp) => resolve(resp ?? { ok: false }));
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

function entryLine(entry) {
  const bits = [entry.year, entry.scheme_text, entry.brand, entry.finish]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  return bits || "(registry entry)";
}

async function main() {
  const title = extractTitle();
  if (!title) return;
  const priceCents = extractPriceCents();

  const panel = mountPanel();

  const health = await sendMessage({ type: "health" });
  if (!health.ok) {
    render(
      `<span class="dh-muted">Diecast Hunter isn't running — start the app ` +
        `(or enable "keep running in background" in its Settings) and reload.</span>`,
    );
    return;
  }

  const resp = await sendMessage({
    type: "preview",
    payload: {
      title,
      url: location.href,
      price_cents: priceCents,
      shipping_cents: null,
    },
  });
  if (!resp.ok) {
    const detail =
      resp.status === 401
        ? "shared secret mismatch — copy it again from the app's Settings into the extension options"
        : esc((resp.body && resp.body.error) || resp.error || `HTTP ${resp.status}`);
    render(`<span class="dh-muted">Preview failed: ${detail}</span>`);
    return;
  }

  const p = resp.body;
  if (!p || (!p.entry && p.skipped_reason)) {
    render(`<span class="dh-muted">${esc(p ? p.skipped_reason : "no response")}</span>`);
    return;
  }

  const conf = p.confidence !== null ? `${Math.round(p.confidence)}%` : "—";
  const badge = p.matched
    ? `<span class="dh-badge good">match · ${conf}</span>`
    : `<span class="dh-badge meh">best guess · ${conf}</span>`;
  const dcrLink = p.entry.detail_url
    ? `<a class="dh-link" href="${esc(DCR_BASE + p.entry.detail_url)}" target="_blank" rel="noreferrer">View on DCR ↗</a>`
    : "";
  const already = p.already_listing_id !== null;

  render(`
    <div>${badge}</div>
    <div class="dh-row"><span class="dh-strong">${esc(p.driver_name ?? "")}</span></div>
    <div class="dh-muted">${entryLine(p.entry)}</div>
    <div class="dh-row"><span class="dh-muted">Retail</span><span>${fmtCents(p.entry.retail_value_cents)}</span></div>
    <div class="dh-row"><span class="dh-muted">Wholesale</span><span>${fmtCents(p.entry.wholesale_value_cents)}</span></div>
    ${
      p.deal_score !== null
        ? `<div class="dh-row"><span class="dh-muted">This listing</span><span class="dh-strong">${Math.round(p.deal_score)}% of retail</span></div>`
        : ""
    }
    <div class="dh-actions">
      ${
        already
          ? `<span class="dh-muted">✓ already saved</span>`
          : `<button class="dh-btn" id="dh-watch">Watch in app</button>`
      }
      ${dcrLink}
    </div>
  `);

  const watchBtn = panel.querySelector("#dh-watch");
  if (watchBtn) {
    watchBtn.addEventListener("click", async () => {
      watchBtn.disabled = true;
      watchBtn.textContent = "Watching…";
      const r = await sendMessage({ type: "watch", payload: { input: location.href } });
      if (r.ok && r.body && r.body.listing_id !== null) {
        watchBtn.replaceWith(
          Object.assign(document.createElement("span"), {
            className: "dh-muted",
            textContent: "✓ saved to Diecast Hunter",
          }),
        );
      } else {
        watchBtn.disabled = false;
        watchBtn.textContent = "Watch in app";
        const err = (r.body && (r.body.error || r.body.filtered_reason)) || r.error || "failed";
        render(
          shadowBody.innerHTML +
            `<div class="dh-muted" style="margin-top:6px">Watch failed: ${esc(err)}</div>`,
        );
      }
    });
  }
}

main().catch(() => {});
