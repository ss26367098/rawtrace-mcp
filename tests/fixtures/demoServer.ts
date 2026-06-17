import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";

export interface DemoServer {
  url: string;
  close(): Promise<void>;
}

export async function startDemoServer(): Promise<DemoServer> {
  const server = createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(demoHtml());
      return;
    }

    if (req.url === "/second") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><title>RawTrace Second Page</title></head><body><h1>Second Page</h1><a id="back-home" href="/">Home</a></body></html>`);
      return;
    }

    if (req.url === "/api/delayed") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, marker: "delayed-response" }));
      }, 40);
      return;
    }

    if (req.url === "/api/response-body") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, marker: "response-body-marker", token: "RAW_RESPONSE_BODY_TOKEN" }));
      return;
    }

    if (req.url === "/api/large-response") {
      const body = "rawtrace-large-response:".concat("x".repeat(70_000));
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": Buffer.byteLength(body, "utf8")
      });
      res.end(body);
      return;
    }

    if (req.url === "/download/report.txt") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": "attachment; filename=\"rawtrace-report.txt\""
      });
      res.end("rawtrace download payload");
      return;
    }

    if (req.url === "/api/search" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        setTimeout(() => {
          res.writeHead(200, {
            "content-type": "application/json",
            "set-cookie": "rawtrace_demo=session-refresh; HttpOnly; Path=/; SameSite=Lax"
          });
          res.end(JSON.stringify({ rows: ["alpha", "beta", "gamma"], received: Buffer.concat(chunks).toString("utf8") }));
        }, 30);
      });
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (socket) => {
    socket.on("message", (message) => {
      socket.send(`echo:${message.toString()}`);
    });
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.url === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
      return;
    }
    socket.destroy();
  });

  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to get demo server address.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function demoHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>RawTrace Demo</title>
  <style>
    .loading { opacity: 0.7; }
    #hover-target.hovered { color: green; }
    #spacer { height: 1200px; }
  </style>
</head>
<body>
  <h1 aria-label="RawTrace Demo Heading">RawTrace Demo</h1>
  <input id="query" value="">
  <input id="space-placeholder" placeholder="First  name" value="">
  <select id="choice" aria-label="Choice">
    <option value="">Choose</option>
    <option value="alpha">Alpha</option>
    <option value="beta">Beta</option>
  </select>
  <section id="form-container">
    <form id="profile-form" aria-label="Profile Form">
      <label for="profile-name">Profile Name</label>
      <input id="profile-name" name="profileName" value="">
      <label for="profile-notes">Profile Notes</label>
      <textarea id="profile-notes" name="profileNotes"></textarea>
      <label for="profile-tier">Profile Tier</label>
      <select id="profile-tier" name="profileTier">
        <option value="free">Free</option>
        <option value="pro">Pro</option>
      </select>
      <label><input id="profile-enabled" name="profileEnabled" type="checkbox"> Enabled</label>
      <input id="upload-file" name="uploadFile" type="file">
      <button id="profile-submit" type="submit">Save Profile</button>
    </form>
  </section>
  <label><input id="agree" type="checkbox"> Agree</label>
  <button id="submit" type="button">Submit</button>
  <button id="dialog-button" type="button">Dialog</button>
  <button id="delayed-button" type="button">Delayed API</button>
  <button id="response-body-button" type="button">Response Body API</button>
  <button id="large-response-button" type="button">Large Response API</button>
  <button id="geolocation-button" type="button">Read Location</button>
  <a id="download-link" href="/download/report.txt" download>Download Report</a>
  <button data-test="data-test-action" type="button">Data Test Action</button>
  <button id="aria-disabled-action" type="button" aria-disabled="true">Disabled Action</button>
  <a id="second-link" href="/second">Second</a>
  <a id="popup-link" href="/second" target="_blank">Popup</a>
  <div id="hover-target" role="button" tabindex="0">Hover Target</div>
  <section id="selector-lab" aria-label="Selector Lab">
    <div data-testid="selector-first-card">
      <h3>Selector First</h3>
      <button type="button" class="rounded bg-blue-600 px-2">Duplicate Action</button>
    </div>
    <div>
      <h3>Selector Target</h3>
      <button id="base-ui-_r_dynamic" type="button" class="rounded bg-blue-600 px-2">Duplicate Action</button>
    </div>
  </section>
  <section id="checkin-selector-lab" aria-label="Checkin Selector Lab">
    <h3>每日签到</h3>
    <button type="button">立即签到</button>
  </section>
  <div id="status">idle</div>
  <ul id="results"></ul>
  <div id="spacer">scroll area</div>
  <button id="bottom-button" type="button">Bottom</button>
  <script>
    const input = document.querySelector("#query");
    const button = document.querySelector("#submit");
    const status = document.querySelector("#status");
    const results = document.querySelector("#results");
    document.querySelector("#choice").addEventListener("change", (event) => {
      status.textContent = "choice:" + event.target.value;
    });
    document.querySelector("#agree").addEventListener("change", (event) => {
      status.textContent = "agree:" + event.target.checked;
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") status.textContent = "pressed-enter";
    });
    document.querySelector("#hover-target").addEventListener("mouseenter", (event) => {
      event.currentTarget.classList.add("hovered");
      status.textContent = "hovered";
    });
    document.querySelector("#dialog-button").addEventListener("click", () => {
      alert("rawtrace demo dialog");
    });
    document.querySelector("#delayed-button").addEventListener("click", async () => {
      const response = await fetch("/api/delayed");
      const data = await response.json();
      status.textContent = data.marker;
    });
    document.querySelector("#response-body-button").addEventListener("click", async () => {
      const response = await fetch("/api/response-body");
      const data = await response.json();
      status.textContent = data.marker;
    });
    document.querySelector("#large-response-button").addEventListener("click", async () => {
      const response = await fetch("/api/large-response");
      const text = await response.text();
      status.textContent = "large:" + text.length;
    });
    document.querySelector("#geolocation-button").addEventListener("click", () => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          status.textContent = "geo:" + position.coords.latitude.toFixed(3) + "," + position.coords.longitude.toFixed(3);
        },
        (error) => {
          status.textContent = "geo-error:" + error.code;
        }
      );
    });
    document.querySelector("#profile-form").addEventListener("submit", (event) => {
      event.preventDefault();
      status.textContent =
        "profile:" +
        document.querySelector("#profile-name").value +
        ":" +
        document.querySelector("#profile-tier").value +
        ":" +
        document.querySelector("#profile-enabled").checked;
    });
    button.addEventListener("click", async () => {
      button.classList.add("loading");
      status.textContent = "loading";
      const transient = document.createElement("div");
      transient.id = "transient";
      transient.textContent = "short lived";
      document.body.appendChild(transient);
      setTimeout(() => transient.remove(), 50);
      const loading = document.createElement("div");
      loading.id = "loading-node";
      loading.textContent = "loading node";
      document.body.appendChild(loading);
      const ws = new WebSocket("ws://" + location.host + "/ws");
      ws.addEventListener("open", () => ws.send("clicked"));
      ws.addEventListener("message", (event) => {
        status.textContent = event.data;
      });
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: document.querySelector("#query").value, csrf: "raw-csrf-demo" })
      });
      const data = await response.json();
      results.innerHTML = "";
      for (const row of data.rows) {
        const li = document.createElement("li");
        li.className = "row";
        li.textContent = row;
        results.appendChild(li);
      }
      loading.remove();
      button.classList.remove("loading");
    });
  </script>
</body>
</html>`;
}
