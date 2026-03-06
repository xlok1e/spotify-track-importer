const SCOPES = "playlist-modify-public playlist-modify-private";
const STORAGE_KEY = "spotify_import_state";
const MAX_TRACKS = 10000;
const SEARCH_CONCURRENCY = 1;

/** @type {string | null} */
let accessToken = null;
/** @type {string[]} */
let tracks = [];

// ─── Modal ─────────────────────────────────────────────────────────────────

const modalOverlay = document.getElementById("modal-overlay");
document.getElementById("current-url").textContent = location.href.split("?")[0];

document
	.getElementById("btn-help")
	.addEventListener("click", () => modalOverlay.classList.add("open"));
document
	.getElementById("modal-close")
	.addEventListener("click", () => modalOverlay.classList.remove("open"));
modalOverlay.addEventListener("click", (e) => {
	if (e.target === modalOverlay) modalOverlay.classList.remove("open");
});

// ─── PKCE ──────────────────────────────────────────────────────────────────

const base64url = (/** @type {Uint8Array} */ buf) =>
	btoa(String.fromCharCode(...buf))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

const sha256 = async (/** @type {string} */ str) => {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
	return new Uint8Array(buf);
};

const generatePKCE = async () => {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(await sha256(verifier));
	return { verifier, challenge };
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

const logEl = document.getElementById("log");
const progressEl = document.getElementById("progress");
const progressTextEl = document.getElementById("progress-text");
const barEl = document.getElementById("bar");

/**
 * @param {string} msg
 * @param {'ok' | 'skip' | 'err' | 'info'} [type]
 */
const logLine = (msg, type = "info") => {
	const div = document.createElement("div");
	div.className = type;
	div.textContent = msg;
	logEl.appendChild(div);
	logEl.scrollTop = logEl.scrollHeight;
};

/**
 * @param {number} current
 * @param {number} total
 * @param {string} [label]
 */
const setProgress = (current, total, label) => {
	progressTextEl.textContent = label ?? `${current} / ${total}`;
	barEl.style.width = `${Math.min((current / total) * 100, 100)}%`;
};

// ─── Token ─────────────────────────────────────────────────────────────────

const doRefreshToken = async () => {
	const clientId = sessionStorage.getItem("spotify_client_id");
	const token = sessionStorage.getItem("spotify_refresh_token");
	if (!token) return;
	const res = await fetch("https://accounts.spotify.com/api/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: token,
			client_id: clientId,
		}),
	});
	const data = await res.json();
	if (data.access_token) {
		accessToken = data.access_token;
		sessionStorage.setItem("spotify_token", accessToken);
		sessionStorage.setItem("spotify_token_expires", Date.now() + data.expires_in * 1000);
		if (data.refresh_token) sessionStorage.setItem("spotify_refresh_token", data.refresh_token);
	}
};

const ensureFreshToken = async () => {
	const expires = parseInt(sessionStorage.getItem("spotify_token_expires") || "0");
	if (Date.now() > expires - 60_000) await doRefreshToken();
};

// ─── Spotify fetch (auto-retry 429 + 401) ──────────────────────────────────

/**
 * @param {string} endpoint
 * @param {RequestInit} [opts]
 * @param {number} [attempt]
 * @returns {Promise<Response>}
 */
const spotifyFetch = async (endpoint, opts = {}, attempt = 0) => {
	const res = await fetch(`https://api.spotify.com/v1${endpoint}`, {
		...opts,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			...(opts.headers ?? {}),
		},
	});
	if (res.status === 429 && attempt < 5) {
		const wait = parseInt(res.headers.get("Retry-After") || "5") * 1000;
		logLine(`Rate limit → ждём ${wait / 1000}с...`, "info");
		await sleep(wait);
		return spotifyFetch(endpoint, opts, attempt + 1);
	}
	if (res.status === 401 && attempt < 2) {
		await doRefreshToken();
		return spotifyFetch(endpoint, opts, attempt + 1);
	}
	return res;
};

// ─── Track cleaning + search ───────────────────────────────────────────────

/** @param {string} line */
const cleanLine = (line) =>
	line
		.replace(/\(feat\.?[^)]*\)/gi, "")
		.replace(/\[feat\.?[^\]]*\]/gi, "")
		.replace(/\((remastered?|deluxe|explicit|live|radio\s*edit|extended)[^)]*\)/gi, "")
		.replace(/\[[^\]]+\]/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();

/** @param {string} line */
const toFieldQuery = (line) => {
	const idx = line.indexOf(" - ");
	if (idx === -1) return line;
	return `track:${line.slice(idx + 3).trim()} artist:${line.slice(0, idx).trim()}`;
};

/** @param {string} line @returns {Promise<string | null>} */
const searchTrack = async (line) => {
	const cleaned = cleanLine(line);
	const attempt = async (/** @type {string} */ q) => {
		const res = await spotifyFetch(`/search?q=${encodeURIComponent(q)}&type=track&limit=1`);
		const data = await res.json();
		return data.tracks?.items?.[0]?.uri ?? null;
	};
	const uri = await attempt(toFieldQuery(cleaned));
	return uri ?? attempt(cleaned);
};

// ─── Playlist creation ─────────────────────────────────────────────────────

/** @param {string} name @returns {Promise<{ id: string; name: string }>} */
const createPlaylist = async (name) => {
	for (let i = 0; i < 3; i++) {
		const res = await spotifyFetch("/me/playlists", {
			method: "POST",
			body: JSON.stringify({ name, public: true, description: "Imported from Yandex Music" }),
		});
		const data = await res.json();
		if (data.id) return data;
		logLine(`Ошибка создания плейлиста (${i + 1}/3): ${data.error?.message ?? res.status}`, "err");
		await sleep(2000);
	}
	throw new Error("Не удалось создать плейлист после 3 попыток");
};

// ─── Auth ──────────────────────────────────────────────────────────────────

document.getElementById("btn-auth").addEventListener("click", async () => {
	const clientId = document.getElementById("client-id").value.trim();
	if (!clientId) return alert("Введите Client ID");
	const { verifier, challenge } = await generatePKCE();
	sessionStorage.setItem("pkce_verifier", verifier);
	sessionStorage.setItem("spotify_client_id", clientId);
	const params = new URLSearchParams({
		client_id: clientId,
		response_type: "code",
		redirect_uri: location.href.split("?")[0],
		scope: SCOPES,
		code_challenge_method: "S256",
		code_challenge: challenge,
	});
	location.href = `https://accounts.spotify.com/authorize?${params}`;
});

const exchangeCode = async (/** @type {string} */ code) => {
	const clientId = sessionStorage.getItem("spotify_client_id");
	const verifier = sessionStorage.getItem("pkce_verifier");
	const res = await fetch("https://accounts.spotify.com/api/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: location.href.split("?")[0],
			client_id: clientId,
			code_verifier: verifier,
		}),
	});
	const data = await res.json();
	if (data.access_token) {
		accessToken = data.access_token;
		sessionStorage.setItem("spotify_token", accessToken);
		sessionStorage.setItem("spotify_refresh_token", data.refresh_token);
		sessionStorage.setItem("spotify_token_expires", Date.now() + data.expires_in * 1000);
		history.replaceState({}, "", location.pathname);
	}
};

const initAuth = async () => {
	const params = new URLSearchParams(location.search);
	const code = params.get("code");
	if (code) await exchangeCode(code);
	else accessToken = sessionStorage.getItem("spotify_token");
	if (accessToken) {
		document.getElementById("step-auth").style.display = "none";
		document.getElementById("step-import").style.display = "block";
		checkResume();
	}
};

document.getElementById("btn-logout").addEventListener("click", () => {
	sessionStorage.clear();
	localStorage.removeItem(STORAGE_KEY);
	location.reload();
});

// ─── Resume ────────────────────────────────────────────────────────────────

const checkResume = () => {
	try {
		const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
		if (state?.playlistId && !state.completed)
			document.getElementById("btn-resume").style.display = "block";
	} catch {}
};

document.getElementById("btn-resume").addEventListener("click", async () => {
	try {
		const state = JSON.parse(localStorage.getItem(STORAGE_KEY));
		tracks = state.tracks;
		document.getElementById("playlist-name").value = state.playlistName || "";
		document.getElementById("drop-zone").textContent = `Восстановлено · ${tracks.length} треков`;
		document.getElementById("drop-zone").classList.add("loaded");
		document.getElementById("btn-resume").style.display = "none";
		document.getElementById("btn-start").disabled = true;
		logEl.classList.add("visible");
		progressEl.classList.add("visible");
		await runImport(state);
	} catch (e) {
		logLine(`Ошибка восстановления: ${e.message}`, "err");
	}
});

// ─── File drop ─────────────────────────────────────────────────────────────

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
	e.preventDefault();
	dropZone.classList.add("over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("over"));
dropZone.addEventListener("drop", (e) => {
	e.preventDefault();
	dropZone.classList.remove("over");
	handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));

/** @param {File} file */
const handleFile = (file) => {
	if (!file) return;
	const reader = new FileReader();
	reader.onload = (e) => {
		let lines = /** @type {string} */ (e.target.result)
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		if (lines.length > MAX_TRACKS) {
			const ok = confirm(
				`Файл содержит ${lines.length} треков.\n` +
					`Лимит плейлиста Spotify — ${MAX_TRACKS.toLocaleString()}.\n` +
					`Импортировать первые ${MAX_TRACKS.toLocaleString()}?`,
			);
			if (!ok) return;
			lines = lines.slice(0, MAX_TRACKS);
		}
		const unique = [...new Set(lines)];
		const dupes = lines.length - unique.length;
		tracks = unique;
		dropZone.textContent = `${file.name} · ${tracks.length} треков${dupes > 0 ? ` (удалено ${dupes} дублей)` : ""}`;
		dropZone.classList.add("loaded");
		document.getElementById("btn-start").disabled = false;
		document.getElementById("btn-resume").style.display = "none";
		localStorage.removeItem(STORAGE_KEY);
	};
	reader.readAsText(file, "utf-8");
};

// ─── Import ────────────────────────────────────────────────────────────────

document.getElementById("btn-start").addEventListener("click", async () => {
	if (!tracks.length) return;
	const playlistName = document.getElementById("playlist-name").value.trim() || "Imported Playlist";
	document.getElementById("btn-start").disabled = true;
	logEl.innerHTML = "";
	logEl.classList.add("visible");
	progressEl.classList.add("visible");
	await runImport({
		playlistName,
		tracks,
		nextIndex: 0,
		foundUris: [],
		notFound: [],
		playlistId: null,
		completed: false,
	});
});

/**
 * @typedef {{
 *   playlistName: string;
 *   tracks: string[];
 *   nextIndex: number;
 *   foundUris: string[];
 *   notFound: string[];
 *   playlistId: string | null;
 *   completed: boolean;
 * }} ImportState
 */

/** @param {ImportState} state */
const runImport = async (state) => {
	await ensureFreshToken();

	const meRes = await spotifyFetch("/me");
	const me = await meRes.json();
	if (!me.id) {
		logLine("Ошибка авторизации. Переподключись.", "err");
		document.getElementById("btn-start").disabled = false;
		return;
	}
	logLine(`Вошёл как ${me.display_name}`);

	if (!state.playlistId) {
		try {
			const playlist = await createPlaylist(state.playlistName);
			state.playlistId = playlist.id;
			logLine(`Плейлист создан: ${playlist.name}`);
		} catch (e) {
			logLine(e.message, "err");
			document.getElementById("btn-start").disabled = false;
			return;
		}
	} else {
		logLine(`Продолжаем: плейлист ${state.playlistId}`);
	}

	const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

	logLine(`Поиск треков ${state.nextIndex + 1}–${state.tracks.length}...`);
	logLine("⚠ Не сворачивайте и не закрывайте эту вкладку до завершения импорта.", "info");

	for (let i = state.nextIndex; i < state.tracks.length; i += SEARCH_CONCURRENCY) {
		await ensureFreshToken();
		const batch = state.tracks.slice(i, i + SEARCH_CONCURRENCY);
		const results = await Promise.all(batch.map(searchTrack));
		results.forEach((uri, j) => {
			const line = batch[j];
			if (uri) {
				state.foundUris.push(uri);
				logLine(`✓ ${line}`, "ok");
			} else {
				state.notFound.push(line);
				logLine(`✗ ${line}`, "skip");
			}
		});
		state.nextIndex = Math.min(i + SEARCH_CONCURRENCY, state.tracks.length);
		setProgress(state.nextIndex, state.tracks.length);
		save();
		await sleep(500);
	}

	const totalBatches = Math.ceil(state.foundUris.length / 100);
	logLine(`Добавляем ${state.foundUris.length} треков (${totalBatches} батчей)...`, "info");

	for (let i = 0; i < state.foundUris.length; i += 100) {
		await ensureFreshToken();
		const batchNum = Math.floor(i / 100) + 1;
		const chunk = state.foundUris.slice(i, i + 100);
		let success = false;
		for (let attempt = 0; attempt < 3; attempt++) {
			const res = await spotifyFetch(`/playlists/${state.playlistId}/items`, {
				method: "POST",
				body: JSON.stringify({ uris: chunk }),
			});
			if (res.status === 201) {
				success = true;
				break;
			}
			const err = await res.json().catch(() => ({}));
			logLine(
				`Батч ${batchNum}/${totalBatches} — ошибка ${res.status}: ${err.error?.message ?? "?"} (${attempt + 1}/3)`,
				"err",
			);
			await sleep(2000);
		}
		if (!success) logLine(`⚠ Батч ${batchNum}/${totalBatches} не добавлен`, "err");
		setProgress(batchNum, totalBatches, `Батч ${batchNum} / ${totalBatches}`);
		await sleep(500);
	}

	state.completed = true;
	localStorage.removeItem(STORAGE_KEY);

	logLine(
		`Готово. Найдено: ${state.foundUris.length}, не найдено: ${state.notFound.length}`,
		"info",
	);

	const link = document.createElement("a");
	link.href = `https://open.spotify.com/playlist/${state.playlistId}`;
	link.target = "_blank";
	link.textContent = `→ open.spotify.com/playlist/${state.playlistId}`;
	const wrap = document.createElement("div");
	wrap.className = "ok";
	wrap.appendChild(link);
	logEl.appendChild(wrap);
	logEl.scrollTop = logEl.scrollHeight;

	if (state.notFound.length > 0) {
		const blob = new Blob([state.notFound.join("\n")], { type: "text/plain;charset=utf-8" });
		const dlLink = document.createElement("a");
		dlLink.href = URL.createObjectURL(blob);
		dlLink.download = "not_found.txt";
		dlLink.textContent = `↓ Скачать ненайденные треки (${state.notFound.length})`;
		const dlWrap = document.createElement("div");
		dlWrap.className = "info";
		dlWrap.style.marginTop = "4px";
		dlWrap.appendChild(dlLink);
		logEl.appendChild(dlWrap);
		logEl.scrollTop = logEl.scrollHeight;
	}

	document.getElementById("btn-start").disabled = false;
};

initAuth();
