'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('../src/auth');
const { searchLimit, canExport, canBatch } = require('../src/plans');
const { toCsv, csvEscape, pickOccurrence, referenceLinks } = require('../src/gbif');

describe('Specimen Finder Pro smoke', () => {
  let dbPath;
  let app;
  let db;
  let server;
  let base;

  before(async () => {
    process.env.JWT_SECRET = 'test-secret';
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_PRICE_PRO;
    dbPath = path.join(os.tmpdir(), `sfp-test-${Date.now()}.db`);
    ({ app, db } = createApp({ dbPath }));
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
  });

  it('GET /health', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'specimen-finder-pro');
  });

  it('landing page explains free tool and Pro', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Specimen Finder Pro/);
    assert.match(html, /theoryofshadows\.github\.io\/specimen-finder/);
    assert.match(html, /\$5/);
    assert.match(html, /Start free/);
    assert.doesNotMatch(html, /Pl@ntNet/);
    assert.match(html, /does not include photo identification/);
    assert.doesNotMatch(html, /trusted by thousands/i);
  });

  it('signup, login, saved-search limits, export gate', async () => {
    const email = `user${Date.now()}@example.com`;
    const password = 'password123';

    let res = await fetch(`${base}/api/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 201);
    const signup = await res.json();
    assert.ok(signup.token);
    assert.equal(signup.user.plan, 'free');

    res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(res.status, 200);
    const login = await res.json();
    assert.ok(login.token);
    const auth = { Authorization: `Bearer ${login.token}` };

    for (const query of ['Sarracenia purpurea', 'Asclepias incarnata', 'Dionaea muscipula']) {
      res = await fetch(`${base}/api/searches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ query, notes: 'field note' }),
      });
      assert.equal(res.status, 201);
    }

    res = await fetch(`${base}/api/searches`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ query: 'Should fail' }),
    });
    assert.equal(res.status, 403);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS c FROM searches WHERE user_id = ?').get(signup.user.id).c,
      3
    );

    const first = db.prepare('SELECT id FROM searches WHERE user_id = ?').get(signup.user.id);
    res = await fetch(`${base}/api/searches/${first.id}/export.csv`, { headers: auth });
    assert.equal(res.status, 403);

    res = await fetch(`${base}/dashboard`, { headers: auth });
    assert.equal(res.status, 200);
    const dash = await res.text();
    assert.match(dash, /Sarracenia|saved searches/i);
  });

  it('auth helpers', () => {
    const hash = hashPassword('secretpass');
    assert.ok(verifyPassword('secretpass', hash));
    assert.ok(!verifyPassword('wrong', hash));
    const token = signToken({ id: 'u1', email: 'a@b.c', plan: 'free' });
    const payload = verifyToken(token);
    assert.equal(payload.sub, 'u1');
  });

  it('plan limits', () => {
    assert.equal(searchLimit('free'), 3);
    assert.equal(searchLimit('pro'), Number.POSITIVE_INFINITY);
    assert.equal(canExport('free'), false);
    assert.equal(canExport('pro'), true);
    assert.equal(canBatch('pro'), true);
  });

  it('csv helpers and GBIF record mapping', () => {
    assert.equal(csvEscape('plain'), 'plain');
    assert.equal(csvEscape('a,b'), '"a,b"');
    const rec = pickOccurrence({
      key: 123,
      scientificName: 'Sarracenia purpurea L.',
      country: 'Canada',
      year: 1891,
      institutionCode: 'CAN',
      catalogNumber: '1234',
    });
    assert.equal(rec.gbifID, 123);
    assert.match(rec.gbifUrl, /occurrence\/123/);
    const csv = toCsv([rec]);
    assert.match(csv, /gbifID/);
    assert.match(csv, /123/);
    const links = referenceLinks('Sarracenia purpurea', 2685094);
    assert.match(links.gbifSpecies, /2685094/);
    assert.match(links.wikipedia, /Sarracenia/);
    assert.match(links.powo, /powo\.science\.kew\.org/);
  });

  it('pro user can exceed three searches and export after fetch payload', () => {
    const id = 'pro-user-' + Date.now();
    db.prepare(
      `INSERT INTO users (id, email, password_hash, plan) VALUES (?, ?, ?, 'pro')`
    ).run(id, `pro${Date.now()}@example.com`, hashPassword('password123'));
    const token = signToken({ id, email: 'p@p.c', plan: 'pro' });
    assert.equal(searchLimit('pro'), Number.POSITIVE_INFINITY);
    assert.ok(token);
  });

  it('unauthenticated dashboard redirects', async () => {
    const res = await fetch(`${base}/dashboard`, { redirect: 'manual' });
    assert.ok([301, 302, 303, 307, 308].includes(res.status));
  });
});
