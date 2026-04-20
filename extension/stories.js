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
      const card = document.createElement("div");
      card.className = "story-card" + (item.deleted ? " deleted" : "");

      // Preview
      const preview = document.createElement("div");
      preview.className = "story-preview";

      const localPath = getLocalPath(data.username, item);

      if (item.url) {
        if (item.type === "video") {
          preview.textContent = "▶";
        } else {
          // Try to show from CDN (may be expired)
          const img = document.createElement("img");
          img.src = item.url;
          img.loading = "lazy";
          img.onerror = () => { img.remove(); preview.textContent = "📷"; };
          preview.appendChild(img);
        }
      } else {
        preview.textContent = item.type === "video" ? "▶" : "📷";
      }

      preview.addEventListener("click", () => openLightbox(item));
      card.appendChild(preview);

      // Meta
      const meta = document.createElement("div");
      meta.className = "story-meta";

      const row1 = document.createElement("div");
      row1.className = "story-meta-row";

      const typeBadge = document.createElement("span");
      typeBadge.className = "story-type " + (item.type || "image");
      typeBadge.textContent = item.type === "video" ? "VID" : "IMG";
      row1.appendChild(typeBadge);

      if (item.deleted) {
        const del = document.createElement("span");
        del.className = "story-deleted";
        del.textContent = "DELETED";
        row1.appendChild(del);
      }

      if (item.timestamp) {
        const time = document.createElement("span");
        time.className = "story-time";
        time.textContent = timeAgo(item.timestamp);
        time.title = new Date(item.timestamp * 1000).toLocaleString();
        row1.appendChild(time);
      }
      meta.appendChild(row1);

      if (item.music_title) {
        const music = document.createElement("div");
        music.className = "story-music";
        music.textContent = "\u266A " + item.music_title + (item.music_artist ? " - " + item.music_artist : "");
        meta.appendChild(music);
      }

      if (item.caption) {
        const cap = document.createElement("div");
        cap.className = "story-caption";
        cap.textContent = item.caption;
        cap.title = item.caption;
        meta.appendChild(cap);
      }

      // Actions
      const actions = document.createElement("div");
      actions.className = "story-actions";

      if (item.url) {
        const openCDN = document.createElement("a");
        openCDN.href = item.url;
        openCDN.target = "_blank";
        openCDN.textContent = "CDN";
        openCDN.title = "Open from Instagram CDN (may be expired)";
        actions.appendChild(openCDN);
      }

      const openLocal = document.createElement("a");
      openLocal.href = "#";
      openLocal.textContent = "Local";
      openLocal.title = "Open downloaded file";
      openLocal.addEventListener("click", async (e) => {
        e.preventDefault();
        const dl = await findDownload(localPath);
        if (dl) {
          browser.downloads.open(dl.id).catch(() => {
            browser.downloads.show(dl.id);
          });
        }
      });
      actions.appendChild(openLocal);

      meta.appendChild(actions);
      card.appendChild(meta);
      grid.appendChild(card);
    }

    section.appendChild(grid);
    el.appendChild(section);
  }

  document.getElementById("totalCount").textContent = total + " stories from " + users.length + " users";
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------

function openLightbox(item) {
  const lb = document.getElementById("lightbox");
  const content = document.getElementById("lightboxContent");
  content.textContent = "";

  if (item.url) {
    if (item.type === "video") {
      const video = document.createElement("video");
      video.src = item.url;
      video.controls = true;
      video.autoplay = true;
      content.appendChild(video);
    } else {
      const img = document.createElement("img");
      img.src = item.url;
      content.appendChild(img);
    }
  }
  lb.classList.add("active");
}

document.getElementById("closeLightbox").addEventListener("click", () => {
  document.getElementById("lightbox").classList.remove("active");
  const content = document.getElementById("lightboxContent");
  const video = content.querySelector("video");
  if (video) video.pause();
  content.textContent = "";
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

render();
