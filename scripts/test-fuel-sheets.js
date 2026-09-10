#!/usr/bin/env node
'use strict';
/**
 * Golden-file tests for the fuel price sheet parsers and the margin engine.
 *
 * Offline and self-contained: no database, no network, no server. It reads the four
 * real vendor files in backend/__fixtures__/fuel and asserts the exact numbers they
 * contain, so a change to a parser that moves a single price fails loudly here
 * instead of quietly on a sheet a client has already sent to a customer.
 *
 *   node scripts/test-fuel-sheets.js          (or: npm run test:fuel-sheets)
 */

const fs = require('fs');
const path = require('path');

const reg = require('../utils/fuelParsers');
const shared = require('../utils/fuelParsers/shared');
const margin = require('../utils/fuelMargin');

const FIX = path.join(__dirname, '..', '__fixtures__', 'fuel');
const F = {
  petro: 'petro-canada-2026-08-24.xlsx',
  unknownXlsx: 'unknown-vendor-rack.xlsx',
  unknownPdf: 'unknown-vendor-contract.pdf',
  avaal: 'avaal-blue-esso-2026-09-04.pdf',
  flyingJ: 'flying-j-cad-2026-09-09.pdf',
  ta: 'ta-petro-2026-09-09.pdf',
};

let pass = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass += 1; return; }
  failures.push({ name, detail: detail === undefined ? '' : detail });
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function throwsCode(name, fn, code) {
  try { await fn(); check(name, false, 'no error thrown'); }
  catch (e) { check(name, e.code === code, `expected code ${code}, got ${e.code} (${e.message})`); }
}
function read(f) { return fs.readFileSync(path.join(FIX, f)); }
function row(sheet, key, value) {
  return sheet.rows.find((r) => String(r.text[key]) === String(value));
}
const fm = (int, dp) => shared.fmtMoney(int, dp);

// =========================================================================
(async function run() {
  // ---------------------------------------------------------------- money layer
  eq('parseMoney plain', shared.parseMoney('2.0090').int, 2009000);
  eq('parseMoney with $ and space', shared.parseMoney('$ 195.50').int, 195500000);
  eq('parseMoney keeps dp', shared.parseMoney('195.50').dp, 2);
  eq('parseMoney dash is zero', shared.parseMoney('-').int, 0);
  eq('parseMoney thousands separator', shared.parseMoney('1,234.56').int, 1234560000);
  eq('parseMoney parenthesised negative', shared.parseMoney('(1.25)').int, -1250000);
  eq('parseMoney rejects text', shared.parseMoney('abc'), null);
  eq('parseMoney rejects empty', shared.parseMoney(''), null);
  eq('parseMoney refuses more precision than modelled', shared.parseMoney('1.1234567'), null);
  eq('fmtMoney 4dp', fm(2009000, 4), '2.0090');
  eq('fmtMoney 2dp', fm(195500000, 2), '195.50');
  eq('fmtMoney 0dp', fm(2000000, 0), '2');
  eq('roundToDp truncates to 3dp, half-up', margin.roundToDp(2009500, 3), 2010000);
  eq('roundToDp rounds up at half', margin.roundToDp(1500, 3), 2000);
  eq('roundToDp leaves exact values', margin.roundToDp(2009000, 4), 2009000);
  eq('divRound half-up', shared.divRound(5, 2), 3);
  // BigInt path: a percent margin on a cents-per-litre sheet overflows a double
  eq('mulDivRound 5% of 2.0090', shared.mulDivRound(2009000, 5000000, 100 * 1e6), 100450);
  eq('mulDivRound 100% of 263.34 cents is exact', shared.mulDivRound(263340000, 100 * 1e6, 100 * 1e6), 263340000);
  eq('mulDivRound keeps the sign', shared.mulDivRound(-2000000, 3000000, 1000000), -6000000);
  eq('mulDivRound rounds half-up', shared.mulDivRound(3, 1, 2), 2);
  await throwsCode('mulDivRound refuses a result it cannot represent exactly',
    () => shared.mulDivRound(Number.MAX_SAFE_INTEGER, 1000000, 1), 'price_out_of_range');
  check('the same multiply in doubles would have been wrong',
    !Number.isSafeInteger(263340000 * (100 * 1e6)),
    'the overflow this guards against no longer exists — re-check the guard');
  eq('divRound negative half-up', shared.divRound(-5, 2), -3);

  // ---------------------------------------------------------------- dates
  eq('date: Month D, YYYY', shared.parseLooseDate('Price Effective : September 9, 2026 at 12 am'), '2026-09-09');
  eq('date: ordinal', shared.parseLooseDate('Effective Date: September 9th, 2026'), '2026-09-09');
  eq('date: MM/DD/YYYY', shared.parseLooseDate('Effective Date 09/04/2026 - 09/07/2026'), '2026-09-04');
  eq('date: ISO', shared.parseLooseDate('(As of: 2026-08-24)'), '2026-08-24');
  eq('date: none', shared.parseLooseDate('no date here'), null);

  // ---------------------------------------------------------------- registry
  eq('registry lists four vendors', reg.VENDORS.length, 4);
  for (const key of Object.keys(F)) {
    const det = await reg.detectVendor(read(F[key]), F[key]);
    check(`detect ${key}`, !!det.vendor, JSON.stringify(det));
  }
  await throwsCode('empty upload refused', () => reg.parseSheet(Buffer.alloc(0), { filename: 'x.pdf' }), 'empty_file');
  await throwsCode('corrupt pdf refused', () => reg.parseSheet(Buffer.from('%PDF-1.4 nope'), { filename: 'x.pdf' }), 'pdf_unreadable');
  await throwsCode('unsupported type refused', () => reg.parseSheet(Buffer.from('x'), { filename: 'x.docx' }), 'unsupported_file_type');
  await throwsCode('unknown vendor refused', () => reg.parseSheet(read(F.flyingJ), { vendor: 'shell_canada' }), 'unknown_vendor');
  await throwsCode('wrong parser for file refused', () => reg.parseSheet(read(F.flyingJ), { vendor: 'ta_petro' }), 'vendor_signature_mismatch');
  await throwsCode('xlsx parser refuses a pdf', () => reg.parseSheet(read(F.avaal), { vendor: 'petro_canada' }), 'vendor_signature_mismatch');

  // ================================================================ FLYING J
  const fj = await reg.parseSheet(read(F.flyingJ), { filename: F.flyingJ });
  eq('FJ vendor', fj.meta.vendor, 'flying_j_cad');
  eq('FJ effective date', fj.meta.effectiveDate, '2026-09-09');
  eq('FJ unit', fj.meta.unit, 'per_litre');
  eq('FJ currency', fj.meta.currency, 'CAD');
  eq('FJ pages', fj.stats.pages, 2);
  eq('FJ row count', fj.stats.rows, 54);
  eq('FJ nothing unparsed', fj.stats.unparsed, 0);
  eq('FJ nothing flagged', fj.stats.flagged, 0);
  eq('FJ no warnings', fj.warnings.length, 0);
  eq('FJ confidential notice detected', fj.meta.confidentialNotice, true);
  eq('FJ base column', fj.baseColumn, 'price_ex_tax');
  {
    const r = row(fj, 'site_number', '813');
    eq('FJ 813 name', r.text.name, 'Airdrie');
    eq('FJ 813 address', r.text.address, '85 EAST LAKE CRESENT');
    eq('FJ 813 region', r.text.region, 'AB');
    eq('FJ 813 base', fm(r.money.price_ex_tax.int, 4), '2.0090');
    eq('FJ 813 gst', fm(r.money.gst.int, 4), '0.1005');
    eq('FJ 813 pst', fm(r.money.pst.int, 4), '0.0000');
    eq('FJ 813 total', fm(r.money.total.int, 4), '2.1095');
  }
  {
    // this row's address is printed across two lines in the PDF
    const r = row(fj, 'site_number', '850');
    eq('FJ wrapped address merged in printed order', r.text.address, 'CA HWY 16 & HWY 2 EX 170 ST NW');
  }
  {
    const r = row(fj, 'site_number', '463'); // ON row, HST rather than GST
    eq('FJ Ontario HST read', fm(r.money.gst.int, 4), '0.2557');
    eq('FJ Ontario total', fm(r.money.total.int, 4), '2.2232');
  }
  eq('FJ every row carries a province', fj.rows.filter((r) => !r.text.region).length, 0);
  eq('FJ every row identity holds', fj.rows.filter((r) => r.flags.some((f) => f.code === 'identity_failed')).length, 0);
  eq('FJ vendor columns add up exactly', fj.stats.vendorRoundingDrift, 0);
  eq('FJ every row cross-checked', fj.rows.filter((r) => r.flags.some((f) => f.code.startsWith('cross_check'))).length, 0);

  // ================================================================ AVAAL
  const av = await reg.parseSheet(read(F.avaal), { filename: F.avaal });
  eq('AVAAL vendor', av.meta.vendor, 'avaal_blue_esso');
  eq('AVAAL effective from', av.meta.effectiveDate, '2026-09-04');
  eq('AVAAL effective to', av.meta.effectiveTo, '2026-09-07');
  eq('AVAAL unit is cents per litre', av.meta.unit, 'cents_per_litre');
  eq('AVAAL pages', av.stats.pages, 3);
  eq('AVAAL row count', av.stats.rows, 76);
  eq('AVAAL nothing unparsed', av.stats.unparsed, 0);
  eq('AVAAL nothing flagged', av.stats.flagged, 0);
  eq('AVAAL reports the vendor\'s own penny rounding', av.stats.vendorRoundingDrift, 12);
  eq('AVAAL warns about it once', av.warnings.filter((w) => w.code === 'vendor_rounding_drift').length, 1);
  eq('AVAAL raises no other warning', av.warnings.filter((w) => w.code !== 'vendor_rounding_drift').length, 0);
  {
    const r = row(av, 'site_id', '53936');
    eq('AVAAL 53936 location', r.text.location, 'ESSO ATMORE');
    eq('AVAAL 53936 product', r.text.product, 'DSL EFF LS');
    eq('AVAAL 53936 price', fm(r.money.price.int, 2), '195.50');
    eq('AVAAL 53936 gst', fm(r.money.gst.int, 2), '9.78');
    eq('AVAAL dash means zero', fm(r.money.pst.int, 2), '0.00');
    eq('AVAAL 53936 gross', fm(r.money.gross.int, 2), '205.28');
  }
  {
    const r = row(av, 'site_id', '59467'); // QC row: PST/QST is populated
    eq('AVAAL QC pst', fm(r.money.pst.int, 2), '22.66');
    eq('AVAAL QC gross', fm(r.money.gross.int, 2), '261.22');
  }
  {
    const r = row(av, 'site_id', '62169'); // NS row: much higher HST
    eq('AVAAL NS hst', fm(r.money.gst.int, 2), '29.89');
  }
  eq('AVAAL two products present', [...new Set(av.rows.map((r) => r.text.product))].sort().join('|'), 'DIESEL LS|DSL EFF LS');
  eq('AVAAL no row misread', av.rows.filter((r) => r.flags.some((f) => f.severity !== 'info')).length, 0);

  // ================================================================ TA / PETRO
  const ta = await reg.parseSheet(read(F.ta), { filename: F.ta });
  eq('TA vendor', ta.meta.vendor, 'ta_petro');
  eq('TA effective date', ta.meta.effectiveDate, '2026-09-09');
  eq('TA unit is per gallon', ta.meta.unit, 'per_gallon');
  eq('TA currency is USD', ta.meta.currency, 'USD');
  eq('TA pages', ta.stats.pages, 18);
  eq('TA row count', ta.stats.rows, 350);
  eq('TA nothing unparsed', ta.stats.unparsed, 0);
  eq('TA nothing flagged', ta.stats.flagged, 0);
  eq('TA base column is the price the client pays', ta.baseColumn, 'actual');
  {
    const r = row(ta, 'location_no', '6319');
    eq('TA 6319 travel center', r.text.travel_center, 'PETRO BUCKSVILLE');
    eq('TA 6319 state', r.text.region, 'AL');
    eq('TA 6319 merchant id', r.text.merchant_id, '514619');
    eq('TA 6319 city/state', r.text.city_state, 'BIRMINGHAM, AL');
    eq('TA two-line product merged', r.text.product, 'DIESEL ULTRA LOW SULFUR');
    eq('TA 6319 retail', fm(r.money.retail.int, 4), '5.7990');
    eq('TA 6319 actual', fm(r.money.actual.int, 3), '5.524');
    eq('TA 6319 savings', fm(r.money.savings.int, 3), '0.275');
  }
  {
    const r = row(ta, 'location_no', '6326');
    eq('TA bio product merged', r.text.product, 'DIESEL BIO ULTRA LS 20%');
  }
  eq('TA every row has a product', ta.rows.filter((r) => !r.text.product).length, 0);
  eq('TA every row has a merchant id', ta.rows.filter((r) => !/^\d+$/.test(r.text.merchant_id)).length, 0);
  eq('TA every row identity holds', ta.rows.filter((r) => r.flags.length).length, 0);
  eq('TA vendor columns add up exactly', ta.stats.vendorRoundingDrift, 0);
  eq('TA location numbers are unique per product', new Set(ta.rows.map((r) => `${r.text.location_no}|${r.text.product}`)).size, 350);

  // ================================================================ PETRO-CANADA
  const pc = await reg.parseSheet(read(F.petro), { filename: F.petro });
  eq('PC vendor', pc.meta.vendor, 'petro_canada');
  eq('PC first sheet is the default', pc.meta.sheetName, 'Aug. 24th Pricing');
  eq('PC effective date', pc.meta.effectiveDate, '2026-08-24');
  eq('PC unit', pc.meta.unit, 'per_litre');
  eq('PC row count', pc.stats.rows, 339);
  eq('PC blank separator rows skipped', pc.stats.blankRows > 0, true);
  eq('PC nothing unparsed', pc.stats.unparsed, 0);
  eq('PC nothing flagged', pc.stats.flagged, 0);
  eq('PC warns that the workbook holds more than one day', pc.warnings.some((w) => w.code === 'multiple_sheets'), true);
  eq('PC lists both days', pc.meta.availableSheets.map((s) => s.effectiveDate).join(','), '2026-08-24,2026-08-25');
  {
    const r = row(pc, 'site_name', 'DEER LAKE');
    eq('PC DEER LAKE region', r.text.region, 'NL');
    eq('PC DEER LAKE price', fm(r.money.price_ex_sales_tax.int, 4), '2.0083');
    eq('PC DEER LAKE carbon etc', fm(r.money.cbn_pft_utt.int, 4), '0.0950');
    eq('PC DEER LAKE base', fm(r.money.base_ex_all_tax.int, 4), '1.9133');
  }
  {
    const second = await reg.parseSheet(read(F.petro), { filename: F.petro, sheet: 1 });
    eq('PC second sheet name', second.meta.sheetName, 'Aug. 25th - Pricing');
    eq('PC second sheet date', second.meta.effectiveDate, '2026-08-25');
    eq('PC second sheet row count', second.stats.rows, 339);
    const r = row(second, 'site_name', 'DEER LAKE');
    eq('PC second sheet has its own prices', fm(r.money.price_ex_sales_tax.int, 4), '1.9403');
    const byName = await reg.parseSheet(read(F.petro), { filename: F.petro, sheet: 'Aug. 25th - Pricing' });
    eq('PC sheet selectable by name', byName.meta.sheetName, 'Aug. 25th - Pricing');
  }
  await throwsCode('PC unknown sheet refused', () => reg.parseSheet(read(F.petro), { filename: F.petro, sheet: 'Nope' }), 'sheet_not_found');
  eq('PC every row identity holds', pc.rows.filter((r) => r.flags.length).length, 0);
  eq('PC vendor columns add up exactly', pc.stats.vendorRoundingDrift, 0);

  // total across all four
  eq('all four vendors together', fj.stats.rows + av.stats.rows + ta.stats.rows + pc.stats.rows, 819);

  // ================================================================ MARGIN: validation
  const R = (o) => () => margin.normalizeProfile({ rules: [o] });
  await throwsCode('rule needs a value', R({ scope: 'global', mode: 'flat', value: '' }), 'rule_value_invalid');
  await throwsCode('rule value cannot be text', R({ scope: 'global', mode: 'flat', value: 'abc' }), 'rule_value_invalid');
  await throwsCode('negative value refused, use subtract', R({ scope: 'global', mode: 'flat', value: '-1' }), 'rule_value_negative');
  await throwsCode('bad scope refused', R({ scope: 'planet', value: '1' }), 'rule_scope_invalid');
  await throwsCode('bad mode refused', R({ scope: 'global', mode: 'sideways', value: '1' }), 'rule_mode_invalid');
  await throwsCode('bad direction refused', R({ scope: 'global', direction: 'up', value: '1' }), 'rule_direction_invalid');
  await throwsCode('region rule needs a match', R({ scope: 'region', value: '1' }), 'rule_match_required');
  await throwsCode('empty profile refused', () => margin.normalizeProfile({ rules: [] }), 'profile_has_no_rules');
  await throwsCode('bad rounding refused', () => margin.normalizeProfile({ roundingDp: 9, rules: [{ scope: 'global', value: '1' }] }), 'rounding_dp_invalid');
  await throwsCode('bad tax mode refused', () => margin.normalizeProfile({ taxMode: 'invent', rules: [{ scope: 'global', value: '1' }] }), 'tax_mode_invalid');

  // ================================================================ MARGIN: behaviour
  {
    // zero margin must reproduce the vendor sheet to the cent, on every vendor
    for (const [name, sheet] of [['FJ', fj], ['AVAAL', av], ['TA', ta], ['PC', pc]]) {
      const z = margin.priceSheet(sheet, { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0' }] });
      const base = sheet.baseColumn;
      const baseMismatch = z.rows.filter((r) => r.finalInt !== r.money[base].int);
      eq(`${name}: zero margin reproduces the base price exactly`, baseMismatch.length, 0);
      const taxMismatch = z.rows.filter((r) => z.taxColumns.some((k) => r.money[k] && r.taxes[k] !== r.money[k].int));
      eq(`${name}: zero margin reproduces every tax column exactly`, taxMismatch.length, 0);
      if (z.totalColumn) {
        const drifted = sheet.stats.vendorRoundingDrift || 0;
        const totMismatch = z.rows.filter((r) => r.totalInt !== r.money[z.totalColumn].int);
        // our total is always the sum of the figures we print; it can only differ from
        // the vendor's printed total on rows where the vendor's own columns disagree
        eq(`${name}: zero margin total differs only where the vendor's own columns do`, totMismatch.length, drifted);
        const tol = name === 'AVAAL' ? 10000 : 100;
        const beyond = totMismatch.filter((r) => Math.abs(r.totalInt - r.money[z.totalColumn].int) > tol);
        eq(`${name}: and never by more than the vendor's last printed decimal`, beyond.length, 0);
      }
      eq(`${name}: zero margin has no blockers`, z.blockers.length, 0);
      eq(`${name}: the vendor's own rounding does not block publishing`, z.blockers.some((b) => b.code === 'rows_flagged_by_parser'), false);
      eq(`${name}: every row priced`, z.totals.unpriced, 0);
    }
  }
  {
    const p = margin.priceSheet(fj, {
      taxMode: 'recompute',
      rules: [
        { scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' },
        { scope: 'region', match: 'BC', mode: 'flat', direction: 'add', value: '0.0800' },
        { scope: 'site', match: 'Yorkton', mode: 'percent', direction: 'add', value: '3' },
      ],
    });
    eq('margin: no blockers', p.blockers.length, 0);
    eq('margin: all rows priced', p.totals.priced, 54);
    const ab = p.rows.find((r) => r.text.site_number === '813');
    eq('margin: global flat applied', fm(ab.finalInt, 4), '2.0590');
    eq('margin: global rule reported', ab.rule.scope, 'global');
    eq('margin: tax recomputed on the new price', fm(ab.taxes.gst, 4), '0.1030');
    eq('margin: total is new price plus new taxes', fm(ab.totalInt, 4), '2.1620');
    const bc = p.rows.find((r) => r.text.site_number === '827');
    eq('margin: region rule beats global', bc.rule.scope, 'region');
    eq('margin: region flat applied', fm(bc.finalInt, 4), '2.4420');
    const yk = p.rows.find((r) => r.text.site_number === '844');
    eq('margin: site rule beats region and global', yk.rule.scope, 'site');
    eq('margin: percent of 2.0335 at 3% is 0.0610', fm(yk.marginInt, 4), '0.0610');
    eq('margin: percent final', fm(yk.finalInt, 4), '2.0945');
    eq('margin: rules actually used are reported', p.totals.rulesUsed.join(','), '0,1,2');
  }
  {
    // product scope, on the vendor that has real product variety
    const p = margin.priceSheet(ta, {
      rules: [
        { scope: 'global', mode: 'flat', direction: 'add', value: '0.100' },
        { scope: 'product', match: 'DIESEL BIO ULTRA LS 20%', mode: 'flat', direction: 'add', value: '0.250' },
      ],
    });
    const bio = p.rows.find((r) => r.text.product === 'DIESEL BIO ULTRA LS 20%');
    eq('margin: product rule matched', bio.rule.scope, 'product');
    eq('margin: product margin applied', fm(bio.marginInt, 3), '0.250');
    const plain = p.rows.find((r) => r.text.product === 'DIESEL ULTRA LOW SULFUR');
    eq('margin: other products fall back to global', plain.rule.scope, 'global');
    eq('margin: TA output keeps 3 decimals', fm(plain.finalInt, 3), fm(plain.baseInt + 100000, 3));
    eq('margin: TA has no tax columns to recompute', p.taxColumns.length, 0);
    eq('margin: TA has no total column', p.totalColumn, null);
  }
  {
    // subtract, and the guard against pricing below zero
    const p = margin.priceSheet(fj, { rules: [{ scope: 'global', mode: 'flat', direction: 'subtract', value: '0.0100' }] });
    const r = p.rows.find((x) => x.text.site_number === '813');
    eq('margin: subtract lowers the price', fm(r.finalInt, 4), '1.9990');
    eq('margin: subtract reports a negative margin', fm(r.marginInt, 4), '-0.0100');
    const wipe = margin.priceSheet(fj, { rules: [{ scope: 'global', mode: 'flat', direction: 'subtract', value: '99' }] });
    eq('margin: prices at or below zero are blocked', wipe.blockers.some((b) => b.code === 'non_positive_price'), true);
    eq('margin: those rows are not priced', wipe.totals.priced, 0);
  }
  {
    // a sheet with no rule covering some rows must not publish
    const p = margin.priceSheet(fj, { rules: [{ scope: 'region', match: 'BC', mode: 'flat', direction: 'add', value: '0.05' }] });
    const blocker = p.blockers.find((b) => b.code === 'rows_without_rule');
    check('margin: rows with no rule are blocked', !!blocker, JSON.stringify(p.blockers));
    eq('margin: only BC rows priced', p.totals.priced, fj.rows.filter((r) => r.text.region === 'BC').length);
  }
  {
    // preserve mode leaves the vendor's tax numbers alone
    const p = margin.priceSheet(fj, { taxMode: 'preserve', rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' }] });
    const r = p.rows.find((x) => x.text.site_number === '813');
    eq('margin: preserve keeps the vendor GST', fm(r.taxes.gst, 4), '0.1005');
    eq('margin: preserve still moves the total', fm(r.totalInt, 4), '2.1595');
  }
  {
    // rounding is explicit, and the reported margin is the one actually applied
    const p = margin.priceSheet(fj, { roundingDp: 2, rules: [{ scope: 'global', mode: 'percent', direction: 'add', value: '3.7' }] });
    const r = p.rows.find((x) => x.text.site_number === '813');
    eq('margin: rounded to 2dp', fm(r.finalInt, 2), '2.08');
    eq('margin: reported margin matches the rounded price', r.baseInt + r.marginInt, r.finalInt);
  }
  {
    // the overflow case, end to end: a 100% margin on the cents-per-litre feed
    const p = margin.priceSheet(av, { rules: [{ scope: 'global', mode: 'percent', direction: 'add', value: '100' }] });
    const r = p.rows.find((x) => x.text.site_id === '53936');
    eq('margin: 100% of 195.50 cents is exactly 391.00', fm(r.finalInt, 2), '391.00');
    eq('margin: its tax is recomputed exactly', fm(r.taxes.gst, 2), '19.56');
    eq('margin: and the total is the sum of what is printed', r.totalInt, r.finalInt + r.taxes.gst + r.taxes.pst);
    eq('margin: no blockers on a large but valid margin', p.blockers.length, 0);
  }
  {
    // Defence in depth against a value nobody could mean. The first wall is the rule
    // validator: a number too large to hold exactly is refused before it is stored.
    await throwsCode('margin: a value too large to represent is refused outright',
      () => margin.normalizeProfile({ rules: [{ scope: 'global', mode: 'percent', direction: 'add', value: '99999999999999999' }] }),
      'rule_value_invalid');
    // The second wall is mulDivRound (tested above). Between them, an absurd but
    // REPRESENTABLE margin is still computed exactly rather than silently drifting —
    // which is the property that matters, because the preview is what catches a typo.
    const p = margin.priceSheet(av, { rules: [{ scope: 'global', mode: 'percent', direction: 'add', value: '10000' }] });
    const r = p.rows.find((x) => x.text.site_id === '53936');
    eq('margin: 10000% of 195.50 is exactly 19745.50', fm(r.finalInt, 2), '19745.50');
    eq('margin: its columns still add up', r.totalInt, r.finalInt + r.taxes.gst + r.taxes.pst);
    eq('margin: a huge margin is not silently blocked either — the preview shows it', p.blockers.length, 0);
  }
  {
    // a sheet with no locations on it is not publishable
    const empty = margin.priceSheet(
      { meta: av.meta, columns: av.columns, baseColumn: av.baseColumn, rows: [] },
      { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '1' }] },
    );
    eq('margin: an empty sheet is blocked', empty.blockers.some((b) => b.code === 'sheet_has_no_rows'), true);
  }
  {
    // whatever rounding is chosen, the printed columns must add up to the printed total
    for (const dpChoice of [2, 3, 4]) {
      const p = margin.priceSheet(fj, {
        roundingDp: dpChoice,
        rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' }],
      });
      const bad = p.rows.filter((r) => r.priced && r.totalInt !== r.finalInt + r.taxes.gst + r.taxes.pst);
      eq(`margin: at ${dpChoice}dp the total is the sum of the printed columns`, bad.length, 0);
      const unaligned = p.rows.filter((r) => r.priced
        && [r.finalInt, r.taxes.gst, r.taxes.pst, r.totalInt].some((v) => margin.roundToDp(v, dpChoice) !== v));
      eq(`margin: at ${dpChoice}dp every printed figure is aligned to it`, unaligned.length, 0);
    }
  }
  {
    // preserve mode also has to print figures that add up
    const p = margin.priceSheet(fj, {
      taxMode: 'preserve', roundingDp: 2,
      rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '0.0500' }],
    });
    const bad = p.rows.filter((r) => r.priced && r.totalInt !== r.finalInt + r.taxes.gst + r.taxes.pst);
    eq('margin: preserve mode still adds up at the chosen rounding', bad.length, 0);
  }
  {
    // units are never rewritten by pricing
    const p = margin.priceSheet(av, { rules: [{ scope: 'global', mode: 'flat', direction: 'add', value: '5' }] });
    eq('margin: AVAAL stays in cents per litre', p.unit, 'cents_per_litre');
    eq('margin: AVAAL unit label', p.unitLabel, '¢/L');
    const r = p.rows.find((x) => x.text.site_id === '53936');
    eq('margin: a flat margin is in the sheet\'s own unit', fm(r.finalInt, 2), '200.50');
    eq('margin: cents sheet keeps 2 decimals', p.dp, 2);
  }
  {
    // site rules match on the id as well as the name
    const p = margin.priceSheet(av, {
      rules: [
        { scope: 'global', mode: 'flat', direction: 'add', value: '1' },
        { scope: 'site', match: '53936', mode: 'flat', direction: 'add', value: '7' },
      ],
    });
    const r = p.rows.find((x) => x.text.site_id === '53936');
    eq('margin: site rule matched by id', fm(r.marginInt, 2), '7.00');
  }

  // ================================================================ ANY OTHER SHEET
  // The four named parsers cover the vendors this client uses today. Anything else is
  // read as a plain table — which must work, but must never pretend to be verified.
  {
    const g = await reg.parseSheet(read(F.unknownXlsx), { filename: F.unknownXlsx });
    eq('unknown xlsx: read by the generic reader', g.meta.vendor, 'generic');
    eq('unknown xlsx: every row found', g.stats.rows, 8);
    eq('unknown xlsx: nothing unparsed', g.stats.unparsed, 0);
    eq('unknown xlsx: column labels come from its own header', g.columns.map((c) => c.label).join('|'), 'Terminal|Prov|Grade|Rack Price|Freight|Delivered');
    eq('unknown xlsx: number columns spotted', g.columns.filter((c) => c.kind === 'money').map((c) => c.label).join(','), 'Rack Price,Freight,Delivered');
    eq('unknown xlsx: text columns spotted', g.columns.filter((c) => c.kind === 'text').length, 3);
    eq('unknown xlsx: effective date read off the banner', g.meta.effectiveDate, '2026-09-14');
    // the important part: it refuses to decide which column is the price
    eq('unknown xlsx: no price column is assumed', g.baseColumn, null);
    eq('unknown xlsx: no unit is assumed', g.meta.unit, null);
    eq('unknown xlsx: it asks to be mapped', g.meta.mappingRequired, true);
    eq('unknown xlsx: and says it is unverified', g.warnings.some((w) => w.code === 'unverified_layout'), true);
    const r = g.rows[0];
    eq('unknown xlsx: first row text', `${r.text.col1}|${r.text.col2}`, 'Sarnia|ON');
    eq('unknown xlsx: first row price', fm(r.money.col4.int, 4), '1.6421');
    eq('unknown xlsx: first row derived total', fm(r.money.col6.int, 4), '1.6731');
  }
  {
    const g = await reg.parseSheet(read(F.unknownPdf), { filename: F.unknownPdf });
    eq('unknown pdf: read by the generic reader', g.meta.vendor, 'generic');
    eq('unknown pdf: every row found', g.stats.rows, 7);
    eq('unknown pdf: nothing unparsed', g.stats.unparsed, 0);
    eq('unknown pdf: its confidentiality line is noticed', g.meta.confidentialNotice, true);
    eq('unknown pdf: effective date read', g.meta.effectiveDate, '2026-09-12');
    eq('unknown pdf: it asks to be mapped', g.meta.mappingRequired, true);
    eq('unknown pdf: at least four number columns found', g.columns.filter((c) => c.kind === 'money').length >= 4, true);
    // the fixture carries one deliberately malformed value ("1.9-")
    eq('unknown pdf: a malformed value is flagged, not swallowed', g.stats.flagged, 1);
    eq('unknown pdf: and only that row', g.rows.filter((r) => r.flags.length).length, 1);
  }
  {
    // a vendor we DO know must never fall through to the generic reader
    for (const [name, file, vendor] of [
      ['Flying J', F.flyingJ, 'flying_j_cad'],
      ['AVAAL', F.avaal, 'avaal_blue_esso'],
      ['TA', F.ta, 'ta_petro'],
      ['Petro-Canada', F.petro, 'petro_canada'],
    ]) {
      const det = await reg.detectVendor(read(file), file);
      eq(`${name} is still recognised by its own parser`, det.vendor, vendor);
    }
  }
  {
    // a file with no table in it is still refused — "read anything" is not "accept anything"
    await throwsCode('a text file with no table is refused',
      () => reg.parseSheet(Buffer.from('just some words\nand another line\n'), { filename: 'notes.csv' }), 'no_table_found');
  }

  // ---------------------------------------------------------------- report
  const total = pass + failures.length;
  console.log(`\nfuel sheets: ${pass}/${total} checks passed`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log(`  ✗ ${f.name}\n      ${f.detail}`));
    process.exit(1);
  }
  console.log('all good\n');
})().catch((e) => { console.error('\nTEST RUNNER CRASHED:', e); process.exit(1); });
