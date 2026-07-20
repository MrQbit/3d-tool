/**
 * Engine adapters — dedicated generative 3D models behind one normalized
 * interface. The agent never sculpts geometry; these models do.
 *
 * Both are task-based REST APIs: create task → poll → download.
 * IMPORTANT: provider output URLs EXPIRE (Tripo ~2 hours, Meshy days) —
 * always download promptly after success.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const MESHY_API = process.env.MESHY_API_BASE || "https://api.meshy.ai";
const TRIPO_API = process.env.TRIPO_API_BASE || "https://api.tripo3d.ai/v2/openapi";

export function requireKey(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Export it or pass it via the MCP server env.`);
  return v;
}

export async function jsonFetch(url, { method = "GET", headers = {}, body, form } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(form ? {} : body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return data;
}

// ── Meshy ───────────────────────────────────────────────────────────────────
// Text→3D is two-stage: "preview" (untextured geometry) → "refine" (texture).
// Refine can be re-run from the same preview = non-destructive retexture.
// Image→3D is single-stage, textured.

export const meshy = {
  id: "meshy",
  headers: () => ({ Authorization: `Bearer ${requireKey("MESHY_API_KEY")}` }),

  async textTo3D({ prompt, style }) {
    const data = await jsonFetch(`${MESHY_API}/openapi/v2/text-to-3d`, {
      method: "POST",
      headers: this.headers(),
      body: {
        mode: "preview",
        prompt: String(prompt).slice(0, 600),
        ai_model: process.env.MESHY_AI_MODEL || "latest",
        model_type: style === "lowpoly" ? "lowpoly" : "standard",
        target_formats: ["glb"],
      },
    });
    return {
      task_id: data.result,
      engine: "meshy",
      stage: "preview",
      next: "When this task succeeds, call refine_3d with this task_id to texture it.",
    };
  },

  async imageTo3D({ image_url }) {
    const data = await jsonFetch(`${MESHY_API}/openapi/v1/image-to-3d`, {
      method: "POST",
      headers: this.headers(),
      body: {
        image_url,
        ai_model: process.env.MESHY_AI_MODEL || "latest",
        should_texture: true,
        enable_pbr: true,
      },
    });
    return { task_id: data.result, engine: "meshy", stage: "image" };
  },

  async refine({ task_id, texture_prompt }) {
    const data = await jsonFetch(`${MESHY_API}/openapi/v2/text-to-3d`, {
      method: "POST",
      headers: this.headers(),
      body: {
        mode: "refine",
        preview_task_id: task_id,
        enable_pbr: true,
        ...(texture_prompt ? { texture_prompt: String(texture_prompt).slice(0, 600) } : {}),
      },
    });
    return { task_id: data.result, engine: "meshy", stage: "refine" };
  },

  async check({ task_id }) {
    let t;
    try {
      t = await jsonFetch(`${MESHY_API}/openapi/v2/text-to-3d/${task_id}`, { headers: this.headers() });
    } catch {
      t = await jsonFetch(`${MESHY_API}/openapi/v1/image-to-3d/${task_id}`, { headers: this.headers() });
    }
    const status =
      t.status === "SUCCEEDED"
        ? "succeeded"
        : t.status === "FAILED" || t.status === "CANCELED"
          ? "failed"
          : t.status === "IN_PROGRESS"
            ? "running"
            : "pending";
    return {
      task_id,
      status,
      progress: t.progress ?? (status === "succeeded" ? 100 : 0),
      model_glb_url: t.model_urls?.glb ?? null,
      preview_image_url: t.thumbnail_url ?? null,
      error: t.task_error?.message ?? null,
      note: status === "succeeded" ? "URLs expire — download promptly." : undefined,
    };
  },
};

// ── Tripo ───────────────────────────────────────────────────────────────────
// Single-stage textured text→3D / image→3D. Retexture = a texture_model task
// pointing at the original task id (the original output is untouched).

export const tripo = {
  id: "tripo",
  headers: () => ({ Authorization: `Bearer ${requireKey("TRIPO_API_KEY")}` }),
  unwrap(data) {
    if (data?.code !== 0) throw new Error(`Tripo error code ${data?.code}: ${data?.message ?? "unknown"}`);
    return data.data;
  },

  async textTo3D({ prompt }) {
    const data = this.unwrap(
      await jsonFetch(`${TRIPO_API}/task`, {
        method: "POST",
        headers: this.headers(),
        body: {
          type: "text_to_model",
          prompt: String(prompt).slice(0, 1024),
          pbr: true,
          ...(process.env.TRIPO_MODEL_VERSION ? { model_version: process.env.TRIPO_MODEL_VERSION } : {}),
        },
      })
    );
    return { task_id: data.task_id, engine: "tripo", stage: "image" };
  },

  async imageTo3D({ image_url, image_path }) {
    let file;
    if (image_path) {
      const buf = readFileSync(image_path);
      const ext = image_path.split(".").pop().toLowerCase().replace("jpeg", "jpg");
      const form = new FormData();
      form.append("file", new Blob([buf], { type: `image/${ext === "jpg" ? "jpeg" : ext}` }), `image.${ext}`);
      const up = this.unwrap(await jsonFetch(`${TRIPO_API}/upload`, { method: "POST", headers: this.headers(), form }));
      file = { type: ext, file_token: up.image_token ?? up.file_token ?? up.token };
    } else {
      const ext = image_url.split("?")[0].split(".").pop()?.toLowerCase() ?? "png";
      file = { type: ["jpg", "jpeg", "png", "webp"].includes(ext) ? ext : "png", url: image_url };
    }
    const data = this.unwrap(
      await jsonFetch(`${TRIPO_API}/task`, {
        method: "POST",
        headers: this.headers(),
        body: {
          type: "image_to_model",
          file,
          pbr: true,
          ...(process.env.TRIPO_MODEL_VERSION ? { model_version: process.env.TRIPO_MODEL_VERSION } : {}),
        },
      })
    );
    return { task_id: data.task_id, engine: "tripo", stage: "image" };
  },

  async refine({ task_id, texture_prompt }) {
    const data = this.unwrap(
      await jsonFetch(`${TRIPO_API}/task`, {
        method: "POST",
        headers: this.headers(),
        body: {
          type: "texture_model",
          original_model_task_id: task_id,
          pbr: true,
          ...(texture_prompt ? { texture_prompt: String(texture_prompt).slice(0, 1024) } : {}),
        },
      })
    );
    return { task_id: data.task_id, engine: "tripo", stage: "refine" };
  },

  async check({ task_id }) {
    const t = this.unwrap(await jsonFetch(`${TRIPO_API}/task/${task_id}`, { headers: this.headers() }));
    const status =
      t.status === "success" ? "succeeded" : t.status === "queued" ? "pending" : t.status === "running" ? "running" : "failed";
    const out = t.output ?? {};
    return {
      task_id,
      status,
      progress: t.progress ?? (status === "succeeded" ? 100 : 0),
      model_glb_url: out.pbr_model ?? out.model ?? out.base_model ?? null,
      preview_image_url: out.rendered_image ?? null,
      error: status === "failed" ? `task ${t.status}` : null,
      note: status === "succeeded" ? "Tripo URLs expire in ~2 hours — download promptly." : undefined,
    };
  },
};

// ── Local (Hunyuan3D-2.1 api_server.py) ─────────────────────────────────────
// Fully self-hosted engine — no external provider. Run Tencent's open-weight
// Hunyuan3D-2.1 locally (`python api_server.py --port 8081`, NVIDIA GPU) and
// point LOCAL_3D_BASE_URL at it. The server is IMAGE-input only:
//   POST /send {image: <b64>, texture, type:"glb"} → {uid}
//   GET  /status/{uid} → {status: processing|completed|error, model_base64}
// Text→3D therefore goes through a local text-to-image server first
// (LOCAL_T2I_BASE_URL, any AUTOMATIC1111-compatible /sdapi/v1/txt2img).
// The finished GLB arrives as base64 (no URL); we write it to
// LOCAL_3D_OUT (default ./3d-out/local-tasks) and report model_glb_path.
// See docs/local-setup.md.

const LOCAL_OUT = () => process.env.LOCAL_3D_OUT || "./3d-out/local-tasks";

function localBase() {
  return process.env.LOCAL_3D_BASE_URL || "http://127.0.0.1:8081";
}

async function imageArgToBase64({ image_url, image_path }) {
  if (image_path) return readFileSync(image_path).toString("base64");
  if (image_url?.startsWith("data:")) {
    const m = image_url.match(/^data:image\/[a-z+]+;base64,(.+)$/i);
    if (!m) throw new Error("Unsupported data URL.");
    return m[1];
  }
  if (image_url) {
    const res = await fetch(image_url);
    if (!res.ok) throw new Error(`Could not fetch image: ${res.status}`);
    return Buffer.from(await res.arrayBuffer()).toString("base64");
  }
  throw new Error("Provide image_url or image_path.");
}

/** Generate a concept image via a local A1111-compatible txt2img server. */
async function localTxt2Img(prompt) {
  const base = process.env.LOCAL_T2I_BASE_URL;
  if (!base) {
    throw new Error(
      "Local text→3D needs a concept image first, and no LOCAL_T2I_BASE_URL is set. Either run a local AUTOMATIC1111-compatible image server (e.g. SD WebUI/Forge on :7860) and set LOCAL_T2I_BASE_URL, or use image_to_3d with your own reference image."
    );
  }
  const data = await jsonFetch(`${base.replace(/\/$/, "")}/sdapi/v1/txt2img`, {
    method: "POST",
    body: {
      prompt: `${prompt}. single object, centered, three-quarter view, plain neutral light-gray studio background, soft even lighting, entire object fully in frame, no text`,
      negative_prompt: "cropped, multiple objects, busy background, text, watermark",
      width: 768,
      height: 768,
      steps: Number(process.env.LOCAL_T2I_STEPS || 28),
    },
  });
  const b64 = data?.images?.[0];
  if (!b64) throw new Error("Local txt2img returned no image.");
  return b64;
}

export const local = {
  id: "local",

  async textTo3D({ prompt }) {
    const image = await localTxt2Img(prompt);
    return this._send(image);
  },

  async imageTo3D({ image_url, image_path }) {
    return this._send(await imageArgToBase64({ image_url, image_path }));
  },

  async _send(imageB64) {
    const data = await jsonFetch(`${localBase()}/send`, {
      method: "POST",
      body: { image: imageB64, texture: true, type: "glb" },
    });
    const uid = data?.uid ?? data?.task_id;
    if (!uid) throw new Error("Local 3D server returned no uid.");
    return { task_id: uid, engine: "local", stage: "image" };
  },

  async refine() {
    throw new Error(
      "The local Hunyuan3D server has no standalone retexture endpoint — regenerate instead (texture is already applied when texture:true), or use the meshy/tripo engines for prompt-driven retexturing."
    );
  },

  async check({ task_id }) {
    const t = await jsonFetch(`${localBase()}/status/${task_id}`);
    const raw = String(t?.status ?? "processing").toLowerCase();
    const status =
      raw === "completed" ? "succeeded" : raw === "error" || raw === "failed" ? "failed" : "running";
    let model_glb_path = null;
    if (status === "succeeded") {
      // The GLB arrives inline as base64 — persist once, then report the path.
      const dir = resolve(LOCAL_OUT());
      const file = resolve(dir, `${task_id}.glb`);
      if (!existsSync(file)) {
        const b64 = t?.model_base64 ?? t?.model;
        if (!b64) throw new Error("Local task completed but returned no model_base64.");
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, Buffer.from(b64, "base64"));
      }
      model_glb_path = file;
    }
    return {
      task_id,
      status,
      progress: status === "succeeded" ? 100 : status === "failed" ? 0 : 50,
      model_glb_url: null,
      model_glb_path,
      preview_image_url: null,
      error: status === "failed" ? (t?.message ?? "local generation error") : null,
    };
  },
};

export function engineFor(name) {
  if (name === "tripo") return tripo;
  if (name === "local") return local;
  if (name === "meshy" || !name) return name ? meshy : engineFor(defaultEngine());
  throw new Error(`Unknown engine: ${name} (use "meshy", "tripo", or "local")`);
}

export function defaultEngine() {
  if (process.env.LOCAL_3D_BASE_URL) return "local";
  if (process.env.MESHY_API_KEY) return "meshy";
  if (process.env.TRIPO_API_KEY) return "tripo";
  return "meshy";
}

/** Poll until terminal state or timeout. */
export async function waitForTask(eng, { task_id, timeout_seconds = 300, poll_seconds = 10, onTick } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const state = await eng.check({ task_id });
    onTick?.(state);
    if (state.status === "succeeded" || state.status === "failed") return state;
    if (Date.now() - startedAt > timeout_seconds * 1000) return { ...state, timed_out: true };
    await new Promise((r) => setTimeout(r, poll_seconds * 1000));
  }
}
