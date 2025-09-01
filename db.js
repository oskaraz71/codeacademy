// C:\Users\Oskaraz\Desktop\CA Projektai\NodeJs\db.js
const fs = require("fs").promises;
const path = require("path");

class JsonDB {
    constructor(filePath) {
        this.file = path.resolve(__dirname, filePath);
        this._ops = Promise.resolve(); // nuoseklūs rašymai
    }

    async _readRaw() {
        try {
            const text = await fs.readFile(this.file, "utf8");
            return text.trim() ? JSON.parse(text) : {};
        } catch (e) {
            if (e.code === "ENOENT") return {};
            throw e;
        }
    }

    async read() {
        await this._ops;
        return this._readRaw();
    }

    async write(obj) {
        this._ops = this._ops.then(async () => {
            await fs.mkdir(path.dirname(this.file), { recursive: true });
            await fs.writeFile(this.file, JSON.stringify(obj, null, 2), "utf8");
        });
        await this._ops;
        return obj;
    }

    async ensure(defaults) {
        const current = await this.read();
        const next = { ...defaults, ...current };
        return this.write(next);
    }

    async get(key) {
        const all = await this.read();
        return all[key];
    }

    async set(key, value) {
        const all = await this.read();
        all[key] = value;
        return this.write(all);
    }

    async push(key, item) {
        const arr = (await this.get(key)) || [];
        arr.push(item);
        await this.set(key, arr);
        return item;
    }

    async updateInArray(key, predicate, updater) {
        const arr = (await this.get(key)) || [];
        const idx = arr.findIndex(predicate);
        if (idx === -1) return null;
        arr[idx] = updater(arr[idx]);
        await this.set(key, arr);
        return arr[idx];
    }

    async removeFromArray(key, predicate) {
        const arr = (await this.get(key)) || [];
        const idx = arr.findIndex(predicate);
        if (idx === -1) return false;
        arr.splice(idx, 1);
        await this.set(key, arr);
        return true;
    }
}

module.exports = JsonDB;
