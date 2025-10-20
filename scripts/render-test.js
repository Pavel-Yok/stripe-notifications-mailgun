import { renderEmail } from '../src/renderEmail.js';
import { writeFileSync, mkdirSync } from 'fs';

const brandKey = 'yokweb';
const locale = 'en';
// use a legacy id to verify mapping → will auto-map to 'payment-paid'
const notificationId = 'invoice-paid';
const serviceId = 'comp-aud'; // any serviceId is fine for this test

const systemData = {
  customerName: 'Jane Customer',
  amount: '590.00',
  currency: '€',
  invoiceNo: 'INV-12345',
  trackOrder: 'https://yokweb.com/orders/INV-12345',
  purchaseSite: 'yokweb.com',
  billing: {
    name: 'Jane Customer',
    address_line1: 'Main St 1',
    address_line2: '',
    postcode: '00-001',
    city: 'Warsaw',
    country: 'PL',
    vat_id: 'PL1234567890'
  },
  preheader: 'Thanks for your purchase — payment received. Order INV-12345',
  ctaUrl: 'https://yokweb.com/orders/INV-12345',
  ctaLabel: 'View order'
};

const { html, text, subject } = await renderEmail({
  brandKey, locale, notificationId, serviceId, systemData
});

mkdirSync('./out', { recursive: true });
writeFileSync('./out/test.html', html, 'utf8');
writeFileSync('./out/test.txt', text, 'utf8');
console.log('Subject:', subject);
console.log('Wrote ./out/test.html and ./out/test.txt');
