/**
 * The verified-generation pipeline — the whole point of this repo in one
 * function: generate → (texture) → download → render 4 views → vision
 * critique → if rejected, regenerate with the critic's revised prompt →
 * repeat until accepted or out of rounds. Returns the full audit trail.
 *
 * Non-destructive by construction: every round writes into its own
 * round-N/ directory; nothing is ever overwritten.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { engineFor, defaultEngine, waitForTask } from "./engines.mjs";
import { renderViews } from "./render.mjs";
import { downloadTo } from "./render.mjs";
import { critique } from "./critic.mjs";

/**
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.engine]            "meshy" | "tripo" (default: whichever key is set)
 * @param {string} [opts.style]             "realistic" | "sculpture" | "lowpoly"
 * @param {string} [opts.outDir="./3d-out"]
 * @param {number} [opts.maxRounds=3]
 * @param {number} [opts.timeoutSeconds=600] per provider task
 * @param {boolean} [opts.skipCritique=false] generate + render only (no OPENROUTER_API_KEY needed)
 * @param {(msg:string)=>void} [opts.log]
 */
export async function generateVerified({
  prompt,
  engine,
  style,
  outDir = "./3d-out",
  maxRounds = 3,
  timeoutSeconds = 600,
  skipCritique = false,
  log = () => {},
}) {
  const engName = engine || defaultEngine();
  const eng = engineFor(engName);
  const rounds = [];
  let currentPrompt = prompt;

  for (let round = 1; round <= maxRounds; round++) {
    const roundDir = resolve(outDir, `round-${round}`);
    log(`[round ${round}/${maxRounds}] generating with ${engName}: ${currentPrompt.slice(0, 120)}…`);

    // 1. Generate geometry (+ texture for single-stage engines).
    const gen = await eng.textTo3D({ prompt: currentPrompt, style });
    let state = await waitForTask(eng, { task_id: gen.task_id, timeout_seconds: timeoutSeconds, onTick: (s) => log(`  ${s.status} ${s.progress ?? 0}%`) });
    if (state.timed_out) throw new Error(`Round ${round}: generation timed out after ${timeoutSeconds}s (task ${gen.task_id}).`);
    if (state.status === "failed") throw new Error(`Round ${round}: generation failed: ${state.error ?? "unknown"}`);

    // 2. Meshy text→3D is two-stage: texture the preview.
    let geometryTaskId = gen.task_id;
    if (engName === "meshy") {
      log(`  texturing (refine)…`);
      const ref = await eng.refine({ task_id: gen.task_id });
      state = await waitForTask(eng, { task_id: ref.task_id, timeout_seconds: timeoutSeconds, onTick: (s) => log(`  ${s.status} ${s.progress ?? 0}%`) });
      if (state.timed_out) throw new Error(`Round ${round}: texturing timed out (task ${ref.task_id}).`);
      if (state.status === "failed") throw new Error(`Round ${round}: texturing failed: ${state.error ?? "unknown"}`);
    }

    // 3. Persist outputs immediately (provider URLs expire). Local engines
    // report a file path instead of a URL — copy it into the round dir.
    let glbPath;
    if (state.model_glb_url) {
      glbPath = await downloadTo(state.model_glb_url, resolve(roundDir, "model.glb"));
    } else if (state.model_glb_path) {
      mkdirSync(roundDir, { recursive: true });
      glbPath = resolve(roundDir, "model.glb");
      copyFileSync(state.model_glb_path, glbPath);
    } else {
      throw new Error(`Round ${round}: task succeeded but returned no model URL or path.`);
    }
    let providerPreview = null;
    if (state.preview_image_url) {
      const ext = state.preview_image_url.split("?")[0].split(".").pop()?.toLowerCase();
      providerPreview = await downloadTo(
        state.preview_image_url,
        resolve(roundDir, `provider-preview.${["png", "jpg", "jpeg", "webp"].includes(ext) ? ext : "png"}`)
      );
    }
    log(`  saved ${glbPath}`);

    // 4. Render canonical views — the agent's eyes.
    log(`  rendering 4 views…`);
    const views = await renderViews({ glbPath, outDir: resolve(roundDir, "views") });

    const record = {
      round,
      prompt: currentPrompt,
      engine: engName,
      task_id: state.task_id,
      geometry_task_id: geometryTaskId,
      glb: glbPath,
      provider_preview: providerPreview,
      views,
    };

    // 5. Judge.
    if (skipCritique) {
      rounds.push(record);
      return { accepted: null, rounds, final: record, note: "Critique skipped (skipCritique=true)." };
    }
    log(`  critiquing…`);
    const verdict = await critique({
      prompt, // judge against the ORIGINAL intent, not the mutated prompt
      images: views.map((v) => ({ path: v.path, angle: v.angle })),
    });
    record.verdict = verdict;
    rounds.push(record);
    log(`  score ${verdict.score}/10 — ${verdict.acceptable ? "ACCEPTED" : "rejected"}: ${verdict.summary}`);

    if (verdict.acceptable) return { accepted: true, rounds, final: record };
    if (!verdict.revisedPrompt || round === maxRounds) break;
    currentPrompt = verdict.revisedPrompt;
  }

  // Out of rounds: return the best-scoring round as the final.
  const best = rounds.reduce((a, b) => ((b.verdict?.score ?? -1) > (a.verdict?.score ?? -1) ? b : a), rounds[0]);
  return { accepted: false, rounds, final: best, note: "No round was accepted; 'final' is the best-scoring attempt." };
}
