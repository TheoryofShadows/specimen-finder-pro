'use strict';

const express = require('express');
const { randomUUID } = require('crypto');
const {
  hashPassword,
  verifyPassword,
  signToken,
  setAuthCookie,
  clearAuthCookie,
  requireAuth,
} = require('./auth');
const { searchLimit, isPro, canExport, canBatch } = require('./plans');
const { layout, escapeHtml } = require('./html');
const { pullForQuery, toCsv, referenceLinks } = require('./gbif');

const FREE_TOOL = 'https://theoryofshadows.github.io/specimen-finder/';
const FREE_REPO = 'https://github.com/TheoryofShadows/specimen-finder';
const PRO_LOOKUP = 'specimen-finder-pro';
const PRO_CENTS = 400;

async function resolveProPrice(stripe) {
  try {
    const listed = await stripe.prices.list({ lookup_keys: [PRO_LOOKUP], active: true, limit: 1 });
    const hit = (listed.data || []).find((p) => p.unit_amount === PRO_CENTS);
    if (hit) return hit.id;
  } catch (err) {
    console.error('[stripe price lookup]', err.message);
  }
  return process.env.STRIPE_PRICE_PRO || '';
}

function wantsJson(req) {
  return req.path.startsWith('/api') || req.accepts(['json', 'html']) === 'json';
}

function createUser(db, email, password) {
  if (!email || password.length < 8) {
    const err = new Error('Email and password (8+ chars) required');
    err.status = 400;
    throw err;
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    const err = new Error('Email already registered');
    err.status = 409;
    throw err;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, plan) VALUES (?, ?, ?, 'free')`
  ).run(id, email, hashPassword(password));
  return db.prepare('SELECT id, email, plan FROM users WHERE id = ?').get(id);
}

function searchCount(db, userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM searches WHERE user_id = ?').get(userId).c;
}

function getOwnedSearch(db, userId, searchId) {
  return db
    .prepare('SELECT * FROM searches WHERE id = ? AND user_id = ?')
    .get(searchId, userId);
}

function parseLastFetch(search) {
  if (!search.last_fetch_json) return null;
  try {
    return JSON.parse(search.last_fetch_json);
  } catch {
    return null;
  }
}

function insertSearch(db, user, query, notes) {
  const q = String(query || '').trim().slice(0, 200);
  const n = String(notes || '').slice(0, 4000);
  if (!q) {
    const err = new Error('Species query required');
    err.status = 400;
    throw err;
  }
  const count = searchCount(db, user.id);
  const limit = searchLimit(user.plan);
  if (count >= limit) {
    const err = new Error(
      user.plan === 'free'
        ? 'Free tier allows 3 saved searches. Upgrade to Pro for unlimited.'
        : 'Search limit reached'
    );
    err.status = 403;
    throw err;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO searches (id, user_id, query, notes) VALUES (?, ?, ?, ?)`).run(
    id,
    user.id,
    q,
    n
  );
  return db.prepare('SELECT * FROM searches WHERE id = ?').get(id);
}

function createRouter(db, stripe) {
  const router = express.Router();
  const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'specimen-finder-pro' });
  });

  router.get('/', (req, res) => {
    if (req.user) return res.redirect('/dashboard');
    const body = `
      <section class="hero">
        <p class="eyebrow">Hosted upgrade · $4/mo</p>
        <h1>Keep specimen work in one place.</h1>
        <p class="lead">The free browser tool stays free. Pro is a hosted account for saved GBIF pulls, private notes, and CSV/JSON export — not photo ID, not a data store you can resell.</p>
        <div class="cta">
          <a class="btn" href="/signup">Start free</a>
          <a class="btn secondary" href="/login">Log in</a>
          <a class="btn secondary" href="${FREE_TOOL}" target="_blank" rel="noopener">Open the free tool</a>
        </div>
      </section>
      <div class="grid">
        <div class="card">
          <h3>Free account</h3>
          <p class="muted">$0</p>
          <ul class="pricing">
            <li>Email + password account</li>
            <li>Up to 3 saved species searches</li>
            <li>Private notes on each search</li>
            <li>Server-side GBIF specimen pull</li>
          </ul>
        </div>
        <div class="card">
          <h3>Pro</h3>
          <p class="muted">$4 / month</p>
          <ul class="pricing">
            <li>Unlimited saved searches</li>
            <li>CSV + JSON export of last fetch</li>
            <li>Batch species list</li>
            <li>Private per-specimen annotations</li>
          </ul>
        </div>
      </div>
      <div class="card">
        <h3>What Pro is — and is not</h3>
        <p>Paid value is the <strong>hosted workflow</strong>: accounts, saved searches, GBIF specimen pulls with attribution, private notes, and exports of <em>your</em> last fetch.</p>
        <p>The open tool remains at <a href="${FREE_TOOL}">theoryofshadows.github.io/specimen-finder</a> (<a href="${FREE_REPO}">source</a>). This product does not paywall it, does not include photo identification, and does not sell or redistribute third-party observation or publisher content.</p>
        <p class="muted">Context links on result pages go to Wikipedia, Wikidata, Plants of the World Online (Kew), and GBIF species pages.</p>
      </div>`;
    res.type('html').send(layout({ title: 'Hosted GBIF workflow', user: null, body }));
  });

  router.get('/signup', (req, res) => {
    if (req.user) return res.redirect('/dashboard');
    const err = req.query.error ? `<p class="error">${escapeHtml(req.query.error)}</p>` : '';
    const body = `
      <h1>Sign up</h1>
      <div class="card">
        ${err}
        <form class="stack" method="post" action="/signup">
          <label>Email</label>
          <input type="email" name="email" required autocomplete="email" />
          <label>Password (min 8 characters)</label>
          <input type="password" name="password" required minlength="8" autocomplete="new-password" />
          <button class="primary" type="submit">Create account</button>
        </form>
        <p class="muted">Already have an account? <a href="/login">Log in</a></p>
      </div>`;
    res.type('html').send(layout({ title: 'Sign up', user: null, body }));
  });

  router.post('/signup', (req, res) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const user = createUser(db, email, password);
      setAuthCookie(res, signToken(user));
      res.redirect('/dashboard');
    } catch (err) {
      res.redirect('/signup?error=' + encodeURIComponent(err.message));
    }
  });

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect('/dashboard');
    const err = req.query.error ? `<p class="error">${escapeHtml(req.query.error)}</p>` : '';
    const body = `
      <h1>Log in</h1>
      <div class="card">
        ${err}
        <form class="stack" method="post" action="/login">
          <label>Email</label>
          <input type="email" name="email" required autocomplete="email" />
          <label>Password</label>
          <input type="password" name="password" required autocomplete="current-password" />
          <button class="primary" type="submit">Log in</button>
        </form>
        <p class="muted">No account? <a href="/signup">Sign up</a></p>
      </div>`;
    res.type('html').send(layout({ title: 'Log in', user: null, body }));
  });

  router.post('/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password'));
    }
    setAuthCookie(res, signToken(user));
    res.redirect('/dashboard');
  });

  router.post('/logout', (_req, res) => {
    clearAuthCookie(res);
    res.redirect('/');
  });

  router.get('/dashboard', requireAuth, (req, res) => {
    const searches = db
      .prepare('SELECT * FROM searches WHERE user_id = ? ORDER BY created_at DESC')
      .all(req.user.id);
    const limit = searchLimit(req.user.plan);
    const limitLabel = Number.isFinite(limit) ? String(limit) : 'unlimited';
    const canAdd = searches.length < limit;
    const flash =
      req.query.upgraded === '1'
        ? 'Welcome to Pro — unlimited saved searches, batch lists, and CSV/JSON export are unlocked.'
        : null;
    const err = req.query.error ? `<p class="error">${escapeHtml(req.query.error)}</p>` : '';
    const ok = req.query.ok ? `<p class="ok">${escapeHtml(req.query.ok)}</p>` : '';

    const upgradeCard =
      req.user.plan === 'pro'
        ? `<div class="card"><p class="ok">Plan: <strong>Pro</strong> (${searches.length} saved searches, unlimited)</p></div>`
        : `<div class="card">
            <p>Plan: <strong>Free</strong> (${searches.length}/${limitLabel} saved searches). Pro unlocks unlimited searches, batch lists, and CSV/JSON export.</p>
            <form method="post" action="/billing/checkout"><button class="primary" type="submit">Upgrade to Pro — $4/mo</button></form>
            <p class="muted">Stripe Checkout. The free open tool is unchanged.</p>
          </div>`;

    const addForm = canAdd
      ? `<div class="card">
          <h3>Save a search</h3>
          ${err}
          <form class="stack" method="post" action="/searches">
            <label>Species query (scientific or common name)</label>
            <input name="query" required maxlength="200" placeholder="Sarracenia purpurea" />
            <label>Private notes (optional)</label>
            <textarea name="notes" maxlength="4000" rows="3" placeholder="Why you are tracking this species…"></textarea>
            <button class="primary" type="submit">Save search</button>
          </form>
        </div>`
      : `<div class="card">${err}<p class="muted">Saved-search limit reached for your plan.${
          req.user.plan === 'free' ? ' Upgrade to Pro for unlimited.' : ''
        }</p></div>`;

    const batchForm =
      req.user.plan === 'pro'
        ? `<div class="card">
            <h3>Batch species list</h3>
            <p class="muted">One species per line. Each line becomes a saved search (notes optional after a tab or " — ").</p>
            <form class="stack" method="post" action="/searches/batch">
              <textarea name="list" required rows="6" placeholder="Sarracenia purpurea&#10;Asclepias incarnata&#10;Dionaea muscipula"></textarea>
              <button class="primary" type="submit">Add list</button>
            </form>
          </div>`
        : `<div class="card">
            <h3>Batch species list</h3>
            <p class="muted">Pro only. Upgrade to paste a list of species and save them in one go.</p>
          </div>`;

    const rows = searches
      .map((s) => {
        const fetched = s.last_fetch_at
          ? `${s.last_fetch_count ?? 0} records · ${escapeHtml(s.last_fetch_at)}`
          : 'not fetched yet';
        const name = s.scientific_name
          ? `<em>${escapeHtml(s.scientific_name)}</em>`
          : escapeHtml(s.query);
        return `<tr>
          <td><a href="/searches/${escapeHtml(s.id)}">${name}</a><br><span class="muted">${escapeHtml(s.query)}</span></td>
          <td class="muted">${fetched}</td>
          <td class="muted">${escapeHtml((s.notes || '').slice(0, 80))}${
            (s.notes || '').length > 80 ? '…' : ''
          }</td>
          <td class="row-actions">
            <form method="post" action="/searches/${escapeHtml(s.id)}/delete" onsubmit="return confirm('Delete this saved search?')">
              <button type="submit">Delete</button>
            </form>
          </td>
        </tr>`;
      })
      .join('');

    const body = `
      <h1>Dashboard</h1>
      ${upgradeCard}
      ${ok}
      ${addForm}
      ${batchForm}
      <div class="card">
        <h3>Saved searches</h3>
        ${
          searches.length === 0
            ? '<p class="muted">No saved searches yet. Add a species above.</p>'
            : `<table>
                <thead><tr><th>Search</th><th>Last GBIF pull</th><th>Notes</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
              </table>`
        }
      </div>
      <p class="muted">Free browser tool: <a href="${FREE_TOOL}" target="_blank" rel="noopener">${FREE_TOOL}</a></p>`;
    res.type('html').send(layout({ title: 'Dashboard', user: req.user, body, flash }));
  });

  router.post('/searches', requireAuth, (req, res) => {
    try {
      insertSearch(db, req.user, req.body.query, req.body.notes);
      res.redirect('/dashboard?ok=' + encodeURIComponent('Search saved'));
    } catch (err) {
      res.redirect('/dashboard?error=' + encodeURIComponent(err.message));
    }
  });

  router.post('/searches/batch', requireAuth, (req, res) => {
    if (!canBatch(req.user.plan)) {
      return res.redirect(
        '/dashboard?error=' + encodeURIComponent('Batch lists are a Pro feature')
      );
    }
    const lines = String(req.body.list || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return res.redirect('/dashboard?error=' + encodeURIComponent('Paste at least one species'));
    }
    let added = 0;
    const errors = [];
    for (const line of lines) {
      const [query, ...rest] = line.split(/\t| — | - /);
      try {
        insertSearch(db, req.user, query, rest.join(' — '));
        added += 1;
      } catch (err) {
        errors.push(`${query}: ${err.message}`);
        if (err.status === 403) break;
      }
    }
    if (added === 0) {
      return res.redirect(
        '/dashboard?error=' + encodeURIComponent(errors[0] || 'Could not add list')
      );
    }
    const msg = `Added ${added} search${added === 1 ? '' : 'es'}${
      errors.length ? ` (${errors.length} skipped)` : ''
    }`;
    res.redirect('/dashboard?ok=' + encodeURIComponent(msg));
  });

  router.post('/searches/:id/delete', requireAuth, (req, res) => {
    db.prepare('DELETE FROM searches WHERE id = ? AND user_id = ?').run(
      req.params.id,
      req.user.id
    );
    res.redirect('/dashboard?ok=' + encodeURIComponent('Search deleted'));
  });

  router.get('/searches/:id', requireAuth, (req, res) => {
    const search = getOwnedSearch(db, req.user.id, req.params.id);
    if (!search) {
      return res.status(404).type('html').send(
        layout({
          title: 'Not found',
          user: req.user,
          body: '<h1>Search not found</h1><p class="muted"><a href="/dashboard">Back to dashboard</a></p>',
        })
      );
    }
    const err = req.query.error ? `<p class="error">${escapeHtml(req.query.error)}</p>` : '';
    const ok = req.query.ok ? `<p class="ok">${escapeHtml(req.query.ok)}</p>` : '';
    const payload = parseLastFetch(search);
    const links = referenceLinks(search.scientific_name || search.query, search.gbif_taxon_key);
    const annotations = db
      .prepare('SELECT gbif_key, note FROM annotations WHERE search_id = ? ORDER BY updated_at DESC')
      .all(search.id);
    const noteByKey = Object.fromEntries(annotations.map((a) => [String(a.gbif_key), a.note]));

    const linkRow = `
      <p class="muted">
        <a href="${escapeHtml(links.gbifSpecies)}" target="_blank" rel="noopener">GBIF species</a> ·
        <a href="${escapeHtml(links.wikipedia)}" target="_blank" rel="noopener">Wikipedia</a> ·
        <a href="${escapeHtml(links.wikidata)}" target="_blank" rel="noopener">Wikidata</a> ·
        <a href="${escapeHtml(links.powo)}" target="_blank" rel="noopener">POWO (Kew)</a>
      </p>`;

    let resultsHtml = '<p class="muted">No fetch yet. Run a GBIF pull to load preserved-specimen records.</p>';
    if (payload && Array.isArray(payload.results)) {
      const rows = payload.results
        .map((r) => {
          const key = String(r.gbifID);
          const existing = noteByKey[key] || '';
          return `<tr>
            <td><a href="${escapeHtml(r.gbifUrl)}" target="_blank" rel="noopener">${escapeHtml(key)}</a><br><span class="muted">${escapeHtml(r.scientificName)}</span></td>
            <td>${escapeHtml(r.year)} · ${escapeHtml(r.country)}</td>
            <td class="muted">${escapeHtml(r.institutionCode)} ${escapeHtml(r.catalogNumber)}</td>
            <td class="muted">${escapeHtml(r.recordedBy)}</td>
            <td>
              <form class="stack tight" method="post" action="/searches/${escapeHtml(search.id)}/annotations">
                <input type="hidden" name="gbif_key" value="${escapeHtml(key)}" />
                <input name="note" value="${escapeHtml(existing)}" maxlength="500" placeholder="Private note" />
                <button type="submit">Save</button>
              </form>
            </td>
          </tr>`;
        })
        .join('');
      resultsHtml = `
        <p class="muted">${payload.results.length} of ${payload.count ?? payload.results.length} GBIF preserved-specimen records (capped per pull).</p>
        <p class="muted">${escapeHtml(payload.attribution || '')}</p>
        <table>
          <thead><tr><th>Record</th><th>When / where</th><th>Collection</th><th>Collector</th><th>Private note</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    const exportBlock = canExport(req.user.plan)
      ? search.last_fetch_json
        ? `<p>
            <a class="btn" href="/searches/${escapeHtml(search.id)}/export.csv">Download CSV</a>
            <a class="btn secondary" href="/searches/${escapeHtml(search.id)}/export.json">Download JSON</a>
          </p>`
        : '<p class="muted">Export unlocks after a successful fetch.</p>'
      : `<p class="muted">CSV/JSON export is a Pro feature. <form method="post" action="/billing/checkout" style="display:inline"><button class="primary" type="submit">Upgrade — $4/mo</button></form></p>`;

    const body = `
      <p class="muted"><a href="/dashboard">← Dashboard</a></p>
      <h1>${escapeHtml(search.scientific_name || search.query)}</h1>
      <p class="muted">Query: ${escapeHtml(search.query)}${
        search.gbif_taxon_key ? ` · taxonKey ${escapeHtml(search.gbif_taxon_key)}` : ''
      }</p>
      ${linkRow}
      ${err}${ok}
      <div class="card">
        <h3>Private notes</h3>
        <form class="stack" method="post" action="/searches/${escapeHtml(search.id)}/notes">
          <textarea name="notes" maxlength="4000" rows="3">${escapeHtml(search.notes || '')}</textarea>
          <button class="primary" type="submit">Save notes</button>
        </form>
      </div>
      <div class="card">
        <h3>GBIF specimen pull</h3>
        <p class="muted">Server-side request to api.gbif.org. We identify the app, throttle requests, and attribute GBIF. Records stay in your account for this workflow — we do not republish them.</p>
        <form method="post" action="/searches/${escapeHtml(search.id)}/fetch">
          <button class="primary" type="submit">Run GBIF fetch</button>
        </form>
        ${exportBlock}
      </div>
      <div class="card">
        <h3>Last fetch</h3>
        ${resultsHtml}
      </div>`;
    res.type('html').send(layout({ title: search.query, user: req.user, body }));
  });

  router.post('/searches/:id/notes', requireAuth, (req, res) => {
    const search = getOwnedSearch(db, req.user.id, req.params.id);
    if (!search) return res.redirect('/dashboard?error=' + encodeURIComponent('Search not found'));
    db.prepare('UPDATE searches SET notes = ? WHERE id = ? AND user_id = ?').run(
      String(req.body.notes || '').slice(0, 4000),
      search.id,
      req.user.id
    );
    res.redirect(`/searches/${search.id}?ok=` + encodeURIComponent('Notes saved'));
  });

  router.post('/searches/:id/annotations', requireAuth, (req, res) => {
    const search = getOwnedSearch(db, req.user.id, req.params.id);
    if (!search) return res.redirect('/dashboard?error=' + encodeURIComponent('Search not found'));
    const gbifKey = String(req.body.gbif_key || '').trim().slice(0, 64);
    const note = String(req.body.note || '').trim().slice(0, 500);
    if (!gbifKey) {
      return res.redirect(`/searches/${search.id}?error=` + encodeURIComponent('Missing record key'));
    }
    if (!note) {
      db.prepare('DELETE FROM annotations WHERE search_id = ? AND gbif_key = ? AND user_id = ?').run(
        search.id,
        gbifKey,
        req.user.id
      );
    } else {
      db.prepare(
        `INSERT INTO annotations (id, user_id, search_id, gbif_key, note, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(search_id, gbif_key) DO UPDATE SET note = excluded.note, updated_at = datetime('now')`
      ).run(randomUUID(), req.user.id, search.id, gbifKey, note);
    }
    res.redirect(`/searches/${search.id}?ok=` + encodeURIComponent('Annotation saved'));
  });

  async function runFetch(user, search) {
    const payload = await pullForQuery(search.query);
    db.prepare(
      `UPDATE searches
       SET scientific_name = ?, gbif_taxon_key = ?, last_fetch_json = ?, last_fetch_count = ?, last_fetch_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      payload.match.scientificName,
      payload.match.taxonKey,
      JSON.stringify(payload),
      payload.results.length,
      payload.fetchedAt,
      search.id,
      user.id
    );
    return payload;
  }

  router.post('/searches/:id/fetch', requireAuth, async (req, res) => {
    const search = getOwnedSearch(db, req.user.id, req.params.id);
    if (!search) {
      if (wantsJson(req)) return res.status(404).json({ error: 'Search not found' });
      return res.redirect('/dashboard?error=' + encodeURIComponent('Search not found'));
    }
    try {
      const payload = await runFetch(req.user, search);
      if (wantsJson(req) || req.path.startsWith('/api')) {
        return res.json({
          ok: true,
          searchId: search.id,
          match: payload.match,
          count: payload.count,
          returned: payload.results.length,
        });
      }
      res.redirect(`/searches/${search.id}?ok=` + encodeURIComponent('GBIF fetch complete'));
    } catch (err) {
      console.error('[gbif fetch]', err.message);
      if (wantsJson(req) || req.path.startsWith('/api')) {
        return res.status(err.status || 502).json({ error: err.message });
      }
      res.redirect(`/searches/${search.id}?error=` + encodeURIComponent(err.message));
    }
  });

  function sendExport(req, res, format) {
    const search = getOwnedSearch(db, req.user.id, req.params.id);
    if (!search) {
      if (format === 'json' || wantsJson(req)) return res.status(404).json({ error: 'Search not found' });
      return res.redirect('/dashboard?error=' + encodeURIComponent('Search not found'));
    }
    if (!canExport(req.user.plan)) {
      if (format === 'json' || wantsJson(req)) {
        return res.status(403).json({ error: 'CSV/JSON export is a Pro feature' });
      }
      return res.redirect(
        `/searches/${search.id}?error=` + encodeURIComponent('CSV/JSON export is a Pro feature')
      );
    }
    const payload = parseLastFetch(search);
    if (!payload || !Array.isArray(payload.results)) {
      if (format === 'json' || wantsJson(req)) {
        return res.status(404).json({ error: 'No fetch results to export' });
      }
      return res.redirect(
        `/searches/${search.id}?error=` + encodeURIComponent('Run a GBIF fetch first')
      );
    }
    const slug = (search.scientific_name || search.query || 'specimens')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${slug || 'specimens'}.csv"`);
      return res.send(toCsv(payload.results));
    }
    res.setHeader('Content-Disposition', `attachment; filename="${slug || 'specimens'}.json"`);
    return res.json({
      query: search.query,
      notes: search.notes,
      match: payload.match,
      count: payload.count,
      fetchedAt: payload.fetchedAt,
      attribution: payload.attribution,
      results: payload.results,
    });
  }

  router.get('/searches/:id/export.csv', requireAuth, (req, res) => sendExport(req, res, 'csv'));
  router.get('/searches/:id/export.json', requireAuth, (req, res) => sendExport(req, res, 'json'));

  router.post('/billing/checkout', requireAuth, async (req, res) => {
    const price = stripe ? await resolveProPrice(stripe) : '';
    if (!stripe || !price) {
      return res.status(503).type('html').send(
        layout({
          title: 'Billing unavailable',
          user: req.user,
          body: '<h1>Billing not configured</h1><p class="muted">Set STRIPE_SECRET_KEY and STRIPE_PRICE_PRO, then restart.</p>',
        })
      );
    }
    try {
      let customerId = req.user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: req.user.email,
          metadata: { user_id: req.user.id },
        });
        customerId = customer.id;
        db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(
          customerId,
          req.user.id
        );
      }
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price, quantity: 1 }],
        success_url: `${APP_URL}/dashboard?upgraded=1`,
        cancel_url: `${APP_URL}/dashboard`,
        metadata: { user_id: req.user.id },
        subscription_data: { metadata: { user_id: req.user.id } },
      });
      res.redirect(303, session.url);
    } catch (err) {
      console.error('[stripe checkout]', err.message);
      if (wantsJson(req)) return res.status(502).json({ error: 'Could not start checkout' });
      res.redirect('/dashboard?error=' + encodeURIComponent('Could not start checkout'));
    }
  });

  router.post('/api/signup', (req, res) => {
    try {
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const user = createUser(db, email, password);
      const token = signToken(user);
      setAuthCookie(res, token);
      res.status(201).json({ user, token });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  router.post('/api/login', (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const safe = { id: user.id, email: user.email, plan: user.plan };
    const token = signToken(user);
    setAuthCookie(res, token);
    res.json({ user: safe, token });
  });

  router.post('/api/searches', requireAuth, (req, res) => {
    try {
      const search = insertSearch(db, req.user, req.body.query, req.body.notes);
      res.status(201).json({
        search: {
          id: search.id,
          query: search.query,
          notes: search.notes,
        },
      });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  router.get('/api/searches', requireAuth, (req, res) => {
    const searches = db
      .prepare(
        `SELECT id, query, notes, scientific_name, gbif_taxon_key, last_fetch_count, last_fetch_at, created_at
         FROM searches WHERE user_id = ? ORDER BY created_at DESC`
      )
      .all(req.user.id);
    res.json({
      plan: req.user.plan,
      limit: Number.isFinite(searchLimit(req.user.plan)) ? searchLimit(req.user.plan) : null,
      searches,
    });
  });

  router.post('/api/searches/:id/fetch', requireAuth, async (req, res) => {
    const search = getOwnedSearch(db, req.user.id, req.params.id);
    if (!search) return res.status(404).json({ error: 'Search not found' });
    try {
      const payload = await runFetch(req.user, search);
      res.json({
        ok: true,
        searchId: search.id,
        match: payload.match,
        count: payload.count,
        returned: payload.results.length,
        attribution: payload.attribution,
      });
    } catch (err) {
      console.error('[gbif fetch]', err.message);
      res.status(err.status || 502).json({ error: err.message });
    }
  });

  router.get('/api/searches/:id/export.csv', requireAuth, (req, res) =>
    sendExport(req, res, 'csv')
  );
  router.get('/api/searches/:id/export.json', requireAuth, (req, res) =>
    sendExport(req, res, 'json')
  );

  return router;
}

function createWebhookHandler(db, stripe) {
  return async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(503).send('Webhook not configured');
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[webhook]', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        if (userId) {
          db.prepare(
            `UPDATE users SET plan = 'pro', stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?`
          ).run(session.customer || null, userId);
        }
      }
      if (
        event.type === 'customer.subscription.updated' ||
        event.type === 'customer.subscription.deleted'
      ) {
        const sub = event.data.object;
        const userId = sub.metadata?.user_id;
        const active = sub.status === 'active' || sub.status === 'trialing';
        if (userId) {
          db.prepare(`UPDATE users SET plan = ? WHERE id = ?`).run(active ? 'pro' : 'free', userId);
        } else if (sub.customer) {
          const user = db.prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(sub.customer);
          if (user) {
            db.prepare(`UPDATE users SET plan = ? WHERE id = ?`).run(
              active ? 'pro' : 'free',
              user.id
            );
          }
        }
      }
    } catch (err) {
      console.error('[webhook handle]', err.message);
      return res.status(500).json({ error: 'handler failed' });
    }
    res.json({ received: true });
  };
}

module.exports = { createRouter, createWebhookHandler };
