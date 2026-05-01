"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.supabase = void 0;
const supabase_js_1 = require("@supabase/supabase-js");
const config_js_1 = require("./config.js");
exports.supabase = (0, supabase_js_1.createClient)(config_js_1.config.supabase.url, config_js_1.config.supabase.serviceRoleKey, {
    auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
    },
    realtime: {
        params: {
            eventsPerSecond: 1,
        },
    },
});
