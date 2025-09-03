// controllers/authController.js
const validator = require("email-validator");
const jwt = require("jsonwebtoken");
const { DateTime } = require("luxon");
const User = require("../models/User");

// bcrypt su fallback į bcryptjs
let bcrypt;
try { bcrypt = require("bcrypt"); }
catch { bcrypt = require("bcryptjs"); }

const SALT_ROUNDS = Number(process.env.SALT_ROUNDS || 10);
const JWT_EXPIRES = process.env.JWT_EXPIRES || "24h";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "oskaraz@oskaraz.lt").toLowerCase();

const mask = (t) => (t && typeof t === "string" ? t.slice(0, 12) + "..." : "");
const isAdminEmail = (email) => String(email || "").toLowerCase() === ADMIN_EMAIL;

// --------------------------------------------------
// Helpers
// --------------------------------------------------
function signToken(userDoc) {
    const payload = {
        id: String(userDoc._id),
        email: userDoc.email,
        userName: userDoc.userName || userDoc.username,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES });
    console.log(`[AUTH][JWT] issued user=${payload.id} email=${payload.email} exp=${JWT_EXPIRES} token=${mask(token)}`);
    return token;
}

async function getUserFromRequest(req) {
    try {
        const hdr = req.headers.authorization || req.headers.Authorization || "";
        if (!hdr || !hdr.startsWith("Bearer ")) {
            console.warn("[AUTH][ME] missing Bearer token");
            return null;
        }
        const raw = hdr.slice(7);
        let decoded;
        try {
            decoded = jwt.verify(raw, process.env.JWT_SECRET);
        } catch (e) {
            console.warn(`[AUTH][ME] token verify failed: ${e.name} ${e.message} token=${mask(raw)}`);
            return null;
        }
        const u = await User.findById(decoded.id);
        if (!u) {
            console.warn(`[AUTH][ME] user not found id=${decoded.id}`);
            return null;
        }
        console.log(`[AUTH][ME] verified user=${decoded.id} email=${decoded.email}`);
        return u;
    } catch (e) {
        console.error("[AUTH][ME] unexpected error:", e);
        return null;
    }
}

function toClientUser(u) {
    return {
        id: String(u._id),
        email: u.email,
        userName: u.userName || u.username || (u.email ? String(u.email).split("@")[0] : "user"),
        balance: typeof u.balance === "number" ? Math.round(u.balance * 100) / 100 : 1000,
        is_admin: isAdminEmail(u.email),
        avatar_url: u.avatar_url || "",
        phone: u.phone || "",
        city: u.city || "",
    };
}

function todayWindowVilnius() {
    const now = DateTime.now().setZone("Europe/Vilnius");
    return {
        start: now.startOf("day").toJSDate(),
        end: now.endOf("day").toJSDate(),
    };
}

// --------------------------------------------------
// Controllers
// --------------------------------------------------
module.exports = {
    // POST /api/auth/register
    register: async (req, res) => {
        try {
            const email = String(req.body?.email || "").trim().toLowerCase();
            const p1 = String(req.body?.passwordOne || "");
            const p2 = String(req.body?.passwordTwo || "");

            console.log("[AUTH][REGISTER] email=%s len(p1)=%s len(p2)=%s", email, p1.length, p2.length);

            if (!validator.validate(email)) {
                return res.json({ success: false, message: "bad email" });
            }
            if (!p1 || !p2) {
                return res.json({ success: false, message: "missing passwords" });
            }
            if (p1 !== p2) {
                return res.json({ success: false, message: "passwords do not match" });
            }
            if (await User.exists({ email })) {
                return res.json({ success: false, message: "email already exists" });
            }

            const base = email.split("@")[0];
            let userName = base.toLowerCase().replace(/\s+/g, "-");
            let i = 2;
            // unikalus userName / legacy username
            while (await User.exists({ $or: [{ userName }, { username: userName }] })) {
                userName = `${base}-${i++}`;
            }

            const passwordHash = await bcrypt.hash(p1, SALT_ROUNDS);

            const user = await User.create({
                userName,
                email,
                passwordHash,
                // balance pagal schema default 1000 €
            });

            if (typeof user.balance !== "number") {
                console.warn("[AUTH][REGISTER] balance missing; forcing 1000€");
                user.balance = 1000;
                await user.save();
            }

            const token = signToken(user);
            const out = toClientUser(user);
            console.log(`[AUTH][REGISTER] OK user=${out.id} admin=${out.is_admin} balance=${out.balance}€`);
            return res.json({ success: true, token, user: out });
        } catch (err) {
            console.error("[AUTH][REGISTER] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // POST /api/auth/login
    login: async (req, res) => {
        try {
            const identifier = String(req.body?.email || "").trim().toLowerCase();
            const password = String(req.body?.password || "");
            console.log("[AUTH][LOGIN] identifier=%s len(password)=%s", identifier, password.length);

            const user = await User.findOne({
                $or: [{ email: identifier }, { userName: identifier }, { username: identifier }],
            })
                .select("+password +passwordHash")
                .lean();

            if (!user) {
                console.log("[AUTH][LOGIN] user not found");
                return res.json({ success: false, message: "bad credentials" });
            }

            let ok = false;
            if (user.passwordHash) {
                ok = await bcrypt.compare(password, user.passwordHash);
            } else if (user.password) {
                ok = user.password === password; // legacy plaintext
                if (ok) {
                    // migracija į hash
                    const newHash = await bcrypt.hash(password, SALT_ROUNDS);
                    await User.updateOne(
                        { _id: user._id },
                        { $set: { passwordHash: newHash }, $unset: { password: 1 } }
                    );
                    console.log("[AUTH][LOGIN] migrated legacy password -> passwordHash");
                }
            }

            if (!ok) {
                console.log("[AUTH][LOGIN] bad password for user=%s", user._id);
                return res.json({ success: false, message: "bad credentials" });
            }

            const token = signToken(user);
            // pasiimam šviežius laukus (balance ir pan.)
            const fresh = await User.findById(user._id).lean();
            const out = toClientUser(fresh || user);

            console.log(`[AUTH][LOGIN] OK user=${out.id} admin=${out.is_admin} balance=${out.balance}€`);
            return res.json({ success: true, token, user: out });
        } catch (err) {
            console.error("[AUTH][LOGIN] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // GET /api/auth/me
    me: async (req, res) => {
        try {
            // jei middleware requireAuth sukelta – turėsim req.user, bet padarom ir fallback per JWT
            const user = req.user || (await getUserFromRequest(req));
            if (!user) {
                return res.status(401).json({ success: false, message: "unauthorized" });
            }
            const out = toClientUser(user);
            console.log(`[AUTH][ME] user=${out.id} admin=${out.is_admin} balance=${out.balance}€`);
            return res.json({ success: true, user: out });
        } catch (err) {
            console.error("[AUTH][ME] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // POST /api/auth/topup   { amount, note? }
    // - 1000 €/d. limitas pagal Europe/Vilnius (00:00–23:59)
    // - Admin gali apeiti limitą
    // - Refund'ai iš rezervacijų į limitą nesiskaičiuoja (mes jų čia net nefiksuojam)
    topup: async (req, res) => {
        try {
            const user = req.user || (await getUserFromRequest(req));
            if (!user) {
                return res.status(401).json({ success: false, message: "unauthorized" });
            }
            const isAdmin = isAdminEmail(user.email);

            const rawAmount = Number(req.body?.amount);
            const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
            const amount = Math.round((isFinite(rawAmount) ? rawAmount : 0) * 100) / 100;

            console.log(`[AUTH][TOPUP] user=${user._id} email=${user.email} isAdmin=${isAdmin} amount=${amount}€ note="${note}"`);

            if (!isFinite(amount) || amount <= 0) {
                return res.status(400).json({ success: false, message: "amount must be > 0" });
            }
            if (amount > 1000000) {
                // sanity check
                return res.status(400).json({ success: false, message: "amount too large" });
            }

            // limitas – tik jei ne admin
            if (!isAdmin) {
                const fresh = await User.findById(user._id).select("+topups balance email").lean();
                const { start, end } = todayWindowVilnius();
                const todays = Array.isArray(fresh.topups)
                    ? fresh.topups.filter(t => {
                        const ts = t && t.created_at ? new Date(t.created_at) : null;
                        return ts && ts >= start && ts <= end;
                    })
                    : [];
                const used = todays.reduce((sum, t) => sum + Number(t.amount || 0), 0);
                const remaining = Math.max(0, 1000 - used);

                console.log(`[AUTH][TOPUP] limit check used=${used}€ remaining=${remaining}€ (Vilnius day)`);

                if (amount > remaining) {
                    return res.status(400).json({
                        success: false,
                        message: `Daily top-up limit exceeded. Remaining today: ${remaining.toFixed(2)}€`,
                        remaining: Number(remaining.toFixed(2)),
                    });
                }
            }

            // Atliekam atnaujinimą: pridedam balance, įrašom į topups (su select:false)
            const pushEntry = { amount, created_at: new Date(), note };
            const updated = await User.findByIdAndUpdate(
                user._id,
                { $inc: { balance: amount }, $push: { topups: pushEntry } },
                { new: true }
            ).lean();

            const out = toClientUser(updated);
            console.log(`[AUTH][TOPUP] OK user=${out.id} newBalance=${out.balance}€ amount=${amount}€`);
            return res.json({
                success: true,
                user: out,
                topup: { amount, created_at: pushEntry.created_at.toISOString(), note },
            });
        } catch (err) {
            console.error("[AUTH][TOPUP] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },
};
