(function () {
	"use strict";

	var SEASON_FIX = {
		id: "season_fix",
		version: "2.0",
		debug_enabled: true,
		debug_rows: {},
		debug_timer: null,
		hooked: false,

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
				var rows = ["Season Fix " + _this.version + " | исходные сезоны TMDB"];
				["Статус", "Вход", "Результат", "Данные"].forEach(function (key) {
					rows.push(key + ": " + escape(_this.debug_rows[key] || "—"));
				});
				if (_this.hooked && Lampa.Utils.splitEpisodesIntoSeasons !== _this.split_override) {
					rows[1] = "Статус: функция заменена другим плагином";
				}
				_this.debug_content.innerHTML = rows.join("<br>");
			}, 300);
		},

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

		hook: function () {
			if (this.hooked) return true;
			if (typeof Lampa === "undefined" || !Lampa.Utils || typeof Lampa.Utils.splitEpisodesIntoSeasons !== "function") return false;
			var _this = this;
			var originalSplit = Lampa.Utils.splitEpisodesIntoSeasons;
			this.split_override = function (episodes, gap) {
				if (!Array.isArray(episodes) || !episodes.length) return originalSplit.apply(this, arguments);
				var seasons = _this.splitBySeasonNumber(episodes);
				_this.debug("Вход", "tv=" + (episodes[0] && (episodes[0].show_id || episodes[0].series_id) || "?") + "; серий=" + episodes.length);
				if (!seasons) {
					_this.debug("Результат", "нет корректного season_number — штатное разбиение Lampa");
					_this.debug("Данные", "—");
					return originalSplit.apply(this, arguments);
				}
				_this.debug("Результат", Object.keys(seasons).map(function (season) {
					return "S" + season + ": " + seasons[season].length + " серий";
				}).join("; "));
				var descriptions = 0;
				var images = 0;
				for (var i = 0; i < episodes.length; i++) {
					if (episodes[i].overview) descriptions++;
					if (episodes[i].still_path) images++;
				}
				_this.debug("Данные", "с описанием=" + descriptions + "; с кадром=" + images + "; номера и ID сохранены");
				return seasons;
			};
			Lampa.Utils.splitEpisodesIntoSeasons = this.split_override;
			this.hooked = true;
			this.debug("Статус", "подключён; ожидание серий; TVmaze не используется");
			return true;
		},

		init: function () {
			var _this = this;
			this.debug("Статус", "ожидание Lampa");
			var waitForLampa = function () {
				if (!_this.hook()) setTimeout(waitForLampa, 500);
			};
			waitForLampa();
		}
	};

	if (window.SEASON_FIX) {
		if (window.SEASON_FIX.version !== SEASON_FIX.version) {
			SEASON_FIX.debug("Статус", "активна версия " + window.SEASON_FIX.version + "; полностью перезапустите Lampa");
		}
		return;
	}
	window.SEASON_FIX_LOADED = true;
	window.SEASON_FIX = SEASON_FIX;
	SEASON_FIX.init();
})();
