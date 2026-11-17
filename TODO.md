# Sig Tau Beer Die: to-do list

Planned changes, saved for later. Nothing here is built yet. Work through them roughly in this order,
one at a time, and test each on a phone before moving on.

How the app works (read before changing anything):
- Static site on GitHub Pages: `index.html`, `styles.css`, `app.js` (ES module), `sw.js`, `firebase-config.js`.
- Data is in Firebase Firestore under `leagues/{CODE}/players`, `leagues/{CODE}/games`, `leagues/{CODE}/members`,
  `leagues/{CODE}/tournaments`.
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

### 13. Game-night recap
- A summary for one night (all games logged that day): MVP (most points), most sinks, best hands (catch %),
  biggest comeback, redemptions, and each team's record.
- A **Share** button that copies a text version for the group chat.

---

## More ideas (not yet prioritized)

Owner's top picks: **Rules tab**, **Power rankings**, **Achievements**, **Rush mode**.

### At the table

#### Rules tab
- A read-only page with the chapter's Beer Die house rules: setup (table, cups, dice, height), scoring
  (point, tink, sink, field goal), defense (one-hand catch, drops), redemption (2 tosses, one per teammate,
  3 per team, knock back to 11, leftover points add), FIFA (catch only), Die Don't Lie, self-sink, first toss
  (High/Low). Keep it in sync with what the app actually scores. Admins could edit the text later (optional).

#### Height check vote
- When a toss might be too low, both teams can tap a quick vote ("Too low" / "Good"). Majority or the
  defending team's call decides (confirm the rule with the owner first). Logs as Too low or as the toss result.

#### Sound effects
- Optional sounds for sink, tink, win and redemption (short, generated with Web Audio, no files needed).
  Off by default, with a mute toggle remembered per phone. Must start from a user tap (browser rule).

#### Faster logging
- Shortcuts for the most common outcomes (Point, Caught, Short) so the scorekeeper taps less, e.g. a
  long-press on a defender to log "Point on X" directly, or swipe gestures. Keep big buttons as the default.

### Competition

#### Power rankings (Elo)
- An Elo-style rating per player (and per duo), updated after every finished game by opponent strength.
  Recompute from game history so it never drifts. Show on the leaderboard, profiles, and a rankings card,
  with rating change per game (+12 / -8).

#### Challenges
- A duo can challenge another duo in the app; the other side accepts or declines. Accepted challenges show as
  "Upcoming" and start as a normal game with one tap. Needs a new Firestore collection + rules update.

#### Achievements and badges
- Earned automatically from game history, shown on profiles with the date earned. Examples: First sink,
  Hat trick (3 sinks in a game), Perfect defense game (no drops, 3+ catches), Survived 3 redemptions,
  Comeback kid (won after trailing by 6+), 10-game win streak, Tournament champion, Iron hands (90%+ catch
  rate over 20 chances). Toast when someone earns one live.

#### Rivalries
- Detect the pair of players (and duos) who have played each other most; show the series score on both
  profiles and a "Top rivalries" card on Stats.

### Chapter life

#### Hall of fame
- A permanent page of all-time records: most sinks in a game, most points in a game, longest win streak,
  best catch % (min chances), most redemptions, biggest comeback, tournament champions by date.

#### Rush mode (guest players)
- Rushees/guests can be added and played without a Google account (already possible as "guest" players);
  add a quick "Rush night" flow to add several guests fast, mark them as rush, and later merge a guest into
  their real account when they join (the admin merge tool exists; make it easy from the guest's profile).

#### Big/little family stats
- Tag big-brother/little-brother links between players. Show family lines and team stats for each family
  (combined record, best family duo).

#### Notifications
- Push notifications for: join request approved, your tournament match is ready, someone broke your record.
  Needs Firebase Cloud Messaging, a service worker push handler, per-user permission, and something to send
  them (Cloud Functions requires the paid Blaze plan). iOS only supports web push for home-screen apps.
  Check cost and setup with the owner before building.

### Behind the scenes

#### Automatic weekly backup
- Back up the league data automatically instead of relying on the Export button. Options: Firestore
  scheduled exports (needs the paid Blaze plan + a Cloud Storage bucket, low cost) or a scheduled job that
  reads the data and saves it elsewhere. Confirm the cost with the owner before setting it up.
