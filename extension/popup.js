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

function esc(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

async function render() {
  console.log("[Popup] Rendering...");
  const cache = await getCache();
  const stats = await getStats();
  const el = document.getElementById("content");
  el.textContent = "";

  const header = document.createElement("div");
  header.style.cssText = "margin-bottom:8px;color:#8b949e;";
  header.textContent = "Blocked: " + stats.blockedCount + " seen receipts | Users: " + stats.users;
  el.appendChild(header);

  if (!cache || Object.keys(cache).length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "No stories cached yet. Browse Instagram and click on stories to start capturing.";
    el.appendChild(empty);
    return;
  }

  for (const [, data] of Object.entries(cache)) {
    const items = Object.values(data.items);
    if (items.length === 0) continue;

    const userDiv = document.createElement("div");
    userDiv.className = "user";

    const nameSpan = document.createElement("span");
    nameSpan.className = "username";
    nameSpan.textContent = "@" + data.username;
    userDiv.appendChild(nameSpan);
    userDiv.appendChild(document.createTextNode(" (" + items.length + " stories)"));
    userDiv.appendChild(document.createElement("br"));

    items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const item of items) {
      const time = item.timestamp ? new Date(item.timestamp * 1000).toLocaleString() : "?";
      const type = item.type || "image";

      const itemDiv = document.createElement("div");
      itemDiv.className = "item";

      let text = type + " | " + time;
      if (item.deleted) {
        const del = document.createElement("span");
        del.className = "deleted";
        del.textContent = " [DELETED]";
        itemDiv.appendChild(document.createTextNode(text));
        itemDiv.appendChild(del);
      } else {
        itemDiv.appendChild(document.createTextNode(text));
      }

      if (item.music_title) {
        itemDiv.appendChild(document.createTextNode(" \u266A " + item.music_title + (item.music_artist ? " - " + item.music_artist : "") + " "));
      }
      if (item.caption) {
        itemDiv.appendChild(document.createTextNode(' "' + item.caption.substring(0, 50) + '" '));
      }
      if (item.url) {
        const link = document.createElement("a");
        link.className = "media-link";
        link.href = item.url;
        link.target = "_blank";
        link.textContent = "open";
        itemDiv.appendChild(link);
      }

      const cached = document.createElement("span");
      cached.className = "cached";
      cached.textContent = " cached " + new Date(item.cached_at).toLocaleTimeString();
      itemDiv.appendChild(cached);

      userDiv.appendChild(itemDiv);
    }
    el.appendChild(userDiv);
  }
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

// Load settings into checkboxes
async function loadSettings() {
  try {
    const resp = await browser.runtime.sendMessage({ type: "getSettings" });
    if (resp) {
      document.getElementById("blockSeen").checked = resp.blockSeen !== false;
      document.getElementById("autoFetch").checked = resp.autoFetch !== false;
      document.getElementById("autoDownload").checked = resp.autoDownload !== false;
      if (resp.fetchInterval) document.getElementById("interval").value = resp.fetchInterval;
    }
  } catch(_) {}
}

document.getElementById("saveSettings").addEventListener("click", async () => {
  const settings = {
    blockSeen: document.getElementById("blockSeen").checked,
    autoFetch: document.getElementById("autoFetch").checked,
    autoDownload: document.getElementById("autoDownload").checked,
    fetchInterval: parseInt(document.getElementById("interval").value) || 300
  };
  await browser.runtime.sendMessage({ type: "saveSettings", settings });
});

loadSettings();
render();
