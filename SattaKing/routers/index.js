const express = require("express");
const router = express.Router();
const { getDailyKhabars, getLuckyNumber, getMonthWiseChart, getYearWiseChart, updateDailyKhabar } = require("../controller");

router.get("/dailyKhabar", getDailyKhabars);

router.get("/luckyNumber", getLuckyNumber);

router.get("/monthWiseChart", getMonthWiseChart);

router.get("/yearWiseChart", getYearWiseChart);

router.post("/updateKhabar", updateDailyKhabar);

// console.log("Router loaded");

module.exports = router;
