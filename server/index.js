require('dotenv').config();
const express = require('express'), mongoose = require('mongoose'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const helmet = require('helmet'), cors = require('cors'), rateLimit = require('express-rate-limit');

const { MONGODB_URI = 'mongodb://127.0.0.1:27017/hydrobuddy', JWT_SECRET, PORT = 4000 } = process.env;
if (!JWT_SECRET || JWT_SECRET.length < 16) { console.error('Set JWT_SECRET (16+ chars) in server/.env'); process.exit(1); }

// ---------- models ----------
const { Schema } = mongoose;
const User = mongoose.model('User', new Schema({
  email: { type: String, unique: true, required: true, lowercase: true, trim: true },
  name: String, passwordHash: { type: String, required: true },
  settings: { type: Schema.Types.Mixed, default: null }, settingsUpdatedAt: { type: Number, default: 0 }, settingsServerAt: { type: Number, default: 0 }
}, { timestamps: true }));

const logSchema = new Schema({ user: { type: Schema.Types.ObjectId, required: true }, id: String, ts: Number, amount: Number, source: String,
  deleted: { type: Boolean, default: false }, updatedAt: Number, serverAt: Number });
logSchema.index({ user: 1, id: 1 }, { unique: true }); logSchema.index({ user: 1, serverAt: 1 });
const Log = mongoose.model('Log', logSchema);

const eventSchema = new Schema({ user: { type: Schema.Types.ObjectId, required: true }, id: String, ts: Number, outcome: String, serverAt: Number });
eventSchema.index({ user: 1, id: 1 }, { unique: true }); eventSchema.index({ user: 1, serverAt: 1 });
const Event = mongoose.model('Event', eventSchema);

// ---------- helpers ----------
const ah = fn => (req, res, next) => fn(req, res, next).catch(next);
const inRange = (v, a, b) => typeof v === 'number' && Number.isFinite(v) && v >= a && v <= b;
const OUTCOMES = ['drink', 'snooze', 'dismiss', 'missed', 'notified'];
const cleanLog = l => (l && typeof l.id === 'string' && l.id.length <= 64 && inRange(l.ts, 0, 4e12) && inRange(l.amount, 0, 10000) && inRange(l.updatedAt, 0, 4e12))
  ? { id: l.id, ts: l.ts, amount: l.amount, source: String(l.source || 'manual').slice(0, 16), deleted: !!l.deleted, updatedAt: l.updatedAt } : null;
const cleanEvent = e => (e && typeof e.id === 'string' && e.id.length <= 64 && inRange(e.ts, 0, 4e12) && OUTCOMES.includes(e.outcome)) ? { id: e.id, ts: e.ts, outcome: e.outcome } : null;
function cleanSettings(s) { // flat key/value only, safe key names (no Mongo operators)
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (!/^[A-Za-z]{1,32}$/.test(k)) continue;
    if (typeof v === 'string' && v.length <= 2000 || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  return out;
}
const sign = u => jwt.sign({ sub: String(u._id) }, JWT_SECRET, { expiresIn: '60d' });
const publicUser = u => ({ email: u.email, name: u.name });
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try { req.uid = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', JWT_SECRET).sub; next(); }
  catch { res.status(401).json({ error: 'Not logged in' }); }
}

// ---------- app ----------
const app = express();
app.use(helmet()); app.use(cors()); app.use(express.json({ limit: '2mb' }));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 600 }));
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, message: { error: 'Too many attempts, try again later' } });

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/register', authLimit, ah(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return res.status(400).json({ error: 'Enter a valid email' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) return res.status(400).json({ error: 'Password must be 8–200 characters' });
  if (await User.exists({ email: email.toLowerCase().trim() })) return res.status(409).json({ error: 'Email already registered' });
  const u = await User.create({ email, name: typeof name === 'string' ? name.slice(0, 60) : '', passwordHash: await bcrypt.hash(password, 12) });
  res.status(201).json({ token: sign(u), user: publicUser(u) });
}));

app.post('/api/auth/login', authLimit, ah(async (req, res) => {
  const { email, password } = req.body || {};
  const u = typeof email === 'string' && typeof password === 'string' ? await User.findOne({ email: email.toLowerCase().trim() }) : null;
  if (!u || !(await bcrypt.compare(password, u.passwordHash))) return res.status(401).json({ error: 'Wrong email or password' });
  res.json({ token: sign(u), user: publicUser(u) });
}));

app.get('/api/me', auth, ah(async (req, res) => {
  const u = await User.findById(req.uid); if (!u) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: publicUser(u) });
}));

// Delta sync. Client pushes its changed records; server returns everything changed since `since`.
// Conflict rule: per-record last-write-wins on the client's updatedAt. Deletes are tombstones (deleted:true).
app.post('/api/sync', auth, ah(async (req, res) => {
  const now = Date.now(), uid = new mongoose.Types.ObjectId(req.uid), b = req.body || {};
  const since = inRange(b.since, 0, 4e12) ? b.since : 0;
  const logs = (Array.isArray(b.logs) ? b.logs.slice(0, 2000) : []).map(cleanLog).filter(Boolean);
  const events = (Array.isArray(b.events) ? b.events.slice(0, 2000) : []).map(cleanEvent).filter(Boolean);

  if (logs.length) {
    const existing = await Log.find({ user: uid, id: { $in: logs.map(l => l.id) } }, 'id updatedAt').lean();
    const have = new Map(existing.map(e => [e.id, e.updatedAt]));
    const ops = logs.filter(l => !have.has(l.id) || l.updatedAt > have.get(l.id))
      .map(l => ({ updateOne: { filter: { user: uid, id: l.id }, update: { $set: { ...l, serverAt: now } }, upsert: true } }));
    if (ops.length) await Log.bulkWrite(ops, { ordered: false });
  }
  if (events.length) await Event.bulkWrite(events.map(e => ({ updateOne: { filter: { user: uid, id: e.id }, update: { $setOnInsert: { ...e, serverAt: now } }, upsert: true } })), { ordered: false });

  const user = await User.findById(uid);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  const incoming = cleanSettings(b.settings);
  if (incoming && inRange(b.settingsUpdatedAt, 1, 4e12) && b.settingsUpdatedAt > user.settingsUpdatedAt) {
    user.settings = incoming; user.settingsUpdatedAt = b.settingsUpdatedAt; user.settingsServerAt = now; await user.save();
  }

  const LIMIT = 5000;
  const outLogs = await Log.find({ user: uid, serverAt: { $gt: since } }, '-_id id ts amount source deleted updatedAt serverAt').sort({ serverAt: 1 }).limit(LIMIT).lean();
  const outEvents = await Event.find({ user: uid, serverAt: { $gt: since } }, '-_id id ts outcome serverAt').sort({ serverAt: 1 }).limit(LIMIT).lean();
  const more = outLogs.length === LIMIT || outEvents.length === LIMIT;
  const lastAt = Math.min(outLogs.length === LIMIT ? outLogs[LIMIT - 1].serverAt : Infinity, outEvents.length === LIMIT ? outEvents[LIMIT - 1].serverAt : Infinity);
  res.json({
    logs: outLogs, events: outEvents, more,
    serverTime: more ? lastAt : now - 5000, // 5s overlap is safe: merges are idempotent
    settings: user.settingsServerAt > since ? user.settings : null, settingsUpdatedAt: user.settingsUpdatedAt
  });
}));

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });

mongoose.connect(MONGODB_URI).then(() => {
  app.listen(PORT, () => console.log(`HydroBuddy server on http://localhost:${PORT}`));
}).catch(e => { console.error('MongoDB connection failed:', e.message); process.exit(1); });
