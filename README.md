# Diorama Rail

A model railway to watch in the browser: low-poly terrain, track, stations,
roads, buildings and trees on a diorama block, with trains running on their own
and cars, vans, buses and lorries driving the roads, waiting at level crossings
while the trains go by. A layout is one JSON file; everything visible is derived
from it plus a seed — including its scenery objects, which are themselves small
JSON models built from primitives. Layouts and objects can be validated, simulated and screenshotted
from the command line, so an LLM (or you) can write and repair them in a loop.

![](docs/valley-loop.png)

## Quick start

```sh
npm install
npm run dev                      # http://localhost:5173/?layout=valley-loop
```

Open `?layout=harbour-town` for the second example (an unknown name lists the
available layouts and suggests the closest one). Edit a file in `layouts/` while
`npm run dev` is running and the page rebuilds the world in place (camera kept).
Layout errors appear in a red panel.

URL parameters: `layout=<name>` (file in `layouts/`), `seed=N` (override the
seed), `t=SECONDS` (pre-run the simulation), `view=overview|top|follow`, `shot=1`
(screenshot mode), `cam=x,y,z,tx,ty,tz` (eye and target in model metres),
`object=<id>[,<id>…]` or `object=*` (preview scenery objects alone, with
`season=summer|autumn|winter`).

### Controls

The HUD in the bottom-left corner shows the layout, simulated time, fps, draw
calls and triangles, and this list of controls with the current state of each.

| Key | Action |
|---|---|
| mouse | orbit (drag), zoom (wheel), pan (right-drag) |
| `Space` | pause / resume |
| `1` `2` `3` | time scale 1×, 2×, 4× |
| `F` | follow the next train; `Esc` stops following |
| `S` | shadows on/off |
| `H` | hide / show the HUD (shown by default; hidden in screenshots) |
| `R` | auto-rotate on/off |

In the browser console, `dr` holds the API plus `world`, `sim`, `scene` and
`renderer`, e.g. `dr.query(dr.world).describe()`.

## Command line

```sh
npm run check -- layouts/valley-loop.json [--json]          # validate; exit 1 on errors
npm run simulate -- layouts/valley-loop.json --minutes 30   # per-service stops, speed, waits; road traffic; exit 1 on deadlock
npm run screenshot -- layouts/valley-loop.json --out shot.png --t 120 --view top --size 1600x1000
npm run screenshot -- layouts/valley-loop.json --object windmill --out mill.png     # one object alone
npm run screenshot -- layouts/valley-loop.json --object all --season winter         # every object
npm run schema                                              # writes docs/schema.json
npm test                                                    # vitest: geometry, validation, sim invariants
npm run typecheck
```

`screenshot` builds the app, serves it with `vite preview` on a free port (or
uses `--url http://localhost:5173` to reuse a running dev server), renders in
headless Chromium with SwiftShader WebGL and prints draw calls and triangles.
Layout files outside `layouts/` work too. With `--object` it renders just those
scenery objects (built-in and the layout's own) on a small plinth, labelled.
The same preview is live in the browser at `?layout=valley-loop&object=*`.

Writing layouts: read [docs/LAYOUT_GUIDE.md](docs/LAYOUT_GUIDE.md) — coordinates,
roads and traffic, placing scenery, designing objects, rules of thumb, every
validation code with a fix, and the authoring loop.

## How it fits together

```
layout.json ─► model/  parse (zod) → refs → track geometry (fillets, junctions) → heights,
                 │     bridges/tunnels → roads (junctions, crossroads, level crossings, heights)
                 │     → terrain shaping → conflicts, stations, routes → scenery
                 ├───► sim/    blocks, per-service plans, trains, level crossings, road traffic,
                 │             fixed 1/30 s step, deadlock check
                 └───► scene/  three.js meshes built once; trains, vehicles, barriers, people,
                               smoke, light updated per frame
cli/ check | simulate | schema | screenshot        api.ts: the stable public API (also window.dr)
```

`model/` and `sim/` never import three.js or touch the DOM, so they run in Node.
Model coordinates are metres, x east, y north, z up; `scene/geo.ts` `toThree()` is
the only place they meet three.js's y-up frame.

## Extending

**A new train type** — add an entry to `TRAIN_CATALOG` in `src/model/catalog.ts`:

```ts
"intercity-4": { cars: 4, carLength: 26, carWidth: 3, carHeight: 4, maxSpeed: 40,
                 accel: 0.7, decel: 0.9, color: "#5a7fa8", shape: "multiple-unit" },
```

Use it as a service's `train`. Meshes come from `shape` (`multiple-unit`,
`loco-hauled`, `tram`, `freight`); `locoLength` sets a different first vehicle.
Run `npm run schema` so the schema description lists it.

**A new building, tree or other object** — describe it as parts in the layout's
`objects` and place it in `scenery`; no code changes:

```jsonc
"objects": { "kiosk": { "tint": ["#3d7d8c"], "parts": [
  { "shape": "box", "size": [3, 2, 2.4] },
  { "shape": "pyramid", "at": [0, 0, 2.4], "size": [3.6, 2.6, 0.8], "color": "roof" } ] } },
"scenery": [ { "object": "kiosk", "at": [700, 215], "face": "track" } ]
```

Preview it with `npm run screenshot -- my.json --object kiosk`. To make it
available to every layout, add the same entry to `src/model/objectLibrary.ts`.

**A new vehicle** — it is an object too: define it (front toward +x, origin at
its centre, `lamp`-coloured parts for headlights) and list it in the layout's
`traffic.vehicles`, e.g. `"traffic": { "vehicles": ["car", "car", "tractor"] }`.

**A new validation rule** —
1. `src/model/validate.ts`: write `checkSomething(...)` returning `Issue[]` built
   with `error(code, message, path, at?)` or `warning(...)`.
2. `src/model/build.ts`: call it where its inputs exist, e.g.
   `issues.push(...checkSomething(layout, tracks));`.
3. Add the code to `docs/LAYOUT_GUIDE.md` §7 and a failing fixture to
   `test/validate.test.ts`.

## Notes on v0.1

### Changes to the spec's `valley-loop`
The spec's layout did not validate as written, so it was adjusted minimally:

- `hill` ended at `z: 30`, which needs a 3.9% climb over its 738 m (max 3.5%,
  `GRADE_EXCEEDED`). The end height is now `z: 26`.
- With the original last waypoint `[1060, 880]` the line cut under the hill's
  shoulder all the way to its end, so the whole end — and Bergdorf — lay in the
  tunnel. The last waypoint is now `[1030, 890]` with an extra waypoint
  `[1030, 750]`: the line tunnels under the shoulder (140 m), emerges, and ends
  on a 93 m straight in the open.
- `bergdorf` moved from `at: 520` (inside the tunnel, on a curve) to `at: 722`,
  on that final straight.

The intent is kept: an oval round a valley, a branch climbing to a hill village
through a tunnel (and, as a bonus, crossing the main line on a viaduct), three
services and two towns. Bergdorf's platform is on the west (`left`) side, where
the hillside is level with the track.

### Scenery: objects instead of towns and forests
The spec's procedural `towns`, `forests` and `scatterTrees` are replaced by
explicit scenery: every building and tree is an object (a JSON model of
primitive parts), placed one by one or scattered over an area. Built-in objects
live in `src/model/objectLibrary.ts`; a layout can add or override objects in
its `objects` section. Both example layouts now lay out their towns along their
roads and define a few objects of their own (windmill, hay bale, lighthouse,
fishing boat, jetty).

### Roads and traffic

![](docs/level-crossing.png)

Roads are a network of their own, built like the track (`src/model/roads.ts`):
filleted waypoints, heights that follow the smoothed ground within `maxGrade`
(a waypoint `z` pins one point), bridges, tunnels and terrain shaping, T-junctions
and corners via `from`/`to`, crossroads wherever two roads cross at about the
same height, and level crossings wherever a road meets a track within 3 m of its
height. The sim (`src/sim/traffic.ts`) drives vehicles on two right-hand lanes:

- Cars follow the car ahead (a time gap plus a minimum distance), slow for
  curves and turns, and choose turns at random. They pass a junction one at a
  time, and only when there is room beyond it, so they never block one; nor do
  they stop on a level crossing. Dead ends near the board edge lead off the
  board; elsewhere cars turn round.
- A level crossing starts flashing when a train could arrive within about 11 s
  (a pessimistic estimate: the line's speed limits, accelerating from its
  current speed, after any remaining dwell) or is too close to brake comfortably,
  lowers its barriers once no car is on it, and opens when the tail has passed.
  Trains stop short of a crossing that is not closed — a safety net that the
  examples never need.
- Crossings close together on one road (a road over double track) work as one:
  they flash, close and open together, with barriers only outside the group.
- Limitations: no traffic lights, overtaking, parking or right of way between
  junction approaches beyond first come, first served (a car kept waiting
  because its way out is full takes another); one vehicle at a time in a
  junction.

### Interpretations and limitations
- **Fixed routes.** A service follows one path through the graph. Two shuttles
  cannot choose either side of a passing loop, so `harbour-town` uses two
  services (`east-west` on the main line, `west-east` through `passing`) instead
  of one service with `count: 2`. The passing track is drawn east→west so the
  second route starts at the opposite terminus.
- **Single-track safety.** A block is "opposed" for a train when another service
  (or another train of the same shuttle) can run through it the other way.
  Trains reserve a whole opposed stretch plus room to stand clear beyond it in
  one go, which prevents head-on deadlocks on shared single track.
- Because routes are fixed, car positions are computed by walking back along the
  route path rather than via a ring buffer of the head's history.
- Shuttle ends: the farthest stop on the route's end track (train centred on the
  platform), else the buffer stop; a loop end track without stops turns round
  half a lap from the junction.
- When a track has explicit `z` waypoints, junction heights join them as
  interpolation anchors, so branches ramp evenly instead of climbing at once.
- Terrain `features` are Gaussian bumps `height·exp(−3·(d/radius)²)` (5% left at
  `radius`).
- The terrain mesh receives but does not cast shadows (it would double its
  175k-triangle cost); trees, buildings, structures and trains cast them.
- The renderer's triangle count includes the shadow pass. Both examples render
  in about 90 draw calls and ~430k triangles (shadow pass included). Each object
  type in use costs 2–3 instanced draw calls (fixed colours, tinted parts,
  glowing windows), however many times it is placed; vehicles likewise per type.
- Turnouts are drawn as overlapping track; no signals, sound or timetables.
