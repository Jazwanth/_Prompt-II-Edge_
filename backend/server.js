const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { exec, spawn } = require("child_process");
const { SerialPort } = require("serialport");
const WebSocket = require("ws");

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));

const DEFAULT_PORT = "/dev/ttyUSB0";
const DEFAULT_FQBN = "esp32:esp32:esp32";
const SKETCH_DIR = "./tempSketch";
const MAIN_FILE = "tempSketch.ino";

let serialPort = null;
let activeSerialPath = DEFAULT_PORT;
let clients = [];

function cleanSketchDir() {
  if (fs.existsSync(SKETCH_DIR)) {
    fs.rmSync(SKETCH_DIR, { recursive: true, force: true });
  }

  fs.mkdirSync(SKETCH_DIR);
}

function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function saveSketchFiles(files, fallbackCode) {
  cleanSketchDir();

  if (Array.isArray(files) && files.length > 0) {
    files.forEach((file) => {
      const name = safeFileName(file.name || MAIN_FILE);
      fs.writeFileSync(path.join(SKETCH_DIR, name), file.content || "");
    });

    const hasIno = files.some((file) => file.name?.endsWith(".ino"));

    if (!hasIno) {
      fs.writeFileSync(path.join(SKETCH_DIR, MAIN_FILE), fallbackCode || "");
    }

    return;
  }

  fs.writeFileSync(path.join(SKETCH_DIR, MAIN_FILE), fallbackCode || "");
}

function sendToClients(data) {
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data.toString());
    }
  });
}

function openSerial(portPath = DEFAULT_PORT, baudRate = 115200) {
  if (serialPort && serialPort.isOpen) {
    sendToClients(`[Serial already running on ${activeSerialPath}]\n`);
    return;
  }

  activeSerialPath = portPath;

  serialPort = new SerialPort({
    path: portPath,
    baudRate,
    autoOpen: false,
  });

  serialPort.open((err) => {
    if (err) {
      sendToClients("[Serial Error] " + err.message + "\n");
      serialPort = null;
      return;
    }

    sendToClients(`[Serial connected: ${portPath}]\n`);
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
      sendToClients("\n[Serial closed]\n");
      setTimeout(callback, 1200);
    });
  } else {
    serialPort = null;
    callback();
  }
}

function runCommand(command, callback) {
  exec(command, { maxBuffer: 1024 * 1024 * 10 }, callback);
}

app.get("/", (req, res) => {
  res.send("Arduino IDE Backend Running");
});

app.get("/boards", (req, res) => {
  runCommand("arduino-cli board list --format json", (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({
        success: false,
        error: stderr || error.message,
      });
    }

    try {
      const parsed = JSON.parse(stdout);

      const boards = Array.isArray(parsed)
        ? parsed
        : parsed.detected_ports || parsed.ports || [];

      res.json({ success: true, boards });
    } catch {
      res.json({
        success: false,
        error: "Could not parse board list JSON",
        raw: stdout,
      });
    }
  });
});

app.get("/board-list", (req, res) => {
  const child = spawn("arduino-cli", [
    "board",
    "listall",
    "--format",
    "json",
  ]);

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  child.on("close", (code) => {
    if (code !== 0) {
      return res.status(500).json({
        success: false,
        error: stderr || `arduino-cli exited with code ${code}`,
      });
    }

    try {
      const parsed = JSON.parse(stdout);

      const boards = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.boards)
        ? parsed.boards
        : Array.isArray(parsed.items)
        ? parsed.items
        : [];

      const cleanedBoards = boards
        .filter((board) => board && board.name && board.fqbn)
        .map((board) => ({
          name: board.name,
          fqbn: board.fqbn,
        }));

      res.json({
        success: true,
        count: cleanedBoards.length,
        boards: cleanedBoards,
      });
    } catch {
      res.status(500).json({
        success: false,
        error: "Could not parse board list JSON",
      });
    }
  });
});

app.post("/compile", (req, res) => {
  const selectedFqbn = req.body.fqbn || DEFAULT_FQBN;

  saveSketchFiles(req.body.files, req.body.code);

  runCommand(
    `arduino-cli compile --fqbn ${selectedFqbn} ${SKETCH_DIR}`,
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
  const selectedPort = req.body.port || DEFAULT_PORT;
  const selectedFqbn = req.body.fqbn || DEFAULT_FQBN;

  saveSketchFiles(req.body.files, req.body.code);

  closeSerial(() => {
    runCommand(
      `arduino-cli compile --fqbn ${selectedFqbn} ${SKETCH_DIR} && arduino-cli upload -p ${selectedPort} --fqbn ${selectedFqbn} ${SKETCH_DIR}`,
      (error, stdout, stderr) => {
        if (error) {
          return res.status(500).json({
            success: false,
            error: stderr || error.message,
          });
        }

        setTimeout(() => {
          openSerial(selectedPort);
        }, 2500);

        res.json({
          success: true,
          output:
            stdout +
            `\n\nUpload complete. Serial monitor restarted automatically on ${selectedPort}.`,
        });
      }
    );
  });
});

app.post("/serial/start", (req, res) => {
  const selectedPort = req.body.port || DEFAULT_PORT;
  openSerial(selectedPort);
  res.json({ success: true, port: selectedPort });
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