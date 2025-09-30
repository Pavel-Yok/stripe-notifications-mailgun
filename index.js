import express from "express";
import bodyParser from "body-parser";

const app = express();

// Stripe will later require raw body for signature verification.
// For now, simple JSON parser and a no-op handler are fine.
app.use(express.json());

// Health
app.get("/", (req, res) => res.status(200).send("OK"));

// Placeholder webhook — returns 200 so Stripe accepts the endpoint.
// We will replace this with proper Stripe verification after you add whsec.
app.post("/webhook", bodyParser.raw({ type: "*/*" }), (req, res) => {
  console.log("Webhook hit (placeholder). Bytes:", req.body?.length ?? 0);
  res.status(200).json({ ok: true });
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));
