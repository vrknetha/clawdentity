import { Hono } from "hono";

type Bindings = { DB: D1Database; ENVIRONMENT: string };
const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) =>
  c.json({ status: "ok", version: "0.0.0", environment: c.env.ENVIRONMENT }),
);

export default app;
