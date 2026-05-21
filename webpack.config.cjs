const path = require("path");

module.exports = {
  mode: "development",
  entry: {
    ar: "./client/main.js",
    map: "./client/map.js",
    agent: "./client/agent.js"
  },
  output: {
    filename: "[name].bundle.js",
    path: path.resolve(__dirname, "client/dist"),
    publicPath: "/dist/",
  },

  module: {
    rules: [
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"]
      }
    ]
  }
};