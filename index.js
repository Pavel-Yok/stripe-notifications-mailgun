// index.js
// Stripe → Amazon SES webhook mailer (multi-brand, multi-region, metadata-aware)
// Node 18+, Express raw body for Stripe signature verification
// package.json should include: "type": "module", and deps: express, body-parser, stripe, @aws-sdk/client-sesv2

import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/* ========= ENV =========
Required:
  STRIPE_SECRET_KEY
  STRIPE_WEBHOOK_SECRET

Optional:
  BRAND_DEFAULT=yokweb
  SES_FROM_YOKWEB="Yokweb Billing <no-reply@billing.yokweb.com>"
  SES_REPLY_TO_YOKWEB="billing@yokweb.com"
  SES_FROM_TRUEWEB="Trueweb Billing <no-reply@billing.trueweb.pl>"
  SES_REPLY_TO_TRUEWEB="billing@trueweb.pl"
  TEST_TO="you@example.com"  // override for tests / example.com recipients

Notes:
- From addresses use verified domains in SES; no mailbox is required for no-reply.
- Reply-To should be a real inbox you monitor.
- SES credentials are provided via env AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (from GCP Secret Manager).
========================= */

const BRAND_DEFAULT = (process.env.BRAND_DEFAULT || "yokweb").toLowerCase();

const BRAND_CFG = {
  yokweb: {
    region: "eu-west-1", // Ireland
    from: process.env.SES_FROM_YOKWEB || "Yokweb Billing <no-reply@billing.yokweb.com>",
    replyTo: process.env.SES_REPLY_TO_YOKWEB || "billing@yokweb.com",
  },
  trueweb: {
    region: "eu-central-1", // Frankfurt
    from: process.env.SES_FROM_TRUEWEB || "Trueweb Billing <no-reply@billing.trueweb.pl>",
    replyTo: process.env.SES_REPLY_TO_TRUEWEB || "billing@trueweb.pl",
  },
};


function renderTemplate(tpl, vars) {
  return tpl.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : ""
  );
}



// Cache SES clients by region
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

function formatAmount(inv) {
  const cents = (inv.amount_paid ?? inv.amount_due ?? 0);
  const amount = cents / 100;
  const cur = String(inv.currency || "").toUpperCase();
  return `${amount.toFixed(2)} ${cur}`;
}

function buildMessage({ brand, inv, locale = "en" }) {
  const amount = formatAmount(inv);
  const invoiceNo = inv.number || inv.id;
  const brandLabel = brand === "trueweb" ? "Trueweb" : "Yokweb";

  if (locale === "pl") {
    const subject = `Płatność otrzymana — ${brandLabel}`;
    const text =
      `Dzień dobry,\r\notrzymaliśmy Twoją płatność.\r\n` +
      `Faktura: ${invoiceNo}\r\nKwota: ${amount}\r\n` +
      `Dziękujemy,\r\n${brandLabel}`;
    const html =
      `<p>Dzień dobry,</p><p>Otrzymaliśmy Twoją płatność.</p>` +
      `<p><b>Faktura:</b> ${invoiceNo}<br><b>Kwota:</b> ${amount}</p>` +
      `<p>Dziękujemy,<br>${brandLabel}</p>`;
    return { subject, text, html };
  }

  // default EN
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

// ------- metadata helpers (inserted after buildMessage and before resolveRecipient) -------
function pickMeta(obj, key) {
  const v = obj?.metadata?.[key];
  return (typeof v === "string" ? v.trim().toLowerCase() : null) || null;
}
function normalizeBrand(v) {
  return v === "trueweb" ? "trueweb" : v === "yokweb" ? "yokweb" : null;
}
function normalizeLocale(v) {
  return v === "pl" ? "pl" : v === "en" ? "en" : null;
}
function resolveBrandLocale({ inv, customer, lineMeta }) {
  const candBrand = normalizeBrand(
    pickMeta(inv, "brand") ||
    pickMeta(customer, "brand") ||
    pickMeta(lineMeta?.price, "brand") ||
    pickMeta(lineMeta?.product, "brand")
  );
  const candLocale = normalizeLocale(
    pickMeta(inv, "locale") ||
    pickMeta(customer, "locale") ||
    pickMeta(lineMeta?.price, "locale") ||
    pickMeta(lineMeta?.product, "locale")
  );
  const brand = candBrand || (process.env.BRAND_DEFAULT || "yokweb");
  const locale = candLocale || "en";
  return { brand, locale };
}
// -----------------------------------------------------------------------------------------

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

  if (event.type === "invoice.paid") {
    const invBasic = event.data.object;

    // Expand invoice to get lines (price.product) + customer
    let inv, customerObj = null, lineMeta = null;
    try {
      inv = await stripe.invoices.retrieve(invBasic.id, {
        expand: ["lines.data.price.product", "customer"],
      });
    } catch (e) {
      console.warn("Could not expand invoice; falling back to payload:", e?.message);
      inv = invBasic;
    }

    // Retrieve customer if needed
    try {
      if (typeof inv.customer === "string") {
        customerObj = await stripe.customers.retrieve(inv.customer);
      } else if (inv.customer?.email || inv.customer?.metadata) {
        customerObj = inv.customer;
      }
    } catch (e) {
      console.warn("Could not retrieve customer:", e?.message);
    }

    // First line price/product metadata (if any)
    try {
      const line = inv?.lines?.data?.[0];
      lineMeta = {
        price: line?.price,
        product: line?.price?.product && typeof line.price.product !== "string" ? line.price.product : null,
      };
    } catch { /* noop */ }

    // Resolve brand + locale (order: invoice → customer → price/product → defaults)
    const { brand, locale } = resolveBrandLocale({ inv, customer: customerObj, lineMeta });

    // Resolve recipient
    let to = resolveRecipient(inv) || customerObj?.email || null;
    if (!to) {
      console.warn("No recipient email found; skipping send.");
      return res.json({ received: true, mailed: false });
    }

// Choose sender by brand
const cfg = BRAND_CFG[brand] || BRAND_CFG[BRAND_DEFAULT];

    import { Storage } from "@google-cloud/storage";

const TEMPLATES_BUCKET = process.env.TEMPLATES_BUCKET || "";
const storage = new Storage(); // uses Cloud Run's service account
const tplCache = new Map();

async function loadTemplate({ brand, service, locale }) {
  if (!TEMPLATES_BUCKET) return null;
  const key = `${brand}/${service}/${locale}.html`;
  if (tplCache.has(key)) return tplCache.get(key);
  try {
    const file = storage.bucket(TEMPLATES_BUCKET).file(key);
    const [buf] = await file.download();
    const html = buf.toString("utf8");
    tplCache.set(key, html);
    return html;
  } catch {
    return null;
  }
}

function renderTemplate(tpl, vars) {
  return tpl.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : ""
  );
}


// Try to load a GCS template for this service/locale
const service = "invoice-paid";
const amount = formatAmount(inv);
const invoiceNo = inv.number || inv.id;

// Fallback subject/text (kept simple)
let subject, text;
if (locale === "pl") {
  subject = `Płatność otrzymana — ${brand === "trueweb" ? "Trueweb" : "Yokweb"}`;
  text =
    `Dzień dobry,\r\nOtrzymaliśmy Twoją płatność.\r\n` +
    `Faktura: ${invoiceNo}\r\nKwota: ${amount}\r\n` +
    `Dziękujemy,\r\n${brand === "trueweb" ? "Trueweb" : "Yokweb"}`;
} else {
  subject = `Payment received — ${brand === "trueweb" ? "Trueweb" : "Yokweb"}`;
  text =
    `Hi,\r\nWe've received your payment.\r\n` +
    `Invoice: ${invoiceNo}\r\nAmount: ${amount}\r\n` +
    `Thanks,\r\n${brand === "trueweb" ? "Trueweb" : "Yokweb"}`;
}

// Load template with fallback: exact locale → EN → built-in
let html =
  (await loadTemplate({ brand, service, locale })) ||
  (await loadTemplate({ brand, service, locale: "en" }));
if (!html) {
  html = buildMessage({ brand, inv, locale }).html;
} else {
  html = renderTemplate(html, { invoiceNo, amount });
}

try {
  await sendWithSES({
    region: cfg.region,
    from: cfg.from,
    replyTo: cfg.replyTo,
    to,
    subject,
    text,
    html,
  });
} catch (err) {
  console.error("SES send failed:", err);
  return res.json({ received: true, mailed: false, error: "ses_send_failed" });
}
