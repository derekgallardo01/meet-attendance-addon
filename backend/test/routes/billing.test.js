// Tests for /api/billing/* — Stripe checkout, portal, status, webhook, and the
// requireProPlan gate. The Stripe SDK is mocked so no network calls happen.

const request = require('supertest');
const { authedHeader, buildApp } = require('../helpers/testApp');

// Controllable Stripe instance returned by the mocked SDK factory.
const mockStripeInstance = {
  checkout: { sessions: { create: jest.fn() } },
  billingPortal: { sessions: { create: jest.fn() } },
  prices: { retrieve: jest.fn().mockResolvedValue({ id: 'p1', type: 'recurring', recurring: { interval: 'year' } }) },
  webhooks: { constructEvent: jest.fn() },
  promotionCodes: { create: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripeInstance));

jest.mock('../../src/services/firestore', () => ({
  getTenantPlan: jest.fn(),
  setTenantPlan: jest.fn(),
  getUserPlan: jest.fn(),
  setUserPlan: jest.fn(),
  getUser: jest.fn(),
  updateUserTokens: jest.fn(),
  getTeamAdminStatus: jest.fn(), // requireTeamAdmin (runs before requireProPlan on /team/overview)
  countUserMonthlyExports: jest.fn().mockResolvedValue(0),
}));

const firestore = require('../../src/services/firestore');

let app;

beforeEach(() => {
  jest.clearAllMocks();
  mockStripeInstance.prices.retrieve.mockResolvedValue({ id: 'p1', type: 'recurring', recurring: { interval: 'year' } });
  mockStripeInstance.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/test' });
  firestore.getUser.mockImplementation(async (domain, email) => ({ email, domain }));
  firestore.getTenantPlan.mockResolvedValue({ plan: 'free', billingStatus: null, stripeCustomerId: null });
  firestore.getUserPlan.mockResolvedValue({ plan: 'free', billingStatus: null, stripeCustomerId: null });
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_ID;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_INDIVIDUAL_PRICE_ID;
  app = buildApp();
});

describe('billing — not configured (pre-launch defaults)', () => {
  test('POST /billing/checkout 401 without auth', async () => {
    const res = await request(app).post('/api/billing/checkout').send({});
    expect(res.status).toBe(401);
  });

  test('POST /billing/checkout 503 when Stripe env is unset', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set(authedHeader('admin@acme.com', 'acme.com'))
      .send({});
    expect(res.status).toBe(503);
  });

  test('GET /billing/portal 503 when unconfigured', async () => {
    const res = await request(app)
      .get('/api/billing/portal')
      .set(authedHeader('admin@acme.com', 'acme.com'));
    expect(res.status).toBe(503);
  });

  test('POST /billing/webhook 503 when unconfigured', async () => {
    const res = await request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .send({ type: 'checkout.session.completed' });
    expect(res.status).toBe(503);
  });

  test('GET /billing/status returns the free plan + billingConfigured:false', async () => {
    const res = await request(app)
      .get('/api/billing/status')
      .set(authedHeader('admin@acme.com', 'acme.com'));
    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('free');
    expect(res.body.billingConfigured).toBe(false);
  });
});

describe('billing — configured (Stripe env set)', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_ID = 'price_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    app = buildApp();
  });

  test('POST /billing/checkout returns the session URL', async () => {
    mockStripeInstance.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/abc' });
    const res = await request(app)
      .post('/api/billing/checkout')
      .set(authedHeader('admin@acme.com', 'acme.com'))
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('checkout.stripe.com');
    // Per-domain: the session must carry the domain for the webhook to key on.
    expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ client_reference_id: 'acme.com' })
    );
  });

  test('webhook 400 on bad signature (does not update the plan)', async () => {
    mockStripeInstance.webhooks.constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const res = await request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'nope')
      .send({ type: 'checkout.session.completed' });
    expect(res.status).toBe(400);
    expect(firestore.setTenantPlan).not.toHaveBeenCalled();
  });

  test('webhook checkout.session.completed upgrades the domain to Pro', async () => {
    mockStripeInstance.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: 'acme.com', customer: 'cus_1', subscription: 'sub_1' } },
    });
    const res = await request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'good')
      .send({});
    expect(res.status).toBe(200);
    expect(firestore.setTenantPlan).toHaveBeenCalledWith('acme.com', expect.objectContaining({
      plan: 'pro', billingStatus: 'active', stripeCustomerId: 'cus_1',
    }));
  });

  test('webhook subscription.deleted downgrades to free', async () => {
    mockStripeInstance.webhooks.constructEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_1', status: 'canceled', metadata: { domain: 'acme.com' } } },
    });
    await request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'good')
      .send({});
    expect(firestore.setTenantPlan).toHaveBeenCalledWith('acme.com', expect.objectContaining({
      plan: 'free', billingStatus: 'canceled',
    }));
  });

  test('webhook subscription.updated → past_due KEEPS Pro (dunning grace)', async () => {
    mockStripeInstance.webhooks.constructEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'past_due', metadata: { domain: 'acme.com' } } },
    });
    await request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'good')
      .send({});
    expect(firestore.setTenantPlan).toHaveBeenCalledWith('acme.com', expect.objectContaining({
      plan: 'pro', billingStatus: 'past_due',
    }));
  });

  test('webhook subscription.updated → unpaid downgrades to free (retries exhausted)', async () => {
    mockStripeInstance.webhooks.constructEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'unpaid', metadata: { domain: 'acme.com' } } },
    });
    await request(app)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'good')
      .send({});
    expect(firestore.setTenantPlan).toHaveBeenCalledWith('acme.com', expect.objectContaining({
      plan: 'free', billingStatus: 'unpaid',
    }));
  });

  test('team overview is gated: 402 for a free domain once billing is live', async () => {
    firestore.getTenantPlan.mockResolvedValue({ plan: 'free' });
    firestore.getTeamAdminStatus.mockResolvedValue({ isTeamAdmin: true }); // pass requireTeamAdmin, then hit requireProPlan
    const res = await request(app)
      .get('/api/team/overview')
      .set(authedHeader('admin@acme.com', 'acme.com'));
    expect(res.status).toBe(402);
    expect(res.body.upgrade).toBe(true);
  });
});

describe('billing — individual (per-user) tier for personal-email users', () => {
  const GMAIL = 'teacher@gmail.com';
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_ID = 'price_org';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    process.env.STRIPE_INDIVIDUAL_PRICE_ID = 'price_individual';
    app = buildApp();
  });
  afterEach(() => { delete process.env.STRIPE_INDIVIDUAL_PRICE_ID; });

  test('checkout uses the INDIVIDUAL price + user:<email> reference for a personal domain', async () => {
    mockStripeInstance.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/ind' });
    const res = await request(app).post('/api/billing/checkout').set(authedHeader(GMAIL, 'gmail.com')).send({});
    expect(res.status).toBe(200);
    expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [{ price: 'price_individual', quantity: 1 }],
      client_reference_id: `user:${GMAIL}`,
      metadata: expect.objectContaining({ individual: '1', domain: 'gmail.com', email: GMAIL }),
    }));
  });

  test('checkout allows an institutional user to explicitly buy an INDIVIDUAL plan', async () => {
    mockStripeInstance.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/ind-school' });
    const res = await request(app).post('/api/billing/checkout').set(authedHeader('teacher@k12.edu', 'k12.edu')).send({ plan: 'individual' });
    expect(res.status).toBe(200);
    expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [{ price: 'price_individual', quantity: 1 }],
      client_reference_id: 'user:teacher@k12.edu',
      metadata: expect.objectContaining({ individual: '1', domain: 'k12.edu', email: 'teacher@k12.edu' }),
    }));
  });

  test('checkout 503 for a personal user when the individual price is not set (tier not launched)', async () => {
    delete process.env.STRIPE_INDIVIDUAL_PRICE_ID;
    app = buildApp();
    const res = await request(app).post('/api/billing/checkout').set(authedHeader(GMAIL, 'gmail.com')).send({});
    expect(res.status).toBe(503);
  });

  test('webhook checkout.completed with individual metadata writes the USER plan, not the tenant', async () => {
    mockStripeInstance.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: { object: { client_reference_id: `user:${GMAIL}`, customer: 'cus_i', subscription: 'sub_i', metadata: { individual: '1', domain: 'gmail.com', email: GMAIL } } },
    });
    const res = await request(app).post('/api/billing/webhook').set('Content-Type', 'application/json').set('stripe-signature', 'good').send({});
    expect(res.status).toBe(200);
    expect(firestore.setUserPlan).toHaveBeenCalledWith('gmail.com', GMAIL, expect.objectContaining({
      individualPlan: 'pro', individualBillingStatus: 'active', individualStripeCustomerId: 'cus_i',
    }));
    expect(firestore.setTenantPlan).not.toHaveBeenCalled();
  });

  test('webhook subscription.deleted for an individual downgrades the USER to free', async () => {
    mockStripeInstance.webhooks.constructEvent.mockReturnValue({
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_i', status: 'canceled', metadata: { individual: '1', domain: 'gmail.com', email: GMAIL } } },
    });
    await request(app).post('/api/billing/webhook').set('Content-Type', 'application/json').set('stripe-signature', 'good').send({});
    expect(firestore.setUserPlan).toHaveBeenCalledWith('gmail.com', GMAIL, expect.objectContaining({ individualPlan: 'free', individualBillingStatus: 'canceled' }));
    expect(firestore.setTenantPlan).not.toHaveBeenCalled();
  });

  test('status for a personal user reports individual:true and reads the user plan', async () => {
    firestore.getUserPlan.mockResolvedValue({ plan: 'pro', billingStatus: 'active', stripeCustomerId: 'cus_i' });
    const res = await request(app).get('/api/billing/status').set(authedHeader(GMAIL, 'gmail.com'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: 'pro', individual: true, billingConfigured: true });
    expect(firestore.getUserPlan).toHaveBeenCalledWith('gmail.com', GMAIL);
    expect(firestore.getTenantPlan).not.toHaveBeenCalled();
  });

  test('portal for a personal user uses the USER stripe customer', async () => {
    firestore.getUserPlan.mockResolvedValue({ plan: 'pro', stripeCustomerId: 'cus_i' });
    mockStripeInstance.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/i' });
    const res = await request(app).get('/api/billing/portal').set(authedHeader(GMAIL, 'gmail.com'));
    expect(res.status).toBe(200);
    expect(mockStripeInstance.billingPortal.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_i' }));
  });
});

describe('billing — annual pricing (monthly + annual per tier)', () => {
  const GMAIL = 'teacher@gmail.com';
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_ID = 'price_org_monthly';
    process.env.STRIPE_INDIVIDUAL_PRICE_ID = 'price_ind_monthly';
    process.env.STRIPE_ANNUAL_PRICE_ID = 'price_org_annual';
    process.env.STRIPE_INDIVIDUAL_ANNUAL_PRICE_ID = 'price_ind_annual';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    mockStripeInstance.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/x' });
    app = buildApp();
  });
  afterEach(() => {
    delete process.env.STRIPE_INDIVIDUAL_PRICE_ID;
    delete process.env.STRIPE_ANNUAL_PRICE_ID;
    delete process.env.STRIPE_INDIVIDUAL_ANNUAL_PRICE_ID;
  });
  const checkout = (email, domain, body) => request(app).post('/api/billing/checkout')
    .set(authedHeader(email, domain)).set('Content-Type', 'application/json').send(body || {});
  const priceOf = () => mockStripeInstance.checkout.sessions.create.mock.calls[0][0].line_items[0].price;

  test('individual + interval:annual → individual ANNUAL price', async () => {
    await checkout(GMAIL, 'gmail.com', { interval: 'annual' });
    expect(priceOf()).toBe('price_ind_annual');
  });
  test('individual, no interval → individual MONTHLY price', async () => {
    await checkout(GMAIL, 'gmail.com', {});
    expect(priceOf()).toBe('price_ind_monthly');
  });
  test('team (workspace) + interval:annual → team ANNUAL price', async () => {
    await checkout('admin@acme.com', 'acme.com', { interval: 'annual' });
    expect(priceOf()).toBe('price_org_annual');
  });
  test('annual requested but annual price unset → falls back to MONTHLY', async () => {
    delete process.env.STRIPE_INDIVIDUAL_ANNUAL_PRICE_ID;
    await checkout(GMAIL, 'gmail.com', { interval: 'annual' });
    expect(priceOf()).toBe('price_ind_monthly');
  });
  test('status reports annualAvailable:true when the annual price is set', async () => {
    firestore.getUserPlan.mockResolvedValue({ plan: 'free' });
    const res = await request(app).get('/api/billing/status').set(authedHeader(GMAIL, 'gmail.com'));
    expect(res.body.annualAvailable).toBe(true);
  });
  test('status reports annualAvailable:false when the annual price is unset', async () => {
    delete process.env.STRIPE_INDIVIDUAL_ANNUAL_PRICE_ID;
    firestore.getUserPlan.mockResolvedValue({ plan: 'free' });
    const res = await request(app).get('/api/billing/status').set(authedHeader(GMAIL, 'gmail.com'));
    expect(res.body.annualAvailable).toBe(false);
  });
});

describe('planIsPro — per-user gating for personal domains', () => {
  const { planIsPro } = require('../../src/routes/billing');
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_ID = 'price_org';
  });
  afterEach(() => { delete process.env.STRIPE_INDIVIDUAL_PRICE_ID; });

  test('personal domain with NO email stays free-tier-allowed (no regression on existing callers)', async () => {
    process.env.STRIPE_INDIVIDUAL_PRICE_ID = 'price_individual';
    expect(await planIsPro('gmail.com')).toBe(true); // no email → not gated
    expect(firestore.getUserPlan).not.toHaveBeenCalled();
  });

  test('personal domain + email but individual tier NOT launched → allowed (no regression)', async () => {
    delete process.env.STRIPE_INDIVIDUAL_PRICE_ID;
    expect(await planIsPro('gmail.com', 'u@gmail.com')).toBe(true);
    expect(firestore.getUserPlan).not.toHaveBeenCalled();
  });

  test('personal domain + email + launched → reads the user plan (pro=true / free=false)', async () => {
    process.env.STRIPE_INDIVIDUAL_PRICE_ID = 'price_individual';
    firestore.getUserPlan.mockResolvedValueOnce({ plan: 'pro' });
    expect(await planIsPro('gmail.com', 'u@gmail.com')).toBe(true);
    firestore.getUserPlan.mockResolvedValueOnce({ plan: 'free' });
    expect(await planIsPro('gmail.com', 'u@gmail.com')).toBe(false);
  });

  test('one gmail user paying does NOT make another gmail user Pro (per-user, not per shared tenant)', async () => {
    process.env.STRIPE_INDIVIDUAL_PRICE_ID = 'price_individual';
    firestore.getUserPlan.mockImplementation(async (_d, email) => ({ plan: email === 'payer@gmail.com' ? 'pro' : 'free' }));
    expect(await planIsPro('gmail.com', 'payer@gmail.com')).toBe(true);
    expect(await planIsPro('gmail.com', 'freeloader@gmail.com')).toBe(false);
  });

  test('workspace domain still gates on the DOMAIN plan (email ignored)', async () => {
    firestore.getTenantPlan.mockResolvedValueOnce({ plan: 'pro' });
    expect(await planIsPro('acme.com', 'anyone@acme.com')).toBe(true);
    expect(firestore.getUserPlan).not.toHaveBeenCalled();
  });

  test('per-user gate fails CLOSED on a read error with no cached plan', async () => {
    process.env.STRIPE_INDIVIDUAL_PRICE_ID = 'price_individual';
    firestore.getUserPlan.mockRejectedValue(new Error('firestore down'));
    expect(await planIsPro('gmail.com', 'nocache@gmail.com')).toBe(false);
  });
});

describe('billing — additional configured paths', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_ID = 'price_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
    app = buildApp();
  });

  test('POST /billing/checkout 502 when Stripe throws', async () => {
    mockStripeInstance.checkout.sessions.create.mockRejectedValue(new Error('stripe down'));
    const res = await request(app).post('/api/billing/checkout').set(authedHeader('a@acme.com', 'acme.com')).send({});
    expect(res.status).toBe(502);
  });

  test('GET /billing/portal 404 when the domain has no Stripe customer', async () => {
    firestore.getTenantPlan.mockResolvedValue({ plan: 'free', stripeCustomerId: null });
    const res = await request(app).get('/api/billing/portal').set(authedHeader('a@acme.com', 'acme.com'));
    expect(res.status).toBe(404);
  });

  test('GET /billing/portal returns the portal URL when a customer exists', async () => {
    firestore.getTenantPlan.mockResolvedValue({ plan: 'pro', stripeCustomerId: 'cus_1' });
    mockStripeInstance.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/p/x' });
    const res = await request(app).get('/api/billing/portal').set(authedHeader('a@acme.com', 'acme.com'));
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('billing.stripe.com');
  });

  test('GET /billing/portal 502 when Stripe throws', async () => {
    firestore.getTenantPlan.mockResolvedValue({ plan: 'pro', stripeCustomerId: 'cus_1' });
    mockStripeInstance.billingPortal.sessions.create.mockRejectedValue(new Error('stripe down'));
    const res = await request(app).get('/api/billing/portal').set(authedHeader('a@acme.com', 'acme.com'));
    expect(res.status).toBe(502);
  });

  test('webhook subscription.updated (active) upgrades to Pro', async () => {
    mockStripeInstance.webhooks.constructEvent.mockReturnValue({
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_1', status: 'active', metadata: { domain: 'acme.com' } } },
    });
    const res = await request(app).post('/api/billing/webhook').set('Content-Type', 'application/json').send(Buffer.from('{}'));
    expect(res.status).toBe(200);
    expect(firestore.setTenantPlan).toHaveBeenCalledWith('acme.com', expect.objectContaining({ plan: 'pro' }));
  });

  test('webhook checkout.session.completed with no domain is ignored', async () => {
    mockStripeInstance.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed', data: { object: { client_reference_id: null, metadata: {} } },
    });
    const res = await request(app).post('/api/billing/webhook').set('Content-Type', 'application/json').send(Buffer.from('{}'));
    expect(res.status).toBe(200);
    expect(firestore.setTenantPlan).not.toHaveBeenCalled();
  });

  test('webhook subscription.updated with no domain is ignored', async () => {
    mockStripeInstance.webhooks.constructEvent.mockReturnValue({
      type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'active', metadata: {} } },
    });
    const res = await request(app).post('/api/billing/webhook').set('Content-Type', 'application/json').send(Buffer.from('{}'));
    expect(res.status).toBe(200);
    expect(firestore.setTenantPlan).not.toHaveBeenCalled();
  });

  test('webhook ignores unknown event types', async () => {
    mockStripeInstance.webhooks.constructEvent.mockReturnValue({ type: 'invoice.paid', data: { object: {} } });
    const res = await request(app).post('/api/billing/webhook').set('Content-Type', 'application/json').send(Buffer.from('{}'));
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });

  test('webhook 500 when the handler throws while updating', async () => {
    mockStripeInstance.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed', data: { object: { client_reference_id: 'acme.com' } },
    });
    firestore.setTenantPlan.mockRejectedValue(new Error('firestore down'));
    const res = await request(app).post('/api/billing/webhook').set('Content-Type', 'application/json').send(Buffer.from('{}'));
    expect(res.status).toBe(500);
  });
});

describe('requireProPlan (direct)', () => {
  const { requireProPlan } = require('../../src/routes/billing');
  function ctx() {
    const req = { user: { domain: 'acme.com' } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    return { req, res, next };
  }
  afterEach(() => { delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_PRICE_ID; });

  test('passes through when billing is not configured', async () => {
    const { req, res, next } = ctx();
    await requireProPlan(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('allows a Pro domain when configured', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_PRICE_ID = 'price_x';
    firestore.getTenantPlan.mockResolvedValue({ plan: 'pro' });
    const { req, res, next } = ctx();
    await requireProPlan(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('fails CLOSED (402) when the plan read throws and there is no cached plan', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_PRICE_ID = 'price_x';
    firestore.getTenantPlan.mockRejectedValue(new Error('read boom'));
    // Unique domain so no prior test primed the module-level plan cache.
    const req = { user: { domain: `nocache-${Date.now()}.com` } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await requireProPlan(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ upgrade: true, transient: true }));
  });

  test('tolerates a transient read error using the last known Pro plan', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_PRICE_ID = 'price_x';
    const domain = `paying-${Date.now()}.com`;
    const mk = () => ({
      req: { user: { domain } },
      res: { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() },
      next: jest.fn(),
    });
    // A successful Pro read primes the cache...
    firestore.getTenantPlan.mockResolvedValueOnce({ plan: 'pro' });
    let c = mk(); await requireProPlan(c.req, c.res, c.next);
    expect(c.next).toHaveBeenCalled();
    // ...so a subsequent read error still lets the paying domain through.
    firestore.getTenantPlan.mockRejectedValueOnce(new Error('blip'));
    c = mk(); await requireProPlan(c.req, c.res, c.next);
    expect(c.next).toHaveBeenCalled();
  });
});

describe('billing status error', () => {
  test('GET /billing/status 500 when the plan read throws', async () => {
    firestore.getTenantPlan.mockRejectedValue(new Error('read boom'));
    const res = await request(app).get('/api/billing/status').set(authedHeader('a@acme.com', 'acme.com'));
    expect(res.status).toBe(500);
  });
});

describe('createReferralPromoCode', () => {
  const { createReferralPromoCode } = require('../../src/routes/billing');
  afterEach(() => { delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_REFERRAL_COUPON_ID; });

  test('returns null when the coupon is not configured', async () => {
    delete process.env.STRIPE_REFERRAL_COUPON_ID;
    expect(await createReferralPromoCode('inviter@x.com')).toBeNull();
  });

  test('mints a single-use promo code referencing the coupon when configured', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_REFERRAL_COUPON_ID = 'coup_123';
    mockStripeInstance.promotionCodes.create.mockResolvedValue({ code: 'ABC123' });
    const code = await createReferralPromoCode('inviter@x.com');
    expect(code).toBe('ABC123');
    expect(mockStripeInstance.promotionCodes.create).toHaveBeenCalledWith(expect.objectContaining({
      coupon: 'coup_123', max_redemptions: 1,
      metadata: expect.objectContaining({ referrer: 'inviter@x.com', kind: 'referral_reward' }),
    }));
  });

  test('returns null (does not throw) when Stripe errors', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_REFERRAL_COUPON_ID = 'coup_123';
    mockStripeInstance.promotionCodes.create.mockRejectedValue(new Error('stripe down'));
    expect(await createReferralPromoCode('inviter@x.com')).toBeNull();
  });
});

describe('billing — one-time lifetime payment mode', () => {
  test('uses mode: payment and payment_intent_data when price is one-time', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_ID = 'price_lifetime_1999';
    mockStripeInstance.prices.retrieve.mockResolvedValueOnce({ id: 'price_lifetime_1999', type: 'one_time', recurring: null });
    mockStripeInstance.checkout.sessions.create.mockResolvedValueOnce({ url: 'https://checkout.stripe.com/pay' });

    const res = await request(app)
      .post('/api/billing/checkout')
      .set(authedHeader('admin@acme.com', 'acme.com'))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.com/pay');
    expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'payment',
      payment_intent_data: expect.objectContaining({ metadata: expect.objectContaining({ domain: 'acme.com' }) }),
    }));
  });
});

describe('billing — public-checkout for marketing pages', () => {
  test('creates a public checkout session without authentication', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_PRICE_ID = 'price_domain_1999';
    process.env.STRIPE_INDIVIDUAL_PRICE_ID = 'price_indiv_999';
    mockStripeInstance.checkout.sessions.create.mockResolvedValueOnce({ url: 'https://checkout.stripe.com/public_pay' });

    const res = await request(app)
      .post('/api/billing/public-checkout')
      .send({ plan: 'lifetime', email: 'teacher@school.edu' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.com/public_pay');
    expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      customer_email: 'teacher@school.edu',
      client_reference_id: 'user:teacher@school.edu',
    }));
  });

  test('returns 503 when Stripe is not configured', async () => {
    const oldKey = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;

    const res = await request(app)
      .post('/api/billing/public-checkout')
      .send({ plan: 'individual' });

    expect(res.status).toBe(503);
    process.env.STRIPE_SECRET_KEY = oldKey;
  });

  test('creates a public checkout session for educator pass', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_EDUCATOR_PRICE_ID = 'price_educator_499';
    mockStripeInstance.checkout.sessions.create.mockResolvedValueOnce({ url: 'https://checkout.stripe.com/educator_pay' });

    const res = await request(app)
      .post('/api/billing/public-checkout')
      .send({ plan: 'educator', email: 'teacher@deped.gov.ph' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.com/educator_pay');
    expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({
      line_items: [{ price: 'price_educator_499', quantity: 1 }],
      customer_email: 'teacher@deped.gov.ph',
    }));
  });
});

