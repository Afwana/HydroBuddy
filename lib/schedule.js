// Pure scheduling helpers (no Electron) so they can be unit-tested.
const toMin = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const dayAt = (ts, hhmm) => { const d = new Date(ts), m = toMin(hhmm); d.setHours(Math.floor(m / 60), m % 60, 0, 0); return d.getTime(); };
const dayKey = ts => new Date(ts).toLocaleDateString('en-CA');
const inWork = (ts, s) => ts >= dayAt(ts, s.workStart) && ts <= dayAt(ts, s.workEnd);

// Next reminder time after `from`. 'relative' = from + interval; 'fixed' = clock slots from work start.
function nextAfter(from, s) {
  const iv = s.interval * 60000, start = dayAt(from, s.workStart), end = dayAt(from, s.workEnd);
  let c = s.scheduleMode === 'fixed' ? start + Math.max(Math.floor((from - start) / iv) + 1, 1) * iv : from + iv;
  if (c < start) c = start + iv;
  if (c > end) { const t = new Date(start); t.setDate(t.getDate() + 1); c = dayAt(t.getTime(), s.workStart) + iv; }
  return c;
}
module.exports = { dayAt, dayKey, inWork, nextAfter };
