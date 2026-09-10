const mongoose = require('mongoose');

// Generic per-tenant sequence counter. One doc per {tenantId, key}.
// nextSeq() is atomic ($inc via findOneAndUpdate upsert) — never count()+1,
// two concurrent creates would mint the same number.
const schema = new mongoose.Schema({
    tenantId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    seq: { type: Number, default: 0 },
});

schema.index({ tenantId: 1, key: 1 }, { unique: true });

const Counter = mongoose.model('counters', schema);

// start: value of the FIRST issued number (e.g. start=1000 → 1000, 1001, ...)
// The unique index MUST exist before concurrent upserts run, otherwise two
// processes can each create their own counter doc and mint the same number —
// so we wait for Counter.init() (cached) and retry the E11000 loser.
Counter.nextSeq = async function (tenantId, key, start = 1000) {
    await Counter.init();
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const doc = await Counter.findOneAndUpdate(
                { tenantId, key },
                [{ $set: { seq: { $add: [{ $ifNull: ['$seq', start - 1] }, 1] } } }],
                { new: true, upsert: true }
            );
            return doc.seq;
        } catch (err) {
            // Upsert race: another process created the doc first — retry increments it.
            if (err && err.code === 11000) continue;
            throw err;
        }
    }
    throw new Error('Failed to allocate a sequence number.');
};

// Push a sequence forward (never backward). Used when the counter is found to
// be behind numbers that already exist — e.g. cheques created by hand, or rows
// written before the counter did.
Counter.bumpTo = async function (tenantId, key, minSeq) {
    await Counter.init();
    await Counter.updateOne(
        { tenantId, key },
        { $max: { seq: Number(minSeq) || 0 } },
        { upsert: true }
    ).catch((err) => { if (err.code !== 11000) throw err; });
};

module.exports = Counter;
