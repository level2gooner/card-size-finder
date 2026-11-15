// Card Size Finder
// Lists your characters by how much storage they use: the card image plus
// their chat history. Read-only: it never changes or deletes anything.

const PANEL_ID = 'card_size_finder';
const CONCURRENCY = 4;

let results = null;
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
 * Size of a character's card file in bytes, or null if it can't be read.
 * Tries a HEAD request first, then a 1-byte range request, then a full download.
 */
export async function getCardBytes(avatar) {
    const url = `/characters/${encodeURIComponent(avatar)}`;

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
                <small class="csf_info">Lists your characters by how much space they use: the card image plus their chat history. It only reads; nothing is changed or deleted. Tap a character to open it.</small>
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
                <div class="csf_summary"></div>
                <div class="csf_list"></div>
                <small class="csf_info">Sprite, expression and gallery folders aren't counted.</small>
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

function render(root) {
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

    const strong = document.createElement('b');
    strong.textContent = formatBytes(imageTotal + chatTotal);
    summary.append(
        strong,
        ` total across ${results.length} characters · card images ${formatBytes(imageTotal)} · chats ${formatBytes(chatTotal)}`,
    );

    const max = rows[0]?.[key] || 1;
    const fragment = document.createDocumentFragment();
    rows.forEach((row, index) => {
        const item = document.createElement('div');
        item.className = 'csf_row';
        item.setAttribute('role', 'button');
        item.tabIndex = 0;
        item.dataset.avatar = row.avatar;

        const rank = document.createElement('div');
        rank.className = 'csf_rank';
        rank.textContent = String(index + 1);

        const main = document.createElement('div');
        main.className = 'csf_main';
        const name = document.createElement('div');
        name.className = 'csf_name';
        name.textContent = row.name;
        const detail = document.createElement('div');
        detail.className = 'csf_detail';
        detail.textContent = `card ${formatBytes(row.imageBytes)} · chats ${formatBytes(row.chatBytes)}`;
        main.append(name, detail);

        const total = document.createElement('div');
        total.className = 'csf_total';
        total.textContent = formatBytes(row[key]);

        const bar = document.createElement('div');
        bar.className = 'csf_bar';
        bar.style.width = `${Math.max(1, Math.round(((row[key] || 0) / max) * 100))}%`;

        item.append(rank, main, total, bar);
        fragment.append(item);
    });
    list.append(fragment);
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
    let next = 0;
    let done = 0;
    let failed = 0;
    setStatus(root, `Scanning… 0 / ${characters.length}`);

    async function worker() {
        while (!stopRequested) {
            const index = next++;
            if (index >= characters.length) return;
            const character = characters[index];
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
                setStatus(root, `Scanning… ${done} / ${characters.length}`);
            }
        }
    }

    try {
        const workers = Array.from({ length: Math.min(CONCURRENCY, characters.length) }, () => worker());
        await Promise.all(workers);
    } finally {
        results = found.filter(Boolean);
        setScanning(root, false);
    }

    let status = stopRequested
        ? `Stopped after ${done} of ${characters.length} characters.`
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

function onActivate(element, handler) {
    element.addEventListener('click', handler);
    element.addEventListener('keydown', (event) => {
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
