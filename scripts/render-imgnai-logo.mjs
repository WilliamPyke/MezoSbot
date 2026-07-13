import fs from "node:fs";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const source = fs.readFileSync("src/assets/imgnai-logo.svg", "utf8")
  .replaceAll('class="cls-1"', 'fill="#fefefe"')
  .replaceAll('class="cls-2"', 'fill="#000000"')
  .replaceAll('class="cls-3"', 'fill="#f271b6"');
const image = await loadImage(Buffer.from(source));
const canvas = createCanvas(64, 64);
const context = canvas.getContext("2d");
context.clearRect(0, 0, 64, 64);
context.drawImage(image, 0, 0, 64, 64);
fs.writeFileSync("src/assets/imgnai-logo.png", canvas.toBuffer("image/png"));
