# Build "Focus Up": a distraction-blocking focus tool with session tracking

You are building a personal focus tool for one user on **Windows 11** who studies and writes in the **Brave** browser (Chromium-based). Work in `d:\UNI\Focus up`. Build it step by step, test each phase before you start the next, and keep the code simple and readable. It is a personal project, not a product.

## Goal

When the user starts a **Focus Session**, the tool should:
1. Block all notifications (browser and Windows).
2. Allow only **3 browser tabs**, each with a fixed role:
   - **Music**: Spotify, YouTube Music, SoundCloud, etc.
   - **Research**: Google, AI assistants (ChatGPT, Claude, Gemini, Perplexity), and pages opened from search results.
   - **Work**: the book, article, or PDF the user is working on.
3. Block distracting sites and apps, but **still allow Discord** so the user can be in a voice call with friends.
4. Time each session and save it.
5. Show past sessions on a **calendar**.

When no session is running, nothing is restricted.

## Architecture

A browser extension cannot silence Windows notifications or control desktop apps, so build it in two parts:

### Part A: Brave extension (Chromium, Manifest V3). Build this first; it is the core.
- `background.js` service worker: session state, tab enforcement, timer, and blocking rules.
- `popup.html/js`: start, pause, and end a session; shows the live timer and the 3 tab slots.
- `dashboard.html/js` (options page): the calendar, session history, stats, and settings.
- Storage: `chrome.storage.local`. No backend and no accounts.
- Plain HTML, CSS, and JS. No build step, so the user can load it unpacked in Brave right away.

### Part B: Small Windows companion app. Build this second, after Part A works.
- Python (with a tray icon, using `pystray`) or a small PowerShell script plus a scheduled task. Pick whichever is simpler and explain why you chose it.
- Talks to the extension through **Native Messaging** (Brave supports the Chrome API). The extension tells it when a session starts and ends.
- On session start: turn on Windows **Do Not Disturb**, keeping Discord as an allowed priority app if possible so calls still come through. Optionally close or minimize apps on a user-editable blocklist (e.g., Steam, other games, WhatsApp desktop). **Never touch Discord, the browser, or the music app.**
- On session end: restore the previous notification settings.
- If programmatic DND control is unreliable on Windows 11, say so plainly. Then fall back to opening the right Settings page and showing the user a one-time manual setup guide. Do not use fragile registry hacks without warning the user.

### Brave-specific notes
- Use only the standard `chrome.*` extension APIs that Brave supports. Do not depend on Chrome-only features or Google services (e.g., `chrome.identity` with Google sign-in).
- **Native messaging host registration:** Brave on Windows may read its own registry key (`HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\...`) rather than Chrome's (`HKCU\Software\Google\Chrome\NativeMessagingHosts\...`). Check which one Brave uses. If you are unsure, have the setup script register the host under both keys.
- **Brave's own distractions:** Brave News on the New Tab page, Brave Rewards/ads notifications, and Brave's built-in notifications. Block or neutralize what an extension can reach. For anything it can't reach, add a one-time "Recommended Brave settings" checklist to the README and the dashboard (e.g., turn off Brave News, Rewards notifications, and Brave Talk/Wallet popups).
- **Leo (Brave's built-in AI) in the sidebar:** it doesn't use a tab, so it doesn't count toward the 3-tab limit. Mention in the README that the user can use Leo as their AI assistant and keep the Research tab for Google.
- **Brave sidebar and vertical tabs:** sidebar panels (bookmarks, reading list, web panels) can show websites without a tab. Find out whether an extension can detect or restrict this. If it can't, list it as a known limitation.
- **Brave Shields:** they should not interfere with the extension. Test with Shields on.

## Detailed requirements

### 1. Session flow
- Click **Start Session**. Optionally enter a session name or subject (e.g., "Thesis ch. 3").
- The user assigns the 3 slots. The simplest UX: when the session starts, the currently open tabs can be dragged into or picked for Music, Research, and Work, and a slot can be left empty. Any other tabs get closed after a confirmation, or their URLs are saved to a "parked" list that comes back when the session ends. Use the parked list; it is safer.
- While a session is running:
  - **No new tabs or windows.** If one opens (Ctrl+T, middle-click, `window.open`), close it right away. If it was opened from the Research tab, load its URL into the Research tab instead.
  - **Music tab**: only domains on the music allowlist.
  - **Research tab**: open browsing is allowed, except domains on the distraction **blocklist**. Defaults: youtube.com (but not music.youtube.com), reddit, x/twitter, instagram, tiktok, facebook, netflix, twitch, news sites, and shopping sites. Blocked pages redirect to a calm "Blocked: stay focused" page with a "back" button.
  - **Work tab**: locked to the domain (or local `file://` PDF) it had at assignment, plus a user-editable allowlist. The user can deliberately re-assign it from the popup.
  - **Discord exception**: discord.com is always allowed. If the user uses Discord web instead of the desktop app, allow it as an optional 4th "Comms" tab, on by default and toggleable in settings.
- **Pause** stops the timer but keeps restrictions on. **End** stops the timer, saves the session, lifts all restrictions, and offers to reopen parked tabs.
- An **emergency unlock** exists but adds friction: the user must type a sentence like "I am choosing to end my focus early", and the session is saved with an `endedEarly` flag.
- The session must survive service worker restarts and browser restarts. Persist the state and recompute elapsed time from timestamps. Never keep a counter that only lives in memory.

### 2. Notification blocking (browser side)
- During a session, set the content setting for notifications to `block` for all sites (`chrome.contentSettings.notifications`). Restore the previous setting afterwards.
- Also inject a content script that overrides `Notification.requestPermission` and the `Notification` constructor during a session, as a second layer of protection.

### 3. Timer
- Show a live timer in the popup and on the extension badge (e.g., "42m").
- Optional Pomodoro mode (25/5, configurable), off by default. The plain stopwatch is the main mode.
- Track active time (excluding pauses) separately from wall-clock time.

### 4. Session data model
```json
{
  "id": "uuid",
  "name": "Thesis ch. 3",
  "start": "ISO timestamp",
  "end": "ISO timestamp",
  "activeSeconds": 5400,
  "pauses": [{ "start": "...", "end": "..." }],
  "endedEarly": false,
  "blockedAttempts": 7,
  "slots": { "music": "open.spotify.com", "research": "google.com", "work": "file:///.../paper.pdf" }
}
```
Count `blockedAttempts` (blocked navigations and new-tab attempts). It is a useful honesty metric.

### 5. Calendar dashboard
- **Month view** in which every day shows total focus time, with a heat-map shading (GitHub-contribution style).
- Click a day to list its sessions (name, start–end, duration, blocked attempts) and allow editing the name or deleting a session.
- A **week view** or summary: total hours this week, daily average, current streak (consecutive days with at least 1 session), and longest session.
- **Export/Import** to JSON and **Export** to CSV, so the data is never trapped.
- Write the calendar yourself in vanilla JS. Do not add a heavy library.

### 6. Settings
- Edit the music allowlist, distraction blocklist, Work-tab extra allowlist, and blocked desktop apps (for Part B).
- Toggles: Discord web tab, Pomodoro mode, and close vs. park extra tabs.

## Technical notes
- Use `chrome.declarativeNetRequest` dynamic rules for domain blocking where possible. Use `chrome.tabs` / `chrome.webNavigation` listeners for per-tab role enforcement, which DNR cannot express per tab.
- Request only the permissions you need, and list each one with the reason in the README.
- Handle edge cases: the user closes a slot tab (the slot becomes empty and they can reassign it), the user drags a tab into a new window, the browser restarts mid-session, `brave://` and `chrome://` pages, and the extension's own pages.
- Design the UI to be calm and minimal, with a dark mode.

## Deliverables
1. Working extension in `extension/`, loadable via `brave://extensions` → Developer mode → Load unpacked.
2. Companion app in `companion/` with a setup script that registers the native messaging host.
3. `README.md` covering install steps, how to use it, the permissions, and known limitations (be honest about what cannot be enforced, e.g., the user can always disable the extension).
4. A short manual test checklist that you have actually run through for each feature.

## How to work
- Start by stating the plan and the file structure, then build **Part A in this order**: session state + timer → tab enforcement → blocking + notifications → dashboard/calendar → settings. Then build Part B.
- After each step, tell me how to test it.
- If a requirement turns out to be impossible or unreliable with the browser or Windows APIs, say so and propose the closest workable alternative. Do not silently skip it.
