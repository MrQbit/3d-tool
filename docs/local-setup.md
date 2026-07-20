# Fully local setup — no external providers

Run the entire loop (generate → render → critique → iterate) on your own
hardware. Three pieces, each independently optional:

| Piece | Replaces | Software | Needs |
| --- | --- | --- | --- |
| 3D engine | Meshy/Tripo | **Hunyuan3D-2.1** (Tencent, open weights) | NVIDIA GPU, ~10–16 GB VRAM |
| Concept image (text→3D only) | — | any **AUTOMATIC1111-compatible** SD server (WebUI/Forge) | shares/uses the same GPU |
| Vision critic | OpenRouter | **Ollama** + a vision model (e.g. `qwen2.5vl`) | CPU-ok, GPU faster |

Mix freely: e.g. local Hunyuan3D + hosted critic, or hosted Meshy + local
critic. Whatever env vars are set decide the routing.

## Hardware reality check

- **NVIDIA + Linux/WSL2 is the happy path.** 12 GB VRAM works; 16–24 GB is
  comfortable. Mac/MPS support for these models is still poor.
- Generation takes ~1–5 minutes per model on a 4090-class card (vs ~1–3 min
  hosted). Texture quality is close to, but still slightly behind, hosted
  Meshy/Tripo.

## 1. Hunyuan3D-2.1 (the 3D engine)

```bash
git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1
cd Hunyuan3D-2.1
pip install -r requirements.txt          # PyTorch w/ CUDA first, per their README
python api_server.py --host 127.0.0.1 --port 8081
```

First run downloads the weights from Hugging Face. Verify:
`curl http://127.0.0.1:8081/health`.

The server accepts an image (base64) and returns a textured GLB —
`POST /send` → `{uid}`, `GET /status/{uid}` → `{status, model_base64}`.
three-gen handles all of that; you just point at it:

```bash
export LOCAL_3D_BASE_URL=http://127.0.0.1:8081
```

With that set, `local` becomes the default engine (or pass
`--engine local` / `"engine": "local"` explicitly).

> Alternative engines that fit the same slot: **TRELLIS** (Microsoft, MIT)
> and **Stable Fast 3D** — both would need a thin API wrapper matching the
> send/status shape above, or their own adapter in `lib/engines.mjs`
> (contributions welcome; the adapter interface is 4 functions).

## 2. Text→3D: a local concept-image server

Hunyuan3D's server is **image-input only**, so text→3D needs a local
text-to-image step first. Any AUTOMATIC1111-compatible API works
(SD WebUI, Forge):

```bash
# in your stable-diffusion-webui checkout
./webui.sh --api --port 7860
export LOCAL_T2I_BASE_URL=http://127.0.0.1:7860
```

three-gen prompts it for a "single object, 3/4 view, neutral background"
concept shot and feeds that to Hunyuan3D. If you skip this piece, use
`image_to_3d` with your own reference image — everything else works the same.

Optional: `LOCAL_T2I_STEPS` (default 28).

## 3. The critic: Ollama + a vision model

```bash
ollama pull qwen2.5vl        # or llama3.2-vision, etc.
export CRITIC_BASE_URL=http://127.0.0.1:11434/v1
export THREE3D_CRITIC_MODEL=qwen2.5vl
# CRITIC_API_KEY not needed for Ollama
```

Any OpenAI-compatible `/chat/completions` endpoint with vision works
(LM Studio, vLLM, llama.cpp server…). Honest note: a 7B local vision model
is a noticeably less rigorous judge than hosted frontier models — it will
catch missing parts and gross geometry errors, but grades texture quality
generously. Use a bigger local model (or the hosted critic) for final passes.

## Run it

```bash
node cli.mjs generate "a classic Staunton king chess piece, ivory white" --engine local
```

or via MCP with the same env vars passed through `claude mcp add -e ...`.

Outputs land in `./3d-out/round-N/` exactly as with hosted engines; the
intermediate GLBs written by the local engine live in `./3d-out/local-tasks/`
(override with `LOCAL_3D_OUT`).

## Env reference (local pieces)

| Var | Meaning | Default |
| --- | --- | --- |
| `LOCAL_3D_BASE_URL` | Hunyuan3D api_server base URL; setting it makes `local` the default engine | `http://127.0.0.1:8081` (when engine=local) |
| `LOCAL_T2I_BASE_URL` | A1111-compatible txt2img server (needed for local text→3D) | unset |
| `LOCAL_T2I_STEPS` | txt2img sampling steps | 28 |
| `LOCAL_3D_OUT` | where local task GLBs are written | `./3d-out/local-tasks` |
| `CRITIC_BASE_URL` | OpenAI-compatible critic endpoint (e.g. Ollama `/v1`) | OpenRouter |
| `CRITIC_API_KEY` | key for that endpoint, if it wants one | `local` |
| `THREE3D_CRITIC_MODEL` | critic model name (required with `CRITIC_BASE_URL`) | `google/gemini-2.5-flash` (hosted) |

The wiring is covered by the keyless smoke test (`npm run smoke`), which
runs the full local pipeline against mock servers — so a broken local setup
is a server/env problem, not a three-gen problem.
