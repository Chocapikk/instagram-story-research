# Instagram Story Cache Bug - Research Idea

## Discovery

Deleted Instagram stories remain viewable in the local client cache even after server-side deletion. The story appears removed for everyone, but a device that already fetched the story retains it locally.

## What we observed

- User A posts a story, User B's phone fetches it
- User A deletes the story within minutes
- On User B's phone, refreshing the app shows no story (server returns nothing)
- BUT: the phone cache still has the story content from the initial fetch
- User A has no indication that User B saw the deleted content

## Research angles

### 1. Android Emulator Setup
- Set up an Android emulator (Genymotion, AVD, or Waydroid)
- Install Instagram APK (not from Play Store, use apkmirror for specific versions)
- Create test accounts for controlled testing
- Monitor cache directory and API calls

### 2. Cache Analysis
- Where does Instagram store story cache locally? SQLite? Flat files? SharedPreferences?
- How long does cached content persist after server-side deletion?
- Can we extract story media (images/videos) from the cache after deletion?
- Is the cache encrypted or plaintext?

### 3. API Interception
- Use mitmproxy/Frida to intercept Instagram API calls
- Identify the story fetch endpoint
- Determine: does fetching a story immediately mark it as "seen"?
- Can we separate the "fetch content" call from the "mark as seen" call?
- If yes: fetch without marking seen = anonymous story viewing

### 4. Anonymous Viewing Potential
- Can a modified client fetch stories without sending the "seen" receipt?
- Is the "seen" status sent as a separate API call or bundled with the fetch?
- If separate: simply block/drop the "seen" call = invisible viewing
- Test with Frida hooks on the Instagram APK

### 5. Deleted Story Recovery
- After server-side deletion, can a client that already cached the story re-serve it?
- Is there a race condition between cache TTL and deletion propagation?
- Can we build a tool that continuously caches stories and retains deleted ones?

## Potential Outputs
- Blog post on the cache behavior
- PoC tool for story cache extraction
- Responsible disclosure to Meta if the "seen" bypass is confirmed
- CVE if applicable (privacy violation: user believes story is deleted but it persists on recipient devices)

## Constraints
- Physical phone has no root = no Frida, no direct cache access
- Frida requires root or a debuggable app (Instagram is not debuggable)
- Modifying the APK (jadx + smali + apktool) is possible but Instagram is heavily obfuscated with cert pinning, root detection, and integrity checks = weeks of reverse
- Best approach: rooted Android emulator (Genymotion/AVD) + Frida for runtime hooking
- Alternative: Xposed module to intercept story cache purge and persist data externally
- On physical phone without root: only option is relying on UI cache (what we observed tonight) which is unreliable and timing-dependent
- For daily use: dedicated cheap Android phone (rooted with Magisk), Instagram installed, Frida/Xposed running, plugged in 24/7 on wifi like a server. Emulator is for research only, not practical for continuous monitoring

## No-root approaches to investigate
- Accessibility service that auto-screenshots stories when displayed
- Web version cache (browser-based, no app needed, browser cache may retain deleted stories)
- Direct API calls to story endpoints (bypass app entirely, use session cookies from browser)
- mitmproxy with cert pinning bypass (possible with Android network_security_config override on user-installable CA)
- Work profile isolation for additional app data access

## Phase 2: Headless fetcher
- Node/Python script, no browser needed
- Connect with session cookies
- Call GalleryQuery directly via HTTP every 5-10 min
- Never send SeenMutation
- Save stories to local folder (images + videos + metadata)
- Cron job running 24/7
- Catches deleted stories because it polls regularly

## Phase 3: Asymmetric visibility
- On mobile app: you can disable "seen" but you lose the viewer list on your own stories
- On web: no such feature, you're always visible AND you always see viewers
- Goal: block outgoing SeenMutation (you're invisible) BUT still fetch the viewer list of YOUR stories
- Need to identify the "get story viewers" endpoint (separate from SeenMutation?)
- If separate: we can have both - invisible viewing + full viewer list on our stories
- This is the real privacy bug: the mobile "disable seen" feature trades two things that should be independent

## Notes
- This is privacy research, not stalking tooling
- All testing on controlled accounts only
- Check Meta's bug bounty scope before disclosure
