import { useState, useEffect, useRef } from "react";
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

function App() {
  const [installedCores, setInstalledCores] = useState([]);
  const [coreToInstall, setCoreToInstall] = useState("arduino:avr");
  const [coreOutput, setCoreOutput] = useState("");

  const [availableBoards, setAvailableBoards] = useState([]);
  const [output, setOutput] = useState("");
  const [serialData, setSerialData] = useState("");
  const [isSerialConnected, setIsSerialConnected] = useState(false);

  const [ports, setPorts] = useState([]);
  const [selectedPort, setSelectedPort] = useState("/dev/ttyUSB0");
  const [selectedFqbn, setSelectedFqbn] = useState("esp32:esp32:esp32");

  const [plotLabels, setPlotLabels] = useState([]);
  const [plotValues, setPlotValues] = useState([]);

  const [projectName, setProjectName] = useState("Untitled");
  const [savedProjects, setSavedProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState("");

  const [installedLibraries, setInstalledLibraries] = useState([]);
  const [librarySearchQuery, setLibrarySearchQuery] = useState("wifi");
  const [librarySearchResults, setLibrarySearchResults] = useState([]);
  const [libraryOutput, setLibraryOutput] = useState("");

  const [files, setFiles] = useState(() => {
    const autosaved = localStorage.getItem(AUTOSAVE_KEY);
    return autosaved ? JSON.parse(autosaved) : DEFAULT_FILES;
  });

  const [activeFile, setActiveFile] = useState(() => {
    const autosaved = localStorage.getItem(AUTOSAVE_KEY);
    const loaded = autosaved ? JSON.parse(autosaved) : DEFAULT_FILES;
    return loaded[0]?.name || "tempSketch.ino";
  });

  const wsRef = useRef(null);
  const pointCounterRef = useRef(0);
  const fileInputRef = useRef(null);

  const currentFile =
    files.find((file) => file.name === activeFile) || files[0];

  const currentCode = currentFile?.content || "";

  useEffect(() => {
    refreshLibraries();
    loadProjectList();
    refreshBoards();
    refreshBoardList();
    refreshCores();

    const ws = new WebSocket("ws://localhost:5000");
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const message = event.data;

      if (message.includes("[Serial connected")) {
        setIsSerialConnected(true);
        return;
      }

      if (
        message.includes("[Serial closed]") ||
        message.includes("[Serial Error]")
      ) {
        setIsSerialConnected(false);
        return;
      }

      if (message.includes("[WebSocket")) return;
      if (message.includes("[Serial already running")) return;

      setSerialData((prev) => prev + message);
      handlePlotData(message);
    };

    ws.onerror = () => {};

    ws.onclose = () => {
      setIsSerialConnected(false);
    };

    return () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(files));
  }, [files]);

  const updateCurrentFile = (content) => {
    setFiles((prev) =>
      prev.map((file) =>
        file.name === activeFile ? { ...file, content: content || "" } : file
      )
    );
  };

  const addFile = () => {
    const name = prompt("Enter file name, example: wifi.cpp or config.h");

    if (!name) return;

    if (name.endsWith(".ino")) {
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
    const raw = localStorage.getItem(PROJECTS_KEY);
    const projects = raw ? JSON.parse(raw) : {};
    setSavedProjects(Object.keys(projects));
  };

  const getProjects = () => {
    const raw = localStorage.getItem(PROJECTS_KEY);
    return raw ? JSON.parse(raw) : {};
  };

  const saveProject = () => {
    const name = projectName.trim();

    if (!name) {
      setOutput("Project name cannot be empty.");
      return;
    }

    const projects = getProjects();

    projects[name] = {
      files,
      activeFile,
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

    if (project.files) {
      setFiles(project.files);
      setActiveFile(project.activeFile || project.files[0]?.name);
    } else if (project.code) {
      setFiles([{ name: "tempSketch.ino", content: project.code }]);
      setActiveFile("tempSketch.ino");
    }

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
    setFiles(DEFAULT_FILES);
    setActiveFile("tempSketch.ino");
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
      const importedCode = reader.result;
      const importedName = file.name;

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
      setOutput(`Imported ${importedName}`);
    };

    reader.readAsText(file);
    event.target.value = "";
  };

  const handlePlotData = (message) => {
    const lines = message.split(/\r?\n/);

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (trimmed === "") return;

      const value = Number(trimmed);
      if (!Number.isFinite(value)) return;

      pointCounterRef.current += 1;

      setPlotLabels((prev) => {
        const updated = [...prev, pointCounterRef.current.toString()];
        return updated.slice(-50);
      });

      setPlotValues((prev) => {
        const updated = [...prev, value];
        return updated.slice(-50);
      });
    });
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
      setOutput(JSON.stringify(err.response?.data || err.message, null, 2));
    }
  };

  const refreshBoardList = async () => {
    try {
      const res = await axios.get("http://localhost:5000/board-list");
      const boards = Array.isArray(res.data.boards) ? res.data.boards : [];
      setAvailableBoards(boards);
    } catch (err) {
      setOutput(JSON.stringify(err.response?.data || err.message, null, 2));
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
      setLibraryOutput(JSON.stringify(err.response?.data || err.message, null, 2));
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
      setLibraryOutput(JSON.stringify(err.response?.data || err.message, null, 2));
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
      setLibraryOutput(JSON.stringify(err.response?.data || err.message, null, 2));
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
      setCoreOutput(JSON.stringify(err.response?.data || err.message, null, 2));
    }
  };

  const updateCoreIndex = async () => {
    try {
      setCoreOutput("Updating core index...\n");

      const res = await axios.post("http://localhost:5000/cores/update-index");

      setCoreOutput(res.data.output || "Core index updated.");

      refreshBoardList();
      refreshCores();
    } catch (err) {
      setCoreOutput(JSON.stringify(err.response?.data || err.message, null, 2));
    }
  };

  const installCore = async () => {
    try {
      if (!coreToInstall.trim()) {
        setCoreOutput("Enter a core name, example: arduino:avr");
        return;
      }

      setCoreOutput(`Installing ${coreToInstall}...\n`);

      const res = await axios.post("http://localhost:5000/cores/install", {
        core: coreToInstall.trim(),
      });

      setCoreOutput(res.data.output || `Installed ${coreToInstall}`);

      refreshCores();
      refreshBoardList();
    } catch (err) {
      setCoreOutput(JSON.stringify(err.response?.data || err.message, null, 2));
    }
  };

  const getCoreLabel = (core) => {
    return (
      core.id ||
      core.ID ||
      core.platform ||
      core.name ||
      core.package ||
      core.platform_id ||
      JSON.stringify(core)
    );
  };

  const getCoreVersion = (core) => {
    return core.installed || core.version || core.latest_version || "";
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
      setOutput(JSON.stringify(err.response?.data || err.message, null, 2));
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
      setOutput(JSON.stringify(err.response?.data || err.message, null, 2));
    }
  };

  const connectSerial = async () => {
    try {
      await axios.post("http://localhost:5000/serial/start", {
        port: selectedPort,
      });
    } catch (err) {
      setSerialData(
        (prev) =>
          prev +
          "\n[Serial start error] " +
          JSON.stringify(err.response?.data || err.message) +
          "\n"
      );
    }
  };

  const disconnectSerial = async () => {
    try {
      await axios.post("http://localhost:5000/serial/stop");
      setIsSerialConnected(false);
    } catch (err) {
      setSerialData(
        (prev) =>
          prev +
          "\n[Serial stop error] " +
          JSON.stringify(err.response?.data || err.message) +
          "\n"
      );
    }
  };

  const clearSerial = () => {
    setSerialData("");
  };

  const clearPlot = () => {
    setPlotLabels([]);
    setPlotValues([]);
    pointCounterRef.current = 0;
  };

  const getPortAddress = (item) => {
    return item.port?.address || item.address || item.port || "";
  };

  const getPortLabel = (item) => {
    const address = getPortAddress(item);
    const protocol = item.port?.protocol || item.protocol || "serial";

    const boardName =
      item.matching_boards?.[0]?.name ||
      item.boards?.[0]?.name ||
      "Unknown Board";

    return `${address} - ${boardName} (${protocol})`;
  };

  const plotData = {
    labels: plotLabels,
    datasets: [
      {
        label: "Serial Value",
        data: plotValues,
        tension: 0.3,
      },
    ],
  };

  const plotOptions = {
    responsive: true,
    animation: false,
    maintainAspectRatio: false,
  };

  return (
    <div style={{ padding: "20px" }}>
      <h1>Prompt II Edge</h1>

      <div style={{ marginBottom: "15px", padding: "10px", background: "#e9f5ff", border: "1px solid #9bc9ee" }}>
        <h3>Project</h3>

        <input
          ref={fileInputRef}
          type="file"
          accept=".ino,.cpp,.h,.txt"
          style={{ display: "none" }}
          onChange={importFile}
        />

        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="Project name"
          style={{ padding: "5px", width: "220px" }}
        />

        <button onClick={newProject} style={{ marginLeft: "10px" }}>
          New Project
        </button>

        <button onClick={saveProject} style={{ marginLeft: "10px" }}>
          Save Project
        </button>

        <button onClick={exportCurrentFile} style={{ marginLeft: "10px" }}>
          Export Current File
        </button>

        <button onClick={() => fileInputRef.current.click()} style={{ marginLeft: "10px" }}>
          Import File
        </button>

        <select value={selectedProject} onChange={(e) => openProject(e.target.value)} style={{ marginLeft: "10px" }}>
          <option value="">Open Saved Project</option>
          {savedProjects.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <button onClick={deleteProject} style={{ marginLeft: "10px" }}>
          Delete Project
        </button>
      </div>

      <div style={{ marginBottom: "15px", padding: "10px", background: "#f3f3f3", border: "1px solid #ccc" }}>
        <button onClick={refreshBoards}>Refresh Boards</button>

        <button onClick={refreshBoardList} style={{ marginLeft: "10px" }}>
          Refresh Board List
        </button>

        <select value={selectedPort} onChange={(e) => setSelectedPort(e.target.value)} style={{ marginLeft: "10px" }}>
          <option value="/dev/ttyUSB0">/dev/ttyUSB0</option>
          <option value="/dev/ttyUSB1">/dev/ttyUSB1</option>
          <option value="/dev/ttyACM0">/dev/ttyACM0</option>
          <option value="/dev/ttyACM1">/dev/ttyACM1</option>

          {ports.map((item, index) => {
            const address = getPortAddress(item);
            if (!address) return null;

            return (
              <option key={`${address}-${index}`} value={address}>
                {getPortLabel(item)}
              </option>
            );
          })}
        </select>

        <select value={selectedFqbn} onChange={(e) => setSelectedFqbn(e.target.value)} style={{ marginLeft: "10px", maxWidth: "320px" }}>
          <option value="esp32:esp32:esp32">ESP32 Dev Module</option>

          {availableBoards.map((board, index) => (
            <option key={`${board.fqbn}-${index}`} value={board.fqbn}>
              {board.name} - {board.fqbn}
            </option>
          ))}
        </select>

        <div style={{ marginTop: "8px", fontSize: "14px" }}>
          <strong>Selected Port:</strong> {selectedPort}
          <br />
          <strong>Selected Board:</strong> {selectedFqbn}
        </div>
      </div>

      <div
        style={{
          marginBottom: "15px",
          padding: "10px",
          background: "#fff7e6",
          border: "1px solid #f0c36d",
        }}
      >
        <h3>Board Manager</h3>

        <button onClick={refreshCores}>Refresh Installed Cores</button>

        <button onClick={updateCoreIndex} style={{ marginLeft: "10px" }}>
          Update Core Index
        </button>

        <input
          value={coreToInstall}
          onChange={(e) => setCoreToInstall(e.target.value)}
          placeholder="example: arduino:avr"
          style={{ marginLeft: "10px", padding: "5px", width: "220px" }}
        />

        <button onClick={installCore} style={{ marginLeft: "10px" }}>
          Install Core
        </button>

        <div style={{ marginTop: "10px" }}>
          <strong>Installed Cores:</strong>

        <ul
          style={{
            textAlign: "left",
            maxWidth: "600px",
            margin: "10px auto",
          }}
        >
            {installedCores.map((core, index) => (
              <li key={index}>
                {getCoreLabel(core)} {getCoreVersion(core)}
              </li>
            ))}
          </ul>
        </div>

        <pre
          style={{
            background: "#222",
            color: "#fff",
            padding: "10px",
            overflow: "auto",
            maxHeight: "180px",
          }}
        >
          {coreOutput}
        </pre>
      </div>

      <div style={{ display: "flex", gap: "6px", marginBottom: "6px", alignItems: "center" }}>
        {files.map((file) => (
          <button
            key={file.name}
            onClick={() => setActiveFile(file.name)}
            style={{
              padding: "6px 10px",
              background: activeFile === file.name ? "#222" : "#ddd",
              color: activeFile === file.name ? "#fff" : "#000",
              border: "1px solid #999",
            }}
          >
            {file.name}
          </button>
        ))}

        <button onClick={addFile}>+ Add File</button>
        <button onClick={deleteFile}>Delete File</button>
      </div>

      <div
        style={{
          marginBottom: "15px",
          padding: "10px",
          background: "#eefbea",
          border: "1px solid #8dcc80",
        }}
      >
        <h3>Library Manager</h3>

        <button onClick={refreshLibraries}>Refresh Installed Libraries</button>

        <input
          value={librarySearchQuery}
          onChange={(e) => setLibrarySearchQuery(e.target.value)}
          placeholder="Search library, example: wifi"
          style={{ marginLeft: "10px", padding: "5px", width: "240px" }}
        />

        <button onClick={searchLibraries} style={{ marginLeft: "10px" }}>
          Search Libraries
        </button>

        <h4>Search Results</h4>

        <div style={{ maxHeight: "220px", overflow: "auto" }}>
          {librarySearchResults.map((lib, index) => (
            <div
              key={`${lib.name}-${index}`}
              style={{
                padding: "8px",
                marginBottom: "8px",
                background: "#fff",
                border: "1px solid #ccc",
              }}
            >
              <strong>{lib.name}</strong> {lib.version && `v${lib.version}`}
              <br />
              <small>{lib.sentence}</small>
              <br />
              <small>
                {lib.author} | {lib.category}
              </small>
              <br />

              {lib.includes?.length > 0 && (
                <small>Includes: {lib.includes.join(", ")}</small>
              )}

              <br />

              <button onClick={() => installLibrary(lib.name)}>
                Install
              </button>

              {lib.includes?.[0] && (
                <button
                  onClick={() => insertInclude(lib.includes[0])}
                  style={{ marginLeft: "10px" }}
                >
                  Insert Include
                </button>
              )}
            </div>
          ))}
        </div>

        <h4>Installed Libraries</h4>

        <ul style={{ maxHeight: "140px", overflow: "auto" }}>
          {installedLibraries.map((lib, index) => (
            <li key={index}>
              {lib.name} {lib.version && `v${lib.version}`}
            </li>
          ))}
        </ul>

        <pre
          style={{
            background: "#222",
            color: "#fff",
            padding: "10px",
            overflow: "auto",
            maxHeight: "180px",
          }}
        >
          {libraryOutput}
        </pre>
      </div>

      <Editor
        height="500px"
        defaultLanguage="cpp"
        theme="vs-dark"
        value={currentCode}
        onChange={(value) => updateCurrentFile(value || "")}
      />

      <br />

      <button onClick={compileCode}>Compile</button>

      <button onClick={uploadCode} style={{ marginLeft: "10px" }}>
        Upload
      </button>

      <button onClick={connectSerial} style={{ marginLeft: "10px" }}>
        Connect Serial
      </button>

      <button onClick={disconnectSerial} style={{ marginLeft: "10px" }}>
        Disconnect Serial
      </button>

      <button onClick={clearSerial} style={{ marginLeft: "10px" }}>
        Clear Serial
      </button>

      <button onClick={clearPlot} style={{ marginLeft: "10px" }}>
        Clear Plot
      </button>

      <h3>Compiler / Upload Output</h3>

      <pre style={{ background: "#222", color: "#fff", padding: "10px", overflow: "auto", maxHeight: "280px" }}>
        {output}
      </pre>

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
        <Line data={plotData} options={plotOptions} />
      </div>
    </div>
  );
}

export default App;