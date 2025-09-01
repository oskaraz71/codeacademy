const jwt = require("jsonwebtoken");
const validator = require("email-validator");
const User = require("../models/User");
const Post = require("../models/Post");

const asyncMw = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const mask = (t) => (t && typeof t === "string" ? t.slice(0, 12) + "..." : "");

/** JWT (naudojam POST/PUT/DELETE) */
const requireAuth = asyncMw(async (req, res, next) => {
    const h = req.headers.authorization || req.headers.Authorization || "";
    const hasBearer = h.startsWith("Bearer ");
    console.log(`[MW][AUTH] ${req.method} ${req.path} header=${hasBearer ? "present" : "missing"}`);
    if (!hasBearer) return res.status(401).json({ success: false, message: "missing token" });

    const token = h.slice(7);
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        console.log(`[MW][AUTH] token ok sub=${payload.id} email=${payload.email} token=${mask(token)}`);
        const user = await User.findById(payload.id);
        if (!user) {
            console.warn(`[MW][AUTH] user not found id=${payload.id}`);
            return res.status(401).json({ success: false, message: "invalid user" });
        }
        req.user = user;
        next();
    } catch (e) {
        console.warn(`[MW][AUTH] verify failed ${e.name}: ${e.message} token=${mask(token)}`);
        return res.status(401).json({ success: false, message: "invalid/expired token" });
    }
});

/** REGISTER – bazinė validacija */
const validateRegister = (req, res, next) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const p1 = String(req.body?.passwordOne || "");
    const p2 = String(req.body?.passwordTwo || "");
    console.log(`[MW][REGISTER] email=${email} len(p1)=${p1.length} len(p2)=${p2.length}`);
    if (!validator.validate(email)) return res.json({ success: false, message: "bad email" });
    if (!p1 || !p2) return res.json({ success: false, message: "missing passwords" });
    if (p1 !== p2) return res.json({ success: false, message: "passwords do not match" });
    req.body.email = email;
    next();
};

/** LOGIN – bazinė validacija */
const validateLogin = (req, res, next) => {
    const identifier = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    console.log(`[MW][LOGIN] identifier=${identifier} len(password)=${password.length}`);
    if (!identifier || !password) return res.json({ success: false, message: "missing credentials" });
    req.body.email = identifier;
    next();
};

/** CREATE – privalomi laukai */
const validatePostCreate = (req, res, next) => {
    const title = String(req.body?.title || "").trim();
    const image_url = String(req.body?.image_url || "").trim();
    const description = String(req.body?.description || "").trim();
    console.log(`[MW][POST][CREATE_VALID] title=${!!title} image_url=${!!image_url} description=${!!description}`);
    if (!title || !image_url || !description) {
        return res.status(400).json({ success: false, message: "required: title, image_url, description" });
    }
    req.body.title = title;
    req.body.image_url = image_url;
    req.body.description = description;
    next();
};

/** UPDATE – bent vienas laukas; set -> req.updateSet */
const validatePostUpdate = (req, res, next) => {
    const set = {};
    if (typeof req.body?.title === "string") set.title = req.body.title.trim();
    if (typeof req.body?.image_url === "string") set.image_url = req.body.image_url.trim();
    if (typeof req.body?.description === "string") set.description = req.body.description.trim();
    Object.keys(set).forEach((k) => {
        if (!set[k]) delete set[k];
    });
    console.log(`[MW][POST][UPDATE_VALID] fields=${Object.keys(set).join(",") || "none"}`);
    if (!Object.keys(set).length) {
        return res.status(400).json({ success: false, message: "nothing to update" });
    }
    req.updateSet = set;
    next();
};

/** Nuosavybės tikrinimas pagal :id (po requireAuth) */
const requireOwnership = asyncMw(async (req, res, next) => {
    const id = String(req.params.id || "");
    const post = await Post.findById(id);
    if (!post) {
        console.warn(`[MW][OWNERSHIP] post not found id=${id}`);
        return res.status(404).json({ success: false, message: "post not found" });
    }
    const isOwner = String(post.user) === String(req.user?._id);
    console.log(`[MW][OWNERSHIP] id=${id} user=${req.user?._id} isOwner=${isOwner}`);
    if (!isOwner) return res.status(403).json({ success: false, message: "not your post" });
    req.post = post;
    next();
});

module.exports = {
    requireAuth,
    validateRegister,
    validateLogin,
    validatePostCreate,
    validatePostUpdate,
    requireOwnership,
};
