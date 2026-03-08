const Khabar = require("../modals/khabar.model");
const Image = require("../modals/image.model");
const Lucky = require("../modals/luckynumber.model");
const SingleJodi = require("../modals/singlejodi.model");
const MonthlyChart = require("../modals/monthlychart.model");
const YearlyChart = require("../modals/yearlychart.model");

const getDailyKhabars = async (req, res) => {
  Khabar.find()
    .sort({ top: -1 })
    .then((items) => {
      return res.status(200).json({ DailyKhabar: items });
    })
    .catch(function () {
      console.log("error");
    });
};

const getLuckyNumber = async (req, res) => {
  Lucky.find()
    .then((data) => {
      return res.status(200).json({ LuckyNumber: data });
    })
    .catch(function () {
      console.log("reject");
    });
};

const getMonthWiseChart = async (req, res) => {
  try {
    const { month, fullYear } = req.query;
    
    if (!month || !fullYear) {
      return res.status(400).json({ 
        error: "Month and fullYear parameters are required" 
      });
    }

    const date = month + '-' + fullYear;
    
    const chartData = await MonthlyChart.find({
      date: { $regex: date }
    });

    let responseData = chartData.sort((a, b) => {
      return new Date(a.date) - new Date(b.date);
    });

    return res.status(200).json({ 
      monthlyChart: responseData,
      month: month,
      year: fullYear,
      searchPattern: date
    });

  } catch (error) {
    console.log("Error fetching monthly chart:", error);
    return res.status(500).json({ 
      error: "Internal server error while fetching monthly chart data" 
    });
  }
};

const getYearWiseChart = async (req, res) => {
  try {
    const { year, newsName } = req.query;
    
    if (!year || !newsName) {
      return res.status(400).json({ 
        error: "Year and newsName parameters are required" 
      });
    }

    // Find documents where both year and newsName match
    const chartData = await YearlyChart.find({
      year: year,
      newsName: newsName
    });

    return res.status(200).json({ 
      yearlyChart: chartData,
      year: year,
      newsName: newsName
    });

  } catch (error) {
    console.log("Error fetching yearly chart:", error);
    return res.status(500).json({ 
      error: "Internal server error while fetching yearly chart data" 
    });
  }
};

const updateDailyKhabar = async (req, res) => {
  const { KhabarID, KhabarNo, KhabarType } = req.body;
  if (KhabarType == "today") {
    const updateMany = {
      $set: {
        top: false,
      },
    };
    Khabar.updateMany({}, updateMany).then((data) => {
      const dataset = { $set: { todayResult: KhabarNo, top: true } };
      Khabar.updateOne({ _id: KhabarID }, dataset).then((data) => {
        return res.json("ok");
      });
    });
  }
  if (KhabarType == "last") {
    const updateMany = {
      $set: {
        top: false,
      },
    };
    Khabar.updateMany({}, updateMany).then((data) => {
      const dataset = { $set: { lastResult: KhabarNo, top: true } };
      Khabar.updateOne({ _id: KhabarID }, dataset).then((data) => {
        return res.json("ok");
      });
    });
  }
};

module.exports = { getDailyKhabars, getLuckyNumber, getMonthWiseChart, getYearWiseChart, updateDailyKhabar };
