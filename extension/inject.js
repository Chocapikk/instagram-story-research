// Runs in MAIN world (page context) - injected by content.js
// Intercepts WebSocket messages to block typing indicators and presence
if (window.__igResearchLoaded) { /* already loaded */ } else {
window.__igResearchLoaded = true;

// Settings (updated via CustomEvent from content script)
let settings = { blockTyping: true, blockPresence: false };

window.addEventListener("ig_research_settings", (e) => {
  if (e.detail) settings = { ...settings, ...e.detail };
});

function pageLog(msg) {
  console.log("[IG Inject]", msg);
  window.dispatchEvent(new CustomEvent("ig_research_log", { detail: msg }));
}

// ---------------------------------------------------------------------------
// WebSocket monkey-patch
// Instagram uses MQTT over WebSocket (gateway.instagram.com) for:
// - Typing indicators (typing_activity, is_typing)
// - Presence/online status (co_presence, heartbeat, active_status)
// ---------------------------------------------------------------------------

const TYPING_MARKERS = [
  "typing_activity",
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

const originalWSSend = WebSocket.prototype.send;
let typingBlockedCount = 0;
let presenceBlockedCount = 0;

WebSocket.prototype.send = function(data) {
  if (!this.url || !this.url.includes("gateway.instagram.com")) {
    return originalWSSend.apply(this, arguments);
  }

  if (!settings.blockTyping && !settings.blockPresence) {
    return originalWSSend.apply(this, arguments);
  }

  // Decode binary frame to check for markers
  let text = "";
  try {
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(data));
    } else if (data instanceof Uint8Array) {
      text = new TextDecoder("utf-8", { fatal: false }).decode(data);
    } else if (data instanceof Blob) {
      return originalWSSend.apply(this, arguments);
    }
  } catch(_) {
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

pageLog("Page context loaded - WS interception active");

} // end guard
