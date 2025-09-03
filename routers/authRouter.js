// routers/authRouter.js
const express = require("express");
const router = express.Router();

const authCtrl = require("../controllers/authController");
const {
    requireAuth,
    validateRegister,
    validateLogin,
} = require("../middleware/authValidators");

// Small helper for route logs
function logRoute(req, _res, next) {
    const auth = req.headers.authorization || req.headers.Authorization || "";
    const hasBearer = auth.startsWith("Bearer ");
    const tokenPreview = hasBearer ? auth.slice(7, 19) + "..." : "";
    console.log(`[AUTH][ROUTE] ${req.method} ${req.originalUrl} auth=${hasBearer ? "Bearer " + tokenPreview : "no"}`);
    next();
}

// CORS preflight (Express 5: naudok RegExp, ne "(.*)")
router.options(/.*/, (req, res) => {
    console.log("[AUTH][ROUTE] OPTIONS preflight for", req.originalUrl);
    res.sendStatus(204);
});

// Health
router.get("/health", (req, res) => {
    console.log("[AUTH][ROUTE] GET /health");
    res.json({ ok: true, scope: "auth" });
});

// REGISTER
// body: { email, passwordOne, passwordTwo }
router.post("/register", logRoute, validateRegister, authCtrl.register);

// LOGIN
// body: { email (arba userName), password }
router.post("/login", logRoute, validateLogin, authCtrl.login);

// ME (requires JWT)
router.get("/me", logRoute, requireAuth, authCtrl.me);

// TOP-UP (requires JWT)
// body: { amount, note? }  — 1000 €/d. limitas (admin apeina)
router.post("/topup", logRoute, requireAuth, authCtrl.topup);

// Fallback šitam routeriui (Express 5 patikimiau su router.use)
router.use((req, res) => {
    console.warn(`[AUTH][ROUTE][404] ${req.method} ${req.originalUrl}`);
    res.status(404).json({ success: false, message: "Unknown auth route" });
});

module.exports = router;
