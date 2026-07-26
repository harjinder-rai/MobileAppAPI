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

  for (const scrapedResult of scrapedResults) {
    const matchedDoc = existingByName.get(normalizeName(scrapedResult.gameName));

    if (!matchedDoc) {
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
    debug: {
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

module.exports = { updateKalyanResults, getTestingLiveResults };
