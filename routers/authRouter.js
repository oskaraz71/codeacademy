// routers/authRouter.js
const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth'); // JWT middleware
const User = require('../models/User');

// konvertuojam į saugų user objektą
function toClient(u) {
    return {
        id: u._id,
        username: u.username,
        email: u.email,
        phone: u.phone || "",
        avatar: u.avatar || "",
        balance: Number(u.balance ?? u.money ?? 0),
        role: u.role || "user",
    };
}

// GET /api/auth/me  -> reikia Bearer token
router.get('/me', auth, async (req, res) => {
    const u = await User.findById(req.user.id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({ user: toClient(u) });
});

// PATCH /api/auth/me -> atnaujint leidžiam tik šiuos laukus
router.patch('/me', auth, async (req, res) => {
    const allow = ['username', 'email', 'phone', 'avatar', 'money', 'balance'];
    const patch = {};
    for (const k of allow) if (req.body[k] !== undefined) patch[k] = req.body[k];

    const u = await User.findByIdAndUpdate(req.user.id, patch, { new: true });
    if (!u) return res.status(404).json({ error: 'User not found' });
    res.json({ user: toClient(u) });
});

module.exports = router;
