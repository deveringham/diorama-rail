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
stations[]: { id, name, track, at (s of platform centre), length 120, side "left"|"right"|"both" (relative to +s),
              building "station-building" (object id, or null for none) }
services[]: { id, train "regional-3"|"express-6"|"freight-10"|"tram-2", color? "#rrggbb", route [track ids],
              mode "loop"|"shuttle", stops [station ids], dwell 25, count 1 }
objects: { <id>: { description?, parts [part…], tint "walls", smoke 0, maxSlope 30 } }     custom scenery objects (§3)
scenery[]: { object, at [x,y], rotation 0 | face "track"|[x,y], scale 1, z?, color?, smoke? }   one object
         | { scatter [ids], spacing, at? [x,y], radius?, scale [0.8, 1.2] }                     many, randomly
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

## 3. Scenery: buildings, trees and other objects

Everything beside the track — houses, churches, trees, lamps, boats — is an
**object**: a small low-poly model described in JSON. Many are built in (below);
a layout can define its own in `objects` (and may redefine a built-in id to
restyle it everywhere, e.g. `"house"` or `"station-building"`). Objects are
placed through `scenery`.

### Placing objects (`scenery`)

```jsonc
"scenery": [
  { "object": "church", "at": [693, 410], "rotation": 270 },        // front (+x) faces 270° = south
  { "object": "house", "at": [640, 262], "face": "track" },         // turn to face the nearest track
  { "object": "house", "at": [655, 262], "face": [655, 252], "color": "#e8d2a6" },
  { "object": "fishing-boat", "at": [196, 352], "rotation": 265, "z": 0 },   // float at sea level
  { "scatter": ["conifer", "conifer", "deciduous"], "at": [1170, 790], "radius": 230, "spacing": 7 },
  { "scatter": ["deciduous", "bush"], "spacing": 80 }               // no at/radius: the whole map
]
```

- **One object:** `object` + `at`. `rotation` is the direction (degrees
  counter-clockwise from east) its **front** faces; buildings have their doors
  at the front. `face` turns it toward the nearest track or a point instead.
  `scale` resizes it, `color` sets the colour of its `"tint"` parts (default:
  picked from the object's tint list), `smoke` turns its chimneys on/off, and `z`
  sets an absolute base height (default: the ground, or the platform surface if
  `at` is on a platform).
- **Scatter:** `scatter` lists object ids picked at random (repeat an id to make
  it more common), `spacing` is the minimum distance between items, and `at` +
  `radius` limit it to a circle with a ragged edge. Scattered items skip water,
  ground steeper than the object's `maxSlope`, the track corridor (6 m+) and the
  footprints of placed objects (plus a 2 m garden). Use it for forests, orchards,
  hay bales, rocks.
- Single objects are checked: within 2 m of a track centre → `SCENERY_ON_TRACK`
  (error); standing inside another placed object → `SCENERY_OVERLAP` (warning).
  Flat pieces under 0.5 m tall (`road`, `paving`) may overlap anything.
- Stations add their own `building` (beside the platform, facing it) and
  benches (`bench`); people on platforms are automatic.

### Built-in objects

| id | what | footprint (x × y m) |
|---|---|---|
| `house` | two-storey house, door at the front, chimney (smokes sometimes) | 7.8 × 9.8 |
| `terrace` | row of three terraced houses | 8.8 × 22.8 |
| `flats` | four-storey block of flats | 12.4 × 16.4 |
| `church` | church with tower and spire; the tower end is the front | 25 × 10.8 |
| `barn` | timber barn with big doors | 11 × 16.8 |
| `station-building` | used for every station unless `building` says otherwise | 9.8 × 16.8 |
| `bench` | platform bench | 0.6 × 1.8 |
| `lamp-post` | street lamp, lit at night | 0.6 × 0.6 |
| `fence` | 10 m of wooden fence along y | 0.2 × 10.2 |
| `road` | 10 m of 6 m road along x; lay end to end on gentle ground | 10 × 6 |
| `paving` | 10 × 10 m paved square | 10 × 10 |
| `conifer` | spruce, ~10 m, snow on top in winter | 4.6 × 5.4 |
| `deciduous` | broadleaf tree, ~8 m, autumn colours, bare in winter | 5.4 × 5.4 |
| `poplar` | tall narrow poplar, ~16 m | 3.2 × 3.2 |
| `bush` | low bush | 2.2 × 2 |
| `rock` | boulder | 2.8 × 2.2 |

See them all with `npm run screenshot -- layouts/valley-loop.json --object all --out objects.png`.

## 4. Designing objects (`objects`)

An object is a list of **parts**, each a low-poly primitive in the object's own
frame: **x = front, y = left, z = up**, metres, origin on the ground at the
object's centre. Every part stands on its `at` point (its bottom centre).

```jsonc
"objects": {
  "kiosk": {
    "description": "Newspaper kiosk, 3 × 2 m, counter at the front",
    "tint": ["#3d7d8c", "#8a4a3a"],                       // one of these per placement
    "parts": [
      { "shape": "box", "size": [3, 2, 2.4] },                                           // colour "tint" by default
      { "shape": "pyramid", "at": [0, 0, 2.4], "size": [3.6, 2.6, 0.8], "color": "roof", "winter": "snow" },
      { "shape": "panel", "at": [1.45, 0, 0.9], "size": [0.1, 2.2, 1], "color": "window" }   // glows at night
    ]
  }
}
```

**Shapes** (`size` is always [along x, along y, height]):

| shape | what it is |
|---|---|
| `box` | a box; `taper` (top size as a fraction of the bottom, number or [x, y]) makes a frustum |
| `pyramid` | a box narrowing to a point (taper 0); `taper: [1, 0]` gives a hipped ridge along x |
| `gable` | triangular roof prism, ridge along x at full height; `ridge` 0..1 moves it across (0 or 1 = lean-to) |
| `cylinder` | n-sided cylinder (`sides`, default 8), elliptical if x ≠ y; `taper` narrows the top |
| `cone` | cylinder with taper 0 (`sides` default 6) |
| `sphere` | low-poly ellipsoid (`detail` 0 = 20 faces, 1 = 80) |
| `panel` | only the front (+x) face of the box, one-sided: windows, doors, signs |

**Placement within the object:** `at` [x, y, z] (negative z sinks a part into the
ground, e.g. a 3 m plinth so buildings sit on slopes), `rotate` [x°, y°, z°]
(applied about x, then y, then z, pivoting on `at`; right-handed: `[0, 0, 90]`
turns the front to face +y, `[0, 90, 0]` lays a cylinder along x, `[180, 0, 0]`
turns a part upside down so it hangs below `at`, as for a boat hull), `grid`
[nx, ny, nz] with `step` [dx, dy, dz] for rows of windows, posts or columns, and
`mirror` `"x"` (front↔back), `"y"` (left↔right) or `"xy"` for symmetric copies.

**Colours:** `"#rrggbb"`, or a name: `wall plaster brick stone concrete wood
timber metal dark white red yellow blue green roof roof-slate roof-dark roof-grey
chimney trunk window lamp snow sand water grass`, plus seasonal `foliage` and
`needles`. `"tint"` (the default) uses the placement's colour, picked from the
object's `tint`: a list of colours or a palette list (`walls`, `roofs`, `foliage`,
`needles`, `people`; foliage and needles follow the season). Only one tint
colour per placement, so give fixed colours to roofs, doors and trims.

**Seasons, light and smoke:** `winter` is the part's colour in winter (snow on
roofs); `seasons` limits a part to some seasons (a full crown in summer and
autumn, bare twigs in winter); `glow: true` (default for `window` and `lamp`)
lights the part warmly at night; `smoke: true` marks a chimney, and the object's
`smoke` (0..1) is the share of placements whose chimneys smoke.

**Tips for good low-poly objects**
- Think in 3–12 parts. Body, roof, chimney, a door panel, a grid of window panels.
- Keep it to scale: storeys are ~3 m, doors 2 × 1 m, windows 1.2 × 1.3 m, trees
  8–15 m. A person is 1.7 m and a carriage 3 m wide.
- Put windows as `panel`s 0.03 m in front of the wall they sit on, with `mirror`
  for the back or other side.
- Give walls a 2–3 m plinth below ground (`"at": [0, 0, -3]`, height + 3) so the
  object stands cleanly on sloping ground.
- Check each new object alone before placing it:
  `npm run screenshot -- my.json --object kiosk --out kiosk.png`
  (`--season winter` to see winter colours; `--object all` for everything).
- Budget: a house is ~60 triangles; keep objects under ~500. Every object type
  in use costs 2–3 draw calls, however many times it is placed.

## 5. Rules of thumb (avoid most errors)

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

## 6. Validation codes

| Code | Severity | Fix |
|---|---|---|
| `SCHEMA` | error | Match `schema.json`: fix the type, add the missing field, or remove the unknown key. |
| `DUPLICATE_ID` | error | Rename one of the two; ids are shared by tracks, stations and services (objects have their own namespace). |
| `UNKNOWN_REF` | error | Use an existing id (the message lists the known ones): track, station, train type or object. |
| `TRACK_REF_CYCLE` | error | A branch can't (indirectly) be its own parent; make one track a plain line/loop. |
| `OUT_OF_BOUNDS` | error | Move waypoints inward (track must stay 20 m inside the terrain), or move a placed object onto the board. |
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
| `SCENERY_ON_TRACK` | error | A placed object comes within 2 m of a track centre: move it away (the message says how far) or turn it. |
| `SCENERY_OVERLAP` | warning | Two placed objects stand inside each other: move one. |
| `DEADLOCK` | error | (`simulate` only) Trains wait on each other: add a passing loop, fewer trains, or different routes. |

Every issue has `path` (JSON path such as `tracks[1].points[2]`), a one-sentence
`message` with numbers and a suggested fix, and often `at` (map coordinates).

## 7. Authoring loop

1. Write the JSON (start from an example).
2. `npm run check -- my.json --json` → fix every error (warnings are advisory).
3. `npm run simulate -- my.json --minutes 30` → every service should stop
   regularly, no `DEADLOCK`, and `max wait` should be modest.
4. New objects: `npm run screenshot -- my.json --object <id> --out obj.png` and
   look at it from the front-right before placing it.
5. `npm run screenshot -- my.json --view top --out top.png` to verify geometry
   (straight down, north up), then `--view overview` (and `--view follow`) to
   judge the composition: is the track readable, do towns sit next to stations,
   are bridges and tunnels where you meant them, is the board too empty or busy?
   `--t 120` shows trains after two minutes; `--cam x,y,z,tx,ty,tz` takes a close-up.
6. Iterate. Use `query(world).describe()` from `src/api.ts` for a compact text
   summary (track lengths, structures, junctions, placed objects) when choosing
   `at` values.

## 8. Examples

Both examples are in `layouts/`. Their tracks and services are short; most of
each file is the scenery list, one placement per line.

### `layouts/valley-loop.json`
- Terrain: a big wooded hill (north-east, 55 m), a smaller hill (north-west) and
  a shallow valley inside an oval main line (`main`, five corners at r = 120 m).
- `hill` leaves `main` at s = 700, crosses over the main line on a 350 m viaduct,
  tunnels under the hill's shoulder and ends at Bergdorf at z = 26.
- Lindenau: a station road running north from the platforms to a church square,
  crossed by three streets of houses and terraces, flats by the station, lamps,
  gardens with trees; farms to the west and east.
- Bergdorf: a village street below the station, with church and barn, in a
  clearing of the hill forest.
- Custom objects defined in the layout: `windmill` (a tapered tower, cap and four
  sails made from rotated boxes) and `hay-bale` (a cylinder on its side,
  scattered over a field):

```jsonc
"windmill": {
  "description": "Tower windmill with a cap and four sails; the sails face +x",
  "tint": ["#ece6da", "#e2d8c6"],
  "parts": [
    { "shape": "cylinder", "size": [9, 9, 14], "sides": 8, "taper": 0.7 },
    { "shape": "cone", "at": [0, 0, 14], "size": [7.2, 7.2, 4.2], "sides": 8, "color": "roof-dark", "winter": "snow" },
    { "shape": "panel", "at": [4.1, 0, 0], "size": [0.2, 1.4, 2.4], "color": "timber" },
    { "shape": "cylinder", "at": [3.2, 0, 15.2], "size": [1.2, 1.2, 1.8], "sides": 6, "rotate": [0, 90, 0], "color": "timber" },
    { "shape": "box", "at": [4.8, 0, 15.2], "size": [0.3, 1.8, 10], "rotate": [45, 0, 0], "color": "white" },
    { "shape": "box", "at": [4.8, 0, 15.2], "size": [0.3, 1.8, 10], "rotate": [135, 0, 0], "color": "white" },
    ...
  ]
}
```

### `layouts/harbour-town.json`
- Terrain falls from wooded hills in the north to the sea (`seaLevel: 0`) in the
  south, with a bay that the coastal line crosses on a 225 m bridge.
- `coast` runs between the termini Westhafen and Ostkap, with a 6 m-offset
  passing loop; two shuttles (one per loop track) cross there every cycle.
- Westhafen: a waterfront road with lamps and a row of houses facing the sea,
  streets inland up to a church, a `jetty` and moored `fishing-boat`s placed at
  `z: 0`. Ostkap: streets behind the station and a `lighthouse` on the point.
- Custom objects: `lighthouse` (stacked red and white cylinders using `grid`
  steps, a glowing `lamp` lantern), `fishing-boat` (an upside-down tapered box
  as the hull, a cabin, a mast; tinted per boat) and `jetty` (a deck on a grid
  of posts).
