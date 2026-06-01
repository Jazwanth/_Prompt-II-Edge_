const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const { SerialPort } = require("serialport");
const WebSocket = require("ws");
const {
  generateArduinoProject,
  repairArduinoProject,
} = require("./src/services/ai/geminiProvider");

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));

const DEFAULT_PORT = "/dev/ttyUSB0";
const DEFAULT_FQBN = "esp32:esp32:esp32";
const DEFAULT_BAUD_RATE = 115200;
const SKETCH_DIR = path.join(__dirname, "tempSketch");
const FRONTEND_DIST_DIR = path.join(__dirname, "../frontend/dist");
const FRONTEND_INDEX_FILE = path.join(FRONTEND_DIST_DIR, "index.html");
const MAIN_FILE = "tempSketch.ino";
const AI_ALLOWED_FILE_EXTENSIONS = new Set([".ino", ".cpp", ".c", ".h", ".hpp", ".txt"]);
const CORE_LIBRARY_NAMES = new Set([
  "arduino",
  "arduinoh",
  "arduinoota",
  "eeprom",
  "esp",
  "esp32",
  "esp8266wifi",
  "spi",
  "wifi",
  "wire",
]);
const DEFAULT_OTA_IP = "192.168.1.100";
const DEFAULT_OTA_PASSWORD = "";
const BOARD_LIST_CACHE_MS = 5 * 60 * 1000;
const SERVER_HOST = process.env.HOST || "127.0.0.1";
const SERVER_PORT = Number(process.env.PORT) || 5000;

let serialPort = null;
let activeSerialPath = DEFAULT_PORT;
let activeSerialBaudRate = DEFAULT_BAUD_RATE;
let clients = [];
let boardListCache = null;
let boardListCacheAt = 0;
let expectedSerialClose = false;

function hasFrontendBuild() {
  return fs.existsSync(FRONTEND_INDEX_FILE);
}

function getCachedBoardList() {
  if (!boardListCache) return null;
  if (Date.now() - boardListCacheAt > BOARD_LIST_CACHE_MS) return null;

  return boardListCache;
}

function setBoardListCache(payload) {
  boardListCache = payload;
  boardListCacheAt = Date.now();
}

function clearBoardListCache() {
  boardListCache = null;
  boardListCacheAt = 0;
}

function cleanSketchDir() {
  if (fs.existsSync(SKETCH_DIR)) {
    fs.rmSync(SKETCH_DIR, { recursive: true, force: true });
  }

  fs.mkdirSync(SKETCH_DIR, { recursive: true });
}

function safeFileName(name) {
  const baseName = String(name || MAIN_FILE).split(/[\\/]/).pop();
  const safeName = baseName.replace(/[^a-zA-Z0-9_.-]/g, "_");

  return safeName && safeName !== "." && safeName !== ".."
    ? safeName
    : MAIN_FILE;
}

function getFileExtension(name) {
  const safeName = String(name || "");
  const dotIndex = safeName.lastIndexOf(".");

  return dotIndex >= 0 ? safeName.slice(dotIndex).toLowerCase() : "";
}

function requestString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function requestNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function requestBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function sketchContent(value) {
  return typeof value === "string" ? value : "";
}

function getCoreId(core) {
  if (!core || typeof core !== "object") return "";

  return (
    core.id ||
    core.ID ||
    core.platform ||
    core.platform_id ||
    core.name ||
    [core.package, core.architecture].filter(Boolean).join(":") ||
    ""
  );
}

function getLibraryName(library) {
  if (!library || typeof library !== "object") return "";

  return (
    library.name ||
    library.library?.name ||
    library.metadata?.name ||
    library.properties?.name ||
    ""
  );
}

function saveSketchFiles(files, fallbackCode) {
  cleanSketchDir();

  if (Array.isArray(files) && files.length > 0) {
    const writtenFiles = new Set();
    let hasMainFile = false;

    files.forEach((file) => {
      const safeName = safeFileName(file.name || MAIN_FILE);
      const isIno = safeName.toLowerCase().endsWith(".ino");
      const name = isIno ? MAIN_FILE : safeName;

      if (writtenFiles.has(name)) return;

      writtenFiles.add(name);
      hasMainFile = hasMainFile || name === MAIN_FILE;
      fs.writeFileSync(path.join(SKETCH_DIR, name), sketchContent(file.content));
    });

    if (!hasMainFile) {
      fs.writeFileSync(path.join(SKETCH_DIR, MAIN_FILE), sketchContent(fallbackCode));
    }

    return;
  }

  fs.writeFileSync(path.join(SKETCH_DIR, MAIN_FILE), sketchContent(fallbackCode));
}

function sendToClients(data) {
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data.toString());
    }
  });
}

function isSerialOpen() {
  return Boolean(serialPort && serialPort.isOpen);
}

function getSerialStatusPayload() {
  return {
    success: true,
    connected: isSerialOpen(),
    port: activeSerialPath,
    baudRate: activeSerialBaudRate,
  };
}

function getSerialLineEnding(lineEnding, appendNewline) {
  if (lineEnding === "crlf") return "\r\n";
  if (lineEnding === "cr") return "\r";
  if (lineEnding === "none") return "";

  return appendNewline ? "\n" : "";
}

function sendSerialStatus(ws) {
  const status = getSerialStatusPayload();
  const label = status.connected ? "connected" : "disconnected";

  ws.send(
    `[Serial status: ${label} on ${status.port} at ${status.baudRate} baud]\n`
  );
}

function openSerial(portPath = DEFAULT_PORT, baudRate = DEFAULT_BAUD_RATE) {
  if (serialPort && serialPort.isOpen) {
    if (activeSerialPath === portPath && activeSerialBaudRate === baudRate) {
      sendToClients(
        `[Serial already running on ${activeSerialPath} at ${activeSerialBaudRate} baud]\n`
      );
      return;
    }

    sendToClients(
      `[Switching serial from ${activeSerialPath} at ${activeSerialBaudRate} baud to ${portPath} at ${baudRate} baud]\n`
    );
    closeSerial(() => openSerial(portPath, baudRate));
    return;
  }

  activeSerialPath = portPath;
  activeSerialBaudRate = baudRate;

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

    sendToClients(`[Serial connected: ${portPath} at ${baudRate} baud]\n`);
  });

  serialPort.on("data", (data) => {
    sendToClients(data);
  });

  serialPort.on("close", () => {
    serialPort = null;

    if (expectedSerialClose) {
      expectedSerialClose = false;
      return;
    }

    sendToClients("\n[Serial closed]\n");
  });

  serialPort.on("error", (err) => {
    sendToClients("\n[Serial Error] " + err.message + "\n");
  });
}

function closeSerial(callback) {
  if (serialPort && serialPort.isOpen) {
    expectedSerialClose = true;

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

function runSpawnCommand(command, args, callback) {
  const child = spawn(command, args);

  let stdout = "";
  let stderr = "";
  let hasFinished = false;

  const finish = (code, finalStdout = stdout, finalStderr = stderr) => {
    if (hasFinished) return;
    hasFinished = true;
    callback(code, finalStdout, finalStderr);
  };

  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  child.on("error", (error) => {
    finish(1, stdout, stderr || error.message);
  });

  child.on("close", (code) => {
    finish(code, stdout, stderr);
  });
}

function runArduinoCli(args, callback) {
  runSpawnCommand("arduino-cli", args, callback);
}

function runArduinoCliSequence(argsList, callback) {
  let index = 0;
  let stdout = "";
  let stderr = "";

  const runNext = () => {
    if (index >= argsList.length) {
      callback(0, stdout, stderr);
      return;
    }

    runArduinoCli(argsList[index], (code, nextStdout, nextStderr) => {
      stdout += nextStdout;
      stderr += nextStderr;

      if (code !== 0) {
        callback(code, stdout, stderr);
        return;
      }

      index += 1;
      runNext();
    });
  };

  runNext();
}

function runArduinoCliAsync(args) {
  return new Promise((resolve) => {
    runArduinoCli(args, (code, stdout, stderr) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function cleanAiText(value, fallback = "") {
  if (typeof value !== "string") return fallback;

  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || fallback;
}

function cleanProjectName(value, fallback) {
  return cleanAiText(value, fallback)
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

function uniqueStringList(values, limit = 30) {
  const seen = new Set();
  const cleaned = [];

  if (!Array.isArray(values)) return cleaned;

  values.forEach((value) => {
    const item = cleanAiText(value).replace(/\s+/g, " ").slice(0, 120);
    const key = item.toLowerCase();

    if (!item || seen.has(key)) return;

    seen.add(key);
    cleaned.push(item);
  });

  return cleaned.slice(0, limit);
}

function normalizeAiFiles(files) {
  const sourceFiles = Array.isArray(files) ? files : [];
  const normalizedFiles = [];
  const seenNames = new Set();
  let hasMainFile = false;

  sourceFiles.forEach((file) => {
    if (!file || typeof file !== "object") return;

    const safeName = safeFileName(file.name || MAIN_FILE);
    const extension = getFileExtension(safeName);

    if (!AI_ALLOWED_FILE_EXTENSIONS.has(extension)) return;

    const name = extension === ".ino" ? MAIN_FILE : safeName;

    if (seenNames.has(name)) return;

    seenNames.add(name);
    hasMainFile = hasMainFile || name === MAIN_FILE;
    normalizedFiles.push({
      name,
      content: sketchContent(file.content),
    });
  });

  if (!hasMainFile) {
    normalizedFiles.unshift({
      name: MAIN_FILE,
      content: "",
    });
  }

  return normalizedFiles;
}

function normalizeAiWiring(wiring) {
  if (!Array.isArray(wiring)) return [];

  return wiring
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      module: cleanAiText(item.module),
      modulePin: cleanAiText(item.modulePin),
      boardPin: cleanAiText(item.boardPin),
      note: cleanAiText(item.note),
    }))
    .filter((item) => item.module || item.modulePin || item.boardPin || item.note)
    .slice(0, 80);
}

function validateAiProject(project, fallbackProjectName) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new Error("Gemini did not return a project object.");
  }

  const files = normalizeAiFiles(project.files);

  if (files.length === 0 || files.every((file) => !file.content.trim())) {
    throw new Error("Gemini did not return usable sketch files.");
  }

  return {
    projectName: cleanProjectName(
      project.projectName,
      fallbackProjectName || "AI Generated Project"
    ),
    libraries: uniqueStringList(project.libraries, 20),
    files,
    wiring: normalizeAiWiring(project.wiring),
    explanation: cleanAiText(project.explanation),
    warnings: uniqueStringList(project.warnings, 30),
  };
}

function isCoreLibraryName(library) {
  const cleaned = cleanAiText(library).toLowerCase().replace(/[^a-z0-9]/g, "");

  return CORE_LIBRARY_NAMES.has(cleaned);
}

async function installProjectLibraries(libraries) {
  const results = [];

  for (const library of uniqueStringList(libraries, 20)) {
    if (isCoreLibraryName(library)) {
      results.push({
        library,
        success: true,
        skipped: true,
        output: "Skipped core library bundled with the selected board package.",
        error: "",
      });
      continue;
    }

    const result = await runArduinoCliAsync(["lib", "install", library]);

    results.push({
      library,
      success: result.code === 0,
      skipped: false,
      output: result.stdout,
      error: result.stderr || (result.code !== 0 ? `arduino-cli exited with code ${result.code}` : ""),
    });
  }

  return results;
}

function compileSketchForBoard(fqbn) {
  return runArduinoCliAsync(["compile", "--fqbn", fqbn, SKETCH_DIR]);
}

function compileErrorText(result) {
  if (!result) return "";

  return result.stderr || result.stdout || `arduino-cli exited with code ${result.code}`;
}

function formatInstallOutput(results) {
  if (!results.length) return "No external libraries requested.";

  return results
    .map((result) => {
      if (result.skipped) return `[library] ${result.library}: skipped core library`;
      if (result.success) return `[library] ${result.library}: installed`;

      return `[library] ${result.library}: install failed\n${result.error}`;
    })
    .join("\n");
}

function installWarnings(results) {
  return results
    .filter((result) => !result.success)
    .map((result) => `Could not install "${result.library}": ${result.error}`);
}

function appendUniqueWarnings(project, warnings) {
  return {
    ...project,
    warnings: uniqueStringList([...(project.warnings || []), ...warnings], 40),
  };
}

function aiResponseProject(project, fqbn, installResults, repaired) {
  return {
    ...project,
    fqbn,
    repaired,
    libraryInstallResults: installResults,
  };
}

app.get("/cores", (req, res) => {
  runArduinoCli(
    ["core", "list", "--format", "json"],
    (code, stdout, stderr) => {
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `arduino-cli exited with code ${code}`,
        });
      }

      try {
        const parsed = JSON.parse(stdout);

        const cores = Array.isArray(parsed)
          ? parsed
          : parsed.platforms || parsed.installed_platforms || [];

        res.json({
          success: true,
          cores,
        });
      } catch {
        res.json({
          success: true,
          raw: stdout,
        });
      }
    }
  );
});

app.post("/cores/update-index", (req, res) => {
  runArduinoCli(
    ["core", "update-index"],
    (code, stdout, stderr) => {
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `arduino-cli exited with code ${code}`,
        });
      }

      clearBoardListCache();

      res.json({
        success: true,
        output: stdout || "Core index updated successfully.",
      });
    }
  );
});

app.post("/cores/search", (req, res) => {
  const query = requestString(req.body.query, "");

  if (!query) {
    return res.status(400).json({
      success: false,
      error: "Core search query is required.",
    });
  }

  runArduinoCli(
    ["core", "search", query, "--format", "json"],
    (code, stdout, stderr) => {
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `arduino-cli exited with code ${code}`,
        });
      }

      try {
        const parsed = JSON.parse(stdout);
        const cores = Array.isArray(parsed)
          ? parsed
          : parsed.platforms || parsed.items || parsed.results || parsed.cores || [];

        const cleanedCores = cores
          .filter((core) => getCoreId(core))
          .map((core) => ({
            id: getCoreId(core),
            name: core.name || core.maintainer || getCoreId(core),
            version:
              core.latest ||
              core.latest_version ||
              core.version ||
              core.installed ||
              "",
            installed: core.installed || core.installed_version || "",
            raw: core,
          }))
          .slice(0, 50);

        res.json({
          success: true,
          count: cleanedCores.length,
          cores: cleanedCores,
        });
      } catch {
        res.status(500).json({
          success: false,
          error: "Could not parse core search JSON",
          raw: stdout,
        });
      }
    }
  );
});

app.post("/cores/install", (req, res) => {
  const core = requestString(req.body.core, "");

  if (!core) {
    return res.status(400).json({
      success: false,
      error: "Core name is required. Example: arduino:avr",
    });
  }

  runArduinoCli(
    ["core", "install", core],
    (code, stdout, stderr) => {
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `arduino-cli exited with code ${code}`,
        });
      }

      clearBoardListCache();

      res.json({
        success: true,
        output: stdout || `Installed core: ${core}`,
      });
    }
  );
});

app.post("/cores/uninstall", (req, res) => {
  const core = requestString(req.body.core, "");

  if (!core) {
    return res.status(400).json({
      success: false,
      error: "Core name is required.",
    });
  }

  runArduinoCli(
    ["core", "uninstall", core],
    (code, stdout, stderr) => {
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `arduino-cli exited with code ${code}`,
        });
      }

      clearBoardListCache();

      res.json({
        success: true,
        output: stdout || `Removed core: ${core}`,
      });
    }
  );
});

app.post("/cores/upgrade", (req, res) => {
  const core = requestString(req.body.core, "");
  const args = core ? ["core", "upgrade", core] : ["core", "upgrade"];

  runArduinoCli(args, (code, stdout, stderr) => {
    if (code !== 0) {
      return res.status(500).json({
        success: false,
        error: stderr || `arduino-cli exited with code ${code}`,
      });
    }

    clearBoardListCache();

    res.json({
      success: true,
      output: stdout || (core ? `Updated core: ${core}` : "Updated cores."),
    });
  });
});

if (fs.existsSync(FRONTEND_DIST_DIR)) {
  app.use(express.static(FRONTEND_DIST_DIR));
}

app.get("/", (req, res) => {
  if (hasFrontendBuild()) {
    return res.sendFile(FRONTEND_INDEX_FILE);
  }

  res.send("Arduino IDE Backend Running");
});

app.get("/boards", (req, res) => {
  runArduinoCli(["board", "list", "--format", "json"], (code, stdout, stderr) => {
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
  const cachedBoards = getCachedBoardList();

  if (cachedBoards) {
    return res.json({
      ...cachedBoards,
      cached: true,
    });
  }

  runArduinoCli(["board", "listall", "--format", "json"], (code, stdout, stderr) => {
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

      const payload = {
        success: true,
        count: cleanedBoards.length,
        boards: cleanedBoards,
      };

      setBoardListCache(payload);

      res.json({
        ...payload,
        cached: false,
      });
    } catch {
      res.status(500).json({
        success: false,
        error: "Could not parse board list JSON",
      });
    }
  });
});

app.post("/api/ai/generate-project", async (req, res) => {
  const prompt = requestString(req.body.prompt, "");
  const selectedFqbn = requestString(req.body.fqbn, "");
  const requestedProjectName = requestString(req.body.projectName, "");
  const currentFiles = Array.isArray(req.body.files)
    ? normalizeAiFiles(req.body.files)
    : [];

  if (!prompt) {
    return res.status(400).json({
      success: false,
      error: "Prompt is required.",
    });
  }

  if (!selectedFqbn) {
    return res.status(400).json({
      success: false,
      error: "Board FQBN is required.",
    });
  }

  try {
    let project = validateAiProject(
      await generateArduinoProject({
        prompt,
        fqbn: selectedFqbn,
        projectName: requestedProjectName,
        files: currentFiles,
      }),
      requestedProjectName
    );

    saveSketchFiles(project.files);

    let installResults = await installProjectLibraries(project.libraries);
    project = appendUniqueWarnings(project, installWarnings(installResults));

    let compileResult = await compileSketchForBoard(selectedFqbn);
    let repaired = false;

    if (compileResult.code !== 0) {
      const repairError = compileErrorText(compileResult);

      const repairedProject = validateAiProject(
        await repairArduinoProject({
          prompt,
          fqbn: selectedFqbn,
          projectName: project.projectName,
          files: project.files,
          repairContext: {
            project,
            compileError: repairError,
          },
        }),
        project.projectName
      );

      project = {
        ...appendUniqueWarnings(repairedProject, [
          "The first generated version failed to compile, so Gemini made one correction pass.",
        ]),
      };

      saveSketchFiles(project.files);

      const repairInstallResults = await installProjectLibraries(project.libraries);
      installResults = [...installResults, ...repairInstallResults];
      project = appendUniqueWarnings(project, installWarnings(repairInstallResults));

      compileResult = await compileSketchForBoard(selectedFqbn);
      repaired = true;
    }

    const compileOutput = [
      formatInstallOutput(installResults),
      compileResult.stdout,
      compileResult.stderr,
    ]
      .filter(Boolean)
      .join("\n\n");

    const responseProject = aiResponseProject(
      project,
      selectedFqbn,
      installResults,
      repaired
    );

    if (compileResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: compileErrorText(compileResult),
        project: responseProject,
        compileOutput,
        wiring: project.wiring,
        explanation: project.explanation,
        warnings: project.warnings,
        readyToUpload: false,
      });
    }

    return res.json({
      success: true,
      project: responseProject,
      compileOutput,
      wiring: project.wiring,
      explanation: project.explanation,
      warnings: project.warnings,
      readyToUpload: true,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error.message || "AI project generation failed.",
    });
  }
});

app.post("/compile", (req, res) => {
  const selectedFqbn = requestString(req.body.fqbn, DEFAULT_FQBN);

  saveSketchFiles(req.body.files, req.body.code);

  runArduinoCli(
    ["compile", "--fqbn", selectedFqbn, SKETCH_DIR],
    (code, stdout, stderr) => {
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `arduino-cli exited with code ${code}`,
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
  const selectedPort = requestString(req.body.port, DEFAULT_PORT);
  const selectedFqbn = requestString(req.body.fqbn, DEFAULT_FQBN);

  saveSketchFiles(req.body.files, req.body.code);

  closeSerial(() => {
    runArduinoCliSequence(
      [
        ["compile", "--fqbn", selectedFqbn, SKETCH_DIR],
        ["upload", "-p", selectedPort, "--fqbn", selectedFqbn, SKETCH_DIR],
      ],
      (code, stdout, stderr) => {
        if (code !== 0) {
          setTimeout(() => {
            openSerial(selectedPort);
          }, 1000);

          return res.status(500).json({
            success: false,
            error: stderr || `arduino-cli exited with code ${code}`,
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

app.post("/upload-ota", (req, res) => {
  const selectedFqbn = requestString(req.body.fqbn, DEFAULT_FQBN);
  const otaIp = requestString(req.body.otaIp, DEFAULT_OTA_IP);
  const otaPassword =
    typeof req.body.otaPassword === "string"
      ? req.body.otaPassword
      : DEFAULT_OTA_PASSWORD;

  if (!otaIp.trim()) {
    return res.status(400).json({
      success: false,
      error: "ESP32 OTA IP address is required.",
    });
  }

  saveSketchFiles(req.body.files, req.body.code);

  runArduinoCliSequence(
    [
      ["compile", "--fqbn", selectedFqbn, SKETCH_DIR],
      [
        "upload",
        "-p",
        otaIp,
        "--fqbn",
        selectedFqbn,
        "--protocol",
        "network",
        "--upload-field",
        `password=${otaPassword}`,
        SKETCH_DIR,
      ],
    ],
    (code, stdout, stderr) => {
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `arduino-cli exited with code ${code}`,
        });
      }

      res.json({
        success: true,
        output:
          stdout +
          `\n\nOTA upload complete. Uploaded wirelessly to ESP32 at ${otaIp}.`,
      });
    }
  );
});

app.post("/serial/start", (req, res) => {
  const selectedPort = requestString(req.body.port, DEFAULT_PORT);
  const selectedBaudRate = requestNumber(req.body.baudRate, DEFAULT_BAUD_RATE);

  openSerial(selectedPort, selectedBaudRate);

  res.json({
    success: true,
    port: selectedPort,
    baudRate: selectedBaudRate,
  });
});

app.get("/serial/status", (req, res) => {
  res.json(getSerialStatusPayload());
});

app.post("/serial/write", (req, res) => {
  if (!isSerialOpen()) {
    return res.status(400).json({
      success: false,
      error: "Serial monitor is not connected.",
    });
  }

  const message =
    typeof req.body.message === "string" ? req.body.message.slice(0, 4096) : "";
  const lineEnding = requestString(req.body.lineEnding, "");
  const appendNewline = requestBoolean(req.body.appendNewline, true);

  if (!message && getSerialLineEnding(lineEnding, appendNewline) === "") {
    return res.status(400).json({
      success: false,
      error: "Message is required.",
    });
  }

  const payload = message + getSerialLineEnding(lineEnding, appendNewline);

  serialPort.write(payload, (error) => {
    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message,
      });
    }

    serialPort.drain(() => {
      sendToClients(`[Serial write] ${JSON.stringify(payload)}\n`);

      res.json({
        success: true,
        bytesWritten: Buffer.byteLength(payload),
      });
    });
  });
});

app.post("/serial/stop", (req, res) => {
  closeSerial(() => {
    res.json({ success: true });
  });
});

app.get("/libs", (req, res) => {
  runArduinoCli(
    ["lib", "list", "--format", "json"],
    (code, stdout, stderr) => {
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `arduino-cli exited with code ${code}`,
        });
      }

      try {
        const parsed = JSON.parse(stdout);

        const libraries = Array.isArray(parsed)
          ? parsed
          : parsed.libraries ||
            parsed.installed_libraries ||
            parsed.items ||
            parsed.result ||
            [];

        const cleanedLibraries = libraries.map((lib) => ({
          name: getLibraryName(lib) || "Unknown Library",
          version:
            lib.version ||
            lib.installed_version ||
            lib.library?.version ||
            lib.metadata?.version ||
            "",
          author:
            lib.author ||
            lib.library?.author ||
            lib.metadata?.author ||
            "",
          raw: lib,
        }));

        res.json({
          success: true,
          count: cleanedLibraries.length,
          libraries: cleanedLibraries,
        });
      } catch {
        res.status(500).json({
          success: false,
          error: "Could not parse installed library JSON",
          raw: stdout,
        });
      }
    }
  );
});

app.post("/libs/search", (req, res) => {
  const query = requestString(req.body.query, "");

  if (!query) {
    return res.status(400).json({
      success: false,
      error: "Search query is required.",
    });
  }

  runArduinoCli(
    ["lib", "search", query, "--format", "json"],
    (code, stdout, stderr) => {
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `arduino-cli exited with code ${code}`,
        });
      }

      try {
        const parsed = JSON.parse(stdout);

        const libraries = Array.isArray(parsed)
          ? parsed
          : parsed.libraries || [];

        const cleanedLibraries = libraries
          .filter((lib) => lib && lib.name)
          .map((lib) => ({
            name: lib.name,
            sentence: lib.latest?.sentence || lib.sentence || "",
            version: lib.latest?.version || "",
            author: lib.latest?.author || "",
            category: lib.latest?.category || "",
            architectures: lib.latest?.architectures || [],
            includes: lib.latest?.provides_includes || [],
          }));

        res.json({
          success: true,
          count: cleanedLibraries.length,
          libraries: cleanedLibraries.slice(0, 30),
        });
      } catch {
        res.status(500).json({
          success: false,
          error: "Could not parse library search JSON",
        });
      }
    }
  );
});

app.post("/libs/install", (req, res) => {
  const library = requestString(req.body.library, "");

  if (!library) {
    return res.status(400).json({
      success: false,
      error: "Library name is required.",
    });
  }

  runArduinoCli(
    ["lib", "install", library],
    (code, stdout, stderr) => {
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `arduino-cli exited with code ${code}`,
        });
      }

      res.json({
        success: true,
        output: stdout || `Installed library: ${library}`,
      });
    }
  );
});

app.post("/libs/uninstall", (req, res) => {
  const library = requestString(req.body.library, "");

  if (!library) {
    return res.status(400).json({
      success: false,
      error: "Library name is required.",
    });
  }

  runArduinoCli(
    ["lib", "uninstall", library],
    (code, stdout, stderr) => {
      if (code !== 0) {
        return res.status(500).json({
          success: false,
          error: stderr || `arduino-cli exited with code ${code}`,
        });
      }

      res.json({
        success: true,
        output: stdout || `Removed library: ${library}`,
      });
    }
  );
});

app.post("/libs/upgrade", (req, res) => {
  const library = requestString(req.body.library, "");
  const args = library ? ["lib", "upgrade", library] : ["lib", "upgrade"];

  runArduinoCli(args, (code, stdout, stderr) => {
    if (code !== 0) {
      return res.status(500).json({
        success: false,
        error: stderr || `arduino-cli exited with code ${code}`,
      });
    }

    res.json({
      success: true,
      output: stdout || (library ? `Updated library: ${library}` : "Updated libraries."),
    });
  });
});

app.get(
  /^\/(?!api(?:\/|$)|serial(?:\/|$)|boards(?:\/|$)|board-list(?:\/|$)|libs(?:\/|$)|cores(?:\/|$)|compile(?:\/|$)|upload(?:\/|$)|upload-ota(?:\/|$)).*/,
  (req, res, next) => {
    if (!hasFrontendBuild()) return next();

    res.sendFile(FRONTEND_INDEX_FILE);
  }
);

const server = app.listen(SERVER_PORT, SERVER_HOST, () => {
  console.log(`Backend running at http://${SERVER_HOST}:${SERVER_PORT}`);
});

server.on("error", (error) => {
  console.error("Backend server error:", error.message);
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  clients.push(ws);
  ws.send("[WebSocket connected]\n");
  sendSerialStatus(ws);

  ws.on("close", () => {
    clients = clients.filter((client) => client !== ws);
  });
});
