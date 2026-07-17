#!/usr/bin/env node
/**
 * three-gen CLI — the same pipeline, driveable by hand (or by an agent that
 * prefers shell to MCP).
 *
 *   three-gen generate "a bronze raven statuette" [--engine meshy|tripo]
 *       [--style realistic|sculpture|lowpoly] [--out ./3d-out] [--rounds 3]
 *       [--no-critique]
 *   three-gen render model.glb [--out ./renders] [--size 768]
 *   three-gen critique "original prompt" view1.png view2.png …
 *   three-gen status <task_id> [--engine meshy|tripo]
 *
 * Env: MESHY_API_KEY / TRIPO_API_KEY (engines), OPENROUTER_API_KEY (critic).
 */

import { engineFor, defaultEngine } from "./lib/engines.mjs";
import { renderViews } from "./lib/render.mjs";
import { critique } from "./lib/critic.mjs";
import { generateVerified } from "./lib/pipeline.mjs";

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (key.startsWith("no-")) flags[key.slice(3)] = false;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[key] = argv[++i];
      else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const [cmd, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);

function out(v) {
  console.log(JSON.stringify(v, null, 2));
}

try {
  switch (cmd) {
    case "generate": {
      if (!positional[0]) throw new Error('Usage: three-gen generate "<prompt>"');
      const result = await generateVerified({
        prompt: positional[0],
        engine: flags.engine,
        style: flags.style,
        outDir: flags.out || "./3d-out",
        maxRounds: Number(flags.rounds ?? 3),
        skipCritique: flags.critique === false,
        log: (m) => console.error(m),
      });
      out(result);
      break;
    }
    case "render": {
      if (!positional[0]) throw new Error("Usage: three-gen render <model.glb>");
      out(await renderViews({ glbPath: positional[0], outDir: flags.out || "./renders", size: Number(flags.size ?? 768) }));
      break;
    }
    case "critique": {
      const [prompt, ...images] = positional;
      if (!prompt || !images.length) throw new Error('Usage: three-gen critique "<prompt>" <img1> [img2…]');
      out(await critique({ prompt, images }));
      break;
    }
    case "status": {
      if (!positional[0]) throw new Error("Usage: three-gen status <task_id>");
      const eng = engineFor(flags.engine || defaultEngine());
      out(await eng.check({ task_id: positional[0] }));
      break;
    }
    default:
      console.error(
        [
          "three-gen — reliable 3D generation for agents and humans",
          "",
          '  three-gen generate "<prompt>" [--engine meshy|tripo] [--style …] [--out dir] [--rounds 3] [--no-critique]',
          "  three-gen render <model.glb> [--out dir] [--size 768]",
          '  three-gen critique "<prompt>" <view1.png> [view2.png…]',
          "  three-gen status <task_id> [--engine meshy|tripo]",
          "",
          "Env: MESHY_API_KEY / TRIPO_API_KEY, OPENROUTER_API_KEY (critic).",
          "MCP server: node server.mjs (see README).",
        ].join("\n")
      );
      process.exit(cmd ? 1 : 0);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
