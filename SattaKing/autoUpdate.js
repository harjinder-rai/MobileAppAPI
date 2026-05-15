// Auto-update script for SattaKing daily results
// Scrapes https://satta-king-fast.com/ and syncs with MongoDB collection "DailyResults"
// Uses the existing Khabar Mongoose model (SattaKing/modals/khabar.model.js)

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const mongoose = require('mongoose');

// Ensure DB connection (DB/index.js already connects via mongoose)
require('../DB'); // Connects using MONGODB_URI env variable
// Import the Khabar model (uses SattaKing DB via useDb)
const Khabar = require('./modals/khabar.model');

// Mapping from website identifiers to DB entries and result times
const TARGET_MAPPING = {
  DESAWAR: ['Deshawar(देशावर)', '05:00 AM'],
  GALI: ['Gali(गली)', '11:25 PM'],
  FARIDABAD: ['Faridabad(फरीदाबाद)', '06:00 PM'],
  GHAZIABAD: ['Ghaziabad(ग़ज़िआबाद)', '09:25 PM'],
  'DUBAI BAZAR': ['Dubai Bazaar(दुबई बाज़ार)', '07:30 PM'],
  'INDIA KING': ['India King(इंडिया किंग)', '04:30 PM']
};

const URL = 'https://satta-king-fast.com/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

async function autoUpdateSattaKing() {
  try {
    const response = await axios.get(URL, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(response.data);
    const table = $('table.quick-result-board');
    if (!table.length) {
      console.log('⚠️ No result table found on the page');
      return;
    }

    // Collect scraped rows first
    const scraped = [];
    const rows = table.find('tr');
    rows.each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;
      const rawText = $(cells[0]).text().replace(/\s+/g, ' ').trim().toUpperCase();
      for (const [webKey, [dbName, resultTime]] of Object.entries(TARGET_MAPPING)) {
        if (rawText.includes(webKey) && rawText.includes(resultTime)) {
          const yesterdayVal = $(cells[1]).text().trim();
          const todayVal = $(cells[2]).text().trim();
          scraped.push({ dbName, resultTime, yesterdayVal, todayVal });
        }
      }
    });

    if (scraped.length === 0) {
      console.log('⚠️ No matching rows found');
      return;
    }

    // Load existing records in one query
    const existingDocs = await Khabar.find({}).lean();
    const existingMap = new Map(existingDocs.map(doc => [doc.resultName, doc]));

    const bulkOps = [];
    let newTopFound = false;
    let newTopName = null;

    // Determine updates
    for (const item of scraped) {
      const { dbName, resultTime, yesterdayVal, todayVal } = item;
      const current = existingMap.get(dbName);
      let isNew = false;
      if (todayVal && todayVal !== '--') {
        if (!current || current.todayResult !== todayVal) {
          isNew = true;
        }
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

    // Execute bulk write (all updates / upserts in one round‑trip)
    await Khabar.bulkWrite(bulkOps);
    console.log('✅ Bulk update completed');
  } catch (err) {
    console.error('Error during SattaKing auto‑update:', err.message);
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

