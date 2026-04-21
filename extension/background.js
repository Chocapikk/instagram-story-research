// IG Story Research - Background Script
// Blocks SeenMutation, caches stories, auto-fetches, downloads media

const SEEN_MUTATION = "PolarisStoriesV3SeenMutation";
// Only block the validation (sends "seen" to the other person)
// Let MarkThreadAsRead through so our own UI marks it as read locally
const DM_READ_MUTATIONS = [
  "useIGDMarkThreadAsReadValidationMutation"
];
const STORY_QUERIES = [
  "PolarisStoriesV3ReelPageGalleryQuery",
  "PolarisStoriesV3ReelPageGalleryPaginationQuery"
];
const AUTO_FETCH_DELAY = 300;
const GALLERY_DOC_ID_FALLBACK = "25869747379387218";

// Settings (persisted via storage.local)
let settings = {
  blockSeen: true,
  blockDMRead: true,
  blockTyping: true,
  blockPresence: false,
  autoFetch: true,
  autoDownload: true,
  fetchInterval: 300
};

// Load settings on startup
browser.storage.local.get("settings").then(result => {
  if (result.settings) settings = { ...settings, ...result.settings };
  bglog("Settings loaded: " + JSON.stringify(settings));
});

// Debug log buffer (shared with popup)
const bgLog = [];
function bglog(...args) {
  const msg = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
  const ts = new Date().toLocaleTimeString();
  const line = "[" + ts + "] [BG] " + msg;
  bgLog.push(line);
  if (bgLog.length > 200) bgLog.shift();
  console.log("[IG]", msg);
  // Push to popup in real-time
  browser.runtime.sendMessage({ type: "logUpdate", line }).catch(_ => {});
}

function pushStats() {
  const s = cacheStats();
  browser.runtime.sendMessage({ type: "statsUpdate", blockedCount, ...s }).catch(_ => {});
}

// State
let storyCache = {};
const freshItemIds = new Map(); // userId -> Set of mediaIds seen from server in current fetch cycle
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

// Persistent seen history: { mediaId: { seenSent, seenBlocked, username, timestamp } }
// Survives cache clear, allows restoring seen status on expired stories
let seenHistory = {};

// Restore persisted state on startup
browser.storage.local.get(["reelIds", "storyCache", "seenHistory"]).then(result => {
  if (result.reelIds?.length) {
    allReelIds = result.reelIds;
    bglog("Restored", allReelIds.length, "reel IDs from storage");
  }
  if (result.storyCache && Object.keys(result.storyCache).length) {
    storyCache = result.storyCache;
    bglog("Restored", Object.keys(storyCache).length, "users from storage");
  }
  if (result.seenHistory && Object.keys(result.seenHistory).length) {
    seenHistory = result.seenHistory;
    bglog("Restored", Object.keys(seenHistory).length, "seen history entries");
  }
});

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
  const rows = ["username,media_id,code,type,timestamp,posted_at,expires_at,cached_at,music_title,music_artist,caption,audience,viewer_count,file_path,deleted,deleted_at,seen_sent,seen_blocked,cdn_url"];

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
        deletedAt,
        item.seenSent || false,
        item.seenBlocked || false,
        escape(item.url)
      ].join(","));
    }
  }

  const csv = rows.join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);

  // Remove ALL previous CSV downloads (entries + files) then write fresh
  browser.downloads.search({ query: ["history"] }).then(async (results) => {
    for (const r of results) {
      if (r.filename && r.filename.includes("history")) {
        try { await browser.downloads.removeFile(r.id); } catch(_) {}
        try { await browser.downloads.erase({ id: r.id }); } catch(_) {}
      }
    }
    // Write new CSV after cleanup
    browser.downloads.download({
      url,
      filename: "ig_stories/history.csv",
      saveAs: false,
      conflictAction: "overwrite"
    }).then(() => {
      bglog("CSV exported:", rows.length - 1, "entries");
      URL.revokeObjectURL(url);
    }).catch(_ => {});
  }).catch(_ => {});
}

function downloadMedia(username, mediaId, url, ext) {
  const date = new Date().toISOString().split("T")[0];
  const filename = "ig_stories/" + username + "/" + date + "_" + mediaId + "." + ext;
  browser.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" })
    .then(() => bglog("Downloaded:", filename))
    .catch(e => bglog("ERROR: Download failed:", username, e.message));
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

    // Block story seen mutation (if enabled)
    if (body.includes(SEEN_MUTATION)) {
      // Extract reel ID from mutation body
      let reelId = null;
      try {
        const vars = body.match(/variables=([^&]+)/);
        if (vars) {
          const parsed = JSON.parse(decodeURIComponent(vars[1]));
          reelId = parsed.reel_id || parsed.reelId;
        }
      } catch(_) {}

      if (settings.blockSeen) {
        if (reelId && storyCache[reelId]) {
          const username = storyCache[reelId].username;
          for (const [id, item] of Object.entries(storyCache[reelId].items)) {
            item.seenBlocked = true;
            seenHistory[id] = { seenSent: false, seenBlocked: true, username, timestamp: item.timestamp };
          }
          browser.storage.local.set({ storyCache, seenHistory });
        }
        blockedCount++;
        bglog("Blocked StorySeen #" + blockedCount, reelId ? "(reel " + reelId + ")" : "");
        pushStats();
        return { cancel: true };
      }
      // Seen not blocked - mark stories as seen (vu lâché)
      if (reelId && storyCache[reelId]) {
        const username = storyCache[reelId].username;
        for (const [id, item] of Object.entries(storyCache[reelId].items)) {
          item.seenSent = true;
          seenHistory[id] = { seenSent: true, seenBlocked: false, username, timestamp: item.timestamp };
        }
        browser.storage.local.set({ storyCache, seenHistory });
        bglog("Seen sent for reel", reelId);
      }
    }

    // Block DM read validation (backup - also checked in onBeforeSendHeaders via header)
    if (settings.blockDMRead && DM_READ_MUTATIONS.some(m => body.includes(m))) {
      blockedCount++;
      bglog("Blocked DMRead #" + blockedCount + " (via body)");
      pushStats();
      return { cancel: true };
    }

    // Capture pagination template
    if (body.includes("PolarisStoriesV3ReelPageGalleryPaginationQuery")) {
      lastPaginationBody = body;
    }

    // Capture gallery query for auto-fetch replay
    if (body.includes("PolarisStoriesV3ReelPageGalleryQuery") && !lastQueryBody) {
      lastQueryBody = body;
      bglog("Captured GalleryQuery for replay");
      startAutoFetch();
    }

    // Intercept story responses via StreamFilter
    if (STORY_QUERIES.some(q => body.includes(q))) {
      bglog("Story query detected, capturing response...");
      const filter = browser.webRequest.filterResponseData(details.requestId);
      const chunks = [];
      filter.ondata = (event) => { chunks.push(new Uint8Array(event.data)); filter.write(event.data); };
      filter.onstop = () => {
        filter.close();
        try { processStoryData(JSON.parse(mergeChunks(chunks))); }
        catch (e) { bglog("ERROR: Parse error:", e.message?.substring(0, 100)); }
      };
      filter.onerror = () => { try { filter.close(); } catch(_) {} };
    }
  },
  { urls: ["https://www.instagram.com/graphql/query*", "https://www.instagram.com/api/graphql*"] },
  ["blocking", "requestBody"]
);

// Capture headers + block DM read via header inspection
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.method !== "POST") return;
    const headers = {};
    for (const h of details.requestHeaders) headers[h.name] = h.value;
    lastQueryHeaders = headers;

    // Block DM read validation via header
    const friendlyName = headers["X-FB-Friendly-Name"] || "";
    if (friendlyName) bglog("[HDR] " + friendlyName + " from=" + (details.originUrl || "?").substring(0, 60) + " tabId=" + details.tabId);
    if (settings.blockDMRead && friendlyName.includes("MarkThreadAsRead")) {
      blockedCount++;
      bglog("Blocked DMRead #" + blockedCount + " (" + friendlyName + ")");
      pushStats();
      return { cancel: true };
    }
  },
  { urls: ["https://www.instagram.com/graphql/query*", "https://www.instagram.com/api/graphql*"] },
  ["blocking", "requestHeaders"]
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

    // The reel's "seen" field is a timestamp of the last story we reported as seen
    // Check both the reel data and the tray seen timestamps
    const reelSeen = reel.seen || reel.seen_at || traySeenTimestamps[String(userId)] || 0;

    for (const item of (reel.items || reel.media || [])) {
      const mediaId = item.id || item.pk;
      if (!mediaId) continue;

      // Track fresh item IDs from server for purge detection
      if (!freshItemIds.has(String(userId))) freshItemIds.set(String(userId), new Set());
      freshItemIds.get(String(userId)).add(String(mediaId));

      // Update seen status on existing cached items
      if (storyCache[userId].items[mediaId]) {
        const existing = storyCache[userId].items[mediaId];
        const takenAt = existing.timestamp || 0;
        if (!existing.seenSent && reelSeen > 0 && takenAt > 0 && reelSeen >= takenAt) {
          existing.seenSent = true;
          seenHistory[mediaId] = { seenSent: true, seenBlocked: existing.seenBlocked, username, timestamp: takenAt };
        }
        continue;
      }

      let url = null;
      if (item.video_versions?.length) url = item.video_versions[0].url;
      else if (item.image_versions2?.candidates?.length) url = item.image_versions2.candidates[0].url;
      else if (item.display_url) url = item.display_url;

      const music = item.story_music_stickers?.[0]?.music_asset_info;
      const isVideo = !!(item.has_audio || item.video_versions?.length);
      const takenAt = item.taken_at || item.taken_at_timestamp || 0;

      // Check seen status: first from seenHistory, then from reel timestamp
      const histEntry = seenHistory[mediaId];
      const alreadySeen = (histEntry?.seenSent) || (reelSeen > 0 && takenAt > 0 && reelSeen >= takenAt);
      const wasBlocked = histEntry?.seenBlocked || false;

      if (url && settings.autoDownload) downloadMedia(username, mediaId, url, isVideo ? "mp4" : "jpg");

      storyCache[userId].items[mediaId] = {
        id: mediaId, code: item.code || null, url,
        timestamp: takenAt,
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
        deleted: false,
        seenBlocked: wasBlocked,
        seenSent: alreadySeen
      };
    }
  }



  // Trigger pagination for missing users
  const cachedIds = new Set(Object.keys(storyCache));
  const missing = allReelIds.filter(id => !cachedIds.has(String(id)));
  if (missing.length > 0 && lastPaginationBody) fetchMissingReels(missing);

  const s = cacheStats();
  bglog("Cached " + reels.length + " reels | " + s.users + " users | " + s.stories + " stories");
  browser.storage.local.set({ storyCache, reelIds: allReelIds });
  exportCSV();
}

// ---------------------------------------------------------------------------
// Auto-fetch and pagination
// ---------------------------------------------------------------------------

function tryAutoFetch() {
  if (!pendingTrayIds?.length) return;
  if (!lastQueryHeaders["Cookie"]) {
    if (++autoFetchRetries > 10) return bglog("Gave up waiting for headers");
    bglog("Waiting for headers... retry", autoFetchRetries);
    return setTimeout(tryAutoFetch, 2000);
  }
  bglog("Headers ready, firing auto GalleryQuery");
  buildAndFireGalleryQuery(pendingTrayIds);
  pendingTrayIds = null;
  autoFetchRetries = 0;
}


async function ensureHeaders() {
  if (lastQueryHeaders["X-CSRFToken"]) return;
  bglog("No CSRF token yet, extracting from Instagram tab...");
  try {
    const tabs = await browser.tabs.query({ url: "https://www.instagram.com/*" });
    if (tabs.length > 0) {
      const resp = await browser.tabs.sendMessage(tabs[0].id, { type: "extractHeaders" });
      if (resp?.csrf) {
        lastQueryHeaders["X-CSRFToken"] = resp.csrf;
        if (resp.lsd) lastQueryHeaders["X-FB-LSD"] = resp.lsd;
        bglog("Got CSRF from content script");
      }
    }
  } catch(_) {}
}

// Stores seen timestamps per reel from the tray API
let traySeenTimestamps = {};

async function fetchFullTray() {
  await ensureHeaders();
  try {
    const resp = await fetch("https://www.instagram.com/api/v1/feed/reels_tray/", {
      method: "GET",
      headers: {
        "X-CSRFToken": lastQueryHeaders["X-CSRFToken"] || "",
        "X-IG-App-ID": lastQueryHeaders["X-IG-App-ID"] || "936619743392459",
        "X-Requested-With": "XMLHttpRequest"
      },
      credentials: "include"
    });
    const data = await resp.json();
    if (data.tray) {
      const ids = [];
      for (const reel of data.tray) {
        const id = reel.id || reel.user?.pk || reel.user?.id;
        const username = reel.user?.username;
        if (id && username) {
          ids.push({ id: String(id), username });
          // Capture seen timestamp from tray
          const seen = reel.seen || reel.seen_at || 0;
          const latestMedia = reel.latest_reel_media || 0;
          if (seen > 0) {
            traySeenTimestamps[String(id)] = seen;
          }
          bglog("Tray:", username, "| seen:", seen, "| latest:", latestMedia, "| unseen:", seen < latestMedia);
        }
      }
      bglog("Tray API returned", ids.length, "users,", Object.keys(traySeenTimestamps).length, "with seen data");
      return ids;
    }
  } catch (e) {
    bglog("ERROR: Tray fetch failed:", e.message || e);
  }
  return [];
}

async function buildAndFireGalleryQuery(trayIds) {
  // First, try to get the full tray from the API
  const trayUsers = await fetchFullTray();
  if (trayUsers.length > 0) {
    const newIds = trayUsers.map(u => u.id);
    const merged = [...new Set([...trayIds, ...newIds])];
    if (merged.length > trayIds.length) {
      bglog("Merged tray IDs:", trayIds.length, "->", merged.length);
      trayIds = merged;
      allReelIds = merged;
      browser.storage.local.set({ reelIds: allReelIds });
    }

    // Purge detection: users in cache but NOT in tray with non-expired items
    const trayIdSet = new Set(newIds.map(String));
    const nowPurge = Math.floor(Date.now() / 1000);
    let trayPurgeCount = 0;
    for (const [userId, userData] of Object.entries(storyCache)) {
      if (trayIdSet.has(String(userId))) continue;
      for (const [mediaId, item] of Object.entries(userData.items)) {
        if (item.deleted) continue;
        if (item.expiring_at && nowPurge < item.expiring_at) {
          item.deleted = true;
          item.deleted_at = Date.now();
          trayPurgeCount++;
          bglog("PURGED (not in tray): " + userData.username + " / " + mediaId + " (" + Math.round((item.expiring_at - nowPurge) / 60) + "min left)");
        }
      }
    }
    if (trayPurgeCount > 0) {
      bglog("Tray purge: " + trayPurgeCount + " stories marked");
      browser.storage.local.set({ storyCache });
      exportCSV();
    }
  }

  bglog("Building GalleryQuery for", trayIds.length, "users");
  await ensureHeaders();

  let after = null;
  let page = 0;
  const pageSize = 12;

  while (true) {
    page++;
    const vars = { initial_reel_id: trayIds[0], reel_ids: trayIds, first: pageSize };
    if (after) vars.after = after;

    const params = new URLSearchParams();
    params.set("fb_api_req_friendly_name", "PolarisStoriesV3ReelPageGalleryQuery");
    params.set("variables", JSON.stringify(vars));
    params.set("doc_id", galleryDocId());

    try {
      const resp = await fetch("https://www.instagram.com/graphql/query", {
        method: "POST", headers: buildHeaders(), body: params.toString(), credentials: "include"
      });
      const text = await resp.text();
      const data = JSON.parse(text);
      processStoryData(data);

      if (page === 1) {
        lastQueryBody = params.toString();
        startAutoFetch();
      }

      // Find pagination info
      let hasNext = false, nextCursor = null;
      (function find(obj) {
        if (!obj || typeof obj !== "object") return;
        if (obj.has_next_page !== undefined) { hasNext = obj.has_next_page; nextCursor = obj.end_cursor; return; }
        if (Array.isArray(obj)) obj.forEach(find); else Object.values(obj).forEach(find);
      })(data);

      const s = cacheStats();
      bglog("Page", page, "| users:", s.users, "| stories:", s.stories, "| hasNext:", hasNext);

      if (!hasNext || !nextCursor) break;
      after = nextCursor;
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      bglog("ERROR: GalleryQuery page", page, "failed:", e.message || e);
      break;
    }
  }

  bglog("GalleryQuery complete -", page, "pages fetched");

  // Purge detection: compare freshItemIds (accumulated across all pages) against cache
  const nowSec = Math.floor(Date.now() / 1000);
  let purgeCount = 0;
  for (const [userId, userData] of Object.entries(storyCache)) {
    const userFresh = freshItemIds.get(String(userId));
    if (!userFresh || userFresh.size === 0) continue; // user wasn't in this fetch cycle
    for (const [mediaId, item] of Object.entries(userData.items)) {
      if (item.deleted) continue;
      if (userFresh.has(String(mediaId))) continue;
      if (item.expiring_at && nowSec < item.expiring_at) {
        item.deleted = true;
        item.deleted_at = Date.now();
        purgeCount++;
        bglog("PURGED: " + userData.username + " / " + mediaId + " (" + Math.round((item.expiring_at - nowSec) / 60) + "min left)");
      }
    }
  }
  if (purgeCount > 0) {
    bglog("Purge detection: " + purgeCount + " stories marked as purged");
    browser.storage.local.set({ storyCache });
    exportCSV();
  }
  freshItemIds.clear();
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
      bglog("Page", page, "| hasNext:", hasNext, "|", s.users, "users,", s.stories, "stories");
      cursor = hasNext && nextCursor ? nextCursor : null;
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      bglog("ERROR: Pagination failed:", e);
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
    bglog("Auto-fetch: replaying GalleryQuery...");
    try {
      const data = await (await fetch("https://www.instagram.com/graphql/query", {
        method: "POST", headers: buildHeaders(), body: lastQueryBody, credentials: "include"
      })).json();
      processStoryData(data);
      bglog("Auto-fetch complete");
    } catch (e) {
      bglog("ERROR: Auto-fetch failed:", e);
    }
  }, delay * 1000);
  bglog("Auto-fetch started, interval:", delay + "s");
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
      if (found > 0) bglog("Extracted", found, "doc_ids from bundle");
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
    bglog("Got", ids.length, "tray user IDs from content script");
    allReelIds = [...new Set([...allReelIds, ...ids])];
    browser.storage.local.set({ reelIds: allReelIds });
    pendingTrayIds = ids;
    tryAutoFetch();
    sendResponse({ ok: true });
  }
  if (msg.type === "triggerFetch") {
    bglog("Manual fetch triggered, reelIds:", allReelIds.length);
    if (allReelIds.length > 0) {
      buildAndFireGalleryQuery(allReelIds);
    } else {
      bglog("No reel IDs, asking content script to extract...");
      browser.tabs.query({ url: "https://www.instagram.com/*" }).then(tabs => {
        if (tabs.length === 0) {
          bglog("No Instagram tab found");
          return;
        }
        browser.tabs.sendMessage(tabs[0].id, { type: "extractTray" }).then(resp => {
          if (resp?.users?.length) {
            allReelIds = [...new Set([...allReelIds, ...resp.users.map(u => u.id)])];
            browser.storage.local.set({ reelIds: allReelIds });
            bglog("Got", allReelIds.length, "IDs from content script, fetching...");
            buildAndFireGalleryQuery(allReelIds);
          } else {
            bglog("Content script found no tray users");
          }
        }).catch(e => bglog("Content script error:", e.message));
      });
    }
    sendResponse({ ok: true });
  }
  if (msg.type === "clearCache") { storyCache = {}; sendResponse({ ok: true }); }
  if (msg.type === "getSeenHistory") sendResponse({ seenHistory });
  if (msg.type === "getLogs") sendResponse({ logs: [...bgLog] });
  if (msg.type === "getSettings") sendResponse(settings);
  if (msg.type === "saveSettings") {
    settings = { ...settings, ...msg.settings };
    browser.storage.local.set({ settings });
    restartAutoFetch();
    // Push settings to page context (for WebSocket typing blocker)
    browser.tabs.query({ url: "https://www.instagram.com/*" }).then(tabs => {
      for (const tab of tabs) {
        browser.tabs.sendMessage(tab.id, { type: "pushSettings", settings }).catch(_ => {});
      }
    });
    bglog("Settings saved:", settings);
    sendResponse({ ok: true });
  }
  if (msg.type === "injectLog") {
    bglog("[PAGE] " + msg.msg);
  }
  return true;
});

// Toggle floating panel on browser action click
browser.browserAction.onClicked.addListener((tab) => {
  if (tab.url?.includes("instagram.com")) {
    browser.tabs.sendMessage(tab.id, { type: "togglePanel" }).catch(_ => {});
  } else {
    browser.tabs.create({ url: "https://www.instagram.com/" });
  }
});

bglog("Background loaded");
