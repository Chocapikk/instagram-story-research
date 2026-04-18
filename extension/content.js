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

if (document.readyState === "complete") {
  init();
} else {
  window.addEventListener("load", init);
}
