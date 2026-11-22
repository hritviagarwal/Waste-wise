# WasteWise

AI-powered food waste routing. Users describe leftovers; the app asks follow-ups if needed and recommends: sell, donate, compost, or biogas.

## Run locally
    npm install
    ANTHROPIC_API_KEY=your_key npm start     # open http://localhost:3000
Without a key the app runs in basic rule-based mode.

## Deploy on Render
1. Push this folder to a GitHub repo.
2. On render.com: New > Web Service > connect the repo. (Or New > Blueprint to use render.yaml.)
3. Build command: `npm install`  |  Start command: `npm start`
4. Add environment variable `ANTHROPIC_API_KEY` (from console.anthropic.com).
5. Deploy. Free instances sleep after inactivity, so the first load can take ~30s.

## Accounts, marketplace and pickups
Data (users, listings, pickups) is saved to `data.json`. On Render's free plan this file is erased on every restart or redeploy. For real use, add a Render Disk and set `DATA_DIR` to its mount path, or move to a database.
`partners.json` holds NGO and scrap-dealer listings. The entries are samples: replace them with real partners (name, city, address, phone, hours).
