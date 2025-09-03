// controllers/blogController.js
const crypto = require("crypto");
const validator = require("email-validator");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Post = require("../models/Post");

// bcrypt su fallback į bcryptjs
let bcrypt;
try { bcrypt = require("bcrypt"); }
catch { bcrypt = require("bcryptjs"); }

const SALT_ROUNDS = Number(process.env.SALT_ROUNDS || 10);
const JWT_EXPIRES = process.env.JWT_EXPIRES || "24h";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "oskaraz@oskaraz.lt").toLowerCase();

const mask = (t) => (t && typeof t === "string" ? t.slice(0, 12) + "..." : "");

// helperis
const makeSecret = () =>
    (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));

function normalizePost(p) {
    const raw = typeof p.toJSON === "function" ? p.toJSON() : p;

    raw.id = String(raw.id || raw._id || "");
    delete raw._id;

    if (!raw.created_at) {
        const ts =
            raw.createdAt ||
            (raw._id && typeof raw._id.getTimestamp === "function" ? raw._id.getTimestamp() : null);
        raw.created_at = ts ? new Date(ts).toISOString() : null;
    }
    delete raw.createdAt;
    delete raw.updatedAt;
    delete raw.__v;

    // likes / comments metrika
    raw.likes_count = Array.isArray(raw.likes) ? raw.likes.length : 0;
    raw.comments_count = Array.isArray(raw.comments) ? raw.comments.length : 0;

    return raw;
}

// papildomai – jei yra reqUser, pažymim is_liked
function toClientPost(p, reqUser) {
    const out = normalizePost(p);
    if (reqUser && Array.isArray(out.likes)) {
        out.is_liked = out.likes.some((x) => String(x) === String(reqUser._id));
    }
    return out;
}

// JWT helperiai
function signToken(userLike) {
    const payload = {
        id: String(userLike._id),
        email: userLike.email,
        userName: userLike.userName || userLike.username, // dėl senos bazės
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES });
    console.log(`[JWT] issued user=${payload.id} (${payload.email}) exp=${JWT_EXPIRES} token=${mask(token)}`);
    return token;
}

async function getUserFromToken(req) {
    try {
        const hdr = req.headers.authorization || req.headers.Authorization || "";
        if (!hdr.startsWith("Bearer ")) {
            return null; // GET /posts gali būt be auth
        }
        const raw = hdr.slice(7);
        let decoded;
        try {
            decoded = jwt.verify(raw, process.env.JWT_SECRET);
        } catch (e) {
            console.warn(`[JWT] verify failed: ${e.name} ${e.message} token=${mask(raw)}`);
            return null;
        }
        if (!decoded?.id) {
            console.warn("[JWT] decoded but no id in payload");
            return null;
        }
        const u = await User.findById(decoded.id);
        if (u) console.log(`[JWT] verified user=${decoded.id} email=${decoded.email} token=${mask(raw)}`);
        return u || null;
    } catch (e) {
        console.warn("[JWT] unexpected error:", e);
        return null;
    }
}

module.exports = {
    health: (_req, res) => res.json({ ok: true, scope: "blog" }),

    // --- AUTH ---

    // POST /api/blog/register
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
            while (await User.exists({ $or: [{ userName }, { username: userName }] })) {
                userName = `${base}-${i++}`;
            }

            const passwordHash = await bcrypt.hash(p1, SALT_ROUNDS);

            const user = await User.create({
                userName,
                email,
                passwordHash,
                city: "Vilnius",
                secret: makeSecret(),
                // balance default = 1000 (schema), bet paliekam log'ą jeigu kažkas ne taip:
            });

            if (typeof user.balance !== "number") {
                console.warn("[AUTH][REGISTER] user.balance missing; setting to 1000");
                user.balance = 1000;
                await user.save();
            }

            const token = signToken(user);
            const is_admin = String(user.email || "").toLowerCase() === ADMIN_EMAIL;

            console.log(`[AUTH][REGISTER] OK user=${user._id} email=${user.email} is_admin=${is_admin} balance=${user.balance}€`);

            return res.json({
                success: true,
                token,
                user: {
                    id: String(user._id),
                    email: user.email,
                    userName: user.userName,
                    secret: user.secret,
                    balance: user.balance,
                    is_admin,
                },
            });
        } catch (err) {
            console.error("[BLOG][REGISTER] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // POST /api/blog/login
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
            // Re-fetch minimal fields for balance/admin flag if needed
            const fresh = await User.findById(user._id).select("email userName username balance").lean();
            const is_admin = String(fresh?.email || "").toLowerCase() === ADMIN_EMAIL;

            console.log(`[AUTH][LOGIN] OK user=${user._id} email=${fresh?.email} is_admin=${is_admin} balance=${fresh?.balance}€`);

            return res.json({
                success: true,
                token,
                user: {
                    id: String(user._id),
                    email: fresh?.email || user.email,
                    userName: fresh?.userName || user.userName || user.username,
                    secret: user.secret, // legacy laukas gali būti .lean() objekte
                    balance: typeof fresh?.balance === "number" ? fresh.balance : 1000,
                    is_admin,
                },
            });
        } catch (err) {
            console.error("[BLOG][LOGIN] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // --- POSTS ---

    // GET /api/blog/posts?order=desc|asc
    listPosts: async (req, res) => {
        try {
            const order = String(req.query.order || "desc").toLowerCase() === "asc" ? 1 : -1;

            const q = {};
            if (req.query.user_id) q.user = req.query.user_id;
            if (req.query.user_name) q.user_name = String(req.query.user_name).toLowerCase();

            const u = await getUserFromToken(req);

            const docs = await Post.find(q).sort({ createdAt: order, _id: order }).lean();
            const posts = docs.map((d) => toClientPost(d, u));

            return res.json({ success: true, order: order === 1 ? "asc" : "desc", count: posts.length, posts });
        } catch (err) {
            console.error("[BLOG] listPosts error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // POST /api/blog/posts
    createPost: async (req, res) => {
        try {
            const user = req.user; // iš requireAuth
            const { title, image_url, description } = req.body;

            const displayName =
                user.userName || user.username || (user.email ? String(user.email).split("@")[0] : "user");

            const created = await Post.create({
                title,
                image_url,
                description,
                user: user._id,
                user_email: user.email,
                user_name: displayName,
            });

            console.log(`[POST] created id=${created._id} by user=${user._id}`);
            return res.json({ success: true, post: toClientPost(created, user), message: "post created" });
        } catch (err) {
            console.error("[BLOG] createPost error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // PUT /api/blog/posts/:id
    updatePost: async (req, res) => {
        try {
            const set = req.updateSet; // iš validatePostUpdate
            const id = String(req.params.id);

            const updated = await Post.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: true });
            if (!updated) {
                return res.status(404).json({ success: false, message: "not found" });
            }

            console.log(`[POST] updated id=${id} by user=${req.user._id}`);
            return res.json({ success: true, post: toClientPost(updated, req.user), message: "post updated" });
        } catch (err) {
            console.error("[BLOG] updatePost error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // DELETE /api/blog/posts/:id
    deletePost: async (req, res) => {
        try {
            const id = String(req.params.id);
            await Post.deleteOne({ _id: id });
            console.log(`[POST] deleted id=${id} by user=${req.user._id}`);
            return res.json({ success: true, id, message: "post deleted" });
        } catch (err) {
            console.error("[BLOG] deletePost error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // --- POST LIKES ---

    likePost: async (req, res) => {
        try {
            const id = String(req.params.id);
            const uid = String(req.user?._id || "");
            if (!uid) return res.status(401).json({ success: false, message: "missing user" });

            console.log(`[LIKE] add by user=${uid} on post=${id}`);

            const updated = await Post.findByIdAndUpdate(
                id,
                { $addToSet: { likes: req.user._id } },
                { new: true, strict: false }
            );

            if (!updated) return res.status(404).json({ success: false, message: "post not found" });

            const out = toClientPost(updated, req.user);
            console.log(`[LIKE] ok post=${id} likes_count=${out.likes_count}`);
            return res.json({ success: true, post: out });
        } catch (err) {
            console.error("[LIKE] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    unlikePost: async (req, res) => {
        try {
            const id = String(req.params.id);
            const uid = String(req.user?._id || "");
            if (!uid) return res.status(401).json({ success: false, message: "missing user" });

            console.log(`[LIKE] remove by user=${uid} on post=${id}`);

            const updated = await Post.findByIdAndUpdate(
                id,
                { $pull: { likes: req.user._id } },
                { new: true, strict: false }
            );

            if (!updated) return res.status(404).json({ success: false, message: "post not found" });

            const out = toClientPost(updated, req.user);
            console.log(`[UNLIKE] ok post=${id} likes_count=${out.likes_count}`);
            return res.json({ success: true, post: out });
        } catch (err) {
            console.error("[UNLIKE] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    getLikes: async (req, res) => {
        try {
            const id = String(req.params.id);
            console.log(`[LIKES] list post=${id}`);

            const post = await Post.findById(id).lean();
            if (!post) return res.status(404).json({ success: false, message: "post not found" });

            const ids = Array.isArray(post.likes) ? post.likes.map(String) : [];
            if (!ids.length) return res.json({ success: true, count: 0, users: [] });

            const users = await User.find({ _id: { $in: ids } })
                .select("email userName username")
                .lean();

            const out = users.map((u) => ({
                id: String(u._id),
                userName: u.userName || u.username || (u.email ? String(u.email).split("@")[0] : "user"),
                email: u.email || "",
            }));

            console.log(`[LIKES] count=${out.length} post=${id}`);
            return res.json({ success: true, count: out.length, users: out });
        } catch (err) {
            console.error("[LIKES] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // --- COMMENTS (posts) ---

    getComments: async (req, res) => {
        try {
            const id = String(req.params.id);
            console.log(`[COMMENTS] list post=${id}`);

            const doc = await Post.findById(id, { comments: 1 }).lean();
            if (!doc) return res.status(404).json({ success: false, message: "post not found" });

            const comments = Array.isArray(doc.comments) ? doc.comments : [];
            const out = comments.map((c) => ({
                id: String(c._id),
                user: String(c.user),
                user_name: c.user_name || "user",
                user_email: c.user_email || "",
                text: c.text || "",
                created_at: c.created_at ? new Date(c.created_at).toISOString() : null,
            }));

            console.log(`[COMMENTS] count=${out.length} post=${id}`);
            return res.json({ success: true, count: out.length, comments: out });
        } catch (err) {
            console.error("[COMMENTS] list error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    addComment: async (req, res) => {
        try {
            const id = String(req.params.id);
            const text = String(req.body?.text || "").trim();
            const u = req.user;
            if (!u) return res.status(401).json({ success: false, message: "unauthorized" });
            if (!text) return res.status(400).json({ success: false, message: "empty comment" });

            const displayName = u.userName || u.username || (u.email ? String(u.email).split("@")[0] : "user");
            const comment = {
                user: u._id,
                user_name: displayName,
                user_email: u.email || "",
                text,
                created_at: new Date(),
            };

            console.log(`[COMMENTS] add by user=${u._id} post=${id} text="${text.slice(0, 60)}"`);
            const updated = await Post.findByIdAndUpdate(
                id,
                { $push: { comments: comment } },
                { new: true, runValidators: true }
            );
            if (!updated) return res.status(404).json({ success: false, message: "post not found" });

            const added = updated.comments[updated.comments.length - 1];
            const out = {
                id: String(added._id),
                user: String(added.user),
                user_name: added.user_name,
                user_email: added.user_email,
                text: added.text,
                created_at: added.created_at instanceof Date ? added.created_at.toISOString() : added.created_at,
            };

            console.log(`[COMMENTS] ok post=${id} total=${updated.comments.length}`);
            return res.json({ success: true, comment: out, comments_count: updated.comments.length });
        } catch (err) {
            console.error("[COMMENTS] add error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // ===================================================================
    // ====================== USERS / POKES DALIS =========================
    // ===================================================================

    // GET /api/blog/users?order=desc|asc
    listUsers: async (req, res) => {
        try {
            const order = String(req.query.order || "desc").toLowerCase() === "asc" ? 1 : -1;
            const docs = await User.find({})
                .sort({ createdAt: order, _id: order })
                .lean();

            const users = docs.map((u) => ({
                id: String(u._id),
                userName: u.userName || u.username || (u.email ? u.email.split("@")[0] : "user"),
                email: u.email || "",
                avatar_url: u.avatar_url || "",
                phone: u.phone || "",
                created_at: u.createdAt
                    ? new Date(u.createdAt).toISOString()
                    : (u._id?.getTimestamp?.() ? new Date(u._id.getTimestamp()).toISOString() : null),
                // kiek kartų šis useris buvo "poke'intas"
                pokes_count: Array.isArray(u.pokes) ? u.pokes.length : 0,
            }));

            return res.json({ success: true, order: order === 1 ? "asc" : "desc", count: users.length, users });
        } catch (err) {
            console.error("[USERS] listUsers error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // POST /api/blog/users/:id/poke
    // politika: savęs "poke'inti" negalima; kitą userį – tik vieną kartą.
    pokeUser: async (req, res) => {
        try {
            const targetId = String(req.params.id || "");
            const me = req.user;
            if (!me?._id) return res.status(401).json({ success: false, message: "unauthorized" });
            if (!targetId) return res.status(400).json({ success: false, message: "missing id" });
            if (String(me._id) === targetId) {
                return res.status(400).json({ success: false, message: "cannot poke yourself" });
            }

            const target = await User.findById(targetId).select("pokes").lean();
            if (!target) return res.status(404).json({ success: false, message: "user not found" });

            // Suderinamumas su User.pokes: [{ user: ObjectId, created_at: Date }]
            const already = Array.isArray(target.pokes)
                ? target.pokes.some((p) => String(p?.user) === String(me._id))
                : false;

            if (already) {
                // idempotent: jau yra – nieko nebedarom
                console.log(`[USERS][POKE] already poked by=${me._id} target=${targetId}`);
                return res.json({ success: true, already: true, message: "already poked" });
            }

            // pirmas kartas – užfiksuojam
            const push = { user: me._id, created_at: new Date() };
            await User.findByIdAndUpdate(
                targetId,
                { $push: { pokes: push } },
                { new: false, strict: false }
            );

            console.log(`[USERS][POKE] ok by=${me._id} target=${targetId}`);
            return res.json({ success: true, message: "poked" });
        } catch (err) {
            console.error("[USERS] pokeUser error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // GET /api/blog/users/:id/pokes   (palaikytojai + kada)
    // Palaiko ir "me": jei id == "me", iš JWT paimam savo id.
    getUserPokes: async (req, res) => {
        try {
            let id = String(req.params.id || "");
            // jei "me" – bandom iš JWT / req.user
            if (id === "me") {
                const me = req.user || (await getUserFromToken(req));
                if (!me?._id) return res.status(401).json({ success: false, message: "unauthorized" });
                id = String(me._id);
            }

            const doc = await User.findById(id).select("pokes").lean();
            if (!doc) return res.status(404).json({ success: false, message: "user not found" });

            const arr = Array.isArray(doc.pokes) ? doc.pokes : [];

            const fromIds = [...new Set(arr.map((p) => String(p.user)).filter(Boolean))];
            let fromUsers = [];
            if (fromIds.length) {
                fromUsers = await User.find({ _id: { $in: fromIds } })
                    .select("userName username email avatar_url")
                    .lean();
            }
            const map = new Map(
                fromUsers.map((u) => [
                    String(u._id),
                    {
                        id: String(u._id),
                        userName: u.userName || u.username || (u.email ? u.email.split("@")[0] : "user"),
                        email: u.email || "",
                        avatar_url: u.avatar_url || "",
                    },
                ])
            );

            const out = arr
                .map((p) => {
                    const info = map.get(String(p.user)) || { id: String(p.user), userName: "user", email: "", avatar_url: "" };
                    return {
                        id: info.id,
                        userName: info.userName,
                        email: info.email,
                        avatar_url: info.avatar_url,
                        at: p.created_at ? new Date(p.created_at).toISOString() : null,
                    };
                })
                .sort((a, b) => {
                    const ta = a.at ? new Date(a.at).getTime() : 0;
                    const tb = b.at ? new Date(b.at).getTime() : 0;
                    return tb - ta; // naujausi viršuje
                });

            console.log(`[USERS][POKES] count=${out.length} target=${id}`);
            return res.json({ success: true, count: out.length, pokes: out });
        } catch (err) {
            console.error("[USERS] getUserPokes error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // PUT /api/blog/users/me  (profilio atnaujinimas)
    updateMe: async (req, res) => {
        try {
            const me = req.user || (await getUserFromToken(req));
            if (!me?._id) return res.status(401).json({ success: false, message: "unauthorized" });

            const set = {};
            const { userName, avatar_url, phone, city } = req.body || {};
            if (typeof userName === "string") set.userName = userName.trim();
            if (typeof avatar_url === "string") set.avatar_url = avatar_url.trim();
            if (typeof phone === "string") set.phone = phone.trim();
            if (typeof city === "string") set.city = city.trim();

            if (!Object.keys(set).length) {
                return res.json({ success: true, message: "nothing to update" });
            }

            const updated = await User.findByIdAndUpdate(
                me._id,
                { $set: set },
                { new: true, strict: false }
            ).lean();

            console.log(`[USERS][UPDATE_ME] user=${me._id} set=${JSON.stringify(set)}`);

            return res.json({
                success: true,
                user: {
                    id: String(updated._id),
                    userName: updated.userName || updated.username || (updated.email ? updated.email.split("@")[0] : "user"),
                    email: updated.email || "",
                    avatar_url: updated.avatar_url || "",
                    phone: updated.phone || "",
                    city: updated.city || "",
                },
            });
        } catch (err) {
            console.error("[USERS] updateMe error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },
};
