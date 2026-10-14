// allow: if not empty, only matches pass. deny: matches are dropped.
// A broken regex never matches (better one notification too many than one lost).
const hit = (list, s) => list.some((r) => { try { return new RegExp(r, 'i').test(s); } catch { return false; } });

exports.passes = (svc, title, body) => {
  const s = `${title}\n${body}`;
  if (hit(svc.deny || [], s)) return false;
  return !(svc.allow || []).length || hit(svc.allow, s);
};

// Quiet hours: q = { on, from: 'HH:MM', to: 'HH:MM' }. If from > to the range crosses midnight.
const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
exports.inQuiet = (q, d = new Date()) => {
  if (!q.on) return false;
  const now = d.getHours() * 60 + d.getMinutes(), a = mins(q.from), b = mins(q.to);
  return a <= b ? now >= a && now < b : now >= a || now < b;
};

if (require.main === module) {
  const assert = require('assert');
  assert(exports.passes({}, 'a', 'b'));
  assert(!exports.passes({ deny: ['promo'] }, 'Promo!', ''));
  assert(exports.passes({ allow: ['mamma'] }, 'Mamma', 'ciao'));
  assert(!exports.passes({ allow: ['mamma'] }, 'Spam', 'ciao'));
  assert(exports.passes({ deny: ['('] }, 'x', 'y'));
  const at = (h, m) => new Date(2026, 0, 1, h, m);
  const night = { on: true, from: '22:00', to: '08:00' };
  assert(exports.inQuiet(night, at(23, 0)) && exports.inQuiet(night, at(7, 59)));
  assert(!exports.inQuiet(night, at(8, 0)) && !exports.inQuiet(night, at(12, 0)));
  assert(!exports.inQuiet({ ...night, on: false }, at(23, 0)));
  console.log('filter ok');
}
