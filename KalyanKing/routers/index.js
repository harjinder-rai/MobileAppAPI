const express = require("express");
const router = express.Router();
const {
  getLiveResults,
  updateLiveResult,
  getLuckyNumber,
  autoUpdateLiveResult,
  getTestingLiveResults,
  getHistoricalData
} = require("../controller");

router.get("/liveResults", getLiveResults);

router.get("/luckyNumber", getLuckyNumber);

router.post("/updateLiveResult", updateLiveResult);

router.post("/historicalData", getHistoricalData);


router.get("/autoUpdateResult", autoUpdateLiveResult);

router.get("/testingLiveResults", getTestingLiveResults);

module.exports = router;

