const { spawn } = require("child_process");

const doppler = spawn("doppler", ["run", "--", "node", "apps/api/src/backend-server.js"], { env: { ...process.env, PORT: "3004" }, stdio: "inherit" });
const web = spawn("node", ["apps/web/src/server.js"], { env: { ...process.env, PORT: "3002", CLAIMGUARD_API_BASE_URL: "http://127.0.0.1:3004" } });

setTimeout(async () => {
  try {
    const res = await fetch("http://127.0.0.1:3002/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organisationSlug: "bonitas", username: "analyst-alpha", password: "Password123!" })
    });
    console.log("Status:", res.status);
    console.log("Body:", await res.text());
  } catch (err) {
    console.error(err);
  } finally {
    doppler.kill();
    web.kill();
    process.exit(0);
  }
}, 6000);
