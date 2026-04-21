// Content script - extracts story tray user IDs from SSR HTML
// and sends them to background for auto-fetch

function extractTrayUserIds() {
  const scripts = document.querySelectorAll('script[type="application/json"][data-sjs]');
  const userIds = [];

  for (const script of scripts) {
    const text = script.textContent;
    if (!text.includes("latest_reel_media")) continue;

    // Extract all user PKs near story tray data
    const re = /"pk":"(\d+)","username":"([^"]+)"/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      userIds.push({ id: match[1], username: match[2] });
    }
  }

  // Dedupe by id
  const seen = new Set();
  const unique = userIds.filter(u => {
    if (seen.has(u.id)) return false;
    seen.add(u.id);
    return true;
  });

  return unique;
}

// Wait for page to fully load then extract
function init() {
  const users = extractTrayUserIds();
  if (users.length > 0) {
    console.log("[IG Content] Found", users.length, "story tray users in SSR HTML");
    browser.runtime.sendMessage({
      type: "trayUserIds",
      users: users
    });
  } else {
    console.log("[IG Content] No tray users found in SSR HTML, retrying in 2s...");
    setTimeout(init, 2000);
  }
}

function extractHeaders() {
  // CSRF token from cookie
  const csrf = document.cookie.split(";").map(c => c.trim()).find(c => c.startsWith("csrftoken="));
  const csrfVal = csrf ? csrf.split("=")[1] : "";

  // LSD token from page HTML
  let lsd = "";
  const scripts = document.querySelectorAll("script");
  for (const s of scripts) {
    const m = s.textContent.match(/"LSD",\[\],\{"token":"([^"]+)"/);
    if (m) { lsd = m[1]; break; }
  }

  return { csrf: csrfVal, lsd };
}

// Floating panel
let panelFrame = null;
function togglePanel() {
  if (panelFrame) {
    panelFrame.remove();
    panelFrame = null;
    return;
  }
  panelFrame = document.createElement("iframe");
  panelFrame.src = browser.runtime.getURL("popup.html");
  panelFrame.style.cssText = "position:fixed;top:8px;right:8px;width:390px;height:600px;z-index:999999;border:1px solid #30363d;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);background:#0d1117;";
  document.body.appendChild(panelFrame);
}

// Listen for on-demand extraction from background/popup
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "togglePanel") {
    togglePanel();
    sendResponse({ ok: true });
  }
  if (msg.type === "extractTray") {
    const users = extractTrayUserIds();
    console.log("[IG Content] On-demand extraction:", users.length, "users");
    sendResponse({ users });
  }
  if (msg.type === "extractHeaders") {
    const headers = extractHeaders();
    console.log("[IG Content] Headers extracted, csrf:", headers.csrf ? "yes" : "no");
    sendResponse(headers);
  }
  return true;
});

// Patch fetch/sendBeacon SYNCHRONOUSLY via wrappedJSObject (Firefox-only)
// This runs at document_start before ANY Instagram code
(function patchPageFetch() {
  const pageWindow = window.wrappedJSObject;
  if (!pageWindow || pageWindow.__igEarlyPatch) return;
  pageWindow.__igEarlyPatch = true;
  pageWindow.__igBlockDMRead = true;

  const origFetch = pageWindow.fetch;
  pageWindow.fetch = exportFunction(function(input, init) {
    try {
      if (pageWindow.__igBlockDMRead) {
        let fn = "";
        try {
          if (init && init.headers) {
            if (typeof init.headers.get === "function") fn = init.headers.get("X-FB-Friendly-Name") || "";
            else fn = init.headers["X-FB-Friendly-Name"] || "";
          }
          if (!fn && input && typeof input === "object" && input.headers) {
            fn = input.headers.get("X-FB-Friendly-Name") || "";
          }
        } catch(_) {}
        if (fn === "useIGDMarkThreadAsReadValidationMutation") {
          console.log("[IG Patch] Blocked DMRead validation (fetch)");
          return pageWindow.Promise.resolve(new pageWindow.Response('{"data":{}}', { status: 200 }));
        }
      }
    } catch(_) {}
    return origFetch.call(this, input, init);
  }, pageWindow);

  const origBeacon = pageWindow.navigator.sendBeacon;
  pageWindow.navigator.sendBeacon = exportFunction(function(url, data) {
    try {
      if (pageWindow.__igBlockDMRead && url && url.includes("/api/graphql")) {
        const t = typeof data === "string" ? data : "";
        if (t.includes("MarkThreadAsReadValidation")) {
          console.log("[IG Patch] Blocked DMRead validation (beacon)");
          return true;
        }
      }
    } catch(_) {}
    return origBeacon.call(this, url, data);
  }, pageWindow.navigator);

  console.log("[IG Patch] fetch + sendBeacon patched synchronously at document_start");
})();

// Inject full page-context script (MAIN world) for WebSocket/typing/presence
function injectPageScript() {
  const s = document.createElement("script");
  s.src = browser.runtime.getURL("inject.js");
  s.onload = () => s.remove();
  const target = document.head || document.documentElement;
  if (target) {
    target.appendChild(s);
  } else {
    new MutationObserver((_, obs) => {
      const t = document.head || document.documentElement;
      if (t) { t.appendChild(s); obs.disconnect(); }
    }).observe(document, { childList: true, subtree: true });
  }
}

// Forward settings to page context
async function pushSettingsToPage() {
  try {
    const resp = await browser.runtime.sendMessage({ type: "getSettings" });
    window.dispatchEvent(new CustomEvent("ig_research_settings", { detail: resp }));
  } catch(_) {}
}

// Listen for log messages from inject.js
window.addEventListener("ig_research_log", (e) => {
  browser.runtime.sendMessage({ type: "injectLog", msg: e.detail });
});

injectPageScript();

if (document.readyState === "complete") {
  init();
  pushSettingsToPage();
} else {
  window.addEventListener("load", () => {
    init();
    pushSettingsToPage();
  });
}

// When settings change, forward to page context
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "pushSettings") {
    window.dispatchEvent(new CustomEvent("ig_research_settings", { detail: msg.settings }));
    // Sync DM read setting
    window.wrappedJSObject.__igBlockDMRead = !!msg.settings.blockDMRead;
    sendResponse({ ok: true });
  }
  return true;
});
