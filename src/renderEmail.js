import fetch from 'node-fetch';
import juice from 'juice';
import { readGcsText } from './utils/gcs.js';
import { replacePlaceholders } from './utils/templating.js';

const TEMPLATES_BUCKET = process.env.TEMPLATES_BUCKET; // e.g., gs://yokweb-billing-001-email-templates
const ASSETS_BUCKET    = process.env.ASSETS_BUCKET;    // e.g., gs://yokweb-billing-001-email-assets

const LEGACY_TO_NEW = {
  'invoice-paid': 'payment-paid',
  'subscription-renewed': 'payment-paid-sub-renew',
  // unchanged:
  'payment-failed': 'payment-failed',
  'refund-issued': 'refund-issued'
};
const normalizeNotificationId = (id) => LEGACY_TO_NEW[id] || id;

async function loadBrand(brandKey) {
  const url = ${ASSETS_BUCKET}/brands/.json;
  const json = await readGcsText(url);
  return JSON.parse(json);
}

async function loadTemplate({ brand, notificationId, serviceId, locale }) {
  const tryPaths = [
    ${TEMPLATES_BUCKET}/trueweb//.html,
    ${TEMPLATES_BUCKET}/trueweb//en.html,
    ${TEMPLATES_BUCKET}/trueweb/services//.html,
    ${TEMPLATES_BUCKET}/trueweb/services//en.html,
  ];
  for (const p of tryPaths) {
    try {
      return await readGcsText(p);
    } catch { /* try next */ }
  }
  return \<!doctype html><html><body><p>Fallback: \ (\)</p></body></html>\;
}

async function loadSubject({ brand, notificationId, locale }) {
  const tryPaths = [
    \\/\trueweb/\/\.subject.txt\,
    \\/\trueweb/\/en.subject.txt\,
  ];
  for (const p of tryPaths) {
    try {
      return await readGcsText(p);
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

  const injected = html.includes('</head>')
    ? html.replace('</head>', \<style>\</style></head>\)
    : \<style>\</style>\\;

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
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { html, text, subject };
}

function defaultSubject(notificationId, data) {
  switch (notificationId) {
    case 'payment-paid': return \\: Payment received — order \\.trim();
    case 'payment-failed': return \\: Payment failed\;
    case 'payment-paid-sub-renew': return \\: Subscription renewed\;
    case 'refund-issued': return \\: Refund processed\;
    default: return \\: Update\;
  }
}
