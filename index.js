import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import Mailgun from "mailgun.js";
import formData from "form-data";

const app = express();

// Helper: pick recipient
function resolveRecipient(inv, customerObj) {
  // Prefer invoice.customer_email, then customer.email
  const invEmail = inv.customer_email || inv.account_email; // sometimes present
  const custEmail = customerObj && customerObj.email;
  let to = invEmail || custEmail || null;

  // TEST override: if env TEST_TO is set, or if to ends with example.com, send to TEST_TO
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

      const mg = new Mailgun(formData).client({
        username: "api",
        key: process.env.MAILGUN_EU_API_KEY,
        url: process.env.MAILGUN_API_URL || "https://api.eu.mailgun.net",
      });

      const domain = process.env.MAILGUN_DOMAIN; // billing.yokweb.com
      const amount = (inv.amount_paid / 100).toFixed(2) + " " + String(inv.currency || "").toUpperCase();
      const subject = "Payment received - Yokweb";

      const text = [
        `Hi,`,
        `We've received your payment.`,
        `Invoice: ${inv.number || inv.id}`,
        `Amount: ${amount}`,
        `Thanks,`,
        `Yokweb`,
      ].join("\r\n");

      const html = `
        <p>Hi,</p>
        <p>We've received your payment.</p>
        <p><b>Invoice:</b> ${inv.number || inv.id}<br>
        <b>Amount:</b> ${amount}</p>
        <p>Thanks,<br>Yokweb</p>
      `;

      console.log("Sending Mailgun message to:", to);
      const resp = await mg.messages.create(domain, {
        from: "Yokweb Billing <no-reply@billing.yokweb.com>",
        to,
        subject,
        text,
        html,
        "h:Reply-To": "billing@yokweb.com",
        "o:tracking": "false",
      });
      console.log("Mailgun queued id:", resp?.id || resp);
    }
  } catch (e) {
    console.error("Handler error:", e);
  }

  return res.json({ received: true });
});

app.get("/", (_req, res) => res.status(200).send("OK"));
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));

