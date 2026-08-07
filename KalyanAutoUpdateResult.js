const axios = require("axios");
const cheerio = require("cheerio");
const mongoose = require("mongoose");
require("dotenv").config();
// FCM push helper (shared) — notifies subscribed users when a result updates.
const { sendTopicNotification } = require("./firebase");

const DPBOSS_URL = "https://dpboss.boston/";

// Mobile app must subscribe devices to this topic. Overridable via env.
const KALYAN_FCM_TOPIC = process.env.KALYANKING_FCM_TOPIC || "kalyanking_results";

// Clean a game name for display: strip "(...)" and title-case ALL-CAPS names.
function displayGameName(name) {
  const base = String(name).replace(/\s*\(.*?\)\s*/g, " ").trim();
  return base === base.toUpperCase()
    ? base.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
    : base;
}

// Announce that result(s) are declared — no number shown, to drive app opens.
// Copy matches the SattaKing style. Never throws (errors handled by caller).
async function notifyKalyanResults(results) {
  const names = results.map((r) => displayGameName(r.gameName)).join(", ");
  const isSingle = results.length === 1;

  const title = isSingle
    ? `${displayGameName(results[0].gameName)} ka result declare ho gaya! 🎯`
    : `${results.length} games ke result declare ho gaye! 🎯`;
  const body = isSingle
    ? `Result out ho chuka hai 👉 abhi app mein check karein`
    : `${names} ka result aa gaya — abhi dekhein 👉`;

  return sendTopicNotification({
    topic: KALYAN_FCM_TOPIC,
    title,
    body,
    data: {
      type: "kalyan_result_update",
      count: results.length,
      results: JSON.stringify(
        results.map((r) => ({ name: displayGameName(r.gameName), result: r.result }))
      ),
      game: displayGameName(results[0].gameName),
    },
  });
}

const resultSchema = new mongoose.Schema(
  {
    gameName: { type: String},
    openTime: String,
    closeTime: String,
    result: String,
    isTop: Boolean,
    // Importance tier — set once via scripts/setMarketPriority.js and never
    // written by the updater, so result scrapes can't clobber it.
    priority: Number,
  },
  { timestamps: true }
);

const kalyanDb = mongoose.connection.useDb("KalyanKing");
const Result = kalyanDb.model("Result", resultSchema, "liveresult");


async function ensureMongoConnected() {
  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (mongoose.connection.readyState === 2) {
    await mongoose.connection.asPromise();
    return;
  }

  const mongoUrl = process.env.MONGODB_URI || process.env.DATABASE;

  if (!mongoUrl) {
    throw new Error("MONGODB_URI or DATABASE is missing in .env");
  }

  await mongoose.connect(mongoUrl);
}

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseTimeRange(text) {
  const matches = cleanText(text).match(/\d{1,2}:\d{2}\s*[AP]M/gi) || [];

  return {
    openTime: matches[0] || "",
    closeTime: matches[1] || "",
  };
}

function isResultValue(text) {
  const value = cleanText(text);

  return value === "Loading..." || value === "Loading" || /^\d[\d-]*$/.test(value);
}

// ── Auto-discovery of new markets ──────────────────────────────────────────
// The updater used to skip any scraped market that wasn't already in the DB,
// so a market the source added stayed invisible until someone inserted it.
//
// OFF BY DEFAULT, DELIBERATELY. The source publishes ~163 markets against the
// ~18 we curate. Blanket auto-add would take the app from 18 to 160 markets and
// bury Kalyan — the exact opposite of what this app is for. Coverage is grown
// deliberately via scripts/addMarkets.js instead.
//
// Set AUTO_ADD_MARKETS=true only if you genuinely want every market the source
// publishes, and check GET /KalyanKing/probeSource first to see what that means.
const AUTO_ADD_MARKETS = String(process.env.AUTO_ADD_MARKETS ?? "false") === "true";

// A scraped entry has to look like a real market before we persist it — the
// source is HTML we don't control, so a layout change could otherwise flood the
// collection with junk documents.
function isPlausibleNewMarket(scraped) {
  const name = cleanText(scraped.gameName);

  if (name.length < 3 || name.length > 40) return false;
  // Names are letters/digits/spaces/&/-/() — anything else is parser noise.
  if (!/^[A-Za-z0-9 ()&.\-]+$/.test(name)) return false;
  // Both times must have parsed, otherwise time-based ordering can't place it.
  if (!scraped.openTime || !scraped.closeTime) return false;
  // Don't create a market from a placeholder; wait for a real result.
  if (!scraped.result || cleanText(scraped.result) === "Loading") return false;

  return true;
}

async function getTestingLiveResults() {
  await ensureMongoConnected();

  const testingLiveResults = await Result.find(
    {},
    "gameName openTime closeTime result isTop"
  ).lean();

  console.log("testingLiveResult documents:", testingLiveResults);
  return testingLiveResults;
}

async function scrapeDpbossResults() {

  const { data } = await axios.get(DPBOSS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
    timeout: 30000,
  });

  const $ = cheerio.load(data);
  const results = [];

  $("h4").each((i, el) => {
    const gameName = cleanText($(el).text());

    if (!gameName || gameName.includes("LIVE RESULT")) {
      return;
    }

    const siblingsText = [];
    let current = $(el).next();

    while (current.length && siblingsText.length < 4) {
      const text = cleanText(current.text());

      if (text) {
        siblingsText.push(text);
      }

      if (current.is("h4")) {
        break;
      }

      current = current.next();
    }

    const result = siblingsText.find(isResultValue);
    const timeText = siblingsText.find((text) => parseTimeRange(text).openTime);

    if (!result || !timeText) {
      return;
    }

    const { openTime, closeTime } = parseTimeRange(timeText);

    results.push({
      gameName,
      result: result.includes("Loading") ? "Loading" : result,
      openTime,
      closeTime,
    });
  });

  if (results.length > 0) {
    return results;
  }

  const resultNameElements = $(".lv-mc span.h8");

  resultNameElements.each((i, el) => {
    const gameName = $(el).text().trim();
    const resultSpan = $(el).next("span.h9");

    if (!gameName || !resultSpan.length) {
      return;
    }

    let result = resultSpan.text().trim();

    if (result.includes("Loading")) {
      result = "Loading";
    }

    results.push({ gameName, result });
  });

  return results;
}

/**
 * Diff what the source publishes against what we store, WITHOUT writing.
 *
 * The scrape source blocks residential IPs (it answers Vercel's datacenter IPs
 * but times out locally), so scripts/probeSource.js can't run from a dev
 * machine. This runs the same diff server-side, where the scraper already works.
 */
async function probeSourceVsDatabase() {
  await ensureMongoConnected();

  const scraped = await scrapeDpbossResults();
  const stored = await Result.find({}, "gameName priority").lean();

  const storedNames = new Set(stored.map((doc) => normalizeName(doc.gameName)));
  const scrapedNames = new Set(scraped.map((row) => normalizeName(row.gameName)));

  const addable = scraped.filter((row) => !storedNames.has(normalizeName(row.gameName)));

  return {
    sourceCount: scraped.length,
    storedCount: stored.length,
    autoAddEnabled: AUTO_ADD_MARKETS,
    // Published by the source but not stored — auto-add will insert these on the
    // next run, provided they pass isPlausibleNewMarket().
    addable: addable.map((row) => ({
      gameName: row.gameName,
      openTime: row.openTime,
      closeTime: row.closeTime,
      result: row.result,
      wouldBeAdded: isPlausibleNewMarket(row),
    })),
    // Stored but no longer published — these will never auto-update again.
    orphaned: stored
      .filter((doc) => !scrapedNames.has(normalizeName(doc.gameName)))
      .map((doc) => doc.gameName),
    sourceMarkets: scraped.map((row) => row.gameName),
  };
}

async function updateKalyanResults() {
  await ensureMongoConnected();

  const existingDocs = await Result.find(
    {},
    "gameName openTime closeTime result isTop"
  ).lean();
  const existingByName = new Map(
    existingDocs.map((doc) => [normalizeName(doc.gameName), doc])
  );

  const scrapedResults = await scrapeDpbossResults();
  const matchedDatabaseResults = [];
  const matchedResults = [];
  const operations = [];
  const updatedResultNames = [];
  const updatedResults = [];
  let firstUpdated = true;

  // Markets the source publishes that we've never stored. Collected here and
  // inserted after the update loop so they appear from the next fetch onward.
  const newMarkets = [];
  const rejectedNewMarkets = [];
  const seenNewNames = new Set();

  for (const scrapedResult of scrapedResults) {
    const matchedDoc = existingByName.get(normalizeName(scrapedResult.gameName));

    if (!matchedDoc) {
      if (!AUTO_ADD_MARKETS) continue;

      const key = normalizeName(scrapedResult.gameName);
      // The source can list the same market twice (e.g. a highlights block).
      if (seenNewNames.has(key)) continue;
      seenNewNames.add(key);

      if (!isPlausibleNewMarket(scrapedResult)) {
        rejectedNewMarkets.push(scrapedResult.gameName);
        continue;
      }

      newMarkets.push({
        gameName: cleanText(scrapedResult.gameName),
        openTime: scrapedResult.openTime,
        closeTime: scrapedResult.closeTime,
        result: scrapedResult.result,
        isTop: false,
        // Untiered on purpose: a newly discovered market sorts below the curated
        // ones until someone assigns it a tier via scripts/setMarketPriority.js.
        priority: 0,
      });
      continue;
    }

    const matchedName = matchedDoc.gameName;

    matchedDatabaseResults.push(matchedDoc);
    matchedResults.push({
      scrapedName: scrapedResult.gameName,
      matchedName,
      oldResult: matchedDoc.result,
      result: scrapedResult.result,
      openTime: scrapedResult.openTime,
      closeTime: scrapedResult.closeTime,
    });

    if (cleanText(matchedDoc.result) === cleanText(scrapedResult.result)) {
      continue;
    }

    const updateData = {
      result: scrapedResult.result,
      isTop: firstUpdated,
    };

    if (scrapedResult.openTime) {
      updateData.openTime = scrapedResult.openTime;
    }

    if (scrapedResult.closeTime) {
      updateData.closeTime = scrapedResult.closeTime;
    }

    operations.push({
      updateOne: {
        filter: { gameName: matchedName },
        update: {
          $set: updateData,
        },
      },
    });

    updatedResultNames.push(matchedName);
    updatedResults.push({
      gameName: matchedName,
      result: scrapedResult.result,
      openTime: scrapedResult.openTime,
      closeTime: scrapedResult.closeTime,
      isTop: firstUpdated,
    });
    firstUpdated = false;
  }


  if (operations.length > 0) {
    await Result.bulkWrite(operations);
    await Result.updateMany(
      { gameName: { $nin: updatedResultNames } },
      { $set: { isTop: false } }
    );
  }

  // Insert markets the source publishes but we've never stored. Upsert rather
  // than insert so two overlapping runs can't create duplicates, and
  // $setOnInsert so an existing document is never overwritten by this path.
  let addedMarketNames = [];
  if (newMarkets.length > 0) {
    const addResult = await Result.bulkWrite(
      newMarkets.map((market) => ({
        updateOne: {
          filter: { gameName: market.gameName },
          update: { $setOnInsert: market },
          upsert: true,
        },
      })),
      { ordered: false }
    );

    // Only report rows Mongo actually created. upsertedIds is keyed by the
    // index of the operation that inserted, so a partial insert (some names
    // already present) reports just the genuinely new ones.
    addedMarketNames = Object.keys(addResult.upsertedIds || {})
      .map((index) => newMarkets[Number(index)])
      .filter(Boolean)
      .map((market) => market.gameName);

    if (addedMarketNames.length > 0) {
      console.log(
        `[auto-add] discovered ${addedMarketNames.length} new market(s):`,
        addedMarketNames.join(", "),
        "— assign tiers with scripts/setMarketPriority.js"
      );
    }
  }
  if (rejectedNewMarkets.length > 0) {
    console.log(
      `[auto-add] skipped ${rejectedNewMarkets.length} implausible entr(y/ies):`,
      rejectedNewMarkets.join(", ")
    );
  }

  // ── Push notification (additive; does not affect the update logic above) ──
  // Notify only for genuinely declared results — skip "Loading" placeholders.
  const notifiable = updatedResults.filter(
    (r) => r.result && cleanText(r.result) !== "Loading"
  );
  let notified = false;
  if (notifiable.length > 0) {
    try {
      const push = await notifyKalyanResults(notifiable);
      notified = !!(push && push.messageId);
    } catch (error) {
      console.error("Kalyan push notification failed:", error.message);
    }
  }

  return {
    updatedCount: updatedResults.length,
    notified,
    updatedResults,
    addedCount: addedMarketNames.length,
    addedMarkets: addedMarketNames,
    debug: {
      autoAddEnabled: AUTO_ADD_MARKETS,
      rejectedNewMarkets,
      collectionName: Result.collection.name,
      dbName: Result.db.name,
      existingCount: existingDocs.length,
      scrapedCount: scrapedResults.length,
      scrapedResults,
      matchedCount: matchedResults.length,
      matchedDatabaseNames: matchedDatabaseResults.map((doc) => doc.gameName),
      matchedScrapedResults: matchedResults,
    },
  };
}

if (require.main === module) {
  updateKalyanResults()
    .then((summary) => {
      console.log(`Updated ${summary.updatedCount} Kalyan results in MongoDB`);
      console.log("Updated results:", summary.updatedResults);
    })
    .catch((error) => {
      console.error("Kalyan auto update failed:", error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  updateKalyanResults,
  getTestingLiveResults,
  probeSourceVsDatabase,
  // exported for scripts/verifyAutoAdd.js
  isPlausibleNewMarket,
};
