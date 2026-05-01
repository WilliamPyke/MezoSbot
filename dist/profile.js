"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractProfile = extractProfile;
exports.updateUserProfile = updateUserProfile;
const discord_js_1 = require("discord.js");
const db_js_1 = require("./db.js");
// In-memory cache to avoid redundant DB updates
const profileCache = new Map();
function extractProfile(interaction) {
    const user = interaction.user;
    const member = interaction.member instanceof discord_js_1.GuildMember ? interaction.member : null;
    const username = user.username;
    const displayName = member?.displayName ?? user.displayName;
    const avatarUrl = (member ?? user).displayAvatarURL({ size: 128, extension: "png", forceStatic: true });
    return { username, displayName, avatarUrl };
}
async function updateUserProfile(discordId, username, displayName, avatarUrl) {
    // Check cache to see if profile has changed
    const cached = profileCache.get(discordId);
    if (cached && cached.username === username && cached.displayName === displayName && cached.avatarUrl === avatarUrl) {
        return; // No changes, skip DB update
    }
    // Update cache
    profileCache.set(discordId, { username, displayName, avatarUrl });
    // Update database
    await db_js_1.supabase
        .from("users")
        .update({
        username,
        display_name: displayName,
        avatar_url: avatarUrl,
    })
        .eq("discord_id", discordId);
}
