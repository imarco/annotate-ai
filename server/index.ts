import { createApp } from "./app";

const port = Number(process.env.PORT || "18767");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

if (import.meta.main) {
  const app = createApp();
  Bun.serve({
    hostname: process.env.ANNOTATE_HOST || "0.0.0.0",
    port,
    fetch: app.fetch,
  });
  console.log(`annotate-ai comment service listening on ${port}`);
}
