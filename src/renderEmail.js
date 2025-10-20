import fetch from 'node-fetch';
import juice from 'juice';
import { readGcsText } from './utils/gcs.js';
import { replacePlaceholders } from './utils/templating.js';

const TEMPLATES_BUCKET = process.env.TEMPLATES_BUCKET; // e.g., gs://yokweb-billing-001-email-templates
const ASSETS_BUCKET    = process.env.ASSETS_BUCKET;    // e.g., gs://yokweb-billing-001-email-assets

const LEGACY_TO_NEW = {
  "invoice-paid": "payment-paid",
  "subscription-renewed": "payment-paid-sub-renew",
  // unchanged:
  "payment-failed": "payment-failed",
  "refund-issued": "refund-issued"
};
const normalizeNotificationId = (id) => LEGACY_TO_NEW[id] || id;

async function loadBrand(brandKey) {
  const bucket = process.env.ASSETS_BUCKET || "";
  if (!bucket) {
    throw new Error("ASSETS_BUCKET env not set");
  }
  if (!brandKey) {
    throw new Error("brandKey is empty");
  }
  const path = `brands/${brandKey}.json`;
  console.log("[dbg] loadBrand:", { bucket, path });

  // readGcsText(bucketName, filePath) — we pass NAME ONLY + relative path
  const jsonText = await readGcsText(bucket, path);
  // strip BOM if present
  const clean = jsonText.replace(/^\uFEFF/, "");
  return JSON.parse(clean);
}


async function loadTemplate({ brand, notificationId, serviceId, locale }) {
  const tryPaths = [
    `${TEMPLATES_BUCKET}/${brand}/${notificationId}/${locale}.html`,
    `${TEMPLATES_BUCKET}/${brand}/${notificationId}/en.html`,
    `${TEMPLATES_BUCKET}/${brand}/services/${serviceId}/${locale}.html`,
    `${TEMPLATES_BUCKET}/${brand}/services/${serviceId}/en.html`
  ];
  for (const p of tryPaths) {
    try {
      return await readGcsText(p);
    } catch {
      // try next
    }
  }
  return `<!doctype html><html><body><p>Fallback: ${notificationId} (${locale})</p></body></html>`;
}

async function loadSubject({ brand, notificationId, locale }) {
  const tryPaths = [
    `${TEMPLATES_BUCKET}/${brand}/${notificationId}/${locale}.subject.txt`,
    `${TEMPLATES_BUCKET}/${brand}/${notificationId}/en.subject.txt`
  ];
  for (const p of tryPaths) {
    try {
      const txt = await readGcsText(p);
      return txt.replace(/^\uFEFF/, ''); // strip BOM
    } catch {}
  }
  return null;
}

// Fetch CSS via HTTPS and inline with juice for robust email client rendering
async function inlineCss(html, brand) {
  const cssUrl = brand?.assets?.cssUrl;
  if (!cssUrl) return html;

  const res = await fetch(cssUrl);
  if (!res.ok) return html;
  const css = await res.text();

  const injected = html.includes("</head>")
    ? html.replace("</head>", `<style>${css}</style></head>`)
    : `<style>${css}</style>${html}`;

  return juice(injected);
}

export async function renderEmail({ brandKey, locale, notificationId, serviceId, systemData }) {
  const brand = await loadBrand(brandKey);
  const normalized = normalizeNotificationId(notificationId);

  const htmlTpl = await loadTemplate({
    brand: brandKey,
    notificationId: normalized,
    serviceId,
    locale
  });

  const subjectTpl = await loadSubject({
    brand: brandKey,
    notificationId: normalized,
    locale
  });

  const data = { ...systemData, brand, locale, notificationId: normalized, serviceId };

  const withCss = await inlineCss(htmlTpl, brand);
  const html = replacePlaceholders(withCss, data);

  const subject = subjectTpl
    ? replacePlaceholders(subjectTpl, data)
    : defaultSubject(normalized, data);

  // Quick text alternative
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return { html, text, subject };
}

function defaultSubject(notificationId, data) {
  switch (notificationId) {
    case "payment-paid":
      return `${data.brand.brandName}: Payment received — order ${data.invoiceNo || ""}`.trim();
    case "payment-failed":
      return `${data.brand.brandName}: Payment failed`;
    case "payment-paid-sub-renew":
      return `${data.brand.brandName}: Subscription renewed`;
    case "refund-issued":
      return `${data.brand.brandName}: Refund processed`;
    default:
      return `${data.brand.brandName}: Update`;
  }
}
