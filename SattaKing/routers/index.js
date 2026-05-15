const express = require("express");
const router = express.Router();
const { getDailyKhabars, getLuckyNumber, getMonthWiseChart, getYearWiseChart, updateDailyKhabar } = require("../controller");
const { autoUpdateSattaKing } = require("../autoUpdate");

router.get("/dailyKhabar", getDailyKhabars);

router.get("/luckyNumber", getLuckyNumber);

router.get("/monthWiseChart", getMonthWiseChart);

router.get("/yearWiseChart", getYearWiseChart);

router.post("/updateKhabar", updateDailyKhabar);

// console.log("Router loaded");

router.get("/autoUpdateResult", async (req, res) => {
  // Start the update without waiting for it to finish
  autoUpdateSattaKing()
    .catch(err => console.error('Auto‑update error:', err));
  // Respond immediately so the browser doesn’t time out
  res.status(202).json({ message: "SattaKing auto‑update started" });
});

module.exports = router;
