(function () {
    var KEY = "3Z0688EVWYKH";
    var BASE = "https://api.tenor.com/v1";
    var undo = [];
    var categoriesCache = null;

    function log(m, e) {
        try { vendetta.logger.log("[Tenor GIFs] " + m + (e ? " " + (e.message || e) : "")); } catch (x) {}
    }

    function getLocale() {
        try {
            var find = vendetta.metro.findByProps;
            var s = find("locale", "getLocale") || find("getLocale");
            var l = (s && (s.locale || (s.getLocale && s.getLocale()))) || "en-US";
            return String(l).replace("-", "_").toLowerCase();
        } catch (e) { return "en_us"; }
    }

    function api(path, params) {
        var p = { key: KEY, locale: getLocale() };
        for (var k in params) p[k] = params[k];
        return fetch(BASE + path + "?" + new URLSearchParams(p).toString()).then(function (res) {
            if (!res.ok) throw new Error("Tenor " + path + " -> " + res.status);
            return res.json();
        });
    }

    function pickFormat(f) {
        if (f === "tinywebp" || f === "webp") return "webp";
        if (f === "webm" || f === "tinywebm") return "tinywebm";
        return "tinymp4";
    }

    function toGif(item, format) {
        var m = item.media && item.media[0];
        if (!m || !m.gif) return null;
        var media = m[format] || m.tinymp4 || m.tinygif || m.gif;
        if (!media) return null;
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

    function list(path, limit, extra, format) {
        var items = [];
        var seen = {};
        function page(pos) {
            var params = {};
            for (var k in extra) params[k] = extra[k];
            params.limit = String(Math.min(limit - items.length, 50));
            if (pos) params.pos = pos;
            return api(path, params).then(function (data) {
                var results = data.results || [];
                if (!results.length) return items;
                var before = items.length;
                for (var i = 0; i < results.length && items.length < limit; i++) {
                    var r = results[i];
                    if (seen[r.id]) continue;
                    seen[r.id] = true;
                    var g = toGif(r, format);
                    if (g) items.push(g);
                }
                if (items.length >= limit || items.length === before || !data.next || data.next === pos) return items;
                return page(data.next);
            });
        }
        return page("");
    }

    function trendingCategories() {
        if (categoriesCache) return Promise.resolve(categoriesCache);
        return api("/categories", { type: "featured" }).then(function (res) {
            if (!res || !res.tags || !res.tags.length) throw new Error("no categories");
            categoriesCache = {
                categories: res.tags.map(function (t) { return { name: t.searchterm, src: t.image }; }),
                gifs: [{ src: res.tags[0].image }]
            };
            return categoriesCache;
        });
    }

    function ok(body) { return { ok: true, status: 200, body: body, headers: {} }; }

    function handle(method, url, query, body) {
        var format = pickFormat(query && query.media_format);
        if (method === "get") {
            if (url.slice(-11) === "/gifs/search")
                return list("/search", 100, { q: query.q }, format).then(ok);
            if (url.slice(-12) === "/gifs/suggest")
                return api("/search_suggestions", { q: query.q, limit: "5" }).then(function (r) { return ok(r.results || []); });
            if (url.slice(-19) === "/gifs/trending-gifs")
                return list("/trending", 50, {}, format).then(ok);
            if (url.slice(-14) === "/gifs/trending")
                return trendingCategories().then(ok);
        } else if (method === "post" && url.slice(-12) === "/gifs/select") {
            api("/registershare", { id: body.id, q: body.q }).catch(function () {});
            return Promise.resolve(ok({}));
        }
        return null;
    }

    function patchMethod(RestAPI, method) {
        return vendetta.patcher.instead(method, RestAPI, function (args, orig) {
            var req = args[0];
            var url = typeof req === "string" ? req : (req && req.url) || "";
            if (url.indexOf("/gifs/") === -1) return orig.apply(this, args);
            var query = (req && req.query) || {};
            var body = (req && req.body) || {};
            var p;
            try { p = handle(method, url, query, body); } catch (e) { p = null; }
            if (!p) return orig.apply(this, args);
            var self = this;
            return p.catch(function (e) {
                log("falling back to default provider:", e);
                return orig.apply(self, args);
            });
        });
    }

    return {
        onLoad: function () {
            try {
                var find = vendetta.metro.findByProps;
                var RestAPI = find("getAPIBaseURL", "get", "post") || find("getAPIBaseURL");
                if (!RestAPI) { log("REST module not found"); return; }
                undo.push(patchMethod(RestAPI, "get"));
                undo.push(patchMethod(RestAPI, "post"));
                log("patched");
            } catch (e) {
                log("onLoad failed:", e);
            }
        },
        onUnload: function () {
            for (var i = 0; i < undo.length; i++) { try { undo[i](); } catch (e) {} }
            undo = [];
            categoriesCache = null;
        }
    };
})()
