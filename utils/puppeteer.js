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

module.exports = { launchBrowser, resolveChromePath, CHROME_PATHS };
