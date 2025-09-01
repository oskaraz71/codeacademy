// controllers/blogController.js
const crypto = require("crypto");
const validator = require("email-validator");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Post = require("../models/Post");

let bcrypt; try { bcrypt = require("bcrypt"); } catch { bcrypt = require("bcryptjs"); }
const SALT_ROUNDS = Number(process.env.SALT_ROUNDS || 10);

const makeSecret = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));
const maskToken = (t) => (t && typeof t === "string" ? t.slice(0, 12) + "..." : "");

function signToken(user) {
    const payload = { id: String(user._id), email: user.email, userName: user.userName || user.username };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
    console.log(`[JWT] issued token for user=${payload.id} (${payload.email}) token=${maskToken(token)}`);
    return token;
}

async function getUserFromToken(req) {
    try {
        const hdr = req.headers.authorization || req.headers.Authorization || "";
        if (!hdr.startsWith("Bearer ")) return null;
        const raw = hdr.slice(7);
        let decoded;
        try { decoded = jwt.verify(raw, process.env.JWT_SECRET); }
        catch (e) { console.warn(`[JWT] verify failed: ${e.name} ${e.message}`); return null; }
        if (!decoded?.id) return null;
        const u = await User.findById(decoded.id);
        if (u) console.log(`[JWT] verified user=${decoded.id} email=${decoded.email} token=${maskToken(raw)}`);
        return u || null;
    } catch (e) {
        console.warn("[JWT] unexpected error:", e);
        return null;
    }
}

function normalizePost(p) {
    const raw = typeof p.toJSON === "function" ? p.toJSON() : p;
    raw.id = String(raw.id || raw._id || ""); delete raw._id;

    if (!raw.created_at) {
        const ts = raw.createdAt || (raw._id && typeof raw._id.getTimestamp === "function" ? raw._id.getTimestamp() : null);
        raw.created_at = ts ? new Date(ts).toISOString() : null;
    }
    delete raw.createdAt; delete raw.updatedAt; delete raw.__v;

    raw.likes_count    = Array.isArray(raw.likes)    ? raw.likes.length    : 0;
    raw.comments_count = Array.isArray(raw.comments) ? raw.comments.length : 0;
    return raw;
}
function toClientPost(p, reqUser) {
    const out = normalizePost(p);
    if (reqUser && Array.isArray(out.likes)) out.is_liked = out.likes.some((x) => String(x) === String(reqUser._id));
    return out;
}

function normalizeUser(u) {
    const raw = typeof u.toJSON === "function" ? u.toJSON() : u;
    raw.id = String(raw.id || raw._id || ""); delete raw._id;

    if (!raw.created_at) {
        const ts = raw.createdAt || (u && u._id && typeof u._id.getTimestamp === "function" ? u._id.getTimestamp() : null);
        raw.created_at = ts ? new Date(ts).toISOString() : null;
    }
    delete raw.createdAt; delete raw.updatedAt; delete raw.__v;

    raw.userName = raw.userName || raw.username || (raw.email ? String(raw.email).split("@")[0] : "user");
    raw.phone    = raw.phone || raw.phoneNumber || raw.mobile || "";
    raw.avatar   = raw.avatar || raw.photo || "";
    raw.likes_count = Array.isArray(raw.likes) ? raw.likes.length : 0;

    return raw;
}

module.exports = {
    health: (_req, res) => res.json({ ok: true, scope: "blog" }),

    // ---------- USERS (su logais) ----------
    listUsers: async (req, res) => {
        try {
            const asc = String(req.query.order || "desc").toLowerCase() === "asc";
            console.log(`[USERS] listUsers hit (order=${asc ? "asc" : "desc"})`);

            const docs = await User
                .find({}, { email: 1, userName: 1, username: 1, phone: 1, avatar: 1, createdAt: 1, likes: 1 })
                .sort({ createdAt: asc ? 1 : -1, _id: asc ? 1 : -1 })
                .lean();

            const users = (docs || []).map(normalizeUser);
            console.log(`[USERS] listUsers -> ${users.length} users`);
            return res.json({ success: true, order: asc ? "asc" : "desc", count: users.length, users });
        } catch (err) {
            console.error("[USERS] listUsers error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // ---------- AUTH ----------
    register: async (req, res) => {
        try {
            const email = String(req.body?.email || "").trim().toLowerCase();
            const p1 = String(req.body?.passwordOne || "");
            const p2 = String(req.body?.passwordTwo || "");
            if (!validator.validate(email)) return res.json({ success: false, message: "bad email" });
            if (!p1 || !p2) return res.json({ success: false, message: "missing passwords" });
            if (p1 !== p2) return res.json({ success: false, message: "passwords do not match" });
            if (await User.exists({ email })) return res.json({ success: false, message: "email already exists" });

            const base = email.split("@")[0];
            let userName = base.toLowerCase().replace(/\s+/g, "-");
            let i = 2;
            while (await User.exists({ $or: [{ userName }, { username: userName }] })) userName = `${base}-${i++}`;

            const passwordHash = await bcrypt.hash(p1, SALT_ROUNDS);
            const user = await User.create({ userName, email, passwordHash, city: "Vilnius", secret: makeSecret() });
            const token = signToken(user);
            console.log(`[AUTH] register OK user=${user._id} email=${user.email}`);

            return res.json({ success: true, token, user: { id: String(user._id), email: user.email, userName: user.userName, secret: user.secret } });
        } catch (err) {
            console.error("[BLOG] register error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    login: async (req, res) => {
        try {
            const identifier = String(req.body?.email || "").trim().toLowerCase();
            const password = String(req.body?.password || "");
            console.log(`[AUTH] login attempt ${identifier}`);

            const user = await User.findOne({ $or: [{ email: identifier }, { userName: identifier }, { username: identifier }] })
                .select("+password +passwordHash")
                .lean();

            if (!user) return res.json({ success: false, message: "bad credentials" });

            let ok = false;
            if (user.passwordHash) ok = await bcrypt.compare(password, user.passwordHash);
            else if (user.password) {
                ok = user.password === password;
                if (ok) await User.updateOne({ _id: user._id }, { $set: { passwordHash: await bcrypt.hash(password, SALT_ROUNDS) }, $unset: { password: 1 } });
            }
            if (!ok) return res.json({ success: false, message: "bad credentials" });

            const token = signToken(user);
            console.log(`[AUTH] login OK user=${user._id} email=${user.email}`);
            return res.json({ success: true, token, user: { id: String(user._id), email: user.email, userName: user.userName || user.username, secret: user.secret } });
        } catch (err) {
            console.error("[BLOG] login error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // ---------- POSTS (palikta kaip turėjai) ----------
    listPosts: async (req, res) => {
        try {
            const order = String(req.query.order || "desc").toLowerCase() === "asc" ? 1 : -1;
            const q = {};
            if (req.query.user_id)   q.user = req.query.user_id;
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

    createPost: async (req, res) => {
        try {
            const user = req.user;
            const { title, image_url, description } = req.body;
            const displayName = user.userName || user.username || (user.email ? String(user.email).split("@")[0] : "user");
            const created = await Post.create({ title, image_url, description, user: user._id, user_email: user.email, user_name: displayName });
            console.log(`[POST] created id=${created._id} by user=${user._id}`);
            return res.json({ success: true, post: toClientPost(created, user), message: "post created" });
        } catch (err) {
            console.error("[BLOG] createPost error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    updatePost: async (req, res) => {
        try {
            const set = req.updateSet;
            const id = String(req.params.id);
            const updated = await Post.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: true });
            if (!updated) return res.status(404).json({ success: false, message: "not found" });
            console.log(`[POST] updated id=${id} by user=${req.user._id}`);
            return res.json({ success: true, post: toClientPost(updated, req.user), message: "post updated" });
        } catch (err) {
            console.error("[BLOG] updatePost error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

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

    likePost: async (req, res) => {
        try {
            const id = String(req.params.id);
            const uid = String(req.user?._id || "");
            if (!uid) return res.status(401).json({ success: false, message: "missing user" });
            const updated = await Post.findByIdAndUpdate(id, { $addToSet: { likes: req.user._id } }, { new: true, strict: false });
            if (!updated) return res.status(404).json({ success: false, message: "post not found" });
            const out = toClientPost(updated, req.user);
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
            const updated = await Post.findByIdAndUpdate(id, { $pull: { likes: req.user._id } }, { new: true, strict: false });
            if (!updated) return res.status(404).json({ success: false, message: "post not found" });
            const out = toClientPost(updated, req.user);
            return res.json({ success: true, post: out });
        } catch (err) {
            console.error("[UNLIKE] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    getLikes: async (req, res) => {
        try {
            const id = String(req.params.id);
            const post = await Post.findById(id).lean();
            if (!post) return res.status(404).json({ success: false, message: "post not found" });
            const ids = Array.isArray(post.likes) ? post.likes.map(String) : [];
            if (!ids.length) return res.json({ success: true, count: 0, users: [] });
            const users = await User.find({ _id: { $in: ids } }).select("email userName username").lean();
            const out = users.map((u) => ({
                id: String(u._id),
                userName: u.userName || u.username || (u.email ? String(u.email).split("@")[0] : "user"),
                email: u.email || "",
            }));
            return res.json({ success: true, count: out.length, users: out });
        } catch (err) {
            console.error("[LIKES] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    getComments: async (req, res) => {
        try {
            const id = String(req.params.id);
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
            const comment = { user: u._id, user_name: displayName, user_email: u.email || "", text, created_at: new Date() };

            const updated = await Post.findByIdAndUpdate(id, { $push: { comments: comment } }, { new: true, runValidators: true });
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
            return res.json({ success: true, comment: out, comments_count: updated.comments.length });
        } catch (err) {
            console.error("[COMMENTS] add error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },
};
