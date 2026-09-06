const crypto = require('crypto');
const { Resend } = require('resend');
const log = require('./logger');
const CONFIG = require('../config');
const { maskSlackWebhook } = require('./slack');
const { escapeHtml: escape } = require('./html');

// Resend transactional email — better deliverability + open/click tracking
// than Gmail SMTP, and the API doesn't have Gmail's 500/day cap.
// Lazy init so boot doesn't fail when RESEND_API_KEY isn't set yet.
let cachedResend = null;
function getResend() {
  if (cachedResend) return cachedResend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  cachedResend = new Resend(apiKey);
  return cachedResend;
}

// Build the From address. Until RESEND_FROM_DOMAIN is set (user has verified
// their domain in Resend), fall back to onboarding@resend.dev which Resend
// allows for any account without DNS. The display name still appears
// correctly in the recipient's inbox either way.
function makeFrom(displayName) {
  const domain = process.env.RESEND_FROM_DOMAIN;
  if (!domain) return `${displayName} <onboarding@resend.dev>`;
  const localpart = process.env.RESEND_FROM_LOCAL || 'hello';
  return `${displayName} <${localpart}@${domain}>`;
}

// Where replies go. GMAIL_USER stays around as the "owner inbox" — anyone who
// replies to a re-engagement or feedback email lands here, regardless of
// what the actual sending domain is.
function ownerEmail() {
  return process.env.GMAIL_USER || process.env.NOTIFY_EMAIL || null;
}

const RESEND_TIMEOUT_MS = Number(process.env.RESEND_TIMEOUT_MS) || 8000;

// Single send wrapper. Mirrors nodemailer's sendMail signature so every call
// site is one-line changed. Throws on hard failure; callers decide whether
// to swallow (fire-and-forget) or surface (admin email, feedback). Tags get
// passed through to Resend for per-type delivery analytics.
async function send({ from, to, subject, text, html, replyTo, tags }) {
  const resend = getResend();
  if (!resend) throw new Error('Resend not configured — set RESEND_API_KEY');
  const params = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    text,
    html,
  };
  if (replyTo) params.replyTo = replyTo;
  // Every internal caller passes a tags array, so the no-tags branch is
  // defensive-only.
  /* istanbul ignore next */
  if (tags) params.tags = tags;
  // The Resend SDK does its own HTTP without an exposed timeout; race it so a
  // hung call can't block the request (or a fire-and-forget email path). Clear
  // the timer once the race settles so it doesn't dangle (and keep the process
  // alive) when the send wins.
  let timer;
  const result = await Promise.race([
    resend.emails.send(params),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Resend send timeout after ${RESEND_TIMEOUT_MS}ms`)), RESEND_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (result.error) {
    throw new Error(`Resend send failed: ${result.error.message || JSON.stringify(result.error)}`);
  }
  return { sent: true, id: result.data?.id };
}

// Format a whole-minute duration as "Nm" / "Nh Nm". Callers supply the empty
// value (email uses '—', Slack uses '').
function hm(min) {
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

// Send an already-built email + log the outcome. Collapses the identical
// try{ send } / log.info(sent) / catch{ log.warn(failed) } block repeated across
// every sender. `label` reproduces the prior per-sender log wording (e.g.
// 'signup notification' → "signup notification sent" / "… failed").
/* istanbul ignore next: every caller passes logMeta; the default is defensive */
async function dispatchEmail(params, label, logMeta = {}) {
  try {
    const info = await send(params);
    log.info(`${label} sent`, { to: params.to, ...logMeta });
    return info;
  } catch (err) {
    log.warn(`${label} failed`, { to: params.to, error: err.message });
    return { sent: false, error: err.message };
  }
}

// POST JSON with a hard timeout so a hung Slack webhook can't block the request
// (or the export flow that fire-and-forgets it). Aborts after SLACK_TIMEOUT_MS.
const SLACK_TIMEOUT_MS = Number(process.env.SLACK_TIMEOUT_MS) || 5000;
async function postJsonWithTimeout(url, body, timeoutMs = SLACK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── One-click unsubscribe (CAN-SPAM) ──────────────────────────────────────
// Every promotional / lifecycle email carries an unsubscribe link. The token is
// an HMAC of the recipient's email under a purpose-separated key (not the raw
// SESSION_SECRET, so it can't be conflated with the JWT/token-at-rest keys), so
// the endpoint can verify the request came from us without storing per-email
// tokens. verify accepts the legacy (bare-secret) token too, so unsubscribe
// links already in users' inboxes keep working after the key separation.
const UNSUBSCRIBE_KEY_LABEL = 'unsubscribe:v1';
function unsubscribeToken(email) {
  return crypto
    .createHmac('sha256', CONFIG.deriveSecret(UNSUBSCRIBE_KEY_LABEL))
    .update(String(email).toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

function legacyUnsubscribeToken(email) {
  return crypto
    .createHmac('sha256', CONFIG.sessionSecret)
    .update(String(email).toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

function tokenMatches(expected, token) {
  const a = Buffer.from(expected);
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyUnsubscribeToken(email, token) {
  if (!email || !token) return false;
  return tokenMatches(unsubscribeToken(email), token)
    || tokenMatches(legacyUnsubscribeToken(email), token);
}

function unsubscribeUrl(email) {
  const t = unsubscribeToken(email);
  return `${CONFIG.publicApiUrl}/public/unsubscribe?e=${encodeURIComponent(email)}&t=${t}`;
}

// Footer appended to lifecycle emails. Returns matching text + HTML fragments.
function unsubscribeFooter(email) {
  const url = unsubscribeUrl(email);
  return {
    text: `\n\n—\nDon't want these emails? Unsubscribe: ${url}`,
    html: `<p style="margin:24px 0 0;color:#8a8f98;font-size:12px;font-family:sans-serif">`
      + `Don't want these emails? <a href="${escape(url)}" style="color:#8a8f98">Unsubscribe</a>.</p>`,
  };
}

// Fire-and-forget signup notification email. Sends to NOTIFY_EMAIL (or the
// owner's inbox if NOTIFY_EMAIL isn't set). Silent no-op if Resend isn't
// configured.
//
// Two source signals, shown side by side because they legitimately differ:
//   - reportedSource: what the user told us via the "how did you find us?"
//     modal (strongest attribution signal). May be absent if dismissed.
//   - detectedSource: what we auto-derived at signup from UTM / referrer /
//     entry point. Users who enter through the in-Meet add-on have no web
//     referrer, so this is usually "direct" even when they found us via search.
// Legacy callers pass a single `acquisitionSource` — treat it as detected.
async function sendSignupWebhook({ email, displayName, domain, reportedSource, reportedDetail, detectedSource, acquisitionSource, totalUsers, signupIp, signupGeo }) {
  if (!getResend()) return;
  const to = process.env.NOTIFY_EMAIL || ownerEmail();
  if (!to) return;

  const reported = reportedSource || null;
  const detected = detectedSource || acquisitionSource || null;
  const primary = reported || detected; // best single label for the subject
  const sourceLine = primary ? ` (via ${primary})` : '';
  const subject = `🎉 New user: ${displayName || email}${sourceLine}`;

  const reportedText = reported
    ? `${reported}${reportedDetail ? ` — ${reportedDetail}` : ''}`
    : 'Not reported';
  const detectedText = detected || 'Unknown';

  const country = signupGeo?.country || null;
  const flag = country ? String.fromCodePoint(0x1F1E6 + country.toUpperCase().charCodeAt(0) - 65, 0x1F1E6 + country.toUpperCase().charCodeAt(1) - 65) + ' ' : '';
  const ipLine = signupIp
    ? `${flag}${signupIp}${country ? ` (${country})` : ''}`
    : 'Unknown';
  const ipLink = signupIp ? `https://ipinfo.io/${encodeURIComponent(signupIp)}` : null;

  const html = `
    <p>A new user just signed up for Attendance Tracker.</p>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr><td style="padding:4px 12px 4px 0;color:#666">Name</td><td>${escape(displayName) || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Email</td><td><a href="mailto:${escape(email)}">${escape(email)}</a></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Domain</td><td>${escape(domain)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Source (self-reported)</td><td>${escape(reportedText)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Source (detected)</td><td>${escape(detectedText)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">IP / Location</td><td>${ipLink ? `<a href="${escape(ipLink)}">${escape(ipLine)}</a>` : escape(ipLine)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Total users now</td><td>${totalUsers ?? '?'}</td></tr>
    </table>
    <p style="margin-top:16px">
      <a href="https://attendancetracker.dev/admin.html">Open admin dashboard</a>
    </p>
  `;

  const text = [
    `New Attendance Tracker user: ${displayName || email}`,
    `Email: ${email}`,
    `Domain: ${domain}`,
    `Source (self-reported): ${reportedText}`,
    `Source (detected): ${detectedText}`,
    `IP / Location: ${ipLine}${ipLink ? ` — ${ipLink}` : ''}`,
    `Total users now: ${totalUsers ?? '?'}`,
    '',
    'Open admin dashboard: https://attendancetracker.dev/admin.html',
  ].join('\n');

  return dispatchEmail({
    from: makeFrom('Attendance Tracker'),
    to, subject, text, html,
    tags: [{ name: 'type', value: 'signup' }],
  }, 'signup notification', { email, domain });
}


// Deferred-signup flush. Sends the signup notification for a user exactly once,
// carrying whatever acquisition source is known at flush time (self-reported if
// the user answered the modal, else the auto-detected fallback). Safe to call
// from multiple triggers — the source-modal answer, the post-signup grace
// timer, and the daily sweep backstop all call this. The underlying claim
// (claimSignupNotification) is transactional, so only the first caller emails;
// the rest are no-ops. Returns { sent: false } when there's nothing pending.
async function maybeSendSignupNotification(domain, email) {
  // Lazy require to avoid a load-time cycle (firestore ⇄ notifications).
  const { claimSignupNotification, countAllUsers } = require('../services/firestore');
  const payload = await claimSignupNotification(domain, email);
  if (!payload) return { sent: false };
  const totalUsers = await countAllUsers();
  const ownerResult = await sendSignupWebhook({
    email: payload.email,
    displayName: payload.displayName,
    domain: payload.domain,
    reportedSource: payload.reportedSource,
    reportedDetail: payload.reportedDetail,
    detectedSource: payload.detectedSource,
    totalUsers,
    signupIp: payload.signupIp,
    signupGeo: payload.signupGeo,
  });

  // Welcome email to the newly signed up user (fire-and-forget)
  sendWelcomeEmail({ to: payload.email, displayName: payload.displayName }).catch(err => {
    log.warn('welcome email failed', { to: payload.email, error: err.message });
  });

  return ownerResult;
}

// Referral win: tell the inviter that someone they invited just joined and
// that they've earned a free month of Pro. Uses sendPersonalEmail so it carries
// the reply-to + CAN-SPAM unsubscribe footer like other lifecycle mail.
async function sendReferralNotification({ to, inviterName, newUserName, rewardMonths = 1, totalReferrals = 1, promoCode = null, rewarded = true }) {
  const monthWord = rewardMonths === 1 ? 'a free month' : `${rewardMonths} free months`;
  // Three states: rewarded + code (apply at checkout), rewarded but no code
  // (billing not yet configured — we'll apply it), or capped (attribution only,
  // no money-bearing reward — see REFERRAL_REWARD_CAP).
  const rewardLine = !rewarded
    ? `Thanks for spreading the word — that's a big help.`
    : promoCode
      ? `As a thank-you, here's ${monthWord} of Pro on us — apply code ${promoCode} at checkout.`
      : `As a thank-you, you've earned ${monthWord} of Pro — it'll be applied to your account (or your next upgrade).`;
  const subject = rewarded
    ? `🎉 ${newUserName} joined Attendance Tracker — you earned a free month`
    : `🎉 ${newUserName} joined Attendance Tracker via your invite`;
  return sendPersonalEmail({
    to, displayName: inviterName,
    subject,
    lines: [
      `Good news — ${newUserName} just signed up for Attendance Tracker using your invite.`,
      '',
      rewardLine,
      totalReferrals > 1 ? `That's ${totalReferrals} people you've brought in so far. Seriously, thank you.` : `Thanks again.`,
      '',
      '— Derek',
      'attendancetracker.dev',
    ],
    tags: [{ name: 'type', value: 'referral' }],
    logLabel: 'referral notification', logMeta: { totalReferrals, hasPromo: !!promoCode, rewarded },
  });
}

// Deferred referral flush. Claims a referred user's pending referral once,
// credits + notifies the inviter, and is a no-op otherwise. Fired from the same
// triggers as the signup notification (grace timer, source modal, daily sweep).
// Idempotent via claimReferral + recordReferralForInviter's per-user guard.
async function maybeSendReferralNotification(domain, email) {
  const { claimReferral, releaseReferral, recordReferralForInviter, recordReferralPromoCode, isEmailSuppressed } = require('../services/firestore');
  const { createReferralPromoCode } = require('../routes/billing');
  const claim = await claimReferral(domain, email);
  if (!claim) return { sent: false };
  // Anti-abuse: a self-referral (signed up with your own ?ref=) earns nothing.
  if (claim.referredBy === (claim.newUserEmail || '').toLowerCase()) return { sent: false, selfReferral: true };
  const rewardMonths = 1;
  // Credit the inviter. If this fails transiently (recordReferralForInviter now
  // rethrows), RELEASE the claim so a later flush retries rather than silently
  // losing the reward. A genuinely-missing inviter returns {inviterExists:false}
  // (no throw) and is dropped below without a release.
  let rec;
  try {
    rec = await recordReferralForInviter(claim.referredBy, { newUserEmail: claim.newUserEmail, rewardMonths });
  } catch (err) {
    await releaseReferral(domain, email);
    return { sent: false, released: true };
  }
  // Nothing to email if the inviter never signed in, or we already credited
  // this referral on a prior flush.
  if (!rec.inviterExists || rec.already) return { sent: false, recorded: !!rec.inviterExists && !rec.already };
  // Mint the free-month coupon ONLY when the inviter is under the reward cap
  // (rewardEligible) — past the cap, attribution still accrued but no more
  // money-bearing codes. null when the Stripe coupon isn't configured.
  const promoCode = rec.rewardEligible ? await createReferralPromoCode(claim.referredBy) : null;
  if (promoCode) await recordReferralPromoCode(claim.referredBy, promoCode);
  // CAN-SPAM: never email a suppressed inviter (still credited above).
  if (await isEmailSuppressed(claim.referredBy)) return { sent: false, recorded: true, promoCode: promoCode || null };
  return sendReferralNotification({
    to: claim.referredBy,
    inviterName: rec.inviterDisplayName,
    newUserName: claim.newUserName || claim.newUserEmail,
    rewardMonths,
    totalReferrals: rec.totalReferrals,
    promoCode,
    rewarded: rec.rewardEligible,
  });
}

// Single flush point for both deferred per-signup notifications — the owner
// signup ping and the referrer credit/notify. Every trigger (post-signup grace
// timer, the source modal, the daily sweep) calls this so a call site can't
// forget one. Both underlying flushes are independently claimed + idempotent,
// and fired best-effort so a mail hiccup never blocks the caller.
function flushDeferredNotifications(domain, email) {
  maybeSendSignupNotification(domain, email).catch(() => { /* best-effort */ });
  maybeSendReferralNotification(domain, email).catch(() => { /* best-effort */ });
}

// Generic email send used by the admin "email from dashboard" feature.
// Returns { sent: true, id } or throws if Resend isn't configured.
async function sendAdminEmail({ to, subject, body }) {
  if (!to || !subject) throw new Error('to and subject are required');
  const text = body || '';
  const html = text.split('\n').map(l => `<p style="margin:0 0 12px;font-family:sans-serif;font-size:14px;line-height:1.5">${escape(l) || '&nbsp;'}</p>`).join('');
  return send({
    from: makeFrom('Derek Gallardo'),
    to,
    subject,
    text,
    html,
    replyTo: ownerEmail(),
    tags: [{ name: 'type', value: 'admin' }],
  });
}

// Weekly self-report email. Formats the report from firestore into something
// you can scan in 30 seconds Monday morning.
async function sendWeeklySelfReport(report) {
  if (!getResend()) return { skipped: 'Resend not configured' };
  const to = process.env.NOTIFY_EMAIL || ownerEmail();
  if (!to) return { skipped: 'no NOTIFY_EMAIL/owner' };

  const arrow = (s) => s.startsWith('+') ? `<span style="color:#16a34a">▲ ${s}</span>` : s.startsWith('-') ? `<span style="color:#dc2626">▼ ${s}</span>` : `<span style="color:#666">${s}</span>`;

  const newSignupsList = (report.signups.new || []).map(u =>
    `<li>${escape(u.displayName || u.email)} &lt;${escape(u.email)}&gt; — ${escape(u.domain)}${u.source ? ` (${escape(u.source)})` : ''}</li>`
  ).join('') || '<li style="color:#666">No new signups this week.</li>';

  const concernsList = (report.concerns || []).map(u =>
    `<li>${escape(u.displayName || u.email)} &lt;${escape(u.email)}&gt; — ${escape(u.domain)}, signed up 3-7d ago, never tracked</li>`
  ).join('') || '<li style="color:#16a34a">No churn-risk users this week 🎉</li>';

  const sourcesList = Object.entries(report.sources || {}).sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `<li>${escape(s)} — ${n}</li>`).join('') || '<li style="color:#666">No source data yet.</li>';

  const useCasesList = Object.entries(report.useCases || {}).sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `<li>${escape(s)} — ${n}</li>`).join('') || '<li style="color:#666">No survey responses yet.</li>';

  const topUserLine = report.topUser
    ? `${escape(report.topUser.displayName || report.topUser.email)} (${report.topUser.actions} actions)`
    : 'Nobody yet — quiet week.';

  const rt = report.retention;
  const remindersBreakdown = rt ? (Object.entries(rt.remindersThis || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${escape(k)} ${n}`).join(', ') || 'none') : '';
  const retentionHtml = rt ? `
      <h3 style="margin:0 0 6px">🔁 Retention</h3>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:14px">
        <li><b>Return rate:</b> ${rt.returnRate}% — ${rt.returned}/${rt.eligible} came back on a later day</li>
        <li><b>Retention nudges sent:</b> ${rt.remindersThisTotal} this week ${arrow(rt.remindersDelta || '0')} — ${remindersBreakdown}</li>
        <li><b>Silent dead-ends:</b> ${rt.deadEnds} user${rt.deadEnds === 1 ? '' : 's'} polled 5+ times but captured nobody (not the host)</li>
      </ul>` : '';

  const subject = `📊 Weekly Attendance Tracker report — ${report.signups.thisWeek} new signup${report.signups.thisWeek === 1 ? '' : 's'}, ${report.tracks.thisWeek} track${report.tracks.thisWeek === 1 ? '' : 's'}`;

  const html = `
    <div style="font-family:sans-serif;max-width:600px;color:#111">
      <h2 style="margin:0 0 6px;color:#4ade80">Week of ${new Date(report.windowStart).toLocaleDateString()} → ${new Date(report.windowEnd).toLocaleDateString()}</h2>
      <p style="color:#666;margin:0 0 16px">Snapshot: ${report.totalUsers} total users, ${report.totalMeetings} total meetings tracked.</p>
      <table style="border-collapse:collapse;width:100%;margin-bottom:18px;font-size:14px">
        <tr style="background:#f5f5f5"><th style="text-align:left;padding:8px">Metric</th><th style="text-align:right;padding:8px">This week</th><th style="text-align:right;padding:8px">Last week</th><th style="text-align:right;padding:8px">Change</th></tr>
        <tr><td style="padding:8px;border-top:1px solid #eee">Signups</td><td style="text-align:right;padding:8px;border-top:1px solid #eee">${report.signups.thisWeek}</td><td style="text-align:right;padding:8px;border-top:1px solid #eee">${report.signups.lastWeek}</td><td style="text-align:right;padding:8px;border-top:1px solid #eee">${arrow(report.signups.delta)}</td></tr>
        <tr><td style="padding:8px;border-top:1px solid #eee">Meetings tracked</td><td style="text-align:right;padding:8px;border-top:1px solid #eee">${report.tracks.thisWeek}</td><td style="text-align:right;padding:8px;border-top:1px solid #eee">${report.tracks.lastWeek}</td><td style="text-align:right;padding:8px;border-top:1px solid #eee">${arrow(report.tracks.delta)}</td></tr>
        <tr><td style="padding:8px;border-top:1px solid #eee">Exports</td><td style="text-align:right;padding:8px;border-top:1px solid #eee">${report.exports.thisWeek}</td><td style="text-align:right;padding:8px;border-top:1px solid #eee">${report.exports.lastWeek}</td><td style="text-align:right;padding:8px;border-top:1px solid #eee">${arrow(report.exports.delta)}</td></tr>
      </table>
      ${retentionHtml}
      <h3 style="margin:0 0 6px">⭐ Top user this week</h3>
      <p style="margin:0 0 16px;font-size:14px">${topUserLine}</p>

      <h3 style="margin:0 0 6px">🌱 New signups</h3>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:14px">${newSignupsList}</ul>

      <h3 style="margin:0 0 6px">⚠ Churn risk — check in this week</h3>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:14px">${concernsList}</ul>

      <h3 style="margin:0 0 6px">📡 Where they came from</h3>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:14px">${sourcesList}</ul>

      <h3 style="margin:0 0 6px">🎯 What they're using it for</h3>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:14px">${useCasesList}</ul>

      <p style="margin-top:24px;color:#666;font-size:12px"><a href="https://attendancetracker.dev/admin.html">Open admin dashboard →</a></p>
    </div>
  `;

  const text = [
    `Weekly Attendance Tracker report`,
    `Week of ${new Date(report.windowStart).toLocaleDateString()} → ${new Date(report.windowEnd).toLocaleDateString()}`,
    ``,
    `Signups:  ${report.signups.thisWeek} (was ${report.signups.lastWeek}, ${report.signups.delta})`,
    `Tracks:   ${report.tracks.thisWeek} (was ${report.tracks.lastWeek}, ${report.tracks.delta})`,
    `Exports:  ${report.exports.thisWeek} (was ${report.exports.lastWeek}, ${report.exports.delta})`,
    ...(rt ? [
      ``,
      `Retention:`,
      `  Return rate: ${rt.returnRate}% (${rt.returned}/${rt.eligible} came back)`,
      `  Nudges sent: ${rt.remindersThisTotal} (${rt.remindersDelta})`,
      `  Dead-ends:   ${rt.deadEnds}`,
    ] : []),
    ``,
    `Top user: ${topUserLine.replace(/<[^>]+>/g, '')}`,
    ``,
    `Use cases:`,
    ...Object.entries(report.useCases || {}).sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${s}: ${n}`),
    ``,
    `Admin: https://attendancetracker.dev/admin.html`,
  ].join('\n');

  return send({
    from: makeFrom('Attendance Tracker'),
    to,
    subject,
    text,
    html,
    tags: [{ name: 'type', value: 'weekly_report' }],
  });
}

// Fire-and-forget "your attendance is ready" email sent when an auto-export
// completes. Lands in the organizer's inbox so they always have the sheet
// link, even if they close the side panel and never look at it again. Now
// includes an inline attendance table so the email is actionable on its own
// — the user doesn't have to open the sheet to see what happened.
async function sendExportNotification({ to, displayName, sheetUrl, meetingTitle, totalAttended, totalInvited, exportedAt, participants, overflow, conferenceId, recurringEventId }) {
  if (!getResend()) return;
  const title = meetingTitle || 'Google Meet';
  const summary = totalInvited
    ? `${totalAttended} of ${totalInvited} attended`
    : `${totalAttended} attended`;
  const subject = `Attendance: ${title} — ${summary}`;
  const dateStr = exportedAt ? new Date(exportedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const greeting = displayName ? `Hi ${escape(displayName.split(' ')[0])},` : 'Hi,';

  // Inline attendance table. Color-codes status: green=present, amber=left
  // early, red=absent. Keeps the email scannable in 2 seconds.
  const statusColor = (s) => {
    if (s === 'Present') return '#16a34a';
    if (s === 'Left') return '#d97706';
    if (s === 'Excused') return '#6b7280'; // muted gray — excused isn't a problem
    return '#dc2626';
  };
  const fmtDur = (m) => !m ? '—' : hm(m);
  const tableRows = (participants || []).map(p => {
    const lateBadge = p.lateMin > 0
      ? ` <span style="background:rgba(245,158,11,.15);color:#b45309;border:1px solid rgba(245,158,11,.35);font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;margin-left:6px">+${p.lateMin}m late</span>`
      : '';
    return `
    <tr>
      <td style="padding:6px 10px;border-top:1px solid #eee">${escape(p.displayName || p.email || '—')}${lateBadge}${p.email && p.displayName ? `<div style="color:#888;font-size:11px">${escape(p.email)}</div>` : ''}</td>
      <td style="padding:6px 10px;border-top:1px solid #eee;color:${statusColor(p.status)};font-weight:600">${escape(p.status)}</td>
      <td style="padding:6px 10px;border-top:1px solid #eee;color:#666;text-align:right">${escape(fmtDur(p.durationMin))}</td>
    </tr>
  `;
  }).join('');
  const overflowRow = overflow > 0
    ? `<tr><td colspan="3" style="padding:8px 10px;border-top:1px solid #eee;color:#888;font-size:12px;font-style:italic">…and ${overflow} more in the sheet</td></tr>`
    : '';
  const tableHtml = participants?.length ? `
    <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:13px">
      <thead>
        <tr style="background:#f5f5f5">
          <th style="text-align:left;padding:8px 10px;font-size:11px;color:#666;text-transform:uppercase">Person</th>
          <th style="text-align:left;padding:8px 10px;font-size:11px;color:#666;text-transform:uppercase">Status</th>
          <th style="text-align:right;padding:8px 10px;font-size:11px;color:#666;text-transform:uppercase">Time</th>
        </tr>
      </thead>
      <tbody>${tableRows}${overflowRow}</tbody>
    </table>
  ` : '';

  // Web deep links: jump straight to this meeting (or its series) in
  // history.html. Hash-based so they survive any URL shape.
  const meetingLink = conferenceId
    ? `https://attendancetracker.dev/history.html#meeting=${encodeURIComponent(conferenceId)}`
    : 'https://attendancetracker.dev/history.html';
  const seriesLink = recurringEventId
    ? `https://attendancetracker.dev/history.html#series=${encodeURIComponent(recurringEventId)}`
    : null;
  const reviewUrl = `${CONFIG.publicApiUrl}/public/review-click?email=${encodeURIComponent(to)}&source=export_email`;

  const html = `
    <div style="font-family:sans-serif;max-width:600px;color:#111;font-size:14px;line-height:1.5">
      <p>${greeting}</p>
      <p>Your meeting just ended — attendance has been auto-exported.</p>
      <table style="border-collapse:collapse;margin:8px 0;font-size:14px">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Meeting</td><td>${escape(title)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Attendance</td><td>${escape(summary)}</td></tr>
        ${dateStr ? `<tr><td style="padding:4px 12px 4px 0;color:#666">When</td><td>${escape(dateStr)}</td></tr>` : ''}
      </table>
      ${tableHtml}
      <p style="margin-top:18px">
        <a href="${escape(sheetUrl)}" style="display:inline-block;background:#1f6feb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;margin-right:8px">Open sheet</a>
        <a href="${escape(meetingLink)}" style="display:inline-block;color:#1f6feb;padding:10px 4px;text-decoration:none;font-weight:600">View on web →</a>
      </p>
      ${seriesLink ? `<p style="margin-top:8px;font-size:13px;color:#666">This is part of a recurring series — <a href="${escape(seriesLink)}" style="color:#1f6feb">see the full trend →</a></p>` : ''}
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;margin:20px 0;text-align:left">
        <div style="font-weight:600;color:#1e293b;font-size:13px;margin-bottom:3px">⭐ Did this save you time today?</div>
        <div style="font-size:12px;color:#64748b;margin-bottom:10px;line-height:1.4">If Attendance Tracker helped your call, could you spare 10 seconds to leave a 5-star review on Google Marketplace? It helps independent creators like me keep building for educators!</div>
        <a href="${escape(reviewUrl)}" style="display:inline-block;background:#f59e0b;color:#111;font-size:12px;font-weight:700;padding:6px 14px;border-radius:6px;text-decoration:none">Leave a 5-Star Review (takes 10s) →</a>
      </div>
      <p style="color:#666;font-size:12px;margin-top:24px">
        You're getting this because you tracked this meeting with Attendance Tracker.
        The sheet lives in your Drive folder "Meet Attendance Tracker" — reuse the same
        spreadsheet next time, each meeting gets its own tab.
      </p>
    </div>
  `;

  const textRows = (participants || []).map(p => `  ${(p.displayName || p.email || '—').padEnd(28)} ${p.status.padEnd(8)} ${fmtDur(p.durationMin)}`).join('\n');
  const text = [
    `${displayName ? 'Hi ' + displayName.split(' ')[0] + ',' : 'Hi,'}`,
    ``,
    `Your meeting just ended — attendance has been auto-exported.`,
    ``,
    `Meeting: ${title}`,
    `Attendance: ${summary}`,
    dateStr ? `When: ${dateStr}` : '',
    ``,
    participants?.length ? `${textRows}${overflow > 0 ? `\n  ...and ${overflow} more in the sheet` : ''}` : '',
    ``,
    `Open sheet: ${sheetUrl}`,
    `View on web: ${meetingLink}`,
    seriesLink ? `Series trend: ${seriesLink}` : '',
    ``,
    `Did this save you time today? Leave a quick 5-star review (takes 10s):`,
    reviewUrl,
  ].filter(Boolean).join('\n');

  return dispatchEmail({
    from: makeFrom('Attendance Tracker'),
    to, subject, text, html,
    tags: [{ name: 'type', value: 'export_notification' }],
  }, 'export notification', { sheetUrl });
}

// Daily series attendance alert. Batched: one email per user per day,
// listing every triggered rule across all their series. The point is to
// give the user a reason to come back to the product — so the CTA is a
// "View series →" link, not a static report.
async function sendSeriesAlertEmail({ to, displayName, alerts }) {
  if (!getResend()) return { skipped: 'Resend not configured' };
  if (!alerts?.length) return { skipped: 'no alerts' };

  const subject = alerts.length === 1
    ? `Attendance alert: ${alerts[0].personName || alerts[0].personEmail || 'Someone'} ${alerts[0].detail}`
    : `${alerts.length} attendance alerts from your recurring meetings`;

  const greeting = displayName ? `Hi ${escape(displayName.split(' ')[0])},` : 'Hi,';
  const leadHtml = alerts.length === 1
    ? `There's an attendance change in one of your recurring meetings:`
    : `There are ${alerts.length} attendance changes across your recurring meetings:`;

  const itemHtml = alerts.map(a => `
    <li style="margin-bottom:12px">
      <strong>${escape(a.personName || a.personEmail || 'Someone')}</strong> ${escape(a.detail)}.
      <div style="color:#666;font-size:12px;margin-top:2px">${a.attended} of ${a.instanceCount} instances attended overall</div>
    </li>
  `).join('');

  const html = `
    <div style="font-family:sans-serif;max-width:560px;color:#111;font-size:14px;line-height:1.5">
      <p>${greeting}</p>
      <p>${leadHtml}</p>
      <ul style="padding-left:18px;margin:14px 0">${itemHtml}</ul>
      <p style="margin-top:20px"><a href="https://attendancetracker.dev/history.html" style="display:inline-block;background:#1f6feb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">View series →</a></p>
      <p style="color:#666;font-size:12px;margin-top:24px">
        You're getting this because you tracked recurring meetings with Attendance Tracker.
        Alerts run once per day if there's something worth flagging — no email if there's nothing new.
      </p>
      ${unsubscribeFooter(to).html}
    </div>
  `;
  const text = [
    displayName ? `Hi ${displayName.split(' ')[0]},` : 'Hi,',
    '',
    alerts.length === 1
      ? "There's an attendance change in one of your recurring meetings:"
      : `There are ${alerts.length} attendance changes across your recurring meetings:`,
    '',
    ...alerts.map(a => `  - ${a.personName || a.personEmail || 'Someone'} ${a.detail}. (${a.attended}/${a.instanceCount})`),
    '',
    'View series: https://attendancetracker.dev/history.html',
    unsubscribeFooter(to).text,
  ].join('\n');

  return dispatchEmail({
    from: makeFrom('Attendance Tracker'),
    to, subject, text, html,
    tags: [{ name: 'type', value: 'series_alert' }],
  }, 'series alert email', { alertCount: alerts.length });
}

// In-product feedback widget submissions. Lands in your inbox with full
// context (user email, where they were in the app, what they wrote) so you
// can reply quickly. Throws on failure — caller decides whether to retry.
async function sendFeedbackEmail({ body, fromEmail, fromName, source, conferenceId, userAgent }) {
  if (!body) throw new Error('body is required');
  const to = process.env.NOTIFY_EMAIL || ownerEmail();
  if (!to) throw new Error('NOTIFY_EMAIL or GMAIL_USER must be set as the destination inbox');
  const subjectName = fromName || fromEmail || 'Anonymous';
  const subject = `💬 Feedback from ${subjectName}: ${String(body).slice(0, 60).replace(/\s+/g, ' ')}${body.length > 60 ? '…' : ''}`;
  const html = `
    <div style="font-family:sans-serif;max-width:560px;color:#111;font-size:14px;line-height:1.5">
      <p style="white-space:pre-wrap;border-left:3px solid #4ade80;padding:0 0 0 14px;margin:0">${escape(body)}</p>
      <table style="border-collapse:collapse;margin-top:18px;font-size:13px;color:#666">
        <tr><td style="padding:3px 12px 3px 0">From</td><td>${escape(fromName || '')} ${fromEmail ? `&lt;<a href="mailto:${escape(fromEmail)}">${escape(fromEmail)}</a>&gt;` : '(no email)'}</td></tr>
        ${source ? `<tr><td style="padding:3px 12px 3px 0">Source</td><td>${escape(source)}</td></tr>` : ''}
        ${conferenceId ? `<tr><td style="padding:3px 12px 3px 0">Meeting</td><td><code>${escape(conferenceId)}</code></td></tr>` : ''}
        ${userAgent ? `<tr><td style="padding:3px 12px 3px 0">User agent</td><td style="font-size:11px">${escape(userAgent)}</td></tr>` : ''}
      </table>
    </div>
  `;
  const text = [
    body,
    '',
    '---',
    `From: ${fromName || ''} ${fromEmail ? '<' + fromEmail + '>' : ''}`.trim(),
    source ? `Source: ${source}` : '',
    conferenceId ? `Meeting: ${conferenceId}` : '',
  ].filter(Boolean).join('\n');

  return send({
    from: makeFrom('Attendance Tracker feedback'),
    to,
    subject,
    text,
    html,
    replyTo: fromEmail || ownerEmail(),
    tags: [{ name: 'type', value: 'feedback' }],
  });
}

// Re-engagement / lifecycle emails feel like a personal check-in, not a product
// notification: From-name "Derek Gallardo" (not "Attendance Tracker"), plain
// prose paragraphs, reply-to the owner inbox, and a one-click unsubscribe
// footer. This helper captures that shared scaffold; each caller only supplies
// the subject, the body lines, and a Resend tag.
//
// - `lines` are the body paragraphs; the "Hey {firstName}," greeting + blank
//   line are prepended automatically.
// - `htmlLineTransform(line)` optionally returns custom HTML for a given line
//   (e.g. turning a "Your series so far:" line into a link); return falsy to
//   use the default paragraph rendering.
const emailParagraph = (l) =>
  `<p style="margin:0 0 12px;font-family:sans-serif;font-size:14px;line-height:1.55;color:#111">${escape(l) || '&nbsp;'}</p>`;

async function sendPersonalEmail({ to, displayName, subject, lines, tags, htmlLineTransform, logLabel, logMeta }) {
  if (!getResend()) return { skipped: 'Resend not configured' };
  const firstName = displayName ? displayName.split(' ')[0] : null;
  const hi = firstName ? `Hey ${firstName},` : 'Hey,';
  const body = [hi, '', ...lines].join('\n');

  const foot = unsubscribeFooter(to);
  const html = body.split('\n')
    .map(l => (htmlLineTransform && htmlLineTransform(l)) || emailParagraph(l))
    .join('') + foot.html;

  return dispatchEmail({
    from: makeFrom('Derek Gallardo'),
    to, subject,
    text: body + foot.text,
    html,
    replyTo: ownerEmail(),
    tags,
  }, `${logLabel} email`, logMeta);
}

async function sendWelcomeEmail({ to, displayName }) {
  const lines = [
    `Thanks for installing Attendance Tracker for Google Meet!`,
    '',
    `Here is how to track your first meeting in 3 quick steps:`,
    '',
    `1. Open Google Meet and start or join any call.`,
    `2. Click the Activities icon (shapes in the bottom-right corner) and open Attendance Tracker.`,
    `3. Click "Start" — join times, leave times, and stay durations update live. When you're ready, click "Sheet" to export to Google Sheets in one click.`,
    '',
    `Tip: If you're testing right now in an empty call, click "Testing solo? Load 10 demo students" inside the side panel to see how it works before your next real meeting.`,
    '',
    `Watch the 30-second video demo: https://youtu.be/WqX-LxjjY04`,
    '',
    `If you have any questions or run into anything, just reply directly to this email — I read every response.`,
    '',
    'Best,',
    'Derek',
    'Creator of Attendance Tracker',
    'https://attendancetracker.dev',
  ];
  return sendPersonalEmail({
    to, displayName,
    subject: 'Welcome to Attendance Tracker for Google Meet',
    lines,
    tags: [{ name: 'type', value: 'welcome' }],
    logLabel: 'welcome', logMeta: {},
  });
}

async function sendReactivationEmail({ to, displayName, daysSinceLogin, variant }) {
  const lines = variant === '7d' ? [
    `It's been about a week since you last opened Attendance Tracker. Quick question — was there something missing or confusing that kept you from using it for your meetings?`,
    '',
    `If you've got two minutes, hit reply and tell me what you'd want to see. I'm building this for actual users, not in a vacuum.`,
    '',
    '— Derek',
    'attendancetracker.dev',
  ] : [
    `You signed up for Attendance Tracker about a month ago and haven't been back. Two questions:`,
    '',
    `1) Was the product missing something? If you'd reply with what would've made it useful for your workflow, I'd genuinely appreciate the signal.`,
    '',
    `2) If you'd rather I delete your account and any stored data, just say the word — no hard feelings.`,
    '',
    'Either way is fine. I just want to know.',
    '',
    '— Derek',
  ];
  return sendPersonalEmail({
    to, displayName,
    subject: variant === '7d' ? 'Quick check-in on Attendance Tracker' : 'Should I delete your Attendance Tracker account?',
    lines,
    tags: [{ name: 'type', value: 'reactivation' }, { name: 'variant', value: variant }],
    logLabel: 'reactivation', logMeta: { variant, daysSinceLogin },
  });
}

// Activation nudge for people who signed up but never tracked a meeting — a
// short how-to-start, not a win-back.
async function sendActivationNudgeEmail({ to, displayName, daysSinceLogin }) {
  return sendPersonalEmail({
    to, displayName,
    subject: 'Getting started with Attendance Tracker',
    lines: [
      "You signed up for Attendance Tracker but haven't taken attendance in a meeting yet. It takes about 30 seconds:",
      '',
      '1. Start or join a Google Meet.',
      '2. Open Attendance Tracker from the Activities panel (bottom-right in Meet).',
      '3. Press Start — it tracks who joins, who leaves, and how long they stayed, then exports to a Google Sheet when the meeting ends.',
      '',
      "If something got in the way — setup, permissions, or it just didn't fit — hit reply and tell me. I read every one.",
      '',
      '— Derek',
      'attendancetracker.dev',
    ],
    tags: [{ name: 'type', value: 'activation_nudge' }],
    logLabel: 'activation nudge', logMeta: { daysSinceLogin },
  });
}

// For users who tried the tool but only on a solo test — move them from "tested
// it on myself" to "used it in a real meeting".
async function sendSoloNudgeEmail({ to, displayName, daysSinceLogin }) {
  return sendPersonalEmail({
    to, displayName,
    subject: 'You tried Attendance Tracker solo — try it with a real meeting',
    lines: [
      "I noticed you gave Attendance Tracker a spin, but it looks like the meeting was just you. That's the perfect way to kick the tires — but it really earns its keep when other people are in the call.",
      '',
      "Next time you're in a real one — a class, a standup, a client call — open the panel and hit Start. It'll show you exactly who joined, who left, who was late, and drop the whole roll-call into a Google Sheet when the meeting ends.",
      '',
      "If something's getting in the way of using it for real, hit reply and tell me — that feedback is gold.",
      '',
      '— Derek',
      'attendancetracker.dev',
    ],
    tags: [{ name: 'type', value: 'solo_nudge' }],
    logLabel: 'solo nudge', logMeta: { daysSinceLogin },
  });
}

async function sendForgottenMeetingEmail({ to, displayName, seriesTitle, recurringEventId, trackedInWindow, daysSinceLast }) {
  const seriesLink = recurringEventId
    ? `https://attendancetracker.dev/history.html#series=${encodeURIComponent(recurringEventId)}`
    : 'https://attendancetracker.dev/history.html';
  return sendPersonalEmail({
    to, displayName,
    subject: `Forgot to track "${seriesTitle}"?`,
    lines: [
      `You tracked "${seriesTitle}" ${trackedInWindow} times in the past month, but it's been ${daysSinceLast} days since the last one. If you want to keep the streak going, just open the Attendance Tracker side panel next time you're in that meeting — it picks up from where you left off.`,
      '',
      `Your series so far: ${seriesLink}`,
      '',
      '— Derek',
    ],
    // Render the series line as a link instead of a bare URL.
    htmlLineTransform: (l) => l.startsWith('Your series so far:')
      ? `<p style="margin:0 0 12px;font-family:sans-serif;font-size:14px;line-height:1.55;color:#111">Your series so far: <a href="${escape(seriesLink)}" style="color:#1f6feb">view the trend →</a></p>`
      : null,
    tags: [{ name: 'type', value: 'forgotten_meeting' }],
    logLabel: 'forgotten-meeting', logMeta: { recurringEventId, daysSinceLast },
  });
}

// Meeting-specific win-back for an activated user who tracked a one-off meeting
// and went quiet — the "come back and track your next one" nudge that a
// non-recurring tracker (e.g. a single class) previously never got (only the
// generic reactivation email). Fires once via the comeback_7d dedup slot.
async function sendComebackEmail({ to, displayName, meetingTitle, daysSinceLogin }) {
  const historyLink = 'https://attendancetracker.dev/history.html';
  const title = meetingTitle || 'your last meeting';
  return sendPersonalEmail({
    to, displayName,
    subject: 'Track your next meeting?',
    lines: [
      `It's been about ${daysSinceLogin} days since you tracked "${title}". Next time you're in a meeting, just open the Attendance Tracker side panel — it captures who joined, who left, and how long they stayed, then exports to Sheets in one click.`,
      '',
      'One tip: if it\'s a class or meeting that repeats, put it on a recurring Google Calendar invite — then you get per-person attendance trends across every session, not just a single day.',
      '',
      `Your history: ${historyLink}`,
      '',
      '— Derek',
    ],
    htmlLineTransform: (l) => l.startsWith('Your history:')
      ? `<p style="margin:0 0 12px;font-family:sans-serif;font-size:14px;line-height:1.55;color:#111">Your history: <a href="${escape(historyLink)}" style="color:#1f6feb">open your dashboard →</a></p>`
      : null,
    tags: [{ name: 'type', value: 'comeback_7d' }],
    logLabel: 'comeback', logMeta: { daysSinceLogin },
  });
}

// Export-gap win-back: the user tracked a real (multi-person) meeting but never
// saved the report — the Google Sheet is the payoff they missed. Point them
// straight at exporting (and auto-export) rather than a generic come-back.
// Fires once via the export_gap dedup slot.
async function sendExportGapEmail({ to, displayName, meetingTitle, daysSinceLogin }) {
  const historyLink = 'https://attendancetracker.dev/history.html';
  const title = meetingTitle || 'your class';
  return sendPersonalEmail({
    to, displayName,
    subject: 'Your attendance report is one click away',
    lines: [
      `You tracked "${title}" about ${daysSinceLogin} days ago, but never saved the report. Next time you're in that meeting, open the Attendance Tracker side panel and hit Export — you'll get a clean Google Sheet with who joined, who left, and how long they stayed. (Turn on auto-export in Settings and it happens automatically when the meeting ends.)`,
      '',
      `Your history: ${historyLink}`,
      '',
      '— Derek',
    ],
    htmlLineTransform: (l) => l.startsWith('Your history:')
      ? `<p style="margin:0 0 12px;font-family:sans-serif;font-size:14px;line-height:1.55;color:#111">Your history: <a href="${escape(historyLink)}" style="color:#1f6feb">open your dashboard →</a></p>`
      : null,
    tags: [{ name: 'type', value: 'export_gap' }],
    logLabel: 'export-gap', logMeta: { daysSinceLogin },
  });
}

// Pre-meeting reminder for a recurring series the user tracks but has been
// slipping on — fired shortly before the next scheduled instance so it's
// actionable ("open the panel when you join"). Self-limiting: the sweep only
// qualifies LAPSING series, so reliable trackers never get these. Once per
// calendar instance; honors the standard unsubscribe footer.
async function sendUpcomingMeetingEmail({ to, displayName, meetingTitle, minutesUntil }) {
  const when = minutesUntil <= 1 ? 'is starting now' : `starts in about ${minutesUntil} minutes`;
  return sendPersonalEmail({
    to, displayName,
    subject: `Reminder: "${meetingTitle}" ${minutesUntil <= 1 ? 'is starting' : 'starts soon'}`,
    lines: [
      `Your recurring meeting "${meetingTitle}" ${when}. When you join, open the Attendance Tracker side panel and it'll capture who's there — then export the report in one click (or let it auto-export when the meeting ends).`,
      '',
      "You're getting this because you've tracked this meeting before but not in the last few days — just a nudge so it doesn't slip.",
      '',
      '— Derek',
    ],
    tags: [{ name: 'type', value: 'upcoming_reminder' }],
    logLabel: 'upcoming-reminder', logMeta: { minutesUntil },
  });
}

// ── Slack post-meeting digest ──
// Posts a Block Kit message to a user-configured Slack incoming webhook
// after every export. Fire-and-forget: failures are logged but don't break
// the export flow. The webhook URL is a bearer-token secret in the URL
// path, so we never log the full URL — only the masked form.


// Build the Block Kit payload. Pulled out for testability.
function buildSlackDigestBlocks({ meetingTitle, totalAttended, totalInvited, participants, sheetUrl, durationMin, startTime }) {
  const title = meetingTitle || 'Google Meet';
  const attendanceSummary = totalInvited
    ? `*${totalAttended} of ${totalInvited} attended*`
    : `*${totalAttended} attended*`;
  const durStr = durationMin ? hm(durationMin) : '';
  const timeStr = startTime ? new Date(startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
  const metaLine = [attendanceSummary, durStr, timeStr ? `started ${timeStr}` : ''].filter(Boolean).join(' · ');

  // Bucket participants by status. Cap each bucket at 8 names + overflow.
  const cap = 8;
  const present = (participants || []).filter(p => p.status === 'Present').map(p => p.displayName || p.email || '?');
  const left = (participants || []).filter(p => p.status === 'Left').map(p => p.displayName || p.email || '?');
  const absent = (participants || []).filter(p => p.status === 'Absent' || p.status === 'Excused').map(p => `${p.displayName || p.email || '?'}${p.status === 'Excused' ? ' (excused)' : ''}`);

  const formatBucket = (names, total) => {
    // Callers only invoke formatBucket for non-empty buckets (guarded by
    // `if (bucket.length)` below), so the empty branch is defensive-only.
    /* istanbul ignore next */
    if (names.length === 0) return '_none_';
    const shown = names.slice(0, cap).join(', ');
    return total > cap ? `${shown}, +${total - cap} more` : shown;
  };

  const fields = [];
  if (present.length) fields.push({ type: 'mrkdwn', text: `*✅ Present (${present.length})*\n${formatBucket(present, present.length)}` });
  if (left.length) fields.push({ type: 'mrkdwn', text: `*🟡 Left early (${left.length})*\n${formatBucket(left, left.length)}` });
  if (absent.length) fields.push({ type: 'mrkdwn', text: `*❌ Absent (${absent.length})*\n${formatBucket(absent, absent.length)}` });

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `📊 ${title}`.slice(0, 150) } },
    { type: 'section', text: { type: 'mrkdwn', text: metaLine } },
  ];
  if (fields.length) blocks.push({ type: 'section', fields });
  if (sheetUrl) {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open sheet' }, url: sheetUrl }],
    });
  }
  return blocks;
}

// Fallback plain-text body for Slack clients that don't render blocks.
function buildSlackFallbackText({ meetingTitle, totalAttended, totalInvited, sheetUrl }) {
  const title = meetingTitle || 'Google Meet';
  const summary = totalInvited ? `${totalAttended} of ${totalInvited} attended` : `${totalAttended} attended`;
  return `📊 ${title} — ${summary}${sheetUrl ? '\nOpen sheet: ' + sheetUrl : ''}`;
}

async function sendSlackDigest({ webhookUrl, meetingTitle, totalAttended, totalInvited, participants, sheetUrl, durationMin, startTime }) {
  if (!webhookUrl) return { sent: false, reason: 'no_webhook' };
  const blocks = buildSlackDigestBlocks({ meetingTitle, totalAttended, totalInvited, participants, sheetUrl, durationMin, startTime });
  const text = buildSlackFallbackText({ meetingTitle, totalAttended, totalInvited, sheetUrl });
  const body = JSON.stringify({ text, blocks });

  try {
    const res = await postJsonWithTimeout(webhookUrl, body);
    if (!res.ok) {
      const respText = await res.text().catch(() => '');
      log.warn('slack digest send failed', { webhook: maskSlackWebhook(webhookUrl), status: res.status, response: respText.slice(0, 200) });
      return { sent: false, status: res.status };
    }
    log.info('slack digest sent', { webhook: maskSlackWebhook(webhookUrl), meetingTitle });
    return { sent: true };
  } catch (err) {
    log.warn('slack digest exception', { webhook: maskSlackWebhook(webhookUrl), error: err.message });
    return { sent: false, error: err.message };
  }
}

// Test-only ping used by the settings modal's "Test" button to verify a
// webhook is reachable + posts correctly. Same Block Kit machinery but
// minimal payload.
async function sendSlackTestPing({ webhookUrl }) {
  if (!webhookUrl) return { sent: false, reason: 'no_webhook' };
  try {
    const res = await postJsonWithTimeout(webhookUrl, JSON.stringify({
      text: '✅ Attendance Tracker is connected. Future meeting digests will land in this channel.',
    }));
    if (!res.ok) {
      const respText = await res.text().catch(() => '');
      return { sent: false, status: res.status, response: respText.slice(0, 200) };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendSignupWebhook, maybeSendSignupNotification, sendWelcomeEmail, sendReferralNotification, maybeSendReferralNotification, flushDeferredNotifications, sendAdminEmail, sendWeeklySelfReport, sendExportNotification,
  sendSeriesAlertEmail, sendFeedbackEmail, sendReactivationEmail, sendActivationNudgeEmail, sendSoloNudgeEmail, sendForgottenMeetingEmail, sendComebackEmail, sendExportGapEmail, sendUpcomingMeetingEmail,
  sendSlackDigest, sendSlackTestPing, buildSlackDigestBlocks, buildSlackFallbackText, maskSlackWebhook,
  unsubscribeUrl, unsubscribeToken, verifyUnsubscribeToken, unsubscribeFooter,
};
