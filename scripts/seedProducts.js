#!/usr/bin/env node
/* Seed: sugeneruoja po N ([seed] prefix) produktų kiekvienam ne-admin useriui.
   Idempotentiškas: tikrina kiek jau yra [seed] produktų ir prideda trūkstamus.
*/
try { require("dotenv").config(); } catch (_) {}

const mongoose = require("mongoose");
const { faker } = require("@faker-js/faker");
const User = require("../models/User");
const Product = require("../models/Product");

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "oskaraz@oskaraz.lt").toLowerCase();
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/blog";
const PER_USER =
    Number(
        (process.env.SEED_PRODUCTS_PER_USER || "")
        || ((process.argv.find(a => a.startsWith("--per=")) || "").split("=")[1])
        || 3
    ) || 3;

const MIN_PRICE = 15;
const MAX_PRICE = 300;

function maskConn(str) { return str ? str.replace(/:\/\/.*@/, "://***:***@") : "(missing)"; }

function randPrice(min = MIN_PRICE, max = MAX_PRICE) {
    const v = Math.random() * (max - min) + min;
    return Math.round(v * 100) / 100;
}
function imgUrl(seed) {
    return `https://picsum.photos/seed/${encodeURIComponent(seed)}/600/400`;
}

async function ensureSeedForUser(user) {
    const prefix = "[seed] ";
    const q = { owner: user._id, name: new RegExp("^\\[seed\\]\\s", "i") };
    const existing = await Product.countDocuments(q);
    const need = Math.max(0, PER_USER - existing);
    console.log(`[SEED] user=${user._id} email=${user.email} have=${existing} need=${need}`);

    if (!need) return 0;

    const ops = [];
    for (let i = 0; i < need; i++) {
        const seed = `${user._id}-${Date.now()}-${i}`;
        const name = `${prefix}${faker.commerce.productName()}`;
        const description = faker.commerce.productDescription();
        const image_url = imgUrl(seed);
        const price = randPrice();

        console.log(`[SEED]   -> insert name="${name}" price=${price}€ imgSeed=${seed}`);
        ops.push({
            insertOne: {
                document: { name, description, image_url, price, owner: user._id }
            }
        });
    }

    if (!ops.length) return 0;
    const res = await Product.bulkWrite(ops);
    const inserted = (res && res.insertedCount) || ops.length;
    console.log(`[SEED] inserted=${inserted} for user=${user._id}`);
    return inserted;
}

(async () => {
    console.log("──────────────────────────────────────────────");
    console.log("[SEED] Seed products starting…");
    console.log("[SEED] MONGO_URI =", maskConn(MONGO_URI));
    console.log("[SEED] ADMIN_EMAIL =", ADMIN_EMAIL);
    console.log("[SEED] PER_USER =", PER_USER);
    console.log("──────────────────────────────────────────────");

    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    console.log("[SEED] MongoDB Connected! state=", mongoose.connection.readyState);

    const users = await User.find({ email: { $ne: ADMIN_EMAIL } })
        .select("_id email")
        .lean();

    console.log(`[SEED] non-admin users count=${users.length}`);

    let total = 0;
    for (const u of users) {
        try {
            total += await ensureSeedForUser(u);
        } catch (e) {
            console.error(`[SEED] error seeding user=${u._id}:`, e && e.message ? e.message : e);
        }
    }

    console.log("──────────────────────────────────────────────");
    console.log(`[SEED] DONE. total inserted=${total}`);
    console.log("──────────────────────────────────────────────");

    await mongoose.connection.close();
    console.log("[SEED] MongoDB disconnected");
    process.exit(0);
})().catch(async (e) => {
    console.error("[SEED] FAILED:", e && e.stack ? e.stack : e);
    try { await mongoose.connection.close(); } catch {}
    process.exit(1);
});
