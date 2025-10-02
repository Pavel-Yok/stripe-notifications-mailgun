// index.js
// Stripe → SES webhook mailer (multi-brand, multi-region)
// Node 18+, Express raw body for Stripe signature verification
// Package.json: { "type": "module", "dependencies": { "express": "...", "body-parser": "...", "stripe": "...", "@aws-sdk/client-sesv2": "..." } }

import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/* ========= ENV =========
Required (runtime / Cloud Run secrets):
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET

Optional (sane defaults provided):
  BRAND_DEFAULT=yokweb
  SES_FROM_YOKWEB="Yokweb Billing <no-reply@billing.yokweb.com>"
  SES_REPLY_TO_YOKWEB="billing@yokweb.com"
  SES_FROM_TRUEWEB="Trueweb Billing <no-reply@billing.trueweb.pl>"
  SES_REPLY_TO_TRUEWEB="billing@trueweb.pl"
  TEST_TO="you@example.com"   // routes test/safe emails
Notes:
- From addresses use verified domains; no mailbox needed for "no-reply".
- Reply-To should be a real inbox you monitor.
========================= */

const BRAND_DEFAULT = (process.env.BRAND_DEFAULT || "yokweb").toLowerCase();

const BRAND_CFG = {
  yokweb: {
    region: "eu-west-1",
    from: process.env.SES_FROM_YOKWEB || "Yokweb Billing <no-reply@billing.yokweb.com>",
    replyTo: process.env.SES_REPLY_TO_YOKWEB || "billing@yokweb.com",
  },
  trueweb: {
    region: "eu-central-1",
    from: process.env.SES_FROM_TRUEWEB || "Trueweb Billing <no-reply@billing.trueweb.pl>",
    replyTo: process.env.SES_REPLY_TO_TRUEWEB || "billing@trueweb.pl",
  },
};

// Lazily create an SES client per region and cache it.
const sesClients = new Map();
function getSesClient(region) {
  if (!sesClients.has(region)) sesClients.set(region, new SESv2Client({ region }));
  return sesClients.get(region);
}

async function sendWithSES({ region, from, replyTo, to, subject, text, html }) {
  const ses = getSesClient(region);
  const cmd = new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    ReplyToAddresses: replyTo ? [replyTo] : [],
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Html: html ? { Data: html, Charset: "UTF-8" } : undefined,
          Text: text ? { Data: text, Charset: "UTF-8" } : undefined,
        },
      },
    },
  });
  const resp = await ses.send(cmd);
  console.log("SES MessageId:", resp?.MessageId, "to:", to, "region:", region);
  return resp;
}

// Determine brand for template/sender routing.
// Priority: invoice.metadata.brand → price/product metadata (optional later) → default.
function resolveBrand(inv) {
  const m = (inv?.metadata?.brand || "").toLowerCase().trim();
  if (m === "yokweb" || m === "trueweb") return m;
  return BRAND_DEFAULT; // fallback
}

function formatAmount(inv) {
  const amount = (inv.amount_paid ?? inv.amount_due ?? 0) / 100;
  const cur = String(inv.currency || "").toUpperCase();
  return `${amount.toFixed(2)} ${cur}`;
}

// Build minimal EN content; you can expand to PL later via templates.
function buildMessage({ brand, inv }) {
  const amount = formatAmount(inv);
  const invoiceNo = inv.number || inv.id;
  const brandLabel = brand === "trueweb" ? "Trueweb" : "Yokweb";

  const subject = `Payment received — ${brandLabel}`;
  const text =
    `Hi,\r\nWe've received your payment.\r\n` +
    `Invoice: ${invoiceNo}\r\nAmount: ${amount}\r\n` +
    `Thanks,\r\n${brandLabel}`;
  const html =
    `<p>Hi,</p><p>We've received your payment.</p>` +
    `<p><b>Invoice:</b> ${invoiceNo}<br><b>Amount:</b> ${amount}</p>` +
    `<p>Thanks,<br>${brandLabel}</p>`;

  return { subject, text, html };
}

// Resolve recipient with a TEST override
function resolveRecipient(inv) {
  const invEmail = inv.customer_email || inv.account_email || null;
  const testTo = process.env.TEST_TO;
  let to = invEmail;

  if (testTo && (!to || /@example\.com$/i.test(to))) {
    console.log("TEST_TO override active:", testTo, "(original:", to, ")");
    to = testTo;
  }
  return to;
}

// Express app + Stripe webhook
const app = express();

// RAW body required for Stripe signature verification
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!endpointSecret || !stripeKey) {
    console.error("Missing STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY");
    return res.status(500).send("Server not configured");
  }

  const stripe = new Stripe(stripeKey);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], endpointSecret);
  } catch (err) {
    console.error("Signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("Stripe event:", event.type);

  // Handle successful payment
  if (event.type === "invoice.paid") {
    const inv = event.data.object;

    // Try to hydrate customer to find email if needed
    let customerObj = null;
    try {
      if (typeof inv.customer === "string") {
        customerObj = await stripe.customers.retrieve(inv.customer);
      } else if (inv.customer?.email) {
        customerObj = inv.customer;
      }
    } catch (e) {
      console.warn("Could not retrieve customer:", e?.message);
    }

    let to = resolveRecipient(inv) || customerObj?.email || null;
    if (!to) {
      console.warn("No recipient email found; skipping send.");
      return res.json({ received: true, mailed: false });
    }

    const brand = resolveBrand(inv);
    const { region, from, replyTo } = BRAND_CFG[brand] || BRAND_CFG[BRAND_DEFAULT];
    const { subject, text, html } = buildMessage({ brand, inv });

    try {
      await sendWithSES({ region, from, replyTo, to, subject, text, html });
    } catch (err) {
      console.error("SES send failed:", err);
      // Still acknowledge webhook to avoid Stripe retries storming your endpoint
      return res.json({ received: true, mailed: false, error: "ses_send_failed" });
    }
  }

  return res.json({ received: true });
});

app.get("/", (_req, res) => res.status(200).send("OK"));
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));
