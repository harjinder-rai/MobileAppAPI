const mongoose = require("mongoose");

const URL =
  process.env.MONGODB_URI ||
  process.env.DATABASE ||
  "mongodb+srv://SattaKing:Kaka5611@cluster0.gzspqod.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

mongoose
  .connect(URL)
  .then(() => {
    console.log("Connection Sucessful");
  })
  .catch((err) => {
    console.log(err);
  });