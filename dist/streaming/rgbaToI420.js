"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rgbaToI420 = rgbaToI420;
/**
 * Convert an RGBA frame into I420 (YUV420 planar) for WebRTC video sources.
 * Assumes even width/height (Game Boy 160x144 satisfies this).
 */
function rgbaToI420(rgba, width, height, out) {
    const ySize = width * height;
    const uvWidth = width >> 1;
    const uvHeight = height >> 1;
    const uvSize = uvWidth * uvHeight;
    const required = ySize + uvSize * 2;
    const yuv = out && out.length >= required ? out : Buffer.allocUnsafe(required);
    const yPlane = 0;
    const uPlane = ySize;
    const vPlane = ySize + uvSize;
    // Luma plane (Y)
    for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
            const rgbaIdx = (py * width + px) * 4;
            const r = rgba[rgbaIdx];
            const g = rgba[rgbaIdx + 1];
            const b = rgba[rgbaIdx + 2];
            const y = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
            const clampedY = y < 0 ? 0 : y > 255 ? 255 : y;
            yuv[yPlane + py * width + px] = clampedY;
        }
    }
    // Chroma planes (U and V), 2x2 subsampled.
    for (let py = 0; py < height; py += 2) {
        for (let px = 0; px < width; px += 2) {
            let sumU = 0;
            let sumV = 0;
            for (let oy = 0; oy < 2; oy++) {
                for (let ox = 0; ox < 2; ox++) {
                    const rgbaIdx = ((py + oy) * width + (px + ox)) * 4;
                    const r = rgba[rgbaIdx];
                    const g = rgba[rgbaIdx + 1];
                    const b = rgba[rgbaIdx + 2];
                    sumU += ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                    sumV += ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
                }
            }
            const uvIdx = (py >> 1) * uvWidth + (px >> 1);
            const u = Math.round(sumU / 4);
            const v = Math.round(sumV / 4);
            yuv[uPlane + uvIdx] = u < 0 ? 0 : u > 255 ? 255 : u;
            yuv[vPlane + uvIdx] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
    }
    return { data: yuv, width, height };
}
