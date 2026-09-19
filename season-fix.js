(function () {
	"use strict";

	var SEASON_FIX = {
		id: "season_fix",
		version: "1.6",
		tvmaze_cache: {},
		tvmaze_pending: {},
		tvmaze_retry_after: {},
		current_tv_id: null,

		init: function () {
			var _this = this;
			var waitForLampa = function () {
				_this.hook();
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
					return {};
				}

				var tvId =
					(episodes[0] && (episodes[0].show_id || episodes[0].series_id)) ||
					_this.current_tv_id;
				var seasonMap = tvId ? _this.tvmaze_cache[tvId] : null;

				if (
					seasonMap &&
					typeof seasonMap === "object" &&
					Object.keys(seasonMap).length > 0
				) {
					return _this.splitByTvmaze(episodes, seasonMap);
				}

				return originalSplit.call(this, episodes, gap);
			};
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

		prepareResponse: function (url, callback) {
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
				if (!data || !Array.isArray(data.episodes)) return callback.apply(context, args);

				_this.fetchTvmaze(tvId, apiKey, function () {
					var previousId = _this.current_tv_id;
					_this.current_tv_id = tvId;
					try {
						callback.apply(context, args);
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
					e.params.complite = _this.prepareResponse(e.params.url, e.params.complite);
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
				settings.success = _this.prepareResponse(reqUrl, settings.success);

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
			var finished = false;
			var finish = function (map) {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				var callbacks = _this.tvmaze_pending[tvId];
				delete _this.tvmaze_pending[tvId];
				if (map) {
					_this.tvmaze_cache[tvId] = map;
					delete _this.tvmaze_retry_after[tvId];
				} else {
					_this.tvmaze_retry_after[tvId] = Date.now() + 30000;
				}
				callbacks.forEach(function (call) {
					setTimeout(call, 0);
				});
				if (map) {
					var event = document.createEvent("CustomEvent");
					event.initCustomEvent("tvmaze_loaded", false, false, { id: tvId });
					window.dispatchEvent(event);
				}
			};
			var timer = setTimeout(function () {
				finish(null);
			}, 15000);

			if (
				!apiKey &&
				typeof Lampa !== "undefined" &&
				Lampa.TMDB &&
				typeof Lampa.TMDB.key === "function"
			) {
				apiKey = Lampa.TMDB.key();
			}

			if (!apiKey) {
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

				_this.makeRequest(lookupUrl, function (showData, status2, error2) {
					if (finished) return;
					if (!showData || !showData.id) {
						finish(null);
						return;
					}

					var episodesUrl =
						"https://api.tvmaze.com/shows/" + showData.id + "/episodes";

					_this.makeRequest(episodesUrl, function (episodes, status3, error3) {
						if (finished) return;
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
			var completed = false;
			var fallbackStarted = false;
			var finish = function (data, status, error) {
				if (completed) return;
				completed = true;
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

					var successCb = function (data) {
						finish(data, 200, null);
					};

					var errorCb = function (e, x) {
						useXHR();
					};

					if (method === "native") {
						network.native(url, successCb, errorCb);
					} else {
						network.silent(url, successCb, errorCb);
					}
				} catch (e) {
					useXHR();
				}
			};

			var useXHR = function () {
				if (completed || fallbackStarted) return;
				fallbackStarted = true;
				try {
					var xhr = new XMLHttpRequest();
					xhr.open("GET", url, true);
					xhr.timeout = 5000;

					xhr.onload = function () {
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

			useLampaReguest();
		}
	};

	if (window.SEASON_FIX_LOADED) return;
	window.SEASON_FIX_LOADED = true;
	window.SEASON_FIX = SEASON_FIX;
	SEASON_FIX.init();
})();
