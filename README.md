# IG Ghost Mode

**The PoC that became a product. You're welcome, Meta.**

A Firefox extension that blocks every client-side privacy signal Instagram uses: story seen receipts, DM read receipts, typing indicators, and online presence. Plus automatic story caching, media downloads, deletion detection, and metadata export.

Full writeup: [Instagram's "Seen" Is a Lie](https://chocapikk.com/posts/2026/instagram-seen-is-a-lie/)

## What it blocks

| Signal | Mechanism | What's blocked | Toggle |
|--------|-----------|---------------|--------|
| Story seen | GraphQL POST | `PolarisStoriesV3SeenMutation` | Story seen |
| DM read | GraphQL POST | `useIGDMarkThreadAsReadValidationMutation` | DM read |
| Typing indicator | MQTT WebSocket | `typing_activity` on `gateway.instagram.com` | Typing |
| Online presence | MQTT WebSocket | `co_presence` heartbeat on `gateway.instagram.com` | Online |

Every single "privacy signal" on Instagram is client-side trust with zero server-side enforcement. Block the call and you're invisible. One toggle per signal.

## What it does beyond blocking

- **Automatic story fetching** - extracts tray user IDs from SSR HTML, captures GraphQL `doc_id`s from JS bundles, fires its own GalleryQuery. Stories cached without clicking.
- **Media download** - every story saved to `ig_stories/<username>/<date>_<id>.jpg|mp4`. If someone deletes a story 5 minutes later, the file is already on disk.
- **Deletion detection** - if a story disappears before 24h expiry, flagged as deleted. File persists.
- **Asymmetric visibility** - blocks your receipts but your own story metadata still includes the full viewer list. You see who views you while being invisible viewing others.
- **CSV export** - timestamped CSV with username, media ID, music, caption, audience, viewer count, deletion status.
- **Auto-refresh** - replays GalleryQuery every N seconds with pagination.
- **Persistent state** - story cache and reel IDs survive extension reload via `storage.local`.
- **Story browser** - dedicated tab with grid layout, search by username, expandable metadata panels (media ID, timestamps, dimensions, music, audience, viewer count, local file path), image/video lightbox with info overlay, and direct links to open local files or CDN URLs.
- **System theme** - follows OS dark/light preference automatically.

## How it works

```
Instagram page load
    |
    |-- content.js extracts tray user IDs from SSR HTML
    |-- content.js injects inject.js into page context (MAIN world)
    |
    |-- background.js intercepts HTTP via webRequest API
    |   |-- Blocks PolarisStoriesV3SeenMutation (story seen)
    |   |-- Blocks useIGDMarkThreadAsReadValidationMutation (DM read)
    |   |-- Intercepts story responses via StreamFilter
    |   |-- Extracts doc_ids from JS bundles
    |   |-- Auto-fetches stories, downloads media, exports CSV
    |   '-- Lets useIGDMarkThreadAsReadMutation through (local read state)
    |
    '-- inject.js patches WebSocket.prototype.send in page context
        |-- Filters typing_activity frames on gateway.instagram.com
        '-- Filters co_presence heartbeat frames (online status)
```

Settings propagation: popup -> background -> content.js -> inject.js (page context) via CustomEvent.

## The $2 billion punchline

Instagram is testing [Instagram Plus](https://techcrunch.com/2026/03/30/meta-starts-testing-a-premium-subscription-on-instagram/), a $2/month subscription. The headline feature? Anonymous story viewing. Meta projects [$2.4 billion in annual revenue](https://www.webpronews.com/meta-wants-you-to-pay-for-the-privilege-of-lurking-inside-instagrams-secret-story-viewing-test/) if 1% of users subscribe.

The product is a `cancel: true` on a GraphQL call. That's the $2.4 billion business. Browser extensions doing this have existed since [2019](https://github.com/haikov/instaghost). Seven years. Nobody noticed. Now Meta wants to charge for it.

This extension does everything Instagram Plus does and more. For free. Including things their subscription doesn't offer: DM read blocking, typing indicator blocking, presence blocking, media downloads, deletion detection, CSV export.

## Prior art

| Project | Year | Method | Still works? |
|---------|------|--------|-------------|
| [instaghost](https://github.com/haikov/instaghost) | 2019 | Blocks REST `/api/v1/stories/reel/seen` | Probably not |
| [incognito-viewer](https://github.com/yizzycool/instagram-story-incognito-viewer) | 2023 | Blocks REST seen via `declarativeNetRequest` | Probably not |
| **This extension** | 2026 | Blocks GraphQL mutations + MQTT WebSocket | **Yes** |

Every prior implementation targets the old REST endpoint. None identified the GraphQL mutations. None handle DMs, typing, or presence. None cache, download, or detect deletions.

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
| `background.js` | HTTP interception, story caching, auto-fetch, downloads, CSV, settings |
| `content.js` | SSR HTML parsing, injects inject.js, bridges settings to page context |
| `inject.js` | Page context (MAIN world) - WebSocket monkey-patch for typing + presence |
| `popup.html` | Compact popup with stats, toggles, debug log |
| `popup.js` | Popup logic, settings management |
| `stories.html` | Full-tab story browser with grid view, search, lightbox |
| `stories.js` | Story browser logic, metadata panels, local file viewer |

## GraphQL endpoints

| Query | Purpose | Action |
|-------|---------|--------|
| `PolarisStoriesV3ReelPageGalleryQuery` | Fetch stories | Intercepted + cached |
| `PolarisStoriesV3ReelPageGalleryPaginationQuery` | Paginate stories | Intercepted + cached |
| `PolarisStoriesV3SeenMutation` | Mark story as "seen" | **Blocked** |
| `useIGDMarkThreadAsReadMutation` | Mark DM as read (local) | Allowed through |
| `useIGDMarkThreadAsReadValidationMutation` | Send "seen" to sender | **Blocked** |

## MQTT WebSocket (gateway.instagram.com)

| Signal | Marker | Action |
|--------|--------|--------|
| Typing indicator | `typing_activity`, `is_typing` | **Blocked** |
| Online presence | `co_presence`, `presence_heartbeat` | **Blocked** (off by default) |

## Limitations

- First page load requires one GraphQL call to capture headers
- Pagination needs a captured template from a story click or auto-fetch
- Online presence blocking is experimental (markers may need refinement)
- CDN media URLs expire after hours; downloaded files persist
- Firefox only (MV2 with `webRequest` blocking)

## Disclaimer

This is security research. I built it to document a design flaw that affects 2 billion users and that Meta is monetizing instead of fixing. All testing was performed on my own account. If you use this to harass or stalk someone, that's on you.
