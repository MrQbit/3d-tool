/**
 * Headless multi-view renderer — gives a terminal-bound agent eyes on a GLB.
 *
 * Serves a tiny local page hosting Google's <model-viewer>, loads it in
 * headless Chromium (Playwright), captures the model from four canonical
 * angles (front / right / back / top), and writes PNGs. Those views are what
 * the vision critic judges — no Blender, no GPU server, fully local.
 */

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

export const CANONICAL_ORBITS = [
  ["front", "0deg 80deg 105%"],
  ["right side", "90deg 80deg 105%"],
  ["back", "180deg 80deg 105%"],
  ["top-down", "0deg 20deg 105%"],
];

function viewerHtml() {
  return `<!doctype html><html><head><meta charset="utf-8">
<script type="module" src="/model-viewer.min.js"></script>
<style>html,body{margin:0;padding:0}model-viewer{width:768px;height:768px;background:#e8e8e8}</style>
</head><body>
<model-viewer id="mv" src="/model.glb" interaction-prompt="none" shadow-intensity="1" exposure="1"></model-viewer>
</body></html>`;
}

async function launchChromium() {
  const { chromium } = await import("playwright").catch(() => {
    throw new Error(
      "playwright is not installed. Run: npm install && npx playwright install chromium (skip the second step if a system Chromium is provided via PLAYWRIGHT_BROWSERS_PATH)."
    );
  });
  try {
    return await chromium.launch();
  } catch (err) {
    // Fall back to a system-provided Chromium if the managed download is absent.
    const sysPath = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
    try {
      return await chromium.launch({ executablePath: sysPath });
    } catch {
      throw err;
    }
  }
}

/**
 * Render a GLB from multiple angles.
 * @param {object} opts
 * @param {string} opts.glbPath              Path to the .glb file.
 * @param {string} [opts.outDir="./renders"] Where PNGs are written.
 * @param {Array<[string,string]>} [opts.orbits] [label, "theta phi radius"] pairs.
 * @param {number} [opts.size=768]           Square viewport size in px.
 * @returns {Promise<Array<{angle:string, path:string}>>}
 */
export async function renderViews({ glbPath, outDir = "./renders", orbits = CANONICAL_ORBITS, size = 768 }) {
  const glb = readFileSync(resolve(glbPath));
  const mvJs = readFileSync(require.resolve("@google/model-viewer/dist/model-viewer.min.js"));

  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(viewerHtml());
    } else if (req.url === "/model-viewer.min.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      res.end(mvJs);
    } else if (req.url === "/model.glb") {
      res.writeHead(200, { "Content-Type": "model/gltf-binary" });
      res.end(glb);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#mv")?.loaded === true, undefined, { timeout: 60_000 });

    mkdirSync(resolve(outDir), { recursive: true });
    const results = [];
    for (const [label, orbit] of orbits) {
      const dataUrl = await page.evaluate(async (o) => {
        const mv = document.querySelector("#mv");
        mv.cameraOrbit = o;
        mv.jumpCameraToGoal();
        await mv.updateComplete;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return mv.toDataURL("image/png");
      }, orbit);
      const b64 = dataUrl.split(",")[1];
      const file = resolve(outDir, `${label.replace(/[^a-z0-9]+/gi, "-")}.png`);
      writeFileSync(file, Buffer.from(b64, "base64"));
      results.push({ angle: label, path: file });
    }
    return results;
  } finally {
    await browser.close();
    server.close();
  }
}

/** Download a URL to a local file (used for finished provider outputs). */
export async function downloadTo(url, path) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), Buffer.from(await res.arrayBuffer()));
  return resolve(path);
}
