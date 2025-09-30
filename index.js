import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";

const app = express();

function resolveRecipient(inv, customerObj) {
  const invEmail = inv.customer_email || inv.account_email;
  const custEmail = customerObj && customerObj.email;
  let to = invEmail || custEmail || null;

  const testTo = process.env.TEST_TO;
  if (testTo && (!to || /@example\.com$/i.test(to))) {
    console.log("TEST override: routing mail to TEST_TO:", testTo, " (original to:", to, ")");
    to = testTo;
  } else {
    console.log("Resolved recipient:", to);
  }
  return to;
}

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

  console.log("Stripe event:", event.type);

  try {
    if (event.type === "invoice.paid") {
      const inv = event.data.object;
      let customerObj = null;

      try {
        if (typeof inv.customer === "string") {
          customerObj = await stripe.customers.retrieve(inv.customer);
        } else if (inv.customer && inv.customer.email) {
          customerObj = inv.customer;
        }
      } catch (e) {
        console.warn("Could not retrieve customer:", e?.message);
      }

      const to = resolveRecipient(inv, customerObj);
      if (!to) {
        console.warn("No recipient email found; skipping send.");
        return res.json({ received: true, mailed: false });
      }

      // --- Mailgun direct HTTP (UTF-8 safe) ---
      const domain = process.env.MAILGUN_DOMAIN; // e.g., billing.yokweb.com
      const apiBase = process.env.MAILGUN_API_URL || "https://api.eu.mailgun.net";
      const apiKey  = process.env.MAILGUN_EU_API_KEY;

      const amount = (inv.amount_paid / 100).toFixed(2) + " " + String(inv.currency || "").toUpperCase();
      const subject = "Payment received - Yokweb"; // ASCII
      const text = [
        "Hi,",
        "We've received your payment.",
        `Invoice: ${inv.number || inv.id}`,
        `Amount: ${amount}`,
        "Thanks,",
        "Yokweb"
      ].join("\r\n");
      const html = `
        <p>Hi,</p>
        <p>We've received your payment.</p>
        <p><b>Invoice:</b> ${inv.number || inv.id}<br>
        <b>Amount:</b> ${amount}</p>
        <p>Thanks,<br>Yokweb</p>
      `;

      const params = new URLSearchParams();
      params.append("from", "Yokweb Billing <no-reply@billing.yokweb.com>");
      params.append("to", to);
      params.append("subject", subject);
      params.append("text", text);
      params.append("html", html);
      params.append("h:Reply-To", "billing@yokweb.com");
      params.append("o:tracking", "false");

      const auth = Buffer.from(`api:${apiKey}`, "utf8").toString("base64");
      const resp = await fetch(`${apiBase}/v3/${domain}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      });

      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Mailgun HTTP ${resp.status}: ${body}`);
      } else {
        const body = await resp.text();
        console.log("Mailgun queued:", body);
      }
      // --- end Mailgun HTTP ---
    }
  } catch (e) {
    console.error("Handler error:", e);
  }

  return res.json({ received: true });
});

app.get("/", (_req, res) => res.status(200).send("OK"));
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));
