// IG Story Research - Background Script
// Blocks SeenMutation, caches stories, auto-fetches, downloads media

const SEEN_MUTATION = "PolarisStoriesV3SeenMutation";
const STORY_QUERIES = [
  "PolarisStoriesV3ReelPageGalleryQuery",
  "PolarisStoriesV3ReelPageGalleryPaginationQuery"
];
const AUTO_FETCH_DELAY = 300;
const GALLERY_DOC_ID_FALLBACK = "25869747379387218";

// Settings (persisted via storage.local)
let settings = {
  blockSeen: true,
  autoFetch: true,
  autoDownload: true,
  fetchInterval: 300
};

// Load settings on startup
browser.storage.local.get("settings").then(result => {
  if (result.settings) settings = { ...settings, ...result.settings };
  console.log("[IG] Settings loaded:", settings);
});

// State
let storyCache = {};
let blockedCount = 0;
const capturedDocIds = {};
let allReelIds = [];
let lastQueryBody = null;
let lastQueryHeaders = {};
let lastPaginationBody = null;
let autoFetchInterval = null;
let pendingTrayIds = null;
let autoFetchRetries = 0;
let isFetchingPages = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodeBody(requestBody) {
  if (!requestBody) return null;
  if (requestBody.formData) {
    const parts = [];
    for (const [key, values] of Object.entries(requestBody.formData)) {
      for (const val of values) parts.push(key + "=" + val);
    }
    return parts.join("&");
  }
  if (requestBody.raw) {
    const decoder = new TextDecoder("utf-8");
    return requestBody.raw.map(r => decoder.decode(r.bytes)).join("");
  }
  return null;
}

function mergeChunks(chunks) {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8").decode(merged);
}

function buildHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-CSRFToken": lastQueryHeaders["X-CSRFToken"] || "",
    "X-IG-App-ID": lastQueryHeaders["X-IG-App-ID"] || "936619743392459",
    "X-FB-LSD": lastQueryHeaders["X-FB-LSD"] || ""
  };
}

function galleryDocId() {
  return capturedDocIds["PolarisStoriesV3ReelPageGalleryQuery"] || GALLERY_DOC_ID_FALLBACK;
}

function cacheStats() {
  const users = Object.keys(storyCache).length;
  const stories = Object.values(storyCache).reduce((a, u) => a + Object.keys(u.items).length, 0);
  return { users, stories };
}

function exportCSV() {
  const rows = ["username,media_id,code,type,timestamp,posted_at,expires_at,cached_at,music_title,music_artist,caption,audience,viewer_count,file_path,deleted,deleted_at"];

  for (const [, data] of Object.entries(storyCache)) {
    for (const [, item] of Object.entries(data.items)) {
      const date = item.timestamp ? new Date(item.timestamp * 1000).toISOString().split("T")[0] : "unknown";
      const postedAt = item.timestamp ? new Date(item.timestamp * 1000).toISOString() : "";
      const expiresAt = item.expiring_at ? new Date(item.expiring_at * 1000).toISOString() : "";
      const cachedAt = item.cached_at ? new Date(item.cached_at).toISOString() : "";
      const ext = item.type === "video" ? "mp4" : "jpg";
      const filePath = "ig_stories/" + data.username + "/" + date + "_" + item.id + "." + ext;
      const deletedAt = item.deleted_at ? new Date(item.deleted_at).toISOString() : "";

      const escape = (s) => s ? '"' + String(s).replace(/"/g, '""').replace(/\n/g, " ") + '"' : "";

      rows.push([
        data.username,
        item.id,
        item.code || "",
        item.type,
        item.timestamp || "",
        postedAt,
        expiresAt,
        cachedAt,
        escape(item.music_title),
        escape(item.music_artist),
        escape(item.caption),
        item.audience || "",
        item.viewer_count || "",
        filePath,
        item.deleted || false,
        deletedAt
      ].join(","));
    }
  }

  const csv = rows.join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);

  browser.downloads.download({
    url,
    filename: "ig_stories/history.csv",
    saveAs: false,
    conflictAction: "uniquify"
  }).then(() => {
    console.log("[IG] CSV exported:", rows.length - 1, "entries");
    URL.revokeObjectURL(url);
  }).catch(_ => {});
}

function downloadMedia(username, mediaId, url, ext) {
  const date = new Date().toISOString().split("T")[0];
  const filename = "ig_stories/" + username + "/" + date + "_" + mediaId + "." + ext;
  browser.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" })
    .then(() => console.log("[IG] Downloaded:", filename))
    .catch(e => console.error("[IG] Download failed:", username, e.message));
}

// ---------------------------------------------------------------------------
// Request interceptor
// ---------------------------------------------------------------------------

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "POST") return;
    const body = decodeBody(details.requestBody);
    if (!body) return;

    // Capture doc_ids and query names
    const fnMatch = body.match(/fb_api_req_friendly_name=([^&]+)/);
    const docMatch = body.match(/doc_id=(\d+)/);
    if (fnMatch && docMatch) capturedDocIds[fnMatch[1]] = docMatch[1];

    // Block seen mutation (if enabled)
    if (settings.blockSeen && body.includes(SEEN_MUTATION)) {
      blockedCount++;
      console.log("[IG] Blocked SeenMutation #" + blockedCount);
      return { cancel: true };
    }

    // Capture pagination template
    if (body.includes("PolarisStoriesV3ReelPageGalleryPaginationQuery")) {
      lastPaginationBody = body;
    }

    // Capture gallery query for auto-fetch replay
    if (body.includes("PolarisStoriesV3ReelPageGalleryQuery") && !lastQueryBody) {
      lastQueryBody = body;
      console.log("[IG] Captured GalleryQuery for replay");
      startAutoFetch();
    }

    // Intercept story responses via StreamFilter
    if (STORY_QUERIES.some(q => body.includes(q))) {
      console.log("[IG] Story query detected, capturing response...");
      const filter = browser.webRequest.filterResponseData(details.requestId);
      const chunks = [];
      filter.ondata = (event) => { chunks.push(new Uint8Array(event.data)); filter.write(event.data); };
      filter.onstop = () => {
        filter.close();
        try { processStoryData(JSON.parse(mergeChunks(chunks))); }
        catch (e) { console.error("[IG] Parse error:", e.message?.substring(0, 100)); }
      };
      filter.onerror = () => { try { filter.close(); } catch(_) {} };
    }
  },
  { urls: ["https://www.instagram.com/graphql/query*"] },
  ["blocking", "requestBody"]
);

// Capture headers from any GraphQL call
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.method !== "POST") return;
    const headers = {};
    for (const h of details.requestHeaders) headers[h.name] = h.value;
    lastQueryHeaders = headers;
  },
  { urls: ["https://www.instagram.com/graphql/query*"] },
  ["requestHeaders"]
);

// ---------------------------------------------------------------------------
// Story data processing
// ---------------------------------------------------------------------------

function processStoryData(data) {
  const reels = [];
  function walk(obj) {
    if (!obj || typeof obj !== "object") return;
    if ((obj.reel_type || obj.__typename === "GraphReel") && (obj.items || obj.user)) reels.push(obj);
    if (obj.reel_ids && Array.isArray(obj.reel_ids)) {
      allReelIds = [...new Set([...allReelIds, ...obj.reel_ids])];
    }
    if (Array.isArray(obj)) obj.forEach(walk);
    else Object.values(obj).forEach(walk);
  }
  walk(data);

  if (reels.length === 0) return;

  const now = Date.now();
  for (const reel of reels) {
    const userId = reel.id || reel.user?.id;
    const username = reel.user?.username || reel.owner?.username || "unknown";
    if (!userId) continue;
    if (!storyCache[userId]) storyCache[userId] = { username, items: {} };
    storyCache[userId].username = username;

    for (const item of (reel.items || reel.media || [])) {
      const mediaId = item.id || item.pk;
      if (!mediaId || storyCache[userId].items[mediaId]) continue;

      let url = null;
      if (item.video_versions?.length) url = item.video_versions[0].url;
      else if (item.image_versions2?.candidates?.length) url = item.image_versions2.candidates[0].url;
      else if (item.display_url) url = item.display_url;

      const music = item.story_music_stickers?.[0]?.music_asset_info;
      const isVideo = !!(item.has_audio || item.video_versions?.length);

      if (url && settings.autoDownload) downloadMedia(username, mediaId, url, isVideo ? "mp4" : "jpg");

      storyCache[userId].items[mediaId] = {
        id: mediaId, code: item.code || null, url,
        timestamp: item.taken_at || item.taken_at_timestamp,
        expiring_at: item.expiring_at || null,
        cached_at: now,
        type: isVideo ? "video" : "image",
        width: item.original_width || null,
        height: item.original_height || null,
        caption: item.caption?.text || item.caption || null,
        music_title: music?.title || null,
        music_artist: music?.display_artist || null,
        audience: item.audience || null,
        viewer_count: item.viewer_count || null,
        viewers: item.viewers || null,
        deleted: false
      };
    }
  }

  // Trigger pagination for missing users
  const cachedIds = new Set(Object.keys(storyCache));
  const missing = allReelIds.filter(id => !cachedIds.has(String(id)));
  if (missing.length > 0 && lastPaginationBody) fetchMissingReels(missing);

  const s = cacheStats();
  console.log("[IG] Cached " + reels.length + " reels | " + s.users + " users | " + s.stories + " stories");
  exportCSV();
}

// ---------------------------------------------------------------------------
// Auto-fetch and pagination
// ---------------------------------------------------------------------------

function tryAutoFetch() {
  if (!pendingTrayIds?.length) return;
  if (!lastQueryHeaders["Cookie"]) {
    if (++autoFetchRetries > 10) return console.log("[IG] Gave up waiting for headers");
    console.log("[IG] Waiting for headers... retry", autoFetchRetries);
    return setTimeout(tryAutoFetch, 2000);
  }
  console.log("[IG] Headers ready, firing auto GalleryQuery");
  buildAndFireGalleryQuery(pendingTrayIds);
  pendingTrayIds = null;
  autoFetchRetries = 0;
}

async function buildAndFireGalleryQuery(trayIds) {
  console.log("[IG] Building GalleryQuery for", trayIds.length, "users");
  const params = new URLSearchParams();
  params.set("fb_api_req_friendly_name", "PolarisStoriesV3ReelPageGalleryQuery");
  params.set("variables", JSON.stringify({ initial_reel_id: trayIds[0], reel_ids: trayIds, first: 3 }));
  params.set("doc_id", galleryDocId());

  try {
    const data = await (await fetch("https://www.instagram.com/graphql/query", {
      method: "POST", headers: buildHeaders(), body: params.toString(), credentials: "include"
    })).json();
    processStoryData(data);
    lastQueryBody = params.toString();
    startAutoFetch();
    console.log("[IG] Auto GalleryQuery complete");
  } catch (e) {
    console.error("[IG] Auto GalleryQuery failed:", e);
  }
}

async function fetchMissingReels(missingIds) {
  if (isFetchingPages || !lastPaginationBody || !lastQueryHeaders["Cookie"]) return;
  isFetchingPages = true;
  let cursor = missingIds[0];
  let page = 0;

  while (cursor) {
    page++;
    try {
      const body = lastPaginationBody.replace(/"after":"[^"]*"/, '"after":"' + cursor + '"');
      const data = await (await fetch("https://www.instagram.com/graphql/query", {
        method: "POST", headers: buildHeaders(), body, credentials: "include"
      })).json();

      let hasNext = false, nextCursor = null;
      (function find(obj) {
        if (!obj || typeof obj !== "object") return;
        if (obj.has_next_page !== undefined) { hasNext = obj.has_next_page; nextCursor = obj.end_cursor; return; }
        if (Array.isArray(obj)) obj.forEach(find); else Object.values(obj).forEach(find);
      })(data);

      processStoryData(data);
      const s = cacheStats();
      console.log("[IG] Page", page, "| hasNext:", hasNext, "|", s.users, "users,", s.stories, "stories");
      cursor = hasNext && nextCursor ? nextCursor : null;
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.error("[IG] Pagination failed:", e);
      break;
    }
  }
  isFetchingPages = false;
}

function startAutoFetch() {
  if (autoFetchInterval) return;
  if (!settings.autoFetch) return;
  const delay = settings.fetchInterval || AUTO_FETCH_DELAY;
  autoFetchInterval = setInterval(async () => {
    if (!settings.autoFetch || !lastQueryBody || !lastQueryHeaders["Cookie"]) return;
    console.log("[IG] Auto-fetch: replaying GalleryQuery...");
    try {
      const data = await (await fetch("https://www.instagram.com/graphql/query", {
        method: "POST", headers: buildHeaders(), body: lastQueryBody, credentials: "include"
      })).json();
      processStoryData(data);
      console.log("[IG] Auto-fetch complete");
    } catch (e) {
      console.error("[IG] Auto-fetch failed:", e);
    }
  }, delay * 1000);
  console.log("[IG] Auto-fetch started, interval:", delay + "s");
}

function restartAutoFetch() {
  if (autoFetchInterval) { clearInterval(autoFetchInterval); autoFetchInterval = null; }
  if (settings.autoFetch) startAutoFetch();
}

// ---------------------------------------------------------------------------
// Doc ID extraction from JS bundles
// ---------------------------------------------------------------------------

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const chunks = [];
    filter.ondata = (event) => { chunks.push(new Uint8Array(event.data)); filter.write(event.data); };
    filter.onstop = () => {
      filter.close();
      const text = mergeChunks(chunks);
      const re = /__d\("(\w+)_instagramRelayOperation",[^)]*\(function\([^)]*\)\{[^}]*\.exports="(\d+)"/g;
      let m, found = 0;
      while ((m = re.exec(text)) !== null) { capturedDocIds[m[1]] = m[2]; found++; }
      if (found > 0) console.log("[IG] Extracted", found, "doc_ids from bundle");
    };
    filter.onerror = () => { try { filter.close(); } catch(_) {} };
  },
  { urls: ["https://static.cdninstagram.com/rsrc.php/*"], types: ["script"] },
  ["blocking"]
);

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getCache") sendResponse({ cache: storyCache });
  if (msg.type === "getStats") sendResponse({ blockedCount, ...cacheStats() });
  if (msg.type === "trayUserIds") {
    const ids = msg.users.map(u => u.id);
    console.log("[IG] Got", ids.length, "tray user IDs from content script");
    allReelIds = [...new Set([...allReelIds, ...ids])];
    pendingTrayIds = ids;
    tryAutoFetch();
    sendResponse({ ok: true });
  }
  if (msg.type === "triggerFetch") {
    console.log("[IG] Manual fetch triggered");
    if (allReelIds.length > 0) buildAndFireGalleryQuery(allReelIds);
    sendResponse({ ok: true });
  }
  if (msg.type === "clearCache") { storyCache = {}; sendResponse({ ok: true }); }
  if (msg.type === "getSettings") sendResponse(settings);
  if (msg.type === "saveSettings") {
    settings = { ...settings, ...msg.settings };
    browser.storage.local.set({ settings });
    restartAutoFetch();
    console.log("[IG] Settings saved:", settings);
    sendResponse({ ok: true });
  }
  return true;
});

console.log("[IG] Background loaded");
