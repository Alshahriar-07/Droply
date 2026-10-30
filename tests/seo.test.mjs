/**
 * Production SEO checks.
 *
 * These assert the metadata and crawl files that ship with the site, so a
 * rename, a stale domain or a broken asset path fails the suite instead of
 * being discovered in Search Console weeks later.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ORIGIN = "https://droply-files.vercel.app";
const CANONICAL = `${ORIGIN}/`;
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const index = read("index.html");

/** Reads width/height from a PNG's IHDR chunk without any dependency. */
function pngSize(file) {
  const buffer = fs.readFileSync(path.join(ROOT, file));
  assert.equal(buffer.subarray(1, 4).toString("ascii"), "PNG", `${file} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const metaContent = (attr, value) => {
  const pattern = new RegExp(`<meta\\s+${attr}="${value}"\\s+content="([^"]*)"`, "i");
  return index.match(pattern)?.[1]?.replaceAll("&amp;", "&") ?? null;
};

test("title and description are unique and within search-result limits", () => {
  const title = index.match(/<title>([^<]+)<\/title>/)?.[1].replaceAll("&amp;", "&");
  assert.ok(title, "missing <title>");
  assert.ok(title.length <= 65, `title is ${title.length} chars`);
  assert.match(title, /Droply/);
  assert.match(title, /Peer-to-Peer File Transfer/);

  const description = metaContent("name", "description");
  assert.ok(description, "missing meta description");
  assert.ok(description.length >= 120 && description.length <= 165, `description is ${description.length} chars`);
  assert.doesNotMatch(description, /unlimited|guaranteed|any file size/i);
});

test("canonical, og:url and sitemap agree on one HTTPS host", () => {
  assert.match(index, new RegExp(`<link rel="canonical" href="${CANONICAL}"`));
  assert.equal(metaContent("property", "og:url"), CANONICAL);

  const sitemap = read("sitemap.xml");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locations, [CANONICAL], "sitemap should list exactly the homepage");

  const robots = read("robots.txt");
  assert.match(robots, new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, "m"));
  assert.match(robots, /^Disallow: \/api\/$/m);
});

test("social metadata points at a real 1200x630 image", () => {
  assert.equal(metaContent("property", "og:image"), `${ORIGIN}/assets/og-image.png`);
  assert.equal(metaContent("name", "twitter:image"), `${ORIGIN}/assets/og-image.png`);
  assert.equal(metaContent("name", "twitter:card"), "summary_large_image");
  assert.equal(metaContent("property", "og:image:width"), "1200");
  assert.equal(metaContent("property", "og:image:height"), "630");
  assert.ok(metaContent("property", "og:image:alt"));
  assert.ok(metaContent("property", "og:title"));
  assert.ok(metaContent("property", "og:description"));
  assert.equal(metaContent("property", "og:site_name"), "Droply");

  assert.deepEqual(pngSize("assets/og-image.png"), { width: 1200, height: 630 });
});

test("JSON-LD is valid and contains only defensible facts", () => {
  const raw = index.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(raw, "missing JSON-LD block");

  const data = JSON.parse(raw);
  assert.equal(data["@context"], "https://schema.org");
  const nodes = data["@graph"];
  assert.ok(Array.isArray(nodes) && nodes.length >= 3);

  const byType = Object.fromEntries(nodes.map((node) => [node["@type"], node]));
  for (const type of ["WebSite", "Organization", "SoftwareApplication"]) {
    assert.ok(byType[type], `missing ${type} node`);
  }

  assert.equal(byType.WebSite.url, CANONICAL);
  assert.equal(byType.SoftwareApplication.url, CANONICAL);
  assert.equal(byType.SoftwareApplication.applicationCategory, "UtilitiesApplication");
  assert.equal(byType.SoftwareApplication.operatingSystem, "Web Browser");
  assert.equal(byType.Organization.name, "Eagox Studio");
  assert.equal(byType.SoftwareApplication.codeRepository, "https://github.com/Alshahriar-07/Droply");

  const plain = JSON.stringify(data);
  for (const forbidden of ["aggregateRating", "review", "reviewCount", "ratingValue", "downloadCount", "award"]) {
    assert.doesNotMatch(plain, new RegExp(forbidden, "i"), `structured data must not invent ${forbidden}`);
  }
});

test("error routes are noindex and absent from the sitemap", () => {
  for (const file of ["error.html", "404.html"]) {
    const html = read(file);
    assert.match(html, /<meta name="robots" content="noindex/i, `${file} must be noindex`);
    assert.match(html, /<meta name="x-robots-tag" content="noindex/i, `${file} needs the header hint`);
    assert.match(html, /<html lang="en"/);
  }

  const sitemap = read("sitemap.xml");
  for (const route of ["/403", "/404", "/410", "/429", "/500", "/502", "/503", "/504", "/error"]) {
    assert.ok(!sitemap.includes(route), `${route} must not be in the sitemap`);
    assert.ok(read("robots.txt").includes(`Disallow: ${route}`), `${route} must be disallowed`);
  }
});

test("every local asset referenced by the page exists", () => {
  const references = [
    ...index.matchAll(/(?:href|src)="((?:assets|css|js)\/[^"]+|[a-z0-9-]+\.(?:txt|xml|webmanifest|png|ico|svg))"/g),
  ].map((match) => match[1]);

  assert.ok(references.length > 10, "expected many local references");
  for (const reference of references) {
    assert.ok(fs.existsSync(path.join(ROOT, reference)), `missing ${reference}`);
  }

  assert.ok(fs.existsSync(path.join(ROOT, "assets/og-image.png")));
  assert.ok(fs.existsSync(path.join(ROOT, "api/error.js")), "branded error routes need the Edge function");
});

test("production files contain no retired domain or plaintext origin", () => {
  const production = ["index.html", "error.html", "404.html", "robots.txt", "sitemap.xml", "site.webmanifest", "vercel.json"];
  for (const file of production) {
    const text = read(file);
    assert.doesNotMatch(text, /(^|[^-\w.])droply\.vercel\.app/i, `${file} references the retired domain`);
    assert.doesNotMatch(text, /https?:\/\/localhost/, `${file} contains a localhost URL`);
    assert.doesNotMatch(text, /http:\/\/[a-z0-9.-]*vercel\.app/i, `${file} uses plain HTTP`);
  }
});

test("semantic structure: one H1 in the shell, declared language", () => {
  assert.match(index, /<html lang="en"/);
  const main = index.slice(index.indexOf("<main"), index.indexOf("</main>"));
  assert.equal((main.match(/<h1[\s>]/g) ?? []).length, 1, "the shell must expose exactly one h1");
  assert.match(main, /<h1>Loading Droply…<\/h1>/);
  assert.ok(index.includes('id="app"') && index.includes('tabindex="-1"'));
  assert.ok(index.includes('class="skip-link"'));
});

test("favicon set is complete", () => {
  for (const file of [
    "assets/favicon.svg",
    "assets/favicon.ico",
    "assets/favicon-32.png",
    "assets/icon-192.png",
    "assets/apple-touch-icon.png",
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `missing ${file}`);
  }

  assert.deepEqual(pngSize("assets/icon-192.png"), { width: 192, height: 192 });
  assert.deepEqual(pngSize("assets/apple-touch-icon.png"), { width: 180, height: 180 });

  const manifest = JSON.parse(read("site.webmanifest"));
  assert.equal(manifest.name, "Droply");
  assert.ok(manifest.icons.length >= 2);
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(ROOT, icon.src.replace(/^\//, ""))), `manifest icon missing: ${icon.src}`);
  }
});
