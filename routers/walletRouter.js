const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const User = require("../models/User");

const router = express.Router();

/**
 * POST /api/wallet/deposit  body: { amount, note? }
 */
router.post("/deposit", requireAuth, async (req, res) => {
    let amount = Number(req.body?.amount || 0);
    const note = (req.body?.note || "").trim();
    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "amount>0" });
    }

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Dienos limitas: 1000, išskyrus admin
    const isAdmin = typeof user.isAdmin === "function" ? user.isAdmin() : false;
    if (!isAdmin) {
        const left = user.remainingTopupToday(1000);
        if (amount > left) {
            return res.status(400).json({ error: `Daily top-up limit exceeded. Left today: €${left}` });
        }
    }

    user.balance = Number(user.balance || 0) + amount;
    user.topups.push({ amount, note });
    await user.save();

    res.json({ ok: true, balance: user.balance });
});

module.exports = router;
