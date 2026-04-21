# IG Ghost Mode

**The PoC that became a product. You're welcome, Meta.**

A Firefox extension that blocks every client-side privacy signal Instagram uses: story seen receipts, DM read receipts, typing indicators, and online presence. Plus automatic story caching, media downloads, deletion detection, seen tracking, and full metadata export.

Full writeup: [Instagram's "Seen" Is a Lie](https://chocapikk.com/posts/2026/instagram-seen-is-a-lie/)

## What it blocks

| Signal | Mechanism | What's blocked | Toggle |
|--------|-----------|---------------|--------|
| Story seen | GraphQL POST | `PolarisStoriesV3SeenMutation` | Story seen |
| DM read | GraphQL POST + SharedWorker | Both `MarkThreadAsRead` mutations | DM read |
| Typing indicator | MQTT WebSocket | `typing_activity` / `indicate_activity` | Typing |
| Online presence | MQTT WebSocket | `co_presence` heartbeat | Online |

Two known MQTT gateways: `gateway.instagram.com` and `edge-chat.instagram.com`. Both intercepted.

## What it does beyond blocking

**Story intelligence**
- **Full tray fetch** - queries `/api/v1/feed/reels_tray/` to get ALL users with active stories, not just what's visible in the HTML
- **Auto-pagination** - fetches stories in pages until `has_next_page: false`, no hardcoded limits
- **Media download** - every story saved to `ig_stories/<username>/<date>_<id>.jpg|mp4`
- **Seen tracking** - detects which stories you've already viewed (via tray seen timestamps) and which were viewed invisibly (seen blocked by extension)
- **Deletion vs expiry** - distinguishes between stories manually deleted by the poster (PURGED) and stories that expired naturally after 24h (EXPIRED). Downloaded files persist in both cases
- **Close friends detection** - identifies and badges stories posted to the poster's close friends list
- **Persistent seen history** - seen/ghost status stored independently from cache, survives cache clear and extension reload
- **Local file scanning** - scans downloaded files via `browser.downloads.search()` to show stories that exist on disk even after cache is cleared

**Asymmetric visibility**
- Blocks your receipts but your own story metadata still includes the full viewer list
- You see who views your stories while being invisible when viewing theirs

**Data export**
- **CSV** with columns: username, media_id, code, type, timestamp, posted_at, expires_at, cached_at, music_title, music_artist, caption, audience, viewer_count, file_path, deleted, deleted_at, seen_sent, seen_blocked
- **JSON export** of full cache with all metadata

**Story browser**
- Dedicated full-tab browser opened from the popup
- Grid layout with video thumbnails (first frame preview)
- Search by username, sort by date or alphabetical
- Expandable metadata panels per story (media ID, timestamps, dimensions, music, audience, viewers, local path)
- Image/video lightbox with info overlay
- Direct "Open local" button to view downloaded files
- Badges: 🖼 IMG, ▶ VID, ⭐ CLOSE FRIENDS, 👁 SEEN, 👻 GHOST, 🟢 LIVE, ⏰ EXPIRED, 🗑 PURGED, 💾 LOCAL
- CDN links greyed out and struck through on expired stories

**UI**
- Compact popup with real-time stats (blocked, users, stories)
- iOS-style toggles for each privacy feature
- Debug log panel with color-coded background/page/error messages
- System theme support (follows OS dark/light preference)

## How it works

```
Instagram page load
    |
    |-- content.js extracts tray user IDs from SSR HTML
    |-- content.js injects inject.js into page context (MAIN world)
    |
    |-- content.js patches window.fetch via wrappedJSObject at document_start
    |   '-- Blocks DM read mutations before Instagram code loads
    |
    |-- background.js intercepts HTTP via webRequest API
    |   |-- Fetches full tray via /api/v1/feed/reels_tray/ (all users + seen timestamps)
    |   |-- Blocks PolarisStoriesV3SeenMutation (story seen)
    |   |-- Blocks both MarkThreadAsRead mutations via onBeforeSendHeaders
    |   |-- Injects fetch patch into SharedWorker via filterResponseData
    |   |-- Intercepts story responses via StreamFilter
    |   |-- Extracts doc_ids from JS bundles
    |   |-- Auto-paginates GalleryQuery until no more results
    |   |-- Downloads media, exports CSV, persists cache + seenHistory
    |   '-- Tracks seen/ghost status per story via tray timestamps
    |
    '-- inject.js patches WebSocket.prototype.send in page context
        |-- Filters typing_activity / indicate_activity frames
        |-- Filters co_presence heartbeat frames (online status)
        '-- Covers both gateway.instagram.com and edge-chat.instagram.com
```

Settings propagation: popup -> background -> content.js -> inject.js (page context) via CustomEvent.

DM read blocking uses three layers:
1. `webRequest.onBeforeSendHeaders` - blocks both mutations via `X-FB-Friendly-Name` header
2. `wrappedJSObject` + `exportFunction` - patches `fetch` synchronously at `document_start` (Firefox API)
3. `filterResponseData` on `/static_resources/webworker/init_script/` - injects `fetch` patch into Instagram's SharedWorker (`IGDAWMainWebWorkerBundle`) before it executes

The SharedWorker injection is necessary because Instagram sends the DM read validation mutation from a SharedWorker context that has its own `fetch`, invisible to page-level patches and unreliable via `webRequest`.

## The $2 billion punchline

Instagram is testing [Instagram Plus](https://techcrunch.com/2026/03/30/meta-starts-testing-a-premium-subscription-on-instagram/), a $2/month subscription. The headline feature? Anonymous story viewing. Meta projects [$2.4 billion in annual revenue](https://www.webpronews.com/meta-wants-you-to-pay-for-the-privilege-of-lurking-inside-instagrams-secret-story-viewing-test/) if 1% of users subscribe.

The product is a `cancel: true` on a GraphQL call. That's the $2.4 billion business.

This extension does everything Instagram Plus does and more. For free. Including things their subscription doesn't offer: DM read blocking, typing indicator blocking, presence blocking, media downloads, deletion detection, seen tracking, CSV export, story browser with metadata panels.

## Prior art

| Project | Year | Method | Still works? |
|---------|------|--------|-------------|
| [instaghost](https://github.com/haikov/instaghost) | 2019 | Blocks REST `/api/v1/stories/reel/seen` | Probably not |
| [incognito-viewer](https://github.com/yizzycool/instagram-story-incognito-viewer) | 2023 | Blocks REST seen via `declarativeNetRequest` | Probably not |
| [Ghostify](https://chromewebstore.google.com/detail/ghostify-hide-seen-typing/flpnibonbhdmnpgflnbemgghghhblmpm) | ~2023 | `declarativeNetRequest` + WS `indicate_activity` | Partial |
| [better-instagram](https://github.com/dclstn/better-instagram) | ~2024 | XHR middleware on REST `/stories/reel/seen` | Probably not |
| [instafn](https://github.com/xafn/instafn) | ~2025 | WS `is_typing` modification (sets to 0) | Partial |
| **This extension** | 2026 | GraphQL mutations + MQTT WebSocket + tray API | **Yes** |

Every prior implementation either targets the old REST endpoints (dead) or does partial blocking without caching, downloading, or tracking.

## Install

### Temporary (about:debugging)

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `extension/manifest.json`

### Permanent (signed via AMO)

A signed XPI is available for self-hosting. The extension is submitted to AMO as unlisted. Once signed, install the XPI directly and it persists across browser restarts.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Extension config (MV2, Firefox, min version 142) |
| `background.js` | HTTP interception, tray fetch, story caching, auto-fetch, downloads, CSV, seen tracking, settings |
| `content.js` | SSR HTML parsing, header extraction, `wrappedJSObject` fetch patch, injects inject.js, floating panel, bridges settings |
| `inject.js` | Page context (MAIN world) - WebSocket monkey-patch for typing + presence, Lightspeed task logging |
| `popup.html` | Compact popup/panel with stats, toggles, debug log |
| `popup.js` | Popup logic, settings management |
| `stories.html` | Full-tab story browser with grid view, search, sort, lightbox, theme support |
| `stories.js` | Story browser logic, metadata panels, local file scanning, download merge |

## GraphQL endpoints

| Query | Purpose | Action |
|-------|---------|--------|
| `PolarisStoriesV3ReelPageGalleryQuery` | Fetch stories | Intercepted + cached + paginated |
| `PolarisStoriesV3ReelPageGalleryPaginationQuery` | Paginate stories | Intercepted + cached |
| `PolarisStoriesV3SeenMutation` | Mark story as "seen" | **Blocked** |
| `useIGDMarkThreadAsReadMutation` | Mark DM as read + reports to server | **Blocked** (via `onBeforeSendHeaders`) |
| `useIGDMarkThreadAsReadValidationMutation` | Async confirmation via SharedWorker | **Blocked** (via worker `fetch` injection) |

## REST API

| Endpoint | Purpose | Action |
|----------|---------|--------|
| `/api/v1/feed/reels_tray/` | Full story tray with seen timestamps | Queried for user discovery + seen detection |

## MQTT WebSocket

| Gateway | Signal | Marker | Action |
|---------|--------|--------|--------|
| `gateway.instagram.com` | Typing | `typing_activity`, `is_typing` | **Blocked** |
| `edge-chat.instagram.com` | Typing | `indicate_activity`, `is_typing` | **Blocked** |
| Both | Presence | `co_presence`, `presence_heartbeat` | **Blocked** (off by default) |

## Story status badges

| Badge | Meaning |
|-------|---------|
| 🖼 IMG | Image story |
| ▶ VID | Video story |
| ⭐ CLOSE FRIENDS | Posted to poster's close friends list |
| 👁 SEEN | You viewed this and the seen receipt was sent (before extension or with blocking off) |
| 👻 GHOST | Viewed invisibly - seen receipt was blocked by extension |
| 🟢 LIVE | Story is still active, CDN link valid |
| ⏰ EXPIRED | Naturally expired after 24h |
| 🗑 PURGED | Manually deleted by poster before 24h expiry - file still on your disk |
| 💾 LOCAL | Only available from local disk (expired from cache) |

## Limitations

- First page load requires one GraphQL call to capture headers
- Online presence blocking is experimental (markers may need refinement)
- DM read blocking requires the SharedWorker to reload (first page load after extension install). The worker script is patched via `filterResponseData` - if the worker was already running before the extension loaded, it won't be patched until the next full page reload
- CDN media URLs persist 2-5 days after story expiry (no auth required, shareable to anyone without an Instagram account). Close friends stories use the same CDN with no additional access control
- Firefox only (MV2 with `webRequest` blocking + `wrappedJSObject` + `exportFunction` + `filterResponseData`)
- Deletion detection requires the extension to be running when the story disappears
- Instagram's mobile "disable read receipts" toggle is client-side only. Users who disabled it on mobile are still visible as "read" on the web client of the receiving account. The toggle blocks one client, not the server

## Disclaimer

This is security research. I built it to document a design flaw that affects 2 billion users and that Meta is monetizing instead of fixing. All testing was performed on my own account. If you use this to harass or stalk someone, that's on you.
