// app.js
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const { DateTime } = require("luxon");
const { uid } = require("uid");
try { require("dotenv").config(); } catch (_) {}

// --------------------------------------------------
// App & ENV
// --------------------------------------------------
const app = express();
const PORT = process.env.PORT || 2500;
const NODE_ENV = process.env.NODE_ENV || "development";

// Mask helper for logs
const mask = (t) => (t && typeof t === "string" ? t.slice(0, 6) + "..." : "");

// ---- ENV LOGS
console.log("────────────────────────────────────────────────────");
console.log("[BOOT] Starting app.js");
console.log("[ENV] NODE_ENV        =", NODE_ENV);
console.log("[ENV] PORT            =", PORT);
console.log("[ENV] JWT_SECRET set  =", !!process.env.JWT_SECRET);
console.log("[ENV] MONGO_URI       =", process.env.MONGO_URI ? process.env.MONGO_URI.replace(/:\/\/.*@/,'://***:***@') : "(missing)");
console.log("[ENV] CORS_ORIGIN     =", process.env.CORS_ORIGIN || "(not set)");
console.log("────────────────────────────────────────────────────");

// --------------------------------------------------
// DB
// --------------------------------------------------
const DEFAULT_LOCAL_URI = "mongodb://127.0.0.1:27017/blog";
const MONGO_URI = process.env.MONGO_URI || DEFAULT_LOCAL_URI;

console.log("[MongoDB] Connecting ->", MONGO_URI === DEFAULT_LOCAL_URI ? "(local default)" : "(from ENV)");
mongoose
    .connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => console.log("[MongoDB] Database Connected! state=", mongoose.connection.readyState))
    .catch((err) => console.error("[MongoDB] Connection error:", err));

// Helpful DB events
mongoose.connection.on("error", (e) => console.error("[MongoDB] runtime error:", e.message));
mongoose.connection.on("disconnected", () => console.warn("[MongoDB] disconnected"));
mongoose.connection.on("reconnected", () => console.log("[MongoDB] reconnected"));

// --------------------------------------------------
// CORS
// --------------------------------------------------
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:3000,http://localhost:3001,http://localhost:3002")
    .split(",")
    .map((s) => s.trim());

console.log("[CORS] allowedOrigins =", allowedOrigins);

const corsOptions = {
    origin(origin, cb) {
        // Allow non-browser tools (no Origin)
        if (!origin) {
            console.log("[CORS] ALLOW (no-origin) request");
            return cb(null, true);
        }
        const ok = allowedOrigins.includes(origin);
        console.log(`[CORS] ${ok ? "ALLOW" : "BLOCK"} ${origin}`);
        cb(null, ok);
    },
    credentials: true,
    optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// Preflight for all routes (Express 5: naudok RegExp)
app.options(/.*/, cors(corsOptions));

// --------------------------------------------------
// Security, parsers, compression
// --------------------------------------------------
app.set("trust proxy", 1);
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// --------------------------------------------------
// Request ID + Request Logger (morgan + custom)
// --------------------------------------------------
app.use((req, _res, next) => {
    req.id = req.headers["x-request-id"] || uid(12);
    next();
});

morgan.token("id", (req) => req.id);
morgan.token("auth", (req) => {
    const h = req.headers.authorization || req.headers.Authorization || "";
    return h.startsWith("Bearer ") ? "Bearer " + mask(h.slice(7)) : "no";
});
morgan.token("body", (req) => {
    if (req.method === "GET") return "-";
    const clone = { ...(req.body || {}) };
    ["password", "passwordOne", "passwordTwo"].forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(clone, k)) clone[k] = "***";
    });
    return JSON.stringify(clone);
});

app.use(
    morgan(
        '[HTTP] :id :method :url :status :res[content-length] - :response-time ms auth=:auth body=:body'
    )
);

// Additional per-request timing log
app.use((req, res, next) => {
    const t0 = Date.now();
    res.on("finish", () => {
        const dt = Date.now() - t0;
        console.log(`[RES] ${req.id} ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${dt}ms`);
    });
    next();
});

// --------------------------------------------------
// Helpers
// --------------------------------------------------
function safeRequire(path, label) {
    try {
        const mod = require(path);
        console.log(`[APP] ${label} loaded from ${path}`);
        return mod;
    } catch (e) {
        const code = e && e.code;
        console.warn(`[APP] ${label} not found (${path}) code=${code || e.message}. Skipping mount.`);
        return null;
    }
}

// --------------------------------------------------
// Health
// --------------------------------------------------
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        scope: "root",
        now: DateTime.now().setZone("Europe/Vilnius").toISO(),
        dbState: mongoose.connection.readyState,
        env: NODE_ENV,
    });
});

// Simple ping
app.get("/__ping", (_req, res) => res.json({ pong: true }));

// --------------------------------------------------
// Demo: Faker generator (ContactPage)
// --------------------------------------------------
const { generatePerson } =
safeRequire("./modules/personGenerate", "personGenerate") || {};
if (generatePerson) {
    app.get("/generatePerson/:amount", (req, res) => {
        const amount = parseInt(req.params.amount, 10);
        if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
            return res.status(400).json({ ok: false, message: "įveskite skaičių 1..500" });
        }
        const users = generatePerson(amount);
        res.json({ ok: true, count: users.length, users });
    });
}

// --------------------------------------------------
// Optional middlewares (lazy expiry)
// --------------------------------------------------
const lazyExpiryFactory = safeRequire("./middleware/lazyExpiry", "lazyExpiry middleware");

// --------------------------------------------------
// Routers
// --------------------------------------------------
const blogRouter = safeRequire("./routers/blogRouter", "blogRouter");
if (blogRouter) {
    console.log("[APP] mounting blogRouter at /api/blog");
    app.use("/api/blog", blogRouter);
}

const authRouter = safeRequire("./routers/authRouter", "authRouter");
if (authRouter) {
    console.log("[APP] mounting authRouter at /api/auth");
    app.use("/api/auth", authRouter);
}

const productRouter = safeRequire("./routers/productRouter", "productRouter");
if (productRouter) {
    console.log("[APP] mounting productRouter at /api/products");
    // IMPORTANT: lazyExpiry is a FACTORY -> must be invoked to get middleware function
    if (typeof lazyExpiryFactory === "function") {
        app.use(
            "/api/products",
            lazyExpiryFactory({
                throttleMs: Number(process.env.LAZY_EXPIRY_THROTTLE_MS || 15000),
                batchLimit: Number(process.env.LAZY_EXPIRY_BATCH_LIMIT || 200),
            })
        );
    }
    app.use("/api/products", productRouter);
}

const reservationRouter = safeRequire("./routers/reservationRouter", "reservationRouter");
if (reservationRouter) {
    console.log("[APP] mounting reservationRouter at /api/reservations");
    if (typeof lazyExpiryFactory === "function") {
        app.use(
            "/api/reservations",
            lazyExpiryFactory({
                throttleMs: Number(process.env.LAZY_EXPIRY_THROTTLE_MS || 15000),
                batchLimit: Number(process.env.LAZY_EXPIRY_BATCH_LIMIT || 200),
            })
        );
    }
    app.use("/api/reservations", reservationRouter);
}

// --------------------------------------------------
// 404 + Error handler
// --------------------------------------------------
const ehMod = safeRequire("./middleware/errorHandler", "errorHandler");
if (ehMod && (typeof ehMod.notFound === "function" || typeof ehMod.errorHandler === "function")) {
    // naudosim tavo custom notFound, jeigu yra
    if (typeof ehMod.notFound === "function") {
        app.use(ehMod.notFound);
    } else {
        // fallback 404 jei modulyje nėra notFound
        app.use((req, res) => {
            console.warn(`[404] ${req.id} ${req.method} ${req.originalUrl}`);
            res.status(404).json({ success: false, message: "Not Found" });
        });
    }
    // global error handler (būtina eiti po 404)
    if (typeof ehMod.errorHandler === "function") {
        app.use(ehMod.errorHandler);
    } else {
        app.use((err, _req, res, _next) => {
            console.error("[ERR] Unhandled error:", err && err.stack ? err.stack : err);
            res.status(500).json({ success: false, message: "Internal Server Error" });
        });
    }
} else {
    // Visas fallback, jei middleware/errorHandler modulis nerastas
    app.use((req, res) => {
        console.warn(`[404] ${req.id} ${req.method} ${req.originalUrl}`);
        res.status(404).json({ success: false, message: "Not Found" });
    });
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
        console.error("[ERR] Unhandled error:", err && err.stack ? err.stack : err);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    });
}

// --------------------------------------------------
// Process events
// --------------------------------------------------
process.on("unhandledRejection", (reason) => {
    console.error("[PROC] Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("[PROC] Uncaught Exception:", err);
});
process.on("SIGINT", () => {
    console.warn("[PROC] SIGINT received. Shutting down...");
    process.exit(0);
});

// --------------------------------------------------
// Listen
// --------------------------------------------------
app.listen(PORT, () => {
    console.log("────────────────────────────────────────────────────");
    console.log("Serveris paleistas:  http://localhost:" + PORT);
    console.log("Root health:         http://localhost:" + PORT + "/health");
    if (blogRouter) console.log("Blog health:         http://localhost:" + PORT + "/api/blog/health");
    if (productRouter) console.log("Products:            http://localhost:" + PORT + "/api/products");
    if (reservationRouter) console.log("Reservations:        http://localhost:" + PORT + "/api/reservations");
    if (authRouter) console.log("Auth:                http://localhost:" + PORT + "/api/auth");
    console.log("────────────────────────────────────────────────────");
});
