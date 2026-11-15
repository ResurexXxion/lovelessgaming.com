// Builds the site into dist/. No npm packages needed; Node 20 or newer.
//
//   node build.mjs              build (fetches the Medium feed if one is set)
//   SKIP_FEEDS=1 node build.mjs build without going online
//   BASE_PATH=/repo node build.mjs   build for https://user.github.io/repo/ (the workflow sets this)

import { readFile, writeFile, mkdir, rm, cp, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(root, 'dist');
const readJSON = async (p) => JSON.parse(await readFile(path.join(root, p), 'utf8'));

const config = await readJSON('site.config.json');
const { releases = [], games = [] } = await readJSON('content/mods.json');
const { books = [] } = await readJSON('content/books.json');
const sol = await readJSON('content/solclient.json');
// One JSON file per game setup in content/setups/, each becoming /mods/<slug>/.
const setups = await Promise.all(
  (await readdir(path.join(root, 'content/setups')).catch(() => []))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJSON(`content/setups/${f}`))
);
const discordUrl = ((config.links || []).find((l) => /discord/i.test(l.label)) || {}).url || '';
const base = (process.env.BASE_PATH || '').replace(/\/$/, '');
const year = new Date().getFullYear();

// ---------- helpers ----------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Site-relative paths ("/mods/") get the base path; full URLs pass through.
const href = (p) => (p && p.startsWith('/') ? base + p : p || '');

const decode = (s) =>
  String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const fmtDate = (d) => {
  const t = new Date(d);
  return isNaN(t) ? '' : t.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
};

const linkList = (links = []) =>
  links
    .filter((l) => l && l.url)
    .map((l) => `<a class="btn btn-small" href="${esc(href(l.url))}" rel="noopener">${esc(l.label)}</a>`)
    .join('');

// ---------- Medium feed ----------

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim() : '';
}

function parseItem(block) {
  const title = decode(tag(block, 'title'));
  const body = tag(block, 'content:encoded') || tag(block, 'description');
  // First real image (Medium appends a 1x1 tracking pixel from /_/stat).
  const img = [...body.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]).find((s) => !s.includes('/_/stat')) || '';
  let text = decode(
    body
      .replace(/^\s*<h[1-4][^>]*>[\s\S]*?<\/h[1-4]>/, ' ') // Medium repeats the title as the first heading
      .replace(/<figure[\s\S]*?<\/figure>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
  if (text.startsWith(title)) text = text.slice(title.length).trim();
  const snippet = text.length > 180 ? text.slice(0, 180).replace(/\s+\S*$/, '') + '…' : text;
  const tags = [...block.matchAll(/<category>([\s\S]*?)<\/category>/g)].map((m) =>
    decode(m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim())
  );
  const link = tag(block, 'link').split('?')[0];
  return { title, link, date: tag(block, 'pubDate'), img, snippet, tags };
}

async function fetchMedium(url) {
  if (!url) return { items: [], status: 'unset' };
  if (process.env.SKIP_FEEDS) return { items: [], status: 'skipped' };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'site-build/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => parseItem(m[1]));
    console.log(`Medium feed: ${items.length} articles`);
    return { items, status: 'ok' };
  } catch (e) {
    console.warn(`Medium feed failed (${e.message}); building without articles.`);
    return { items: [], status: 'failed' };
  }
}

// MEDIUM_FEED overrides the config (handy for testing against someone else's feed).
const medium = await fetchMedium(process.env.MEDIUM_FEED ?? config.mediumFeed);
const mediumProfile = config.mediumProfile || (config.mediumFeed || '').replace('/feed/', '/');

// ---------- page shell ----------

// The logo links home, so there's no separate Home item (keeps the bar on one line on phones).
const nav = [
  ['/mods/', 'Mods'],
  ['/solclient/', 'SolClient'],
  ['/books/', 'Books'],
  ['/writing/', 'Writing'],
  ['/links/', 'Links'],
  ['/about/', 'About'],
];

function page({ slug, title, description, body }) {
  const fullTitle = slug === '/' ? `${config.siteName}: ${config.tagline}` : `${title} · ${config.siteName}`;
  const canonical = `https://${config.domain}${slug}`;
  const navHtml = nav
    .map(([p, label]) => `<a href="${href(p)}"${slug.startsWith(p) ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(description || config.description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(config.siteName)}">
<meta property="og:title" content="${esc(fullTitle)}">
<meta property="og:description" content="${esc(description || config.description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="theme-color" content="#0e0f13">
<meta property="og:image" content="https://${esc(config.domain)}/og-image.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The Loveless Gaming logo, a cracked heart-shaped game controller, glowing over drifting embers">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${href('/favicon.svg')}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${href('/apple-touch-icon.png')}">
<link rel="stylesheet" href="${href('/styles.css')}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="${href('/')}" aria-label="${esc(config.siteName)} home">
      <img src="${href('/logo.svg')}" alt="" width="30" height="30">
      <span>${esc(config.siteName)}</span>
    </a>
    <nav class="site-nav" aria-label="Main">${navHtml}</nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-inner">
    <span>© ${year} ${esc(config.author || config.siteName)}</span>
    <span class="footer-links">${(config.links || [])
      .filter((l) => l.url)
      .map((l) => `<a href="${esc(l.url)}" rel="noopener">${esc(l.label)}</a>`)
      .join('')}${config.contactEmail ? `<a href="mailto:${esc(config.contactEmail)}">Contact</a>` : ''}</span>
  </div>
</footer>
</body>
</html>
`;
}

// ---------- sections ----------

const empty = (msg) => `<p class="empty">${msg}</p>`;

function modCard(m) {
  return `<article class="card">
  ${m.image ? `<img class="card-img" src="${esc(href(m.image))}" alt="" loading="lazy">` : ''}
  <div class="card-body">
    <p class="eyebrow">${esc(m.game)}${m.version ? ` · v${esc(m.version)}` : ''}</p>
    <h3>${esc(m.name)}</h3>
    <p>${esc(m.summary)}</p>
    ${m.updated ? `<p class="meta">Updated ${esc(fmtDate(m.updated))}</p>` : ''}
    <div class="actions">${linkList(m.links)}</div>
  </div>
</article>`;
}

function setupCard(s) {
  return `<a class="card tile-link" href="${href(`/mods/${s.slug}/`)}">
  <div class="card-body">
    <p class="eyebrow">${esc(s.game)}</p>
    <h3>${esc(s.title)}</h3>
    <p>${esc(s.summary)}</p>
    ${s.updated ? `<p class="meta">Updated ${esc(fmtDate(s.updated))}</p>` : ''}
  </div>
</a>`;
}

const extLink = (name, url) => (url ? `<a href="${esc(url)}" rel="noopener">${esc(name)}</a>` : esc(name));

function setupPage(s) {
  return page({
    slug: `/mods/${s.slug}/`,
    title: `${s.title}: ${s.game}`,
    description: s.summary,
    body: `<section class="page-head wrap">
  <p class="kicker"><a href="${href('/mods/')}">Mods</a> · ${esc(s.game)}</p>
  <h1>${esc(s.title)}</h1>
  <p class="lede">${esc(s.summary)}</p>
  ${s.facts?.length ? `<dl class="facts">${s.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
</section>
${s.base ? `<section class="wrap section">
  <div class="feature static">
    <div>
      <p class="eyebrow">Built on</p>
      <h2>${esc(s.base.name)} <span class="by">by ${esc(s.base.author)}</span></h2>
      <p>${esc(s.base.note)}</p>
    </div>
    <a class="btn" href="${esc(s.base.url)}" rel="noopener">Get ${esc(s.base.name)} on Nexus</a>
  </div>
</section>` : ''}
${s.added?.length ? `<section class="wrap section">
  <h2>What I added</h2>
  <div class="grid three">
    ${s.added.map((g) => `<div class="card"><div class="card-body"><h3>${esc(g.group)}</h3><ul class="modlist">${g.items.map((i) => `<li><strong>${extLink(i.name, i.url)}</strong><span>${esc(i.why)}</span></li>`).join('')}</ul></div></div>`).join('\n    ')}
  </div>
</section>` : ''}
${s.removed?.length ? `<section class="wrap section">
  <h2>What I removed, and why</h2>
  <ul class="modlist wide">${s.removed.map((r) => `<li><strong>${esc(r.name)}</strong><span>${esc(r.why)}</span></li>`).join('')}</ul>
</section>` : ''}
${s.lessons?.length ? `<section class="wrap section">
  <h2>Fixes and lessons</h2>
  <div class="grid three">
    ${s.lessons.map((l) => `<div class="card"><div class="card-body"><h3>${esc(l.title)}</h3><p>${esc(l.text)}</p></div></div>`).join('\n    ')}
  </div>
</section>` : ''}
<section class="wrap section prose">
  ${s.status ? `<h2>Status</h2><p>${esc(s.status)}</p>` : ''}
  ${s.tool ? `<h2>The tool behind it</h2><p>${esc(s.tool.why)} <a href="${esc(s.tool.url)}" rel="noopener">Get ${esc(s.tool.name)} →</a></p>` : ''}
  ${s.omitted ? `<p class="meta">${esc(s.omitted)}</p>` : ''}
  <p class="meta">Questions about this setup? Ask in the ${discordUrl ? `<a href="${esc(discordUrl)}" rel="noopener">Discord</a>` : 'Discord'}.</p>
</section>`,
  });
}

function bookCard(b) {
  return `<article class="book">
  ${b.cover ? `<img class="book-cover" src="${esc(href(b.cover))}" alt="Cover of ${esc(b.title)}" loading="lazy">` : '<div class="book-cover placeholder" aria-hidden="true"></div>'}
  <div>
    <h3>${esc(b.title)}</h3>
    ${b.subtitle ? `<p class="subtitle">${esc(b.subtitle)}</p>` : ''}
    <p>${esc(b.blurb)}</p>
    ${b.published ? `<p class="meta">Published ${esc(fmtDate(b.published))}</p>` : ''}
    <div class="actions">${linkList(b.links)}</div>
  </div>
</article>`;
}

function articleCard(a) {
  return `<article class="card article">
  ${a.img ? `<img class="card-img" src="${esc(a.img)}" alt="" loading="lazy">` : ''}
  <div class="card-body">
    <p class="eyebrow">${esc(fmtDate(a.date))}</p>
    <h3><a href="${esc(a.link)}" rel="noopener">${esc(a.title)}</a></h3>
    ${a.snippet ? `<p>${esc(a.snippet)}</p>` : ''}
    ${a.tags.length ? `<p class="tags">${a.tags.slice(0, 4).map((t) => `<span>${esc(t)}</span>`).join('')}</p>` : ''}
  </div>
</article>`;
}

const articlesEmpty =
  medium.status === 'failed'
    ? empty(`Couldn't reach Medium just now.${mediumProfile ? ` <a href="${esc(mediumProfile)}" rel="noopener">Read the articles on Medium →</a>` : ''}`)
    : empty('The first articles are on the way.');

const newsletter = config.newsletterUrl
  ? `<section class="band">
  <div class="wrap band-inner">
    <div><h2>Get new releases by email</h2><p>New mods, books and articles. No spam, unsubscribe any time.</p></div>
    <a class="btn" href="${esc(config.newsletterUrl)}" rel="noopener">Join the list</a>
  </div>
</section>`
  : '';

// ---------- pages ----------

const latestArticle = medium.items[0];

const home = page({
  slug: '/',
  body: `<section class="hero">
  <div class="wrap">
    <p class="kicker">Mods · Books · Writing</p>
    <h1>${esc(config.siteName)}</h1>
    <p class="lede">${esc(config.tagline)}</p>
    <div class="actions">
      <a class="btn" href="${href('/mods/')}">Browse mods</a>
      <a class="btn btn-ghost" href="${href('/writing/')}">Read the writing</a>
    </div>
  </div>
</section>
<section class="wrap">
  <div class="grid three">
    <a class="tile" href="${href('/mods/')}">
      <span class="tile-icon" aria-hidden="true">⚙</span>
      <h2>Mods</h2>
      <p>${releases.length ? `${releases.length} release${releases.length === 1 ? '' : 's'}, newest: ${esc(releases[0].name)}` : `Fixes, tweaks and load-order know-how for ${games.length} games.`}</p>
    </a>
    <a class="tile" href="${href('/books/')}">
      <span class="tile-icon" aria-hidden="true">❧</span>
      <h2>Books</h2>
      <p>${books.length ? `Latest: ${esc(books[0].title)}` : 'First book in the works.'}</p>
    </a>
    <a class="tile" href="${href('/writing/')}">
      <span class="tile-icon" aria-hidden="true">✎</span>
      <h2>Writing</h2>
      <p>${latestArticle ? `Latest: ${esc(latestArticle.title)}` : 'Articles on Medium, coming soon.'}</p>
    </a>
  </div>
</section>
<section class="wrap section">
  <a class="feature" href="${href('/solclient/')}">
    <div>
      <p class="eyebrow">Featured project · ${esc(sol.status)}</p>
      <h2>${esc(sol.name)} for Furcadia</h2>
      <p>${esc(sol.tagline)}</p>
    </div>
    <span class="btn">Learn more</span>
  </a>
</section>
${medium.items.length ? `<section class="wrap section">
  <div class="section-head"><h2>Latest articles</h2><a href="${href('/writing/')}">All articles →</a></div>
  <div class="grid three">${medium.items.slice(0, 3).map(articleCard).join('')}</div>
</section>` : ''}
${releases.length ? `<section class="wrap section">
  <div class="section-head"><h2>Latest mods</h2><a href="${href('/mods/')}">All mods →</a></div>
  <div class="grid three">${releases.slice(0, 3).map(modCard).join('')}</div>
</section>` : ''}
${newsletter}`,
});

const modsPage = page({
  slug: '/mods/',
  title: 'Mods',
  description: `Game mods from ${config.siteName}.`,
  body: `<section class="page-head wrap"><h1>Mods</h1><p class="lede">Releases, patches and compatibility fixes. Downloads are hosted on the mod sites linked from each one.</p></section>
<section class="wrap section">
  <h2>Releases and tools</h2>
  ${releases.length ? `<div class="grid three">${releases.map(modCard).join('')}</div>` : empty('First releases coming soon.')}
  <p class="meta">Playing Furcadia? See <a href="${href('/solclient/')}">SolClient</a>, my add-on for the Furcadia client.</p>
</section>
${setups.length ? `<section class="wrap section">
  <h2>My setups</h2>
  <p class="meta">Full modded setups I play, with credit to the collections they're built on, what I changed, and the fixes it took.</p>
  <div class="grid three">${setups.map(setupCard).join('')}</div>
</section>` : ''}
${games.length ? `<section class="wrap section">
  <h2>Games I mod</h2>
  <ul class="chips">${games.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
</section>` : ''}`,
});

const booksPage = page({
  slug: '/books/',
  title: 'Books',
  description: `Books by ${config.penName || config.author || config.siteName}.`,
  body: `<section class="page-head wrap"><h1>Books</h1><p class="lede">Practical books written from lived experience${config.penName ? `, published under the pen name <strong>${esc(config.penName)}</strong>` : ''}.</p></section>
<section class="wrap section">
  ${books.length ? `<div class="stack">${books.map(bookCard).join('')}</div>` : empty('The first book is in the works. Check back soon.')}
</section>
${newsletter}`,
});

const writingPage = page({
  slug: '/writing/',
  title: 'Writing',
  description: `Articles by ${config.penName || config.author || config.siteName} on Medium.`,
  body: `<section class="page-head wrap"><h1>Writing</h1><p class="lede">Articles published on Medium${config.penName ? ` as <strong>${esc(config.penName)}</strong>` : ''}.${mediumProfile ? ` <a href="${esc(mediumProfile)}" rel="noopener">Follow on Medium →</a>` : ''}</p></section>
<section class="wrap section">
  ${medium.items.length ? `<div class="grid three">${medium.items.map(articleCard).join('')}</div>` : articlesEmpty}
</section>`,
});

const linkRows = (config.links || []).filter((l) => l.url);
const aboutPage = page({
  slug: '/about/',
  title: 'About',
  description: `About ${config.siteName}.`,
  body: `<section class="page-head wrap"><h1>About</h1></section>
<section class="wrap section prose">
  ${(config.about || []).map((p) => `<p>${esc(p)}</p>`).join('\n  ')}
  ${config.contactEmail ? `<h2>Contact</h2><p>Email <a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a>.</p>` : ''}
  ${linkRows.length ? `<h2>Elsewhere</h2><ul>${linkRows.map((l) => `<li><a href="${esc(l.url)}" rel="noopener">${esc(l.label)}</a></li>`).join('')}</ul>` : ''}
</section>`,
});

const solPage = page({
  slug: '/solclient/',
  title: 'SolClient for Furcadia',
  description: sol.tagline,
  body: `<section class="page-head wrap">
  <p class="kicker">Furcadia · ${esc(sol.status)}${sol.version ? ` · v${esc(sol.version)}` : ''}</p>
  <h1>${esc(sol.name)}</h1>
  <p class="lede">${esc(sol.tagline)}</p>
  <div class="actions">
    ${discordUrl ? `<a class="btn" href="${esc(discordUrl)}" rel="noopener">Follow development on Discord</a>` : ''}
  </div>
</section>
<section class="wrap section prose">
  ${(sol.intro || []).map((p) => `<p>${esc(p)}</p>`).join('\n  ')}
</section>
<section class="wrap section">
  <div class="grid three">
    ${(sol.groups || []).map((g) => `<div class="card"><div class="card-body"><h3>${esc(g.title)}</h3><ul class="ticks">${g.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div></div>`).join('\n    ')}
  </div>
</section>
<section class="wrap section prose">
  <h2>Safe by design</h2>
  <ul class="ticks">${(sol.safety || []).map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
  <h2>Release</h2>
  <p>SolClient isn't released yet. Release news, test builds and feedback all happen in the ${discordUrl ? `<a href="${esc(discordUrl)}" rel="noopener">Loveless Gaming Discord</a>` : 'Loveless Gaming Discord'}.</p>
  <p class="meta">${esc(sol.disclaimer)}</p>
</section>`,
});

// Link-in-bio page: the one URL to put in every social profile.
const linksPage = page({
  slug: '/links/',
  title: 'Links',
  description: `Everywhere to find ${config.siteName}.`,
  body: `<section class="linkpage wrap">
  <img class="linkpage-logo" src="${href('/favicon.svg')}" alt="" width="88" height="88">
  <h1>${esc(config.siteName)}</h1>
  <p class="lede">${esc(config.tagline)}</p>
  <ul class="linklist">
    <li><a href="${href('/mods/')}">Mods</a></li>
    <li><a href="${href('/solclient/')}">SolClient for Furcadia</a></li>
    <li><a href="${href('/books/')}">Books</a></li>
    <li><a href="${href('/writing/')}">Writing</a></li>
    ${config.newsletterUrl ? `<li><a class="primary" href="${esc(config.newsletterUrl)}" rel="noopener">Join the email list</a></li>` : ''}
    ${linkRows.map((l) => `<li><a href="${esc(l.url)}" rel="noopener">${esc(l.label)}</a></li>`).join('\n    ')}
    ${config.contactEmail ? `<li><a href="mailto:${esc(config.contactEmail)}">Email me</a></li>` : ''}
  </ul>
</section>`,
});

const notFound = page({
  slug: '/404.html',
  title: 'Not found',
  body: `<section class="page-head wrap"><h1>Page not found</h1><p class="lede">That page doesn't exist.</p><div class="actions"><a class="btn" href="${href('/')}">Go home</a></div></section>`,
});

// ---------- write ----------

await rm(out, { recursive: true, force: true });
await cp(path.join(root, 'static'), out, { recursive: true, filter: (src) => path.basename(src) !== 'README.md' });

const pages = { 'index.html': home, 'mods/index.html': modsPage, 'solclient/index.html': solPage, 'books/index.html': booksPage, 'writing/index.html': writingPage, 'links/index.html': linksPage, 'about/index.html': aboutPage, '404.html': notFound };
for (const s of setups) pages[`mods/${s.slug}/index.html`] = setupPage(s);
for (const [file, html] of Object.entries(pages)) {
  await mkdir(path.dirname(path.join(out, file)), { recursive: true });
  await writeFile(path.join(out, file), html);
}

const urls = ['/', '/mods/', ...setups.map((s) => `/mods/${s.slug}/`), '/solclient/', '/books/', '/writing/', '/links/', '/about/'];
await writeFile(
  path.join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>https://${config.domain}${u}</loc></url>`).join('\n')}\n</urlset>\n`
);
await writeFile(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: https://${config.domain}/sitemap.xml\n`);

console.log(`Built ${Object.keys(pages).length} pages into dist/${base ? ` (base path ${base})` : ''}.`);
