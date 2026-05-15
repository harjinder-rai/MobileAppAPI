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

    const rows = table.find('tr');
    for (let i = 0; i < rows.length; i++) {
      const cells = $(rows[i]).find('td');
      if (cells.length < 3) continue;

      const rawText = $(cells[0]).text().replace(/\s+/g, ' ').trim().toUpperCase();

      for (const [webKey, [dbName, resultTime]] of Object.entries(TARGET_MAPPING)) {
        if (rawText.includes(webKey) && rawText.includes(resultTime)) {
          const yesterdayVal = $(cells[1]).text().trim();
          const todayVal = $(cells[2]).text().trim();

          // Fetch current record (if any)
          const currentRecord = await Khabar.findOne({ resultName: dbName }).lean();

          // Determine if we have a new/touching result
          let isNew = false;
          if (todayVal && todayVal !== '--') {
            if (!currentRecord || currentRecord.todayResult !== todayVal) {
              isNew = true;
            }
          }

          if (isNew) {
            // Reset "top" flag on all other documents
            await Khabar.updateMany({}, { $set: { top: false } });
            console.log(`🔥 New result detected for ${dbName}. Marking as top.`);
          }

          const updateData = {
            resultName: dbName,
            resultTime: resultTime,
            lastResult: yesterdayVal,
            todayResult: todayVal,
            updatedAt: new Date()
          };

          if (isNew) {
            updateData.top = true;
          } else if (!currentRecord) {
            // New document but not a changed result – default top false
            updateData.top = false;
          }

          await Khabar.updateOne({ resultName: dbName }, { $set: updateData }, { upsert: true });
          console.log(`✅ Updated ${dbName} | Today: ${todayVal}`);
        }
      }
    }
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
