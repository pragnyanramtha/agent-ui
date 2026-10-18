#!/usr/bin/env node
/* Local stand-in for the tunnel: one port that sends /pty (HTTP and WebSocket) to the terminal
 * backend and everything else to the app, so the web terminal works under `pnpm dev`.
 * DEV_PROXY_PORT (3310) -> app 3311, /pty -> PTY_PORT (3312). */
import http from "node:http";
import net from "node:net";

const port = Number(process.env.DEV_PROXY_PORT ?? 3310);
const app = 3311;
const pty = Number(process.env.PTY_PORT ?? 3312);
const target = (url = "") => (/^\/pty(\/|\?|$)/.test(url) ? pty : app);

const server = http.createServer((req, res) => {
  const up = http.request({ host: "127.0.0.1", port: target(req.url), path: req.url, method: req.method, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const up = net.connect(target(req.url), "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((x) => `${k}: ${x}`))];
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const end = () => {
    up.destroy();
    socket.destroy();
  };
  up.on("error", end);
  socket.on("error", end);
});

server.listen(port, "127.0.0.1", () => console.log(`dev proxy on http://127.0.0.1:${port} (app ${app}, /pty ${pty})`));
