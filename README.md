# Sig Tau Beer Die

A scorekeeper and stat tracker for 2 v 2 Beer Die, built for the chapter as an installable web app (PWA).
Log every toss (Point, Tink!, Sink!, field goals, catches, FIFAs), and it keeps the score,
enforces the house rules (to 12 with redemption, no winning on a FIFA, self-sink loses) and builds
a leaderboard, charts, duo records and game history.

It is a plain static site: no build step, no server. Open `index.html` from any web host.

- **Sign in with Google.** Stats are tied to real accounts, so they are accurate and follow you to any phone.
- **One crew, one league.** Whoever starts a league code (for example `SIGTAU-DIE`) owns it. Everyone else
  enters the code to *ask* to join and waits until the owner or an admin lets them in.
- **Players are linked to accounts.** Each member picks which player they are. Friends without the app
  can still play as **guests**; any member can log a whole game for all four players from one phone.
- **Works with bad signal.** Tosses are saved on the phone first and sync when the connection is back.
- **Without Firebase** it still works, but with no sign-in and stats stay on that one device (a banner says so).

## House rule: Redemption

Reaching the target (12 by default) does not end the game. The **other** team gets a **redemption round**:

- **2 tosses, one by each player.** The app picks the thrower (teammate 1, then teammate 2); you can swap the order,
  but nobody throws twice. Both tosses are always taken, even if the first one works. A re-toss doesn't use one up.
- **A redemption shot knocks the leader down first**, but never below target − 1 (11). Points left over are added to the
  redeeming team. With a target of 12: `12-9` + point → `11-9`, then another point → `11-10`. `14-9` + sink → `11-9`.
  `14-9` + point → `13-9`. `12-11` + sink → `11-13`.
- **After the two tosses:** if the leader is still at 12 or more, the leader wins. Otherwise play continues and the
  leader tosses next. If the leftover points put the redeeming team at 12 or more, the roles flip and the old leader
  gets a redemption round against them.
- **3 redemption rounds per team, per game.** If a team reaches the target and the other side has none left, it wins on the spot.
- **No FIFA in redemption**: the FIFA button is hidden for those two tosses. Everything else works as usual
  (a self-sink is still an automatic loss if that rule is on).
- **FIFA points and the target:** you still can't win on a FIFA. A FIFA point handed to the defending team neither wins
  the game nor starts a redemption round; that team has to score a normal point at or past the target to trigger it.

Under **House rules** on the new-game screen the win rule can be switched to **Win by 2** or **First to target** instead.
Games played before this rule existed keep the rule they were played with, so history and stats don't change.
Stats add **Rdm** (a player's redemption tosses that scored) and **Cmbk** (a duo's wins in games where it had to redeem).

### Defensive stats
Logging a **Point** asks which defender it was on (required) and how it got down (Dropped, Two-handed catch, Trapped, Bobble; defaults to Dropped).
- **Drops**: points scored on a player, whatever the reason. Redemption tosses count the same.
- **Catch %**: catches / (catches + drops). Older points logged without a defender are ignored, not held against anyone.
- The Stats tab has a **Best hands** board ranked by Catch % (5 chances to qualify) and a drops-by-reason breakdown per player.

## 1. Set up Firebase (free tier is plenty)

1. Go to <https://console.firebase.google.com> and create a project (Google Analytics is not needed).
2. **Build → Authentication → Get started → Sign-in method → Google**: switch it to **Enabled**,
   pick a **project support email**, and save. (If **Anonymous** is on from an older version, turn it off.)
3. **Authentication → Settings → Authorized domains → Add domain**: add the domain you host on.
   For GitHub Pages that is `<username>.github.io` (just the domain, no `https://` and no path).
   `localhost` is already there for local testing.
4. **Build → Firestore Database → Create database** (production mode, any region).
5. **Firestore → Rules**: replace everything with the contents of `firestore.rules` and press **Publish**.
6. **Project settings (gear) → General → Your apps → Web app (`</>`)**: register an app (no Hosting needed),
   then copy the `firebaseConfig` values into `firebase-config.js`, replacing every `PASTE_HERE`.
7. Deploy (section 2), open the app, sign in, type a league code and press **Start a new league**.
   You are now the owner. Share the code; approve people under **Players → Join requests**.

The config values are not secrets and are safe to commit. Access is controlled by `firestore.rules`:
only approved members of a league can read or change its data, and only the owner and admins can approve people.

### Roles

| Role | Can do |
| --- | --- |
| Owner (started the league) | Everything, plus make or remove admins. Cannot be removed. |
| Admin | Approve / deny join requests, remove members, link players to members, merge duplicate players, delete any game, copy old on-device stats into the league. |
| Member | Add players and guests, log games, undo tosses, delete games they started, link themself to a player. |

### Coming from the old code-only version

- Stats that lived only on a phone: sign in as an admin on that phone, open the menu (the league chip, top right)
  and use **Copy this phone's old stats into the league**.
- A league that already exists in Firestore from the anonymous version has no owner. The first person who signs in
  and presses **Start a new league** with that same code adopts it, old players and games included.
  (The rule that allows this is marked `MIGRATION` in `firestore.rules`; delete it once you own your league.)

### Sign-in notes

- The app signs in with a Google pop-up. If the pop-up is blocked, or the app is running from the home screen
  (standalone), it uses a full-page redirect instead.
- Redirect sign-in can fail on Safari / iOS when the site is not on the same domain as the Firebase `authDomain`
  (Safari blocks the storage it relies on). The app notices when a redirect comes back empty and switches to the
  pop-up on the next tap. If people still can't sign in from the home-screen app, have them sign in once in Safari,
  or follow Firebase's "Best practices for using signInWithRedirect" guide.
- "This site isn't an authorized domain" means step 3 was missed.

## 2. Deploy to GitHub Pages

1. Create a repository (for example `beer-die`) and push these files to the `main` branch,
   with `index.html` at the repository root.
2. **Settings → Pages → Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`.
3. After a minute the app is at `https://YOUR-USER.github.io/beer-die/`.
   All paths are relative, so any subpath works.

## 3. Install on a phone

- **iPhone (Safari)**: Share → Add to Home Screen.
- **Android (Chrome)**: menu → Install app / Add to Home screen.

Open it once with a connection so it can cache itself and sign you in; after that it launches offline.

## Trying it locally

```
python3 -m http.server 8000
```

then open <http://localhost:8000>. (Service workers need `http://localhost` or HTTPS, not `file://`.)

## Files

| File | What it is |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The app |
| `firebase-config.js` | Your Firebase project config (edit this) |
| `firestore.rules` | Security rules (membership, roles) to paste into the Firebase console |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA install and offline support |

When you change the app after deploying, bump `VERSION` in `sw.js` (currently `beer-die-v4`) so old caches are cleared
and phones pick up the new files.
