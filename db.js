// db.js
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

class JsonDB {
    /**
     * @param {string} filePath - kelias iki JSON failo (gali būti santykinis nuo __dirname arba absoliutus)
     * @param {object} [options]
     * @param {number} [options.backups=3] - kiek atsarginių kopijų laikyti (rotuojamos .bak1, .bak2, ...)
     * @param {number} [options.pretty=2]  - JSON įtrauka įrašant
     * @param {boolean} [options.atomic=true] - ar rašyti atominiu būdu (į .tmp ir tuomet rename)
     * @param {boolean} [options.autoMkdir=true] - ar automatiškai sukurti direktoriją
     * @param {string} [options.label="JsonDB"] - logų prefiksas
     */
    constructor(filePath, options = {}) {
        const {
            backups = 3,
            pretty = 2,
            atomic = true,
            autoMkdir = true,
            label = "JsonDB",
        } = options;

        const abs = path.isAbsolute(filePath)
            ? filePath
            : path.resolve(__dirname, filePath);

        this.file = abs;
        this.dir = path.dirname(abs);
        this.tmp = (suffix) => `${abs}.tmp-${process.pid}-${Date.now()}${suffix ? "-" + suffix : ""}`;
        this.backups = Math.max(0, backups | 0);
        this.pretty = pretty;
        this.atomic = !!atomic;
        this.autoMkdir = !!autoMkdir;
        this.label = label;

        // Nuoseklaus vykdymo grandinė (mutex)
        this._ops = Promise.resolve();

        console.log(`[${this.label}] init file=${this.file} backups=${this.backups} atomic=${this.atomic}`);
    }

    // -------- Helpers --------

    async _ensureDir() {
        if (!this.autoMkdir) return;
        await fsp.mkdir(this.dir, { recursive: true });
    }

    async _exists(p) {
        try {
            await fsp.access(p, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    async _rotateBackups() {
        if (!this.backups) return;
        // Perstumiam .bakN -> .bak(N+1), o .bak1 nuo file
        for (let i = this.backups; i >= 1; i--) {
            const src = `${this.file}.bak${i}`;
            const dst = `${this.file}.bak${i + 1}`;
            if (await this._exists(src)) {
                try {
                    // .bak(backups+1) pašalinam, jei viršijam limitą
                    if (i === this.backups && (await this._exists(dst))) {
                        await fsp.unlink(dst);
                    }
                    await fsp.rename(src, dst);
                } catch (e) {
                    console.warn(`[${this.label}] backup rotate warn: ${src} -> ${dst} : ${e.message}`);
                }
            }
        }
        if (await this._exists(this.file)) {
            try {
                await fsp.copyFile(this.file, `${this.file}.bak1`);
                console.log(`[${this.label}] backup created -> ${this.file}.bak1`);
            } catch (e) {
                console.warn(`[${this.label}] backup create warn: ${e.message}`);
            }
        }
    }

    async _atomicWrite(text) {
        if (!this.atomic) {
            await this._ensureDir();
            await fsp.writeFile(this.file, text, "utf8");
            return;
        }
        await this._ensureDir();
        const tmpPath = this.tmp("w");
        await fsp.writeFile(tmpPath, text, "utf8");
        // Pastaba: galima būtų fsync’inti, bet paprastai rename yra pakankamas atominiam keitimui daugely OS
        await fsp.rename(tmpPath, this.file);
    }

    async _readRawPrefer(pathCandidate) {
        const text = await fsp.readFile(pathCandidate, "utf8");
        return text.trim() ? JSON.parse(text) : {};
    }

    async _readWithRecovery() {
        // Pirma bandome pagrindinį failą
        try {
            return await this._readRawPrefer(this.file);
        } catch (e) {
            if (e.code === "ENOENT") {
                console.warn(`[${this.label}] read: file not found -> returning empty object`);
                return {};
            }
            console.error(`[${this.label}] read: JSON parse/IO error on main file: ${e.message}`);
            // Bandome iš .bak1 .. .bakN
            for (let i = 1; i <= this.backups; i++) {
                const bak = `${this.file}.bak${i}`;
                try {
                    const obj = await this._readRawPrefer(bak);
                    console.warn(`[${this.label}] recovery: restored from ${bak}`);
                    return obj;
                } catch {
                    // ignore; bandome kitą
                }
            }
            // Nepavyko atstatyti
            throw e;
        }
    }

    // -------- Public Low-level --------

    async read() {
        await this._ops;
        const t0 = Date.now();
        const data = await this._readWithRecovery();
        console.log(`[${this.label}] read ok in ${Date.now() - t0}ms`);
        return data;
    }

    async write(obj) {
        const text = JSON.stringify(obj ?? {}, null, this.pretty);
        // Nuosekliai: pridedame į grandinę
        this._ops = this._ops.then(async () => {
            const t0 = Date.now();
            await this._rotateBackups();
            await this._atomicWrite(text);
            console.log(`[${this.label}] write ok in ${Date.now() - t0}ms size=${Buffer.byteLength(text, "utf8")}B`);
        }).catch((e) => {
            console.error(`[${this.label}] write chain error: ${e.message}`);
        });
        await this._ops;
        return obj;
    }

    // Patogi „read-modify-write“ transakcija
    async withUpdate(fn) {
        // Garantija, kad viduje nebus kitų rašymų
        let result;
        await (this._ops = this._ops.then(async () => {
            const current = await this._readWithRecovery();
            const next = await fn({ ...current }); // leiskim fn saugiai keisti kopiją
            await this._rotateBackups();
            const text = JSON.stringify(next ?? {}, null, this.pretty);
            await this._atomicWrite(text);
            result = next;
            console.log(`[${this.label}] withUpdate ok (fn)`);
        }));
        return result;
        // Pastaba: jei fn mes klaidą, grandinė nutraukiama ir klaida pakeliama į viršų
    }

    // -------- Public High-level (API suderinamumas) --------

    async ensure(defaults) {
        return this.withUpdate((current) => ({ ...defaults, ...current }));
    }

    async get(key) {
        const all = await this.read();
        return all[key];
    }

    async set(key, value) {
        return this.withUpdate((all) => {
            all[key] = value;
            return all;
        });
    }

    async push(key, item) {
        return this.withUpdate((all) => {
            const arr = Array.isArray(all[key]) ? all[key] : [];
            arr.push(item);
            all[key] = arr;
            return all;
        }).then(() => item);
    }

    async updateInArray(key, predicate, updater) {
        let updated = null;
        await this.withUpdate((all) => {
            const arr = Array.isArray(all[key]) ? all[key] : [];
            const idx = arr.findIndex(predicate);
            if (idx === -1) return all;
            arr[idx] = updater(arr[idx]);
            updated = arr[idx];
            all[key] = arr;
            return all;
        });
        return updated; // null jei nerasta
    }

    async removeFromArray(key, predicate) {
        let removed = false;
        await this.withUpdate((all) => {
            const arr = Array.isArray(all[key]) ? all[key] : [];
            const idx = arr.findIndex(predicate);
            if (idx === -1) return all;
            arr.splice(idx, 1);
            all[key] = arr;
            removed = true;
            return all;
        });
        return removed; // true jei pašalinta
    }

    // -------- Extra convenience --------

    async merge(key, partial) {
        return this.withUpdate((all) => {
            const base = (all[key] && typeof all[key] === "object") ? all[key] : {};
            all[key] = { ...base, ...partial };
            return all;
        }).then(() => this.get(key));
    }

    async increment(key, n = 1) {
        return this.withUpdate((all) => {
            const val = Number(all[key] || 0);
            all[key] = val + Number(n);
            return all;
        }).then(() => this.get(key));
    }
}

module.exports = JsonDB;
