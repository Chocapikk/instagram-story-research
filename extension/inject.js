// Runs in MAIN world (page context) - injected by content.js
// Intercepts WebSocket messages to block typing indicators
if (window.__igResearchLoaded) { /* already loaded */ } else {
window.__igResearchLoaded = true;

// Settings (updated via CustomEvent from content script)
let settings = { blockTyping: true };

window.addEventListener("ig_research_settings", (e) => {
  if (e.detail) settings = { ...settings, ...e.detail };
});

function pageLog(msg) {
  console.log("[IG Inject]", msg);
  window.dispatchEvent(new CustomEvent("ig_research_log", { detail: msg }));
}

// ---------------------------------------------------------------------------
// WebSocket monkey-patch - intercept typing indicators on MQTT gateway
// Instagram uses MQTT over WebSocket (gateway.instagram.com). Typing
// indicators are sent as binary MQTT PUBLISH frames containing identifiable
// markers in the payload.
// ---------------------------------------------------------------------------

const TYPING_MARKERS = [
  "typing_activity",
  "is_typing",
  "/thread_typing",
  "TYPING_INDICATOR"
];

const originalWSSend = WebSocket.prototype.send;
let typingBlockedCount = 0;

WebSocket.prototype.send = function(data) {
  if (!settings.blockTyping || !this.url || !this.url.includes("gateway.instagram.com")) {
    return originalWSSend.apply(this, arguments);
  }

  // Decode binary frame to check for typing markers
  let text = "";
  try {
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(data));
    } else if (data instanceof Uint8Array) {
      text = new TextDecoder("utf-8", { fatal: false }).decode(data);
    } else if (data instanceof Blob) {
      // Can't decode synchronously, let it through
      return originalWSSend.apply(this, arguments);
    }
  } catch(_) {
    return originalWSSend.apply(this, arguments);
  }

  if (TYPING_MARKERS.some(m => text.includes(m))) {
    typingBlockedCount++;
    pageLog("Blocked typing indicator #" + typingBlockedCount);
    return; // drop
  }

  return originalWSSend.apply(this, arguments);
};

pageLog("Page context loaded - WebSocket typing blocker active");

} // end guard
