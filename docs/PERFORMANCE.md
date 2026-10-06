# Performance

How the renderer was profiled on the densest layout, `spreeviertel` (2 × 1.5 km of
city, 4,800 scenery objects, 1,500 people), what each part of a frame costs, what
changed for everyone, and the graphics settings that trade looks for frame rate.

## Method

`npm run bench -- layouts/spreeviertel.json` renders a layout once per graphics preset
in headless Chromium and prints the median time per frame, draw calls and
triangles (shadow pass included). The WebGL there is SwiftShader, a software
rasteriser: everything a graphics chip would do runs on the CPU, so it stands in
for a very weak one. It exaggerates some costs (multisampling above all) and its
timings vary by about ±30% between runs, so triangles and draw calls, which do not
depend on the hardware, matter as much as the milliseconds. `--cam` takes a
close-up, `--t` a time of day (Spreeviertel's day starts at 16:00; windows begin to
glow from about 17:00).

On the CPU side, the simulation step (30 a second) takes about 2.6 ms on
Spreeviertel and the per-frame snapshot and scene update under 1 ms together, so the
frame rate on weak hardware is decided by the graphics work.

## Where a frame went

Before this work, Spreeviertel's overview drew **336 draw calls and 2.61 million
triangles** a frame (1280×720, SwiftShader: about 3.1 s a frame).

| Part | Triangles | Note |
|---|---|---|
| Sidewalks and paths | 518k | six triangles for every 1 m sample, even on dead-straight streets |
| Scenery | 509k | of which ~180k windows (glowing parts) |
| Shadow pass | 547k | structures and scenery again, into the shadow map |
| Terrain | 246k | one mesh, never culled; does not cast shadows |
| Roads | 210k | a cross-section every 2 m |
| Sleepers | ~190k | 32,000 instances of a 10-triangle box |
| Bridges, portals, platforms | 160k | sections every 2 m |
| Track | 112k | sections every 2 m |

Turning things off one at a time (SwiftShader, overview): multisampled
antialiasing roughly doubled the frame time; shadows took about a third of it;
halving the resolution saved only 5–20%, because software rendering is held up by
geometry rather than pixels. A real integrated chip is more balanced:
geometry still dominates at this triangle count, and the number of pixels matters
more on a high-density screen.

## Changes for everyone (same picture)

- **Straight stretches drawn as straight** (`scene/simplify.ts`). Roads, sidewalks,
  paths, track, bridge decks and platforms are still sampled every 1–2 m, but a
  sample is dropped when the line through its neighbours passes within 3 cm of it
  (sideways and in height), with stretches up to 60 m. Sidewalks went from 518k to
  39k triangles, roads 210k → 37k, track 112k → 18k, structures 160k → 44k; the
  scene builds in half the time (4.1 → 2.0 s). Screenshots differ in 0.2–0.3% of
  pixels, by a shade.
- **One draw call per object body** (`sceneryMesh.ts`). An object's own-coloured
  and per-placement-tinted parts share one instanced mesh; a per-vertex `tintMask`
  tells the shader which vertices take the instance colour. Draw calls 336 → 228.
- **Ground in tiles** (`terrainMesh.ts`). The terrain is cut into tiles of about
  500 m, so a close-up or a ride along a train skips those off screen.

## The graphics settings

The **Graphics** button (or `G`) opens a panel with a preset (Auto, Low, Medium,
High) and six settings; see the README for what each does. Their effect, measured
one at a time from High on the overview:

| Change from High | Frame time | Why |
|---|---|---|
| Smooth edges off | −40% | no multisampling |
| Shadows off | −29% | no shadow pass, no shadow lookups |
| Shadows static | most frames without a shadow pass | moving things cast none; buildings' shadows redrawn every ¾° of sun |
| Small things: mid | −31% | lamp posts, benches, bushes, sleepers, people and (by day) windows under 1.5 px left out |
| Resolution 50% | −21% | a quarter of the pixels |
| Shadow detail low | −9% | 1024² map |

## Results

SwiftShader at 1280×720 by day (`npm run bench`), before this work and at each
preset now. Milliseconds per frame (lower is better; a real graphics chip is many
times faster, but in much the same proportions), draw calls and triangles:

| Layout, view | Before | High | Medium | Low |
|---|---|---|---|---|
| Spreeviertel, overview | 3161 ms · 336 · 2613k | 2023 ms · 226 · 1576k | 1221 ms · 117 · 768k | 356 ms · 115 · 760k |
| Spreeviertel, close-up | 1845 ms · 259 · 2579k | 1326 ms · 171 · 1422k | 806 ms · 94 · 806k | 239 ms · 87 · 674k |
| valley-loop, overview | 936 ms · 131 · 543k | 784 ms · 99 · 450k | 530 ms · 51 · 293k | 152 ms · 49 · 292k |
| harbour-town, overview | 844 ms · 120 · 469k | 735 ms · 90 · 408k | 566 ms · 46 · 298k | 176 ms · 46 · 298k |

High looks as before and is 1.6× faster on Spreeviertel's overview; Medium 2.6×,
Low 8.9×. Watched live in the same browser (frames actually shown per second, the
camera turning slowly), Spreeviertel ran at 0.2 fps before, and now 0.3 at High,
0.5 at Medium and 2.7 at Low: software rendering is that slow, but the proportions
carry over to a graphics chip. The close-up is Kottbusser Tor from 150 m (`--cam 1330,230,120,1460,420,0`).
By night Medium and Low draw more, since lit windows are never left out.

## Ideas not done

- Cull whole buildings outside the view in close-ups (needs a margin for the
  shadows they cast into it).
- Simpler far versions of buildings (one box per row of houses).
- Run the simulation in a Web Worker, so a slow CPU at 4× speed doesn't stutter.
- FXAA as a cheaper alternative to multisampling.
