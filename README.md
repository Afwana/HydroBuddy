# HydroBuddy 💧 — animated desktop hydration companion

A little water-drop buddy runs in from the left, asks you to drink, and reacts to your choice:

* **Remind me later** → sad face, walks off left, snoozes.
* **I'll take it!** → runs right, jumps, lifts a water bottle overhead like a trophy ("CAMPEÓN!"; the "Siuuu" pose is a setting), says "Byeee!", exits right, logs the drink.

## Run it
```bash
npm install
npm start        # opens the dashboard; click "Test the buddy" to see the animation
npm test         # unit tests for the scheduling logic
npm run dist     # build a Windows installer (electron-builder)
```
Requires Node 18+. Closing the dashboard keeps HydroBuddy running in the system tray.

## Layout
| File | Purpose |
| --- | --- |
| `main.js` | Electron main process: JSON storage, reminder scheduler, tray, windows, IPC |
| `lib/schedule.js` | Pure scheduling logic (work hours, relative/fixed intervals) |
| `buddy.html` | Transparent always-on-top window: character, animation state machine, sounds |
| `dashboard.html` | Home / History / Insights / Settings UI |
| `preload.js` | Safe IPC bridge (contextIsolation on) |

Data is stored in `hydrobuddy.json` inside Electron's user-data folder.

## Design notes
* The buddy window is a transparent strip across the chosen display, click-through except over the buttons, so the buddy can run across the screen while the reminder buttons stay fixed.
* Buttons lock the instant one is clicked, so sad and happy animations can't both run. The drink is logged on click, not at the end of the animation.
* Scheduler is restart-safe: one persisted `nextDue`, fires once if overdue (wake from sleep), never piles up.
* Sounds are synthesized with WebAudio — no audio files. The character is original cartoon art, not a likeness of anyone.

## Not built yet (from your roadmap)
* Phase 5: Express/MongoDB auth + sync (the JSON store in `main.js` is the seam to replace)
* Dragging the buddy (position is a Top/Middle/Bottom setting for now), Lottie/Rive skins and costumes
* Automatic fullscreen/meeting detection (use tray → Pause, or "Off for today")
* Linux: transparency/click-through support varies by desktop environment

## Custom characters
Add `characters/<name>/idle.png` (required) plus optional `run`, `jump`, `sad`, `celebrate`, `wave`, `happy` images
(transparent PNG/WebP/GIF). Pick the character in Settings → Character; "Open characters folder" opens the per-user folder.
Only use artwork you have the rights to. The bundled `characters/MyBuddy` is your uploaded artwork (background removed, trimmed).

## Cloud account & sync (Phase 5, optional)
The app works fully offline. To sync between PCs, run the server and sign in from the **Account** tab.

```bash
cd server
npm install
cp .env.example .env          # set JWT_SECRET (see the comment inside)
docker compose up -d          # local MongoDB (or put a MongoDB Atlas URI in .env)
npm start                     # http://localhost:4000
```
* Delta sync every 5 minutes, ~4 s after any change, on wake from sleep, and via **Sync now**. Offline changes queue up and upload later.
* Conflicts: last write wins per drink log; deletes sync as tombstones. Settings sync too, except "start at login" (per-device).
* Passwords are bcrypt-hashed; sessions use a 60-day JWT, stored on the PC with the OS keychain encryption (Electron `safeStorage`).
* Deploy the server behind **https** for real use; the app refuses plain http to non-localhost servers.
* Not included: password reset, email verification, account deletion.

## Build the Windows installer (Phase 6)
```bash
npm install
npm run dist      # creates dist/HydroBuddy-Setup-<version>.exe
npm run pack      # optional: unpacked build in dist/win-unpacked for a quick test
```
* If the build fails with "Cannot create symbolic link", turn on Windows **Developer Mode** (Settings → For developers) or run the terminal as Administrator, then retry.
* The installer is unsigned, so Windows SmartScreen shows "unknown publisher" (More info → Run anyway). A code-signing certificate removes this.
* Launch at login only works in the installed app (not `npm start`). With "Start minimized to the tray" on, it starts silently in the tray.
