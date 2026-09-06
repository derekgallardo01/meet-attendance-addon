const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const express = require('express');
const log = require('../lib/logger');
const CONFIG = require('../config');
const { getTenantPlan, setTenantPlan, getUserPlan, setUserPlan, logEvent } = require('../services/firestore');
const { PERSONAL_EMAIL_DOMAINS } = require('../services/firestore/_core');

// Personal-email tenants (gmail.com etc.) are shared by unrelated users, so they
// can't buy the per-domain org plan — they buy an INDIVIDUAL (per-user) plan
// stored on their user doc. Gated on its own price id so it dark-launches
// independently of the org tier.
const isPersonalDomain = (domain) => PERSONAL_EMAIL_DOMAINS.has((domain || '').toLowerCase());
function individualBillingConfigured() {
  return !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_INDIVIDUAL_PRICE_ID;
}

// Per-domain Pro subscription via Stripe Checkout. Lazy-init the SDK (like the
// Resend wrapper) so the service boots and runs fine before billing is
// configured — every billing endpoint degrades to a clear 503 until the
// STRIPE_* env vars are set. Feature gating (see requireProPlan) is a no-op
// while billing is off, so nothing behind the paywall breaks pre-launch.
let cachedStripe = null;
function getStripe() {
  if (cachedStripe) return cachedStripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  cachedStripe = require('stripe')(key);
  return cachedStripe;
}

// True when Stripe is wired up enough to actually sell/gate.
function billingConfigured() {
  return !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PRICE_ID;
}

const router = Router();

// POST /api/billing/checkout — start a Checkout Session for the caller's
// Workspace domain. Per-domain billing: whoever completes checkout pays for the
// whole org, keyed by domain via client_reference_id + subscription metadata.
router.post('/billing/checkout', requireAuth, async (req, res) => {
  const stripe = getStripe();
  const domain = req.user.domain;
  const email = req.user.email;
  const isEducator = req.body && req.body.plan === 'educator';
  const individual = isEducator
    ? true
    : (req.body && (req.body.plan === 'team' || req.body.plan === 'lifetime')
      ? false
      : (req.body && req.body.plan === 'individual' ? true : isPersonalDomain(domain)));
  // Personal-email users buy the INDIVIDUAL (per-user) plan; Workspace domains
  // buy the per-domain org plan. Each has monthly + optional annual prices.
  // Annual falls back to monthly when its price id isn't set, so annual can be
  // dark-launched (and the frontend only offers it when annualAvailable, below).
  /* istanbul ignore next: express.json always sets req.body to an object */
  const annual = (req.body || {}).interval === 'annual';
  const priceId = isEducator
    ? (process.env.STRIPE_EDUCATOR_PRICE_ID || process.env.STRIPE_INDIVIDUAL_ANNUAL_PRICE_ID || process.env.STRIPE_INDIVIDUAL_PRICE_ID)
    : (individual
      ? (annual && process.env.STRIPE_INDIVIDUAL_ANNUAL_PRICE_ID) || process.env.STRIPE_INDIVIDUAL_PRICE_ID
      : (annual && process.env.STRIPE_ANNUAL_PRICE_ID) || process.env.STRIPE_PRICE_ID);
  if (!stripe || !priceId) {
    return res.status(503).json({ error: 'Billing is not configured yet.' });
  }
  try {
    // client_reference_id tags who the subscription is for: `user:<email>` for
    // an individual, or the bare domain for an org. Metadata carries both so the
    // webhook can route to setUserPlan vs setTenantPlan.
    const meta = individual
      ? { individual: '1', domain, email: email.toLowerCase() }
      : { domain, initiatedBy: email };
    const backTo = individual ? 'history.html' : 'team.html';
    // Retrieve price details to dynamically use 'subscription' for recurring plans
    // or 'payment' for one-time / lifetime purchases.
    let isRecurring = true;
    if (stripe.prices && typeof stripe.prices.retrieve === 'function') {
      try {
        const priceObj = await stripe.prices.retrieve(priceId);
        isRecurring = priceObj ? (priceObj.type === 'recurring' || !!priceObj.recurring) : true;
      } catch (e) {
        log.warn('billing: could not retrieve price object, defaulting to subscription', { priceId, error: e.message });
      }
    }

    const promo = (req.body.promo || 'LAUNCH50').toUpperCase();
    const LAUNCH_PROMO_ID = process.env.STRIPE_LAUNCH_PROMO_CODE || 'promo_1UBiZORPP93YBXrOlZdFv8zM';

    const sessionParams = {
      mode: isRecurring ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: individual ? `user:${email.toLowerCase()}` : domain,
      customer_email: email,
      success_url: `${CONFIG.publicSiteUrl}/${backTo}?upgraded=1`,
      cancel_url: `${CONFIG.publicSiteUrl}/${backTo}`,
      metadata: meta,
    };
    if (promo === 'LAUNCH50' && LAUNCH_PROMO_ID) {
      sessionParams.discounts = [{ promotion_code: LAUNCH_PROMO_ID }];
    } else {
      sessionParams.allow_promotion_codes = true;
    }
    if (isRecurring) {
      sessionParams.subscription_data = { metadata: meta };
    } else {
      sessionParams.payment_intent_data = { metadata: meta };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    log.error('billing: checkout create failed', { domain, individual, error: err.message });
    res.status(502).json({ error: 'Could not start checkout.' });
  }
});

// POST /api/billing/public-checkout — start a Checkout Session from the public
// pricing page without requiring a pre-existing session token. Stripe collects
// the customer's email and payment info, and the webhook provisions Pro.
router.post('/billing/public-checkout', async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Billing is not configured yet.' });
  }
  const plan = req.body?.plan || 'lifetime';
  const interval = req.body?.interval || 'annual';
  const email = (req.body?.email || '').trim().toLowerCase() || undefined;
  const isTeam = plan === 'team';
  const isEducator = plan === 'educator';
  const priceId = isEducator
    ? (process.env.STRIPE_EDUCATOR_PRICE_ID || process.env.STRIPE_INDIVIDUAL_ANNUAL_PRICE_ID || process.env.STRIPE_INDIVIDUAL_PRICE_ID || process.env.STRIPE_PRICE_ID)
    : (isTeam
        ? ((interval === 'annual' && process.env.STRIPE_ANNUAL_PRICE_ID) || process.env.STRIPE_PRICE_ID)
        : (plan === 'lifetime'
            ? (process.env.STRIPE_INDIVIDUAL_LIFETIME_PRICE_ID || process.env.STRIPE_INDIVIDUAL_PRICE_ID || process.env.STRIPE_PRICE_ID)
            : ((interval === 'annual' && process.env.STRIPE_INDIVIDUAL_ANNUAL_PRICE_ID) || process.env.STRIPE_INDIVIDUAL_PRICE_ID || process.env.STRIPE_PRICE_ID)));

  if (!priceId) {
    return res.status(503).json({ error: 'Selected plan price is not configured.' });
  }

  try {
    let isRecurring = true;
    if (plan === 'lifetime') {
      isRecurring = false;
    } else if (stripe.prices && typeof stripe.prices.retrieve === 'function') {
      try {
        const priceObj = await stripe.prices.retrieve(priceId);
        isRecurring = priceObj ? (priceObj.type === 'recurring' || !!priceObj.recurring) : true;
      } catch (e) {
        log.warn('billing: could not retrieve price object in public checkout', { priceId, error: e.message });
      }
    }

    const meta = {
      individual: isTeam ? '0' : '1',
      plan,
      source: 'public_pricing',
      ...(email ? { email } : {}),
    };

    const promo = (req.body?.promo || 'LAUNCH50').toUpperCase();
    const LAUNCH_PROMO_ID = process.env.STRIPE_LAUNCH_PROMO_CODE || 'promo_1UBiZORPP93YBXrOlZdFv8zM';

    const sessionParams = {
      mode: isRecurring ? 'subscription' : 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${CONFIG.publicSiteUrl}/history.html?upgraded=1`,
      cancel_url: `${CONFIG.publicSiteUrl}/pricing.html`,
      metadata: meta,
    };
    if (email) {
      sessionParams.customer_email = email;
      sessionParams.client_reference_id = isTeam ? email.split('@')[1] : `user:${email}`;
    }
    if (promo === 'LAUNCH50' && LAUNCH_PROMO_ID) {
      sessionParams.discounts = [{ promotion_code: LAUNCH_PROMO_ID }];
    } else {
      sessionParams.allow_promotion_codes = true;
    }
    if (isRecurring) {
      sessionParams.subscription_data = { metadata: meta };
    } else {
      sessionParams.payment_intent_data = { metadata: meta };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) {
    log.error('billing: public checkout failed', { plan, error: err.message });
    res.status(502).json({ error: 'Could not start checkout.' });
  }
});

// GET /api/billing/portal — Stripe Customer Portal link so the org admin can
// update payment method or cancel. Requires a stored customer id (set by the
// webhook on first successful checkout).
router.get('/billing/portal', requireAuth, async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Billing is not configured yet.' });
  const individual = isPersonalDomain(req.user.domain);
  try {
    const { stripeCustomerId } = individual
      ? await getUserPlan(req.user.domain, req.user.email)
      : await getTenantPlan(req.user.domain);
    if (!stripeCustomerId) return res.status(404).json({ error: 'No active subscription.' });
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${CONFIG.publicSiteUrl}/${individual ? 'history.html' : 'team.html'}`,
    });
    res.json({ url: session.url });
  } catch (err) {
    log.error('billing: portal create failed', { domain: req.user.domain, individual, error: err.message });
    res.status(502).json({ error: 'Could not open the billing portal.' });
  }
});

// GET /api/billing/status — current plan for the caller's domain (drives the
// upgrade CTA in the UI).
router.get('/billing/status', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const individual = isPersonalDomain(req.user.domain);
  try {
    const plan = individual
      ? await getUserPlan(req.user.domain, req.user.email)
      : await getTenantPlan(req.user.domain);
    // annualAvailable tells the frontend whether to offer the monthly/annual
    // toggle — only once the matching annual price id is set (so we never show
    // an annual price the checkout can't actually charge).
    const annualAvailable = individual
      ? !!process.env.STRIPE_INDIVIDUAL_ANNUAL_PRICE_ID
      : !!process.env.STRIPE_ANNUAL_PRICE_ID;
    res.json({
      ...plan,
      individual,
      billingConfigured: individual ? individualBillingConfigured() : billingConfigured(),
      annualAvailable,
      educatorAvailable: !!process.env.STRIPE_EDUCATOR_PRICE_ID,
    });
  } catch (err) {
    log.error('billing: status failed', { domain: req.user.domain, error: err.message });
    res.status(500).json({ error: 'Failed to fetch plan.' });
  }
});

// The webhook handler is exported separately so app.js can mount it with a RAW
// body parser BEFORE express.json() — Stripe signature verification needs the
// exact bytes. Mounting it inside this (post-json) router would break the
// signature check.
async function webhookHandler(req, res) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !secret) return res.status(503).json({ error: 'Billing webhook not configured.' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    log.warn('billing: webhook signature verification failed', { error: err.message });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const ref = s.client_reference_id || '';
        if (ref.startsWith('user:') || s.metadata?.individual === '1') {
          // Individual (per-user) plan → write the user doc.
          const email = s.metadata?.email || (ref.startsWith('user:') ? ref.slice(5) : (s.customer_details?.email || s.customer_email));
          const domain = s.metadata?.domain || (email && email.includes('@') ? email.split('@')[1] : null);
          if (domain && email) {
            await setUserPlan(domain, email.toLowerCase(), {
              individualPlan: 'pro',
              individualBillingStatus: 'active',
              individualStripeCustomerId: s.customer || null,
              individualStripeSubscriptionId: s.subscription || null,
            });
            try { await logEvent(domain, { email, type: 'upgraded', meta: { plan: 'individual', amount: s.amount_total, currency: s.currency } }); } catch {}
          }
        } else {
          const domain = ref || s.metadata?.domain;
          if (domain) {
            await setTenantPlan(domain, {
              plan: 'pro',
              billingStatus: 'active',
              stripeCustomerId: s.customer || null,
              stripeSubscriptionId: s.subscription || null,
            });
            try { await logEvent(domain, { email: s.customer_email || s.metadata?.initiatedBy || 'admin', type: 'upgraded', meta: { plan: 'team', amount: s.amount_total, currency: s.currency } }); } catch {}
          }
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        // Keep Pro through Stripe's dunning window: `past_due` means the latest
        // invoice failed but Stripe is still auto-retrying, so a temporary card
        // decline shouldn't yank access mid-retry. `unpaid`/`canceled`/etc.
        // (retries exhausted or ended) downgrade to Free.
        const active = ['active', 'trialing', 'past_due'].includes(sub.status);
        if (sub.metadata?.individual === '1') {
          const domain = sub.metadata?.domain;
          const email = sub.metadata?.email;
          if (domain && email) {
            await setUserPlan(domain, email, {
              individualPlan: active ? 'pro' : 'free',
              individualBillingStatus: sub.status,
              individualStripeSubscriptionId: sub.id,
              ...(sub.customer ? { individualStripeCustomerId: sub.customer } : {}),
            });
          }
        } else {
          const domain = sub.metadata?.domain;
          if (domain) {
            await setTenantPlan(domain, {
              plan: active ? 'pro' : 'free',
              billingStatus: sub.status,
              stripeSubscriptionId: sub.id,
              ...(sub.customer ? { stripeCustomerId: sub.customer } : {}), // also persist on subscription events (B6/portal)
            });
          }
        }
        break;
      }
      default:
        // Ignore other event types.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    log.error('billing: webhook handling failed', { type: event.type, error: err.message });
    res.status(500).json({ error: 'Webhook handling failed.' });
  }
}

// Short-lived cache of the last successfully-read plan per domain. Lets the gate
// ride out a transient Firestore blip for a paying customer WITHOUT the old
// fail-open behavior, which silently granted Pro to every domain on any read
// error — the opposite of what a paywall should do once it's live.
const planCache = new Map(); // domain -> { plan, at }
const userPlanCache = new Map(); // `${domain}:${email}` -> { plan, at }
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;

// Express middleware: gate a route behind the Pro plan (per-domain). While
// billing is not configured the gate is OPEN, so paywalled features keep
// working until monetization is switched on. Once configured, non-Pro domains
// get 402 with an upgrade hint. On a read error we fall back to a recent known
// plan; absent that we fail CLOSED (the gated features are non-critical
// dashboards, so a brief denial beats giving Pro away for free).
async function requireProPlan(req, res, next) {
  if (!billingConfigured()) return next(); // pre-launch: nothing is gated
  const domain = req.user?.domain;
  try {
    const { plan } = await getTenantPlan(domain);
    planCache.set(domain, { plan, at: Date.now() });
    if (plan === 'pro') return next();
    return res.status(402).json({ error: 'This is a Pro feature.', upgrade: true });
  } catch (err) {
    const cached = planCache.get(domain);
    const fresh = cached && (Date.now() - cached.at) < PLAN_CACHE_TTL_MS;
    log.warn('billing: requireProPlan read failed', {
      domain, usedCache: !!fresh, cachedPlan: cached?.plan || null, error: err.message,
    });
    if (fresh && cached.plan === 'pro') return next();
    return res.status(402).json({ error: 'This is a Pro feature.', upgrade: true, transient: !fresh });
  }
}

// Boolean form of the gate, for features that DEGRADE gracefully rather than
// hard-block a route (auto-export, digests, full history). Pre-launch (billing
// unconfigured) every feature is allowed. Shares requireProPlan's cache + fail
// behavior: a transient read error rides the last-known plan, else denies.
async function planIsPro(domain, email) {
  if (!billingConfigured()) return true; // pre-launch: nothing is gated
  if (isPersonalDomain(domain)) {
    // Personal-email tenants bill per USER, not per domain. Gate ONLY when the
    // caller passes an email AND the individual tier is launched — existing call
    // sites that pass no email keep personal users on the feature set they
    // already had for free (no regression); individual-Pro features pass email.
    if (!email || !individualBillingConfigured()) return true;
    const key = `${(domain || '').toLowerCase()}:${email.toLowerCase()}`;
    try {
      const { plan } = await getUserPlan(domain, email);
      userPlanCache.set(key, { plan, at: Date.now() });
      return plan === 'pro';
    } catch (err) {
      const cached = userPlanCache.get(key);
      const fresh = cached && (Date.now() - cached.at) < PLAN_CACHE_TTL_MS;
      log.warn('billing: planIsPro (per-user) read failed', { usedCache: !!fresh, error: err.message });
      return !!(fresh && cached.plan === 'pro');
    }
  }
  try {
    const { plan } = await getTenantPlan(domain);
    planCache.set(domain, { plan, at: Date.now() });
    return plan === 'pro';
  } catch (err) {
    const cached = planCache.get(domain);
    const fresh = cached && (Date.now() - cached.at) < PLAN_CACHE_TTL_MS;
    log.warn('billing: planIsPro read failed', { domain, usedCache: !!fresh, error: err.message });
    return !!(fresh && cached.plan === 'pro');
  }
}

// Mint a single-use Stripe promotion code for a referral reward, referencing
// the configured coupon (STRIPE_REFERRAL_COUPON_ID — e.g. "100% off once" = one
// free month on a monthly plan). Returns the human-usable code (e.g. "AB12CD"),
// or null when billing/coupon isn't set up — in which case the reward still
// accrues on the inviter's doc and the email falls back to "we'll apply it".
async function createReferralPromoCode(inviterEmail) {
  const couponId = process.env.STRIPE_REFERRAL_COUPON_ID;
  const stripe = getStripe();
  if (!stripe || !couponId) return null;
  try {
    const pc = await stripe.promotionCodes.create({
      coupon: couponId,
      max_redemptions: 1,
      metadata: { referrer: inviterEmail, kind: 'referral_reward' },
    });
    return pc.code;
  } catch (err) {
    log.error('billing: createReferralPromoCode failed', { inviterEmail, error: err.message });
    return null;
  }
}

module.exports = { router, webhookHandler, requireProPlan, planIsPro, createReferralPromoCode };
