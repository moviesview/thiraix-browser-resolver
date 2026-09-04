import puppeteer from "@cloudflare/puppeteer";

const MEDIA_RE = /\.(m3u8|mp4|m4v|webm|mpd)(?:$|[?#])/i;
const HLS_CT_RE = /(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl)/i;
const VIDEO_CT_RE = /^video\//i;

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function classify(url, contentType = "") {
  if (/\.m3u8(?:$|[?#])/i.test(url) || HLS_CT_RE.test(contentType)) return "hls";
  if (/\.mpd(?:$|[?#])/i.test(url)) return "dash";
  if (/\.(mp4|m4v|webm)(?:$|[?#])/i.test(url) || VIDEO_CT_RE.test(contentType)) return "video";
  return null;
}

function allowedTarget(target, env) {
  const allowed = String(env.ALLOWED_HOSTS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

  if (!allowed.length) return false;
  const host = target.hostname.toLowerCase();
  return allowed.some((item) => host === item || host.endsWith(`.${item}`));
}

function isPublicHttpUrl(target) {
  if (!/^https?:$/.test(target.protocol)) return false;
  const h = target.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local")) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return false;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
  return true;
}

function rank(item) {
  let score = 0;
  if (item.type === "hls") score += 100;
  else if (item.type === "video") score += 80;
  else if (item.type === "dash") score += 60;
  if (/master|playlist|index/i.test(item.url)) score += 15;
  if (/1080|720/i.test(item.url)) score += 5;
  return score;
}

async function resolveWithBrowser(targetUrl, env) {
  const browser = await puppeteer.launch(env.BROWSER);
  const found = new Map();

  try {
    const page = await browser.newPage();

    const record = (url, contentType = "", source = "network") => {
      const type = classify(url, contentType);
      if (!type) return;
      if (!found.has(url)) found.set(url, { url, type, source, contentType });
    };

    page.on("response", async (response) => {
      try {
        const headers = response.headers();
        record(response.url(), headers["content-type"] || "", "response");
      } catch (_) {}
    });

    page.on("request", (request) => {
      try {
        const url = request.url();
        if (MEDIA_RE.test(url)) record(url, "", "request");
      } catch (_) {}
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Give normal page scripts time to initialize their player.
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Read media URLs exposed by the rendered DOM and browser performance log.
    const domUrls = await page.evaluate(() => {
      const out = [];
      for (const video of document.querySelectorAll("video")) {
        if (video.currentSrc) out.push(video.currentSrc);
        if (video.src) out.push(video.src);
        for (const source of video.querySelectorAll("source")) {
          if (source.src) out.push(source.src);
        }
      }
      for (const e of performance.getEntriesByType("resource")) {
        if (e && e.name) out.push(e.name);
      }
      return [...new Set(out)];
    });

    for (const url of domUrls) record(url, "", "rendered-page");

    const candidates = [...found.values()].sort((a, b) => rank(b) - rank(a));
    return candidates;
  } finally {
    await browser.close();
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({ ok: true });

    const incoming = new URL(request.url);
    if (incoming.pathname === "/") {
      return json({
        ok: true,
        service: "ThiraiX Browser Run Resolver",
        usage: "/resolve?url=https://allowed-host.example/page",
      });
    }

    if (incoming.pathname !== "/resolve") return json({ error: "Not found" }, 404);

    const raw = incoming.searchParams.get("url");
    if (!raw) return json({ error: "Missing url parameter." }, 400);

    let target;
    try {
      target = new URL(raw);
    } catch (_) {
      return json({ error: "Invalid URL." }, 400);
    }

    if (!isPublicHttpUrl(target)) return json({ error: "Only public HTTP/HTTPS URLs are supported." }, 400);
    if (!allowedTarget(target, env)) {
      return json({
        error: "This hostname is not in ALLOWED_HOSTS.",
        hostname: target.hostname,
      }, 403);
    }

    // Cache by source page URL. This reduces Browser Run usage when many users open the same movie.
    const cache = caches.default;
    const cacheKey = new Request(`https://resolver-cache.invalid/${encodeURIComponent(target.href)}`);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const data = await cached.json();
      return json({ ...data, cached: true });
    }

    let candidates;
    try {
      candidates = await resolveWithBrowser(target.href, env);
    } catch (error) {
      return json({
        error: "Browser Run could not resolve this page.",
        detail: String(error?.message || error),
        note: "The resolver does not bypass login, CAPTCHA, DRM, signed access, or other source access controls.",
      }, 502);
    }

    if (!candidates.length) {
      return json({
        error: "No public MP4/HLS/DASH media request was detected after rendering the page.",
        note: "The page may require a user interaction or use authentication, DRM, signed/session-specific access, or another unsupported delivery method.",
      }, 404);
    }

    const best = candidates[0];
    const payload = {
      videoUrl: best.url,
      type: best.type,
      source: best.source,
      candidates: candidates.slice(0, 8),
      cached: false,
    };

    // Default 10-minute cache. Change CACHE_TTL_SECONDS in Cloudflare variables if needed.
    const ttl = Math.max(30, Math.min(3600, Number(env.CACHE_TTL_SECONDS || 600)));
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(payload), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${ttl}`,
        },
      })
    );

    return json(payload);
  },
};
