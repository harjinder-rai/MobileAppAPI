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
  // Optional shared-secret protection for the cron trigger. If CRON_SECRET is
  // set, callers must supply it via ?key=, an x-cron-secret header, or a
  // Bearer token. If it's unset, the endpoint stays open (backward compatible).
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided =
      req.query.key ||
      req.headers["x-cron-secret"] ||
      (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (provided !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // Await the update so it fully completes within the (serverless) request.
  // On Vercel, work started after the response is sent is not guaranteed to
  // run — so we must finish scrape + DB write + push before responding.
  try {
    const result = await autoUpdateSattaKing();
    return res.status(200).json({ message: "SattaKing auto‑update finished", ...result });
  } catch (err) {
    console.error('Auto‑update error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
