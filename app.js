// app.js
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");

// .env užkraunam kuo anksčiau, prieš skaitant process.env
require("dotenv").config({ path: path.resolve(process.cwd(), ".env") });

const app = express();

/* ---------- helpers ---------- */
function requireEnv(name) {
    const v = process.env[name];
    if (!v || String(v).trim() === "") {
        console.error(`[ENV] Missing required variable: ${name}`);
        process.exit(1);
    }
    return v;
}
function maskJwt(jwt) {
    if (!jwt) return "(empty)";
    return `${jwt.slice(0, 6)}…${jwt.slice(-4)}`;
}
function maskMongo(uri) {
    try {
        const u = new URL(uri);
        // paslepiam user:pass
        if (u.password) u.password = "***";
        if (u.username) u.username = "***";
        // grąžinam tik host/db dalį
        return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
        return "(invalid MONGO_URI)";
    }
}

/* ---------- env ---------- */
const PORT = Number(process.env.PORT || 2500);
const JWT_SECRET = requireEnv("JWT_SECRET");
const MONGO_URI = requireEnv("MONGO_URI");
const CORS_ORIGIN = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map((s) => s.trim())
    : true; // true = leisti viską dev režime

console.log("[ENV] PORT =", PORT);
console.log("[ENV] JWT_SECRET =", maskJwt(JWT_SECRET));
console.log("[ENV] MONGO_URI =", maskMongo(MONGO_URI));
console.log("[ENV] CORS_ORIGIN =", CORS_ORIGIN);

/* ---------- db ---------- */
mongoose
    .connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => console.log("[MongoDB] Database Connected!"))
    .catch((err) => {
        console.error("[MongoDB] Connection error:", err?.message || err);
        process.exit(1);
    });

/* ---------- middleware ---------- */
app.use(
    cors({
        origin: CORS_ORIGIN,
        credentials: true,
    })
);
app.use(express.json());

// --- request/response logger (be slaptažodžių nutekinimo)
app.use((req, res, next) => {
    const t0 = Date.now();

    let body =
        req.method === "GET" ? undefined : { ...(req.body || {}) };
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

/* ---------- routes ---------- */
app.get("/health", (_req, res) => res.json({ ok: true, scope: "root" }));

const { generatePerson } = require("./modules/personGenerate");
app.get("/generatePerson/:amount", (req, res) => {
    const amount = parseInt(req.params.amount, 10);
    if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
        return res.status(400).json({ ok: false, message: "įveskite skaičių 1..500" });
    }
    const users = generatePerson(amount);
    res.json({ ok: true, count: users.length, users });
});

const blogRouter = require("./routers/blogRouter");
app.use("/api/blog", blogRouter);
app.use("/backreg", blogRouter);

/* ---------- start ---------- */
app.listen(PORT, () => {
    console.log("Serveris paleistas:  http://localhost:" + PORT);
    console.log("Root health:         http://localhost:" + PORT + "/health");
    console.log("Blog health (new):   http://localhost:" + PORT + "/api/blog/health");
    console.log("Blog health (alias): http://localhost:" + PORT + "/backreg/health");
});
