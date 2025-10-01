// ...imports...
// import express, bodyParser, Stripe, Mailgun, formData as you already do

const TEMPLATE_MAP = {
  'invoice.paid': 'invoice_paid',
  'invoice.finalized': 'invoice_finalized',
  'invoice.payment_failed': 'invoice_payment_failed',
  'invoice.upcoming': 'invoice_upcoming',
  'customer.subscription.trial_will_end': 'subscription_trial_will_end',
};

function formatAmountMinor(minor, currency) {
  if (typeof minor !== 'number') return '';
  const code = String(currency || '').toUpperCase();
  const major = (minor / 100).toFixed(2);
  return `${major} ${code}`;
}

function pickEmail(inv, customerObj) {
  return (
    inv?.customer_email ||
    inv?.customer_details?.email ||
    inv?.account_email ||
    customerObj?.email ||
    null
  );
}

async function sendTemplatedMail(mg, domain, to, template, subject, vars) {
  return mg.messages.create(domain, {
    from: 'Yokweb Billing <no-reply@billing.yokweb.com>',
    to,
    subject,
    template,                                   // <-- use stored template
    'h:X-Mailgun-Variables': JSON.stringify(vars), // <-- pass variables
    'h:Reply-To': 'billing@yokweb.com',
    'o:tracking': 'false',
  });
}

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!endpointSecret || !stripeKey) {
    console.error('Missing STRIPE_WEBHOOK_SECRET or STRIPE_SECRET_KEY');
    return res.status(500).send('Server not configured');
  }

  const stripe = new Stripe(stripeKey);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Stripe event:', event.type);

  try {
    const template = TEMPLATE_MAP[event.type];
    if (!template) return res.json({ received: true, mailed: false, reason: 'no-template' });

    // Normalize Stripe objects we care about
    const obj = event.data.object || {};
    const inv = obj; // invoice.* events carry the invoice object
    let customerObj = null;

    // Try retrieving customer for email/name fallback
    try {
      if (typeof inv.customer === 'string') {
        customerObj = await stripe.customers.retrieve(inv.customer);
      } else if (inv.customer?.email) {
        customerObj = inv.customer;
      }
    } catch (e) {
      console.warn('Customer retrieve warn:', e?.message);
    }

    // Resolve recipient
    let to = pickEmail(inv, customerObj);
    const testTo = process.env.TEST_TO;
    if (testTo && (!to || /@example\.com$/i.test(to))) {
      console.log('TEST override to:', testTo, '(original to:', to, ')');
      to = testTo;
    }
    if (!to) {
      console.warn('No recipient email found; skipping send.');
      return res.json({ received: true, mailed: false, reason: 'no-recipient' });
    }

    // Prepare variables
    const amount = formatAmountMinor(inv.amount_paid ?? inv.amount_due, inv.currency);
    const invoiceNumber = inv.number || inv.id;
    const customerName = inv.customer_name || inv.customer_details?.name || customerObj?.name || null;
    const dueDate = inv.next_payment_attempt
      ? new Date(inv.next_payment_attempt * 1000).toISOString().slice(0,10)
      : (inv.due_date ? new Date(inv.due_date * 1000).toISOString().slice(0,10) : null);

    const vars = {
      customer_email: to,
      customer_name: customerName,
      invoice_number: invoiceNumber,
      amount,
      due_date: dueDate,
      host: 'yokweb.com',
      support_email: 'help@yokweb.com',
    };

    // Subject per event (feel free to adjust copy)
    const SUBJECTS = {
      'invoice.paid': 'Payment received — Yokweb',
      'invoice.finalized': 'Invoice ready — Yokweb',
      'invoice.payment_failed': 'Payment failed — action needed',
      'invoice.upcoming': 'Upcoming invoice — reminder',
      'customer.subscription.trial_will_end': 'Your trial is ending soon',
    };
    const subject = SUBJECTS[event.type] || 'Notification from Yokweb';

    // Mailgun client
    const mg = new Mailgun(formData).client({
      username: 'api',
      key: process.env.MAILGUN_EU_API_KEY,
      url: process.env.MAILGUN_API_URL || 'https://api.eu.mailgun.net',
    });

    const domain = process.env.MAILGUN_DOMAIN;
    console.log(`Sending "${template}" to:`, to);
    const resp = await sendTemplatedMail(mg, domain, to, template, subject, vars);
    console.log('Mailgun queued id:', resp?.id || resp);
  } catch (e) {
    console.error('Handler error:', e);
  }

  return res.json({ received: true });
});
