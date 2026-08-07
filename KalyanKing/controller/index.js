const LiveResult = require("../modals/liveresult.model");
const LuckyNumber = require("../modals/luckynumber.model");
const HistoricalChart = require('../modals/historicalchart.model');
const {
  updateKalyanResults,
  getTestingLiveResults: getTestingLiveResultsFromCollection,
  probeSourceVsDatabase,
} = require("../../KalyanAutoUpdateResult");

const getLiveResults = async (req, res) => {
  // priority = persistent importance tier; isTop = whichever result landed most
  // recently. The app re-sorts by result time on the client (a market that is
  // live right now outranks one that closed hours ago), so this ordering is the
  // fallback for older builds and the admin view.
  LiveResult.find()
    .sort({ priority: -1, isTop: -1 })
    .then((items) => {
      return res.status(200).json({ liveResults: items });
    })
    .catch(function () {
      console.log("error");
    });
};



const getHistoricalData = async (req, res) => {
  try {
    // 1. Extract parameters from the query string
    const { game, month, year } = req.query;

    // 2. Build a dynamic filter object
    const filter = {};
    
    if (game) filter.gameName = game; // Maps 'game' param to 'gameName' field
    if (month) filter.month = month;
    if (year) filter.year = Number(year); // Ensure year is treated as a number

    // 3. Execute the query with the filter
    const items = await HistoricalChart.find(filter).sort({ index: 1 });

    return res.status(200).json({ 
      success: true,
      count: items.length,
      historicalChart: items 
    });

  } catch (error) {
    console.error("Error fetching historical data:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Internal Server Error" 
    });
  }
};

const getLuckyNumber = async (req, res) => {
  LuckyNumber.find()
    .then((data) => {
      return res.status(200).json({ LuckyNumber: data });
    })
    .catch(function () {
      console.log("reject");
    });
};

const updateLiveResult = async (req, res) => {
  const { ResultID, ResultNo, ResultType } = req.body;
  if (ResultType == "today") {
    const updateMany = {
      $set: {
        isTop: false,
      },
    };
    LiveResult.updateMany({}, updateMany).then((data) => {
      const dataset = { $set: { todayResult: ResultNo, isTop: true } };
      LiveResult.updateOne({ _id: ResultID }, dataset).then((data) => {
        return res.json("ok");
      });
    });
  }
  if (ResultType == "last") {
    const updateMany = {
      $set: {
        isTop: false,
      },
    };
    LiveResult.updateMany({}, updateMany).then((data) => {
      const dataset = { $set: { lastResult: ResultNo, isTop: true } };
      LiveResult.updateOne({ _id: ResultID }, dataset).then((data) => {
        return res.json("ok");
      });
    });
  }
};

const autoUpdateLiveResult = async (req, res) => {
  try {
    const summary = await updateKalyanResults();

    return res.status(200).json({
      message: "Kalyan results updated successfully",
      ...summary,
    });
  } catch (error) {
    console.error("Kalyan auto update API failed:", error.message);

    return res.status(500).json({
      message: "Kalyan results update failed",
      error: error.message,
    });
  }
};

const getTestingLiveResults = async (req, res) => {
  try {
    const testingLiveResults = await getTestingLiveResultsFromCollection();

    return res.status(200).json({
      testingLiveResults,
    });
  } catch (error) {
    console.error("Get testing live results failed:", error.message);

    return res.status(500).json({
      message: "Get testing live results failed",
      error: error.message,
    });
  }
};

// Read-only diagnostic: which markets the source publishes that we don't store.
// Runs server-side because the source blocks non-datacenter IPs. Writes nothing.
const probeSource = async (req, res) => {
  try {
    const report = await probeSourceVsDatabase();
    return res.status(200).json(report);
  } catch (error) {
    console.error("Probe source failed:", error.message);
    return res.status(500).json({ message: "Probe source failed", error: error.message });
  }
};

module.exports = {
  probeSource,
  getLiveResults,
  updateLiveResult,
  getLuckyNumber,
  autoUpdateLiveResult,
  getTestingLiveResults,
  getHistoricalData
};

