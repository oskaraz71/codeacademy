// controllers/productController.js
const Product = require("../models/Product");
const Reservation = require("../models/Reservation");
const User = require("../models/User");

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "oskaraz@oskaraz.lt").toLowerCase();
const MAX_LIMIT = 50;

const isAdminEmail = (email) => String(email || "").toLowerCase() === ADMIN_EMAIL;

// --------------------------------------------------
// Helpers
// --------------------------------------------------
function toClientProduct(p) {
    const raw = typeof p.toJSON === "function" ? p.toJSON() : p;
    // papildomus laukus (rezervacijos būseną) pridėsime vėliau controller’iuose
    return raw;
}

function sanitizePrice(n) {
    const num = Number(n);
    if (!isFinite(num) || num < 0) return null;
    return Math.round(num * 100) / 100;
}

function canEditProduct(user, product) {
    if (!user) return false;
    if (isAdminEmail(user.email)) return true;
    return String(product.owner) === String(user._id);
}

function canDeleteProduct(user, product) {
    // tas pats kaip edit, bet toliau dar tikrinam ar nerezervuotas (nebent admin)
    return canEditProduct(user, product);
}

// Surenkame aktyvias rezervacijas pagal produkto id -> map
async function mapActiveReservationsByProduct(productIds) {
    const docs = await Reservation.find({
        product: { $in: productIds },
        status: Reservation.Status.ACTIVE,
    })
        .select("product reservedBy expiresAt amount status")
        .lean();

    const map = new Map(); // productId -> reservation
    for (const r of docs) {
        map.set(String(r.product), r);
    }
    return map;
}

// Lazy expiry: aptinkame pasibaigusias ir tvarkome (refund + status=expired)
async function runLazyExpiryNow(limit = 100) {
    const now = new Date();
    const expired = await Reservation.find({
        status: Reservation.Status.ACTIVE,
        expiresAt: { $lt: now },
    })
        .sort({ expiresAt: 1 })
        .limit(limit)
        .lean();

    if (!expired.length) return { processed: 0 };

    console.log(`[RES][EXPIRE] Found ${expired.length} expired active reservation(s) -> processing refunds`);

    let processed = 0;
    for (const r of expired) {
        try {
            // bandome atominiu būdu perjungti į expired, tik jei vis dar ACTIVE
            const switched = await Reservation.findOneAndUpdate(
                { _id: r._id, status: Reservation.Status.ACTIVE },
                { $set: { status: Reservation.Status.EXPIRED } },
                { new: true }
            ).lean();

            if (!switched) {
                console.log(`[RES][EXPIRE] skip r=${r._id} already processed by another worker`);
                continue;
            }

            // refund grąžinamas rezervavusiam (reservedBy)
            const inc = Number(r.amount || 0);
            await User.updateOne({ _id: r.reservedBy }, { $inc: { balance: inc } });
            processed++;
            console.log(
                `[RES][EXPIRE] OK r=${r._id} product=${r.product} -> status=expired, refund=${inc}€ to user=${r.reservedBy}`
            );
        } catch (e) {
            console.error(`[RES][EXPIRE] error r=${r._id}:`, e && e.message ? e.message : e);
        }
    }

    return { processed };
}

// --------------------------------------------------
// Controllers
// --------------------------------------------------
module.exports = {
    // GET /api/products
    // query:
    //  - page (default 1)
    //  - limit (default 20, max 50)
    //  - filter=available|reserved|mine
    //  - q (optional search by name/description)
    list: async (req, res) => {
        try {
            // Lazy expiry prieš list
            const expiredInfo = await runLazyExpiryNow();
            if (expiredInfo.processed) {
                console.log(`[PRODUCT][LIST] lazy-expiry processed=${expiredInfo.processed}`);
            }

            const page = Math.max(1, parseInt(req.query.page, 10) || 1);
            const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 20));
            const skip = (page - 1) * limit;

            const filter = String(req.query.filter || "").toLowerCase(); // available|reserved|mine
            const qText = String(req.query.q || "").trim();

            const find = {};
            if (qText) {
                // paprastas pilnas tekstas (naudojam text indexą)
                find.$text = { $search: qText };
            }

            // "mine" – reikalauja auth
            if (filter === "mine") {
                const me = req.user;
                if (!me) {
                    return res.status(401).json({ success: false, message: "unauthorized" });
                }
                find.owner = me._id;
            }

            // Iš anksto paimam kandidatų "total"
            const total = await Product.countDocuments(find);

            // Paimam puslapį
            const products = await Product.find(find)
                .sort({ createdAt: -1, _id: -1 })
                .skip(skip)
                .limit(limit)
                .lean();

            const productIds = products.map((p) => String(p._id));
            const resmap = productIds.length ? await mapActiveReservationsByProduct(productIds) : new Map();

            // Jei filter=available arba reserved – prafiltruojam po rezervacijų map'o
            let filtered = products;
            if (filter === "available") {
                filtered = products.filter((p) => !resmap.has(String(p._id)));
            } else if (filter === "reserved") {
                filtered = products.filter((p) => resmap.has(String(p._id)));
            }

            // Sudedam reserved būseną į išvestį
            const out = filtered.map((p) => {
                const base = toClientProduct(p);
                const r = resmap.get(String(p._id));
                base.is_reserved = !!r;
                base.reserved_by = r ? String(r.reservedBy) : null;
                base.reserved_until = r ? new Date(r.expiresAt).toISOString() : null;
                return base;
            });

            console.log(
                `[PRODUCT][LIST] page=${page} limit=${limit} filter=${filter || "-"} total=${total} returned=${out.length}`
            );

            return res.json({
                success: true,
                page,
                limit,
                total,
                count: out.length,
                products: out,
            });
        } catch (err) {
            console.error("[PRODUCT][LIST] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // GET /api/products/:id
    getOne: async (req, res) => {
        try {
            // Lazy expiry prieš get
            const expiredInfo = await runLazyExpiryNow();
            if (expiredInfo.processed) {
                console.log(`[PRODUCT][GET] lazy-expiry processed=${expiredInfo.processed}`);
            }

            const id = String(req.params.id || "");
            const doc = await Product.findById(id).lean();
            if (!doc) return res.status(404).json({ success: false, message: "not found" });

            const r = await Reservation.findOne({
                product: doc._id,
                status: Reservation.Status.ACTIVE,
            })
                .select("reservedBy expiresAt amount status")
                .lean();

            const out = toClientProduct(doc);
            out.is_reserved = !!r;
            out.reserved_by = r ? String(r.reservedBy) : null;
            out.reserved_until = r ? new Date(r.expiresAt).toISOString() : null;

            console.log(`[PRODUCT][GET] id=${id} reserved=${!!r}`);
            return res.json({ success: true, product: out });
        } catch (err) {
            console.error("[PRODUCT][GET] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // POST /api/products
    create: async (req, res) => {
        try {
            const me = req.user;
            if (!me?._id) return res.status(401).json({ success: false, message: "unauthorized" });

            const name = String(req.body?.name || "").trim();
            const description = String(req.body?.description || "").trim();
            const image_url = String(req.body?.image_url || "").trim();
            const price = sanitizePrice(req.body?.price);

            console.log(`[PRODUCT][CREATE] by=${me._id} name=${name ? name.slice(0, 30) : "(empty)"} price=${price}€`);

            if (!name || !description || !image_url || price === null) {
                return res.status(400).json({ success: false, message: "required: name, description, image_url, price" });
            }

            const created = await Product.create({
                name,
                description,
                image_url,
                price,
                owner: me._id,
            });

            const out = toClientProduct(created);
            out.is_reserved = false;
            out.reserved_by = null;
            out.reserved_until = null;

            console.log(`[PRODUCT][CREATE] OK id=${created._id}`);
            return res.json({ success: true, product: out, message: "product created" });
        } catch (err) {
            console.error("[PRODUCT][CREATE] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // PUT /api/products/:id
    update: async (req, res) => {
        try {
            const me = req.user;
            if (!me?._id) return res.status(401).json({ success: false, message: "unauthorized" });

            const id = String(req.params.id || "");
            const doc = await Product.findById(id);
            if (!doc) return res.status(404).json({ success: false, message: "not found" });

            const admin = isAdminEmail(me.email);
            if (!canEditProduct(me, doc)) {
                console.warn(`[PRODUCT][UPDATE] forbidden id=${id} by=${me._id}`);
                return res.status(403).json({ success: false, message: "forbidden" });
            }

            // Ar produktas rezervuotas šiuo metu?
            const active = await Reservation.findOne({
                product: doc._id,
                status: Reservation.Status.ACTIVE,
            })
                .select("_id")
                .lean();

            const set = {};
            if (typeof req.body?.name === "string") set.name = req.body.name.trim();
            if (typeof req.body?.description === "string") set.description = req.body.description.trim();
            if (typeof req.body?.image_url === "string") set.image_url = req.body.image_url.trim();

            if (typeof req.body?.price !== "undefined") {
                const newPrice = sanitizePrice(req.body.price);
                if (newPrice === null) {
                    return res.status(400).json({ success: false, message: "bad price" });
                }
                if (active && !admin) {
                    console.warn(`[PRODUCT][UPDATE] price change blocked (reserved) id=${id} by=${me._id}`);
                    return res.status(409).json({ success: false, message: "cannot change price while reserved" });
                }
                set.price = newPrice;
            }

            if (!Object.keys(set).length) {
                return res.json({ success: true, message: "nothing to update" });
            }

            const updated = await Product.findByIdAndUpdate(id, { $set: set }, { new: true, runValidators: true }).lean();

            const out = toClientProduct(updated);
            out.is_reserved = !!active;
            out.reserved_by = null;
            out.reserved_until = null;

            console.log(`[PRODUCT][UPDATE] OK id=${id} by=${me._id} fields=${Object.keys(set).join(",")}`);
            return res.json({ success: true, product: out, message: "product updated" });
        } catch (err) {
            console.error("[PRODUCT][UPDATE] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // DELETE /api/products/:id
    remove: async (req, res) => {
        try {
            const me = req.user;
            if (!me?._id) return res.status(401).json({ success: false, message: "unauthorized" });

            const id = String(req.params.id || "");
            const doc = await Product.findById(id).lean();
            if (!doc) return res.status(404).json({ success: false, message: "not found" });

            const admin = isAdminEmail(me.email);
            if (!canDeleteProduct(me, doc)) {
                console.warn(`[PRODUCT][DELETE] forbidden id=${id} by=${me._id}`);
                return res.status(403).json({ success: false, message: "forbidden" });
            }

            // Jei rezervuotas – neleisti trinti, nebent admin
            const active = await Reservation.findOne({
                product: id,
                status: Reservation.Status.ACTIVE,
            })
                .select("_id")
                .lean();

            if (active && !admin) {
                console.warn(`[PRODUCT][DELETE] blocked (reserved) id=${id} by=${me._id}`);
                return res.status(409).json({ success: false, message: "cannot delete while reserved" });
            }

            await Product.deleteOne({ _id: id });

            console.log(`[PRODUCT][DELETE] OK id=${id} by=${me._id} admin=${admin}`);
            return res.json({ success: true, id, message: "product deleted" });
        } catch (err) {
            console.error("[PRODUCT][DELETE] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },
};
