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

// Listen for on-demand extraction from background/popup
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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

// Inject page-context script (MAIN world) for WebSocket interception
function injectPageScript() {
  const s = document.createElement("script");
  s.src = browser.runtime.getURL("inject.js");
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
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
    sendResponse({ ok: true });
  }
  return true;
});
