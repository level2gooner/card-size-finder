// Card Size Finder
// Shows where your storage goes: character cards and chats (ranked per
// character), plus sprites, gallery images, backgrounds, Data Bank files and
// the app's in-browser data. Read-only: it never changes or deletes anything.

const PANEL_ID = 'card_size_finder';
const CONCURRENCY = 4;
const SAMPLE_SIZE = 40;
const MAX_KEYS = 50000;
const PROMPT_DB = 'SillyTavern_Prompts';
const KNOWN_DATABASES = [
    PROMPT_DB,
    'SillyTavern_ChatCompletions',
    'SillyTavern_TextCompletions',
    'SillyTavern_Thumbnails',
    'localforage',
];

let results = null;
let breakdown = null;
let scanning = false;
let stopRequested = false;

function getContext() {
    return globalThis.SillyTavern?.getContext?.();
}

export function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '?';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit++;
    }
    const shown = unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1);
    return `${shown} ${units[unit]}`;
}

/**
 * Size of a file served by the app, in bytes, or null if it can't be read.
 * Tries a HEAD request first, then a 1-byte range request, then a full download.
 */
export async function getUrlBytes(url) {
    try {
        const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        if (response.ok) {
            const length = Number(response.headers.get('content-length'));
            if (Number.isFinite(length) && length > 0) return length;
        }
    } catch {
        // fall through
    }

    try {
        const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
        const contentRange = response.headers.get('content-range');
        const match = contentRange && /\/(\d+)\s*$/.exec(contentRange);
        if (match) {
            response.body?.cancel?.().catch(() => {});
            return Number(match[1]);
        }
        if (response.ok) {
            const blob = await response.blob();
            return blob.size;
        }
    } catch {
        // fall through
    }

    return null;
}

export function getCardBytes(avatar) {
    return getUrlBytes(`/characters/${encodeURIComponent(avatar)}`);
}

/** Runs fn over items a few at a time. Stops early if Stop was tapped. */
async function pool(items, fn) {
    let next = 0;
    async function worker() {
        while (!stopRequested) {
            const index = next++;
            if (index >= items.length) return;
            await fn(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()));
}

async function fetchJson(url, options) {
    try {
        const response = await fetch(url, options);
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    }
}

function postJson(url, body) {
    const headers = getContext()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
    return fetchJson(url, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
}

// ---------- Other files ----------

async function measureUrls(urls) {
    let bytes = 0;
    let files = 0;
    await pool(urls, async (url) => {
        const size = await getUrlBytes(url);
        if (size !== null) {
            bytes += size;
            files++;
        }
    });
    return { bytes, files };
}

async function scanSprites(characters, onProgress) {
    const urls = [];
    let done = 0;
    let answered = 0;
    await pool(characters, async (character) => {
        const folder = String(character.avatar).replace(/\.[^.]+$/, '');
        const sprites = await fetchJson(`/api/sprites/get?name=${encodeURIComponent(folder)}`);
        if (Array.isArray(sprites)) {
            answered++;
            for (const sprite of sprites) {
                if (sprite?.path) urls.push(sprite.path);
            }
        }
        done++;
        if (done % 25 === 0) onProgress(done);
    });
    if (answered === 0) return null;
    return measureUrls(urls);
}

async function scanGallery() {
    const folders = await postJson('/api/images/folders');
    if (!Array.isArray(folders)) return null;
    const urls = [];
    await pool(folders, async (folder) => {
        const files = await postJson('/api/images/list', { folder, type: 0b111 });
        if (!Array.isArray(files)) return;
        for (const file of files) {
            urls.push(`/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`);
        }
    });
    return measureUrls(urls);
}

async function scanBackgrounds() {
    const payload = await postJson('/api/backgrounds/all');
    const images = Array.isArray(payload) ? payload : payload?.images;
    if (!Array.isArray(images)) return null;
    const urls = images
        .map(image => (typeof image === 'string' ? image : image?.filename))
        .filter(Boolean)
        .map(name => `/backgrounds/${encodeURIComponent(name)}`);
    return measureUrls(urls);
}

function sumAttachments() {
    const settings = getContext()?.extensionSettings ?? {};
    let bytes = 0;
    let files = 0;
    const add = (list) => {
        if (!Array.isArray(list)) return;
        for (const item of list) {
            const size = Number(item?.size);
            if (Number.isFinite(size) && size > 0) {
                bytes += size;
                files++;
            }
        }
    };
    add(settings.attachments);
    for (const list of Object.values(settings.character_attachments ?? {})) add(list);
    return { bytes, files };
}

// ---------- In-app browser data (IndexedDB) ----------

/** Rough stored size of a value, in bytes. */
export function roughSize(value, depth = 0) {
    if (value === null || value === undefined) return 1;
    switch (typeof value) {
        case 'string':
            // Text with characters outside Latin-1 is stored at 2 bytes per character.
            return /[^\x00-\xff]/.test(value) ? value.length * 2 : value.length;
        case 'number':
            return 8;
        case 'boolean':
            return 1;
        case 'bigint':
            return 8;
        case 'object':
            break;
        default:
            return 0;
    }
    if (depth > 50) return 0;
    if (value instanceof ArrayBuffer) return value.byteLength;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
    if (value instanceof Date) return 8;
    let total = 0;
    if (Array.isArray(value)) {
        for (const item of value) total += roughSize(item, depth + 1);
        return total;
    }
    if (value instanceof Map) {
        for (const [k, v] of value) total += roughSize(k, depth + 1) + roughSize(v, depth + 1);
        return total;
    }
    if (value instanceof Set) {
        for (const item of value) total += roughSize(item, depth + 1);
        return total;
    }
    for (const key of Object.keys(value)) {
        total += key.length + roughSize(value[key], depth + 1);
    }
    return total;
}

/** Opens an existing database without ever creating a new one. */
function openExistingDatabase(name) {
    return new Promise((resolve) => {
        let request;
        try {
            request = indexedDB.open(name);
        } catch {
            resolve(null);
            return;
        }
        // An upgrade here means the database didn't exist. Cancel so nothing is created.
        request.onupgradeneeded = () => {
            try {
                request.transaction.abort();
            } catch {
                // ignore
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => {
            event.preventDefault?.();
            resolve(null);
        };
        request.onblocked = () => resolve(null);
    });
}

function requestToPromise(request) {
    return new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => {
            event.preventDefault?.();
            resolve(null);
        };
    });
}

/**
 * Estimates one object store's size from an evenly spaced sample of its records.
 * Only the sampled records are read, so this stays quick on very large stores.
 */
async function estimateStore(db, storeName) {
    let count = 0;
    let keys = null;
    try {
        count = (await requestToPromise(db.transaction(storeName, 'readonly').objectStore(storeName).count())) || 0;
        if (!count) return 0;
        keys = await requestToPromise(db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys(null, MAX_KEYS));
    } catch {
        return 0;
    }
    if (!Array.isArray(keys) || keys.length === 0) return 0;

    const step = Math.max(1, Math.floor(keys.length / SAMPLE_SIZE));
    let sampled = 0;
    let bytes = 0;
    for (let i = 0; i < keys.length && sampled < SAMPLE_SIZE && !stopRequested; i += step) {
        try {
            const value = await requestToPromise(db.transaction(storeName, 'readonly').objectStore(storeName).get(keys[i]));
            bytes += roughSize(keys[i]) + roughSize(value);
            sampled++;
        } catch {
            break;
        }
    }
    return sampled ? Math.round((bytes / sampled) * count) : 0;
}

async function scanBrowserData() {
    if (typeof indexedDB === 'undefined') return { bytes: null, databases: [] };

    let names = [];
    try {
        if (typeof indexedDB.databases === 'function') {
            names = (await indexedDB.databases()).map(info => info.name).filter(Boolean);
        }
    } catch {
        // fall through
    }
    if (names.length === 0) names = KNOWN_DATABASES;

    const databases = [];
    for (const name of new Set(names)) {
        if (stopRequested) break;
        const db = await openExistingDatabase(name);
        if (!db) continue;
        let bytes = 0;
        try {
            for (const storeName of Array.from(db.objectStoreNames)) {
                bytes += await estimateStore(db, storeName);
            }
        } finally {
            db.close();
        }
        databases.push({ name, bytes });
    }
    databases.sort((a, b) => b.bytes - a.bytes);

    const estimated = databases.reduce((sum, d) => sum + d.bytes, 0);
    let reported = null;
    try {
        const estimate = await navigator.storage?.estimate?.();
        if (estimate && Number.isFinite(estimate.usage) && estimate.usage > 0) reported = estimate.usage;
    } catch {
        // not available here
    }
    return { bytes: Math.max(estimated, reported ?? 0), databases };
}

// ---------- UI ----------

function buildPanel() {
    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Card Size Finder</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <small class="csf_info">Shows where your storage goes, and ranks your characters by size (card image plus chat history). It only reads; nothing is changed or deleted. Tap a character to open it.</small>
                <div class="csf_controls">
                    <div class="menu_button csf_scan" role="button" tabindex="0">Scan</div>
                    <div class="menu_button csf_stop" role="button" tabindex="0" style="display:none">Stop</div>
                    <select class="text_pono csf_sort" aria-label="Sort by">
                        <option value="total">Sort: total</option>
                        <option value="image">Sort: card image</option>
                        <option value="chats">Sort: chats</option>
                    </select>
                </div>
                <div class="csf_status"></div>
                <div class="csf_breakdown"></div>
                <div class="csf_summary"></div>
                <div class="csf_list"></div>
            </div>
        </div>`;
    return root;
}

function setStatus(root, text) {
    root.querySelector('.csf_status').textContent = text;
}

function setScanning(root, value) {
    scanning = value;
    root.querySelector('.csf_scan').style.display = value ? 'none' : '';
    root.querySelector('.csf_stop').style.display = value ? '' : 'none';
}

const SORT_KEYS = { total: 'total', image: 'imageBytes', chats: 'chatBytes' };

export function sortResults(rows, sortValue) {
    const key = SORT_KEYS[sortValue] || 'total';
    return [...rows].sort((a, b) => (b[key] || 0) - (a[key] || 0));
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function renderBreakdown(root) {
    const box = root.querySelector('.csf_breakdown');
    box.replaceChildren();
    if (!breakdown) return;

    const rows = [...breakdown.rows].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    const found = rows.reduce((sum, row) => sum + (row.bytes || 0), 0);
    const max = Math.max(1, ...rows.map(row => row.bytes || 0));

    const title = element('div', 'csf_bd_title');
    title.append(element('b', '', 'Where the space goes'), ` · ${formatBytes(found)} found`);
    box.append(title);

    for (const row of rows) {
        const line = element('div', 'csf_bd_row');
        line.dataset.key = row.key;
        const label = element('div', 'csf_bd_label', row.label);
        const sizeText = row.bytes === null ? "couldn't check" : `${row.approx ? '~' : ''}${formatBytes(row.bytes)}`;
        const size = element('div', 'csf_bd_size', sizeText);
        const bar = element('div', 'csf_bar');
        bar.style.width = `${Math.max(1, Math.round(((row.bytes || 0) / max) * 100))}%`;
        line.append(label, size, bar);
        box.append(line);

        if (row.key === 'browser' && breakdown.databases?.length) {
            for (const db of breakdown.databases.filter(d => d.bytes >= 1_000_000).slice(0, 5)) {
                const sub = element('div', 'csf_bd_sub');
                sub.append(element('div', 'csf_bd_label', db.name), element('div', 'csf_bd_size', `~${formatBytes(db.bytes)}`));
                box.append(sub);
            }
        }
    }

    const prompts = breakdown.databases?.find(d => d.name === PROMPT_DB);
    if (prompts && prompts.bytes >= 50_000_000) {
        box.append(element(
            'div',
            'csf_hint',
            `Saved prompt history (${PROMPT_DB}) is using about ${formatBytes(prompts.bytes)}. To clear it: User Settings → Debug Menu → Delete itemized prompts. Your chats and characters aren't affected.`,
        ));
    }

    box.append(element(
        'small',
        'csf_info',
        'In-app data sizes are estimates. Not counted: memory/vector indexes and their model, Agent workspaces, extension files, and iOS\'s own web cache.',
    ));
}

function render(root) {
    renderBreakdown(root);

    const summary = root.querySelector('.csf_summary');
    const list = root.querySelector('.csf_list');
    list.replaceChildren();
    summary.replaceChildren();
    if (!results || results.length === 0) return;

    const sortValue = root.querySelector('.csf_sort').value;
    const rows = sortResults(results, sortValue);
    const key = SORT_KEYS[sortValue] || 'total';

    const imageTotal = results.reduce((sum, r) => sum + (r.imageBytes || 0), 0);
    const chatTotal = results.reduce((sum, r) => sum + (r.chatBytes || 0), 0);

    summary.append(
        element('b', '', 'Characters by size'),
        ` · ${results.length} characters · ${formatBytes(imageTotal + chatTotal)}`,
    );

    const max = rows[0]?.[key] || 1;
    const fragment = document.createDocumentFragment();
    rows.forEach((row, index) => {
        const item = element('div', 'csf_row');
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.dataset.avatar = row.avatar;

        const main = element('div', 'csf_main');
        main.append(
            element('div', 'csf_name', row.name),
            element('div', 'csf_detail', `card ${formatBytes(row.imageBytes)} · chats ${formatBytes(row.chatBytes)}`),
        );

        const bar = element('div', 'csf_bar');
        bar.style.width = `${Math.max(1, Math.round(((row[key] || 0) / max) * 100))}%`;

        item.append(
            element('div', 'csf_rank', String(index + 1)),
            main,
            element('div', 'csf_total', formatBytes(row[key])),
            bar,
        );
        fragment.append(item);
    });
    list.append(fragment);
}

/** A breakdown row for a group of files; bytes is null when the group couldn't be checked. */
function fileRow(key, label, result) {
    if (!result) return { key, label, bytes: null };
    return { key, label: `${label} (${result.files})`, bytes: result.bytes };
}

async function scan(root) {
    if (scanning) return;
    const context = getContext();
    const characters = (context?.characters ?? []).filter(c => c && c.avatar);
    if (characters.length === 0) {
        setStatus(root, 'No characters found.');
        return;
    }

    setScanning(root, true);
    stopRequested = false;
    const found = new Array(characters.length);
    let done = 0;
    let failed = 0;
    const rows = [];
    let databases = [];

    try {
        // 1. Cards and chats
        setStatus(root, `Checking cards… 0 / ${characters.length}`);
        await pool(characters, async (character, index) => {
            const imageBytes = await getCardBytes(character.avatar);
            if (imageBytes === null) failed++;
            const chatBytes = Number(character.chat_size) || 0;
            found[index] = {
                name: character.name || character.avatar,
                avatar: character.avatar,
                imageBytes,
                chatBytes,
                total: (imageBytes || 0) + chatBytes,
            };
            done++;
            if (done % 10 === 0 || done === characters.length) {
                setStatus(root, `Checking cards… ${done} / ${characters.length}`);
            }
        });
        results = found.filter(Boolean);
        rows.push({ key: 'cards', label: 'Card images', bytes: results.reduce((s, r) => s + (r.imageBytes || 0), 0) });
        rows.push({ key: 'chats', label: 'Chats', bytes: results.reduce((s, r) => s + (r.chatBytes || 0), 0) });

        const groupBytes = (context?.groups ?? []).reduce((s, g) => s + (Number(g?.chat_size) || 0), 0);
        if (groupBytes > 0) rows.push({ key: 'groups', label: 'Group chats', bytes: groupBytes });

        // 2. Other files
        if (!stopRequested) {
            setStatus(root, 'Checking in-app data…');
            const browser = await scanBrowserData();
            databases = browser.databases;
            if (browser.bytes !== null) {
                rows.push({ key: 'browser', label: 'In-app data (prompt history, caches, extension data)', bytes: browser.bytes, approx: true });
            }
        }
        if (!stopRequested) {
            setStatus(root, 'Checking gallery images…');
            const gallery = await scanGallery();
            rows.push(fileRow('gallery', 'Gallery and generated images', gallery));
        }
        if (!stopRequested) {
            setStatus(root, 'Checking backgrounds…');
            const backgrounds = await scanBackgrounds();
            rows.push(fileRow('backgrounds', 'Backgrounds', backgrounds));
        }
        if (!stopRequested) {
            setStatus(root, 'Checking sprites…');
            const sprites = await scanSprites(characters, (n) => setStatus(root, `Checking sprites… ${n} / ${characters.length}`));
            rows.push(fileRow('sprites', 'Character sprites', sprites));
        }
        if (!stopRequested) {
            const attachments = sumAttachments();
            if (attachments.files > 0) {
                rows.push({ key: 'databank', label: `Data Bank files (${attachments.files})`, bytes: attachments.bytes });
            }
        }
    } finally {
        results = found.filter(Boolean);
        breakdown = { rows, databases };
        setScanning(root, false);
    }

    let status = stopRequested
        ? `Stopped early. Checked ${done} of ${characters.length} characters.`
        : `Scanned ${done} characters.`;
    if (failed) status += ` Couldn't read ${failed} card image${failed === 1 ? '' : 's'}.`;
    setStatus(root, status);
    render(root);
}

async function openCharacter(avatar) {
    const context = getContext();
    const id = (context?.characters ?? []).findIndex(c => c?.avatar === avatar);
    if (id < 0) {
        globalThis.toastr?.warning?.('That character is gone. Tap Scan to refresh the list.');
        return;
    }
    await context.selectCharacterById(String(id));
}

function onActivate(target, handler) {
    target.addEventListener('click', handler);
    target.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handler(event);
        }
    });
}

function init() {
    if (document.getElementById(PANEL_ID)) return;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;

    const root = buildPanel();
    host.append(root);

    onActivate(root.querySelector('.csf_scan'), () => scan(root));
    onActivate(root.querySelector('.csf_stop'), () => {
        stopRequested = true;
        setStatus(root, 'Stopping…');
    });
    root.querySelector('.csf_sort').addEventListener('change', () => render(root));
    onActivate(root.querySelector('.csf_list'), (event) => {
        const row = event.target.closest('.csf_row');
        if (row) openCharacter(row.dataset.avatar);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
