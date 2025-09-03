// models/User.js
const { Schema, model, Types } = require("mongoose");
const { DateTime } = require("luxon");

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "oskaraz@oskaraz.lt").toLowerCase();

const userSchema = new Schema(
    {
        userName:     { type: String, trim: true },
        username:     { type: String, trim: true }, // legacy
        email:        { type: String, required: true, lowercase: true, trim: true, unique: true },

        password:     { type: String, select: false },    // legacy
        passwordHash: { type: String, select: false },

        city:         { type: String, trim: true },
        secret:       { type: String, trim: true },

        // nauji laukeliai Users page'ui
        avatar_url:   { type: String, trim: true, default: "" },
        phone:        { type: String, trim: true, default: "" },

        // FINANSINIAI LAUKAI
        balance:      { type: Number, default: 1000 }, // € kaip Number (rodymui 2 sk.)
        balanceUpdatedAt: { type: Date, default: null },

        // Top-up žurnalas dienos limitui (1000 €/d.) tikrinti
        topups: {
            type: [{
                amount:     { type: Number, required: true }, // € teigiama suma
                created_at: { type: Date, default: Date.now },
                note:       { type: String, trim: true, default: "" },
            }],
            default: [],
            select: false, // nerodome pagal nutylėjimą
        },

        // kas mane „pokin’o“
        pokes: {
            type: [{
                user:       { type: Types.ObjectId, ref: "User" },
                created_at: { type: Date, default: Date.now },
            }],
            default: [],
        },
    },
    { timestamps: true }
);

// -------- Indeksai / nustatymai --------
userSchema.set("minimize", false);

// -------- Virtuals / helpers --------
function isAdminEmail(email) {
    return String(email || "").toLowerCase() === ADMIN_EMAIL;
}

userSchema.methods.isAdmin = function () {
    return isAdminEmail(this.email);
};

userSchema.methods.remainingTopupToday = function (limitEuros = 1000) {
    const now = DateTime.now().setZone("Europe/Vilnius");
    const start = now.startOf("day").toJSDate();
    const end = now.endOf("day").toJSDate();

    const todays = (this.topups || []).filter(t => {
        const ts = t && t.created_at ? new Date(t.created_at) : null;
        return ts && ts >= start && ts <= end;
    });
    const used = todays.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const remaining = Math.max(0, Number(limitEuros) - used);
    console.log(`[USER][remainingTopupToday] email=${this.email} used=${used} left=${remaining} (limit=${limitEuros})`);
    return remaining;
};

// -------- Hooks --------
userSchema.pre("save", function (next) {
    // Užtikriname default balansą seniesiems įrašams
    if (typeof this.balance !== "number") {
        console.log(`[USER][preSave] setting default balance=1000 for email=${this.email}`);
        this.balance = 1000;
    }
    // atnaujinam timestamp, kai keičiasi balance
    if (this.isModified("balance")) {
        this.balanceUpdatedAt = new Date();
        console.log(`[USER][preSave] balance changed -> ${this.balance}€, email=${this.email}`);
    }

    // informacinis logas apie admin vėliavą
    const adminFlag = isAdminEmail(this.email);
    console.log(`[USER][preSave] email=${this.email} isAdmin=${adminFlag}`);
    next();
});

userSchema.post("save", function (doc) {
    console.log(`[USER][postSave] saved id=${doc._id} email=${doc.email} balance=${doc.balance}€`);
});

// -------- toJSON transform --------
userSchema.set("toJSON", {
    versionKey: false,
    transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;

        // created_at suderinamumas su legacy
        const ts = ret.createdAt || ret.created_at;
        ret.created_at = ts ? new Date(ts).toISOString() : null;
        delete ret.createdAt;
        delete ret.updatedAt;

        // slaptų laukų apsauga
        delete ret.password;
        delete ret.passwordHash;

        // admin vėliava atsakymuose
        ret.is_admin = isAdminEmail(ret.email);

        // apvalintas rodymas (paliekam žalią Number balance lauką API vartojimui)
        // ret.balance_formatted = typeof ret.balance === "number" ? ret.balance.toFixed(2) : null;

        return ret;
    },
});

module.exports = model("User", userSchema);
