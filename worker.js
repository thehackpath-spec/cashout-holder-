export default {
  async fetch(request, env) {
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    };

    if (!env.ROBLOX_COOKIE) {
      return new Response(
        JSON.stringify({
          error: "ROBLOX_COOKIE secret is not configured"
        }),
        { status: 500, headers }
      );
    }

    let cookie = env.ROBLOX_COOKIE
      .trim()
      .replace(/"/g, "")
      .replace(/'/g, "")
      .replace(/\^/g, "");

    if (cookie.startsWith(".ROBLOSECURITY=")) {
      cookie = cookie.replace(".ROBLOSECURITY=", "");
    }

    const robloxHeaders = (accept) => ({
      Cookie: `.ROBLOSECURITY=${cookie}`,
      Accept: accept,
      "User-Agent": "Mozilla/5.0"
    });

    // GET with retry on 429 / 5xx (Roblox edge rate limits answer 429 "error code: 1015").
    const fetchWithRetry = async (target, accept, attempts = 3) => {
      const waits = [500, 1000, 2000, 3000];
      let upstream;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        upstream = await fetch(target, { method: "GET", headers: robloxHeaders(accept) });
        if (upstream.status !== 429 && upstream.status < 500) break;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, waits[Math.min(attempt - 1, waits.length - 1)]));
      }
      return upstream;
    };

    // Short memory cache per Worker instance: serves the last good answer when Roblox throttles.
    const CACHE_FRESH_MS = 60 * 1000;
    const CACHE_STALE_MS = 10 * 60 * 1000;
    globalThis.__proxyCache = globalThis.__proxyCache || new Map();
    const proxyCache = globalThis.__proxyCache;
    const cachedFetch = async (key, target, accept, attempts) => {
      const now = Date.now();
      const hit = proxyCache.get(key);
      if (hit && now - hit.at < CACHE_FRESH_MS) {
        return new Response(hit.body, { status: 200, headers: { ...headers, "X-Proxy-Cache": "fresh" } });
      }
      const upstream = await fetchWithRetry(target, accept, attempts);
      const text = await upstream.text();
      if (upstream.ok) {
        if (proxyCache.size > 500) proxyCache.clear();
        proxyCache.set(key, { at: now, body: text });
        return new Response(text, { status: 200, headers });
      }
      if (hit && now - hit.at < CACHE_STALE_MS) {
        return new Response(hit.body, { status: 200, headers: { ...headers, "X-Proxy-Cache": "stale" } });
      }
      return new Response(text, { status: upstream.status, headers });
    };

    // Cashout pass scan proxy (replaces roproxy.com). Read-only GETs to fixed Roblox URLs only.
    const proxyUrl = new URL(request.url);
    if (request.method === "GET" && proxyUrl.pathname.startsWith("/proxy/")) {
      try {
        const gamesId = proxyUrl.pathname.match(/^\/proxy\/games\/(\d+)$/);
        const passesId = proxyUrl.pathname.match(/^\/proxy\/passes\/(\d+)$/);
        const placePassesId = proxyUrl.pathname.match(/^\/proxy\/placepasses\/(\d+)$/);
        const userPassesId = proxyUrl.pathname.match(/^\/proxy\/userpasses\/(\d+)$/);
        const proxyCursor = proxyUrl.searchParams.get("cursor");

        // A user's public experiences.
        if (gamesId) {
          let target = "https://games.roblox.com/v2/users/" + gamesId[1] + "/games?limit=50&accessFilter=Public";
          if (proxyCursor) target += "&cursor=" + encodeURIComponent(proxyCursor);
          return cachedFetch("games:" + gamesId[1] + ":" + (proxyCursor || ""), target, "application/json", 5);
        }

        // Game passes in a user's inventory (creators own their own passes). Fallback when the games list is throttled.
        if (userPassesId) {
          let target = "https://apis.roblox.com/game-passes/v1/users/" + userPassesId[1] + "/game-passes?count=100";
          const startId = proxyUrl.searchParams.get("exclusiveStartId");
          if (startId && /^\d+$/.test(startId)) target += "&exclusiveStartId=" + startId;
          const upstream = await fetchWithRetry(target, "application/json");
          return new Response(await upstream.text(), { status: upstream.status, headers });
        }

        // A universe's game passes (official API, includes off-sale passes).
        if (passesId) {
          let target = "https://apis.roblox.com/game-passes/v1/universes/" + passesId[1] + "/game-passes?passView=Full&pageSize=100";
          if (proxyCursor) target += "&cursor=" + encodeURIComponent(proxyCursor);
          const upstream = await fetchWithRetry(target, "application/json");
          return new Response(await upstream.text(), { status: upstream.status, headers });
        }

        // A place's for-sale game passes, read from the www store partial.
        if (placePassesId) {
          const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
          const seen = new Set();
          const gamePasses = [];
          for (let page = 0; page < 20; page++) {
            const res = await fetchWithRetry("https://www.roblox.com/games/getgamepassesinnerpartial?startIndex=" + (page * 50) + "&maxRows=50&placeId=" + placePassesId[1], "text/html");
            if (!res.ok) {
              return new Response(JSON.stringify({ error: "Store lookup failed", status: res.status }), { status: 502, headers });
            }
            const cards = (await res.text()).split('class="list-item real-game-pass"').slice(1);
            let added = 0;
            for (const card of cards) {
              const id = (card.match(/\/game-pass\/(\d+)\//) || [])[1];
              const price = (card.match(/data-expected-price="(\d+)"/) || [])[1];
              const name = (card.match(/data-item-name="([^"]*)"/) || [])[1];
              if (!id || seen.has(id)) continue;
              seen.add(id);
              added++;
              gamePasses.push({ id: Number(id), name: name ? decode(name) : "Game pass", price: price ? Number(price) : null, isForSale: !!price });
            }
            if (cards.length < 50 || added === 0) break;
          }
          return new Response(JSON.stringify({ gamePasses, nextPageCursor: null }), { headers });
        }

        return new Response(JSON.stringify({ error: "Unknown proxy route" }), { status: 404, headers });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          { status: 502, headers }
        );
      }
    }

    try {
      let body = {};

      if (request.method === "POST") {
        try {
          body = await request.json();
        } catch {
          return new Response(
            JSON.stringify({ error: "Invalid JSON body" }),
            { status: 400, headers }
          );
        }
      }

      const url = new URL(request.url);
      const passId = body.passId ?? url.searchParams.get("passId");

      if (passId != null) {
        const cleanPassId = String(passId).replace(/\D/g, "");

        if (!cleanPassId) {
          return new Response(
            JSON.stringify({
              exists: false,
              error: "Invalid passId"
            }),
            { status: 400, headers }
          );
        }

        const passUrl =
          `https://www.roblox.com/game-pass/${cleanPassId}`;

        const passResponse = await fetch(passUrl, {
          method: "GET",
          redirect: "follow",
          headers: {
            Cookie: `.ROBLOSECURITY=${cookie}`,
            Accept: "text/html",
            "User-Agent": "Mozilla/5.0"
          }
        });

        const responseText = await passResponse.text();

        return new Response(
          JSON.stringify({
            exists: passResponse.status === 200,
            robloxStatus: passResponse.status,
            robloxStatusText: passResponse.statusText,
            finalUrl: passResponse.url,
            responseLength: responseText.length
          }),
          {
            status: 200,
            headers
          }
        );
      }

      let placeIds = [];

      if (request.method === "POST") {
        placeIds = body.placeIds || [];
      } else {
        placeIds = url.searchParams.getAll("placeIds");
      }

      if (!Array.isArray(placeIds) || placeIds.length === 0) {
        return new Response(
          JSON.stringify({
            error: "Missing required: placeIds"
          }),
          { status: 400, headers }
        );
      }

      if (placeIds.length > 100) {
        return new Response(
          JSON.stringify({
            error: "Max 100 placeIds allowed per request"
          }),
          { status: 400, headers }
        );
      }

      const queryString = placeIds
        .map(id => `placeIds=${encodeURIComponent(id)}`)
        .join("&");

      const robloxApiUrl =
        `https://games.roblox.com/v1/games/multiget-place-details?${queryString}`;

      const robloxResponse = await fetch(robloxApiUrl, {
        method: "GET",
        headers: {
          Cookie: `.ROBLOSECURITY=${cookie}`,
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0"
        }
      });

      const responseText = await robloxResponse.text();

      if (!robloxResponse.ok) {
        return new Response(
          JSON.stringify({
            error: `Roblox API returned status ${robloxResponse.status}`,
            robloxStatus: robloxResponse.status,
            robloxStatusText: robloxResponse.statusText,
            details: responseText
          }),
          {
            status: robloxResponse.status,
            headers
          }
        );
      }

      return new Response(responseText, {
        status: 200,
        headers
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        }),
        {
          status: 500,
          headers
        }
      );
    }
  }
};
