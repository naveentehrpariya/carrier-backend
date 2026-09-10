'use strict';
/**
 * Generic driver for the PDF vendor sheets.
 *
 * Every PDF parser in this folder is a declaration (column x-ranges, an anchor test,
 * the vendor's tax identity, a date pattern) plus this one shared code path — so the
 * three vendors cannot drift into behaving differently on a bad file.
 */

const {
  extractPdfBands,
  fullText,
  groupRows,
  parseMoney,
  looksLikeData,
  checkIdentity,
  makeLedger,
} = require('./shared');

function moneyKeys(spec) {
  return spec.columns.filter((c) => c.kind === 'money').map((c) => c.key);
}

/**
 * @param {Buffer} buffer
 * @param {Object} spec  see the vendor files in this folder
 */
async function parsePdfTable(buffer, spec) {
  const led = makeLedger();
  const pages = await extractPdfBands(buffer, spec.yTolerance ? { yTolerance: spec.yTolerance } : undefined);
  const text = fullText(pages);

  if (spec.signature && !spec.signature(text)) {
    const err = new Error(`This file does not look like a ${spec.label} sheet.`);
    err.code = 'vendor_signature_mismatch';
    throw err;
  }

  const grouped = groupRows(pages, {
    columns: spec.columns,
    isAnchor: (cols, band) => spec.isAnchor(cols, band),
    wrapKeys: spec.wrapKeys || [],
    maxWrapDistance: spec.maxWrapDistance,
  });

  // ---- classify what did not become a row -------------------------------
  grouped.noise.forEach((entry) => {
    const t = entry.band.text;
    if (!t) return;
    const known = (spec.ignorePatterns || []).some((re) => re.test(t));
    if (known) return;
    if (entry.stray.length && looksLikeData(t)) {
      led.warn('column_outside_template',
        'A value fell outside every known column — the vendor template may have changed.',
        { page: entry.band.page, text: t, x: entry.stray.map((i) => Math.round(i.x)) });
      led.dropped(t, { page: entry.band.page, reason: 'column_outside_template' });
      return;
    }
    if (looksLikeData(t)) led.dropped(t, { page: entry.band.page, reason: 'unrecognised_row' });
  });

  // ---- build rows -------------------------------------------------------
  const mKeys = moneyKeys(spec);
  const rows = [];
  // A vendor sheet can be internally inconsistent by its own last printed decimal:
  // the AVAAL feed rounds the tax column and the gross column independently, so on
  // some rows price + tax != printed gross by one cent. That is a property of the
  // source, not a parse error, so it is absorbed by the identity tolerance — but it
  // is counted and reported, because our own output prints totals that DO add up and
  // the client will otherwise be asked why their sheet differs from the vendor's.
  const drift = {};
  grouped.rows.forEach((g, idx) => {
    const money = {};
    let fatal = false;
    mKeys.forEach((k) => {
      const parsed = parseMoney(g.values[k]);
      if (!parsed) {
        const optional = spec.columns.find((c) => c.key === k && c.optional);
        if (!optional) {
          fatal = true;
          led.warn('unreadable_number', `Could not read ${k}.`, { page: g.page, text: g.anchorText });
        }
        money[k] = null;
        return;
      }
      money[k] = parsed;
    });

    if (fatal) { led.dropped(g.anchorText, { page: g.page, reason: 'unreadable_number' }); return; }

    const row = {
      rowNo: rows.length + 1,
      page: g.page,
      text: {},
      money,
      rawLine: g.rawLine,
      flags: [],
    };
    spec.columns.filter((c) => c.kind === 'text').forEach((c) => { row.text[c.key] = g.values[c.key] || ''; });

    // required text fields
    (spec.requiredText || []).forEach((k) => {
      if (!row.text[k]) {
        row.flags.push({ code: 'missing_field', message: `${k} is empty` });
        led.warn('missing_field', `Row ${row.rowNo}: ${k} is empty.`, { page: g.page, text: g.anchorText });
      }
    });

    // ---- the vendor's own arithmetic must hold ------------------------
    (spec.identities || []).forEach((identity) => {
      const res = checkIdentity(money, identity);
      if (res.ok && res.delta > 0) {
        drift[identity.label] = drift[identity.label] || { count: 0, maxDelta: 0, rows: [] };
        drift[identity.label].count += 1;
        drift[identity.label].maxDelta = Math.max(drift[identity.label].maxDelta, res.delta);
        if (drift[identity.label].rows.length < 20) drift[identity.label].rows.push(rows.length + 1);
        row.flags.push({ code: 'vendor_rounding_drift', message: `${identity.label} is off by ${res.delta / 1e6} in the vendor's own printed columns`, severity: 'info' });
      }
      if (!res.ok) {
        row.flags.push({ code: 'identity_failed', message: `${identity.label} off by ${res.delta / 1e6}` });
        led.warn('identity_failed',
          `Row ${row.rowNo}: ${identity.label} does not add up (off by ${res.delta / 1e6}). The columns may have been read wrongly.`,
          { page: g.page, text: g.anchorText });
      }
    });

    // ---- second, independent reading of the same line -----------------
    if (spec.rowRegex && spec.regexFields) {
      const m = spec.rowRegex.exec(g.anchorText);
      if (!m) {
        row.flags.push({ code: 'cross_check_unreadable', message: 'regex reading of this line failed' });
        led.warn('cross_check_unreadable',
          `Row ${row.rowNo}: the second (text) reading of this line failed, so the numbers could not be double-checked.`,
          { page: g.page, text: g.anchorText });
      } else {
        spec.regexFields.forEach((field, i) => {
          const byRegex = parseMoney(m[i + 1]);
          const byGeometry = money[field];
          if (!byRegex || !byGeometry) return;
          if (byRegex.int !== byGeometry.int) {
            row.flags.push({ code: 'cross_check_mismatch', message: `${field}: geometry ${byGeometry.text} vs text ${byRegex.text}` });
            led.warn('cross_check_mismatch',
              `Row ${row.rowNo}: the two readings of ${field} disagree (${byGeometry.text} vs ${byRegex.text}).`,
              { page: g.page, text: g.anchorText });
          }
        });
      }
    }

    if (spec.normalizeRow) spec.normalizeRow(row, g);
    rows.push(row);
  });

  Object.keys(drift).forEach((label) => {
    const d = drift[label];
    led.warn('vendor_rounding_drift',
      `On ${d.count} of ${rows.length} rows the vendor's own columns do not add up exactly (${label}; up to ${d.maxDelta / 1e6} out). Your sheet prints totals that add up, so those rows can differ from the vendor's printed total by that much.`,
      { count: d.count, maxDelta: d.maxDelta, rows: d.rows });
  });

  const meta = Object.assign(
    { vendor: spec.vendor, label: spec.label, unit: spec.unit, currency: spec.currency, dp: spec.dp },
    spec.readMeta ? spec.readMeta(text, pages) : {},
  );

  return led.result({
    meta,
    columns: spec.columns.map((c) => ({ key: c.key, label: c.label, kind: c.kind, role: c.role || 'info' })),
    baseColumn: spec.baseColumn,
    rows,
    stats: {
      pages: pages.length,
      rows: rows.length,
      flagged: rows.filter((r) => r.flags.some((f) => f.severity !== 'info')).length,
      vendorRoundingDrift: Object.keys(drift).reduce((acc, k) => acc + drift[k].count, 0),
      unparsed: led.unparsed.length,
    },
  });
}

module.exports = { parsePdfTable };
