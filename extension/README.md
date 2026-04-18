# Instagram's "Seen" Indicator Is a Lie — And They're About to Charge You $2/Month for the Proof

## How it started

I noticed something dumb. I was scrolling Instagram on my phone and someone deleted their story. But I could still see it in my app's cache. The story was gone from Instagram's servers, but my phone still had it. I thought: what if I could intercept this before it disappears?

I didn't know anything about Instagram's internal API. I just opened DevTools, clicked on a story, and looked at the network tab. What I found was worse than I expected.

## What I found

When you view an Instagram story, two separate HTTP calls happen:

```
1. PolarisStoriesV3ReelPageGalleryQuery  →  downloads the story content
2. PolarisStoriesV3SeenMutation          →  tells Instagram you viewed it
```

That's it. Two calls. The content is already in your browser before Instagram knows you saw it. The "seen" indicator that 2 billion users trust is a separate GraphQL mutation that any browser extension can block with one line:

```javascript
if (body.includes("PolarisStoriesV3SeenMutation")) {
  return { cancel: true };
}
```

One line. The "seen" is gone. You're invisible. No hack, no exploit, no reverse engineering. Just a standard `webRequest` API that Firefox and Chrome have supported for over a decade.

## The $2 billion punchline

Instagram is actively testing [Instagram Plus](https://techcrunch.com/2026/03/30/meta-starts-testing-a-premium-subscription-on-instagram/), a paid subscription currently rolling out in Mexico, Japan, and Philippines ([source](https://proton.me/blog/instagram-anonymous-story-viewer)). The flagship feature? **Anonymous story viewing.** Pay $1-2/month and your name won't appear in the viewer list.

Meta projects [$2.4 billion in annual revenue](https://www.webpronews.com/meta-wants-you-to-pay-for-the-privilege-of-lurking-inside-instagrams-secret-story-viewing-test/) if 1% of users subscribe.

The full Instagram Plus package:
- **Anonymous story viewing** — what this extension does for free
- **Searchable viewer lists** — what this extension captures in metadata for free
- Granular audience groups beyond Close Friends
- Stories that last beyond 24 hours
- Weekly spotlight to boost story visibility
- Animated "Superlikes"
- Detailed engagement metrics including rewatch counts

Nobody pays $2/month for animated Superlikes. They pay to view without being seen and to know who's viewing them. Both have always been free in the architecture. The rest is filler to justify the price tag.

**The product is a `cancel: true` on a GraphQL call. That's it. That's the $2.4 billion business.**

And this isn't new. Browser extensions doing the exact same thing have existed since [2019](https://github.com/haikov/instaghost). Seven years. Zero stars, zero attention, zero media coverage. The capability has been public for seven years and nobody connected the dots. Now Meta is packaging it as a premium feature and the tech press is covering it as innovation. It's not innovation. It's monetizing a design flaw that the security community documented years ago and that nobody outside of it ever noticed.

## What this extension does

I built a Firefox extension as a proof of concept. It does more than Instagram Plus for $0.

### Invisible story viewing
Blocks `PolarisStoriesV3SeenMutation` at the network level via Firefox's `webRequest` API. You see stories normally. Your name never appears in the viewer list.

### Automatic story caching without clicking
The extension extracts story tray user IDs from Instagram's Server-Side Rendered HTML, dynamically extracts GraphQL `doc_id`s from Instagram's JavaScript bundles, and builds its own `PolarisStoriesV3ReelPageGalleryQuery`. Stories are fetched and cached automatically when you load instagram.com. No clicking required.

### Local media download
Every intercepted story is downloaded to disk: `~/Downloads/ig_stories/<username>/<date>_<mediaId>.jpg` (or `.mp4`). Organized by username, dated. If someone deletes a story 5 minutes after posting, the file is already on your machine.

### Full metadata capture
Each cached story includes: username, media ID, shortcode, timestamp, expiry time, music title and artist, caption text, audience type (public or close friends), viewer count, and full viewer list with user IDs.

### Deletion detection
If a story disappears from the feed before its 24h expiry, the extension flags it as deleted with a timestamp. The downloaded file persists. You see what was removed.

### Asymmetric visibility
The worst finding. The extension blocks YOUR seen receipts to others, but your own story metadata includes `viewer_count` and a full `viewers` array with user IDs. You see who views your stories while being completely invisible when viewing theirs.

### CSV history export
Every cache update exports a CSV to `ig_stories/history.csv` with columns: `username, media_id, code, type, timestamp, posted_at, expires_at, cached_at, music_title, music_artist, caption, audience, viewer_count, file_path, deleted, deleted_at`.

### Dynamic doc_id extraction
Instagram identifies GraphQL queries by numeric `doc_id`s that change with deployments. The extension intercepts JS bundles via `StreamFilter` and extracts mappings from the pattern `__d("QueryName_instagramRelayOperation", ... exports="docId")`. No hardcoded IDs that break on the next deploy.

### Auto-fetch with pagination
After the initial fetch, the extension replays the GalleryQuery every 5 minutes. It paginates automatically using captured pagination templates until all users with active stories are cached.

## How it works

```
Instagram page load
    │
    ├── JS bundles intercepted via StreamFilter
    │   └── doc_id mappings extracted (QueryName → numeric ID)
    │
    ├── SSR HTML parsed by content script
    │   └── story tray user IDs sent to background
    │
    ├── First GraphQL call intercepted
    │   └── headers captured (CSRF, cookies, session)
    │
    ├── Auto GalleryQuery fired
    │   ├── stories cached + metadata stored
    │   ├── media downloaded to disk
    │   ├── CSV exported
    │   └── pagination triggered for remaining users
    │
    └── Ongoing
        ├── SeenMutation → BLOCKED
        ├── Auto-fetch every 5 minutes
        └── Deletion detection on each fetch
```

## The real question

This isn't a bug. This is a design decision. The SeenMutation has been a separate call since Instagram stories launched. Meta's engineering team chose to separate the content fetch from the seen receipt. There are two possible explanations:

**1. It's an oversight.** Meta never noticed that the seen indicator has zero server-side enforcement and can be bypassed by any browser extension. For years. On a platform with 2 billion users. With thousands of engineers. This seems unlikely.

**2. It's intentional.** They always planned to monetize the toggle. The separation between fetch and seen was a business decision from day one. The "seen" indicator was never a privacy guarantee — it was a future revenue stream parked in the architecture, waiting for the right moment to flip the switch and charge for it.

In both cases, every user who relied on the "seen" indicator to know if someone viewed their story was trusting a system with zero enforcement. The indicator works only if every viewer uses the unmodified official client and chooses not to block the call. One browser extension and it's gone.

Instagram is about to charge $2/month for something that costs one line of JavaScript to do for free. And they've known this the entire time.

## Install (Firefox)

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from this directory

## Files

| File            | Purpose                                                          |
| --------------- | ---------------------------------------------------------------- |
| `manifest.json` | Extension config (MV2, Firefox)                                  |
| `background.js` | Request interception, caching, auto-fetch, downloads, CSV export |
| `content.js`    | SSR HTML parsing for tray user IDs                               |
| `popup.html`    | Cache viewer UI                                                  |
| `popup.js`      | Popup logic, stats, manual fetch, JSON export                    |

## Instagram GraphQL endpoints

| Query                                            | Purpose                           | Blocked?                  |
| ------------------------------------------------ | --------------------------------- | ------------------------- |
| `PolarisStoriesV3ReelPageGalleryQuery`           | Fetch stories for multiple users  | No (intercepted + cached) |
| `PolarisStoriesV3ReelPageGalleryPaginationQuery` | Paginate stories                  | No (intercepted + cached) |
| `PolarisStoriesV3SeenMutation`                   | Mark story as "seen"              | **YES**                   |
| `PolarisStoriesV3AdsPoolQuery`                   | Ad pool, contains `tray_user_ids` | No                        |
| `PolarisStoriesV3TrayContainerQuery`             | Tray container (lazy loaded)      | No                        |

## Limitations

- First page load requires one GraphQL call to capture headers. Auto-fetch retries until headers are available.
- Pagination needs a captured template from a story click or auto-fetch response.
- Some JS bundles cause `NS_ERROR_FAILURE` in StreamFilter when served from browser cache. Harmless.
- Extension is temporary in Firefox. Requires reload after restart.
- CDN media URLs expire after hours. Downloaded files persist.

## A note on intelligence use

The asymmetric visibility feature (see who views your stories while being invisible when viewing theirs) is not just a privacy concern. It's an intelligence tool. Anyone conducting surveillance, social engineering, or HUMINT operations on Instagram can use this architecture to monitor targets without leaving traces, while simultaneously tracking who is monitoring them.

If a state actor, a stalker, or a corporate espionage operator uses this, they get: invisible story viewing, full viewer lists on their own decoy stories, media downloads of deleted content, and timestamped CSV logs. All from a browser extension. No zero-day required. No exploit needed. Just the API working as designed.

I don't know if this was considered when the architecture was designed. But it should be considered now.

## Why I did this

I do security research. I find vulnerabilities, I document them, I build proof of concepts. This is just another research project.

When I heard Instagram was planning to charge people for anonymous story viewing, something felt wrong. People around me were genuinely worried. Some use the "seen" indicator as a safety signal (knowing when someone they blocked on another account is watching them). Some rely on it to know if a message was received. And now Meta is telling them that for $2/month, anyone can bypass that?

So I opened DevTools. And what I found wasn't a complex bypass or a clever exploit. It was a `cancel: true` on a GraphQL call. The most basic interception possible. The "seen" was never enforced. It was never secure. It was just a call that the official client happened to make, and that anyone could stop making at any time.

This isn't about stalking or surveillance. This is about showing that a privacy feature that 2 billion people trust was never real. And now Meta wants to sell the proof.

## Disclaimer

This documents a design flaw in Instagram's story architecture. All testing was performed on the researcher's own account. This tool should not be used to stalk, harass, or violate anyone's privacy.
