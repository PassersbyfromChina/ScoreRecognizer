// 局域网协作服务：电脑端开一个 HTTP 服务，手机扫码打开网页拍照，照片实时传回电脑。
// 手机页面使用 <input type="file" capture="environment"> 调起系统相机，不依赖 HTTPS / getUserMedia。
const http = require("node:http");
const os = require("node:os");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_UPLOAD = 30 * 1024 * 1024;
const DEFAULT_PORT = 47830;

function createLanServer({ userDataDir, onPhoto, log = console.log }) {
  const inbox = path.join(userDataDir, "lan-inbox");
  fs.mkdirSync(inbox, { recursive: true });

  let server = null;
  let token = crypto.randomBytes(9).toString("hex");
  let port = null;
  let pageHtml = "";
  try {
    pageHtml = fs.readFileSync(path.join(__dirname, "mobile", "index.html"), "utf8");
  } catch (e) {
    pageHtml = "<h1>手机拍照页缺失</h1>";
  }

  const decodeName = (value) => {
    const base = String(value || "photo.jpg").replace(/[\\/:*?"<>|]/g, "_").slice(-120);
    return base.length ? base : "photo.jpg";
  };

  function lanUrls() {
    const out = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const addr of addrs || []) {
        if (addr.family === "IPv4" && !addr.internal) {
          const ip = addr.address;
          out.push({
            name,
            ip,
            url: `http://${ip}:${port}/?t=${token}`,
          });
        }
      }
    }
    return out;
  }

  function info() {
    return {
      running: Boolean(server),
      port,
      token,
      urls: server ? lanUrls() : [],
      reachable: Boolean(server) && lanUrls().length > 0,
    };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_UPLOAD) {
          reject(new Error("图片太大"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const given = url.searchParams.get("t") || "";
    const authed = given && given === token;

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      if (!authed) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>链接已失效</h1><p>请在电脑上重新打开扫码页面。</p>");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(pageHtml);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "ScoreRecognizer" }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/upload") {
      if (!authed) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "token" }));
        return;
      }
      try {
        const buffer = await readBody(req);
        if (!buffer || buffer.length < 100) throw new Error("empty");
        const id = crypto.randomBytes(6).toString("hex");
        const original = decodeName(url.searchParams.get("name"));
        const ext = (path.extname(original) || ".jpg").toLowerCase();
        const filename = `phone_${Date.now()}_${id}${ext}`;
        fs.writeFileSync(path.join(inbox, filename), buffer);
        try {
          onPhoto({ id, filename, data: buffer });
        } catch (e) {
          log("onPhoto error", e);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, id }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }

  async function start(preferredPort = DEFAULT_PORT) {
    if (server) return info();
    token = crypto.randomBytes(9).toString("hex");
    server = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        try {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("error");
        } catch {
          /* ignore */
        }
        log("lan server error", e);
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", (err) => {
        server = null;
        reject(err);
      });
      server.listen(preferredPort, "0.0.0.0", () => resolve());
    });
    port = server.address().port;
    return info();
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve(info());
      const s = server;
      server = null;
      port = null;
      s.close(() => resolve(info()));
      setTimeout(() => resolve(info()), 800);
    });
  }

  return { start, stop, info };
}

module.exports = { createLanServer };
