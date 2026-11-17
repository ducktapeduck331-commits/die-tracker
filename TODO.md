# Sig Tau Beer Die: to-do list

Planned changes, saved for later. Nothing here is built yet. Work through them roughly in this order,
one at a time, and test each on a phone before moving on.

How the app works (read before changing anything):
- Static site on GitHub Pages: `index.html`, `styles.css`, `app.js` (ES module), `sw.js`, `firebase-config.js`.
- Data is in Firebase Firestore under `leagues/{CODE}/players`, `leagues/{CODE}/games`, `leagues/{CODE}/members`.
  Access rules are in `firestore.rules` (they must be pasted into the Firebase console by hand when changed).
- A game's score, winner, redemption state and whose toss it is are all derived by replaying `game.events`
  (`calc()` and `tossInfo()` in `app.js`). Old games must keep replaying correctly after any change.
- Bump `VERSION` in `sw.js` on every deploy.

---

## Rule and wording changes

### FIFA: keep only "FIFA catch"
- Remove the FIFA outcomes **FIFA'd onto table and dropped**, **FIFA'd off cup to ground**,
  **FIFA'd into defending cup** and **FIFA'd into offensive cup** from the logging screen.
- Keep **FIFA catch** only (with the existing Off / Preferred / Points setting).
- Old games that used the removed kinds (`fifaDrop`, `fifaTink`, `fifaSink`, `fifaOwn`) must still replay and
  show in history and stats. Only remove them from the buttons, not from `pointsFor()` / `calc()`.

---

## Features

### 3. Export stats (backups)
- The free Firebase plan has no backups. Add an admin-only **Export stats** button that downloads the league's
  players and games as a spreadsheet (`.csv`, one file for players/stats and one for games), plus a full `.json`
  backup.

### 6. Rename or delete a league
- League owner can rename the league's display name (the rules already allow admins to change `name`).
- Owner can delete a league, with an in-page "type the code to confirm" step. This needs a rules change
  (deletes are blocked today) and must also delete `members`, `players` and `games` under it.
- First use: delete the **SIGTAU-2026** test league. **SIGTAU** is the official league.

### 8. Seasons
- Owner can start a new season (for example "Spring 2027"). Leaderboards default to the current season,
  with a switch for **All-time** and past seasons.
- Store the season on each game (name or id plus start date). Games logged before seasons existed count
  as the first season.

### 9. Streaks and head-to-head
- Per player: current win streak and longest win streak (also loss streaks if easy).
- Head-to-head: pick two players or two duos and see their record against each other, points for and against,
  and their last few games.

### 10. Player profile pages
- Tap a player's name anywhere to open their page: all their stats (offense and defense), win %, streaks,
  best partner (duo with the best record), toughest opponent, recent games, and charts.

### 11. Live scoreboard view
- A big read-only scoreboard for spectators: team names, scores, redemption banner, last few tosses,
  no buttons. Meant for a TV or a propped-up phone. Updates live from Firestore.
- Reachable from the menu and by its own link (a hash like `#live`).

### 12. Tournament brackets
- Admin creates a tournament: pick teams (duos), seeding, single elimination (double elimination optional).
- Starting a bracket match opens a normal game with those teams; the winner advances automatically.
- Bracket view shows matchups, scores and the champion.

### 13. Game-night recap
- A summary for one night (all games logged that day): MVP (most points), most sinks, best hands (catch %),
  biggest comeback, redemptions, and each team's record.
- A **Share** button that copies a text version for the group chat.
