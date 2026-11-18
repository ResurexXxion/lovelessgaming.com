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
const solShots = await readJSON('content/solclient-screenshots.json');
const den = await readJSON('content/home.json').catch(() => ({}));
// One JSON file per game setup in content/setups/, each becoming /mods/<slug>/.
const setups = await Promise.all(
  (await readdir(path.join(root, 'content/setups')).catch(() => []))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJSON(`content/setups/${f}`))
);
// Support (donations) page: only built and linked once at least one platform has a URL.
// SUPPORT_PREVIEW=1 fills placeholder links so the page can be checked locally before any account exists.
const support = config.support || {};
const supportLinks = (support.platforms || [])
  .map((p) => ({ ...p, url: p.url || (process.env.SUPPORT_PREVIEW ? '#' : '') }))
  .filter((p) => p.url);
const hasSupport = supportLinks.length > 0;
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

// Inline Markdown from the changelog: **bold**, `code` and [links](https://…). Escaped first.
const mdInline = (s) =>
  esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');

// JSON-LD for search engines; "<" is escaped so the JSON can't close the script tag.
const jsonLd = (data) => `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', ...data }).replace(/</g, '\\u003c')}</script>`;

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

// Books and Writing stay out of the menu, home page and sitemap until they have something in them.
const hasBooks = books.length > 0;
const hasArticles = medium.items.length > 0;

// ---------- SolClient changelog ----------
// Read from the public changelog repo at build time (the daily rebuild keeps it current).
// Each "## 0.10.5 (2026-11-15)" heading starts a release; "- " lines are its changes.

function parseChangelog(md) {
  const releases = [];
  let cur = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+(\S+)(?:\s+\((\d{4}-\d{2}-\d{2})\))?/);
    if (h) { cur = { version: h[1], date: h[2] || '', items: [] }; releases.push(cur); continue; }
    const b = line.match(/^[-*]\s+(.*)/);
    if (b && cur) cur.items.push(b[1].trim());
    else if (cur?.items.length && /^\s{2,}\S/.test(line)) cur.items[cur.items.length - 1] += ' ' + line.trim();
  }
  return releases.filter((r) => r.items.length);
}

async function fetchChangelog(url) {
  if (!url || process.env.SKIP_FEEDS) return [];
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'site-build/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const releases = parseChangelog(await res.text());
    console.log(`SolClient changelog: ${releases.length} releases`);
    return releases;
  } catch (e) {
    console.warn(`SolClient changelog failed (${e.message}); building without it.`);
    return [];
  }
}

const changelogRaw = sol.changelogRaw || (sol.changelog || '').replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/');
const solChanges = await fetchChangelog(changelogRaw.startsWith('https://raw.') ? changelogRaw : '');
const solVersion = solChanges[0]?.version || sol.version || '';

// ---------- YouTube ----------
// Latest uploads from the channel's public feed. Thumbnails are downloaded at build time and served
// from this site, so visitors' browsers never contact YouTube unless they click a video.

async function fetchYouTube(channelId) {
  if (!channelId || process.env.SKIP_FEEDS) return { items: [] };
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { headers: { 'User-Agent': 'site-build/1.0' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
      id: tag(m[1], 'yt:videoId'),
      title: decode(tag(m[1], 'title')),
      published: tag(m[1], 'published'),
    })).filter((v) => /^[\w-]{6,20}$/.test(v.id));
    const thumbs = {};
    for (const v of items.slice(0, 3)) {
      const t = await fetch(`https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`, { signal: AbortSignal.timeout(15000) });
      if (t.ok) thumbs[v.id] = Buffer.from(await t.arrayBuffer());
    }
    const shown = items.filter((v) => thumbs[v.id]);
    console.log(`YouTube feed: ${items.length} videos (${shown.length} with thumbnails shown)`);
    return { items: shown, thumbs };
  } catch (e) {
    console.warn(`YouTube feed failed (${e.message}); building without videos.`);
    return { items: [] };
  }
}
const youtube = await fetchYouTube(config.youtubeChannelId);

// ---------- page shell ----------

// The logo links home, so there's no separate Home item (keeps the bar on one line on phones).
// Each item can have a dropdown tree: groups of child pages, shown on hover, keyboard focus or the ▾ button.
// A child is [path or URL, label]; full URLs are marked as external.
const nav = [
  ['/mods/', 'Mods', [
    ['', [['/mods/', 'All mods']]],
    ['My setups', setups.map((s) => [`/mods/${s.slug}/`, `${s.game}`])],
    ['Releases', releases.filter((r) => r.links?.[0]?.url).map((r) => [r.links[0].url, r.name])],
  ]],
  ['/solclient/', 'SolClient', [['', [['/solclient/', 'About SolClient'], ['/solclient/screenshots/', `Screenshots (${solShots.shots.length})`], ...(solChanges.length ? [['/solclient/#updates', `What's new (v${solVersion})`]] : []), ...(sol.changelog ? [[sol.changelog, 'Changelog']] : [])]]]],
  ...(hasBooks ? [['/books/', 'Books', [['', books.filter((b) => b.links?.[0]?.url).slice(0, 6).map((b) => [b.links[0].url, b.title])]]]] : []),
  ...(hasArticles ? [['/writing/', 'Writing', [['Latest', medium.items.slice(0, 5).map((a) => [a.link, a.title])]]]] : []),
  ['/links/', 'Links', []],
  ['/about/', 'About', hasSupport ? [['', [['/about/', 'About me'], ['/support/', 'Support ♥']]]] : []],
];

function navTree(slug) {
  return `<ul class="nav-list">${nav
    .map(([p, label, groups]) => {
      const cur = slug.startsWith(p) ? ' aria-current="page"' : '';
      const gs = (groups || []).filter(([, items]) => items.length);
      if (!gs.length) return `<li><a href="${href(p)}"${cur}>${label}</a></li>`;
      const sub = gs
        .map(([g, items]) => `${g ? `<li class="sub-group">${esc(g)}</li>` : ''}${items
          .map(([u, t], i) => {
            const ext = /^https?:/.test(u);
            const last = i === items.length - 1 ? ' last' : '';
            return `<li class="sub-item${g ? ' nested' : ''}${last}"><a href="${esc(href(u))}"${ext ? ' rel="noopener"' : ''}${!ext && u === slug ? ' aria-current="page"' : ''}>${esc(t)}${ext ? ' <span class="ext" aria-hidden="true">↗</span>' : ''}</a></li>`;
          })
          .join('')}`)
        .join('');
      return `<li class="has-sub"><a href="${href(p)}"${cur}>${label}</a><button class="sub-toggle" type="button" aria-expanded="false" aria-label="Show ${esc(label)} pages">▾</button><ul class="sub">${sub}</ul></li>`;
    })
    .join('')}</ul>`;
}

function page({ slug, title, description, body, ogImage, ogAlt, script = '', ld = '', noindex = false }) {
  const fullTitle = slug === '/' ? config.homeTitle || `${config.siteName}: ${config.tagline}` : `${title} · ${config.siteName}`;
  const canonical = `https://${config.domain}${slug}`;
  const navHtml = navTree(slug);
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
<meta property="og:image" content="https://${esc(config.domain)}${esc(ogImage || '/og-image.jpg')}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(ogAlt || 'Loveless Gaming: I break games, then I fix them. Two taped-on screenshots, a modded KCD2 courtyard and SolClient map editor.')}">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${href('/favicon.svg')}" type="image/svg+xml">
<link rel="apple-touch-icon" href="${href('/apple-touch-icon.png')}">
<link rel="preload" href="${href('/fonts/bungee-latin-400-normal.woff2')}" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${href('/fonts/ibm-plex-sans-latin-400-normal.woff2')}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${href('/styles.css')}">
${noindex ? '<meta name="robots" content="noindex">\n' : ''}${ld}
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
    <span>${config.signOff ? `<span class="footer-sign">${esc(config.signOff)}</span><br>` : ''}© ${year} ${esc(config.author || config.siteName)}</span>
    <span class="footer-links">${(config.links || [])
      .filter((l) => l.url)
      .map((l) => `<a href="${esc(l.url)}" rel="noopener">${esc(l.label)}</a>`)
      .join('')}${config.contactEmail ? `<a href="mailto:${esc(config.contactEmail)}">Contact</a>` : ''}${hasSupport ? `<a href="${href('/support/')}">Support ♥</a>` : ''}</span>
  </div>
</footer>
${script}
<script>
// Dropdown menus: hover/focus opens them on desktop; the ▾ button opens them on touch screens.
document.querySelectorAll('.sub-toggle').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation();
  const li = b.parentElement, open = !li.classList.contains('open');
  document.querySelectorAll('.has-sub.open').forEach((o) => { o.classList.remove('open'); o.querySelector('.sub-toggle').setAttribute('aria-expanded', 'false'); });
  li.classList.toggle('open', open); b.setAttribute('aria-expanded', String(open));
}));
document.addEventListener('click', () => document.querySelectorAll('.has-sub.open').forEach((o) => o.classList.remove('open')));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.has-sub.open').forEach((o) => o.classList.remove('open')); });
</script>
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
${s.adult?.items?.length ? `<section class="wrap section">
  <details class="adult">
    <summary><span class="badge-18">18+</span> Adult mods in this setup <span class="meta">(hidden; click to show)</span></summary>
    <p class="meta">${esc(s.adult.note)}</p>
    <ul class="modlist wide">${s.adult.items.map((a) => `<li><strong>${esc(a.name)} <span class="by">by ${esc(a.author)}</span></strong><span>${esc(a.why)}</span></li>`).join('')}</ul>
  </details>
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
  ${s.fixes ? `<h2>Get the fixes</h2><p>${esc(s.fixes.text)} <a href="${esc(s.fixes.url)}" rel="noopener">Loveless Mod Fixes on GitHub →</a></p>` : ''}
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

// Discord invite as a sticky note; pages pass their own heading and line.
const discordBand = (title, text) =>
  discordUrl
    ? `<section class="band">
  <div class="wrap band-inner">
    <div class="note-card">
      <h2>${title}</h2>
      <p>${text}</p>
      <a class="btn btn-discord" href="${esc(discordUrl)}" rel="noopener">Join the Discord</a>
    </div>
  </div>
</section>`
    : '';

const newsletter = config.newsletterUrl
  ? `<section class="band">
  <div class="wrap band-inner">
    <div class="note-card">
      <h2>Get new stuff by email</h2>
      <p>New mods, tools, books and articles. No spam, unsubscribe any time.</p>
      <a class="btn" href="${esc(config.newsletterUrl)}" rel="noopener">Join the list</a>
    </div>
  </div>
</section>`
  : '';

// ---------- pages ----------

const latestArticle = medium.items[0];

// The headline of a changelog entry: its bold lead-in if it has one, else its first sentence.
const changeHeadline = (item) => {
  const bold = item.match(/^\*\*(.+?)\*\*/);
  const t = (bold ? bold[1] : item.split(/(?<=\.)\s/)[0]).replace(/[.:]\s*$/, '');
  return t.length > 110 ? t.slice(0, 110).replace(/\s+\S*$/, '') + '…' : t;
};
const latestSol = solChanges[0];
// Screenshots shown beside SolClient on the home page (indexes into solclient-screenshots.json).
const homeShots = (sol.homeShots || [17, 15, 1]).filter((i) => solShots.shots[i]);

// Home page personal bits live in content/home.json: intro, stickers, pinned photos, "now working on".
// {solVersion} in any text is replaced with SolClient's latest version from the changelog.
const fill = (s) => String(s ?? '').replace(/\{solVersion\}/g, solVersion || '');
const homeIntro = fill(den.intro || config.tagline);

const stickerHtml = (den.stickers || [])
  .map((s) => `<a class="sticker${s.color ? ` ${esc(s.color)}` : ''}" href="${esc(href(s.url))}">${esc(fill(s.text))}</a>`)
  .join('');

const pinHtml = (den.pins || [])
  .slice(0, 2)
  .map((p) => `<figure class="pin"><a href="${esc(href(p.url || p.img))}"><img src="${esc(href(p.img))}" alt="${esc(p.alt || p.caption)}" width="960" height="600"></a><figcaption>${esc(p.caption)}</figcaption></figure>`)
  .join('');

const statusLabel = { wip: 'in progress', testing: 'testing', next: 'up next', done: 'done' };
const nowItems = (den.now || []).map((n) => {
  // "solclient": the note comes from the newest changelog entry, so it never goes stale.
  const note = n.auto === 'solclient' && latestSol ? `v${latestSol.version}: ${changeHeadline(latestSol.items[0])}.` : fill(n.note);
  const what = n.url ? `<a href="${esc(href(n.url))}"${/^https?:/.test(n.url) ? ' rel="noopener"' : ''}>${esc(fill(n.what))}</a>` : esc(fill(n.what));
  return `<li><span class="what">${what}</span><span class="status ${esc(n.status || '')}">${esc(n.label || statusLabel[n.status] || n.status || '')}</span><span class="note">${esc(note)}</span></li>`;
});

// Releases and setups as one hand-made list (not a card grid).
const madeItems = [
  ...releases.map((r) => {
    const main = r.links?.[0];
    return `<li>
      <h3>${main?.url ? `<a href="${esc(href(main.url))}" rel="noopener">${esc(r.name)}</a>` : esc(r.name)}</h3>
      <p>${esc(r.summary)}</p>
      <p class="tags">${String(r.game || '').split(/\s*·\s*/).filter(Boolean).map((g) => `<span>${esc(g)}</span>`).join('')}${r.version ? `<span>v${esc(r.version)}</span>` : ''}${r.updated ? `<span>${esc(fmtDate(r.updated))}</span>` : ''}</p>
      ${main?.url ? `<a class="btn btn-small btn-ghost go" href="${esc(href(main.url))}" rel="noopener">${esc(main.label)} →</a>` : ''}
    </li>`;
  }),
  ...setups.map((s) => `<li>
      <h3><a href="${href(`/mods/${s.slug}/`)}">${esc(s.title)}</a></h3>
      <p>${esc(s.summary)}</p>
      <p class="tags"><span>${esc(s.game)}</span><span>full setup</span>${s.updated ? `<span>${esc(fmtDate(s.updated))}</span>` : ''}</p>
      <a class="btn btn-small btn-ghost go" href="${href(`/mods/${s.slug}/`)}">Read it →</a>
    </li>`),
];

const videoHtml = youtube.items.slice(0, 3).map((v) => `<figure class="video"><a href="https://www.youtube.com/watch?v=${esc(v.id)}" rel="noopener"><img src="${href(`/img/yt/${v.id}.jpg`)}" alt="" width="320" height="180" loading="lazy"><figcaption>${esc(v.title)}<span class="when">${esc(fmtDate(v.published))}</span></figcaption></a></figure>`);
const twitchUrl = ((config.links || []).find((l) => /twitch/i.test(l.label)) || {}).url || '';
const youtubeUrl = ((config.links || []).find((l) => /youtube/i.test(l.label)) || {}).url || '';

const home = page({
  slug: '/',
  description: config.description,
  ld: jsonLd({
    '@graph': [
      { '@type': 'WebSite', name: config.siteName, url: `https://${config.domain}/` },
      {
        '@type': 'Organization',
        name: config.siteName,
        url: `https://${config.domain}/`,
        logo: `https://${config.domain}/apple-touch-icon.png`,
        ...(config.contactEmail ? { email: config.contactEmail } : {}),
        sameAs: (config.links || []).map((l) => l.url).filter((u) => /^https?:/.test(u)),
      },
    ],
  }),
  body: `<section class="den-hero">
  <div class="wrap">
    <div>
      ${den.hi ? `<p class="hi">${esc(den.hi)}</p>` : ''}
      <h1>${esc(den.headline || 'I break games.')}${den.headline2 ? `<span class="then">${esc(den.headline2)}</span>` : ''}</h1>
      <p class="lede">${esc(homeIntro)}</p>
      ${stickerHtml ? `<div class="stickers">${stickerHtml}</div>` : ''}
      <div class="actions">
        <a class="btn" href="${href('/mods/')}">Browse mods</a>
        <a class="btn btn-ghost" href="${href('/solclient/')}">See SolClient</a>
        ${discordUrl ? `<a class="btn btn-discord" href="${esc(discordUrl)}" rel="noopener">Join the Discord</a>` : ''}
      </div>
    </div>
    ${pinHtml ? `<div class="pins">${pinHtml}</div>` : ''}
  </div>
</section>
${nowItems.length ? `<section class="wrap section">
  <h2 class="rule-title">Now working on</h2>
  <ul class="now-list">${nowItems.join('')}</ul>
</section>` : ''}
${madeItems.length ? `<section class="wrap section">
  <h2 class="rule-title">Stuff I've made <a href="${href('/mods/')}">all mods →</a></h2>
  <ul class="made">${madeItems.join('')}</ul>
</section>` : ''}
<section class="wrap section">
  <div class="feature sol-feature">
    <div class="sol-feature-text">
      <p class="eyebrow">the big one · ${esc(sol.status)}${solVersion ? ` · v${esc(solVersion)}` : ''}</p>
      <h2>${esc(sol.name)} for Furcadia</h2>
      <p>${esc(sol.tagline)}</p>
      ${latestSol ? `<p class="latest-update"><span class="pill">new in v${esc(latestSol.version)}</span> ${esc(changeHeadline(latestSol.items[0]))}${latestSol.items.length > 1 ? `, and ${latestSol.items.length - 1} more` : ''}. <a href="${href('/solclient/#updates')}">What's new →</a></p>` : ''}
      <div class="actions">
        <a class="btn" href="${href('/solclient/')}">Learn more</a>
        <a class="btn btn-ghost" href="${href('/solclient/screenshots/')}">All ${solShots.shots.length} screenshots</a>
      </div>
    </div>
    <div class="sol-feature-shots">${homeShots.map((i) => `<a href="${href(`/solclient/screenshots/#shot-${String(i + 1).padStart(2, '0')}`)}"><img src="${href(solShots.dir + solShots.shots[i].thumb)}" alt="${esc(solShots.shots[i].title)}" width="640" height="360" loading="lazy"></a>`).join('')}</div>
  </div>
</section>
${medium.items.length ? `<section class="wrap section">
  <h2 class="rule-title">Latest articles <a href="${href('/writing/')}">all articles →</a></h2>
  <div class="grid three">${medium.items.slice(0, 3).map(articleCard).join('')}</div>
</section>` : ''}
${videoHtml.length ? `<section class="wrap section">
  <h2 class="rule-title">On my YouTube ${youtubeUrl ? `<a href="${esc(youtubeUrl)}" rel="noopener">channel →</a>` : ''}</h2>
  <div class="videos">${videoHtml.join('')}</div>
  ${twitchUrl ? `<p class="meta" style="margin-top:22px">I stream on <a href="${esc(twitchUrl)}" rel="noopener">Twitch</a> too, when I'm not breaking something.</p>` : ''}
</section>` : ''}
${!hasBooks || !hasArticles ? `<section class="wrap section">
  <p class="coming">Coming later: ${[!hasBooks && 'books', !hasArticles && 'articles'].filter(Boolean).join(' and ')}, written as ${esc(config.penName || config.siteName)}${!hasArticles && mediumProfile ? `. <a href="${esc(mediumProfile)}" rel="noopener">Follow on Medium →</a>` : '.'}</p>
</section>` : ''}
${newsletter || discordBand('Come hang out!', 'Mod help, SolClient previews and test builds, and people who play the same games. Everyone is welcome.')}`,
});

const modsPage = page({
  slug: '/mods/',
  title: 'Free game mods, modding tools and fixes',
  description: `Free mods, modding tools and compatibility fixes from ${config.siteName}${releases.length ? `: ${releases.map((r) => r.name).join(', ')}` : ''}${setups.length ? `, plus full modded setups for ${setups.map((s) => s.game).join(', ')}` : ''}.`,
  body: `<section class="page-head wrap"><p class="kicker">free, always</p><h1>Mods and tools</h1><p class="lede">Everything I've released, plus the setups I actually play. Downloads live on GitHub and the mod sites, linked from each one.</p></section>
<section class="wrap section">
  <h2>Releases and tools</h2>
  ${releases.length ? `<div class="grid three">${releases.map(modCard).join('')}</div>` : empty('First releases coming soon.')}
  <p class="meta">Playing Furcadia? See <a href="${href('/solclient/')}">SolClient</a>, my add-on for the Furcadia client.</p>
</section>
${setups.length ? `<section class="wrap section">
  <h2>My setups</h2>
  <p class="meta">The full modded setups I play, with credit to the collections they're built on, what I changed, and what it took to make them run.</p>
  <div class="grid three">${setups.map(setupCard).join('')}</div>
</section>` : ''}
${games.length ? `<section class="wrap section">
  <h2>Games I mod</h2>
  <ul class="chips">${games.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
</section>` : ''}
${discordBand('Stuck on a crash or a load order?', 'Ask in the Discord. Bring your log and we\'ll work it out.')}`,
});

const booksPage = page({
  slug: '/books/',
  title: 'Books',
  noindex: !hasBooks,
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
  noindex: !hasArticles,
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

function shotFig(sh, i, big = false) {
  const n = String(i + 1).padStart(2, '0');
  return `<figure class="shot" id="shot-${n}">
  <a href="${href(solShots.dir + sh.file)}" data-i="${i}"><img src="${href(solShots.dir + sh.thumb)}" alt="${esc(sh.title)}: ${esc(sh.caption)}" width="640" height="360" loading="lazy"></a>
  <figcaption><strong>${esc(sh.title)}</strong>${big ? `<span>${esc(sh.caption)}</span>` : ''}</figcaption>
</figure>`;
}

const lightbox = `<dialog class="lightbox" aria-label="Screenshot viewer">
  <button class="lb-close" type="button" aria-label="Close">×</button>
  <button class="lb-prev" type="button" aria-label="Previous screenshot">‹</button>
  <figure><img alt=""><figcaption><strong></strong><span></span><em></em></figcaption></figure>
  <button class="lb-next" type="button" aria-label="Next screenshot">›</button>
</dialog>
<script>
(() => {
  const shots = ${JSON.stringify(solShots.shots.map((s) => ({ src: href(solShots.dir + s.file), t: s.title, c: s.caption })))};
  const d = document.querySelector('.lightbox'), img = d.querySelector('img'), cap = d.querySelector('figcaption');
  let i = 0, x0 = null;
  const show = (n) => {
    i = (n + shots.length) % shots.length;
    img.src = shots[i].src; img.alt = shots[i].t;
    cap.querySelector('strong').textContent = shots[i].t;
    cap.querySelector('span').textContent = shots[i].c;
    cap.querySelector('em').textContent = (i + 1) + ' / ' + shots.length;
    history.replaceState(null, '', '#shot-' + String(i + 1).padStart(2, '0'));
  };
  document.querySelectorAll('.shot a[data-i]').forEach((a) => a.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault(); show(+a.dataset.i); d.showModal();
  }));
  d.querySelector('.lb-prev').onclick = () => show(i - 1);
  d.querySelector('.lb-next').onclick = () => show(i + 1);
  d.querySelector('.lb-close').onclick = () => d.close();
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  d.addEventListener('close', () => history.replaceState(null, '', location.pathname));
  d.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') show(i - 1); if (e.key === 'ArrowRight') show(i + 1); });
  d.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  d.addEventListener('touchend', (e) => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50) show(i + (dx < 0 ? 1 : -1)); x0 = null; });
  const fromHash = () => {
    const m = location.hash.match(/^#shot-([0-9]+)$/);
    if (m && shots[+m[1] - 1] && !d.open) { show(+m[1] - 1); d.showModal(); }
  };
  window.addEventListener('hashchange', fromHash);
  if (document.readyState === 'complete') fromHash(); else window.addEventListener('load', fromHash);
})();
</script>`;

const shotsPage = page({
  slug: '/solclient/screenshots/',
  title: solShots.title,
  description: solShots.intro,
  ogImage: solShots.dir + solShots.og,
  ogAlt: 'SolClient Map Editor showing a Furcadia dream drawn with its real art',
  script: lightbox,
  body: `<section class="page-head wrap">
  <p class="kicker"><a href="${href('/solclient/')}">SolClient</a> · Screenshots</p>
  <h1>SolClient preview</h1>
  <p class="lede">${esc(solShots.intro)}</p>
  <div class="actions">${discordUrl ? `<a class="btn btn-discord" href="${esc(discordUrl)}" rel="noopener">Follow development on Discord</a>` : ''}<a class="btn btn-ghost" href="${href('/solclient/')}">About SolClient</a></div>
</section>
<section class="wrap section">
  <div class="shots big">${solShots.shots.map((sh, i) => shotFig(sh, i, true)).join('')}</div>
  <p class="meta">Click a screenshot to view it full size; use the arrow keys or swipe to move between them. Each one has its own link (for example <code>#shot-18</code>).</p>
  <p class="meta">${esc(sol.disclaimer)}</p>
</section>`,
});

const solPage = page({
  slug: '/solclient/',
  title: 'SolClient: a modern add-on for the Furcadia client',
  description: sol.tagline,
  ld: jsonLd({
    '@type': 'SoftwareApplication',
    name: sol.name.replace(/™/g, ''),
    description: sol.tagline,
    url: `https://${config.domain}/solclient/`,
    image: `https://${config.domain}${solShots.dir}${solShots.og}`,
    applicationCategory: 'GameApplication',
    operatingSystem: 'Windows',
    ...(solVersion ? { softwareVersion: solVersion } : {}),
    ...(sol.changelog ? { releaseNotes: sol.changelog } : {}),
    author: { '@type': 'Organization', name: config.siteName, url: `https://${config.domain}/` },
  }),
  body: `<section class="page-head wrap">
  <p class="kicker">Furcadia · ${esc(sol.status)}${solVersion ? ` · v${esc(solVersion)}` : ''}</p>
  <h1>${esc(sol.name)}</h1>
  <p class="lede">${esc(sol.tagline)}</p>
  <div class="actions">
    ${discordUrl ? `<a class="btn btn-discord" href="${esc(discordUrl)}" rel="noopener">Follow development on Discord</a>` : ''}
    ${sol.changelog ? `<a class="btn btn-ghost" href="${esc(sol.changelog)}" rel="noopener">Changelog</a>` : ''}
    ${hasSupport ? `<a class="btn btn-ghost" href="${href('/support/')}">Support development ♥</a>` : ''}
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
  <h2>Screenshots</h2>
</section>
<section class="wrap section">
  <div class="shots">${solShots.shots.slice(0, 6).map((sh, i) => shotFig(sh, i)).join('')}</div>
  <p><a class="btn btn-ghost" href="${href('/solclient/screenshots/')}">See all ${solShots.shots.length} screenshots →</a></p>
</section>
${solChanges.length ? `<section class="wrap section prose" id="updates">
  <h2>Latest updates</h2>
  ${solChanges.slice(0, 3).map((r) => `<div class="release-note">
    <h3>v${esc(r.version)}${r.date ? ` <span class="meta">${esc(fmtDate(r.date))}</span>` : ''}</h3>
    <ul>${r.items.map((i) => `<li>${mdInline(i)}</li>`).join('')}</ul>
  </div>`).join('\n  ')}
  ${sol.changelog ? `<p><a href="${esc(sol.changelog)}" rel="noopener">Full changelog on GitHub (${solChanges.length} releases) →</a></p>` : ''}
</section>` : ''}
<section class="wrap section prose">
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
    ${hasBooks ? `<li><a href="${href('/books/')}">Books</a></li>` : ''}
    ${hasSupport ? `<li><a class="primary" href="${href('/support/')}">Support my work ♥</a></li>` : ''}
    ${hasArticles ? `<li><a href="${href('/writing/')}">Writing</a></li>` : ''}
    ${config.newsletterUrl ? `<li><a class="primary" href="${esc(config.newsletterUrl)}" rel="noopener">Join the email list</a></li>` : ''}
    ${linkRows.map((l) => `<li><a href="${esc(l.url)}" rel="noopener">${esc(l.label)}</a></li>`).join('\n    ')}
    ${config.contactEmail ? `<li><a href="mailto:${esc(config.contactEmail)}">Email me</a></li>` : ''}
  </ul>
</section>`,
});

const supportPage = page({
  slug: '/support/',
  title: 'Support',
  description: support.intro,
  body: `<section class="page-head wrap">
  <p class="kicker">Support</p>
  <h1>Support Loveless Gaming</h1>
  <p class="lede">${esc(support.intro || '')}</p>
</section>
<section class="wrap section">
  <div class="grid three">
    ${supportLinks.map((p) => `<div class="card support-card"><div class="card-body">
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.note || '')}</p>
      <div class="actions"><a class="btn" href="${esc(p.url)}" rel="noopener">Support on ${esc(p.name)}</a></div>
    </div></div>`).join('')}
  </div>
</section>
${support.promises?.length ? `<section class="wrap section prose">
  <h2>Good to know</h2>
  <ul class="ticks">${support.promises.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
</section>` : ''}
<section class="wrap section prose">
  <p class="meta">Questions? ${config.contactEmail ? `Email <a href="mailto:${esc(config.contactEmail)}">${esc(config.contactEmail)}</a>` : ''}${discordUrl ? ` or ask in the <a href="${esc(discordUrl)}" rel="noopener">Discord</a>` : ''}.</p>
</section>`,
});

const notFound = page({
  slug: '/404.html',
  title: 'Not found',
  body: `<section class="page-head wrap"><p class="kicker">error 404</p><h1>Nothing here.</h1><p class="lede">I probably moved it. Or broke it. That happens a lot around here.</p><div class="actions"><a class="btn" href="${href('/')}">Back to the start</a></div></section>`,
});

// ---------- write ----------

await rm(out, { recursive: true, force: true });
await cp(path.join(root, 'static'), out, { recursive: true, filter: (src) => path.basename(src) !== 'README.md' });

const pages = { 'index.html': home, 'mods/index.html': modsPage, 'solclient/index.html': solPage, 'solclient/screenshots/index.html': shotsPage, 'books/index.html': booksPage, 'writing/index.html': writingPage, 'links/index.html': linksPage, 'about/index.html': aboutPage, ...(hasSupport ? { 'support/index.html': supportPage } : {}), '404.html': notFound };
for (const s of setups) pages[`mods/${s.slug}/index.html`] = setupPage(s);
if (youtube.thumbs) {
  await mkdir(path.join(out, 'img/yt'), { recursive: true });
  for (const [id, buf] of Object.entries(youtube.thumbs)) await writeFile(path.join(out, 'img/yt', `${id}.jpg`), buf);
}
for (const [file, html] of Object.entries(pages)) {
  await mkdir(path.dirname(path.join(out, file)), { recursive: true });
  await writeFile(path.join(out, file), html);
}

const urls = ['/', '/mods/', ...setups.map((s) => `/mods/${s.slug}/`), '/solclient/', '/solclient/screenshots/', ...(hasBooks ? ['/books/'] : []), ...(hasArticles ? ['/writing/'] : []), '/links/', '/about/', ...(hasSupport ? ['/support/'] : [])];
await writeFile(
  path.join(out, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>https://${config.domain}${u}</loc></url>`).join('\n')}\n</urlset>\n`
);
await writeFile(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: https://${config.domain}/sitemap.xml\n`);

// security.txt (RFC 9116): who to tell about a security problem. Security scanners and site-reputation
// services look for it. Expires is required; the daily rebuild keeps it about 6 months ahead.
const securityContact = config.securityEmail || config.contactEmail;
if (securityContact) {
  const expires = new Date(Date.now() + 182 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');
  await mkdir(path.join(out, '.well-known'), { recursive: true });
  await writeFile(
    path.join(out, '.well-known', 'security.txt'),
    `Contact: mailto:${securityContact}\nExpires: ${expires}\nPreferred-Languages: en\nCanonical: https://${config.domain}/.well-known/security.txt\n`
  );
}

console.log(`Built ${Object.keys(pages).length} pages into dist/${base ? ` (base path ${base})` : ''}.`);
