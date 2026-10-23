// Reads your AniList list and sends it (plus any covers the card is missing) to your card.
// Your own GitHub copy of this project runs it every 30 minutes (.github/workflows/watchreading-sync.yml),
// using the three secrets you saved there: ANILIST_USER, CARD_URL and PUSH_KEY.
// Keep the query below the same as the one in the userscript.

const { ANILIST_USER, CARD_URL, PUSH_KEY, GITHUB_ACTIONS, GITHUB_EVENT_NAME } = process.env;
const scheduled = GITHUB_EVENT_NAME === 'schedule';
// a failed timed run only warns (AniList has short outages); a run you started yourself fails loudly
class Stop extends Error {}
const fail = msg => {
  console.log(GITHUB_ACTIONS ? `::${scheduled ? 'warning' : 'error'}::${msg}` : `ERROR: ${msg}`);
  process.exitCode = scheduled ? 0 : 1;
  throw new Stop(msg);
};
async function main() {
  for (const [k, v] of Object.entries({ ANILIST_USER, CARD_URL, PUSH_KEY })) if (!v) fail(`The secret ${k} is missing (README step 4).`);
  const CARD = CARD_URL.trim().replace(/\/+$/, '').replace(/\/card(\.svg)?$/, '');
  const UA = 'watchreading-sync (AniList bio card)';     // AniList turns away requests without one
  const auth = { Authorization: `Bearer ${PUSH_KEY.trim()}` };

  // anime Watching / Rewatching + manga Reading / Rereading (never Planning, Paused, Dropped, Completed)
  // + your profile colour (the card's accent colour follows it)
  const Q = `query($u:String){
    anime:MediaListCollection(userName:$u,type:ANIME,status_in:[CURRENT,REPEATING],sort:UPDATED_TIME_DESC){lists{entries{...E}}}
    manga:MediaListCollection(userName:$u,type:MANGA,status_in:[CURRENT,REPEATING],sort:UPDATED_TIME_DESC){lists{entries{...E}}}
    user:User(name:$u){id options{profileColor}}}
  fragment E on MediaList{status progress updatedAt media{id type siteUrl status episodes chapters title{english romaji}
    coverImage{large} nextAiringEpisode{episode airingAt}}}`;

  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ query: Q, variables: { u: ANILIST_USER.trim() } }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.errors) {
    const said = j && j.errors ? j.errors.map(e => e.message).join('; ') : '';
    if (r.status === 403 || r.status >= 500) fail(`AniList's API is switched off or down right now (${r.status}${said ? ': ' + said : ''}). ` +
      'Nothing to fix: the Tampermonkey script keeps your card updated when you save something on AniList, and this job catches up by itself once the API is back.');
    fail(`AniList answered ${r.status}: ${said} (is ANILIST_USER right?)`);
  }

  const seen = new Set(), list = [];
  for (const col of [j.data.anime, j.data.manga]) for (const e of (col ? col.lists : []).flatMap(l => l.entries)) {
    const m = e.media;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    list.push({ id: m.id, type: m.type, title: m.title.english || m.title.romaji, coverUrl: m.coverImage.large, url: m.siteUrl,
      progress: e.progress || 0, episodes: m.episodes, chapters: m.chapters, listStatus: e.status, mediaStatus: m.status, updatedAt: e.updatedAt,
      next: m.nextAiringEpisode ? { episode: m.nextAiringEpisode.episode, at: m.nextAiringEpisode.airingAt } : null });
  }

  // updatedAt = when you last watched / read the show: its newest list activity (AniList makes one only when
  // you watch / read or change a status). AniList's own updatedAt also changes when you only edit a score or
  // notes, which made re-rated shows say "watched today". A show with no activity among the newest 50 was last
  // watched before the oldest of them. No activities at all (switched off in AniList's settings): times stay.
  if (j.data.user && j.data.user.id) {
    const a = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ query: `query($id:Int){acts:Page(perPage:50){activities(userId:$id,type:MEDIA_LIST,sort:ID_DESC){...on ListActivity{createdAt media{id}}}}}`,
        variables: { id: j.data.user.id } }),
    }).then(x => x.json()).catch(() => null);
    const acts = ((a && a.data && a.data.acts && a.data.acts.activities) || []).filter(x => x && x.media && x.createdAt);
    if (acts.length) {
      const at = {};
      for (const x of acts) if (!(x.media.id in at)) at[x.media.id] = x.createdAt;
      const oldest = Math.min(...acts.map(x => x.createdAt));
      for (const it of list) it.updatedAt = at[it.id] != null ? at[it.id] : Math.min(it.updatedAt, oldest - 1);
    }
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  const profileColor = j.data.user && j.data.user.options ? j.data.user.options.profileColor : null;

  const u = await fetch(`${CARD}/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ list, by: GITHUB_ACTIONS ? 'github' : 'other', profileColor }) }).catch(e => fail(`Could not reach ${CARD}: ${e.message}`));
  if (u.status === 403) fail('Your card says "wrong key": the PUSH_KEY secret on GitHub must be exactly the same as the PUSH_KEY on Cloudflare.');
  if (!u.ok) fail(`Your card answered ${u.status}: ${(await u.text()).slice(0, 200)} (open your card's main page to see what is missing)`);
  const res = await u.json();

  let sent = 0;
  for (const id of res.missing || []) {
    const it = list.find(i => i.id === id);
    if (!it || !it.coverUrl) continue;
    const img = await fetch(it.coverUrl, { headers: { 'User-Agent': UA } });
    if (!img.ok) { console.log(`cover ${id}: ${img.status}`); continue; }
    const data = `data:${img.headers.get('content-type') || 'image/jpeg'};base64,` + Buffer.from(await img.arrayBuffer()).toString('base64');
    const c = await fetch(`${CARD}/cover?id=${id}`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...auth }, body: data });
    if (c.ok) sent++; else console.log(`cover ${id}: the Worker answered ${c.status}`);
  }
  console.log(`Sent ${list.length} shows (newest: ${list[0] ? list[0].title : '-'}), ${sent} new covers.`);
}

main().catch(e => {
  if (e instanceof Stop) return;
  console.log(GITHUB_ACTIONS ? `::error::${e.message}` : `ERROR: ${e.message}`);
  process.exitCode = scheduled ? 0 : 1;
});
