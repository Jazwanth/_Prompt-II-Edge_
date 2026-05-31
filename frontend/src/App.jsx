import { useState, useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import axios from "axios";

function App() {
  const [output, setOutput] = useState("");
  const [serialData, setSerialData] = useState("");
  const [isSerialConnected, setIsSerialConnected] = useState(false);

  const wsRef = useRef(null);

  const [code, setCode] = useState(`
void setup() {
  Serial.begin(115200);
}

void loop() {
  Serial.println("Hello ESP32");
  delay(1000);
}
`);

  useEffect(() => {
    const ws = new WebSocket("ws://localhost:5000");
    wsRef.current = ws;

    ws.onopen = () => {};

    ws.onmessage = (event) => {
  const message = event.data;

  if (message.includes("[Serial connected]")) {
    setIsSerialConnected(true);
    return;
  }

  if (message.includes("[Serial closed]")) {
    setIsSerialConnected(false);
    return;
  }

  if (message.includes("[WebSocket")) {
    return;
  }

  setSerialData((prev) => prev + message);
};

    ws.onerror = () => {};

    ws.onclose = () => {
      setIsSerialConnected(false);
    };

    return () => {
      ws.close();
    };
  }, []);

  const compileCode = async () => {
    try {
      setOutput("Compiling...\n");

      const res = await axios.post("http://localhost:5000/compile", {
        code,
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
      });

      setOutput(res.data.output);
    } catch (err) {
      setOutput(JSON.stringify(err.response?.data || err.message, null, 2));
    }
  };

  const connectSerial = async () => {
    try {
      await axios.post("http://localhost:5000/serial/start");
      setSerialData((prev) => prev + "\n[Starting serial monitor]\n");
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
      setSerialData((prev) => prev + "\n[Stopping serial monitor]\n");
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

  return (
    <div style={{ padding: "20px" }}>
      <h1>Web Arduino IDE</h1>

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
          height: "250px",
          overflow: "auto",
          marginTop: "20px",
          border: "1px solid #333",
        }}
      >
        <pre>{serialData}</pre>
      </div>
    </div>
  );
}

export default App;