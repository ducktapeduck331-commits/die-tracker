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

### 11. Live scoreboard view
- A big read-only scoreboard for spectators: team names, scores, redemption banner, last few tosses,
  no buttons. Meant for a TV or a propped-up phone. Updates live from Firestore.
- Reachable from the menu and by its own link (a hash like `#live`).
- Several games can be live at once (built). Show every live game when there is more than one. The picker cards
  already exist and are read-only without `opts.pick`: reuse `gameCard()` / `gameCards()` in `app.js`.

### 12. Tournament brackets
- Admin creates a tournament: pick teams (duos), seeding, single elimination (double elimination optional).
- Starting a bracket match opens a normal game with those teams; the winner advances automatically.
- Bracket view shows matchups, scores and the champion.

### 13. Game-night recap
- A summary for one night (all games logged that day): MVP (most points), most sinks, best hands (catch %),
  biggest comeback, redemptions, and each team's record.
- A **Share** button that copies a text version for the group chat.
