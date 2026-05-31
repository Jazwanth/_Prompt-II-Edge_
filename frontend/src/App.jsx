import { useState, useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import axios from "axios";

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
} from "chart.js";

import { Line } from "react-chartjs-2";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

const DEFAULT_CODE = `
void setup() {
  Serial.begin(115200);
}

void loop() {
  int value = random(0, 100);
  Serial.println(value);
  delay(500);
}
`;

const PROJECTS_KEY = "webArduinoIDE_projects";
const AUTOSAVE_KEY = "webArduinoIDE_autosave";

function App() {
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

  const wsRef = useRef(null);
  const pointCounterRef = useRef(0);

  const [code, setCode] = useState(() => {
    const autosaved = localStorage.getItem(AUTOSAVE_KEY);
    return autosaved || DEFAULT_CODE;
  });

  useEffect(() => {
    loadProjectList();
    refreshBoards();
    refreshBoardList();

    const ws = new WebSocket("ws://localhost:5000");
    wsRef.current = ws;

    ws.onopen = () => {};

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
    localStorage.setItem(AUTOSAVE_KEY, code);
  }, [code]);

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
      code,
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
    setCode(project.code || DEFAULT_CODE);

    if (project.selectedPort) {
      setSelectedPort(project.selectedPort);
    }

    if (project.selectedFqbn) {
      setSelectedFqbn(project.selectedFqbn);
    }

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
    setCode(DEFAULT_CODE);
    setOutput("New project created.");
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

  const compileCode = async () => {
    try {
      setOutput("Compiling...\n");

      const res = await axios.post("http://localhost:5000/compile", {
        code,
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
        code,
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
    plugins: {
      legend: {
        display: true,
      },
      title: {
        display: false,
      },
    },
    scales: {
      y: {
        beginAtZero: false,
      },
    },
  };

  return (
    <div style={{ padding: "20px" }}>
      <h1>Web Arduino IDE</h1>

      <div
        style={{
          marginBottom: "15px",
          padding: "10px",
          background: "#e9f5ff",
          border: "1px solid #9bc9ee",
        }}
      >
        <h3>Project</h3>

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

        <select
          value={selectedProject}
          onChange={(e) => openProject(e.target.value)}
          style={{ marginLeft: "10px" }}
        >
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

      <div
        style={{
          marginBottom: "15px",
          padding: "10px",
          background: "#f3f3f3",
          border: "1px solid #ccc",
        }}
      >
        <button onClick={refreshBoards}>Refresh Boards</button>

        <button onClick={refreshBoardList} style={{ marginLeft: "10px" }}>
          Refresh Board List
        </button>

        <select
          value={selectedPort}
          onChange={(e) => setSelectedPort(e.target.value)}
          style={{ marginLeft: "10px" }}
        >
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

        <select
          value={selectedFqbn}
          onChange={(e) => setSelectedFqbn(e.target.value)}
          style={{ marginLeft: "10px", maxWidth: "320px" }}
        >
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

      <Editor
        height="500px"
        defaultLanguage="cpp"
        theme="vs-dark"
        value={code}
        onChange={(value) => setCode(value || "")}
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

      <pre
        style={{
          background: "#222",
          color: "#fff",
          padding: "10px",
          overflow: "auto",
          maxHeight: "280px",
        }}
      >
        {output}
      </pre>

      <h3>
        Serial Monitor:{" "}
        <span style={{ color: isSerialConnected ? "green" : "red" }}>
          {isSerialConnected ? "Connected" : "Disconnected"}
        </span>
      </h3>

      <div
        style={{
          background: "#111",
          color: "#00ff00",
          padding: "10px",
          height: "220px",
          overflow: "auto",
          marginTop: "20px",
          border: "1px solid #333",
        }}
      >
        <pre>{serialData}</pre>
      </div>

      <h3>Serial Plotter</h3>

      <div
        style={{
          height: "300px",
          background: "#fff",
          border: "1px solid #ccc",
          padding: "10px",
        }}
      >
        <Line data={plotData} options={plotOptions} />
      </div>
    </div>
  );
}

export default App;