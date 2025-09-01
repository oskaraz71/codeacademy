// app.js
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
try { require("dotenv").config(); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 2500;

// ---- Helpers: saugiai išparsinti CORS_ORIGIN ----
function parseCors(originEnv) {
    if (!originEnv) return [];
    // 1) bandome kaip JSON
    try {
        const parsed = JSON.parse(originEnv);
        if (Array.isArray(parsed)) return parsed;
        if (typeof parsed === "string") return [parsed];
    } catch (_) {}
    // 2) bandome kaip kableliais/skyrimais atskirtą sąrašą arba vieną URL
    return String(originEnv)
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

// ---- ENV logai (be slaptų duomenų nutekinimo) ----
const JWT_SECRET_PREVIEW = (process.env.JWT_SECRET || "");
const MONGO_URI_SAFE = (process.env.MONGO_URI || "").replace(/:\/\/([^@]+)@/, "://***:***@");
const CORS_LIST = parseCors(process.env.CORS_ORIGIN);

console.log("[ENV] PORT =", PORT);
console.log("[ENV] JWT_SECRET =", JWT_SECRET_PREVIEW ? JWT_SECRET_PREVIEW.slice(0, 6) + "…" + JWT_SECRET_PREVIEW.slice(-4) : "(missing)");
console.log("[ENV] MONGO_URI =", MONGO_URI_SAFE || "(missing)");
console.log("[ENV] CORS_ORIGIN =", CORS_LIST.length ? CORS_LIST : "*");

// ---- DB ----
const MONGO_URI =
    process.env.MONGO_URI ||
    "mongodb+srv://cluster.irubfmr.mongodb.net/blog";

mongoose
    .connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => console.log("[MongoDB] Database Connected!"))
    .catch((err) => console.error("[MongoDB] Connection error:", err));

// ---- Middleware ----
app.use(
    cors(
        CORS_LIST.length
            ? { origin: CORS_LIST, credentials: true }
            : {} // be parametrų – leidžia viską (dev)
    )
);

app.use(express.json());

// --- Išsamus loggeris (be paslapčių) ---
app.use((req, res, next) => {
    const t0 = Date.now();

    let body = req.method === "GET" ? undefined : { ...(req.body || {}) };
    ["password", "passwordOne", "passwordTwo"].forEach((k) => {
        if (body && Object.prototype.hasOwnProperty.call(body, k)) body[k] = "***";
    });

    const auth = req.headers.authorization || req.headers.Authorization || "";
    const hasBearer = auth.startsWith("Bearer ");
    const tokenPreview = hasBearer ? auth.slice(7, 19) + "..." : "";

    console.log(
        `[REQ] ${req.method} ${req.path} auth=${hasBearer ? "Bearer " + tokenPreview : "no"} body=${
            body ? JSON.stringify(body) : "-"
        }`
    );

    res.on("finish", () => {
        const ms = Date.now() - t0;
        console.log(`[RES] ${req.method} ${req.path} -> ${res.statusCode} in ${ms}ms`);
    });

    next();
});

// Sveikatos patikra
app.get("/health", (_req, res) => res.json({ ok: true, scope: "root" }));

// (paliekam žmonių generatorių, jei dar naudoji)
const { generatePerson } = require("./modules/personGenerate");
app.get("/generatePerson/:amount", (req, res) => {
    const amount = parseInt(req.params.amount, 10);
    if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
        return res.status(400).json({ ok: false, message: "įveskite skaičių 1..500" });
    }
    const users = generatePerson(amount);
    res.json({ ok: true, count: users.length, users });
});

// BLOG api per router + alias
const blogRouter = require("./routers/blogRouter");
app.use("/api/blog", blogRouter);
app.use("/backreg", blogRouter);

// Start
console.log("[ENV] JWT_SECRET set:", !!process.env.JWT_SECRET);
console.log("[ENV] MONGO_URI set:", !!process.env.MONGO_URI);

app.listen(PORT, () => {
    console.log("Serveris paleistas:  http://localhost:" + PORT);
    console.log("Root health:         http://localhost:" + PORT + "/health");
    console.log("Blog health (new):   http://localhost:" + PORT + "/api/blog/health");
    console.log("Blog health (alias): http://localhost:" + PORT + "/backreg/health");
});
