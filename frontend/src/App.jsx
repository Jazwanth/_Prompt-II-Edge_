import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import axios from "axios";

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from "chart.js";

import { Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend
);

const DEFAULT_FILES = [
  {
    name: "tempSketch.ino",
    content: `void setup() {
  Serial.begin(115200);
}

void loop() {
  int value = random(0, 100);
  Serial.println(value);
  delay(500);
}
`,
  },
];

const PROJECTS_KEY = "webArduinoIDE_projects";
const AUTOSAVE_KEY = "webArduinoIDE_autosave_tabs";
const DASHBOARD_CONFIG_KEY = "webArduinoIDE_dashboard_config";
const MAIN_FILE = "tempSketch.ino";
const AUTOSAVE_DELAY_MS = 500;
const MAX_SERIAL_CHARS = 30000;
const MAX_PLOT_POINTS = 80;
const SERIAL_FLUSH_MS = 100;
const DEFAULT_BAUD_RATE = 115200;
const ALLOWED_FILE_EXTENSIONS = [".ino", ".cpp", ".c", ".h", ".hpp", ".txt"];
const SERIAL_BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 921600];

const EDITOR_OPTIONS = {
  automaticLayout: true,
  minimap: { enabled: false },
  renderWhitespace: "selection",
  scrollBeyondLastLine: false,
  smoothScrolling: true,
};

const PLOT_OPTIONS = {
  responsive: true,
  animation: false,
  maintainAspectRatio: false,
};

const PLOT_COLORS = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#be123c",
  "#4f46e5",
];

function createDefaultFiles() {
  return DEFAULT_FILES.map((file) => ({ ...file }));
}

function cleanFileName(name) {
  return String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function getFileExtension(name) {
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex).toLowerCase() : "";
}

function isAllowedFileName(name) {
  return ALLOWED_FILE_EXTENSIONS.includes(getFileExtension(name));
}

function normalizeFiles(files) {
  const sourceFiles = Array.isArray(files) ? files : createDefaultFiles();
  const normalized = [];
  const seenNames = new Set();
  let mainFile = null;

  sourceFiles.forEach((file) => {
    const originalName = cleanFileName(file?.name);
    if (!originalName || !isAllowedFileName(originalName)) return;

    const content = typeof file?.content === "string" ? file.content : "";
    const isIno = getFileExtension(originalName) === ".ino";
    const name = isIno ? MAIN_FILE : originalName;

    if (seenNames.has(name)) return;

    const normalizedFile = { name, content };
    seenNames.add(name);

    if (name === MAIN_FILE) {
      mainFile = normalizedFile;
      return;
    }

    normalized.push(normalizedFile);
  });

  if (!mainFile) {
    mainFile = createDefaultFiles()[0];
  }

  return [mainFile, ...normalized];
}

function readStoredFiles() {
  try {
    const autosaved = localStorage.getItem(AUTOSAVE_KEY);
    const parsed = autosaved ? JSON.parse(autosaved) : createDefaultFiles();

    return normalizeFiles(parsed);
  } catch {
    return createDefaultFiles();
  }
}

function readStoredProjects() {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    const projects = raw ? JSON.parse(raw) : {};

    return projects && typeof projects === "object" && !Array.isArray(projects)
      ? projects
      : {};
  } catch {
    return {};
  }
}

function readDashboardConfig() {
  try {
    const raw = localStorage.getItem(DASHBOARD_CONFIG_KEY);
    const parsed = raw ? JSON.parse(raw) : {};

    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function formatApiError(err) {
  const data = err.response?.data;

  if (data?.error) return data.error;
  if (typeof data === "string") return data;

  return JSON.stringify(data || err.message, null, 2);
}

function parseSerialMetrics(line) {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);

      return Object.entries(parsed)
        .map(([name, value]) => ({
          name: name.trim().replace(/\s+/g, " "),
          value: Number(value),
        }))
        .filter((item) => item.name && Number.isFinite(item.value));
    } catch {
      // Fall through to Arduino-style key:value parsing.
    }
  }

  const namedValues = [];
  const pairPattern = /([a-zA-Z_][\w .-]*)\s*[:=]\s*(-?\d+(?:\.\d+)?)/g;
  let match = pairPattern.exec(trimmed);

  while (match) {
    namedValues.push({
      name: match[1].trim().replace(/\s+/g, " "),
      value: Number(match[2]),
    });
    match = pairPattern.exec(trimmed);
  }

  if (namedValues.length > 0) {
    return namedValues.filter((item) => Number.isFinite(item.value));
  }

  const value = Number(trimmed);

  if (Number.isFinite(value)) {
    return [{ name: "Serial Value", value }];
  }

  return [];
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function getMetricRange(config) {
  const min = Number(config?.min);
  const max = Number(config?.max);

  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return null;
  }

  return { min, max };
}

const CodeEditor = memo(function CodeEditor({ fileName, code, onChange }) {
  return (
    <Editor
      height="500px"
      defaultLanguage="cpp"
      path={fileName}
      theme="vs-dark"
      value={code}
      options={EDITOR_OPTIONS}
      onChange={onChange}
    />
  );
});

const SerialConsole = memo(function SerialConsole({ selectedPort }) {
  const [serialData, setSerialData] = useState("");
  const [isSerialConnected, setIsSerialConnected] = useState(false);
  const [baudRate, setBaudRate] = useState(DEFAULT_BAUD_RATE);
  const [plotRows, setPlotRows] = useState([]);
  const [latestMetrics, setLatestMetrics] = useState({});
  const [dashboardConfig, setDashboardConfig] = useState(readDashboardConfig);
  const [selectedMetric, setSelectedMetric] = useState("");

  const pointCounterRef = useRef(0);
  const serialBufferRef = useRef("");
  const plotBufferRef = useRef([]);
  const latestMetricsBufferRef = useRef({});
  const serialLineBufferRef = useRef("");
  const flushTimerRef = useRef(null);

  const flushBufferedData = useCallback(() => {
    flushTimerRef.current = null;

    const serialChunk = serialBufferRef.current;
    const plotChunk = plotBufferRef.current;
    const latestChunk = latestMetricsBufferRef.current;

    serialBufferRef.current = "";
    plotBufferRef.current = [];
    latestMetricsBufferRef.current = {};

    if (serialChunk) {
      setSerialData((prev) => (prev + serialChunk).slice(-MAX_SERIAL_CHARS));
    }

    if (plotChunk.length > 0) {
      setPlotRows((prev) =>
        [...prev, ...plotChunk].slice(-MAX_PLOT_POINTS)
      );
    }

    if (Object.keys(latestChunk).length > 0) {
      setLatestMetrics((prev) => ({
        ...prev,
        ...latestChunk,
      }));
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = window.setTimeout(
      flushBufferedData,
      SERIAL_FLUSH_MS
    );
  }, [flushBufferedData]);

  const queueSerialData = useCallback(
    (message) => {
      setIsSerialConnected(true);
      serialBufferRef.current += message;

      const combined = serialLineBufferRef.current + message;
      const lines = combined.split(/\r?\n/);

      serialLineBufferRef.current = /(?:\r?\n)$/.test(combined)
        ? ""
        : lines.pop() || "";

      const nextPoints = [];

      lines.forEach((line) => {
        const metrics = parseSerialMetrics(line);
        if (metrics.length === 0) return;

        pointCounterRef.current += 1;

        const values = {};
        metrics.forEach((metric) => {
          values[metric.name] = metric.value;
          latestMetricsBufferRef.current[metric.name] = metric.value;
        });

        nextPoints.push({
          label: pointCounterRef.current.toString(),
          values,
        });
      });

      if (nextPoints.length > 0) {
        plotBufferRef.current.push(...nextPoints);
      }

      scheduleFlush();
    },
    [scheduleFlush]
  );

  const refreshSerialStatus = useCallback(async () => {
    try {
      const res = await axios.get("http://localhost:5000/serial/status");

      setIsSerialConnected(Boolean(res.data.connected));

      if (res.data.baudRate) {
        setBaudRate(Number(res.data.baudRate));
      }
    } catch {
      setIsSerialConnected(false);
    }
  }, []);

  useEffect(() => {
    const ws = new WebSocket("ws://localhost:5000");

    ws.onmessage = (event) => {
      const message = String(event.data);

      if (
        message.includes("[Serial connected") ||
        message.includes("[Serial already running") ||
        message.includes("[Serial status: connected")
      ) {
        setIsSerialConnected(true);
        return;
      }

      if (
        message.includes("[Serial status: disconnected") ||
        message.includes("[Serial closed]") ||
        message.includes("[Serial Error]")
      ) {
        setIsSerialConnected(false);
        return;
      }

      if (message.includes("[WebSocket")) return;

      queueSerialData(message);
    };

    ws.onopen = () => {
      refreshSerialStatus();
    };

    ws.onerror = () => {
      refreshSerialStatus();
    };

    ws.onclose = () => {
      setIsSerialConnected(false);
    };

    return () => {
      ws.close();

      if (flushTimerRef.current) {
        window.clearTimeout(flushTimerRef.current);
      }
    };
  }, [queueSerialData, refreshSerialStatus]);

  const connectSerial = useCallback(async () => {
    try {
      const res = await axios.post("http://localhost:5000/serial/start", {
        port: selectedPort,
        baudRate,
      });

      if (res.data.success) {
        setIsSerialConnected(true);
      }
    } catch (err) {
      queueSerialData(
        "\n[Serial start error] " +
          formatApiError(err) +
          "\n"
      );
      setIsSerialConnected(false);
    }
  }, [baudRate, queueSerialData, selectedPort]);

  const disconnectSerial = useCallback(async () => {
    try {
      await axios.post("http://localhost:5000/serial/stop");
      setIsSerialConnected(false);
    } catch (err) {
      queueSerialData(
        "\n[Serial stop error] " +
          formatApiError(err) +
          "\n"
      );
    }
  }, [queueSerialData]);

  const clearSerial = useCallback(() => {
    serialBufferRef.current = "";
    serialLineBufferRef.current = "";
    setSerialData("");
  }, []);

  const clearPlot = useCallback(() => {
    plotBufferRef.current = [];
    latestMetricsBufferRef.current = {};
    pointCounterRef.current = 0;
    setPlotRows([]);
    setLatestMetrics({});
  }, []);

  useEffect(() => {
    localStorage.setItem(
      DASHBOARD_CONFIG_KEY,
      JSON.stringify(dashboardConfig)
    );
  }, [dashboardConfig]);

  const plotData = useMemo(
    () => {
      const seriesNames = Array.from(
        new Set(plotRows.flatMap((row) => Object.keys(row.values)))
      );

      return {
        labels: plotRows.map((row) => row.label),
        datasets: seriesNames.map((seriesName, index) => ({
          label: seriesName,
          data: plotRows.map((row) => row.values[seriesName] ?? null),
          borderColor: PLOT_COLORS[index % PLOT_COLORS.length],
          backgroundColor: PLOT_COLORS[index % PLOT_COLORS.length],
          tension: 0.3,
          spanGaps: true,
        })),
      };
    },
    [plotRows]
  );

  const latestMetricEntries = Object.entries(latestMetrics);
  const selectedDashboardMetric =
    selectedMetric && latestMetrics[selectedMetric] !== undefined
      ? selectedMetric
      : latestMetricEntries[0]?.[0] || "";

  const selectedDashboardConfig =
    dashboardConfig[selectedDashboardMetric] || {};

  const updateDashboardMetricConfig = useCallback((metricName, patch) => {
    if (!metricName) return;

    setDashboardConfig((prev) => ({
      ...prev,
      [metricName]: {
        ...prev[metricName],
        ...patch,
      },
    }));
  }, []);

  const resetDashboardMetricConfig = useCallback((metricName) => {
    if (!metricName) return;

    setDashboardConfig((prev) => {
      const nextConfig = { ...prev };
      delete nextConfig[metricName];
      return nextConfig;
    });
  }, []);

  return (
    <>
      <div style={{ marginTop: "15px" }}>
        <select
          value={baudRate}
          onChange={(event) => setBaudRate(Number(event.target.value))}
          style={{ marginRight: "10px" }}
        >
          {SERIAL_BAUD_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {rate} baud
            </option>
          ))}
        </select>

        <button onClick={connectSerial}>Connect Serial</button>

        <button onClick={disconnectSerial} style={{ marginLeft: "10px" }}>
          Disconnect Serial
        </button>

        <button onClick={clearSerial} style={{ marginLeft: "10px" }}>
          Clear Serial
        </button>

        <button onClick={clearPlot} style={{ marginLeft: "10px" }}>
          Clear Plot
        </button>
      </div>

      <h3>
        Serial Monitor:{" "}
        <span style={{ color: isSerialConnected ? "green" : "red" }}>
          {isSerialConnected ? "Connected" : "Disconnected"}
        </span>
      </h3>

      <div style={{ background: "#111", color: "#00ff00", padding: "10px", height: "220px", overflow: "auto", marginTop: "20px", border: "1px solid #333" }}>
        <pre>{serialData}</pre>
      </div>

      <h3>Serial Plotter</h3>

      <div style={{ height: "300px", background: "#fff", border: "1px solid #ccc", padding: "10px" }}>
        <Line data={plotData} options={PLOT_OPTIONS} />
      </div>

      <h3>Circuit Dashboard</h3>

      {latestMetricEntries.length > 0 && (
        <div
          style={{
            marginBottom: "10px",
            padding: "10px",
            background: "#f8fafc",
            border: "1px solid #d8dee9",
            textAlign: "left",
          }}
        >
          <select
            value={selectedDashboardMetric}
            onChange={(event) => setSelectedMetric(event.target.value)}
          >
            {latestMetricEntries.map(([name]) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <input
            value={selectedDashboardConfig.unit || ""}
            onChange={(event) =>
              updateDashboardMetricConfig(selectedDashboardMetric, {
                unit: event.target.value,
              })
            }
            placeholder="unit"
            style={{ marginLeft: "10px", padding: "5px", width: "80px" }}
          />

          <input
            type="number"
            value={selectedDashboardConfig.min ?? ""}
            onChange={(event) =>
              updateDashboardMetricConfig(selectedDashboardMetric, {
                min: event.target.value,
              })
            }
            placeholder="min"
            style={{ marginLeft: "10px", padding: "5px", width: "80px" }}
          />

          <input
            type="number"
            value={selectedDashboardConfig.max ?? ""}
            onChange={(event) =>
              updateDashboardMetricConfig(selectedDashboardMetric, {
                max: event.target.value,
              })
            }
            placeholder="max"
            style={{ marginLeft: "10px", padding: "5px", width: "80px" }}
          />

          <button
            onClick={() => resetDashboardMetricConfig(selectedDashboardMetric)}
            style={{ marginLeft: "10px" }}
          >
            Reset Widget
          </button>
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: "10px",
          textAlign: "left",
        }}
      >
        {latestMetricEntries.length > 0 ? (
          latestMetricEntries.map(([name, value]) => {
            const config = dashboardConfig[name] || {};
            const range = getMetricRange(config);
            const isBinary = value === 0 || value === 1;
            const percent = range
              ? clampPercent(((value - range.min) / (range.max - range.min)) * 100)
              : null;

            return (
              <div
                key={name}
                style={{
                  background: "#f8fafc",
                  border: "1px solid #d8dee9",
                  padding: "10px",
                }}
              >
                <strong>{name}</strong>

                <div style={{ fontSize: "24px", color: "#111827" }}>
                  {value}
                  {config.unit && (
                    <span style={{ fontSize: "14px", marginLeft: "4px" }}>
                      {config.unit}
                    </span>
                  )}
                </div>

                {isBinary && (
                  <div style={{ marginTop: "8px" }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: "12px",
                        height: "12px",
                        borderRadius: "50%",
                        marginRight: "6px",
                        background: value ? "#16a34a" : "#94a3b8",
                      }}
                    />
                    {value ? "ON" : "OFF"}
                  </div>
                )}

                {range && (
                  <div style={{ marginTop: "8px" }}>
                    <div
                      style={{
                        height: "8px",
                        background: "#e5e7eb",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${percent}%`,
                          background: "#2563eb",
                        }}
                      />
                    </div>
                    <small>
                      {range.min} to {range.max}
                    </small>
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div
            style={{
              background: "#f8fafc",
              border: "1px solid #d8dee9",
              padding: "10px",
            }}
          >
            Waiting for serial values
          </div>
        )}
      </div>
    </>
  );
});

function getCoreLabel(core) {
  return (
    core.id ||
    core.ID ||
    core.platform ||
    core.name ||
    core.package ||
    core.platform_id ||
    JSON.stringify(core)
  );
}

function getCoreVersion(core) {
  return core.installed || core.version || core.latest_version || "";
}

function getCoreInstallId(core) {
  return (
    core.id ||
    core.ID ||
    core.platform ||
    core.platform_id ||
    core.name ||
    ""
  );
}

function getPortAddress(item) {
  return item.port?.address || item.address || item.port || "";
}

function getPortLabel(item) {
  const address = getPortAddress(item);
  const protocol = item.port?.protocol || item.protocol || "serial";

  const boardName =
    item.matching_boards?.[0]?.name ||
    item.boards?.[0]?.name ||
    "Unknown Board";

  return `${address} - ${boardName} (${protocol})`;
}

function App() {
  const [installedCores, setInstalledCores] = useState([]);
  const [coreToInstall, setCoreToInstall] = useState("arduino:avr");
  const [coreSearchQuery, setCoreSearchQuery] = useState("esp8266");
  const [coreSearchResults, setCoreSearchResults] = useState([]);
  const [coreOutput, setCoreOutput] = useState("");

  const [availableBoards, setAvailableBoards] = useState([]);
  const [output, setOutput] = useState("");

  const [ports, setPorts] = useState([]);
  const [selectedPort, setSelectedPort] = useState("/dev/ttyUSB0");
  const [selectedFqbn, setSelectedFqbn] = useState("esp32:esp32:esp32");

  const [projectName, setProjectName] = useState("Untitled");
  const [savedProjects, setSavedProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState("");

  const [installedLibraries, setInstalledLibraries] = useState([]);
  const [librarySearchQuery, setLibrarySearchQuery] = useState("wifi");
  const [librarySearchResults, setLibrarySearchResults] = useState([]);
  const [libraryOutput, setLibraryOutput] = useState("");

  const [uploadMode, setUploadMode] = useState("usb");
  const [otaIp, setOtaIp] = useState("192.168.1.100");
  const [otaPassword, setOtaPassword] = useState("");

  const [files, setFiles] = useState(readStoredFiles);

  const [activeFile, setActiveFile] = useState(() => {
    const loaded = readStoredFiles();
    return loaded[0]?.name || MAIN_FILE;
  });

  const fileInputRef = useRef(null);
  const latestFilesRef = useRef(files);

  const currentFile = useMemo(
    () => files.find((file) => file.name === activeFile) || files[0],
    [activeFile, files]
  );

  const currentCode = currentFile?.content || "";

  useEffect(() => {
    latestFilesRef.current = files;

    const autosaveTimer = window.setTimeout(() => {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(files));
    }, AUTOSAVE_DELAY_MS);

    return () => {
      window.clearTimeout(autosaveTimer);
    };
  }, [files]);

  useEffect(() => {
    const flushAutosave = () => {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(latestFilesRef.current));
    };

    window.addEventListener("pagehide", flushAutosave);

    return () => {
      window.removeEventListener("pagehide", flushAutosave);
    };
  }, []);

  const updateCurrentFile = useCallback(
    (content) => {
      const nextContent = content || "";

      setFiles((prev) => {
        let didChange = false;

        const nextFiles = prev.map((file) => {
          if (file.name !== activeFile) return file;
          if (file.content === nextContent) return file;

          didChange = true;
          return { ...file, content: nextContent };
        });

        return didChange ? nextFiles : prev;
      });
    },
    [activeFile]
  );

  const addFile = () => {
    const rawName = prompt("Enter file name, example: wifi.cpp or config.h");
    const name = cleanFileName(rawName);

    if (!name) return;

    if (!isAllowedFileName(name)) {
      setOutput("Use a source file extension like .cpp, .c, .h, .hpp, or .txt.");
      return;
    }

    if (getFileExtension(name) === ".ino") {
      setOutput("Only one .ino file is allowed. Use .cpp / .h files.");
      return;
    }

    if (files.some((file) => file.name === name)) {
      setOutput(`File "${name}" already exists.`);
      return;
    }

    const newFile = {
      name,
      content: name.endsWith(".h")
        ? "#pragma once\n"
        : name.endsWith(".cpp")
        ? '#include "Arduino.h"\n'
        : "",
    };

    setFiles((prev) => [...prev, newFile]);
    setActiveFile(name);

    if (name !== rawName.trim()) {
      setOutput(`Created "${name}" with unsafe characters cleaned up.`);
    }
  };

  const deleteFile = () => {
    if (files.length === 1) {
      setOutput("You need at least one file.");
      return;
    }

    if (activeFile === "tempSketch.ino") {
      setOutput("Do not delete the main .ino file.");
      return;
    }

    const nextFiles = files.filter((file) => file.name !== activeFile);
    setFiles(nextFiles);
    setActiveFile(nextFiles[0].name);
  };

  const loadProjectList = () => {
    const projects = readStoredProjects();
    setSavedProjects(Object.keys(projects));
  };

  const getProjects = () => {
    return readStoredProjects();
  };

  const saveProject = () => {
    const name = projectName.trim();

    if (!name) {
      setOutput("Project name cannot be empty.");
      return;
    }

    const projects = getProjects();

    const normalizedFiles = normalizeFiles(files);

    projects[name] = {
      files: normalizedFiles,
      activeFile: normalizedFiles.some((file) => file.name === activeFile)
        ? activeFile
        : normalizedFiles[0].name,
      selectedPort,
      selectedFqbn,
      updatedAt: new Date().toISOString(),
    };

    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    setSelectedProject(name);
    loadProjectList();

    setOutput(`Project "${name}" saved successfully.`);
  };

  const openProject = (name) => {
    if (!name) return;

    const projects = getProjects();
    const project = projects[name];

    if (!project) {
      setOutput(`Project "${name}" not found.`);
      return;
    }

    setProjectName(name);
    setSelectedProject(name);

    const projectFiles = project.files
      ? normalizeFiles(project.files)
      : normalizeFiles([{ name: MAIN_FILE, content: project.code || "" }]);

    const storedActiveFile = cleanFileName(project.activeFile);
    const nextActiveFile =
      getFileExtension(storedActiveFile) === ".ino"
        ? MAIN_FILE
        : storedActiveFile;

    setFiles(projectFiles);
    setActiveFile(
      projectFiles.some((file) => file.name === nextActiveFile)
        ? nextActiveFile
        : projectFiles[0].name
    );

    if (project.selectedPort) setSelectedPort(project.selectedPort);
    if (project.selectedFqbn) setSelectedFqbn(project.selectedFqbn);

    setOutput(`Project "${name}" opened.`);
  };

  const deleteProject = () => {
    const name = selectedProject || projectName.trim();

    if (!name) {
      setOutput("No project selected to delete.");
      return;
    }

    const projects = getProjects();

    if (!projects[name]) {
      setOutput(`Project "${name}" not found.`);
      return;
    }

    delete projects[name];
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));

    setSelectedProject("");
    loadProjectList();

    setOutput(`Project "${name}" deleted.`);
  };

  const newProject = () => {
    setProjectName("Untitled");
    setSelectedProject("");
    setFiles(createDefaultFiles());
    setActiveFile(MAIN_FILE);
    setOutput("New project created.");
  };

  const exportCurrentFile = () => {
    const blob = new Blob([currentCode], { type: "text/plain" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = activeFile;
    a.click();

    URL.revokeObjectURL(url);

    setOutput(`Exported ${activeFile}`);
  };

  const importFile = (event) => {
    const file = event.target.files[0];

    if (!file) return;

    const reader = new FileReader();

    reader.onload = () => {
      const importedCode =
        typeof reader.result === "string" ? reader.result : "";
      const importedName = cleanFileName(file.name);

      if (!isAllowedFileName(importedName)) {
        setOutput("Imported file type is not supported.");
        return;
      }

      if (getFileExtension(importedName) === ".ino") {
        setFiles((prev) =>
          normalizeFiles(prev).map((item) =>
            item.name === MAIN_FILE
              ? { ...item, content: importedCode }
              : item
          )
        );
        setActiveFile(MAIN_FILE);
        setOutput(`Imported ${file.name} into ${MAIN_FILE}`);
        return;
      }

      setFiles((prev) => {
        const exists = prev.some((item) => item.name === importedName);

        if (exists) {
          return prev.map((item) =>
            item.name === importedName
              ? { ...item, content: importedCode }
              : item
          );
        }

        return [...prev, { name: importedName, content: importedCode }];
      });

      setActiveFile(importedName);
      setOutput(
        importedName === file.name
          ? `Imported ${importedName}`
          : `Imported ${file.name} as ${importedName}`
      );
    };

    reader.readAsText(file);
    event.target.value = "";
  };

  const refreshBoards = async () => {
    try {
      const res = await axios.get("http://localhost:5000/boards");
      const detected = Array.isArray(res.data.boards) ? res.data.boards : [];

      setPorts(detected);

      if (detected.length > 0) {
        const first = detected[0];

        const detectedPort =
          first.port?.address || first.address || first.port || "/dev/ttyUSB0";

        setSelectedPort(detectedPort);

        if (first.matching_boards?.length > 0) {
          setSelectedFqbn(first.matching_boards[0].fqbn);
        }
      }
    } catch (err) {
      setOutput(formatApiError(err));
    }
  };

  const refreshBoardList = async () => {
    try {
      const res = await axios.get("http://localhost:5000/board-list");
      const boards = Array.isArray(res.data.boards) ? res.data.boards : [];
      setAvailableBoards(boards);
    } catch (err) {
      setOutput(formatApiError(err));
    }
  };

  const refreshLibraries = async () => {
    try {
      setLibraryOutput("Loading installed libraries...\n");

      const res = await axios.get("http://localhost:5000/libs");
      const libs = Array.isArray(res.data.libraries) ? res.data.libraries : [];

      setInstalledLibraries(libs);
      setLibraryOutput(`Loaded ${libs.length} installed libraries.`);
    } catch (err) {
      setLibraryOutput(formatApiError(err));
    }
  };

  const searchLibraries = async () => {
    try {
      if (!librarySearchQuery.trim()) {
        setLibraryOutput("Enter a library search term.");
        return;
      }

      setLibraryOutput(`Searching "${librarySearchQuery}"...\n`);

      const res = await axios.post("http://localhost:5000/libs/search", {
        query: librarySearchQuery.trim(),
      });

      setLibrarySearchResults(res.data.libraries || []);
      setLibraryOutput(`Found ${res.data.count || 0} libraries.`);
    } catch (err) {
      setLibraryOutput(formatApiError(err));
    }
  };

  const installLibrary = async (libraryName) => {
    try {
      setLibraryOutput(`Installing ${libraryName}...\n`);

      const res = await axios.post("http://localhost:5000/libs/install", {
        library: libraryName,
      });

      setLibraryOutput(res.data.output || `Installed ${libraryName}`);
      refreshLibraries();
    } catch (err) {
      setLibraryOutput(formatApiError(err));
    }
  };

  const uninstallLibrary = async (libraryName) => {
    try {
      if (!libraryName) {
        setLibraryOutput("No library selected to remove.");
        return;
      }

      setLibraryOutput(`Removing ${libraryName}...\n`);

      const res = await axios.post("http://localhost:5000/libs/uninstall", {
        library: libraryName,
      });

      setLibraryOutput(res.data.output || `Removed ${libraryName}`);
      refreshLibraries();
    } catch (err) {
      setLibraryOutput(formatApiError(err));
    }
  };

  const updateLibrary = async (libraryName = "") => {
    try {
      setLibraryOutput(
        libraryName ? `Updating ${libraryName}...\n` : "Updating libraries...\n"
      );

      const res = await axios.post("http://localhost:5000/libs/upgrade", {
        library: libraryName,
      });

      setLibraryOutput(res.data.output || "Library update complete.");
      refreshLibraries();
    } catch (err) {
      setLibraryOutput(formatApiError(err));
    }
  };

  const insertInclude = (includeName) => {
    if (!includeName) {
      setLibraryOutput("No include file found for this library.");
      return;
    }

    const includeLine = `#include <${includeName}>\n`;

    if (currentCode.includes(includeLine.trim())) {
      setLibraryOutput(`${includeName} already included.`);
      return;
    }

    updateCurrentFile(includeLine + currentCode);
    setLibraryOutput(`Inserted #include <${includeName}>`);
  };

  const refreshCores = async () => {
    try {
      setCoreOutput("Loading installed cores...\n");

      const res = await axios.get("http://localhost:5000/cores");

      const cores = Array.isArray(res.data.cores) ? res.data.cores : [];

      setInstalledCores(cores);
      setCoreOutput(`Loaded ${cores.length} installed cores.`);
    } catch (err) {
      setCoreOutput(formatApiError(err));
    }
  };

  useEffect(() => {
    const startupTimer = window.setTimeout(() => {
      refreshLibraries();
      loadProjectList();
      refreshBoards();
      refreshBoardList();
      refreshCores();
    }, 0);

    return () => {
      window.clearTimeout(startupTimer);
    };
  }, []);

  const updateCoreIndex = async () => {
    try {
      setCoreOutput("Updating core index...\n");

      const res = await axios.post("http://localhost:5000/cores/update-index");

      setCoreOutput(res.data.output || "Core index updated.");

      refreshBoardList();
      refreshCores();
    } catch (err) {
      setCoreOutput(formatApiError(err));
    }
  };

  const searchCores = async () => {
    try {
      if (!coreSearchQuery.trim()) {
        setCoreOutput("Enter a core search term.");
        return;
      }

      setCoreOutput(`Searching cores for "${coreSearchQuery}"...\n`);

      const res = await axios.post("http://localhost:5000/cores/search", {
        query: coreSearchQuery.trim(),
      });

      setCoreSearchResults(res.data.cores || []);
      setCoreOutput(`Found ${res.data.count || 0} matching cores.`);
    } catch (err) {
      setCoreOutput(formatApiError(err));
    }
  };

  const installCore = async (coreName) => {
    const core =
      typeof coreName === "string" && coreName.trim()
        ? coreName.trim()
        : coreToInstall.trim();

    try {
      if (!core) {
        setCoreOutput("Enter a core name, example: arduino:avr");
        return;
      }

      setCoreOutput(`Installing ${core}...\n`);

      const res = await axios.post("http://localhost:5000/cores/install", {
        core,
      });

      setCoreOutput(res.data.output || `Installed ${core}`);

      refreshCores();
      refreshBoardList();
    } catch (err) {
      setCoreOutput(formatApiError(err));
    }
  };

  const uninstallCore = async (coreName) => {
    try {
      if (!coreName) {
        setCoreOutput("No core selected to remove.");
        return;
      }

      setCoreOutput(`Removing ${coreName}...\n`);

      const res = await axios.post("http://localhost:5000/cores/uninstall", {
        core: coreName,
      });

      setCoreOutput(res.data.output || `Removed ${coreName}`);

      refreshCores();
      refreshBoardList();
    } catch (err) {
      setCoreOutput(formatApiError(err));
    }
  };

  const updateCore = async (coreName = "") => {
    try {
      setCoreOutput(coreName ? `Updating ${coreName}...\n` : "Updating cores...\n");

      const res = await axios.post("http://localhost:5000/cores/upgrade", {
        core: coreName,
      });

      setCoreOutput(res.data.output || "Core update complete.");

      refreshCores();
      refreshBoardList();
    } catch (err) {
      setCoreOutput(formatApiError(err));
    }
  };

  const compileCode = async () => {
    try {
      setOutput("Compiling...\n");

      const res = await axios.post("http://localhost:5000/compile", {
        files,
        code: currentCode,
        fqbn: selectedFqbn,
      });

      setOutput(res.data.output);
    } catch (err) {
      setOutput(formatApiError(err));
    }
  };

  const uploadCode = async () => {
    try {
      setOutput("Uploading...\n");

      const res = await axios.post("http://localhost:5000/upload", {
        files,
        code: currentCode,
        port: selectedPort,
        fqbn: selectedFqbn,
      });

      setOutput(res.data.output);
    } catch (err) {
      setOutput(formatApiError(err));
    }
  };

  const uploadOtaCode = async () => {
    try {
      if (!otaIp.trim()) {
        setOutput("Enter ESP32 OTA IP address.");
        return;
      }

      setOutput(`Uploading OTA to ${otaIp}...\n`);

      const res = await axios.post("http://localhost:5000/upload-ota", {
        files,
        code: currentCode,
        fqbn: selectedFqbn,
        otaIp: otaIp.trim(),
        otaPassword,
      });

      setOutput(res.data.output);
    } catch (err) {
      setOutput(formatApiError(err));
    }
  };

  const savedProjectOptions = useMemo(
    () =>
      savedProjects.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      )),
    [savedProjects]
  );

  const portOptions = useMemo(
    () =>
      ports.map((item, index) => {
        const address = getPortAddress(item);
        if (!address) return null;

        return (
          <option key={`${address}-${index}`} value={address}>
            {getPortLabel(item)}
          </option>
        );
      }),
    [ports]
  );

  const boardOptions = useMemo(
    () =>
      availableBoards.map((board, index) => (
        <option key={`${board.fqbn}-${index}`} value={board.fqbn}>
          {board.name} - {board.fqbn}
        </option>
      )),
    [availableBoards]
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Web Arduino IDE</p>
          <h1>Prompt II Edge</h1>
        </div>

        <div className="topbar-actions">
          <button className="primary-action" onClick={compileCode}>
            Compile
          </button>

          <select
            value={uploadMode}
            onChange={(e) => setUploadMode(e.target.value)}
            aria-label="Upload mode"
          >
            <option value="usb">USB Upload</option>
            <option value="ota">ESP32 OTA Upload</option>
          </select>

          {uploadMode === "usb" ? (
            <button className="primary-action" onClick={uploadCode}>
              Upload USB
            </button>
          ) : (
            <>
              <input
                value={otaIp}
                onChange={(e) => setOtaIp(e.target.value)}
                placeholder="ESP32 IP"
                className="ota-input"
              />

              <input
                value={otaPassword}
                onChange={(e) => setOtaPassword(e.target.value)}
                placeholder="OTA password"
                className="ota-input"
                type="password"
              />

              <button className="primary-action" onClick={uploadOtaCode}>
                Upload OTA
              </button>
            </>
          )}
        </div>
      </header>

      <section className="project-bar">
        <input
          ref={fileInputRef}
          type="file"
          accept=".ino,.cpp,.c,.h,.hpp,.txt"
          className="hidden-input"
          onChange={importFile}
        />

        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="Project name"
          className="project-name-input"
        />

        <button onClick={newProject}>New Project</button>

        <button onClick={saveProject}>Save Project</button>

        <button onClick={exportCurrentFile}>
          Export Current File
        </button>

        <button onClick={() => fileInputRef.current?.click()}>
          Import File
        </button>

        <select
          value={selectedProject}
          onChange={(e) => openProject(e.target.value)}
        >
          <option value="">Open Saved Project</option>
          {savedProjectOptions}
        </select>

        <button className="danger-action" onClick={deleteProject}>
          Delete
        </button>
      </section>

      <section className="connection-bar">
        <button onClick={refreshBoards}>Refresh Boards</button>

        <button onClick={refreshBoardList}>
          Refresh Board List
        </button>

        <select
          value={selectedPort}
          onChange={(e) => setSelectedPort(e.target.value)}
          aria-label="Serial port"
        >
          <option value="/dev/ttyUSB0">/dev/ttyUSB0</option>
          <option value="/dev/ttyUSB1">/dev/ttyUSB1</option>
          <option value="/dev/ttyACM0">/dev/ttyACM0</option>
          <option value="/dev/ttyACM1">/dev/ttyACM1</option>

          {portOptions}
        </select>

        <select
          value={selectedFqbn}
          onChange={(e) => setSelectedFqbn(e.target.value)}
          aria-label="Board"
          className="board-select"
        >
          <option value="esp32:esp32:esp32">ESP32 Dev Module</option>

          {boardOptions}
        </select>

        <span className="status-chip">{selectedPort}</span>
        <span className="status-chip">{selectedFqbn}</span>
      </section>

      <main className="workspace-grid">
        <aside className="panel file-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Sketch</p>
              <h2>Files</h2>
            </div>
          </div>

          <div className="file-list">
            {files.map((file) => (
              <button
                key={file.name}
                onClick={() => setActiveFile(file.name)}
                className={activeFile === file.name ? "file-tab active" : "file-tab"}
              >
                {file.name}
              </button>
            ))}
          </div>

          <div className="button-row">
            <button onClick={addFile}>Add File</button>
            <button className="danger-action" onClick={deleteFile}>
              Delete File
            </button>
          </div>
        </aside>

        <section className="panel editor-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Active File</p>
              <h2>{activeFile}</h2>
            </div>
          </div>

          <CodeEditor
            fileName={activeFile}
            code={currentCode}
            onChange={updateCurrentFile}
          />

          <div className="output-panel">
            <div className="panel-heading compact-heading">
              <h2>Compiler / Upload Output</h2>
            </div>

            <pre className="console-output">{output}</pre>
          </div>
        </section>
      </main>

      <section className="manager-grid">
        <div className="panel manager-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Arduino CLI</p>
              <h2>Board Manager</h2>
            </div>
          </div>

          <div className="button-row">
            <button onClick={refreshCores}>Refresh Installed Cores</button>
            <button onClick={updateCoreIndex}>Update Core Index</button>
            <button onClick={() => updateCore()}>Update All Cores</button>
          </div>

          <div className="search-row">
            <input
              value={coreSearchQuery}
              onChange={(e) => setCoreSearchQuery(e.target.value)}
              placeholder="Search core, example: esp8266"
            />

            <button onClick={searchCores}>Search Cores</button>
          </div>

          <div className="search-row">
            <input
              value={coreToInstall}
              onChange={(e) => setCoreToInstall(e.target.value)}
              placeholder="example: arduino:avr"
            />

            <button onClick={() => installCore()}>Install Core</button>
          </div>

          <h3>Core Search Results</h3>

          <div className="result-list">
            {coreSearchResults.map((core, index) => {
              const coreId = getCoreInstallId(core);

              return (
                <div className="result-item" key={`${coreId}-${index}`}>
                  <strong>{coreId}</strong> {core.version && `v${core.version}`}
                  <small>{core.name}</small>

                  <button onClick={() => installCore(coreId)}>Install</button>
                </div>
              );
            })}
          </div>

          <h3>Installed Cores</h3>

          <ul className="installed-list">
            {installedCores.map((core, index) => {
              const coreId = getCoreInstallId(core) || getCoreLabel(core);

              return (
                <li key={`${coreId}-${index}`}>
                  <span>
                    {getCoreLabel(core)} {getCoreVersion(core)}
                  </span>

                  <div>
                    <button onClick={() => updateCore(coreId)}>Update</button>
                    <button
                      className="danger-action"
                      onClick={() => uninstallCore(coreId)}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          <pre className="console-output manager-output">{coreOutput}</pre>
        </div>

        <div className="panel manager-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Arduino CLI</p>
              <h2>Library Manager</h2>
            </div>
          </div>

          <div className="button-row">
            <button onClick={refreshLibraries}>Refresh Installed Libraries</button>
            <button onClick={() => updateLibrary()}>Update All Libraries</button>
          </div>

          <div className="search-row">
            <input
              value={librarySearchQuery}
              onChange={(e) => setLibrarySearchQuery(e.target.value)}
              placeholder="Search library, example: wifi"
            />

            <button onClick={searchLibraries}>Search Libraries</button>
          </div>

          <h3>Search Results</h3>

          <div className="result-list">
            {librarySearchResults.map((lib, index) => (
              <div className="result-item" key={`${lib.name}-${index}`}>
                <strong>{lib.name}</strong> {lib.version && `v${lib.version}`}
                <small>{lib.sentence}</small>
                <small>
                  {lib.author} | {lib.category}
                </small>

                {lib.includes?.length > 0 && (
                  <small>Includes: {lib.includes.join(", ")}</small>
                )}

                <div className="button-row">
                  <button onClick={() => installLibrary(lib.name)}>
                    Install
                  </button>

                  {lib.includes?.[0] && (
                    <button onClick={() => insertInclude(lib.includes[0])}>
                      Insert Include
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          <h3>Installed Libraries</h3>

          <ul className="installed-list">
            {installedLibraries.map((lib, index) => (
              <li key={`${lib.name}-${index}`}>
                <span>
                  {lib.name} {lib.version && `v${lib.version}`}
                </span>

                <div>
                  <button onClick={() => updateLibrary(lib.name)}>Update</button>
                  <button
                    className="danger-action"
                    onClick={() => uninstallLibrary(lib.name)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <pre className="console-output manager-output">{libraryOutput}</pre>
        </div>
      </section>

      <section className="panel serial-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Live Tools</p>
            <h2>Serial Monitor / Plotter / Dashboard</h2>
          </div>
        </div>

        <SerialConsole selectedPort={selectedPort} />
      </section>
    </div>
  );
}

export default App;
