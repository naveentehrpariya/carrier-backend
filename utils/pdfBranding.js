/**
 * The company logo, as a data: URI, for server-rendered PDFs.
 *
 * Resolution order — cached base64 first (no network at all), then the stored URL, then the bundled
 * default. Every server-side document (payslip, owner statement, customer invoice, rate
 * confirmation) uses the same order, so a company that has uploaded a logo sees it on all of them
 * and a company that has not sees the same fallback on all of them.
 *
 * A data: URI is deliberate: `hardenPage` blocks non-public network requests inside the rendering
 * page, and data: URIs pass untouched. Fetching the logo HERE, in normal server code, keeps that
 * boundary intact.
 */
const fs = require('fs');
const path = require('path');

async function resolveCompanyLogoBase64(company) {
  let logoBase64 = company?.logo_base64 || '';

  if (!logoBase64 && (company?.pdf_logo || company?.logo)) {
    try {
      const axios = require('axios');
      const resp = await axios.get(company.pdf_logo || company.logo, { responseType: 'arraybuffer', timeout: 8000 });
      const mime = resp.headers['content-type'] || 'image/png';
      logoBase64 = `data:${mime};base64,${Buffer.from(resp.data).toString('base64')}`;
    } catch (e) { /* fall through to the bundled logo — a document without a logo is still valid */ }
  }

  if (!logoBase64) {
    try {
      const p = path.join(__dirname, '..', 'assets', 'logo.png');
      if (fs.existsSync(p)) logoBase64 = `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
    } catch (e) { /* logo is optional */ }
  }

  return logoBase64;
}

module.exports = { resolveCompanyLogoBase64 };
