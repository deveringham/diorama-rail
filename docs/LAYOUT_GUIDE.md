# Diorama Rail — Layout Guide (for layout authors, human or LLM)

A layout is one JSON document. Everything you see — track, road and path
geometry, heights, bridges, tunnels, terrain shaping, trees, houses, trains,
cars, the people who live in the houses and their comings and goings — is
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
  into embankments and cuttings (about 1:1.5). The cutting runs 8 m on into each
  tunnel, where a stone portal and a short box section meet the hill, so the
  mouth stays open; trees grow on the hill above the tunnel.

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
stations[]: { id, name, kind "passenger"|"freight", track, at (s of platform centre), length 120,
              side "left"|"right"|"both" (relative to +s; a freight yard one side), road? (freight: the road along the dock),
              building "station-building" / freight "goods-shed" (object id, or null for none) }   (freight §8)
services[]: { id, train "regional-3"|"express-6"|"freight-4"|"freight-10"|"tram-2", color? "#rrggbb", route [track ids],
              mode "loop"|"shuttle", stops [station or off-layout ids], dwell 25, count 1 }
roads[]: { id, kind "line"|"loop", points [[x,y] | {at,z?,radius?}], width 6, minRadius 10, maxGrade 0.08, speed 13,
           sidewalks "none"|"both"|"left"|"right", sidewalkWidth 2, parking "none"|"both"|"left"|"right",
           parkingStyle "parallel"|"perpendicular", name?, from? {road, at (s) | "start" | "end"}, to? {…} }   (§3, §4)
paths[]: { id, kind "line"|"loop", points [[x,y] | {at,z?,radius?}], width 2, surface "gravel"|"paved", minRadius 3,
           maxGrade 0.12, name?, from? {path | road, at (s) | "start" | "end"} | {station}, to? {…} }   (§4)
parking[]: { id, at [x,y], spaces 20, rotation?, road?, name? }                                  car parks (§3)
busStops[]: { id, name?, road, at (s of the sign), side "both"|"left"|"right", shelter true }      bus stops (§6)
busLines[]: { id, name?, stops [bus stop or off-layout ids], mode "shuttle"|"loop", count 1, dwell 12, capacity 40, vehicle "bus", color? }
offLayout[]: { id, name?, via [{ track | road | path, end? "start"|"end", distance 2000 }], jobs 0, titles ["Employee"], visits 1,
               supplies {}, demands {} }   (§7, §8)
freight: { vehicles? [{ name?, object "van", count 2, capacity 6, goods? [ids], color? }] }      delivery fleet (§8)
people: { count? (default: as many as the homes hold, ≤ 600), cars 0.45, vehicles ["car","car","car","van"] }   (§5)
traffic: { cars? (through traffic; default ≈ 1 per 200 m of road, ≤ 30), vehicles ["car","car","van","truck"] }
objects: { <id>: { description?, building?, parts [part…], tint "walls", smoke 0, maxSlope 30 } }   custom objects (§10)
scenery[]: { object, at [x,y], rotation 0 | face "track"|"road"|[x,y], scale 1, z?, color?, smoke?, name?, building? }
         | { scatter [ids], spacing, at? [x,y], radius?, scale [0.8, 1.2] }                     many, randomly
building: { functions ["accommodation"|"workplace"|"landmark"], residents 3, jobs 3, titles ["Employee"], kind?, door? [x,y],
            supplies? { goods: loads/h }, demands? { goods: loads/h } }
style: { season "summer"|"autumn"|"winter", timeOfDay 15, dayLengthSeconds null }
```

Train lengths: `regional-3` 66 m, `express-6` 145 m, `freight-4` 74 m, `freight-10` 158 m, `tram-2` 28 m.

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
vans and lorries drive on them, and buses on their lines (§6). Where a road meets a track at the same
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
    "to": { "road": "station-street", "at": 240 }, "parking": "both" }
],
"parking": [{ "id": "station-car-park", "name": "Station Car Park", "at": [568, 148], "spaces": 24, "rotation": 90 }],
"traffic": { "cars": 10 }
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
  road, so a car can wait between them. Each junction (and corner) is paved as
  one piece out to where the roads' kerbs meet, with square corners.
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
  square); under 15° is an error. Crossings with less than 60 m of road between
  them work as one for the cars, which wait before the first while either is shut.
  Elsewhere keep roads half their width + 2.5 m from track centres.
- **Dead ends:** a road end that joins nothing is a dead end where cars turn
  round — unless it lies on the board's edge: then the road leads off the board
  (§7), and through traffic drives off and comes back a few seconds later, as if
  the road went on.
- **Street parking:** `parking` (`left`, `right` or `both`, of increasing s) adds
  a strip of bays between the carriageway and the sidewalk: 2.4 m of parallel
  bays 6 m long (`parkingStyle: "parallel"`, the default) or 5.2 m of nose-in
  bays (`"perpendicular"`). The strip widens the road: its sidewalks move out with
  it, so houses go about 12.5 m from a 6 m road's centre and lamps about 7 m.
  There are no bays near junctions, crossings, zebras, path ends, bridges or dead
  ends, nor where a car pulling out would cross one.
- **Car parks:** each `parking` entry is a car park centred on `at`: two rows of
  nose-in bays (`spaces`, default 20) either side of an aisle, 16.4 m wide and
  2 + 1.3·spaces + 8 m long. Its entrance faces the road it joins (the nearest, or
  `road`; or set `rotation`, the direction the entrance faces) by a driveway of
  1–60 m; the aisle is a dead-end road of its own, so cars reach the bays under
  the usual rules. The paved area must keep clear of roads, tracks and placed
  objects (`PARKING_POSITION`, `SCENERY_ON_ROAD`). `name` is how people speak of
  it (default from its id).
- **Traffic:** residents drive their own cars (§5): out of their bay when there
  is a gap, along the quickest lanes, into a free bay near where they are going.
  On top of that, `traffic.cars` vehicles of **through traffic** (default about
  one per 200 m of road, at most 30) are picked from `traffic.vehicles` — object
  ids, so the built-in `car`, `van` and `truck` or your own (front toward
  +x, origin at the centre, like any object; parts coloured `lamp` are
  headlights) — and drive about at random (straight on is twice as likely). All
  keep their distance, take a junction only when it is free and there is room
  beyond it, and never stop on a level crossing.
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

## 4. Sidewalks and paths

People (§5) walk on **sidewalks** (raised pavements along roads) and
**footpaths** (paths of their own, built like roads).

```jsonc
"roads": [
  { "id": "high-street", "points": [[693, 214], [693, 376]], "sidewalks": "both" },
  { "id": "south-street", "points": [[600, 172], [800, 172]], "sidewalks": "right", "sidewalkWidth": 2.5 }
],
"paths": [
  { "id": "mill-walk", "from": { "road": "high-street", "at": "end" }, "points": [[660, 400], [560, 445], [445, 470]] },
  { "id": "field-path", "from": { "path": "mill-walk", "at": "end" }, "points": [[452, 380], [450, 240], [460, 6]] },
  { "id": "pier", "width": 2.5, "surface": "paved", "from": { "road": "harbour-front", "at": 105 }, "points": [[205, 316]] },
  { "id": "station-path", "from": { "road": "high-street", "at": 40 }, "points": [[660, 214]], "to": { "station": "lindenau" } }
]
```

- **Sidewalks:** a road's `sidewalks` adds raised (0.15 m) pavements of
  `sidewalkWidth` on its `left`, `right` (of increasing s) or `both` sides. They
  follow the kerb, turning square round the corners of its junctions (inside and
  outside), and at junctions of three
  roads or more people cross each leg a car's length behind where the cars wait
  (unmarked: they wait for a gap in the traffic). A sidewalk is part of the road's
  footprint: houses go about 10 m from a 6 m road's centre, lamps about 4.5 m.
  Sidewalks run the whole length of a road, so a country road that passes through
  a town is best split into three roads joined end to end (see `valley-loop`).
- **Paths** work like roads: `points` with rounded corners (`minRadius` 3), `width`
  (default 2 m), `surface` gravel or paved, heights that follow the ground within
  `maxGrade` (default 12%), bridges and tunnels, terrain shaping. `from`/`to`
  start or end a path on another path (`{ "path": id, "at": s }`, a T-junction)
  or at a road's edge (`{ "road": id, "at": s }`), joining that road's sidewalk
  on the side the path leaves from. A path end that simply lies on a road joins
  it the same way, and paths that cross each other at about the same height meet
  at a junction. `{ "station": id }` ends a path on that station's platform,
  beside the station building (people walk on to the platform there). A path's
  `name` is used for addresses and for the places people stroll to along it.
- **Zebra crossings:** where a path crosses a road at about the same height
  there is a zebra crossing; cars stop for anyone on it or waiting at the kerb.
  Keep zebras away from road junctions (beyond the sidewalk corners, or 15 m
  without sidewalks) and 8 m from a level crossing's zone.
- **Foot crossings:** a path that crosses a track within 2 m of its height gets
  a foot crossing with lights and a barrier; it closes for trains exactly like a
  level crossing and follows the same rules (plain ground, off platforms, 35 m
  from railway junctions, 30° or more). Farther apart in height (6.5 m) the path
  goes over or under the line; in between is a `PATH_CONFLICT` — add a waypoint `z`.
  People on sidewalks wait at level crossings too.
- **Piers:** a path over the sea stands on piles — a pier with a deck and railings.
- **Walking:** people keep to the right of a walkway at their own pace, wait at
  the kerb of a zebra until the cars have stopped, wait for a gap at unmarked
  crossings, and wait at level and foot crossings while the lights flash.
- **Scenery and walkways:** placed objects must not stand on a path or sidewalk
  (`SCENERY_ON_PATH`), except small things under 1.2 m across such as lamp posts.
  Scattered items keep 1.5 m and more away. Benches go beside a path, not on it.

## 5. Buildings, people and their errands

Every placed object whose definition has a `building` block is a **building**:
somewhere people live (`accommodation`), work (`workplace`) or go to visit
(`landmark`: a church, a shop, an inn). The residents are generated from the
homes — each has a name, a home, usually a job and perhaps a car — and run
errands: go to work, go home, visit a shop or a friend, stroll along a footpath.
For each they take the quickest way by their own lights: on foot, in their own
car, by train, by bus (§6), or a mix (driving to the station and taking the
train is common) — and some errands take them off the board (§7). At the destination they go inside for a while, then think of the next
thing to do and come out again.

```jsonc
"scenery": [
  { "object": "shop", "at": [625, 314], "rotation": 270, "name": "Lindenau Bakery",
    "building": { "kind": "Bakery", "titles": ["Baker", "Shop assistant"] } },
  { "object": "church", "at": [693, 410], "rotation": 270, "name": "St. Michael's Church" },
  { "object": "windmill", "at": [430, 470], "rotation": 300, "name": "Lindenau Windmill",
    "building": { "functions": ["landmark", "workplace"], "jobs": 2, "titles": ["Miller", "Apprentice miller"], "door": [4.6, 0] } }
],
"people": { "cars": 0.3 }
```

- **Buildings:** built-in buildings come with their uses (table in §9): a house is
  a home for 3, a terrace for 7, flats for 20; the church, barn (a farm), station
  building, shop, office block and inn have jobs. A placement's `building`
  overrides any of `functions`, `residents`, `jobs`, `titles` (the first job gets
  the first title, the last title fills the rest), `kind` (what sort of place it
  is, shown with its name) and `door` ([x, y] in the object frame; default the
  middle of its front). A custom object becomes a building with a `building`
  block in its definition (§10). Scattered objects are buildings too, if their
  object is.
- **Names and addresses:** `name` names a placed building. Otherwise it gets an
  address on the nearest street within 60 m — numbered along the street, odd on
  its left and even on its right (of increasing s): `"14 Market Street"`. A
  road's (or path's) `name` is its street name, by default its id in title case
  (`market-street` → "Market Street"). Station buildings are named after their
  station, car parks by their `name`.
- **Doors:** people go in and out at the door, which must reach a sidewalk or
  path within 45 m in a straight line that crosses no road or track and climbs at
  most 4.5 m (so turn doors toward the street). A door that reaches only a parking
  bay (within 40 m) makes the building reachable by car alone; one that reaches
  neither gets `BUILDING_UNREACHABLE` and nobody lives, works or visits there.
- **People:** `people.count` (default: as many as the reachable homes hold, at
  most 600; more than they hold is a `CAPACITY` warning) live in the homes,
  households sharing a surname. About 72% have a job, where there are posts.
  A share `people.cars` (default 0.45) own a car, one of `people.vehicles`, kept in
  the nearest free bay within 150 m of home — so give the streets where people
  live some parking.
- **Errands:** someone with nothing to do thinks of a task every half minute or
  so — work (4–12 min), home (3–10 min), a visit (1–4 min) or a stroll to a place
  on a footpath (½–1½ min) — and plans the quickest journey by their own tastes
  (some mind walking more than others). They drive only from where their car is
  parked, to a free bay near the destination (it is reserved for them), so a car
  left at the station is collected on the way back. They take a train from a
  station they can walk to, on any passenger service calling at both stations,
  boarding the first one heading their way.
- **Stations:** people reach a platform at the end of a path ending at the
  station (`"to": { "station": id }`), through the station building's door, or
  from the nearest walkway within 45 m of a platform's back edge; platforms on
  `both` sides can be entered from either (by the station's underpass). A station
  that trains stop at but no walkway reaches gets `STATION_UNREACHABLE`. People
  wait on the platform and every train keeps a list of who is aboard.
- **Click to inspect:** in the viewer, click a person, building, car, bus, train,
  bus stop or goods yard to see who they are and what they are doing: a person's home, job,
  car, current errand and journey; who lives, works and is inside a building;
  whose car it is and where it is going; a bus's line, next stops and passengers;
  a train's passengers and where each is going; the lines calling at a stop, when
  the next bus is due and who is waiting. Names in the panel can be clicked in
  turn; Esc closes it. The same descriptions are in `describePerson`,
  `describeBuilding`, `describeVehicle`, `describeTrain`, `describeBusStop` and
  `describeYard` (`src/sim/describe.ts`). For freight, see §8.

## 6. Buses

Buses are trains for the roads: a **bus stop** stands beside a road, and a
**bus line** calls at a list of stops in order, there and back (`shuttle`, the
default) or round and round (`loop`). The buses drive in the traffic like any
car, taking the quickest way along the roads from stop to stop, and stop in
their lane at each stop (the traffic behind waits) while people get off and on.
People plan bus legs like train legs: they walk to the stop, wait, board the
first bus of a line that calls at their destination stop, and get off there.

```jsonc
"busStops": [
  { "id": "westfeld", "road": "country-west", "at": 316, "side": "right" },
  { "id": "market-square", "road": "market-street", "at": 70 },
  { "id": "lindenau-station", "name": "Lindenau Station", "road": "station-street", "at": 100 }
],
"busLines": [
  { "id": "line-2", "name": "2", "stops": ["westfeld", "market-square", "lindenau-station"], "count": 2 }
]
```

- **Stops:** `at` is the s of the stop's sign along `road`; the bus stops with its
  front door beside it (its front 2 m past the sign, its body behind). `side`
  (left/right of increasing s, default `both`) says which sides have a stop.
  Buses drive on the right and call at the stop on their right-hand side: the
  right side serves buses going toward increasing s, the left side buses coming
  back. People wait on the sidewalk by the sign (or just off the road where there
  is none), so each side needs a sidewalk or path within 45 m that it can reach
  without crossing the road — else `BUS_STOP_UNREACHABLE`. A stop has a yellow
  box painted in the lane, a sign at the kerb and (`shelter`, default true) a
  shelter behind the kerb, left out where a building or tree already stands.
  Parked cars keep clear of the box. Ids share the one namespace with roads,
  paths and stations, so name a stop `"market-square"` rather than after its
  street; its `name` (default from the id) is what people and the panel see.
- **Where stops may go:** a waiting bus must not block anything, so the bus's
  whole length (11 m for the built-in `bus`) plus a margin must lie between a
  road's junctions (3 m clear of a junction's area), 6 m clear of a level
  crossing's zone, 3 m clear of a zebra or pedestrian crossing, short of a dead
  end's turning space, out of tunnels, and clear of another stop on the same side.
  `BUS_STOP_POSITION` says what is in the way and suggests an `at` that works.
- **Lines:** list at least two stops. A `shuttle` runs to the last stop and back
  the same way, calling at each stop in between again on the way back (on its
  other side where it has both); a `loop` returns from the last stop to the
  first. Between stops the buses take the quickest roads, turning round at dead
  ends or off the board's edge (where a road leads off it) when they must, so
  the order of the stops matters: list them in the order a bus passes them. A
  stop with one side is called at once, by the buses passing it on that side. If
  no road leads from one stop to the next (on a side buses can serve), the line
  gets `BUS_ROUTE`. `describe()` lists each line's calls (with the side of a
  two-sided stop) and how long a round takes.
- **Buses:** `count` buses (default 1) spread evenly along the line, in its
  `color` (default one per line) and drawn as `vehicle` (default `bus`). Each
  waits `dwell` s (default 12) at every stop, longer while people get on and
  off; a bus that has caught up with the one ahead waits a little longer, so
  they stay apart. A bus takes `capacity` passengers (default 40); the rest
  wait for the next. A line whose round holds fewer buses than `count` (about
  one per 70 m) gets a `CAPACITY` warning.
- **Off the board:** a line may call at an off-layout place reached by a road
  that leaves the board (§7): its buses drive off the edge, call there out of
  sight and come back on (by the same road, or another that leads there). A line
  needs at least one stop on the board.
- **Riding:** buses do best where walking is slow: between towns or out to
  hamlets, along roads without sidewalks, to places by the road like a farm or a
  beach path. People combine buses with walking, trains and their cars. Through
  traffic (`traffic.vehicles`) no longer includes buses; list `"bus"` there only
  for buses that never stop.

## 7. Off the board

The board is a piece of a bigger world. A track, road or footpath **line** whose
first or last waypoint lies on the board's edge (x = 0 or the width, y = 0 or the
height), and that does not join another line there, **leaves the board** at that
end — an *exit*. `offLayout` names the places out there and how far beyond the
edge each lies along each way:

```jsonc
"offLayout": [
  { "id": "neustadt", "via": [{ "road": "country-east", "distance": 3000 }], "jobs": 40,
    "titles": ["Office worker", "Shop assistant", "Nurse"], "visits": 2 },
  { "id": "hochdorf", "via": [{ "track": "hill", "distance": 2200 }, { "road": "bergdorf-lane", "distance": 1800 }] },
  { "id": "muehlbach", "name": "Mühlbach", "via": [{ "path": "field-path", "distance": 1200 }], "visits": 0.6 }
]
```

- **Exits:** cross the edge squarely (at least 45°, else `EXIT_POSITION`). Near an
  exit a line may run right up to the edge (the bounds checks let it); a line
  that ends a few metres short of the edge is neither in bounds nor an exit
  (`OUT_OF_BOUNDS`). No buffer stop is drawn where a track leaves the board.
  `describe()` lists every exit.
- **Places:** each `via` names a line that leaves the board (and with `end`,
  which end, if both do — else `EXIT_REF`), and `distance` (m beyond the edge,
  default 2000). Places have no model; they are destinations and stops. `jobs`
  are posts for residents of the board (they commute; `titles` as for
  buildings), and `visits` how often people go there on a visit (1 is about one
  landmark on the board).
- **Trains:** a service's `stops` may list off-layout places reached by a track
  at an end of its route that leaves the board. A **shuttle** whose route ends on
  a track that leaves the board runs off that end instead of turning at its last
  platform: out of sight it runs out past its stops beyond the edge (nearest
  first), turns at the farthest (400 m out if there are none), calls at them again
  coming back, and comes back on where it left, the other way round. A **loop**
  that cannot close on the board but whose first track comes in over the edge and
  last leaves it runs **through**: off at the end, round to the start (calling at
  its off-layout stops in the order they lie: those beyond the end first, nearest
  first, then those beyond the start, farthest first; 1500 m off the board if none)
  and back on at the start. Trains travel at 80% of their top speed out there,
  hold no blocks while away, and come back on only when the first stretch is free
  (at a speed they can stop from); level crossings near the edge close for a
  train about to come back. Their cars vanish one by one at the edge and appear
  the same way.
- **Buses:** see §6; buses off the board are out of sight but keep their place
  in the line, so the next one is still due on time.
- **Cars:** residents drive off the board along roads that leave it (to an
  off-layout place, where the car stays parked until they drive it back) and
  through traffic drives off and back.
- **People:** errands may lead to an off-layout place: work there (for those
  with a job there), or a visit. People go by train, bus, car or on foot (along
  a path, or a road's sidewalk, that leaves the board, walking the distance out
  of sight) — whatever is quickest — stay there out of sight for the errand's
  length, and come back later the same way or another (a car left out there is
  fetched on a later trip there). The inspect panel says where they are ("at
  work in Neustadt (off the board)", "waiting in Neustadt for a train to
  Lindenau"), and `simulate` counts those off the board.

## 8. Freight and deliveries

Goods move about the board. Buildings and off-layout places **send out** goods
(`supplies`) and **need** goods delivered (`demands`), each a map of goods ids to
loads per hour. Delivery vans and lorries carry them by road; freight trains carry
them between **goods yards** and off-layout places, where lorries take over.

```jsonc
"stations": [
  { "id": "lindenau-goods", "name": "Lindenau Goods Yard", "kind": "freight", "track": "goods-line",
    "at": 149, "length": 100, "side": "right", "road": "goods-road" }
],
"services": [
  { "id": "goods", "train": "freight-4", "route": ["goods-line"], "mode": "shuttle", "stops": ["lindenau-goods", "kreisstadt"] }
],
"offLayout": [
  { "id": "kreisstadt", "via": [{ "track": "goods-line", "distance": 3000 }], "visits": 0,
    "supplies": { "goods": 20, "mail": 40 }, "demands": { "food": 6 } }
],
"scenery": [
  { "object": "shop", "at": [751, 286], "rotation": 90, "name": "Lindenau Post Office",
    "building": { "kind": "Post office", "supplies": { "mail": 12 }, "demands": { "goods": 1 } } }
],
"freight": { "vehicles": [
  { "name": "Post van", "object": "van", "count": 2, "capacity": 8, "goods": ["mail"], "color": "#d9a43a" },
  { "name": "Lorry", "object": "truck", "count": 2, "capacity": 16 }
] }
```

- **Goods:** any id. Built in, with a name and a crate colour: `mail`, `food`,
  `goods`, `drinks`, `materials`, `timber`, `coal`, `fuel`, `fish`. The built-in
  buildings send and need some by default: a farm (`barn`) sends 10 food an hour;
  a shop needs 3 food, 3 goods and 1 mail; an inn 2 food, 3 drinks and ½ mail; an
  office block 3 mail and 1 goods; homes need mail (house 0.4, terrace 1, flats
  2); the `post-office` sends 12 mail, the `warehouse` 10 goods, and the `factory`
  8 goods (needing 3 materials and 2 coal). A placement's `building` overrides
  `supplies` or `demands` (`{}` turns them off), as can a custom object's.
- **Orders:** a source makes its goods into stock (at most two hours' worth). A
  consumer's need grows at its rate, and it orders about half an hour's worth at a
  time (at least one load). The order goes to a source with goods ready, picked by
  how quickly the goods can come: straight by road, or by road to a yard, by
  freight train, and by road from the yard (or straight from or to an off-layout
  place a freight train calls at). Quicker ways are likelier; a train's time
  counts for less, since it carries a lot at once. Each shipment travels as one or
  more *consignments*, leg by leg.
- **Goods yards:** a station with `"kind": "freight"`. It is a 7 m loading dock
  beside the track on `side` `"left"` or `"right"`, with its `building` (default
  `goods-shed`) standing on the dock. Lorries load and unload on the road along
  the dock's back edge: `road`, or by default the nearest one within 30 m. Nobody
  boards there. Crates on the dock show what is waiting, in the goods' colours.
  A yard with no road along its dock gets `YARD_ROAD`.
- **Freight trains:** services running a freight train (`freight-4` 74 m,
  `freight-10` 158 m) stop at yards and off-layout places. At each stop they
  unload what is for there and load what waits there for a stop ahead (8 loads a
  wagon), waiting longer while the goods are moved; their wagons show their loads.
  A shuttle on a line that leaves the board with one stop on it turns at that
  stop. Give a yard a branch or siding of its own: a freight train standing at a
  yard on a single-track main line blocks the trains that need it (harbour-town's
  yard is on a siding).
- **Delivery vehicles:** `freight.vehicles` wait off the board beyond a road that
  leaves it (or, with none, drive about like through traffic) until they get a
  job. After a job they drive about for a minute and a half in case another comes
  up, then go back out to wait. The default fleet is a few vans (6 loads) and
  lorries (16) when anything can move: at most one vehicle per 400 m of road. A job collects everything waiting at one place that fits
  (for as many destinations as that takes), then drops it off in turn, nearest
  first. At a building or yard a vehicle stops in the lane at the kerb nearest the
  door or dock while traffic behind waits. That stopping place is the building's
  *dock*: within 40 m of the door (30 m of a yard's dock), clear of junctions,
  crossings, bus stops, bridges and tunnels. For an off-layout place reached by
  road the vehicle drives off the board and back. `goods` limits a group to some
  goods (post vans); `color` paints its vehicles.
- **Warnings:** these come only once the layout itself says something about
  freight (a yard, `freight`, or `supplies` / `demands` anywhere).
  `FREIGHT_UNREACHABLE` is a building that sends goods, or needs them and is not
  just a home, but has no dock. `FREIGHT_UNMATCHED` is goods sent out but needed
  nowhere, or needed but sent from nowhere.
- **Seeing it:** click a delivery van, a freight train, a yard's dock or a
  building:
  - a van's job and load;
  - a train's goods and where each comes off;
  - what waits on a dock and which lorries are coming;
  - what a building sends out and needs, and what is on its way there.

  `simulate` prints a freight line (orders, deliveries by road and by rail, time
  from order to door), and `describe()` has a Freight section listing who sends
  and needs what.

## 9. Scenery: buildings, trees and other objects

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
  ground steeper than the object's `maxSlope`, the track corridor (6 m+, but not
  over a tunnel more than 9 m down), roads
  (3 m+ beyond the carriageway), paths and sidewalks (1.5 m+) and the footprints
  of placed objects (plus a 2 m garden). Use it for forests, orchards,
  hay bales, rocks.
- Single objects are checked: within 2 m of a track centre → `SCENERY_ON_TRACK`
  (error); reaching onto a road → `SCENERY_ON_ROAD` (error); onto a path or
  sidewalk → `SCENERY_ON_PATH` (error, small things like lamp posts excepted);
  standing inside another placed object → `SCENERY_OVERLAP` (warning). Flat pieces under 0.5 m
  tall (`paving`) may overlap other objects.
- Stations add their own `building` (beside the platform, facing it; its door is
  at the back, toward the town) and benches (`bench`); a freight yard's shed
  stands on its dock.
- **Buildings:** `name` and `building` (§5) apply to single objects.

### Built-in objects

| id | what | footprint (x × y m) |
|---|---|---|
| `house` | two-storey house, door at the front, chimney (smokes sometimes); home for 3 | 7.8 × 9.8 |
| `terrace` | row of three terraced houses; homes for 7 | 8.8 × 22.8 |
| `flats` | four-storey block of flats; homes for 20 | 12.4 × 16.4 |
| `church` | church with tower and spire, the tower end the front; landmark, vicar and verger | 25 × 10.8 |
| `barn` | timber barn with big doors; a farm (sends food), farmer and farmhand | 11 × 16.8 |
| `shop` | shop with a flat above, shop window and awning; landmark, shopkeeper and assistant | 9.6 × 10.6 |
| `pub` | village inn, sign by the door; landmark, landlord, cook and bar staff | 11.5 × 12.8 |
| `office` | three-storey office block; 16 jobs | 15.6 × 20.4 |
| `station-building` | used for every station unless `building` says otherwise; door at the back, 3 jobs | 9.8 × 16.8 |
| `goods-shed` | a freight yard's shed, standing on its dock, open doors toward the track; door at the back, 3 jobs | 5.8 × 18.6 |
| `post-office` | post office with a sorting office behind and a post box; sends 12 mail an hour, 3 jobs | 16.2 × 12.8 |
| `warehouse` | warehouse with three roller doors; sends 10 goods an hour, 4 jobs | 16.6 × 24.6 |
| `factory` | brick factory, sawtooth roof, tall smoking chimney; sends goods, needs materials and coal, 14 jobs | 25.8 × 30.2 |
| `bench` | platform bench | 0.6 × 1.8 |
| `lamp-post` | street lamp, lit at night | 0.6 × 0.6 |
| `fence` | 10 m of wooden fence along y | 0.2 × 10.2 |
| `paving` | 10 × 10 m paved square | 10 × 10 |
| `car` | small car (traffic, residents' cars) | 4.3 × 1.8 |
| `van` | delivery van (traffic, deliveries) | 5.1 × 2 |
| `bus` | single-deck bus, windows lit at night (bus lines) | 11.1 × 2.6 |
| `truck` | box lorry (traffic, deliveries) | 8 × 2.5 |
| `conifer` | spruce, ~10 m, snow on top in winter | 4.6 × 5.4 |
| `deciduous` | broadleaf tree, ~8 m, autumn colours, bare in winter | 5.4 × 5.4 |
| `poplar` | tall narrow poplar, ~16 m | 3.2 × 3.2 |
| `bush` | low bush | 2.2 × 2 |
| `rock` | boulder | 2.8 × 2.2 |

See them all with `npm run screenshot -- layouts/valley-loop.json --object all --out objects.png`.

## 10. Designing objects (`objects`)

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

**Buildings:** `"building": { "functions": [...], "residents", "jobs", "titles",
"kind", "door" }` makes every placement of the object a building (§5), e.g.
`{ "functions": ["workplace", "landmark"], "jobs": 2, "titles": ["Owner", "Waiter"], "kind": "Café" }`.
Put the door where the object's door is drawn.

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

## 11. Rules of thumb (avoid most errors)

1. Keep waypoints at least `2·minRadius` apart where the track turns.
2. Put junctions on straights (`at` well away from curves); turnouts on curves
   tighter than 150 m are rejected.
3. Keep parallel tracks at least 5 m apart (centre to centre).
4. Give each station straight, level track at least as long as its trains.
5. A 30 m climb needs about 860 m of track at 3.5%.
6. Keep all track at least 20 m inside the terrain edge — except where it leaves
   the board: then end it on the edge, crossing it squarely.
7. Branch first waypoints need room to curve: well outside a circle of radius
   `minRadius` touching the parent at the junction.
8. Avoid gentle bumps that leave the track 5–7 m above or below the ground over
   long distances; decide on a real bridge (cross a valley) or a real tunnel.
9. Ten trains need ten times (train length + 150 m) of route.
10. Cross tracks with roads at grade on plain, straight ground away from
    stations and junctions, as squarely as you can — or 6.5 m above or below.
11. Keep 25 m between road junctions, and between a junction or a road's end
    and a level crossing.
12. Lay out a town's streets as `roads` first (with `sidewalks`), then line them
    with houses (≈10 m from the road centre, fronts facing it) and lamps (≈4.5 m).
13. End footpaths on a road's sidewalk (`from`/`to` with `road`) rather than near
    it, and cross roads well away from junctions.
14. Give every building a sidewalk or path within reach of its door, and every
    station a path or sidewalk to its building or platform; check `describe()`'s
    Town section for anything unreachable.
15. Give the streets where people live parking (`parking`, with houses set back
    a further 2.4 m), and a car park by each station for park and ride.
16. Put bus stops in the middle of a stretch between junctions, list a line's
    stops in the order a bus passes them, and give each stop's sides a sidewalk;
    run buses where walking is slow (between towns, out to hamlets).
17. Let a country road, a branch line or a footpath run off the board to an
    `offLayout` place, and give it some jobs: commuters come and go all day.
18. For freight, put a goods yard on a branch or siding of its own with a road
    along its dock, run a freight shuttle from it to an off-layout place that
    sends and needs goods, and keep shops, farms and the like within 40 m of a
    road (doors toward it).

## 12. Validation codes

| Code | Severity | Fix |
|---|---|---|
| `SCHEMA` | error | Match `schema.json`: fix the type, add the missing field, or remove the unknown key. |
| `DUPLICATE_ID` | error | Rename one of the two; ids are shared by tracks, roads, paths, car parks, stations (and freight yards), services, bus stops, bus lines and off-layout places (objects and goods have their own namespaces). |
| `UNKNOWN_REF` | error | Use an existing id (the message lists the known ones): track, road, path, station, bus stop, off-layout place, train type or object (also in `traffic.vehicles`, `people.vehicles`, `freight.vehicles`, a bus line's `vehicle`, a freight yard's `road` and a place's `via`). |
| `TRACK_REF_CYCLE` | error | A branch can't (indirectly) be its own parent; make one track (road, path) a plain line/loop. |
| `OUT_OF_BOUNDS` | error | Move waypoints inward (track must stay 20 m inside the terrain, roads 5 m, paths 3 m), end the line exactly on the edge to let it leave the board, or move a placed object onto the board. |
| `FILLET_OVERLAP` | error | Spread the two named waypoints apart or lower `minRadius` / waypoint `radius`. |
| `CORNER_TOO_SHARP` | error | Split the hairpin with an extra waypoint so no single turn exceeds 170°. |
| `JUNCTION_UNREACHABLE` | error | Move the branch's first (or last, for `to`) waypoint further from the junction, or flip `heading`. |
| `JUNCTION_POSITION` | error | Put `at` inside the parent (not at a line end) and on a straight or a curve ≥ 150 m. Roads and paths: `at` within the parent (or `"start"`/`"end"`), and road junctions ≥ 25 m apart. |
| `GRADE_EXCEEDED` | error | Lengthen the climb, change the `z` targets, or raise `maxGrade` (message gives the length needed). Also for roads and paths. |
| `TRACK_CONFLICT` | error | Separate the tracks by ≥ 5 m in plan or ≥ 6 m in height, or join them with a junction. |
| `STATION_RANGE` | error | Move `at` so `at ± length/2` lies within the track. |
| `STATION_CURVE` | warning | Move the platform onto a straight (curves tighter than 300 m). |
| `STATION_STRUCTURE` | warning | Move the platform off the bridge/tunnel, onto level ground. |
| `ROUTE_DISCONNECTED` | error | Consecutive route tracks must share a junction facing the right way; insert the connecting track. |
| `ROUTE_NOT_CLOSED` | error | Use `mode: "shuttle"`, add tracks that lead back to the first one, or let the first track come in over the board's edge and the last leave it (a loop through the board). |
| `STOP_NOT_ON_ROUTE` | error | Add the station's track to the route or drop the stop. An off-layout stop needs a `via` on a track at an end of the route that leaves the board. |
| `TRAIN_TOO_LONG` | warning | Lengthen the platform (or a freight yard's dock) or use a shorter train. |
| `CAPACITY` | warning | Fewer trains (or buses), or a longer route. (`simulate`: also vehicles that found no room on the roads — lower `traffic.cars`. And `people.count` above what the homes hold.) |
| `ROAD_CONFLICT` | error | A road crosses a track (or road) 3–6.5 m (5.5 m) apart in height, runs too close beside a track, or overlaps another road without a junction: make it a level crossing / crossroads, clear it in height with a waypoint `z`, move it, or join the roads with `from`/`to`. |
| `LEVEL_CROSSING_POSITION` | error | Move the crossing onto plain ground, off the platform, 35 m from railway junctions and 25 m from road junctions and road ends — or take the road over or under the line. The same for a path's foot crossing (without the road rules). |
| `LEVEL_CROSSING_ANGLE` | warning / error | Cross the track at 30° or more (ideally square) so the crossing stays short; below 15° it is an error. Also for paths. |
| `PATH_CONFLICT` | error | A path crosses a track, road or path at an awkward height difference (add a waypoint `z`: at grade, or 6.5 / 5 / 3 m clear), runs beside a track or along a road too closely, overlaps another path, or crosses a road too close to a junction or level crossing: move it, cross elsewhere, or end it on the sidewalk. |
| `SCENERY_ON_TRACK` | error | A placed object comes within 2 m of a track centre: move it away (the message says how far) or turn it. |
| `SCENERY_ON_ROAD` | error | A placed object (or a station building) reaches onto a road: move it further from the road centre or turn it. |
| `SCENERY_ON_PATH` | error | A placed object over 1.2 m across stands on a path or sidewalk: move it beside the walkway. |
| `SCENERY_OVERLAP` | warning | Two placed objects stand inside each other: move one. |
| `PARKING_POSITION` | error | A car park has no road within 300 m, is more than 60 m from the road it joins, or overlaps a road or track: move it beside the road, clear of both. |
| `BUILDING_UNREACHABLE` | warning | Nobody can reach the building's door: run a sidewalk or path within 45 m of it (in a straight line not crossing a road or track), turn its door toward the street, or give it parking beside it. |
| `STATION_UNREACHABLE` | warning | No walkway reaches the station: end a path at it (`"to": { "station": id }`) or run a sidewalk past its building or platform. |
| `BUS_STOP_POSITION` | error | A bus waiting at the stop would reach into a junction, a crossing or a dead end's turning space, stand in a tunnel, overlap another stop on the same side, or the stop is off the road: move `at` (the message suggests where). |
| `BUS_ROUTE` | error | A bus line can't get by road from one stop to the next on a side it serves (connect the roads, give the stop both sides, or reorder the stops), lists a stop twice in a row, or is a loop ending at its first stop (leave the last one out). |
| `BUS_STOP_UNREACHABLE` | warning | Nobody can walk to that side of the stop: give the road a sidewalk on that side, run a path to it, or give the stop the other side only. |
| `BUS_STOP_UNUSED` | warning | No line calls at the stop: add it to a line's `stops` or remove it. |
| `EXIT_POSITION` | error | A line ends on the board's edge at less than 45° to it: move the waypoint before its end so it leaves the board squarely. |
| `STATION_KIND` | error | A path ends at a freight yard, which has no platform for people: end it at a passenger station, a road or another path. |
| `STOP_KIND` | warning | A passenger service stops at a freight yard, where nobody can get on or off: drop the stop, or run a freight train there. |
| `YARD_ROAD` | warning | No lorry can stop beside the yard's dock: run a road along the dock's back edge (within 30 m, with room clear of junctions, crossings and bus stops), or name the right one in `road`. |
| `FREIGHT_UNREACHABLE` | warning | A building that sends goods (or needs them and is not just a home) has no road within 40 m of its door where a lorry could stop: run a road past it or turn its door toward one. |
| `FREIGHT_UNMATCHED` | warning | Goods are sent out but needed nowhere, or needed but sent from nowhere: add a building or off-layout place with the matching `demands` or `supplies`. |
| `EXIT_REF` | error | An off-layout place's `via` names a line that does not leave the board (end its first or last waypoint on the edge), or one that leaves at both ends without `end`. |
| `DEADLOCK` | error | (`simulate` only) Trains wait on each other: add a passing loop, fewer trains, or different routes. |

Every issue has `path` (JSON path such as `tracks[1].points[2]`), a one-sentence
`message` with numbers and a suggested fix, and often `at` (map coordinates).

## 13. Authoring loop

1. Write the JSON (start from an example).
2. `npm run check -- my.json --json` → fix every error (warnings are advisory).
3. `npm run simulate -- my.json --minutes 30` → every service should stop
   regularly, no `DEADLOCK`, and `max wait` should be modest; road traffic and
   people should show nobody stuck and a longest wait under a minute or two, and
   the journeys line shows how people got about (walk, drive, train, bus and
   mixes); buses should make stops and miss none; "off the board" counts people
   out at the off-layout places; freight should show deliveries by road and by
   freight train, nothing `LOST` and few orders nothing could reach.
4. New objects: `npm run screenshot -- my.json --object <id> --out obj.png` and
   look at it from the front-right before placing it.
5. `npm run screenshot -- my.json --view top --out top.png` to verify geometry
   (straight down, north up), then `--view overview` (and `--view follow`) to
   judge the composition: is the track readable, do towns sit next to stations,
   are bridges and tunnels where you meant them, is the board too empty or busy?
   `--t 120` shows trains after two minutes; `--cam x,y,z,tx,ty,tz` takes a close-up.
6. Iterate. Use `query(world).describe()` from `src/api.ts` for a compact text
   summary (track, road and path lengths, structures, junctions, level, zebra
   and foot crossings, parking, the town's buildings, homes and station
   entrances, bus stops and lines, exits and off-layout places, goods yards and
   who sends and needs what, placed objects)
   when choosing `at` values; `query(world).roadAt(x, y)` and
   `trackAt(x, y)` give the `s` of a point near a road or track.

## 14. Examples

Both examples are in `layouts/`. Their tracks and services are short; most of
each file is the scenery list, one placement per line.

### `layouts/valley-loop.json`
- Terrain: a big wooded hill (north-east, 55 m), a smaller hill (north-west) and
  a shallow valley inside an oval main line (`main`, five corners at r = 120 m).
- `hill` leaves `main` at s = 700, crosses over the main line on a 350 m viaduct,
  tunnels under the hill's shoulder, climbs to Bergdorf at z = 26 and runs on
  over a short viaduct to the north edge; the tram calls at Bergdorf and runs on
  off the board to Hochdorf.
- Roads: a country road from the west edge to the east edge, leaving the board
  at both (three roads joined end to end, so only the town stretch, `market-street`, has sidewalks), over
  both sides of the main line at level crossings and through a dip under the
  `hill` viaduct;
  Lindenau's streets as a small grid of crossroads, T-junctions and corners; a
  lane from the south street over a third level crossing just past the
  platforms; and a steep lane (`maxGrade` 0.1) up from Bergdorf to the north
  edge and off the board. Lindenau's streets have sidewalks and street parking (their houses set
  back for it), the country roads a sidewalk on the farms' side; a car park by
  the station; 10 vehicles of through traffic.
- Paths: `mill-walk` from the church square out to the windmill, `field-path`
  on from there over the country road (a zebra) and the main line (a foot
  crossing) off the south edge of the board to Mühlbach, and `chapel-path` to
  St. Anne's door.
- The town: about 420 people in Lindenau's houses, terraces and flats and
  Bergdorf's cottages; shops, an inn, a post office and a café on Market Street,
  offices behind the station, the churches, farms and the windmill as
  workplaces. Lindenau station is entered from the town side (north platform)
  and through its building from South Street.
- Lindenau: the high street runs north from the station forecourt to a church
  square, crossed by Station Street, the country road and Church Street, lined
  with houses, terraces and lamps; flats by the station, gardens with trees;
  farms to the west and east.
- Bergdorf: a village lane below the station, with church and barn, in a
  clearing of the hill forest.
- Hamlets on the country roads, Westfeld (with The Plough inn) to the west and
  Ostend (with a farm shop) to the east, and bus line 2 through them and the
  town between Altheim and Neustadt off the board: Altheim, Westfeld, Market
  Square, Lindenau Station, Ostend, Neustadt and back, three buses.
- Off the board: Altheim (west, by the country road), Neustadt (east, by the
  country road; 40 jobs), Hochdorf (north, by the tram and the Bergdorf lane) and
  Mühlbach (south, on foot by the field path). Commuters to Neustadt take the bus
  or drive; a few dozen people are out there at any time.
- Freight: a goods branch (`goods-line`) leaves the main line east of the
  station and runs off the south edge to Kreisstadt; Lindenau Goods Yard sits on
  its straight with Goods Road along its dock, and a `freight-4` shuttles between
  them. The farms send food, the post office mail; Kreisstadt (by train) and
  Neustadt (by road) send goods and mail, Altheim drinks, and both towns want food.
  Two yellow post vans, two delivery vans and two lorries carry it; `f1` is a
  freight train running round the main line for show (it calls nowhere).
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
- `coast` runs from the terminus at Westhafen past Ostkap and off the east edge,
  with a 6 m-offset passing loop; two shuttles (one per loop track) cross there,
  and run on beyond Ostkap off the board to Neuhafen and back.
- Westhafen: a waterfront road (kept 1 m above the sea) with sidewalks, lamps and
  a row of houses facing the sea, joined round the end of the line to streets
  inland up to a church; a `pier` (a path running out over the sea, so it stands
  on piles) and moored `fishing-boat`s placed at `z: 0`.
- An inland road climbs over the hills past a hamlet to Ostkap's streets; a
  lane leaves it over a level crossing west of Ostkap station and runs along the
  shore to the `lighthouse`. 8 vehicles of through traffic. A `beach-path`
  leaves the inland road and crosses the line at a foot crossing (a waypoint `z`
  brings it up to the rails); a `farm-track` and a `lighthouse-path`.
- The towns: about 260 people; an inn, a fishmonger, a chandler, a bakery and
  stores in Westhafen, stores and the Lighthouse Inn in Ostkap, a harbour office,
  the church, the farm and the lighthouse; street parking in Westhafen, a car
  park there and one by Ostkap station — people drive to Ostkap, park, and take
  the train to Westhafen, and back.
- Bus line 1, the coast line: three buses from Harbour Front through Westhafen
  and over the inland road (calling at the farm and the beach path, where short
  paths with zebras reach both sides of the road) to Ostkap and the lighthouse,
  and on along Ostkap Street off the board to Neuhafen, and back — five buses.
  It is the busiest way between the towns after walking.
- Off the board: Neuhafen (east, by the coast line and Ostkap Street; 30 jobs).
- Freight: Harbour Goods Yard on a siding beside the coast line west of Ostkap,
  with Yard Lane down to it from the inland road; a `freight-4` shuttles between
  the yard and Neuhafen. The fishmonger sends fish to Neuhafen, the farm food; Neuhafen sends
  goods, mail, drinks and food — by train to the yard or by lorry along Ostkap
  Street. The default fleet: three vans and a lorry.
- Custom objects: `lighthouse` (stacked red and white cylinders using `grid`
  steps, a glowing `lamp` lantern) and `fishing-boat` (an upside-down tapered
  box as the hull, a cabin, a mast; tinted per boat).
