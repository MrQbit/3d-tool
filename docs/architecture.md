# three-gen — architecture

## The problem this replaces

Driving Blender with an LLM agent produces poor 3D and endless rework. That is
not a prompting problem — it's structural:

1. **No spatial feedback.** The agent emits `bpy` operations against geometry
   it cannot see. Every translate/extrude/boolean is a guess; errors compound
   silently until a render at the end reveals the mess.
2. **Destructive, order-dependent edits.** Blender's imperative model means a
   texture/UV operation mutates shared state. One wrong step poisons the
   scene — hence "texture operations are almost always a breaking change."
3. **Wrong tool.** Token-by-token coordinate math is the weakest possible way
   to produce a mesh. Dedicated generative 3D models produce watertight,
   textured, UV-mapped GLBs in minutes.

## The fix: three pillars

### 1. Delegate geometry to dedicated generative models (`lib/engines.mjs`)

The agent never sculpts. Shape and texture come from a 3D generation provider
behind one normalized adapter interface:

| Engine | Text→3D | Image→3D | Retexture |
| --- | --- | --- | --- |
| **Meshy** | two-stage: untextured *preview* → *refine* (texture) | single-stage, textured | re-run refine from the same preview geometry |
| **Tripo** | single-stage, textured (PBR) | single-stage (URL or uploaded file) | `texture_model` task against the original task's geometry |

Both are task-based REST APIs (create → poll). **Provider output URLs expire
(Tripo ~2 h)** — the pipeline downloads the GLB the moment a task succeeds.
Model versions are env-pinnable (`MESHY_AI_MODEL`, `TRIPO_MODEL_VERSION`)
because 3D model slugs drift as fast as image-model slugs.

Adding an engine = one adapter object with `textTo3D / imageTo3D / refine /
check` (e.g. Stability's synchronous image→3D endpoints would be trivial).

### 2. Closed-loop visual verification (`lib/render.mjs` + `lib/critic.mjs`)

A generation is never done because the API returned — it's done when it
**looks right from every side**:

- `render.mjs` serves a one-page `<model-viewer>` app on a loopback port,
  loads it in headless Chromium (Playwright), and captures the GLB from four
  canonical orbits (front / right / back / top). No GPU server, no Blender.
- `critic.mjs` sends those labeled views + the ORIGINAL prompt to a vision
  model (OpenRouter) with a strict art-director rubric: geometry integrity,
  proportions, texture quality, completeness, style. It must answer in a
  fixed JSON shape: `{score, acceptable, issues[{aspect, severity,
  description}], revisedPrompt}`.
- The critic always judges against the *original* prompt, even in later
  rounds — so iterative prompt rewrites can't drift away from the user's
  intent.

This is exactly the feedback channel Blender scripting lacks: the model is
*seen* before it is *accepted*.

### 3. Non-destructive, versioned iteration (`lib/pipeline.mjs`)

`generateVerified()` runs the loop: each round writes into its own
`round-N/` directory (GLB, provider preview, view PNGs, verdict). Rejected
rounds are kept — the returned audit trail shows prompt → score → revised
prompt → score across rounds, and if no round is accepted the best-scoring
one is returned as `final` with an explicit note.

Retexturing (`refine_3d`) never touches the mesh: Meshy re-refines from the
kept preview task, Tripo runs `texture_model` against the original geometry
task. "Rollback" is a no-op concept here because nothing is ever overwritten.

## Surfaces

- **`server.mjs`** — MCP stdio server (newline-delimited JSON-RPC 2.0,
  hand-rolled, zero deps). Tools: `generate_3d_verified`, `text_to_3d`,
  `image_to_3d`, `refine_3d`, `check_3d_task`, `wait_for_task`,
  `download_model`, `render_views`, `critique_render`.
- **`cli.mjs`** — same pipeline for shell use: `generate`, `render`,
  `critique`, `status`.

Dependencies are needed only for rendering (`playwright`,
`@google/model-viewer`); the pure-API tools run on Node ≥ 20 with nothing
installed.

## Future work

- **Scene assembly** — composing multiple generated assets via a declarative
  JSON scene graph (positions/lights/materials as a validated document; still
  no imperative editing). The critic loop applies unchanged.
- **Rigging/animation** — both providers expose rig/animate task types that
  slot into the same task-poll-download machinery.
- **More engines** — Stability Fast 3D / SPAR3D (synchronous image→3D),
  Hunyuan3D via fal/replicate.
- **Turntable video capture** for the critic (more views, same idea).
