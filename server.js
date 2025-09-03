// server.js
/*
  Bootstrap starter for the Express app.
  NOTE: app.js jau pats kviečia app.listen(), todėl čia tiesiog jį užkrauname.
  Tai leidžia production'e startuoti su "node server.js", o development'e su "nodemon app.js".
*/

try { require("dotenv").config(); } catch (_) {}

const { DateTime } = require("luxon");
const mongoose = require("mongoose");

// Helper log mask
const mask = (t) => (t && typeof t === "string" ? t.slice(0, 6) + "..." : "");

// --- BOOT LOGS
const NODE_ENV = process.env.NODE_ENV || "development";
const PORT = process.env.PORT || 2500;
console.log("────────────────────────────────────────────────────");
console.log("[BOOT] server.js starting…");
console.log("[ENV] NODE_ENV        =", NODE_ENV);
console.log("[ENV] PORT            =", PORT);
console.log("[ENV] JWT_SECRET set  =", !!process.env.JWT_SECRET);
console.log("[ENV] MONGO_URI       =", process.env.MONGO_URI ? process.env.MONGO_URI.replace(/:\/\/.*@/,'://***:***@') : "(missing)");
console.log("[ENV] CORS_ORIGIN     =", process.env.CORS_ORIGIN || "(not set)");
console.log("[BOOT] Time (Vilnius) =", DateTime.now().setZone("Europe/Vilnius").toISO());
console.log("────────────────────────────────────────────────────");

// --- LOAD APP (this will start the HTTP server inside app.js)
try {
    require("./app");
    console.log("[BOOT] app.js loaded successfully (app.listen should be active).");
} catch (e) {
    console.error("[BOOT] Failed to load app.js:", e && e.stack ? e.stack : e);
    process.exit(1);
}

// --- DB RUNTIME LOGS (useful if DB drops/reconnects)
if (mongoose && mongoose.connection) {
    mongoose.connection.on("error", (e) => console.error("[MongoDB] runtime error:", e && e.message ? e.message : e));
    mongoose.connection.on("disconnected", () => console.warn("[MongoDB] disconnected"));
    mongoose.connection.on("reconnected", () => console.log("[MongoDB] reconnected"));
}

// --- PROCESS EVENT HANDLERS
process.on("unhandledRejection", (reason) => {
    console.error("[PROC] Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("[PROC] Uncaught Exception:", err && err.stack ? err.stack : err);
});

let shuttingDown = false;
async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(`[PROC] ${signal} received. Starting graceful shutdown...`);
    try {
        if (mongoose && mongoose.connection && mongoose.connection.readyState !== 0) {
            console.log("[PROC] Closing MongoDB connection…");
            await mongoose.connection.close();
            console.log("[PROC] MongoDB connection closed.");
        }
    } catch (e) {
        console.error("[PROC] Error while closing MongoDB:", e && e.stack ? e.stack : e);
    } finally {
        console.log("[PROC] Exiting process now.");
        process.exit(0);
    }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
