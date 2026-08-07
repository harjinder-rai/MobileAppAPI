const mongoose = require("mongoose");

const KalyanKing = mongoose.connection.useDb("KalyanKing");

const LiveResultSchema = mongoose.Schema(
  {
    resultName: {
      type: String,
      require: false,
    },
    resultTime: {
      type: String,
      require: false,
    },
    todayResult: {
      type: String,
      require: false,
    },
    lastResult: {
      type: String,
      require: false,
    },
    // isTop is NOT an importance flag — the auto-updater sets it on whichever
    // market's result landed most recently and clears it everywhere else. Use
    // it for a "just declared" badge, never for ordering by importance.
    isTop: {
      type: Boolean,
      require: false,
    },
    // Persistent importance tier, unaffected by result updates.
    // 3 = flagship markets, 2 = well-known, 1 = regional, 0 = unset.
    priority: {
      type: Number,
      require: false,
      default: 0,
    },
  },
  { collection: "liveresult" }
);

const LiveResult = KalyanKing.model("liveresult", LiveResultSchema);

module.exports = LiveResult;

