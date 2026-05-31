const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const { SerialPort } = require("serialport");
const WebSocket = require("ws");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = "/dev/ttyUSB0";
const FQBN = "esp32:esp32:esp32";
const SKETCH_DIR = "./tempSketch";
const SKETCH_FILE = path.join(SKETCH_DIR, "tempSketch.ino");

let serialPort = null;
let clients = [];

function saveSketch(code) {
  if (!fs.existsSync(SKETCH_DIR)) {
    fs.mkdirSync(SKETCH_DIR);
  }

  fs.writeFileSync(SKETCH_FILE, code || "");
}

function sendToClients(data) {
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data.toString());
    }
  });
}

function openSerial() {
  if (serialPort && serialPort.isOpen) {
    sendToClients("[Serial already running]\n");
    return;
  }

  serialPort = new SerialPort({
    path: PORT,
    baudRate: 115200,
    autoOpen: false,
  });

  serialPort.open((err) => {
    if (err) {
      sendToClients("[Serial Error] " + err.message + "\n");
      serialPort = null;
      return;
    }

    sendToClients("[Serial connected]\n");
  });

  serialPort.on("data", (data) => {
    sendToClients(data);
  });

  serialPort.on("close", () => {
    sendToClients("\n[Serial closed]\n");
  });

  serialPort.on("error", (err) => {
    sendToClients("\n[Serial Error] " + err.message + "\n");
  });
}

function closeSerial(callback) {
  if (serialPort && serialPort.isOpen) {
    serialPort.close(() => {
      serialPort = null;
      sendToClients("\n[Serial closed for upload]\n");
      setTimeout(callback, 1200);
    });
  } else {
    serialPort = null;
    callback();
  }
}

app.get("/", (req, res) => {
  res.send("Arduino IDE Backend Running");
});

app.post("/compile", (req, res) => {
  saveSketch(req.body.code);

  exec(
    `arduino-cli compile --fqbn ${FQBN} ${SKETCH_DIR}`,
    (error, stdout, stderr) => {
      if (error) {
        return res.status(500).json({
          success: false,
          error: stderr || error.message,
        });
      }

      res.json({
        success: true,
        output: stdout,
      });
    }
  );
});

app.post("/upload", (req, res) => {
  saveSketch(req.body.code);

  closeSerial(() => {
    exec(
      `arduino-cli compile --fqbn ${FQBN} ${SKETCH_DIR} && arduino-cli upload -p ${PORT} --fqbn ${FQBN} ${SKETCH_DIR}`,
      (error, stdout, stderr) => {
        if (error) {
          return res.status(500).json({
            success: false,
            error: stderr || error.message,
          });
        }

        setTimeout(() => {
          openSerial();
        }, 2500);

        res.json({
          success: true,
          output: stdout + "\n\nUpload complete. Serial monitor restarted automatically.",
        });
      }
    );
  });
});

app.post("/serial/start", (req, res) => {
  openSerial();
  res.json({ success: true });
});

app.post("/serial/stop", (req, res) => {
  closeSerial(() => {
    res.json({ success: true });
  });
});

const server = app.listen(5000, () => {
  console.log("Backend running on port 5000");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  clients.push(ws);
  ws.send("[WebSocket connected]\n");

  ws.on("close", () => {
    clients = clients.filter((client) => client !== ws);
  });
});