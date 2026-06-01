import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
const LAYOUT_KEY = "webArduinoIDE_layout_sizes";
const MAIN_FILE = "tempSketch.ino";
const AUTOSAVE_DELAY_MS = 500;
const MAX_SERIAL_CHARS = 22000;
const MAX_PLOT_POINTS = 64;
const SERIAL_FLUSH_MS = 180;
const DEFAULT_BAUD_RATE = 115200;
const ALLOWED_FILE_EXTENSIONS = [".ino", ".cpp", ".c", ".h", ".hpp", ".txt"];
const SERIAL_BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 921600];
const AI_STEPS = ["Thinking", "Writing code", "Installing libraries", "Compiling", "Ready"];
const DEFAULT_LAYOUT_SIZES = {
  left: 250,
  right: 330,
  dock: 264,
};

const EDITOR_OPTIONS = {
  automaticLayout: true,
  minimap: { enabled: false },
  renderWhitespace: "none",
  scrollBeyondLastLine: false,
  smoothScrolling: false,
};

const PLOT_OPTIONS = {
  responsive: true,
  animation: false,
  maintainAspectRatio: false,
  normalized: true,
  plugins: {
    legend: {
      labels: {
        color: "#cbd5e1",
        boxWidth: 12,
      },
    },
  },
  scales: {
    x: {
      grid: { color: "rgba(148, 163, 184, 0.14)" },
      ticks: { color: "#94a3b8" },
    },
    y: {
      grid: { color: "rgba(148, 163, 184, 0.14)" },
      ticks: { color: "#94a3b8" },
    },
  },
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

const PLOTTER_IGNORED_LINE_PATTERNS = [
  /^\[Serial /i,
  /^ets\s/i,
  /^rst:/i,
  /^configsip:/i,
  /^clk_drv:/i,
  /^mode:/i,
  /^load:0x/i,
  /^entry\s/i,
  /^ho\s/i,
  /^connecting to wifi/i,
  /^ip address:/i,
  /^ota ready/i,
  /^\.+$/,
];

const PLOTTER_IGNORED_METRICS = new Set([
  "rst",
  "boot",
  "configsip",
  "spiwp",
  "clk_drv",
  "q_drv",
  "d_drv",
  "cs0_drv",
  "hd_drv",
  "wp_drv",
  "clock div",
  "entry",
]);

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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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

function readStoredLayoutSizes() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    const parsed = raw ? JSON.parse(raw) : {};

    return {
      left: clamp(Number(parsed.left) || DEFAULT_LAYOUT_SIZES.left, 180, 430),
      right: clamp(Number(parsed.right) || DEFAULT_LAYOUT_SIZES.right, 250, 540),
      dock: clamp(Number(parsed.dock) || DEFAULT_LAYOUT_SIZES.dock, 180, 480),
    };
  } catch {
    return DEFAULT_LAYOUT_SIZES;
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
  if (PLOTTER_IGNORED_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return [];
  }

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
  const pairPattern =
    /(^|[,;\s])([a-zA-Z_][\w .-]{0,32})\s*[:=]\s*(-?(?:\d+\.?\d*|\.\d+))(?![a-zA-Z0-9_.-])/g;
  let match = pairPattern.exec(trimmed);

  while (match) {
    const name = match[2].trim().replace(/\s+/g, " ");

    if (PLOTTER_IGNORED_METRICS.has(name.toLowerCase())) {
      match = pairPattern.exec(trimmed);
      continue;
    }

    namedValues.push({
      name,
      value: Number(match[3]),
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

const CodeEditor = memo(function CodeEditor({ fileName, code, onChange }) {
  return (
    <Editor
      height="100%"
      defaultLanguage="cpp"
      path={fileName}
      theme="vs-dark"
      value={code}
      options={EDITOR_OPTIONS}
      onChange={onChange}
    />
  );
});

const SerialConsole = memo(function SerialConsole({ selectedPort, activeView }) {
  const [serialData, setSerialData] = useState("");
  const [isSerialConnected, setIsSerialConnected] = useState(false);
  const [baudRate, setBaudRate] = useState(DEFAULT_BAUD_RATE);
  const [serialMessage, setSerialMessage] = useState("");
  const [serialLineEnding, setSerialLineEnding] = useState("lf");
  const [plotRows, setPlotRows] = useState([]);

  const pointCounterRef = useRef(0);
  const serialBufferRef = useRef("");
  const plotBufferRef = useRef([]);
  const serialLineBufferRef = useRef("");
  const flushTimerRef = useRef(null);

  const flushBufferedData = useCallback(() => {
    flushTimerRef.current = null;

    const serialChunk = serialBufferRef.current;
    const plotChunk = plotBufferRef.current;

    serialBufferRef.current = "";
    plotBufferRef.current = [];

    if (serialChunk) {
      setSerialData((prev) => (prev + serialChunk).slice(-MAX_SERIAL_CHARS));
    }

    if (plotChunk.length > 0) {
      setPlotRows((prev) =>
        [...prev, ...plotChunk].slice(-MAX_PLOT_POINTS)
      );
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
    pointCounterRef.current = 0;
    setPlotRows([]);
  }, []);

  const sendSerialMessage = useCallback(async () => {
    try {
      await axios.post("http://localhost:5000/serial/write", {
        message: serialMessage,
        lineEnding: serialLineEnding,
        appendNewline: serialLineEnding !== "none",
      });

      setSerialMessage("");
    } catch (err) {
      queueSerialData(
        "\n[Serial write error] " +
          formatApiError(err) +
          "\n"
      );
    }
  }, [queueSerialData, serialLineEnding, serialMessage]);

  const handleSerialMessageKeyDown = useCallback(
    (event) => {
      if (event.key !== "Enter" || event.shiftKey) return;

      event.preventDefault();
      sendSerialMessage();
    },
    [sendSerialMessage]
  );

  const plotData = useMemo(
    () => {
      const seriesNames = Array.from(
        new Set(plotRows.flatMap((row) => Object.keys(row.values)))
      ).filter(
        (seriesName) =>
          !PLOTTER_IGNORED_METRICS.has(seriesName.toLowerCase())
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

  return (
    <div className="serial-tool">
      <div className="serial-toolbar">
        <select
          value={baudRate}
          onChange={(event) => setBaudRate(Number(event.target.value))}
          aria-label="Serial baud rate"
        >
          {SERIAL_BAUD_RATES.map((rate) => (
            <option key={rate} value={rate}>
              {rate} baud
            </option>
          ))}
        </select>

        <button onClick={connectSerial}>Connect Serial</button>

        <button onClick={disconnectSerial}>
          Disconnect Serial
        </button>

        <button onClick={clearSerial}>
          Clear Serial
        </button>

        <button onClick={clearPlot}>
          Clear Plot
        </button>

        <span
          className={
            isSerialConnected
              ? "status-pill status-pill-success"
              : "status-pill status-pill-danger"
          }
        >
          Serial {isSerialConnected ? "Connected" : "Disconnected"}
        </span>
      </div>

      <div className="serial-send-row">
        <input
          value={serialMessage}
          onChange={(event) => setSerialMessage(event.target.value)}
          onKeyDown={handleSerialMessageKeyDown}
          placeholder="Send message to board"
          aria-label="Serial message"
        />

        <select
          value={serialLineEnding}
          onChange={(event) => setSerialLineEnding(event.target.value)}
          aria-label="Serial line ending"
          className="serial-ending-select"
        >
          <option value="lf">Newline</option>
          <option value="crlf">CRLF</option>
          <option value="cr">CR</option>
          <option value="none">No ending</option>
        </select>

        <button
          className="primary-action"
          onClick={sendSerialMessage}
          disabled={!isSerialConnected}
        >
          Send
        </button>
      </div>

      <div className="serial-content">
        {activeView === "plotter" ? (
          <div className="plotter-frame">
            <Line data={plotData} options={PLOT_OPTIONS} />
          </div>
        ) : (
          <pre className="serial-monitor">{serialData}</pre>
        )}
      </div>
    </div>
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
  const [activeRightTab, setActiveRightTab] = useState("board");
  const [activeDockTab, setActiveDockTab] = useState("output");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiStep, setAiStep] = useState("");
  const [aiIsGenerating, setAiIsGenerating] = useState(false);
  const [aiGeneratedWiring, setAiGeneratedWiring] = useState([]);
  const [aiWarnings, setAiWarnings] = useState([]);
  const [aiExplanation, setAiExplanation] = useState("");
  const [showAiUploadModal, setShowAiUploadModal] = useState(false);
  const [layoutSizes, setLayoutSizes] = useState(readStoredLayoutSizes);
  const [activeResizePanel, setActiveResizePanel] = useState("");

  const [files, setFiles] = useState(readStoredFiles);

  const [activeFile, setActiveFile] = useState(() => {
    const loaded = readStoredFiles();
    return loaded[0]?.name || MAIN_FILE;
  });

  const fileInputRef = useRef(null);
  const latestFilesRef = useRef(files);
  const resizeStateRef = useRef(null);

  const currentFile = useMemo(
    () => files.find((file) => file.name === activeFile) || files[0],
    [activeFile, files]
  );

  const currentCode = currentFile?.content || "";

  const stopPanelResize = useCallback(() => {
    resizeStateRef.current = null;
    setActiveResizePanel("");
    document.body.classList.remove("is-resizing");
    document.body.classList.remove("is-resizing-dock");
    document.body.classList.remove("is-resizing-columns");
  }, []);

  const applyPanelResize = useCallback((clientX, clientY) => {
    const resizeState = resizeStateRef.current;

    if (!resizeState) return;

    const deltaX = clientX - resizeState.startX;
    const deltaY = clientY - resizeState.startY;

    setLayoutSizes((prev) => {
      if (resizeState.panel === "left") {
        const maxLeft = Math.max(
          180,
          Math.min(430, resizeState.mainWidth - resizeState.right - 340)
        );

        return {
          ...prev,
          left: clamp(resizeState.left + deltaX, 180, maxLeft),
        };
      }

      if (resizeState.panel === "right") {
        const maxRight = Math.max(
          250,
          Math.min(540, resizeState.mainWidth - resizeState.left - 340)
        );

        return {
          ...prev,
          right: clamp(resizeState.right - deltaX, 250, maxRight),
        };
      }

      if (resizeState.panel === "dock") {
        const maxDock = Math.max(
          180,
          Math.min(480, resizeState.shellHeight - 260)
        );

        return {
          ...prev,
          dock: clamp(resizeState.dock - deltaY, 180, maxDock),
        };
      }

      return prev;
    });
  }, []);

  const startPanelResize = useCallback(
    (panel, event) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);

      resizeStateRef.current = {
        panel,
        startX: event.clientX,
        startY: event.clientY,
        mainWidth:
          document.querySelector(".ide-main")?.clientWidth || window.innerWidth,
        shellHeight:
          document.querySelector(".ide-shell")?.clientHeight ||
          window.innerHeight,
        ...layoutSizes,
      };

      setActiveResizePanel(panel);
      document.body.classList.add("is-resizing");
      document.body.classList.toggle("is-resizing-dock", panel === "dock");
      document.body.classList.toggle("is-resizing-columns", panel !== "dock");
    },
    [layoutSizes]
  );

  useEffect(() => {
    const handlePointerMove = (event) => {
      applyPanelResize(event.clientX, event.clientY);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopPanelResize);
    window.addEventListener("pointercancel", stopPanelResize);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopPanelResize);
      window.removeEventListener("pointercancel", stopPanelResize);
      resizeStateRef.current = null;
      document.body.classList.remove("is-resizing");
      document.body.classList.remove("is-resizing-dock");
      document.body.classList.remove("is-resizing-columns");
    };
  }, [applyPanelResize, stopPanelResize]);

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layoutSizes));
  }, [layoutSizes]);

  useEffect(() => {
    const constrainLayout = () => {
      const mainWidth =
        document.querySelector(".ide-main")?.clientWidth || window.innerWidth;
      const shellHeight =
        document.querySelector(".ide-shell")?.clientHeight ||
        window.innerHeight;

      setLayoutSizes((prev) => {
        const maxLeft = Math.max(180, Math.min(430, mainWidth - prev.right - 340));
        const left = clamp(prev.left, 180, maxLeft);
        const maxRight = Math.max(250, Math.min(540, mainWidth - left - 340));
        const right = clamp(prev.right, 250, maxRight);
        const maxDock = Math.max(180, Math.min(480, shellHeight - 260));
        const dock = clamp(prev.dock, 180, maxDock);

        if (left === prev.left && right === prev.right && dock === prev.dock) {
          return prev;
        }

        return { left, right, dock };
      });
    };

    constrainLayout();
    window.addEventListener("resize", constrainLayout);

    return () => {
      window.removeEventListener("resize", constrainLayout);
    };
  }, []);

  useEffect(() => {
    if (!aiIsGenerating) return undefined;

    setAiStep(AI_STEPS[0]);

    const stepTimer = window.setInterval(() => {
      setAiStep((currentStep) => {
        const index = AI_STEPS.indexOf(currentStep);
        const nextIndex = Math.min(index + 1, AI_STEPS.length - 2);

        return AI_STEPS[nextIndex < 0 ? 0 : nextIndex];
      });
    }, 1800);

    return () => {
      window.clearInterval(stepTimer);
    };
  }, [aiIsGenerating]);

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

  const saveGeneratedProject = (name, generatedFiles) => {
    const cleanName = name.trim() || "AI Generated Project";
    const normalizedFiles = normalizeFiles(generatedFiles);
    const projects = getProjects();

    projects[cleanName] = {
      files: normalizedFiles,
      activeFile: normalizedFiles[0].name,
      selectedPort,
      selectedFqbn,
      updatedAt: new Date().toISOString(),
    };

    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
    setSelectedProject(cleanName);
    loadProjectList();
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

  const generateAiProject = async () => {
    const prompt = aiPrompt.trim();

    if (!prompt) {
      setOutput("Enter a prompt for the AI project generator.");
      setActiveDockTab("output");
      return;
    }

    setAiIsGenerating(true);
    setAiStep(AI_STEPS[0]);
    setAiWarnings([]);
    setAiGeneratedWiring([]);
    setAiExplanation("");
    setShowAiUploadModal(false);
    setActiveDockTab("output");
    setOutput("AI: Thinking...\n");

    try {
      const res = await axios.post("http://localhost:5000/api/ai/generate-project", {
        prompt,
        fqbn: selectedFqbn,
        projectName: projectName.trim(),
        files,
      });

      const project = res.data.project || {};
      const generatedFiles = normalizeFiles(project.files || []);
      const generatedName = project.projectName || projectName || "AI Generated Project";
      const generatedWiring = res.data.wiring || project.wiring || [];
      const generatedWarnings = res.data.warnings || project.warnings || [];

      setProjectName(generatedName);
      setFiles(generatedFiles);
      setActiveFile(generatedFiles[0]?.name || MAIN_FILE);
      setAiGeneratedWiring(generatedWiring);
      setAiWarnings(generatedWarnings);
      setAiExplanation(res.data.explanation || project.explanation || "");
      setAiStep(AI_STEPS[AI_STEPS.length - 1]);
      setOutput(res.data.compileOutput || "AI project generated and compiled.");
      saveGeneratedProject(generatedName, generatedFiles);

      if (res.data.readyToUpload) {
        setShowAiUploadModal(true);
      }
    } catch (err) {
      const data = err.response?.data || {};
      const project = data.project || {};

      if (project.files) {
        const generatedFiles = normalizeFiles(project.files);
        const generatedName = project.projectName || projectName || "AI Generated Project";

        setProjectName(generatedName);
        setFiles(generatedFiles);
        setActiveFile(generatedFiles[0]?.name || MAIN_FILE);
        setAiGeneratedWiring(data.wiring || project.wiring || []);
        setAiWarnings(data.warnings || project.warnings || []);
        setAiExplanation(data.explanation || project.explanation || "");
      }

      setAiStep("Compile failed");
      setOutput(data.compileOutput || formatApiError(err));
    } finally {
      setAiIsGenerating(false);
    }
  };

  const uploadAiProjectUsb = async () => {
    setShowAiUploadModal(false);
    setUploadMode("usb");
    await uploadCode();
  };

  const uploadAiProjectOta = async () => {
    setShowAiUploadModal(false);
    setUploadMode("ota");
    await uploadOtaCode();
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

  const selectedBoardName =
    availableBoards.find((board) => board.fqbn === selectedFqbn)?.name ||
    selectedFqbn;

  const rightTabs = [
    { id: "assistant", label: "AI" },
    { id: "board", label: "Board" },
    { id: "libraries", label: "Libraries" },
    { id: "wiring", label: "Wiring" },
  ];

  const dockTabs = [
    { id: "output", label: "Output" },
    { id: "serial", label: "Serial" },
    { id: "plotter", label: "Plotter" },
    { id: "logs", label: "Logs" },
  ];

  return (
    <div
      className="ide-shell"
      style={{
        "--left-sidebar-width": `${layoutSizes.left}px`,
        "--right-sidebar-width": `${layoutSizes.right}px`,
        "--dock-height": `${layoutSizes.dock}px`,
      }}
    >
      <header className="command-bar glass-panel">
        <div className="project-identity">
          <div className="brand-mark">
            <img src="/logo.png?v=3" alt="Prompt II Edge logo" />
          </div>

          <label className="project-title-field">
            <span>Prompt II Edge</span>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Project name"
              aria-label="Project name"
              className="project-title-input"
            />
          </label>
        </div>

        <div className="command-selects">
          <label className="compact-field">
            <span>Board</span>
            <select
              value={selectedFqbn}
              onChange={(e) => setSelectedFqbn(e.target.value)}
              aria-label="Board"
              className="board-select"
            >
              <option value="esp32:esp32:esp32">ESP32 Dev Module</option>

              {boardOptions}
            </select>
          </label>

          <label className="compact-field compact-field-port">
            <span>Port</span>
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
          </label>
        </div>

        <div className="command-status">
          <span className="status-pill status-pill-info">
            Board {selectedBoardName}
          </span>
          <span className="status-pill status-pill-info">Port {selectedPort}</span>
        </div>

        <div className="command-actions">
          <button onClick={refreshBoards}>Refresh</button>

          <button className="primary-action" onClick={compileCode}>
            Compile
          </button>

          <select
            value={uploadMode}
            onChange={(e) => setUploadMode(e.target.value)}
            aria-label="Upload mode"
            className="upload-mode-select"
          >
            <option value="usb">USB</option>
            <option value="ota">OTA</option>
          </select>

          {uploadMode === "ota" && (
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
            </>
          )}

          <button
            className="primary-action"
            onClick={uploadMode === "usb" ? uploadCode : uploadOtaCode}
          >
            {uploadMode === "usb" ? "Upload" : "Upload OTA"}
          </button>
        </div>
      </header>

      <main className="ide-main">
        <aside className="left-sidebar glass-panel">
          <input
            ref={fileInputRef}
            type="file"
            accept=".ino,.cpp,.c,.h,.hpp,.txt"
            className="hidden-input"
            onChange={importFile}
          />

          <section className="sidebar-section">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Project</p>
                <h2>Actions</h2>
              </div>
            </div>

            <div className="action-grid">
              <button onClick={newProject}>New</button>
              <button onClick={saveProject}>Save</button>
              <button onClick={exportCurrentFile}>Export .ino</button>
              <button onClick={() => fileInputRef.current?.click()}>
                Import .ino
              </button>
            </div>

            <select
              value={selectedProject}
              onChange={(e) => openProject(e.target.value)}
              aria-label="Open saved project"
            >
              <option value="">Open Saved Project</option>
              {savedProjectOptions}
            </select>

            <button className="danger-action" onClick={deleteProject}>
              Delete Project
            </button>
          </section>

          <section className="sidebar-section sidebar-section-fill">
            <div className="section-heading">
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
                  className={
                    activeFile === file.name ? "file-tab active" : "file-tab"
                  }
                >
                  <span>{file.name}</span>
                </button>
              ))}
            </div>

            <div className="button-row">
              <button onClick={addFile}>Add File</button>
              <button className="danger-action" onClick={deleteFile}>
                Delete File
              </button>
            </div>
          </section>
        </aside>

        <section className="editor-workspace glass-panel">
          <div className="editor-header">
            <div>
              <p className="eyebrow">Active File</p>
              <h2>{activeFile}</h2>
            </div>

            <span className="status-pill status-pill-muted">
              {files.length} file{files.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="editor-frame">
            <CodeEditor
              fileName={activeFile}
              code={currentCode}
              onChange={updateCurrentFile}
            />
          </div>
        </section>

        <aside className="right-sidebar glass-panel">
          <div className="right-tabs">
            {rightTabs.map((tab) => (
              <button
                key={tab.id}
                className={activeRightTab === tab.id ? "active" : ""}
                onClick={() => setActiveRightTab(tab.id)}
                aria-pressed={activeRightTab === tab.id}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="right-content">
            {activeRightTab === "assistant" && (
              <div className="tool-stack">
                <section className="tool-section assistant-section">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Assistant</p>
                      <h2>Project Generator</h2>
                    </div>

                    <span
                      className={
                        aiStep === "Ready"
                          ? "status-pill status-pill-success"
                          : aiIsGenerating
                          ? "status-pill status-pill-info"
                          : "status-pill status-pill-muted"
                      }
                    >
                      {aiStep || "Idle"}
                    </span>
                  </div>

                  <textarea
                    value={aiPrompt}
                    onChange={(event) => setAiPrompt(event.target.value)}
                    placeholder="Create ESP32 code for DHT11 and OLED"
                    aria-label="AI project prompt"
                    className="assistant-input"
                  />

                  <button
                    className="primary-action"
                    onClick={generateAiProject}
                    disabled={aiIsGenerating}
                  >
                    Generate Project
                  </button>

                  <div className="ai-step-list" aria-live="polite">
                    {AI_STEPS.map((step) => {
                      const currentIndex = AI_STEPS.indexOf(aiStep);
                      const stepIndex = AI_STEPS.indexOf(step);
                      const isDone = currentIndex >= stepIndex && currentIndex >= 0;
                      const isActive = aiStep === step;

                      return (
                        <span
                          key={step}
                          className={[
                            "ai-step",
                            isDone ? "done" : "",
                            isActive ? "active" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          {step}
                        </span>
                      );
                    })}
                  </div>

                  {aiGeneratedWiring.length > 0 && (
                    <div className="ai-result-block">
                      <h3>Wiring</h3>

                      <div className="wiring-table">
                        <div>Module</div>
                        <div>Pin</div>
                        <div>Board</div>
                        <div>Note</div>

                        {aiGeneratedWiring.map((wire, index) => (
                          <Fragment key={`${wire.module}-${wire.boardPin}-${index}`}>
                            <span>{wire.module}</span>
                            <span>{wire.modulePin}</span>
                            <strong>{wire.boardPin}</strong>
                            <span>{wire.note}</span>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  )}

                  {aiWarnings.length > 0 && (
                    <div className="ai-result-block">
                      <h3>Warnings</h3>

                      <ul className="ai-warning-list">
                        {aiWarnings.map((warning, index) => (
                          <li key={`${warning}-${index}`}>{warning}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {aiExplanation && (
                    <div className="assistant-feed">
                      <div className="assistant-message">{aiExplanation}</div>
                    </div>
                  )}
                </section>
              </div>
            )}

            {activeRightTab === "board" && (
              <div className="tool-stack">
                <section className="tool-section">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Selected</p>
                      <h2>Board Info</h2>
                    </div>
                  </div>

                  <dl className="meta-list">
                    <div>
                      <dt>Board</dt>
                      <dd>{selectedFqbn}</dd>
                    </div>
                    <div>
                      <dt>Port</dt>
                      <dd>{selectedPort}</dd>
                    </div>
                  </dl>
                </section>

                <section className="tool-section">
                  <div className="button-row">
                    <button onClick={refreshBoards}>Refresh Ports</button>
                    <button onClick={refreshBoardList}>Refresh Boards</button>
                    <button onClick={refreshCores}>Refresh Cores</button>
                  </div>

                  <div className="button-row">
                    <button onClick={updateCoreIndex}>Update Index</button>
                    <button onClick={() => updateCore()}>Update All</button>
                  </div>
                </section>

                <section className="tool-section">
                  <div className="search-row">
                    <input
                      value={coreSearchQuery}
                      onChange={(e) => setCoreSearchQuery(e.target.value)}
                      placeholder="Search core, example: esp8266"
                    />

                    <button onClick={searchCores}>Search</button>
                  </div>

                  <div className="search-row">
                    <input
                      value={coreToInstall}
                      onChange={(e) => setCoreToInstall(e.target.value)}
                      placeholder="example: arduino:avr"
                    />

                    <button onClick={() => installCore()}>Install</button>
                  </div>
                </section>

                <section className="tool-section">
                  <h3>Core Results</h3>

                  <div className="result-list">
                    {coreSearchResults.map((core, index) => {
                      const coreId = getCoreInstallId(core);

                      return (
                        <div className="result-item" key={`${coreId}-${index}`}>
                          <strong>{coreId}</strong>{" "}
                          {core.version && `v${core.version}`}
                          <small>{core.name}</small>

                          <button onClick={() => installCore(coreId)}>
                            Install
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="tool-section">
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
                            <button onClick={() => updateCore(coreId)}>
                              Update
                            </button>
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
                </section>
              </div>
            )}

            {activeRightTab === "libraries" && (
              <div className="tool-stack">
                <section className="tool-section">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Arduino CLI</p>
                      <h2>Libraries</h2>
                    </div>
                  </div>

                  <div className="button-row">
                    <button onClick={refreshLibraries}>Refresh</button>
                    <button onClick={() => updateLibrary()}>Update All</button>
                  </div>

                  <div className="search-row">
                    <input
                      value={librarySearchQuery}
                      onChange={(e) => setLibrarySearchQuery(e.target.value)}
                      placeholder="Search library, example: wifi"
                    />

                    <button onClick={searchLibraries}>Search</button>
                  </div>
                </section>

                <section className="tool-section">
                  <h3>Search Results</h3>

                  <div className="result-list">
                    {librarySearchResults.map((lib, index) => (
                      <div className="result-item" key={`${lib.name}-${index}`}>
                        <strong>
                          {lib.name} {lib.version && `v${lib.version}`}
                        </strong>
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
                            <button
                              onClick={() => insertInclude(lib.includes[0])}
                            >
                              Insert Include
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="tool-section">
                  <h3>Installed Libraries</h3>

                  <ul className="installed-list">
                    {installedLibraries.map((lib, index) => (
                      <li key={`${lib.name}-${index}`}>
                        <span>
                          {lib.name} {lib.version && `v${lib.version}`}
                        </span>

                        <div>
                          <button onClick={() => updateLibrary(lib.name)}>
                            Update
                          </button>
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
                </section>
              </div>
            )}

            {activeRightTab === "wiring" && (
              <div className="tool-stack">
                <section className="tool-section">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Circuit</p>
                      <h2>Wiring</h2>
                    </div>
                  </div>

                  <div className="wiring-grid">
                    <span>Board</span>
                    <strong>{selectedBoardName}</strong>
                    <span>Port</span>
                    <strong>{selectedPort}</strong>
                    <span>Sketch</span>
                    <strong>{activeFile}</strong>
                  </div>

                  {aiGeneratedWiring.length > 0 && (
                    <div className="wiring-table">
                      <div>Module</div>
                      <div>Pin</div>
                      <div>Board</div>
                      <div>Note</div>

                      {aiGeneratedWiring.map((wire, index) => (
                        <Fragment key={`${wire.module}-${wire.boardPin}-${index}`}>
                          <span>{wire.module}</span>
                          <span>{wire.modulePin}</span>
                          <strong>{wire.boardPin}</strong>
                          <span>{wire.note}</span>
                        </Fragment>
                      ))}
                    </div>
                  )}

                  <textarea
                    placeholder="Wiring notes"
                    aria-label="Wiring notes"
                    className="wiring-notes"
                  />
                </section>
              </div>
            )}
          </div>
        </aside>

        <div
          className="resize-handle resize-handle-left"
          onPointerDown={(event) => startPanelResize("left", event)}
          role="separator"
          aria-label="Resize project sidebar"
        />

        <div
          className="resize-handle resize-handle-right"
          onPointerDown={(event) => startPanelResize("right", event)}
          role="separator"
          aria-label="Resize tools sidebar"
        />
      </main>

      <section className="bottom-dock glass-panel">
        <div
          className="dock-resize-handle"
          onPointerDown={(event) => startPanelResize("dock", event)}
          role="separator"
          aria-label="Resize bottom panel"
        />

        <div className="dock-tabs">
          {dockTabs.map((tab) => (
            <button
              key={tab.id}
              className={activeDockTab === tab.id ? "active" : ""}
              onClick={() => setActiveDockTab(tab.id)}
              aria-pressed={activeDockTab === tab.id}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="dock-body">
          <div
            className={
              activeDockTab === "output"
                ? "dock-pane active"
                : "dock-pane dock-pane-hidden"
            }
          >
            <pre className="console-output dock-output">{output}</pre>
          </div>

          <div
            className={
              activeDockTab === "serial" || activeDockTab === "plotter"
                ? "dock-pane active"
                : "dock-pane dock-pane-hidden"
            }
          >
            <SerialConsole
              selectedPort={selectedPort}
              activeView={activeDockTab === "plotter" ? "plotter" : "serial"}
            />
          </div>

          <div
            className={
              activeDockTab === "logs"
                ? "dock-pane active"
                : "dock-pane dock-pane-hidden"
            }
          >
            <div className="log-grid">
              <section>
                <h3>Compiler</h3>
                <pre className="console-output mini-output">{output}</pre>
              </section>

              <section>
                <h3>Board Manager</h3>
                <pre className="console-output mini-output">{coreOutput}</pre>
              </section>

              <section>
                <h3>Library Manager</h3>
                <pre className="console-output mini-output">{libraryOutput}</pre>
              </section>
            </div>
          </div>
        </div>
      </section>

      {activeResizePanel && (
        <div
          className={[
            "resize-capture-layer",
            activeResizePanel === "dock"
              ? "resize-capture-layer-dock"
              : "resize-capture-layer-columns",
          ].join(" ")}
          aria-hidden="true"
          onPointerMove={(event) =>
            applyPanelResize(event.clientX, event.clientY)
          }
          onPointerUp={stopPanelResize}
          onPointerCancel={stopPanelResize}
        />
      )}

      {showAiUploadModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="upload-modal">
            <h2>Project is ready. Upload now?</h2>

            <div className="modal-actions">
              <button className="primary-action" onClick={uploadAiProjectUsb}>
                Upload USB
              </button>
              <button onClick={uploadAiProjectOta}>Upload OTA</button>
              <button
                className="danger-action"
                onClick={() => setShowAiUploadModal(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
