const express = require("express");
const router = express.Router();
const {
  getLiveResults,
  updateLiveResult,
  getLuckyNumber,
  autoUpdateLiveResult,
  getTestingLiveResults,
  getHistoricalData,
  probeSource
} = require("../controller");

router.get("/liveResults", getLiveResults);

router.get("/luckyNumber", getLuckyNumber);

router.post("/updateLiveResult", updateLiveResult);

router.get("/historicalData", getHistoricalData);


router.get("/autoUpdateResult", autoUpdateLiveResult);

router.get("/testingLiveResults", getTestingLiveResults);

// Read-only diagnostic — see which markets the source has that we don't store.
router.get("/probeSource", probeSource);

module.exports = router;

