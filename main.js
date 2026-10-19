const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, nativeTheme, Notification, shell, safeStorage } = require('electron');
const { mergeLogs, mergeEvents } = require('./lib/merge');
const { pathToFileURL } = require('url');
const fs = require('fs');
const path = require('path');
const { dayAt, dayKey, inWork, nextAfter } = require('./lib/schedule');

const DEFAULTS = {
  name: '', interval: 45, snooze: 10, workStart: '09:00', workEnd: '18:00', goal: 2000, defaultAmount: 250,
  scheduleMode: 'relative', dismissPolicy: 'interval', timeout: 60, color: 0, size: 1, speed: 1,
  position: 'bottom', sound: true, celebrationSound: 'fanfare', celebration: 'bottle', theme: 'system', autoLaunch: false,
  buddyEnabled: true, startHidden: true, messages: '', character: 'custom:MyBuddy'
};
const MESSAGES = ['Hey! 💧 Time for a water break!', "You've been working for a while. Take a quick sip!",
  'Psst, {name}! Your water bottle misses you.', 'Hydration check! 💧', 'Sip sip hooray! Ready for some water?'];
const FOREVER = 8e15;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
// ---------- persistence (JSON file in the user-data folder) ----------
app.setPath('userData', path.join(app.getPath('appData'), 'HydroBuddy')); // same data folder in dev and installed builds
const file = () => path.join(app.getPath('userData'), 'hydrobuddy.json');
let db;
function load() {
  try { db = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { db = {}; }
  db.settings = { ...DEFAULTS, ...(db.settings || {}) };
  db.logs = db.logs || []; db.events = db.events || []; db.cloud = db.cloud || {}; db.settingsUpdatedAt = db.settingsUpdatedAt || 0;
  db.logs.forEach(l => { l.updatedAt = l.updatedAt || l.ts; }); db.events.forEach(e => { e.id = e.id || uid(); }); // migrate older data
  db.state = db.state || {}; db.onboarded = !!db.onboarded;
}
function persist() {
  const tmp = file() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, file()); // atomic write
}
function save() { persist(); broadcast(); queueSync(); }
const S = () => db.settings;

// ---------- custom characters: characters/<name>/<pose>.png ----------
const POSES = ['idle', 'walk', 'run', 'jump', 'sad', 'celebrate', 'wave', 'happy']; // only idle is required
const userChars = () => path.join(app.getPath('userData'), 'characters');
function listCharacters() {
  const out = [];
  const bundled = app.isPackaged ? path.join(process.resourcesPath, 'characters') : path.join(__dirname, 'characters');
  for (const root of [userChars(), bundled]) {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch {}
    for (const name of names) {
      const poses = {};
      for (const p of POSES) for (const ext of ['png', 'webp', 'gif']) {
        const f = path.join(root, name, `${p}.${ext}`);
        if (fs.existsSync(f)) { poses[p] = pathToFileURL(f).href; break; }
      }
      if (poses.idle && !out.some(o => o.name === name)) out.push({ name, poses });
    }
  }
  return out;
}
ipcMain.handle('list-characters', () => ({ list: listCharacters().map(c => c.name), folder: userChars() }));
ipcMain.handle('open-characters-folder', () => { fs.mkdirSync(userChars(), { recursive: true }); return shell.openPath(userChars()); });

// ---------- windows ----------
let dash, buddy, tray, reminderActive = false, quitting = false;
const startHidden = process.argv.includes('--hidden');
function applyLoginItem() { // only meaningful in the installed app (in dev it would register electron.exe)
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!S().autoLaunch, path: process.execPath, args: S().startHidden ? ['--hidden'] : [] });
}
function openDashboard() {
  if (dash && !dash.isDestroyed()) { dash.show(); dash.focus(); return; }
  dash = new BrowserWindow({ width: 980, height: 700, minWidth: 760, minHeight: 560, title: 'HydroBuddy', icon: path.join(__dirname, 'assets/icon.png'),
    autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  dash.loadFile('dashboard.html');
  dash.on('close', () => { // first time the window is closed, explain that the app keeps running
    if (quitting || db.trayHintShown) return;
    db.trayHintShown = true; persist();
    new Notification({ title: 'HydroBuddy is still running', body: 'It lives in the system tray (near the clock). Right-click the icon to pause or quit.' }).show();
  });
}
function broadcast() {
  for (const w of BrowserWindow.getAllWindows()) if (w === dash && !w.isDestroyed()) w.webContents.send('state', getState());
  buildTray();
}
function getState() {
  const k = dayKey(Date.now());
  const logs = db.logs.filter(l => !l.deleted && dayKey(l.ts) === k);
  return { settings: S(), onboarded: db.onboarded, today: { total: logs.reduce((a, l) => a + l.amount, 0), logs },
    nextDue: db.state.nextDue, pausedUntil: db.state.pausedUntil, skipToday: db.state.skipDate === k,
    cloud: { loggedIn: cloudOn(), email: db.cloud.email || '', url: db.cloud.url || '', last: db.cloud.lastSync || null, status: cloudInfo.status, error: cloudInfo.error } };
}

// ---------- reminder engine ----------
function schedule(from = Date.now()) { db.state.nextDue = nextAfter(from, S()); }
function tick() {
  const st = db.state, now = Date.now();
  if (reminderActive) return;
  if (st.pausedUntil) {
    if (now < st.pausedUntil) return;
    st.pausedUntil = null; schedule(now); save(); return; // resume
  }
  if (st.skipDate === dayKey(now)) return;
  if (!st.nextDue) { schedule(now); save(); }
  if (now < st.nextDue) return;
  // Overdue (restart / wake from sleep): fire ONCE; if outside work hours just reschedule.
  if (!inWork(now, S())) { schedule(now); save(); return; }
  showReminder();
}
function pickMessage() {
  const custom = S().messages.split('\n').map(s => s.trim()).filter(Boolean);
  const list = custom.length ? custom : MESSAGES;
  return list[Math.floor(Math.random() * list.length)].replace('{name}', S().name || 'friend');
}
function targetDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}
function showReminder() {
  if (reminderActive) return;
  reminderActive = true;
  if (!S().buddyEnabled) { // fallback: native notification
    const n = new Notification({ title: 'HydroBuddy 💧', body: pickMessage() });
    n.on('click', openDashboard); n.show();
    addEvent('notified'); schedule(); save(); reminderActive = false; return;
  }
  const wa = targetDisplay().workArea, H = 380;
  const y = S().position === 'top' ? wa.y : S().position === 'middle' ? wa.y + Math.round((wa.height - H) / 2) : wa.y + wa.height - H;
  buddy = new BrowserWindow({ x: wa.x, y, width: wa.width, height: H, transparent: true, frame: false, resizable: false, movable: false,
    hasShadow: false, skipTaskbar: true, focusable: false, alwaysOnTop: true, show: false, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  buddy.setAlwaysOnTop(true, 'screen-saver');
  buddy.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform !== 'linux') buddy.setIgnoreMouseEvents(true, { forward: true });
  buddy.loadFile('buddy.html');
  buddy.webContents.once('did-finish-load', () => {
    const custom = S().character.startsWith('custom:') ? listCharacters().find(c => 'custom:' + c.name === S().character) : null;
    buddy.webContents.send('start', { message: pickMessage(), settings: { ...S(), character: custom ? 'custom' : (S().character.startsWith('custom:') ? 'striker' : S().character) },
      custom: custom || null, amounts: [150, 250, 500] });
    buddy.showInactive();
  });
  buddy.on('closed', () => { buddy = null; reminderActive = false; });
}

ipcMain.on('buddy-respond', (_e, { action, amount }) => {
  const now = Date.now();
  addEvent(action);
  if (action === 'drink') { db.logs.push({ id: uid(), ts: now, amount: amount || S().defaultAmount, source: 'buddy', updatedAt: now, dirty: true }); schedule(now); }
  else if (action === 'snooze' || (action !== 'drink' && S().dismissPolicy === 'snooze')) db.state.nextDue = now + S().snooze * 60000;
  else schedule(now); // dismiss / missed -> regular schedule
  save();
});
ipcMain.on('buddy-finished', () => { if (buddy && !buddy.isDestroyed()) buddy.close(); });
ipcMain.on('buddy-ignore-mouse', (_e, ignore) => {
  if (buddy && !buddy.isDestroyed() && process.platform !== 'linux') buddy.setIgnoreMouseEvents(ignore, { forward: true });
});

// ---------- dashboard IPC ----------
ipcMain.handle('get-state', getState);
ipcMain.handle('get-data', () => ({ logs: db.logs.filter(l => !l.deleted), events: db.events }));
ipcMain.handle('set-settings', (_e, patch) => {
  const old = S(); db.settings = { ...old, ...patch }; db.settingsUpdatedAt = Date.now(); db.settingsDirty = true;
  if (patch.onboarded) db.onboarded = true;
  if (['interval', 'workStart', 'workEnd', 'scheduleMode'].some(k => patch[k] !== undefined && patch[k] !== old[k])) schedule();
  nativeTheme.themeSource = S().theme;
  applyLoginItem();
  save();
});
ipcMain.handle('onboarded', () => { db.onboarded = true; schedule(); save(); });
ipcMain.handle('add-log', (_e, amount) => { const now = Date.now(); db.logs.push({ id: uid(), ts: now, amount, source: 'manual', updatedAt: now, dirty: true }); save(); });
ipcMain.handle('edit-log', (_e, id, amount) => { const l = db.logs.find(x => x.id === id); if (l) { l.amount = amount; l.updatedAt = Date.now(); l.dirty = true; } save(); });
ipcMain.handle('delete-log', (_e, id) => { const l = db.logs.find(x => x.id === id); if (l) { l.deleted = true; l.updatedAt = Date.now(); l.dirty = true; } save(); }); // tombstone so deletes sync
ipcMain.handle('test-buddy', () => showReminder());
ipcMain.handle('pause', (_e, v) => pause(v));
ipcMain.handle('skip-today', (_e, on) => { db.state.skipDate = on ? dayKey(Date.now()) : null; save(); });
function pause(v) { // v: minutes | 'day' | 'forever' | null (resume)
  const now = Date.now();
  db.state.pausedUntil = v === null ? null : v === 'day' ? dayAt(now, '23:59') : v === 'forever' ? FOREVER : now + v * 60000;
  if (v === null) schedule(now);
  save();
}


// ---------- cloud account + sync (Phase 5) ----------
const cloudInfo = { status: 'idle', error: '' };  // idle | syncing | ok | offline | auth
const cloudOn = () => !!(db.cloud.url && db.cloud.token);
const addEvent = outcome => db.events.push({ id: uid(), ts: Date.now(), outcome, dirty: true });
function storeToken(t) {
  if (safeStorage.isEncryptionAvailable()) { db.cloud.token = safeStorage.encryptString(t).toString('base64'); db.cloud.enc = true; }
  else { db.cloud.token = t; db.cloud.enc = false; }
}
function readToken() {
  try { return db.cloud.enc ? safeStorage.decryptString(Buffer.from(db.cloud.token, 'base64')) : db.cloud.token; } catch { return null; }
}
async function api(base, route, body, token) {
  let res;
  try {
    res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  } catch { const e = new Error('Cannot reach the server'); e.offline = true; throw e; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error || `Server error (${res.status})`); e.auth = res.status === 401 && !!token; throw e; }
  return json;
}
function cleanUrl(u) {
  let url; try { url = new URL(String(u).trim()); } catch { throw new Error('Enter a valid server URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('Use https:// for remote servers');
  return url.origin;
}
async function cloudAuth({ url, email, password, name, register }) {
  const base = cleanUrl(url);
  const r = await api(base, register ? '/api/auth/register' : '/api/auth/login', { email, password, name });
  db.cloud = { url: base, email: r.user.email, since: 0 }; storeToken(r.token);
  db.logs.forEach(l => { l.dirty = true; }); db.events.forEach(e => { e.dirty = true; }); // upload existing local history once
  if (register) { db.settingsDirty = true; db.settingsUpdatedAt = db.settingsUpdatedAt || Date.now(); } else { db.settingsUpdatedAt = 0; db.settingsDirty = false; } // existing account: its settings win
  cloudInfo.status = 'idle'; cloudInfo.error = ''; save(); syncNow();
}
function cloudLogout() { db.cloud = {}; cloudInfo.status = 'idle'; cloudInfo.error = ''; save(); } // local data stays on this PC
let syncing = false, syncTimer = null;
function queueSync() { if (!cloudOn()) return; clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 4000); }
const strip = ({ dirty, ...rest }) => rest;
async function syncNow() {
  if (!cloudOn() || syncing) return;
  const token = readToken();
  if (!token) { cloudInfo.status = 'auth'; cloudInfo.error = 'Please log in again'; return broadcast(); }
  syncing = true; cloudInfo.status = 'syncing'; broadcast();
  try {
    const pushLogs = db.logs.filter(l => l.dirty).slice(0, 1000), pushEvents = db.events.filter(e => e.dirty).slice(0, 1000);
    const snap = new Map(pushLogs.map(l => [l.id, l.updatedAt])), sendSettings = db.settingsDirty;
    let more = true, round = 0;
    while (more && round++ < 10) {
      const r = await api(db.cloud.url, '/api/sync', {
        since: db.cloud.since || 0, logs: round === 1 ? pushLogs.map(strip) : [], events: round === 1 ? pushEvents.map(strip) : [],
        settings: round === 1 && sendSettings ? exportSettings() : undefined, settingsUpdatedAt: db.settingsUpdatedAt }, token);
      if (round === 1) { // pushed OK: clear dirty flags (unless edited again meanwhile)
        for (const l of pushLogs) if (l.updatedAt === snap.get(l.id)) l.dirty = false;
        for (const e of pushEvents) e.dirty = false;
        if (sendSettings) db.settingsDirty = false;
      }
      mergeLogs(db.logs, r.logs); mergeEvents(db.events, r.events);
      if (r.settings && r.settingsUpdatedAt > db.settingsUpdatedAt) {
        db.settings = { ...db.settings, ...r.settings, autoLaunch: db.settings.autoLaunch }; db.settingsUpdatedAt = r.settingsUpdatedAt;
        nativeTheme.themeSource = S().theme; schedule();
      }
      db.cloud.since = r.serverTime; more = r.more;
    }
    db.cloud.lastSync = Date.now(); cloudInfo.status = 'ok'; cloudInfo.error = ''; persist();
    if (db.logs.some(l => l.dirty) || db.events.some(e => e.dirty)) setTimeout(syncNow, 1000); // more than 1000 pending
  } catch (e) {
    cloudInfo.status = e.auth ? 'auth' : 'offline'; cloudInfo.error = e.auth ? 'Session expired — please log in again' : e.message;
  } finally { syncing = false; broadcast(); }
}
function exportSettings() { const { autoLaunch, ...rest } = S(); return rest; } // autoLaunch is per-device
ipcMain.handle('cloud-auth', async (_e, p) => { try { await cloudAuth(p); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('cloud-logout', () => cloudLogout());
ipcMain.handle('cloud-sync', () => syncNow());

// ---------- tray ----------
function buildTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets/tray.png')).resize({ width: 18, height: 18 }));
    tray.on('click', openDashboard);
  }
  const paused = db.state.pausedUntil && Date.now() < db.state.pausedUntil;
  tray.setToolTip(paused ? 'HydroBuddy — paused' : db.state.nextDue ? 'HydroBuddy — next reminder ' + new Date(db.state.nextDue).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'HydroBuddy');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open dashboard', click: openDashboard },
    { label: 'Show buddy now', click: showReminder },
    { type: 'separator' },
    paused ? { label: 'Resume reminders', click: () => pause(null) } : { label: 'Pause reminders', submenu: [
      { label: '30 minutes', click: () => pause(30) }, { label: '1 hour', click: () => pause(60) },
      { label: 'Rest of today', click: () => pause('day') }, { label: 'Until I resume', click: () => pause('forever') }] },
    { label: 'Buddy visible', type: 'checkbox', checked: S().buddyEnabled, click: m => { db.settings.buddyEnabled = m.checked; save(); } },
    { label: 'Start with Windows', type: 'checkbox', checked: !!S().autoLaunch, click: m => { db.settings.autoLaunch = m.checked; applyLoginItem(); save(); } },
    { label: 'Sound effects', type: 'checkbox', checked: S().sound, click: m => { db.settings.sound = m.checked; save(); } },
    { type: 'separator' },
    { label: 'Quit HydroBuddy', click: () => { quitting = true; app.quit(); } }
  ]));
}

// ---------- app lifecycle ----------
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache'); // avoids Windows "Unable to move the cache" noise
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => { if (app.isReady()) openDashboard(); });
app.on('window-all-closed', e => { if (!quitting) e.preventDefault(); }); // keep running in the tray
if (gotLock) app.whenReady().then(() => {
  load(); nativeTheme.themeSource = S().theme;
  // Fresh start: don't pop the buddy the instant Windows boots just because a reminder was "due" while the PC was off.
  if (db.state.nextDue && db.state.nextDue < Date.now()) { schedule(); persist(); }
  applyLoginItem(); buildTray();
  if (!startHidden || !db.onboarded) openDashboard(); // launched at login -> stay in the tray (but always show on first run)
  setInterval(tick, 10000);
  setTimeout(syncNow, 2000); setInterval(syncNow, 5 * 60 * 1000);
  require('electron').powerMonitor.on('resume', () => setTimeout(() => { tick(); syncNow(); }, 3000));
});
