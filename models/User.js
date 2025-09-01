// NodeJs/models/User.js
const { Schema, model, Types } = require("mongoose");

const userSchema = new Schema(
    {
        userName:     { type: String, required: true, trim: true, lowercase: true },
        username:     { type: String, trim: true, lowercase: true }, // legacy
        email:        { type: String, required: true, trim: true, lowercase: true, unique: true },
        password:     { type: String, select: false },   // legacy
        passwordHash: { type: String, select: false },

        city:   { type: String, trim: true },
        phone:  { type: String, trim: true },
        avatar: { type: String, trim: true },

        secret: { type: String, trim: true },

        liked_posts: { type: [{ type: Types.ObjectId, ref: "Post" }], default: [] }, // <—
    },
    { timestamps: true }
);

userSchema.set("toJSON", {
    versionKey: false,
    transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        return ret;
    },
});

module.exports = model("User", userSchema);
