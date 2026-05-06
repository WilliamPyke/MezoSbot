"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.commandsData = exports.commands = void 0;
const link = __importStar(require("./link.js"));
const deposit = __importStar(require("./deposit.js"));
const balance = __importStar(require("./balance.js"));
const withdraw = __importStar(require("./withdraw.js"));
const tip = __importStar(require("./tip.js"));
const distribute = __importStar(require("./distribute.js"));
const drop = __importStar(require("./drop.js"));
const claim = __importStar(require("./claim.js"));
const leaderboard = __importStar(require("./leaderboard.js"));
const rain = __importStar(require("./rain.js"));
const history = __importStar(require("./history.js"));
const treasury = __importStar(require("./treasury.js"));
const backfill = __importStar(require("./backfill.js"));
const credit = __importStar(require("./credit.js"));
const sweep = __importStar(require("./sweep.js"));
const arcade = __importStar(require("./arcade.js"));
const gameboy_js_1 = require("./gameboy.js");
const config_js_1 = require("../config.js");
const baseCommands = [
    link,
    deposit,
    balance,
    withdraw,
    tip,
    distribute,
    drop,
    claim,
    leaderboard,
    rain,
    history,
    treasury,
    backfill,
    credit,
    sweep,
    arcade,
];
// Merge base commands + gameboy button commands into a single list
exports.commands = [
    ...baseCommands,
    ...(config_js_1.config.gameboy.enabled ? gameboy_js_1.gameboyCommands : []),
];
exports.commandsData = exports.commands.map((c) => c.data);
