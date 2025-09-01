const { Schema, model } = require("mongoose");

const userSchema = new Schema(
    {
        userName: { type: String, required: true, trim: true },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },
        password: { type: String, required: true }, // (demo) nehashinam – vėliau galėsi pakeisti į hash
        city: { type: String, default: "Vilnius", trim: true },
        secret: { type: String, required: true, unique: true }, // naudojam postų nuosavybei
    },
    { timestamps: true }
);

module.exports = model("User", userSchema);
