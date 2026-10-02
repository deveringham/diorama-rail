# Diorama Rail — Layout Guide (for layout authors, human or LLM)

A layout is one JSON document. Everything you see — track and road geometry,
heights, bridges, tunnels, terrain shaping, trees, houses, trains, cars — is
**derived** from it plus its `seed`. You never draw track directly: you give waypoints and the
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
roads[]: { id, kind "line"|"loop", points [[x,y] | {at,z?,radius?}], width 6, minRadius 10, maxGrade 0.08, speed 13,
           from? {road, at (s) | "start" | "end"}, to? {…} }               (§3)
traffic: { cars? (default ≈ 1 per 70 m of road, ≤ 60), vehicles ["car","car","car","van","bus","truck"] }
objects: { <id>: { description?, parts [part…], tint "walls", smoke 0, maxSlope 30 } }     custom scenery objects (§5)
scenery[]: { object, at [x,y], rotation 0 | face "track"|"road"|[x,y], scale 1, z?, color?, smoke? }   one object
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

## 3. Roads and traffic

Roads are a second network built the way track is — waypoints with filleted
corners, heights held to a grade, bridges, tunnels and terrain shaping — and cars,
vans, buses and lorries drive on them. Where a road meets a track at the same
height there is a **level crossing**, with flashing lights and barriers that come
down for every train.

```jsonc
"roads": [
  { "id": "country-road", "points": [[6, 300], { "at": [1092, 300], "z": -1.8 }, [1394, 300]], "speed": 16 },
  { "id": "station-street", "points": [[560, 252], [830, 252]] },
  { "id": "church-street", "points": [[560, 348], [830, 348]] },
  { "id": "west-lane", "from": { "road": "station-street", "at": "start" }, "points": [[560, 300]],
    "to": { "road": "church-street", "at": "start" } },
  { "id": "crossing-lane", "from": { "road": "south-street", "at": "end" }, "points": [[800, 230]],
    "to": { "road": "station-street", "at": 240 } }
],
"traffic": { "cars": 40 }
```

- **Geometry** works as for tracks: `points` are waypoints whose corners become
  arcs of `minRadius` (default 10 m) or a waypoint's `radius`; `kind` is `"line"`
  or `"loop"`. `width` (default 6 m) is the carriageway, two lanes, driving on the
  right. `speed` is the limit in m/s (default 13 ≈ 50 km/h); cars also slow for
  curves and turns.
- **Junctions:** `from` / `to: { road, at }` starts or ends a road on another
  road: at `s = at` along it (a T-junction) or at its `"start"` / `"end"` (a
  corner). There is no `heading`: the road leaves straight toward its first
  waypoint. Roads that cross at about the same height (within 3 m) form a
  **crossroads** by themselves. Keep road junctions at least 25 m apart along a
  road, so a car can wait between them.
- **Heights:** a road follows the ground smoothed over 40 m, held to `maxGrade`
  (default 8%). A waypoint `z` pins the height at that point only (for example a
  dip to pass under a railway bridge). A road takes the height of the road it
  joins; the later of two crossing roads takes the earlier one's. Roads keep at
  least 1 m above sea level (along a shore they run on a low quay). More than 5 m
  above the ground becomes a bridge, more than 7 m below a tunnel, as for tracks.
- **Meeting a track:** within 3 m of the track's height the crossing is a level
  crossing and the road is brought up to the rails (level for 5 m either side).
  At 6.5 m or more apart the road simply passes over or under the line (e.g.
  below a viaduct). In between is a `ROAD_CONFLICT`: add a waypoint `z` to make it
  one or the other. A level crossing must be on plain ground (not on a bridge or
  in a tunnel), clear of platforms (5 m), 35 m from a railway junction and 25 m
  from a road junction or road end, and should cross at 30° or more (ideally
  square).
  Elsewhere keep roads half their width + 2.5 m from track centres.
- **Dead ends:** a road end that joins nothing is a dead end where cars turn
  round — unless it is within 30 m of the board edge: there cars drive off the
  board and come back a few seconds later, as if the road went on.
- **Traffic:** `traffic.cars` vehicles (default about one per 70 m of road, at
  most 60) are picked at random from `traffic.vehicles` — object ids, so the
  built-in `car`, `van`, `bus` and `truck` or your own (front toward +x, origin at
  the centre, like any object; parts coloured `lamp` are headlights). Each picks
  turns at random (straight on is twice as likely), keeps its distance, takes a
  junction only when it is free and there is room beyond it, and never stops on
  a level crossing.
- **Level crossings** start flashing when a train could arrive within about
  11 s (or is close enough to need to brake), lower their barriers once no car is
  on the crossing, and open when the train's tail has passed. A train only has to
  stop for a crossing that is not closed in time, which normally never happens.
  A road over two tracks side by side (or crossing the line twice within a few
  metres) gets one crossing: both close and open together, barriers outside.
- **Scenery along roads:** placed objects must stay 0.3 m outside the
  carriageway (`SCENERY_ON_ROAD`); scattered trees keep 3 m and more away;
  `"face": "road"` turns an object's front to the nearest road. Pavements, lamps
  and houses are ordinary scenery: put houses about 10 m from a 6 m road's centre
  and lamps 4.5 m.

## 4. Scenery: buildings, trees and other objects

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
  `at` is on a platform). `face: "road"` faces the nearest road (§3).
- **Scatter:** `scatter` lists object ids picked at random (repeat an id to make
  it more common), `spacing` is the minimum distance between items, and `at` +
  `radius` limit it to a circle with a ragged edge. Scattered items skip water,
  ground steeper than the object's `maxSlope`, the track corridor (6 m+), roads
  (3 m+ beyond the carriageway) and the footprints of placed objects (plus a 2 m
  garden). Use it for forests, orchards,
  hay bales, rocks.
- Single objects are checked: within 2 m of a track centre → `SCENERY_ON_TRACK`
  (error); reaching onto a road → `SCENERY_ON_ROAD` (error); standing inside
  another placed object → `SCENERY_OVERLAP` (warning). Flat pieces under 0.5 m
  tall (`paving`) may overlap other objects.
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
| `paving` | 10 × 10 m paved square | 10 × 10 |
| `car` | small car (traffic) | 4.3 × 1.8 |
| `van` | delivery van (traffic) | 5.1 × 2 |
| `bus` | single-deck bus, windows lit at night (traffic) | 11.1 × 2.6 |
| `truck` | box lorry (traffic) | 8 × 2.5 |
| `conifer` | spruce, ~10 m, snow on top in winter | 4.6 × 5.4 |
| `deciduous` | broadleaf tree, ~8 m, autumn colours, bare in winter | 5.4 × 5.4 |
| `poplar` | tall narrow poplar, ~16 m | 3.2 × 3.2 |
| `bush` | low bush | 2.2 × 2 |
| `rock` | boulder | 2.8 × 2.2 |

See them all with `npm run screenshot -- layouts/valley-loop.json --object all --out objects.png`.

## 5. Designing objects (`objects`)

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

## 6. Rules of thumb (avoid most errors)

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
10. Cross tracks with roads at grade on plain, straight ground away from
    stations and junctions, as squarely as you can — or 6.5 m above or below.
11. Keep 25 m between road junctions, and between a junction or a road's end
    and a level crossing.
12. Lay out a town's streets as `roads` first, then line them with houses
    (≈10 m from the road centre, fronts facing it) and lamps (≈4.5 m).

## 7. Validation codes

| Code | Severity | Fix |
|---|---|---|
| `SCHEMA` | error | Match `schema.json`: fix the type, add the missing field, or remove the unknown key. |
| `DUPLICATE_ID` | error | Rename one of the two; ids are shared by tracks, roads, stations and services (objects have their own namespace). |
| `UNKNOWN_REF` | error | Use an existing id (the message lists the known ones): track, road, station, train type or object (also in `traffic.vehicles`). |
| `TRACK_REF_CYCLE` | error | A branch can't (indirectly) be its own parent; make one track (or road) a plain line/loop. |
| `OUT_OF_BOUNDS` | error | Move waypoints inward (track must stay 20 m inside the terrain, roads 5 m), or move a placed object onto the board. |
| `FILLET_OVERLAP` | error | Spread the two named waypoints apart or lower `minRadius` / waypoint `radius`. |
| `CORNER_TOO_SHARP` | error | Split the hairpin with an extra waypoint so no single turn exceeds 170°. |
| `JUNCTION_UNREACHABLE` | error | Move the branch's first (or last, for `to`) waypoint further from the junction, or flip `heading`. |
| `JUNCTION_POSITION` | error | Put `at` inside the parent (not at a line end) and on a straight or a curve ≥ 150 m. Roads: `at` within the road (or `"start"`/`"end"`), and road junctions ≥ 25 m apart. |
| `GRADE_EXCEEDED` | error | Lengthen the climb, change the `z` targets, or raise `maxGrade` (message gives the length needed). Also for roads. |
| `TRACK_CONFLICT` | error | Separate the tracks by ≥ 5 m in plan or ≥ 6 m in height, or join them with a junction. |
| `STATION_RANGE` | error | Move `at` so `at ± length/2` lies within the track. |
| `STATION_CURVE` | warning | Move the platform onto a straight (curves tighter than 300 m). |
| `STATION_STRUCTURE` | warning | Move the platform off the bridge/tunnel, onto level ground. |
| `ROUTE_DISCONNECTED` | error | Consecutive route tracks must share a junction facing the right way; insert the connecting track. |
| `ROUTE_NOT_CLOSED` | error | Use `mode: "shuttle"` or add tracks that lead back to the first one. |
| `STOP_NOT_ON_ROUTE` | error | Add the station's track to the route or drop the stop. |
| `TRAIN_TOO_LONG` | warning | Lengthen the platform or use a shorter train. |
| `CAPACITY` | warning | Fewer trains, or a longer route. (`simulate`: also vehicles that found no room on the roads — lower `traffic.cars`.) |
| `ROAD_CONFLICT` | error | A road crosses a track (or road) 3–6.5 m (5.5 m) apart in height, runs too close beside a track, or overlaps another road without a junction: make it a level crossing / crossroads, clear it in height with a waypoint `z`, move it, or join the roads with `from`/`to`. |
| `LEVEL_CROSSING_POSITION` | error | Move the crossing onto plain ground, off the platform, 35 m from railway junctions and 25 m from road junctions and road ends — or take the road over or under the line. |
| `LEVEL_CROSSING_ANGLE` | warning | Cross the track at 30° or more (ideally square) so the crossing stays short. |
| `SCENERY_ON_TRACK` | error | A placed object comes within 2 m of a track centre: move it away (the message says how far) or turn it. |
| `SCENERY_ON_ROAD` | error | A placed object (or a station building) reaches onto a road: move it further from the road centre or turn it. |
| `SCENERY_OVERLAP` | warning | Two placed objects stand inside each other: move one. |
| `DEADLOCK` | error | (`simulate` only) Trains wait on each other: add a passing loop, fewer trains, or different routes. |

Every issue has `path` (JSON path such as `tracks[1].points[2]`), a one-sentence
`message` with numbers and a suggested fix, and often `at` (map coordinates).

## 8. Authoring loop

1. Write the JSON (start from an example).
2. `npm run check -- my.json --json` → fix every error (warnings are advisory).
3. `npm run simulate -- my.json --minutes 30` → every service should stop
   regularly, no `DEADLOCK`, and `max wait` should be modest; road traffic should
   show no stuck vehicles and a longest wait under a minute or two.
4. New objects: `npm run screenshot -- my.json --object <id> --out obj.png` and
   look at it from the front-right before placing it.
5. `npm run screenshot -- my.json --view top --out top.png` to verify geometry
   (straight down, north up), then `--view overview` (and `--view follow`) to
   judge the composition: is the track readable, do towns sit next to stations,
   are bridges and tunnels where you meant them, is the board too empty or busy?
   `--t 120` shows trains after two minutes; `--cam x,y,z,tx,ty,tz` takes a close-up.
6. Iterate. Use `query(world).describe()` from `src/api.ts` for a compact text
   summary (track and road lengths, structures, junctions, level crossings,
   placed objects) when choosing `at` values; `query(world).roadAt(x, y)` and
   `trackAt(x, y)` give the `s` of a point near a road or track.

## 9. Examples

Both examples are in `layouts/`. Their tracks and services are short; most of
each file is the scenery list, one placement per line.

### `layouts/valley-loop.json`
- Terrain: a big wooded hill (north-east, 55 m), a smaller hill (north-west) and
  a shallow valley inside an oval main line (`main`, five corners at r = 120 m).
- `hill` leaves `main` at s = 700, crosses over the main line on a 350 m viaduct,
  tunnels under the hill's shoulder and ends at Bergdorf at z = 26.
- Roads: a country road from the west edge to the east edge, over both sides of
  the main line at level crossings and through a dip under the `hill` viaduct;
  Lindenau's streets as a small grid of crossroads, T-junctions and corners; a
  lane from the south street over a third level crossing just past the
  platforms; and a steep lane (`maxGrade` 0.1) up to Bergdorf from the north
  edge. 40 vehicles.
- Lindenau: the high street runs north from the station forecourt to a church
  square, crossed by Station Street, the country road and Church Street, lined
  with houses, terraces and lamps; flats by the station, gardens with trees;
  farms to the west and east.
- Bergdorf: a village lane below the station, with church and barn, in a
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
- Westhafen: a waterfront road (kept 1 m above the sea) with lamps and a row of
  houses facing the sea, joined round the end of the line to streets inland up
  to a church; a `jetty` and moored `fishing-boat`s placed at `z: 0`.
- An inland road climbs over the hills past a hamlet to Ostkap's streets; a
  lane leaves it over a level crossing west of Ostkap station and runs along the
  shore to the `lighthouse`. 28 vehicles.
- Custom objects: `lighthouse` (stacked red and white cylinders using `grid`
  steps, a glowing `lamp` lantern), `fishing-boat` (an upside-down tapered box
  as the hull, a cabin, a mast; tinted per boat) and `jetty` (a deck on a grid
  of posts).
