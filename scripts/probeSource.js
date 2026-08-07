/**
 * Diagnostic: compare what the scrape source publishes against what we store.
 *
 * The updater is deliberately update-only — it skips any scraped market that
 * isn't already in the DB (`if (!matchedDoc) continue`). That's safe, but it
 * means new markets are invisible until someone adds them. This script surfaces
 * exactly what we're missing so `addMarkets.js` can be run with real names.
 *
 * Usage:  node scripts/probeSource.js              (source only)
 *         MONGODB_URI=... node scripts/probeSource.js   (source vs DB diff)
 */

const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');

const DPBOSS_URL = process.env.DPBOSS_URL || 'https://dpboss.boston/';

const clean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
const norm = (t) => clean(t).toLowerCase();

const parseTimeRange = (text) => {
  const m = clean(text).match(/\d{1,2}:\d{2}\s*[AP]M/gi) || [];
  return { openTime: m[0] || '', closeTime: m[1] || '' };
};

const isResultValue = (text) => {
  const v = clean(text);
  return v === 'Loading...' || v === 'Loading' || /^\d[\d-]*$/.test(v);
};

async function scrape() {
  const { data } = await axios.get(DPBOSS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 30000,
  });
  const $ = cheerio.load(data);
  const results = [];

  $('h4').each((i, el) => {
    const gameName = clean($(el).text());
    if (!gameName || gameName.includes('LIVE RESULT')) return;

    const siblings = [];
    let cur = $(el).next();
    while (cur.length && siblings.length < 4) {
      const t = clean(cur.text());
      if (t) siblings.push(t);
      if (cur.is('h4')) break;
      cur = cur.next();
    }

    const result = siblings.find(isResultValue);
    const timeText = siblings.find((t) => parseTimeRange(t).openTime);
    if (!result || !timeText) return;

    const { openTime, closeTime } = parseTimeRange(timeText);
    results.push({
      gameName,
      result: result.includes('Loading') ? 'Loading' : result,
      openTime,
      closeTime,
    });
  });

  return results;
}

(async () => {
  const scraped = await scrape();
  console.log(`\nSOURCE publishes ${scraped.length} markets:\n`);
  scraped.forEach((r, i) =>
    console.log(
      `${String(i + 1).padStart(2)}. ${r.gameName.padEnd(30)} ${r.openTime.padEnd(9)} ${r.closeTime.padEnd(9)} ${r.result}`,
    ),
  );

  const uri = process.env.MONGODB_URI || process.env.DATABASE;
  if (!uri) {
    console.log('\n(set MONGODB_URI to also diff against the database)');
    return;
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.useDb('KalyanKing');
  const Result = db.model(
    'Result',
    new mongoose.Schema({ gameName: String, priority: Number }, { strict: false }),
    'liveresult',
  );
  const stored = await Result.find({}, 'gameName').lean();
  const storedNames = new Set(stored.map((d) => norm(d.gameName)));
  const scrapedNames = new Set(scraped.map((r) => norm(r.gameName)));

  const missing = scraped.filter((r) => !storedNames.has(norm(r.gameName)));
  const orphaned = stored.filter((d) => !scrapedNames.has(norm(d.gameName)));

  console.log(`\nDB stores ${stored.length} markets.`);

  console.log(`\n🟢 IN SOURCE BUT NOT IN DB — addable (${missing.length}):`);
  missing.forEach((r) =>
    console.log(`   ${r.gameName.padEnd(30)} ${r.openTime.padEnd(9)} ${r.closeTime}`),
  );

  console.log(`\n🟠 IN DB BUT NOT IN SOURCE — will never auto-update (${orphaned.length}):`);
  orphaned.forEach((d) => console.log(`   ${d.gameName}`));

  await mongoose.disconnect();
})().catch((e) => {
  console.error('Probe failed:', e.message);
  process.exit(1);
});
