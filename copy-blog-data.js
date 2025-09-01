// copy-blog-data.js
require('dotenv').config();
const mongoose = require('mongoose');

const CLUSTER_URI = process.env.MONGO_URI; // tavo .env su /blog
const SOURCE_DB = 'test';                  // IŠ čia kopijuosim
const DEST_DB   = 'blog';                  // Į čia įkelsim

(async () => {
    try {
        const args = process.argv.slice(2);
        const drop = args.includes('--drop');                            // pvz. node copy-blog-data.js --drop
        const only = args.filter(a => !a.startsWith('--'));              // pvz. node copy-blog-data.js posts users
        const collections = only.length ? only : ['posts', 'users'];     // default: abi

        if (!CLUSTER_URI) throw new Error('MONGO_URI nėra .env faile');

        const src = mongoose.createConnection(CLUSTER_URI, {
            dbName: SOURCE_DB, serverSelectionTimeoutMS: 15000
        });
        const dst = mongoose.createConnection(CLUSTER_URI, {
            dbName: DEST_DB, serverSelectionTimeoutMS: 15000
        });

        await src.asPromise();
        await dst.asPromise();
        console.log(`[i] Connected. Copying ${collections.join(', ')} from "${SOURCE_DB}" to "${DEST_DB}". Drop: ${drop}`);

        for (const name of collections) {
            const srcCol = src.collection(name);
            const dstCol = dst.collection(name);

            if (drop) {
                try { await dstCol.drop(); console.log(`[${name}] dropped destination collection`); }
                catch (e) { if (e.codeName !== 'NamespaceNotFound') console.warn(`[${name}] drop warn: ${e.message}`); }
            }

            const cursor = srcCol.find({});
            const batch = [];
            let copied = 0;

            while (await cursor.hasNext()) {
                const doc = await cursor.next();
                batch.push({
                    replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true }
                });
                if (batch.length >= 1000) {
                    const r = await dstCol.bulkWrite(batch, { ordered: false });
                    copied += (r.upsertedCount || 0) + (r.modifiedCount || 0);
                    batch.length = 0;
                    process.stdout.write('.');
                }
            }
            if (batch.length) {
                const r = await dstCol.bulkWrite(batch, { ordered: false });
                copied += (r.upsertedCount || 0) + (r.modifiedCount || 0);
            }

            const srcCount = await srcCol.estimatedDocumentCount();
            const dstCount = await dstCol.estimatedDocumentCount();
            console.log(`\n[${name}] source ~${srcCount} → dest now ${dstCount} (copied/updated ~${copied})`);
        }

        await src.close();
        await dst.close();
        console.log('Done.');
    } catch (e) {
        console.error('ERROR:', e.message);
        process.exit(1);
    }
})();
