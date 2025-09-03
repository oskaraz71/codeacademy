// controllers/reservationController.js
const mongoose = require("mongoose");
const Product = require("../models/Product");
const Reservation = require("../models/Reservation");
const User = require("../models/User");

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "oskaraz@oskaraz.lt").toLowerCase();
const isAdminEmail = (email) => String(email || "").toLowerCase() === ADMIN_EMAIL;

// --------------------------------------------------
// Helpers
// --------------------------------------------------
function sanitizeId(v) {
    return String(v || "").trim();
}

function uniq(arr) {
    return [...new Set(arr.map((x) => String(x)))];
}

function toClientReservation(r, withProduct) {
    const raw = typeof r.toJSON === "function" ? r.toJSON() : r;
    if (withProduct && raw.product && typeof raw.product === "object") {
        // minimalus produkto rinkinys
        raw.product = {
            id: String(raw.product._id || raw.product.id || raw.product),
            name: raw.product.name,
            image_url: raw.product.image_url,
            price: raw.product.price,
            owner: String(raw.product.owner || ""),
        };
    } else {
        raw.product = String(raw.product);
    }
    return raw;
}

function add24h(date = new Date()) {
    return new Date(date.getTime() + 24 * 60 * 60 * 1000);
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
            // atominiu būdu pažymim expired tik jei dar ACTIVE
            const switched = await Reservation.findOneAndUpdate(
                { _id: r._id, status: Reservation.Status.ACTIVE },
                { $set: { status: Reservation.Status.EXPIRED } },
                { new: true }
            ).lean();

            if (!switched) {
                console.log(`[RES][EXPIRE] skip r=${r._id} already processed`);
                continue;
            }

            // refund rezervavusiam (reservedBy)
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
    // ---------- SINGLE RESERVE (palikta kaip buvo) ----------
    // POST /api/reservations
    // body: { productId }
    create: async (req, res) => {
        try {
            const me = req.user;
            if (!me?._id) return res.status(401).json({ success: false, message: "unauthorized" });

            // prieš kuriant – prasukam lazy expiry (jei kas baigėsi)
            const expiredInfo = await runLazyExpiryNow();
            if (expiredInfo.processed) {
                console.log(`[RES][CREATE] lazy-expiry processed=${expiredInfo.processed}`);
            }

            const productId = sanitizeId(req.body?.productId);
            if (!productId) return res.status(400).json({ success: false, message: "missing productId" });

            const product = await Product.findById(productId).lean();
            if (!product) return res.status(404).json({ success: false, message: "product not found" });

            // savininkas negali rezervuoti savo prekės
            if (String(product.owner) === String(me._id)) {
                console.warn(`[RES][CREATE] owner cannot reserve own product id=${productId} by=${me._id}`);
                return res.status(403).json({ success: false, message: "cannot reserve your own product" });
            }

            // ar jau yra aktyvi rezervacija?
            const existing = await Reservation.findOne({
                product: product._id,
                status: Reservation.Status.ACTIVE,
            })
                .select("_id reservedBy expiresAt")
                .lean();

            if (existing) {
                console.warn(`[RES][CREATE] product already reserved product=${productId} res=${existing._id}`);
                return res.status(409).json({ success: false, message: "product already reserved" });
            }

            // kaina tuo momentu (fiksuojam)
            const price = Math.round(Number(product.price || 0) * 100) / 100;
            if (!isFinite(price) || price < 0) {
                console.error(`[RES][CREATE] bad product price product=${productId} price=${product.price}`);
                return res.status(400).json({ success: false, message: "invalid product price" });
            }

            // atominis balanso nurašymas: tik jei balance >= price
            const decRes = await User.updateOne(
                { _id: me._id, balance: { $gte: price } },
                { $inc: { balance: -price } }
            );
            if (!decRes || decRes.modifiedCount !== 1) {
                const fresh = await User.findById(me._id).select("balance").lean();
                const current = Number(fresh?.balance || 0);
                console.warn(`[RES][CREATE] insufficient funds user=${me._id} need=${price}€ have=${current}€`);
                return res.status(400).json({
                    success: false,
                    message: "insufficient funds",
                    balance: Math.round(current * 100) / 100,
                    need: price,
                });
            }

            // bandome sukurti aktyvią rezervaciją
            // (partial unique indeksas leis tik vieną ACTIVE per produktą)
            let created;
            try {
                created = await Reservation.create({
                    product: product._id,
                    owner: product.owner,
                    reservedBy: me._id,
                    amount: price,
                    expiresAt: add24h(new Date()),
                    status: Reservation.Status.ACTIVE,
                });
            } catch (e) {
                // jeigu sukrito dėl dublikato (11000) -> grąžinam pinigus
                if (e && e.code === 11000) {
                    console.warn(
                        `[RES][CREATE] duplicate active reservation product=${productId}; refunding user=${me._id} amount=${price}€`
                    );
                    await User.updateOne({ _id: me._id }, { $inc: { balance: price } });
                    return res.status(409).json({ success: false, message: "product already reserved" });
                }
                // kitos klaidos -> taip pat refund ir klaida
                console.error("[RES][CREATE] error during create; refunding:", e && e.message ? e.message : e);
                await User.updateOne({ _id: me._id }, { $inc: { balance: price } });
                return res.status(500).json({ success: false, message: "server error" });
            }

            const out = toClientReservation(created, false);
            console.log(
                `[RES][CREATE] OK r=${created._id} product=${productId} by=${me._id} amount=${price}€ expiresAt=${created.expiresAt.toISOString()}`
            );

            return res.json({ success: true, reservation: out });
        } catch (err) {
            console.error("[RES][CREATE] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // ---------- BULK QUOTE ----------
    // POST /api/reservations/quote
    // body: { productIds: string[] }
    quote: async (req, res) => {
        try {
            const me = req.user;
            if (!me?._id) return res.status(401).json({ success: false, message: "unauthorized" });

            const expiredInfo = await runLazyExpiryNow();
            if (expiredInfo.processed) console.log(`[RES][QUOTE] lazy-expiry processed=${expiredInfo.processed}`);

            const ids = Array.isArray(req.body?.productIds)
                ? uniq(req.body.productIds.map(sanitizeId).filter(Boolean))
                : [];
            console.log(`[RES][QUOTE] user=${me._id} ids=${ids.length}`);

            if (!ids.length) return res.status(400).json({ success: false, message: "no productIds" });
            if (ids.length > 50) return res.status(400).json({ success: false, message: "too many items (max 50)" });

            const products = await Product.find({ _id: { $in: ids } })
                .select("name image_url price owner")
                .lean();

            const foundMap = new Map(products.map((p) => [String(p._id), p]));
            const missing = ids.filter((id) => !foundMap.has(id));

            // jau rezervuotos
            const actives = await Reservation.find({
                product: { $in: ids },
                status: Reservation.Status.ACTIVE,
            })
                .select("product")
                .lean();
            const reservedSet = new Set(actives.map((r) => String(r.product)));

            // savininko
            const own = products.filter((p) => String(p.owner) === String(me._id)).map((p) => String(p._id));

            const unavailable = {
                missing,
                own,
                alreadyReserved: [...reservedSet],
            };

            // available tik tie, kurie rasti, ne own, ne reserved
            const available = products.filter(
                (p) =>
                    !unavailable.own.includes(String(p._id)) &&
                    !unavailable.alreadyReserved.includes(String(p._id))
            );

            const total = available.reduce((sum, p) => sum + Number(p.price || 0), 0);
            const totalRounded = Math.round(total * 100) / 100;

            console.log(
                `[RES][QUOTE] available=${available.length} missing=${missing.length} reserved=${reservedSet.size} own=${own.length} total=${totalRounded}€`
            );

            return res.json({
                success: true,
                count: available.length,
                total: totalRounded,
                available: available.map((p) => ({
                    id: String(p._id),
                    name: p.name,
                    price: p.price,
                    owner: String(p.owner),
                    image_url: p.image_url,
                })),
                unavailable,
            });
        } catch (err) {
            console.error("[RES][QUOTE] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // ---------- BULK RESERVE ----------
    // POST /api/reservations/bulk
    // body: { productIds: string[] }
    bulk: async (req, res) => {
        const session = await mongoose.startSession();
        try {
            const me = req.user;
            if (!me?._id) return res.status(401).json({ success: false, message: "unauthorized" });

            const expiredInfo = await runLazyExpiryNow();
            if (expiredInfo.processed) console.log(`[RES][BULK] lazy-expiry processed=${expiredInfo.processed}`);

            // sanitize
            const ids = Array.isArray(req.body?.productIds)
                ? uniq(req.body.productIds.map(sanitizeId).filter(Boolean))
                : [];
            console.log(`[RES][BULK] user=${me._id} ids=${ids.length}`);

            if (!ids.length) return res.status(400).json({ success: false, message: "no productIds" });
            if (ids.length > 50) return res.status(400).json({ success: false, message: "too many items (max 50)" });

            // fetch products
            const products = await Product.find({ _id: { $in: ids } })
                .select("name image_url price owner")
                .lean();
            const foundMap = new Map(products.map((p) => [String(p._id), p]));
            const missing = ids.filter((id) => !foundMap.has(id));

            // already reserved check (outside tx – prefilter)
            const actives = await Reservation.find({
                product: { $in: ids },
                status: Reservation.Status.ACTIVE,
            })
                .select("product")
                .lean();
            const reservedSet = new Set(actives.map((r) => String(r.product)));

            const own = products.filter((p) => String(p.owner) === String(me._id)).map((p) => String(p._id));

            // jei kas nors netinka – grąžinam 409 (all-or-nothing)
            const invalid = {
                missing,
                own,
                alreadyReserved: [...reservedSet],
            };
            const invalidCount =
                invalid.missing.length + invalid.own.length + invalid.alreadyReserved.length;

            if (invalidCount > 0) {
                console.warn(
                    `[RES][BULK] invalid selection missing=${missing.length} own=${own.length} reserved=${reservedSet.size}`
                );
                return res.status(409).json({ success: false, message: "some items unavailable", invalid });
            }

            // total price
            const total = products.reduce((sum, p) => sum + Number(p.price || 0), 0);
            const totalRounded = Math.round(total * 100) / 100;

            // TRANSAKCIJA: 1) dar kartą patikrinam, kad nėra ACTIVE; 2) nurašom balansą; 3) sukuriam rezervacijas
            let createdDocs = [];
            await session.withTransaction(
                async () => {
                    // 1) double-check ACTIVE (TOCTOU apsauga)
                    const recheck = await Reservation.find(
                        { product: { $in: ids }, status: Reservation.Status.ACTIVE },
                        null,
                        { session }
                    )
                        .select("product")
                        .lean();
                    if (recheck.length) {
                        const clash = recheck.map((r) => String(r.product));
                        console.warn(`[RES][BULK][TX] clash reserved during tx count=${clash.length}`);
                        const err = new Error("items became reserved");
                        err.status = 409;
                        err.invalid = { alreadyReserved: clash, missing: [], own: [] };
                        throw err;
                    }

                    // 2) balance >= total
                    const dec = await User.updateOne(
                        { _id: me._id, balance: { $gte: totalRounded } },
                        { $inc: { balance: -totalRounded } },
                        { session }
                    );
                    if (!dec || dec.modifiedCount !== 1) {
                        const fresh = await User.findById(me._id).select("balance").session(session).lean();
                        const current = Number(fresh?.balance || 0);
                        console.warn(
                            `[RES][BULK][TX] insufficient funds user=${me._id} need=${totalRounded}€ have=${current}€`
                        );
                        const err = new Error("not enough euros");
                        err.status = 400;
                        err.balance = Math.round(current * 100) / 100;
                        err.need = totalRounded;
                        throw err;
                    }

                    // 3) create reservations
                    const docs = products.map((p) => ({
                        product: p._id,
                        owner: p.owner,
                        reservedBy: me._id,
                        amount: Math.round(Number(p.price || 0) * 100) / 100,
                        expiresAt: add24h(new Date()),
                        status: Reservation.Status.ACTIVE,
                    }));

                    // `insertMany` su session ir ordered:true (jei bent viena failins -> meta klaidą ir transakcija rollback)
                    createdDocs = await Reservation.insertMany(docs, { session, ordered: true });
                    console.log(`[RES][BULK][TX] inserted=${createdDocs.length} total=${totalRounded}€`);
                },
                {
                    writeConcern: { w: "majority" },
                    readConcern: { level: "local" },
                }
            );

            // sėkmė
            const out = createdDocs.map((d) => toClientReservation(d, false));
            const freshUser = await User.findById(me._id).select("balance").lean();
            const newBalance = Math.round(Number(freshUser?.balance || 0) * 100) / 100;

            console.log(
                `[RES][BULK] OK user=${me._id} items=${out.length} total=${totalRounded}€ newBalance=${newBalance}€`
            );

            return res.json({
                success: true,
                count: out.length,
                total: totalRounded,
                reservations: out,
                balance: newBalance,
            });
        } catch (err) {
            // jei err.status yra 400 su „not enough euros“ – FE gali rodyti tavo tekstą
            if (err && err.status === 400 && err.message === "not enough euros") {
                return res.status(400).json({
                    success: false,
                    message: "not enough euros",
                    balance: err.balance,
                    need: err.need,
                });
            }
            if (err && err.status === 409 && err.invalid) {
                return res.status(409).json({
                    success: false,
                    message: "some items unavailable",
                    invalid: err.invalid,
                });
            }
            console.error("[RES][BULK] error:", err?.message || err);
            return res.status(500).json({ success: false, message: "server error" });
        } finally {
            try { await session.endSession(); } catch {}
        }
    },

    // ---------- CANCEL (palikta kaip buvo) ----------
    // POST /api/reservations/:id/cancel
    // leidžiama: reservedBy, owner (produkto savininkas), admin
    cancel: async (req, res) => {
        try {
            const me = req.user;
            if (!me?._id) return res.status(401).json({ success: false, message: "unauthorized" });

            // prieš cancel prasukam lazy expiry (jei kas baigėsi)
            const expiredInfo = await runLazyExpiryNow();
            if (expiredInfo.processed) {
                console.log(`[RES][CANCEL] lazy-expiry processed=${expiredInfo.processed}`);
            }

            const id = sanitizeId(req.params.id);
            if (!id) return res.status(400).json({ success: false, message: "missing reservation id" });

            const r = await Reservation.findById(id).lean();
            if (!r) return res.status(404).json({ success: false, message: "reservation not found" });

            if (r.status !== Reservation.Status.ACTIVE) {
                console.warn(`[RES][CANCEL] not active r=${id} status=${r.status}`);
                return res.status(409).json({ success: false, message: "reservation not active" });
            }

            const admin = isAdminEmail(me.email);
            const isActor = admin || String(r.reservedBy) === String(me._id) || String(r.owner) === String(me._id);
            if (!isActor) {
                console.warn(`[RES][CANCEL] forbidden r=${id} by=${me._id}`);
                return res.status(403).json({ success: false, message: "forbidden" });
            }

            // perjungiame į cancelled tik jei dar ACTIVE
            const switched = await Reservation.findOneAndUpdate(
                { _id: id, status: Reservation.Status.ACTIVE },
                { $set: { status: Reservation.Status.CANCELLED } },
                { new: true }
            ).lean();

            if (!switched) {
                console.warn(`[RES][CANCEL] already processed r=${id}`);
                return res.status(409).json({ success: false, message: "already processed" });
            }

            // refund rezervavusiam
            const refund = Number(r.amount || 0);
            await User.updateOne({ _id: r.reservedBy }, { $inc: { balance: refund } });

            console.log(
                `[RES][CANCEL] OK r=${id} by=${me._id} admin=${admin} refund=${refund}€ to user=${r.reservedBy}`
            );
            const out = toClientReservation(switched, false);
            return res.json({ success: true, reservation: out });
        } catch (err) {
            console.error("[RES][CANCEL] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // ---------- MY ACTIVE (palikta kaip buvo) ----------
    // GET /api/reservations/my
    // tik aktyvios mano rezervacijos; be countdown, bet su createdAt/expiresAt
    myActive: async (req, res) => {
        try {
            const me = req.user;
            if (!me?._id) return res.status(401).json({ success: false, message: "unauthorized" });

            // prieš my – lazy expiry
            const expiredInfo = await runLazyExpiryNow();
            if (expiredInfo.processed) {
                console.log(`[RES][MY] lazy-expiry processed=${expiredInfo.processed}`);
            }

            const docs = await Reservation.find({
                reservedBy: me._id,
                status: Reservation.Status.ACTIVE,
            })
                .populate({ path: "product", select: "name image_url price owner" })
                .sort({ createdAt: -1, _id: -1 });

            const out = docs.map((d) => toClientReservation(d, true));

            console.log(`[RES][MY] user=${me._id} count=${out.length}`);
            return res.json({ success: true, count: out.length, reservations: out });
        } catch (err) {
            console.error("[RES][MY] error:", err);
            return res.status(500).json({ success: false, message: "server error" });
        }
    },

    // Health
    health: async (_req, res) => {
        res.json({ ok: true, scope: "reservations" });
    },
};
