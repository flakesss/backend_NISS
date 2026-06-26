const path = require("path");
// Root project: dua level di atas folder backend/ (project_biomedis/)
const PROJECT_ROOT = path.resolve(__dirname, "../..");

module.exports = {
  apps: [
    {
      name: "niss-backend",
      script: "server.js",
      cwd: __dirname,
      interpreter: "node",
      env_file: ".env",
      restart_delay: 3000,
      max_restarts: 10,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "niss-camera",
      script: path.join(PROJECT_ROOT, "mqtt_test/mqtt_server.py"),
      interpreter: "/usr/bin/python3",
      restart_delay: 5000,
      max_restarts: 10,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
    {
      name: "niss-stream-tunnel",
      script: "ngrok",
      interpreter: "none",
      args: "http --url=petal-calibrate-stadium.ngrok-free.dev 3000",
      restart_delay: 5000,
      max_restarts: 10,
      watch: false,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
