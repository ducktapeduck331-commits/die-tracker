/* Sig Tau Beer Die — standalone PWA.
   Data model, all under leagues/{CODE}: the league doc {name, ownerUid, createdAt};
   members/{uid} {uid, name, photoURL, email, status: pending|approved, role: owner|admin|member, playerId?, requestedAt, approvedAt};
   players/{id} {name, createdAt, uid?} (uid = the Google account the player is linked to; none = guest);
   games/{id} {teamA, teamB, settings, events[], status, winner, firstToss, startedAt, endedAt, score?, called?, loggedBy, label?}.
   Several games can be live at once. Which live game a phone is scoring is kept on that phone only (localStorage, see myGame).
   settings {target, winRule: redemption|winBy2|first, winBy2 (legacy mirror of winRule), tinks, fieldGoals, fifa, selfSinkLoss}.
   Score, winner, whose toss and the redemption state are always derived by replaying events (see calc). Sign-in is Google only; without a Firebase config it runs local-only. */
import { firebaseConfig, configured } from './firebase-config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const opp = t => (t === 'A' ? 'B' : 'A');
const DEF = { target: 12, winRule: 'redemption', winBy2: false, tinks: true, fieldGoals: true, fifa: 'off', selfSinkLoss: true };
const RULES = [['redemption', 'Redemption'], ['winBy2', 'Win by 2'], ['first', 'First to target']];
const MAX_RED = 3; // redemption rounds each team may use per game
/* Games saved before winRule existed only have winBy2 (and the default back then was true), so they replay exactly as they were played. */
const ruleOf = raw => (raw && RULES.some(r => r[0] === raw.winRule) ? raw.winRule : raw && raw.winBy2 === false ? 'first' : 'winBy2');
const ruleText = st => 'First to ' + st.target + (st.winRule === 'redemption' ? ' \u00b7 Redemption' : st.winRule === 'winBy2' ? ' \u00b7 Win by 2' : '');
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function die(n, cls) {
  let h = '';
  for (let i = 0; i < 9; i++) h += '<i' + (PIPS[n].indexOf(i) >= 0 ? ' class="on"' : '') + '></i>';
  return '<span class="die ' + (cls || '') + '" role="img" aria-label="Die showing ' + n + '">' + h + '</span>';
}
const KIND = { point: 'Point', tink: 'Tink', sink: 'Sink', fg: 'Field goal', caught: 'Caught', short: 'Short / dead', low: 'Too low', retoss: 'Die Don\'t Lie', selfSink: 'Self-sink',
  fifaCatch: 'FIFA catch', fifaDrop: "FIFA'd onto table, dropped", fifaTink: "FIFA'd off cup to ground", fifaSink: "FIFA'd into defending cup", fifaOwn: "FIFA'd into offensive cup" };
const REASON = { dropped: 'Dropped', twohand: 'Two-handed catch', trapped: 'Trapped', bobble: 'Bobble touched table' };
const REASON_SHORT = { dropped: 'Dropped', twohand: 'Two-handed', trapped: 'Trapped', bobble: 'Bobble' };
const MIN_CHANCES = 5; // catches + drops needed to rank on the Best hands board
const TABS = ['game', 'stats', 'history', 'players'];
const CODE_RE = /^[A-Z0-9-]{4,32}$/;
const LS = 'beerdie.v1', LS_LEAGUE = 'beerdie.league', LS_THEME = 'beerdie.theme', LS_SEL = 'beerdie.sel.';
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
const reducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const buzz = p => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} };

/* ---------- state + store ---------- */
const S = { players: {}, games: {}, members: {}, member: null, league: null, user: null, mode: 'loading', code: null,
  got: { players: false, games: false }, meta: { players: null, games: null }, syncErr: '', authErr: '', err: '' };
const ui = { tab: 'game', pick: false, setupLive: 0, panel: null, tossTeam: null, thrower: null, confirmEnd: false, setup: null, setupOpen: false, lastId: null, watchId: null,
  sort: { k: 'w', dir: -1 }, open: null, confirmDel: null, rename: null, drafts: {}, menu: false, trend: null, chartSel: null,
  league: { busy: false, msg: '', offer: null }, signBusy: false, who: false, whoSkip: false, more: null, merge: null, rmMember: null, confirmLeave: false, exportOpen: false, h2h: { mode: 'p', a: null, b: null, da: null, db: null } };
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
  S.mode = 'cloud'; ui.menu = false; ui.setup = null; ui.setupOpen = false; ui.lastId = null; ui.watchId = null; ui.panel = null; ui.pick = false; ui.league = { busy: false, msg: '', offer: null };
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
function norm(id, g) {
  const st = Object.assign({}, DEF, g.settings || {}); st.winRule = ruleOf(g.settings); st.winBy2 = st.winRule === 'winBy2';
  return Object.assign({}, g, { id: id, teamA: g.teamA || [], teamB: g.teamB || [], events: g.events || [], settings: st });
}
function games() { return Object.keys(S.games).map(id => norm(id, S.games[id])).filter(g => g.teamA.length === 2 && g.teamB.length === 2); }
function liveGames() { return games().filter(g => g.status === 'live').sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)); }
/* Several games can be live at once. Each phone remembers which one it is scoring: the game id is kept per league in
   localStorage (never in Firestore), with an in-memory copy in case storage is blocked. */
const selMem = {};
const selKey = () => LS_SEL + (S.mode === 'cloud' && S.code ? S.code : 'local');
function selGet() { const k = selKey(); if (!(k in selMem)) selMem[k] = lsGet(k) || null; return selMem[k]; }
function selSet(id) { const k = selKey(); selMem[k] = id || null; lsSet(k, id || null); }
/* The game this phone is scoring: the selected game if it is still live; otherwise, if exactly one game is live, that
   one (and it becomes the selection); otherwise none, and the Game tab shows the picker. Logging, undo, ending and
   everything else that touches "the current game" goes through here, so it only ever acts on this phone's game. */
function myGame() {
  const lv = liveGames(), id = selGet(), g = id ? lv.filter(x => x.id === id)[0] : null;
  if (g) return g;
  if (id && S.games[id] && ui.lastId === id) return null; // this phone is on that game's winner screen
  if (lv.length === 1) { if (id !== lv[0].id) selSet(lv[0].id); return lv[0]; }
  return null;
}
const gameLabel = g => String(g.label || '').trim() || tname(g, 'A') + ' vs ' + tname(g, 'B');
function busyMap(exceptId) { // player id -> the live game they are in right now
  const m = {}; liveGames().forEach(g => { if (g.id !== exceptId) g.teamA.concat(g.teamB).forEach(id => { m[id] = g; }); }); return m;
}
function setupBusy(su) { const busy = busyMap(); return su.A.concat(su.B).filter(id => busy[id]).map(id => ({ id: id, g: busy[id] })); }
function leaveGameUi() { ui.panel = null; ui.confirmEnd = false; ui.tossTeam = null; ui.thrower = null; }
function finals() { return games().filter(g => g.status === 'final').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0)); }
const tname = (g, t) => g['team' + t].map(pname).join(' & ');
const tnameH = (g, t) => g['team' + t].map(id => (S.players[id] && S.players[id].uid ? pmark(id) : '') + esc(pname(id))).join(' &amp; '); // HTML, with avatars for linked players
const canDelete = g => S.mode === 'local' || isAdmin() || (!!g.loggedBy && g.loggedBy === me());
function saveGame(g) { const d = Object.assign({}, g); delete d.id; put('games', g.id, d); }
function isFifaTeamPoint(e) { return !!(e.fifa && e.scoreTeam && e.scoreTeam !== e.team); }
function met(sc, t, st) { return sc[t] >= st.target && (!st.winBy2 || sc[t] - sc[opp(t)] >= 2); }
/* Replays the toss log. Everything about a game's state comes out of here, so undo is just "drop the last event".
   Redemption rule (settings.winRule === 'redemption'):
   - When a team scores and is at or past the target, the game does not end. The other team gets a redemption round of
     2 tosses (one per player). Each team may use MAX_RED rounds per game; if it has none left, the scorer wins on the spot.
   - A redemption shot's points first knock the leader down, but never below target-1; whatever is left over is added to
     the redeeming team. Both tosses are always taken. A re-toss doesn't use one up; a self-sink keeps its normal effect.
   - After the 2 tosses: leader still at the target -> leader wins. Otherwise play goes on (the leader tosses next, which
     falls out of the normal alternation). If the leftover points carried the redeeming team to the target, the old leader
     gets a redemption round against them, or loses on the spot if it has used all of its rounds.
   - FIFA: no FIFA plays during redemption. Outside it, the existing "can't win on a FIFA" rule is kept as is: a FIFA
     point given to the defending team neither wins nor starts a redemption round. That team sits at the target ("hold")
     until it scores a non-FIFA point, and that score is what triggers the round (or the win).
   Events carry redemption/knock/add for display, but the replay recomputes them, so it never depends on those fields. */
function calc(g) {
  const st = g.settings, T = st.target, redRule = st.winRule === 'redemption';
  const sc = { A: 0, B: 0 }, fp = { A: 0, B: 0 }, maxDef = { A: 0, B: 0 }, used = { A: 0, B: 0 }, steps = [];
  let winner = null, n = 0, red = null, survived = false;
  const startRed = (team, leader) => { used[team]++; red = { team: team, leader: leader, n: 0, thrown: [], added: 0 }; };
  for (let i = 0; i < g.events.length && !winner; i++) {
    const e = g.events[i], s = e.scoreTeam, inRed = !!(red && e.team === red.team);
    const step = { before: { A: sc.A, B: sc.B }, red: inRed, knock: 0, add: 0 }; steps.push(step);
    if (e.kind !== 'retoss') n++;
    if (s && e.points) {
      if (inRed && s === red.team) {
        step.knock = Math.min(e.points, Math.max(0, sc[red.leader] - (T - 1))); step.add = e.points - step.knock;
        sc[red.leader] -= step.knock; sc[s] += step.add; red.added += step.add;
      } else { sc[s] += e.points; if (isFifaTeamPoint(e)) fp[s] += e.points; }
    }
    step.after = { A: sc.A, B: sc.B };
    maxDef.A = Math.max(maxDef.A, sc.B - sc.A); maxDef.B = Math.max(maxDef.B, sc.A - sc.B);
    if (e.kind === 'selfSink' && st.selfSinkLoss) { winner = opp(e.team); break; }
    if (inRed) {
      if (e.kind !== 'retoss') { red.n++; red.thrown.push(e.thrower); }
      if (red.n >= 2) {
        const L = red.leader, R = red.team, added = red.added; red = null;
        if (sc[L] >= T) { winner = L; survived = true; }
        else if (added > 0 && sc[R] >= T) { if (used[L] < MAX_RED) startRed(L, R); else winner = R; }
      }
    } else if (s && e.points && !isFifaTeamPoint(e)) {
      if (redRule) { if (!red && sc[s] >= T) { if (used[opp(s)] < MAX_RED) startRed(opp(s), s); else winner = s; } }
      else if (met(sc, s, st)) winner = s;
    }
  }
  let hold = null; if (!winner && !red) ['A', 'B'].forEach(t => { if (met(sc, t, st)) hold = t; });
  return { sc: sc, fp: fp, winner: winner, hold: hold, maxDef: maxDef, tosses: n, red: red, used: used, steps: steps, survived: survived };
}
/* Turn order: each team's turn is 2 tosses, one per teammate (A1, A2, then B1, B2, ...). A re-toss doesn't count.
   Redemption tosses are their own round; afterwards the leader starts a fresh turn. Logging a toss for the other team
   (after "Other side") starts a fresh turn for that team. */
function tossInfo(g) {
  const c = calc(g), red = c.red;
  let team = g.firstToss || 'A', thrown = [];
  g.events.forEach((e, i) => {
    if (e.kind === 'retoss') return;
    if (c.steps[i] && c.steps[i].red) { team = opp(e.team); thrown = []; return; }
    if (e.team !== team) { team = e.team; thrown = []; }
    thrown.push(e.thrower);
    if (thrown.length >= 2) { team = opp(team); thrown = []; }
  });
  if (red) { // redemption: the redeeming team throws both, one toss per player; the order can be swapped but nobody throws twice
    const rp = g['team' + red.team], free = rp.filter(id => red.thrown.indexOf(id) < 0);
    return { team: red.team, thr: ui.thrower && free.indexOf(ui.thrower) >= 0 ? ui.thrower : free[0] || rp[0], red: red, free: free };
  }
  if (ui.tossTeam && ui.tossTeam !== team) { team = ui.tossTeam; thrown = []; }
  const ps = g['team' + team]; let thr = ps.filter(id => thrown.indexOf(id) < 0)[0] || ps[0];
  if (ui.thrower && ps.indexOf(ui.thrower) >= 0) thr = ui.thrower;
  return { team: team, thr: thr, turnToss: thrown.length + 1 };
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
  const g = myGame(); if (!g) return;
  const ti = tossInfo(g), pf = pointsFor(kind, g, ti.team);
  if (ti.red && kind.indexOf('fifa') === 0) return; // no FIFA in redemption
  if (kind.indexOf('fifa') === 0 && kind !== 'fifaCatch') return; // only FIFA catch can be logged now
  if (kind === 'point' && !(extra && g['team' + opp(ti.team)].indexOf(extra.defender) >= 0)) return; // a point is always on one of the two defenders
  const ev = Object.assign({ t: Date.now(), kind: kind, thrower: ti.thr, team: ti.team, points: pf.points, scoreTeam: pf.to || null }, extra || {});
  if (ti.red) { // points stays the shot's value; knock/add record how it was split (for the log; the replay recomputes it)
    ev.redemption = true;
    if (pf.points) { const over = Math.max(0, calc(g).sc[ti.red.leader] - (g.settings.target - 1)); ev.knock = Math.min(pf.points, over); ev.add = pf.points - ev.knock; }
  }
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
  const src = from || lastG, raw = src && S.games[src.id] ? S.games[src.id].settings : null;
  const st = Object.assign({}, DEF, src ? src.settings : {});
  if (!raw || !raw.winRule) st.winRule = DEF.winRule; // carrying house rules over from a pre-redemption game: redemption is the default now
  st.winBy2 = st.winRule === 'winBy2';
  return { A: from ? from.teamA.slice() : [], B: from ? from.teamB.slice() : [], settings: st, firstToss: from && from.winner ? opp(from.winner) : 'A', caller: 'B', call: null, roll: null };
}

/* ---------- stats ---------- */
const MIX = [['pt', 'Points'], ['tink', 'Tinks'], ['sink', 'Sinks'], ['fg', 'Field goals'], ['fifa', 'FIFA plays']];
function mixKey(e) { return e.fifa ? 'fifa' : e.kind === 'tink' ? 'tink' : e.kind === 'sink' ? 'sink' : e.kind === 'fg' ? 'fg' : 'pt'; }
const newRow = id => ({ id: id, name: pname(id), g: 0, w: 0, toss: 0, pts: 0, tink: 0, sink: 0, fg: 0, ctch: 0, drop: 0, dr: { dropped: 0, twohand: 0, trapped: 0, bobble: 0 }, miss: 0, fifa: 0, ss: 0, red: 0, mix: { pt: 0, tink: 0, sink: 0, fg: 0, fifa: 0 }, trend: [] });
const blankRow = id => Object.assign(newRow(id), { pct: 0, ppt: 0, ppg: 0, ch: 0, cpct: -1, stk: 0, lws: 0, lls: 0 }); // a player with no finished games
/* Streaks from a player's finished games, oldest first. stk is the current run: +3 = won the last 3 (W3), -2 = lost the
   last 2 (L2), 0 = no games. lws / lls are the longest win and loss runs ever. */
function streaks(trend) {
  let stk = 0, lws = 0, lls = 0;
  trend.forEach(x => { stk = x.won ? (stk > 0 ? stk + 1 : 1) : (stk < 0 ? stk - 1 : -1); if (stk > lws) lws = stk; if (-stk > lls) lls = -stk; });
  return { stk: stk, lws: lws, lls: lls };
}
const fstk = v => (v > 0 ? 'W' + v : v < 0 ? 'L' + (-v) : '');
/* Head-to-head between two sides (each a list of player ids: one player each, or a duo each). A game counts as a meeting
   when everyone on side X is on one team and everyone on side Y is on the other. For two single players it also counts
   the games they played as partners. Newest first. */
function h2h(X, Y) {
  const r = { g: 0, wx: 0, wy: 0, px: 0, py: 0, meets: [], tg: 0, tw: 0 };
  const side = (g, ids) => (ids.every(id => g.teamA.indexOf(id) >= 0) ? 'A' : ids.every(id => g.teamB.indexOf(id) >= 0) ? 'B' : null);
  finals().forEach(g => {
    const tx = side(g, X), ty = side(g, Y); if (!tx || !ty) return;
    if (tx === ty) { r.tg++; if (g.winner === tx) r.tw++; return; }
    const c = calc(g); r.g++; if (g.winner === tx) r.wx++; else if (g.winner === ty) r.wy++;
    r.px += c.sc[tx]; r.py += c.sc[ty];
    r.meets.push({ id: g.id, at: g.endedAt || 0, sx: c.sc[tx], sy: c.sc[ty], won: g.winner === tx ? 'x' : g.winner === ty ? 'y' : null, tx: tname(g, tx), ty: tname(g, ty) });
  });
  return r;
}
function computeStats() {
  const P = {}, D = {}, fs = finals(), tot = { g: fs.length, toss: 0, sink: 0, pts: 0 };
  const rec = { sinks: null, pts: null, comeback: null, long: null };
  const en = id => P[id] || (P[id] = newRow(id));
  fs.forEach(g => {
    const c = calc(g), per = {};
    ['A', 'B'].forEach(t => {
      g['team' + t].forEach(id => { const p = en(id); p.g++; if (g.winner === t) p.w++; per[id] = { pts: 0, sink: 0, t: t }; });
      const key = g['team' + t].slice().sort().join('|'), d = D[key] || (D[key] = { ids: g['team' + t].slice().sort(), g: 0, w: 0, pf: 0, pa: 0, cb: 0 });
      d.g++; if (g.winner === t) { d.w++; if (c.used[t] > 0) d.cb++; } // comeback: won after having to redeem
      d.pf += c.sc[t]; d.pa += c.sc[opp(t)];
    });
    g.events.forEach((e, i) => {
      if (e.kind === 'retoss') return;
      const p = en(e.thrower), pp = per[e.thrower] || (per[e.thrower] = { pts: 0, sink: 0 }); p.toss++; tot.toss++;
      if (c.steps[i] && c.steps[i].red && e.points && e.scoreTeam === e.team) p.red++; // a redemption toss that scored
      if (e.points && e.scoreTeam === e.team) { p.pts += e.points; pp.pts += e.points; p.mix[mixKey(e)] += e.points; }
      if (e.points) tot.pts += e.points;
      if (e.kind === 'tink') p.tink++;
      else if (e.kind === 'sink') { p.sink++; pp.sink++; tot.sink++; }
      else if (e.kind === 'fg') p.fg++;
      else if (e.kind === 'short' || e.kind === 'low') p.miss++;
      else if (e.kind === 'selfSink') p.ss++;
      else if (e.kind === 'caught' && e.defender) en(e.defender).ctch++;
      else if (e.kind === 'point' && e.defender) { const dp = en(e.defender); dp.drop++; dp.dr[REASON[e.reason] ? e.reason : 'dropped']++; } // any uncaught point on a defender is a drop; untagged points count against nobody
      else if (e.kind === 'fifaCatch' && e.defender) en(e.defender).fifa++;
    });
    Object.keys(per).forEach(id => {
      if (per[id].t) en(id).trend.push({ at: g.endedAt || 0, pts: per[id].pts, won: g.winner === per[id].t, gid: g.id, vs: tname(g, opp(per[id].t)), fs: c.sc[per[id].t] + '–' + c.sc[opp(per[id].t)] });
      if (per[id].sink && (!rec.sinks || per[id].sink > rec.sinks.v)) rec.sinks = { v: per[id].sink, who: pname(id), g: g };
      if (per[id].pts && (!rec.pts || per[id].pts > rec.pts.v)) rec.pts = { v: per[id].pts, who: pname(id), g: g };
    });
    if (g.winner && c.maxDef[g.winner] > 0 && (!rec.comeback || c.maxDef[g.winner] > rec.comeback.v)) rec.comeback = { v: c.maxDef[g.winner], who: tname(g, g.winner), g: g };
    if (!rec.long || c.tosses > rec.long.v) rec.long = { v: c.tosses, who: tname(g, 'A') + ' vs ' + tname(g, 'B'), g: g };
  });
  const rows = Object.keys(P).map(id => { const p = P[id]; p.pct = p.g ? p.w / p.g : 0; p.ppt = p.toss ? p.pts / p.toss : 0; p.ppg = p.g ? p.pts / p.g : 0; p.ch = p.ctch + p.drop; p.cpct = p.ch ? p.ctch / p.ch : -1; p.trend.sort((a, b) => a.at - b.at); Object.assign(p, streaks(p.trend)); return p; });
  const duos = Object.keys(D).map(k => { const d = D[k]; d.pct = d.w / d.g; return d; }).sort((a, b) => b.pct - a.pct || b.w - a.w || (b.pf - b.pa) - (a.pf - a.pa));
  return { rows: rows, duos: duos, rec: rec, tot: tot };
}
const COLS = [['name', 'Player', 'Player'], ['g', 'GP', 'Games played'], ['w', 'W', 'Wins'], ['pct', 'Win%', 'Win percentage'], ['stk', 'Strk', 'Current streak: wins in a row (W) or losses in a row (L)'], ['lws', 'Best W', 'Longest win streak'], ['toss', 'Toss', 'Tosses'], ['pts', 'Pts', 'Points scored'],
  ['ppt', 'P/Toss', 'Points per toss'], ['ppg', 'P/Game', 'Points per game'], ['tink', 'Tink', 'Tinks'], ['sink', 'Sink', 'Sinks'], ['fg', 'FG', 'Field goals'], ['ctch', 'Catch', 'One-hand catches'], ['drop', 'Drops', 'Drops: points scored on this defender'], ['cpct', 'Catch%', 'Catch percentage: catches out of catches plus drops'],
  ['miss', 'Shrt/Low', 'Short and too-low tosses'], ['fifa', 'FIFA', 'FIFA catches'], ['ss', 'Self', 'Self-sinks'], ['red', 'Rdm', 'Redemptions: redemption tosses that scored']];
function fmt(k, v) { return k === 'stk' ? (fstk(v) || '&mdash;') : k === 'cpct' ? (v < 0 ? '&mdash;' : Math.round(v * 100) + '%') : k === 'pct' ? Math.round(v * 100) + '%' : k === 'ppt' ? v.toFixed(2) : k === 'ppg' ? v.toFixed(1) : k === 'name' ? esc(v) : String(v); }
function fdate(t) { if (!t) return ''; try { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; } }

/* ---------- export: spreadsheets + full backup (admins; anyone in local mode) ---------- */
/* CSV: quote a cell when it holds a quote, comma or line break; a leading = + - @ in a text cell gets an apostrophe so a
   spreadsheet never runs a player's name as a formula. Files start with a UTF-8 BOM so Excel reads accents correctly. */
function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const toCsv = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const p2 = n => (n < 10 ? '0' : '') + n;
const ymd = t => { const d = new Date(t); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
const stamp16 = t => { if (!t) return ''; const d = new Date(t); return ymd(t) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
const exportCode = () => (S.mode === 'cloud' && S.code ? S.code : 'LOCAL');
const exportName = (what, ext) => 'beer-die-' + exportCode() + '-' + ymd(Date.now()) + '-' + what + '.' + ext;
const pct1 = v => Math.round(v * 1000) / 10;
/* One row per player (players with no finished game get zeros), every column of the Stats table plus the drop reasons. */
const XCOLS = [['Player', r => r.name], ['Account', r => (S.mode !== 'cloud' ? '' : S.players[r.id] && S.players[r.id].uid ? 'linked' : 'guest')],
  ['Games', r => r.g], ['Wins', r => r.w], ['Losses', r => r.g - r.w], ['Win %', r => pct1(r.pct)], ['Current streak', r => fstk(r.stk)], ['Longest win streak', r => r.lws], ['Longest loss streak', r => r.lls], ['Tosses', r => r.toss], ['Points', r => r.pts],
  ['Points per toss', r => Math.round(r.ppt * 1000) / 1000], ['Points per game', r => Math.round(r.ppg * 100) / 100], ['Tinks', r => r.tink], ['Sinks', r => r.sink], ['Field goals', r => r.fg],
  ['Catches', r => r.ctch], ['Drops', r => r.drop], ['Catch %', r => (r.ch ? pct1(r.cpct) : '')], ['Short / too low', r => r.miss], ['FIFA catches', r => r.fifa], ['Self-sinks', r => r.ss], ['Redemptions', r => r.red],
  ['Drops: dropped', r => r.dr.dropped], ['Drops: two-handed', r => r.dr.twohand], ['Drops: trapped', r => r.dr.trapped], ['Drops: bobble', r => r.dr.bobble], ['Player id', r => r.id]];
function playersCsv() {
  const s = computeStats(), by = {}; s.rows.forEach(r => { by[r.id] = r; });
  const rows = Object.keys(S.players).map(id => by[id] || blankRow(id)).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  return toCsv([XCOLS.map(c => c[0])].concat(rows.map(r => XCOLS.map(c => c[1](r)))));
}
const GCOLS = ['Date', 'Label', 'Team A players', 'Team B players', 'Score A', 'Score B', 'Winner', 'Win rule', 'Target', 'Tosses', 'Logged by', 'Called early', 'Game id'];
function gamesCsv() {
  const fs = finals().slice().reverse(); // oldest first
  return toCsv([GCOLS].concat(fs.map(g => { const c = calc(g), st = g.settings;
    return [stamp16(g.endedAt || g.startedAt), String(g.label || '').trim(), tname(g, 'A'), tname(g, 'B'), c.sc.A, c.sc.B, g.winner ? tname(g, g.winner) : '', (RULES.filter(r => r[0] === st.winRule)[0] || ['', ''])[1], st.target, c.tosses,
      g.loggedBy && S.members[g.loggedBy] ? String(S.members[g.loggedBy].name || '') : '', g.called ? 'yes' : 'no', g.id]; })));
}
function backupJson() { // the raw docs, exactly as stored; members go without their e-mail addresses
  const members = {}; Object.keys(S.members).forEach(u => { const m = Object.assign({}, S.members[u]); delete m.email; members[u] = m; });
  return JSON.stringify({ app: 'Sig Tau Beer Die', format: 1, league: exportCode(), leagueName: S.league && S.league.name ? S.league.name : null, mode: S.mode, exportedAt: new Date().toISOString(),
    players: S.players, games: S.games, members: members }, null, 2);
}
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/* Hand a file to the person. Normally a plain download. Installed to an iPhone home screen a download link may do nothing,
   so there it goes through the share sheet (Save to Files), or failing that opens in a new tab to be saved from there. */
async function saveFile(name, mime, text) {
  let blob, url;
  try { blob = new Blob([text], { type: mime }); url = URL.createObjectURL(blob); } catch (e) { toast("Couldn't build " + name + ' on this device'); return; }
  const later = () => setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
  if (isIOS() && standalone()) {
    try {
      const f = new File([blob], name, { type: mime });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [f] })) { await navigator.share({ files: [f], title: name }); toast('Shared ' + name); later(); return; }
    } catch (e) { if (e && e.name === 'AbortError') { toast('Export cancelled'); later(); return; } }
    let w = null; try { w = window.open(url, '_blank'); } catch (e) {}
    toast(w ? 'Opened ' + name + ' in a new tab. Save it from there.' : "Couldn't open " + name + '. Try from Safari instead of the home-screen app.'); later(); return;
  }
  try {
    const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove(); toast('Downloaded ' + name);
  } catch (e) { let w = null; try { w = window.open(url, '_blank'); } catch (e2) {} toast(w ? 'Opened ' + name + ' in a new tab. Save it from there.' : "Couldn't download " + name); }
  later();
}
function exportFile(what) {
  if (!isAdmin() || (S.mode !== 'cloud' && S.mode !== 'local')) return;
  if (what === 'players') return saveFile(exportName('players', 'csv'), 'text/csv;charset=utf-8', playersCsv());
  if (what === 'games') return saveFile(exportName('games', 'csv'), 'text/csv;charset=utf-8', gamesCsv());
  if (what === 'backup') return saveFile(exportName('backup', 'json'), 'application/json', backupJson());
}
function exportBlock() { // in the menu
  if (!isAdmin()) return '';
  const nF = finals().length, nP = Object.keys(S.players).length;
  if (!ui.exportOpen) return '<button type="button" class="btn block" id="export-open" data-act="exportopen" aria-expanded="false">Export stats</button>';
  return '<div class="codecard exportcard" id="export-card"><span class="tape">Export stats</span>' +
    '<p class="small">' + (S.mode === 'cloud' ? 'The cloud keeps no backups, so save a copy now and then.' : 'These stats live on this device only, so save a copy now and then.') + ' The two spreadsheets open in Excel or Google Sheets; the backup holds everything.</p>' +
    '<button type="button" class="btn block" id="export-players" data-act="export" data-v="players">Players and stats (.csv) <span class="small muted num">' + nP + '</span></button>' +
    '<button type="button" class="btn block" id="export-games" data-act="export" data-v="games">Finished games (.csv) <span class="small muted num">' + nF + '</span></button>' +
    '<button type="button" class="btn primary block" id="export-backup" data-act="export" data-v="backup">Full backup (.json)</button>' +
    '<button type="button" class="btn sm ghost" data-act="exportopen" aria-expanded="true">Hide</button></div>';
}

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

function dropChart(rows) {
  const rs = rows.filter(r => r.drop > 0).sort((a, b) => b.drop - a.drop || a.name.localeCompare(b.name));
  if (!rs.length) return '<p class="muted small">No drops tagged yet.</p>';
  const max = rs[0].drop, keys = Object.keys(REASON_SHORT);
  let h = '<div class="legend">' + keys.map(k => '<span><i class="sw d-' + k + '"></i>' + REASON_SHORT[k] + '</span>').join('') + '</div><div class="mix">';
  rs.forEach(r => {
    let x = 0, bar = '';
    keys.forEach(k => {
      const v = r.dr[k]; if (!v) return; const w = v / max * 100;
      bar += '<rect class="d-' + k + '" x="' + x.toFixed(2) + '%" y="1" width="' + w.toFixed(2) + '%" height="18" rx="4"><title>' + esc(r.name) + ' — ' + REASON_SHORT[k] + ': ' + v + '</title></rect>'; x += w;
    });
    const label = keys.filter(k => r.dr[k]).map(k => REASON_SHORT[k] + ' ' + r.dr[k]).join(', ');
    h += '<div class="mixrow"><span class="nm">' + esc(r.name) + '</span><svg class="mixbar" height="20" role="img" aria-label="' + esc(r.name) + ': ' + r.drop + ' drop' + (r.drop === 1 ? '' : 's') + '. ' + esc(label) + '">' + bar + '</svg><span class="tot num">' + r.drop + '</span></div>';
  });
  return h + '</div>';
}
function defenseView(rows) {
  const by = (a, b) => b.cpct - a.cpct || b.ch - a.ch || a.name.localeCompare(b.name);
  const q = rows.filter(r => r.ch >= MIN_CHANCES).sort(by), nq = rows.filter(r => r.ch > 0 && r.ch < MIN_CHANCES).sort(by);
  const n = (v, one, many) => v + ' ' + (v === 1 ? one : many);
  let h = '<section class="card stack" id="defense"><h3 class="tape">Defense &middot; best hands</h3>';
  if (!q.length && !nq.length) return h + '<p class="muted small">No catches or drops logged yet. Pick the defender when you log a Point and this fills in.</p></section>';
  if (q.length) h += '<ol class="hands" id="best-hands">' + q.map((r, i) => '<li><span class="rk num">' + (i + 1) + '</span><span class="nm">' + pmark(r.id) + esc(r.name) + '</span><span class="cd num">' + n(r.ctch, 'catch', 'catches') + ' &middot; ' + n(r.drop, 'drop', 'drops') + '</span><b class="pc num">' + Math.round(r.cpct * 100) + '%</b></li>').join('') + '</ol>';
  else h += '<p class="small muted">Nobody has ' + MIN_CHANCES + ' chances yet.</p>';
  if (nq.length) h += '<p class="small muted num" id="hands-pending"><b>Not enough chances yet</b> (need ' + MIN_CHANCES + '): ' + nq.map(r => esc(r.name) + ' ' + r.ctch + ' of ' + r.ch).join(', ') + '</p>';
  h += '<p class="small muted">Catch % = catches out of catches + drops.</p>';
  return h + '<h3 class="tape">Drops by reason</h3>' + dropChart(rows) + '</section>';
}

/* ---------- views ---------- */
function describe(e, step) {
  let s = '<b>' + esc(pname(e.thrower)) + '</b> &middot; ' + (step && step.red ? 'Redemption &middot; ' : '') + esc(KIND[e.kind] || e.kind);
  if (step && step.red && (step.knock || step.add)) s += ' <span class="muted num">&mdash; ' + step.before.A + '-' + step.before.B + ' &rarr; ' + step.after.A + '-' + step.after.B + '</span>';
  const why = e.reason && REASON_SHORT[e.reason] ? esc(REASON_SHORT[e.reason].toLowerCase()) : '';
  if (why && !e.defender) s += ' <span class="muted">(' + why + ')</span>';
  if (e.cup === 'partner') s += ' <span class="muted">(partner\'s cup)</span>';
  if (e.defender) s += ' <span class="muted">' + (e.kind === 'caught' || e.kind === 'fifaCatch' ? 'by ' : e.kind === 'sink' ? 'in the cup of ' : e.fifa ? 'FIFA by ' : 'on ') + esc(pname(e.defender)) + (why ? ' &middot; ' + why : '') + '</span>';
  if (e.fifa) s += '<span class="tag">FIFA</span>';
  if (e.capped) s += ' <span class="muted">(FIFA point cap reached)</span>';
  return s;
}
function feed(g, limit) {
  const steps = calc(g).steps, sc = { A: 0, B: 0 }; let rows = [];
  g.events.forEach((e, i) => {
    const step = steps[i]; let pt;
    if (step) { sc.A = step.after.A; sc.B = step.after.B; } else if (e.scoreTeam && e.points) sc[e.scoreTeam] += e.points; // (no step: a toss after the game was decided)
    if (step && step.red && (step.knock || step.add)) pt = '<span class="pt t' + e.scoreTeam + '">' + (step.knock ? '&minus;' + step.knock : '') + (step.knock && step.add ? ' ' : '') + (step.add ? '+' + step.add : '') + '</span>';
    else pt = e.points ? '<span class="pt t' + e.scoreTeam + '">+' + e.points + '</span>' : '<span class="pt muted">&mdash;</span>';
    rows.push('<li' + (step && step.red ? ' class="red"' : '') + '><span class="sc">' + sc.A + '&ndash;' + sc.B + '</span><span>' + describe(e, step) + '</span>' + pt + '</li>'); });
  if (limit) { rows = rows.reverse().slice(0, limit); }
  return rows.length ? '<ol class="feed">' + rows.join('') + '</ol>' : '<p class="muted small">No tosses yet. Somebody throw something.</p>';
}
function redBanner(g, c) {
  const r = c.red, T = g.settings.target, left = MAX_RED - c.used[r.team], down = c.sc[r.leader] < T;
  return '<div class="redbar" id="redemption-banner" role="status" aria-live="polite"><b>Redemption</b><span>' + esc(tname(g, r.team)) +
    (down ? ' knocked them back to ' + (T - 1) : ' need' + (/ & /.test(tname(g, r.team)) ? '' : 's') + ' to knock them back to ' + (T - 1)) +
    ' &middot; toss ' + Math.min(2, r.n + 1) + ' of 2 &middot; redemptions left: ' + left + '</span></div>';
}
function statusLine(g, c) {
  const st = g.settings, redRule = st.winRule === 'redemption', gp = [];
  const rule = '<p class="status dim rule" id="rule-line">' + ruleText(st) + (redRule && g.status !== 'final' ? ' <span class="num">(left: ' + (MAX_RED - c.used.A) + ' &middot; ' + (MAX_RED - c.used.B) + ')</span>' : '') + '</p>';
  if (g.status === 'final') return '<p class="status">Final' + (g.called ? ' &middot; called early' : '') + '</p>' + rule;
  if (c.red) return redBanner(g, c) + rule;
  if (c.hold) return '<p class="status hot" aria-live="polite">' + esc(tname(g, c.hold)) + " can't win on a FIFA &mdash; play on until a non-FIFA point " + (redRule ? 'counts' : 'wins it') + '</p>' + rule;
  ['A', 'B'].forEach(t => { const s = { A: c.sc.A, B: c.sc.B }; s[t]++; if (met(s, t, st)) gp.push(t); });
  if (gp.length) return '<p class="status hot" aria-live="polite">Game point &mdash; ' + gp.map(t => esc(tname(g, t)) + (redRule ? (c.used[opp(t)] < MAX_RED ? ' (redemption to follow)' : ' (no redemption left)') : '')).join(' and ') + '</p>' + rule;
  if (st.winRule === 'winBy2' && c.sc.A >= st.target - 1 && c.sc.B >= st.target - 1) return '<p class="status" aria-live="polite">Win by 2 &mdash; keep tossing</p>' + rule;
  return rule;
}
function board(g, c, ti) {
  const h = t => { const on = ti && ti.team === t, won = g.status === 'final' && g.winner === t;
    return '<div class="half t' + t + (on ? ' on' : '') + (won ? ' won' : '') + '"><div class="who"><span>' + tnameH(g, t) + '</span></div><div class="score num" id="score-' + t + '" aria-label="' + esc(tname(g, t)) + ' score">' + c.sc[t] + '</div>' +
      '<span class="tossing' + (on || won ? '' : ' off') + '"' + (on || won ? '' : ' aria-hidden="true"') + '>' + (won ? 'Winners' : die(1, 'sm') + (c.red ? ' redeeming' : ' throwing')) + '</span></div>'; };
  return '<section class="board' + (c.red ? ' redeem' : '') + '" id="board" aria-label="Scoreboard">' + h('A') + '<div class="mid" aria-hidden="true"></div>' + h('B') + statusLine(g, c) + '</section>';
}
function chip(k, v, label) { const on = ui.panel && ui.panel[k] === v; return '<button type="button" class="chip" data-act="pset" data-k="' + k + '" data-v="' + esc(v) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(label) + '</button>'; }
function panelView(g, ti) {
  const p = ui.panel, d = opp(ti.team), defs = g['team' + d], st = g.settings, c = calc(g); let h = '';
  const defChips = title => '<h3 class="tape">' + title + '</h3><div class="chips">' + defs.map(id => chip('defender', id, pname(id))).join('') + '</div>';
  const x = () => { const o = {}; if (p.defender) o.defender = p.defender; if (p.reason) o.reason = p.reason; return esc(JSON.stringify(o)); };
  if (p.kind === 'point') {
    const why = REASON[p.reason] ? p.reason : 'dropped';
    h = '<h2>Point</h2><h3 class="tape">How did it get down?</h3><div class="chips">' + Object.keys(REASON).map(k => chip('reason', k, REASON[k])).join('') + '</div>' +
      '<h3 class="tape">Who was it on? Tap to log</h3><div class="stack" id="point-defenders">' + defs.map(id =>
      '<button type="button" class="btn primary block big" data-act="log" data-v="point" data-x="' + esc(JSON.stringify({ defender: id, reason: why })) + '">On ' + esc(pname(id)) + ' <span class="val">+1</span></button>').join('') + '</div>';
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
      // House rule: FIFA catch is the only FIFA outcome. The other kinds (fifaDrop/Tink/Sink/Own) stay in
      // pointsFor()/calc() so games logged with them still replay, but they can't be logged any more.
      '<div class="outs">' + fb2('fifaCatch', 0, catchSub) + '</div>';
  }
  return '<section class="card stack panel" aria-label="Toss detail">' + h + '<button type="button" class="btn ghost block" data-act="pcancel">Cancel</button></section>';
}
function ftime(t) { if (!t) return ''; try { return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch (e) { return ''; } }
/* Small strip above the scoreboard: which game this is, and (when more than one is live) the way to the picker. */
function gameBar(g) {
  const n = liveGames().length, multi = g.status === 'live' && n > 1;
  if (!multi && !String(g.label || '').trim()) return '';
  return '<div class="gamebar" id="game-bar"><span class="glabel" id="game-label-shown">' + esc(gameLabel(g)) + '</span>' +
    (multi ? '<button type="button" class="btn sm" id="games-switch" data-act="games" aria-label="Games: ' + n + ' live. Switch game">Games: ' + n + ' live &middot; <u>Switch</u></button>' : '') + '</div>';
}
/* One live game as a card: label, teams, score, whose toss or redemption, when it started, who is logging it.
   Read-only unless opts.pick is set, so the live scoreboard view (TODO item 11) can reuse it as is. */
function gameCard(g, opts) {
  const c = calc(g), ti = (() => { const keepT = ui.tossTeam, keepP = ui.thrower; ui.tossTeam = null; ui.thrower = null; try { return tossInfo(g); } finally { ui.tossTeam = keepT; ui.thrower = keepP; } })();
  const o = opts || {}, by = S.mode === 'cloud' && g.loggedBy && S.members[g.loggedBy] ? S.members[g.loggedBy].name : '';
  const row = t => '<div class="grow t' + t + (ti.team === t ? ' on' : '') + '"><span class="gnm"><span class="c' + t + '" aria-hidden="true">&#9632;</span> ' + esc(tname(g, t)) + '</span><span class="gsc num" aria-label="' + esc(tname(g, t)) + ' score">' + c.sc[t] + '</span></div>';
  return '<li class="card gcard' + (o.mine ? ' mine' : '') + '" data-game="' + esc(g.id) + '">' +
    '<div class="spread"><h3 class="gtitle">' + esc(gameLabel(g)) + '</h3>' + (c.red ? '<span class="gbadge red">Redemption</span>' : o.mine ? '<span class="gbadge">This phone</span>' : '') + '</div>' +
    row('A') + row('B') +
    '<p class="small muted gmeta">' + (c.red ? esc(tname(g, c.red.team)) + ' redeeming' : esc(tname(g, ti.team)) + ' to toss') + ' &middot; ' + esc(ruleText(g.settings)) +
    (g.startedAt ? ' &middot; started ' + esc(ftime(g.startedAt)) : '') + (by ? ' &middot; logged by ' + esc(by) : '') + '</p>' +
    (o.pick ? '<button type="button" class="btn ' + (o.mine ? '' : 'primary ') + 'block" data-act="pickgame" data-v="' + esc(g.id) + '">' + (o.mine ? 'Back to this game' : 'Score this game') + '</button>' : '') + '</li>';
}
function gameCards(opts) { const sel = selGet(); return '<ul class="gcards">' + liveGames().map(g => gameCard(g, Object.assign({}, opts, { mine: !!(opts && opts.pick) && g.id === sel }))).join('') + '</ul>'; }
function pickerView() {
  const n = liveGames().length;
  return '<h2>Live games</h2><p class="onwood small" id="picker-note">' + n + ' games are going. Pick the one this phone is scoring. It only changes this phone.</p>' + gameCards({ pick: true }) +
    '<button type="button" class="btn block" id="picker-new" data-act="newgame">Start a new game</button>';
}
function liveView(g) {
  const c = calc(g), ti = tossInfo(g), st = g.settings; let h = gameBar(g) + board(g, c, ti);
  if (ui.panel && ui.panel.kind === 'fifa' && ti.red) ui.panel = null; // no FIFA in redemption
  if (ui.panel) return h + panelView(g, ti);
  const out = (kind, label, sub, val, cls) => '<button type="button" class="out ' + (cls || '') + '" id="out-' + kind + '" data-act="out" data-v="' + kind + '"><span class="lbl">' + label + '<small>' + sub + '</small></span>' + (val ? '<span class="val">+' + val + '</span>' : '') + '</button>';
  const other = opp(ti.team);
  h += '<section class="thrower t' + ti.team + '" aria-label="Who is throwing"><h3 class="tape">' + (ti.red ? 'Redemption toss ' + Math.min(2, ti.red.n + 1) + ' of 2 &middot; one each' : 'Who\'s throwing? &middot; toss ' + ti.turnToss + ' of 2') + '</h3><div class="throw-row">' +
    g['team' + ti.team].map(id => '<button type="button" class="btn who t' + ti.team + '" data-act="thrower" data-v="' + id + '" aria-pressed="' + (id === ti.thr ? 'true' : 'false') + '"' + (ti.red && ti.free.indexOf(id) < 0 ? ' disabled' : '') + '>' + esc(pname(id)) + '</button>').join('') +
    (ti.red ? '</div></section>' : '<button type="button" class="btn swap" id="switch-toss" data-act="switch" aria-label="Give the toss to ' + esc(tname(g, other)) + '"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Other side</span></button></div></section>');
  h += '<section class="stack" aria-label="Log a toss"><div class="outs scoring">' +
    out('sink', 'Sink!', 'In the cup', 3, 'score cup wide') +
    out('point', 'Point', 'Hit the table, not caught', 1, 'score') +
    (st.tinks ? out('tink', 'Tink!', 'Off the cup, uncaught', 2, 'score') : '') +
    (st.fieldGoals ? out('fg', 'Field goal', 'Back through own cups', 2, 'score' + (st.tinks ? ' wide' : '')) : '') +
    '</div><div class="outs">' +
    out('caught', 'Caught', 'One-hand catch') + out('short', 'Short / dead', 'Own side or on the line') + out('low', 'Too low', 'Below height') + out('retoss', 'Die Don\'t Lie', 'Disputed, throw again') +
    (st.fifa !== 'off' && !ti.red ? out('fifa', 'FIFA!', 'Kicked back into play') : '') + out('selfSink', 'Self-sink', st.selfSinkLoss ? 'Automatic loss' : 'Own or partner\'s cup', 0, 'bad') + '</div></section>';
  h += '<section class="card stack"><div class="spread"><h3 class="tape">Recent tosses</h3><button type="button" class="btn sm" id="undo-last" data-act="undo"' + (g.events.length ? '' : ' disabled') + '>Undo last</button></div>' + feed(g, 8) + '</section>';
  if (ui.confirmEnd) {
    const lead = c.sc.A === c.sc.B ? null : (c.sc.A > c.sc.B ? 'A' : 'B');
    h += '<section class="confirm" aria-label="End game"><b>End this game?</b>' +
      (lead ? '<button type="button" class="btn block" data-act="callit" data-v="' + lead + '">Call it &mdash; ' + esc(tname(g, lead)) + ' win ' + c.sc[lead] + '&ndash;' + c.sc[opp(lead)] + '</button>' : '') +
      (canDelete(g) ? '<button type="button" class="btn danger block" data-act="discard">Abandon and discard (no stats)</button>' : '<span class="small muted">Only the person who started this game or a league admin can discard it.</span>') + '<button type="button" class="btn ghost block" data-act="endno">Keep playing</button></section>';
  } else h += '<button type="button" class="btn ghost block onwood" id="end-game" data-act="endask">End or abandon game</button>' +
    '<button type="button" class="btn ghost block onwood" id="another-game" data-act="newgame">Start another game (second table)</button>';
  return h;
}
function finishedView(g) {
  const c = calc(g), w = g.winner, last = g.events[g.events.length - 1], nLive = liveGames().length;
  return gameBar(g) + board(g, c, null) + '<section class="banner" aria-live="polite"><div class="tape">Winners</div><div class="big">' + esc(tname(g, w)) + '</div><div class="fs num">' + c.sc[w] + ' &ndash; ' + c.sc[opp(w)] + '</div>' +
    (last && last.kind === 'selfSink' && g.settings.selfSinkLoss ? '<div class="small">' + esc(pname(last.thrower)) + ' self-sank. Automatic loss.</div>' : '') +
    (c.survived ? '<div class="small">Survived the redemption round.</div>' : !g.called && c.winner && c.used[opp(w)] >= MAX_RED && g.settings.winRule === 'redemption' && !(last && last.kind === 'selfSink') ? '<div class="small">' + esc(tname(g, opp(w))) + ' had no redemptions left.</div>' : '') + (g.called ? '<div class="small">Called early</div>' : '') + '</section>' +
    '<div class="stack"><button type="button" class="btn primary block big" id="rematch" data-act="rematch">Rematch, same teams</button>' +
    '<button type="button" class="btn block" id="new-game" data-act="newgame">New game</button>' +
    (nLive ? '<button type="button" class="btn block" id="back-live" data-act="leavefinal">' + (nLive === 1 ? 'Go to the live game' : 'Live games (' + nLive + ')') + '</button>' : '') +
    '<button type="button" class="btn ghost block onwood" id="undo-final" data-act="undofinal">' + (g.called ? 'Reopen game' : 'Undo last toss and reopen') + '</button></div>' +
    '<section class="card stack"><h3 class="tape">Toss log</h3>' + feed(g) + '</section>';
}
function sw(key, on, label, sub) { return '<div class="setrow"><span class="lbl" id="lbl-' + key + '">' + label + (sub ? '<small>' + sub + '</small>' : '') + '</span><button type="button" class="switch" id="set-' + key + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-labelledby="lbl-' + key + '" data-act="toggle" data-v="' + key + '"></button></div>'; }
function setupView() {
  const su = ui.setup || (ui.setup = newSetup()), st = su.settings, ids = Object.keys(S.players).sort((a, b) => pname(a).localeCompare(pname(b)));
  su.A = su.A.filter(id => S.players[id]); su.B = su.B.filter(id => S.players[id]);
  const add = '<form class="row" data-form="quickadd"><input type="text" id="quick-player-name" maxlength="24" autocomplete="off" placeholder="Add a player" aria-label="New player name" value="' + esc(ui.drafts['quick-player-name'] || '') + '"><button class="btn" id="quick-player-add" type="submit">Add</button></form>';
  const busy = busyMap(), nLive = liveGames().length, clash = setupBusy(su);
  let h = '<h2>New game</h2>';
  if (nLive && ui.setupOpen) h += '<div class="gamebar"><span class="glabel">' + nLive + ' game' + (nLive === 1 ? '' : 's') + ' live right now</span><button type="button" class="btn sm" id="setup-back" data-act="setupback">Back to ' + (nLive === 1 ? 'the game' : 'live games') + '</button></div>';
  if (!ids.length) return h + '<div class="empty">' + die(5, 'big') + '<p><b>No players yet &mdash; add your crew to start</b></p><p class="muted small">You need four for a game of 2 v 2.</p></div>' + add;
  const slot = t => '<div class="slot t' + t + '"><b>Team ' + t + '</b>' + (su[t].length ? su[t].map(id => esc(pname(id))).join('<br>') : '<span class="muted">Pick 2</span>') + '</div>';
  h += '<section class="stack"><div class="slots">' + slot('A') + '<div class="slot-line" aria-hidden="true"></div>' + slot('B') + '</div><div class="card"><ul class="plist">' + ids.map(id => {
    const bz = busy[id];
    const b = t => { const on = su[t].indexOf(id) >= 0; return '<button type="button" class="pick t' + t + '" data-act="assign" data-v="' + t + ':' + id + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc(pname(id)) + ' on team ' + t + '"' + (bz && !on ? ' disabled' : '') + '>' + t + '</button>'; };
    return '<li' + (bz ? ' class="busy"' : '') + '>' + pmark(id) + '<span class="nm">' + esc(pname(id)) + (S.mode === 'cloud' && !S.players[id].uid ? '<span class="tag">guest</span>' : '') +
      (bz ? '<span class="busy-note">In a game at ' + esc(gameLabel(bz)) + '</span>' : '') + '</span>' + b('A') + b('B') + '</li>'; }).join('') + '</ul></div>' +
    (Object.keys(busy).length ? '<p class="small onwood" id="busy-help">Players in a live game can\'t be picked until that game ends.</p>' : '') + add +
    '<div class="row"><label class="lbl-inline onwood" for="game-label">Table name <span class="small">(optional)</span></label><input type="text" id="game-label" maxlength="40" autocomplete="off" placeholder="Table 1" value="' + esc(ui.drafts['game-label'] || '') + '"></div></section>';
  h += '<section class="card"><h3 class="tape">House rules</h3>' +
    '<div class="setrow"><span class="lbl">Play to</span><span class="stepper"><button type="button" class="btn sm" id="target-down" data-act="target" data-v="-1" aria-label="Lower target score">&minus;</button><span class="v num" id="target-value" aria-live="polite">' + st.target + '</span><button type="button" class="btn sm" id="target-up" data-act="target" data-v="1" aria-label="Raise target score">+</button></span></div>' +
    '<div class="setrow" style="display:block"><span class="lbl">Win rule<small>' + (st.winRule === 'redemption' ? 'Redemption: reach ' + st.target + ' and the other team gets 2 tosses to knock you back to ' + (st.target - 1) + '. 2 tosses, ' + MAX_RED + ' per team' : st.winRule === 'winBy2' ? 'First to ' + st.target + ', but you have to lead by 2' : 'First to ' + st.target + ' wins') + '</small></span>' +
    '<div class="seg" style="margin-top:8px">' + RULES.map(o => '<button type="button" class="btn sm" id="rule-' + o[0] + '" data-act="rule" data-v="' + o[0] + '" aria-pressed="' + (st.winRule === o[0] ? 'true' : 'false') + '">' + o[1] + '</button>').join('') + '</div></div>' +
    sw('tinks', st.tinks, 'Tinks', 'Off the cup and down is worth 2') + sw('fieldGoals', st.fieldGoals, 'Field goals', 'Back through your own cups is worth 2') +
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
  const full = su.A.length === 2 && su.B.length === 2, ok = full && !clash.length;
  if (clash.length) h += '<p class="note warn" id="busy-msg" role="alert">' + clash.map(x => esc(pname(x.id)) + ' is already in a game at ' + esc(gameLabel(x.g))).join('. ') + '. A player can\'t be in two live games at once: take them off the team, or wait for that game to end.</p>';
  h += '<button type="button" class="btn primary block big" id="start-game" data-act="start"' + (ok ? '' : ' disabled') + '>' + (ok ? 'Start game' : clash.length ? 'A picked player is in another game' : 'Pick two players per team') + '</button>';
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
    c('Streak', fstk(r.stk) || '&mdash;') + c('Best W streak', r.lws) + c('Sinks', r.sink) + c('Tinks', r.tink) + c('Wins rank', '#' + rank) + c('Catches', r.ctch) + c('Drops', r.drop) + c('Catch %', fmt('cpct', r.cpct)) + '</div>' +
    '<p class="small muted num">' + r.g + ' game' + (r.g === 1 ? '' : 's') + ' &middot; ' + r.toss + ' tosses &middot; ' + r.ppg.toFixed(1) + ' points per game</p></section>';
}
/* Head-to-head card on Stats: two players (or two duos), picked with selects whose values are the stable ids. */
function h2hView(s) {
  const H = ui.h2h, ps = s.rows.filter(r => r.g).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  if (ps.length < 2) return '';
  const dkey = d => d.ids.join('|'), dname = d => d.ids.map(pname).join(' & ');
  const ds = s.duos.slice().sort((a, b) => dname(a).localeCompare(dname(b)) || (dkey(a) < dkey(b) ? -1 : 1));
  const apart = (a, b) => !a.ids.some(id => b.ids.indexOf(id) >= 0);
  const canDuo = ds.some(a => ds.some(b => apart(a, b)));
  const duo = H.mode === 'd' && canDuo;
  let X, Y, nx, ny, optA, optB, va, vb;
  const opts = (list, val, key, name) => list.map(o => '<option value="' + esc(key(o)) + '"' + (key(o) === val ? ' selected' : '') + '>' + esc(name(o)) + '</option>').join('');
  if (duo) {
    const as = ds.filter(a => ds.some(b => apart(a, b)));
    const a = as.filter(d => dkey(d) === H.da)[0] || as.slice().sort((p, q) => q.g - p.g)[0], bs = ds.filter(d => apart(a, d));
    const b = bs.filter(d => dkey(d) === H.db)[0] || bs.slice().sort((p, q) => h2h(a.ids, q.ids).g - h2h(a.ids, p.ids).g || q.g - p.g)[0];
    X = a.ids; Y = b.ids; nx = dname(a); ny = dname(b); va = dkey(a); vb = dkey(b);
    optA = opts(as, va, dkey, dname); optB = opts(bs, vb, dkey, dname);
  } else {
    const mine = myPlayerId(), a = ps.filter(r => r.id === H.a)[0] || ps.filter(r => r.id === mine)[0] || ps.slice().sort((p, q) => q.w - p.w || q.g - p.g)[0], bs = ps.filter(r => r.id !== a.id);
    const b = bs.filter(r => r.id === H.b)[0] || bs.slice().sort((p, q) => h2h([a.id], [q.id]).g - h2h([a.id], [p.id]).g || q.g - p.g)[0];
    X = [a.id]; Y = [b.id]; nx = a.name; ny = b.name; va = a.id; vb = b.id;
    optA = opts(ps, va, r => r.id, r => r.name); optB = opts(bs, vb, r => r.id, r => r.name);
  }
  const r = h2h(X, Y), what = duo ? 'duo' : 'player', pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  let h = '<section class="card stack" id="h2h"><h3 class="tape">Head-to-head</h3>' +
    (canDuo ? '<div class="seg"><button type="button" class="btn sm" id="h2h-mode-p" data-act="h2hmode" data-v="p" aria-pressed="' + (duo ? 'false' : 'true') + '">Players</button><button type="button" class="btn sm" id="h2h-mode-d" data-act="h2hmode" data-v="d" aria-pressed="' + (duo ? 'true' : 'false') + '">Duos</button></div>' : '') +
    '<div class="h2h-pick"><select id="h2h-a" data-sel="' + (duo ? 'da' : 'a') + '" aria-label="First ' + what + '">' + optA + '</select><span class="vs" aria-hidden="true">vs</span>' +
    '<select id="h2h-b" data-sel="' + (duo ? 'db' : 'b') + '" aria-label="Second ' + what + '">' + optB + '</select></div>';
  if (!r.g) h += '<p class="small muted" id="h2h-none">' + esc(nx) + ' and ' + esc(ny) + ' haven\'t played against each other yet.</p>';
  else {
    const df = r.px - r.py;
    h += '<div class="h2h-score" role="group" aria-label="Record: ' + esc(nx) + ' ' + r.wx + ', ' + esc(ny) + ' ' + r.wy + '"><div class="hs' + (r.wx > r.wy ? ' lead' : '') + '"><div class="v num" id="h2h-wa">' + r.wx + '</div><div class="k">' + esc(nx) + '</div></div>' +
      '<div class="hm num" id="h2h-games">' + pl(r.g, 'game') + '</div>' +
      '<div class="hs' + (r.wy > r.wx ? ' lead' : '') + '"><div class="v num" id="h2h-wb">' + r.wy + '</div><div class="k">' + esc(ny) + '</div></div></div>' +
      '<p class="small num" id="h2h-pts"><b>Points in these games:</b> ' + esc(nx) + (duo ? '' : '\'s teams') + ' ' + r.px + ', ' + esc(ny) + (duo ? '' : '\'s teams') + ' ' + r.py + ' <span class="muted">(' + (df > 0 ? '+' : df < 0 ? '&minus;' : '') + Math.abs(df) + ' for ' + esc(nx) + ')</span></p>';
  }
  if (!duo) h += '<p class="small num" id="h2h-together"><b>As partners:</b> ' + (r.tg ? pl(r.tg, 'game') + ', ' + r.tw + '&ndash;' + (r.tg - r.tw) + ' <span class="muted">(' + Math.round(r.tw / r.tg * 100) + '% won)</span>' : 'never teamed up') + '</p>';
  if (r.g) h += '<h3 class="tape">Last ' + (r.g === 1 ? 'meeting' : Math.min(5, r.g) + ' meetings') + '</h3><ol class="meets" id="h2h-meets">' + r.meets.slice(0, 5).map(m =>
    '<li><span class="md num">' + esc(fdate(m.at)) + '</span><span class="mt"><span' + (m.won === 'x' ? ' class="w"' : '') + '>' + esc(m.tx) + '</span> <b class="num">' + m.sx + '&ndash;' + m.sy + '</b> <span' + (m.won === 'y' ? ' class="w"' : '') + '>' + esc(m.ty) + '</span></span>' +
    '<span class="mw">' + (m.won ? esc(m.won === 'x' ? nx : ny) + ' won' : '') + '</span></li>').join('') + '</ol>';
  return h + '</section>';
}
function statsView() {
  const s = computeStats(); let h = myStatsView(s) + '<h2>Leaderboard</h2>';
  if (!s.tot.g) return h + '<div class="empty">' + die(3, 'big') + '<p><b>No finished games yet</b></p><p class="muted small">Finish a game and the leaderboard fills in.</p></div>';
  const top = (k, min) => s.rows.filter(r => !min || r.toss >= min).sort((a, b) => b[k] - a[k] || b.g - a.g)[0];
  const tw = top('w'), tp = top('ppt', 1), ts = top('sink'), tc = top('ctch'), th = s.rows.filter(r => r.ch >= MIN_CHANCES).sort((a, b) => b.cpct - a.cpct || b.ch - a.ch)[0];
  const tile = (k, v, sub) => '<div class="tile"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="s num">' + sub + '</div></div>';
  h += '<div class="tiles">' + tile('Most wins', esc(tw.name), tw.w + ' of ' + tw.g + ' games') + (tp ? tile('Best arm', esc(tp.name), tp.ppt.toFixed(2) + ' pts per toss') : '') +
    (ts && ts.sink ? tile('Sink leader', esc(ts.name), ts.sink + ' sink' + (ts.sink === 1 ? '' : 's')) : tile('Sinks', '0', 'Nobody has sunk one yet')) +
    (th ? tile('Best hands', esc(th.name), Math.round(th.cpct * 100) + '% caught') : tc && tc.ctch ? tile('Best hands', esc(tc.name), tc.ctch + ' catch' + (tc.ctch === 1 ? '' : 'es')) : tile('Games', String(s.tot.g), s.tot.toss + ' tosses logged')) + '</div>';
  const withGames = s.rows.filter(r => r.trend.length).sort((a, b) => a.name.localeCompare(b.name));
  if (withGames.length) {
    const mineId = myPlayerId(), cur = withGames.filter(r => r.id === ui.trend)[0] || withGames.filter(r => r.id === mineId)[0] || withGames.filter(r => r.id === tw.id)[0] || withGames[0];
    h += '<section class="card stack"><h3 class="tape">Points per game</h3><div class="chips scrollx">' + withGames.map(r => '<button type="button" class="chip" data-act="trend" data-v="' + r.id + '" aria-pressed="' + (r.id === cur.id ? 'true' : 'false') + '">' + esc(r.name) + '</button>').join('') + '</div>' + trendChart(cur) + '</section>';
  }
  h += '<section class="card stack"><h3 class="tape">How they score</h3>' + mixChart(s.rows) + '</section>';
  h += defenseView(s.rows);
  h += h2hView(s);
  const k = ui.sort.k, dir = ui.sort.dir;
  s.rows.sort((a, b) => { const d = k === 'name' ? a.name.localeCompare(b.name) : a[k] - b[k]; return d * dir || b.w - a.w || a.name.localeCompare(b.name); });
  h += '<section class="stack"><h3 class="tape">Players &middot; tap a column to sort</h3><div class="scroll"><table><thead><tr>' + COLS.map(c =>
    '<th scope="col"' + (k === c[0] ? ' aria-sort="' + (dir < 0 ? 'descending' : 'ascending') + '"' : '') + '><button type="button" id="sort-' + c[0] + '" data-act="sort" data-v="' + c[0] + '" title="' + c[2] + '" aria-label="Sort by ' + c[2] + '">' + c[1] + '</button></th>').join('') +
    '</tr></thead><tbody>' + s.rows.map(r => '<tr>' + COLS.map(c => '<td' + (k === c[0] ? ' class="hi"' : '') + '>' + (c[0] === 'name' ? pmark(r.id) : '') + fmt(c[0], r[c[0]]) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' +
    '<p class="small onwood">Finished games only. Points count what a player scored on their own tosses (a redemption shot counts in full). Strk = current streak (W3 = won the last 3, L2 = lost the last 2); Best W = longest win streak. Rdm = redemption tosses that scored. Drops = points scored on a player; Catch% = catches out of catches + drops (points logged without a defender are ignored).</p></section>';
  h += '<section class="stack"><h3 class="tape">Best duos</h3><div class="scroll"><table><thead><tr><th scope="col"><button type="button" disabled>Duo</button></th><th scope="col"><button type="button" disabled>W&ndash;L</button></th><th scope="col"><button type="button" disabled>Win%</button></th><th scope="col"><button type="button" disabled>Pt diff</button></th><th scope="col"><button type="button" disabled title="Comebacks: games won after having to redeem">Cmbk</button></th></tr></thead><tbody>' +
    s.duos.slice(0, 10).map(d => { const df = d.pf - d.pa; return '<tr><td style="max-width:190px">' + esc(d.ids.map(pname).join(' & ')) + '</td><td>' + d.w + '&ndash;' + (d.g - d.w) + '</td><td>' + Math.round(d.pct * 100) + '%</td><td>' + (df > 0 ? '+' : '') + df + '</td><td>' + d.cb + '</td></tr>'; }).join('') + '</tbody></table></div></section>';
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
      '<span class="small muted" style="grid-column:1/-1">' + (String(g.label || '').trim() ? esc(String(g.label).trim()) + ' &middot; ' : '') + fdate(g.endedAt) + ' &middot; ' + c.tosses + ' tosses' + (g.called ? ' &middot; called early' : '') + '</span></button>';
    if (open) {
      const st = g.settings;
      li += '<div class="detail stack"><p class="small muted">' + ruleText(st) + ' &middot; tinks ' + (st.tinks ? 'on' : 'off') + ' &middot; field goals ' + (st.fieldGoals ? 'on' : 'off') + ' &middot; FIFA ' + st.fifa + ' &middot; ' + esc(tname(g, g.firstToss || 'A')) + ' tossed first</p>' + feed(g) +
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
function shownGame() { // the game the Game tab is showing on this phone, if any: its selected live game, or the winner screen of the game it just scored
  const lv = liveGames(), id = selGet();
  if (ui.pick && lv.length < 2) ui.pick = false;
  // sitting on the new-game screen with nothing live, and someone starts a game on another phone: follow it, as before
  if (ui.setupOpen && ui.setupLive === 0 && lv.length) ui.setupOpen = false;
  if (id && !lv.some(g => g.id === id)) {
    const raw = S.games[id];
    if (raw && raw.status === 'final' && raw.winner && (ui.watchId === id || ui.lastId === id)) { // it ended (here or on another phone): stay on its result
      ui.lastId = id; leaveGameUi();
      return ui.setupOpen ? null : norm(id, raw);
    }
    if (raw || S.mode === 'local' || (S.meta.games && !S.meta.games.fromCache)) { // gone for good (deleted or abandoned elsewhere), or a result from an earlier visit
      selSet(null); if (ui.lastId === id) ui.lastId = null; leaveGameUi();
      if (!raw || raw.status !== 'final') toast('That game ended on another phone');
    }
  }
  const g = myGame();
  if (g) { if (ui.watchId !== g.id) { if (ui.watchId) leaveGameUi(); ui.watchId = g.id; } return g; }
  ui.watchId = null;
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
  h += exportBlock();
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
      if (c.red && c.red.n === 0) stamp('Redemption!', 'quiet');
      else if (sink) stamp('Sink!', 'cup');
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
    const nLive = liveGames().length;
    if (ui.setupOpen || (ui.pick && nLive > 1)) cur = null; // the new-game screen or the picker is up instead of the game
    view.innerHTML = ui.tab === 'stats' ? statsView() : ui.tab === 'history' ? historyView() : ui.tab === 'players' ? playersView()
      : ui.setupOpen ? setupView() : cur ? (cur.status === 'live' ? liveView(cur) : finishedView(cur)) : nLive > 1 ? pickerView() : setupView();
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
function openSetup() { // the new-game screen; leaving a winner screen for it drops this phone's selection
  const id = selGet(), lv = liveGames();
  if (id && !lv.some(g => g.id === id)) selSet(null);
  ui.lastId = null; ui.pick = false; ui.setupOpen = true; ui.setupLive = lv.length; leaveGameUi(); render(); window.scrollTo(0, 0);
}
const ACT = {
  out: v => { if (v === 'point' || v === 'sink' || v === 'caught' || v === 'selfSink' || v === 'fifa') { ui.panel = v === 'point' ? { kind: v, reason: 'dropped' } : { kind: v }; buzz(8); render(); } else logEvent(v); },
  log: (v, b) => { let x = {}; try { x = JSON.parse(b.dataset.x || '{}'); } catch (e) {} logEvent(v, x); },
  pset: (v, b) => { const k = b.dataset.k; ui.panel[k] = ui.panel[k] === v && k !== 'reason' ? null : v; render(); },
  pcancel: () => { ui.panel = null; render(); },
  thrower: v => { ui.thrower = v; buzz(8); render(); },
  'switch': () => { const g = myGame(); if (!g || calc(g).red) return; ui.tossTeam = opp(tossInfo(g).team); ui.thrower = null; buzz(8); render(); },
  undo: () => { const g = myGame(); if (!g || !g.events.length) return; ui.panel = null; ui.tossTeam = null; ui.thrower = null; saveGame(Object.assign({}, g, { events: g.events.slice(0, -1) })); },
  undofinal: () => { let g = S.games[ui.lastId]; if (!g || g.status !== 'final') return; g = norm(ui.lastId, g);
    const busy = busyMap(g.id), clash = g.teamA.concat(g.teamB).filter(id => busy[id])[0]; // a player may have moved on to another live game
    if (clash) { toast(pname(clash) + ' is in a game at ' + gameLabel(busy[clash]) + " now, so this one can't be reopened."); return; }
    selSet(g.id); ui.watchId = g.id; ui.setupOpen = false; ui.pick = false;
    const ng = Object.assign({}, g, { status: 'live', winner: null, endedAt: null, events: g.called ? g.events : g.events.slice(0, -1) }); delete ng.score; delete ng.called; saveGame(ng); },
  endask: () => { ui.confirmEnd = true; render(); },
  endno: () => { ui.confirmEnd = false; render(); },
  callit: v => { const g = myGame(); if (!g) return; ui.confirmEnd = false; ui.lastId = g.id; ui.setupOpen = false; saveGame(Object.assign({}, g, { status: 'final', winner: v, called: true, endedAt: Date.now(), score: calc(g).sc })); },
  discard: () => { const g = myGame(); if (!g) return; leaveGameUi(); ui.lastId = null; ui.watchId = null; selSet(null); if (S.mode === 'cloud') delete S.games[g.id]; put('games', g.id, null); },
  rematch: () => { const g = S.games[ui.lastId]; ui.setup = g ? newSetup(norm(ui.lastId, g)) : null; ui.drafts['game-label'] = g && g.label ? String(g.label) : ''; openSetup(); },
  newgame: () => { ui.setup = null; ui.drafts['game-label'] = ''; openSetup(); },
  setupback: () => { ui.setupOpen = false; render(); window.scrollTo(0, 0); },
  games: () => { if (liveGames().length < 2) return; leaveGameUi(); ui.pick = true; render(); window.scrollTo(0, 0); }, // open the picker; nothing changes until a game is chosen
  pickgame: v => { const g = liveGames().filter(x => x.id === v)[0]; if (!g) { render(); return; }
    if (selGet() !== v) leaveGameUi(); selSet(v); ui.watchId = v; ui.lastId = null; ui.pick = false; ui.setupOpen = false; buzz(8); render(); window.scrollTo(0, 0); },
  leavefinal: () => { selSet(null); ui.lastId = null; ui.watchId = null; ui.setupOpen = false; render(); window.scrollTo(0, 0); }, // off the winner screen, back to whatever is live
  assign: v => { const su = ui.setup, t = v.slice(0, 1), id = v.slice(2), i = su[t].indexOf(id);
    if (i >= 0) su[t].splice(i, 1); else { const bz = busyMap()[id]; if (bz) { toast(pname(id) + ' is in a game at ' + gameLabel(bz)); render(); return; } if (su[t].length >= 2) return; const o = su[opp(t)].indexOf(id); if (o >= 0) su[opp(t)].splice(o, 1); su[t].push(id); } render(); },
  toggle: v => { ui.setup.settings[v] = !ui.setup.settings[v]; render(); },
  target: v => { const s = ui.setup.settings; s.target = Math.max(3, Math.min(30, s.target + Number(v))); render(); },
  fifa: v => { ui.setup.settings.fifa = v; render(); },
  rule: v => { const s = ui.setup.settings; s.winRule = ruleOf({ winRule: v }); s.winBy2 = s.winRule === 'winBy2'; render(); }, // winBy2 is kept in step for phones still on the old app
  first: v => { ui.setup.firstToss = v; render(); },
  caller: () => { const su = ui.setup; su.caller = opp(su.caller); su.roll = null; render(); },
  call: v => { const su = ui.setup; su.call = su.call === v ? null : v; su.roll = null; render(); },
  roll: () => { const su = ui.setup, n = 1 + Math.floor(Math.random() * 6); su.roll = n; su.rolledAt = Date.now(); buzz([15, 30, 15]);
    if (su.call) su.firstToss = ((su.call === 'high') === (n >= 4)) ? su.caller : opp(su.caller); render(); },
  start: () => { const su = ui.setup; if (!su || su.A.length !== 2 || su.B.length !== 2) return;
    const clash = setupBusy(su)[0]; // checked again here: another phone may have started a game with one of these players
    if (clash) { toast(pname(clash.id) + ' is already in a game at ' + gameLabel(clash.g)); render(); return; }
    const id = uid(), label = String(ui.drafts['game-label'] || '').trim().slice(0, 40);
    ui.setup = null; ui.setupOpen = false; ui.pick = false; ui.lastId = null; ui.drafts['game-label'] = ''; leaveGameUi(); buzz(30);
    const ng = { teamA: su.A.slice(), teamB: su.B.slice(), settings: Object.assign({}, su.settings), events: [], status: 'live', winner: null, firstToss: su.firstToss, startedAt: Date.now(), endedAt: null };
    if (label) ng.label = label;
    if (S.mode === 'cloud' && me()) ng.loggedBy = me();
    // starting a game only selects it on this phone; every other phone stays on the game it is scoring
    if (S.mode === 'cloud') S.games[id] = ng; // the snapshot listener confirms it a moment later
    selSet(id); ui.watchId = id;
    put('games', id, ng);
    window.scrollTo(0, 0); },
  sort: v => { if (ui.sort.k === v) ui.sort.dir = -ui.sort.dir; else ui.sort = { k: v, dir: v === 'name' ? 1 : -1 }; render(); },
  h2hmode: v => { ui.h2h.mode = v === 'd' ? 'd' : 'p'; render(); },
  trend: v => { ui.trend = v; ui.chartSel = null; render(); },
  pt: v => { ui.chartSel = Number(v); render(); },
  open: v => { ui.open = ui.open === v ? null : v; ui.confirmDel = null; render(); },
  delask: v => { ui.confirmDel = v; render(); },
  delno: () => { ui.confirmDel = null; render(); },
  delyes: v => { ui.confirmDel = null; ui.open = null; if (ui.lastId === v) ui.lastId = null; if (selGet() === v) selSet(null); put('games', v, null); },
  rename: v => { ui.rename = v; ui.drafts['rename-input'] = null; render(); const el = document.getElementById('rename-input'); if (el) { el.focus(); el.select(); } },
  renameno: () => { ui.rename = null; render(); },
  rmplayer: v => { if (ui.more === v) ui.more = null; put('players', v, null); },
  clearerr: () => { S.err = ''; render(); },
  reload: () => { location.reload(); },
  exportopen: () => { ui.exportOpen = !ui.exportOpen; render(); const el = document.getElementById(ui.exportOpen ? 'export-players' : 'export-open'); if (el) el.focus(); },
  export: v => { exportFile(v); },
  menu: () => { ui.menu = !ui.menu; ui.exportOpen = false; render(); if (ui.menu) { const el = document.getElementById('menu-close'); if (el) el.focus(); } },
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
document.addEventListener('change', e => { const t = e.target; if (t && t.tagName === 'SELECT' && t.dataset.sel && t.dataset.sel in ui.h2h) { ui.h2h[t.dataset.sel] = t.value; render(); } });
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
if ('serviceWorker' in navigator && location.protocol !== 'file:') window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(r => { r.update().catch(() => {}); }).catch(() => {});
  // when a new version takes over, reload once so the update shows right away (skipped on the very first install)
  if (navigator.serviceWorker.controller) { let done = false; navigator.serviceWorker.addEventListener('controllerchange', () => { if (!done) { done = true; location.reload(); } }); } });
