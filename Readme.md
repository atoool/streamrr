# WatchParty — Deploy to Render (signaling + static server)

This repository serves the static frontend from `/public` and runs a WebSocket signaling server (used by `watch.html`) on the same service.

## Prerequisites
- GitHub repo containing this project (server.js, package.json, public/)
- Render account (https://render.com)

## Steps to deploy to Render (Web Service)

1. Commit & push your code to GitHub.

2. On Render:
   - Click "New" → "Web Service".
   - Connect your GitHub repo and select the branch.
   - For Environment:
     - Runtime: Node
     - Build Command: (leave blank)
     - Start Command: `npm start`
   - Port: leave default (Render sets `PORT` environment variable).
   - Advanced: Health check URL: `/health`
   - Create service and deploy.

3. After deploy finishes you will get a public HTTPS URL like:
   `https://watchparty-yourname.onrender.com`

4. Use `watch.html`:
   - If you serve frontend from the same Render URL, open:
     `https://watchparty-yourname.onrender.com/watch.html?name=Host&room=myroom&isHost=1`
   - If you serve frontend elsewhere (e.g. Vercel), update `public/watch.html` and set `WS_URL` to `wss://watchparty-yourname.onrender.com`.

## Notes
- Render supports secure websockets (`wss://`) automatically on the HTTPS domain.
- For reliable peer connection across NATs, consider adding a TURN server (coturn or a paid provider).
- To monitor logs: Render dashboard → Logs. To restart: deploy new commit or click restart.

## Local testing
1. `npm install`
2. `npm start`
3. Serve frontend at http://localhost:3000 (server serves `/public` already)
4. Open two windows:
   - Host: `http://localhost:3000/watch.html?name=Host&room=test&isHost=1`
   - Viewer: `http://localhost:3000/watch.html?name=Viewer&room=test`

