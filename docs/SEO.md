# SEO, metadata and sharing

Droply is a single-page product: one indexable document plus private, code-based transfer routes
that live in the URL fragment and never reach a crawler. This file records what is implemented, what
is deliberately not claimed, and the manual steps that still need a real account.

- **Canonical host:** `https://droply-files.vercel.app/`
- **Repository:** https://github.com/Alshahriar-07/Droply
- **Publisher:** Eagox Studio (https://alshahriarsayon.vercel.app/)

`droply.vercel.app` is **not** a Droply domain. Nothing in this repository references it. Do not add
redirects from it: it is not controlled by this project, so a redirect rule would be dead code.

## Canonical URL policy

- One canonical per page, absolute, HTTPS, with a trailing slash at the root only:
  `https://droply-files.vercel.app/`.
- `vercel.json` sets `"trailingSlash": false`, so `/index.html` is not an alternate address; requests
  to it are served as the same document and canonical resolves to `/`.
- Transfer links use the fragment (`/#/receive?code=…`). Fragments are never sent to a server, are
  never indexed, and are stripped by the app on load (`history.replaceState`) once read.
- No page duplicates metadata: the head block exists only in `index.html`.

## Metadata in `index.html`

| Tag | Value |
|---|---|
| `<title>` | Droply — Fast & Private Peer-to-Peer File Transfer |
| `meta[name=description]` | Send files directly between devices with Droply. Connect using a simple transfer code or QR scan and share files through peer-to-peer technology. |
| `link[rel=canonical]` | https://droply-files.vercel.app/ |
| `meta[name=robots]` | `index, follow, max-image-preview:large, max-snippet:-1` |
| `meta[name=theme-color]` | `#f7f8fa` |
| `html[lang]` | `en` |
| `og:type / og:site_name / og:locale` | `website` / `Droply` / `en_US` |
| `og:title`, `og:description`, `og:url` | Same copy as the title/description, canonical URL |
| `og:image` | `https://droply-files.vercel.app/assets/og-image.png` (1200×630, `og:image:alt` set) |
| `twitter:card` | `summary_large_image`, with matching title/description/image |

`meta[name=author]`, `meta[name=publisher]` and `meta[name=application-name]` credit Eagox Studio as
the publisher while Droply stays the product name.

## Structured data

A single `application/ld+json` block with an `@graph` of three nodes, all cross-referenced by `@id`:

- `WebSite` — name, URL, language, publisher.
- `Organization` — Eagox Studio, portfolio URL, founder, repository in `sameAs`.
- `SoftwareApplication` — `UtilitiesApplication`, `operatingSystem: "Web Browser"`,
  `isAccessibleForFree: true`, a zero-price `Offer`, `license`, `codeRepository`,
  `featureList`, and `publisher`/`isPartOf` links.

Facts only: no `aggregateRating`, no `review`, no download or user counts, no awards, no pricing other
than "free to use". Validate with the [Rich Results Test](https://search.google.com/test/rich-results)
and the [Schema.org validator](https://validator.schema.org/) after deploying.

## robots.txt and sitemap.xml

`robots.txt`:

- Allows `/`, `/assets/`, `/css/`, `/js/` (crawlers must fetch CSS/JS to render the page).
- Disallows `/api/` and the error routes (`/error`, `/403`, `/404`, `/410`, `/429`, `/500`, `/502`,
  `/503`, `/504`).
- Declares `Sitemap: https://droply-files.vercel.app/sitemap.xml`.

`sitemap.xml` contains exactly one URL — the homepage — with a `lastmod` that must be updated when the
page content actually changes. Error pages, transfer routes and API endpoints are never listed.

## Error pages

`/403`, `/404`, `/410`, `/429`, `/500`, `/502`, `/503`, `/504` return their real status code (via
`api/error.js`, see [ERRORS.md](ERRORS.md)) and are excluded from indexing three ways: `<meta
name="robots" content="noindex, nofollow">`, an `X-Robots-Tag` header in `vercel.json`, and the
`Disallow` rules above.

## Search engine verification

No verification token is committed, because an invented token fails verification and misleads
visitors. To verify the deployment:

1. Open [Google Search Console](https://search.google.com/search-console) → **Add property** →
   **URL prefix** → `https://droply-files.vercel.app/`.
2. Choose the **HTML tag** method and copy the token from the `<meta name="google-site-verification">`
   snippet it shows.
3. Add that line to the head of `index.html` (a commented example sits next to the other metadata
   tags), or inject it at build time from a Vercel environment variable.
4. Deploy, then press **Verify**.
5. Submit `https://droply-files.vercel.app/sitemap.xml` under **Sitemaps**.

For [Bing Webmaster Tools](https://www.bing.com/webmasters), either import the site from Google
Search Console or use the `msvalidate.01` meta tag, which is also pre-commented in `index.html`.

## What this project does *not* claim

- No ranking, traffic or indexing guarantees — submission does not equal indexing.
- No unlimited file sizes, no guaranteed connectivity on every network, no universal browser support.
- No "end-to-end encryption beyond WebRTC DTLS": the page says WebRTC DTLS, and that a configured
  TURN relay forwards encrypted packets without storing them.
- No testimonials, statistics or ratings. The homepage copy describes only what the code does.

## Performance notes relevant to Core Web Vitals

- No framework, no bundler, no webfont download: typography uses the system UI stack, so there is no
  font-swap shift.
- CSS is split by concern and loaded with five plain `<link>` tags; nothing is render-blocking beyond
  those small files.
- Images declare intrinsic `width`/`height` (`logo-96.png` in the header and the OG image) to avoid
  layout shift. The logo ships at its display size, not at 512 px.
- The QR generation and decoding libraries are vendored and loaded as classic scripts before the
  module, so the app boots without a network round trip to a CDN.
- The intro overlay animates transform/opacity only and is removed from the DOM; `prefers-reduced-motion`
  shortens it to a near-instant fade.

## Manual checklist after a deploy

1. `curl -I https://droply-files.vercel.app/` → 200, HTTPS, HSTS present.
2. `curl -I https://droply-files.vercel.app/403` → 403 with `X-Robots-Tag: noindex`.
3. `curl -I https://droply-files.vercel.app/missing-page` → 404.
4. `curl https://droply-files.vercel.app/robots.txt` and `…/sitemap.xml` → correct host, valid XML.
5. Rich Results Test on the homepage → `SoftwareApplication`, `Organization`, `WebSite` detected.
6. Open Graph preview (e.g. the LinkedIn Post Inspector) → title, description and 1200×630 image.
7. Lighthouse (mobile) → check SEO and accessibility are 100; note the real numbers, do not assume.
8. Confirm no console requests to `localhost` or `http://` on the production page.
