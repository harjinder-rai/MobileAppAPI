const mongoose = require("mongoose");

const KalyanKing = mongoose.connection.useDb("KalyanKing");

// Sub-schema for daily game numbers to keep things clean
const DailyResultSchema = new mongoose.Schema({
  top: { 
    type: [String], 
    required: true 
  },
  main: { 
    type: String, 
    required: true 
  },
  bottom: { 
    type: [String], 
    required: true 
  }
}, { _id: false }); // Set _id to false if you don't want sub-documents to have unique IDs

const HistoricalChartSchema = new mongoose.Schema(
  {
    gameName: {
      type: String,
      required: true,
      uppercase: true
    },
    month: {
      type: String,
      required: true
    },
    year: {
      type: Number,
      required: true
    },
    dateRange: {
      type: String,
      required: true
    },
    numbers: {
      MON: DailyResultSchema,
      TUE: DailyResultSchema,
      WED: DailyResultSchema,
      THU: DailyResultSchema,
      FRI: DailyResultSchema,
      SAT: DailyResultSchema
    },
    index: {
      type: Number
    }
  },
  { 
    collection: "historicalchart",
    timestamps: true // Optional: adds createdAt and updatedAt fields
  }
);

const HistoricalChart = KalyanKing.model("historicalchart", HistoricalChartSchema);

module.exports = HistoricalChart;