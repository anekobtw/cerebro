import Fastify from "fastify";

import { config } from "./config.js";

const server = Fastify({ logger: true });

server.get("/health", async () => ({ version: "0.0.0" }));

await server.listen({ host: config.HOST, port: config.PORT });
