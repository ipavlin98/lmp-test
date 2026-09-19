(function () {
	"use strict";

	var SEASON_FIX = {
		id: "season_fix",
		version: "1.6-debug4",
		debug_enabled: true,
		debug_rows: {},
		debug_timer: null,
		debug_network: {},
		tvmaze_cache: {},
		tvmaze_pending: {},
		tvmaze_retry_after: {},
		current_tv_id: null,

		canUseTvmazeHttp: function () {
			return location.protocol === "file:" && /Tizen/i.test(navigator.userAgent);
		},

		debug: function (key, value) {
			if (!this.debug_enabled) return;
			value = String(value).replace(/https?:\/\/[^\s)]+/g, function (url) {
				return url.split(/[?#]/)[0].replace(/\/\/[^/@]+@/, "//");
			}).slice(0, 180);
			if (this.debug_rows[key] === value) return;
			this.debug_rows[key] = value;
			this.debugShow();
		},

		debugNetwork: function (stage, value) {
			var entries = this.debug_network[stage] || [];
			entries.push(value);
			this.debug_network[stage] = entries.slice(-3);
			this.debug(stage + " net", this.debug_network[stage].join(" > "));
		},

		debugConfig: function () {
			var _this = this;
			this.debug("Clock", new Date().toISOString());
			if (!this.debug_rows.Policy) this.debug("Policy", "no CSP event observed");
			try {
				var app = window.tizen && tizen.application && tizen.application.getCurrentApplication().appInfo;
				this.debug("App", app ? app.id + " v" + app.version : "browser");
			} catch (e) {
				this.debug("App", e.name + " " + e.message);
			}
			if (location.protocol !== "file:") {
				this.debug("Config", "not a packaged app");
				return;
			}
			try {
				var xhr = new XMLHttpRequest();
				xhr.open("GET", location.href.split(/[?#]/)[0].replace(/[^/]*$/, "config.xml"), true);
				xhr.timeout = 5000;
				xhr.onload = function () {
					var xml = new DOMParser().parseFromString(xhr.responseText, "text/xml");
					if (xml.getElementsByTagName("parsererror").length || !xml.getElementsByTagName("widget").length) {
						_this.debug("Config", "unavailable or invalid XML; status=" + xhr.status);
						return;
					}
					var origins = [];
					var policies = [];
					var internet = false;
					var elements = xml.getElementsByTagName("*");
					for (var i = 0; i < elements.length; i++) {
						var node = elements[i];
						var name = node.localName || node.nodeName.split(":").pop();
						if (name === "access") origins.push(node.getAttribute("origin") + " sub=" + node.getAttribute("subdomains"));
						if (name === "privilege" && /\/internet$/.test(node.getAttribute("name") || "")) internet = true;
						if (name === "content-security-policy" || name === "allow-origin") policies.push(node.textContent);
					}
					var relevant = origins.filter(function (origin) { return /tvmaze|\*/i.test(origin); });
					_this.debug("Config", "internet=" + internet + " access(" + origins.length + ")=" + ((relevant.length ? relevant : origins).join("; ") || "none"));
					_this.debug("App policy", policies.join("; ") || "no explicit CSP/allow-origin in config");
				};
				xhr.onerror = function () { _this.debug("Config", "read error"); };
				xhr.ontimeout = function () { _this.debug("Config", "read timeout"); };
				xhr.send();
			} catch (e) {
				this.debug("Config", e.name + " " + e.message);
			}
		},

		debugProbes: function (lookupUrl) {
			if (!this.debug_enabled || this.debug_probes_started) return;
			this.debug_probes_started = true;
			this.debug_page = "network";
			var _this = this;
			var remaining = 4;
			this.debugConfig();
			this.debug("Probes", "running: direct=/shows/1; lookup=current show; limit=8s");
			var finish = function (label, result) {
				_this.debug(label, result);
				remaining--;
				if (!remaining) _this.debug("Probes", "DONE 4/4; direct=/shows/1; rs=readyState; hdr=headers received");
			};
			var probe = function (label, url) {
				if (location.protocol === "https:" && url.indexOf("http:") === 0) {
					finish(label, "skipped: HTTPS page / mixed content");
					return;
				}
				var xhr;
				var settled = false;
				var headers = false;
				var started = Date.now();
				var complete = function (event) {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					var details = "";
					try {
						details = " status=" + xhr.status + " rs=" + xhr.readyState + " hdr=" + headers + " bytes=" + xhr.responseText.length + " final=" + (xhr.responseURL || "none");
					} catch (e) {
						details = " " + e.name;
					}
					finish(label, event + " " + (Date.now() - started) + "ms" + details);
				};
				var timer = setTimeout(function () {
					complete("watchdog");
					if (xhr) xhr.abort();
				}, 8500);
				_this.debug(label, "loading");
				try {
					xhr = new XMLHttpRequest();
					xhr.open("GET", url, true);
					xhr.timeout = 8000;
					xhr.onreadystatechange = function () { if (xhr.readyState >= 2 && xhr.status) headers = true; };
					xhr.onload = function () { complete("load"); };
					xhr.onerror = function () { complete("error"); };
					xhr.ontimeout = function () { complete("timeout"); };
					xhr.onabort = function () { complete("abort"); };
					xhr.send();
				} catch (e) {
					complete(e.name + ": " + e.message);
				}
			};
			probe("Direct HTTP", "http://api.tvmaze.com/shows/1");
			probe("Direct HTTPS", "https://api.tvmaze.com/shows/1");
			probe("Lookup HTTP", lookupUrl.replace(/^https:/, "http:"));
			if (typeof fetch !== "function") {
				finish("Fetch opaque", "unsupported");
				return;
			}
			var started = Date.now();
			var settled = false;
			var controller;
			var completeFetch = function (result) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				finish("Fetch opaque", result + " " + (Date.now() - started) + "ms");
			};
			var timer = setTimeout(function () {
				completeFetch("timeout");
				if (controller) controller.abort();
			}, 8000);
			try {
				if (typeof AbortController === "function") controller = new AbortController();
				var options = { mode: "no-cors", credentials: "omit", cache: "no-store" };
				if (controller) options.signal = controller.signal;
				fetch("https://api.tvmaze.com/shows/1", options).then(function (response) {
					completeFetch("resolved type=" + response.type + " status=" + response.status);
				}, function (error) {
					completeFetch(error.name + ": " + error.message);
				});
			} catch (e) {
				completeFetch(e.name + ": " + e.message);
			}
		},

		debugPanel: function () {
			if (!document.body) return false;
			if (this.debug_panel) return true;
			var _this = this;
			var template = typeof Lampa !== "undefined" && Lampa.Noty && Lampa.Noty.render ? Lampa.Noty.render() : null;
			var source = template && (template[0] || template);
			var panel = source && source.cloneNode ? source.cloneNode(true) : document.createElement("div");
			panel.id = "season-fix-debug";
			panel.className = "noty noty--visible";
			panel.style.cssText = "position:fixed!important;left:12px!important;right:12px!important;bottom:12px!important;top:auto!important;width:auto!important;max-width:1050px!important;max-height:55vh!important;overflow:auto!important;display:block!important;visibility:visible!important;opacity:1!important;transform:none!important;z-index:2147483647!important;pointer-events:auto!important;background:#10241f!important;color:#fff!important;padding:10px 14px!important;border:1px solid #55d6a0!important;border-radius:6px!important;font-size:16px!important;line-height:1.3!important;text-align:left!important;box-sizing:border-box!important;user-select:text!important;";
			var body = panel.querySelector(".noty__body");
			if (body) body.style.cssText = "display:block!important;padding:0!important;background:none!important;color:inherit!important;max-width:none!important;";
			var content = panel.querySelector(".noty__text");
			if (!content) {
				content = document.createElement("div");
				panel.appendChild(content);
			}
			content.style.cssText = "display:block!important;font-size:inherit!important;line-height:inherit!important;white-space:normal!important;overflow-wrap:break-word!important;color:inherit!important;";
			var toggle = document.createElement("button");
			toggle.type = "button";
			toggle.textContent = "SF: скрыть";
			toggle.style.cssText = "position:fixed;right:12px;top:12px;z-index:2147483647;background:#10241f;color:#fff;border:1px solid #55d6a0;border-radius:4px;padding:6px 10px;font:14px sans-serif;cursor:pointer;";
			toggle.onclick = function () {
				_this.debug_hidden = !_this.debug_hidden;
				panel.style.setProperty("display", _this.debug_hidden ? "none" : "block", "important");
				toggle.textContent = _this.debug_hidden ? "SF: показать" : "SF: скрыть";
			};
			document.body.appendChild(panel);
			document.body.appendChild(toggle);
			var page = toggle.cloneNode(true);
			page.textContent = "SF: сводка / сеть";
			page.style.right = "130px";
			page.onclick = function () {
				_this.debug_page = _this.debug_page === "network" ? "summary" : "network";
				_this.debugShow();
			};
			document.body.appendChild(page);
			this.debug_panel = panel;
			this.debug_content = content;
			return true;
		},

		debugShow: function () {
			var _this = this;
			if (!this.debug_enabled || this.debug_timer) return;
			this.debug_timer = setTimeout(function () {
				_this.debug_timer = null;
				if (!_this.debugPanel()) {
					_this.debugShow();
					return;
				}
				var escape = function (value) {
					return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
				};
				var rows = ["Season Fix " + _this.version + " | " + new Date().toTimeString().slice(0, 8)];
				var keys = _this.debug_page === "network" ? ["Boot", "Page", "Clock", "App", "Config", "App policy", "Policy", "Probes", "Direct HTTP", "Direct HTTPS", "Lookup HTTP", "Fetch opaque", "Error"] : ["Boot", "Page", "UA", "Card", "Req", "IDs", "IDs net", "Lookup", "Lookup net", "Episodes", "Episodes net", "Split", "Error"];
				keys.forEach(function (key) {
					var value = _this.debug_rows[key] || "—";
					if (key === "Boot") value = value.replace(/ready=(true|false)/, "ready=" + !!window.appready);
					rows.push(key + ": " + escape(value));
				});
				if (_this.split_override && Lampa.Utils && Lampa.Utils.splitEpisodesIntoSeasons !== _this.split_override) {
					rows[1] += " | SPLIT REPLACED";
				}
				_this.debug_content.innerHTML = rows.join("<br>");
			}, 700);
		},

		debugError: function (where, error) {
			var stack = error && error.stack ? String(error.stack).split("\n").slice(1, 3).join(" ") : "";
			this.debug("Error", where + ": " + (error && error.message || error || "unknown") + " " + stack);
		},

		debugRequest: function (url, channel, callback) {
			if (typeof url !== "string") return;
			var match = url.match(/(?:^|\/)tv\/(\d+)(?:\/season\/(\d+))?/);
			if (!match) return;
			this.debug("Req", channel + " tv=" + match[1] + " season=" + (match[2] || "-") + " cb=" + typeof callback);
		},

		init: function () {
			var _this = this;
			this.debug("Page", location.protocol + "//" + (location.host || "local") + " online=" + navigator.onLine + " secure=" + !!window.isSecureContext);
			this.debug("UA", navigator.userAgent);
			window.addEventListener("securitypolicyviolation", function (e) {
				if (String(e.blockedURI).indexOf("tvmaze.com") >= 0) {
					_this.debug("Policy", "CSP " + e.effectiveDirective + " blocked=" + e.blockedURI);
				}
			});
			var waitForLampa = function () {
				try {
					_this.hook();
				} catch (e) {
					_this.debugError("init", e);
				}
				var chrome = navigator.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/);
				_this.debug("Boot", "ready=" + !!window.appready + " split=" + !!_this.hooked + " req=" + !!_this.requests_hooked + " ajax=" + !!_this.ajax_hooked + " engine=" + (chrome ? chrome[1] : "other") + " " + location.protocol);
				if (!_this.hooked || !_this.requests_hooked || !_this.ajax_hooked) {
					setTimeout(waitForLampa, 500);
				}
			};

			if (typeof Lampa !== "undefined" && Lampa.Listener) {
				Lampa.Listener.follow("app", function (e) {
					if (e.type === "ready") {
						_this.hook();
					}
				});
			}

			waitForLampa();
		},

		hook: function () {
			if (typeof Lampa === "undefined") return;

			if (!this.hooked && Lampa.Utils && typeof Lampa.Utils.splitEpisodesIntoSeasons === "function") {
				this.overrideSplitFunction();
				this.hooked = true;
			}

			this.hookRequests();
			this.hookAjax();
		},

		overrideSplitFunction: function () {
			var _this = this;
			var originalSplit = Lampa.Utils.splitEpisodesIntoSeasons;

			Lampa.Utils.splitEpisodesIntoSeasons = function (episodes, gap) {
				if (!Array.isArray(episodes) || episodes.length === 0) {
					_this.debug("Split", "empty input");
					return {};
				}

				var tvId =
					(episodes[0] && (episodes[0].show_id || episodes[0].series_id)) ||
					_this.current_tv_id;
				var seasonMap = tvId ? _this.tvmaze_cache[tvId] : null;

				try {
					if (
						seasonMap &&
						typeof seasonMap === "object" &&
						Object.keys(seasonMap).length > 0
					) {
						var result = _this.splitByTvmaze(episodes, seasonMap);
						_this.debug("Split", "tv=" + tvId + " in=" + episodes.length + " TVmaze " + Object.keys(result).map(function (s) { return s + ":" + result[s].length; }).join(" "));
						return result;
					}

					_this.debug("Split", "tv=" + (tvId || "?") + " in=" + episodes.length + " ORIGINAL pending=" + !!_this.tvmaze_pending[tvId]);
					return originalSplit.call(this, episodes, gap);
				} catch (e) {
					_this.debugError("split", e);
					throw e;
				}
			};
			this.split_override = Lampa.Utils.splitEpisodesIntoSeasons;
		},

		splitByTvmaze: function (episodes, seasonMap) {
			var sorted = episodes.slice().sort(function (a, b) {
				return (a.episode_number || 0) - (b.episode_number || 0);
			});

			var seasons = {};
			var currentSeason = 1;
			var episodeCounter = 0;
			var seasonLimit = seasonMap[currentSeason] || 9999;

			for (var i = 0; i < sorted.length; i++) {
				var ep = sorted[i];
				episodeCounter++;

				if (episodeCounter > seasonLimit) {
					currentSeason++;
					episodeCounter = 1;
					seasonLimit = seasonMap[currentSeason] || 9999;
				}

				if (!seasons[currentSeason]) {
					seasons[currentSeason] = [];
				}

				var newEp;
				try {
					newEp = JSON.parse(JSON.stringify(ep));
				} catch (e) {
					newEp = {};
					for (var k in ep) {
						if (ep.hasOwnProperty(k)) newEp[k] = ep[k];
					}
				}

				newEp.season_number = currentSeason;
				newEp.episode_number = episodeCounter;
				newEp.id = 900000 + currentSeason * 1000 + episodeCounter;
				seasons[currentSeason].push(newEp);
			}

			return seasons;
		},

		prepareResponse: function (url, callback, channel) {
			var _this = this;
			var match = typeof url === "string" ? url.match(/(?:^|\/)tv\/(\d+)\/season\/1(?:[/?#]|$)/) : null;
			if (!this.hooked || !match || typeof callback !== "function" || callback.season_fix_response) return callback;

			var tvId = match[1];
			var apiKeyMatch = url.match(/[?&]api_key=([^&]+)/);
			var apiKey = apiKeyMatch ? apiKeyMatch[1] : null;
			this.fetchTvmaze(tvId, apiKey);

			var wrapped = function (data) {
				var context = this;
				var args = arguments;
				var first = data && data.episodes && data.episodes[0] || {};
				_this.debug("Req", channel + " response tv=" + tvId + " n=" + (data && Array.isArray(data.episodes) ? data.episodes.length : "missing") + " first=" + (first.show_id || first.series_id || "?") + "/s" + first.season_number + "e" + first.episode_number);
				if (!data || !Array.isArray(data.episodes)) return callback.apply(context, args);

				_this.fetchTvmaze(tvId, apiKey, function () {
					var previousId = _this.current_tv_id;
					_this.current_tv_id = tvId;
					try {
						callback.apply(context, args);
					} catch (e) {
						_this.debugError("response", e);
						throw e;
					} finally {
						_this.current_tv_id = previousId;
					}
				});
			};
			wrapped.season_fix_response = true;
			return wrapped;
		},

		hookRequests: function () {
			var _this = this;
			if (this.requests_hooked || !Lampa.Listener || !Lampa.Listener.follow) return;

			Lampa.Listener.follow("request_before", function (e) {
				if (e.params) {
					_this.debugRequest(e.params.url, "Lampa", e.params.complite);
					e.params.complite = _this.prepareResponse(e.params.url, e.params.complite, "Lampa");
				}
			});
			Lampa.Listener.follow("activity", function (e) {
				if (e.type !== "start") return;
				try {
					var active = Lampa.Activity.active() || {};
					var card = active.movie || active.card || {};
					_this.debug("Card", (card.name || card.title || active.title || "?") + " id=" + (card.id || "?") + " src=" + (card.source || active.source || "?") + " view=" + (active.component || "?"));
				} catch (error) {
					_this.debugError("activity", error);
				}
			});
			this.requests_hooked = true;
		},

		hookAjax: function () {
			var _this = this;

			if (this.ajax_hooked || typeof $ === "undefined" || !$.ajax) {
				return;
			}

			var originalAjax = $.ajax;

			$.ajax = function (url, options) {
				var settings = (typeof url === "object" ? url : options) || {};
				var reqUrl = typeof url === "string" ? url : settings.url || "";
				_this.debugRequest(reqUrl, "ajax", settings.success);
				settings.success = _this.prepareResponse(reqUrl, settings.success, "ajax");

				return originalAjax.apply(this, arguments);
			};
			this.ajax_hooked = true;
		},

		fetchTvmaze: function (tvId, apiKey, callback) {
			var _this = this;

			if (this.tvmaze_cache[tvId]) {
				if (callback) callback();
				return;
			}

			if (this.tvmaze_pending[tvId]) {
				if (callback) this.tvmaze_pending[tvId].push(callback);
				return;
			}

			if (this.tvmaze_retry_after[tvId] > Date.now()) {
				if (callback) callback();
				return;
			}

			this.tvmaze_pending[tvId] = callback ? [callback] : [];
			["IDs", "Lookup", "Episodes"].forEach(function (stage) {
				_this.debug_network[stage] = [];
				_this.debug(stage + " net", "—");
			});
			this.debug("IDs", "tv=" + tvId + " loading");
			this.debug("Lookup", "waiting");
			this.debug("Episodes", "waiting");
			this.debug("Error", "—");
			var finished = false;
			var timeout = this.canUseTvmazeHttp() ? 30000 : 15000;
			var finish = function (map) {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				var callbacks = _this.tvmaze_pending[tvId];
				delete _this.tvmaze_pending[tvId];
				if (map) {
					_this.debug("Error", "—");
					_this.debug("Episodes", "tv=" + tvId + " map=" + Object.keys(map).map(function (s) { return s + ":" + map[s]; }).join(" "));
					_this.tvmaze_cache[tvId] = map;
					delete _this.tvmaze_retry_after[tvId];
				} else {
					_this.tvmaze_retry_after[tvId] = Date.now() + 30000;
				}
				callbacks.forEach(function (call) {
					setTimeout(call, 0);
				});
				if (_this.debug_lookup_url) setTimeout(function () { _this.debugProbes(_this.debug_lookup_url); }, 0);
				if (map) {
					var event = document.createEvent("CustomEvent");
					event.initCustomEvent("tvmaze_loaded", false, false, { id: tvId });
					window.dispatchEvent(event);
				}
			};
			var timer = setTimeout(function () {
				_this.debug("Error", "tv=" + tvId + " total timeout " + timeout / 1000 + "s");
				finish(null);
			}, timeout);

			if (
				!apiKey &&
				typeof Lampa !== "undefined" &&
				Lampa.TMDB &&
				typeof Lampa.TMDB.key === "function"
			) {
				apiKey = Lampa.TMDB.key();
			}

			if (!apiKey) {
				this.debug("Error", "TMDB key unavailable");
				finish(null);
				return;
			}

			var externalUrl;
			if (typeof Lampa !== "undefined" && Lampa.TMDB && Lampa.TMDB.api) {
				externalUrl = Lampa.TMDB.api(
					"tv/" + tvId + "/external_ids?api_key=" + apiKey
				);
			} else {
				externalUrl =
					"https://api.themoviedb.org/3/tv/" +
					tvId +
					"/external_ids?api_key=" +
					apiKey;
			}

			this.makeRequest(externalUrl, function (ids, status, error) {
				if (finished) return;
				_this.debug("IDs", "tv=" + tvId + " status=" + status + " imdb=" + (ids && ids.imdb_id || "-") + " tvdb=" + (ids && ids.tvdb_id || "-") + (error ? " " + error : ""));
				if (!ids) {
					finish(null);
					return;
				}

				var lookupId = null;
				var lookupType = null;

				if (ids.imdb_id) {
					lookupId = ids.imdb_id;
					lookupType = "imdb";
				} else if (ids.tvdb_id) {
					lookupId = ids.tvdb_id;
					lookupType = "thetvdb";
				}

				if (!lookupId) {
					finish(null);
					return;
				}

				var lookupUrl =
					"https://api.tvmaze.com/lookup/shows?" + lookupType + "=" + lookupId;
				_this.debug_lookup_url = lookupUrl;
				_this.debug("Lookup", lookupType + "=" + lookupId + " loading");

				_this.makeRequest(lookupUrl, function (showData, status2, error2) {
					if (finished) return;
					_this.debug("Lookup", "status=" + status2 + " maze=" + (showData && showData.id || "-") + " " + (showData && showData.name || error2 || ""));
					if (!showData || !showData.id) {
						finish(null);
						return;
					}

					var episodesUrl =
						"https://api.tvmaze.com/shows/" + showData.id + "/episodes";
					_this.debug("Episodes", "maze=" + showData.id + " loading");

					_this.makeRequest(episodesUrl, function (episodes, status3, error3) {
						if (finished) return;
						_this.debug("Episodes", "status=" + status3 + " count=" + (Array.isArray(episodes) ? episodes.length : "invalid") + (error3 ? " " + error3 : ""));
						if (!Array.isArray(episodes) || !episodes.length) {
							finish(null);
							return;
						}

						var map = {};
						for (var i = 0; i < episodes.length; i++) {
							var ep = episodes[i];
							if (!ep || !(ep.season > 0) || !(ep.number > 0)) continue;
							var s = ep.season;
							if (!map[s]) map[s] = 0;
							map[s]++;
						}

						finish(map[1] > 0 ? map : null);
					});
				});
			});
		},

		makeRequest: function (url, callback) {
			var _this = this;
			var canUseHttp = this.canUseTvmazeHttp() && /^https:\/\/api\.tvmaze\.com\/(?:lookup\/shows\?|shows\/\d+\/episodes(?:\?|$))/.test(url);
			if (canUseHttp && this.tvmaze_http) url = url.replace(/^https:/, "http:");
			var stage = url.indexOf("external_ids") >= 0 ? "IDs" : url.indexOf("lookup/shows") >= 0 ? "Lookup" : "Episodes";
			var host = url.match(/^(?:https?:)?\/\/([^/?#]+)/);
			var started = Date.now();
			var completed = false;
			var fallbackStarted = false;
			var transport = "Lampa";
			var transportStarted = started;
			var endpoint = url.split(/[?#]/)[0];
			this.debugNetwork(stage, endpoint);
			var finish = function (data, status, error) {
				if (completed) return;
				completed = true;
				_this.debugNetwork(stage, transport + " " + (error || (transport.indexOf("XHR") === 0 ? status : "OK")) + " " + (Date.now() - transportStarted) + "ms");
				if (!error && data && canUseHttp && url.indexOf("http:") === 0) _this.tvmaze_http = true;
				if (error) _this.debug("Error", stage + " " + (host ? host[1] : "?") + " status=" + status + " " + error + " " + (Date.now() - started) + "ms");
				callback(data, status, error);
			};

			var useLampaReguest = function () {
				var Request = typeof Lampa !== "undefined" && (Lampa.Reguest || Lampa.Request);
				if (!Request) {
					useXHR();
					return;
				}

				try {
					var network = new Request();
					network.timeout(5000);

					var isTmdbUrl =
						url.indexOf("themoviedb.org") !== -1 ||
						url.indexOf("apitmdb.") !== -1;
					var method = isTmdbUrl ? "silent" : "native";
					transport = "Lampa." + method;

					var successCb = function (data) {
						finish(data, 200, null);
					};

					var errorCb = function (e, x) {
						_this.debugNetwork(stage, transport + " " + (e && e.status || 0) + "/" + (x || "error") + " " + (Date.now() - transportStarted) + "ms");
						_this.debug("Error", stage + " Lampa status=" + (e && e.status || 0) + " " + (x || "error") + " -> XHR");
						useXHR();
					};

					if (method === "native") {
						network.native(url, successCb, errorCb);
					} else {
						network.silent(url, successCb, errorCb);
					}
				} catch (e) {
					_this.debugError(stage + " request", e);
					useXHR();
				}
			};

			var useXHR = function () {
				if (completed || fallbackStarted) return;
				fallbackStarted = true;
				if (canUseHttp && url.indexOf("https:") === 0) {
					url = url.replace(/^https:/, "http:");
					endpoint = url.split(/[?#]/)[0];
					_this.debugNetwork(stage, "fallback=" + endpoint);
				}
				transport = "XHR/" + url.split(":")[0];
				transportStarted = Date.now();
				try {
					var xhr = new XMLHttpRequest();
					xhr.open("GET", url, true);
					xhr.timeout = 5000;

					xhr.onload = function () {
						var finalUrl = xhr.responseURL ? xhr.responseURL.split(/[?#]/)[0] : "";
						if (finalUrl && finalUrl !== endpoint) _this.debugNetwork(stage, "redirect=" + finalUrl);
						if (xhr.status >= 200 && xhr.status < 300) {
							var data;
							try {
								data = JSON.parse(xhr.responseText);
							} catch (e) {
								finish(null, xhr.status, "parse error");
								return;
							}
							finish(data, xhr.status, null);
						} else {
							finish(null, xhr.status, "status " + xhr.status);
						}
					};

					xhr.onerror = function () {
						finish(null, 0, "network error");
					};

					xhr.ontimeout = function () {
						finish(null, 0, "timeout");
					};

					xhr.send();
				} catch (e) {
					finish(null, 0, e.message);
				}
			};

			if (canUseHttp && this.tvmaze_http) useXHR();
			else useLampaReguest();
		}
	};

	if (window.SEASON_FIX_LOADED) {
		SEASON_FIX.debug("Boot", "DUPLICATE: active version=" + (window.SEASON_FIX && window.SEASON_FIX.version || "unknown"));
		return;
	}
	window.SEASON_FIX_LOADED = true;
	window.SEASON_FIX = SEASON_FIX;
	SEASON_FIX.init();
})();
