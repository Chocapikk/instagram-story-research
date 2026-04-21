// Stories browser - full tab view

async function getCache() {
  try {
    return (await browser.runtime.sendMessage({ type: "getCache" }))?.cache || null;
  } catch(_) { return null; }
}

async function getSeenHistory() {
  try {
    const resp = await browser.runtime.sendMessage({ type: "getSeenHistory" });
    return resp?.seenHistory || {};
  } catch(_) { return {}; }
}

async function scanLocalFiles() {
  try {
    const results = await browser.downloads.search({ query: ["ig_stories/"], limit: 5000, orderBy: ["-startTime"] });
    const files = {};
    for (const dl of results) {
      if (!dl.filename || dl.state !== "complete") continue;
      // Parse: .../ig_stories/<username>/<date>_<mediaId>.<ext>
      const match = dl.filename.match(/ig_stories\/([^/]+)\/(\d{4}-\d{2}-\d{2})_(\d+)\.(jpg|mp4)$/);
      if (!match) continue;
      const [, username, date, mediaId, ext] = match;
      if (!files[username]) files[username] = {};
      files[username][mediaId] = {
        id: mediaId,
        type: ext === "mp4" ? "video" : "image",
        localDate: date,
        downloadId: dl.id,
        fileUrl: "file://" + dl.filename,
        fileSize: dl.fileSize || 0
      };
    }
    return files;
  } catch(_) { return {}; }
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() / 1000) - ts);
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}

function durationStr(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return Math.floor(h / 24) + "d " + (h % 24) + "h";
  return h + "h " + m + "m";
}

function parseCdnExpiry(url) {
  if (!url) return null;
  const match = url.match(/[&?]oe=([0-9a-fA-F]+)/);
  if (!match) return null;
  return parseInt(match[1], 16) * 1000;
}

function cdnStatus(url) {
  const expiry = parseCdnExpiry(url);
  if (!expiry) return null;
  const now = Date.now();
  if (now < expiry) {
    return { valid: true, expiry, remaining: durationStr(expiry - now) };
  }
  return { valid: false, expiry, elapsed: durationStr(now - expiry) };
}

function formatDate(ts) {
  return ts ? new Date(ts * 1000).toLocaleString() : "-";
}

function formatMs(ts) {
  return ts ? new Date(ts).toLocaleString() : "-";
}

function getLocalPath(username, item) {
  const date = item.timestamp ? new Date(item.timestamp * 1000).toISOString().split("T")[0] : "unknown";
  const ext = item.type === "video" ? "mp4" : "jpg";
  return "ig_stories/" + username + "/" + date + "_" + item.id + "." + ext;
}

async function findDownload(path) {
  try {
    const results = await browser.downloads.search({ query: [path], limit: 1 });
    return results.length > 0 ? results[0] : null;
  } catch(_) { return null; }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function render(filter) {
  const cache = await getCache() || {};
  const seenHist = await getSeenHistory();
  const localFiles = await scanLocalFiles();
  const el = document.getElementById("content");
  el.textContent = "";

  // Merge local files into cache: add stories that exist on disk but not in cache
  const merged = JSON.parse(JSON.stringify(cache));
  for (const [username, files] of Object.entries(localFiles)) {
    // Find user in cache by username
    let userId = null;
    for (const [uid, data] of Object.entries(merged)) {
      if (data.username === username) { userId = uid; break; }
    }
    if (!userId) {
      userId = "local_" + username;
      merged[userId] = { username, items: {} };
    }
    for (const [mediaId, file] of Object.entries(files)) {
      if (!merged[userId].items[mediaId]) {
        const hist = seenHist[mediaId] || {};
        merged[userId].items[mediaId] = {
          id: mediaId,
          type: file.type,
          timestamp: null,
          expiring_at: null,
          cached_at: null,
          url: null,
          localOnly: true,
          downloadId: file.downloadId,
          seenSent: hist.seenSent || false,
          seenBlocked: hist.seenBlocked || false
        };
      } else {
        // Attach download ID to existing cached item
        merged[userId].items[mediaId].downloadId = file.downloadId;
      }
    }
  }

  const hasData = Object.values(merged).some(u => Object.keys(u.items).length > 0);
  if (!hasData) {
    el.appendChild(Object.assign(document.createElement("div"), {
      className: "empty", textContent: "No stories cached or downloaded. Open Instagram and click Refresh in the extension popup."
    }));
    document.getElementById("totalCount").textContent = "";
    return;
  }

  const users = Object.entries(cache)
    .map(([id, data]) => {
      const items = Object.values(data.items);
      const latest = Math.max(...items.map(i => i.timestamp || 0));
      return { id, data, items, latest };
    })
    .filter(u => u.items.length > 0)
    .filter(u => !filter || u.data.username.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => {
      const sort = document.getElementById("sortBy")?.value || "newest";
      if (sort === "oldest") return a.latest - b.latest;
      if (sort === "username") return a.data.username.localeCompare(b.data.username);
      return b.latest - a.latest;
    });

  let total = 0;
  for (const { data, items } of users) {
    total += items.length;
    const section = document.createElement("div");
    section.className = "user-section";

    // User header
    const header = document.createElement("div");
    header.className = "user-header";

    const avatar = document.createElement("div");
    avatar.className = "user-avatar";
    avatar.textContent = data.username.charAt(0).toUpperCase();
    header.appendChild(avatar);

    const info = document.createElement("div");
    const name = document.createElement("div");
    name.className = "user-name";
    name.textContent = "@" + data.username;
    info.appendChild(name);
    const count = document.createElement("div");
    count.className = "user-count";
    count.textContent = items.length + (items.length === 1 ? " story" : " stories");
    info.appendChild(count);
    header.appendChild(info);

    const dashBtn = document.createElement("button");
    dashBtn.className = "dash-toggle";
    dashBtn.textContent = "\uD83D\uDCCA Analytics";
    dashBtn.style.marginLeft = "auto";
    header.appendChild(dashBtn);

    section.appendChild(header);

    // Dashboard
    const dashId = "dash-" + data.username;
    const dashboard = document.createElement("div");
    dashboard.className = "user-dashboard";
    dashboard.id = dashId;
    section.appendChild(dashboard);

    dashBtn.addEventListener("click", () => {
      const isOpen = dashboard.classList.toggle("open");
      if (isOpen) buildDashboard(dashboard, data.username, items);
    });

    // Story grid
    const grid = document.createElement("div");
    grid.className = "story-grid";

    items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const item of items) {
      grid.appendChild(buildCard(data.username, item));
    }

    section.appendChild(grid);
    el.appendChild(section);
  }

  document.getElementById("totalCount").textContent = total + " stories - " + users.length + " users";
}

// ---------------------------------------------------------------------------
// Story card
// ---------------------------------------------------------------------------

function buildCard(username, item) {
  const card = document.createElement("div");
  card.className = "story-card" + (item.deleted ? " deleted" : "");

  // Preview
  const preview = document.createElement("div");
  preview.className = "story-preview";

  if (item.url) {
    if (item.type === "video") {
      // Show play icon instead of loading video - load on click only
      const placeholder = document.createElement("div");
      placeholder.style.cssText = "width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:48px;color:#8b949e;background:#161b22;";
      placeholder.textContent = "\u25B6";
      preview.appendChild(placeholder);

      const overlay = document.createElement("div");
      overlay.className = "play-overlay";
      overlay.textContent = "\u25B6 VID";
      preview.appendChild(overlay);
    } else {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.onerror = () => { img.remove(); preview.textContent = "\uD83D\uDCF7"; };
      preview.appendChild(img);
      // Load image only when visible
      const obs = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) { img.src = item.url; obs.disconnect(); }
      });
      obs.observe(preview);
    }
  } else {
    preview.textContent = item.type === "video" ? "\u25B6" : "\uD83D\uDCF7";
  }

  preview.addEventListener("click", () => openLightbox(username, item));
  card.appendChild(preview);

  // Info
  const info = document.createElement("div");
  info.className = "story-info";

  // Top row: badges + time
  const top = document.createElement("div");
  top.className = "story-info-top";

  const typeBadge = document.createElement("span");
  typeBadge.className = "badge " + (item.type === "video" ? "badge-video" : "badge-image");
  typeBadge.textContent = item.type === "video" ? "\u25B6 VID" : "\uD83D\uDDBC IMG";
  top.appendChild(typeBadge);

  if (item.localOnly) {
    const local = document.createElement("span");
    local.className = "badge badge-local";
    local.textContent = "\uD83D\uDCBE LOCAL";
    local.title = "Only on disk - expired from live cache";
    top.appendChild(local);
  }

  if (item.audience === "besties") {
    const bestie = document.createElement("span");
    bestie.className = "badge badge-bestie";
    bestie.textContent = "\u2B50 CLOSE FRIENDS";
    top.appendChild(bestie);
  }

  if (item.seenSent) {
    const seen = document.createElement("span");
    seen.className = "badge badge-seen";
    seen.textContent = "\uD83D\uDC41 SEEN";
    seen.title = "You viewed this and the seen receipt was sent";
    top.appendChild(seen);
  } else if (item.seenBlocked) {
    const ghost = document.createElement("span");
    ghost.className = "badge badge-ghost";
    ghost.textContent = "\uD83D\uDC7B GHOST";
    ghost.title = "Viewed invisibly - no receipt sent";
    top.appendChild(ghost);
  }

  const now = Math.floor(Date.now() / 1000);
  const isExpired = item.expiring_at && now > item.expiring_at;
  if (item.deleted) {
    const del = document.createElement("span");
    del.className = "badge badge-purged";
    del.textContent = "\uD83D\uDDD1 PURGED";

    // Calculate deltas
    const postedMs = item.timestamp ? item.timestamp * 1000 : 0;
    const deletedMs = item.deleted_at || 0;
    const cachedMs = item.cached_at || 0;
    let titleParts = ["Deleted by poster before 24h expiry"];
    if (postedMs && deletedMs) {
      titleParts.push("Was live for " + durationStr(deletedMs - postedMs));
    }
    if (cachedMs && deletedMs && !item.seenBlocked) {
      titleParts.push("Cached " + durationStr(deletedMs - cachedMs) + " before deletion");
    }
    del.title = titleParts.join(" | ");
    top.appendChild(del);

    // Show duration badge
    if (postedMs && deletedMs) {
      const dur = document.createElement("span");
      dur.className = "story-time";
      dur.style.color = "#f85149";
      dur.textContent = "\u23F1 Lived " + durationStr(deletedMs - postedMs);
      dur.title = "Posted, then deleted " + durationStr(deletedMs - postedMs) + " later";
      top.appendChild(dur);
    }
  } else if (isExpired) {
    const exp = document.createElement("span");
    exp.className = "badge badge-expired";
    exp.textContent = "\u23F0 EXPIRED";
    exp.title = "Expired naturally after 24h at " + formatDate(item.expiring_at);
    top.appendChild(exp);
  } else if (item.expiring_at) {
    const live = document.createElement("span");
    live.className = "badge badge-live";
    live.textContent = "\uD83D\uDFE2 LIVE";
    live.title = "Expires " + formatDate(item.expiring_at);
    top.appendChild(live);
  }

  // CDN token status
  const cdn = cdnStatus(item.url);
  if (cdn) {
    const cdnBadge = document.createElement("span");
    if (cdn.valid) {
      cdnBadge.className = "badge badge-live";
      cdnBadge.textContent = "\uD83D\uDD17 CDN " + cdn.remaining;
      cdnBadge.title = "CDN token valid for " + cdn.remaining + " (expires " + new Date(cdn.expiry).toLocaleString() + ")";
    } else {
      cdnBadge.className = "badge badge-expired";
      cdnBadge.textContent = "\uD83D\uDD17 CDN dead";
      cdnBadge.title = "CDN token expired " + cdn.elapsed + " ago";
    }
    top.appendChild(cdnBadge);
  }

  if (item.timestamp) {
    const time = document.createElement("span");
    time.className = "story-time";
    time.textContent = timeAgo(item.timestamp);
    time.title = formatDate(item.timestamp);
    top.appendChild(time);
  }
  info.appendChild(top);

  // Music
  if (item.music_title) {
    const music = document.createElement("div");
    music.className = "story-music";
    music.textContent = "\u266A " + item.music_title + (item.music_artist ? " - " + item.music_artist : "");
    info.appendChild(music);
  }

  // Caption
  if (item.caption) {
    const cap = document.createElement("div");
    cap.className = "story-caption";
    cap.textContent = item.caption;
    cap.title = item.caption;
    info.appendChild(cap);
  }

  // Metadata toggle
  const toggle = document.createElement("div");
  toggle.className = "meta-toggle";
  toggle.textContent = "\u25B6 Metadata";
  const panel = document.createElement("div");
  panel.className = "meta-panel";
  toggle.addEventListener("click", () => {
    const open = panel.classList.toggle("open");
    toggle.textContent = (open ? "\u25BC" : "\u25B6") + " Metadata";
  });

  const metaFields = [
    ["Media ID", item.id],
    ["Code", item.code],
    ["Type", item.type],
    ["Posted", formatDate(item.timestamp)],
    ["Expires", formatDate(item.expiring_at)],
    ["Cached", formatMs(item.cached_at)],
    ["Size", item.width && item.height ? item.width + "x" + item.height : null],
    ["Music", item.music_title ? item.music_title + (item.music_artist ? " - " + item.music_artist : "") : null],
    ["Caption", item.caption],
    ["Audience", item.audience],
    ["Viewers", item.viewer_count],
    ["Deleted", item.deleted ? "Yes (" + formatMs(item.deleted_at) + ")" : "No"],
    ["Story lifespan", item.deleted && item.timestamp && item.deleted_at ? durationStr(item.deleted_at - item.timestamp * 1000) : null],
    ["Seen after", item.cached_at && item.timestamp ? durationStr(item.cached_at - item.timestamp * 1000) : null],
    ["Deleted after seen", item.deleted && item.cached_at && item.deleted_at && !item.seenBlocked ? durationStr(item.deleted_at - item.cached_at) : null],
    ["Seen status", item.seenSent ? "Seen (receipt sent)" : item.seenBlocked ? "Ghost (receipt blocked)" : "Auto-fetched"],
    ["CDN token expires", cdn ? new Date(cdn.expiry).toLocaleString() : null],
    ["CDN token status", cdn ? (cdn.valid ? "Valid (" + cdn.remaining + " remaining)" : "Expired (" + cdn.elapsed + " ago)") : null],
    ["CDN token lifetime", cdn && item.timestamp ? durationStr(cdn.expiry - item.timestamp * 1000) + " after post" : null],
    ["Local path", getLocalPath(username, item)]
  ];

  for (const [key, value] of metaFields) {
    if (value === null || value === undefined || value === "") continue;
    const row = document.createElement("div");
    row.className = "meta-row";
    const k = document.createElement("span");
    k.className = "meta-key";
    k.textContent = key;
    const v = document.createElement("span");
    v.className = "meta-value";
    v.textContent = String(value);
    row.appendChild(k);
    row.appendChild(v);
    panel.appendChild(row);
  }

  info.appendChild(toggle);
  info.appendChild(panel);

  // Actions
  const actions = document.createElement("div");
  actions.className = "story-actions";

  if (item.url) {
    const openCDN = document.createElement("a");
    openCDN.href = item.url;
    openCDN.target = "_blank";
    const cdnDead = cdn && !cdn.valid;
    if (cdnDead) {
      openCDN.textContent = "CDN (dead)";
      openCDN.title = "CDN token expired " + cdn.elapsed + " ago";
      openCDN.style.cssText = "opacity:0.4;text-decoration:line-through;";
    } else if (cdn && cdn.valid) {
      openCDN.textContent = "CDN (" + cdn.remaining + ")";
      openCDN.title = "CDN token valid for " + cdn.remaining;
    } else {
      openCDN.textContent = "Open CDN";
      openCDN.title = "Open from Instagram CDN";
    }
    actions.appendChild(openCDN);
  }

  const openLocal = document.createElement("button");
  openLocal.textContent = "Open local";
  openLocal.title = "Open downloaded file";
  openLocal.addEventListener("click", async () => {
    if (item.downloadId) {
      browser.downloads.open(item.downloadId).catch(() => browser.downloads.show(item.downloadId));
      return;
    }
    const localPath = getLocalPath(username, item);
    const dl = await findDownload(localPath);
    if (dl) {
      browser.downloads.open(dl.id).catch(() => browser.downloads.show(dl.id));
    }
  });
  actions.appendChild(openLocal);

  info.appendChild(actions);
  card.appendChild(info);
  return card;
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

function openLightbox(username, item) {
  const lb = document.getElementById("lightbox");
  const media = document.getElementById("lightboxMedia");
  const info = document.getElementById("lightboxInfo");
  media.textContent = "";
  info.textContent = "";

  if (item.url) {
    if (item.type === "video") {
      const video = document.createElement("video");
      video.src = item.url;
      video.controls = true;
      video.autoplay = true;
      media.appendChild(video);
    } else {
      const img = document.createElement("img");
      img.src = item.url;
      media.appendChild(img);
    }
  }

  const user = document.createElement("div");
  user.className = "lb-user";
  user.textContent = "@" + username;
  info.appendChild(user);

  if (item.timestamp) {
    const time = document.createElement("div");
    time.textContent = formatDate(item.timestamp) + " (" + timeAgo(item.timestamp) + ")";
    info.appendChild(time);
  }

  if (item.music_title) {
    const music = document.createElement("div");
    music.className = "lb-music";
    music.textContent = "\u266A " + item.music_title + (item.music_artist ? " - " + item.music_artist : "");
    info.appendChild(music);
  }

  if (item.caption) {
    const cap = document.createElement("div");
    cap.textContent = '"' + item.caption + '"';
    info.appendChild(cap);
  }

  if (item.deleted) {
    const del = document.createElement("div");
    del.style.color = "#f85149";
    del.textContent = "DELETED" + (item.deleted_at ? " at " + formatMs(item.deleted_at) : "");
    info.appendChild(del);
  }

  lb.classList.add("active");
}

document.getElementById("closeLightbox").addEventListener("click", () => {
  const lb = document.getElementById("lightbox");
  lb.classList.remove("active");
  const video = document.getElementById("lightboxMedia").querySelector("video");
  if (video) video.pause();
  document.getElementById("lightboxMedia").textContent = "";
  document.getElementById("lightboxInfo").textContent = "";
});

document.getElementById("lightbox").addEventListener("click", (e) => {
  if (e.target === document.getElementById("lightbox")) {
    document.getElementById("closeLightbox").click();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.getElementById("closeLightbox").click();
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let searchTimeout;
document.getElementById("search").addEventListener("input", (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => render(e.target.value), 300);
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.getElementById("sortBy").addEventListener("change", () => {
  render(document.getElementById("search").value);
});

// Tab switching
document.getElementById("tabStories").addEventListener("click", () => {
  document.getElementById("tabStories").classList.add("active");
  document.getElementById("tabGlobal").classList.remove("active");
  document.getElementById("content").style.display = "";
  document.querySelector(".search-bar").style.display = "";
  document.getElementById("globalDashboard").classList.remove("active");
});

document.getElementById("tabGlobal").addEventListener("click", async () => {
  document.getElementById("tabGlobal").classList.add("active");
  document.getElementById("tabStories").classList.remove("active");
  document.getElementById("content").style.display = "none";
  document.querySelector(".search-bar").style.display = "none";
  document.getElementById("globalDashboard").classList.add("active");
  await buildGlobalDashboard();
});

document.getElementById("refreshBtn").addEventListener("click", async () => {
  const btn = document.getElementById("refreshBtn");
  btn.textContent = "Fetching...";
  btn.disabled = true;
  await browser.runtime.sendMessage({ type: "triggerFetch" });
  setTimeout(async () => {
    await render(document.getElementById("search").value);
    btn.textContent = "\u21BB Refresh";
    btn.disabled = false;
  }, 3000);
});

render();

// ---------------------------------------------------------------------------
// User analytics dashboard
// ---------------------------------------------------------------------------

const chartDefaults = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { labels: { color: "#c9d1d9", font: { size: 10 } } } },
  scales: {
    x: { ticks: { color: "#8b949e", font: { size: 9 } }, grid: { color: "#21262d" } },
    y: { ticks: { color: "#8b949e", font: { size: 9 } }, grid: { color: "#21262d" } }
  }
};

function buildDashboard(container, username, items) {
  container.textContent = "";

  const now = Math.floor(Date.now() / 1000);
  const totalStories = items.length;
  const videos = items.filter(i => i.type === "video").length;
  const images = totalStories - videos;
  const deleted = items.filter(i => i.deleted);
  const besties = items.filter(i => i.audience === "besties").length;
  const ghosted = items.filter(i => i.seenBlocked).length;
  const seen = items.filter(i => i.seenSent).length;

  // Average response time (cached_at - timestamp)
  const responseTimes = items
    .filter(i => i.cached_at && i.timestamp)
    .map(i => (i.cached_at - i.timestamp * 1000) / 1000);
  const avgResponse = responseTimes.length
    ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
    : 0;

  // Average deletion speed
  const deletionSpeeds = deleted
    .filter(i => i.deleted_at && i.timestamp)
    .map(i => (i.deleted_at - i.timestamp * 1000) / 1000);
  const avgDeletion = deletionSpeeds.length
    ? deletionSpeeds.reduce((a, b) => a + b, 0) / deletionSpeeds.length
    : 0;

  // Title
  const title = document.createElement("div");
  title.className = "dash-title";
  title.textContent = "\uD83D\uDCCA Analytics for @" + username;
  container.appendChild(title);

  // Stat cards
  const grid = document.createElement("div");
  grid.className = "dash-grid";

  const stats = [
    [totalStories, "Total stories"],
    [Math.round((deleted.length / totalStories) * 100) + "%", "Deletion rate"],
    [durationStr(avgResponse * 1000), "Avg time to view"],
    [avgDeletion > 0 ? durationStr(avgDeletion * 1000) : "-", "Avg deletion speed"],
    [Math.round((besties / totalStories) * 100) + "%", "Close friends"],
    [Math.round((videos / totalStories) * 100) + "%", "Video ratio"]
  ];

  for (const [value, label] of stats) {
    const card = document.createElement("div");
    card.className = "dash-stat";
    const v = document.createElement("div");
    v.className = "dash-stat-value";
    v.textContent = value;
    const l = document.createElement("div");
    l.className = "dash-stat-label";
    l.textContent = label;
    card.appendChild(v);
    card.appendChild(l);
    grid.appendChild(card);
  }
  container.appendChild(grid);

  // Charts
  const charts = document.createElement("div");
  charts.className = "dash-charts";

  // 1. Posting hours histogram
  const hours = new Array(24).fill(0);
  items.forEach(i => { if (i.timestamp) hours[new Date(i.timestamp * 1000).getHours()]++; });
  const hoursChart = makeChartContainer("Posting hours");
  charts.appendChild(hoursChart.wrapper);
  new Chart(hoursChart.canvas, {
    type: "bar",
    data: {
      labels: Array.from({ length: 24 }, (_, i) => i + "h"),
      datasets: [{ data: hours, backgroundColor: "#58a6ff", borderRadius: 3 }]
    },
    options: { ...chartDefaults, plugins: { legend: { display: false } } }
  });

  // 2. Media type + status donut
  const typeChart = makeChartContainer("Content breakdown");
  charts.appendChild(typeChart.wrapper);
  new Chart(typeChart.canvas, {
    type: "doughnut",
    data: {
      labels: ["Images", "Videos", "Deleted", "Close Friends"],
      datasets: [{
        data: [images, videos, deleted.length, besties],
        backgroundColor: ["#58a6ff", "#3fb950", "#f85149", "#d29922"]
      }]
    },
    options: { ...chartDefaults, scales: {} }
  });

  // 3. Seen status donut
  const seenChart = makeChartContainer("Seen status");
  charts.appendChild(seenChart.wrapper);
  const autoFetched = totalStories - seen - ghosted;
  new Chart(seenChart.canvas, {
    type: "doughnut",
    data: {
      labels: ["Seen (receipt sent)", "Ghost (blocked)", "Auto-fetched"],
      datasets: [{
        data: [seen, ghosted, autoFetched],
        backgroundColor: ["#d29922", "#8957e5", "#30363d"]
      }]
    },
    options: { ...chartDefaults, scales: {} }
  });

  // 4. Activity timeline (stories per day)
  const days = {};
  items.forEach(i => {
    if (!i.timestamp) return;
    const day = new Date(i.timestamp * 1000).toISOString().split("T")[0];
    days[day] = (days[day] || 0) + 1;
  });
  const sortedDays = Object.keys(days).sort();
  if (sortedDays.length > 1) {
    const timeChart = makeChartContainer("Activity timeline");
    charts.appendChild(timeChart.wrapper);
    new Chart(timeChart.canvas, {
      type: "line",
      data: {
        labels: sortedDays.map(d => d.slice(5)),
        datasets: [{
          data: sortedDays.map(d => days[d]),
          borderColor: "#58a6ff",
          backgroundColor: "#58a6ff22",
          fill: true,
          tension: 0.3,
          pointRadius: 3
        }]
      },
      options: { ...chartDefaults, plugins: { legend: { display: false } } }
    });
  }

  container.appendChild(charts);

  // 5. Top music
  const musicCounts = {};
  items.forEach(i => {
    if (!i.music_title) return;
    const key = i.music_title + (i.music_artist ? " - " + i.music_artist : "");
    musicCounts[key] = (musicCounts[key] || 0) + 1;
  });
  const topMusic = Object.entries(musicCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topMusic.length > 0) {
    const musicDiv = document.createElement("div");
    musicDiv.className = "dash-chart";
    musicDiv.style.marginTop = "12px";
    const musicTitle = document.createElement("div");
    musicTitle.className = "dash-chart-title";
    musicTitle.textContent = "\u266A Top music";
    musicDiv.appendChild(musicTitle);
    const list = document.createElement("div");
    list.className = "dash-music-list";
    for (const [song, count] of topMusic) {
      const item = document.createElement("div");
      item.className = "dash-music-item";
      const name = document.createElement("span");
      name.textContent = song;
      const c = document.createElement("span");
      c.className = "dash-music-count";
      c.textContent = count + "x";
      item.appendChild(name);
      item.appendChild(c);
      list.appendChild(item);
    }
    musicDiv.appendChild(list);
    container.appendChild(musicDiv);
  }
}

// ---------------------------------------------------------------------------
// Global analytics dashboard
// ---------------------------------------------------------------------------

async function buildGlobalDashboard() {
  const cache = await getCache() || {};
  const container = document.getElementById("globalDashboard");
  container.textContent = "";

  const allItems = [];
  const userStats = [];

  for (const [, data] of Object.entries(cache)) {
    const items = Object.values(data.items);
    if (items.length === 0) continue;
    allItems.push(...items.map(i => ({ ...i, username: data.username })));

    const deleted = items.filter(i => i.deleted).length;
    const besties = items.filter(i => i.audience === "besties").length;
    const videos = items.filter(i => i.type === "video").length;
    userStats.push({
      username: data.username,
      total: items.length,
      deleted,
      besties,
      videos,
      deletionRate: Math.round((deleted / items.length) * 100)
    });
  }

  if (allItems.length === 0) {
    container.textContent = "No data yet.";
    return;
  }

  const totalStories = allItems.length;
  const totalUsers = userStats.length;
  const totalDeleted = allItems.filter(i => i.deleted).length;
  const totalVideos = allItems.filter(i => i.type === "video").length;
  const totalBesties = allItems.filter(i => i.audience === "besties").length;
  const totalGhosted = allItems.filter(i => i.seenBlocked).length;
  const totalSeen = allItems.filter(i => i.seenSent).length;

  // Title
  const title = document.createElement("div");
  title.className = "dash-title";
  title.style.fontSize = "18px";
  title.textContent = "\uD83D\uDCCA Global Analytics";
  container.appendChild(title);

  // Global stat cards
  const grid = document.createElement("div");
  grid.className = "dash-grid";
  const gStats = [
    [totalStories, "Total stories"],
    [totalUsers, "Users tracked"],
    [totalDeleted, "Purged"],
    [totalVideos, "Videos"],
    [totalBesties, "Close friends"],
    [totalGhosted, "Ghost views"],
    [totalSeen, "Seen (receipt sent)"],
    [Math.round((totalDeleted / totalStories) * 100) + "%", "Global deletion rate"]
  ];
  for (const [value, label] of gStats) {
    const card = document.createElement("div");
    card.className = "dash-stat";
    const v = document.createElement("div");
    v.className = "dash-stat-value";
    v.textContent = value;
    const l = document.createElement("div");
    l.className = "dash-stat-label";
    l.textContent = label;
    card.appendChild(v);
    card.appendChild(l);
    grid.appendChild(card);
  }
  container.appendChild(grid);

  // Charts section
  const charts = document.createElement("div");
  charts.className = "dash-charts";

  // 1. Global posting hours
  const hours = new Array(24).fill(0);
  allItems.forEach(i => { if (i.timestamp) hours[new Date(i.timestamp * 1000).getHours()]++; });
  const hoursC = makeChartContainer("Global posting hours");
  charts.appendChild(hoursC.wrapper);
  new Chart(hoursC.canvas, {
    type: "bar",
    data: {
      labels: Array.from({ length: 24 }, (_, i) => i + "h"),
      datasets: [{ data: hours, backgroundColor: "#58a6ff", borderRadius: 3 }]
    },
    options: { ...chartDefaults, plugins: { legend: { display: false } } }
  });

  // 2. Global activity timeline
  const days = {};
  allItems.forEach(i => {
    if (!i.timestamp) return;
    const day = new Date(i.timestamp * 1000).toISOString().split("T")[0];
    days[day] = (days[day] || 0) + 1;
  });
  const sortedDays = Object.keys(days).sort();
  if (sortedDays.length > 1) {
    const timeC = makeChartContainer("Stories per day (all users)");
    charts.appendChild(timeC.wrapper);
    new Chart(timeC.canvas, {
      type: "line",
      data: {
        labels: sortedDays.map(d => d.slice(5)),
        datasets: [{
          data: sortedDays.map(d => days[d]),
          borderColor: "#58a6ff",
          backgroundColor: "#58a6ff22",
          fill: true,
          tension: 0.3,
          pointRadius: 3
        }]
      },
      options: { ...chartDefaults, plugins: { legend: { display: false } } }
    });
  }

  // 3. Seen status global
  const seenC = makeChartContainer("Seen status (global)");
  charts.appendChild(seenC.wrapper);
  new Chart(seenC.canvas, {
    type: "doughnut",
    data: {
      labels: ["Seen", "Ghost", "Auto-fetched"],
      datasets: [{
        data: [totalSeen, totalGhosted, totalStories - totalSeen - totalGhosted],
        backgroundColor: ["#d29922", "#8957e5", "#30363d"]
      }]
    },
    options: { ...chartDefaults, scales: {} }
  });

  // 4. Content type global
  const typeC = makeChartContainer("Content type (global)");
  charts.appendChild(typeC.wrapper);
  new Chart(typeC.canvas, {
    type: "doughnut",
    data: {
      labels: ["Images", "Videos"],
      datasets: [{
        data: [totalStories - totalVideos, totalVideos],
        backgroundColor: ["#58a6ff", "#3fb950"]
      }]
    },
    options: { ...chartDefaults, scales: {} }
  });

  container.appendChild(charts);

  // Leaderboard: most active posters
  const section1 = document.createElement("div");
  section1.className = "global-section";
  const s1Title = document.createElement("div");
  s1Title.className = "global-section-title";
  s1Title.textContent = "\uD83C\uDFC6 Most active posters";
  section1.appendChild(s1Title);

  const sorted = [...userStats].sort((a, b) => b.total - a.total);
  const maxTotal = sorted[0]?.total || 1;
  const table = document.createElement("table");
  table.className = "leaderboard";
  table.innerHTML = "";
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const h of ["#", "User", "Stories", "Deleted", "Videos", "Del %", ""]) {
    const th = document.createElement("th");
    th.textContent = h;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  sorted.forEach((u, i) => {
    const tr = document.createElement("tr");
    const cells = [
      i + 1,
      "@" + u.username,
      u.total,
      u.deleted,
      u.videos,
      u.deletionRate + "%"
    ];
    cells.forEach((c, j) => {
      const td = document.createElement("td");
      if (j === 0) td.className = "rank";
      td.textContent = c;
      tr.appendChild(td);
    });
    // Bar
    const barTd = document.createElement("td");
    barTd.style.width = "100px";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.width = Math.round((u.total / maxTotal) * 100) + "%";
    barTd.appendChild(bar);
    tr.appendChild(barTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  section1.appendChild(table);
  container.appendChild(section1);

  // Top music global
  const musicCounts = {};
  allItems.forEach(i => {
    if (!i.music_title) return;
    const key = i.music_title + (i.music_artist ? " - " + i.music_artist : "");
    musicCounts[key] = (musicCounts[key] || 0) + 1;
  });
  const topMusic = Object.entries(musicCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (topMusic.length > 0) {
    const section2 = document.createElement("div");
    section2.className = "global-section";
    const s2Title = document.createElement("div");
    s2Title.className = "global-section-title";
    s2Title.textContent = "\u266A Top music (all users)";
    section2.appendChild(s2Title);
    const list = document.createElement("div");
    list.className = "dash-music-list";
    for (const [song, count] of topMusic) {
      const item = document.createElement("div");
      item.className = "dash-music-item";
      const name = document.createElement("span");
      name.textContent = song;
      const c = document.createElement("span");
      c.className = "dash-music-count";
      c.textContent = count + "x";
      item.appendChild(name);
      item.appendChild(c);
      list.appendChild(item);
    }
    section2.appendChild(list);
    container.appendChild(section2);
  }

  // Highest deletion rate
  const deleters = [...userStats].filter(u => u.total >= 3).sort((a, b) => b.deletionRate - a.deletionRate);
  if (deleters.length > 0) {
    const section3 = document.createElement("div");
    section3.className = "global-section";
    const s3Title = document.createElement("div");
    s3Title.className = "global-section-title";
    s3Title.textContent = "\uD83D\uDDD1 Highest deletion rate (min 3 stories)";
    section3.appendChild(s3Title);
    const table3 = document.createElement("table");
    table3.className = "leaderboard";
    const thead3 = document.createElement("thead");
    const hr3 = document.createElement("tr");
    for (const h of ["#", "User", "Total", "Deleted", "Rate"]) {
      const th = document.createElement("th");
      th.textContent = h;
      hr3.appendChild(th);
    }
    thead3.appendChild(hr3);
    table3.appendChild(thead3);
    const tbody3 = document.createElement("tbody");
    deleters.slice(0, 10).forEach((u, i) => {
      const tr = document.createElement("tr");
      const cells = [i + 1, "@" + u.username, u.total, u.deleted, u.deletionRate + "%"];
      cells.forEach((c, j) => {
        const td = document.createElement("td");
        if (j === 0) td.className = "rank";
        td.textContent = c;
        tr.appendChild(td);
      });
      tbody3.appendChild(tr);
    });
    table3.appendChild(tbody3);
    section3.appendChild(table3);
    container.appendChild(section3);
  }
}

function makeChartContainer(title) {
  const wrapper = document.createElement("div");
  wrapper.className = "dash-chart";
  const t = document.createElement("div");
  t.className = "dash-chart-title";
  t.textContent = title;
  wrapper.appendChild(t);
  const canvas = document.createElement("canvas");
  canvas.style.maxHeight = "200px";
  wrapper.appendChild(canvas);
  return { wrapper, canvas };
}
