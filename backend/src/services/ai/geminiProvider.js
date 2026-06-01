const { GoogleGenAI } = require("@google/genai");

const DEFAULT_MODEL = "gemini-2.5-flash";

const PROJECT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  propertyOrdering: [
    "projectName",
    "libraries",
    "files",
    "wiring",
    "explanation",
    "warnings",
  ],
  required: [
    "projectName",
    "libraries",
    "files",
    "wiring",
    "explanation",
    "warnings",
  ],
  properties: {
    projectName: { type: "string" },
    libraries: {
      type: "array",
      items: { type: "string" },
    },
    files: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "content"],
        properties: {
          name: { type: "string" },
          content: { type: "string" },
        },
      },
    },
    wiring: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["module", "modulePin", "boardPin", "note"],
        properties: {
          module: { type: "string" },
          modulePin: { type: "string" },
          boardPin: { type: "string" },
          note: { type: "string" },
        },
      },
    },
    explanation: { type: "string" },
    warnings: {
      type: "array",
      items: { type: "string" },
    },
  },
};

const SYSTEM_PROMPT = `You are an Arduino project generator inside a web Arduino IDE.
Return only valid JSON.
Generate safe Arduino code.
Use common Arduino library names that arduino-cli can install.
Choose safe default pins for the selected board.
For ESP32, avoid flash pins and boot-sensitive pins when possible.
Never suggest unsafe voltage wiring.
Never upload code.
Always include libraries, files, wiring, explanation, and warnings.

Return exactly this JSON schema:
{
  "projectName": "string",
  "libraries": ["string"],
  "files": [
    {
      "name": "string",
      "content": "string"
    }
  ],
  "wiring": [
    {
      "module": "string",
      "modulePin": "string",
      "boardPin": "string",
      "note": "string"
    }
  ],
  "explanation": "string",
  "warnings": ["string"]
}

Do not include markdown fences, prose before JSON, prose after JSON, comments outside code, or trailing commas.
Use tempSketch.ino for the main Arduino sketch file.
If helper files are useful, use .h, .hpp, .c, or .cpp files only.
Do not list board-core built-in headers such as Wire, SPI, WiFi, EEPROM, or ArduinoOTA as installable libraries.
Prefer robust serial logging and clear pin constants in generated code.`;

function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured on the backend.");
  }

  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });
}

function getResponseText(response) {
  if (!response) return "";

  if (typeof response.text === "function") {
    return response.text();
  }

  return response.text || "";
}

function parseStrictJson(text) {
  const trimmed = String(text || "").trim();

  if (!trimmed) {
    throw new Error("Gemini returned an empty response.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const withoutFence = trimmed
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    if (withoutFence !== trimmed) {
      return JSON.parse(withoutFence);
    }

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }

    throw new Error("Gemini response was not valid JSON.");
  }
}

async function requestProjectJson({ prompt, fqbn, projectName, files, repairContext }) {
  const ai = getClient();
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const existingFiles = Array.isArray(files) ? files : [];

  const repairBlock = repairContext
    ? `
The previous generated project failed to compile. Repair it in one attempt.
Return the full corrected project JSON, not a patch.

Compile error:
${repairContext.compileError || ""}

Previous project JSON:
${JSON.stringify(repairContext.project || {}, null, 2)}
`
    : "";

  const response = await ai.models.generateContent({
    model,
    contents: `User prompt:
${prompt}

Selected board FQBN:
${fqbn}

Requested project name:
${projectName || ""}

Current sketch files, if any:
${JSON.stringify(existingFiles, null, 2)}
${repairBlock}`,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseJsonSchema: PROJECT_JSON_SCHEMA,
      temperature: repairContext ? 0.2 : 0.35,
    },
  });

  return parseStrictJson(getResponseText(response));
}

async function generateArduinoProject(options) {
  return requestProjectJson(options);
}

async function repairArduinoProject(options) {
  return requestProjectJson(options);
}

module.exports = {
  generateArduinoProject,
  repairArduinoProject,
};
