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

## Features

### Top priority: multiple games at once
- Today `liveGame()` in `app.js` returns only the newest live game, and every phone in the league shows it.
  If a second table starts a game, the first table's phone jumps to it and tosses from both tables land in one
  game. Until this is built, the chapter must play one game at a time.
- Allow several live games per league. Optional game label at setup ("Table 1", "Back porch"); default label is
  the two team names.
- Each phone remembers which live game it is scoring (store the game id per device, e.g. localStorage, not in
  Firestore). When more than one game is live, the Game tab shows a picker list (labels, teams, scores, whose
  toss). A phone stays on its game until that game ends, then returns to the picker or new-game screen.
- Starting a new game never takes over another phone's game. "Undo", "End game" and logging act only on the
  game this phone has selected (replace every `liveGame()` use with the selected game).
- A player can't be on two live games at once: block it at setup with a clear message.
- Stats, history and records are unchanged: all games count toward the same league.
- The live scoreboard view (item 11) should show every live game at once when there is more than one.

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
