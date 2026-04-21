// Runs in MAIN world (page context) - injected by content.js
// Intercepts WebSocket messages to block typing indicators and presence
if (window.__igResearchLoaded) { /* already loaded */ } else {
window.__igResearchLoaded = true;

// Settings (updated via CustomEvent from content script)
let settings = { blockTyping: true, blockPresence: false, blockDMRead: true };

window.addEventListener("ig_research_settings", (e) => {
  if (e.detail) settings = { ...settings, ...e.detail };
});

function pageLog(msg) {
  console.log("[IG Inject]", msg);
  window.dispatchEvent(new CustomEvent("ig_research_log", { detail: msg }));
}

// ---------------------------------------------------------------------------
// WebSocket monkey-patch
// Instagram uses MQTT over WebSocket for realtime signals. Two known gateways:
//   - gateway.instagram.com (primary)
//   - edge-chat.instagram.com (some regions/versions)
// ---------------------------------------------------------------------------

const IG_WS_HOSTS = ["gateway.instagram.com", "edge-chat.instagram.com"];

const TYPING_MARKERS = [
  "typing_activity",
  "indicate_activity",
  "is_typing",
  "/thread_typing"
];

const PRESENCE_MARKERS = [
  "co_presence",
  "presence_heartbeat",
  "active_status",
  "foreground_state",
  "app_presence"
];

function isInstagramWS(url) {
  return url && IG_WS_HOSTS.some(h => url.includes(h));
}

function decodeFrame(data) {
  if (typeof data === "string") return data;
  try {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (!(bytes instanceof Uint8Array)) return null;
    // Skip large frames (typing/presence are small, < 500 bytes)
    if (bytes.length > 500) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch(_) {
    return null;
  }
}

const originalWSSend = WebSocket.prototype.send;
let typingBlockedCount = 0;
let presenceBlockedCount = 0;

WebSocket.prototype.send = function(data) {
  if (!isInstagramWS(this.url)) {
    return originalWSSend.apply(this, arguments);
  }

  if (!settings.blockTyping && !settings.blockPresence) {
    return originalWSSend.apply(this, arguments);
  }

  const text = decodeFrame(data);
  if (text === null) {
    return originalWSSend.apply(this, arguments);
  }

  // Block typing
  if (settings.blockTyping && TYPING_MARKERS.some(m => text.includes(m))) {
    typingBlockedCount++;
    pageLog("Blocked typing #" + typingBlockedCount);
    return;
  }

  // Block presence
  if (settings.blockPresence && PRESENCE_MARKERS.some(m => text.includes(m))) {
    presenceBlockedCount++;
    pageLog("Blocked presence #" + presenceBlockedCount);
    return;
  }

  return originalWSSend.apply(this, arguments);
};

// ---------------------------------------------------------------------------
// Monkey-patch fetch and sendBeacon to block DM read validation
// ---------------------------------------------------------------------------

const originalFetch = window.fetch;
window.fetch = function(input, init) {
  const url = (typeof input === "string" ? input : input?.url) || "";
  const headers = init?.headers;
  let friendly = "";
  if (headers instanceof Headers) {
    friendly = headers.get("X-FB-Friendly-Name") || "";
  } else if (headers && typeof headers === "object") {
    friendly = headers["X-FB-Friendly-Name"] || "";
  }
  // Also check input if it's a Request object
  if (!friendly && input instanceof Request) {
    friendly = input.headers?.get("X-FB-Friendly-Name") || "";
  }

  if (url.includes("/api/graphql") || url.includes("/graphql")) {
    pageLog("[FETCH] " + url.substring(0, 50) + " friendly=" + (friendly || "NONE"));
  }

  if (settings.blockDMRead && friendly.includes("MarkThreadAsReadValidation")) {
    pageLog("BLOCKED DMRead validation (fetch)");
    return Promise.resolve(new Response('{"data":{}}', { status: 200, headers: {"Content-Type": "application/json"} }));
  }
  return originalFetch.apply(this, arguments);
};

const originalBeacon = navigator.sendBeacon;
if (originalBeacon) {
  navigator.sendBeacon = function(url, data) {
    if (settings.blockDMRead && url && url.includes("/api/graphql")) {
      const text = typeof data === "string" ? data : "";
      if (text.includes("MarkThreadAsReadValidation")) {
        pageLog("Blocked DMRead validation (sendBeacon)");
        return true;
      }
    }
    return originalBeacon.apply(this, arguments);
  };
}

pageLog("Page context loaded - WS interception active (gateways: " + IG_WS_HOSTS.join(", ") + ")");

} // end guard
