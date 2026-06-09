# Prompt II Edge: How To Run

This submitted project folder is already configured with the required backend settings, including the Gemini API key in `backend/.env`.

Please do not upload or share `backend/.env` publicly.

## Run

Open a terminal inside this project folder and run:

```bash
bash run-public.sh
```

The script will automatically prepare the project, start the backend, create a Cloudflare public link when possible, and open the website in the browser.

The terminal will show one URL, for example:

```txt
https://example-words.trycloudflare.com
```

If the browser does not open automatically, copy that URL and open it manually.

If Cloudflare quick-tunnel DNS is slow or blocked on the network, the script will automatically fall back to the local website URL:

```txt
http://localhost:5000
```

That local URL is enough when the project is being used on the same machine.

Use `http://localhost:5000` in the browser. `127.0.0.1` points to the same machine, but browsers save zoom and layout separately for those two addresses.

## Stable Cloudflare URL

The free quick URL from Cloudflare changes every time because it is a temporary quick tunnel.

For one fixed URL, create a named Cloudflare Tunnel once. Use `prompt2edge` as the tunnel name.

1. Open Cloudflare dashboard.
2. Go to Zero Trust / Networks / Tunnels.
3. Create a Cloudflare Tunnel named `prompt2edge`.
4. Add a public hostname, for example `prompt2edge.yourdomain.com`.
5. Set the service URL to:

```txt
http://127.0.0.1:5000
```

6. Copy the tunnel token from Cloudflare.
7. Add these two lines to `backend/.env`:

```txt
CLOUDFLARED_TUNNEL_TOKEN=paste_the_cloudflare_tunnel_token_here
PUBLIC_URL=https://prompt2edge.yourdomain.com
```

After that, run the same command:

```bash
bash run-public.sh
```

The script will use the configured stable URL instead of creating a random quick URL.

`prompt2edge` alone is a project/tunnel name, not a full public domain. For a browser URL, use either a Cloudflare Pages URL such as `https://prompt2edge.pages.dev` for the static frontend, or a tunnel hostname such as `https://prompt2edge.yourdomain.com` for the full local IDE with backend, USB, Serial, Gemini, compile, and upload support.

## Cloudflare Static Frontend

The included `wrangler.jsonc` uses the Cloudflare project name `prompt2edge` and deploys the built frontend from `frontend/dist`.

This static Cloudflare deployment is only the browser UI. Full Arduino compile, upload, Serial Monitor, Gemini, and board access still require the local backend from `bash run-public.sh`, because those features use local files, `arduino-cli`, and USB/serial ports.

## Important

Keep the terminal open while using the IDE.

To stop the project, press:

```txt
Ctrl+C
```

## First Run Note

The first run can take a few minutes because the script may automatically install missing project tools locally, including Node packages, `cloudflared`, `arduino-cli`, and ESP32 board support.

If it pauses at `Preparing Arduino CLI`, leave it running. ESP32 board support is large and may take several minutes on the first run.

To force more Cloudflare public URL retries, run:

```bash
TUNNEL_ATTEMPTS=5 TUNNEL_WAIT_SECONDS=240 bash run-public.sh
```

## Arduino Upload

For USB upload or Serial Monitor, connect the Arduino/ESP32 board to the same machine running the script.

If upload fails on Linux due to permission issues, reconnect the board or run with a user account that has serial port access.
