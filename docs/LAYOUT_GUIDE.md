# Diorama Rail — Layout Guide (for layout authors, human or LLM)

A layout is one JSON document. Everything you see — track geometry, heights,
bridges, tunnels, terrain shaping, trees, houses, trains — is **derived** from it
plus its `seed`. You never draw track directly: you give waypoints and the
builder fits straights and curves through them, then checks the result.

The full machine-readable schema is in [`schema.json`](schema.json)
(regenerate with `npm run schema`). Unknown keys are errors, so typos are caught.

## 1. Coordinates and track positions

- Metres at full scale. **x = east, y = north, z = up.** The terrain is the
  rectangle `[0, 0]` – `terrain.size`, origin bottom-left (south-west).
- Headings are radians, counter-clockwise from +x (east = 0, north = π/2).
- A position on a track is `(trackId, s)`: `s` is the distance in metres along
  the track from its start.
  - `kind: "loop"`: `s = 0` is just after the curve at waypoint 0, on the
    straight heading toward waypoint 1. `s` wraps at the loop length.
  - `kind: "line"`: `s = 0` is the first point (or the junction for `from`).
- Use `npm run check -- file.json` to see track lengths (`trackLength` in stats)
  and `query(world).describe()` (see `src/api.ts`) for per-track lengths,
  junction positions, z ranges and structures, so you can place stations by `s`.

### How waypoints become track
- Each interior waypoint is a corner. The corner is replaced by an arc of radius
  `radius` (per waypoint) or the track's `minRadius`, tangent to both legs. The
  arc cuts the corner, so **the track does not pass through the waypoint**; it
  passes `r·(1/cos(θ/2) − 1)` inside it, where θ is the turn angle.
- Each curve needs `t = r·tan(θ/2)` metres of each adjoining leg. Two curves on
  one leg need `t₁ + t₂ ≤ leg length`.
- Turns under 0.5° are merged into a straight. Turns over 170° are rejected.

### Junctions (`from` / `to`)
- `from: { track: "main", at: 700, heading: "forward" }` — the branch starts at
  `main` s=700, tangent to it, leaving in main's direction of increasing s
  (`"backward"`: decreasing s). It curves (radius `minRadius`) toward the first
  waypoint until it points straight at it.
- `to: { … }` — the same at the branch's end: the branch arrives at the parent
  travelling in the parent's forward (or backward) direction.
- The branch's height at the junction is taken from the parent.
- A passing loop is a `line` with both `from` and `to` on the same parent.
  Its first/last waypoints sit beside the parent (≥ 5 m away), at least
  `1.5·√(minRadius·offset)` metres along from each junction.

### Heights
- If any waypoint has `z`, heights are interpolated linearly by `s` between the
  `z` waypoints and the junction ends (held constant beyond the first/last).
  Otherwise the track follows the terrain, smoothed over a 120 m window.
- Grades are then limited to `maxGrade` (default 3.5%). Explicit `z` and junction
  heights are hard constraints.
- Where the track is more than 5 m above the original ground it becomes a
  **bridge**; more than 7 m below, a **tunnel**. Elsewhere the ground is shaped
  into embankments and cuttings (about 1:1.5).

### Terrain
- `features`: smooth bumps (`height > 0`) or basins (`height < 0`); about 5% of
  the height remains at `radius`, so a hill's flank at 0.45·radius sits at
  roughly half its height.
- `noise.amplitude` metres of gentle relief at `noise.scale` metres.
- `seaLevel`: a water plane at this z; anything below is sea. Keep track z above
  it (use waypoint `z`) — crossing water automatically makes a bridge or causeway.

## 2. Schema summary

```text
version: 1, name, seed (int, default 1)
terrain: { size [w,h], cell 4, baseHeight 0, seaLevel null, features [{at,radius,height}], noise {amplitude 2, scale 120} }
tracks[]: { id /^[a-z][a-z0-9-]*$/, kind "loop"|"line", points [[x,y] | {at,z?,radius?}], minRadius 40, maxGrade 0.035,
            from? {track, at, heading "forward"|"backward"}, to? {…} }      loop ≥ 3 points; line ≥ 2 (≥ 1 with from/to)
stations[]: { id, name, track, at (s of platform centre), length 120, side "left"|"right"|"both" (relative to +s) }
services[]: { id, train "regional-3"|"express-6"|"freight-10"|"tram-2", color? "#rrggbb", route [track ids],
              mode "loop"|"shuttle", stops [station ids], dwell 25, count 1 }
scenery: { towns [{near: stationId|[x,y], radius, density 0..1}], forests [{at, radius, density}], scatterTrees 0.15 }
style: { season "summer"|"autumn"|"winter", timeOfDay 15, dayLengthSeconds null }
```

Train lengths: `regional-3` 66 m, `express-6` 145 m, `freight-10` 158 m, `tram-2` 28 m.

### Services and routes
- `route` lists tracks in travel order; consecutive tracks must share a junction,
  and the junction must face the right way for a through run.
- `mode: "loop"` — the route must close (a single `loop` track, or tracks that
  lead back to the first). Trains run in the direction of increasing `s` on a
  single loop track.
- `mode: "shuttle"` — the train runs to the end of the route, waits, and comes
  back. Each end is the farthest stop on the end track (the train stops centred
  on that platform), else the buffer stop. A shuttle that starts on a loop track
  turns round at its stop on that loop.
- **v0.1 limitation:** a service follows one fixed path. To let two shuttles pass
  each other on a passing loop, use two services (each `count: 1`) whose routes
  differ only in which loop track they take — see `harbour-town`. Point the
  passing track's `from`/`to` so that the second service's route runs the other
  way, and both trains start at opposite ends.
- A train may only enter a stretch it shares with opposing traffic once it can
  reserve all of it plus room to stand clear beyond, so single-track sections
  never deadlock — but they do make trains wait.

## 3. Rules of thumb (avoid most errors)

1. Keep waypoints at least `2·minRadius` apart where the track turns.
2. Put junctions on straights (`at` well away from curves); turnouts on curves
   tighter than 150 m are rejected.
3. Keep parallel tracks at least 5 m apart (centre to centre).
4. Give each station straight, level track at least as long as its trains.
5. A 30 m climb needs about 860 m of track at 3.5%.
6. Keep all track at least 20 m inside the terrain edge.
7. Branch first waypoints need room to curve: well outside a circle of radius
   `minRadius` touching the parent at the junction.
8. Avoid gentle bumps that leave the track 5–7 m above or below the ground over
   long distances; decide on a real bridge (cross a valley) or a real tunnel.
9. Ten trains need ten times (train length + 150 m) of route.

## 4. Validation codes

| Code | Severity | Fix |
|---|---|---|
| `SCHEMA` | error | Match `schema.json`: fix the type, add the missing field, or remove the unknown key. |
| `DUPLICATE_ID` | error | Rename one of the two; ids are shared by tracks, stations and services. |
| `UNKNOWN_REF` | error | Use an existing id (the message lists the known ones) or a catalog train type. |
| `TRACK_REF_CYCLE` | error | A branch can't (indirectly) be its own parent; make one track a plain line/loop. |
| `OUT_OF_BOUNDS` | error | Move waypoints inward; track must stay 20 m inside the terrain. |
| `FILLET_OVERLAP` | error | Spread the two named waypoints apart or lower `minRadius` / waypoint `radius`. |
| `CORNER_TOO_SHARP` | error | Split the hairpin with an extra waypoint so no single turn exceeds 170°. |
| `JUNCTION_UNREACHABLE` | error | Move the branch's first (or last, for `to`) waypoint further from the junction, or flip `heading`. |
| `JUNCTION_POSITION` | error | Put `at` inside the parent (not at a line end) and on a straight or a curve ≥ 150 m. |
| `GRADE_EXCEEDED` | error | Lengthen the climb, change the `z` targets, or raise `maxGrade` (message gives the length needed). |
| `TRACK_CONFLICT` | error | Separate the tracks by ≥ 5 m in plan or ≥ 6 m in height, or join them with a junction. |
| `STATION_RANGE` | error | Move `at` so `at ± length/2` lies within the track. |
| `STATION_CURVE` | warning | Move the platform onto a straight (curves tighter than 300 m). |
| `STATION_STRUCTURE` | warning | Move the platform off the bridge/tunnel, onto level ground. |
| `ROUTE_DISCONNECTED` | error | Consecutive route tracks must share a junction facing the right way; insert the connecting track. |
| `ROUTE_NOT_CLOSED` | error | Use `mode: "shuttle"` or add tracks that lead back to the first one. |
| `STOP_NOT_ON_ROUTE` | error | Add the station's track to the route or drop the stop. |
| `TRAIN_TOO_LONG` | warning | Lengthen the platform or use a shorter train. |
| `CAPACITY` | warning | Fewer trains, or a longer route. |
| `DEADLOCK` | error | (`simulate` only) Trains wait on each other: add a passing loop, fewer trains, or different routes. |

Every issue has `path` (JSON path such as `tracks[1].points[2]`), a one-sentence
`message` with numbers and a suggested fix, and often `at` (map coordinates).

## 5. Authoring loop

1. Write the JSON (start from an example).
2. `npm run check -- my.json --json` → fix every error (warnings are advisory).
3. `npm run simulate -- my.json --minutes 30` → every service should stop
   regularly, no `DEADLOCK`, and `max wait` should be modest.
4. `npm run screenshot -- my.json --view top --out top.png` to verify geometry
   (straight down, north up), then `--view overview` (and `--view follow`) to
   judge the composition: is the track readable, do towns sit next to stations,
   are bridges and tunnels where you meant them, is the board too empty or busy?
   `--t 120` shows trains after two minutes; `--cam x,y,z,tx,ty,tz` takes a close-up.
5. Iterate. Use `query(world).describe()` from `src/api.ts` for a compact text
   summary (track lengths, structures, junctions) when choosing `at` values.

## 6. Examples

### `layouts/valley-loop.json`
```jsonc
{
  "version": 1, "name": "Valley Loop", "seed": 7,
  "terrain": {
    "size": [1400, 1000], "cell": 4,
    "features": [
      { "at": [1150, 800], "radius": 260, "height": 55 },   // the big wooded hill (north-east)
      { "at": [300, 850], "radius": 200, "height": 30 },    // smaller hill (north-west)
      { "at": [700, 500], "radius": 220, "height": -8 }     // shallow valley inside the oval
    ],
    "noise": { "amplitude": 3, "scale": 140 }, "seaLevel": null
  },
  "tracks": [
    // An oval main line: 5 corners at r = 120 m. s = 0 is at (313, 200) heading east.
    { "id": "main", "kind": "loop", "minRadius": 120,
      "points": [[200, 200], [1200, 200], [1250, 560], [700, 680], [180, 560]] },
    // Branch leaving main at s = 700 (the long southern straight), crossing over the
    // main line on a 350 m viaduct, tunnelling under the hill's shoulder and ending
    // at the hill village at z = 26.
    { "id": "hill", "kind": "line", "minRadius": 80,
      "from": { "track": "main", "at": 700, "heading": "forward" },
      "points": [[1080, 420], [1120, 700], [1030, 750], { "at": [1030, 890], "z": 26 }] }
  ],
  "stations": [
    { "id": "lindenau", "name": "Lindenau", "track": "main", "at": 380, "length": 160, "side": "both" },
    // On the hill line's final straight, out of the tunnel (hill is 769 m long).
    { "id": "bergdorf", "name": "Bergdorf", "track": "hill", "at": 722, "length": 80, "side": "right" }
  ],
  "services": [
    { "id": "r1", "train": "regional-3", "route": ["main"], "mode": "loop", "stops": ["lindenau"], "count": 2 },
    { "id": "f1", "train": "freight-10", "route": ["main"], "mode": "loop", "stops": [], "count": 1 },
    // Shuttles between Lindenau (on the loop) and Bergdorf; it runs against the loop
    // traffic between Lindenau and the junction, so it waits for a clear path.
    { "id": "t1", "train": "tram-2", "route": ["main", "hill"], "mode": "shuttle", "stops": ["lindenau", "bergdorf"], "count": 1 }
  ],
  "scenery": {
    "towns": [{ "near": "lindenau", "radius": 180, "density": 0.7 }, { "near": "bergdorf", "radius": 90, "density": 0.5 }],
    "forests": [{ "at": [1150, 800], "radius": 240, "density": 0.8 }, { "at": [300, 850], "radius": 150, "density": 0.6 }],
    "scatterTrees": 0.15
  },
  "style": { "season": "summer", "timeOfDay": 15, "dayLengthSeconds": null }
}
```

### `layouts/harbour-town.json`
```jsonc
{
  "version": 1, "name": "Harbour Town", "seed": 11,
  "terrain": {
    "size": [1600, 1000], "cell": 4, "baseHeight": -6, "seaLevel": 0,
    "features": [
      { "at": [200, 1250], "radius": 1100, "height": 38 },   // three broad rises north of the map:
      { "at": [1400, 1250], "radius": 1100, "height": 38 },  // land climbs from the sea (south)
      { "at": [800, 1350], "radius": 1000, "height": 20 },   // toward wooded hills (north)
      { "at": [830, 370], "radius": 170, "height": -13 },    // the bay the line bridges
      { "at": [1250, 820], "radius": 260, "height": 25 }     // a hill behind Ostkap
    ],
    "noise": { "amplitude": 2.5, "scale": 160 }
  },
  "tracks": [
    // Coastal line west → east. z at both ends keeps it 3.5–4.5 m above the sea,
    // so it crosses the bay on a 225 m bridge.
    { "id": "coast", "kind": "line", "minRadius": 300,
      "points": [{ "at": [120, 450], "z": 3.5 }, [700, 430], [1000, 440], { "at": [1480, 500], "z": 4.5 }] },
    // Passing loop 6 m north of the coast line between s = 190 and s = 500. It is
    // drawn east → west (both junctions "backward") so a route through it runs
    // from Ostkap to Westhafen.
    { "id": "passing", "kind": "line", "minRadius": 150,
      "from": { "track": "coast", "at": 500, "heading": "backward" },
      "points": [{ "at": [565, 440.7], "z": 3.7 }, { "at": [365, 447.6], "z": 3.7 }],
      "to": { "track": "coast", "at": 190, "heading": "backward" } }
  ],
  "stations": [
    { "id": "westhafen", "name": "Westhafen", "track": "coast", "at": 90, "length": 120, "side": "right" },
    { "id": "ostkap", "name": "Ostkap", "track": "coast", "at": 1270, "length": 120, "side": "left" }
  ],
  "services": [
    // Two shuttles that cross at the passing loop (v0.1: one service per loop track).
    // east-west starts at Westhafen and keeps to the coast line; west-east starts at
    // Ostkap and takes the passing track.
    { "id": "east-west", "train": "regional-3", "route": ["coast"], "mode": "shuttle", "stops": ["westhafen", "ostkap"] },
    { "id": "west-east", "train": "regional-3", "color": "#3d7d8c", "route": ["coast", "passing", "coast"],
      "mode": "shuttle", "stops": ["ostkap", "westhafen"] }
  ],
  "scenery": {
    "towns": [
      { "near": "westhafen", "radius": 160, "density": 0.75 },
      { "near": "ostkap", "radius": 120, "density": 0.6 },
      { "near": [560, 620], "radius": 70, "density": 0.4 }      // a hamlet inland
    ],
    "forests": [{ "at": [1250, 820], "radius": 210, "density": 0.75 }, { "at": [380, 860], "radius": 220, "density": 0.5 }],
    "scatterTrees": 0.12
  },
  "style": { "season": "autumn", "timeOfDay": 16.5, "dayLengthSeconds": 600 }   // a 10-minute day
}
```
