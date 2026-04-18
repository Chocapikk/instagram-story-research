console.log("[Popup] Loaded");

async function getCache() {
  try {
    const response = await browser.runtime.sendMessage({ type: "getCache" });
    console.log("[Popup] Got cache:", response);
    return response?.cache || null;
  } catch(_) {
    return null;
  }
}

async function getStats() {
  try {
    return await browser.runtime.sendMessage({ type: "getStats" });
  } catch(e) {
    return { blockedCount: 0, cachedCount: 0, users: 0 };
  }
}

async function render() {
  console.log("[Popup] Rendering...");
  const cache = await getCache();
  const stats = await getStats();
  const el = document.getElementById("content");

  const header = "<div style='margin-bottom:8px;color:#8b949e;'>" +
    "Blocked: " + stats.blockedCount + " seen receipts | " +
    "Users: " + stats.users +
    "</div>";

  if (!cache || Object.keys(cache).length === 0) {
    el.innerHTML = header + '<span class="empty">No stories cached yet. Browse Instagram and click on stories to start capturing.</span>';
    return;
  }

  let html = header;
  for (const [, data] of Object.entries(cache)) {
    const items = Object.values(data.items);
    if (items.length === 0) continue;

    html += '<div class="user">';
    html += '<span class="username">@' + data.username + '</span> (' + items.length + ' stories)<br>';

    items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const item of items) {
      const time = item.timestamp ? new Date(item.timestamp * 1000).toLocaleString() : "?";
      const type = item.type || "image";
      const status = item.deleted ? ' <span class="deleted">[DELETED]</span>' : "";

      html += '<div class="item">';
      html += type + " | " + time + status + " ";
      if (item.music_title) {
        html += '♪ ' + item.music_title + (item.music_artist ? ' - ' + item.music_artist : '') + ' ';
      }
      if (item.caption) {
        html += '"' + item.caption.substring(0, 50) + '" ';
      }
      if (item.url) {
        html += '<a class="media-link" href="' + item.url + '" target="_blank">open</a>';
      }
      html += ' <span class="cached">cached ' + new Date(item.cached_at).toLocaleTimeString() + "</span>";
      html += "</div>";
    }
    html += "</div>";
  }
  el.innerHTML = html;
}

document.getElementById("refresh").addEventListener("click", async () => {
  console.log("[Popup] Refresh clicked");
  await browser.runtime.sendMessage({ type: "triggerFetch" });
  setTimeout(render, 3000);
});

document.getElementById("clear").addEventListener("click", async () => {
  console.log("[Popup] Clear clicked");
  await browser.runtime.sendMessage({ type: "clearCache" });
  render();
});

document.getElementById("export").addEventListener("click", async () => {
  console.log("[Popup] Export clicked");
  const cache = await getCache();
  if (!cache) return;
  const blob = new Blob([JSON.stringify(cache, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ig_story_cache_" + Date.now() + ".json";
  a.click();
  URL.revokeObjectURL(url);
});

render();
