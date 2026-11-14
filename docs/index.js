(function () {
    var KEY = "3Z0688EVWYKH";
    var BASE = "https://api.tenor.com/v1";
    var undo = [];
    var categoriesCache = null;

    function log(m, e) {
        try { vendetta.logger.log("[Tenor GIFs] " + m + (e ? " " + (e.message || e) : "")); } catch (x) {}
    }

    var shown = {};
    var bypass = false;
    function toast(t) {
        try { vendetta.ui.toasts.showToast(t); } catch (x) {}
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
            if (!res.ok) {
                return res.text().then(function (t) {
                    var msg = t;
                    try { var j = JSON.parse(t); msg = (j.error && (j.error.message || j.error.status)) || t; } catch (e) {}
                    log("Tenor " + path + " HTTP " + res.status + " full: " + t);
                    if (path !== "/registershare") toast(path + " " + res.status + ": " + String(msg).replace(/\s+/g, " ").slice(0, 140));
                    throw new Error("Tenor " + path + " -> " + res.status);
                });
            }
            return res.json().then(function (j) {
                var n = (j.results && j.results.length) || (j.tags && j.tags.length) || 0;
                if (!n) toast("Tenor " + path + " OK but empty: " + JSON.stringify(j).slice(0, 80));
                return j;
            });
        }, function (err) {
            toast("Tenor " + path + " network error: " + (err && err.message));
            throw err;
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

    function copy(ev, over) {
        var o = {};
        for (var k in ev) o[k] = ev[k];
        for (var k2 in over) o[k2] = over[k2];
        return o;
    }

    // Guess the media format Discord wants from what Klipy returned
    function detectFormat(items) {
        var src = String((items && items[0] && items[0].src) || "");
        if (/\.webp/i.test(src)) return "webp";
        if (/\.webm/i.test(src)) return "tinywebm";
        return "tinymp4";
    }

    function patchFlux(FD) {
        return vendetta.patcher.instead("dispatch", FD, function (args, orig) {
            var ev = args[0];
            var self = this;
            if (bypass || !ev || typeof ev.type !== "string") return orig.apply(self, args);

            function pass() { return orig.apply(self, args); }
            function send(e) {
                bypass = true;
                try { return orig.call(self, e); } finally { bypass = false; }
            }
            function fail(e) { log("falling back to default provider:", e); pass(); }

            var t = ev.type;

            if (t === "GIF_PICKER_QUERY_SUCCESS") {
                var q = ev.query;
                var fmt = detectFormat(ev.items);
                (q ? list("/search", 100, { q: q }, fmt) : list("/trending", 50, {}, fmt))
                    .then(function (items) {
                        if (!items.length) return pass();
                        send(copy(ev, { items: items }));
                    })
                    .catch(fail);
                return;
            }

            if (t === "GIF_PICKER_TRENDING_FETCH_SUCCESS") {
                trendingCategories()
                    .then(function (c) {
                        send(copy(ev, { trendingCategories: c.categories, trendingGIFPreview: c.gifs[0] }));
                    })
                    .catch(fail);
                return;
            }

            if (t === "GIF_PICKER_SUGGESTIONS_SUCCESS" && ev.query) {
                api("/search_suggestions", { q: ev.query, limit: "5" })
                    .then(function (r) {
                        if (!r.results || !r.results.length) return pass();
                        send(copy(ev, { items: r.results }));
                    })
                    .catch(fail);
                return;
            }

            return orig.apply(self, args);
        });
    }

    // Selecting a GIF: tell Tenor instead of Discord's provider
    function patchSelect(mod) {
        if (typeof mod.post !== "function") return null;
        return vendetta.patcher.instead("post", mod, function (args, orig) {
            var req = args[0];
            var url = typeof req === "string" ? req : (req && req.url) || "";
            if (url.slice(-12) === "/gifs/select") {
                var b = (req && req.body) || {};
                api("/registershare", { id: b.id, q: b.q }).catch(function () {});
                return Promise.resolve({ ok: true, status: 200, body: {}, headers: {} });
            }
            return orig.apply(this, args);
        });
    }

    return {
        onLoad: function () {
            try {
                var find = vendetta.metro.findByProps;
                var FD = (vendetta.metro.common && vendetta.metro.common.FluxDispatcher) || find("dispatch", "subscribe");
                if (FD) undo.push(patchFlux(FD));
                else toast("Tenor GIFs: FluxDispatcher not found");

                var mods = [find("getAPIBaseURL", "get", "post"), find("getAPIBaseURL")];
                var done = [];
                for (var i = 0; i < mods.length; i++) {
                    var m = mods[i];
                    if (!m || done.indexOf(m) !== -1) continue;
                    done.push(m);
                    var u = patchSelect(m);
                    if (u) undo.push(u);
                }
                toast("Tenor GIFs v7 loaded");
            } catch (e) {
                log("onLoad failed:", e);
                toast("Tenor GIFs onLoad failed: " + (e && e.message));
            }
        },
        onUnload: function () {
            for (var i = 0; i < undo.length; i++) { try { undo[i](); } catch (e) {} }
            undo = [];
            categoriesCache = null;
        }
    };
})()
