# Bitcoin Rainbow App

Static dashboard (`bitcoin-rainbow.html`) plus a Vercel serverless proxy
(`api/onchain-metrics.js`) that holds your ChartInspect API key server-side
and serves processed Sharpe / Cost-Basis P/L z-scores to the page.

## Deploy (no local Node.js required)

1. Push this folder to a new GitHub repo:
   ```
   cd bitcoin-rainbow-app
   git init
   git add .
   git commit -m "Initial commit"
   ```
   Create an empty repo on github.com, then:
   ```
   git remote add origin <your-new-repo-url>
   git branch -M main
   git push -u origin main
   ```
2. Go to https://vercel.com, sign in, click **Add New... > Project**, and import that GitHub repo.
3. Before the first deploy (or right after, under Project Settings > Environment Variables), add:
   - Name: `CHARTINSPECT_API_KEY`
   - Value: your rotated ChartInspect API key
   - Environment: Production (and Preview if you want PR previews to work too)
4. Deploy. Vercel will serve `bitcoin-rainbow.html` as a static file and
   `api/onchain-metrics.js` as a serverless function automatically -- no
   `vercel.json` needed for this simple layout.
5. Open the deployed URL. The page auto-loads live BTC price data on open,
   then calls `/api/onchain-metrics` (same-origin, so no CORS issues) for
   the Sharpe/Cost-Basis indicators. If that call ever fails, the page
   silently falls back to a live price-derived approximation instead of
   breaking.

## Alternative: Vercel CLI (if you install Node.js)

```
npm install -g vercel
vercel login
vercel            # deploy from this folder
vercel env add CHARTINSPECT_API_KEY production
vercel --prod
```

## Notes

- The API key never appears in `bitcoin-rainbow.html` or in git history --
  it only exists as a Vercel environment variable, read via
  `process.env.CHARTINSPECT_API_KEY` inside `api/onchain-metrics.js`.
- The proxy caches its ChartInspect response for 1 hour (`Cache-Control:
  s-maxage=3600`), so traffic to your app doesn't translate 1:1 into calls
  against your ChartInspect rate limit.
- Sharpe and Cost-Basis P/L indicators are OFF by default in the UI (toggle
  them on in the "Indicators" card); the price valuation (Asymmetric Tail
  Curvature) indicator is on by default and does not depend on the proxy.
