/**
 * Guard-rail check for auto-discovered markets.
 *
 * The updater now inserts markets the source publishes that we don't store yet.
 * The source is HTML we don't control, so isPlausibleNewMarket() is what stops a
 * layout change from flooding the collection with junk. This asserts that filter
 * still behaves. Run it after touching the scraper.
 *
 * Usage: node scripts/verifyAutoAdd.js      (no DB, no network)
 */

const assert = require('assert');
const { isPlausibleNewMarket } = require('../KalyanAutoUpdateResult');

const accept = [
  { gameName: 'Rajdhani Day', openTime: '03:00 PM', closeTime: '05:00 PM', result: '123-45-678' },
  { gameName: 'Main Mumbai', openTime: '09:35 PM', closeTime: '11:59 PM', result: '460-09-478' },
  { gameName: 'Sridevi Morning', openTime: '10:00 AM', closeTime: '11:00 AM', result: '480-2' },
  { gameName: 'Kalyan (Old)', openTime: '04:02 PM', closeTime: '06:02 PM', result: '990-89-135' },
];

const reject = [
  ['no times', { gameName: 'Ghost Market', openTime: '', closeTime: '', result: '123-45-678' }],
  ['half times', { gameName: 'Half Market', openTime: '03:00 PM', closeTime: '', result: '123' }],
  ['placeholder result', { gameName: 'Pending', openTime: '01:00 PM', closeTime: '02:00 PM', result: 'Loading' }],
  ['empty result', { gameName: 'Blank', openTime: '01:00 PM', closeTime: '02:00 PM', result: '' }],
  ['name too short', { gameName: 'X', openTime: '01:00 PM', closeTime: '02:00 PM', result: '123' }],
  [
    'name too long',
    { gameName: 'A'.repeat(41), openTime: '01:00 PM', closeTime: '02:00 PM', result: '123' },
  ],
  [
    'markup leaked into name',
    { gameName: '<div>Result</div>', openTime: '01:00 PM', closeTime: '02:00 PM', result: '123' },
  ],
  [
    'prose leaked into name',
    { gameName: 'Click here for free tips!!!', openTime: '01:00 PM', closeTime: '02:00 PM', result: '123' },
  ],
];

let failures = 0;

for (const market of accept) {
  try {
    assert.strictEqual(isPlausibleNewMarket(market), true);
    console.log(`  ✅ accepts  ${market.gameName}`);
  } catch {
    failures++;
    console.log(`  ❌ WRONGLY REJECTS  ${market.gameName}`);
  }
}

for (const [label, market] of reject) {
  try {
    assert.strictEqual(isPlausibleNewMarket(market), false);
    console.log(`  ✅ rejects  ${label}`);
  } catch {
    failures++;
    console.log(`  ❌ WRONGLY ACCEPTS  ${label} (${market.gameName})`);
  }
}

if (failures) {
  console.error(`\n${failures} guard-rail check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${accept.length + reject.length} guard-rail checks passed.`);
