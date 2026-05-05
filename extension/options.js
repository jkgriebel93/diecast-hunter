const api = typeof browser !== "undefined" ? browser : chrome;

async function load() {
  const { endpointUrl, sharedSecret } = await api.storage.local.get([
    "endpointUrl",
    "sharedSecret",
  ]);
  if (endpointUrl) document.getElementById("endpoint").value = endpointUrl;
  if (sharedSecret) document.getElementById("secret").value = sharedSecret;
}

function setStatus(html) {
  document.getElementById("status").innerHTML = html;
}

document.getElementById("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const endpointUrl = document.getElementById("endpoint").value.trim();
  const sharedSecret = document.getElementById("secret").value.trim();
  await api.storage.local.set({ endpointUrl, sharedSecret });

  setStatus("Saved. Testing connection…");

  // Health-check the desktop app. The endpoint URL points at /listings/save,
  // strip that to get the server root, then fetch /health.
  const root = endpointUrl.replace(/\/listings\/save\/?$/i, "");
  try {
    const resp = await fetch(root + "/health");
    if (resp.ok) {
      setStatus(`<span class="success">Connected — health check passed.</span>`);
    } else {
      setStatus(
        `<span class="error">Health check returned HTTP ${resp.status}.</span>`,
      );
    }
  } catch (err) {
    setStatus(
      `<span class="error">Couldn't reach ${root}: ${err.message}. Is the desktop app running?</span>`,
    );
  }
});

load();
