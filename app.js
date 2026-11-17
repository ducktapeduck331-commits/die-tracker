/* Sig Tau Beer Die — standalone PWA.
   Data model, all under leagues/{CODE}: the league doc {name, ownerUid, createdAt};
   members/{uid} {uid, name, photoURL, email, status: pending|approved, role: owner|admin|member, playerId?, requestedAt, approvedAt};
   players/{id} {name, createdAt, uid?} (uid = the Google account the player is linked to; none = guest);
   games/{id} {teamA, teamB, settings, events[], status, winner, firstToss, startedAt, endedAt, score?, called?, loggedBy}.
   Score is always derived by replaying events. Sign-in is Google only; without a Firebase config it runs local-only. */
import { firebaseConfig, configured } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const opp = t => (t === 'A' ? 'B' : 'A');
const DEF = { target: 12, winBy2: true, tinks: true, fieldGoals: true, fifa: 'off', selfSinkLoss: true };
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function die(n, cls) {
  let h = '';
  for (let i = 0; i < 9; i++) h += '<i' + (PIPS[n].indexOf(i) >= 0 ? ' class="on"' : '') + '></i>';
  return '<span class="die ' + (cls || '') + '" role="img" aria-label="Die showing ' + n + '">' + h + '</span>';
}
const KIND = { point: 'Point', tink: 'Tink', sink: 'Sink', fg: 'Field goal', caught: 'Caught', short: 'Short / dead', low: 'Too low', retoss: 'Re-toss', selfSink: 'Self-sink',
  fifaCatch: 'FIFA catch', fifaDrop: "FIFA'd onto table, dropped", fifaTink: "FIFA'd off cup to ground", fifaSink: "FIFA'd into defending cup", fifaOwn: "FIFA'd into offensive cup" };
const REASON = { dropped: 'Dropped', twohand: 'Two-handed catch', trapped: 'Trapped', bobble: 'Bobble touched table' };
const TABS = ['game', 'stats', 'history', 'players'];
const CODE_RE = /^[A-Z0-9-]{4,32}$/;
const LS = 'beerdie.v1', LS_LEAGUE = 'beerdie.league', LS_THEME = 'beerdie.theme';
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
const reducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const buzz = p => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} };

/* ---------- state + store ---------- */
const S = { players: {}, games: {}, members: {}, member: null, league: null, user: null, mode: 'loading', code: null,
  got: { players: false, games: false }, meta: { players: null, games: null }, syncErr: '', authErr: '', err: '' };
const ui = { tab: 'game', panel: null, tossTeam: null, thrower: null, confirmEnd: false, setup: null, setupOpen: false, lastId: null, watchId: null,
  sort: { k: 'w', dir: -1 }, open: null, confirmDel: null, rename: null, drafts: {}, menu: false, trend: null, chartSel: null,
  league: { busy: false, msg: '', offer: null }, signBusy: false, who: false, whoSkip: false, more: null, merge: null, rmMember: null, confirmLeave: false };
let fb = null, db = null, authM = null, auth = null, unsubs = [], memberUnsub = null;

function lsRead() { try { const d = JSON.parse(lsGet(LS) || 'null'); if (d && typeof d === 'object') return { players: d.players || {}, games: d.games || {} }; } catch (e) {} return { players: {}, games: {} }; }
function lsSave() { lsSet(LS, JSON.stringify({ players: S.players, games: S.games })); }
const ref = (col, id) => fb.doc(db, 'leagues', S.code, col, id);
const me = () => (S.user ? S.user.uid : null);
const myRole = () => (S.mode === 'cloud' && S.member && S.member.status === 'approved' ? S.member.role || 'member' : null);
const isOwner = () => myRole() === 'owner';
const isAdmin = () => S.mode === 'local' || myRole() === 'owner' || myRole() === 'admin';
const myPlayerId = () => { const u = me(); if (!u || S.mode !== 'cloud') return null; return Object.keys(S.players).filter(id => S.players[id].uid === u)[0] || null; };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({ code: 'timeout' }), ms || 10000))]);
function writeErr(e) { S.err = e && e.code === 'permission-denied' ? "The cloud refused that change. You may not have permission, or the Firestore rules aren't published." : "That change couldn't be saved. It'll retry when you're back online."; render(); }

function put(col, id, data) { // data === null deletes
  if (S.mode === 'local') { if (data === null) delete S[col][id]; else S[col][id] = data; lsSave(); render(); return; }
  if (S.mode !== 'cloud' || !db) return;
  // Firestore applies the write to the local cache right away and the snapshot listener re-renders;
  // the promise only settles once the server has it, so it may stay pending while offline.
  const p = data === null ? fb.deleteDoc(ref(col, id)) : fb.setDoc(ref(col, id), data);
  p.catch(writeErr);
}
function syncState() {
  if (S.mode === 'local') return { k: 'local', t: 'This device only' };
  if (S.syncErr || S.authErr) return { k: 'error', t: 'Error' };
  const m = [S.meta.players, S.meta.games];
  if (!navigator.onLine || m.some(x => x && x.fromCache)) return { k: 'offline', t: 'Offline — will sync' };
  if (m.some(x => !x)) return { k: 'busy', t: 'Connecting…' };
  if (m.some(x => x.hasPendingWrites)) return { k: 'busy', t: 'Syncing…' };
  return { k: 'synced', t: 'Synced' };
}
function stopData() { unsubs.forEach(u => { try { u(); } catch (e) {} }); unsubs = []; }
function stopAll() { stopData(); if (memberUnsub) { try { memberUnsub(); } catch (e) {} memberUnsub = null; } }
function subscribe() {
  stopData();
  ['players', 'games'].forEach(col => {
    unsubs.push(fb.onSnapshot(fb.collection(db, 'leagues', S.code, col), { includeMetadataChanges: true }, snap => {
      const o = {}; snap.forEach(d => { o[d.id] = d.data(); });
      S[col] = o; S.got[col] = true; S.syncErr = '';
      S.meta[col] = { fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites };
      render();
    }, e => {
      S.got[col] = true;
      S.syncErr = e && e.code === 'permission-denied' ? "Cloud access was refused. Check that you're still a member and the Firestore rules are published." : "Can't reach the cloud right now.";
      render();
    }));
  });
  // who is in the league (names, photos, roles, join requests) and the league doc itself
  unsubs.push(fb.onSnapshot(fb.collection(db, 'leagues', S.code, 'members'), snap => { const o = {}; snap.forEach(d => { o[d.id] = d.data(); }); S.members = o; render(); }, () => {}));
  unsubs.push(fb.onSnapshot(fb.doc(db, 'leagues', S.code), snap => { S.league = snap.exists() ? snap.data() : null; render(); }, () => {}));
}
function enterLeague(code) {
  S.code = code; lsSet(LS_LEAGUE, code);
  S.players = {}; S.games = {}; S.members = {}; S.league = null; S.got = { players: false, games: false }; S.meta = { players: null, games: null }; S.syncErr = ''; S.err = '';
  S.mode = 'cloud'; ui.menu = false; ui.setup = null; ui.setupOpen = false; ui.lastId = null; ui.watchId = null; ui.panel = null; ui.league = { busy: false, msg: '', offer: null };
  ui.who = false; ui.whoSkip = false; ui.more = null; ui.merge = null; ui.rmMember = null; ui.confirmLeave = false;
  fxPrev = null;
  subscribe(); syncProfile(); render();
}
function toPicker(msg, forget) { // back to the "enter your league code" screen
  const code = S.code; stopAll();
  if (forget && lsGet(LS_LEAGUE) === code) lsSet(LS_LEAGUE, null);
  if (code && !ui.drafts['league-code']) ui.drafts['league-code'] = code;
  S.code = null; S.member = null; S.members = {}; S.league = null; S.players = {}; S.games = {}; S.syncErr = ''; S.err = '';
  S.mode = 'league'; ui.menu = false; ui.league = { busy: false, msg: msg || '', offer: null };
  render(); window.scrollTo(0, 0);
}
/* Everything hangs off my own member doc (leagues/CODE/members/MY-UID), the one doc I can always read:
   missing -> not in this league; "pending" -> waiting screen; "approved" -> open the table. It is watched live,
   so approval lets me in without a reload and removal shows me the door. */
function watchLeague(code) {
  stopAll();
  const u = me(); if (!u || !db) return;
  S.code = code; S.member = null; S.mode = 'checking'; S.syncErr = ''; S.err = ''; ui.menu = false; render();
  memberUnsub = fb.onSnapshot(fb.doc(db, 'leagues', code, 'members', u), { includeMetadataChanges: true }, snap => {
    if (S.code !== code || me() !== u) return;
    if (!snap.exists()) {
      if (snap.metadata.fromCache) return; // not known yet (offline, or the server hasn't answered)
      const was = S.mode;
      toPicker(was === 'cloud' ? "You're no longer a member of " + code + '.' : was === 'pending' ? 'Your request to join ' + code + " wasn't approved." : "You're not in " + code + ' on this account yet. Ask to join below.', true);
      return;
    }
    S.member = snap.data();
    if (S.member.status === 'approved') { if (S.mode !== 'cloud') { if (S.mode === 'pending') toast("You're in! Welcome to " + code + '.'); enterLeague(code); } else render(); }
    else { if (S.mode === 'cloud') stopData(); S.mode = 'pending'; lsSet(LS_LEAGUE, code); render(); }
  }, e => {
    if (S.code !== code) return;
    toPicker(e && e.code === 'permission-denied' ? 'The cloud refused access. Check that the Firestore rules are published.' : "Can't reach the cloud right now. Try again in a moment.", false);
  });
}
function syncProfile() { // keep my name and photo in the league fresh
  const m = S.member, u = S.user; if (!m || !u || m.status !== 'approved') return;
  if (m.name !== u.name || (m.photoURL || '') !== u.photoURL) fb.updateDoc(ref('members', u.uid), { name: u.name, photoURL: u.photoURL }).catch(() => {});
}

/* ---------- Google sign-in ---------- */
const LS_REDIRECT = 'beerdie.redirect', LS_NOREDIRECT = 'beerdie.noredirect';
const standalone = () => !!(navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches));
function authMsg(e) {
  const c = (e && e.code) || '';
  if (c === 'auth/popup-closed-by-user' || c === 'auth/cancelled-popup-request' || c === 'auth/user-cancelled' || c === 'auth/redirect-cancelled-by-user') return '';
  if (c === 'auth/network-request-failed') return 'No connection. Signing in needs the internet — try again when you have signal.';
  if (c === 'auth/unauthorized-domain') return "This site isn't an authorized domain for the Firebase project yet. Add " + location.hostname + ' under Authentication → Settings → Authorized domains.';
  if (c === 'auth/operation-not-allowed') return "Google sign-in isn't turned on for this Firebase project (Authentication → Sign-in method → Google).";
  if (c === 'auth/user-disabled') return 'This account has been disabled.';
  return "Couldn't sign in with Google. Try again.";
}
function signIn() { // must run straight from the tap, or browsers block the pop-up
  if (!auth || ui.signBusy) return;
  const prov = new authM.GoogleAuthProvider(); prov.setCustomParameters({ prompt: 'select_account' });
  const viaRedirect = () => { lsSet(LS_REDIRECT, String(Date.now())); return authM.signInWithRedirect(auth, prov); };
  // Installed to the home screen (iOS especially) pop-ups are unreliable, so go through a full-page redirect there.
  // If a redirect once came back empty on this device, stop preferring it.
  const p = standalone() && !lsGet(LS_NOREDIRECT) ? viaRedirect() : authM.signInWithPopup(auth, prov).catch(e => {
    const c = (e && e.code) || '';
    if (c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-this-environment' || c === 'auth/web-storage-unsupported') return viaRedirect();
    throw e;
  });
  ui.signBusy = true; S.authErr = ''; render();
  p.then(() => { S.authErr = ''; }, e => { S.authErr = authMsg(e); }).then(() => { ui.signBusy = false; render(); });
}
function signOut() {
  if (!auth) return;
  stopAll(); ui.menu = false;
  authM.signOut(auth).catch(() => { toast("Couldn't sign out. Try again."); });
}
function onUser(u) {
  if (u && u.isAnonymous) { authM.signOut(auth).catch(() => {}); return; } // a session left over from the old code-only version
  const prev = me();
  S.user = u ? { uid: u.uid, name: (u.displayName || (u.email || '').split('@')[0] || 'Player').slice(0, 60), photoURL: u.photoURL || '', email: u.email || '' } : null;
  if (!u) {
    stopAll(); S.code = null; S.member = null; S.members = {}; S.league = null; S.players = {}; S.games = {}; S.syncErr = ''; S.err = '';
    S.mode = 'signin'; ui.menu = false; ui.signBusy = false; render(); return;
  }
  lsSet(LS_REDIRECT, null); S.authErr = '';
  if (prev === u.uid && S.mode !== 'signin' && S.mode !== 'loading') { render(); return; }
  const code = lsGet(LS_LEAGUE);
  if (code && CODE_RE.test(code)) watchLeague(code); else { S.mode = 'league'; render(); }
}
async function initCloud() {
  const [appM, aM, fsM] = await Promise.all([import(FB + 'firebase-app.js'), import(FB + 'firebase-auth.js'), import(FB + 'firebase-firestore.js')]);
  const app = appM.initializeApp(firebaseConfig);
  try { db = fsM.initializeFirestore(app, { localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() }) }); }
  catch (e) { db = fsM.getFirestore(app); }
  fb = fsM; authM = aM;
  // stay signed in across launches (IndexedDB first, localStorage as the fallback)
  try { auth = aM.initializeAuth(app, { persistence: [aM.indexedDBLocalPersistence, aM.browserLocalPersistence], popupRedirectResolver: aM.browserPopupRedirectResolver }); }
  catch (e) { auth = aM.getAuth(app); }
  // finish a redirect sign-in if we are coming back from Google
  const started = Number(lsGet(LS_REDIRECT)) || 0, expecting = started && Date.now() - started < 15 * 60 * 1000;
  const rr = aM.getRedirectResult(auth).then(r => !!(r && r.user), e => { S.authErr = authMsg(e); return false; });
  if (expecting) await Promise.race([rr, new Promise(res => setTimeout(res, 12000))]);
  await new Promise(res => { let first = true; aM.onAuthStateChanged(auth, u => { onUser(u); if (first) { first = false; res(); } }, () => { if (first) { first = false; res(); } }); });
  if (started) {
    lsSet(LS_REDIRECT, null);
    if (expecting && !auth.currentUser && !S.authErr) { // the redirect lost the sign-in (some browsers block the storage it needs)
      lsSet(LS_NOREDIRECT, '1'); S.authErr = "Google didn't hand the sign-in back to the app. Tap the button again and it will use a pop-up instead."; render();
    }
  }
}
async function boot() {
  render();
  if (!configured) { S.mode = 'local'; Object.assign(S, lsRead()); render(); return; }
  try { await initCloud(); }
  catch (e) { S.mode = 'down'; render(); }
}
window.addEventListener('online', () => render());
window.addEventListener('offline', () => render());

/* ---------- league: join, create, membership ---------- */
function normCode(s) { return String(s || '').toUpperCase().trim().replace(/[\s_]+/g, '-').replace(/[^A-Z0-9-]/g, '').replace(/-{2,}/g, '-').slice(0, 32); }
/* The league doc is only readable by members, so joining never reads it. Joining just writes my own member doc as
   "pending"; the rules accept that only when the league exists, so a refusal means "no such league". */
async function leagueGo(create) {
  const L = ui.league, code = normCode(ui.drafts['league-code']), u = S.user;
  ui.drafts['league-code'] = code; L.offer = null;
  if (!u || !db) return;
  if (!CODE_RE.test(code)) { L.msg = 'League codes are 4 to 32 characters: letters, numbers and dashes.'; render(); return; }
  L.busy = true; L.msg = ''; render();
  const mref = fb.doc(db, 'leagues', code, 'members', u.uid), lref = fb.doc(db, 'leagues', code), now = Date.now();
  const prof = { uid: u.uid, name: u.name, photoURL: u.photoURL, email: u.email, requestedAt: now };
  let stage = 'check', msg = '', offer = null, ok = false, started = false;
  try {
    const snap = await withTimeout(fb.getDoc(mref));
    if (snap.exists()) ok = true; // already a member, or already waiting
    else if (create) {
      stage = 'create';
      const owner = Object.assign({}, prof, { status: 'approved', role: 'owner', approvedAt: now });
      const b = fb.writeBatch(db); b.set(lref, { name: code, ownerUid: u.uid, createdAt: now }); b.set(mref, owner); await withTimeout(b.commit());
      ok = true; started = true;
    } else {
      stage = 'join';
      await withTimeout(fb.setDoc(mref, Object.assign({}, prof, { status: 'pending', role: 'member' })));
      ok = true;
    }
  } catch (e) {
    const c = (e && e.code) || '';
    if (c === 'permission-denied' && stage === 'join') { msg = 'Nobody has started ' + code + ' yet. Check the spelling, or start it yourself.'; offer = code; }
    else if ((c === 'permission-denied' || c === 'not-found') && stage === 'create') msg = code + ' is already taken. Ask to join it instead, or pick a different code.';
    else if (c === 'permission-denied') msg = 'The cloud refused that. Check that the Firestore rules are published.';
    else msg = "Couldn't reach the cloud. Joining or starting a league needs a connection — try again in a moment.";
  }
  if (S.mode !== 'league' || me() !== u.uid) return; // signed out or moved on while we waited
  L.busy = false;
  if (!ok) { L.msg = msg; L.offer = offer; render(); return; }
  if (started) toast(code + ' is open. You run this league.');
  ui.drafts['league-code'] = ''; lsSet(LS_LEAGUE, code); watchLeague(code);
}
function memberSet(u, data) { fb.updateDoc(ref('members', u), data).catch(writeErr); }
function memberRemove(u) { // deny a request, or remove a member (their player stays on the board as a guest)
  const b = fb.writeBatch(db);
  Object.keys(S.players).forEach(id => { if (S.players[id].uid === u) b.update(ref('players', id), { uid: fb.deleteField() }); });
  b.delete(ref('members', u)); b.commit().catch(writeErr);
}
async function leaveLeague() { // cancel my request, or walk away from a league I'm in
  const code = S.code, u = me(); if (!code || !u) return;
  const mine = myPlayerId(), b = fb.writeBatch(db);
  if (mine) b.update(ref('players', mine), { uid: fb.deleteField() });
  b.delete(fb.doc(db, 'leagues', code, 'members', u));
  stopAll();
  try { await withTimeout(b.commit()); toPicker('', true); toast('You left ' + code + '.'); }
  catch (e) { toast("Couldn't do that right now. Try again when you're online."); watchLeague(code); }
}

/* ---------- players <-> accounts ---------- */
function linkPlayer(pid, u) { // u = account uid, or null to make the player a guest again
  const p = S.players[pid]; if (!p) return;
  const b = fb.writeBatch(db), prevU = p.uid || null;
  if (u) Object.keys(S.players).forEach(id => { if (id !== pid && S.players[id].uid === u) b.update(ref('players', id), { uid: fb.deleteField() }); }); // one player per account
  b.update(ref('players', pid), { uid: u || fb.deleteField() });
  if (prevU && prevU !== u && S.members[prevU]) b.update(ref('members', prevU), { playerId: fb.deleteField() });
  if (u && S.members[u]) b.update(ref('members', u), { playerId: pid });
  b.commit().catch(writeErr);
}
function createMyPlayer() {
  const u = S.user; if (!u || myPlayerId()) return;
  const id = uid(), b = fb.writeBatch(db);
  b.set(ref('players', id), { name: u.name.trim().slice(0, 24) || 'Player', createdAt: Date.now(), uid: u.uid });
  b.update(ref('members', u.uid), { playerId: id });
  b.commit().catch(writeErr);
}
const inGame = (g, id) => (g.teamA || []).concat(g.teamB || []).indexOf(id) >= 0;
/* Fold a duplicate player into another: every game and toss that mentions `from` is rewritten to `into`, then `from`
   is deleted. Firestore batches cap at 500 writes, so it goes in chunks; the delete is last, so if a chunk fails the
   duplicate is still there and the merge can simply be run again. */
async function mergePlayers(from, into) {
  const pf = S.players[from], pi = S.players[into]; if (!pf || !pi || from === into) return;
  const ids = Object.keys(S.games);
  if (ids.some(id => inGame(S.games[id], from) && inGame(S.games[id], into))) { toast(pf.name + ' and ' + pi.name + " played in the same game, so they can't be the same person."); return; }
  const swap = id => (id === from ? into : id), ops = [];
  ids.forEach(id => {
    const g = S.games[id], evs = g.events || [];
    if (!inGame(g, from) && !evs.some(e => e.thrower === from || e.defender === from)) return;
    const data = { teamA: (g.teamA || []).map(swap), teamB: (g.teamB || []).map(swap),
      events: evs.map(e => (e.thrower === from || e.defender === from ? Object.assign({}, e, e.thrower === from ? { thrower: into } : null, e.defender === from ? { defender: into } : null) : e)) };
    ops.push(b => b.update(ref('games', id), data));
  });
  if (pf.uid && !pi.uid) { ops.push(b => b.update(ref('players', into), { uid: pf.uid })); if (S.members[pf.uid]) ops.push(b => b.update(ref('members', pf.uid), { playerId: into })); }
  else if (pf.uid && S.members[pf.uid]) ops.push(b => b.update(ref('members', pf.uid), { playerId: fb.deleteField() }));
  ops.push(b => b.delete(ref('players', from)));
  const n = ops.length - 1;
  try {
    for (let i = 0; i < ops.length; i += 400) { const b = fb.writeBatch(db); ops.slice(i, i + 400).forEach(f => f(b)); await b.commit(); }
    toast('Merged ' + pf.name + ' into ' + pi.name + '.');
  } catch (e) { writeErr(e); }
  return n;
}

/* ---------- sign-in, league and waiting screens ---------- */
const okUrl = u => typeof u === 'string' && /^https:\/\//.test(u);
function avatar(name, url, cls) { // initial with the Google photo laid over it; a broken photo is removed and the initial shows
  const ini = esc((String(name || '?').trim()[0] || '?').toUpperCase());
  return '<i class="av ' + (cls || '') + '" aria-hidden="true">' + ini + (okUrl(url) ? '<img src="' + esc(url) + '" alt="" referrerpolicy="no-referrer">' : '') + '</i>';
}
function pmark(id) { // avatar for a player linked to an account, dashed ring for a guest; nothing in local mode
  if (S.mode !== 'cloud') return '';
  const p = S.players[id]; if (!p) return '';
  if (!p.uid) return '<i class="av xs guest" role="img" aria-label="Guest" title="Guest: not linked to an account"></i>';
  const m = S.members[p.uid];
  return '<i class="av xs ok" role="img" aria-label="Verified" title="Linked to ' + esc(m ? m.name : 'a Google account') + '">' + esc((String(p.name || '?').trim()[0] || '?').toUpperCase()) +
    (m && okUrl(m.photoURL) ? '<img src="' + esc(m.photoURL) + '" alt="" referrerpolicy="no-referrer">' : '') + '</i>';
}
const GOOGLE_G = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
function signinView() {
  return '<section class="league signin"><div class="league-die">' + die(6, 'huge') + '</div><h2>Sig Tau<small><span>Beer Die</span></small></h2>' +
    '<p class="onwood">Pull up a chair. Sign in so every toss lands on the right name, on any phone.</p>' +
    '<div class="card stack"><span class="tape">Who\'s playing?</span>' +
    '<button type="button" class="gbtn" id="google-signin" data-act="signin"' + (ui.signBusy ? ' disabled' : '') + '>' + GOOGLE_G + '<span>' + (ui.signBusy ? 'Signing in…' : 'Sign in with Google') + '</span></button>' +
    (S.authErr ? '<p class="note warn" role="alert">' + esc(S.authErr) + '</p>' : '') +
    '<p class="small muted">Your league sees your name and photo so stats stay honest. Friends without the app can still play as guests.</p></div></section>';
}
function acctLine() {
  const u = S.user; if (!u) return '';
  return '<p class="acct-line small onwood">' + avatar(u.name, u.photoURL, 'xs') + '<span>Signed in as <b>' + esc(u.name) + '</b></span><button type="button" class="linkbtn" data-act="signout">Sign out</button></p>';
}
function leagueView() {
  const L = ui.league, had = lsGet(LS_LEAGUE);
  return '<section class="league"><div class="league-die">' + die(5, 'huge') + '</div><h2>Enter your league code</h2>' +
    '<p class="onwood">One crew, one code. Ask to join your crew\'s league, or start your own and let people in.</p>' +
    '<form class="card stack" data-form="league"><label class="tape" for="league-code">League code</label>' +
    '<input type="text" id="league-code" class="code-input" maxlength="32" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="DIE-HOUSE" value="' + esc(ui.drafts['league-code'] || '') + '">' +
    (L.msg ? '<p class="note" role="alert">' + esc(L.msg) + '</p>' : '') +
    '<button type="submit" class="btn primary block big" id="league-join"' + (L.busy ? ' disabled' : '') + '>' + (L.busy ? 'Checking the table…' : 'Ask to join') + '</button>' +
    '<button type="button" class="btn block" id="league-create" data-act="leaguecreate"' + (L.busy ? ' disabled' : '') + '>' + (L.offer ? 'Start ' + esc(L.offer) + ' as a new league' : 'Start a new league') + '</button>' +
    '<p class="small muted">Letters, numbers and dashes, 4 to 32 characters. Whoever starts a league runs it and approves everyone who asks to join.</p></form>' +
    (had && CODE_RE.test(had) ? '<button type="button" class="btn ghost block onwood" data-act="leagueback">Back to ' + esc(had) + '</button>' : '') + acctLine() + '</section>';
}
function pendingView() {
  return '<section class="league"><div class="league-die">' + die(3, 'huge') + '</div><h2>Almost in</h2>' +
    '<p class="onwood" id="pending-msg">Waiting for the league owner to let you in.</p>' +
    '<div class="codecard"><span class="tape">League code</span><div class="code">' + esc(S.code) + '</div>' +
    '<p class="small">Your request is in as <b>' + esc(S.user ? S.user.name : '') + '</b>. Give whoever runs the league a nudge. This screen opens the table by itself the moment you\'re approved.</p>' +
    '<p class="syncline"><span class="dot busy"></span><b>' + (navigator.onLine ? 'Waiting for approval…' : 'Offline — will check when you have signal') + '</b></p></div>' +
    '<button type="button" class="btn block" data-act="cancelreq">Cancel my request</button>' +
    '<button type="button" class="btn ghost block onwood" data-act="leagueswitch">Try a different league</button>' + acctLine() + '</section>';
}
function checkingView() {
  return '<section class="league"><div class="empty">' + die(6, 'big') + '<p><b>Finding your seat at ' + esc(S.code) + '&hellip;</b></p>' +
    (navigator.onLine ? '' : '<p class="muted small">You\'re offline. This needs a connection the first time on a device.</p>') + '</div>' +
    '<button type="button" class="btn ghost block onwood" data-act="leagueswitch">Use a different league</button>' + acctLine() + '</section>';
}
function whoView() {
  const u = S.user, used = {};
  games().forEach(g => { g.teamA.concat(g.teamB).forEach(id => { used[id] = (used[id] || 0) + 1; }); });
  const same = id => pname(id).trim().toLowerCase() === u.name.trim().toLowerCase() || pname(id).trim().toLowerCase() === u.name.trim().split(/\s+/)[0].toLowerCase();
  const free = Object.keys(S.players).filter(id => !S.players[id].uid).sort((a, b) => (same(b) - same(a)) || pname(a).localeCompare(pname(b)));
  const nm = u.name.trim().slice(0, 24) || 'Player';
  return '<section class="league who"><div class="league-die">' + avatar(u.name, u.photoURL, 'xl') + '</div><h2>Which player are you?</h2>' +
    '<p class="onwood">Link your account to your name on the board, so your stats are yours on every phone.</p><div class="card stack">' +
    (free.length ? '<h3 class="tape">Already on the board?</h3><ul class="plist">' + free.map(id => '<li><span class="nm">' + esc(pname(id)) + '<br><span class="small muted num" style="font-weight:400">' + (used[id] || 0) + ' game' + (used[id] === 1 ? '' : 's') + '</span></span>' +
      '<button type="button" class="btn sm' + (same(id) ? ' primary' : '') + '" data-act="whome" data-v="' + id + '" aria-label="I am ' + esc(pname(id)) + '">That\'s me</button></li>').join('') + '</ul><h3 class="tape">Not on the list?</h3>' : '') +
    '<button type="button" class="btn ' + (free.some(same) ? '' : 'primary ') + 'block" id="who-new" data-act="whonew">Add me as ' + esc(nm) + '</button></div>' +
    '<button type="button" class="btn ghost block onwood" data-act="whoskip">Not now</button></section>';
}

/* ---------- game logic ---------- */
const pname = id => (S.players[id] ? S.players[id].name : 'Unknown');
function norm(id, g) { return Object.assign({}, g, { id: id, teamA: g.teamA || [], teamB: g.teamB || [], events: g.events || [], settings: Object.assign({}, DEF, g.settings || {}) }); }
function games() { return Object.keys(S.games).map(id => norm(id, S.games[id])).filter(g => g.teamA.length === 2 && g.teamB.length === 2); }
function liveGame() { return games().filter(g => g.status === 'live').sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null; }
function finals() { return games().filter(g => g.status === 'final').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)); }
const tname = (g, t) => g['team' + t].map(pname).join(' & ');
const tnameH = (g, t) => g['team' + t].map(id => (S.players[id] && S.players[id].uid ? pmark(id) : '') + esc(pname(id))).join(' &amp; '); // HTML, with avatars for linked players
const canDelete = g => S.mode === 'local' || isAdmin() || (!!g.loggedBy && g.loggedBy === me());
function saveGame(g) { const d = Object.assign({}, g); delete d.id; put('games', g.id, d); }
function isFifaTeamPoint(e) { return !!(e.fifa && e.scoreTeam && e.scoreTeam !== e.team); }
function met(sc, t, st) { return sc[t] >= st.target && (!st.winBy2 || sc[t] - sc[opp(t)] >= 2); }
function calc(g) {
  const st = g.settings, sc = { A: 0, B: 0 }, fp = { A: 0, B: 0 }, maxDef = { A: 0, B: 0 };
  let winner = null, n = 0;
  for (let i = 0; i < g.events.length && !winner; i++) {
    const e = g.events[i], s = e.scoreTeam; if (e.kind !== 'retoss') n++;
    if (s && e.points) { sc[s] += e.points; if (isFifaTeamPoint(e)) fp[s] += e.points; }
    maxDef.A = Math.max(maxDef.A, sc.B - sc.A); maxDef.B = Math.max(maxDef.B, sc.A - sc.B);
    if (e.kind === 'selfSink' && st.selfSinkLoss) { winner = opp(e.team); break; }
    if (s && e.points && !isFifaTeamPoint(e) && met(sc, s, st)) winner = s;
  }
  let hold = null; if (!winner) ['A', 'B'].forEach(t => { if (met(sc, t, st)) hold = t; });
  return { sc: sc, fp: fp, winner: winner, hold: hold, maxDef: maxDef, tosses: n };
}
function tossInfo(g) {
  let team = g.firstToss || 'A'; const last = { A: null, B: null };
  g.events.forEach(e => { if (e.kind === 'retoss') return; last[e.team] = e.thrower; team = opp(e.team); });
  if (ui.tossTeam) team = ui.tossTeam;
  const ps = g['team' + team]; let thr = last[team] === ps[0] ? ps[1] : ps[0];
  if (ui.thrower && ps.indexOf(ui.thrower) >= 0) thr = ui.thrower;
  return { team: team, thr: thr };
}
function pointsFor(kind, g, team) { // -> {points,to,fifa,capped}
  const st = g.settings, d = opp(team), c = calc(g), left = Math.max(0, 3 - c.fp[d]); let p;
  switch (kind) {
    case 'point': return { points: 1, to: team };
    case 'tink': return { points: 2, to: team };
    case 'sink': return { points: 3, to: team };
    case 'fg': return { points: 2, to: team };
    case 'fifaDrop': return { points: 1, to: team, fifa: true };
    case 'fifaTink': return { points: st.tinks ? 2 : 1, to: team, fifa: true };
    case 'fifaSink': return { points: st.tinks ? 3 : 2, to: team, fifa: true };
    case 'fifaCatch': p = st.fifa === 'points' ? Math.min(1, left) : 0; return { points: p, to: p ? d : null, fifa: true, capped: st.fifa === 'points' && !p };
    case 'fifaOwn': p = Math.min(2, left); return { points: p, to: p ? d : null, fifa: true, capped: p < 2 };
  }
  return { points: 0, to: null };
}
function logEvent(kind, extra) {
  const g = liveGame(); if (!g) return;
  const ti = tossInfo(g), pf = pointsFor(kind, g, ti.team);
  const ev = Object.assign({ t: Date.now(), kind: kind, thrower: ti.thr, team: ti.team, points: pf.points, scoreTeam: pf.to || null }, extra || {});
  if (S.mode === 'cloud' && me()) ev.loggedBy = me();
  if (pf.fifa) ev.fifa = true; if (pf.capped) ev.capped = true;
  Object.keys(ev).forEach(k => { if (ev[k] === undefined || ev[k] === '') delete ev[k]; });
  const ng = Object.assign({}, g, { events: g.events.concat([ev]) }), c = calc(ng);
  if (c.winner) { ng.status = 'final'; ng.winner = c.winner; ng.endedAt = Date.now(); ng.score = c.sc; ui.lastId = g.id; ui.setupOpen = false; }
  ui.panel = null; ui.confirmEnd = false;
  if (kind !== 'retoss') { ui.tossTeam = null; ui.thrower = null; }
  buzz(c.winner ? [60, 50, 60, 50, 220] : kind === 'sink' || kind === 'fifaSink' ? [40, 50, 40, 50, 140] : kind === 'tink' || kind === 'fg' ? [25, 40, 25] : pf.points ? 30 : 12);
  saveGame(ng);
}
function newSetup(from) {
  const lastG = games().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
  const st = Object.assign({}, DEF, from ? from.settings : (lastG ? lastG.settings : {}));
  return { A: from ? from.teamA.slice() : [], B: from ? from.teamB.slice() : [], settings: st, firstToss: from && from.winner ? opp(from.winner) : 'A', caller: 'B', call: null, roll: null };
}

/* ---------- stats ---------- */
const MIX = [['pt', 'Points'], ['tink', 'Tinks'], ['sink', 'Sinks'], ['fg', 'Field goals'], ['fifa', 'FIFA plays']];
function mixKey(e) { return e.fifa ? 'fifa' : e.kind === 'tink' ? 'tink' : e.kind === 'sink' ? 'sink' : e.kind === 'fg' ? 'fg' : 'pt'; }
function computeStats() {
  const P = {}, D = {}, fs = finals(), tot = { g: fs.length, toss: 0, sink: 0, pts: 0 };
  const rec = { sinks: null, pts: null, comeback: null, long: null };
  const en = id => P[id] || (P[id] = { id: id, name: pname(id), g: 0, w: 0, toss: 0, pts: 0, tink: 0, sink: 0, fg: 0, ctch: 0, miss: 0, fifa: 0, ss: 0, mix: { pt: 0, tink: 0, sink: 0, fg: 0, fifa: 0 }, trend: [] });
  fs.forEach(g => {
    const c = calc(g), per = {};
    ['A', 'B'].forEach(t => {
      g['team' + t].forEach(id => { const p = en(id); p.g++; if (g.winner === t) p.w++; per[id] = { pts: 0, sink: 0, t: t }; });
      const key = g['team' + t].slice().sort().join('|'), d = D[key] || (D[key] = { ids: g['team' + t].slice().sort(), g: 0, w: 0, pf: 0, pa: 0 });
      d.g++; if (g.winner === t) d.w++; d.pf += c.sc[t]; d.pa += c.sc[opp(t)];
    });
    g.events.forEach(e => {
      if (e.kind === 'retoss') return;
      const p = en(e.thrower), pp = per[e.thrower] || (per[e.thrower] = { pts: 0, sink: 0 }); p.toss++; tot.toss++;
      if (e.points && e.scoreTeam === e.team) { p.pts += e.points; pp.pts += e.points; p.mix[mixKey(e)] += e.points; }
      if (e.points) tot.pts += e.points;
      if (e.kind === 'tink') p.tink++;
      else if (e.kind === 'sink') { p.sink++; pp.sink++; tot.sink++; }
      else if (e.kind === 'fg') p.fg++;
      else if (e.kind === 'short' || e.kind === 'low') p.miss++;
      else if (e.kind === 'selfSink') p.ss++;
      else if (e.kind === 'caught' && e.defender) en(e.defender).ctch++;
      else if (e.kind === 'fifaCatch' && e.defender) en(e.defender).fifa++;
    });
    Object.keys(per).forEach(id => {
      if (per[id].t) en(id).trend.push({ at: g.endedAt || 0, pts: per[id].pts, won: g.winner === per[id].t, vs: tname(g, opp(per[id].t)), fs: c.sc[per[id].t] + '–' + c.sc[opp(per[id].t)] });
      if (per[id].sink && (!rec.sinks || per[id].sink > rec.sinks.v)) rec.sinks = { v: per[id].sink, who: pname(id), g: g };
      if (per[id].pts && (!rec.pts || per[id].pts > rec.pts.v)) rec.pts = { v: per[id].pts, who: pname(id), g: g };
    });
    if (g.winner && c.maxDef[g.winner] > 0 && (!rec.comeback || c.maxDef[g.winner] > rec.comeback.v)) rec.comeback = { v: c.maxDef[g.winner], who: tname(g, g.winner), g: g };
    if (!rec.long || c.tosses > rec.long.v) rec.long = { v: c.tosses, who: tname(g, 'A') + ' vs ' + tname(g, 'B'), g: g };
  });
  const rows = Object.keys(P).map(id => { const p = P[id]; p.pct = p.g ? p.w / p.g : 0; p.ppt = p.toss ? p.pts / p.toss : 0; p.ppg = p.g ? p.pts / p.g : 0; p.trend.sort((a, b) => a.at - b.at); return p; });
  const duos = Object.keys(D).map(k => { const d = D[k]; d.pct = d.w / d.g; return d; }).sort((a, b) => b.pct - a.pct || b.w - a.w || (b.pf - b.pa) - (a.pf - a.pa));
  return { rows: rows, duos: duos, rec: rec, tot: tot };
}
const COLS = [['name', 'Player', 'Player'], ['g', 'GP', 'Games played'], ['w', 'W', 'Wins'], ['pct', 'Win%', 'Win percentage'], ['toss', 'Toss', 'Tosses'], ['pts', 'Pts', 'Points scored'],
  ['ppt', 'P/Toss', 'Points per toss'], ['ppg', 'P/Game', 'Points per game'], ['tink', 'Tink', 'Tinks'], ['sink', 'Sink', 'Sinks'], ['fg', 'FG', 'Field goals'], ['ctch', 'Catch', 'One-hand catches'],
  ['miss', 'Shrt/Low', 'Short and too-low tosses'], ['fifa', 'FIFA', 'FIFA catches'], ['ss', 'Self', 'Self-sinks']];
function fmt(k, v) { return k === 'pct' ? Math.round(v * 100) + '%' : k === 'ppt' ? v.toFixed(2) : k === 'ppg' ? v.toFixed(1) : k === 'name' ? esc(v) : String(v); }
function fdate(t) { if (!t) return ''; try { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; } }

/* ---------- charts (inline SVG) ---------- */
function trendChart(p) {
  const all = p.trend, off = Math.max(0, all.length - 20), d = all.slice(off), n = d.length;
  const W = 340, H = 176, L = 30, Rr = 14, T = 14, B = 26, pw = W - L - Rr, ph = H - T - B;
  const max = Math.max(4, Math.ceil(Math.max.apply(null, d.map(x => x.pts)) / 4) * 4);
  const X = i => L + (n === 1 ? pw / 2 : pw * i / (n - 1)), Y = v => T + ph - ph * v / max;
  let s = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Points per game for ' + esc(p.name) + ', last ' + n + ' game' + (n === 1 ? '' : 's') + '">';
  for (let v = 0; v <= max; v += max / 4) s += '<line class="grid' + (v === 0 ? ' base' : '') + '" x1="' + L + '" x2="' + (W - Rr) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text class="ax" x="' + (L - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + v + '</text>';
  const step = Math.max(1, Math.ceil(n / 6));
  d.forEach((x, i) => { if (i % step === 0 || i === n - 1) { if (i === n - 1 && (n - 1) % step !== 0 && step > 1 && (n - 1) % step < step / 2) return; s += '<text class="ax" x="' + X(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + (off + i + 1) + '</text>'; } });
  if (n > 1) s += '<polyline class="ln" points="' + d.map((x, i) => X(i).toFixed(1) + ',' + Y(x.pts).toFixed(1)).join(' ') + '"/>';
  const sel = ui.chartSel != null && ui.chartSel < n ? ui.chartSel : n - 1;
  d.forEach((x, i) => {
    s += '<circle class="dot' + (x.won ? '' : ' loss') + (i === sel ? ' sel' : '') + '" cx="' + X(i).toFixed(1) + '" cy="' + Y(x.pts).toFixed(1) + '" r="' + (i === sel ? 6 : 4.5) + '"/>';
  });
  d.forEach((x, i) => {
    const w = n === 1 ? pw : pw / (n - 1);
    s += '<rect class="hit" data-act="pt" data-v="' + i + '" tabindex="0" role="button" aria-label="Game ' + (off + i + 1) + ': ' + x.pts + ' points, ' + (x.won ? 'won' : 'lost') + '" x="' + (X(i) - w / 2).toFixed(1) + '" y="0" width="' + w.toFixed(1) + '" height="' + H + '"><title>Game ' + (off + i + 1) + ': ' + x.pts + ' pts (' + (x.won ? 'W' : 'L') + ')</title></rect>';
  });
  s += '</svg>';
  const x = d[sel];
  return s + '<p class="readout num"><b>Game ' + (off + sel + 1) + ' &middot; ' + x.pts + ' pt' + (x.pts === 1 ? '' : 's') + '</b> &middot; ' + (x.won ? 'Won' : 'Lost') + ' ' + esc(x.fs) + ' vs ' + esc(x.vs) + ' &middot; ' + fdate(x.at) + '</p>' +
    '<p class="small muted"><span class="lg-dot"></span> win <span class="lg-dot loss"></span> loss &middot; tap a dot for the game</p>';
}
function mixChart(rows) {
  const rs = rows.filter(r => r.pts > 0).sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name));
  if (!rs.length) return '<p class="muted small">Nobody has scored yet.</p>';
  const max = rs[0].pts, keys = MIX.filter(m => rs.some(r => r.mix[m[0]] > 0));
  let h = '<div class="legend">' + keys.map(m => '<span><i class="sw m-' + m[0] + '"></i>' + m[1] + '</span>').join('') + '</div><div class="mix">';
  rs.forEach(r => {
    let x = 0, bar = '';
    keys.forEach(m => {
      const v = r.mix[m[0]]; if (!v) return; const w = v / max * 100;
      bar += '<rect class="m-' + m[0] + '" x="' + x.toFixed(2) + '%" y="1" width="' + w.toFixed(2) + '%" height="18" rx="4"><title>' + esc(r.name) + ' — ' + m[1] + ': ' + v + ' pts</title></rect>'; x += w;
    });
    const label = keys.filter(m => r.mix[m[0]]).map(m => m[1] + ' ' + r.mix[m[0]]).join(', ');
    h += '<div class="mixrow"><span class="nm">' + esc(r.name) + '</span><svg class="mixbar" height="20" role="img" aria-label="' + esc(r.name) + ': ' + r.pts + ' points. ' + esc(label) + '">' + bar + '</svg><span class="tot num">' + r.pts + '</span></div>';
  });
  return h + '</div><p class="small muted">Points each player scored on their own tosses, by how they got them.</p>';
}

/* ---------- views ---------- */
function describe(e) {
  let s = '<b>' + esc(pname(e.thrower)) + '</b> &middot; ' + esc(KIND[e.kind] || e.kind);
  if (e.reason && REASON[e.reason]) s += ' <span class="muted">(' + esc(REASON[e.reason].toLowerCase()) + ')</span>';
  if (e.cup === 'partner') s += ' <span class="muted">(partner\'s cup)</span>';
  if (e.defender) s += ' <span class="muted">' + (e.kind === 'caught' || e.kind === 'fifaCatch' ? 'by ' : e.kind === 'sink' ? 'in the cup of ' : e.fifa ? 'FIFA by ' : 'on ') + esc(pname(e.defender)) + '</span>';
  if (e.fifa) s += '<span class="tag">FIFA</span>';
  if (e.capped) s += ' <span class="muted">(FIFA point cap reached)</span>';
  return s;
}
function feed(g, limit) {
  const sc = { A: 0, B: 0 }; let rows = [];
  g.events.forEach(e => { if (e.scoreTeam && e.points) sc[e.scoreTeam] += e.points;
    rows.push('<li><span class="sc">' + sc.A + '&ndash;' + sc.B + '</span><span>' + describe(e) + '</span>' + (e.points ? '<span class="pt t' + e.scoreTeam + '">+' + e.points + '</span>' : '<span class="pt muted">&mdash;</span>') + '</li>'); });
  if (limit) { rows = rows.reverse().slice(0, limit); }
  return rows.length ? '<ol class="feed">' + rows.join('') + '</ol>' : '<p class="muted small">No tosses yet. Somebody throw something.</p>';
}
function statusLine(g, c) {
  const st = g.settings, rule = 'First to ' + st.target + (st.winBy2 ? ', win by 2' : ''), gp = [];
  if (g.status === 'final') return '<p class="status">Final' + (g.called ? ' &middot; called early' : '') + '</p>';
  if (c.hold) return '<p class="status hot" aria-live="polite">' + esc(tname(g, c.hold)) + " can't win on a FIFA &mdash; play on until a non-FIFA point wins it</p>";
  ['A', 'B'].forEach(t => { const s = { A: c.sc.A, B: c.sc.B }; s[t]++; if (met(s, t, st)) gp.push(t); });
  if (gp.length) return '<p class="status hot" aria-live="polite">Game point &mdash; ' + gp.map(t => esc(tname(g, t))).join(' and ') + '</p>';
  if (st.winBy2 && c.sc.A >= st.target - 1 && c.sc.B >= st.target - 1) return '<p class="status" aria-live="polite">Win by 2 &mdash; keep tossing</p>';
  return '<p class="status dim" aria-live="polite">' + rule + '</p>';
}
function board(g, c, ti) {
  const h = t => { const on = ti && ti.team === t, won = g.status === 'final' && g.winner === t;
    return '<div class="half t' + t + (on ? ' on' : '') + (won ? ' won' : '') + '"><div class="who"><span>' + tnameH(g, t) + '</span></div><div class="score num" id="score-' + t + '" aria-label="' + esc(tname(g, t)) + ' score">' + c.sc[t] + '</div>' +
      '<span class="tossing' + (on || won ? '' : ' off') + '"' + (on || won ? '' : ' aria-hidden="true"') + '>' + (won ? 'Winners' : die(1, 'sm') + ' throwing') + '</span></div>'; };
  return '<section class="board" id="board" aria-label="Scoreboard">' + h('A') + '<div class="mid" aria-hidden="true"></div>' + h('B') + statusLine(g, c) + '</section>';
}
function chip(k, v, label) { const on = ui.panel && ui.panel[k] === v; return '<button type="button" class="chip" data-act="pset" data-k="' + k + '" data-v="' + esc(v) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(label) + '</button>'; }
function panelView(g, ti) {
  const p = ui.panel, d = opp(ti.team), defs = g['team' + d], st = g.settings, c = calc(g); let h = '';
  const defChips = title => '<h3 class="tape">' + title + '</h3><div class="chips">' + defs.map(id => chip('defender', id, pname(id))).join('') + '</div>';
  const x = () => { const o = {}; if (p.defender) o.defender = p.defender; if (p.reason) o.reason = p.reason; return esc(JSON.stringify(o)); };
  if (p.kind === 'point') {
    h = '<h2>Point</h2><button type="button" class="btn primary block big" id="panel-go" data-act="log" data-v="point" data-x="' + x() + '">Log point <span class="val">+1</span></button>' +
      '<h3 class="tape">Why? (optional)</h3><div class="chips">' + Object.keys(REASON).map(k => chip('reason', k, REASON[k])).join('') + '</div>' + defChips('Who missed it? (optional)');
  } else if (p.kind === 'sink') {
    h = '<h2>Sink!</h2><button type="button" class="btn cup block big" id="panel-go" data-act="log" data-v="sink" data-x="' + x() + '">Log sink <span class="val">+3</span></button>' + defChips('Whose cup? (optional)');
  } else if (p.kind === 'caught') {
    h = '<h2>Caught</h2><h3 class="tape">Who caught it one-handed?</h3><div class="stack">' + defs.map(id =>
      '<button type="button" class="btn primary block big" data-act="log" data-v="caught" data-x="' + esc(JSON.stringify({ defender: id })) + '">' + esc(pname(id)) + ' caught it</button>').join('') +
      '<button type="button" class="btn block" data-act="log" data-v="caught">Not sure who</button></div>';
  } else if (p.kind === 'selfSink') {
    h = '<h2>Self-sink</h2><h3 class="tape">Which cup?</h3><div class="chips">' + chip('cup', 'own', 'Own cup') + chip('cup', 'partner', "Partner's cup") + '</div>' +
      '<p class="small muted">' + (st.selfSinkLoss ? 'House rule: a self-sink is an automatic loss. ' + esc(tname(g, d)) + ' win the game.' : 'Logged against the tosser. No points change.') + '</p>' +
      '<button type="button" class="btn primary block big" id="panel-go" data-act="log" data-v="selfSink" data-x="' + esc(JSON.stringify({ cup: p.cup || 'own' })) + '">' + (st.selfSinkLoss ? 'Log self-sink and end game' : 'Log self-sink') + '</button>';
  } else if (p.kind === 'fifa') {
    const fb2 = (kind, pts, who) => { const pf = pointsFor(kind, g, ti.team);
      return '<button type="button" class="out wide" data-act="log" data-v="' + kind + '" data-x="' + x() + '"><span class="lbl">' + esc(KIND[kind]) + '<small>' + who + (pf.capped ? ' &middot; cap reached' : '') + '</small></span><span class="val' + (pf.points ? '' : ' zero') + '">' + (pf.points ? '+' + pf.points : '0') + '</span></button>'; };
    const catchSub = st.fifa === 'points' ? 'to ' + esc(tname(g, d)) : 'No points &middot; ' + esc(pname(ti.thr)) + ' sits out next defense';
    h = '<h2>FIFA!</h2>' + defChips("Who FIFA'd it? (optional)") +
      (st.fifa === 'points' ? '<p class="small muted num">FIFA points used by ' + esc(tname(g, d)) + ': ' + c.fp[d] + ' of 3. A FIFA point can\'t win the game.</p>' : '') +
      '<div class="outs">' + fb2('fifaCatch', 0, catchSub) + fb2('fifaDrop', 1, 'to ' + esc(tname(g, ti.team))) + fb2('fifaTink', 0, 'to ' + esc(tname(g, ti.team))) +
      fb2('fifaSink', 0, 'to ' + esc(tname(g, ti.team))) + fb2('fifaOwn', 0, 'to ' + esc(tname(g, d))) + '</div>';
  }
  return '<section class="card stack panel" aria-label="Toss detail">' + h + '<button type="button" class="btn ghost block" data-act="pcancel">Cancel</button></section>';
}
function liveView(g) {
  const c = calc(g), ti = tossInfo(g), st = g.settings; let h = board(g, c, ti);
  if (ui.panel) return h + panelView(g, ti);
  const out = (kind, label, sub, val, cls) => '<button type="button" class="out ' + (cls || '') + '" id="out-' + kind + '" data-act="out" data-v="' + kind + '"><span class="lbl">' + label + '<small>' + sub + '</small></span>' + (val ? '<span class="val">+' + val + '</span>' : '') + '</button>';
  const other = opp(ti.team);
  h += '<section class="thrower t' + ti.team + '" aria-label="Who is throwing"><h3 class="tape">Who\'s throwing?</h3><div class="throw-row">' +
    g['team' + ti.team].map(id => '<button type="button" class="btn who t' + ti.team + '" data-act="thrower" data-v="' + id + '" aria-pressed="' + (id === ti.thr ? 'true' : 'false') + '">' + esc(pname(id)) + '</button>').join('') +
    '<button type="button" class="btn swap" id="switch-toss" data-act="switch" aria-label="Give the toss to ' + esc(tname(g, other)) + '"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Other side</span></button></div></section>';
  h += '<section class="stack" aria-label="Log a toss"><div class="outs scoring">' +
    out('sink', 'Sink!', 'In the cup', 3, 'score cup wide') +
    out('point', 'Point', 'Hit the table, not caught', 1, 'score') +
    (st.tinks ? out('tink', 'Tink!', 'Off the cup, uncaught', 2, 'score') : '') +
    (st.fieldGoals ? out('fg', 'Field goal', 'Back through own cups', 2, 'score' + (st.tinks ? ' wide' : '')) : '') +
    '</div><div class="outs">' +
    out('caught', 'Caught', 'One-hand catch') + out('short', 'Short / dead', 'Own side or on the line') + out('low', 'Too low', 'Below height') + out('retoss', 'Re-toss', 'Disputed, throw again') +
    (st.fifa !== 'off' ? out('fifa', 'FIFA!', 'Kicked back into play') : '') + out('selfSink', 'Self-sink', st.selfSinkLoss ? 'Automatic loss' : 'Own or partner\'s cup', 0, 'bad') + '</div></section>';
  h += '<section class="card stack"><div class="spread"><h3 class="tape">Recent tosses</h3><button type="button" class="btn sm" id="undo-last" data-act="undo"' + (g.events.length ? '' : ' disabled') + '>Undo last</button></div>' + feed(g, 8) + '</section>';
  if (ui.confirmEnd) {
    const lead = c.sc.A === c.sc.B ? null : (c.sc.A > c.sc.B ? 'A' : 'B');
    h += '<section class="confirm" aria-label="End game"><b>End this game?</b>' +
      (lead ? '<button type="button" class="btn block" data-act="callit" data-v="' + lead + '">Call it &mdash; ' + esc(tname(g, lead)) + ' win ' + c.sc[lead] + '&ndash;' + c.sc[opp(lead)] + '</button>' : '') +
      (canDelete(g) ? '<button type="button" class="btn danger block" data-act="discard">Abandon and discard (no stats)</button>' : '<span class="small muted">Only the person who started this game or a league admin can discard it.</span>') + '<button type="button" class="btn ghost block" data-act="endno">Keep playing</button></section>';
  } else h += '<button type="button" class="btn ghost block onwood" id="end-game" data-act="endask">End or abandon game</button>';
  return h;
}
function finishedView(g) {
  const c = calc(g), w = g.winner, last = g.events[g.events.length - 1];
  return board(g, c, null) + '<section class="banner" aria-live="polite"><div class="tape">Winners</div><div class="big">' + esc(tname(g, w)) + '</div><div class="fs num">' + c.sc[w] + ' &ndash; ' + c.sc[opp(w)] + '</div>' +
    (last && last.kind === 'selfSink' && g.settings.selfSinkLoss ? '<div class="small">' + esc(pname(last.thrower)) + ' self-sank. Automatic loss.</div>' : '') + (g.called ? '<div class="small">Called early</div>' : '') + '</section>' +
    '<div class="stack"><button type="button" class="btn primary block big" id="rematch" data-act="rematch">Rematch, same teams</button>' +
    '<button type="button" class="btn block" id="new-game" data-act="newgame">New game</button>' +
    '<button type="button" class="btn ghost block onwood" id="undo-final" data-act="undofinal">' + (g.called ? 'Reopen game' : 'Undo last toss and reopen') + '</button></div>' +
    '<section class="card stack"><h3 class="tape">Toss log</h3>' + feed(g) + '</section>';
}
function sw(key, on, label, sub) { return '<div class="setrow"><span class="lbl" id="lbl-' + key + '">' + label + (sub ? '<small>' + sub + '</small>' : '') + '</span><button type="button" class="switch" id="set-' + key + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-labelledby="lbl-' + key + '" data-act="toggle" data-v="' + key + '"></button></div>'; }
function setupView() {
  const su = ui.setup || (ui.setup = newSetup()), st = su.settings, ids = Object.keys(S.players).sort((a, b) => pname(a).localeCompare(pname(b)));
  su.A = su.A.filter(id => S.players[id]); su.B = su.B.filter(id => S.players[id]);
  const add = '<form class="row" data-form="quickadd"><input type="text" id="quick-player-name" maxlength="24" autocomplete="off" placeholder="Add a player" aria-label="New player name" value="' + esc(ui.drafts['quick-player-name'] || '') + '"><button class="btn" id="quick-player-add" type="submit">Add</button></form>';
  let h = '<h2>New game</h2>';
  if (!ids.length) return h + '<div class="empty">' + die(5, 'big') + '<p><b>No players yet &mdash; add your crew to start</b></p><p class="muted small">You need four for a game of 2 v 2.</p></div>' + add;
  const slot = t => '<div class="slot t' + t + '"><b>Team ' + t + '</b>' + (su[t].length ? su[t].map(id => esc(pname(id))).join('<br>') : '<span class="muted">Pick 2</span>') + '</div>';
  h += '<section class="stack"><div class="slots">' + slot('A') + '<div class="slot-line" aria-hidden="true"></div>' + slot('B') + '</div><div class="card"><ul class="plist">' + ids.map(id => {
    const b = t => { const on = su[t].indexOf(id) >= 0; return '<button type="button" class="pick t' + t + '" data-act="assign" data-v="' + t + ':' + id + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc(pname(id)) + ' on team ' + t + '">' + t + '</button>'; };
    return '<li>' + pmark(id) + '<span class="nm">' + esc(pname(id)) + (S.mode === 'cloud' && !S.players[id].uid ? '<span class="tag">guest</span>' : '') + '</span>' + b('A') + b('B') + '</li>'; }).join('') + '</ul></div>' + add + '</section>';
  h += '<section class="card"><h3 class="tape">House rules</h3>' +
    '<div class="setrow"><span class="lbl">Play to</span><span class="stepper"><button type="button" class="btn sm" id="target-down" data-act="target" data-v="-1" aria-label="Lower target score">&minus;</button><span class="v num" id="target-value" aria-live="polite">' + st.target + '</span><button type="button" class="btn sm" id="target-up" data-act="target" data-v="1" aria-label="Raise target score">+</button></span></div>' +
    sw('winBy2', st.winBy2, 'Win by 2') + sw('tinks', st.tinks, 'Tinks', 'Off the cup and down is worth 2') + sw('fieldGoals', st.fieldGoals, 'Field goals', 'Back through your own cups is worth 2') +
    sw('selfSinkLoss', st.selfSinkLoss, 'Self-sink is an automatic loss') +
    '<div class="setrow" style="display:block"><span class="lbl">FIFA<small>' + (st.fifa === 'off' ? 'No kicking the die back into play' : st.fifa === 'preferred' ? 'Preferred: no points. A FIFA catch sits the air-ball thrower out of the next defense' : 'Points: a FIFA catch is 1 for the defense, max 3 per team. You can\'t win on a FIFA') + '</small></span>' +
    '<div class="seg" style="margin-top:8px">' + [['off', 'Off'], ['preferred', 'Preferred'], ['points', 'Points']].map(o => '<button type="button" class="btn sm" id="fifa-' + o[0] + '" data-act="fifa" data-v="' + o[0] + '" aria-pressed="' + (st.fifa === o[0] ? 'true' : 'false') + '">' + o[1] + '</button>').join('') + '</div></div></section>';
  const tl = t => (su[t].length ? su[t].map(pname).join(' & ') : 'Team ' + t);
  let res = '';
  if (su.roll) res = '<p class="small" aria-live="polite"><b>Rolled a ' + su.roll + ' (' + (su.roll >= 4 ? 'High' : 'Low') + ').</b> ' + (su.call ? esc(tl(su.caller)) + ' called ' + (su.call === 'high' ? 'High' : 'Low') + ' &mdash; ' + esc(tl(su.firstToss)) + ' toss first.' : 'Pick who tosses first.') + '</p>';
  h += '<section class="card stack"><h3 class="tape">First toss</h3><div class="seg">' + ['A', 'B'].map(t => '<button type="button" class="btn t' + t + '" id="first-' + t + '" data-act="first" data-v="' + t + '" aria-pressed="' + (su.firstToss === t ? 'true' : 'false') + '">' + esc(tl(t)) + '</button>').join('') + '</div>' +
    '<p class="small muted">Or roll for it: one team rolls, the other calls High (4&ndash;6) or Low (1&ndash;3). A correct call takes first toss.</p>' +
    '<div class="row"><button type="button" class="btn sm" id="caller-swap" data-act="caller">' + esc(tl(su.caller)) + ' call</button>' +
    '<button type="button" class="btn sm" id="call-high" data-act="call" data-v="high" aria-pressed="' + (su.call === 'high' ? 'true' : 'false') + '">High</button>' +
    '<button type="button" class="btn sm" id="call-low" data-act="call" data-v="low" aria-pressed="' + (su.call === 'low' ? 'true' : 'false') + '">Low</button>' +
    '<button type="button" class="rollbtn" id="roll-die" data-act="roll" aria-label="Roll the die">' + die(su.roll || 5, 'big' + (su.rolledAt && Date.now() - su.rolledAt < 300 ? ' rolled' : '')) + '</button></div>' + res + '</section>';
  const ok = su.A.length === 2 && su.B.length === 2;
  h += '<button type="button" class="btn primary block big" id="start-game" data-act="start"' + (ok ? '' : ' disabled') + '>' + (ok ? 'Start game' : 'Pick two players per team') + '</button>';
  return h;
}
function myStatsView(s) { // the signed-in person's own numbers, top of the Stats tab
  if (S.mode !== 'cloud' || !S.user) return '';
  const pid = myPlayerId(), u = S.user, head = '<div class="mine-head">' + avatar(u.name, u.photoURL, 'lg') + '<span class="acct-txt"><span class="tape">My stats</span><b>' + esc(pid ? pname(pid) : u.name) + '</b></span></div>';
  if (!pid) return '<section class="card stack mine" id="my-stats">' + head + '<p class="small muted">Link your account to a player to see your own numbers here.</p><button type="button" class="btn sm" data-act="whoopen">Pick my player</button></section>';
  const r = s.rows.filter(x => x.id === pid)[0];
  if (!r || !r.g) return '<section class="card stack mine" id="my-stats">' + head + '<p class="small muted">No finished games for you yet. Get on the table.</p></section>';
  const rank = s.rows.slice().sort((a, b) => b.w - a.w || b.pct - a.pct || b.pts - a.pts).map(x => x.id).indexOf(pid) + 1;
  const c = (k, v) => '<div class="ms"><div class="v num">' + v + '</div><div class="k">' + k + '</div></div>';
  return '<section class="card stack mine" id="my-stats">' + head + '<div class="mystats">' + c('Record', r.w + '&ndash;' + (r.g - r.w)) + c('Win%', Math.round(r.pct * 100) + '%') + c('Points', r.pts) + c('Pts / toss', r.ppt.toFixed(2)) +
    c('Sinks', r.sink) + c('Tinks', r.tink) + c('Catches', r.ctch) + c('Wins rank', '#' + rank) + '</div>' +
    '<p class="small muted num">' + r.g + ' game' + (r.g === 1 ? '' : 's') + ' &middot; ' + r.toss + ' tosses &middot; ' + r.ppg.toFixed(1) + ' points per game</p></section>';
}
function statsView() {
  const s = computeStats(); let h = myStatsView(s) + '<h2>Leaderboard</h2>';
  if (!s.tot.g) return h + '<div class="empty">' + die(3, 'big') + '<p><b>No finished games yet</b></p><p class="muted small">Finish a game and the leaderboard fills in.</p></div>';
  const top = (k, min) => s.rows.filter(r => !min || r.toss >= min).sort((a, b) => b[k] - a[k] || b.g - a.g)[0];
  const tw = top('w'), tp = top('ppt', 1), ts = top('sink'), tc = top('ctch');
  const tile = (k, v, sub) => '<div class="tile"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s num">' + sub + '</div></div>';
  h += '<div class="tiles">' + tile('Most wins', esc(tw.name), tw.w + ' of ' + tw.g + ' games') + (tp ? tile('Best arm', esc(tp.name), tp.ppt.toFixed(2) + ' pts per toss') : '') +
    (ts && ts.sink ? tile('Sink leader', esc(ts.name), ts.sink + ' sink' + (ts.sink === 1 ? '' : 's')) : tile('Sinks', '0', 'Nobody has sunk one yet')) +
    (tc && tc.ctch ? tile('Best hands', esc(tc.name), tc.ctch + ' catch' + (tc.ctch === 1 ? '' : 'es')) : tile('Games', String(s.tot.g), s.tot.toss + ' tosses logged')) + '</div>';
  const withGames = s.rows.filter(r => r.trend.length).sort((a, b) => a.name.localeCompare(b.name));
  if (withGames.length) {
    const mineId = myPlayerId(), cur = withGames.filter(r => r.id === ui.trend)[0] || withGames.filter(r => r.id === mineId)[0] || withGames.filter(r => r.id === tw.id)[0] || withGames[0];
    h += '<section class="card stack"><h3 class="tape">Points per game</h3><div class="chips scrollx">' + withGames.map(r => '<button type="button" class="chip" data-act="trend" data-v="' + r.id + '" aria-pressed="' + (r.id === cur.id ? 'true' : 'false') + '">' + esc(r.name) + '</button>').join('') + '</div>' + trendChart(cur) + '</section>';
  }
  h += '<section class="card stack"><h3 class="tape">How they score</h3>' + mixChart(s.rows) + '</section>';
  const k = ui.sort.k, dir = ui.sort.dir;
  s.rows.sort((a, b) => { const d = k === 'name' ? a.name.localeCompare(b.name) : a[k] - b[k]; return d * dir || b.w - a.w || a.name.localeCompare(b.name); });
  h += '<section class="stack"><h3 class="tape">Players &middot; tap a column to sort</h3><div class="scroll"><table><thead><tr>' + COLS.map(c =>
    '<th scope="col"' + (k === c[0] ? ' aria-sort="' + (dir < 0 ? 'descending' : 'ascending') + '"' : '') + '><button type="button" id="sort-' + c[0] + '" data-act="sort" data-v="' + c[0] + '" title="' + c[2] + '" aria-label="Sort by ' + c[2] + '">' + c[1] + '</button></th>').join('') +
    '</tr></thead><tbody>' + s.rows.map(r => '<tr>' + COLS.map(c => '<td' + (k === c[0] ? ' class="hi"' : '') + '>' + (c[0] === 'name' ? pmark(r.id) : '') + fmt(c[0], r[c[0]]) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' +
    '<p class="small onwood">Finished games only. Points count what a player scored on their own tosses.</p></section>';
  h += '<section class="stack"><h3 class="tape">Best duos</h3><div class="scroll"><table><thead><tr><th scope="col"><button type="button" disabled>Duo</button></th><th scope="col"><button type="button" disabled>W&ndash;L</button></th><th scope="col"><button type="button" disabled>Win%</button></th><th scope="col"><button type="button" disabled>Pt diff</button></th></tr></thead><tbody>' +
    s.duos.slice(0, 10).map(d => { const df = d.pf - d.pa; return '<tr><td style="max-width:190px">' + esc(d.ids.map(pname).join(' & ')) + '</td><td>' + d.w + '&ndash;' + (d.g - d.w) + '</td><td>' + Math.round(d.pct * 100) + '%</td><td>' + (df > 0 ? '+' : '') + df + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
  const r = s.rec, rl = (k2, x, unit) => (x ? tile(k2, x.v + ' ' + unit, esc(x.who) + ' &middot; ' + fdate(x.g.endedAt)) : '');
  const rh = rl('Most sinks in a game', r.sinks, 'sinks') + rl('Most points in a game', r.pts, 'pts') + rl('Biggest comeback', r.comeback, 'down') + rl('Longest game', r.long, 'tosses');
  if (rh) h += '<section class="stack"><h3 class="tape">Records</h3><div class="tiles two">' + rh + '</div></section>';
  return h;
}
function historyView() {
  const fs = finals(); const h = '<h2>History</h2>';
  if (!fs.length) return h + '<div class="empty">' + die(2, 'big') + '<p><b>No games in the books</b></p><p class="muted small">Finished games land here with the full toss log.</p></div>';
  return h + '<ul class="hist">' + fs.map(g => {
    const c = calc(g), open = ui.open === g.id, w = g.winner;
    const tm = t => '<span class="tm' + (w === t ? ' w' : '') + '"><span class="c' + t + '">&#9632;</span> ' + esc(tname(g, t)) + (w === t ? ' &middot; won' : '') + '</span>';
    let li = '<li><button type="button" class="hbtn" id="hist-' + g.id + '" data-act="open" data-v="' + g.id + '" aria-expanded="' + (open ? 'true' : 'false') + '">' + tm('A') + '<span class="fs num">' + c.sc.A + '&ndash;' + c.sc.B + '</span>' + tm('B') +
      '<span class="small muted" style="grid-column:1/-1">' + fdate(g.endedAt) + ' &middot; ' + c.tosses + ' tosses' + (g.called ? ' &middot; called early' : '') + '</span></button>';
    if (open) {
      const st = g.settings;
      li += '<div class="detail stack"><p class="small muted">To ' + st.target + (st.winBy2 ? ', win by 2' : '') + ' &middot; tinks ' + (st.tinks ? 'on' : 'off') + ' &middot; field goals ' + (st.fieldGoals ? 'on' : 'off') + ' &middot; FIFA ' + st.fifa + ' &middot; ' + esc(tname(g, g.firstToss || 'A')) + ' tossed first</p>' + feed(g) +
        (ui.confirmDel === g.id ? '<div class="confirm"><b>Delete this game and its stats?</b><button type="button" class="btn danger block" data-act="delyes" data-v="' + g.id + '">Delete game</button><button type="button" class="btn ghost block" data-act="delno">Keep it</button></div>'
          : canDelete(g) ? '<button type="button" class="btn sm ghost danger" data-act="delask" data-v="' + g.id + '">Delete game</button>' : '<p class="small muted">Only the person who logged this game or a league admin can delete it.</p>') + '</div>';
    }
    return li + '</li>'; }).join('') + '</ul>';
}
function memberRows() { // join requests + member list, shown on the Players tab
  const ms = Object.keys(S.members).map(u => Object.assign({ uid: u }, S.members[u])), adm = isAdmin(), own = isOwner();
  const pend = ms.filter(m => m.status !== 'approved').sort((a, b) => (a.requestedAt || 0) - (b.requestedAt || 0));
  const appr = ms.filter(m => m.status === 'approved').sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  const linked = {}; Object.keys(S.players).forEach(id => { if (S.players[id].uid) linked[S.players[id].uid] = id; });
  let req = '', list = '';
  if (adm && pend.length) req = '<section class="stack" id="join-requests"><h3 class="tape">Join requests &middot; ' + pend.length + '</h3><div class="card"><ul class="plist">' + pend.map(m =>
    '<li class="mrow">' + avatar(m.name, m.photoURL) + '<span class="nm">' + esc(m.name) + (m.email ? '<br><span class="small muted" style="font-weight:400">' + esc(m.email) + '</span>' : '') + '</span>' +
    '<button type="button" class="btn sm primary" data-act="approve" data-v="' + esc(m.uid) + '" aria-label="Let ' + esc(m.name) + ' in">Let in</button>' +
    '<button type="button" class="btn sm ghost danger" data-act="deny" data-v="' + esc(m.uid) + '" aria-label="Deny ' + esc(m.name) + '">Deny</button></li>').join('') + '</ul></div></section>';
  if (appr.length) list = '<section class="stack"><h3 class="tape">Members &middot; ' + appr.length + '</h3><div class="card"><ul class="plist">' + appr.map(m => {
    const role = m.role === 'owner' ? 'Owner' : m.role === 'admin' ? 'Admin' : 'Member', mine = m.uid === me();
    let li = '<li class="mrow">' + avatar(m.name, m.photoURL) + '<span class="nm">' + esc(m.name) + (mine ? ' <span class="muted" style="font-weight:400">(you)</span>' : '') +
      '<br><span class="small muted" style="font-weight:400">' + role + ' &middot; ' + (linked[m.uid] ? 'plays as ' + esc(pname(linked[m.uid])) : 'no player yet') + '</span></span>';
    if (!mine && m.role !== 'owner') {
      if (own) li += '<button type="button" class="btn sm" data-act="' + (m.role === 'admin' ? 'unadmin' : 'mkadmin') + '" data-v="' + esc(m.uid) + '">' + (m.role === 'admin' ? 'Remove admin' : 'Make admin') + '</button>';
      if (own || (adm && m.role !== 'admin')) li += '<button type="button" class="btn sm ghost danger" data-act="rmmask" data-v="' + esc(m.uid) + '" aria-label="Remove ' + esc(m.name) + ' from the league">Remove</button>';
    }
    li += '</li>';
    if (ui.rmMember === m.uid) li += '<li><div class="confirm" style="flex:1"><b>Remove ' + esc(m.name) + ' from the league?</b><span class="small">They lose access. Their player and stats stay on the board as a guest.</span>' +
      '<button type="button" class="btn danger block" data-act="rmmyes" data-v="' + esc(m.uid) + '">Remove member</button><button type="button" class="btn ghost block" data-act="rmmno">Keep</button></div></li>';
    return li; }).join('') + '</ul></div>' + (adm ? '' : '<p class="small onwood">The owner and admins approve new members.</p>') + '</section>';
  return { req: req, list: list };
}
function playerMore(id, removable) { // admin tools for one player: link to an account, merge a duplicate into it
  const p = S.players[id], others = Object.keys(S.players).filter(x => x !== id).sort((a, b) => pname(a).localeCompare(pname(b)));
  const taken = {}; Object.keys(S.players).forEach(x => { if (S.players[x].uid) taken[S.players[x].uid] = 1; });
  const freeM = Object.keys(S.members).filter(u => S.members[u].status === 'approved' && !taken[u]).sort((a, b) => String(S.members[a].name).localeCompare(String(S.members[b].name)));
  let h = '<li class="sub"><div class="stack" style="flex:1">';
  if (p.uid) h += '<div class="spread"><span class="small">Linked to <b>' + esc(S.members[p.uid] ? S.members[p.uid].name : 'a former member') + '</b></span><button type="button" class="btn sm" data-act="unlink" data-v="' + id + '">Unlink</button></div>';
  else h += '<span class="small"><b>Link to a member</b> &middot; a guest until linked</span>' + (freeM.length ? '<div class="chips">' + freeM.map(u => '<button type="button" class="chip" data-act="link" data-v="' + id + '" data-u="' + esc(u) + '">' + avatar(S.members[u].name, S.members[u].photoURL, 'xs') + ' ' + esc(S.members[u].name) + '</button>').join('') + '</div>' : '<span class="small muted">Every member already has a player.</span>');
  if (ui.merge && ui.merge.into === id && S.players[ui.merge.from]) {
    const f = ui.merge.from;
    h += '<div class="confirm"><b>Merge ' + esc(pname(f)) + ' into ' + esc(pname(id)) + '?</b><span class="small">Every game and toss by ' + esc(pname(f)) + ' becomes ' + esc(pname(id)) + '\'s, then ' + esc(pname(f)) + ' is deleted. This can\'t be undone.</span>' +
      '<button type="button" class="btn danger block" id="merge-yes" data-act="mergeyes">Merge players</button><button type="button" class="btn ghost block" data-act="mergeno">Cancel</button></div>';
  } else if (others.length) h += '<span class="small"><b>Same person twice?</b> Fold a duplicate into ' + esc(pname(id)) + ':</span><div class="chips">' + others.map(x => '<button type="button" class="chip" data-act="mergeask" data-v="' + id + '" data-u="' + x + '">' + esc(pname(x)) + '</button>').join('') + '</div>';
  if (removable && !(ui.merge && ui.merge.into === id)) h += '<button type="button" class="btn sm ghost danger" data-act="rmplayer" data-v="' + id + '">Remove ' + esc(pname(id)) + ' (no games yet)</button>';
  return h + '</div></li>';
}
function playersView() {
  const ids = Object.keys(S.players).sort((a, b) => pname(a).localeCompare(pname(b))), used = {}, cl = S.mode === 'cloud', adm = isAdmin();
  games().forEach(g => { g.teamA.concat(g.teamB).forEach(id => { used[id] = (used[id] || 0) + 1; }); });
  const mr = cl ? memberRows() : { req: '', list: '' };
  const h = '<h2>Players</h2>' + mr.req + '<form class="row" data-form="addplayer"><input type="text" id="new-player-name" maxlength="24" autocomplete="off" placeholder="' + (cl ? 'Guest or new player name' : 'Player name') + '" aria-label="New player name" value="' + esc(ui.drafts['new-player-name'] || '') + '"><button class="btn primary" id="new-player-add" type="submit">Add player</button></form>';
  if (!ids.length) return h + '<div class="empty">' + die(4, 'big') + '<p><b>No players yet &mdash; add your crew to start</b></p><p class="muted small">' + (cl ? 'Names are shared with everyone in the league.' : 'Add everyone who plays at this table.') + '</p></div>' + mr.list;
  return h + '<div class="card"><ul class="plist">' + ids.map(id => {
    if (ui.rename === id) return '<li><form class="row" style="flex:1" data-form="rename" data-v="' + id + '"><input type="text" id="rename-input" maxlength="24" autocomplete="off" aria-label="Rename ' + esc(pname(id)) + '" value="' + esc(ui.drafts['rename-input'] != null ? ui.drafts['rename-input'] : pname(id)) + '"><button class="btn sm primary" type="submit" id="rename-save">Save</button><button class="btn sm ghost" type="button" data-act="renameno">Cancel</button></form></li>';
    const p = S.players[id], who = cl ? (p.uid ? ' &middot; ' + (p.uid === me() ? 'you' : 'verified') : ' &middot; guest') : '';
    return '<li>' + pmark(id) + '<span class="nm">' + esc(pname(id)) + '<br><span class="small muted num" style="font-weight:400">' + (used[id] || 0) + ' game' + (used[id] === 1 ? '' : 's') + who + '</span></span><button type="button" class="btn sm" data-act="rename" data-v="' + id + '" aria-label="Rename ' + esc(pname(id)) + '">Rename</button>' +
      (cl && adm ? '<button type="button" class="btn sm" data-act="more" data-v="' + id + '" aria-expanded="' + (ui.more === id ? 'true' : 'false') + '" aria-label="Link or merge ' + esc(pname(id)) + '">' + (ui.more === id ? 'Done' : 'Manage') + '</button>' : '') +
      (used[id] || (cl && (adm || p.uid)) ? '' : '<button type="button" class="btn sm ghost danger" data-act="rmplayer" data-v="' + id + '" aria-label="Remove ' + esc(pname(id)) + '">Remove</button>') + '</li>' +
      (cl && adm && ui.more === id ? playerMore(id, !used[id]) : ''); }).join('') + '</ul></div>' +
    (cl ? '<p class="small onwood">Players with a photo are linked to a Google account. Guests are friends without the app: anyone in the league can log their tosses.</p>' : '') + mr.list;
}
function shownGame() { // the game the Game tab is showing, if any
  const g = liveGame();
  if (g) { ui.watchId = g.id; return g; }
  // a game someone else just finished on another phone: show its result here too
  if (ui.watchId && S.games[ui.watchId] && S.games[ui.watchId].status === 'final' && !ui.setupOpen && !ui.lastId) ui.lastId = ui.watchId;
  ui.watchId = null;
  if (!ui.setupOpen && ui.lastId && S.games[ui.lastId]) { const f = norm(ui.lastId, S.games[ui.lastId]); if (f.status === 'final' && f.winner) return f; }
  return null;
}
function menuView() {
  const sy = syncState(), loc = lsRead(), nG = Object.keys(loc.games).length, nP = Object.keys(loc.players).length, th = lsGet(LS_THEME) || 'auto';
  let h = '<div class="scrim" data-act="menuclose"></div><section class="sheet" role="dialog" aria-modal="true" aria-label="League and settings"><div class="spread"><h2>' + (S.mode === 'cloud' ? 'Your league' : 'Settings') + '</h2><button type="button" class="btn sm ghost" id="menu-close" data-act="menuclose">Close</button></div>';
  if (S.mode === 'cloud') {
    const u = S.user, role = myRole(), nPend = Object.keys(S.members).filter(x => S.members[x].status !== 'approved').length;
    h += '<div class="acct">' + avatar(u.name, u.photoURL, 'lg') + '<span class="acct-txt"><b>' + esc(u.name) + '</b><small>' + (role === 'owner' ? 'League owner' : role === 'admin' ? 'League admin' : 'Member') + (u.email ? ' &middot; ' + esc(u.email) : '') + '</small></span>' +
      '<button type="button" class="btn sm" id="sign-out" data-act="signout">Sign out</button></div>' +
      '<div class="codecard"><span class="tape">League code</span><div class="code" id="code-text">' + esc(S.code) + '</div><p class="small">Share it. Anyone who enters this code can ask to join; the owner or an admin lets them in.</p>' +
      '<div class="row"><button type="button" class="btn primary" id="copy-code" data-act="copycode">Copy code</button>' + (navigator.share ? '<button type="button" class="btn" data-act="sharecode">Share</button>' : '') + '</div></div>' +
      '<p class="syncline"><span class="dot ' + sy.k + '"></span><b>' + esc(sy.t) + '</b>' + (sy.k === 'offline' ? ' &middot; keep logging, it catches up when you have signal' : '') + (S.syncErr || S.authErr ? ' &middot; ' + esc(S.authErr || S.syncErr) : '') + '</p>' +
      (isAdmin() && nPend ? '<button type="button" class="btn primary block" data-act="gomembers">' + nPend + ' join request' + (nPend === 1 ? '' : 's') + ' waiting</button>' : '') +
      '<button type="button" class="btn block" id="switch-league" data-act="leagueswitch">Switch league</button>' +
      (isAdmin() && (nG || nP) ? '<button type="button" class="btn block" data-act="importlocal">Copy this phone\'s old stats into the league (' + nG + ' game' + (nG === 1 ? '' : 's') + ', ' + nP + ' player' + (nP === 1 ? '' : 's') + ')</button>' : '') +
      (role === 'owner' ? '' : ui.confirmLeave ? '<div class="confirm"><b>Leave ' + esc(S.code) + '?</b><span class="small">You\'ll need to be let back in. Your player and stats stay on the board.</span><button type="button" class="btn danger block" data-act="leaveyes">Leave league</button><button type="button" class="btn ghost block" data-act="leaveno">Stay</button></div>'
        : '<button type="button" class="btn ghost block danger" data-act="leaveask">Leave this league</button>');
  } else {
    h += '<p class="note">Cloud not set up &mdash; stats saved on this device only. Paste your Firebase config into <b>firebase-config.js</b> to share a league across phones.</p>';
  }
  h += '<h3 class="tape">Lights</h3><div class="seg">' + [['auto', 'Auto'], ['light', 'Daylight'], ['dark', 'String lights']].map(o => '<button type="button" class="btn sm" data-act="theme" data-v="' + o[0] + '" aria-pressed="' + (th === o[0] ? 'true' : 'false') + '">' + o[1] + '</button>').join('') + '</div>';
  return h + '</section>';
}

/* ---------- feedback: stamps, splashes, confetti ---------- */
const fxEl = document.getElementById('fx');
let fxPrev = null;
function stamp(text, cls) {
  fxEl.querySelectorAll('.stamp').forEach(x => x.remove());
  const el = document.createElement('div'); el.className = 'stamp ' + (cls || ''); el.textContent = text; el.setAttribute('aria-hidden', 'true');
  fxEl.appendChild(el); setTimeout(() => el.remove(), 1300);
}
function burst(kind) {
  if (reducedMotion()) return;
  const n = kind === 'win' ? 44 : 22, w = window.innerWidth, h = window.innerHeight;
  for (let i = 0; i < n; i++) {
    const el = document.createElement('i'); const r = Math.random;
    if (kind === 'win') {
      el.className = 'bit fall ' + ['cupbit', 'diebit', 'foam'][i % 3];
      el.style.left = (r() * w) + 'px'; el.style.top = '-30px';
      el.style.setProperty('--dx', ((r() - 0.5) * 160) + 'px'); el.style.setProperty('--dy', (h + 80) + 'px');
      el.style.setProperty('--rot', ((r() - 0.5) * 1080) + 'deg'); el.style.animationDuration = (1.4 + r() * 1.4) + 's'; el.style.animationDelay = (r() * 0.5) + 's';
    } else {
      const a = -Math.PI * (0.15 + r() * 0.7), d = 90 + r() * 170;
      el.className = 'bit splash ' + (i % 3 ? 'beer' : 'foam');
      el.style.left = (w / 2) + 'px'; el.style.top = (h * 0.42) + 'px';
      el.style.setProperty('--dx', (Math.cos(a) * d) + 'px'); el.style.setProperty('--dy', (Math.sin(a) * d) + 'px');
      el.style.setProperty('--s', String(0.6 + r() * 1.2)); el.style.animationDuration = (0.7 + r() * 0.4) + 's';
    }
    fxEl.appendChild(el); setTimeout(() => el.remove(), 3600);
  }
}
function retrigger(el, cls) { if (!el) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
function feedback(g, prev) {
  const c = calc(g), e = g.events[g.events.length - 1], added = g.events.length === prev.n + 1;
  ['A', 'B'].forEach(t => { if (c.sc[t] !== prev[t]) retrigger(document.getElementById('score-' + t), 'pop'); });
  const justWon = g.status === 'final' && prev.status !== 'final';
  if (added && e) {
    const sink = e.kind === 'sink' || e.kind === 'fifaSink';
    if (sink) { retrigger(document.getElementById('board'), 'shake'); burst('sink'); }
    if (!justWon) {
      if (sink) stamp('Sink!', 'cup');
      else if (e.kind === 'tink' || e.kind === 'fifaTink') stamp('Tink!');
      else if (e.kind === 'fg') stamp('Field goal!');
      else if (e.fifa) stamp('FIFA!');
      else if (e.kind === 'caught') stamp('Caught!', 'quiet');
      else if (e.kind === 'point') stamp('+1');
    }
  }
  if (justWon) { stamp(e && e.kind === 'selfSink' ? 'Self-sink!' : 'Game!', 'cup win'); burst('win'); }
}
let toastT = null;
function toast(msg) { const el = document.getElementById('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 2600); }

/* ---------- render ---------- */
const view = document.getElementById('view'), notes = document.getElementById('notes'), sheet = document.getElementById('sheet'), chipEl = document.getElementById('league-chip');
function askWho() { // an approved member with no player yet gets asked once per visit which player they are
  if (S.mode !== 'cloud' || !S.user || myPlayerId()) { ui.who = false; return false; }
  if (ui.who) return true;
  return !ui.whoSkip && !!S.meta.players && !S.meta.players.fromCache && !S.meta.players.hasPendingWrites;
}
function render() {
  const a = document.activeElement, fid = a && a.id && (view.contains(a) || sheet.contains(a)) ? a.id : null; let ss = null, se = null;
  if (fid && a.tagName === 'INPUT') { try { ss = a.selectionStart; se = a.selectionEnd; } catch (e) {} }
  let n = '';
  if (S.mode === 'local') n += '<div class="note warn" id="local-banner">Cloud not set up &mdash; stats saved on this device only</div>';
  if (S.syncErr || (S.authErr && S.mode !== 'signin')) n += '<div class="note warn">' + esc(S.authErr || S.syncErr) + '</div>';
  if (S.err) n += '<div class="note warn">' + esc(S.err) + ' <button type="button" class="linkbtn" data-act="clearerr">Dismiss</button></div>';
  notes.innerHTML = n;
  const sy = syncState(), inApp = S.mode === 'local' || S.mode === 'cloud';
  document.body.classList.toggle('no-tabs', !inApp);
  chipEl.hidden = !inApp;
  chipEl.innerHTML = '<span class="dot ' + sy.k + '"></span><span class="chip-txt"><b>' + esc(S.mode === 'cloud' ? S.code : 'Local') + '</b><small id="sync-status">' + esc(sy.t) + '</small></span>';
  chipEl.setAttribute('aria-label', (S.mode === 'cloud' ? 'League ' + S.code : 'Local mode') + ', ' + sy.t + '. Open menu');
  const nReq = S.mode === 'cloud' && isAdmin() ? Object.keys(S.members).filter(u => S.members[u].status !== 'approved').length : 0, badge = document.getElementById('members-badge');
  if (badge) { badge.hidden = !nReq; badge.textContent = nReq ? String(nReq) : ''; badge.setAttribute('aria-label', nReq + ' join request' + (nReq === 1 ? '' : 's')); }
  document.querySelectorAll('#tabs a').forEach(el => { if (el.dataset.tab === ui.tab) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current'); });
  const loading = S.mode === 'loading' || (S.mode === 'cloud' && !(S.got.players && S.got.games));
  let cur = null;
  if (loading) view.innerHTML = '<div class="empty">' + die(6, 'big') + '<p>Setting the table&hellip;</p></div>';
  else if (S.mode === 'down') view.innerHTML = '<div class="empty">' + die(1, 'big') + '<p><b>Can\'t reach the cloud</b></p><p class="muted small">The first launch needs a connection to load the sync engine. After that it works offline.</p><button type="button" class="btn primary" data-act="reload">Try again</button></div>';
  else if (S.mode === 'signin') view.innerHTML = signinView();
  else if (S.mode === 'league') view.innerHTML = leagueView();
  else if (S.mode === 'pending') view.innerHTML = pendingView();
  else if (S.mode === 'checking') view.innerHTML = checkingView();
  else if (askWho()) view.innerHTML = whoView();
  else {
    cur = shownGame();
    view.innerHTML = ui.tab === 'stats' ? statsView() : ui.tab === 'history' ? historyView() : ui.tab === 'players' ? playersView() : cur ? (cur.status === 'live' ? liveView(cur) : finishedView(cur)) : setupView();
  }
  sheet.innerHTML = ui.menu && inApp ? menuView() : '';
  sheet.hidden = !(ui.menu && inApp);
  if (fid) { const el = document.getElementById(fid); if (el && el !== document.activeElement) { try { el.focus({ preventScroll: true }); if (ss != null) el.setSelectionRange(ss, se); } catch (e) {} } }
  // score pops and celebrations, driven by data so every phone in the league sees them
  if (cur) {
    const c = calc(cur), now = { id: cur.id, n: cur.events.length, A: c.sc.A, B: c.sc.B, status: cur.status };
    if (fxPrev && fxPrev.id === cur.id && ui.tab === 'game' && (fxPrev.n !== now.n || fxPrev.status !== now.status)) feedback(cur, fxPrev);
    fxPrev = now;
  } else if (inApp && !loading) fxPrev = null;
}

/* ---------- actions ---------- */
function addPlayer(draftId) {
  const nm = (ui.drafts[draftId] || '').trim().slice(0, 24); if (!nm) return;
  ui.drafts[draftId] = ''; put('players', uid(), { name: nm, createdAt: Date.now() });
}
function applyTheme() { const t = lsGet(LS_THEME); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch (e) {}
  try { const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch (e) { return false; }
}
const ACT = {
  out: v => { if (v === 'point' || v === 'sink' || v === 'caught' || v === 'selfSink' || v === 'fifa') { ui.panel = { kind: v }; buzz(8); render(); } else logEvent(v); },
  log: (v, b) => { let x = {}; try { x = JSON.parse(b.dataset.x || '{}'); } catch (e) {} logEvent(v, x); },
  pset: (v, b) => { const k = b.dataset.k; ui.panel[k] = ui.panel[k] === v ? null : v; render(); },
  pcancel: () => { ui.panel = null; render(); },
  thrower: v => { ui.thrower = v; buzz(8); render(); },
  'switch': () => { const g = liveGame(); if (!g) return; ui.tossTeam = opp(tossInfo(g).team); ui.thrower = null; buzz(8); render(); },
  undo: () => { const g = liveGame(); if (!g || !g.events.length) return; ui.panel = null; ui.tossTeam = null; ui.thrower = null; saveGame(Object.assign({}, g, { events: g.events.slice(0, -1) })); },
  undofinal: () => { let g = S.games[ui.lastId]; if (!g || liveGame()) return; g = norm(ui.lastId, g);
    const ng = Object.assign({}, g, { status: 'live', winner: null, endedAt: null, events: g.called ? g.events : g.events.slice(0, -1) }); delete ng.score; delete ng.called; saveGame(ng); },
  endask: () => { ui.confirmEnd = true; render(); },
  endno: () => { ui.confirmEnd = false; render(); },
  callit: v => { const g = liveGame(); if (!g) return; ui.confirmEnd = false; ui.lastId = g.id; ui.setupOpen = false; saveGame(Object.assign({}, g, { status: 'final', winner: v, called: true, endedAt: Date.now(), score: calc(g).sc })); },
  discard: () => { const g = liveGame(); if (!g) return; ui.confirmEnd = false; ui.panel = null; ui.lastId = null; ui.watchId = null; put('games', g.id, null); },
  rematch: () => { const g = S.games[ui.lastId]; ui.setup = g ? newSetup(norm(ui.lastId, g)) : null; ui.setupOpen = true; render(); window.scrollTo(0, 0); },
  newgame: () => { ui.setup = null; ui.setupOpen = true; render(); window.scrollTo(0, 0); },
  assign: v => { const su = ui.setup, t = v.slice(0, 1), id = v.slice(2), i = su[t].indexOf(id);
    if (i >= 0) su[t].splice(i, 1); else { if (su[t].length >= 2) return; const o = su[opp(t)].indexOf(id); if (o >= 0) su[opp(t)].splice(o, 1); su[t].push(id); } render(); },
  toggle: v => { ui.setup.settings[v] = !ui.setup.settings[v]; render(); },
  target: v => { const s = ui.setup.settings; s.target = Math.max(3, Math.min(30, s.target + Number(v))); render(); },
  fifa: v => { ui.setup.settings.fifa = v; render(); },
  first: v => { ui.setup.firstToss = v; render(); },
  caller: () => { const su = ui.setup; su.caller = opp(su.caller); su.roll = null; render(); },
  call: v => { const su = ui.setup; su.call = su.call === v ? null : v; su.roll = null; render(); },
  roll: () => { const su = ui.setup, n = 1 + Math.floor(Math.random() * 6); su.roll = n; su.rolledAt = Date.now(); buzz([15, 30, 15]);
    if (su.call) su.firstToss = ((su.call === 'high') === (n >= 4)) ? su.caller : opp(su.caller); render(); },
  start: () => { const su = ui.setup; if (!su || su.A.length !== 2 || su.B.length !== 2 || liveGame()) return;
    const id = uid(); ui.setup = null; ui.setupOpen = false; ui.lastId = null; ui.panel = null; ui.tossTeam = null; ui.thrower = null; buzz(30);
    const ng = { teamA: su.A.slice(), teamB: su.B.slice(), settings: Object.assign({}, su.settings), events: [], status: 'live', winner: null, firstToss: su.firstToss, startedAt: Date.now(), endedAt: null };
    if (S.mode === 'cloud' && me()) ng.loggedBy = me();
    put('games', id, ng);
    window.scrollTo(0, 0); },
  sort: v => { if (ui.sort.k === v) ui.sort.dir = -ui.sort.dir; else ui.sort = { k: v, dir: v === 'name' ? 1 : -1 }; render(); },
  trend: v => { ui.trend = v; ui.chartSel = null; render(); },
  pt: v => { ui.chartSel = Number(v); render(); },
  open: v => { ui.open = ui.open === v ? null : v; ui.confirmDel = null; render(); },
  delask: v => { ui.confirmDel = v; render(); },
  delno: () => { ui.confirmDel = null; render(); },
  delyes: v => { ui.confirmDel = null; ui.open = null; if (ui.lastId === v) ui.lastId = null; put('games', v, null); },
  rename: v => { ui.rename = v; ui.drafts['rename-input'] = null; render(); const el = document.getElementById('rename-input'); if (el) { el.focus(); el.select(); } },
  renameno: () => { ui.rename = null; render(); },
  rmplayer: v => { if (ui.more === v) ui.more = null; put('players', v, null); },
  clearerr: () => { S.err = ''; render(); },
  reload: () => { location.reload(); },
  menu: () => { ui.menu = !ui.menu; render(); if (ui.menu) { const el = document.getElementById('menu-close'); if (el) el.focus(); } },
  menuclose: () => { ui.menu = false; render(); chipEl.focus(); },
  theme: v => { lsSet(LS_THEME, v === 'auto' ? null : v); applyTheme(); render(); },
  copycode: async () => { toast(await copyText(S.code) ? 'League code copied' : 'Copy failed — the code is ' + S.code); },
  sharecode: () => { try { navigator.share({ title: 'Sig Tau Beer Die', text: 'Join our Sig Tau Beer Die league. Code: ' + S.code, url: location.href.split('#')[0] }).catch(() => {}); } catch (e) {} },
  leagueswitch: () => { ui.drafts['league-code'] = ''; const c = S.code; toPicker('', false); ui.drafts['league-code'] = ''; if (c) lsSet(LS_LEAGUE, c); render(); },
  leagueback: () => { const c = lsGet(LS_LEAGUE); if (c && CODE_RE.test(c) && me()) watchLeague(c); },
  signin: () => { signIn(); },
  signout: () => { signOut(); },
  cancelreq: () => { leaveLeague(); },
  leaveask: () => { ui.confirmLeave = true; render(); },
  leaveno: () => { ui.confirmLeave = false; render(); },
  leaveyes: () => { ui.confirmLeave = false; if (!isOwner()) leaveLeague(); },
  gomembers: () => { ui.menu = false; if (location.hash !== '#players') location.hash = '#players'; else render(); },
  approve: v => { if (isAdmin()) memberSet(v, { status: 'approved', approvedAt: Date.now() }); },
  deny: v => { if (isAdmin()) memberRemove(v); },
  mkadmin: v => { if (isOwner()) memberSet(v, { role: 'admin' }); },
  unadmin: v => { if (isOwner()) memberSet(v, { role: 'member' }); },
  rmmask: v => { ui.rmMember = v; render(); },
  rmmno: () => { ui.rmMember = null; render(); },
  rmmyes: v => { ui.rmMember = null; if (isAdmin() && v !== me()) memberRemove(v); render(); },
  more: v => { ui.more = ui.more === v ? null : v; ui.merge = null; render(); },
  link: (v, b) => { if (isAdmin()) linkPlayer(v, b.dataset.u); },
  unlink: v => { if (isAdmin()) linkPlayer(v, null); },
  mergeask: (v, b) => { ui.merge = { into: v, from: b.dataset.u }; render(); },
  mergeno: () => { ui.merge = null; render(); },
  mergeyes: () => { const m = ui.merge; ui.merge = null; ui.more = null; if (m && isAdmin() && S.mode === 'cloud') mergePlayers(m.from, m.into); render(); },
  whome: v => { const p = S.players[v]; ui.who = false; if (p && !p.uid && me()) linkPlayer(v, me()); else render(); },
  whonew: () => { ui.who = false; createMyPlayer(); render(); },
  whoskip: () => { ui.who = false; ui.whoSkip = true; render(); },
  whoopen: () => { ui.who = true; ui.whoSkip = false; render(); window.scrollTo(0, 0); },
  leaguecreate: () => { leagueGo(true); },
  importlocal: () => { if (S.mode !== 'cloud' || !isAdmin()) return; const loc = lsRead(); let n = 0;
    ['players', 'games'].forEach(col => Object.keys(loc[col]).forEach(id => { if (!S[col][id]) { put(col, id, col === 'games' ? Object.assign({}, loc[col][id], { loggedBy: me() }) : loc[col][id]); n++; } }));
    toast(n ? 'Copied ' + n + ' item' + (n === 1 ? '' : 's') + ' into ' + S.code : 'Already in the league — nothing to copy'); }
};
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-act]'); if (!b || b.disabled) return; const f = ACT[b.dataset.act]; if (f) f(b.dataset.v, b); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && ui.menu) { ACT.menuclose(); return; }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('hit')) { e.preventDefault(); ACT.pt(e.target.dataset.v); }
});
// a Google profile photo that fails to load is dropped, leaving the initial underneath
document.addEventListener('error', e => { const t = e.target; if (t && t.tagName === 'IMG' && t.parentNode && t.parentNode.classList && t.parentNode.classList.contains('av')) t.remove(); }, true);
document.addEventListener('input', e => { if (e.target.id && e.target.tagName === 'INPUT') ui.drafts[e.target.id] = e.target.value; });
document.addEventListener('submit', e => {
  const f = e.target, k = f.dataset && f.dataset.form; if (!k) return; e.preventDefault();
  if (k === 'quickadd') addPlayer('quick-player-name');
  else if (k === 'addplayer') addPlayer('new-player-name');
  else if (k === 'league') leagueGo(false);
  else if (k === 'rename') { const id = f.dataset.v, p = S.players[id], d = ui.drafts['rename-input'], nm = (d == null ? '' : d).trim().slice(0, 24); ui.rename = null; ui.drafts['rename-input'] = null;
    if (p && nm && nm !== p.name) put('players', id, Object.assign({}, p, { name: nm })); else render(); }
});
const hashTab = () => { const t = (location.hash || '').replace('#', ''); return TABS.indexOf(t) >= 0 ? t : 'game'; };
window.addEventListener('hashchange', () => { ui.tab = hashTab(); fxEl.innerHTML = ''; render(); window.scrollTo(0, 0); });
window.addEventListener('storage', e => { if (e.key === LS && S.mode === 'local') { Object.assign(S, lsRead()); render(); } });
document.getElementById('brand-die').innerHTML = die(5);
applyTheme();
ui.tab = hashTab();
boot();
if ('serviceWorker' in navigator && location.protocol !== 'file:') window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
