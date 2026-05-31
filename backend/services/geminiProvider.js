import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

export async function generateArduinoProject({ prompt, fqbn, files = [] }) {
  const systemPrompt = `
You are an Arduino AI project generator inside a web Arduino IDE.

Return ONLY valid JSON. No markdown. No explanation outside JSON.

JSON schema:
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

Rules:
- Generate complete Arduino code.
- Use installable Arduino library names.
- Choose safe pins for the selected board.
- For ESP32 avoid GPIO 0, 2, 12, 15 unless necessary.
- Do not upload.
- Do not include markdown fences.
`;

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
    contents: `${systemPrompt}

User prompt:
${prompt}

Board FQBN:
${fqbn}

Existing files:
${JSON.stringify(files)}
`,
    config: {
      responseMimeType: "application/json",
    },
  });

  return JSON.parse(response.text);
}