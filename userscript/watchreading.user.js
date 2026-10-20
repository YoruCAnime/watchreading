// ==UserScript==
// @name         watchreading - AniList bio card sync
// @namespace    watchreading
// @version      1.0.0
// @description  Sends your Watching / Rewatching anime and Reading / Rereading manga to your watchreading card a few seconds after you update AniList.
// @match        https://anilist.co/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      workers.dev
// @connect      anilist.co
// @connect      *
// @run-at       document-start
// @noframes
// ==/UserScript==
//
// Settings (your Worker's address, your key, your AniList name) are asked the first time you open
// AniList, and can be changed any time: Tampermonkey icon > "watchreading: settings".
// They are kept by Tampermonkey, so updates of this script never lose them.
//
// What it does while any AniList tab is open (in front or in the background):
//  - about 2 seconds after AniList saves a change to your list (+1 button, list editor, anything),
//    it reads your list and sends it to your card;
//  - it also looks every minute (catches changes made on another device) and sends only when
//    something changed, plus once every 30 minutes anyway;
//  - covers the card does not have yet are sent once each (the Worker cannot download them itself).
(function () {
  'use strict';
  const CHECK_EVERY = 60 * 1000;
  const RESEND_AFTER = 30 * 60 * 1000;

  // anime Watching / Rewatching + manga Reading / Rereading (never Planning, Paused, Dropped, Completed)
  // + your profile colour (the card's accent colour follows it)
  const Q = `query($u:String){
    anime:MediaListCollection(userName:$u,type:ANIME,status_in:[CURRENT,REPEATING],sort:UPDATED_TIME_DESC){lists{entries{...E}}}
    manga:MediaListCollection(userName:$u,type:MANGA,status_in:[CURRENT,REPEATING],sort:UPDATED_TIME_DESC){lists{entries{...E}}}
    user:User(name:$u){options{profileColor}}}
  fragment E on MediaList{status progress updatedAt media{id type siteUrl status episodes chapters title{english romaji}
    coverImage{large} nextAiringEpisode{episode airingAt}}}`;

  const cfg = () => GM_getValue('cfg', null);
  const gm = o => new Promise((ok, bad) => GM_xmlhttpRequest({ timeout: 30000, ...o, onload: ok, onerror: bad, ontimeout: bad }));
  const parse = r => (typeof r.response === 'string' ? JSON.parse(r.response) : r.response);

  async function readList(user) {
    const r = await gm({ method: 'POST', url: 'https://graphql.anilist.co', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      data: JSON.stringify({ query: Q, variables: { u: user } }), responseType: 'json' });
    const j = parse(r);
    if (r.status !== 200 || !j || j.errors) throw new Error('AniList ' + r.status + (j && j.errors ? ': ' + j.errors.map(e => e.message).join('; ') : ''));
    const seen = new Set(), out = [];
    for (const col of [j.data.anime, j.data.manga]) for (const e of (col ? col.lists : []).flatMap(l => l.entries)) {
      const m = e.media;
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ id: m.id, type: m.type, title: m.title.english || m.title.romaji, coverUrl: m.coverImage.large, url: m.siteUrl,
        progress: e.progress || 0, episodes: m.episodes, chapters: m.chapters, listStatus: e.status, mediaStatus: m.status, updatedAt: e.updatedAt,
        next: m.nextAiringEpisode ? { episode: m.nextAiringEpisode.episode, at: m.nextAiringEpisode.airingAt } : null });
    }
    const color = j.data.user && j.data.user.options ? j.data.user.options.profileColor : null;
    return { list: out.sort((a, b) => b.updatedAt - a.updatedAt), color };
  }

  function toB64(buf) {
    const b = new Uint8Array(buf); let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // one AniList read per 8 s at most (2 s right after a save); several AniList tabs take turns
  let busy = false, lastRead = 0, again = false;
  async function sync(force, urgent) {
    const c = cfg();
    if (!c) return null;
    if (busy) { if (urgent) again = true; return null; }
    if (!force && Date.now() - lastRead < (urgent ? 2000 : 8000)) return null;
    lastRead = Date.now();
    if (!force && !urgent && Date.now() - GM_getValue('lock', 0) < 45000) return null;
    busy = true; GM_setValue('lock', Date.now());
    const auth = { Authorization: 'Bearer ' + c.key };
    try {
      const { list, color } = await readList(c.user);
      const sig = JSON.stringify([c.worker, color, list.slice(0, 30).map(i => [i.id, i.progress, i.updatedAt, i.episodes, i.listStatus, i.next && i.next.at])]);
      if (!force && sig === GM_getValue('sig', '') && Date.now() - GM_getValue('sent', 0) < RESEND_AFTER) return 'unchanged';
      const r = await gm({ method: 'POST', url: c.worker + '/update', headers: { 'Content-Type': 'application/json', ...auth },
        data: JSON.stringify({ list, by: 'browser', profileColor: color, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }), responseType: 'json' });
      if (r.status === 403) throw new Error('the Worker says "wrong key"');
      const res = parse(r);
      if (r.status !== 200 || !res || !res.ok) throw new Error('the Worker answered ' + r.status);
      let covers = 0;
      for (const id of res.missing || []) {
        const it = list.find(i => i.id === id);
        if (!it || !it.coverUrl) continue;
        const img = await gm({ method: 'GET', url: it.coverUrl, responseType: 'arraybuffer' });
        if (img.status !== 200) continue;
        const type = /\.png($|\?)/i.test(it.coverUrl) ? 'image/png' : 'image/jpeg';
        const up = await gm({ method: 'POST', url: c.worker + '/cover?id=' + id, headers: { 'Content-Type': 'text/plain', ...auth },
          data: 'data:' + type + ';base64,' + toB64(img.response) });
        if (up.status === 200) covers++;
      }
      GM_setValue('sig', sig); GM_setValue('sent', Date.now());
      console.debug('[watchreading] sent', list.length, 'shows,', covers, 'new covers');
      return `sent ${list.length} shows and ${covers} new covers`;
    } catch (e) {
      console.debug('[watchreading]', e && e.message || e);
      if (force) throw e;
      return null;
    } finally {
      busy = false; GM_setValue('lock', 0);
      if (again) { again = false; setTimeout(() => sync(false, true), 2500); }
    }
  }

  // ---------------------------------------------------------------- settings
  async function settings() {
    const c = cfg() || {};
    const guessUser = (location.pathname.match(/^\/user\/([^/]+)/) || [])[1] || '';
    let worker = prompt('watchreading (1/3)\n\nYour card\'s address (your Cloudflare Worker), e.g.\nhttps://watchreading.yourname.workers.dev', c.worker || '');
    if (worker === null) return;
    worker = worker.trim().replace(/\/+$/, '').replace(/\/(card(\.svg)?|status)$/, '');
    if (!/^https:\/\/[^\s/]+$/.test(worker)) { alert('watchreading: that does not look like an address (it should start with https:// ).'); return; }
    const key = prompt('watchreading (2/3)\n\nYour secret key (the PUSH_KEY you saved in Cloudflare):', c.key || '');
    if (key === null || !key.trim()) return;
    const user = prompt('watchreading (3/3)\n\nYour AniList user name:', c.user || guessUser);
    if (user === null || !user.trim()) return;
    GM_setValue('cfg', { worker, key: key.trim(), user: user.trim() });
    GM_setValue('sig', '');
    try {
      const msg = await sync(true, true);
      alert('watchreading is set up: ' + (msg || 'sent') + '.\n\nYour card: ' + worker + '/card.svg');
    } catch (e) {
      alert('watchreading: saved, but the first send failed: ' + (e && e.message || e) +
        '\n\nCheck the address and the key (Tampermonkey icon > "watchreading: settings").');
    }
  }
  GM_registerMenuCommand('watchreading: settings', settings);
  GM_registerMenuCommand('watchreading: send now', () => sync(true, true).then(m => alert('watchreading: ' + (m || 'sent'))).catch(e => alert('watchreading: ' + (e && e.message || e))));

  // ---------------------------------------------------------------- notice AniList's own saves
  // A tiny listener in the page tells this script when AniList saves a list entry
  // (SaveMediaListEntry / UpdateMediaListEntries / DeleteMediaListEntry), whatever button did it,
  // or saves your settings (UpdateUser: a new profile colour).
  const hook = document.createElement('script');
  hook.textContent = `(() => {
    const SAVE = /SaveMediaListEntry|UpdateMediaListEntries|DeleteMediaListEntry|UpdateUser/;
    const tell = () => window.dispatchEvent(new CustomEvent('watchreading-saved'));
    const isSave = body => typeof body === 'string' && SAVE.test(body);
    const f = window.fetch;
    if (f) window.fetch = function (input, init) {
      const p = f.apply(this, arguments);
      try { if (init && isSave(init.body)) p.then(tell, () => {}); } catch (e) {}
      return p;
    };
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      try { if (isSave(body)) this.addEventListener('loadend', tell); } catch (e) {}
      return send.apply(this, arguments);
    };
  })();`;
  (function inject(tries) {                              // the page may not exist yet at document-start
    const root = document.head || document.documentElement;
    if (root) { try { root.appendChild(hook); hook.remove(); } catch (e) {} return; }
    if (tries < 200) setTimeout(() => inject(tries + 1), 10);
  })(0);
  let savedT;
  window.addEventListener('watchreading-saved', () => {
    clearTimeout(savedT);
    savedT = setTimeout(() => sync(false, true), 1500);
  });

  // after any click (in case a save is missed) look again a little later
  let soon1, soon2;
  document.addEventListener('click', () => {
    clearTimeout(soon1); clearTimeout(soon2);
    soon1 = setTimeout(() => sync(false), 4000);
    soon2 = setTimeout(() => sync(false), 20000);
  }, true);

  setTimeout(() => {
    if (!cfg() && !GM_getValue('asked', false)) { GM_setValue('asked', true); settings(); }   // first time only
    else sync(false);
  }, 2000);
  setInterval(() => sync(false), CHECK_EVERY);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(false); });
})();
