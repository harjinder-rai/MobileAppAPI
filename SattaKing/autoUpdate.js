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

// Old docs that no longer correspond to any current site game. They are
// removed once so they don't linger in the app as stale/duplicate entries.
const OBSOLETE_NAMES = ['India King(इंडिया किंग)', 'Dubai Bazaar(दुबई बाज़ार)'];

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
        timeout: 15000
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

// Build and send a single push summarizing the new result(s) for this run.
// Failures are swallowed inside sendTopicNotification, so this never throws.
async function notifyNewResults(results) {
  const summary = results.map(r => `${r.name}: ${r.result}`).join(', ');
  const title = results.length === 1
    ? '🎯 New Satta Result!'
    : `🎯 ${results.length} New Satta Results!`;

  await sendTopicNotification({
    topic: FCM_TOPIC,
    title,
    body: summary,
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

async function autoUpdateSattaKing() {
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
      return;
    }

    console.log(`🔎 Scraped ${scraped.length} games: ${scraped.map(s => s.dbName).join(', ')}`);

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
      return;
    }

    // Execute bulk write (all updates / upserts in one round‑trip)
    await Khabar.bulkWrite(bulkOps);
    console.log(`✅ Bulk update completed (${bulkOps.length} op(s), ${changed.length} new)`);

    // Notify subscribed users only when a genuinely new result was written.
    // Runs after the DB write so a push failure can never block the update.
    if (newResults.length) {
      await notifyNewResults(newResults);
    }
  } catch (err) {
    // A thrown error here means the scrape ultimately failed (after retries) —
    // this is a FAILURE, distinct from "no new result".
    console.error('❌ SattaKing auto‑update FAILED (scrape/DB error):', err.message);
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

