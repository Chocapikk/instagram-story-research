// ---------------------------------------------------------------------------
// Debug logger
// ---------------------------------------------------------------------------

const logLines = [];

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  const line = "[" + ts + "] " + msg;
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  console.log("[Popup]", msg);
  renderLog();
}

function renderLog() {
  const el = document.getElementById("log");
  if (!el) return;
  el.textContent = "";
  for (const line of logLines) {
    const div = document.createElement("div");
    div.textContent = line;
    if (line.includes("ERROR")) div.className = "log-error";
    else if (line.includes("[PAGE]")) div.className = "log-page";
    else if (line.includes("[BG]")) div.className = "log-bg";
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------------------
// Background comms
// ---------------------------------------------------------------------------

async function getCache() {
  try {
    return (await browser.runtime.sendMessage({ type: "getCache" }))?.cache || null;
  } catch(_) { return null; }
}

async function getStats() {
  try {
    return await browser.runtime.sendMessage({ type: "getStats" });
  } catch(_) { return { blockedCount: 0, stories: 0, users: 0 }; }
}

async function getLogs() {
  try {
    return (await browser.runtime.sendMessage({ type: "getLogs" }))?.logs || [];
  } catch(_) { return []; }
}

// ---------------------------------------------------------------------------
// Stats bar
// ---------------------------------------------------------------------------

async function updateStats() {
  const stats = await getStats();
  document.getElementById("statBlocked").textContent = stats.blockedCount || 0;
  document.getElementById("statUsers").textContent = stats.users || 0;
  document.getElementById("statStories").textContent = stats.stories || 0;
}

// ---------------------------------------------------------------------------
// Render story list
// ---------------------------------------------------------------------------

function timeAgo(ts) {
  const diff = Math.floor((Date.now() / 1000) - ts);
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

async function render() {
  const cache = await getCache();
  await updateStats();
  const el = document.getElementById("content");
  el.textContent = "";

  if (!cache || Object.keys(cache).length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "No stories cached yet. Browse Instagram to start.";
    el.appendChild(empty);
    log("Cache empty");
    return;
  }

  // Sort users by most recent story
  const users = Object.entries(cache)
    .map(([id, data]) => {
      const items = Object.values(data.items);
      const latest = Math.max(...items.map(i => i.timestamp || 0));
      return { id, data, items, latest };
    })
    .filter(u => u.items.length > 0)
    .sort((a, b) => b.latest - a.latest);

  let totalItems = 0;
  for (const { data, items } of users) {
    totalItems += items.length;

    const userDiv = document.createElement("div");
    userDiv.className = "user";

    const headerDiv = document.createElement("div");
    headerDiv.className = "user-header";

    const nameSpan = document.createElement("span");
    nameSpan.className = "username";
    nameSpan.textContent = "@" + data.username;
    headerDiv.appendChild(nameSpan);

    const countSpan = document.createElement("span");
    countSpan.className = "story-count";
    countSpan.textContent = items.length + (items.length === 1 ? " story" : " stories");
    headerDiv.appendChild(countSpan);

    userDiv.appendChild(headerDiv);

    items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const item of items) {
      const type = item.type || "image";

      const itemDiv = document.createElement("div");
      itemDiv.className = "item";

      // Type badge
      const typeBadge = document.createElement("span");
      typeBadge.className = "item-type " + type;
      typeBadge.textContent = type === "video" ? "VID" : "IMG";
      itemDiv.appendChild(typeBadge);

      // Time
      if (item.timestamp) {
        const timeSpan = document.createElement("span");
        timeSpan.textContent = timeAgo(item.timestamp);
        itemDiv.appendChild(timeSpan);
      }

      // Deleted
      if (item.deleted) {
        const del = document.createElement("span");
        del.className = "deleted";
        del.textContent = "DELETED";
        itemDiv.appendChild(del);
      }

      // Music
      if (item.music_title) {
        const music = document.createElement("span");
        music.className = "music";
        music.textContent = "\u266A " + item.music_title + (item.music_artist ? " - " + item.music_artist : "");
        itemDiv.appendChild(music);
      }

      // Caption
      if (item.caption) {
        const cap = document.createElement("span");
        cap.className = "caption-text";
        cap.textContent = '"' + item.caption.substring(0, 40) + (item.caption.length > 40 ? '...' : '') + '"';
        itemDiv.appendChild(cap);
      }

      // Open link
      if (item.url) {
        const link = document.createElement("a");
        link.className = "media-link";
        link.href = item.url;
        link.target = "_blank";
        link.textContent = "open";
        itemDiv.appendChild(link);
      }

      // Cached time
      const cached = document.createElement("span");
      cached.className = "cached";
      cached.textContent = new Date(item.cached_at).toLocaleTimeString();
      itemDiv.appendChild(cached);

      userDiv.appendChild(itemDiv);
    }
    el.appendChild(userDiv);
  }
  log("Rendered " + totalItems + " stories / " + users.length + " users");
}

// ---------------------------------------------------------------------------
// Fetch background logs
// ---------------------------------------------------------------------------

async function syncLogs() {
  const bgLogs = await getLogs();
  for (const msg of bgLogs) {
    if (!logLines.includes(msg)) {
      logLines.push(msg);
      if (logLines.length > 200) logLines.shift();
    }
  }
  renderLog();
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

document.getElementById("refresh").addEventListener("click", async () => {
  log("Triggering fetch...");
  const btn = document.getElementById("refresh");
  btn.textContent = "Fetching...";
  btn.disabled = true;
  await browser.runtime.sendMessage({ type: "triggerFetch" });
  setTimeout(async () => {
    await syncLogs();
    await render();
    btn.textContent = "Refresh";
    btn.disabled = false;
    log("Refresh complete");
  }, 3000);
});

document.getElementById("clear").addEventListener("click", async () => {
  log("Clearing cache...");
  await browser.runtime.sendMessage({ type: "clearCache" });
  await render();
  log("Cache cleared");
});

document.getElementById("export").addEventListener("click", async () => {
  log("Exporting JSON...");
  const cache = await getCache();
  if (!cache) { log("Nothing to export"); return; }
  const blob = new Blob([JSON.stringify(cache, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ig_story_cache_" + Date.now() + ".json";
  a.click();
  URL.revokeObjectURL(url);
  log("JSON exported");
});

document.getElementById("clearLog").addEventListener("click", () => {
  logLines.length = 0;
  renderLog();
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  try {
    const resp = await browser.runtime.sendMessage({ type: "getSettings" });
    if (resp) {
      document.getElementById("blockSeen").checked = resp.blockSeen !== false;
      document.getElementById("blockDMRead").checked = resp.blockDMRead !== false;
      document.getElementById("blockTyping").checked = resp.blockTyping !== false;
      document.getElementById("autoFetch").checked = resp.autoFetch !== false;
      document.getElementById("autoDownload").checked = resp.autoDownload !== false;
      if (resp.fetchInterval) document.getElementById("interval").value = resp.fetchInterval;
      log("Settings loaded");
    }
  } catch(_) {
    log("Failed to load settings");
  }
}

document.getElementById("saveSettings").addEventListener("click", async () => {
  const settings = {
    blockSeen: document.getElementById("blockSeen").checked,
    blockDMRead: document.getElementById("blockDMRead").checked,
    blockTyping: document.getElementById("blockTyping").checked,
    autoFetch: document.getElementById("autoFetch").checked,
    autoDownload: document.getElementById("autoDownload").checked,
    fetchInterval: parseInt(document.getElementById("interval").value) || 300
  };
  await browser.runtime.sendMessage({ type: "saveSettings", settings });
  log("Settings saved");
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

loadSettings();
syncLogs();
render();
log("Popup ready");
