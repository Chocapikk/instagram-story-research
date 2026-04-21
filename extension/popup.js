// ---------------------------------------------------------------------------
// Debug logger
// ---------------------------------------------------------------------------

const logLines = [];

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logLines.push("[" + ts + "] " + msg);
  if (logLines.length > 200) logLines.shift();
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

async function send(type) {
  try { return await browser.runtime.sendMessage({ type }); }
  catch(_) { return null; }
}

async function syncLogs() {
  const resp = await send("getLogs");
  if (!resp?.logs) return;
  for (const msg of resp.logs) {
    if (!logLines.includes(msg)) {
      logLines.push(msg);
      if (logLines.length > 200) logLines.shift();
    }
  }
  renderLog();
}

async function updateStats() {
  const stats = (await send("getStats")) || {};
  document.getElementById("statBlocked").textContent = stats.blockedCount || 0;
  document.getElementById("statUsers").textContent = stats.users || 0;
  document.getElementById("statStories").textContent = stats.stories || 0;
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
  const poll = setInterval(async () => {
    await syncLogs();
    await updateStats();
  }, 1000);
  setTimeout(() => {
    clearInterval(poll);
    updateStats();
    syncLogs();
    btn.textContent = "\u21BB Refresh";
    btn.disabled = false;
    log("Refresh complete");
  }, 10000);
});

document.getElementById("viewStories").addEventListener("click", () => {
  browser.tabs.create({ url: browser.runtime.getURL("stories.html") });
});

document.getElementById("export").addEventListener("click", async () => {
  log("Exporting JSON...");
  const resp = await send("getCache");
  if (!resp?.cache) { log("Nothing to export"); return; }
  const blob = new Blob([JSON.stringify(resp.cache, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ig_story_cache_" + Date.now() + ".json";
  a.click();
  URL.revokeObjectURL(url);
  log("JSON exported");
});

document.getElementById("clear").addEventListener("click", async () => {
  log("Clearing cache...");
  await browser.runtime.sendMessage({ type: "clearCache" });
  await updateStats();
  log("Cache cleared");
});

document.getElementById("clearLog").addEventListener("click", () => {
  logLines.length = 0;
  renderLog();
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function loadSettings() {
  const resp = await send("getSettings");
  if (!resp) return;
  document.getElementById("blockSeen").checked = resp.blockSeen !== false;
  document.getElementById("blockDMRead").checked = resp.blockDMRead !== false;
  document.getElementById("blockTyping").checked = resp.blockTyping !== false;
  document.getElementById("blockPresence").checked = resp.blockPresence === true;
  document.getElementById("autoFetch").checked = resp.autoFetch !== false;
  document.getElementById("autoDownload").checked = resp.autoDownload !== false;
  if (resp.fetchInterval) document.getElementById("interval").value = resp.fetchInterval;
  log("Settings loaded");
}

document.getElementById("saveSettings").addEventListener("click", async () => {
  const settings = {
    blockSeen: document.getElementById("blockSeen").checked,
    blockDMRead: document.getElementById("blockDMRead").checked,
    blockTyping: document.getElementById("blockTyping").checked,
    blockPresence: document.getElementById("blockPresence").checked,
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
updateStats();
log("Popup ready");

// Real-time updates from background
browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === "statsUpdate") {
    document.getElementById("statBlocked").textContent = msg.blockedCount || 0;
    document.getElementById("statUsers").textContent = msg.users || 0;
    document.getElementById("statStories").textContent = msg.stories || 0;
  }
  if (msg.type === "logUpdate" && msg.line) {
    logLines.push(msg.line);
    if (logLines.length > 200) logLines.shift();
    renderLog();
  }
});
