// models/Post.js
const { Schema, model, Types } = require("mongoose");

const commentSchema = new Schema(
    {
        user:       { type: Types.ObjectId, ref: "User", required: true },
        user_name:  { type: String, required: true, trim: true },
        user_email: { type: String, default: "", trim: true, lowercase: true },
        text:       { type: String, required: true, trim: true },
        created_at: { type: Date, default: Date.now },
    },
    { _id: true }
);

const postSchema = new Schema(
    {
        title:       { type: String, required: true, trim: true },
        image_url:   { type: String, required: true, trim: true },
        description: { type: String, required: true, trim: true },

        user:       { type: Types.ObjectId, ref: "User", required: true },
        user_email: { type: String, required: true, lowercase: true, trim: true },
        user_name:  { type: String, required: true, trim: true },

        // likes: user _id sąrašas
        likes: { type: [{ type: Types.ObjectId, ref: "User" }], default: [] },

        // comments: sub-docs
        comments: { type: [commentSchema], default: [] },
    },
    { timestamps: true }
);

// gražus JSON
postSchema.set("toJSON", {
    versionKey: false,
    transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;

        // created_at išlaikymas
        let ts = ret.createdAt || ret.created_at;
        if (!ts && doc && doc._id && typeof doc._id.getTimestamp === "function") {
            ts = doc._id.getTimestamp();
        }
        ret.created_at = ts ? new Date(ts).toISOString() : null;

        // metrika
        ret.likes_count    = Array.isArray(ret.likes)    ? ret.likes.length    : 0;
        ret.comments_count = Array.isArray(ret.comments) ? ret.comments.length : 0;

        delete ret.createdAt;
        delete ret.updatedAt;
        return ret;
    },
});

module.exports = model("Post", postSchema);
