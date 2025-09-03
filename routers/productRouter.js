// routers/productRouter.js
const express = require("express");
const router = express.Router();

const productCtrl = require("../controllers/productController");
const { requireAuth } = require("../middleware/authValidators");

// ---------------------------------------------
// Helpers
// ---------------------------------------------
function logRoute(req, _res, next) {
    const auth = req.headers.authorization || req.headers.Authorization || "";
    const hasBearer = auth.startsWith("Bearer ");
    const tokenPreview = hasBearer ? auth.slice(7, 19) + "..." : "";
    console.log(
        `[PRODUCT][ROUTE] ${req.method} ${req.originalUrl} auth=${hasBearer ? "Bearer " + tokenPreview : "no"}`
    );
    next();
}

function sanitizePrice(raw) {
    const num = Number(raw);
    if (!isFinite(num) || num < 0) return null;
    return Math.round(num * 100) / 100;
}

// ---------------------------------------------
// Validators (router-level)
// ---------------------------------------------
function validateProductCreate(req, res, next) {
    const name = String(req.body?.name || "").trim();
    const description = String(req.body?.description || "").trim();
    const image_url = String(req.body?.image_url || "").trim();
    const price = sanitizePrice(req.body?.price);

    console.log(
        `[PRODUCT][VALIDATE][CREATE] name=${!!name} description=${!!description} image_url=${!!image_url} price=${price}`
    );

    if (!name || !description || !image_url || price === null) {
        return res
            .status(400)
            .json({ success: false, message: "required: name, description, image_url, price(>=0)" });
    }

    // Normalizuojam body, kad controller'is gautų švarias reikšmes
    req.body.name = name;
    req.body.description = description;
    req.body.image_url = image_url;
    req.body.price = price;
    next();
}

function validateProductUpdate(req, res, next) {
    const set = {};
    if (typeof req.body?.name === "string") set.name = req.body.name.trim();
    if (typeof req.body?.description === "string") set.description = req.body.description.trim();
    if (typeof req.body?.image_url === "string") set.image_url = req.body.image_url.trim();
    if (typeof req.body?.price !== "undefined") {
        const p = sanitizePrice(req.body.price);
        if (p === null) {
            return res.status(400).json({ success: false, message: "bad price" });
        }
        set.price = p;
    }

    // Išvalom tuščias reikšmes
    Object.keys(set).forEach((k) => {
        if (typeof set[k] === "string" && !set[k]) delete set[k];
    });

    console.log(`[PRODUCT][VALIDATE][UPDATE] fields=${Object.keys(set).join(",") || "none"}`);

    if (!Object.keys(set).length) {
        return res.status(400).json({ success: false, message: "nothing to update" });
    }

    // Atiduodam controlleriui
    req.body = { ...req.body, ...set };
    next();
}

// ---------------------------------------------
// CORS preflight / Health
// ---------------------------------------------
// Express 5: naudok RegExp vietoj "(.*)"
router.options(/.*/, (req, res) => {
    console.log("[PRODUCT][ROUTE] OPTIONS preflight for", req.originalUrl);
    res.sendStatus(204);
});

router.get("/health", (req, res) => {
    console.log("[PRODUCT][ROUTE] GET /health");
    res.json({ ok: true, scope: "products" });
});

// ---------------------------------------------
// Routes
// ---------------------------------------------

// List (public) – palaiko ?page, ?limit, ?filter=available|reserved|mine, ?q
router.get("/", logRoute, productCtrl.list);

// Get one (public)
router.get("/:id", logRoute, productCtrl.getOne);

// Create (auth required)
router.post("/", logRoute, requireAuth, validateProductCreate, productCtrl.create);

// Update (auth required; controller tikrina nuosavybę ir rezervacijos taisykles)
router.put("/:id", logRoute, requireAuth, validateProductUpdate, productCtrl.update);

// Delete (auth required; controller tikrina nuosavybę ir rezervacijos taisykles)
router.delete("/:id", logRoute, requireAuth, productCtrl.remove);

// ---------------------------------------------
// Fallback 404 šitam routeriui (Express 5 patikimiau su router.use)
// ---------------------------------------------
router.use((req, res) => {
    console.warn(`[PRODUCT][ROUTE][404] ${req.method} ${req.originalUrl}`);
    res.status(404).json({ success: false, message: "Unknown products route" });
});

module.exports = router;
