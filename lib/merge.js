// Pure merge helpers for cloud sync (last-write-wins per record). Records from the server are never "dirty".
function mergeLogs(local, remote) {
  const by = new Map(local.map(l => [l.id, l])); let changed = 0;
  for (const r of remote) {
    const rec = { id: r.id, ts: r.ts, amount: r.amount, source: r.source, deleted: !!r.deleted, updatedAt: r.updatedAt, dirty: false };
    const l = by.get(r.id);
    if (!l) { local.push(rec); by.set(r.id, rec); changed++; }
    else if (r.updatedAt > l.updatedAt) { Object.assign(l, rec); changed++; }
  }
  return changed;
}
function mergeEvents(local, remote) {
  const ids = new Set(local.map(e => e.id)); let changed = 0;
  for (const r of remote) if (!ids.has(r.id)) { local.push({ id: r.id, ts: r.ts, outcome: r.outcome, dirty: false }); ids.add(r.id); changed++; }
  return changed;
}
module.exports = { mergeLogs, mergeEvents };
