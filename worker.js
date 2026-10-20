// watchreading - a live "Currently Watching / Reading" card for your AniList bio.
// This whole file is the card. Paste it into a Cloudflare Worker (see README.md).
// Nothing in here needs changing.
//
//   /             a check page: what works, what is missing, the line for your bio
//   /card.svg     the card (drawn fresh on every view, so countdowns are always current)
//                 ?rows=1..10  ?only=anime|manga  ?theme=dark|light  ?accent=ff6b9d
//   /status       the same facts as the check page, as JSON
//   POST /update  your list, sent by the Tampermonkey script or the GitHub job (needs the key)
//   POST /cover   one cover picture (needs the key)
//
// Optional Worker variables (Settings > Variables and Secrets): ROWS (default 5), THEME (dark / light),
// ACCENT ("profile" = your AniList profile colour, the default; or a colour like #3db4f2),
// HEADING (default "Currently Watching / Reading"), TIMEZONE (default: your browser's, sent by the script).
//
// Why the list is sent TO the Worker instead of the Worker reading AniList: AniList blocks Cloudflare
// Worker addresses (its API and its cover-picture server both answer 403 "manually blocked").
// So your browser (the Tampermonkey script) and a GitHub Actions job read AniList and send the list
// and the covers here. The covers are stored and put inside the card, because a picture shown in a
// bio is not allowed to load other pictures from the internet.

const MAX_ROWS = 10;
const PROFILE_COLOURS = { blue: '#3db4f2', purple: '#c063ff', pink: '#fc9dd6', orange: '#ef881a', red: '#e13333', green: '#4cca51', gray: '#677b94' };

// ------------------------------------------------------------------ storage (D1 database "DB")
let ready = null;
function setup(db) {
  if (!ready) ready = db.prepare('CREATE TABLE IF NOT EXISTS store (k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER NOT NULL)').run()
    .catch(e => { ready = null; throw e; });
  return ready;
}
const now = () => Math.floor(Date.now() / 1000);
const get = async (env, k) => (await env.DB.prepare('SELECT v, t FROM store WHERE k = ?').bind(k).first()) || null;
const put = (env, k, v) => env.DB.prepare('INSERT OR REPLACE INTO store (k, v, t) VALUES (?, ?, ?)').bind(k, v, now());
const readList = async env => { const r = await get(env, 'list'); return r ? JSON.parse(r.v) : null; };

// ------------------------------------------------------------------ the list
const str = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);
const int = v => (v !== null && v !== undefined && v !== '' && Number.isFinite(+v) ? Math.trunc(+v) : null);
const hex = v => (/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(v || '').trim()) ? '#' + String(v).trim().replace('#', '').toLowerCase() : null);
const profileColour = v => PROFILE_COLOURS[String(v || '').toLowerCase()] || hex(v);

function cleanList(list) {
  if (!Array.isArray(list)) throw new Error('list missing');
  return list.slice(0, 500).map(e => ({
    id: int(e.id), type: e.type === 'MANGA' ? 'MANGA' : 'ANIME', title: str(e.title, 200),
    progress: int(e.progress) || 0, episodes: int(e.episodes), chapters: int(e.chapters),
    listStatus: str(e.listStatus, 20), mediaStatus: str(e.mediaStatus, 20), updatedAt: int(e.updatedAt) || 0,
    next: e.next && int(e.next.episode) != null && int(e.next.at) != null ? { episode: int(e.next.episode), at: int(e.next.at) } : null,
  })).filter(e => e.id != null).sort((a, b) => b.updatedAt - a.updatedAt);
}

// covers the card can show: the newest 10 of everything, of anime only and of manga only
function wanted(list) {
  const ids = new Set();
  for (const pick of [list, list.filter(e => e.type === 'ANIME'), list.filter(e => e.type === 'MANGA')])
    for (const e of pick.slice(0, MAX_ROWS)) ids.add(e.id);
  return [...ids];
}
async function haveCovers(env, ids) {
  if (!ids.length) return new Map();
  const r = await env.DB.prepare(`SELECT k, v FROM store WHERE k IN (${ids.map(() => '?').join(',')})`).bind(...ids.map(i => 'cover:' + i)).all();
  return new Map(r.results.map(x => [x.k, x.v]));
}

function validTz(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
function dayNo(sec, tz) {                     // calendar day in your time zone
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sec * 1000));
  const [y, mo, d] = p.split('-').map(Number);
  return Math.round(Date.UTC(y, mo - 1, d) / 86400000);
}
function cardData(list, { tz, rows, only, nowSec = Date.now() / 1000 }) {
  const today = dayNo(nowSec, tz);
  return list.filter(it => !only || it.type === only).slice(0, rows).map(it => {
    const days = today - dayNo(it.updatedAt, tz);
    return {
      ...it,
      today: days <= 0,
      ago: days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 30 ? `${days}d ago` : days < 365 ? `${Math.floor(days / 30)}mo ago` : `${Math.floor(days / 365)}y ago`,
      next: it.next ? { episode: it.next.episode, inSec: Math.max(0, it.next.at - nowSec) } : null,
    };
  });
}

// ------------------------------------------------------------------ drawing (twice the size of AniList's 514 px bio column)
const W = 1028, TOP = 106, ROW_H = 150, PAD = 36;
const CX = PAD, CW = 84, CH = 118, TX = CX + CW + 24, TW = W - PAD - TX;
const THEMES = {
  dark: { bg: '#151f2e', edge: '#0b1622', title: '#edf1f5', text: '#9fadbd', dim: '#728aa1', line: '#2a3a50', track: '#24334a', cover: '#0b1622', badge: '#0b1622' },
  light: { bg: '#fbfbfb', edge: '#e3e9ef', title: '#2e3a46', text: '#5c728a', dim: '#8ba0b2', line: '#e3e9ef', track: '#e3e9ef', cover: '#d9e1e8', badge: '#ffffff' },
};
const FONT = "'Overpass','Segoe UI','Helvetica Neue',Roboto,Arial,sans-serif";
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NARROW = 'iljtf.,:;!|\'"() ', WIDE = 'mwMWQGOD@%';
function textW(s, size, bold) {               // rough width, to wrap / shorten long titles
  let w = 0;
  for (const ch of s) w += NARROW.includes(ch) ? 0.3 : WIDE.includes(ch) ? 0.84 : /[A-Z]/.test(ch) ? 0.67 : ch > '⺀' ? 1 : 0.55;
  return w * size * (bold ? 1.07 : 1);
}
function fit(s, size, max, bold) {
  if (textW(s, size, bold) <= max) return s;
  let t = s;
  while (t.length > 1 && textW(t + '…', size, bold) > max) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}
function wrap(s, size, max, bold, lines = 2) {
  const words = s.split(/\s+/), out = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const t = cur ? cur + ' ' + words[i] : words[i];
    if (textW(t, size, bold) <= max || !cur) { cur = t; continue; }
    out.push(cur); cur = words[i];
    if (out.length === lines - 1) { cur = words.slice(i).join(' '); break; }
  }
  out.push(cur);
  return out.slice(0, lines).map(l => fit(l, size, max, bold));
}
const txt = (x, y, s, size, fill, weight = 500, extra = '') =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${esc(s)}</text>`;
function when(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
function onAccent(accent) {                   // dark text on light colours (pink, green ...), white on dark ones
  const h = accent.replace('#', ''), f = h.length === 3 ? h.split('').map(x => x + x).join('') : h;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(f.slice(i, i + 2), 16) / 255).map(v => (v <= 0.04 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#0b1622' : '#ffffff';
}
const pill = (x, y, w, label, fill, stroke, textFill) =>
  `<rect x="${x}" y="${y}" width="${w}" height="20" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>` +
  txt(x + w / 2, y + 14.5, label, 12, textFill, 700, 'text-anchor="middle" letter-spacing="1"');

const LIST = { ANIME: { CURRENT: 'Watching', REPEATING: 'Rewatching' }, MANGA: { CURRENT: 'Reading', REPEATING: 'Rereading' } };
const MEDIA = { ANIME: { RELEASING: 'Airing', FINISHED: 'Finished', NOT_YET_RELEASED: 'Upcoming', HIATUS: 'On hiatus', CANCELLED: 'Cancelled' },
                MANGA: { RELEASING: 'Releasing', FINISHED: 'Finished', NOT_YET_RELEASED: 'Upcoming', HIATUS: 'On hiatus', CANCELLED: 'Cancelled' } };

function row(it, y, i, last, c, accent) {
  const manga = it.type === 'MANGA', kind = manga ? 'MANGA' : 'ANIME';
  const aired = manga ? null : it.next ? it.next.episode - 1 : it.episodes;
  const tot = manga ? it.chapters : it.episodes;
  const barTotal = tot || (manga ? it.progress + Math.max(5, Math.round(it.progress * 0.1)) : Math.max(12, (aired || it.progress) + 1));
  const pct = Math.max(0.02, Math.min(1, it.progress / barTotal));
  const behind = aired && aired > it.progress ? aired - it.progress : 0;

  let s = `<clipPath id="c${i}"><rect x="${CX}" y="${y}" width="${CW}" height="${CH}" rx="8"/></clipPath>
  <rect x="${CX}" y="${y}" width="${CW}" height="${CH}" rx="8" fill="${c.cover}"/>`;
  if (it.cover) s += `<image href="${it.cover}" x="${CX}" y="${y}" width="${CW}" height="${CH}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c${i})"/>`;
  if (it.today) s += pill(CX + 8, y + CH - 27, CW - 16, 'TODAY', accent, accent, onAccent(accent));
  if (manga) s += pill(CX + 6, y + 6, 56, 'MANGA', c.badge, accent, accent);
  if (behind) s += pill(CX + CW - 44, y + 6, 38, `+${behind}`, c.badge, accent, accent);

  wrap(it.title, 30, TW, true).forEach((l, k) => { s += txt(TX, y + 27 + k * 32, l, 30, c.title, 700); });
  const my = y + 89, unit = manga ? 'CH' : 'EP';
  const epTxt = tot ? `${unit} ${it.progress} / ${tot}` : `${unit} ${it.progress}`;
  const doing = LIST[kind][it.listStatus] || LIST[kind].CURRENT;
  let st = [doing, MEDIA[kind][it.mediaStatus]].filter(Boolean).join(' · ');
  if (textW(epTxt, 22, true) + textW(st, 21) > TW - 16) st = doing;
  s += txt(TX, my, epTxt, 22, accent, 700) + txt(TX + TW, my, st, 21, c.text, 500, 'text-anchor="end"');
  s += `<rect x="${TX}" y="${my + 10}" width="${TW}" height="8" rx="4" fill="${c.track}"/>
  <rect x="${TX}" y="${my + 10}" width="${(TW * pct).toFixed(1)}" height="8" rx="4" fill="${accent}"/>`;

  let left;
  if (!manga && it.next) left = `ep ${it.next.episode} in ${when(it.next.inSec)}`;
  else if (tot && tot > it.progress) left = `${tot - it.progress} ${manga ? 'ch' : 'ep' + (tot - it.progress > 1 ? 's' : '')} left`;
  else if (manga && it.mediaStatus === 'RELEASING') left = 'ongoing';
  else left = 'all caught up';
  s += txt(TX, y + 125, left, 21, c.text);
  s += txt(TX + TW, y + 125, it.today ? (manga ? 'read today' : 'watched today') : it.ago, 21, it.today ? accent : c.dim, it.today ? 700 : 500, 'text-anchor="end"');
  if (!last) s += `<line x1="${CX}" y1="${y + ROW_H - 12}" x2="${W - PAD}" y2="${y + ROW_H - 12}" stroke="${c.line}" stroke-width="1.5"/>`;
  return s;
}

function cardSvg(items, { theme, accent, heading, note }) {
  const c = THEMES[theme] || THEMES.dark;
  const n = items.length, H = TOP + Math.max(1, n) * ROW_H + 18;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="22" fill="${c.bg}" stroke="${c.edge}" stroke-width="2"/>
<rect x="${PAD}" y="42" width="6" height="34" rx="3" fill="${accent}"/>`;
  s += txt(PAD + 20, 70, fit(heading, 34, W - 2 * PAD - 20, true), 34, c.title, 800);
  items.forEach((it, i) => { s += row(it, TOP + i * ROW_H, i, i === n - 1, c, accent); });
  if (!n) s += txt(PAD, TOP + 64, note, 26, c.text, 600);
  return s + '</svg>';
}

async function card(req, env) {
  const url = new URL(req.url), q = k => url.searchParams.get(k);
  let rows = Math.round(+(q('rows') || env.ROWS || 5));
  if (!(rows >= 1 && rows <= MAX_ROWS)) rows = 5;
  const only = { anime: 'ANIME', manga: 'MANGA' }[(q('only') || '').toLowerCase()] || '';
  await setup(env.DB);
  const [list, colour, tzRow] = await Promise.all([readList(env), get(env, 'color'), get(env, 'tz')]);
  const tz = [env.TIMEZONE, tzRow && tzRow.v, 'UTC'].find(t => t && validTz(t));
  const items = cardData(list || [], { tz, rows, only });
  const covers = await haveCovers(env, items.map(it => it.id));
  for (const it of items) it.cover = covers.get('cover:' + it.id) || null;
  const fixed = String(env.ACCENT || 'profile').toLowerCase() === 'profile' ? null : hex(env.ACCENT);
  return cardSvg(items, {
    theme: (q('theme') || env.THEME || 'dark').toLowerCase(),
    accent: hex(q('accent')) || fixed || (colour && colour.v) || '#3db4f2',
    heading: env.HEADING || 'Currently Watching / Reading',
    note: list ? 'Nothing on the list right now' : 'Waiting for the first update from AniList',
  });
}

// ------------------------------------------------------------------ the key
async function allowed(req, env) {
  const given = ((req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || new URL(req.url).searchParams.get('key') || '').trim();
  const want = String(env.PUSH_KEY || '').trim();
  if (!want || !given) return false;
  const a = new TextEncoder().encode(given), b = new TextEncoder().encode(want);
  return a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}
function randomKey() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789', b = crypto.getRandomValues(new Uint8Array(24));
  return [...b].map(x => abc[x % abc.length]).join('');
}

// ------------------------------------------------------------------ the check page
async function facts(env) {
  const f = { database: false, key: !!String(env.PUSH_KEY || '').trim(), shows: 0, minutesAgo: null, sentBy: null, profileColour: null, timeZone: null };
  if (!env.DB) return f;
  try {
    await setup(env.DB);
    const [list, by, colour, tz] = await Promise.all([get(env, 'list'), get(env, 'list_by'), get(env, 'color'), get(env, 'tz')]);
    f.database = true;
    if (list) { f.shows = JSON.parse(list.v).length; f.minutesAgo = Math.round((now() - list.t) / 60); }
    f.sentBy = by ? by.v : null;
    f.profileColour = colour ? colour.v : null;
    f.timeZone = env.TIMEZONE || (tz ? tz.v : null);
  } catch (e) { f.databaseError = e.message; }
  return f;
}

function checkPage(f, origin) {
  const ok = (good, yes, no) => `<li class="${good ? 'ok' : 'no'}"><b>${good ? '✔' : '✘'}</b> ${good ? yes : no}</li>`;
  const ago = m => (m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`);
  const by = { browser: 'your browser (Tampermonkey)', github: 'GitHub (every 30 minutes)', other: 'the sync script' }[f.sentBy] || 'unknown';
  const items = [
    ok(true, 'The Worker is running.', ''),
    ok(f.database, 'The database is connected.', `The database is not connected${f.databaseError ? ` (${esc(f.databaseError)})` : ''}. Add a <b>D1 database</b> binding with the variable name <code>DB</code> (README step 1.5).`),
    ok(f.key, 'Your secret key (PUSH_KEY) is set.', `The secret key is missing. Add a <b>Secret</b> called <code>PUSH_KEY</code> (README step 1.7). You can use this key: <code class="key">${randomKey()}</code>`),
    ok(f.shows > 0, `Your list arrived: ${f.shows} shows, ${ago(f.minutesAgo)}, from ${by}.`, 'Your list has not arrived yet. Set up the Tampermonkey script (README step 2) or the GitHub job (step 4).'),
  ];
  const bio = `~~~img100%(${origin}/card.svg)~~~`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>watchreading</title><style>
body{margin:0;background:#0b1622;color:#d3dce6;font:16px/1.5 'Segoe UI',Roboto,Arial,sans-serif}
main{max-width:560px;margin:0 auto;padding:28px 18px}h1{font-size:22px;color:#edf1f5}h2{font-size:17px;color:#edf1f5;margin-top:28px}
ul{list-style:none;padding:0}li{background:#151f2e;border-radius:8px;padding:10px 14px;margin:8px 0}li b{margin-right:6px}
.ok b{color:#4cca51}.no b{color:#e13333}code{background:#0b1622;border-radius:4px;padding:2px 6px;word-break:break-all}
.key{color:#ffd166;user-select:all}.bio{display:block;background:#151f2e;padding:12px;border-radius:8px;user-select:all;word-break:break-all}
img{width:100%;max-width:514px;display:block}small{color:#728aa1}</style></head><body><main>
<h1>watchreading</h1><ul>${items.join('')}</ul>
<h2>Paste this into your AniList bio</h2><code class="bio">${esc(bio)}</code>
<small>AniList &gt; Settings &gt; Profile &gt; About. Click the line once to select it all.</small>
<h2>Your card right now</h2><img src="/card.svg" alt="card">
${f.profileColour ? `<p><small>Colour: your AniList profile colour (${esc(f.profileColour)}). Time zone: ${esc(f.timeZone || 'UTC')}.</small></p>` : ''}
</main></body></html>`;
}

// ------------------------------------------------------------------ requests
const text = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/')
        return new Response(checkPage(await facts(env), url.origin), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      if (path === '/status') return json(await facts(env));
      if (!env.DB) return text('The database is not connected yet: open the main page of this Worker to see what to do.', 500);

      if (path === '/card.svg' || path === '/card') {
        const svg = req.method === 'HEAD' ? null : await card(req, env);
        return new Response(svg, { headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store, max-age=0', 'access-control-allow-origin': '*' } });
      }

      if (path === '/update' || path === '/cover') {
        if (req.method !== 'POST') return text('use POST', 405);
        if (!String(env.PUSH_KEY || '').trim()) return text('The secret PUSH_KEY is not set on the Worker yet.', 500);
        if (!(await allowed(req, env))) return text('wrong key', 403);
        await setup(env.DB);
        if (path === '/update') {
          const body = await req.json();
          const list = cleanList(body.list);
          const writes = [put(env, 'list', JSON.stringify(list)), put(env, 'list_by', ['browser', 'github'].includes(body.by) ? body.by : 'other')];
          const pc = profileColour(body.profileColor);
          if (pc) writes.push(put(env, 'color', pc));
          if (typeof body.timeZone === 'string' && validTz(body.timeZone)) writes.push(put(env, 'tz', body.timeZone));
          await env.DB.batch(writes);
          const ids = wanted(list);
          // covers of shows that left the top of your list a month ago are forgotten
          await env.DB.prepare(`DELETE FROM store WHERE k LIKE 'cover:%' AND t < ?${ids.length ? ` AND k NOT IN (${ids.map(() => '?').join(',')})` : ''}`)
            .bind(now() - 30 * 86400, ...ids.map(i => 'cover:' + i)).run();
          const have = await haveCovers(env, ids);
          return json({ ok: true, shows: list.length, missing: ids.filter(i => !have.has('cover:' + i)) });
        }
        const id = Math.trunc(+url.searchParams.get('id'));
        const data = await req.text();
        if (!(id > 0) || !/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(data) || data.length > 600000) return text('bad cover', 400);
        await put(env, 'cover:' + id, data).run();
        return json({ ok: true });
      }
      return text('not found', 404);
    } catch (e) {
      return text(`error: ${e.message}`, 500);
    }
  },
};
