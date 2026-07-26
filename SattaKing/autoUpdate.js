// Auto-update script for SattaKing daily results
// Scrapes https://esattaking.in/ and syncs with MongoDB collection "DailyResults"
// Uses the existing Khabar Mongoose model (SattaKing/modals/khabar.model.js)

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');

// Ensure DB connection (DB/index.js already connects via mongoose)
require('../DB'); // Connects using MONGODB_URI env variable
// Import the Khabar model (uses SattaKing DB via useDb)
const Khabar = require('./modals/khabar.model');
// FCM push helper — notifies subscribed users when a new result lands
const { sendTopicNotification } = require('../firebase');

// Mobile app must subscribe devices to this topic. Overridable via env.
const FCM_TOPIC = process.env.SATTAKING_FCM_TOPIC || 'sattaking_results';

// The site lists every game in its own ".matka-column" block with a plain
// English name. For the games that already existed in the app we remap the
// site name -> the existing (Hindi) display name so we UPDATE those docs
// instead of creating duplicates. Every other game is stored under its raw
// site name. Keys are the UPPERCASED site names.
const NAME_OVERRIDES = {
  'DESAWAR': 'Deshawar(देशावर)',
  'GALI': 'Gali(गली)',
  'FARIDABAD': 'Faridabad(फरीदाबाद)',
  'GAZIYABAD': 'Ghaziabad(ग़ज़िआबाद)'
};

// Games to ignore entirely — never scraped, stored, or notified. Matched
// against the UPPERCASED site name.
const EXCLUDED_GAMES = new Set(['SATTA KING']);

// Old/unwanted docs to remove so they don't linger in the app. Includes games
// that no longer exist on the site plus any excluded games above (which use
// their raw site name as the stored resultName).
const OBSOLETE_NAMES = [
  'India King(इंडिया किंग)',
  'Dubai Bazaar(दुबई बाज़ार)',
  ...EXCLUDED_GAMES
];

const URL = 'https://esattaking.in/';

// Rotate through a few realistic User-Agents to reduce intermittent anti-bot
// challenge pages. One is picked per fetch attempt.
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
];

const buildHeaders = (attempt) => ({
  'User-Agent': USER_AGENTS[attempt % USER_AGENTS.length],
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.google.com/'
});

const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The site uses several "result not declared yet" placeholders in the today
// column ("XX", "X", blank). Canonicalize all of them to "--" so downstream
// logic never stores a placeholder as a real result.
const PLACEHOLDER_RE = /^(x+|-+)$/i;
const normalizeResult = (str) => {
  const v = String(str || '').trim();
  return (v === '' || PLACEHOLDER_RE.test(v)) ? '--' : v;
};

// Tidy a scraped time string: "( 05:15 AM)" -> "05:15 AM"
const cleanTime = (str) =>
  String(str || '').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();

// Fetch the page HTML with retries + backoff + rotating User-Agent.
// A page with no game columns (typical of a challenge page) is treated as a
// retryable failure so a transient block doesn't lose the whole cycle.
async function fetchGameColumns() {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await axios.get(URL, {
        headers: buildHeaders(attempt),
        timeout: 8000 // keep a single attempt well under serverless function limits
      });
      const $ = cheerio.load(response.data);
      const cols = $('.matka-column');
      if (cols.length) {
        if (attempt > 0) console.log(`✅ Fetch succeeded on attempt ${attempt + 1}`);
        return { $, cols };
      }
      lastErr = new Error('No game columns found (possible challenge page)');
    } catch (err) {
      lastErr = err;
    }
    console.warn(`⚠️ Fetch attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${lastErr.message}`);
    if (attempt < MAX_ATTEMPTS - 1) {
      const backoff = 2000 * Math.pow(2, attempt); // 2s, 4s
      await sleep(backoff);
    }
  }
  throw lastErr || new Error('Failed to fetch game columns');
}

// ---------------------------------------------------------------------------
// Fallback sources
// If esattaking hasn't posted a game's result yet AND its result time has
// already passed, we look the game up on backup sites (in order) and use the
// first real value we find. Add more sources to FALLBACK_SOURCES as needed.
// ---------------------------------------------------------------------------

// Normalize a time to a tolerant key for matching: "05:00 AM" -> "500AM".
const timeKey = (str) =>
  String(str || '').toUpperCase().replace(/[^0-9APM]/g, '').replace(/^0+(\d)/, '$1');

// Parse "09:30 PM" (in IST) to minutes-since-midnight; null if unparseable.
function parseTimeToMinutes(str) {
  const m = String(str || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/PM/i.test(m[3])) h += 12;
  return h * 60 + parseInt(m[2], 10);
}

// Current time in IST (UTC+5:30) as minutes-since-midnight. The server may run
// in UTC (e.g. Vercel), so we compute IST explicitly rather than trust TZ.
function istMinutesNow() {
  const now = new Date();
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
}

// Has a game's declared result time already passed (in IST)?
function resultTimePassed(timeStr) {
  const t = parseTimeToMinutes(timeStr);
  if (t == null) return true; // unknown time -> allow fallback
  return istMinutesNow() >= t;
}

// Each source maps our DB name -> a matcher on that site: the name substring
// plus the time THAT site displays for the game (times differ between sites).
const FALLBACK_SOURCES = [
  {
    name: 'satta-king-fast.com',
    url: 'https://satta-king-fast.com/',
    map: {
      'Deshawar(देशावर)': { key: 'DESAWAR', time: '05:00 AM' },
      'Gali(गली)': { key: 'GALI', time: '11:25 PM' },
      'Faridabad(फरीदाबाद)': { key: 'FARIDABAD', time: '06:00 PM' },
      'Ghaziabad(ग़ज़िआबाद)': { key: 'GHAZIABAD', time: '09:25 PM' },
      'HINDUSTAN': { key: 'HINDUSTAN', time: '05:10 PM' },
      'GHAZIABAD DIN': { key: 'GHAZIABAD DIN', time: '04:35 PM' }
    },
    // Parse the page into rows: [{ text: UPPER, time: 'HH:MM AM', today }].
    parse: ($) => {
      const rows = [];
      $('table.quick-result-board tr').each((_, tr) => {
        const c = $(tr).find('td');
        if (c.length < 3) return;
        const text = $(c[0]).text().replace(/\s+/g, ' ').trim().toUpperCase();
        const tm = text.match(/\d{1,2}:\d{2}\s*(AM|PM)/);
        rows.push({ text, time: tm ? tm[0] : '', today: normalizeResult($(c[2]).text()) });
      });
      return rows;
    }
  }
];

// Fetch a URL to a cheerio document, with retries + rotating User-Agent.
async function fetchHtml(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.get(url, { headers: buildHeaders(attempt), timeout: 8000 });
      return cheerio.load(res.data);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr || new Error(`Failed to fetch ${url}`);
}

// Fill still-pending games from the fallback sources, in order. Mutates the
// `scraped` items' todayVal in place. Only runs for games that are pending AND
// whose result time has already passed (so we don't hit backups needlessly).
async function applyFallbacks(scraped) {
  let pending = scraped.filter((s) => s.todayVal === '--' && resultTimePassed(s.resultTime));
  if (!pending.length) return;
  console.log(`⏱️ ${pending.length} overdue pending game(s): ${pending.map((p) => p.dbName).join(', ')}`);

  for (const source of FALLBACK_SOURCES) {
    pending = pending.filter((s) => s.todayVal === '--');
    if (!pending.length) break;
    const applicable = pending.filter((s) => source.map[s.dbName]);
    if (!applicable.length) continue;

    let $;
    try {
      $ = await fetchHtml(source.url);
    } catch (err) {
      console.warn(`⚠️ Fallback "${source.name}" fetch failed: ${err.message}`);
      continue;
    }
    const rows = source.parse($);

    for (const s of applicable) {
      const m = source.map[s.dbName];
      const wantTime = timeKey(m.time);
      const row = rows.find((r) => r.text.includes(m.key) && timeKey(r.time) === wantTime);
      if (row && row.today && row.today !== '--') {
        s.todayVal = row.today;
        s.source = source.name;
        console.log(`↩️ Fallback: ${s.dbName} = ${s.todayVal} (from ${source.name})`);
      }
    }
  }
}

// Clean a stored game name for user-facing display: drop the Hindi suffix
// (e.g. "Gali(गली)" -> "Gali") and title-case ALL-CAPS names
// (e.g. "PUNE CITY" -> "Pune City").
function displayName(name) {
  const base = String(name).replace(/\s*\(.*?\)\s*/g, ' ').trim();
  return base === base.toUpperCase()
    ? base.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    : base;
}

// Build and send a single push summarizing the new result(s) for this run.
// Failures are swallowed inside sendTopicNotification, so this never throws.
// Copy is Hinglish for engagement, with the number shown in the title.
async function notifyNewResults(results) {
  const names = results.map((r) => displayName(r.name)).join(', ');
  const isSingle = results.length === 1;

  // Result number is intentionally NOT shown — we only announce that it's
  // declared, to drive the user to open the app. The number is still in `data`.
  const title = isSingle
    ? `${displayName(results[0].name)} ka result declare ho gaya! 🎯`
    : `${results.length} games ke result declare ho gaye! 🎯`;
  const body = isSingle
    ? `Result out ho chuka hai 👉 abhi app mein check karein`
    : `${names} ka result aa gaya — abhi dekhein 👉`;

  return sendTopicNotification({
    topic: FCM_TOPIC,
    title,
    body,
    data: {
      type: 'result_update',
      count: results.length,
      // full list for the app to render, plus the primary game for deep-linking
      results: JSON.stringify(results),
      game: results[0].name,
      result: results[0].result
    }
  });
}

// Guard against overlapping runs (e.g. a 5-min cron firing again before a
// slow run finishes) so we never double-write or send duplicate pushes.
let updateInProgress = false;

async function autoUpdateSattaKing() {
  if (updateInProgress) {
    console.log('⏭️ Skipped: an auto-update is already in progress');
    return { skipped: true };
  }
  updateInProgress = true;
  try {
    const { $, cols } = await fetchGameColumns();

    // Each ".matka-column" is one game: a ".matka-game" name, a ".timefont"
    // time, and two ".matka-number" spans (first = Last/yesterday, second =
    // Today). Empty today number = result not declared yet.
    const scraped = [];
    const seenNames = new Set();
    cols.each((_, el) => {
      const rawName = $(el).find('.matka-game').text().replace(/\s+/g, ' ').trim();
      if (!rawName) return;
      if (EXCLUDED_GAMES.has(rawName.toUpperCase())) return; // skip unwanted games
      const resultTime = cleanTime($(el).find('.timefont').text());
      const nums = $(el).find('.matka-number')
        .map((_, n) => $(n).text().replace(/\s+/g, ' ').trim()).get();
      const yesterdayVal = normalizeResult(nums[0]);
      const todayVal = normalizeResult(nums[1]);

      // Map the 4 pre-existing games to their Hindi display names; keep the
      // raw site name for everything else.
      const dbName = NAME_OVERRIDES[rawName.toUpperCase()] || rawName;
      if (seenNames.has(dbName)) return; // guard against duplicate columns
      seenNames.add(dbName);
      scraped.push({ dbName, resultTime, yesterdayVal, todayVal });
    });

    if (scraped.length === 0) {
      console.log('⚠️ No game columns parsed (page present but empty)');
      return { ok: true, scraped: 0, new: 0 };
    }

    console.log(`🔎 Scraped ${scraped.length} games: ${scraped.map(s => s.dbName).join(', ')}`);

    // For any game esattaking hasn't posted yet (and whose time has passed),
    // try the backup sources so results still reach users without delay.
    await applyFallbacks(scraped);

    // Remove obsolete docs that no longer map to any current site game.
    if (process.env.DRY_RUN) {
      const willDelete = await Khabar.countDocuments({ resultName: { $in: OBSOLETE_NAMES } });
      console.log(`🧪 DRY_RUN: would remove ${willDelete} obsolete game doc(s)`);
    } else {
      const del = await Khabar.deleteMany({ resultName: { $in: OBSOLETE_NAMES } });
      if (del.deletedCount) console.log(`🗑️ Removed ${del.deletedCount} obsolete game doc(s)`);
    }

    // Load existing records in one query
    const existingDocs = await Khabar.find({}).lean();
    const existingMap = new Map(existingDocs.map(doc => [doc.resultName, doc]));

    const bulkOps = [];
    let newTopFound = false;
    let newTopName = null;
    const changed = [];
    const newResults = []; // structured {name, result} for the push notification
    const unchanged = [];
    const pending = []; // result not declared yet on the site

    // Determine updates
    for (const item of scraped) {
      const { dbName, resultTime, yesterdayVal, todayVal } = item;
      const current = existingMap.get(dbName);
      let isNew = false;
      if (todayVal && todayVal !== '--') {
        if (!current || current.todayResult !== todayVal) {
          isNew = true;
          changed.push(`${dbName}: ${current ? current.todayResult : '(none)'} -> ${todayVal}`);
          newResults.push({ name: dbName, result: todayVal });
        } else {
          unchanged.push(dbName);
        }
      } else {
        pending.push(dbName);
      }

      if (isNew && !newTopFound) {
        // First new result becomes the top entry
        newTopFound = true;
        newTopName = dbName;
      }

      const update = {
        resultName: dbName,
        resultTime: resultTime,
        lastResult: yesterdayVal,
        todayResult: todayVal,
        updatedAt: new Date(),
        top: isNew ? true : (current ? current.top : false)
      };

      // If this entry is not the new top but a later new result appears, ensure top is false
      if (isNew && newTopFound && dbName !== newTopName) {
        update.top = false;
      }

      bulkOps.push({
        updateOne: {
          filter: { resultName: dbName },
          update: { $set: update },
          upsert: true
        }
      });
    }

    // If a new top was found, clear top flag on all other docs in a single operation
    if (newTopFound) {
      bulkOps.push({
        updateMany: {
          filter: { resultName: { $ne: newTopName } },
          update: { $set: { top: false } }
        }
      });
      console.log(`🔥 New top result detected: ${newTopName}`);
    }

    // Diagnostics: clearly separate "no new result" from an actual write
    if (changed.length) {
      console.log(`🆕 ${changed.length} new result(s):\n  - ${changed.join('\n  - ')}`);
    } else {
      console.log('ℹ️ No new results this run (nothing changed on the site).');
    }
    if (unchanged.length) console.log(`⏸️ Unchanged: ${unchanged.join(', ')}`);
    if (pending.length) console.log(`🕓 Result not declared yet on site: ${pending.join(', ')}`);

    // DRY_RUN=1 previews the planned writes without touching the DB.
    if (process.env.DRY_RUN) {
      console.log(`🧪 DRY_RUN: ${bulkOps.length} op(s) planned, ${changed.length} new — no DB write performed`);
      return { ok: true, dryRun: true, scraped: scraped.length, new: newResults.length };
    }

    // Execute bulk write (all updates / upserts in one round‑trip)
    await Khabar.bulkWrite(bulkOps);
    console.log(`✅ Bulk update completed (${bulkOps.length} op(s), ${changed.length} new)`);

    // Notify subscribed users only when a genuinely new result was written.
    // Runs after the DB write so a push failure can never block the update.
    let notified = false;
    if (newResults.length) {
      const push = await notifyNewResults(newResults);
      notified = !!(push && push.messageId);
    }
    return { ok: true, scraped: scraped.length, new: newResults.length, results: newResults, notified };
  } catch (err) {
    // A thrown error here means the scrape ultimately failed (after retries) —
    // this is a FAILURE, distinct from "no new result".
    console.error('❌ SattaKing auto‑update FAILED (scrape/DB error):', err.message);
    return { ok: false, error: err.message };
  } finally {
    updateInProgress = false;
  }
}

// When run directly: execute the updater
if (require.main === module) {
  (async () => {
    await autoUpdateSattaKing();
    // Close mongoose connection gracefully
    mongoose.connection.close();
  })();
}

module.exports = { autoUpdateSattaKing };

