// server/routers/reservationRouter.js
const express = require("express");
const mongoose = require("mongoose");
const requireAuth = require("../middleware/requireAuth");
const Product = require("../models/Product");
const User = require("../models/User");

const router = express.Router();

// Greitam patikrinimui: ar šitas routeris apskritai pasiekimas
router.get("/health", (req, res) => {
    console.log("[RESERVATIONS][HEALTH] OK");
    res.json({ ok: true, route: "/api/reservations/*" });
});

/**
 * POST /api/reservations
 * body: { productId, reservedUntil }
 * Sėkmė → { ok: true, product, balance }
 */
router.post("/", requireAuth, async (req, res) => {
    console.log("=== [RES][POST /api/reservations] START ===");
    console.log("[RES] headers.authorization =", req.headers?.authorization ? "present" : "missing");
    console.log("[RES] body =", req.body);

    const { productId, reservedUntil } = req.body || {};
    if (!productId || !mongoose.isValidObjectId(productId)) {
        console.log("[RES] BAD productId:", productId);
        return res.status(400).json({ error: "Bad productId" });
    }

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            console.log("[RES] req.user.id =", req.user?.id);

            const user = await User.findById(req.user.id).session(session);
            if (!user) {
                console.log("[RES] User not found");
                return res.status(404).json({ error: "User not found" });
            }
            console.log("[RES] User balance BEFORE =", user.balance);

            const product = await Product.findById(productId).session(session);
            if (!product) {
                console.log("[RES] Product not found:", productId);
                return res.status(404).json({ error: "Product not found" });
            }

            if (product.is_reserved) {
                console.log("[RES] Product already reserved");
                return res.status(409).json({ error: "Already reserved" });
            }

            const price = Number(product.price || 0);
            const have = Number(user.balance || 0);
            console.log("[RES] price =", price, "have =", have);

            if (!Number.isFinite(price) || price < 0) {
                console.log("[RES] Invalid price");
                return res.status(400).json({ error: "Invalid price" });
            }
            if (have < price) {
                console.log("[RES] Insufficient funds");
                return res.status(400).json({ error: "insufficient funds", need: price, have });
            }

            // pažymim produktą rezervuotu
            product.is_reserved = true;
            product.reserved_by = user._id;
            product.reserved_until = reservedUntil
                ? new Date(reservedUntil)
                : new Date(Date.now() + 24 * 3600 * 1000);
            await product.save({ session });

            // atimam kainą iš balanso
            user.balance = have - price;
            user.balanceUpdatedAt = new Date();
            await user.save({ session });

            console.log("[RES] SUCCESS product =", product._id, "new balance =", user.balance);

            return res.json({ ok: true, product: product.toJSON(), balance: user.balance });
        });
    } catch (e) {
        console.error("[RES] ERROR:", e);
        return res.status(500).json({ error: "Reservation failed" });
    } finally {
        session.endSession();
        console.log("=== [RES][POST /api/reservations] END ===");
    }
});

/**
 * GET /api/reservations/mine
 */
router.get("/mine", requireAuth, async (req, res) => {
    console.log("[RES][GET /mine] user.id =", req.user?.id);
    try {
        const items = await Product.find({
            is_reserved: true,
            reserved_by: req.user.id,
        }).sort({ reserved_until: -1 });

        console.log("[RES][GET /mine] count =", items.length);
        res.json({ ok: true, count: items.length, products: items.map(p => p.toJSON()) });
    } catch (e) {
        console.error("[RES][MINE] error:", e);
        res.status(500).json({ error: "Fetch failed" });
    }
});

/**
 * DELETE /api/reservations/:productId
 * (jei reikės atšaukti ir grąžinti €)
 */
router.delete("/:productId", requireAuth, async (req, res) => {
    const { productId } = req.params || {};
    console.log("[RES][DELETE] productId =", productId, "user.id =", req.user?.id);

    if (!productId || !mongoose.isValidObjectId(productId)) {
        return res.status(400).json({ error: "Bad productId" });
    }

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const user = await User.findById(req.user.id).session(session);
            if (!user) return res.status(404).json({ error: "User not found" });

            const product = await Product.findById(productId).session(session);
            if (!product) return res.status(404).json({ error: "Product not found" });

            if (!product.is_reserved || String(product.reserved_by) !== String(user._id)) {
                console.log("[RES][DELETE] not reserved by user");
                return res.status(409).json({ error: "Not reserved by you" });
            }

            const price = Number(product.price || 0);
            product.is_reserved = false;
            product.reserved_by = null;
            product.reserved_until = null;
            await product.save({ session });

            user.balance = Number(user.balance || 0) + (Number.isFinite(price) ? price : 0);
            user.balanceUpdatedAt = new Date();
            await user.save({ session });

            console.log("[RES][DELETE] success, balance =", user.balance);
            return res.json({ ok: true, product: product.toJSON(), balance: user.balance });
        });
    } catch (e) {
        console.error("[RES][DELETE] error:", e);
        res.status(500).json({ error: "Cancel failed" });
    } finally {
        session.endSession();
    }
});

module.exports = router;
