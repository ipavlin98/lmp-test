(function () {
	"use strict";

	const ANISKIP_API = "https://api.aniskip.com/v2/skip-times";
	const ANILIST_API = "https://graphql.anilist.co";
	const JIKAN_API = "https://api.jikan.moe/v4/anime";
	const GITHUB_DB_URL = "https://raw.githubusercontent.com/ipavlin98/lmp-series-skip-db/refs/heads/main/database/";
	const SKIP_TYPES = ["op", "ed", "recap"];
	const STORAGE_KEY = "ultimate_skip_offsets";
	const segmentSources = new WeakMap();

	function getCardId(card) {
		if (!card) return null;
		return card.id || card.kinopoisk_id || card.kp_id || card.imdb_id || null;
	}

	function getOffsets() {
		try {
			var data = Lampa.Storage.get(STORAGE_KEY, "{}");
			return Lampa.Arrays.isObject(data) ? data : {};
		} catch (e) {
			return {};
		}
	}

	function getOffset(cardId) {
		if (!cardId) return 0;
		var offsets = getOffsets();
		var value = Number(offsets[cardId]);
		return Number.isFinite(value) ? value : 0;
	}

	function setOffset(cardId, value) {
		if (!cardId) return;
		var offsets = getOffsets();
		if (value === 0) {
			delete offsets[cardId];
		} else {
			offsets[cardId] = value;
		}
		Lampa.Storage.set(STORAGE_KEY, offsets);
	}

	function normalizeSegments(segments) {
		if (!Array.isArray(segments)) return [];
		return segments.filter(function (seg) {
			return seg && seg.start != null && seg.end != null;
		}).map(function (seg) {
			return Object.assign({}, seg, { start: Number(seg.start), end: Number(seg.end) });
		}).filter(function (seg) {
			return Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start;
		});
	}

	function applyOffset(segments, offset) {
		return segments.map(function (seg) {
			return Object.assign({}, seg, {
				start: Math.max(0, seg.start + offset),
				end: Math.max(0, seg.end + offset)
			});
		}).filter(function (seg) {
			return seg.end > seg.start;
		});
	}

	function hasExistingSegments(obj) {
		return obj && obj.segments && obj.segments.skip && obj.segments.skip.length > 0;
	}

	function setSegments(target, segments, offset) {
		if (!target || (hasExistingSegments(target) && !segmentSources.has(target.segments.skip))) return;
		const skip = applyOffset(segments, offset);
		const previous = target.segments;
		target.segments = Object.assign({}, Lampa.Arrays.isObject(previous) ? previous : { duration_ms: previous }, { skip });
		segmentSources.set(skip, segments);
		return true;
	}

	function getPosition(params, defaultSeason = 1, defaultEpisode = 1) {
		const season = parseInt(params.season || params.s, 10);
		const episode = parseInt(params.episode || params.e || params.episode_number, 10);
		return {
			season: Number.isFinite(season) && season > 0 ? season : defaultSeason,
			episode: Number.isFinite(episode) && episode > 0 ? episode : defaultEpisode
		};
	}

	function isAnimeContent(card) {
		if (!card) return false;
		const lang = String(card.original_language || "").toLowerCase();
		const isAsian = lang === "ja" || lang === "zh" || lang === "cn";
		const isAnimation = Array.isArray(card.genres) && card.genres.some(
			(g) => g && (g.id === 16 || (g.name && String(g.name).toLowerCase() === "animation"))
		);
		return isAsian || isAnimation;
	}

	function getSegmentsFromDb(dbData, season, episode) {
		if (!dbData) return [];
		const seasonStr = String(season);
		const episodeStr = String(episode);

		if (dbData[seasonStr] && dbData[seasonStr][episodeStr]) {
			return normalizeSegments(dbData[seasonStr][episodeStr]);
		}

		return normalizeSegments(dbData.movie);
	}

	function requestJson(url, postData) {
		return new Promise((resolve) => {
			const network = new Lampa.Reguest();
			network.silent(url, resolve, () => resolve(null), postData ? JSON.stringify(postData) : undefined, {
				headers: postData ? { "Content-Type": "application/json", "Accept": "application/json" } : undefined
			});
		}).catch(() => null);
	}

	function findMalId(results, seas, year) {
		const withMalId = results.filter((item) => item.id);
		if (!withMalId.length) return null;

		if (year && seas === 1) {
			const match = withMalId.find((item) => String(item.year) === String(year));
			if (match) return match.id;
		}

		if (seas > 1) {
			const lastTwo = seas % 100;
			const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[seas % 10] || "th");
			const keywords = [`Season ${seas}`, `${seas}${suffix} Season`, `Season${seas}`].map((word) => word.toLowerCase());
			const match = withMalId.find((item) => item.titles.some((title) =>
				typeof title === "string" && keywords.some((word) => title.toLowerCase().includes(word))
			));
			if (match) return match.id;
		}

		return withMalId[0].id;
	}

	async function searchMalIdAniList(title, seas, year) {
		const query = seas > 1 ? title + " Season " + seas : title;
		const json = await requestJson(ANILIST_API, {
			query: `query ($search: String) {
				Page(page: 1, perPage: 10) {
					media(search: $search, type: ANIME) {
						idMal
						title { romaji english native }
						seasonYear
						synonyms
					}
				}
			}`,
			variables: { search: query }
		});
		const results = json && json.data && json.data.Page && json.data.Page.media;
		if (!Array.isArray(results)) return null;

		return findMalId(results.filter(Boolean).map((item) => ({
			id: item.idMal,
			year: item.seasonYear,
			titles: [item.title && item.title.romaji, item.title && item.title.english].concat(item.synonyms || [])
		})), seas, year);
	}

	async function searchMalIdJikan(title, seas, year) {
		const query = seas > 1 ? title + " Season " + seas : title;
		const json = await requestJson(JIKAN_API + "?q=" + encodeURIComponent(query) + "&limit=10");
		if (!json || !Array.isArray(json.data)) return null;

		return findMalId(json.data.filter(Boolean).map((item) => ({
			id: item.mal_id,
			year: item.year || (item.aired && item.aired.from && String(item.aired.from).slice(0, 4)),
			titles: [item.title, item.title_english].concat(item.title_synonyms || [])
		})), seas, year);
	}

	async function searchMalId(title, seas, year, isCurrent) {
		const malId = await searchMalIdAniList(title, seas, year);
		if (malId || !isCurrent()) return malId;
		return searchMalIdJikan(title, seas, year);
	}

	async function fetchAniSkipSegments(malId, episode) {
		const types = SKIP_TYPES.map((type) => "types=" + type);
		types.push("episodeLength=0");
		const data = await requestJson(ANISKIP_API + "/" + malId + "/" + episode + "?" + types.join("&"));
		return data && data.found && Array.isArray(data.results) ? data.results : [];
	}

	function parseAniSkipSegments(rawSegments) {
		if (!rawSegments || !rawSegments.length) return [];
		const list = [];
		rawSegments.forEach((s) => {
			if (!s || !s.interval) return;
			const type = String(s.skipType || s.skip_type || "").toLowerCase();
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
		return normalizeSegments(list);
	}

	async function searchAndApply(videoParams, card, playlist, isCurrent) {
		if (!card || !isCurrent()) return;

		const title = String(videoParams.title || card.title || card.name || "").toLowerCase();
		if (["трейлер", "trailer", "тизер", "teaser"].some((word) => title.includes(word))) return;

		const cardId = getCardId(card);
		const currentOffset = getOffset(cardId);
		[videoParams].concat(playlist).forEach((item) => {
			const segments = item && item.segments && segmentSources.get(item.segments.skip);
			if (segments) setSegments(item, segments, currentOffset);
		});
		if (hasExistingSegments(videoParams)) return;

		const index = playlist.findIndex((item) => item && (item === videoParams || (item.url && item.url === videoParams.url)));
		const fallback = index < 0 ? { season: 1, episode: 1 } : getPosition(playlist[index], 1, index + 1);
		const position = getPosition(videoParams, fallback.season, fallback.episode);
		const isSerial = card.number_of_seasons > 0 || (card.original_name && !card.original_title);
		const season = isSerial ? position.season : 1;
		const episode = isSerial ? position.episode : 1;
		const kpId = card.kinopoisk_id || (card.source === "kinopoisk" ? card.id : null) || card.kp_id;
		let finalSegments = [];
		let dbData = null;

		if (isAnimeContent(card)) {
			const searchTerm = String(card.original_name || card.original_title || card.name || "")
				.replace(/\(\d{4}\)/g, "")
				.replace(/\(TV\)/gi, "")
				.replace(/Season \d+/gi, "")
				.replace(/Part \d+/gi, "")
				.replace(/[:\-]/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			const releaseYear = String(card.release_date || card.first_air_date || "0000").slice(0, 4);

			if (searchTerm) {
				const malId = await searchMalId(searchTerm, season, releaseYear, isCurrent);
				if (!isCurrent()) return;
				if (malId) finalSegments = parseAniSkipSegments(await fetchAniSkipSegments(malId, episode));
			}
		}

		if (!isCurrent()) return;
		if (!finalSegments.length && kpId) {
			dbData = await requestJson(GITHUB_DB_URL + encodeURIComponent(kpId) + ".json");
			finalSegments = getSegmentsFromDb(dbData, season, episode);
		}
		if (!isCurrent()) return;

		const offset = getOffset(cardId);
		playlist.forEach((item, index) => {
			if (!item) return;
			const position = getPosition(item, season, index + 1);
			const segments = position.season === season && position.episode === episode && finalSegments.length
				? finalSegments : getSegmentsFromDb(dbData, position.season, position.episode);
			if (segments.length) setSegments(item, segments, offset);
		});

		if (finalSegments.length && setSegments(videoParams, finalSegments, offset)) {
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

		Lampa.Select.listener.follow("preshow", function (event) {
			var active = Lampa.Activity.active();

			var componentName = active && typeof active.component === "string" ? active.component.toLowerCase() : "";
			if (componentName !== "lamponline" && componentName !== "lampacskaz") {
				return;
			}

			var menu = event.active;

			if (!menu || !Array.isArray(menu.items) || menu.title !== Lampa.Lang.translate("title_filter")) {
				return;
			}

			var card = active.movie || active.card;
			var cardId = getCardId(card);

			if (!cardId) {
				return;
			}

			var currentOffset = getOffset(cardId);

			var offsetItem = menu.items.find(function (item) {
				return item.stype === "ultimate_skip_offset";
			});

			if (!offsetItem) {
				offsetItem = {
					title: Lampa.Lang.translate("ultimate_skip_offset"),
					stype: "ultimate_skip_offset"
				};
				menu.items.push(offsetItem);
			}

			offsetItem.subtitle = formatOffset(currentOffset);
			offsetItem.onSelect = function () {
				menu.items.forEach(function (item) {
					item.selected = item === offsetItem;
				});

				function returnToFilter() {
					Lampa.Select.show(menu);
				}

				var values = [-30, -20, -15, -10, -5, -3, -2, -1, 0, 1, 2, 3, 5, 10, 15, 20, 30];

				var items = values.map(function (val) {
					return {
						title: formatOffset(val),
						value: val,
						selected: val === currentOffset
					};
				});

				Lampa.Select.show({
					title: Lampa.Lang.translate("ultimate_skip_offset"),
					items: items,
					onBack: returnToFilter,
					onSelect: function (item) {
						setOffset(cardId, item.value);
						Lampa.Noty.show(Lampa.Lang.translate("ultimate_skip_offset") + ": " + formatOffset(item.value));
						returnToFilter();
					}
				});
			};
		});
	}

	function formatOffset(value) {
		return (value > 0 ? "+" + value : String(value)) + " " + Lampa.Lang.translate("ultimate_skip_offset_sec");
	}

	function init() {
		if (window.lampa_ultimate_skip) return;
		window.lampa_ultimate_skip = true;

		initOffsetFilterMenu();

		let generation = 0;
		let resuming = null;

		Lampa.Player.listener.follow("destroy", function () {
			generation++;
		});

		Lampa.Player.listener.follow("create", function (event) {
			const videoParams = event.data;
			if (videoParams === resuming) return;
			const token = ++generation;
			const active = Lampa.Activity.active();
			const card = videoParams.movie || videoParams.card || (active && (active.movie || active.card));
			if (!card) return;
			const isCurrent = () => token === generation && Lampa.Activity.active() === active;

			event.abort();

			Promise.resolve().then(() => {
				const playlist = Array.isArray(videoParams.playlist) && videoParams.playlist.length
					? videoParams.playlist : Lampa.PlayerPlaylist.get();
				return searchAndApply(videoParams, card, Array.isArray(playlist) ? playlist : [], isCurrent);
			}).catch((error) => {
				console.error("UltimateSkip", error);
			}).then(() => {
				if (!isCurrent()) return;
				resuming = videoParams;
				try {
					Lampa.Player.play(videoParams);
				} finally {
					resuming = null;
				}
			}).catch((error) => {
				console.error("UltimateSkip", error);
			});
		});
	}

	if (window.appready) {
		init();
	} else {
		Lampa.Listener.follow("app", function onReady(event) {
			if (event.type !== "ready") return;
			Lampa.Listener.remove("app", onReady);
			init();
		});
	}
})();
