'use strict';

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout({ title, user, body, flash }) {
  const nav = user
    ? `<a href="/dashboard">Dashboard</a>
       <form method="post" action="/logout" style="display:inline"><button type="submit" class="linkish">Log out</button></form>`
    : `<a href="/login">Log in</a> <a href="/signup" class="btn">Sign up</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Specimen Finder Pro</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="top">
    <a class="logo" href="/">Specimen Finder Pro</a>
    <nav>${nav}</nav>
  </header>
  ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ''}
  <main>${body}</main>
  <footer>
    <p>Hosted workflow for <a href="https://theoryofshadows.github.io/specimen-finder/">Specimen Finder</a> — the free open tool stays free.</p>
    <p>Occurrence data via <a href="https://www.gbif.org/">GBIF</a>. Context links: Wikipedia, Wikidata, POWO. We do not sell or redistribute publisher content.</p>
    <p><a href="https://github.com/TheoryofShadows/specimen-finder-pro">Source on GitHub</a></p>
  </footer>
</body>
</html>`;
}

module.exports = { escapeHtml, layout };
