/**
 * Engine adapters — dedicated generative 3D models behind one normalized
 * interface. The agent never sculpts geometry; these models do.
 *
 * Both are task-based REST APIs: create task → poll → download.
 * IMPORTANT: provider output URLs EXPIRE (Tripo ~2 hours, Meshy days) —
 * always download promptly after success.
 */

import { readFileSync } from "node:fs";

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

export function engineFor(name) {
  if (name === "tripo") return tripo;
  if (name === "meshy" || !name) return name ? meshy : engineFor(defaultEngine());
  throw new Error(`Unknown engine: ${name} (use "meshy" or "tripo")`);
}

export function defaultEngine() {
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
