// Stories browser - full tab view

async function getCache() {
  try {
    return (await browser.runtime.sendMessage({ type: "getCache" }))?.cache || null;
  } catch(_) { return null; }
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() / 1000) - ts);
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
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
  const cache = await getCache();
  const el = document.getElementById("content");
  el.textContent = "";

  if (!cache || Object.keys(cache).length === 0) {
    el.appendChild(Object.assign(document.createElement("div"), {
      className: "empty", textContent: "No stories cached. Open Instagram and click Refresh in the extension popup."
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
    .sort((a, b) => b.latest - a.latest);

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
    section.appendChild(header);

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
      const video = document.createElement("video");
      video.src = item.url;
      video.muted = true;
      video.preload = "metadata";
      video.addEventListener("loadeddata", () => { video.currentTime = 0.5; });
      video.onerror = () => { video.remove(); preview.textContent = "\u25B6"; };
      preview.appendChild(video);

      const overlay = document.createElement("div");
      overlay.className = "play-overlay";
      overlay.textContent = "\u25B6";
      preview.appendChild(overlay);
    } else {
      const img = document.createElement("img");
      img.src = item.url;
      img.loading = "lazy";
      img.onerror = () => { img.remove(); preview.textContent = "\uD83D\uDCF7"; };
      preview.appendChild(img);
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
  typeBadge.textContent = item.type === "video" ? "VID" : "IMG";
  top.appendChild(typeBadge);

  // Close friends badge
  if (item.audience === "besties") {
    const bestie = document.createElement("span");
    bestie.className = "badge badge-bestie";
    bestie.textContent = "\u2605 BESTIE";
    top.appendChild(bestie);
  }

  // Seen status
  if (item.seenSent) {
    const seen = document.createElement("span");
    seen.className = "badge badge-seen";
    seen.textContent = "\u2713 SEEN";
    seen.title = "Seen receipt was sent to Instagram";
    top.appendChild(seen);
  } else if (item.seenBlocked) {
    const ghost = document.createElement("span");
    ghost.className = "badge badge-ghost";
    ghost.textContent = "\u2B24 GHOST";
    ghost.title = "Viewed invisibly - seen receipt was blocked";
    top.appendChild(ghost);
  }

  if (item.deleted) {
    const del = document.createElement("span");
    del.className = "badge badge-deleted";
    del.textContent = "DELETED";
    top.appendChild(del);
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
    openCDN.textContent = "Open CDN";
    openCDN.title = "Open from Instagram CDN (may be expired)";
    actions.appendChild(openCDN);
  }

  const openLocal = document.createElement("button");
  openLocal.textContent = "Open local";
  openLocal.title = "Open downloaded file";
  openLocal.addEventListener("click", async () => {
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
