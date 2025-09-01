// models/User.js
const { Schema, model, Types } = require("mongoose");

const likeSub = new Schema(
    {
            user:       { type: Types.ObjectId, ref: "User", required: true }, // kas pamėgo mane
            created_at: { type: Date, default: Date.now }
    },
    { _id: false }
);

const userSchema = new Schema(
    {
            userName:     { type: String, required: true, trim: true, lowercase: true, index: true },
            email:        { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
            passwordHash: { type: String, required: true, select: false },

            // jau turėjai:
            city:   { type: String, default: "" },
            secret: { type: String, default: "" },

            // nauji – visi optional, kad nesugadint senų įrašų
            avatar_url: { type: String, default: "" },
            phone:      { type: String, default: "" },

            // KAS MANE PAMĖGO
            likes: { type: [likeSub], default: [] }
    },
    { timestamps: true }
);

// JSON forma
userSchema.set("toJSON", {
        versionKey: false,
        transform(doc, ret) {
                ret.id = String(ret._id);
                delete ret._id;

                const ts = ret.createdAt || (doc?._id?.getTimestamp?.() ? doc._id.getTimestamp() : null);
                ret.created   = ts ? new Date(ts).toISOString() : null;
                ret.created_at = ret.created; // patogiai, jei reikės

                ret.likes_count = Array.isArray(ret.likes) ? ret.likes.length : 0;

                delete ret.createdAt;
                delete ret.updatedAt;
                return ret;
        },
});

module.exports = model("User", userSchema);
