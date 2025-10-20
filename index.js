// index.js
// Stripe → Amazon SES webhook mailer (multi-brand, multi-locale, metadata-aware)
// Node 18+ (ESM). Deps: express, body-parser, stripe, @aws-sdk/client-sesv2, @google-cloud/storage

import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import {
  SESv2Client,
  SendEmailCommand,
  GetSuppressedDestinationCommand,
} from "@aws-sdk/client-sesv2";
import { Storage } from "@google-cloud/storage";
import { renderEmail } from './src/renderEmail.js';


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
  TEST_TO="you@example.com"                         # override for tests / @example.com recipients
  TEMPLATES_BUCKET="email-templates-yokweb-trueweb" # GCS bucket for templates
  SES_CONFIG_SET="deliverability-prod"              # optional SES Configuration Set name

Notes:
- From addresses use verified SES domains; mailbox for no-reply is not required.
- Reply-To should be a real inbox you monitor.
- SES creds via AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
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
    from:
      process.env.SES_FROM_TRUEWEB ||
      "Trueweb Billing <no-reply@billing.trueweb.pl>",
    replyTo: process.env.SES_REPLY_TO_TRUEWEB || "billing@trueweb.pl",
  },
};

/* ====== GCS template loader (top-level, single instance) ====== */
const TEMPLATES_BUCKET = process.env.TEMPLATES_BUCKET || "";
const storage = new Storage(); // Cloud Run SA provides auth
const tplCache = new Map();

function escapeHtml(val) {
  // minimal, fast escape for HTML injection safety
  return String(val)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Load HTML template from GCS by brand/service/locale
 * Path: gs://<bucket>/<brand>/<service>/<locale>.html
 * Logs errors (without crashing) for easier debugging.
 */
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
  } catch (e) {
    console.warn(`Template load failed for ${key}:`, e?.message || e);
    return null;
  }
}

function renderTemplate(tpl, vars) {
  return tpl.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? escapeHtml(vars[k]) : ""
  );
}
/* ============================================================= */

/* ====== SES helpers ====== */
const sesClients = new Map();
function getSesClient(region) {
  if (!sesClients.has(region)) sesClients.set(region, new SESv2Client({ region }));
  return sesClients.get(region);
}

async function sendWithSES({
  region,
  from,
  replyTo,
  to,
  subject,
  text,
  html,
}) {
  const ses = getSesClient(region);

  const cmd = new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: [to] },
    ReplyToAddresses: replyTo ? [replyTo] : [],
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: html, Charset: "UTF-8" },
          Text: { Data: text || " ", Charset: "UTF-8" }
        }
      }
    },
    // ConfigurationSetName: process.env.SES_CONFIG_SET || undefined
  });

  const resp = await ses.send(cmd);
  console.log("SES MessageId:", resp?.MessageId, "to:", to, "region:", region);
  return resp;
}


/* ---- SES account-level suppression check (centralized) ---- */
async function isSuppressedInSES({ region, email }) {
  try {
    const ses = getSesClient(region);
    const cmd = new GetSuppressedDestinationCommand({ EmailAddress: email });
    const resp = await ses.send(cmd);
    if (resp?.SuppressionAttributes?.Reason) {
      console.warn(
        "SES-suppressed recipient; reason:",
        resp.SuppressionAttributes.Reason,
        "email:",
        email
      );
      return true;
    }
    return false;
  } catch (e) {
    // NotFoundException => not suppressed; anything else => log + allow send
    const code = e?.name || "";
    if (/NotFoundException/i.test(code)) return false;
    console.warn("SES suppression check failed (treating as not suppressed):", code || e?.message || e);
    return false;
  }
}
/* ========================= */

/* ====== Local suppression cache (24h TTL) ====== */
const SUPPRESS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const suppressed = new Map(); // email -> firstSeenTs

function isSuppressed(email) {
  const ts = suppressed.get(email);
  if (!ts) return false;
  if (Date.now() - ts > SUPPRESS_TTL_MS) {
    suppressed.delete(email);
    return false;
  }
  return true;
}
function noteSuppressed(email) {
  suppressed.set(email, Date.now());
}
/* ============================================== */

/* ====== content helpers (fallbacks) ====== */
function formatAmount(inv) {
  const cents = inv.amount_paid ?? inv.amount_due ?? 0;
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
      `Dzień dobry,\r\nOtrzymaliśmy Twoją płatność.\r\n` +
      `Faktura: ${invoiceNo}\r\nKwota: ${amount}\r\n` +
      `Dziękujemy,\r\n${brandLabel}`;
    const html =
      `<p>Dzień dobry,</p><p>Otrzymaliśmy Twoją płatność.</p>` +
      `<p><b>Faktura:</b> ${escapeHtml(invoiceNo)}<br><b>Kwota:</b> ${escapeHtml(amount)}</p>` +
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
    `<p><b>Invoice:</b> ${escapeHtml(invoiceNo)}<br><b>Amount:</b> ${escapeHtml(amount)}</p>` +
    `<p>Thanks,<br>${brandLabel}</p>`;
  return { subject, text, html };
}
/* ======================================== */

/* ====== metadata helpers ====== */
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
  const brand = candBrand || BRAND_DEFAULT; // single source of truth
  const locale = candLocale || "en";
  return { brand, locale };
}
/* ========================= */

/* ====== recipient resolver ====== */
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
/* =============================== */

const app = express();

// RAW body required for Stripe signature verification
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!endpointSecret || !stripeKey) {
      console.error("Missing STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY");
      return res.status(500).send("Server not configured");
    }

    const stripe = new Stripe(stripeKey);
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        endpointSecret
      );
    } catch (err) {
      console.error("Signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("Stripe event:", event.type);

    if (event.type === "invoice.paid") {
      const invBasic = event.data.object;

      // Expand invoice to get lines (price.product) + customer
      let inv,
        customerObj = null,
        lineMeta = null;
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
          product:
            line?.price?.product && typeof line.price.product !== "string"
              ? line.price.product
              : null,
        };
      } catch {
        /* noop */
      }

      // Resolve brand + locale (order: invoice → customer → price/product → defaults)
      const { brand, locale } = resolveBrandLocale({
        inv,
        customer: customerObj,
        lineMeta,
      });

      // Resolve recipient
      let to = resolveRecipient(inv) || customerObj?.email || null;
      if (!to) {
        console.warn("No recipient email found; skipping send.");
        return res.json({ received: true, mailed: false });
      }

      // Skip locally suppressed recipients
      if (isSuppressed(to)) {
        console.warn("Local-suppressed recipient; skipping send:", to);
        return res.json({ received: true, mailed: false, suppressed: true });
      }

      // Choose sender by brand (falls back to default)
      const cfg = BRAND_CFG[brand] || BRAND_CFG[BRAND_DEFAULT];

      // Centralized suppression (SES account-level)
      if (await isSuppressedInSES({ region: cfg.region, email: to })) {
        noteSuppressed(to); // remember locally to avoid re-checks for 24h
        return res.json({ received: true, mailed: false, suppressed: "ses" });
      }

      // Detect service from metadata (invoice → price → product), accept both "service" and "serviceID"
      const service =
        pickMeta(inv, "service") ||
        pickMeta(inv, "serviceid") ||
        pickMeta(lineMeta?.price, "service") ||
        pickMeta(lineMeta?.price, "serviceid") ||
        pickMeta(lineMeta?.product, "service") ||
        pickMeta(lineMeta?.product, "serviceid") ||
        "invoice-paid";

      // NEW: render via central pipeline (GCS templates + brand JSON + central CSS)
console.log("[mail] using NEW renderer");
const invoiceNo = inv.number || inv.id;
// derive currency & amount numeric for templates
const currency = String(inv.currency || "").toUpperCase();
const amountNumber = ((inv.amount_paid ?? inv.amount_due ?? 0) / 100).toFixed(2);

// optional helpers for placeholders
const trackOrder =
  inv.hosted_invoice_url ||
  inv.invoice_pdf ||
  null;

const billing = {
  name: inv.customer_name || customerObj?.name || "",
  address_line1: inv.customer_address?.line1 || "",
  address_line2: inv.customer_address?.line2 || "",
  postcode: inv.customer_address?.postal_code || "",
  city: inv.customer_address?.city || "",
  country: inv.customer_address?.country || "",
  vat_id: (inv.customer_tax_ids && inv.customer_tax_ids[0]?.value) || ""
};

// call renderer — it will normalize legacy ids like 'invoice-paid' -> 'payment-paid'
const { html, text, subject } = await renderEmail({

  brandKey: 'yokweb',   // 'yokweb' | 'trueweb'
  locale,                     // 'en' | 'pl'
  notificationId: service,    // e.g. 'invoice-paid' (legacy ok)
  serviceId: null,            // set if you later use per-product templates
  systemData: {
    customerName: customerObj?.name || customerObj?.email || "Customer",
    invoiceNo,
    amount: amountNumber,
    currency,
    trackOrder,
    purchaseSite: brand === "trueweb" ? "trueweb.pl" : "yokweb.com",
    billing
  }
});


      try {
        await sendWithSES({
          region: cfg.region,
          from: cfg.from,
          replyTo: cfg.replyTo,
          to,
          subject,
          text,
          html,
          brand,
          service,
          locale,
        });
        return res.json({ received: true, mailed: true });
      } catch (err) {
        console.error("SES send failed:", err);
        // If SES says address is on suppression list, remember it locally
        const msg = String(err && (err.message || err.toString() || ""));
        if (/suppression list|suppressed|complaint/i.test(msg)) {
          noteSuppressed(to);
        }
        // acknowledge to avoid Stripe retry storms
        return res.json({ received: true, mailed: false, error: "ses_send_failed" });
      }
    }

    return res.json({ received: true });
  }
);

app.get("/", (_req, res) => res.status(200).send("OK"));
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));
