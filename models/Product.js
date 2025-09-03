// models/Product.js
const { Schema, model, Types } = require("mongoose");

// Pagal susitarimą:
// name, description, image_url, price (eurais, Number), owner (User ObjectId)
// Jokio rezervacijos flag'o čia nelaikome – rezervacijos tvarkomos atskiroje kolekcijoje.

const productSchema = new Schema(
    {
        name: {
            type: String,
            required: [true, "name is required"],
            trim: true,
            maxlength: [200, "name too long"],
        },
        description: {
            type: String,
            required: [true, "description is required"],
            trim: true,
            maxlength: [5000, "description too long"],
        },
        image_url: {
            type: String,
            required: [true, "image_url is required"],
            trim: true,
        },
        price: {
            type: Number, // € kaip Number (rodoma su 2 sk.)
            required: [true, "price is required"],
            min: [0, "price must be >= 0"],
        },
        owner: {
            type: Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
    },
    { timestamps: true }
);

// Indeksai
productSchema.index({ name: "text", description: "text" });

// Naudingi logai prieš/po išsaugojimo
productSchema.pre("save", function (next) {
    // suapvalinam iki 2 skaitmenų (rodymui FE vis tiek formatuos)
    if (this.isModified("price") && typeof this.price === "number") {
        this.price = Math.round(this.price * 100) / 100;
    }
    console.log(
        `[PRODUCT][preSave] name="${this.name}" price=${this.price}€ owner=${this.owner}`
    );
    next();
});

productSchema.post("save", function (doc) {
    console.log(
        `[PRODUCT][postSave] saved id=${doc._id} name="${doc.name}" price=${doc.price}€`
    );
});

// toJSON transform – suderinamumas ir švara
productSchema.set("toJSON", {
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

module.exports = model("Product", productSchema);
