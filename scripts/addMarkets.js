/**
 * Add a curated set of markets to the live results collection.
 *
 * WHY CURATED AND NOT AUTO-ADD:
 *   The source publishes ~163 markets. Taking all of them would push the app
 *   from 18 to 160 and bury Kalyan under a wall of obscure markets — the
 *   opposite of what the app is positioned for. So auto-add is off by default
 *   and coverage grows through this list instead.
 *
 * SELECTION PRINCIPLE — complete the families we already carry:
 *   Someone who follows Rajdhani Night wants Rajdhani Day. Someone who follows
 *   Madhur Day wants Madhur Morning. Those users convert and stay. Nobody who
 *   came for Kalyan wants "Teen Patti" or "1000 Dollar Night".
 *
 * NAME CASING:
 *   The source publishes UPPERCASE ("RAJDHANI DAY") while our existing rows are
 *   Title Case ("Rajdhani Night"). We store the Title Case form so the list
 *   doesn't look broken. This is safe: the updater matches on normalizeName(),
 *   which lower-cases both sides, so scrapes still find these rows.
 *
 * LIVE DATA:
 *   Times and results come from GET /KalyanKing/probeSource rather than being
 *   hard-coded, so nothing goes in stale. That endpoint runs server-side because
 *   the source blocks non-datacenter IPs.
 *
 * Usage:
 *   MONGODB_URI=... node scripts/addMarkets.js --dry
 *   MONGODB_URI=... node scripts/addMarkets.js
 */

const axios = require('axios');
const mongoose = require('mongoose');

const PROBE_URL =
  process.env.PROBE_URL || 'https://mobile-app-api-opal.vercel.app/KalyanKing/probeSource';

// sourceName (as published, upper-case) -> { displayName, priority }
// priority: 3 = flagship, 2 = well-known, 1 = regional
const CURATED = {
  // Completes Rajdhani — we carry Night only. Highest-value single addition.
  'RAJDHANI DAY': { displayName: 'Rajdhani Day', priority: 3 },

  // "main mumbai" appeared 7x across competitor listings; we carry neither.
  'MAIN MUMBAI NIGHT': { displayName: 'Main Mumbai Night', priority: 3 },
  'OLD MAIN MUMBAI': { displayName: 'Old Main Mumbai', priority: 2 },
  'MAIN MUMBAI RK': { displayName: 'Main Mumbai RK', priority: 2 },

  // Completes Main Bazar (we carry the 10:00 PM one).
  'MAIN BAZAR MORNING': { displayName: 'Main Bazar Morning', priority: 2 },
  'MAIN BAZAR DAY': { displayName: 'Main Bazar Day', priority: 2 },
  'MAIN BAZAR NIGHT': { displayName: 'Main Bazar Night', priority: 2 },

  // Completes Milan — we carry Morning/Day/Night of the plain Milan family.
  'MILAN BAZAR MORNING': { displayName: 'Milan Bazar Morning', priority: 2 },
  'MILAN BAZAR DAY': { displayName: 'Milan Bazar Day', priority: 2 },
  'MILAN BAZAR NIGHT': { displayName: 'Milan Bazar Night', priority: 2 },

  // Completes Madhur (we carry Day + Night).
  'MADHUR MORNING': { displayName: 'Madhur Morning', priority: 2 },

  // Completes Sridevi (we carry Sridevi + Sridevi Night).
  'SRIDEVI MORNING': { displayName: 'Sridevi Morning', priority: 2 },
  'SRIDEVI DAY': { displayName: 'Sridevi Day', priority: 2 },

  // Kalyan-branded markets — reinforce the app's core keyword.
  'KALYAN SRIDEVI': { displayName: 'Kalyan Sridevi', priority: 2 },
  'KALYAN SRIDEVI NIGHT': { displayName: 'Kalyan Sridevi Night', priority: 2 },

  // Completes Time Bazar (we carry Morning/Day/plain).
  'NEW TIME BAZAR': { displayName: 'New Time Bazar', priority: 2 },
  'NIGHT TIME BAZAR': { displayName: 'Night Time Bazar', priority: 2 },
  'TIME NIGHT': { displayName: 'Time Night', priority: 2 },

  // Completes the two regional markets we already carry.
  'MADHURI NIGHT': { displayName: 'Madhuri Night', priority: 1 },
  'PADMAVATHI NIGHT': { displayName: 'Padmavathi Night', priority: 1 },
};

const DRY = process.argv.includes('--dry');
const norm = (s) => String(s || '').trim().toLowerCase();

const resultSchema = new mongoose.Schema(
  {
    gameName: String,
    openTime: String,
    closeTime: String,
    result: String,
    isTop: Boolean,
    priority: Number,
  },
  { timestamps: true },
);

(async () => {
  const uri = process.env.MONGODB_URI || process.env.DATABASE;
  if (!uri) throw new Error('Set MONGODB_URI before running this script.');

  console.log(`Fetching live market data from ${PROBE_URL}\n`);
  const { data: probe } = await axios.get(PROBE_URL, { timeout: 90000 });

  const addableByName = new Map(probe.addable.map((row) => [norm(row.gameName), row]));

  const toInsert = [];
  const notAvailable = [];

  for (const [sourceName, meta] of Object.entries(CURATED)) {
    const row = addableByName.get(norm(sourceName));
    if (!row) {
      notAvailable.push(sourceName);
      continue;
    }
    toInsert.push({
      gameName: meta.displayName,
      openTime: row.openTime,
      closeTime: row.closeTime,
      result: row.result,
      isTop: false,
      priority: meta.priority,
    });
  }

  console.log(`Curated: ${Object.keys(CURATED).length}   Available now: ${toInsert.length}`);
  toInsert.forEach((m) =>
    console.log(
      `  ${DRY ? '[dry] ' : ''}+ ${m.gameName.padEnd(22)} p${m.priority}  ${m.openTime} - ${m.closeTime}`,
    ),
  );

  if (notAvailable.length) {
    console.log('\n⚠️  Curated but not offered by the source right now (skipped):');
    notAvailable.forEach((n) => console.log('   -', n));
  }

  if (!toInsert.length) {
    console.log('\nNothing to insert.');
    return;
  }

  if (DRY) {
    console.log(`\n[dry run] ${toInsert.length} market(s) would be inserted. Re-run without --dry.`);
    return;
  }

  await mongoose.connect(uri);
  const db = mongoose.connection.useDb('KalyanKing');
  const Result = db.model('Result', resultSchema, 'liveresult');

  // Upsert on gameName so re-running never duplicates. $setOnInsert means an
  // existing row is left exactly as-is.
  const res = await Result.bulkWrite(
    toInsert.map((market) => ({
      updateOne: {
        filter: { gameName: market.gameName },
        update: { $setOnInsert: market },
        upsert: true,
      },
    })),
    { ordered: false },
  );

  const inserted = Object.keys(res.upsertedIds || {})
    .map((i) => toInsert[Number(i)])
    .filter(Boolean);

  console.log(`\n✅ Inserted ${inserted.length} new market(s).`);
  if (inserted.length !== toInsert.length) {
    console.log(`   (${toInsert.length - inserted.length} already existed — left untouched.)`);
  }

  const total = await Result.countDocuments();
  console.log(`   Collection now holds ${total} markets.`);

  await mongoose.disconnect();
})().catch((e) => {
  console.error('\nFailed:', e.message);
  process.exit(1);
});
