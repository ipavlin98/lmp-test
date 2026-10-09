(function () {
	"use strict";

	var config = {
		defaultApiKey: "cf4d8e72-0ef2-47b7-a5fd-08e7ad3a2939",
		apiUrl: "https://kinopoiskapiunofficial.tech/api/v2.2/films",
		keywordUrl: "https://kinopoiskapiunofficial.tech/api/v2.1/films/search-by-keyword",
		xmlUrl: "https://rating.kinopoisk.ru/",
		apiKeyName: "rating_api_key",
		cacheName: "rating_cache_v2",
		backoffName: "rating_api_backoff_v2",
		lookupVersion: 2,
		cacheLimit: 1000,
		day: 86400000,
		retryDelay: 60000,
		flushDelay: 1500,
		focusDelay: 900,
		maxRunning: 3,
		maxRunningApi: 2,
		apiInterval: 350,
		apiTimeout: 8000,
		apiWatchdog: 9000,
		requestTimeout: 5000,
		requestWatchdog: 6500,
		backoffBase: 15000,
		backoffMax: 300000,
		keyBlock: 21600000,
		cubMinVotes: 20
	};

	var messages = {
		loading: "Загрузка рейтинга",
		none: "Оценки пока нет",
		error: "Рейтинг временно недоступен",
		cub: "Для оценки нужно минимум 20 реакций"
	};

	var cubReactions = ["shit", "bore", "think", "nice", "fire"];
	var cubWeights = { fire: 10, nice: 7.5, think: 5, bore: 2.5, shit: 0 };
	var cubPrior = {
		tv: { mean: 7.436, confidence: 69 },
		movie: { mean: 6.584, confidence: 274 }
	};
	var rateAnchors = ".rate--imdb, .rate--kp, .rate--tmdb, .full-start__rate, .full-start-new__rate";

	var state = { demandKey: "", focusCard: null, current: null };
	var pendingRatings = Object.create(null);
	var pendingCub = Object.create(null);
	var idleRetry = Object.create(null);
	var fingerprints = Object.create(null);
	var focusTimer = null;
	var drawFrame = null;
	var preloadedReactions = null;
	var started = false;

	var nextFrame = window.requestAnimationFrame ?
		function (callback) { return window.requestAnimationFrame(callback); } :
		function (callback) { return setTimeout(callback, 16); };

	var cancelFrame = window.cancelAnimationFrame ?
		function (id) { window.cancelAnimationFrame(id); } :
		function (id) { clearTimeout(id); };

	function whenIdle(callback) {
		if (window.requestIdleCallback) window.requestIdleCallback(callback, { timeout: 1000 });
		else callback();
	}

	function isRecord(value) {
		return !!value && typeof value === "object" && !Array.isArray(value);
	}

	function hasOwn(object, name) {
		return Object.prototype.hasOwnProperty.call(object, name);
	}

	function readObject(name) {
		try {
			var value = Lampa.Storage.get(name, "{}");
			if (typeof value === "string") value = JSON.parse(value);
			return isRecord(value) ? value : {};
		} catch (e) {
			return {};
		}
	}

	function storeObject(name, value) {
		try {
			Lampa.Storage.set(name, value);
			return true;
		} catch (e) {
			return false;
		}
	}

	function positiveId(value) {
		return /^[1-9]\d*$/.test(String(value || "")) ? String(value) : "";
	}

	function ratingValue(value) {
		if (typeof value !== "number" && typeof value !== "string") return 0;
		var number = parseFloat(String(value).replace(",", "."));
		return isFinite(number) && number > 0 && number <= 10 ? number : 0;
	}

	function formatRating(value) {
		return value.toFixed(1).replace("10.0", "10");
	}

	function imdbIdOf(data) {
		var id = data.imdb_id || (data.external_ids && data.external_ids.imdb_id);
		return typeof id === "string" ? id : "";
	}

	function apiKey() {
		var key = Lampa.Storage.get(config.apiKeyName, "");
		return typeof key === "string" && key.trim() ? key.trim() : config.defaultApiKey;
	}

	function keyFingerprint(key) {
		if (!fingerprints[key]) {
			var hash = 2166136261;
			for (var i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
			fingerprints[key] = String(hash >>> 0);
		}
		return fingerprints[key];
	}

	function describeCard(data, object, complete) {
		if (!isRecord(data)) return null;
		object = object || {};
		var id = positiveId(data.id || data.card_id || object.id);
		if (!id) return null;
		var source = String(object.source || data.source || "tmdb").toLowerCase();
		if (source === "cub") source = "tmdb";
		if (!/^[a-z0-9_-]+$/.test(source)) return null;
		var method = object.method || data.media_type || data.card_type || data.method;
		if (method === "person" || source === "person") return null;
		if (method !== "tv" && method !== "movie") {
			method = data.first_air_date || data.original_name || data.name ? "tv" : "movie";
		}
		var kpId = positiveId(data.kp_id || data.kinopoisk_id || data.kinopoiskId || data.kpId);
		if (!kpId && (source === "kinopoisk" || source === "kp")) kpId = id;
		return {
			id: id,
			source: source,
			method: method,
			key: source + ":" + method + ":" + id,
			kpId: kpId,
			complete: !!complete,
			data: data
		};
	}

	function setDemand(key) {
		if (state.demandKey !== key) state.current = null;
		state.demandKey = key;
	}

	function clearDemand() {
		state.demandKey = "";
		state.current = null;
	}

	function isFocused(key) {
		return !!state.focusCard && state.focusCard.key === key;
	}

	function isKeyActive(key) {
		return !!pendingRatings[key] || !!pendingCub[key] || state.demandKey === key || isFocused(key);
	}

	function stillWanted(card, paid) {
		return state.demandKey === card.key || (!paid && !document.hidden && isFocused(card.key));
	}

	var cacheStore = (function () {
		var entries = {};
		var dirty = false;
		var timer = null;

		function cleanEntry(entry) {
			if (!isRecord(entry)) return null;
			if (entry.ratings !== undefined && !isRecord(entry.ratings)) delete entry.ratings;
			if (entry.cub !== undefined && !isRecord(entry.cub)) delete entry.cub;
			return entry;
		}

		function mergeEntry(key, incoming) {
			var local = entries[key];
			if (!local) {
				entries[key] = incoming;
				return;
			}
			["ratings", "cub"].forEach(function (part) {
				if (incoming[part] && (!local[part] || (incoming[part].at || 0) > (local[part].at || 0))) {
					local[part] = incoming[part];
				}
			});
			if (!local.kpId && incoming.kpId) local.kpId = incoming.kpId;
			local.used = Math.max(local.used || 0, incoming.used || 0);
		}

		function mergeExternal(json) {
			var remote;
			try {
				remote = JSON.parse(json);
			} catch (e) {
				return;
			}
			if (!isRecord(remote)) return;
			Object.keys(remote).forEach(function (key) {
				var incoming = cleanEntry(remote[key]);
				if (!incoming) return;
				mergeEntry(key, incoming);
				notify(key);
			});
		}

		function load() {
			var saved = readObject(config.cacheName);
			entries = {};
			Object.keys(saved).forEach(function (key) {
				var entry = cleanEntry(saved[key]);
				if (entry) entries[key] = entry;
			});
			window.addEventListener("storage", function (event) {
				if (event.key === config.cacheName) mergeExternal(event.newValue);
			});
		}

		function peek(key) {
			return entries[key] || null;
		}

		function ensure(key) {
			return entries[key] || (entries[key] = { used: Date.now() });
		}

		function markDirty() {
			dirty = true;
			if (timer) return;
			timer = setTimeout(function () {
				timer = null;
				whenIdle(flush);
			}, config.flushDelay);
		}

		function touch(key) {
			var entry = entries[key];
			if (!entry || Date.now() - (entry.used || 0) <= config.retryDelay) return;
			entry.used = Date.now();
			markDirty();
		}

		function prune(limit) {
			var keys = Object.keys(entries);
			if (keys.length <= limit) return;
			keys.sort(function (a, b) {
				return (entries[b].used || 0) - (entries[a].used || 0);
			});
			keys.slice(Math.floor(limit * 0.9)).forEach(function (key) {
				if (!isKeyActive(key)) delete entries[key];
			});
		}

		function flush() {
			clearTimeout(timer);
			timer = null;
			if (!dirty) return;
			dirty = false;
			prune(config.cacheLimit);
			if (storeObject(config.cacheName, entries)) return;
			prune(config.cacheLimit / 2);
			storeObject(config.cacheName, entries);
		}

		return { load: load, peek: peek, ensure: ensure, touch: touch, markDirty: markDirty, flush: flush };
	})();

	var apiBackoff = (function () {
		var blocks = null;

		function active(fingerprint) {
			if (!blocks) blocks = readObject(config.backoffName);
			var block = blocks[fingerprint];
			return block && block.until > Date.now() ? block : null;
		}

		function retryAfter(error) {
			try {
				var value = error.getResponseHeader && error.getResponseHeader("Retry-After");
				if (!value) return 0;
				var time = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
				return isFinite(time) ? time - Date.now() : 0;
			} catch (e) {
				return 0;
			}
		}

		function record(fingerprint, error) {
			var status = error.status;
			if (status !== 401 && status !== 402 && status !== 403 && status !== 429) return;
			blocks = readObject(config.backoffName);
			var previous = blocks[fingerprint] || {};
			var delay = status === 429 ?
				Math.min((previous.delay || config.backoffBase) * 2, config.backoffMax) : config.keyBlock;
			delay = Math.max(delay, retryAfter(error));
			blocks[fingerprint] = { until: Date.now() + delay, delay: delay, status: status };
			storeObject(config.backoffName, blocks);
			error.blockedUntil = blocks[fingerprint].until;
		}

		return { active: active, record: record };
	})();

	var http = (function () {
		var tasks = Object.create(null);
		var queue = [];
		var running = 0;
		var runningApi = 0;
		var nextApiAt = 0;
		var timer = null;
		var pumping = false;
		var repeat = false;

		function request(url, kind, card, callback) {
			var key = kind === "api" ? apiKey() : "";
			var fingerprint = keyFingerprint(key);
			var id = kind + ":" + fingerprint + ":" + url;
			var task = tasks[id];
			if (task) {
				task.callbacks.push(callback);
				task.card = card;
				return;
			}
			task = tasks[id] = {
				id: id, url: url, kind: kind, card: card, key: key,
				fingerprint: fingerprint, callbacks: [callback], cancel: null
			};
			queue.push(task);
			pump();
		}

		function finish(task, error, data) {
			delete tasks[task.id];
			task.callbacks.forEach(function (callback) {
				try {
					callback(error, data);
				} catch (e) {
					if (window.console) console.warn("Рейтинги: не удалось обработать ответ", e);
				}
			});
		}

		function apiError(task, original) {
			var error = {
				status: Number(original.status) || 0,
				apiFingerprint: task.fingerprint,
				getResponseHeader: function (name) {
					return original.getResponseHeader ? original.getResponseHeader(name) : null;
				}
			};
			apiBackoff.record(task.fingerprint, error);
			return error;
		}

		function requestParams(task) {
			if (task.kind === "api") return { headers: { "X-API-KEY": task.key } };
			if (task.kind === "xml") return { dataType: "text" };
			return {};
		}

		function send(task) {
			var isApi = task.kind === "api";
			var network = new Lampa.Reguest();
			var ended = false;
			var watchdog = null;

			function complete(error, data) {
				if (ended) return;
				ended = true;
				clearTimeout(watchdog);
				running--;
				if (isApi) {
					runningApi--;
					if (error && !error.cancelled) error = apiError(task, error);
				}
				finish(task, error, data);
				pump();
			}

			running++;
			if (isApi) {
				runningApi++;
				nextApiAt = Date.now() + config.apiInterval;
			}
			watchdog = setTimeout(function () {
				complete({ status: 0 });
				network.clear();
			}, isApi ? config.apiWatchdog : config.requestWatchdog);
			task.cancel = function () {
				complete({ cancelled: true });
				network.clear();
			};
			network.timeout(isApi ? config.apiTimeout : config.requestTimeout);
			try {
				network[task.kind === "xml" ? "native" : "silent"](
					task.url,
					function (data) { complete(null, data); },
					function (error) { complete(error || { status: 0 }); },
					false,
					requestParams(task)
				);
			} catch (e) {
				complete({ status: 0 });
			}
		}

		function cancelUnwanted() {
			Object.keys(tasks).forEach(function (id) {
				var task = tasks[id];
				if (task && task.kind !== "api" && task.cancel && !stillWanted(task.card, false)) task.cancel();
			});
		}

		function prioritize() {
			var demanded = [];
			var rest = [];
			queue.forEach(function (task) {
				(task.card.key === state.demandKey ? demanded : rest).push(task);
			});
			queue = demanded.concat(rest);
		}

		function dispatch() {
			cancelUnwanted();
			prioritize();
			for (var i = 0; i < queue.length;) {
				var task = queue[i];
				var isApi = task.kind === "api";
				if (!stillWanted(task.card, isApi)) {
					queue.splice(i, 1);
					finish(task, { cancelled: true });
					continue;
				}
				var block = isApi ? apiBackoff.active(task.fingerprint) : null;
				if (block) {
					queue.splice(i, 1);
					finish(task, { status: block.status, blockedUntil: block.until, apiFingerprint: task.fingerprint });
					continue;
				}
				if (running >= config.maxRunning) break;
				if (isApi && (runningApi >= config.maxRunningApi || nextApiAt > Date.now())) {
					i++;
					continue;
				}
				queue.splice(i, 1);
				send(task);
			}
			if (queue.length && running < config.maxRunning && runningApi < config.maxRunningApi) {
				timer = setTimeout(pump, Math.max(20, nextApiAt - Date.now()));
			}
		}

		function pump() {
			if (pumping) {
				repeat = true;
				return;
			}
			pumping = true;
			try {
				do {
					repeat = false;
					clearTimeout(timer);
					timer = null;
					dispatch();
				} while (repeat);
			} finally {
				pumping = false;
			}
		}

		return { request: request, pump: pump };
	})();

	function commit(card) {
		cacheStore.ensure(card.key).used = Date.now();
		cacheStore.markDirty();
		notify(card.key);
	}

	function readyRatings(kp, imdb) {
		return {
			kp: kp, imdb: imdb, at: Date.now(), state: "ready",
			retryAt: 0, lookupVersion: config.lookupVersion
		};
	}

	function seedRatings(entry, kp, imdb) {
		var previous = entry.ratings;
		var complete = kp && imdb;
		var differs = !previous || (kp && kp !== previous.kp) || (imdb && imdb !== previous.imdb);
		var refresh = complete && previous && (previous.state !== "ready" ||
			previous.lookupVersion !== config.lookupVersion || Date.now() - previous.at > config.day / 2);
		if (!differs && !refresh) return false;
		if (complete) {
			entry.ratings = readyRatings(kp, imdb);
			return true;
		}
		previous = previous || {};
		entry.ratings = {
			kp: kp || previous.kp || 0,
			imdb: imdb || previous.imdb || 0,
			at: previous.at || 0,
			state: previous.state || "partial",
			lookupVersion: previous.lookupVersion || 0,
			retryAt: previous.retryAt || 0,
			failedKey: previous.failedKey
		};
		return true;
	}

	function seedCard(card) {
		var data = card.data;
		var kp = ratingValue(data.kp_rating || data.ratingKinopoisk);
		var imdb = ratingValue(data.imdb_rating || data.ratingImdb);
		if (!card.kpId && !kp && !imdb) return;
		var entry = cacheStore.ensure(card.key);
		var updated = false;
		if (card.kpId && entry.kpId !== card.kpId) {
			if (entry.kpId) delete entry.ratings;
			entry.kpId = card.kpId;
			updated = true;
		}
		if ((kp || imdb) && seedRatings(entry, kp, imdb)) updated = true;
		if (updated) commit(card);
	}

	function putRatings(card, kp, imdb) {
		var entry = cacheStore.ensure(card.key);
		var previous = entry.ratings || {};
		entry.ratings = readyRatings(
			ratingValue(kp) || ratingValue(previous.kp),
			ratingValue(imdb) || ratingValue(previous.imdb)
		);
		commit(card);
	}

	function putPartialRatings(card, kp, imdb) {
		if (!ratingValue(kp) && !ratingValue(imdb)) return;
		var entry = cacheStore.ensure(card.key);
		var previous = entry.ratings || {};
		entry.ratings = {
			kp: ratingValue(kp) || ratingValue(previous.kp),
			imdb: ratingValue(imdb) || ratingValue(previous.imdb),
			at: previous.at || 0,
			state: "partial",
			retryAt: 0,
			lookupVersion: config.lookupVersion
		};
		commit(card);
	}

	function failRatings(card, missing, error) {
		var entry = cacheStore.ensure(card.key);
		var ratings = entry.ratings || { kp: 0, imdb: 0, at: 0 };
		ratings.state = missing ? "missing" : "error";
		ratings.retryAt = error && error.blockedUntil ? error.blockedUntil :
			Date.now() + (missing ? config.day : config.retryDelay);
		ratings.failedKey = error && error.apiFingerprint;
		ratings.lookupVersion = config.lookupVersion;
		entry.ratings = ratings;
		commit(card);
	}

	function needsRatings(card) {
		var entry = cacheStore.peek(card.key);
		var ratings = entry && entry.ratings;
		if (!ratings) return true;
		var now = Date.now();
		var outdated = ratings.lookupVersion !== config.lookupVersion;
		var incomplete = !ratingValue(ratings.kp) || !ratingValue(ratings.imdb);
		if (outdated && (ratings.state === "missing" || (ratings.state === "ready" && incomplete))) return true;
		if (ratings.retryAt > now && (!ratings.failedKey || ratings.failedKey === keyFingerprint(apiKey()))) return false;
		return ratings.state !== "ready" || now - ratings.at >= config.day;
	}

	function idleBlocked(key) {
		var until = idleRetry[key];
		if (until && until > Date.now()) return true;
		delete idleRetry[key];
		return false;
	}

	function normalizeTitle(value) {
		return typeof value === "string" ? value.toLowerCase().replace(/ё/g, "е")
			.replace(/[\s.,:;'"\u0060!?()\[\]\/\\+\-\u2010-\u2015]+/g, " ").trim() : "";
	}

	function scoreFilm(item, card, title, original, year) {
		var titles = [item.nameOriginal || item.orig_title, item.nameEn || item.en_title,
			item.nameRu || item.ru_title || item.title].map(normalizeTitle);
		var score = original && titles.indexOf(original) !== -1 ? 8 :
			title && titles.indexOf(title) !== -1 ? 6 : 0;
		if (!score) return 0;
		var itemYear = parseInt(item.year || item.start_date, 10);
		if (year && itemYear) score += year === itemYear ? 4 : Math.abs(year - itemYear) === 1 ? 1 : 0;
		var type = item.type;
		if (type && type !== "ALL") {
			var isTv = type === "TV_SERIES" || type === "MINI_SERIES" || type === "TV_SHOW";
			if ((card.method === "tv") === isTv) score += 2;
		}
		return score;
	}

	function selectFilm(items, card, trustedImdb) {
		var data = card.data;
		var imdbId = imdbIdOf(data);
		if (trustedImdb && items.length === 1 && isRecord(items[0])) {
			var returnedId = items[0].imdbId || items[0].imdb_id;
			if (!returnedId || returnedId === imdbId) return items[0];
		}
		var title = normalizeTitle(data.title || data.name);
		var original = normalizeTitle(data.original_title || data.original_name);
		var year = parseInt(String(data.release_date || data.first_air_date || "").slice(0, 4), 10);
		var candidates = [];
		items.forEach(function (item) {
			if (!isRecord(item)) return;
			var itemImdb = item.imdbId || item.imdb_id;
			if (imdbId && itemImdb && imdbId !== itemImdb) return;
			var score = imdbId && itemImdb === imdbId ? 100 : scoreFilm(item, card, title, original, year);
			if (score) candidates.push({ item: item, score: score });
		});
		candidates.sort(function (a, b) { return b.score - a.score; });
		return candidates.length && (!candidates[1] || candidates[0].score > candidates[1].score) ?
			candidates[0].item : null;
	}

	function keywordQuery(title) {
		if (!title) return "";
		var cleaned = String(title).replace(/[\s.,:;'\u0060!?]+/g, " ").trim()
			.replace(/^[ \/\\]+|[ \/\\]+$/g, "").replace(/( *[\/\\]+ *)+/g, " ");
		return config.keywordUrl + "?keyword=" + encodeURIComponent(cleaned);
	}

	function parseXmlRatings(text) {
		if (typeof text !== "string") return null;
		var kp = text.match(/<kp_rating\b[^>]*>([^<]*)<\/kp_rating>/i);
		var imdb = text.match(/<imdb_rating\b[^>]*>([^<]*)<\/imdb_rating>/i);
		if (!kp && !imdb) return null;
		return { kp: ratingValue(kp && kp[1]), imdb: ratingValue(imdb && imdb[1]) };
	}

	function RatingLookup(card, paid) {
		this.card = card;
		this.paid = paid;
	}

	RatingLookup.prototype.start = function (kpId) {
		if (kpId) return this.fromXml(kpId);
		var data = this.card.data;
		var title = data.title || data.name || data.original_title || data.original_name;
		var original = data.original_title || data.original_name;
		var imdbId = imdbIdOf(data);
		var keyword = keywordQuery(title);
		if (/^tt\d+$/.test(imdbId)) {
			this.search(config.apiUrl + "?imdbId=" + encodeURIComponent(imdbId), true, keyword);
		} else if (keyword) {
			this.search(keyword, false,
				original && normalizeTitle(original) !== normalizeTitle(title) ? keywordQuery(original) : "");
		} else this.finish({ status: 404 }, true);
	};

	RatingLookup.prototype.finish = function (error, missing) {
		delete pendingRatings[this.card.key];
		if (error && !error.cancelled) failRatings(this.card, missing, error);
		else notify(this.card.key);
	};

	RatingLookup.prototype.save = function (data) {
		if (!isRecord(data) || !hasOwn(data, "ratingKinopoisk") || !hasOwn(data, "ratingImdb")) {
			return this.finish({ status: 0 });
		}
		putRatings(this.card, data.ratingKinopoisk, data.ratingImdb);
		this.finish();
	};

	RatingLookup.prototype.fromApi = function (kpId) {
		var self = this;
		if (!self.paid || !stillWanted(self.card, true)) return self.finish({ cancelled: true });
		http.request(config.apiUrl + "/" + kpId, "api", self.card, function (error, data) {
			if (error) self.finish(error, error.status === 404);
			else self.save(data);
		});
	};

	RatingLookup.prototype.fromXml = function (kpId) {
		var self = this;
		http.request(config.xmlUrl + kpId + ".xml", "xml", self.card, function (error, text) {
			var parsed = error ? null : parseXmlRatings(text);
			if (parsed && parsed.kp && parsed.imdb) {
				putRatings(self.card, parsed.kp, parsed.imdb);
				return self.finish();
			}
			if (parsed) putPartialRatings(self.card, parsed.kp, parsed.imdb);
			if (error && error.cancelled) return self.finish(error);
			if (self.paid && stillWanted(self.card, true)) return self.fromApi(kpId);
			if (!self.paid) idleRetry[self.card.key] = Date.now() + (error ? config.retryDelay : config.day);
			self.finish({ cancelled: true });
		});
	};

	RatingLookup.prototype.search = function (url, trustedImdb, alternative) {
		var self = this;
		if (!stillWanted(self.card, true)) return self.finish({ cancelled: true });
		http.request(url, "api", self.card, function (error, data) {
			if (error && error.status !== 404) return self.finish(error);
			var items = data && (data.items || data.films);
			if (!error && !Array.isArray(items)) return self.finish({ status: 0 });
			var found = selectFilm(error ? [] : items, self.card, trustedImdb);
			if (!found) return alternative ? self.search(alternative, false, "") : self.finish({ status: 404 }, true);
			var kpId = positiveId(found.kinopoiskId || found.filmId || found.kp_id || found.kinopoisk_id);
			if (!kpId) return self.finish({ status: 0 });
			cacheStore.ensure(self.card.key).kpId = kpId;
			commit(self.card);
			if (ratingValue(found.ratingKinopoisk) && ratingValue(found.ratingImdb)) return self.save(found);
			putPartialRatings(self.card, found.ratingKinopoisk, found.ratingImdb);
			self.fromXml(kpId);
		});
	};

	function canSearch(card, paid) {
		var data = card.data;
		var imdbId = imdbIdOf(data);
		if (!paid) return false;
		if (!card.complete && !/^tt\d+$/.test(imdbId)) return false;
		return !!(data.title || data.name || data.original_title || data.original_name || imdbId);
	}

	function fetchRatings(card, paid) {
		seedCard(card);
		if (!needsRatings(card)) return;
		var pending = pendingRatings[card.key];
		if (pending) {
			if (paid) {
				pending.paid = true;
				pending.card = card;
			}
			return;
		}
		var entry = cacheStore.peek(card.key);
		var kpId = entry && entry.kpId;
		if (!kpId && !canSearch(card, paid)) return;
		if (!paid && idleBlocked(card.key)) return;
		var lookup = pendingRatings[card.key] = new RatingLookup(card, paid);
		notify(card.key);
		lookup.start(kpId);
	}

	function cubBase() {
		var domain = Lampa.Manifest && Lampa.Manifest.cub_domain;
		if (typeof domain !== "string" || !domain) return "";
		return /^https?:\/\//.test(domain) ? domain.replace(/\/$/, "") :
			Lampa.Utils.protocol() + domain.replace(/\/$/, "");
	}

	function reactionUrl(base, reaction) {
		return base + "/img/reactions/" + reaction + ".svg";
	}

	function preloadReactions() {
		if (preloadedReactions) return;
		var base = cubBase();
		if (!base) return;
		preloadedReactions = cubReactions.map(function (reaction) {
			var image = new Image();
			image.src = reactionUrl(base, reaction);
			return image;
		});
	}

	function putCub(card, items) {
		cacheStore.ensure(card.key).cub = { items: items, at: Date.now(), retryAt: 0 };
		commit(card);
	}

	function delayCub(card) {
		var entry = cacheStore.ensure(card.key);
		var cub = entry.cub || { items: [], at: 0 };
		cub.retryAt = Date.now() + config.retryDelay;
		entry.cub = cub;
		commit(card);
	}

	function isReactionsResponse(data) {
		return !!data && typeof data === "object" && hasOwn(data, "result") &&
			(data.result === null || Array.isArray(data.result));
	}

	function fetchCub(card) {
		if (card.source !== "tmdb" || pendingCub[card.key]) return;
		var entry = cacheStore.peek(card.key);
		var cached = entry && entry.cub;
		var requestedAt = Date.now();
		if (cached && (cached.retryAt > requestedAt || requestedAt - cached.at < config.day / 2)) return;
		var base = cubBase();
		if (!base) return;
		pendingCub[card.key] = true;
		notify(card.key);
		http.request(base + "/api/reactions/get/" + card.method + "_" + card.id, "cub", card, function (error, data) {
			delete pendingCub[card.key];
			var latest = cacheStore.peek(card.key);
			if (latest && latest.cub && latest.cub.at > requestedAt) return notify(card.key);
			if (!error && isReactionsResponse(data)) putCub(card, data.result || []);
			else if (!error || !error.cancelled) delayCub(card);
			else notify(card.key);
		});
	}

	function medianReaction(counts, count) {
		var cumulative = 0;
		for (var i = 0; i < cubReactions.length; i++) {
			cumulative += counts[cubReactions[i]] || 0;
			if (cumulative >= (count + 1) / 2) return cubReactions[i];
		}
		return "";
	}

	function cubRating(card, entry) {
		var cub = entry && entry.cub;
		if (!cub || !Array.isArray(cub.items)) return null;
		var counts = {};
		var sum = 0;
		var count = 0;
		cub.items.forEach(function (reaction) {
			if (!reaction || !hasOwn(cubWeights, reaction.type)) return;
			var amount = Number(reaction.counter);
			if (!isFinite(amount) || amount <= 0) return;
			amount = Math.floor(amount);
			counts[reaction.type] = (counts[reaction.type] || 0) + amount;
			sum += amount * cubWeights[reaction.type];
			count += amount;
		});
		if (count < config.cubMinVotes) return null;
		var prior = card.method === "tv" ? cubPrior.tv : cubPrior.movie;
		return {
			value: (prior.mean * prior.confidence + sum) / (prior.confidence + count),
			reaction: medianReaction(counts, count)
		};
	}

	function setClass(element, name, enabled) {
		if (element.hasClass(name) === enabled) return false;
		element.toggleClass(name, enabled);
		return true;
	}

	function setAttr(element, name, value) {
		if (element.attr(name) === value) return false;
		element.attr(name, value);
		return true;
	}

	function createBlock(render, name, label) {
		var anchors = render.find(rateAnchors);
		var anchor = name === "tmdb" ? anchors.first() : anchors.last();
		if (!anchor.length) return anchor;
		var block = $('<div class="full-start__rate rate--' + name + '"><div></div>' +
			(name === "cub" ? '<div class="rating-plugin-reaction"></div><div class="rating-plugin-cub-label"></div>' : '<div></div>') +
			'</div>');
		if (name !== "cub") block.children("div").last().text(label);
		if (name === "tmdb") anchor.before(block);
		else anchor.after(block);
		return block;
	}

	function cubBlockReady(block) {
		var children = block.children("div");
		var icon = children.eq(1);
		var caption = children.eq(2);
		return children.length === 3 && block.children(".rating-plugin-reaction")[0] === icon[0] &&
			!icon.hasClass("rating-plugin-label") && caption.hasClass("rating-plugin-label") &&
			caption.hasClass("rating-plugin-cub-label") && caption.text() === "CUB" &&
			!caption[0].style.paddingLeft && block.attr("aria-label") === "Рейтинг CUB";
	}

	function prepareCubBlock(block) {
		if (cubBlockReady(block)) return;
		var icon = block.children(".rating-plugin-reaction").first();
		if (!icon.length) icon = block.children("div").eq(1);
		if (!icon.is("div")) {
			var replacement = $('<div class="rating-plugin-reaction"></div>');
			if (icon.length) {
				replacement.append(icon.contents());
				var reaction = icon.attr("data-reaction");
				if (reaction !== undefined) replacement.attr("data-reaction", reaction);
				icon.remove();
			}
			icon = replacement.appendTo(block);
		}
		icon.removeClass("rating-plugin-label").addClass("rating-plugin-reaction");
		var caption = block.children("div").eq(2);
		if (!caption.length) caption = $("<div>").appendTo(block);
		if (caption.text() !== "CUB") caption.text("CUB");
		caption.addClass("rating-plugin-label rating-plugin-cub-label").css("padding-left", "");
		block.children("div").slice(3).remove();
		block.attr("aria-label", "Рейтинг CUB");
	}

	function ensureBlock(render, name, label) {
		var block = render.find(".rate--" + name).first();
		if (!block.length) block = createBlock(render, name, label);
		if (!block.length) return block;
		setClass(block, "rating-plugin-rate", true);
		setClass(block, "hide", false);
		setClass(block.children("div").first(), "rating-plugin-value", true);
		if (name === "cub") prepareCubBlock(block);
		else setClass(block.children("div").last(), "rating-plugin-label", true);
		return block;
	}

	function setCubLabelHidden(block, hidden) {
		var caption = block.children(".rating-plugin-cub-label");
		if (caption.length) setAttr(caption, "aria-hidden", hidden ? "true" : "false");
	}

	function showValue(block, value, loading, unavailable) {
		if (!block.length) return;
		var number = block.children("div").first();
		var hasPlaceholder = number.children(".rating-plugin-placeholder").length > 0;
		var pending = !value && loading;
		var changed = false;
		var text;
		if (value) {
			text = formatRating(value);
			if (hasPlaceholder || number.text() !== text) {
				number.text(text);
				changed = true;
			}
		} else if (!hasPlaceholder) {
			number.empty().append($('<span class="rating-plugin-placeholder"></span>').text("—"));
			changed = true;
		}
		changed = setClass(block, "rating-plugin-pending", pending) || changed;
		changed = setClass(block, "rating-plugin-empty", !value) || changed;
		changed = setAttr(block, "aria-busy", pending ? "true" : "false") || changed;
		changed = setAttr(block, "title", value ? "" : loading ? messages.loading : unavailable) || changed;
		setCubLabelHidden(block, !!value && block.hasClass("rating-plugin-cub-image-ready"));
		if (changed) Lampa.Listener.send("rating:updated", { render: block });
	}

	function revealReaction(block, icon, image, reaction) {
		if (image[0].naturalWidth > 0 && icon.attr("data-reaction") === reaction && $.contains(icon[0], image[0])) {
			icon.addClass("rating-plugin-reaction-loaded");
			block.addClass("rating-plugin-cub-image-ready");
			setCubLabelHidden(block, true);
		}
	}

	function showReaction(block, reaction) {
		var icon = block.children(".rating-plugin-reaction").first();
		if (!icon.length) return;
		if (!reaction) {
			if (icon.children().length) icon.empty();
			setAttr(icon, "data-reaction", "");
			icon.removeClass("rating-plugin-reaction-loaded rating-plugin-reaction-managed");
			setClass(block, "rating-plugin-cub-image-ready", false);
			setCubLabelHidden(block, false);
			return;
		}
		if (icon.attr("data-reaction") === reaction && icon.hasClass("rating-plugin-reaction-managed")) return;
		icon.attr("data-reaction", reaction).removeClass("rating-plugin-reaction-loaded")
			.addClass("rating-plugin-reaction-managed").empty();
		block.removeClass("rating-plugin-cub-image-ready");
		setCubLabelHidden(block, false);
		var base = cubBase();
		if (!base) return;
		var image = $("<img>").attr("alt", "");
		image.on("load", function () {
			revealReaction(block, icon, image, reaction);
		}).attr("src", reactionUrl(base, reaction));
		icon.append(image);
		if (image[0].complete) revealReaction(block, icon, image, reaction);
	}

	function drawTmdb(render, card) {
		var block = ensureBlock(render, "tmdb", "TMDB");
		var value = card.data.vote_average;
		if (value === undefined) value = block.children("div").first().text();
		showValue(block, ratingValue(value), false, messages.none);
	}

	function drawCub(render, card, entry) {
		var cub = cubRating(card, entry);
		var block = ensureBlock(render, "cub", "");
		showValue(block, cub ? cub.value : 0, !!pendingCub[card.key], messages.cub);
		showReaction(block, cub ? cub.reaction : "");
	}

	function draw(view) {
		var card = view.card;
		var render = view.render;
		var entry = cacheStore.peek(card.key);
		var ratings = (entry && entry.ratings) || {};
		var loading = !!pendingRatings[card.key];
		var unavailable = ratings.state === "error" ? messages.error : messages.none;
		render.find(".wait_rating").remove();
		if (card.source === "tmdb") drawTmdb(render, card);
		showValue(ensureBlock(render, "kp", "КП"), ratingValue(ratings.kp), loading, unavailable);
		showValue(ensureBlock(render, "imdb", "IMDb"), ratingValue(ratings.imdb), loading, unavailable);
		if (card.source === "tmdb") drawCub(render, card, entry);
	}

	function drawNow() {
		if (drawFrame !== null) {
			cancelFrame(drawFrame);
			drawFrame = null;
		}
		if (state.current) draw(state.current);
	}

	function notify(key) {
		var current = state.current;
		if (!current || current.card.key !== key || state.demandKey !== key || drawFrame !== null) return;
		drawFrame = nextFrame(function () {
			drawFrame = null;
			if (state.current) draw(state.current);
		});
	}

	function openCard(card) {
		if (!card) return;
		clearTimeout(focusTimer);
		setDemand(card.key);
		seedCard(card);
		cacheStore.touch(card.key);
		fetchRatings(card, true);
		http.pump();
	}

	function bindCard(card, render, reactions) {
		if (!card || !render) return;
		render = $(render);
		if (!render.length) return;
		setDemand(card.key);
		state.current = { card: card, render: render };
		seedCard(card);
		if (card.source === "tmdb") {
			if (reactions && Array.isArray(reactions.result)) putCub(card, reactions.result);
			preloadReactions();
		}
		fetchRatings(card, true);
		fetchCub(card);
		drawNow();
	}

	function findCard(element) {
		var node = element && element.jquery ? element[0] : element;
		for (var steps = 0; node && steps < 15; steps++, node = node.parentNode) {
			var data = node.card_data || node.data;
			if (!isRecord(data)) data = $(node).data("data");
			var card = describeCard(data);
			if (card) return card;
		}
		return null;
	}

	function scheduleFocus(element) {
		var card = findCard(element);
		if (state.focusCard && card && state.focusCard.key === card.key) return;
		clearTimeout(focusTimer);
		state.focusCard = card;
		http.pump();
		if (!card || document.hidden) return;
		seedCard(card);
		focusTimer = setTimeout(function () {
			if (!stillWanted(card, false) || !document.documentElement.contains($(element)[0])) return;
			fetchRatings(card, false);
			fetchCub(card);
		}, config.focusDelay);
	}

	function focusSelectedCard() {
		var selected = $(".layer--visible .card.focus, .layer--visible .card-parser.focus").first();
		if (selected.length) scheduleFocus(selected);
	}

	function activeChanged() {
		clearTimeout(focusTimer);
		state.focusCard = null;
		var active = Lampa.Activity.active();
		if (active && active.component === "full") {
			var card = describeCard(active.card || active.movie || active, active, !!active.card);
			if (card) {
				if (active.activity && typeof active.activity.render === "function") bindCard(card, active.activity.render());
				else openCard(card);
			}
		} else clearDemand();
		http.pump();
		setTimeout(focusSelectedCard, 0);
	}

	function fullEvent(event) {
		if (event.type !== "start" && event.type !== "build" && event.type !== "complite") return;
		if (event.type === "build" && event.name !== "start") return;
		var data = event.data || {};
		if (event.link && event.object) event.link.ratingPluginObject = event.object;
		var object = event.object || (event.link && (event.link.ratingPluginObject || event.link.object));
		var active = Lampa.Activity.active();
		if (object && object.activity && active && active.activity && object.activity !== active.activity) return;
		var card = describeCard(data.movie, object, true);
		if (!card) return;
		if (event.type === "start") {
			seedCard(card);
			if (card.source === "tmdb" && data.reactions && Array.isArray(data.reactions.result)) putCub(card, data.reactions.result);
			openCard(card);
			return;
		}
		var render = event.item && typeof event.item.render === "function" ? event.item.render() : event.body;
		if (!render && event.object && event.object.activity) render = event.object.activity.render();
		bindCard(card, render, data.reactions);
	}

	function installNavigation() {
		["push", "replace"].forEach(function (name) {
			var original = Lampa.Activity[name];
			if (typeof original !== "function") return;
			Lampa.Activity[name] = function (object) {
				try {
					if (object && object.component === "full") openCard(describeCard(object.movie || object.card || object, object));
					else if (object && object.component) clearDemand();
				} catch (e) {}
				return original.apply(this, arguments);
			};
		});
	}

	function installStyles() {
		$("<style>").text([
			".rating-plugin-rate{-webkit-font-feature-settings:'tnum';font-feature-settings:'tnum';font-variant-numeric:tabular-nums}",
			".rating-plugin-rate>.rating-plugin-value{position:relative;width:3ch;min-width:3ch;-webkit-flex:0 0 3ch;flex:0 0 3ch;text-align:center;-webkit-transition:opacity .22s ease;transition:opacity .22s ease}",
			".rating-plugin-rate>.rating-plugin-label{-webkit-transition:opacity .22s ease;transition:opacity .22s ease}",
			".rating-plugin-empty>.rating-plugin-value,.rating-plugin-empty>.rating-plugin-label{opacity:.4}",
			".rating-plugin-placeholder{opacity:0}",
			".rating-plugin-empty>.rating-plugin-value:before{content:'';position:absolute;left:12%;right:12%;top:50%;height:1px;-webkit-transform:translateY(-50%);transform:translateY(-50%);background:currentColor}",
			".rating-plugin-value:after{content:'';position:absolute;left:25%;right:25%;bottom:-.18em;height:1px;background:currentColor;opacity:0;-webkit-transition:opacity .22s ease;transition:opacity .22s ease}",
			".rating-plugin-pending>.rating-plugin-value:after{-webkit-animation:rating-plugin-loading 1.8s ease-in-out infinite;animation:rating-plugin-loading 1.8s ease-in-out infinite}",
			".rate--cub.rating-plugin-rate>.rating-plugin-reaction{display:none;-webkit-justify-content:center;justify-content:center;-webkit-align-items:center;align-items:center;-webkit-flex:0 0 1.6em;flex:0 0 1.6em;width:1.6em;min-width:1.6em;padding:0;overflow:visible;-webkit-box-sizing:content-box;box-sizing:content-box}",
			".rate--cub.rating-plugin-rate>.rating-plugin-cub-label{display:block}",
			".rate--cub.rating-plugin-cub-image-ready>.rating-plugin-reaction{display:-webkit-flex;display:flex}",
			".rate--cub.rating-plugin-cub-image-ready>.rating-plugin-cub-label{display:none}",
			".rate--cub.rating-plugin-empty>.rating-plugin-reaction{display:none}",
			".rate--cub.rating-plugin-empty>.rating-plugin-cub-label{display:block}",
			".rate--cub.rating-plugin-rate>.rating-plugin-reaction>img{display:none;width:auto;height:.84em;max-width:none;max-height:none;margin:0 .2em;vertical-align:middle}",
			".rate--cub.rating-plugin-rate>.rating-plugin-reaction-loaded>img{display:inline-block}",
			"@-webkit-keyframes rating-plugin-loading{0%,100%{opacity:.2}50%{opacity:.65}}",
			"@keyframes rating-plugin-loading{0%,100%{opacity:.2}50%{opacity:.65}}",
			"@media(prefers-reduced-motion:reduce){.rating-plugin-pending>.rating-plugin-value:after{-webkit-animation:none;animation:none;opacity:.4}.rating-plugin-value,.rating-plugin-label{-webkit-transition:none!important;transition:none!important}}"
		].join("")).appendTo("head");
	}

	function installSettings() {
		if (!Lampa.SettingsApi || !Lampa.Input || typeof Lampa.SettingsApi.addComponent !== "function" ||
			typeof Lampa.SettingsApi.addParam !== "function") return;
		Lampa.SettingsApi.addComponent({
			component: "rating_plugin_settings",
			name: "Рейтинги",
			icon: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 3 L14.8 8.7 L21.1 9.6 L16.5 14.1 L17.6 20.4 L12 17.4 L6.4 20.4 L7.5 14.1 L2.9 9.6 L9.2 8.7 Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'
		});
		Lampa.SettingsApi.addParam({
			component: "rating_plugin_settings",
			param: { name: "rating_api_key_edit", type: "static" },
			field: {
				name: "Личный ключ Kinopoisk API",
				description: "Необязательно. У встроенного ключа общая квота для всех пользователей."
			},
			onRender: function (element) {
				element.on("hover:enter", function () {
					var controller = Lampa.Controller.enabled().name;
					Lampa.Input.edit({
						title: "Ключ API (пусто — встроенный)",
						value: Lampa.Storage.get(config.apiKeyName, ""),
						type: "password", nosave: true, free: true, nomic: true
					}, function (value) {
						if (typeof value === "string") {
							Lampa.Storage.set(config.apiKeyName, value.trim());
							Lampa.Noty.show(value.trim() ? "Личный ключ сохранён" : "Используется встроенный ключ");
						}
						Lampa.Controller.toggle(controller);
					});
				});
			}
		});
	}

	function installListeners() {
		Lampa.Listener.follow("full", fullEvent);
		Lampa.Listener.follow("activity", function (event) {
			if (event.type === "active" || event.type === "start") activeChanged();
		});
		Lampa.Listener.follow("target", function (event) {
			if (event.target) scheduleFocus(event.target);
		});
		$(document).on("hover:focus.ratingPlugin mouseenter.ratingPlugin focusin.ratingPlugin", ".card, .card-parser", function () {
			scheduleFocus(this);
		});
		$(document).on("mouseleave.ratingPlugin", ".card, .card-parser", function () {
			if (!$(this).hasClass("focus")) scheduleFocus(null);
		});
		document.addEventListener("visibilitychange", function () {
			if (document.hidden) {
				clearTimeout(focusTimer);
				state.focusCard = null;
				cacheStore.flush();
			} else activeChanged();
		});
		window.addEventListener("pagehide", cacheStore.flush);
		if (Lampa.Storage.listener) Lampa.Storage.listener.follow("change", function (event) {
			if (event.name === config.apiKeyName && state.current) fetchRatings(state.current.card, true);
		});
	}

	function startPlugin() {
		if (started || !window.Lampa || !Lampa.Storage || !Lampa.Listener || !document.body) return;
		if (window.rating_plugin_v2) return;
		started = true;
		window.rating_plugin_v2 = true;
		window.rating_plugin = true;
		window.cub_rating_plugin = true;
		cacheStore.load();
		installStyles();
		installNavigation();
		installSettings();
		installListeners();
		activeChanged();
	}

	function ready() {
		if (window.Lampa && Lampa.Listener) {
			if (window.appready) startPlugin();
			else Lampa.Listener.follow("app", function (event) {
				if (event.type === "ready") startPlugin();
			});
		} else setTimeout(ready, 100);
	}

	ready();
})();
