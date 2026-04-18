// Runs in MAIN world - same context as Instagram's JS.
// Guard against double injection.
if (window.__igResearchLoaded) { /* already loaded */ } else {
window.__igResearchLoaded = true;

const SEEN_MUTATION = "PolarisStoriesV3SeenMutation";
const STORY_QUERIES = [
  "PolarisStoriesV3ReelPageGalleryQuery",
  "PolarisStoriesV3ReelPageGalleryPaginationQuery"
];
const CACHE_KEY = "ig_story_cache";

const originalFetch = window.fetch;

window.fetch = async function (...args) {
  const [resource, config] = args;
  const url = typeof resource === "string" ? resource : resource?.url || "";

  if (!url.includes("graphql/query") || !config?.body) {
    return originalFetch.apply(this, args);
  }

  const body = typeof config.body === "string" ? config.body : "";

  // Block seen mutation
  if (body.includes(SEEN_MUTATION)) {
    console.log("[IG Research] Blocked SeenMutation");
    return new Response(JSON.stringify({ data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Intercept story fetch and cache the response
  const isStoryQuery = STORY_QUERIES.some((q) => body.includes(q));
  if (isStoryQuery) {
    captureQueryParams(body);
    captureHeaders(config);
    const response = await originalFetch.apply(this, args);
    const clone = response.clone();

    clone.json().then((data) => {
      try {
        cacheStories(data);
      } catch (e) {
        console.error("[IG Research] Cache error:", e);
      }
    }).catch(() => {});

    return response;
  }

  return originalFetch.apply(this, args);
};

function cacheStories(data) {
  const reels = extractReels(data);
  if (reels.length === 0) return;

  const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  const now = Date.now();

  for (const reel of reels) {
    const userId = reel.id || reel.user?.id;
    const username = reel.user?.username || reel.owner?.username || "unknown";

    if (!userId) continue;
    if (!cache[userId]) cache[userId] = { username, items: {} };
    cache[userId].username = username;

    const items = reel.items || reel.media || [];
    for (const item of items) {
      const mediaId = item.id || item.pk;
      if (!mediaId) continue;
      if (cache[userId].items[mediaId]) continue;

      const mediaUrl = extractMediaUrl(item);
      cache[userId].items[mediaId] = {
        id: mediaId,
        url: mediaUrl,
        timestamp: item.taken_at || item.taken_at_timestamp,
        cached_at: now,
        type: item.is_video ? "video" : "image",
        deleted: false
      };
    }
  }

  localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  console.log("[IG Research] Cached", reels.length, "reels");

  detectDeletions(cache, reels);
}

function detectDeletions(cache, freshReels) {
  const now = Math.floor(Date.now() / 1000);
  const STORY_TTL = 86400;

  const liveIds = new Set();
  for (const reel of freshReels) {
    const userId = reel.id || reel.user?.id;
    const items = reel.items || reel.media || [];
    for (const item of items) {
      const mediaId = item.id || item.pk;
      if (userId && mediaId) liveIds.add(userId + ":" + mediaId);
    }
  }

  for (const [userId, data] of Object.entries(cache)) {
    for (const [mediaId, item] of Object.entries(data.items)) {
      if (item.deleted) continue;
      if (!item.timestamp) continue;

      const expiresAt = item.timestamp + STORY_TTL;
      const key = userId + ":" + mediaId;

      if (now < expiresAt && !liveIds.has(key)) {
        item.deleted = true;
        item.deleted_at = Date.now();
        console.warn("[IG Research] DELETED story detected:", data.username, mediaId);
        document.title = "[DELETED] @" + data.username + " removed a story";
        setTimeout(() => { document.title = "Instagram"; }, 10000);
      }
    }
  }
}

function extractReels(data) {
  const reels = [];

  function walk(obj) {
    if (!obj || typeof obj !== "object") return;
    if (obj.reel_type || obj.__typename === "GraphReel" || obj.items || obj.media) {
      reels.push(obj);
    }
    if (Array.isArray(obj)) {
      obj.forEach(walk);
    } else {
      Object.values(obj).forEach(walk);
    }
  }

  walk(data);
  return reels;
}

function extractMediaUrl(item) {
  if (item.video_versions?.length) return item.video_versions[0].url;
  if (item.image_versions2?.candidates?.length) return item.image_versions2.candidates[0].url;
  if (item.display_url) return item.display_url;
  if (item.video_url) return item.video_url;
  return null;
}

// Auto-fetch routine
const FETCH_INTERVAL_KEY = "ig_research_fetch_interval";
const FETCH_ENABLED_KEY = "ig_research_fetch_enabled";

function getSettings() {
  return {
    enabled: localStorage.getItem(FETCH_ENABLED_KEY) !== "false",
    interval: parseInt(localStorage.getItem(FETCH_INTERVAL_KEY) || "300", 10)
  };
}

let fetchTimer = null;

function startAutoFetch() {
  stopAutoFetch();
  const settings = getSettings();
  if (!settings.enabled) return;

  fetchTimer = setInterval(() => {
    console.log("[IG Research] Auto-fetch triggered");
    refetchStories();
  }, settings.interval * 1000);

  console.log("[IG Research] Auto-fetch started, interval:", settings.interval, "seconds");
}

function stopAutoFetch() {
  if (fetchTimer) {
    clearInterval(fetchTimer);
    fetchTimer = null;
  }
}

let lastFetchParams = null;
let lastFetchHeaders = null;

function captureQueryParams(body) {
  if (body.includes("PolarisStoriesV3ReelPageGalleryQuery")) {
    lastFetchParams = body;
  }
}

function captureHeaders(config) {
  const headers = {};
  if (config?.headers) {
    if (config.headers instanceof Headers) {
      config.headers.forEach((v, k) => { headers[k] = v; });
    } else {
      Object.assign(headers, config.headers);
    }
  }
  if (Object.keys(headers).length > 0) {
    lastFetchHeaders = headers;
  }
}

function refetchStories() {
  if (!lastFetchParams || !lastFetchHeaders) {
    console.log("[IG Research] No captured params/headers yet, waiting for first manual load");
    return;
  }

  // Reuse the exact headers from the last real Instagram fetch
  const headers = { ...lastFetchHeaders };

  // Refresh CSRF token from cookie in case it rotated
  const csrfToken = document.cookie.match(/csrftoken=([^;]+)/)?.[1];
  if (csrfToken) headers["X-CSRFToken"] = csrfToken;

  originalFetch("https://www.instagram.com/graphql/query", {
    method: "POST",
    headers,
    body: lastFetchParams,
    credentials: "include"
  }).then(r => r.json()).then(data => {
    try {
      cacheStories(data);
      console.log("[IG Research] Auto-fetch complete");
    } catch (e) {
      console.error("[IG Research] Auto-fetch cache error:", e);
    }
  }).catch(e => console.error("[IG Research] Auto-fetch failed:", e));
}

// Listen for settings changes from popup
window.addEventListener("ig_research_settings", (e) => {
  const { enabled, interval } = e.detail;
  localStorage.setItem(FETCH_ENABLED_KEY, enabled);
  localStorage.setItem(FETCH_INTERVAL_KEY, interval);
  if (enabled) {
    startAutoFetch();
  } else {
    stopAutoFetch();
  }
});

startAutoFetch();

console.log("[IG Research] Extension loaded - SeenMutation blocked, story caching active");

} // end guard
