// Cross-browser API namespace. Firefox provides `browser` natively; Chrome
// only has `chrome`. Both define `chrome` for MV3, so prefer `browser` when
// available so we get promise-returning APIs even on older Firefox.
const api = typeof browser !== "undefined" ? browser : chrome;

const MARKETPLACE_ITEM_RE =
  /^https?:\/\/(?:www|m)\.facebook\.com\/marketplace\/item\/(\d+)/;

async function getConfig() {
  return await api.storage.local.get(["endpointUrl", "sharedSecret"]);
}

async function getActiveTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function extractItemIdFromUrl(url) {
  const m = url && url.match(MARKETPLACE_ITEM_RE);
  return m ? m[1] : null;
}

// Runs in the page context via chrome.scripting.executeScript. Pulls
// OpenGraph/product meta tags — FB's React DOM is heavily obfuscated, but
// the OG tags are stable across rewrites.
async function extractListingData(tabId) {
  const [{ result }] = await api.scripting.executeScript({
    target: { tabId },
    func: () => {
      const meta = (key) => {
        const el =
          document.querySelector(`meta[property="${key}"]`) ||
          document.querySelector(`meta[name="${key}"]`);
        return el ? el.getAttribute("content") : null;
      };
      return {
        url: meta("og:url") || location.href,
        title: meta("og:title") || document.title,
        description: meta("og:description"),
        image: meta("og:image"),
        priceAmount:
          meta("og:price:amount") || meta("product:price:amount"),
        priceCurrency:
          meta("og:price:currency") || meta("product:price:currency"),
      };
    },
  });
  return result;
}

function dollarsToCents(amount) {
  if (amount === null || amount === undefined) return null;
  const cleaned = String(amount).replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const f = parseFloat(cleaned);
  if (!Number.isFinite(f)) return null;
  return Math.round(f * 100);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c],
  );
}

function setContent(html) {
  document.getElementById("content").innerHTML = html;
}

document.getElementById("open-options").addEventListener("click", () => {
  api.runtime.openOptionsPage();
});

async function init() {
  const { endpointUrl, sharedSecret } = await getConfig();
  if (!endpointUrl || !sharedSecret) {
    setContent(`
      <p>Configure the endpoint URL and shared secret first.</p>
      <button id="open-settings" class="primary">Open settings</button>
    `);
    document
      .getElementById("open-settings")
      .addEventListener("click", () => api.runtime.openOptionsPage());
    return;
  }

  const tab = await getActiveTab();
  const itemId = extractItemIdFromUrl(tab && tab.url);
  if (!itemId) {
    setContent(`
      <p>This isn't a Facebook Marketplace item page. Open one (URL like
      <code>facebook.com/marketplace/item/12345</code>) and try again.</p>
    `);
    return;
  }

  let data;
  try {
    data = await extractListingData(tab.id);
  } catch (e) {
    setContent(
      `<p class="error">Failed to read the page: ${escapeHtml(e.message)}</p>`,
    );
    return;
  }

  const priceCents = dollarsToCents(data.priceAmount);
  const payload = {
    external_id: itemId,
    url: data.url || tab.url,
    title: (data.title || `Marketplace item ${itemId}`).trim(),
    price_cents: priceCents,
    currency: data.priceCurrency || "USD",
    image_url: data.image || null,
    description: data.description || null,
    seller_username: null,
    location: null,
  };

  setContent(`
    ${data.image ? `<img class="thumb" src="${escapeHtml(data.image)}" alt="">` : ""}
    <div class="title">${escapeHtml(payload.title)}</div>
    <div class="meta">
      ${
        priceCents !== null
          ? `$${(priceCents / 100).toFixed(2)}`
          : "(no price)"
      }
      ${data.priceCurrency && data.priceCurrency !== "USD" ? ` ${escapeHtml(data.priceCurrency)}` : ""}
    </div>
    <div class="meta-id">item ${escapeHtml(itemId)}</div>
    <button id="save" class="primary">Save to Diecast Hunter</button>
    <div id="status"></div>
  `);

  document.getElementById("save").addEventListener("click", async () => {
    const btn = document.getElementById("save");
    const status = document.getElementById("status");
    btn.disabled = true;
    status.textContent = "Saving…";
    try {
      const resp = await fetch(endpointUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + sharedSecret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        status.innerHTML =
          `<span class="error">HTTP ${resp.status}: ${escapeHtml(text || resp.statusText)}</span>`;
        btn.disabled = false;
        return;
      }
      const result = await resp.json();
      const verb = result.created ? "Saved" : "Updated";
      const matched = result.matched_registry_entry_id
        ? "matched to registry"
        : "no registry match";
      status.innerHTML = `<span class="success">${verb} (${matched}).</span>`;
    } catch (e) {
      status.innerHTML = `<span class="error">${escapeHtml(e.message)} — is the desktop app running?</span>`;
      btn.disabled = false;
    }
  });
}

init();
