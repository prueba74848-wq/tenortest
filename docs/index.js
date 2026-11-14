(function () {
    const { instead } = vendetta.patcher;
    const { findByProps } = vendetta.metro;
    const { logger } = vendetta;

    // Same Gboard key the Vencord GifProviderSwitcher uses
    const KEY = "3Z0688EVWYKH";
    const BASE = "https://api.tenor.com/v1";

    let unpatch = null;
    let categoriesCache = null;

    function getLocale() {
        try {
            const LocaleStore = findByProps("locale", "getLocale") ?? findByProps("getLocale");
            const l = LocaleStore?.locale ?? LocaleStore?.getLocale?.() ?? "en-US";
            return String(l).replace("-", "_").toLowerCase();
        } catch (e) { return "en_us"; }
    }

    async function api(path, params) {
        const res = await fetch(`${BASE}${path}?` + new URLSearchParams({ key: KEY, locale: getLocale(), ...params }));
        if (!res.ok) throw new Error(`Tenor ${path} -> ${res.status}`);
        return res.json();
    }

    // Discord asks for a media format; map it to what Tenor offers
    function pickFormat(mediaFormat) {
        if (mediaFormat === "tinywebp" || mediaFormat === "webp") return "webp";
        if (mediaFormat === "webm" || mediaFormat === "tinywebm") return "tinywebm";
        return "tinymp4";
    }

    function toGif(item, format) {
        const m = item.media?.[0];
        const media = m?.[format] ?? m?.tinymp4 ?? m?.tinygif ?? m?.gif;
        if (!m?.gif || !media) return null;
        return {
            id: item.id,
            title: item.title || item.h1_title || "",
            url: item.itemurl,
            gif_src: m.gif.url,
            src: media.url,
            width: media.dims[0],
            height: media.dims[1],
            preview: media.preview
        };
    }

    async function list(path, limit, extra, format) {
        const items = [];
        const seen = new Set();
        let pos = "";
        while (items.length < limit) {
            const params = { ...extra, limit: String(Math.min(limit - items.length, 50)) };
            if (pos) params.pos = pos;
            const { next, results = [] } = await api(path, params);
            if (!results.length) break;
            const before = items.length;
            for (const r of results) {
                if (seen.has(r.id)) continue;
                seen.add(r.id);
                const g = toGif(r, format);
                if (g) items.push(g);
                if (items.length >= limit) break;
            }
            if (items.length === before || !next || next === pos) break;
            pos = next;
        }
        return items;
    }

    async function getTrendingCategories() {
        if (categoriesCache) return categoriesCache;
        const res = await api("/categories", { type: "featured" });
        if (!res?.tags?.length) throw new Error("no categories");
        categoriesCache = {
            categories: res.tags.map(t => ({ name: t.searchterm, src: t.image })),
            gifs: [{ src: res.tags[0].image }]
        };
        return categoriesCache;
    }

    function parseReq(args) {
        const req = args[0];
        if (typeof req === "string") return { url: req, query: {}, body: {} };
        return { url: req?.url ?? "", query: req?.query ?? {}, body: req?.body ?? {} };
    }

    const ok = body => ({ ok: true, status: 200, body, headers: {} });

    async function handle(method, url, query, body) {
        const format = pickFormat(query?.media_format);
        if (method === "get") {
            if (url.endsWith("/gifs/search"))
                return ok(await list("/search", 100, { q: query.q }, format));
            if (url.endsWith("/gifs/suggest"))
                return ok((await api("/search_suggestions", { q: query.q, limit: "5" })).results ?? []);
            if (url.endsWith("/gifs/trending-gifs"))
                return ok(await list("/trending", 50, {}, format));
            if (url.endsWith("/gifs/trending"))
                return ok(await getTrendingCategories());
        } else if (method === "post" && url.endsWith("/gifs/select")) {
            api("/registershare", { id: body.id, q: body.q }).catch(() => {});
            return ok({});
        }
        return null;
    }

    return {
        onLoad() {
          try {
            const RestAPI = findByProps("getAPIBaseURL", "get", "post") ?? findByProps("getAPIBaseURL");
            if (!RestAPI) { logger.error("[Tenor GIFs] REST module not found"); return; }

            const undo = ["get", "post"].map(method =>
                instead(method, RestAPI, async (args, orig) => {
                    const { url, query, body } = parseReq(args);
                    if (url.includes("/gifs/")) {
                        try {
                            const res = await handle(method, url, query, body);
                            if (res) return res;
                        } catch (e) {
                            // Tenor down/shut down -> fall back to Discord's own provider
                            logger.error("[Tenor GIFs] falling back to default provider:", e?.message ?? e);
                        }
                    }
                    return orig(...args);
                })
            );
            unpatch = () => undo.forEach(u => u());
          } catch (e) {
            logger.error("[Tenor GIFs] onLoad failed:", e && e.message ? e.message : e);
          }
        },
        onUnload() {
            unpatch?.();
            unpatch = null;
            categoriesCache = null;
        }
    };
})()
