// Capacitor's "webDir" needs a folder it can copy into ios/android as-is.
// There's no bundler in this repo (single-file app, no build step), so this
// script is the entire "build": copy index.html into www/ unchanged. Run via
// `npm run cap:prebuild` (or automatically as part of `npm run cap:sync`).
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const wwwDir = path.join(root, "www");

if (!fs.existsSync(wwwDir)) {
  fs.mkdirSync(wwwDir);
}

fs.copyFileSync(path.join(root, "index.html"), path.join(wwwDir, "index.html"));
console.log("Copied index.html -> www/index.html");
