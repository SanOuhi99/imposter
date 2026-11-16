import express, { type Express } from "express";
import cors from "cors";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const serverBundleDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendDirectory = path.resolve(
  serverBundleDirectory,
  "../../imposter-game/dist/public",
);
if (process.env.SERVE_FRONTEND === "true" && existsSync(frontendDirectory)) {
  app.use(express.static(frontendDirectory));
  app.get("/{*splat}", (req, res, next) => {
    if (req.path === "/api" || req.path.startsWith("/api/") || req.path.startsWith("/socket.io/")) {
      next();
      return;
    }
    res.sendFile(path.join(frontendDirectory, "index.html"));
  });
}

export default app;
