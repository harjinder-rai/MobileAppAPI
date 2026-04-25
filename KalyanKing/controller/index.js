const LiveResult = require("../modals/liveresult.model");
const LuckyNumber = require("../modals/luckynumber.model");
const {
  updateKalyanResults,
  getTestingLiveResults: getTestingLiveResultsFromCollection,
} = require("../../KalyanAutoUpdateResult");

const getLiveResults = async (req, res) => {
  LiveResult.find()
    .sort({ isTop: -1 })
    .then((items) => {
      return res.status(200).json({ liveResults: items });
    })
    .catch(function () {
      console.log("error");
    });
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

module.exports = {
  getLiveResults,
  updateLiveResult,
  getLuckyNumber,
  autoUpdateLiveResult,
  getTestingLiveResults,
};

