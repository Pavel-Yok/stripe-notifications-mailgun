import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";

const app = express();

// Stripe requires the raw body for signature verification
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!endpointSecret || !stripeKey) {
    console.error("Missing STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY");
    return res.status(500).send("Server not configured");
  }

  const stripe = new Stripe(stripeKey);

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("Signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // For now, just log the event type. We'll add Mailgun next.
  console.log("Stripe event:", event.type);
  return res.json({ received: true });
});

// Simple health endpoint
app.get("/", (_req, res) => res.status(200).send("OK"));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));
