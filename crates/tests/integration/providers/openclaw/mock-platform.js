const fs = require("fs");
const http = require("http");

const port = Number(process.env.RUNTIME_PORT || "3001");
const hookPath = process.env.RUNTIME_HOOK_PATH || "/hooks/agent";
const logPath = process.env.PLATFORM_LOG_PATH || "/var/log/mock-platform-openclaw.jsonl";

function appendEvent(event) {
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", provider: "openclaw-mock" }));
    return;
  }

  if (req.method === "POST" && req.url === hookPath) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      appendEvent({
        at: new Date().toISOString(),
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
    });
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`openclaw mock platform listening on ${port} ${hookPath}`);
});
