// index.js
import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import Mailgun from "mailgun.js";
import formData from "form-data";
import Handlebars from "handlebars";
import {Storage} from "@google-cloud/storage";

const app = express();

// -------- Config: brands → Mailgun domain + headers --------
const BRANDS = {
  yokweb: {
    domain: "billing.yokweb.com",
    from: "Yokweb Billing <no-reply@billing.yokweb.com>",
    replyTo: "billing@yokweb.com",
  },
  trueweb: {
    domain: "billing.trueweb.pl",
    from: "Trueweb Billing <no-reply@billing.trueweb.pl>",
    replyTo: "platnosci@trueweb.pl",
  },
};

// Defaults & Env
const DEFAULT_BRAND  = process.env.DEFAULT_BRAND  || "yokweb";
const DEFAULT_LOCALE = process.env.DEFAULT_LOCALE || "en";
const FORCE_BRAND    = process.env.FORCE_BRAND || "";   // for testing only
const FORCE_LOCALE   = process.env.FORCE_LOCALE || "";  // for testing only
const TEST_TO        = process.env.TEST_TO || "";       // route all mail here when set

// GCS templates bucket
const TPL_BUCKET = process.env.TPL_BUCKET || "yokweb-mail-templates";
const storage = new Storage();
const bucket = storage.bucket(TPL_BUCKET);

// cache compiled templates (in-memory)
const tplCache = new Map(); // key => { compiled, ts }
const TPL_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadTemplate(eventType, brand, locale, part /* 'subject'|'html'|'txt' */) {
  const ext = (part === "html") ? "html.hbs" : (part === "txt" ? "txt.hbs" : "subject.hbs");
  const key = `templates/${brand}/${locale}/${eventType}.${ext}`;
  const cacheKey = `${key}`;
  const now = Date.now();
  const cached = tplCache.get(cacheKey);
  if (cached && (now - cached.ts) < TPL_TTL_MS) return cached.compiled;

  const file = bucket.file(key);
  const [buf] = await file.download();           // throws if not found
  const src = buf.toString("utf8");
  const compiled = Handlebars.compile(src, { noEscape: true });
  tplCache.set(cacheKey, { compiled, ts: now });
  return compiled;
}

// ---- helper: safe amount/currency
function formatAmountMinor(minor, currency) {
  const v = (Number(minor || 0) / 100).toFixed(2);
  return `${v} ${String(currency || "").toUpperCase()}`;
}

// ---- resolve recipient
function resolveRecipient(inv, customerObj) {
  let to = inv.customer_email || inv.account_email || (customerObj && customerObj.email) || null;
  if (TEST_TO) {
    console.log("TEST override: routing to TEST_TO:", TEST_TO, "(original to:", to, ")");
    return TEST_TO;
  }
  console.log("Resolved recipient:", to);
  return to;
}

// ---- resolve brand/locale
async function resolveBrandAndLocale(stripe, invoice) {
  // Force for testing
  if (FORCE_BRAND || FORCE_LOCALE) {
    return {
      brand: FORCE_BRAND || DEFAULT_BRAND,
      locale: FORCE_LOCALE || DEFAULT_LOCALE,
      source: "forced",
    };
  }

  // Try invoice line item product metadata
  try {
    const lines = invoice?.lines?.data || [];
    // Grab first product id on the invoice
    const firstWithProduct = lines.find(l => l.price?.product);
    const productId = firstWithProduct?.price?.product;
    if (typeof productId === "string") {
      const product = await stripe.products.retrieve(productId);
      const brand  = (product.metadata?.brand || "").toLowerCase();
      const locale = (product.metadata?.locale || "").toLowerCase();
      if (brand && locale) return { brand, locale, source: "product.metadata" };
      if (brand)          return { brand, locale: DEFAULT_LOCALE, source: "product.metadata-partial" };
      if (locale)         return { brand: DEFAULT_BRAND, locale, source: "product.metadata-partial" };
    }
  } catch (e) {
    console.warn("resolveBrandAndLocale: product metadata lookup failed:", e?.message);
  }

  // Fallback to defaults
  return { brand: DEFAULT_BRAND, locale: DEFAULT_LOCALE, source: "default" };
}

// ---- per-event data shaping for templates
function buildTemplateData({ invoice, customer }) {
  const amount = formatAmountMinor(invoice.amount_paid ?? invoice.amount_due, invoice.currency);
  const data = {
    name: customer?.name || customer?.email || "there",
    email: customer?.email || invoice.customer_email || "",
    invoiceNumber: invoice.number || invoice.id,
    amount,
    currency: String(invoice.currency || "").toUpperCase(),
    hostedInvoiceUrl: invoice.hosted_invoice_url || "",
    status: invoice.status || "",
  };
  return data;
}

// ---- webhook endpoint
app.post("/webhook", bodyParser.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!endpointSecret || !stripeKey) {
    console.error("Missing STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY");
    return res.status(500).send("Server not configured");
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2024-06-20" });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error("Signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("Stripe event:", event.type);

  // Only handle a subset. Add more types as needed.
  const handled = new Set([
    "invoice.paid",
    "invoice.payment_failed",
    "invoice.finalized",
    "customer.subscription.trial_will_end",
  ]);

  if (!handled.has(event.type)) {
    return res.json({ received: true, skipped: event.type });
  }

  try {
    const inv = event.data.object;
    // Try to fetch customer (may fail on test fixtures; it's OK)
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

    const { brand, locale, source } = await resolveBrandAndLocale(stripe, inv);
    console.log(`Using brand=${brand}, locale=${locale} (source=${source})`);

    const brandCfg = BRANDS[brand] || BRANDS[DEFAULT_BRAND];

    // compile templates
    const data = buildTemplateData({ invoice: inv, customer: customerObj });
    const eventKey = event.type; // e.g., 'invoice.paid'

    // subject
    let subject;
    try {
      const subjectTpl = await loadTemplate(eventKey, brand, locale, "subject");
      subject = subjectTpl(data).replace(/\r?\n/g, " ").trim();
    } catch (_) {
      subject = `Notification — ${brand}`; // fallback
    }

    // txt
    let text;
    try {
      const txtTpl = await loadTemplate(eventKey, brand, locale, "txt");
      text = txtTpl(data).replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"); // normalize CRLF for SMTP
    } catch (_) {
      text = [
        `Hi ${data.name},`,
        `We've processed your event: ${eventKey}.`,
        `Invoice: ${data.invoiceNumber}`,
        `Amount: ${data.amount}`,
        `Thanks,`,
        brand === "trueweb" ? "Trueweb" : "Yokweb",
      ].join("\r\n");
    }

    // html
    let html;
    try {
      const htmlTpl = await loadTemplate(eventKey, brand, locale, "html");
      html = htmlTpl(data);
    } catch (_) {
      html = text.replace(/\r\n/g, "<br>"); // fallback
    }

    // Mailgun client
    const mg = new Mailgun(formData).client({
      username: "api",
      key: process.env.MAILGUN_EU_API_KEY,
      url: process.env.MAILGUN_API_URL || "https://api.eu.mailgun.net",
    });

    console.log(`Sending (${brand}/${locale}) → ${to} via ${brandCfg.domain}`);
    const resp = await mg.messages.create(brandCfg.domain, {
      from: brandCfg.from,
      to,
      subject,
      text,
      html,
      "h:Reply-To": brandCfg.replyTo,
      "o:tracking": "false",
      "o:dkim": "yes",
    });

    console.log("Mailgun queued id:", resp?.id || resp);
  } catch (e) {
    console.error("Handler error:", e);
    // Don’t fail the webhook — Stripe will retry. We already logged the error.
  }

  return res.json({ received: true });
});

app.get("/", (_req, res) => res.status(200).send("OK"));
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on", port));
