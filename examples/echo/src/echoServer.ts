import { WebSocketServer } from "ws";

const port = Number(process.env.PORT ?? 9001);
const wss = new WebSocketServer({ port, host: "0.0.0.0" });

wss.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary }));
});

console.log(`echo on ws://0.0.0.0:${port}`);
