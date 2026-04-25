const axios = require("axios");
const cheerio = require("cheerio");
const mongoose = require("mongoose");
require("dotenv").config();

const LiveResult = require("./KalyanKing/modals/liveresult.model");

const DPBOSS_URL = "https://dpboss.boston/";

function normalizeName(name) {
  return String(name || "").trim().toLowerCase();
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

  $(".lv-mc span.h8").each((i, el) => {
    const resultName = $(el).text().trim();
    const resultSpan = $(el).next("span.h9");

    if (!resultName || !resultSpan.length) {
      return;
    }

    let todayResult = resultSpan.text().trim();

    if (todayResult.includes("Loading")) {
      todayResult = "Loading";
    }

    results.push({ resultName, todayResult });
  });

  return results;
}

async function updateKalyanResults() {
  const mongoUrl = process.env.MONGODB_URI || process.env.DATABASE;
  let shouldDisconnect = false;

  if (!mongoUrl) {
    throw new Error("MONGODB_URI or DATABASE is missing in .env");
  }

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUrl);
    shouldDisconnect = true;
  }

  try {
    const existingDocs = await LiveResult.find({}, "resultName").lean();
    const existingByName = new Map(
      existingDocs.map((doc) => [normalizeName(doc.resultName), doc.resultName])
    );

    const scrapedResults = await scrapeDpbossResults();
    const operations = [];
    const updatedResultNames = [];
    const updatedResults = [];
    let firstUpdated = true;

    for (const scrapedResult of scrapedResults) {
      const matchedName = existingByName.get(normalizeName(scrapedResult.resultName));

      if (!matchedName) {
        continue;
      }

      operations.push({
        updateOne: {
          filter: { resultName: matchedName },
          update: {
            $set: {
              todayResult: scrapedResult.todayResult,
              isTop: firstUpdated,
            },
          },
        },
      });

      updatedResultNames.push(matchedName);
      updatedResults.push({
        resultName: matchedName,
        todayResult: scrapedResult.todayResult,
        isTop: firstUpdated,
      });
      firstUpdated = false;
    }

    if (operations.length > 0) {
      await LiveResult.bulkWrite(operations);
      await LiveResult.updateMany(
        { resultName: { $nin: updatedResultNames } },
        { $set: { isTop: false } }
      );
    } else {
      await LiveResult.updateMany({}, { $set: { isTop: false } });
    }

    return {
      updatedCount: updatedResults.length,
      updatedResults,
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
