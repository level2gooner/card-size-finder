// Card Size Finder
// Shows where your storage goes: character cards and chats (ranked per
// character), plus sprites, gallery images, backgrounds, Data Bank files and
// the app's in-browser data.
// Scanning only reads. The one thing that can delete is the "Delete all" button
// inside a gallery folder, and only after you confirm.

const PANEL_ID = 'card_size_finder';
const CONCURRENCY = 4;
const SAMPLE_SIZE = 40;
const MAX_KEYS = 50000;
const MAX_FOLDERS = 30;
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
let expandedFolder = null;
let confirmingFolder = null;
let deleting = null; // { folder, done, total, cancel }
let folderNotice = '';

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
async function pool(items, fn, shouldStop = () => stopRequested) {
    let next = 0;
    async function worker() {
        while (!shouldStop()) {
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

async function scanGallery(onProgress) {
    const folders = await postJson('/api/images/folders');
    if (!Array.isArray(folders)) return null;

    const perFolder = [];
    const jobs = [];
    await pool(folders, async (folder) => {
        const files = await postJson('/api/images/list', { folder, type: 0b111 });
        if (!Array.isArray(files)) return;
        const entry = { folder, bytes: 0, files: 0, items: [] };
        perFolder.push(entry);
        for (const file of files) {
            jobs.push({ entry, name: file, url: `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}` });
        }
    });

    let done = 0;
    await pool(jobs, async (job) => {
        const size = await getUrlBytes(job.url);
        if (size !== null) {
            job.entry.bytes += size;
            job.entry.files++;
            job.entry.items.push({ name: job.name, url: job.url, bytes: size });
        }
        done++;
        if (done % 50 === 0) onProgress?.(done, jobs.length);
    });

    perFolder.sort((x, y) => y.bytes - x.bytes);
    return {
        bytes: perFolder.reduce((sum, f) => sum + f.bytes, 0),
        files: perFolder.reduce((sum, f) => sum + f.files, 0),
        folders: perFolder,
    };
}

/** Mirrors how the app turns a name into a folder name. */
export function toFolderName(name) {
    return String(name ?? '')
        .replace(/[\/?<>\\:*|"]/g, '')
        .replace(/[\x00-\x1f\x80-\x9f]/g, '')
        .replace(/[. ]+$/, '');
}

/** Who a gallery folder belongs to: a character, a group, one of your personas, or nobody. */
export function findFolderOwner(folder) {
    const context = getContext();
    const mapped = context?.extensionSettings?.gallery?.folders ?? {};
    const matches = name => name === folder || toFolderName(name) === folder;

    const character = (context?.characters ?? []).find(c => c && (matches(mapped[c.avatar] ?? c.name) || matches(c.name)));
    if (character) return { type: 'character', avatar: character.avatar };
    if ((context?.groups ?? []).some(g => g && matches(g.name))) return { type: 'group' };
    const personas = Object.values(context?.powerUserSettings?.personas ?? {});
    if (personas.some(matches) || matches(context?.name1)) return { type: 'persona' };
    return { type: 'none' };
}

const OWNER_LABELS = {
    character: '',
    group: ' · group chat',
    persona: ' · your persona',
    none: ' · no character, group or persona with this name',
};

async function deleteFolderImages(root, entry) {
    if (deleting || scanning) return;
    const items = [...entry.items];
    deleting = { folder: entry.folder, done: 0, total: items.length, cancel: false };
    confirmingFolder = null;
    folderNotice = '';
    renderFolders(root);

    const headers = getContext()?.getRequestHeaders?.() ?? { 'Content-Type': 'application/json' };
    let removed = 0;
    let freed = 0;
    let failed = 0;
    const state = deleting;
    try {
        await pool(items, async (item) => {
            let ok = false;
            try {
                const response = await fetch('/api/images/delete', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ path: item.url }),
                });
                ok = response.ok;
            } catch {
                ok = false;
            }
            if (ok) {
                removed++;
                freed += item.bytes;
                const index = entry.items.indexOf(item);
                if (index >= 0) entry.items.splice(index, 1);
            } else {
                failed++;
            }
            state.done++;
            if (state.done % 5 === 0 || state.done === state.total) {
                const progress = root.querySelector('.csf_delete_progress');
                if (progress) progress.textContent = `Deleting… ${state.done} / ${state.total}`;
            }
        }, () => state.cancel);
    } finally {
        entry.bytes = entry.items.reduce((sum, item) => sum + item.bytes, 0);
        entry.files = entry.items.length;
        const row = breakdown?.rows.find(r => r.key === 'gallery');
        if (row) {
            const folders = breakdown.galleryFolders;
            row.bytes = folders.reduce((sum, f) => sum + f.bytes, 0);
            row.label = `Gallery and generated images (${folders.reduce((sum, f) => sum + f.files, 0)})`;
        }
        breakdown?.galleryFolders.sort((x, y) => y.bytes - x.bytes);
        folderNotice = `Deleted ${removed} file${removed === 1 ? '' : 's'} from "${entry.folder}" and freed ${formatBytes(freed)}.`;
        if (state.cancel) folderNotice += ' Stopped early.';
        if (failed) folderNotice += ` ${failed} couldn't be deleted.`;
        if (entry.files === 0) expandedFolder = null;
        deleting = null;
        render(root);
    }
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
                <small class="csf_info">Shows where your storage goes, and ranks your characters by size (card image plus chat history). Scanning only reads. Nothing is deleted unless you open a gallery folder, tap Delete all and confirm.</small>
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
                <div class="csf_folders_summary"></div>
                <div class="csf_folder_notice"></div>
                <div class="csf_folders csf_list"></div>
                <div class="csf_summary"></div>
                <div class="csf_characters csf_list"></div>
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

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

function button(label, className, handler) {
    const node = element('div', `menu_button ${className}`, label);
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    onActivate(node, (event) => {
        event.stopPropagation();
        handler();
    });
    return node;
}

function buildFolderPanel(root, entry, owner) {
    const panel = element('div', 'csf_folder_panel');

    const previews = entry.items.filter(item => IMAGE_FILE.test(item.name)).slice(0, 6);
    if (previews.length) {
        const strip = element('div', 'csf_previews');
        for (const item of previews) {
            const image = document.createElement('img');
            image.loading = 'lazy';
            image.decoding = 'async';
            image.alt = '';
            image.src = item.url;
            strip.append(image);
        }
        panel.append(strip);
    }

    if (deleting?.folder === entry.folder) {
        const state = deleting;
        panel.append(
            element('div', 'csf_delete_progress', `Deleting… ${state.done} / ${state.total}`),
            button('Stop deleting', 'csf_cancel_delete', () => {
                state.cancel = true;
            }),
        );
        return panel;
    }

    if (confirmingFolder === entry.folder) {
        const box = element('div', 'csf_confirm');
        box.append(element(
            'div',
            '',
            `Delete all ${entry.files} file${entry.files === 1 ? '' : 's'} (${formatBytes(entry.bytes)}) in "${entry.folder}"? This can't be undone. Chat messages that showed these images will show a broken picture instead.`,
        ));
        const actions = element('div', 'csf_actions');
        actions.append(
            button(`Yes, delete ${entry.files} file${entry.files === 1 ? '' : 's'}`, 'csf_confirm_delete', () => deleteFolderImages(root, entry)),
            button('Cancel', 'csf_cancel', () => {
                confirmingFolder = null;
                renderFolders(root);
            }),
        );
        box.append(actions);
        panel.append(box);
        return panel;
    }

    const actions = element('div', 'csf_actions');
    if (owner.type === 'character') {
        actions.append(button('Open character', 'csf_open', () => openCharacter(owner.avatar)));
    }
    if (!deleting && !scanning) {
        actions.append(button('Delete all…', 'csf_delete', () => {
            confirmingFolder = entry.folder;
            renderFolders(root);
        }));
    }
    panel.append(actions);
    return panel;
}

function renderFolders(root) {
    const summary = root.querySelector('.csf_folders_summary');
    const notice = root.querySelector('.csf_folder_notice');
    const list = root.querySelector('.csf_folders');
    summary.replaceChildren();
    list.replaceChildren();
    notice.textContent = folderNotice;
    const all = breakdown?.galleryFolders ?? [];
    const folders = all.filter(f => f.files > 0);
    if (!folders.length) return;

    const shown = folders.slice(0, MAX_FOLDERS);
    summary.append(
        element('b', '', 'Biggest gallery folders'),
        ` · ${folders.length} folder${folders.length === 1 ? '' : 's'}${folders.length > shown.length ? `, top ${shown.length} shown` : ''} · tap one to preview or delete`,
    );

    const max = shown[0].bytes || 1;
    shown.forEach((folder, index) => {
        const owner = findFolderOwner(folder.folder);
        const item = element('div', 'csf_row');
        item.dataset.folder = folder.folder;
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        const main = element('div', 'csf_main');
        main.append(
            element('div', 'csf_name', folder.folder),
            element('div', 'csf_detail', `${folder.files} file${folder.files === 1 ? '' : 's'}${OWNER_LABELS[owner.type]}`),
        );
        const bar = element('div', 'csf_bar');
        bar.style.width = `${Math.max(1, Math.round((folder.bytes / max) * 100))}%`;
        item.append(element('div', 'csf_rank', String(index + 1)), main, element('div', 'csf_total', formatBytes(folder.bytes)), bar);
        list.append(item);

        if (expandedFolder === folder.folder) {
            item.classList.add('csf_open_row');
            list.append(buildFolderPanel(root, folder, owner));
        }
    });
}

function render(root) {
    renderBreakdown(root);
    renderFolders(root);

    const summary = root.querySelector('.csf_summary');
    const list = root.querySelector('.csf_characters');
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
    if (scanning || deleting) return;
    expandedFolder = null;
    confirmingFolder = null;
    folderNotice = '';
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
    let galleryFolders = [];

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
            const gallery = await scanGallery((n, total) => setStatus(root, `Checking gallery images… ${n} / ${total}`));
            galleryFolders = gallery?.folders ?? [];
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
        breakdown = { rows, databases, galleryFolders };
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
    onActivate(root.querySelector('.csf_characters'), (event) => {
        const row = event.target.closest('.csf_row');
        if (row?.dataset.avatar) openCharacter(row.dataset.avatar);
    });
    onActivate(root.querySelector('.csf_folders'), (event) => {
        const row = event.target.closest('.csf_row');
        if (!row || deleting) return;
        expandedFolder = expandedFolder === row.dataset.folder ? null : row.dataset.folder;
        confirmingFolder = null;
        renderFolders(root);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
