import { createServer } from "http";
import { readFileSync, existsSync } from "fs";
import { extname, join } from "path";

const PORT = 3333;
const ROOT = ".";

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".json": "application/json",
  ".css": "text/css",
};

createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const url = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(ROOT, url);

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = extname(filePath);
  const mime = MIME[ext] || "application/octet-stream";
  const content = readFileSync(filePath);

  res.writeHead(200, { "Content-Type": mime });
  res.end(content);
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
