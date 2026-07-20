# three-gen — reliable 3D generation for AI agents

Text prompt in → **verified, textured GLB out** — with an audit trail proving
it actually looks like what you asked for.

Exposed two ways: an **MCP tool** (Claude Code, Claude Desktop, anything
MCP-capable) and a **CLI**.

## Why not just drive Blender with the agent?

Agent-driven Blender scripting fails for structural reasons, not prompt
reasons:

- **No spatial feedback.** The LLM edits geometry it cannot see; every
  operation is a guess, and errors compound silently.
- **Destructive edits.** Imperative mesh/texture operations mutate shared
  state — one bad step (texture ops especially) breaks everything after it.
- **Wrong tool for the job.** Token-by-token coordinate math is the weakest
  way to make a mesh; dedicated generative 3D models are trained end-to-end
  for exactly this.

three-gen fixes all three:

1. **Delegate** — geometry + textures come from a dedicated generative 3D
   model ([Meshy](https://meshy.ai) or [Tripo](https://tripo3d.ai)) via API.
2. **Verify with eyes** — the GLB is rendered headlessly from four angles
   (front/right/back/top) and a vision model judges the views against the
   prompt, returning a score, concrete issues, and a **revised prompt**.
3. **Iterate non-destructively** — rejected? regenerate with the revised
   prompt; retexture re-runs from the same geometry. Every round is kept in
   its own directory; nothing is ever overwritten.

`generate_3d_verified` (MCP) / `three-gen generate` (CLI) run the whole loop
in one call:

```
prompt → generate → texture → download GLB → render 4 views
       → vision critique → accepted? done : revised prompt → repeat
```

## Setup

```bash
npm install
npx playwright install chromium   # for the headless renderer
                                  # (skip if PLAYWRIGHT_BROWSERS_PATH provides one)
```

Keys (each provider has a free tier; only what you use is required):

| Env var | Used for | Get it |
| --- | --- | --- |
| `MESHY_API_KEY` | Meshy engine | https://www.meshy.ai/settings/api |
| `TRIPO_API_KEY` | Tripo engine | https://platform.tripo3d.ai/api-keys |
| `OPENROUTER_API_KEY` | vision critic | https://openrouter.ai/keys |

**No providers at all?** There's a third engine: `local`, backed by
open-weight **Hunyuan3D-2.1** on your own NVIDIA GPU, with an Ollama vision
model as the critic — the entire loop runs on your machine with zero
external dependencies. See **[docs/local-setup.md](docs/local-setup.md)**
(`LOCAL_3D_BASE_URL`, `LOCAL_T2I_BASE_URL`, `CRITIC_BASE_URL`).

### As an MCP tool (Claude Code)

```bash
claude mcp add three-gen \
  -e MESHY_API_KEY=msy_... \
  -e OPENROUTER_API_KEY=sk-or-... \
  -- node /path/to/three-gen/server.mjs
```

Then ask the agent for a model — it should reach for `generate_3d_verified`.

### As a CLI

```bash
export MESHY_API_KEY=msy_... OPENROUTER_API_KEY=sk-or-...
node cli.mjs generate "a weathered bronze raven statuette on a hexagonal base"
# → ./3d-out/round-1/{model.glb, views/*.png}, verdict JSON on stdout
```

## Tools / commands

| MCP tool | CLI | What it does |
| --- | --- | --- |
| `generate_3d_verified` | `generate "<prompt>"` | Full closed loop, up to `max_rounds` (default 3). |
| `text_to_3d` | — | Start a text→3D task (Meshy: untextured preview first). |
| `image_to_3d` | — | Reference image (URL or file) → textured 3D task. |
| `refine_3d` | — | Texture/retexture from existing geometry — non-destructive. |
| `check_3d_task` / `wait_for_task` | `status <task_id>` | Poll / block on a task. |
| `download_model` | — | Save GLB + provider preview locally (**URLs expire in hours — always download promptly**). |
| `render_views` | `render <model.glb>` | Headless 4-angle PNG render of a local GLB. |
| `critique_render` | `critique "<prompt>" <imgs…>` | Vision verdict: `{score, acceptable, issues[], revisedPrompt}`. |

Optional env: `MESHY_AI_MODEL` (default `latest`), `TRIPO_MODEL_VERSION`,
`THREE3D_CRITIC_MODEL` (default `google/gemini-2.5-flash`),
`MESHY_API_BASE` / `TRIPO_API_BASE`, `CHROMIUM_PATH` (renderer fallback).

## Output layout (per verified run)

```
3d-out/
  round-1/
    model.glb              ← the mesh
    provider-preview.webp  ← provider's own render
    views/front.png … top-down.png
  round-2/                 ← only if round 1 was rejected
    …
```

The returned JSON includes every round's prompt, task ids, file paths, and
verdict — the full audit trail of how the final model earned acceptance.

## Smoke tests (no API keys needed)

```bash
npm run smoke      # MCP protocol handshake + renderer on a sample GLB
```

See [docs/architecture.md](docs/architecture.md) for design rationale.
