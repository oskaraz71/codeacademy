// app.js
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
try { require("dotenv").config(); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 2500;

// ---- ENV LOGS
console.log("[ENV] PORT =", PORT);
console.log("[ENV] JWT_SECRET set:", !!process.env.JWT_SECRET);
console.log("[ENV] MONGO_URI =", process.env.MONGO_URI ? process.env.MONGO_URI.replace(/:\/\/.*@/,'://***:***@') : "(missing)");
console.log("[ENV] CORS_ORIGIN =", process.env.CORS_ORIGIN || "(not set)");

// ---- DB
const MONGO_URI =
    process.env.MONGO_URI ||
    "mongodb+srv://oskaraz71:0In5wr8d476OX0vx@cluster.irubfmr.mongodb.net/blog?retryWrites=true&w=majority&appName=Cluster";

mongoose
    .connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => console.log("[MongoDB] Database Connected!"))
    .catch((err) => console.error("[MongoDB] Connection error:", err));

// ---- CORS (leidžiam 3000 ir 3001 pagal poreikį)
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:3000,http://localhost:3001")
    .split(",")
    .map(s => s.trim());

app.use(cors({
    origin(origin, cb) {
        if (!origin) return cb(null, true);
        const ok = allowedOrigins.includes(origin);
        console.log(`[CORS] ${ok ? "ALLOW" : "BLOCK"} ${origin}`);
        cb(null, ok);
    }
}));
app.use(express.json());

// ---- REQUEST LOGGER
app.use((req, res, next) => {
    const t0 = Date.now();
    let body = req.method === "GET" ? undefined : { ...(req.body || {}) };
    ["password", "passwordOne", "passwordTwo"].forEach((k) => { if (body && Object.prototype.hasOwnProperty.call(body, k)) body[k] = "***"; });
    const auth = req.headers.authorization || req.headers.Authorization || "";
    const hasBearer = auth.startsWith("Bearer ");
    const tokenPreview = hasBearer ? auth.slice(7, 19) + "..." : "";
    console.log(`[REQ] ${req.method} ${req.originalUrl} auth=${hasBearer ? "Bearer " + tokenPreview : "no"} body=${body ? JSON.stringify(body) : "-"}`);
    res.on("finish", () => console.log(`[RES] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${Date.now() - t0}ms`));
    next();
});

// ---- Health
app.get("/health", (_req, res) => res.json({ ok: true, scope: "root" }));

// ---- Faker generator (ContactPage)
const { generatePerson } = require("./modules/personGenerate");
app.get("/generatePerson/:amount", (req, res) => {
    const amount = parseInt(req.params.amount, 10);
    if (!Number.isFinite(amount) || amount < 1 || amount > 500) {
        return res.status(400).json({ ok: false, message: "įveskite skaičių 1..500" });
    }
    const users = generatePerson(amount);
    res.json({ ok: true, count: users.length, users });
});

// ---- Blog router
const blogRouter = require("./routers/blogRouter");
console.log("[APP] mounting blogRouter at /api/blog");
app.use("/api/blog", blogRouter);

// Simple ping
app.get("/__ping", (_req, res) => res.json({ pong: true }));

app.listen(PORT, () => {
    console.log("Serveris paleistas:  http://localhost:" + PORT);
    console.log("Root health:         http://localhost:" + PORT + "/health");
    console.log("Blog health:         http://localhost:" + PORT + "/api/blog/health");
    console.log("Users endpoint:      http://localhost:" + PORT + "/api/blog/users");
});
