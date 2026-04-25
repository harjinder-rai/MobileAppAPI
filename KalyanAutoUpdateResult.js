const axios = require("axios");
const cheerio = require("cheerio");
const mongoose = require("mongoose");
require("dotenv").config();

const DPBOSS_URL = "https://dpboss.boston/";

const resultSchema = new mongoose.Schema(
  {
    gameName: { type: String, unique: true },
    openTime: String,
    closeTime: String,
    result: String,
    isTop: Boolean,
  },
  { timestamps: true }
);

const kalyanDb = mongoose.connection.useDb("KalyanKing");
const Result =
  kalyanDb.models.Result ||
  kalyanDb.model("Result", resultSchema, "testingLiveResult");

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
}

async function scrapeDpbossResults() {
  console.log(`[KalyanAutoUpdate] Fetching ${DPBOSS_URL}`);

  const { data } = await axios.get(DPBOSS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
    timeout: 30000,
  });

  const $ = cheerio.load(data);
  const results = [];
  const resultNameElements = $(".lv-mc span.h8");

  console.log(
    `[KalyanAutoUpdate] Found ${resultNameElements.length} result name elements`
  );

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
  const mongoUrl = process.env.MONGODB_URI || process.env.DATABASE;
  let shouldDisconnect = false;

  console.log(
    `[KalyanAutoUpdate] Mongo readyState before update: ${mongoose.connection.readyState}`
  );

  if (mongoose.connection.readyState === 0) {
    if (!mongoUrl) {
      throw new Error("MONGODB_URI or DATABASE is missing in .env");
    }

    await mongoose.connect(mongoUrl);
    shouldDisconnect = true;
  }

  try {
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

    console.log(`[KalyanAutoUpdate] Existing Mongo records: ${existingDocs.length}`);
    console.log(`[KalyanAutoUpdate] Scraped results: ${scrapedResults.length}`);

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
        result: scrapedResult.result,
      });

      operations.push({
        updateOne: {
          filter: { gameName: matchedName },
          update: {
            $set: {
              result: scrapedResult.result,
              isTop: firstUpdated,
            },
          },
        },
      });

      updatedResultNames.push(matchedName);
      updatedResults.push({
        gameName: matchedName,
        result: scrapedResult.result,
        isTop: firstUpdated,
      });
      firstUpdated = false;
    }

    console.log(
      `[KalyanAutoUpdate] Matched database records: ${matchedDatabaseResults.length}`
    );
    console.log(
      "[KalyanAutoUpdate] Matched database records only:",
      matchedDatabaseResults
    );
    console.log(`[KalyanAutoUpdate] Matched results: ${matchedResults.length}`);
    console.log(
      "[KalyanAutoUpdate] Matched scraped results only:",
      matchedResults
    );

    if (operations.length > 0) {
      await Result.bulkWrite(operations);
      await Result.updateMany(
        { gameName: { $nin: updatedResultNames } },
        { $set: { isTop: false } }
      );
    } else {
      await Result.updateMany({}, { $set: { isTop: false } });
    }

    return {
      updatedCount: updatedResults.length,
      updatedResults,
      debug: {
        collectionName: Result.collection.name,
        dbName: Result.db.name,
        existingCount: existingDocs.length,
        scrapedCount: scrapedResults.length,
        matchedCount: matchedResults.length,
        matchedDatabaseNames: matchedDatabaseResults.map((doc) => doc.gameName),
        matchedScrapedResults: matchedResults,
      },
    };
  } finally {
    if (shouldDisconnect) {
      await mongoose.disconnect();
    }
  }
}

if (require.main === module) {
  updateKalyanResults()
    .then((summary) => {
      console.log(`Updated ${summary.updatedCount} Kalyan results in MongoDB`);
      console.log(JSON.stringify({ updatedResults: summary.updatedResults }, null, 2));
    })
    .catch((error) => {
      console.error("Kalyan auto update failed:", error.message);
      process.exitCode = 1;
    });
}

module.exports = { updateKalyanResults };
