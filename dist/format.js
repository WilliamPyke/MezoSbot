"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.roundSats = roundSats;
exports.formatSats = formatSats;
/** Precision for sats - supports sub-sat (e.g. 0.5, 0.000001) */
const SATS_PRECISION = 10;
function roundSats(amount) {
    return Math.round(amount * 10 ** SATS_PRECISION) / 10 ** SATS_PRECISION;
}
/** Format sats for display - e.g. "100 sats", "0.5 sats", "0.000001 sats" */
function formatSats(amount) {
    const rounded = roundSats(amount);
    if (rounded === 0)
        return "0 sats";
    const isWhole = Math.abs(rounded - Math.round(rounded)) < 1e-12;
    if (isWhole && rounded >= 1) {
        return `${Math.round(rounded).toLocaleString()} sats`;
    }
    const s = rounded.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: SATS_PRECISION,
    });
    return `${s} sats`;
}
