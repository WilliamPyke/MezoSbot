import fs from "node:fs";
import path from "node:path";

const source = path.resolve("../../src/satscape/world_gen/chunks");
const target = path.resolve("public/assets/satscape/chunks");
if (fs.existsSync(source)) {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
}
