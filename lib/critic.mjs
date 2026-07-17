/**
 * The vision critic — the agent's spatial awareness.
 *
 * A generation is never done because the API returned; it's done when it
 * looks right from every side. Rendered views + the original prompt go to a
 * vision model, which returns a structured verdict including a REVISED PROMPT
 * that feeds the next iteration.
 */

import { readFileSync } from "node:fs";
import { requireKey, jsonFetch } from "./engines.mjs";

const OPENROUTER_API = "https://openrouter.ai/api/v1";

const CRITIC_SYSTEM = `You are a rigorous 3D art director reviewing a generated 3D model.
You are shown rendered views of ONE model (labeled with their camera angle) plus the prompt it was generated from.
Judge only what is visible: geometry integrity (holes, floating fragments, merged limbs, missing parts), proportions vs. the prompt, texture quality (blur, seams, wrong colors, baked-in lighting), completeness (does every element in the prompt exist?), and style match.
Respond with ONLY a JSON object, no markdown fences, exactly this shape:
{"score": <0-10 number>, "acceptable": <boolean, true only if score >= 7 and no critical issues>, "summary": "<one sentence>", "issues": [{"aspect": "geometry|proportion|texture|completeness|style", "severity": "minor|major|critical", "description": "<specific, references the view where visible>"}], "revisedPrompt": "<a full rewritten generation prompt that keeps everything correct and explicitly fixes each issue>"}`;

function mimeFor(path) {
  const ext = path.split(".").pop().toLowerCase();
  if (ext === "webp") return "image/webp";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return "image/png";
}

/**
 * @param {object} opts
 * @param {string} opts.prompt   The prompt the model was generated from.
 * @param {Array<string|{path:string,angle?:string}>} opts.images  Local image paths (optionally labeled).
 * @returns verdict { score, acceptable, summary, issues[], revisedPrompt, critic_model }
 */
export async function critique({ prompt, images }) {
  const apiKey = requireKey("OPENROUTER_API_KEY");
  const model = process.env.THREE3D_CRITIC_MODEL || "google/gemini-2.5-flash";

  const content = [{ type: "text", text: `Original prompt: "${prompt}"\n\nRendered views follow.` }];
  for (const item of images.slice(0, 8)) {
    const path = typeof item === "string" ? item : item.path;
    const angle = typeof item === "string" ? null : item.angle;
    if (angle) content.push({ type: "text", text: `View: ${angle}` });
    const buf = readFileSync(path);
    content.push({ type: "image_url", image_url: { url: `data:${mimeFor(path)};base64,${buf.toString("base64")}` } });
  }

  const data = await jsonFetch(`${OPENROUTER_API}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model,
      max_tokens: 1200,
      temperature: 0.2,
      messages: [
        { role: "system", content: CRITIC_SYSTEM },
        { role: "user", content },
      ],
    },
  });

  const text = data?.choices?.[0]?.message?.content ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`Critic returned no JSON: ${text.slice(0, 200)}`);
  const verdict = JSON.parse(text.slice(start, end + 1));
  verdict.score = Math.max(0, Math.min(10, Number(verdict.score) || 0));
  verdict.acceptable = Boolean(verdict.acceptable);
  verdict.issues = Array.isArray(verdict.issues) ? verdict.issues : [];
  verdict.critic_model = model;
  return verdict;
}
