// models/Post.js
const { Schema, model, Types } = require("mongoose");

// Vieno komentaro sub-schema
const commentSchema = new Schema(
    {
        user:       { type: Types.ObjectId, ref: "User", required: true },
        user_name:  { type: String, required: true, trim: true },
        user_email: { type: String, default: "", trim: true, lowercase: true },
        text:       { type: String, required: true, trim: true, maxlength: 2000 },
        created_at: { type: Date, default: Date.now },
    },
    { _id: true } // kad turėtume comment.id
);

const postSchema = new Schema(
    {
        title:       { type: String, required: true, trim: true },
        image_url:   { type: String, required: true, trim: true },
        description: { type: String, required: true, trim: true },

        user:       { type: Types.ObjectId, ref: "User", required: true }, // savininkas
        user_email: { type: String, required: true, lowercase: true, trim: true },
        user_name:  { type: String, required: true, trim: true },

        // LAIKAI
        likes: { type: [{ type: Types.ObjectId, ref: "User" }], default: [] },

        // KOMENTARAI
        comments: { type: [commentSchema], default: [] },
    },
    { timestamps: true } // sukuria createdAt / updatedAt
);

// gražus JSON
postSchema.set("toJSON", {
    versionKey: false,
    transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;

        // užpildom created_at
        let ts = ret.createdAt || ret.created_at;
        if (!ts && doc && doc._id && typeof doc._id.getTimestamp === "function") {
            ts = doc._id.getTimestamp();
        }
        ret.created_at = ts ? new Date(ts).toISOString() : null;

        // patogumui – metrikos
        ret.likes_count    = Array.isArray(ret.likes)    ? ret.likes.length    : 0;
        ret.comments_count = Array.isArray(ret.comments) ? ret.comments.length : 0;

        delete ret.createdAt;
        delete ret.updatedAt;
        return ret;
    },
});

module.exports = model("Post", postSchema);
