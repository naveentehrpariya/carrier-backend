const mongoose = require('mongoose');

/**
 * Head of each tenant's audit hash chain.
 *
 * One document per tenant holding the next sequence number and the hash of the
 * most recent entry. Advanced with a compare-and-set update so two concurrent
 * requests (or two app instances) can never be handed the same `seq` or chain
 * off the same `lastHash`.
 */
const auditChainStateSchema = new mongoose.Schema({
  tenantId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  /** Sequence number the NEXT entry will take. Starts at 1. */
  nextSeq: {
    type: Number,
    default: 1,
  },
  /** Hash of the entry at nextSeq - 1. Empty string for the genesis entry. */
  lastHash: {
    type: String,
    default: '',
  },
  /**
   * Set by the backfill migration. Entries before this seq were written before
   * hashing existed and are reported as `legacy`, not as tampering.
   */
  genesisSeq: {
    type: Number,
    default: 1,
  },
}, { timestamps: true });

module.exports = mongoose.model('AuditChainState', auditChainStateSchema);
