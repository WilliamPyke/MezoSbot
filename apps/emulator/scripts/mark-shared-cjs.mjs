// Shared ../../src/*.ts files compile to CommonJS (the repo root package.json
// has no "type"), but this package is "type": "module". Without a marker, Node
// would load dist/src/*.js as ESM and their `exports.x = ...` would break.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "src", "package.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify({ type: "commonjs" })}\n`);
