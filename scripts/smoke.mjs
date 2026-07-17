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
console.error("All smoke tests passed.");
process.exit(0);
