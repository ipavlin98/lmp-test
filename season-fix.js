(function () {
	"use strict";

	var SEASON_FIX = {
		id: "season_fix",
		version: "3.0",
		season_cache: {},
		pending: {},
		current_tv_id: null,
		hooked: false,
		/*
		debug_enabled: true,
		debug_rows: {},
		debug_timer: null,

		debug: function (key, value) {
			if (!this.debug_enabled) return;
			this.debug_rows[key] = String(value).slice(0, 180);
			this.debugShow();
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
			panel.style.cssText = "position:fixed!important;left:12px!important;right:12px!important;bottom:12px!important;top:auto!important;width:auto!important;max-width:1050px!important;max-height:35vh!important;overflow:auto!important;display:block!important;visibility:visible!important;opacity:1!important;transform:none!important;z-index:2147483647!important;pointer-events:auto!important;background:#10241f!important;color:#fff!important;padding:10px 14px!important;border:1px solid #55d6a0!important;border-radius:6px!important;font-size:16px!important;line-height:1.3!important;text-align:left!important;box-sizing:border-box!important;user-select:text!important;";
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
				var rows = ["Season Fix " + _this.version + " | Cinemeta + TMDB"];
				["Статус", "Ответ", "База", "Разбиение", "Данные", "Ошибка"].forEach(function (key) {
					rows.push(key + ": " + escape(_this.debug_rows[key] || "—"));
				});
				if (_this.hooked && Lampa.Utils.splitEpisodesIntoSeasons !== _this.split_override) {
					rows[1] = "Статус: функция заменена другим плагином";
				}
				_this.debug_content.innerHTML = rows.join("<br>");
			}, 300);
		},
		*/

		splitBySeasonNumber: function (episodes) {
			var seasons = {};
			for (var i = 0; i < episodes.length; i++) {
				var episode = episodes[i];
				if (!episode || typeof episode.season_number !== "number" || !isFinite(episode.season_number) || episode.season_number < 0 || Math.floor(episode.season_number) !== episode.season_number) return null;
				var season = episode.season_number;
				if (!seasons[season]) seasons[season] = [];
				var copy = {};
				Object.keys(episode).forEach(function (key) {
					copy[key] = episode[key];
				});
				seasons[season].push(copy);
			}
			Object.keys(seasons).forEach(function (season) {
				seasons[season].sort(function (a, b) {
					return (a.episode_number || 0) - (b.episode_number || 0);
				});
			});
			return seasons;
		},

		mapSummary: function (map) {
			return Object.keys(map).map(function (season) {
				return "S" + season + ":" + map[season];
			}).join(" ");
		},

		buildMap: function (videos) {
			if (!Array.isArray(videos)) return null;
			var seasons = {};
			for (var i = 0; i < videos.length; i++) {
				var video = videos[i];
				if (!video) continue;
				var season = Number(video.season);
				if (season === 0) continue;
				var episode = Number(video.episode == null ? video.number : video.episode);
				if (!isFinite(season) || season < 1 || Math.floor(season) !== season || !isFinite(episode) || episode < 1 || Math.floor(episode) !== episode) return null;
				if (!seasons[season]) seasons[season] = {};
				seasons[season][episode] = true;
			}
			var map = {};
			var keys = Object.keys(seasons).map(Number).sort(function (a, b) { return a - b; });
			if (!keys.length) return null;
			for (var s = 0; s < keys.length; s++) {
				if (keys[s] !== s + 1) return null;
				var numbers = Object.keys(seasons[keys[s]]).map(Number).sort(function (a, b) { return a - b; });
				for (var n = 0; n < numbers.length; n++) {
					if (numbers[n] !== n + 1) return null;
				}
				map[keys[s]] = numbers.length;
			}
			return map;
		},

		splitByMap: function (episodes, map) {
			var sorted = episodes.slice().sort(function (a, b) { return a.episode_number - b.episode_number; });
			var total = Object.keys(map).reduce(function (sum, season) { return sum + map[season]; }, 0);
			if (sorted.length > total) return null;
			var result = {};
			var season = 1;
			var number = 0;
			for (var i = 0; i < sorted.length; i++) {
				var episode = sorted[i];
				if (!episode || episode.season_number !== 1 || episode.episode_number !== i + 1) return null;
				if (number === map[season]) {
					season++;
					number = 0;
				}
				if (!map[season]) return null;
				var copy = {};
				Object.keys(episode).forEach(function (key) { copy[key] = episode[key]; });
				copy.season_number = season;
				copy.episode_number = ++number;
				if (!result[season]) result[season] = [];
				result[season].push(copy);
			}
			return result;
		},

		makeRequest: function (url, method, callback) {
			var started = Date.now();
			var finished = false;
			var network;
			var timer;
			var finish = function (data, error) {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				if (network) network.clear();
				callback(data, error, Date.now() - started);
			};
			timer = setTimeout(function () { finish(null, "timeout"); }, 8500);
			try {
				network = new Lampa.Reguest();
				network.timeout(8000);
				network[method](url, function (data) {
					if (typeof data === "string") {
						try { data = JSON.parse(data); }
						catch (e) { finish(null, "неверный JSON"); return; }
					}
					finish(data, data ? null : "пустой ответ");
				}, function (error, reason) {
					finish(null, "status=" + (error && error.status || 0) + " " + (reason || "network error"));
				});
			} catch (e) {
				finish(null, e.message);
			}
		},

		ensureMap: function (tvId, callback) {
			var _this = this;
			var cached = this.season_cache[tvId];
			if (cached && Date.now() - cached.time < (cached.map ? 21600000 : 60000)) {
				if (callback) callback(cached);
				return;
			}
			if (this.pending[tvId]) {
				if (callback) this.pending[tvId].push(callback);
				return;
			}
			this.pending[tvId] = callback ? [callback] : [];
			var entry = { time: Date.now(), map: null, imdb: "", error: "", net: "" };
			var finish = function (error) {
				entry.error = error || "";
				entry.time = Date.now();
				_this.season_cache[tvId] = entry;
				var waiting = _this.pending[tvId];
				delete _this.pending[tvId];
				waiting.forEach(function (ready) {
					try { ready(entry); }
					catch (e) { /* _this.debug("Ошибка", e.message); console.error("Season Fix", e); */ }
				});
				if (entry.map) window.dispatchEvent(new CustomEvent("tvmaze_loaded", { detail: { id: tvId, source: "cinemeta" } }));
			};
			if (!Lampa.TMDB || !Lampa.TMDB.api || !Lampa.TMDB.key) {
				finish("нет доступа к TMDB API Lampa");
				return;
			}
			var idsUrl = Lampa.TMDB.api("tv/" + tvId + "/external_ids?api_key=" + encodeURIComponent(Lampa.TMDB.key()));
			this.makeRequest(idsUrl, "silent", function (ids, error) {
				if (error) { finish("TMDB external_ids: " + error); return; }
				if (!ids || !/^tt\d+$/.test(ids.imdb_id || "")) { finish("в TMDB нет IMDb ID"); return; }
				entry.imdb = ids.imdb_id;
				var url = "https://v3-cinemeta.strem.io/meta/series/" + entry.imdb + ".json";
				_this.makeRequest(url, "native", function (data, error, elapsed) {
					entry.net = "v3-cinemeta.strem.io " + (error || "OK") + " " + elapsed + "ms";
					if (error) { finish("Cinemeta: " + error); return; }
					var meta = data && data.meta;
					if (!meta || (meta.imdb_id || meta.id) !== entry.imdb) { finish("Cinemeta: сериал не найден"); return; }
					entry.map = _this.buildMap(meta.videos);
					finish(entry.map ? null : "Cinemeta: нет полной последовательной нумерации серий");
				});
			});
		},

		/*
		reportResponse: function (tvId, requested, data, inputCount) {
			var entry = this.season_cache[tvId];
			this.debug("Ответ", "последний: tv=" + tvId + "; запрос S" + requested + " → S" + data.season_number + "; TMDB=" + inputCount + ", отдано=" + data.episodes.length);
			this.debug("База", entry && entry.map ? "Cinemeta " + entry.imdb + " | " + this.mapSummary(entry.map) : "TMDB; " + (entry && entry.error || "внешняя разметка не запрашивалась"));
			this.debug("Статус", entry && entry.net || "подключён; TVmaze не используется");
			this.debug("Ошибка", entry && entry.error || "—");
			var descriptions = data.episodes.filter(function (ep) { return ep && ep.overview; }).length;
			var images = data.episodes.filter(function (ep) { return ep && ep.still_path; }).length;
			this.debug("Данные", "с описанием=" + descriptions + "; с кадром=" + images + "; ID эпизодов TMDB сохранены");
		},
		*/

		hookRequest: function (params) {
			if (!params || params.season_fix_wrapped || typeof params.complite !== "function") return;
			var match = String(params.url || "").match(/\/tv\/(\d+)\/season\/(\d+)(?:\?|$)/);
			if (!match) return;
			params.season_fix_wrapped = true;
			var _this = this;
			var tvId = match[1];
			var requested = Number(match[2]);
			var complete = params.complite;
			if (requested === 1) this.ensureMap(tvId);
			params.complite = function (data) {
				var context = this;
				var args = arguments;
				if (!data || !Array.isArray(data.episodes)) return complete.apply(context, args);
				var deliver = function () {
					var previous = _this.current_tv_id;
					_this.current_tv_id = tvId;
					var inputCount = data.episodes.length;
					/* _this.debug("Разбиение", "сезон TMDB без переразметки"); */
					try {
						return complete.apply(context, args);
					} finally {
						_this.current_tv_id = previous;
						/* _this.reportResponse(tvId, requested, data, inputCount); */
					}
				};
				if (requested === 1) {
					/* _this.debug("Статус", "tv=" + tvId + "; ожидание разметки Cinemeta"); */
					_this.ensureMap(tvId, deliver);
				} else return deliver();
			};
		},

		hook: function () {
			if (this.hooked) return true;
			if (typeof Lampa === "undefined" || !Lampa.Utils || typeof Lampa.Utils.splitEpisodesIntoSeasons !== "function" || !Lampa.Listener || !Lampa.Reguest) return false;
			var _this = this;
			var originalSplit = Lampa.Utils.splitEpisodesIntoSeasons;
			this.split_override = function (episodes, gap) {
				if (!Array.isArray(episodes) || !episodes.length) return originalSplit.apply(this, arguments);
				var seasons = _this.splitBySeasonNumber(episodes);
				if (!seasons) return originalSplit.apply(this, arguments);
				var tvId = episodes[0].show_id || episodes[0].series_id || _this.current_tv_id;
				var entry = tvId && _this.season_cache[tvId];
				var mapped = entry && entry.map && _this.splitByMap(episodes, entry.map);
				if (mapped) seasons = mapped;
				var counts = {};
				Object.keys(seasons).forEach(function (season) { counts[season] = seasons[season].length; });
				/* _this.debug("Разбиение", (mapped ? "Cinemeta: " : "сохранены сезоны TMDB: ") + _this.mapSummary(counts)); */
				return seasons;
			};
			Lampa.Utils.splitEpisodesIntoSeasons = this.split_override;
			Lampa.Listener.follow("request_before", function (event) { _this.hookRequest(event.params); });
			this.hooked = true;
			/* this.debug("Статус", "подключён; ожидание серий; TVmaze не используется"); */
			return true;
		},

		init: function () {
			var _this = this;
			/* this.debug("Статус", "ожидание Lampa"); */
			var waitForLampa = function () {
				if (!_this.hook()) setTimeout(waitForLampa, 500);
			};
			waitForLampa();
		}
	};

	if (window.SEASON_FIX) {
		if (window.SEASON_FIX.version !== SEASON_FIX.version) {
			/* SEASON_FIX.debug("Статус", "активна версия " + window.SEASON_FIX.version + "; полностью перезапустите Lampa"); */
		}
		return;
	}
	window.SEASON_FIX_LOADED = true;
	window.SEASON_FIX = SEASON_FIX;
	SEASON_FIX.init();
})();
