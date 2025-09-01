// models/User.js
const { Schema, model, Types } = require("mongoose");

const likeSub = new Schema(
    {
        user:       { type: Types.ObjectId, ref: "User", required: true }, // kas pamėgo
        created_at: { type: Date, default: Date.now },
    },
    { _id: false }
);

const userSchema = new Schema(
    {
        userName:     { type: String, required: true, trim: true, lowercase: true, index: true },
        email:        { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
        passwordHash: { type: String, required: true, select: false },

        city:   { type: String, default: "" },
        secret: { type: String, default: "" },

        // nauji optional laukai (negriauna senų userių)
        avatar_url: { type: String, default: "" },
        phone:      { type: String, default: "" },

        // kas pamėgo šį userį
        likes: { type: [likeSub], default: [] },
    },
    { timestamps: true }
);

userSchema.set("toJSON", {
    versionKey: false,
    transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;

        const ts = ret.createdAt || (doc?._id?.getTimestamp?.() ? doc._id.getTimestamp() : null);
        ret.created = ts ? new Date(ts).toISOString() : null;
        ret.created_at = ret.created;

        ret.likes_count = Array.isArray(ret.likes) ? ret.likes.length : 0;

        delete ret.createdAt;
        delete ret.updatedAt;
        return ret;
    },
});

module.exports = model("User", userSchema);
