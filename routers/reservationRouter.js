// routers/reservationRouter.js
const express = require("express");
const router = express.Router();

const resCtrl = require("../controllers/reservationController");
const { requireAuth } = require("../middleware/authValidators");

// ---------------------------------------------
// Helpers
// ---------------------------------------------
function logRoute(req, _res, next) {
    const auth = req.headers.authorization || req.headers.Authorization || "";
    const hasBearer = auth.startsWith("Bearer ");
    const tokenPreview = hasBearer ? auth.slice(7, 19) + "..." : "";
    console.log(
        `[RES][ROUTE] ${req.method} ${req.originalUrl} auth=${hasBearer ? "Bearer " + tokenPreview : "no"}`
    );
    next();
}

function validateCreate(req, res, next) {
    const productId = String(req.body?.productId || "").trim();
    const looksLikeMongoId = /^[a-f0-9]{24}$/i.test(productId);
    console.log(`[RES][VALIDATE][CREATE] productId="${productId}" isMongoId=${looksLikeMongoId}`);
    if (!productId) {
        return res.status(400).json({ success: false, message: "missing productId" });
    }
    if (!looksLikeMongoId) {
        console.warn("[RES][VALIDATE][CREATE] productId does not look like ObjectId (will try anyway)");
    }
    req.body.productId = productId;
    next();
}

// ---------------------------------------------
// CORS preflight / Health
// ---------------------------------------------
// Express 5: naudok RegExp vietoj "(.*)"
router.options(/.*/, (req, res) => {
    console.log("[RES][ROUTE] OPTIONS preflight for", req.originalUrl);
    res.sendStatus(204);
});

router.get("/health", (req, res) => {
    console.log("[RES][ROUTE] GET /health");
    res.json({ ok: true, scope: "reservations" });
});

// ---------------------------------------------
// Routes
// ---------------------------------------------
// Quote (auth required)
router.post("/quote", logRoute, requireAuth, resCtrl.quote);

// Bulk reserve (auth required)
router.post("/bulk", logRoute, requireAuth, resCtrl.bulk);
// Create reservation (auth required)
// body: { productId }
router.post("/", logRoute, requireAuth, validateCreate, resCtrl.create);

// Cancel/unreserve (auth required)
// params: :id (reservation id)
router.post("/:id/cancel", logRoute, requireAuth, resCtrl.cancel);

// My active reservations (auth required)
router.get("/my", logRoute, requireAuth, resCtrl.myActive);

// ---------------------------------------------
// Fallback 404 šitam routeriui (Express 5 patikimiau su router.use)
// ---------------------------------------------
router.use((req, res) => {
    console.warn(`[RES][ROUTE][404] ${req.method} ${req.originalUrl}`);
    res.status(404).json({ success: false, message: "Unknown reservations route" });
});

module.exports = router;
