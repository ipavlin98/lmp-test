(function () {
	"use strict";
	function injectStyles() {
		var css = `
			.card.ep-design-active .card-watched { display: none !important; }
			.ep-watched-layer {
				position: absolute;
				left: 0.4em;
				right: 0.4em;
				bottom: 2.7em;
				z-index: 2;
				background-color: rgba(0, 0, 0, 0.9);
				border-radius: 1em;
				padding: 0.6em 1em 1em 1em;
				box-sizing: border-box;
				font-family: "SegoeUI", sans-serif;
				text-align: left;
				display: flex;
				flex-direction: column;
				pointer-events: none;
				overflow: hidden;
				opacity: 0;
				transition: opacity 0.2s ease;
			}
			.card.focus .ep-watched-layer,
			.card:hover .ep-watched-layer {
				opacity: 1;
				animation: ep-watched-appear 0.2s ease 0.4s backwards;
			}
			@keyframes ep-watched-appear {
				from { opacity: 0; }
				to { opacity: 1; }
			}
			.ep-watched-body {
				font-size: 0.9em;
				display: flex;
				flex-direction: column;
				width: 100%;
			}
			.ep-watched-item {
				margin-top: 0.3em;
				line-height: 1.6;
			}
			.ep-watched-item.is-active {
				margin-top: 0;
				color: #fff;
			}
			.ep-watched-item:nth-child(2) { color: #9f9f9f; }
			.ep-watched-item:nth-child(3) { color: #6c6c6c; }
			.ep-watched-item:nth-child(4) { color: #5e5e5e; }
			.ep-watched-item:nth-child(5) { color: #4c4c4c; }
			.ep-watched-item > span {
				display: block;
				overflow: hidden;
				text-overflow: ellipsis;
				white-space: nowrap;
			}
			.ep-time-line {
				margin-top: 0.5em;
				margin-bottom: 0.3em;
				border-radius: 3em;
				background-color: rgba(255, 255, 255, 0.25);
				height: 0.3em;
				width: 100%;
				overflow: hidden;
			}
			.ep-time-line > div {
				height: 100%;
				border-radius: 3em;
				background-color: #fff;
			}
			.ep-num {
				font-weight: 600;
			}
		`;
		var style = document.getElementById("ep-design-css") || document.createElement("style");
		style.id = "ep-design-css";
		style.innerHTML = css;
		if (!style.parentNode) document.head.appendChild(style);
	}
	function getDaysFromNow(dateStr) {
		if (!dateStr) return -1;
		var date = new Date(dateStr);
		var now = new Date();
		date.setHours(0, 0, 0, 0);
		now.setHours(0, 0, 0, 0);
		var diff = date - now;
		return Math.ceil(diff / (1000 * 60 * 60 * 24));
	}
	function generateVariations(title) {
		if (!title) return [];
		var variations = [title];
		var acronyms = title.match(/[A-Z]{2,}/g);
		if (acronyms) {
			acronyms.forEach(function (acronym) {
				var withBullets = acronym.split("").join("・");
				variations.push(title.replace(acronym, withBullets));
				var withDots = acronym.split("").join(".");
				variations.push(title.replace(acronym, withDots));
				variations.push(title.replace(acronym, withDots + "."));
			});
		}
		var punctuationMap = { "!": "！", "！": "!", "?": "？", "？": "?" };
		var extraVariations = [];
		variations.forEach(function (t) {
			var changed = t
				.split("")
				.map(function (c) {
					return punctuationMap[c] || c;
				})
				.join("");
			if (changed !== t) {
				extraVariations.push(changed);
			}
		});
		return variations.concat(extraVariations);
	}
	function getSeriesProgress(card) {
		var Utils = Lampa.Utils;
		var Storage = Lampa.Storage;
		var Timeline = Lampa.Timeline;
		var baseKeys = [card.original_name, card.original_title, card.name, card.title].filter(Boolean);
		var keys = [];
		baseKeys.forEach(function (key) {
			var vars = generateVariations(key);
			vars.forEach(function (v) {
				if (keys.indexOf(v) === -1) keys.push(v);
			});
		});
		var cache = Storage.get("online_watched_last", "{}");
		var found = null;
		var foundKey = null;
		keys.some(function (key) {
			var hash = Utils.hash(key);
			if (cache[hash] && cache[hash].episode > 0 && cache[hash].season >= 0) {
				found = cache[hash];
				foundKey = key;
				return true;
			}
		});
		if (!found && card.id) {
			var allKeys = Object.keys(cache);
			allKeys.some(function (hash) {
				var item = cache[hash];
				if (item && item.id == card.id && item.episode > 0 && item.season >= 0) {
					found = item;
					foundKey = item.title || item.name || item.original_title || item.original_name;
					return true;
				}
			});
		}
		if (found) {
			return {
				season: found.season,
				episode: found.episode,
				title: foundKey || baseKeys[0],
				fromHistory: true,
			};
		}
		keys.some(function (key) {
			var watched = Timeline.watched({ original_name: key }, true);
			var last = Array.isArray(watched) && watched[watched.length - 1];
			if (!last) return false;
			found = { season: 1, episode: last.ep, title: key, fromHistory: false };
			return true;
		});
		return found;
	}
	function loadEpisodes(card, season, callback) {
		if (!Lampa.Api || !Lampa.Api.seasons) return callback([]);
		Lampa.Api.seasons(
			card,
			[season],
			function (data) {
				if (data && data[season] && Array.isArray(data[season].episodes)) {
					callback(data[season].episodes);
				} else {
					callback([]);
				}
			},
			function () {
				callback([]);
			},
		);
	}
	function drawHTML(cardNode, items, isMovieMode) {
		var viewContainer = cardNode.querySelector(".card__view");
		if (!viewContainer) return;
		var layer = cardNode.querySelector(".ep-watched-layer");
		cardNode.classList.toggle("ep-design-active", !!(items && items.length));
		if (!items || !items.length) {
			if (layer) layer.remove();
			return;
		}
		if (!layer) {
			layer = document.createElement("div");
			layer.className = "ep-watched-layer";
			viewContainer.appendChild(layer);
		}
		if (isMovieMode) layer.classList.add("layer--movie");
		else layer.classList.remove("layer--movie");
		var body = layer.querySelector(".ep-watched-body");
		if (!body) {
			body = document.createElement("div");
			body.className = "ep-watched-body";
			layer.appendChild(body);
		} else {
			body.innerHTML = "";
		}
		items.forEach(function (data) {
			var item = document.createElement("div");
			item.className = "ep-watched-item" + (data.isMovie ? " movie-variant" : "");
			if (data.isCurrent) {
				item.classList.add("is-active");
			}
			var spanText = document.createElement("span");
			spanText.innerHTML = data.title;
			item.appendChild(spanText);
			if (data.percent > 0) {
				var timeline = document.createElement("div");
				timeline.className = "ep-time-line";
				var bar = document.createElement("div");
				bar.style.width = data.percent + "%";
				timeline.appendChild(bar);
				item.appendChild(timeline);
			}
			body.appendChild(item);
		});
	}
	function processSeries(cardNode, cardData) {
		var progress = getSeriesProgress(cardData);
		if (!progress) return drawHTML(cardNode, [], false);
		var titleKey = progress.title || cardData.original_name || cardData.original_title || cardData.name;
		cardNode.classList.add("ep-design-active");
		var request = cardNode.epDesignRequest;
		loadEpisodes(cardData, progress.season, function (episodes) {
			if (request !== cardNode.epDesignRequest) return;
			var indexInHistory = episodes.findIndex(function (ep) {
				return ep.episode_number == progress.episode;
			});
			if (indexInHistory === -1) {
				drawHTML(cardNode, [], false);
				cardNode.classList.add("ep-design-active");
				return;
			}
			var lastWatchedIndex = -1;
			episodes.forEach(function (ep, index) {
				var hashStr = [ep.season_number, ep.season_number > 10 ? ":" : "", ep.episode_number, titleKey].join("");
				var view = Lampa.Timeline.view(Lampa.Utils.hash(hashStr));
				if (view && view.percent > 0) {
					lastWatchedIndex = index;
				}
			});
			var currentIndex = 0;
			if (lastWatchedIndex > -1) {
				currentIndex = lastWatchedIndex;
			} else {
				currentIndex = indexInHistory;
			}
			var nextEpIndex = currentIndex + 1;
			var nextEp = episodes[nextEpIndex];
			var daysToNext = nextEp ? getDaysFromNow(nextEp.air_date) : -1;
			var nextIsFuture = daysToNext > 0;
			var listToShow = [];
			if (nextIsFuture) {
				listToShow.push(episodes[currentIndex]);
				if (nextEp) listToShow.push(nextEp);
			} else {
				listToShow = episodes.slice(currentIndex, currentIndex + 5);
			}
			var itemsToDraw = listToShow.map(function (ep, i) {
				var isFirstInList = i === 0;
				var percent = 0;
				var days = getDaysFromNow(ep.air_date);
				var isFuture = days > 0;
				var epName = (ep.name || "").replace(new RegExp("^" + ep.episode_number + "([ .-]|$)"), "").trim();
				if (!epName || epName === Lampa.Lang.translate("noname")) epName = "";
				if (isFuture) {
					if (days >= 365) {
						var years = Math.floor(days / 365);
						epName = "Осталось лет: " + years;
					} else if (days >= 30) {
						var months = Math.floor(days / 30);
						epName = "Осталось месяцев: " + months;
					} else if (days >= 7) {
						var weeks = Math.floor(days / 7);
						epName = "Осталось недель: " + weeks;
					} else {
						epName = "Осталось дней: " + days;
					}
				}
				var titleHtml = '<span class="ep-num">' + ep.episode_number + " -</span> " + epName;
				if (!isFuture) {
					var hashStr = [ep.season_number, ep.season_number > 10 ? ":" : "", ep.episode_number, titleKey].join("");
					var viewData = Lampa.Timeline.view(Lampa.Utils.hash(hashStr));
					if (viewData) percent = viewData.percent;
				}
				return {
					title: titleHtml,
					percent: percent,
					isCurrent: isFirstInList,
					isMovie: false,
				};
			});
			drawHTML(cardNode, itemsToDraw, false);
		});
	}
	function processMovie(cardNode, cardData) {
		var Utils = Lampa.Utils;
		var Timeline = Lampa.Timeline;
		var Lang = Lampa.Lang;
		var key = cardData.original_title || cardData.title;
		if (!key) return drawHTML(cardNode, [], true);
		var viewData = Timeline.view(Utils.hash(key));
		if (!viewData || !viewData.percent) return drawHTML(cardNode, [], true);
		var statusText = Lang.translate("title_viewed");
		var timeText = "";
		if (viewData.time && viewData.time > 0) {
			timeText = Utils.secondsToTimeHuman(viewData.time);
		} else {
			timeText = viewData.percent + "%";
		}
		var itemsToDraw = [
			{
				title: statusText + " " + timeText,
				percent: viewData.percent,
				isCurrent: true,
				isMovie: true,
			},
		];
		drawHTML(cardNode, itemsToDraw, true);
	}
	function renderCard(cardNode, cardData) {
		if (!cardData || cardNode.classList.contains("card--wide")) return;
		cardNode.epDesignRequest = (cardNode.epDesignRequest || 0) + 1;
		var isSeries = cardData.number_of_seasons > 0 || cardData.original_name || cardData.media_type === "tv";
		if (isSeries) {
			processSeries(cardNode, cardData);
		} else {
			processMovie(cardNode, cardData);
		}
	}
	function startPlugin() {
		injectStyles();
		function updateCard(card) {
			var data = card.card_data || card.data || (window.jQuery && window.jQuery(card).data("data"));
			renderCard(card, data);
		}
		function updateFocused() {
			document.querySelectorAll(".card.focus").forEach(updateCard);
		}
		function onCardEvent(e) {
			var card = e.target.closest && e.target.closest(".card");
			if (!card) return;
			if (e.type === "mouseover" && e.relatedTarget && card.contains(e.relatedTarget)) return;
			updateCard(card);
		}
		["hover:focus", "hover:touch", "hover:hover", "mouseover", "update"].forEach(function (event) {
			document.addEventListener(event, onCardEvent, true);
		});
		Lampa.Listener.follow("activity", function (e) {
			if (e.type === "start") setTimeout(updateFocused, 0);
		});
		Lampa.Listener.follow("state:changed", function (e) {
			if (e.target === "timeline" || e.target === "timetable") updateFocused();
		});
		window.addEventListener("tvmaze_loaded", function (e) {
			if (!e.detail || !e.detail.id) return;
			document.querySelectorAll(".card").forEach(function (card) {
				var data = card.card_data || card.data || (window.jQuery && window.jQuery(card).data("data"));
				if (data && data.id == e.detail.id) renderCard(card, data);
			});
		});
		updateFocused();
	}
	if (window.appready) {
		startPlugin();
	} else {
		Lampa.Listener.follow("app", function (e) {
			if (e.type == "ready") startPlugin();
		});
	}
})();
