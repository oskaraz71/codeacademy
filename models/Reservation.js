// models/Reservation.js
const { Schema, model, Types } = require("mongoose");

// Pagal susitarimą (atskira kolekcija):
// product (ref Product), owner (produkto savininkas, ref User),
// reservedBy (kas rezervuoja, ref User), amount (EUR tuo momentu),
// createdAt (auto), expiresAt (now+24h), status: active|cancelled|expired

const STATUS = {
    ACTIVE: "active",
    CANCELLED: "cancelled",
    EXPIRED: "expired",
};

function in24hFromNow() {
    const now = Date.now();
    const in24 = new Date(now + 24 * 60 * 60 * 1000);
    return in24;
}

const reservationSchema = new Schema(
    {
        product: {
            type: Types.ObjectId,
            ref: "Product",
            required: true,
            index: true,
        },
        owner: {
            // produkto savininkas (užfiksuojam rezervacijoje patogumui)
            type: Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        reservedBy: {
            type: Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        amount: {
            // € kaip Number (fiksuojama rezervavimo momentu)
            type: Number,
            required: true,
            min: [0, "amount must be >= 0"],
        },
        expiresAt: {
            type: Date,
            required: true,
            default: in24hFromNow,
            index: true,
        },
        status: {
            type: String,
            enum: Object.values(STATUS),
            default: STATUS.ACTIVE,
            index: true,
        },
    },
    { timestamps: true }
);

// Unikalumas: vienam product gali būti tik viena ACTIVE rezervacija
// (naudoja dalinį indeksą, kad leistų daugiau CANCELLED/EXPIRED istorijoje)
reservationSchema.index(
    { product: 1, status: 1 },
    {
        unique: true,
        partialFilterExpression: { status: STATUS.ACTIVE },
    }
);

// Naudingi logai
reservationSchema.pre("save", function (next) {
    // Saugumo dėlei apvalinam amount iki 2 skaičių po kablelio
    if (this.isModified("amount") && typeof this.amount === "number") {
        this.amount = Math.round(this.amount * 100) / 100;
    }
    // expiresAt default jei nenurodė
    if (!this.expiresAt) this.expiresAt = in24hFromNow();

    const isExpired = this.expiresAt && this.expiresAt.getTime() < Date.now();
    console.log(
        `[RES][preSave] product=${this.product} reservedBy=${this.reservedBy} amount=${this.amount}€ status=${this.status} willExpire=${this.expiresAt.toISOString()} isExpiredNow=${isExpired}`
    );
    next();
});

reservationSchema.post("save", function (doc) {
    console.log(
        `[RES][postSave] saved id=${doc._id} product=${doc.product} status=${doc.status} expiresAt=${doc.expiresAt.toISOString()}`
    );
});

// Patogūs helperiai
reservationSchema.methods.isActive = function () {
    return this.status === STATUS.ACTIVE;
};

reservationSchema.methods.isExpiredNow = function () {
    return !!this.expiresAt && this.expiresAt.getTime() < Date.now();
};

reservationSchema.statics.Status = STATUS;

// toJSON transform – švara ir suderinamumas
reservationSchema.set("toJSON", {
    versionKey: false,
    transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;

        const ts = ret.createdAt || ret.created_at;
        ret.created_at = ts ? new Date(ts).toISOString() : null;

        delete ret.createdAt;
        delete ret.updatedAt;

        return ret;
    },
});

module.exports = model("Reservation", reservationSchema);
