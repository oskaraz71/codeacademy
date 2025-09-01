const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
    {
        // Naudojame userName (atitinka kontrolerį)
        userName: { type: String, required: true, trim: true },

        email: { type: String, required: true, unique: true, lowercase: true, trim: true },

        // Šiuolaikinis slaptažodis (hash). Nedarom "required", kad nesprogtų seni dokumentai,
        // bet registruojant mes visada užpildom būtent šitą lauką.
        passwordHash: { type: String, select: false },

        // Legacy laukai – paliekam suderinamumui (irgi paslepiam iš select)
        username: { type: String, trim: true, select: false },
        password: { type: String, select: false },

        secret: { type: String, required: true, unique: true },
        city: { type: String, default: "Vilnius" },
    },
    { timestamps: true }
);

UserSchema.virtual("created_at").get(function () { return this.createdAt; });
UserSchema.virtual("updated_at").get(function () { return this.updatedAt; });

module.exports = mongoose.model("User", UserSchema);
