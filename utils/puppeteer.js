// Single place that decides which Chrome renders our PDFs.
//
// Puppeteer downloads its own Chrome build into ~/.cache/puppeteer at install time. That download
// is skipped often enough (CI caches, `--ignore-scripts`, a fresh clone, a version bump that
// invalidates the cached build) that a PDF route would then die with
// "Could not find Chrome (ver. …)" — which reads like an application bug, not a missing dependency.
// Every launch therefore falls back to a Chrome already on the machine.
//
// Resolution order: PUPPETEER_EXECUTABLE_PATH (explicit wins) → a known system install → whatever
// Puppeteer bundled. Linux servers usually only have the system one; macOS dev boxes have the app.
const fs = require('fs');
const puppeteer = require('puppeteer');

const CHROME_PATHS = [
  // Linux (servers)
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  // macOS (local development)
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

function resolveChromePath() {
  const fromEnv = String(process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return CHROME_PATHS.find((p) => fs.existsSync(p)) || null;
}

// `--no-sandbox` etc. are required on the container the API runs in; harmless locally.
const DEFAULT_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];

async function launchBrowser(options = {}) {
  const executablePath = resolveChromePath();
  const launchOptions = {
    headless: true,
    args: DEFAULT_ARGS,
    ...options,
  };
  // Try the bundled build first only when there is no system Chrome; otherwise prefer the system
  // one, which is the copy that actually exists on the servers.
  if (executablePath) launchOptions.executablePath = executablePath;
  try {
    return await puppeteer.launch(launchOptions);
  } catch (err) {
    // Bundled build missing AND nothing found above: say what to do instead of leaking the
    // "Could not find Chrome" stack to the user.
    if (!executablePath && /Could not find Chrome|Browser was not found/i.test(String(err?.message || ''))) {
      const hint = new Error(
        'PDF rendering needs Chrome. Run "npx puppeteer browsers install chrome" in backend/, '
        + 'install Google Chrome, or set PUPPETEER_EXECUTABLE_PATH to an existing Chrome binary.'
      );
      hint.code = 'chrome_missing';
      throw hint;
    }
    throw err;
  }
}

// Hosts a rendering page may never reach. The browser runs INSIDE our network with the sandbox
// off, so any URL the page loads is fetched with our own network position — an `<img
// src="file:///etc/passwd">` or a hit on the cloud metadata endpoint would come back embedded in a
// PDF the caller downloads. Only public http(s) is allowed out; `data:` URIs (how logos are
// embedded) never touch the network.
function isBlockedHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '::1' ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^0\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^(fc|fd)[0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)
  );
}

// Apply to every page that renders HTML we did not fully author ourselves.
async function hardenPage(page) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url === 'about:blank') return request.continue();
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return request.abort();
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return request.abort();
    if (isBlockedHost(parsed.hostname)) return request.abort();
    return request.continue();
  });
}

module.exports = { launchBrowser, resolveChromePath, CHROME_PATHS, hardenPage, isBlockedHost };
