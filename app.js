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

// HTTP + Socket.IO
const { createServer } = require("http");
const { Server } = require("socket.io");

// ──────────────────────────────────────────────────
// App & ENV
// ──────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 2500;
const NODE_ENV = process.env.NODE_ENV || "development";

const mask = (t) => (t && typeof t === "string" ? t.slice(0, 6) + "..." : "");

console.log("────────────────────────────────────────────────────");
console.log("[BOOT] Starting app.js");
console.log("[ENV] NODE_ENV        =", NODE_ENV);
console.log("[ENV] PORT            =", PORT);
console.log("[ENV] JWT_SECRET set  =", !!process.env.JWT_SECRET);
console.log(
    "[ENV] MONGO_URI       =",
    process.env.MONGO_URI ? process.env.MONGO_URI.replace(/:\/\/.*@/, "://***:***@") : "(missing)"
);
console.log("[ENV] CORS_ORIGIN     =", process.env.CORS_ORIGIN || "(not set)");
console.log("────────────────────────────────────────────────────");

// ──────────────────────────────────────────────────
// DB
// ──────────────────────────────────────────────────
const DEFAULT_LOCAL_URI = "mongodb://127.0.0.1:27017/blog";
const MONGO_URI = process.env.MONGO_URI || DEFAULT_LOCAL_URI;

console.log("[MongoDB] Connecting ->", MONGO_URI === DEFAULT_LOCAL_URI ? "(local default)" : "(from ENV)");
mongoose
    .connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 })
    .then(() => console.log("[MongoDB] Database Connected! state=", mongoose.connection.readyState))
    .catch((err) => console.error("[MongoDB] Connection error:", err));

mongoose.connection.on("error", (e) => console.error("[MongoDB] runtime error:", e.message));
mongoose.connection.on("disconnected", () => console.warn("[MongoDB] disconnected"));
mongoose.connection.on("reconnected", () => console.log("[MongoDB] reconnected"));

// ──────────────────────────────────────────────────
// CORS
// ──────────────────────────────────────────────────
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:3000,http://localhost:3001,http://localhost:3002")
    .split(",")
    .map((s) => s.trim());

console.log("[CORS] allowedOrigins =", allowedOrigins);

const corsOptions = {
    origin(origin, cb) {
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
app.options(/.*/, cors(corsOptions));

// ──────────────────────────────────────────────────
// Security, parsers, logging
// ──────────────────────────────────────────────────
app.set("trust proxy", 1);
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

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
    morgan('[HTTP] :id :method :url :status :res[content-length] - :response-time ms auth=:auth body=:body')
);

app.use((req, res, next) => {
    const t0 = Date.now();
    res.on("finish", () => {
        const dt = Date.now() - t0;
        console.log(`[RES] ${req.id} ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${dt}ms`);
    });
    next();
});

// ──────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        scope: "root",
        now: DateTime.now().setZone("Europe/Vilnius").toISO(),
        dbState: mongoose.connection.readyState,
        env: NODE_ENV,
    });
});
app.get("/__ping", (_req, res) => res.json({ pong: true }));

// ──────────────────────────────────────────────────
// Routers
// ──────────────────────────────────────────────────
const blogRouter = safeRequire("./routers/blogRouter", "blogRouter");
if (blogRouter) {
    app.use("/api/blog", blogRouter);
}

const authRouter = safeRequire("./routers/authRouter", "authRouter");
if (authRouter) {
    app.use("/api/auth", authRouter);
}

const productRouter = safeRequire("./routers/productRouter", "productRouter");
const lazyExpiryFactory = safeRequire("./middleware/lazyExpiry", "lazyExpiry middleware");
if (productRouter) {
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

// ──────────────────────────────────────────────────
// Live Board Game (Socket.IO)
// ──────────────────────────────────────────────────
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: allowedOrigins, methods: ["GET", "POST"] } });

// Board state
const BOARD_COLS = 10;
const BOARD_SIZE = 100;
const HP_FULL = 10;

let board = Array.from({ length: BOARD_SIZE }, () => ({ color: "", hp: 0 }));
const players = new Map(); // userId -> { username, color }

const inBounds = (i) => i >= 0 && i < BOARD_SIZE;
const idxToRC = (i) => ({ r: Math.floor(i / BOARD_COLS), c: i % BOARD_COLS });
const rcToIdx = (r, c) => r * BOARD_COLS + c;
function neighbors4(i) {
    const { r, c } = idxToRC(i);
    const list = [];
    if (r > 0) list.push(rcToIdx(r - 1, c));
    if (r < BOARD_COLS - 1) list.push(rcToIdx(r + 1, c));
    if (c > 0) list.push(rcToIdx(r, c - 1));
    if (c < BOARD_COLS - 1) list.push(rcToIdx(r, c + 1));
    return list;
}
function playerHasAny(color) {
    return board.some((cell) => cell.color === color && cell.hp > 0);
}
function isAdjacentToColor(index, color) {
    return neighbors4(index).some((ni) => {
        const n = board[ni];
        return n && n.color === color && n.hp > 0;
    });
}
function allFilled() {
    return board.every((cell) => cell.color && cell.hp > 0);
}
const cloneBoard = () => board.map((c) => ({ color: c.color, hp: c.hp }));
function resetGame() {
    board = Array.from({ length: BOARD_SIZE }, () => ({ color: "", hp: 0 }));
    players.clear();
    console.log("[BOARD] reset -> empty board, players cleared");
}

// Chat (in-memory)
const CHAT_LIMIT = 100;
const chatHistory = [];

// <<< ADDED: users list / private chat >>>
const chatUsers = new Map(); // socketId -> { userId, username }
const usersList = () =>
    Array.from(chatUsers.entries()).map(([socket_id, u]) => ({
        socket_id,
        userId: u.userId || null,
        username: u.username || "User",
    }));
// <<< /ADDED >>>

io.on("connection", (socket) => {
    console.log("[SOCKET] connected:", socket.id);

    socket.onAny((event, ...args) =>
        console.log("[SOCKET] < event:", event, "from:", socket.id, "args:", args)
    );

    socket.emit("server:hello", { message: "Welcome", id: socket.id });
    const t = setInterval(() => socket.emit("server:time", { now: Date.now() }), 1000);

    // initial board
    socket.emit("board:state", cloneBoard());

    // chat:join (naudojam identifikacijai)
    socket.on("chat:join", ({ userId, username }) => {
        socket.data.userId = userId;
        socket.data.username = username;
        const p = userId ? players.get(userId) : null;
        socket.data.color = p?.color || socket.data.color || "";
        socket.emit("chat:history", chatHistory);
        socket.emit("player:me", { color: socket.data.color || "" });
        io.emit("chat:system", { type: "join", userId, username, ts: Date.now() });

        // <<< ADDED: make sure user appears in online list even if FE nepaskambino registerUser >>>
        if (username && !chatUsers.has(socket.id)) {
            chatUsers.set(socket.id, { username, userId });
            io.emit("usersList", usersList());
        }
        // <<< /ADDED >>>
    });

    // <<< ADDED: explicit registration for user list >>>
    socket.on("registerUser", (payload) => {
        const username =
            typeof payload === "string" ? payload : (payload?.username || socket.data?.username);
        const userId = (payload && payload.userId) || socket.data?.userId || null;

        if (!username || typeof username !== "string") return;

        chatUsers.set(socket.id, { username: username.trim(), userId });
        io.emit("usersList", usersList()); // broadcast updated list
    });
    // <<< /ADDED >>>

    // player color – vieną kartą
    socket.on("player:setColor", ({ color }) => {
        const userId = socket.data.userId;
        const username = socket.data.username || "user";
        if (!userId) return;
        if (typeof color !== "string" || !color.trim()) return;

        const hex = color.trim().startsWith("#") ? color.trim().slice(0, 16) : "#" + color.trim().slice(0, 15);
        const p = players.get(userId) || { username, color: "" };
        if (p.color) {
            socket.emit("player:color:error", { message: "Color already chosen." });
            socket.emit("player:me", { color: p.color });
            return;
        }
        p.username = username;
        p.color = hex;
        players.set(userId, p);
        socket.data.color = hex;
        console.log("[PLAYER] color set:", { userId, username, color: hex });
        socket.emit("player:me", { color: hex });
    });

    // claim tuščio langelio
    socket.on("board:claim", ({ index }) => {
        const color = socket.data.color;
        if (!color) return;
        if (typeof index !== "number" || !inBounds(index)) return;

        const cell = board[index];
        if (!cell || cell.hp > 0 || cell.color) return;

        const first = !playerHasAny(color);
        const allowed = first || isAdjacentToColor(index, color);
        if (!allowed) return;

        board[index] = { color, hp: HP_FULL };
        io.emit("board:state", cloneBoard());

        if (allFilled()) {
            io.emit("board:gameover", { when: Date.now() });
            setTimeout(() => {
                resetGame();
                io.emit("board:reset", { when: Date.now() });
                io.emit("board:state", cloneBoard());
            }, 1200);
        }
    });

    // attack į priešininko langelį (-1 HP), jei ribojasi su tavo
    socket.on("board:attack", ({ index }) => {
        const color = socket.data.color;
        if (!color) return;
        if (typeof index !== "number" || !inBounds(index)) return;

        const cell = board[index];
        if (!cell || !cell.color || cell.hp <= 0) return;
        if (cell.color === color) return;
        if (!isAdjacentToColor(index, color)) return;

        const newHp = Math.max(0, (cell.hp || 0) - 1);
        board[index] = newHp === 0 ? { color: "", hp: 0 } : { color: cell.color, hp: newHp };
        io.emit("board:state", cloneBoard());

        if (allFilled()) {
            io.emit("board:gameover", { when: Date.now() });
            setTimeout(() => {
                resetGame();
                io.emit("board:reset", { when: Date.now() });
                io.emit("board:state", cloneBoard());
            }, 1200);
        }
    });

    // ping/pong
    socket.on("ping", (payload) => {
        socket.emit("pong", { now: Date.now(), payload });
    });

    // demo "foo"
    socket.on("foo", (value) => {
        socket.emit("foo", value);
        socket.broadcast.emit("foo", value);
    });

    // chat msg (public)
    socket.on("chat:message", (text) => {
        if (!socket.data.username || typeof text !== "string") return;
        const msg = {
            id: socket.id + ":" + Date.now(),
            userId: socket.data.userId || socket.id,
            username: socket.data.username,
            text: text.trim().slice(0, 1000),
            ts: Date.now(),
        };
        if (!msg.text) return;
        chatHistory.push(msg);
        if (chatHistory.length > CHAT_LIMIT) chatHistory.shift();
        io.emit("chat:message", msg);
    });

    // <<< ADDED: private chat send >>>
    socket.on("chat:private:send", ({ toSocketId, toUsername, text, message }) => {
        const body = (text ?? message ?? "").toString().trim();
        if (!body) return;

        // sender info
        const fromUser = chatUsers.get(socket.id) || {
            userId: socket.data?.userId || null,
            username: socket.data?.username || "User",
        };

        // resolve target socket id
        let targetSid = toSocketId;
        if (!targetSid && toUsername) {
            for (const [sid, u] of chatUsers.entries()) {
                if (u.username === toUsername) {
                    targetSid = sid;
                    break;
                }
            }
        }
        if (!targetSid) return;

        const msg = {
            id: socket.id + ":" + Date.now(),
            text: body.slice(0, 1000),
            ts: Date.now(),
            from: { socket_id: socket.id, userId: fromUser.userId, username: fromUser.username },
            to: { socket_id: targetSid },
        };

        io.to(targetSid).emit("chat:private:message", msg); // recipient
        socket.emit("chat:private:message", msg);           // echo to sender
    });
    // <<< /ADDED >>>

    socket.on("disconnect", (reason) => {
        clearInterval(t);
        // <<< ADDED: remove from users list on disconnect >>>
        chatUsers.delete(socket.id);
        io.emit("usersList", usersList());
        // <<< /ADDED >>>
        console.log("[SOCKET] disconnected:", socket.id, reason);
    });
});

// ──────────────────────────────────────────────────
// 404 + Error handler
// ──────────────────────────────────────────────────
const ehMod = safeRequire("./middleware/errorHandler", "errorHandler");
if (ehMod && (typeof ehMod.notFound === "function" || typeof ehMod.errorHandler === "function")) {
    if (typeof ehMod.notFound === "function") app.use(ehMod.notFound);
    if (typeof ehMod.errorHandler === "function") app.use(ehMod.errorHandler);
} else {
    app.use((req, res) => res.status(404).json({ success: false, message: "Not Found" }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
        console.error("[ERR] Unhandled error:", err && err.stack ? err.stack : err);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    });
}

// ──────────────────────────────────────────────────
// Listen
// ──────────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log("────────────────────────────────────────────────────");
    console.log("Serveris paleistas:  http://localhost:" + PORT);
    console.log("Root health:         http://localhost:" + PORT + "/health");
    if (blogRouter) console.log("Blog health:         http://localhost:" + PORT + "/api/blog/health");
    if (productRouter) console.log("Products:            http://localhost:" + PORT + "/api/products");
    if (reservationRouter) console.log("Reservations:        http://localhost:" + PORT + "/api/reservations");
    if (authRouter) console.log("Auth:                http://localhost:" + PORT + "/api/auth");
    console.log("────────────────────────────────────────────────────");
});
