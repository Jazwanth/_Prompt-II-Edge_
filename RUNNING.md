# Prompt II Edge: How To Run

This submitted project folder is already configured with the required backend settings, including the Gemini API key in `backend/.env`.

Please do not upload or share `backend/.env` publicly.

## Run

Open a terminal inside this project folder and run:

```bash
bash run-public.sh
```

The script will automatically prepare the project, start the backend, create a Cloudflare public link, and open the website in the browser.

The terminal will show one URL, for example:

```txt
https://example-words.trycloudflare.com
```

If the browser does not open automatically, copy that URL and open it manually.

## Important

Keep the terminal open while using the IDE.

To stop the project, press:

```txt
Ctrl+C
```

## First Run Note

The first run can take a few minutes because the script may automatically install missing project tools locally, including Node packages, `cloudflared`, `arduino-cli`, and ESP32 board support.

## Arduino Upload

For USB upload or Serial Monitor, connect the Arduino/ESP32 board to the same machine running the script.

If upload fails on Linux due to permission issues, reconnect the board or run with a user account that has serial port access.
