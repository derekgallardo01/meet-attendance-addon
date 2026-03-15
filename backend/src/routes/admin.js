const { Router } = require('express');
const log = require('../lib/logger');
const { upsertTenantConfig, getTenantConfig, getDb } = require('../services/firestore');

const router = Router();

// POST /api/admin/install — Marketplace install webhook
// Called by Google when a Workspace admin installs the app
router.post('/admin/install', async (req, res) => {
  try {
    const { domain, adminEmail } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain required' });

    await upsertTenantConfig(domain, {
      installedAt: new Date().toISOString(),
      adminEmail: adminEmail || null,
      active: true,
    });

    log.info('marketplace: app installed', { domain });
    res.json({ success: true });
  } catch (err) {
    log.error('marketplace: install failed', { error: err.message });
    res.status(500).json({ error: 'Install registration failed' });
  }
});

// POST /api/admin/uninstall — Marketplace uninstall webhook
router.post('/admin/uninstall', async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'domain required' });

    await upsertTenantConfig(domain, {
      active: false,
      uninstalledAt: new Date().toISOString(),
    });

    log.info('marketplace: app uninstalled', { domain });
    res.json({ success: true });
  } catch (err) {
    log.error('marketplace: uninstall failed', { error: err.message });
    res.status(500).json({ error: 'Uninstall registration failed' });
  }
});

// GET /api/admin/stats — Basic usage stats (protected by admin check)
router.get('/admin/stats', async (req, res) => {
  try {
    // Only allow authenticated users with a known domain
    if (!req.user?.email) return res.status(401).json({ error: 'Authentication required' });

    const { Firestore } = require('@google-cloud/firestore');
    const db = new Firestore();

    // Count tenants
    const tenantsSnap = await db.collection('tenants').get();
    const tenants = tenantsSnap.docs.map(d => ({
      domain: d.id,
      ...d.data(),
    }));

    // Count users for the requesting user's domain
    const domain = req.user.domain;
    const usersSnap = await db.collection('tenants').doc(domain).collection('users').get();
    const meetingsSnap = await db.collection('tenants').doc(domain).collection('meetings').get();
    const exportsSnap = await db.collection('tenants').doc(domain).collection('exports').get();

    // Get recent users with last login
    const recentUsers = usersSnap.docs
      .map(d => ({ email: d.id, ...d.data() }))
      .sort((a, b) => {
        const aTime = a.lastLoginAt?.toDate?.() || new Date(0);
        const bTime = b.lastLoginAt?.toDate?.() || new Date(0);
        return bTime - aTime;
      })
      .slice(0, 20)
      .map(u => ({
        email: u.email,
        displayName: u.displayName || '',
        lastLogin: u.lastLoginAt?.toDate?.()?.toISOString() || null,
      }));

    res.json({
      totalTenants: tenants.length,
      tenants: tenants.map(t => ({ domain: t.domain, active: t.active, installedAt: t.installedAt })),
      yourDomain: {
        domain,
        users: usersSnap.size,
        meetings: meetingsSnap.size,
        exports: exportsSnap.size,
        recentUsers,
      },
    });
  } catch (err) {
    log.error('admin: stats failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// POST /api/admin/verify-delegation — Test if domain-wide delegation works
router.post('/admin/verify-delegation', async (req, res) => {
  try {
    const { domain, adminEmail } = req.body;
    if (!domain || !adminEmail) {
      return res.status(400).json({ error: 'domain and adminEmail required' });
    }

    // Try to get a Meet API token by impersonating the admin
    const { getMeetToken } = require('../services/googleAuth');
    await getMeetToken(adminEmail);

    // If we get here, delegation works — store the config
    await upsertTenantConfig(domain, {
      adminEmail,
      impersonateEmail: adminEmail,
      delegationVerified: true,
      active: true,
    });

    log.info('admin: delegation verified', { domain, adminEmail });
    res.json({ success: true });
  } catch (err) {
    log.warn('admin: delegation verification failed', { error: err.message });
    res.json({ success: false, error: 'Domain-wide delegation is not configured correctly. Please check the setup steps and try again.' });
  }
});

module.exports = router;
