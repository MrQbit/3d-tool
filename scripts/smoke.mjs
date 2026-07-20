#!/usr/bin/env node
/**
 * Smoke tests that need no API keys:
 *   1. MCP protocol handshake (initialize / tools/list) against server.mjs.
 *   2. Headless renderer on a bundled sample GLB (a procedurally-written
 *      minimal triangle GLB — enough to prove the browser pipeline works).
 * Exits non-zero on failure.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── 1. MCP handshake ─────────────────────────────────────────────────────────
console.error("· MCP handshake…");
const proc = spawn("node", [resolve(ROOT, "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
const replies = [];
proc.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (line.trim()) replies.push(JSON.parse(line));
  }
});
proc.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n"
);
proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
await new Promise((r) => setTimeout(r, 1500));
proc.kill();
const init = replies.find((r) => r.id === 1);
const list = replies.find((r) => r.id === 2);
if (!init?.result?.serverInfo?.name) fail("initialize failed");
if (!list?.result?.tools?.some((t) => t.name === "generate_3d_verified")) fail("tools/list missing generate_3d_verified");
console.error(`✓ MCP OK (${list.result.tools.length} tools)`);

// ── 2. Renderer ──────────────────────────────────────────────────────────────
// Minimal valid GLB: one colored triangle (positions only), written by hand.
function minimalGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0.5, 1, 0]);
  const posBuf = Buffer.from(positions.buffer);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: posBuf.length }],
    buffers: [{ byteLength: posBuf.length }],
  };
  let jsonStr = JSON.stringify(json);
  while (jsonStr.length % 4 !== 0) jsonStr += " ";
  const jsonBuf = Buffer.from(jsonStr);
  const binPad = (4 - (posBuf.length % 4)) % 4;
  const binBuf = Buffer.concat([posBuf, Buffer.alloc(binPad)]);
  const total = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(0x46546c67, o); o += 4; // magic "glTF"
  out.writeUInt32LE(2, o); o += 4;
  out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(jsonBuf.length, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4; // "JSON"
  jsonBuf.copy(out, o); o += jsonBuf.length;
  out.writeUInt32LE(binBuf.length, o); o += 4;
  out.writeUInt32LE(0x004e4942, o); o += 4; // "BIN\0"
  binBuf.copy(out, o);
  return out;
}

console.error("· headless renderer…");
const tmp = resolve(ROOT, ".smoke");
mkdirSync(tmp, { recursive: true });
const glbPath = resolve(tmp, "triangle.glb");
writeFileSync(glbPath, minimalGlb());

const { renderViews } = await import(resolve(ROOT, "lib/render.mjs"));
const views = await renderViews({ glbPath, outDir: resolve(tmp, "views"), size: 256 });
if (views.length !== 4) fail(`expected 4 views, got ${views.length}`);
for (const v of views) {
  if (!existsSync(v.path) || statSync(v.path).size < 500) fail(`view ${v.angle} missing or empty`);
}
console.error(`✓ renderer OK (${views.length} views under ${resolve(tmp, "views")})`);

// ── 3. Full LOCAL pipeline against mock services ─────────────────────────────
// Mocks the three local servers (A1111 txt2img, Hunyuan3D api_server, an
// OpenAI-compatible critic) and runs generateVerified end-to-end with
// engine "local" — real renderer, fake generation. Proves the fully-local
// wiring without a GPU.
console.error("· local pipeline (mock Hunyuan3D + txt2img + critic)…");

import { createServer } from "node:http";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GLB_B64 = minimalGlb().toString("base64");

function mockServer(handler) {
  return new Promise((resolveSrv) => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const reply = handler(req.url, body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolveSrv(srv));
  });
}

let statusCalls = 0;
const t2i = await mockServer((url) => (url.includes("txt2img") ? { images: [PNG_1PX] } : {}));
const hunyuan = await mockServer((url) => {
  if (url === "/send") return { uid: "mock-task-1" };
  if (url.startsWith("/status/")) {
    statusCalls++;
    // First poll: still processing; then done with the GLB inline.
    return statusCalls < 2 ? { status: "processing" } : { status: "completed", model_base64: GLB_B64 };
  }
  return {};
});
const criticSrv = await mockServer((url) =>
  url.includes("chat/completions")
    ? {
        choices: [
          {
            message: {
              content: JSON.stringify({
                score: 8,
                acceptable: true,
                summary: "Mock verdict: matches the prompt.",
                issues: [],
                revisedPrompt: "",
              }),
            },
          },
        ],
      }
    : {}
);

process.env.LOCAL_3D_BASE_URL = `http://127.0.0.1:${hunyuan.address().port}`;
process.env.LOCAL_T2I_BASE_URL = `http://127.0.0.1:${t2i.address().port}`;
process.env.CRITIC_BASE_URL = `http://127.0.0.1:${criticSrv.address().port}/v1`;
process.env.THREE3D_CRITIC_MODEL = "mock-vision";
process.env.LOCAL_3D_OUT = resolve(tmp, "local-tasks");

const { generateVerified } = await import(resolve(ROOT, "lib/pipeline.mjs"));
const result = await generateVerified({
  prompt: "a test triangle",
  engine: "local",
  outDir: resolve(tmp, "local-out"),
  maxRounds: 1,
  timeoutSeconds: 30,
  log: () => {},
});
t2i.close();
hunyuan.close();
criticSrv.close();

if (result.accepted !== true) fail(`local pipeline: expected accepted=true, got ${JSON.stringify(result).slice(0, 200)}`);
if (!existsSync(result.final.glb)) fail("local pipeline: final GLB missing");
if (result.final.views.length !== 4) fail("local pipeline: expected 4 rendered views");
if (result.final.verdict?.score !== 8) fail("local pipeline: critic verdict not propagated");
console.error("✓ local pipeline OK (mock generate → render → critique accepted)");

console.error("All smoke tests passed.");
process.exit(0);
