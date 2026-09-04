import puppeteer from "@cloudflare/puppeteer";

const MEDIA_RE = /\.(m3u8|mp4|m4v|webm|mpd)(?:$|[?#])/i;
const HLS_CT_RE = /(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/mpegurl)/i;
const DASH_CT_RE = /application\/dash\+xml/i;
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
  if (!url || url.startsWith("blob:") || url.startsWith("data:")) return null;
  if (/\.m3u8(?:$|[?#])/i.test(url) || HLS_CT_RE.test(contentType)) return "hls";
  if (/\.mpd(?:$|[?#])/i.test(url) || DASH_CT_RE.test(contentType)) return "dash";
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
  if (item.type === "hls") score += 120;
  else if (item.type === "video") score += 100;
  else if (item.type === "dash") score += 80;
  if (/master|playlist|index/i.test(item.url)) score += 20;
  if (/1080|720/i.test(item.url)) score += 8;
  if (item.source === "response") score += 5;
  return score;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inspectAndStartMedia(frame) {
  try {
    return await frame.evaluate(async () => {
      const out = { urls: [], iframes: [], actions: [] };

      for (const video of document.querySelectorAll("video")) {
        if (video.currentSrc) out.urls.push(video.currentSrc);
        if (video.src) out.urls.push(video.src);
        for (const source of video.querySelectorAll("source")) {
          if (source.src) out.urls.push(source.src);
        }
        try {
          video.muted = true;
          video.playsInline = true;
          const result = video.play();
          if (result && typeof result.catch === "function") await result.catch(() => {});
          out.actions.push("video.play");
        } catch (_) {}
      }

      const selectors = [
        'button[aria-label*="play" i]',
        '[role="button"][aria-label*="play" i]',
        'button[title*="play" i]',
        '.vjs-big-play-button',
        '.jw-icon-playback',
        '.plyr__control[data-plyr="play"]',
        'button[data-plyr="play"]',
        '.mejs__play button'
      ];

      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none") {
          try {
            el.click();
            out.actions.push(`click:${selector}`);
            break;
          } catch (_) {}
        }
      }

      for (const iframe of document.querySelectorAll("iframe[src]")) {
        if (iframe.src) out.iframes.push(iframe.src);
      }

      for (const e of performance.getEntriesByType("resource")) {
        if (e && e.name) out.urls.push(e.name);
      }

      out.urls = [...new Set(out.urls)];
      out.iframes = [...new Set(out.iframes)];
      return out;
    });
  } catch (_) {
    return { urls: [], iframes: [], actions: [] };
  }
}

async function listServerControls(frame) {
  try {
    return await frame.evaluate(() => {
      const all = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')];
      const items = [];
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        const text = String(el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim();
        if (!/^server\s*\d+$/i.test(text)) continue;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        if (r.width <= 0 || r.height <= 0 || s.display === "none" || s.visibility === "hidden") continue;
        items.push({ index: i, text });
      }
      return items;
    });
  } catch (_) {
    return [];
  }
}

async function clickServerControl(frame, label) {
  try {
    return await frame.evaluate((wanted) => {
      const all = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')];
      const target = all.find((el) => {
        const text = String(el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim();
        return text.toLowerCase() === String(wanted).toLowerCase();
      });
      if (!target) return false;
      target.scrollIntoView({ block: "center", inline: "center" });
      target.click();
      return true;
    }, label);
  } catch (_) {
    return false;
  }
}


async function clickRealPlay(frame) {
  try {
    const selector = await frame.evaluate(() => {
      document.querySelectorAll('[data-thiraix-play-target]').forEach((el) => el.removeAttribute('data-thiraix-play-target'));

      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
      };

      const clickableAncestor = (el) => {
        let cur = el;
        for (let i = 0; cur && i < 5; i++, cur = cur.parentElement) {
          if (!visible(cur)) continue;
          const tag = cur.tagName?.toLowerCase();
          const role = cur.getAttribute?.('role');
          const onclick = cur.getAttribute?.('onclick');
          if (tag === 'button' || tag === 'a' || role === 'button' || onclick || getComputedStyle(cur).cursor === 'pointer') return cur;
        }
        return el;
      };

      // Prefer the exact first-stage control seen on this source.
      const textEls = [...document.querySelectorAll('button, a, div, span, p, [role="button"]')];
      let target = textEls.find((el) => /watch\s*&\s*download/i.test(String(el.innerText || el.textContent || '').trim()) && visible(el));
      if (target) target = clickableAncestor(target);

      if (!target) {
        const selectors = [
          '.vjs-big-play-button',
          '.jw-display-icon-container',
          '.jw-icon-display',
          '.jw-icon-playback',
          '.plyr__control--overlaid',
          '.plyr__control[data-plyr="play"]',
          'button[data-plyr="play"]',
          'button[aria-label*="play" i]',
          '[role="button"][aria-label*="play" i]',
          'button[title*="play" i]',
          '.mejs__overlay-button'
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && visible(el)) { target = el; break; }
        }
      }

      if (!target) {
        // Last resort: choose the largest visible clickable element in the central player area.
        const candidates = [...document.querySelectorAll('button, a, [role="button"], [onclick]')].filter(visible);
        candidates.sort((a,b) => {
          const ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
          return (rb.width*rb.height) - (ra.width*ra.height);
        });
        target = candidates.find((el) => {
          const r=el.getBoundingClientRect();
          const cx=r.left+r.width/2, cy=r.top+r.height/2;
          return cx > innerWidth*0.2 && cx < innerWidth*0.8 && cy > innerHeight*0.18 && cy < innerHeight*0.82;
        }) || null;
      }

      if (!target) return null;
      target.setAttribute('data-thiraix-play-target', '1');
      target.scrollIntoView({block:'center', inline:'center'});
      const r = target.getBoundingClientRect();
      return {
        selector: '[data-thiraix-play-target="1"]',
        text: String(target.innerText || target.textContent || '').replace(/\s+/g,' ').trim().slice(0,120),
        tag: target.tagName,
        rect: {x:r.x,y:r.y,width:r.width,height:r.height}
      };
    });

    if (!selector) return { clicked: false };
    const handle = await frame.$(selector.selector);
    if (!handle) return { clicked: false, target: selector };
    await handle.click({ delay: 80 });
    return { clicked: true, target: selector };
  } catch (error) {
    return { clicked: false, error: String(error?.message || error) };
  }
}

async function closeNewPages(browser, keepPages, diagnostics) {
  await sleep(900);
  const pages = await browser.pages();
  let closed = 0;
  for (const p of pages) {
    if (keepPages.includes(p)) continue;
    try {
      diagnostics.popupAttempts.push({ url: p.url(), action: 'closed' });
      await p.close();
      closed++;
    } catch (error) {
      diagnostics.popupAttempts.push({ url: p.url(), action: 'close-failed', error: String(error?.message || error) });
    }
  }
  return closed;
}

async function runTwoStagePlay(browser, page, found, diagnostics, waitMs) {
  // This source often requires: first real click -> ad tab, close ad -> second real click -> media.
  for (let round = 1; round <= 3 && !found.size; round++) {
    let clickedAny = false;
    const frames = page.frames();
    for (const frame of frames) {
      const result = await clickRealPlay(frame);
      if (!result.clicked) continue;
      clickedAny = true;
      diagnostics.playAttempts.push({ round, frame: frame.url(), ...result });
      await sleep(700);
      const closed = await closeNewPages(browser, [page], diagnostics);
      diagnostics.playAttempts.push({ round, frame: frame.url(), popupsClosed: closed });
      await sleep(Math.min(waitMs, 3500));
      for (const currentFrame of page.frames()) {
        await harvestFrame(currentFrame, found, diagnostics);
      }
      if (found.size) break;
    }
    if (!clickedAny) {
      diagnostics.playAttempts.push({ round, clicked: false, note: 'No visible primary play control found.' });
    }
  }
}

function attachNetworkWatch(page, found, diagnostics) {
  const record = (url, contentType = "", source = "network") => {
    const type = classify(url, contentType);
    if (!type) return;
    if (!found.has(url)) found.set(url, { url, type, source, contentType });
  };

  page.on("response", async (response) => {
    try {
      const headers = response.headers();
      const ct = headers["content-type"] || "";
      record(response.url(), ct, "response");
      if (diagnostics.responses.length < 160) {
        diagnostics.responses.push({ url: response.url(), status: response.status(), contentType: ct });
      }
    } catch (_) {}
  });

  page.on("request", (request) => {
    try {
      const url = request.url();
      if (MEDIA_RE.test(url)) record(url, "", "request");
      if (diagnostics.requests.length < 160) diagnostics.requests.push({ url, type: request.resourceType?.() || "" });
    } catch (_) {}
  });

  return record;
}

async function harvestFrame(frame, found, diagnostics) {
  const result = await inspectAndStartMedia(frame);
  for (const url of result.urls) {
    const type = classify(url, "");
    if (type && !found.has(url)) found.set(url, { url, type, source: "rendered-page", contentType: "" });
  }
  diagnostics.actions.push(...result.actions.map((x) => `${frame.url() || "frame"}:${x}`));
  return result.iframes || [];
}

async function exercisePage(page, found, diagnostics, waitMs, serverWaitMs, maxServers) {
  const iframeUrls = new Set();

  // Initial pass.
  for (const frame of page.frames()) {
    for (const u of await harvestFrame(frame, found, diagnostics)) iframeUrls.add(u);
  }
  if (found.size) return [...iframeUrls];

  // Discover visible "Server N" controls in every frame and try them one-by-one.
  const serverTargets = [];
  for (const frame of page.frames()) {
    const controls = await listServerControls(frame);
    for (const c of controls) serverTargets.push({ frame, frameUrl: frame.url(), label: c.text });
  }

  const seen = new Set();
  for (const target of serverTargets) {
    if (found.size) break;
    const key = `${target.frameUrl}|${target.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > maxServers) break;

    const clicked = await clickServerControl(target.frame, target.label);
    diagnostics.serverAttempts.push({ frame: target.frameUrl, server: target.label, clicked });
    if (!clicked) continue;

    await sleep(serverWaitMs);

    // A server switch can restore the first-click ad gate. Repeat the same two-stage interaction.
    await runTwoStagePlay(browser, page, found, diagnostics, Math.min(waitMs, 5000));

    // Server selection can rebuild iframes/player DOM, so rescan all current frames.
    for (const frame of page.frames()) {
      for (const u of await harvestFrame(frame, found, diagnostics)) iframeUrls.add(u);
    }
    if (found.size) break;

    await sleep(Math.min(waitMs, 4000));
    for (const frame of page.frames()) {
      for (const u of await harvestFrame(frame, found, diagnostics)) iframeUrls.add(u);
    }
  }

  if (!found.size) {
    await sleep(waitMs);
    for (const frame of page.frames()) {
      for (const u of await harvestFrame(frame, found, diagnostics)) iframeUrls.add(u);
    }
  }

  return [...iframeUrls];
}

async function resolveWithBrowser(targetUrl, env) {
  const browser = await puppeteer.launch(env.BROWSER);
  const found = new Map();
  const diagnostics = {
    frames: [], actions: [], requests: [], responses: [], iframeAttempts: [], serverAttempts: [], playAttempts: [], popupAttempts: []
  };
  const waitMs = Math.max(1500, Math.min(12000, Number(env.PLAYER_WAIT_MS || 6000)));
  const serverWaitMs = Math.max(800, Math.min(8000, Number(env.SERVER_WAIT_MS || 2500)));
  const maxServers = Math.max(1, Math.min(12, Number(env.MAX_SERVER_BUTTONS || 8)));

  try {
    const page = await browser.newPage();
    attachNetworkWatch(page, found, diagnostics);

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);

    // Reproduce the real-browser sequence used by this source: first click may open an ad tab;
    // close that tab, then click play again so the actual media request is created.
    await runTwoStagePlay(browser, page, found, diagnostics, waitMs);

    let iframeUrls = await exercisePage(page, found, diagnostics, waitMs, serverWaitMs, maxServers);
    diagnostics.frames = page.frames().map((f) => f.url()).filter(Boolean).slice(0, 30);

    if (!found.size) {
      iframeUrls = iframeUrls
        .filter((raw) => {
          try {
            const u = new URL(raw, targetUrl);
            return isPublicHttpUrl(u);
          } catch (_) { return false; }
        })
        .slice(0, 6);

      for (const iframeUrl of iframeUrls) {
        if (found.size) break;
        let u;
        try { u = new URL(iframeUrl, targetUrl).href; } catch (_) { continue; }
        diagnostics.iframeAttempts.push(u);

        const child = await browser.newPage();
        attachNetworkWatch(child, found, diagnostics);
        try {
          await child.goto(u, { waitUntil: "domcontentloaded", timeout: 20000 });
          await sleep(1000);
          await exercisePage(child, found, diagnostics, Math.min(waitMs, 5000), serverWaitMs, maxServers);
        } catch (_) {
        } finally {
          await child.close();
        }
      }
    }

    const candidates = [...found.values()].sort((a, b) => rank(b) - rank(a));
    return { candidates, diagnostics };
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
        service: "ThiraiX Browser Run Resolver v4",
        usage: "/resolve?url=https://allowed-host.example/page",
      });
    }

    if (incoming.pathname !== "/resolve") return json({ error: "Not found" }, 404);

    const raw = incoming.searchParams.get("url");
    const debug = incoming.searchParams.get("debug") === "1";
    if (!raw) return json({ error: "Missing url parameter." }, 400);

    let target;
    try { target = new URL(raw); }
    catch (_) { return json({ error: "Invalid URL." }, 400); }

    if (!isPublicHttpUrl(target)) return json({ error: "Only public HTTP/HTTPS URLs are supported." }, 400);
    if (!allowedTarget(target, env)) {
      return json({ error: "This hostname is not in ALLOWED_HOSTS.", hostname: target.hostname }, 403);
    }

    const cache = caches.default;
    const cacheKey = new Request(`https://resolver-cache.invalid/${encodeURIComponent(target.href)}`);
    if (!debug) {
      const cached = await cache.match(cacheKey);
      if (cached) {
        const data = await cached.json();
        return json({ ...data, cached: true });
      }
    }

    let result;
    try {
      result = await resolveWithBrowser(target.href, env);
    } catch (error) {
      return json({
        error: "Browser Run could not resolve this page.",
        detail: String(error?.message || error),
        note: "This resolver observes media the browser is legitimately allowed to receive; it does not bypass login, CAPTCHA, DRM, or other access controls.",
      }, 502);
    }

    const { candidates, diagnostics } = result;
    if (!candidates.length) {
      return json({
        error: "No public MP4/HLS/DASH media request was detected after ad-popup + second-play interaction.",
        debug: debug ? diagnostics : undefined,
        hint: "Retry with &debug=1 and inspect playAttempts, popupAttempts, serverAttempts, frames, requests, and responses.",
      }, 404);
    }

    const best = candidates[0];
    const payload = {
      videoUrl: best.url,
      type: best.type,
      source: best.source,
      candidates: candidates.slice(0, 8),
      cached: false,
      ...(debug ? { debug: diagnostics } : {}),
    };

    if (!debug) {
      const ttl = Math.max(30, Math.min(3600, Number(env.CACHE_TTL_SECONDS || 600)));
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
        })
      );
    }

    return json(payload);
  },
};
