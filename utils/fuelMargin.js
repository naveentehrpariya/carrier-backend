'use strict';
/**
 * Fuel margin engine — the single definition of "what the client sells this litre for".
 *
 * The whole point of this feature is that the client stops editing a vendor's sheet by
 * hand, so the arithmetic here has to be explainable line by line. Rules:
 *
 * 1. INTEGER MONEY. Everything is integer micro-units (1e-6 of the sheet's own unit),
 *    the same representation the parsers produce. No float accumulates over 350 rows.
 *
 * 2. ONE RULE PER ROW, AND THE ROW SAYS WHICH. Rules are matched by specificity —
 *    site > product > region > global — and among equal specificity the FIRST listed
 *    rule wins. Every priced row carries `ruleIndex`, so the preview can show where
 *    its number came from. A total nobody can explain is not a total.
 *
 * 3. NO ROW IS PRICED BY ACCIDENT. A row that matches no rule is returned `priced:
 *    false` with reason `no_rule`, and the caller must refuse to publish. Quietly
 *    applying a zero margin would ship the vendor's own cost to a customer.
 *
 * 4. TAX IS RECOMPUTED FROM THE SHEET'S OWN RATIO, never from a hardcoded tax table.
 *    Each row already states its tax and its base, so the effective rate is
 *    tax/base for that row — which is right for every province, and reproduces the
 *    vendor's own number exactly when the margin is zero.
 *
 * 5. UNITS NEVER CHANGE HERE. A flat margin is expressed in the sheet's own unit
 *    (cents/litre on the AVAAL feed, dollars/litre on Flying J, dollars/gallon on
 *    TA). Converting silently is the same bug class as an order changing currency.
 */

const { SCALE, divRound, mulDivRound, parseMoney, fmtMoney } = require('./fuelParsers/shared');

const SCOPES = ['global', 'region', 'product', 'site'];
const SPECIFICITY = { global: 0, region: 1, product: 2, site: 3 };
const MODES = ['flat', 'percent'];
const DIRECTIONS = ['add', 'subtract'];
const TAX_MODES = ['recompute', 'preserve'];

const UNIT_LABEL = {
  per_litre: '/L',
  cents_per_litre: '¢/L',
  per_gallon: '/gal',
};

function unitLabel(unit) { return UNIT_LABEL[unit] || ''; }

/** Round an integer micro-unit amount to `dp` decimals, half-up. */
function roundToDp(int, dp) {
  if (dp >= 6) return int;
  const step = Math.round(SCALE / (10 ** dp));
  return divRound(int, step) * step;
}

function norm(s) { return String(s === null || s === undefined ? '' : s).trim().toLowerCase(); }

/**
 * Validate and normalize a margin rule. Throws with a `code` on bad input — a rule
 * that cannot be understood must never be stored, because it will later be applied.
 */
function normalizeRule(input, index) {
  const at = `rule ${index + 1}`;
  const rule = input || {};
  const scope = norm(rule.scope) || 'global';
  if (!SCOPES.includes(scope)) {
    const e = new Error(`${at}: scope must be one of ${SCOPES.join(', ')}.`);
    e.code = 'rule_scope_invalid';
    throw e;
  }
  const mode = norm(rule.mode) || 'flat';
  if (!MODES.includes(mode)) {
    const e = new Error(`${at}: mode must be flat or percent.`);
    e.code = 'rule_mode_invalid';
    throw e;
  }
  const direction = norm(rule.direction) || 'add';
  if (!DIRECTIONS.includes(direction)) {
    const e = new Error(`${at}: direction must be add or subtract.`);
    e.code = 'rule_direction_invalid';
    throw e;
  }
  const parsed = parseMoney(rule.value);
  if (!parsed) {
    const e = new Error(`${at}: value "${rule.value}" is not a number.`);
    e.code = 'rule_value_invalid';
    throw e;
  }
  if (parsed.int < 0) {
    const e = new Error(`${at}: value cannot be negative — use direction "subtract" instead.`);
    e.code = 'rule_value_negative';
    throw e;
  }
  const match = scope === 'global' ? '' : String(rule.match === undefined || rule.match === null ? '' : rule.match).trim();
  if (scope !== 'global' && !match) {
    const e = new Error(`${at}: a ${scope} rule needs something to match on.`);
    e.code = 'rule_match_required';
    throw e;
  }
  return {
    index,
    scope,
    match,
    matchKey: norm(match),
    mode,
    direction,
    valueInt: parsed.int,
    valueText: fmtMoney(parsed.int, mode === 'percent' ? Math.max(parsed.dp, 2) : parsed.dp),
    note: rule.note ? String(rule.note).slice(0, 300) : '',
    specificity: SPECIFICITY[scope],
  };
}

/**
 * The storable / displayable shape of a rule. `normalizeRule` produces integer
 * internals (valueInt) that must never be what gets written down or shown — a saved
 * profile, a published snapshot and the preview all describe a rule through here, so
 * they cannot disagree about what the margin was.
 */
function serializeRules(rules) {
  return (rules || []).map((r) => ({
    scope: r.scope,
    match: r.match || '',
    mode: r.mode,
    direction: r.direction,
    value: r.valueText !== undefined ? r.valueText : String(r.value === undefined ? '' : r.value),
    note: r.note || '',
  }));
}

function normalizeProfile(input) {
  const profile = input || {};
  const taxMode = norm(profile.taxMode) || 'recompute';
  if (!TAX_MODES.includes(taxMode)) {
    const e = new Error(`taxMode must be one of ${TAX_MODES.join(', ')}.`);
    e.code = 'tax_mode_invalid';
    throw e;
  }
  const rules = (Array.isArray(profile.rules) ? profile.rules : []).map(normalizeRule);
  if (!rules.length) {
    const e = new Error('A margin profile needs at least one rule.');
    e.code = 'profile_has_no_rules';
    throw e;
  }
  const roundingDp = profile.roundingDp === undefined || profile.roundingDp === null || profile.roundingDp === ''
    ? null
    : Number(profile.roundingDp);
  if (roundingDp !== null && (!Number.isInteger(roundingDp) || roundingDp < 0 || roundingDp > 6)) {
    const e = new Error('roundingDp must be a whole number between 0 and 6.');
    e.code = 'rounding_dp_invalid';
    throw e;
  }
  return {
    name: profile.name ? String(profile.name).slice(0, 120) : '',
    taxMode,
    roundingDp,
    rules,
  };
}

/**
 * Which text on a row a rule of each scope is matched against.
 * Site matching accepts the site id OR the site name, because the client thinks in
 * names ("ESSO SURREY") while the sheet keys on a number.
 */
function rowMatchTargets(row) {
  const t = row.text || {};
  return {
    region: [t.region],
    product: [t.product],
    site: [t.site_id, t.site_number, t.location_no, t.site_name, t.name, t.location, t.travel_center],
  };
}

function ruleMatches(rule, row) {
  if (rule.scope === 'global') return true;
  const targets = rowMatchTargets(row)[rule.scope] || [];
  return targets.some((value) => {
    const v = norm(value);
    if (!v) return false;
    if (v === rule.matchKey) return true;
    // a name rule may be typed partially ("SURREY" for "ESSO SURREY")
    return rule.scope === 'site' && v.includes(rule.matchKey);
  });
}

/** site > product > region > global; ties broken by listed order. */
function resolveRule(row, rules) {
  let best = null;
  for (const rule of rules) {
    if (!ruleMatches(rule, row)) continue;
    if (!best || rule.specificity > best.specificity) best = rule;
  }
  return best;
}

function marginFor(rule, baseInt) {
  // Computed in BigInt: on a cents-per-litre sheet a percent margin overflows a
  // double before it overflows anything a human would call large. See mulDivRound.
  const magnitude = rule.mode === 'percent'
    ? mulDivRound(baseInt, rule.valueInt, 100 * SCALE)
    : rule.valueInt;
  return rule.direction === 'subtract' ? -magnitude : magnitude;
}

/**
 * Price a parsed sheet.
 *
 * @param {Object} sheet   the object a parser returned ({ meta, columns, baseColumn, rows })
 * @param {Object} profileInput margin profile
 * @returns {Object} { profile, unit, currency, dp, baseColumn, rows, totals, blockers }
 *
 * `blockers` is the list of reasons this priced sheet must not be published. It is
 * built here rather than in the controller so that the API, the preview and the PDF
 * cannot disagree about whether a sheet is fit to send out.
 */
function priceSheet(sheet, profileInput) {
  const profile = normalizeProfile(profileInput);
  const meta = sheet.meta || {};
  const baseKey = sheet.baseColumn;
  const spec = (sheet.columns || []).find((c) => c.key === baseKey);
  if (!baseKey || !spec) {
    const e = new Error('This sheet does not declare which column a margin applies to.');
    e.code = 'base_column_missing';
    throw e;
  }
  const dp = profile.roundingDp === null ? (meta.dp === undefined ? 4 : meta.dp) : profile.roundingDp;
  const taxKeys = (sheet.columns || []).filter((c) => c.role === 'tax').map((c) => c.key);
  const totalKey = (sheet.columns || []).find((c) => c.role === 'total');

  const rows = (sheet.rows || []).map((row) => {
    const baseVal = row.money[baseKey];
    const out = {
      rowNo: row.rowNo,
      page: row.page,
      text: row.text,
      money: row.money,
      flags: row.flags || [],
      priced: false,
      reason: null,
      ruleIndex: null,
      rule: null,
      baseInt: baseVal ? baseVal.int : null,
      marginInt: 0,
      finalInt: null,
      taxes: {},
      totalInt: null,
    };

    if (!baseVal) { out.reason = 'no_base_price'; return out; }

    const rule = resolveRule(row, profile.rules);
    if (!rule) { out.reason = 'no_rule'; return out; }

    let marginInt;
    let finalInt;
    try {
      marginInt = marginFor(rule, baseVal.int);
      finalInt = roundToDp(baseVal.int + marginInt, dp);
    } catch (e) {
      // One absurd row must not fail the whole sheet — it is reported and blocks
      // publishing like any other unpriced row.
      if (e.code === 'price_out_of_range') { out.reason = 'price_out_of_range'; return out; }
      throw e;
    }
    if (!Number.isSafeInteger(finalInt)) { out.reason = 'price_out_of_range'; return out; }

    out.ruleIndex = rule.index;
    out.rule = {
      scope: rule.scope, match: rule.match, mode: rule.mode,
      direction: rule.direction, value: rule.valueText, note: rule.note,
    };
    out.marginInt = finalInt - baseVal.int; // report the margin actually applied, after rounding
    out.finalInt = finalInt;

    if (finalInt <= 0) {
      out.reason = 'non_positive_price';
      out.priced = false;
      return out;
    }

    // Taxes. Rounded to the OUTPUT dp, not the vendor's — our sheet prints a total
    // that must equal the sum of the columns we print, and a coarser rounding chosen
    // by the profile would otherwise leave the printed columns not adding up.
    taxKeys.forEach((k) => {
      const orig = row.money[k];
      if (!orig) return;
      if (profile.taxMode === 'preserve' || baseVal.int === 0) {
        out.taxes[k] = roundToDp(orig.int, dp);
        return;
      }
      // the row's own effective rate — exact when the margin is zero
      out.taxes[k] = roundToDp(mulDivRound(finalInt, orig.int, baseVal.int), dp);
    });

    if (totalKey) {
      out.totalInt = Object.keys(out.taxes).reduce((acc, k) => acc + out.taxes[k], finalInt);
    }

    out.priced = true;
    return out;
  });

  // ---- blockers: everything that must be fixed before this can be sent out ----
  const blockers = [];
  if (!rows.length) {
    // A price sheet with no locations on it is not a price sheet. Publishing one
    // would send a customer an empty document under a real effective date.
    blockers.push({ code: 'sheet_has_no_rows', count: 0, message: 'This sheet has no locations on it.', rows: [] });
  }
  const unpriced = rows.filter((r) => !r.priced);
  const noRule = unpriced.filter((r) => r.reason === 'no_rule');
  const nonPositive = unpriced.filter((r) => r.reason === 'non_positive_price');
  const noBase = unpriced.filter((r) => r.reason === 'no_base_price');
  // informational flags (e.g. the vendor's own penny-rounding) are reported on the
  // row but never block a sheet — only flags that mean we may have misread it do.
  const flagged = rows.filter((r) => (r.flags || []).some((f) => f.severity !== 'info'));

  if (noRule.length) {
    blockers.push({
      code: 'rows_without_rule',
      count: noRule.length,
      message: `${noRule.length} row(s) match no margin rule. Add a global rule, or a rule covering them.`,
      rows: noRule.slice(0, 20).map((r) => r.rowNo),
    });
  }
  if (nonPositive.length) {
    blockers.push({
      code: 'non_positive_price',
      count: nonPositive.length,
      message: `${nonPositive.length} row(s) end up at or below zero after the margin.`,
      rows: nonPositive.slice(0, 20).map((r) => r.rowNo),
    });
  }
  if (noBase.length) {
    blockers.push({
      code: 'no_base_price',
      count: noBase.length,
      message: `${noBase.length} row(s) have no ${spec.label} to apply a margin to.`,
      rows: noBase.slice(0, 20).map((r) => r.rowNo),
    });
  }
  const outOfRange = unpriced.filter((r) => r.reason === 'price_out_of_range');
  if (outOfRange.length) {
    blockers.push({
      code: 'price_out_of_range',
      count: outOfRange.length,
      message: `${outOfRange.length} row(s) price too high to represent exactly — check the margin value.`,
      rows: outOfRange.slice(0, 20).map((r) => r.rowNo),
    });
  }
  if (flagged.length) {
    blockers.push({
      code: 'rows_flagged_by_parser',
      count: flagged.length,
      message: `${flagged.length} row(s) were flagged while reading the vendor sheet and must be checked.`,
      rows: flagged.slice(0, 20).map((r) => r.rowNo),
    });
  }

  const priced = rows.filter((r) => r.priced);
  const totals = {
    rows: rows.length,
    priced: priced.length,
    unpriced: unpriced.length,
    minFinal: priced.length ? Math.min(...priced.map((r) => r.finalInt)) : null,
    maxFinal: priced.length ? Math.max(...priced.map((r) => r.finalInt)) : null,
    minMargin: priced.length ? Math.min(...priced.map((r) => r.marginInt)) : null,
    maxMargin: priced.length ? Math.max(...priced.map((r) => r.marginInt)) : null,
    rulesUsed: [...new Set(priced.map((r) => r.ruleIndex))].sort((a, b) => a - b),
  };

  return {
    profile,
    unit: meta.unit,
    unitLabel: unitLabel(meta.unit),
    currency: meta.currency,
    dp,
    baseColumn: baseKey,
    baseColumnLabel: spec.label,
    taxColumns: taxKeys,
    totalColumn: totalKey ? totalKey.key : null,
    rows,
    totals,
    blockers,
  };
}

module.exports = {
  SCOPES,
  MODES,
  DIRECTIONS,
  TAX_MODES,
  SPECIFICITY,
  unitLabel,
  roundToDp,
  serializeRules,
  normalizeRule,
  normalizeProfile,
  resolveRule,
  marginFor,
  priceSheet,
};
