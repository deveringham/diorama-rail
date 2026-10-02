# Diorama Rail

A model railway to watch in the browser: low-poly terrain, track, stations, towns
and forests on a diorama block, with trains running on their own. A layout is one
JSON file; everything visible is derived from it plus a seed. Layouts can be
validated, simulated and screenshotted from the command line, so an LLM (or you)
can write and repair them in a loop.

![](docs/valley-loop.png)

## Quick start

```sh
npm install
npm run dev                      # http://localhost:5173/?layout=valley-loop
```

Open `?layout=harbour-town` for the second example. Edit a file in `layouts/`
while `npm run dev` is running and the page rebuilds the world in place (camera
kept). Layout errors appear in a red panel.

URL parameters: `layout=<name>` (file in `layouts/`), `seed=N` (override the
seed), `t=SECONDS` (pre-run the simulation), `view=overview|top|follow`, `shot=1`
(screenshot mode), `cam=x,y,z,tx,ty,tz` (eye and target in model metres).

### Controls

| Key | Action |
|---|---|
| mouse | orbit (drag), zoom (wheel), pan (right-drag) |
| `Space` | pause / resume |
| `1` `2` `3` | time scale 1×, 2×, 4× |
| `F` | follow the next train; `Esc` stops following |
| `S` | shadows on/off |
| `H` | HUD (time, fps, draw calls, triangles, followed train) |
| `R` | auto-rotate on/off |

In the browser console, `dr` holds the API plus `world`, `sim`, `scene` and
`renderer`, e.g. `dr.query(dr.world).describe()`.

## Command line

```sh
npm run check -- layouts/valley-loop.json [--json]          # validate; exit 1 on errors
npm run simulate -- layouts/valley-loop.json --minutes 30   # per-service stops, speed, waits; exit 1 on deadlock
npm run screenshot -- layouts/valley-loop.json --out shot.png --t 120 --view top --size 1600x1000
npm run schema                                              # writes docs/schema.json
npm test                                                    # vitest: geometry, validation, sim invariants
npm run typecheck
```

`screenshot` builds the app, serves it with `vite preview` on a free port (or
uses `--url http://localhost:5173` to reuse a running dev server), renders in
headless Chromium with SwiftShader WebGL and prints draw calls and triangles.
Layout files outside `layouts/` work too.

Writing layouts: read [docs/LAYOUT_GUIDE.md](docs/LAYOUT_GUIDE.md) — coordinates,
rules of thumb, every validation code with a fix, and the authoring loop.

## How it fits together

```
layout.json ─► model/  parse (zod) → refs → track geometry (fillets, junctions) → heights,
                 │     bridges/tunnels → terrain shaping → conflicts, stations, routes → scenery
                 ├───► sim/    blocks, per-service plans, trains, fixed 1/30 s step, deadlock check
                 └───► scene/  three.js meshes built once; trains, people, smoke, light updated per frame
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

**A new building variant** —
1. `src/model/catalog.ts`: add the name to `HOUSE_VARIANTS` and its footprint
   radius and triangle estimate to `HOUSE_INFO`.
2. `src/scene/palette.ts`: add its roof colour to `PALETTE.roofs`.
3. `src/scene/sceneryMesh.ts`: add a `case` to `houseGeometry()` building walls
   (white, tinted per house), roof and windows with `GeoBuilder`.
4. `src/model/scenery.ts`: add it to a town `wish` list in `placeScenery()`.

**A new validation rule** —
1. `src/model/validate.ts`: write `checkSomething(...)` returning `Issue[]` built
   with `error(code, message, path, at?)` or `warning(...)`.
2. `src/model/build.ts`: call it where its inputs exist, e.g.
   `issues.push(...checkSomething(layout, tracks));`.
3. Add the code to `docs/LAYOUT_GUIDE.md` §4 and a failing fixture to
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
services and two towns.

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
  in about 30 draw calls and ~400k triangles (shadow pass included).
- Turnouts are drawn as overlapping track; no signals, sound or timetables.
