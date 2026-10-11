# Focus Up

A Brave extension for focus sessions: a locked focus window with at most 3 tabs (Music, Research, Work), no notifications, distraction sites blocked, a session timer and a calendar. Discord is meant to be used as the desktop app, which the extension never touches.

Status: **the extension works. The Windows companion and the desktop app are built; the host, the app-to-host link and the app's logic are tested, but the full Brave-to-app chain has not been run on a real browser yet.**

## How the pieces fit

```
Brave + extension  <--native messaging-->  companion/host.py  <--local socket-->  app/focusup_app.py
 (owns the session,                         (also switches Windows                 (timer, controls,
  enforces the rules,                        notifications and closes apps)         calendar)
  stores the history)
```

The extension is the single source of truth. The desktop app mirrors the live session and the history and sends commands (start, pause, end, rename, delete). Closing the app never affects a running session.

## Install

1. Open `brave://extensions`, turn on **Developer mode**.
2. **Load unpacked** and pick the `extension/` folder.
3. If you use a local PDF in the Work tab: Details → **Allow access to file URLs**.
4. Pin the Focus Up icon to the toolbar.
5. **Optional, for the desktop app, Windows notifications and app closing:** run `powershell -ExecutionPolicy Bypass -File companion\install.ps1`, then reload Focus Up in `brave://extensions`. See "Windows companion" below.

The extension has a fixed ID (`okikjdfcpcfcadmmpgmnhgpjleaapmmp`, pinned by the `key` in the manifest) so the companion can trust it. If you loaded an earlier build, Brave sees this as a new extension: your old sessions don't carry over, so export them first (dashboard, Export JSON) and import after.

## Use

1. Open your tabs: Google/AI, your book or article, your music.
2. Click the icon, pick which tab goes in each slot (it guesses), optionally name the session and set planned minutes, then **Start session**.
3. Your chosen tabs move into a **new maximized window** (the focus window). Your other tabs stay where they are, untouched and unclosed.
4. During a session:
   - **Window lock:** clicking into another Brave window snaps focus back to the focus window (and counts as a blocked attempt). Alt-tabbing to another app, such as Discord, is allowed. A slot tab dragged out of the focus window is moved back.
   - New tabs and windows close immediately. A link opened in a new tab from Research loads in the Research tab instead.
   - Music accepts only the music allowlist. Research accepts everything except the blocklist. Work stays on its page (or file) plus your extra domains. Blocked pages show a "stay focused" page and count as a blocked attempt.
   - Closed a slot tab? The popup shows the slot as empty with an Open button. That is the only way to open a tab mid-session.
   - **Pause** stops the timer but keeps restrictions on.
5. **End session** saves it and unlocks everything. Your tabs stay in the focus window; drag them back if you like.
   If you set planned minutes and end earlier, you must type "I am choosing to end my focus early", and the session is flagged.
   **Started one by mistake?** Click *End session*, then **Discard**: the session stops and **nothing is saved** (no history entry, no calendar time, no project time). A session with 5+ minutes of work asks for a second click so you can't discard real work by accident. Discard skips the "end early" sentence, since there's nothing to flag. The desktop app has the same button.
   Already saved one by mistake? Delete it later from the day list (dashboard or desktop app); project totals drop by that amount.
6. The calendar and settings are in the popup's "Calendar & settings" button (or the extension's options page). Settings are locked while a session runs, so you can't loosen the blocklist mid-session.

## Opening the desktop app with one click

- **From Brave:** the popup and the dashboard have an **Open desktop app** button. It needs the Windows companion (`companion\install.ps1`); a second click just brings the already-open window to the front.
- **From Windows:** the installer puts a **Focus Up** shortcut on your Desktop and in the Start menu. To pin it to the taskbar, open Start, find *Focus Up*, right-click and choose **Pin to taskbar** (Windows doesn't let a program pin itself).
- **At login:** run `powershell -ExecutionPolicy Bypass -File companion\install.ps1 -StartWithWindows` to open the app when you sign in to Windows (`uninstall.ps1` removes it).

Not possible: Brave's own start page can't launch a desktop program, and replacing the new-tab page would clash with the 3-tab limit during a session, so the toolbar button is the way.

## Cloud sync: use it on several computers

Sign in with an email on every computer and your **finished sessions and projects are shared**, so time from your work laptop counts in the same calendar, stats and project totals. It uses **your own free Supabase project**: your data lives in an account you control, not on anyone else's server.

### One-time setup (about 5 minutes)
1. Create a free account at **supabase.com** and make a **New project** (any name; remember the database password, though the extension never needs it). Wait for it to finish starting.
2. Open **SQL Editor → New query**, paste the whole of [`sync/supabase-setup.sql`](sync/supabase-setup.sql) and click **Run**. It is safe to run twice.
3. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key (newer dashboards call it the **publishable** key). **Never** use the *service_role* / *secret* key: it bypasses all security, and the extension refuses it.
4. In the extension: dashboard → **Account** tab → paste both → **Save**, then enter your email and a password → **Create account**. Supabase emails you a confirmation link (you can switch that off under *Authentication* if you prefer); click it, then **Sign in**.
5. **Recommended:** once your own accounts exist, turn off *Allow new users to sign up* in Supabase's *Authentication* settings. The anon key is not secret (it is inside your extension), and without this anyone who found it could register on your project.

### On the work laptop
Copy the `extension` folder over, load it unpacked (Brave, Chrome or Edge: extensions page → Developer mode → Load unpacked), open its dashboard → **Account**, paste the **same URL and key**, and sign in with the **same email**. Give the computer a name ("Work laptop") so history shows which computer recorded each session. The desktop app and the Windows companion are optional extras; the extension works on its own.

### How it behaves
- **What syncs:** finished sessions and the project tree. **Not synced:** settings and blocklists (a work laptop may need different ones), the running session, tabs.
- **When:** about 10 seconds after any change, every 5 minutes, when the browser starts, and on **Sync now**. Offline? Nothing is lost; it catches up when the connection is back.
- **Conflicts:** the newest edit wins. Deleting a session on one computer deletes it everywhere; deleting a project moves its sessions and subprojects up, everywhere. If you create the same project name on two computers before they've met, they are merged into the older one and no time is lost.
- **Desktop app:** it mirrors whatever the extension holds, so synced data appears there too.
- **Signing out** stops syncing and keeps everything on that computer. Signing in as a *different* account on a computer that holds data asks you first, because it would upload that data to the new account.

### What to know about privacy and limits
- Stored in your Supabase project: session names, times, durations, project names, and for each session the **site names** of its tabs and, for a local file in the Work tab, **the file's path** (for example the folder and name of your PDF). Each account can only read and write its own rows (Row Level Security).
- Your password is never stored; the sign-in tokens are kept in the browser profile **unencrypted**, like any extension data. Signing out removes them.
- **Honest limits:** the sync client is tested against a mock server that imitates Supabase, and the SQL script is tested in a real Postgres engine, but **it has not been run against a real Supabase project or two real computers**: the checklist below is how you verify it. If the *same* session is edited on two computers while both are offline, the one that syncs later wins. Free Supabase projects **pause after about a week of no use**; unpause it from the Supabase dashboard (your data is kept).

## Rest breaks

Long stretches without a break are bad for focus, so the extension makes you rest. On by default: after **50 minutes of focus** the session **pauses itself for 10 minutes**, and every **4th rest is a long one (20 minutes)**. All four numbers are editable in Settings → Rest reminders, with one-click presets (25 / 5, 50 / 10, 90 / 20), and you can switch it off.

- **The alert.** Windows banners are silenced during a session on purpose, so a small **rest window** opens in front with a countdown, a chime (best effort, see below) and a few suggestions. The desktop app also jumps to the front and beeps. The toolbar badge shows `rest`.
- **The timer really stops.** Rest time is saved as a pause, so it is **not counted as focus** in your totals, calendar or projects. Restrictions (3 tabs, blocklist, window lock) stay on during a rest.
- **When it ends** the session resumes by itself, the rest window says "Back to focus" and closes, and the focus window is brought back to the front.
- **Skipping.** *Skip this rest* or *Skip rest* (popup, rest window, desktop app) resumes immediately and starts a fresh stretch. *10 more minutes of focus* resumes and reminds you again in 10 minutes. Pressing Resume during a rest counts as a skip. Skipped rests are counted.
- **Manual pauses count.** If you pause by hand for at least the rest length, that counts as a rest and the clock restarts, so you aren't nagged straight after coming back.
- **History.** The day list shows how many rests a session had.
- If you had Pomodoro mode switched on in an earlier version, its focus/rest times carry over.

Limits: the chime may stay silent until you've clicked in the rest window (browser autoplay rules). The rest window can't be forced on top of other apps, and clicking another Brave window snaps you back to the focus window as usual. If the rest window is closed by hand, the rest still runs; the popup and the desktop app show the countdown.

## Projects and subprojects

Group your sessions into projects, and nest projects inside each other (Thesis → Chapter 2 → Figures). **Time on a subproject also counts toward every project above it**: a session on Figures grows Figures, Chapter 2 and Thesis. Each project shows a **Total** (itself plus everything beneath it) and, where relevant, its **Own** time (sessions assigned directly to it).

- **Start a session on a project:** the popup and the desktop app both have a *Project* dropdown with **+ New** (top-level) and **+ Sub** (a subproject of the selected project). The last project you used is pre-selected, so continuing is one click. A session with no name is named after its project.
- **Projects tab** (dashboard and desktop app): the tree with Total / This week / Own, plus add subproject, rename, move to another parent (never into itself or its own subprojects) and delete.
- **Deleting a project never loses time:** its subprojects and sessions move up to its parent (or to "no project"). If that makes two siblings share a name, the later one becomes "Name (2)".
- **Calendar filter:** show only one project (including its subprojects), or only sessions with no project. The heat-map, stats and day list all follow the filter.
- **Assign or change a session's project** afterwards from the day list (dashboard dropdown, or *Set project…* in the app). Sessions from before this feature simply start as "no project".
- **Export/import:** JSON export includes the project tree; CSV has a project path column (`Thesis › Chapter 2 › Figures`). Import merges projects by id and repairs cycles, missing parents and unknown project ids.

Names must be unique among siblings (case-insensitive), but the same name can exist under different parents.

## Desktop app

After running `companion\install.ps1` you get a **Focus Up** shortcut on the desktop and in the Start menu. It opens a window (pure Python + tkinter, nothing to install) that shows:

- the **live timer** (with a countdown to your next rest, or the rest itself), and **Pause / Resume / End** buttons (the pause button becomes **Skip rest** during a rest); ending early before your planned minutes asks for the same typed sentence as the popup;
- a **Start session** form with your open Brave tabs in dropdowns (it guesses the slots like the popup does);
- the **calendar** (month heat-map), week/streak/longest stats, the sessions of the selected day, and **Rename / Delete**.

If Brave isn't running, the window says so, shows the last synced calendar read-only, and offers an **Open Brave** button. Renaming/deleting needs Brave connected, because the extension holds the data.

How it connects: Brave keeps a long-lived connection to `host.py`; the host connects to the app over `127.0.0.1` with a random key stored in `%LOCALAPPDATA%\FocusUp\ipc.json` (readable only by your Windows account) and an HMAC handshake. Messages are JSON. Anything running as *your* user can read that key, which is the same trust level as the rest of your account.

## Windows companion

`companion/host.py` is a small Python program (standard library only, no pip installs). Brave starts it on demand through Native Messaging. It is not a background service and has no tray icon.

While a session runs (at start, once a minute, and after a browser restart) the extension asks it to:
1. **Turn Windows notification banners off.** It sets the registry value `HKCU\Software\Microsoft\Windows\CurrentVersion\PushNotifications\ToastEnabled` to 0, the switch behind Settings → System → Notifications → "Notifications". The previous value is saved to `%LOCALAPPDATA%\FocusUp\state.json` *before* the change and put back exactly when the session ends (if it was already off, it stays off).
2. **Politely close apps on your blocklist** (Settings → Blocked desktop apps, e.g. `Steam.exe`). It uses `taskkill` without `/F`, so apps may ask to save. Discord, Spotify, browsers, Explorer and system processes are on a hard-coded never-close list in `host.py`, whatever the blocklist says.

Install: `powershell -ExecutionPolicy Bypass -File companion\install.ps1` (per-user registry keys, no admin). Remove: `companion\uninstall.ps1` (also restores notifications). If something goes wrong: `python companion\host.py --restore`.

**Honest limits:**
- This is a registry switch, not an official Do Not Disturb API (Windows 11 has none). It silences banners from **all** apps, **including Discord**. Calls and voice are not affected, but you won't get a pop-up for an incoming call or message. Windows' own Do Not Disturb with a Discord exception can't be set reliably from a script.
- Whether the change applies instantly depends on your Windows build. Test it (checklist below). If it doesn't, the approach needs to change.
- Without the companion everything else still works; the popup says "browser-only mode".
- If your PC crashes mid-session, notifications stay off until the extension next starts (it restores them then) or you run `host.py --restore`.

## Permissions

| Permission | Why |
|---|---|
| `tabs` | See tab URLs/ids to assign slots and move them into the focus window |
| `webNavigation` | Check each navigation in a slot tab against its rules |
| `contentSettings` | Set the browser's notification setting to Block during a session |
| `scripting` | Inject the `Notification` override into pages |
| `storage` | Sessions, settings and live session state (all local) |
| `alarms` | Update the toolbar badge each minute; restart recovery; re-check blocked apps |
| `nativeMessaging` | Talk to the Windows companion (optional) |
| `<all_urls>` host access | Needed for `scripting` and for seeing tab URLs on every site |

## Design choices that differ from the brief

- **No `declarativeNetRequest`.** Every rule is per tab (Music vs Research vs Work), which DNR can't express, and DNR can't count blocked attempts outside developer mode. All blocking uses `webNavigation` plus `tabs.update` to a block page.
- Session state is stored with timestamps (start, pause intervals) and the elapsed time is recomputed every time. Nothing lives only in memory.

## Known limitations (read these)

- **You can always turn the extension off** at `brave://extensions`. This is a commitment tool, not a lock.
- **The desktop app only controls an open Brave.** Starting a session needs Brave running with the extension; the app can open Brave for you.
- **Windows notifications and apps** need the companion (see its limits above). Without it, Windows notifications and desktop apps are untouched.
- **Incognito/private windows** are invisible to the extension unless you enable it there, so they bypass the window lock.
- Tabs in your other windows keep running (loading, playing audio); you just can't switch to them.
- **Notification blocking:** the browser-level block is a rule on top of your own per-site settings; a site you explicitly allowed may still win. The page-level override is the second layer. After a session ends, already-open pages keep the override until reloaded.
- **Brave sidebar panels and Leo** show content without a tab; an extension can't see or restrict them. Leo is a fine AI assistant, since it doesn't use a tab.
- **Tab racing:** a blocked page may flash for a moment before the redirect lands.
- **After a browser restart** the slots are re-linked by matching each tab's site to where it last was, and pulled into one window. The extension waits 35 seconds for Brave to restore tabs first. If the restore is slower, tabs created in the meantime may be closed as new tabs.
- Dev note: a tab opened by a link from Research is only redirected if the browser reports the target URL when the tab is created.

## Recommended Brave settings

Also listed in Settings → bottom of the page: turn off Brave News, Rewards ad notifications, Wallet/Talk buttons and the sidebar.

## Manual test checklist (NOT yet run: needs Brave)

Nothing below has been executed in a real browser. The URL-rule and timer logic is covered by a Node test; everything else is untested.

- [ ] Load unpacked: no errors on the extensions page (check the service worker console)
- [ ] Start with 3 tabs chosen: they move to a new maximized window; all other tabs are still open in the old window; badge shows `0m`
- [ ] Click the old window / Ctrl+Alt+Tab between Brave windows: focus snaps back to the focus window
- [ ] Alt-tab to the Discord app and back: allowed, no snap-back
- [ ] Drag the Work tab out of the focus window: it returns
- [ ] Start with Research empty: a Google tab opens
- [ ] Pick a Reddit tab as Research: start is refused with a message
- [ ] Ctrl+T, Ctrl+N, middle-click a link: tab closes; blocked count rises
- [ ] Ctrl+click a result in the Research tab: it loads in the Research tab
- [ ] Music tab: go to reddit.com (blocked), then open.spotify.com (allowed)
- [ ] Research tab: youtube.com blocked, music.youtube.com allowed
- [ ] Music tab: youtube.com/watch and search work; the homepage, Shorts and feeds are blocked
- [ ] Work tab on a PDF/site: navigating to another site is blocked; "Lock Work to its current page" re-locks
- [ ] Close the Music tab: popup shows it empty; Open reopens it
- [ ] Visit a site that asks for notifications: no prompt, `Notification.permission === "denied"` in the console
- [ ] Pause/resume: timer freezes while paused; restrictions stay on
- [ ] Close and reopen the browser mid-session: timer is right, slots re-linked
- [ ] Reload the extension mid-session: session continues
- [ ] End with a planned goal not met: the phrase is required; session shows "ended early"
- [ ] End: restrictions lifted, window switching works again, session on the calendar with the right duration
- [ ] Calendar: heat shading, day list, rename, delete, streak/week stats
- [ ] Export JSON → delete a session → import: it comes back; export CSV opens in a spreadsheet
- [ ] Settings locked during a session; edits apply after it ends
- [ ] Repeat the main flow with Brave Shields up
- [ ] Projects: create Thesis, then a subproject Chapter 2 inside it, then Figures inside that (popup `+ New` / `+ Sub`)
- [ ] Projects: run a session on Figures and end it: Figures, Chapter 2 and Thesis all grew by that amount (dashboard Projects tab and the app's Projects tab)
- [ ] Projects: start another session: the last project is already selected
- [ ] Projects: rename, then move Figures directly under Thesis: totals update; moving Thesis into Figures is refused
- [ ] Projects: delete Chapter 2: Thesis total is unchanged and Figures sits under Thesis
- [ ] Projects: filter the calendar by Thesis: only its sessions (and subprojects') are shown; filter "No project" works
- [ ] Projects: change an old session's project from the day list: totals follow
- [ ] Projects: export JSON, delete a project, import: it comes back; CSV has the project path column
- [ ] Projects: a project made in the app shows in the popup and the dashboard, and the other way round
- [ ] App: open the Focus Up shortcut with Brave closed: "Brave isn't connected", calendar shows history, Open Brave works
- [ ] App: with Brave open, within a few seconds it says "Brave connected" and the tab dropdowns fill in
- [ ] App: Start session from the app: the focus window appears in Brave and the app shows the running timer
- [ ] App: Pause / Resume / End from the app match what the popup shows; the timer in both agrees
- [ ] App: end early with a planned goal: the sentence is required
- [ ] App: finished sessions appear in the calendar right away; Rename and Delete work and the extension dashboard agrees
- [ ] App: close the app mid-session: the session keeps running; reopen it and it picks the session back up
- [ ] App: close Brave mid-session: the app switches to "not connected" and back when Brave returns
- [ ] Companion: after install.ps1 and an extension reload, start a session: the popup says "Windows notifications off" and Settings → System → Notifications shows the top switch off
- [ ] Companion: trigger a Windows notification mid-session (e.g. an alarm or a test from another app): no banner. A Discord call or voice chat still works
- [ ] Companion: end the session: the Windows notifications switch is back to what it was
- [ ] Companion: add `Notepad.exe` to blocked apps, open Notepad mid-session: it closes within a minute; Discord, Brave and Spotify are never closed
- [ ] Companion: close Brave mid-session and reopen it: notifications are still off and the session continues; end it: restored
- [ ] Companion: run uninstall.ps1: the next session shows "browser-only mode"
- [ ] Open app: the **Open desktop app** button in the popup opens the app; clicking it again just brings the open window forward
- [ ] Open app: pin the Start-menu entry to the taskbar and start the app from there
- [ ] Sync: follow the setup steps; the Account tab says "Signed in as ..." and the first sync reports an upload
- [ ] Sync: in the Supabase dashboard's Table Editor you can see rows in `focus_records` after a session
- [ ] Sync: on the second computer, sign in with the same email; the sessions and projects from the first appear
- [ ] Sync: record a session on the work laptop; it shows up on the home computer within a few minutes (or on Sync now), project totals include it
- [ ] Sync: delete a session on one computer; it disappears on the other
- [ ] Sync: turn Wi-Fi off, finish a session, turn it back on: it uploads by itself
- [ ] Sync: create the same project name on both computers before syncing; afterwards there is one
- [ ] Sync: paste the secret/service_role key by mistake: it is refused
- [ ] Discard: start a session, click End session, then Discard (under 5 min): it stops at once and nothing appears in the calendar or in project totals
- [ ] Discard: after 5+ minutes it asks "Really discard …?" first; Keep going cancels and disarms it
- [ ] Discard from the desktop app: confirm dialog, then the session stops and nothing is saved
- [ ] Discard during a rest: the rest window closes, notifications and restrictions are lifted, parked state is clean
- [ ] Delete a saved session from the day list: it disappears from the calendar, stats and its project's total
- [ ] Rests: set rest after 1 min and rest for 1 min in Settings, start a session: after a minute the rest window opens in front, the badge says `rest`, the timer freezes
- [ ] Rests: the chime plays (or note that it doesn't until you click), the desktop app jumps to the front
- [ ] Rests: after the rest minute the session resumes by itself, the window says "Back to focus" and closes, the focus window is in front
- [ ] Rests: *10 more minutes of focus* resumes now and the next rest comes 10 minutes later; *Skip this rest* resumes now with a full new stretch
- [ ] Rests: *Skip rest* in the popup and in the desktop app both work
- [ ] Rests: end the session during a rest: the rest window closes and the saved focus time excludes the rest
- [ ] Rests: a manual pause longer than the rest length: no rest appears right after resuming
- [ ] Rests: switch them off in Settings: no rest ever starts
