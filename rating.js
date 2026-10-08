(function () {
	"use strict";

	var defaultApiKey = "cf4d8e72-0ef2-47b7-a5fd-08e7ad3a2939";
	var apiUrl = "https://kinopoiskapiunofficial.tech/api/v2.2/films";
	var cacheName = "rating_cache_v2";
	var day = 86400000;
	var retryDelay = 60000;
	var cache = {};
	var dirty = {};
	var saveTimer = null;
	var focusTimer = null;
	var focusCard = null;
	var current = null;
	var demandKey = "";
	var pendingRatings = Object.create(null);
	var pendingCub = Object.create(null);
	var requests = Object.create(null);
	var queue = [];
	var running = 0;
	var runningApi = 0;
	var nextApiAt = 0;
	var queueTimer = null;
	var started = false;

	function readObject(name) {
		try {
			var value = Lampa.Storage.get(name, "{}");
			if (typeof value === "string") value = JSON.parse(value);
			return value && typeof value === "object" && !Array.isArray(value) ? value : {};
		} catch (e) {
			return {};
		}
	}

	function storeObject(name, value) {
		try {
			Lampa.Storage.set(name, value);
		} catch (e) {}
	}

	function positiveId(value) {
		return /^[1-9]\d*$/.test(String(value || "")) ? String(value) : "";
	}

	function ratingValue(value) {
		if (typeof value !== "number" && typeof value !== "string") return 0;
		var number = parseFloat(String(value).replace(",", "."));
		return isFinite(number) && number > 0 && number <= 10 ? number : 0;
	}

	function describeCard(data, object) {
		if (!data || typeof data !== "object") return null;
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
			data: data
		};
	}

	function getEntry(card) {
		var entry = cache[card.key];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			entry = cache[card.key] = { used: Date.now() };
		}
		["ratings", "cub"].forEach(function (part) {
			if (entry[part] && (typeof entry[part] !== "object" || Array.isArray(entry[part]))) delete entry[part];
		});
		return entry;
	}

	function changed(card) {
		getEntry(card).used = Date.now();
		dirty[card.key] = true;
		if (!saveTimer) saveTimer = setTimeout(flushCache, 150);
		notify(card.key);
	}

	function flushCache() {
		clearTimeout(saveTimer);
		saveTimer = null;
		var keys = Object.keys(dirty);
		if (!keys.length) return;
		var saved = readObject(cacheName);
		keys.forEach(function (key) {
			var local = cache[key];
			var remote = saved[key];
			if (remote && typeof remote === "object") {
				["ratings", "cub"].forEach(function (part) {
					if (remote[part] && (!local[part] || remote[part].at > local[part].at)) {
						local[part] = remote[part];
					}
				});
			}
			saved[key] = local;
		});
		Object.keys(saved).sort(function (a, b) {
			return ((saved[b] || {}).used || 0) - ((saved[a] || {}).used || 0);
		}).slice(1000).forEach(function (key) {
			delete saved[key];
		});
		Object.keys(cache).forEach(function (key) {
			if (!saved[key] && !pendingRatings[key] && !pendingCub[key] && key !== demandKey &&
				(!focusCard || focusCard.key !== key)) delete cache[key];
		});
		storeObject(cacheName, saved);
		dirty = {};
	}

	function seedCard(card) {
		var entry = getEntry(card);
		var updated = false;
		if (card.kpId && entry.kpId !== card.kpId) {
			if (entry.kpId) delete entry.ratings;
			entry.kpId = card.kpId;
			updated = true;
		}
		var kp = ratingValue(card.data.kp_rating || card.data.ratingKinopoisk);
		var imdb = ratingValue(card.data.imdb_rating || card.data.ratingImdb);
		var ratings = entry.ratings;
		if ((kp || imdb) && (!ratings || (kp && kp !== ratings.kp) || (imdb && imdb !== ratings.imdb) ||
			(kp && imdb && Date.now() - ratings.at > retryDelay))) {
			entry.ratings = {
				kp: kp || (ratings && ratings.kp) || 0,
				imdb: imdb || (ratings && ratings.imdb) || 0,
				at: kp && imdb ? Date.now() : (ratings && ratings.at) || 0,
				state: kp && imdb ? "ready" : (ratings && ratings.state) || "partial",
				retryAt: kp && imdb ? 0 : (ratings && ratings.retryAt) || 0
			};
			updated = true;
		}
		if (updated) changed(card);
	}

	function putRatings(card, kp, imdb) {
		getEntry(card).ratings = {
			kp: ratingValue(kp), imdb: ratingValue(imdb),
			at: Date.now(), state: "ready", retryAt: 0
		};
		changed(card);
	}

	function failRatings(card, missing, error) {
		var entry = getEntry(card);
		var ratings = entry.ratings || { kp: 0, imdb: 0, at: 0 };
		ratings.state = missing ? "missing" : "error";
		ratings.retryAt = Date.now() + (missing ? day : retryDelay);
		if (error && error.blockedUntil) ratings.retryAt = error.blockedUntil;
		ratings.failedKey = error && error.apiFingerprint;
		entry.ratings = ratings;
		changed(card);
	}

	function needsRatings(card) {
		var ratings = getEntry(card).ratings;
		if (!ratings) return true;
		if (ratings.retryAt > Date.now() &&
			(!ratings.failedKey || ratings.failedKey === keyFingerprint(apiKey()))) return false;
		return ratings.state !== "ready" || Date.now() - ratings.at >= day;
	}

	function apiKey() {
		var key = Lampa.Storage.get("rating_api_key", "");
		return typeof key === "string" && key.trim() ? key.trim() : defaultApiKey;
	}

	function keyFingerprint(key) {
		var hash = 2166136261;
		for (var i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
		return String(hash >>> 0);
	}

	function apiBlock(key) {
		return readObject("rating_api_backoff_v2")[keyFingerprint(key)] || {};
	}

	function recordApiError(key, error) {
		error.apiFingerprint = keyFingerprint(key);
		var status = Number(error.status) || 0;
		if (status !== 402 && status !== 429 && status !== 401 && status !== 403) return;
		var blocks = readObject("rating_api_backoff_v2");
		var fingerprint = keyFingerprint(key);
		var previous = blocks[fingerprint] || {};
		var delay = status === 429 ? Math.min((previous.delay || 15000) * 2, 300000) : 6 * 3600000;
		try {
			var retry = error.getResponseHeader && error.getResponseHeader("Retry-After");
			if (retry) {
				var retryTime = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
				if (isFinite(retryTime)) delay = Math.max(delay, retryTime - Date.now());
			}
		} catch (e) {}
		blocks[fingerprint] = { until: Date.now() + delay, delay: delay, status: status };
		storeObject("rating_api_backoff_v2", blocks);
		error.blockedUntil = blocks[fingerprint].until;
	}

	function stillWanted(card, paid) {
		return demandKey === card.key || (!paid && !document.hidden && focusCard && focusCard.key === card.key);
	}

	function request(url, kind, card, callback) {
		var key = kind === "api" ? apiKey() : "";
		var requestKey = kind + ":" + keyFingerprint(key) + ":" + url;
		if (requests[requestKey]) {
			requests[requestKey].callbacks.push(callback);
			requests[requestKey].card = card;
			return;
		}
		var task = {
			url: url, kind: kind, card: card, key: key,
			requestKey: requestKey, callbacks: [callback]
		};
		requests[requestKey] = task;
		queue.push(task);
		pumpQueue();
	}

	function finishRequest(task, error, data) {
		delete requests[task.requestKey];
		task.callbacks.forEach(function (callback) {
			try {
				callback(error, data);
			} catch (e) {
				if (window.console) console.warn("Рейтинги: не удалось обработать ответ", e);
			}
		});
	}

	function sendRequest(task) {
		running++;
		if (task.kind === "api") {
			runningApi++;
			nextApiAt = Date.now() + 350;
		}
		var network = new Lampa.Reguest();
		var ended = false;
		var watchdog = setTimeout(function () {
			complete({ status: 0 });
			network.clear();
		}, task.kind === "api" ? 9000 : 6500);
		function complete(error, data) {
			if (ended) return;
			ended = true;
			clearTimeout(watchdog);
			running--;
			if (task.kind === "api") {
				runningApi--;
				if (error && !error.cancelled) {
					var originalError = error;
					error = {
						status: Number(originalError.status) || 0,
						getResponseHeader: function (name) {
							return originalError.getResponseHeader ? originalError.getResponseHeader(name) : null;
						}
					};
					recordApiError(task.key, error);
				}
			}
			finishRequest(task, error, data);
			pumpQueue();
		}
		task.cancel = function () {
			complete({ cancelled: true });
			network.clear();
		};
		network.timeout(task.kind === "api" ? 8000 : 5000);
		try {
			network[task.kind === "xml" ? "native" : "silent"](
				task.url,
				function (data) { complete(null, data); },
				function (error) { complete(error || { status: 0 }); },
				false,
				task.kind === "api" ? { headers: { "X-API-KEY": task.key } } :
					task.kind === "xml" ? { dataType: "text" } : {}
			);
		} catch (e) {
			complete({ status: 0 });
		}
	}

	function pumpQueue() {
		clearTimeout(queueTimer);
		queueTimer = null;
		Object.keys(requests).forEach(function (key) {
			var task = requests[key];
			if (task && task.kind !== "api" && task.cancel && !stillWanted(task.card, false)) task.cancel();
		});
		queue.sort(function (a, b) {
			return Number(b.card.key === demandKey) - Number(a.card.key === demandKey);
		});
		for (var i = 0; i < queue.length;) {
			var task = queue[i];
			if (!stillWanted(task.card, task.kind === "api")) {
				queue.splice(i, 1);
				finishRequest(task, { cancelled: true });
				continue;
			}
			var block = task.kind === "api" ? apiBlock(task.key) : {};
			if (block.until > Date.now()) {
				queue.splice(i, 1);
				finishRequest(task, {
					blockedUntil: block.until, status: block.status,
					apiFingerprint: keyFingerprint(task.key)
				});
				continue;
			}
			if (running >= 3) break;
			if (task.kind === "api" && (runningApi >= 2 || nextApiAt > Date.now())) {
				i++;
				continue;
			}
			queue.splice(i, 1);
			sendRequest(task);
		}
		if (queue.length && running < 3 && runningApi < 2) {
			queueTimer = setTimeout(pumpQueue, Math.max(20, nextApiAt - Date.now()));
		}
	}

	function normalizeTitle(value) {
		return typeof value === "string" ? value.toLowerCase().replace(/ё/g, "е")
			.replace(/[\s.,:;'"\u0060!?()\[\]\/\\+\-\u2010-\u2015]+/g, " ").trim() : "";
	}

	function selectFilm(items, card, trustedImdb) {
		var data = card.data;
		var imdbId = data.imdb_id || (data.external_ids && data.external_ids.imdb_id);
		if (trustedImdb && items.length === 1 && items[0] && typeof items[0] === "object") {
			var returnedId = items[0].imdbId || items[0].imdb_id;
			if (!returnedId || returnedId === imdbId) return items[0];
		}
		var title = normalizeTitle(data.title || data.name);
		var original = normalizeTitle(data.original_title || data.original_name);
		var year = parseInt(String(data.release_date || data.first_air_date || "").slice(0, 4), 10);
		var candidates = [];
		items.forEach(function (item) {
			if (!item || typeof item !== "object") return;
			var itemImdb = item.imdbId || item.imdb_id;
			if (imdbId && itemImdb && imdbId !== itemImdb) return;
			if (imdbId && itemImdb === imdbId) {
				candidates.push({ item: item, score: 100 });
				return;
			}
			var type = item.type;
			if (type && type !== "ALL") {
				var isTv = type === "TV_SERIES" || type === "MINI_SERIES" || type === "TV_SHOW";
				if ((card.method === "tv") !== isTv) return;
			}
			var titles = [item.nameOriginal, item.nameEn, item.nameRu].map(normalizeTitle);
			var score = original && titles.indexOf(original) !== -1 ? 8 :
				title && titles.indexOf(title) !== -1 ? 6 : 0;
			if (!score) return;
			var itemYear = parseInt(item.year, 10);
			if (year && itemYear) {
				if (Math.abs(year - itemYear) > 1) return;
				score += year === itemYear ? 4 : 1;
			}
			candidates.push({ item: item, score: score });
		});
		candidates.sort(function (a, b) { return b.score - a.score; });
		return candidates.length && (!candidates[1] || candidates[0].score > candidates[1].score) ?
			candidates[0].item : null;
	}

	function keywordQuery(card, title) {
		if (!title) return "";
		var query = "?keyword=" + encodeURIComponent(title);
		var year = parseInt(String(card.data.release_date || card.data.first_air_date || "").slice(0, 4), 10);
		if (year >= 1001 && year <= 9998) query += "&yearFrom=" + (year - 1) + "&yearTo=" + (year + 1);
		if (card.method === "movie") query += "&type=FILM";
		return query;
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
		var entry = getEntry(card);
		if (!paid && !entry.kpId) return;
		if (!entry.kpId && !card.data.title && !card.data.name && !card.data.original_title &&
			!card.data.original_name && !card.data.imdb_id && !(card.data.external_ids && card.data.external_ids.imdb_id)) return;
		var job = { card: card, paid: paid };
		pendingRatings[card.key] = job;
		notify(card.key);
		function finish(error, missing) {
			delete pendingRatings[card.key];
			if (error && !error.cancelled) failRatings(job.card, missing, error);
			else notify(card.key);
		}
		function save(data) {
			if (!data || typeof data !== "object" ||
				!Object.prototype.hasOwnProperty.call(data, "ratingKinopoisk") ||
				!Object.prototype.hasOwnProperty.call(data, "ratingImdb")) return finish({ status: 0 });
			putRatings(job.card, data.ratingKinopoisk, data.ratingImdb);
			finish();
		}
		function details(kpId) {
			if (!job.paid || !stillWanted(job.card, true)) return finish({ cancelled: true });
			request(apiUrl + "/" + kpId, "api", job.card, function (error, data) {
				if (error) finish(error, error.status === 404);
				else save(data);
			});
		}
		function xml(kpId) {
			request("https://rating.kinopoisk.ru/" + kpId + ".xml", "xml", job.card, function (error, text) {
				if (!error && typeof text === "string") {
					var kp = text.match(/<kp_rating\b[^>]*>([^<]*)<\/kp_rating>/i);
					var imdb = text.match(/<imdb_rating\b[^>]*>([^<]*)<\/imdb_rating>/i);
					if (kp || imdb) {
						putRatings(job.card, kp && kp[1], imdb && imdb[1]);
						return finish();
					}
				}
				if (error && error.cancelled) finish(error);
				else if (job.paid && stillWanted(job.card, true)) details(kpId);
				else finish({ cancelled: true });
			});
		}
		function search(query, trustedImdb, alternative) {
			if (!stillWanted(job.card, true)) return finish({ cancelled: true });
			request(apiUrl + query, "api", job.card, function (error, data) {
				if (error && error.status !== 404) return finish(error);
				if (!error && (!data || !Array.isArray(data.items))) return finish({ status: 0 });
				var found = selectFilm(error ? [] : data.items, job.card, trustedImdb);
				if (!found) {
					if (alternative) return search(alternative, false, "");
					return finish({ status: 404 }, true);
				}
				var kpId = positiveId(found.kinopoiskId);
				if (!kpId) return finish({ status: 0 });
				getEntry(job.card).kpId = kpId;
				changed(job.card);
				if (Object.prototype.hasOwnProperty.call(found, "ratingKinopoisk") &&
					Object.prototype.hasOwnProperty.call(found, "ratingImdb")) save(found);
				else xml(kpId);
			});
		}
		if (entry.kpId) return xml(entry.kpId);
		var data = card.data;
		var title = data.title || data.name || data.original_title || data.original_name;
		var original = data.original_title || data.original_name;
		var imdbId = data.imdb_id || (data.external_ids && data.external_ids.imdb_id);
		var keyword = keywordQuery(card, title);
		if (imdbId && /^tt\d+$/.test(imdbId)) search("?imdbId=" + encodeURIComponent(imdbId), true, keyword);
		else if (keyword) search(keyword, false,
			original && normalizeTitle(original) !== normalizeTitle(title) ? keywordQuery(card, original) : "");
		else finish({ status: 404 }, true);
	}

	function cubBase() {
		var domain = Lampa.Manifest && Lampa.Manifest.cub_domain;
		if (typeof domain !== "string" || !domain) return "";
		return /^https?:\/\//.test(domain) ? domain.replace(/\/$/, "") :
			Lampa.Utils.protocol() + domain.replace(/\/$/, "");
	}

	function putCub(card, items) {
		getEntry(card).cub = { items: items, at: Date.now(), retryAt: 0 };
		changed(card);
	}

	function fetchCub(card) {
		if (card.source !== "tmdb" || pendingCub[card.key]) return;
		var entry = getEntry(card);
		if (entry.cub && (entry.cub.retryAt > Date.now() || Date.now() - entry.cub.at < day / 2)) return;
		var base = cubBase();
		if (!base) return;
		var requestedAt = Date.now();
		pendingCub[card.key] = true;
		notify(card.key);
		request(base + "/api/reactions/get/" + card.method + "_" + card.id, "cub", card, function (error, data) {
			delete pendingCub[card.key];
			if (getEntry(card).cub && getEntry(card).cub.at > requestedAt) return notify(card.key);
			if (!error && data && Object.prototype.hasOwnProperty.call(data, "result") &&
				(data.result === null || Array.isArray(data.result))) {
				putCub(card, data.result || []);
			} else if (!error || !error.cancelled) {
				var cub = getEntry(card).cub || { items: [], at: 0 };
				cub.retryAt = Date.now() + retryDelay;
				getEntry(card).cub = cub;
				changed(card);
			} else notify(card.key);
		});
	}

	function cubRating(card) {
		var cub = getEntry(card).cub;
		if (!cub || !Array.isArray(cub.items)) return null;
		var types = ["shit", "bore", "think", "nice", "fire"];
		var weights = { fire: 10, nice: 7.5, think: 5, bore: 2.5, shit: 0 };
		var counts = {};
		var sum = 0;
		var count = 0;
		cub.items.forEach(function (reaction) {
			if (!reaction || !Object.prototype.hasOwnProperty.call(weights, reaction.type)) return;
			var amount = Number(reaction.counter);
			if (!isFinite(amount) || amount <= 0) return;
			amount = Math.floor(amount);
			counts[reaction.type] = (counts[reaction.type] || 0) + amount;
			sum += amount * weights[reaction.type];
			count += amount;
		});
		if (count < 20) return null;
		var median = "";
		var cumulative = 0;
		for (var i = 0; i < types.length; i++) {
			cumulative += counts[types[i]] || 0;
			if (cumulative >= (count + 1) / 2) {
				median = types[i];
				break;
			}
		}
		var prior = card.method === "tv" ? 7.436 : 6.584;
		var confidence = card.method === "tv" ? 69 : 274;
		return { value: (prior * confidence + sum) / (confidence + count), reaction: median };
	}

	function ensureBlock(render, name, label) {
		var block = render.find(".rate--" + name).first();
		if (!block.length) {
			var anchor = render.find(".rate--imdb, .rate--kp, .rate--tmdb, .full-start__rate, .full-start-new__rate").last();
			if (!anchor.length) return block;
			block = $('<div class="full-start__rate rate--' + name + '"><div></div>' +
				(name === "cub" ? '<div class="rating-plugin-reaction"></div>' : '<div></div>') + '</div>');
			if (name !== "cub") block.children("div").last().text(label);
			anchor.after(block);
		}
		block.addClass("rating-plugin-rate").removeClass("hide");
		block.children("div").first().addClass("rating-plugin-value");
		if (name === "cub") {
			block.children("div").slice(2).remove();
			var icon = block.children("div").eq(1);
			if (!icon.length) icon = $("<div>").appendTo(block);
			icon.removeClass("rating-plugin-label").addClass("rating-plugin-reaction");
			if (icon.text().trim()) icon.empty();
			block.attr("aria-label", "Рейтинг CUB");
		} else block.children("div").last().addClass("rating-plugin-label");
		return block;
	}

	function showValue(block, value, loading, unavailable) {
		if (!block.length) return;
		var number = block.children("div").first();
		var text = value ? value.toFixed(1).replace("10.0", "10") : "—";
		if (number.text() !== text) number.text(text);
		block.toggleClass("rating-plugin-pending", !value && loading)
			.toggleClass("rating-plugin-empty", !value);
		block.attr("aria-busy", !value && loading ? "true" : "false");
		block.attr("title", value ? "" : loading ? "Загрузка рейтинга" : unavailable);
		Lampa.Listener.send("rating:updated", { render: block });
	}

	function draw(context) {
		var entry = getEntry(context.card);
		var ratings = entry.ratings || {};
		var waiting = !!pendingRatings[context.card.key];
		var message = ratings.state === "error" ? "Рейтинг временно недоступен" : "Оценки пока нет";
		context.render.find(".wait_rating").remove();
		showValue(ensureBlock(context.render, "kp", "КП"), ratingValue(ratings.kp), waiting, message);
		showValue(ensureBlock(context.render, "imdb", "IMDb"), ratingValue(ratings.imdb), waiting, message);
		if (context.card.source !== "tmdb") return;
		var cub = cubRating(context.card);
		var block = ensureBlock(context.render, "cub", "");
		showValue(block, cub ? cub.value : 0, !!pendingCub[context.card.key], "Для оценки нужно минимум 20 реакций");
		var icon = block.children(".rating-plugin-reaction").first();
		var reaction = cub ? cub.reaction : "";
		if (icon.attr("data-reaction") !== reaction) {
			icon.attr("data-reaction", reaction).empty();
			if (reaction && cubBase()) {
				var image = $("<img>").on("load", function () { $(this).addClass("rating-plugin-image-ready"); });
				image.attr({ src: cubBase() + "/img/reactions/" + reaction + ".svg", alt: "" });
				if (image[0].complete && image[0].naturalWidth) image.addClass("rating-plugin-image-ready");
				icon.append(image);
			}
		}
	}

	function notify(key) {
		if (!current || current.card.key !== key || demandKey !== key) return;
		draw(current);
	}

	function openCard(card) {
		if (!card) return;
		clearTimeout(focusTimer);
		if (demandKey !== card.key) current = null;
		demandKey = card.key;
		seedCard(card);
		var entry = getEntry(card);
		if (Date.now() - entry.used > retryDelay) changed(card);
		fetchRatings(card, true);
		pumpQueue();
	}

	function bindCard(card, render, reactions) {
		if (!card || !render) return;
		render = $(render);
		if (!render.length) return;
		if (demandKey !== card.key) current = null;
		demandKey = card.key;
		seedCard(card);
		if (card.source === "tmdb" && reactions && Array.isArray(reactions.result)) putCub(card, reactions.result);
		current = { card: card, render: render };
		draw(current);
		fetchRatings(card, true);
		fetchCub(card);
		draw(current);
	}

	function findCard(element) {
		var node = element && element.jquery ? element[0] : element;
		for (var steps = 0; node && steps < 15; steps++, node = node.parentNode) {
			var data = node.card_data || node.data;
			if (!data || typeof data !== "object") data = $(node).data("data");
			var card = describeCard(data);
			if (card) return card;
		}
		return null;
	}

	function scheduleFocus(element) {
		var card = findCard(element);
		if (focusCard && card && focusCard.key === card.key) return;
		clearTimeout(focusTimer);
		focusCard = card;
		pumpQueue();
		if (!card || document.hidden) return;
		seedCard(card);
		focusTimer = setTimeout(function () {
			if (!stillWanted(card, false) || !document.documentElement.contains($(element)[0])) return;
			fetchRatings(card, false);
			fetchCub(card);
		}, 900);
	}

	function activeChanged() {
		clearTimeout(focusTimer);
		focusCard = null;
		var active = Lampa.Activity.active();
		if (active && active.component === "full") {
			var card = describeCard(active.card || active.movie || active, active);
			if (card) {
				if (active.activity && typeof active.activity.render === "function") bindCard(card, active.activity.render());
				else openCard(card);
			}
		} else {
			demandKey = "";
			current = null;
		}
		pumpQueue();
		setTimeout(function () {
			var selected = $(".layer--visible .card.focus, .layer--visible .card-parser.focus").first();
			if (selected.length) scheduleFocus(selected);
		}, 0);
	}

	function fullEvent(event) {
		if (event.type !== "start" && event.type !== "build" && event.type !== "complite") return;
		if (event.type === "build" && event.name !== "start") return;
		var data = event.data || {};
		if (event.link && event.object) event.link.ratingPluginObject = event.object;
		var object = event.object || (event.link && (event.link.ratingPluginObject || event.link.object));
		var active = Lampa.Activity.active();
		if (object && object.activity && active && active.activity && object.activity !== active.activity) return;
		var card = describeCard(data.movie, object);
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
					else if (object && object.component) {
						demandKey = "";
						current = null;
					}
				} catch (e) {}
				return original.apply(this, arguments);
			};
		});
	}

	function installStyles() {
		$("<style>").text(
			".rating-plugin-rate{font-variant-numeric:tabular-nums}" +
			".rating-plugin-rate>.rating-plugin-value{position:relative;width:3ch;min-width:3ch;flex:0 0 3ch;text-align:center;transition:opacity .22s ease}" +
			".rating-plugin-rate>.rating-plugin-label{transition:opacity .22s ease}" +
			".rating-plugin-empty>.rating-plugin-value,.rating-plugin-empty>.rating-plugin-label{opacity:.4}" +
			".rating-plugin-value:after{content:'';position:absolute;left:25%;right:25%;bottom:-.18em;height:1px;background:currentColor;opacity:0;transition:opacity .22s ease}" +
			".rating-plugin-pending>.rating-plugin-value:after{animation:rating-plugin-loading 1.8s ease-in-out infinite}" +
			".rating-plugin-reaction{width:1.4em;min-width:1.4em;height:1.2em;text-align:center}" +
			".rating-plugin-reaction img{display:block;width:1.2em;height:1.2em;margin:0 .1em;opacity:0;transition:opacity .22s ease}" +
			".rating-plugin-reaction img.rating-plugin-image-ready{opacity:1}" +
			"@keyframes rating-plugin-loading{0%,100%{opacity:.2}50%{opacity:.65}}" +
			"@media(prefers-reduced-motion:reduce){.rating-plugin-pending>.rating-plugin-value:after{animation:none;opacity:.4}.rating-plugin-value,.rating-plugin-label,.rating-plugin-reaction img{transition:none!important}}"
		).appendTo("head");
	}

	function installSettings() {
		if (!Lampa.SettingsApi || !Lampa.Input || typeof Lampa.SettingsApi.addComponent !== "function" ||
			typeof Lampa.SettingsApi.addParam !== "function") return;
		Lampa.SettingsApi.addComponent({ component: "rating_plugin_settings", name: "Рейтинги" });
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
						value: Lampa.Storage.get("rating_api_key", ""),
						type: "password", nosave: true, free: true, nomic: true
					}, function (value) {
						if (typeof value === "string") {
							Lampa.Storage.set("rating_api_key", value.trim());
							Lampa.Noty.show(value.trim() ? "Личный ключ сохранён" : "Используется встроенный ключ");
						}
						Lampa.Controller.toggle(controller);
					});
				});
			}
		});
	}

	function startPlugin() {
		if (started || !window.Lampa || !Lampa.Storage || !Lampa.Listener || !document.body) return;
		if (window.rating_plugin_v2) return;
		started = true;
		window.rating_plugin_v2 = true;
		window.rating_plugin = true;
		window.cub_rating_plugin = true;
		cache = readObject(cacheName);
		installStyles();
		installNavigation();
		installSettings();
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
				focusCard = null;
				flushCache();
			} else activeChanged();
		});
		window.addEventListener("pagehide", flushCache);
		if (Lampa.Storage.listener) Lampa.Storage.listener.follow("change", function (event) {
			if (current && event.name === "rating_api_key") fetchRatings(current.card, true);
		});
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
