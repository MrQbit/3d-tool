#!/usr/bin/env node
/**
 * three-gen — MCP (Model Context Protocol) stdio server: reliable 3D
 * generation for any agent.
 *
 * Why this exists: LLM agents scripting Blender directly produce poor 3D —
 * they have no spatial feedback, and imperative mesh/texture edits are
 * destructive. This tool flips the workflow:
 *
 *   1. DELEGATE geometry+texture to a dedicated generative 3D model
 *      (Meshy or Tripo) — they are trained for exactly this.
 *   2. VERIFY with eyes, not vibes: render_views screenshots the GLB from
 *      four angles headlessly; critique_render has a vision model judge them
 *      and return a revised prompt.
 *   3. ITERATE non-destructively: retexture re-runs from the same geometry;
 *      every round is a new artifact, nothing is edited in place.
 *
 * generate_3d_verified runs the whole loop in one call.
 *
 * Setup (Claude Code):
 *   claude mcp add three-gen -e MESHY_API_KEY=... -e OPENROUTER_API_KEY=... \
 *     -- node /path/to/three-gen/server.mjs
 *
 * Newline-delimited JSON-RPC 2.0 over stdio. Zero runtime deps for the API
 * tools; render tools need playwright + @google/model-viewer (npm install).
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { engineFor, defaultEngine, waitForTask } from "./lib/engines.mjs";
import { critique } from "./lib/critic.mjs";
import { renderViews, downloadTo } from "./lib/render.mjs";
import { generateVerified } from "./lib/pipeline.mjs";

const TOOLS = [
  {
    name: "generate_3d_verified",
    description:
      "The one-call reliable path: generate a 3D model from a prompt, texture it, download the GLB, render it from 4 angles, have a vision model judge it against the prompt, and auto-regenerate with the revised prompt until accepted (or max_rounds). Returns the full audit trail with per-round GLB paths, view images, and verdicts. Takes 3-15 minutes — prefer this for 'make me a good 3D model of X'. Requires an engine key + OPENROUTER_API_KEY (set skip_critique=true to run without the judge).",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        engine: { type: "string", enum: ["meshy", "tripo", "local"] },
        style: { type: "string", enum: ["realistic", "sculpture", "lowpoly"] },
        out_dir: { type: "string", description: "Output directory (default ./3d-out). Each round writes round-N/." },
        max_rounds: { type: "number", description: "Max generate→judge rounds (default 3)." },
        skip_critique: { type: "boolean", description: "Generate + render only, no vision judging." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "text_to_3d",
    description:
      "Start generating a 3D model (GLB) from a text prompt using a dedicated generative 3D engine. Returns a task_id — poll with check_3d_task or wait_for_task. For Meshy the first pass is untextured geometry; call refine_3d afterwards to texture it. Prefer generate_3d_verified unless you want manual control of the loop.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Shape, materials, style, distinguishing details." },
        engine: { type: "string", enum: ["meshy", "tripo", "local"], description: "Default: whichever key is configured." },
        style: { type: "string", enum: ["realistic", "sculpture", "lowpoly"], description: "Meshy only." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "image_to_3d",
    description:
      "Start generating a textured 3D model (GLB) from a reference image. Best input: a single object, 3/4 view, neutral background. Provide image_url (https or data: URL) or image_path (local file, Tripo only). Returns a task_id.",
    inputSchema: {
      type: "object",
      properties: {
        image_url: { type: "string" },
        image_path: { type: "string", description: "Local path (uploaded directly; Tripo only)." },
        engine: { type: "string", enum: ["meshy", "tripo", "local"] },
      },
    },
  },
  {
    name: "refine_3d",
    description:
      "Texture/retexture NON-DESTRUCTIVELY from an existing task's geometry. Meshy: pass the preview task_id. Tripo: pass the original model task_id. The original output is never modified — this creates a new task. texture_prompt changes the look without touching the mesh.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        texture_prompt: { type: "string" },
        engine: { type: "string", enum: ["meshy", "tripo", "local"] },
      },
      required: ["task_id"],
    },
  },
  {
    name: "check_3d_task",
    description:
      "Poll a 3D task: status (pending|running|succeeded|failed), progress, and on success model_glb_url + preview_image_url. Provider URLs EXPIRE within hours — download promptly with download_model.",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" }, engine: { type: "string", enum: ["meshy", "tripo", "local"] } },
      required: ["task_id"],
    },
  },
  {
    name: "wait_for_task",
    description: "Block until a 3D task finishes (default timeout 300s, poll 10s). Same result shape as check_3d_task.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        engine: { type: "string", enum: ["meshy", "tripo", "local"] },
        timeout_seconds: { type: "number" },
      },
      required: ["task_id"],
    },
  },
  {
    name: "download_model",
    description:
      "Download a finished task's GLB (+ provider preview image) to local disk. Do this immediately after success — provider URLs expire.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        engine: { type: "string", enum: ["meshy", "tripo", "local"] },
        out_dir: { type: "string", description: "Default ./3d-out" },
        basename: { type: "string", description: "Default: the task id." },
      },
      required: ["task_id"],
    },
  },
  {
    name: "render_views",
    description:
      "Render a local GLB from multiple camera angles (front/right/back/top) to PNG files using headless Chromium — the agent's eyes on the model. Returns the image paths; feed them to critique_render.",
    inputSchema: {
      type: "object",
      properties: {
        glb_path: { type: "string" },
        out_dir: { type: "string", description: "Default ./renders" },
        size: { type: "number", description: "Square viewport px (default 768)." },
      },
      required: ["glb_path"],
    },
  },
  {
    name: "critique_render",
    description:
      "Visual QA: send rendered views of ONE model (local image paths) + the original prompt; a vision model returns {score 0-10, acceptable, issues[{aspect,severity,description}], revisedPrompt}. Judge every generation before calling it done; feed revisedPrompt back into text_to_3d/refine_3d. Requires OPENROUTER_API_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        image_paths: { type: "array", items: { type: "string" } },
      },
      required: ["prompt", "image_paths"],
    },
  },
];

async function callTool(name, args = {}) {
  const eng = engineFor(args.engine || defaultEngine());
  switch (name) {
    case "generate_3d_verified": {
      const logs = [];
      const result = await generateVerified({
        prompt: args.prompt,
        engine: args.engine,
        style: args.style,
        outDir: args.out_dir || "./3d-out",
        maxRounds: args.max_rounds ?? 3,
        skipCritique: Boolean(args.skip_critique),
        log: (m) => logs.push(m),
      });
      return { ...result, log: logs };
    }
    case "text_to_3d":
      return eng.textTo3D(args);
    case "image_to_3d":
      if (!args.image_url && !args.image_path) throw new Error("Provide image_url or image_path.");
      return eng.imageTo3D(args);
    case "refine_3d":
      return eng.refine(args);
    case "check_3d_task":
      return eng.check(args);
    case "wait_for_task":
      return waitForTask(eng, args);
    case "download_model": {
      const state = await eng.check(args);
      if (state.status !== "succeeded") throw new Error(`Task is ${state.status}, nothing to download yet.`);
      const outDir = resolve(args.out_dir || "./3d-out");
      const base = args.basename || args.task_id;
      const saved = {};
      if (state.model_glb_url) {
        saved.model = await downloadTo(state.model_glb_url, resolve(outDir, `${base}.glb`));
      } else if (state.model_glb_path) {
        mkdirSync(outDir, { recursive: true });
        saved.model = resolve(outDir, `${base}.glb`);
        copyFileSync(state.model_glb_path, saved.model);
      }
      if (state.preview_image_url) {
        const ext = state.preview_image_url.split("?")[0].split(".").pop()?.toLowerCase();
        const pext = ["png", "jpg", "jpeg", "webp"].includes(ext) ? ext : "png";
        saved.preview = await downloadTo(state.preview_image_url, resolve(outDir, `${base}-preview.${pext}`));
      }
      if (!saved.model) throw new Error("Task succeeded but no model URL was returned.");
      return { ...saved, note: "Run render_views + critique_render before considering the model done." };
    }
    case "render_views":
      return {
        views: await renderViews({ glbPath: args.glb_path, outDir: args.out_dir || "./renders", size: args.size ?? 768 }),
      };
    case "critique_render":
      return critique({ prompt: args.prompt, images: args.image_paths });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP plumbing (newline-delimited JSON-RPC 2.0 over stdio) ────────────────

// A closed client pipe (EPIPE) must never crash the server mid-write.
process.stdout.on("error", (err) => {
  if (err?.code === "EPIPE") process.exit(0);
  throw err;
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "three-gen", version: "1.0.0" },
      },
    });
    return;
  }
  if (String(method).startsWith("notifications/")) return;
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments ?? {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    } catch (e) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
