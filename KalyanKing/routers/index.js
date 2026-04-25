const express = require("express");
const router = express.Router();
const {
  getLiveResults,
  updateLiveResult,
  getLuckyNumber,
  autoUpdateLiveResult,
} = require("../controller");

router.get("/liveResults", getLiveResults);

router.get("/luckyNumber", getLuckyNumber);

router.post("/updateLiveResult", updateLiveResult);

router.post("/autoUpdateResult", autoUpdateLiveResult);

module.exports = router;

