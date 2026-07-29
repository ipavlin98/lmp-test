(function () {
	"use strict";

	const ANISKIP_API = "https://api.aniskip.com/v2/skip-times";
	const JIKAN_API = "https://api.jikan.moe/v4/anime";
	const ANILIST_API = "https://graphql.anilist.co";
	const GITHUB_DB_URL = "https://raw.githubusercontent.com/ipavlin98/lmp-series-skip-db/refs/heads/main/database/";
	const SKIP_TYPES = ["op", "ed", "recap"];
	const STORAGE_KEY = "ultimate_skip_offsets";
	const FETCH_TIMEOUT = 8000;
	const requestCache = new Map();

	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async function fetchJson(url, options, attempts = 2) {
		for (let attempt = 0; attempt < attempts; attempt++) {
			const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
			const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT) : null;
			try {
				const response = await fetch(url, Object.assign({}, options, controller ? { signal: controller.signal } : {}));
				if (response.ok) return await response.json();
				if (response.status < 500 && response.status !== 429) return null;
			} catch (e) {
				// Retry network and temporary upstream errors once.
			} finally {
				if (timer) clearTimeout(timer);
			}
			if (attempt + 1 < attempts) await sleep(400 * (attempt + 1));
		}
		return null;
	}

	function cached(key, load) {
		if (!requestCache.has(key)) {
			const request = Promise.resolve().then(load);
			requestCache.set(key, request);
			request.then((value) => {
				if (value === null) requestCache.delete(key);
			}, () => requestCache.delete(key));
		}
		return requestCache.get(key);
	}

	function getCardId(card) {
		if (!card) return null;
		return card.id || card.kinopoisk_id || card.kp_id || card.imdb_id || null;
	}

	function getOffsets() {
		try {
			var data = Lampa.Storage.get(STORAGE_KEY, "{}");
			if (typeof data === "string") return JSON.parse(data);
			return data || {};
		} catch (e) {
			return {};
		}
	}

	function getOffset(cardId) {
		if (!cardId) return 0;
		var offsets = getOffsets();
		return offsets[cardId] || 0;
	}

	function setOffset(cardId, value) {
		if (!cardId) return;
		var offsets = getOffsets();
		if (value === 0) {
			delete offsets[cardId];
		} else {
			offsets[cardId] = value;
		}
		Lampa.Storage.set(STORAGE_KEY, JSON.stringify(offsets));
	}

	function applyOffset(segments, offset) {
		if (!segments || !offset) return segments;
		return segments.map(function (seg) {
			return {
				start: Math.max(0, seg.start + offset),
				end: Math.max(0, seg.end + offset),
				name: seg.name
			};
		});
	}

	function hasExistingSegments(obj) {
		return obj && obj.segments && obj.segments.skip && obj.segments.skip.length > 0;
	}

	function isAnimeContent(card) {
		if (!card) return false;
		const lang = (card.original_language || "").toLowerCase();
		const isAsian = lang === "ja" || lang === "zh" || lang === "cn";
		const isAnimation = Array.isArray(card.genres) && card.genres.some(
			(g) => g.id === 16 || (g.name && g.name.toLowerCase() === "animation")
		);
		return isAsian || isAnimation;
	}

	function updatePlaylist(playlist, currentSeason, currentEpisode, segments) {
		if (playlist && Array.isArray(playlist)) {
			playlist.forEach((item, index) => {
				const itemSeason = item.season || item.s || currentSeason;
				const itemEpisode = item.episode || item.e || item.episode_number || index + 1;

				if (parseInt(itemEpisode) === parseInt(currentEpisode) && parseInt(itemSeason) === parseInt(currentSeason)) {
					if (!hasExistingSegments(item)) {
						item.segments = item.segments || {};
						item.segments.skip = segments.slice();
					}
				}
			});
		}
	}

	function getSegmentsFromDb(dbData, season, episode) {
		if (!dbData) return null;
		const seasonStr = String(season);
		const episodeStr = String(episode);

		if (dbData[seasonStr] && dbData[seasonStr][episodeStr]) {
			return dbData[seasonStr][episodeStr];
		}

		if (seasonStr === "1" && episodeStr === "1" && dbData.movie) {
			return dbData.movie;
		}

		return null;
	}

	async function fetchFromGitHub(kpId) {
		return cached("db:" + kpId, () => fetchJson(`${GITHUB_DB_URL}${kpId}.json`));
	}

	async function searchAniList(query) {
		const payload = {
			query: "query ($search: String) { Page(page: 1, perPage: 10) { media(search: $search, type: ANIME) { idMal title { romaji english native } seasonYear startDate { year } } } }",
			variables: { search: query }
		};
		const json = await fetchJson(ANILIST_API, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(payload)
		});
		if (!json || (json.errors && json.errors.length)) return [];
		return (json.data && json.data.Page && json.data.Page.media ? json.data.Page.media : [])
			.filter((item) => item.idMal)
			.map((item) => ({
				mal_id: item.idMal,
				title: item.title.romaji,
				title_english: item.title.english,
				title_synonyms: [item.title.native].filter(Boolean),
				year: item.seasonYear || (item.startDate && item.startDate.year)
			}));
	}

	async function searchMalId(title, seas, year) {
		if (!title) return null;
		return cached(`mal:${title}|${seas}|${year}`, async () => {
			let query = title;
			if (seas > 1) query += " Season " + seas;

			const jikan = await fetchJson(`${JIKAN_API}?q=${encodeURIComponent(query)}&limit=10`, {}, 1);
			const results = jikan && jikan.data && jikan.data.length ? jikan.data : await searchAniList(query);
			if (!results.length) return null;

			if (year && seas === 1) {
				const match = results.find((item) => {
					let y = item.year;
					if (!y && item.aired && item.aired.from)
						y = item.aired.from.substring(0, 4);
					return String(y) === String(year);
				});
				if (match) {
					return match.mal_id;
				}
			}

			if (seas > 1) {
				const ordinal =
					seas +
					(seas % 10 === 1 && seas !== 11
						? "st"
						: seas % 10 === 2 && seas !== 12
							? "nd"
							: seas % 10 === 3 && seas !== 13
								? "rd"
								: "th");
				const keywords = [
					`Season ${seas}`,
					`${ordinal} Season`,
					`Season${seas}`
				];

				const titleMatch = results.find((item) => {
					const titlesToCheck = [
						item.title,
						item.title_english,
						...(item.title_synonyms || [])
					]
						.filter(Boolean)
						.map((t) => t.toLowerCase());

					return titlesToCheck.some((t) =>
						keywords.some((k) => t.includes(k.toLowerCase()))
					);
				});

				if (titleMatch) {
					return titleMatch.mal_id;
				}
			}

			return results[0].mal_id;
		});
	}

	async function fetchAniSkipSegments(malId, episode) {
		const types = SKIP_TYPES.map((t) => "types=" + t);
		types.push("episodeLength=0");
		const url = `${ANISKIP_API}/${malId}/${episode}?${types.join("&")}`;
		return cached(`skip:${malId}:${episode}`, async () => {
			const data = await fetchJson(url);
			return data && data.found && data.results ? data.results : [];
		});
	}

	function parseAniSkipSegments(rawSegments) {
		if (!rawSegments || !rawSegments.length) return [];
		const list = [];
		rawSegments.forEach((s) => {
			if (!s.interval) return;
			const type = (s.skipType || s.skip_type || "").toLowerCase();
			let name = "Пропустить";
			if (type.includes("op")) name = "Опенинг";
			else if (type.includes("ed")) name = "Эндинг";
			else if (type === "recap") name = "Рекап";

			const start =
				s.interval.startTime !== undefined
					? s.interval.startTime
					: s.interval.start_time;
			const end =
				s.interval.endTime !== undefined
					? s.interval.endTime
					: s.interval.end_time;

			if (start !== undefined && end !== undefined) {
				list.push({ start, end, name });
			}
		});
		return list;
	}

	async function searchAndApply(videoParams) {
		let card = videoParams.movie || videoParams.card;
		if (!card) {
			const active = Lampa.Activity.active();
			if (active) card = active.movie || active.card;
		}
		if (!card) return;

		const title = videoParams.title || card.title || card.name || "";
		const trailerKeywords = ["трейлер", "trailer", "тизер", "teaser"];
		const isTrailerTitle = trailerKeywords.some((k) =>
			title.toLowerCase().includes(k)
		);

		if (isTrailerTitle) {
			return;
		}

		const kpId = card.kinopoisk_id || (card.source === "kinopoisk" ? card.id : null) || card.kp_id;

		const position = (function (params, defaultSeason = 1) {
			if (params.episode || params.e || params.episode_number) {
				return {
					season: parseInt(params.season || params.s || defaultSeason),
					episode: parseInt(params.episode || params.e || params.episode_number)
				};
			}
			if (params.playlist && Array.isArray(params.playlist)) {
				const url = params.url;
				const index = params.playlist.findIndex((p) => p.url && p.url === url);
				if (index !== -1) {
					const item = params.playlist[index];
					return {
						season: parseInt(item.season || item.s || defaultSeason),
						episode: parseInt(item.episode || item.e || item.episode_number || index + 1)
					};
				}
			}
			return { season: defaultSeason, episode: 1 };
		})(videoParams, 1);

		let episode = position.episode;
		let season = position.season;

		const isSerial = card.number_of_seasons > 0 || (card.original_name && !card.original_title);
		if (!isSerial) {
			season = 1;
			episode = 1;
		}

		if (hasExistingSegments(videoParams)) return;

		let finalSegments = [];
		let source = null;
		const isAnime = isAnimeContent(card);

		if (isAnime) {
			let cleanName = card.original_name || card.original_title || card.name || card.title;
			const searchTerm = cleanName
				? cleanName
					.replace(/\(\d{4}\)/g, "")
					.replace(/\(TV\)/gi, "")
					.replace(/Season \d+/gi, "")
					.replace(/Part \d+/gi, "")
					.replace(/[:\-]/g, " ")
					.replace(/\s+/g, " ")
					.trim()
				: "";

			const releaseYear = (card.release_date || card.first_air_date || "0000").slice(0, 4);

			const malId = await searchMalId(searchTerm, season, releaseYear);

			if (malId) {
				const segmentsData = await fetchAniSkipSegments(malId, episode);
				finalSegments = parseAniSkipSegments(segmentsData);
				if (finalSegments.length > 0) {
					source = "aniskip";
				}
			}
		}

		if (finalSegments.length === 0 && kpId) {
			const dbData = await fetchFromGitHub(kpId);
			if (dbData) {
				const segmentsData = getSegmentsFromDb(dbData, season, episode);
				if (segmentsData && segmentsData.length > 0) {
					finalSegments = segmentsData.slice();
					source = "github";
				}

				if (videoParams.playlist && Array.isArray(videoParams.playlist)) {
					videoParams.playlist.forEach((item) => {
						if (hasExistingSegments(item)) return;

						const itemSeason = item.season || item.s || season;
						const itemEpisode = item.episode || item.e || item.episode_number;
						if (itemSeason && itemEpisode) {
							const itemSegments = getSegmentsFromDb(dbData, itemSeason, itemEpisode);
							if (itemSegments) {
								var cardId = getCardId(card);
								var offset = getOffset(cardId);
								item.segments = item.segments || {};
								item.segments.skip = offset !== 0 ? applyOffset(itemSegments, offset) : itemSegments.slice();
							}
						}
					});
				}
			}
		}

		if (finalSegments.length > 0) {
			var cardId = getCardId(card);
			var offset = getOffset(cardId);
			if (offset !== 0) {
				finalSegments = applyOffset(finalSegments, offset);
			}

			videoParams.segments = videoParams.segments || {};
			videoParams.segments.skip = finalSegments.slice();

			updatePlaylist(videoParams.playlist, season, episode, finalSegments);
			Lampa.Noty.show("Таймкоды загружены: Сезон " + season + ", Серия " + episode);
		}
	}

	function initOffsetFilterMenu() {
		if (window.ultimate_skip_filter_plugin) {
			return;
		}

		window.ultimate_skip_filter_plugin = true;

		Lampa.Lang.add({
			ultimate_skip_offset: {
				ru: "Смещение меток",
				en: "Marks offset",
				uk: "Зміщення міток",
				zh: "标记偏移"
			},
			ultimate_skip_offset_sec: {
				ru: "сек",
				en: "sec",
				uk: "сек",
				zh: "秒"
			}
		});

		Lampa.Controller.listener.follow("toggle", function (event) {
			if (event.name !== "select") {
				return;
			}

			var active = Lampa.Activity.active();

			var componentName = active.component ? active.component.toLowerCase() : "";
			if (
				!active ||
				!active.component ||
				(componentName !== "lamponline" && componentName !== "lampacskaz")
			) {
				return;
			}

			var $filterTitle = $(".selectbox__title");

			if (
				$filterTitle.length !== 1 ||
				$filterTitle.text() !== Lampa.Lang.translate("title_filter")
			) {
				return;
			}

			if ($(".selectbox-item[data-ultimate-skip-offset]").length > 0) {
				return;
			}

			var card = active.movie || active.card;
			var cardId = getCardId(card);

			if (!cardId) {
				return;
			}

			var currentOffset = getOffset(cardId);
			var offsetText = currentOffset === 0 ? "0" : (currentOffset > 0 ? "+" + currentOffset : String(currentOffset));

			var $offsetItem = Lampa.Template.get("selectbox_item", {
				title: Lampa.Lang.translate("ultimate_skip_offset"),
				subtitle: offsetText + " " + Lampa.Lang.translate("ultimate_skip_offset_sec")
			});

			$offsetItem.attr("data-ultimate-skip-offset", "true");

			$offsetItem.on("hover:enter", function () {
				Lampa.Select.close();

				var items = [];
				var values = [-30, -20, -15, -10, -5, -3, -2, -1, 0, 1, 2, 3, 5, 10, 15, 20, 30];

				values.forEach(function (val) {
					var label = val === 0 ? "0" : (val > 0 ? "+" + val : String(val));
					items.push({
						title: label + " " + Lampa.Lang.translate("ultimate_skip_offset_sec"),
						value: val,
						selected: val === currentOffset
					});
				});

				Lampa.Select.show({
					title: Lampa.Lang.translate("ultimate_skip_offset"),
					items: items,
					onBack: function () {
						Lampa.Controller.toggle("content");
					},
					onSelect: function (item) {
						setOffset(cardId, item.value);
						Lampa.Noty.show(Lampa.Lang.translate("ultimate_skip_offset") + ": " + (item.value === 0 ? "0" : (item.value > 0 ? "+" + item.value : item.value)) + " " + Lampa.Lang.translate("ultimate_skip_offset_sec"));
						Lampa.Controller.toggle("content");
					}
				});
			});

			var $lastItem = $(".selectbox-item").last();
			if ($lastItem.length) {
				$lastItem.after($offsetItem);
			} else {
				var $scrollBody = $("body > .selectbox").find(".scroll__body");
				$scrollBody.append($offsetItem);
			}

			Lampa.Controller.collectionSet(
				$("body > .selectbox").find(".scroll__body")
			);
		});
	}

	function init() {
		if (window.lampa_ultimate_skip) return;
		window.lampa_ultimate_skip = true;

		initOffsetFilterMenu();

		const originalPlay = Lampa.Player.play;
		const originalPlaylist = Lampa.Player.playlist;
		let pendingPlaylist = null;

		Lampa.Player.playlist = function (playlist) {
			pendingPlaylist = playlist;
			originalPlaylist.call(this, playlist);
		};

		Lampa.Player.play = function (videoParams) {
			const context = this;

			if (videoParams.url) {
				Lampa.PlayerPlaylist.url(videoParams.url);
			}

			if (videoParams.playlist && videoParams.playlist.length > 0) {
				Lampa.PlayerPlaylist.set(videoParams.playlist);
			}

			searchAndApply(videoParams)
				.then(() => {
					originalPlay.call(context, videoParams);

					if (pendingPlaylist) {
						Lampa.PlayerPlaylist.set(pendingPlaylist);
						pendingPlaylist = null;
					}
				})
				.catch((e) => {
					originalPlay.call(context, videoParams);
				});
		};
	}

	if (window.Lampa && window.Lampa.Player) {
		init();
	} else {
		window.document.addEventListener("app_ready", init);
	}
})();
