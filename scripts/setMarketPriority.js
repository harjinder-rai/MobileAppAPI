/**
 * One-time (re-runnable) script: assign a persistent importance tier to each market.
 *
 * WHY A NEW FIELD INSTEAD OF isTop:
 *   isTop is owned by the auto-updater — it flags whichever market's result
 *   landed most recently and clears it on every other document each run
 *   (see KalyanAutoUpdateResult.js). Anything written there is wiped within
 *   minutes. `priority` is never touched by the updater, so it survives.
 *
 * TIERS
 *   3 = flagship markets people open the app specifically for
 *   2 = well-known secondary markets
 *   1 = regional / lower-traffic markets
 *
 * The app sorts primarily by result time (live now > upcoming > declared) and
 * uses `priority` only to break ties inside those groups.
 *
 * Usage:  node scripts/setMarketPriority.js          (apply)
 *         node scripts/setMarketPriority.js --dry    (preview, writes nothing)
 */

const mongoose = require('mongoose');

const URL =
  process.env.MONGODB_URI ||
  process.env.DATABASE ||
  (() => {
    throw new Error(
      'Set MONGODB_URI before running this script — do not hard-code credentials.',
    );
  })();

const TIERS = {
  3: ['KALYAN', 'Kalyan Night', 'Milan Day', 'Milan Night', 'Rajdhani Night', 'Main Bazar', 'Time Bazar'],
  2: [
    'Kalyan Morning',
    'Milan Morning',
    'Madhur Day',
    'Madhur Night',
    'Sridevi',
    'Sridevi Night',
    'Time Bazar Day',
    'Time Bazar Morning',
  ],
  1: ['Karnataka Day', 'Madhuri', 'Padmavathi'],
};

const DRY = process.argv.includes('--dry');

const resultSchema = new mongoose.Schema(
  { gameName: String, openTime: String, closeTime: String, result: String, isTop: Boolean, priority: Number },
  { timestamps: true },
);

const norm = (s) => String(s || '').trim().toLowerCase();

(async () => {
  await mongoose.connect(URL);
  const db = mongoose.connection.useDb('KalyanKing');
  const Result = db.model('Result', resultSchema, 'liveresult');

  const docs = await Result.find({}, 'gameName priority').lean();
  const byName = new Map(docs.map((d) => [norm(d.gameName), d]));

  const wanted = new Map();
  for (const [tier, names] of Object.entries(TIERS)) {
    for (const n of names) wanted.set(norm(n), Number(tier));
  }

  const ops = [];
  const missing = [];
  for (const [name, tier] of wanted) {
    const doc = byName.get(name);
    if (!doc) {
      missing.push(name);
      continue;
    }
    if (doc.priority === tier) continue; // already correct — idempotent
    ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { priority: tier } } } });
    console.log(`  ${DRY ? '[dry] ' : ''}${doc.gameName}: ${doc.priority ?? 'unset'} -> ${tier}`);
  }

  const untiered = docs.filter((d) => !wanted.has(norm(d.gameName)));
  if (untiered.length) {
    console.log('\nNot in any tier (will be left at priority 0):');
    untiered.forEach((d) => console.log('  -', d.gameName));
  }
  if (missing.length) {
    console.log('\n⚠️  Named in TIERS but not found in the DB (check spelling):');
    missing.forEach((n) => console.log('  -', n));
  }

  if (!ops.length) {
    console.log('\nNothing to change — all priorities already correct.');
  } else if (DRY) {
    console.log(`\n[dry run] ${ops.length} document(s) would be updated. Re-run without --dry to apply.`);
  } else {
    const res = await Result.bulkWrite(ops);
    console.log(`\n✅ Updated ${res.modifiedCount} document(s).`);
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
