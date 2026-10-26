import {
    Plugin,
    Menu,
    showMessage,
    fetchSyncPost,
    openTab,
    getAllEditor,
    adaptHotkey,
} from "siyuan";
import type { IProtyle } from "siyuan";
import "./index.scss";

type TeamComment = {
    author: string;
    text: string;
    quote: string;
    createdAt: number;
    updatedAt?: number;
};

type TeamReply = {
    parent: string;
    // When set, this reply answers another reply instead of the comment itself.
    replyTo?: string;
    author: string;
    text: string;
    createdAt: number;
    updatedAt?: number;
};

type Resolution = {
    by: string;
    at: number;
};

type StoredCommentJson = TeamComment & {
    blockId: string;
    replies: Record<string, TeamReply>;
    resolution?: Resolution | null;
};

type Store = {
    v: number;
    comments: Record<string, StoredCommentJson>;
};

// UI shapes: the same records, flattened for rendering.
type StoredReply = {
    key: string;
    blockId: string;
    reply: TeamReply;
};

type StoredComment = {
    key: string;
    blockId: string;
    comment: TeamComment;
    replies: StoredReply[];
    resolution?: Resolution;
    index?: number;
};

type AttrRow = {
    block_id: string;
    name: string;
    value: string;
};

// Every restorable field carries a stable data-draft name, so a re-render can put
// half-typed text (and the caret) back exactly where it was.
type Draft = {
    fields: Record<string, string>;
    focused: string;
    selection?: {selector: string; start: number; end: number};
};

// All comments of a document live in ONE attribute on the document block. Reading
// the SQL "attributes" table instead was wrong: the index only picks a write up
// several seconds later, so comments vanished on refresh and replies never showed.
const STORE_KEY = "custom-comments";
// Older versions stored one attribute per entry; they are folded in once.
const KEY_PREFIX = "custom-cmt-";
const REPLY_PREFIX = "custom-cmtr-";
const RESOLVED_PREFIX = "custom-cmtres-";
const AUTHOR_KEY = "extended-comments:author";
// the plugin used to live under another name; keep reading the old key so a
// signature saved before the rename still shows up
const LEGACY_AUTHOR_KEY = "team-comment:author";
const DOCK_TYPE = "dock_extended_comments";
const MARK_LAYER_ID = "tc-mark-layer";
// A text range's client rect ends on the line box, so drawing the mark right at
// `bottom` clips the descenders. Drop it by a slice of the line height instead,
// which keeps the same visual gap from small text up to headings.
const MARK_GAP_RATIO = 0.12;
const MARK_MIN_GAP = 1;
const STORE_VERSION = 1;

// The SDK types i18n values as JSONValue; every message we use here is a plain string.
const t = (plugin: Plugin): Record<string, string> =>
    (plugin as unknown as {i18n: Record<string, string>}).i18n;

async function api<T>(url: string, data: unknown): Promise<T> {
    const response = await fetchSyncPost(url, data);
    if (response.code !== 0) {
        throw new Error(response.msg || String(response.code));
    }
    return response.data as T;
}

const readAttrs = async (blockId: string): Promise<Record<string, string>> =>
    (await api<Record<string, string>>("/api/attr/getBlockAttrs", {id: blockId})) ?? {};

const writeAttrs = (blockId: string, attrs: Record<string, string>): Promise<void> =>
    api("/api/attr/setBlockAttrs", {id: blockId, attrs});

const newKey = (prefix: string): string =>
    `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// Avatars and relative timestamps: the two things every mature comment UI has.
const initialsHue = (author: string): number => {
    let hash = 0;
    for (let index = 0; index < author.length; index++) {
        hash = (hash * 31 + author.charCodeAt(index)) % 360;
    }
    return hash;
};

const initialsOf = (author: string): string => {
    const trimmed = (author || "").trim();
    if (!trimmed) {
        return "?";
    }
    if (/^[a-zA-Z]/.test(trimmed)) {
        const parts = trimmed.split(/\s+/).filter((part) => Boolean(part));
        return parts.length > 1
            ? (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase()
            : trimmed.slice(0, 2).toUpperCase();
    }
    return trimmed.slice(0, 1);
};

const fullTime = (ts: number): string => new Date(ts).toLocaleString();

const pad2 = (value: number): string => (value < 10 ? "0" + value : String(value));

const sameDay = (left: Date, right: Date): boolean =>
    left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();

// Lark-style stamp: "just now" / "12 min ago" / "Today 14:32" / "Yesterday 09:05".
const relativeTime = (ts: number, i18n: Record<string, string>): string => {
    const date = new Date(ts);
    const clock = pad2(date.getHours()) + ":" + pad2(date.getMinutes());
    const diff = Date.now() - ts;
    if (diff < 60000) {
        return i18n.justNow || clock;
    }
    if (diff < 3600000) {
        return (i18n.minutesAgo || "{n}").replace("{n}", String(Math.floor(diff / 60000)));
    }
    const today = new Date();
    if (sameDay(date, today)) {
        return (i18n.todayAt || "{time}").replace("{time}", clock);
    }
    if (sameDay(date, new Date(today.getTime() - 86400000))) {
        return (i18n.yesterdayAt || "{time}").replace("{time}", clock);
    }
    return date.getFullYear() + "-" + pad2(date.getMonth() + 1) + "-" + pad2(date.getDate()) + " " + clock;
};

const emptyStore = (): Store => ({v: STORE_VERSION, comments: {}});

// Read comments written by an older version (one attribute per entry) so nothing is
// lost; the next write persists them into the document store.
async function migrateLegacy(rootId: string): Promise<Store> {
    const store = emptyStore();
    const stmt = `SELECT block_id, name, value FROM attributes WHERE root_id = '${rootId}' AND (name LIKE 'custom-cmt-%' OR name LIKE 'custom-cmtr-%' OR name LIKE 'custom-cmtres-%')`;
    let rows: AttrRow[] = [];
    try {
        rows = await api<AttrRow[]>("/api/query/sql", {stmt});
    } catch {
        return store;
    }
    const resolutions = new Map<string, Resolution>();
    const replies: AttrRow[] = [];
    for (const row of rows) {
        try {
            if (row.name.startsWith(RESOLVED_PREFIX)) {
                resolutions.set(row.name.slice(RESOLVED_PREFIX.length), JSON.parse(row.value) as Resolution);
            } else if (row.name.startsWith(REPLY_PREFIX)) {
                replies.push(row);
            } else if (row.name.startsWith(KEY_PREFIX)) {
                const comment = JSON.parse(row.value) as TeamComment;
                store.comments[row.name] = {
                    author: comment.author ?? "",
                    text: comment.text ?? "",
                    quote: comment.quote ?? "",
                    createdAt: comment.createdAt ?? Date.now(),
                    updatedAt: comment.updatedAt,
                    blockId: row.block_id,
                    replies: {},
                };
            }
        } catch {
            // Malformed legacy entries are skipped rather than breaking the panel.
        }
    }
    for (const row of replies) {
        try {
            const reply = JSON.parse(row.value) as TeamReply;
            const comment = store.comments[reply.parent];
            if (comment) {
                comment.replies[row.name] = reply;
            }
        } catch {
            // Ignore unreadable replies.
        }
    }
    resolutions.forEach((resolution, key) => {
        const comment = store.comments[key];
        if (comment) {
            comment.resolution = resolution;
        }
    });
    return store;
}

async function readStore(rootId: string): Promise<Store> {
    const raw = (await readAttrs(rootId))[STORE_KEY];
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as Store;
            if (parsed && typeof parsed === "object" && parsed.comments && typeof parsed.comments === "object") {
                return {v: STORE_VERSION, comments: parsed.comments};
            }
        } catch {
            // Corrupt payload: fall through to the legacy path.
        }
    }
    return migrateLegacy(rootId);
}

// Read-modify-write of the document store: a write is visible to the very next
// read, so the panel never has to guess what the server has.
async function mutateStore(rootId: string, change: (store: Store) => void): Promise<void> {
    const store = await readStore(rootId);
    change(store);
    await writeAttrs(rootId, {[STORE_KEY]: JSON.stringify(store)});
}

const toThreads = (store: Store): StoredComment[] => {
    const comments = store.comments ?? {};
    return Object.keys(comments)
        .map((key): StoredComment => {
            const comment = comments[key];
            const replies = comment.replies ?? {};
            return {
                key,
                blockId: comment.blockId,
                comment: {
                    author: comment.author,
                    text: comment.text,
                    quote: comment.quote,
                    createdAt: comment.createdAt,
                    updatedAt: comment.updatedAt,
                },
                replies: Object.keys(replies)
                    .map((replyKey): StoredReply => ({key: replyKey, blockId: comment.blockId, reply: replies[replyKey]}))
                    .sort((a, b) => a.reply.createdAt - b.reply.createdAt),
                resolution: comment.resolution ?? undefined,
            };
        })
        .sort((a, b) => a.comment.createdAt - b.comment.createdAt);
};

const listThreads = async (rootId: string): Promise<StoredComment[]> => toThreads(await readStore(rootId));

const esc = (value: string): string => value.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
}[ch] ?? ch));

const readAuthor = (): string =>
    localStorage.getItem(AUTHOR_KEY) ?? localStorage.getItem(LEGACY_AUTHOR_KEY) ?? "";

// The selection toolbar and the context menu both hand us a DOM Range, never a
// block id: walk up to the nearest element that owns a node id.
const blockIdFromRange = (range?: Range | null): string => {
    let node: Node | null = range?.startContainer ?? null;
    while (node) {
        const element = node instanceof HTMLElement ? node : node.parentElement;
        const id = element?.getAttribute?.("data-node-id");
        if (id) {
            return id;
        }
        node = element?.parentElement ?? null;
    }
    return "";
};

// Locate the quoted text inside a block by walking its text nodes; comments are
// block-level, so the anchor is the stored quote rather than an inline mark.
const findQuoteRange = (blockEl: HTMLElement, quote: string): Range | null => {
    const target = quote.trim();
    if (!target) {
        return null;
    }
    const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let full = "";
    let node = walker.nextNode() as Text | null;
    while (node) {
        nodes.push(node);
        full += node.data;
        node = walker.nextNode() as Text | null;
    }
    let index = full.indexOf(target);
    let length = target.length;
    if (index < 0) {
        const newline = target.indexOf("\n");
        const firstLine = (newline >= 0 ? target.slice(0, newline) : target).trim();
        if (firstLine && firstLine !== target) {
            index = full.indexOf(firstLine);
            length = firstLine.length;
        }
    }
    if (index < 0) {
        return null;
    }
    let startNode: Text | null = null;
    let startOffset = 0;
    let endNode: Text | null = null;
    let endOffset = 0;
    let acc = 0;
    for (const item of nodes) {
        const next = acc + item.data.length;
        if (!startNode && index < next) {
            startNode = item;
            startOffset = index - acc;
        }
        if (startNode && index + length <= next) {
            endNode = item;
            endOffset = index + length - acc;
            break;
        }
        acc = next;
    }
    if (!startNode || !endNode) {
        return null;
    }
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
};

// The dock tab panel outlives a plugin reload (disable/enable), so the delegated
// listeners are attached once and always dispatch to the live instance.
const PLUGIN_KEY = "__extendedCommentsPlugin";

const setCurrentPlugin = (plugin: TeamCommentPlugin | null) => {
    const holder = window as unknown as Record<string, unknown>;
    if (plugin) {
        holder[PLUGIN_KEY] = plugin;
    } else {
        delete holder[PLUGIN_KEY];
    }
};

const currentPlugin = (): TeamCommentPlugin | undefined =>
    (window as unknown as Record<string, TeamCommentPlugin | undefined>)[PLUGIN_KEY];

export default class TeamCommentPlugin extends Plugin {
    private dockElement?: HTMLElement;
    private inputTimer?: number;
    private markLayer?: HTMLElement;
    private rafId = 0;
    private pending: {blockId: string; quote: string} | null = null;
    private replying: {key: string; blockId: string} | null = null;
    private editing: {key: string; blockId: string} | null = null;
    private editingReply: string | null = null;
    private authorEditing = false;
    private showResolved = false;
    private threads: StoredComment[] = [];
    private lastRootId = "";
    private marks: {key: string; blockId: string; quote: string}[] = [];
    private activeCard?: HTMLElement;
    private activeKey = "";
    private lastScrollTop = -1;
    private flash?: {blockId: string; until: number};
    private orderMap = new Map<string, number>();
    private orderRootId = "";

    onload() {
        setCurrentPlugin(this);
        // Register our own symbol first: no icon theme ships a comment glyph, and
        // without a matching <symbol> the toolbar and dock buttons render blank.
        this.addIcons(`<symbol id="iconTeamComment" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
<path d="M22 17a2 2 0 0 1-2 2H6l-4 4V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"></path>
<path d="M8 10h.01"></path>
<path d="M12 10h.01"></path>
<path d="M16 10h.01"></path>
</symbol>`);

        this.eventBus.on("open-menu-content", this.onOpenMenuContent);
        this.eventBus.on("switch-protyle", this.onSwitchProtyle);
        this.eventBus.on("click-editorcontent", this.onClickEditorContent);

        this.addDock({
            config: {
                position: "RightBottom",
                size: {width: 320, height: 0},
                icon: "iconTeamComment",
                title: t(this).dockTitle,
                hotkey: adaptHotkey("⌥⌘."),
            },
            data: {},
            type: DOCK_TYPE,
            init: (custom) => {
                this.dockElement = custom.element as HTMLElement;
                void this.renderDockSoft();
                this.refreshMarks();
            },
            resize: () => {
                void this.renderDockSoft();
            },
            destroy: () => {
                this.dockElement = undefined;
            },
        });

        this.registerToolbarItem();
        this.ensureMarkLayer();

        document.addEventListener("scroll", this.onViewportChange, true);
        window.addEventListener("resize", this.onViewportChange);
        document.addEventListener("input", this.onEditorInput, true);
    }

    onunload() {
        if (currentPlugin() === this) {
            setCurrentPlugin(null);
        }
        if (this.inputTimer) {
            window.clearTimeout(this.inputTimer);
        }
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
        }
        this.eventBus.off("open-menu-content", this.onOpenMenuContent);
        this.eventBus.off("switch-protyle", this.onSwitchProtyle);
        this.eventBus.off("click-editorcontent", this.onClickEditorContent);
        this.removeToolbarItem?.("extended-comments");
        document.removeEventListener("scroll", this.onViewportChange, true);
        window.removeEventListener("resize", this.onViewportChange);
        document.removeEventListener("input", this.onEditorInput, true);
        this.markLayer?.remove();
        this.markLayer = undefined;
    }

    private registerToolbarItem() {
        this.addToolbarItem?.({
            name: "extended-comments",
            icon: "iconTeamComment",
            tip: t(this).toolbarTip,
            tipPosition: "n",
            click: () => {
                const editor = this.activeEditor();
                const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
                const blockId = blockIdFromRange(range) || this.activeRootId();
                if (!blockId) {
                    showMessage(t(this).noBlock);
                    return;
                }
                let quote = range?.toString() ?? "";
                if (!quote) {
                    quote = editor?.wysiwyg?.element?.textContent?.slice(0, 50) ?? "";
                }
                this.startCompose(blockId, quote);
            },
        });
    }

    private editors(): IProtyle[] {
        const list = getAllEditor() as unknown as Array<{protyle?: IProtyle} | IProtyle>;
        return list.map((entry) => (entry as {protyle?: IProtyle})?.protyle ?? (entry as IProtyle));
    }

    private activeEditor(): IProtyle | undefined {
        return this.editors()[0];
    }

    // The document id lives on the Protyle instance; the wysiwyg element does not
    // reliably carry data-node-id, so the DOM is only a fallback.
    private rootIdOf(protyle: IProtyle | undefined): string {
        if (!protyle) {
            return "";
        }
        const block = (protyle as unknown as {block?: {rootID?: string; id?: string}}).block;
        if (block?.rootID) {
            return block.rootID;
        }
        const fromWysiwyg = protyle.wysiwyg?.element?.getAttribute("data-node-id") ?? "";
        if (fromWysiwyg) {
            return fromWysiwyg;
        }
        const title = (protyle as unknown as {title?: {element?: HTMLElement}}).title;
        const fromTitle = title?.element?.getAttribute("data-node-id") ?? "";
        return fromTitle || block?.id || "";
    }

    private activeRootId(): string {
        const editors = this.editors();
        const visible = editors.filter((editor) => {
            const element = editor?.wysiwyg?.element;
            if (!element) {
                return false;
            }
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
        for (const editor of visible.concat(editors.filter((item) => visible.indexOf(item) < 0))) {
            const id = this.rootIdOf(editor);
            if (id) {
                // Remember it: when the dock panel holds focus the editor lookup can come
                // back empty, and blanking the list (or the underlines) is not acceptable.
                this.lastRootId = id;
                return id;
            }
        }
        for (const selector of [".layout__wnd--active .protyle-wysiwyg", ".protyle-wysiwyg", ".protyle-title"]) {
            const id = document.querySelector(selector)?.getAttribute("data-node-id") ?? "";
            if (id) {
                this.lastRootId = id;
                return id;
            }
        }
        return this.lastRootId;
    }

    // Any block in the open editor tells the kernel which document it belongs to.
    private async rootIdFromVisibleBlock(): Promise<string> {
        const blockId = document.querySelector(".protyle-wysiwyg [data-node-id]")?.getAttribute("data-node-id") ?? "";
        return blockId ? this.rootIdForBlock(blockId) : "";
    }

    // Last resort for a write: ask the kernel which document a known block lives in.
    private async rootIdForBlock(blockId: string): Promise<string> {
        try {
            const info = await api<{rootID?: string}>("/api/block/getBlockInfo", {id: blockId});
            const id = info?.rootID ?? "";
            if (id) {
                this.lastRootId = id;
            }
            return id;
        } catch (error) {
            console.warn("[extended-comments] cannot resolve the document of block " + blockId, error);
            return "";
        }
    }

    private onOpenMenuContent = (event: CustomEvent<{menu: Menu; range: Range}>) => {
        const blockId = blockIdFromRange(event.detail.range);
        if (!blockId) {
            return;
        }
        event.detail.menu.addItem({
            icon: "iconTeamComment",
            label: t(this).addComment,
            click: () => this.startCompose(blockId, event.detail.range.toString()),
        });
    };

    private onSwitchProtyle = () => {
        this.scheduleMarks();
        this.lastScrollTop = -1;
        this.activeCard = undefined;
        this.activeKey = "";
        // Follow the document the user just switched to.
        void this.renderDockSoft();
    };

    private onClickEditorContent = () => {
        if (this.pending) {
            this.scheduleMarks();
        }
    };

    private onViewportChange = () => {
        this.scheduleMarks();
    };

    private onEditorInput = () => {
        if (this.inputTimer) {
            window.clearTimeout(this.inputTimer);
        }
        this.inputTimer = window.setTimeout(() => {
            this.refreshMarks();
        }, 600);
    };

    private ensureMarkLayer() {
        if (this.markLayer?.isConnected) {
            return;
        }
        this.markLayer = document.createElement("div");
        this.markLayer.id = MARK_LAYER_ID;
        this.markLayer.className = "tc-mark-layer";
        document.body.appendChild(this.markLayer);
    }

    private scheduleMarks() {
        if (this.rafId) {
            return;
        }
        this.rafId = requestAnimationFrame(() => {
            this.rafId = 0;
            this.drawMarks();
        });
    }

    private drawMarks() {
        this.ensureMarkLayer();
        if (!this.markLayer) {
            return;
        }
        this.markLayer.innerHTML = "";
        for (const mark of this.marks) {
            const blockEl = document.querySelector<HTMLElement>(`[data-node-id="${mark.blockId}"]`);
            if (!blockEl) {
                continue;
            }
            const range = findQuoteRange(blockEl, mark.quote) ?? (() => {
                const whole = document.createRange();
                whole.selectNodeContents(blockEl);
                return whole;
            })();
            for (const rect of Array.from(range.getClientRects())) {
                if (rect.width <= 0 || rect.height <= 0) {
                    continue;
                }
                const line = document.createElement("div");
                line.className = this.flash?.blockId === mark.blockId && Date.now() < this.flash.until
                    ? "tc-mark tc-mark--flash"
                    : "tc-mark";
                line.dataset.block = mark.blockId;
                line.style.left = `${rect.left}px`;
                line.style.top = `${rect.bottom + Math.max(MARK_MIN_GAP, Math.round(rect.height * MARK_GAP_RATIO))}px`;
                line.style.width = `${rect.width}px`;
                this.markLayer.appendChild(line);
            }
        }
    }

    // Reading is a single attribute lookup on the document block, so it always
    // reflects the latest write instead of waiting for the SQL index.
    private async reloadThreads() {
        let rootId = this.activeRootId();
        if (!rootId && this.pending?.blockId) {
            rootId = await this.rootIdForBlock(this.pending.blockId);
        }
        if (!rootId) {
            rootId = await this.rootIdFromVisibleBlock();
        }
        if (!rootId) {
            return;
        }
        try {
            const threads = await listThreads(rootId);
            if (rootId === this.activeRootId()) {
                this.threads = threads;
                this.syncMarks();
            }
        } catch (error) {
            console.warn("[extended-comments] failed to load comments", error);
        }
    }

    private async refreshMarks() {
        if (!this.activeRootId() && !this.pending?.blockId) {
            this.marks = [];
            this.scheduleMarks();
            return;
        }
        await this.reloadThreads();
    }

    // Resolved comments keep their history but lose their underline.
    private syncMarks() {
        this.marks = this.threads
            .filter((item) => !item.resolution)
            .map((item) => ({key: item.key, blockId: item.blockId, quote: item.comment.quote}));
        this.scheduleMarks();
    }

    private startCompose(blockId: string, quote: string) {
        this.pending = {blockId, quote: quote.slice(0, 200)};
        this.authorEditing = false;
        this.editing = null;
        this.replying = null;
        this.openDock();
        // The dock panel is created a tick after the click, so render now and again
        // until the input really exists on screen, then put the caret in it.
        this.renderComposeUntilVisible(0);
        this.scheduleMarks();
    }

    private renderComposeUntilVisible(attempt: number) {
        void this.renderDock().then(() => {
            const textarea = this.panelElement()?.querySelector<HTMLTextAreaElement>(".tc-text");
            if (textarea) {
                this.focusSoon(".tc-text");
                return;
            }
            if (attempt < 20) {
                // The first dock click can race with layout creation; nudge it again.
                if (attempt % 5 === 2) {
                    this.openDock();
                }
                setTimeout(() => this.renderComposeUntilVisible(attempt + 1), 150);
                return;
            }
            console.warn("[extended-comments] compose panel never became visible", {
                dockElement: Boolean(this.dockElement?.isConnected),
                panels: document.querySelectorAll(".tc-panel").length,
                pending: Boolean(this.pending),
            });
        });
    }

    // Focus is lost while the dock finishes expanding, so keep it and restore the
    // caret at the end of the text until the user focuses something else on purpose.
    private focusSoon(selector: string, attempt = 0) {
        const element = this.panelElement()?.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
        if (element) {
            // Clicking the toolbar leaves the caret in the editor, so take it back
            // for the next few hundred milliseconds: the user asked for this input.
            if (document.activeElement !== element) {
                element.focus();
                if (element instanceof HTMLTextAreaElement) {
                    element.setSelectionRange(element.value.length, element.value.length);
                }
            }
            if (attempt >= 3) {
                return;
            }
        } else if (attempt >= 8) {
            return;
        }
        setTimeout(() => this.focusSoon(selector, attempt + 1), 100 + attempt * 80);
    }

    // Prefer the live DOM: our own rendered panel is the source of truth, so a stale
    // or missing dockElement reference never blocks an update.
    private panelElement(): HTMLElement | undefined {
        const panels = Array.from(document.querySelectorAll<HTMLElement>(".tc-panel"));
        const visible = panels.find((panel) => panel.offsetWidth > 0 || panel.offsetHeight > 0) ?? panels[0];
        if (visible?.parentElement) {
            this.dockElement = visible.parentElement as HTMLElement;
            return this.dockElement;
        }
        // No content of ours yet: resolve the dock tab panel from the tab id that
        // SiYuan stores on both the dock button and the tab panel (data-id).
        const id = this.dockButton()?.getAttribute("data-id");
        if (id) {
            const panel = Array.from(document.querySelectorAll<HTMLElement>(`[data-id="${id}"]`))
                .find((el) => el.classList.contains("fn__flex-1") || Boolean(el.closest(".layout-tab-container")));
            if (panel) {
                this.dockElement = panel;
                return panel;
            }
        }
        if (this.dockElement?.isConnected) {
            return this.dockElement;
        }
        return undefined;
    }

    // SiYuan registers a plugin dock under "<pluginName><type>", so the dock button's
    // data-type is prefixed with the plugin name rather than being the bare type.
    private dockType(): string {
        return `${this.name}${DOCK_TYPE}`;
    }

    private dockButton(): HTMLElement | null {
        const exact = document.querySelector<HTMLElement>(`.dock__item[data-type="${this.dockType()}"]`);
        if (exact) {
            return exact;
        }
        return document.querySelector<HTMLElement>(`.dock__item[data-type$="${DOCK_TYPE}"]`);
    }

    private openDock() {
        interface DockLike {
            elements?: HTMLElement[];
            panelVisible?: boolean;
            toggleModel?: (type: string, show?: boolean, close?: boolean) => void;
        }
        const layout = (window as unknown as {
            siyuan?: {layout?: {leftDock?: DockLike; rightDock?: DockLike; bottomDock?: DockLike}};
        }).siyuan?.layout;
        const docks = [layout?.leftDock, layout?.rightDock, layout?.bottomDock].filter(Boolean) as DockLike[];
        const item = this.dockButton();
        if (!item) {
            console.warn("[extended-comments] dock button not found", Array.from(document.querySelectorAll(".dock__item"))
                .map((el) => el.getAttribute("data-type")));
            return;
        }
        // Judge by real layout size: the button can stay "active" while the panel is
        // collapsed, and an empty tab panel is still measurable.
        const panel = this.panelElement();
        if (panel && panel.offsetWidth > 0 && panel.offsetHeight > 0) {
            return;
        }
        const host = docks.find((dock) => (dock.elements ?? []).some((element) => element?.contains(item)));
        if (host?.toggleModel) {
            // Same call as clicking the dock button, without depending on event dispatch.
            host.toggleModel(item.getAttribute("data-type") ?? this.dockType());
            return;
        }
        item.click();
    }

    private async renderDock(refetch = true) {
        const element = this.panelElement();
        if (!element) {
            return;
        }
        // Re-rendering replaces the inner HTML, which would drop half-typed text.
        const draft = this.captureDraft(element);
        if (refetch) {
            const rootId = this.activeRootId();
            if (rootId) {
                await this.reloadThreads();
            }
            // No active document: keep what we have instead of blanking the list.
        }
        // Ordering only matters once there is more than one comment to compare.
        await this.ensureBlockOrder(this.threads.length > 1 ? this.activeRootId() : "");
        // The cards are rebuilt, so the old highlight is gone, but the list must stay
        // where the reader left it instead of snapping back to the first comment.
        const list = element.querySelector<HTMLElement>(".tc-list");
        const listScroll = list?.scrollTop ?? 0;
        this.activeCard = undefined;
        this.lastScrollTop = -1;
        element.innerHTML = this.panelHtml(readAuthor());
        const nextList = element.querySelector<HTMLElement>(".tc-list");
        if (nextList) {
            // A new comment is written at the top of the list, so show the form.
            nextList.scrollTop = this.pending ? 0 : listScroll;
            // Keep the selected comment selected, but never move the list here.
            const card = this.activeKey
                ? nextList.querySelector<HTMLElement>(`.tc-item[data-key="${this.activeKey}"]`)
                : null;
            if (card) {
                card.classList.add("tc-item--active");
                this.activeCard = card;
            }
        }
        this.restoreDraft(element, draft);
        this.wirePanel(element);
    }

    // Background refreshes must not rebuild a form the user is typing in.
    private renderDockSoft(): Promise<void> {
        const active = document.activeElement as HTMLElement | null;
        if (active?.matches?.("textarea, input") && active.closest(".tc-panel")) {
            return Promise.resolve();
        }
        return this.renderDock();
    }

    private captureDraft(element: HTMLElement): Draft {
        const fields: Record<string, string> = {};
        element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-draft]").forEach((field) => {
            const name = field.getAttribute("data-draft") ?? "";
            if (name && field.value) {
                fields[name] = field.value;
            }
        });
        const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
        const focused = active && element.contains(active) ? active.getAttribute("data-draft") ?? "" : "";
        const selection = focused && typeof active?.selectionStart === "number"
            ? {
                selector: `[data-draft="${focused}"]`,
                start: active.selectionStart,
                end: active.selectionEnd ?? active.selectionStart,
            }
            : undefined;
        return {fields, focused, selection};
    }

    private restoreDraft(element: HTMLElement, draft: Draft) {
        Object.keys(draft.fields).forEach((name) => {
            const field = element.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-draft="${name}"]`);
            if (field) {
                field.value = draft.fields[name];
            }
        });
        if (draft.selection) {
            // Put the caret back where it was rather than at the end of the text.
            const field = element.querySelector<HTMLTextAreaElement | HTMLInputElement>(draft.selection.selector);
            if (field) {
                field.focus();
                field.setSelectionRange(draft.selection.start, draft.selection.end);
            }
        } else if (draft.focused) {
            element.querySelector<HTMLElement>(`[data-draft="${draft.focused}"]`)?.focus();
        }
    }

    private panelHtml(author: string): string {
        const i18n = t(this);
        const ordered = this.orderedThreads();
        const visible = this.showResolved ? ordered : ordered.filter((item) => !item.resolution);
        const resolvedCount = this.threads.length - ordered.filter((item) => !item.resolution).length;
        const list = visible.length
            ? visible.map((item, index) => this.itemHtml(item, author, index)).join("")
            : `<div class="tc-empty">${esc(i18n.noComments)}</div>`;
        const toggle = resolvedCount > 0
            ? `<div class="tc-show-resolved"><button class="b3-button b3-button--small" data-action="toggle-resolved">` +
                esc(this.showResolved ? i18n.hideResolved : i18n.showResolved + " (" + resolvedCount + ")") +
                `</button></div>`
            : "";
        return `<div class="tc-panel">
    <div class="tc-toolbar">
        <span class="tc-toolbar-title">${esc(i18n.dockTitle)}</span>
        <span class="fn__space"></span>
        <button class="b3-button b3-button--small" data-action="first" title="${esc(i18n.jumpFirst || "首条评论")}">${esc(i18n.jumpFirst || "首条评论")}</button>
        <button class="b3-button b3-button--small" data-action="author">${esc(i18n.setAuthor)}</button>
        <button class="b3-button b3-button--small" data-action="refresh">${esc(i18n.refresh)}</button>
    </div>
    ${this.authorHtml(author)}
    ${this.composeHtml(author)}
    <div class="tc-list">${list}</div>
    ${toggle}
</div>`;
    }

    private avatarHtml(author: string): string {
        return `<span class="tc-avatar" style="--tc-avatar-hue:${initialsHue(author)}">${esc(initialsOf(author))}</span>`;
    }

    private authorHtml(author: string): string {
        if (!this.authorEditing) {
            return "";
        }
        const i18n = t(this);
        return `<div class="tc-compose">
    <div class="tc-compose-head">${esc(i18n.authorName)}</div>
    <input class="b3-text-field fn__block tc-author-input" data-draft="author" value="${esc(author)}" placeholder="${esc(i18n.authorPlaceholder)}">
    <div class="tc-compose-actions">
        <button class="b3-button b3-button--cancel" data-action="author-cancel">${esc(i18n.cancel)}</button>
        <button class="b3-button b3-button--text" data-action="author-save">${esc(i18n.save)}</button>
    </div>
</div>`;
    }

    private composeHtml(author: string): string {
        const pending = this.pending;
        if (!pending) {
            return "";
        }
        const i18n = t(this);
        const quote = pending.quote ? `<div class="tc-quote">${esc(pending.quote)}</div>` : "";
        const authorField = author
            ? ""
            : `<input class="b3-text-field fn__block tc-author-inline" data-draft="inline-author" placeholder="${esc(i18n.authorPlaceholder)}">`;
        return `<div class="tc-compose">
    ${quote}
    ${authorField}
    <textarea class="b3-text-field fn__block tc-text" data-draft="compose" placeholder="${esc(i18n.commentPlaceholder)}"></textarea>
    <div class="tc-compose-actions">
        <button class="b3-button b3-button--cancel" data-action="compose-cancel">${esc(i18n.cancel)}</button>
        <button class="b3-button b3-button--text" data-action="compose-save">${esc(i18n.save)}</button>
    </div>
</div>`;
    }

    private itemHtml(item: StoredComment, author: string, index: number): string {
        const i18n = t(this);
        const mine = item.comment.author === author;
        const editing = this.editing?.key === item.key;
        const resolved = Boolean(item.resolution);
        const quote = item.comment.quote
            ? `<div class="tc-item-quote" data-action="jump" data-key="${esc(item.key)}" title="${esc(i18n.jumpToText || "")}">${esc(item.comment.quote)}</div>`
            : "";
        const body = editing
            ? `<textarea class="b3-text-field fn__block tc-edit-text" data-draft="comment-edit">${esc(item.comment.text)}</textarea>
        <div class="tc-compose-actions">
            <button class="b3-button b3-button--cancel" data-action="edit-cancel">${esc(i18n.cancel)}</button>
            <button class="b3-button b3-button--text" data-action="edit-save" data-key="${esc(item.key)}">${esc(i18n.save)}</button>
        </div>`
            : `<div class="tc-item-text">${esc(item.comment.text)}</div>`;
        // Resolving covers the whole card (the comment and everything under it), so it
        // lives on the card itself rather than among the per-entry actions.
        const resolve = resolved
            ? `<button class="b3-button b3-button--small" data-action="unresolve" data-key="${esc(item.key)}">${esc(i18n.unresolve)}</button>`
            : `<button class="b3-button b3-button--small" data-action="resolve" data-key="${esc(item.key)}">${esc(i18n.resolveHide)}</button>`;
        const actions = `<div class="tc-item-actions">
        <button class="b3-button b3-button--small" data-action="reply" data-key="${esc(item.key)}">${esc(i18n.reply)}</button>
        <button class="b3-button b3-button--small" data-action="jump" data-key="${esc(item.key)}">${esc(i18n.locate || "定位")}</button>
        ${mine && !editing && !resolved
            ? `<button class="b3-button b3-button--small" data-action="edit" data-key="${esc(item.key)}">${esc(i18n.edit)}</button>`
            : ""}
        ${mine
            ? `<button class="b3-button b3-button--small" data-action="delete" data-key="${esc(item.key)}">${esc(i18n.delete)}</button>`
            : ""}
    </div>`;
        const replies = this.threadReplies(item.replies, item.key);
        const repliesHtml = replies.length
            ? `<div class="tc-replies">${replies.map((reply) => this.replyHtml(reply, author, replies, !resolved)).join("")}</div>`
            : "";
        // A resolved thread is closed: reopen it to reply or edit again.
        const footer = resolved
            ? `<div class="tc-locked">${esc(i18n.resolvedLocked)}</div>`
            : this.replyBoxHtml(item.key, item.blockId);
        return `<div class="tc-card tc-item${resolved ? " tc-item--resolved" : ""}" data-key="${esc(item.key)}" data-block="${esc(item.blockId)}" data-index="${index}">
    <div class="tc-card-head">
        <span class="tc-item-who">
            ${this.avatarHtml(item.comment.author)}
            <span class="tc-item-author">${esc(item.comment.author)}</span>
            <span class="tc-item-time" title="${esc(fullTime(item.comment.createdAt))}">${esc(relativeTime(item.comment.createdAt, i18n))}</span>
            ${item.comment.updatedAt ? `<span class="tc-item-edited">${esc(i18n.edited)}</span>` : ""}
            ${resolved ? `<span class="tc-resolved-tag">${esc(i18n.resolved)}</span>` : ""}
        </span>
        <div class="tc-card-tools">${resolve}</div>
    </div>
    ${quote}
    ${body}
    ${actions}
    ${repliesHtml}
    ${footer}
</div>`;
    }

    // Mature comment systems keep one flat list of replies per thread and express
    // "an answer to an answer" as "Reply @name", which stays readable at any depth.
    private threadReplies(replies: StoredReply[], commentKey: string): StoredReply[] {
        return replies.filter((reply) => reply.reply.parent === commentKey);
    }

    private childReplies(replies: StoredReply[], replyKey: string): StoredReply[] {
        return replies.filter((reply) => reply.reply.replyTo === replyKey);
    }

    // The composer is only shown once the user asks for it: a quiet "Reply…" row
    // keeps the list compact, exactly like Lark and Figma.
    private replyBoxHtml(commentKey: string, blockId: string): string {
        const i18n = t(this);
        const targeting = this.replying
            ? this.replying.key === commentKey || this.findReply(this.replying.key)?.reply.parent === commentKey
            : false;
        if (!targeting) {
            return `<div class="tc-reply-open" data-action="reply" data-key="${esc(commentKey)}">${esc(i18n.replyPlaceholder)}</div>`;
        }
        const answered = this.replying && this.replying.key !== commentKey ? this.findReply(this.replying.key) : undefined;
        const chip = answered
            ? `<div class="tc-reply-chip">
            <span class="tc-reply-to">${esc(i18n.replyTo)} @${esc(answered.reply.author)}</span>
            <button class="tc-chip-close" data-action="reply-clear" data-key="${esc(commentKey)}" title="${esc(i18n.cancel)}">✕</button>
        </div>`
            : "";
        return `<div class="tc-reply-box" data-block="${esc(blockId)}">
        ${chip}
        <textarea class="b3-text-field fn__block tc-reply-text" data-draft="reply:${esc(commentKey)}" placeholder="${esc(i18n.replyPlaceholder)}"></textarea>
        <div class="tc-compose-actions">
            <button class="b3-button b3-button--cancel" data-action="reply-cancel">${esc(i18n.cancel)}</button>
            <button class="b3-button b3-button--text" data-action="reply-save" data-key="${esc(commentKey)}">${esc(i18n.save)}</button>
        </div>
    </div>`;
    }

    // A reply is an entry like any other: its author can edit and delete it, and
    // anyone can answer it.
    private replyHtml(reply: StoredReply, author: string, all: StoredReply[], open: boolean): string {
        const i18n = t(this);
        const mine = reply.reply.author === author;
        const editing = this.editingReply === reply.key;
        const answered = reply.reply.replyTo ? all.find((entry) => entry.key === reply.reply.replyTo) : undefined;
        const target = answered
            ? `<span class="tc-reply-target">${esc(i18n.replyTo)} @${esc(answered.reply.author)}</span>`
            : "";
        const body = editing
            ? `<textarea class="b3-text-field fn__block tc-reply-edit-text" data-draft="reply-edit:${esc(reply.key)}">${esc(reply.reply.text)}</textarea>
        <div class="tc-compose-actions">
            <button class="b3-button b3-button--cancel" data-action="reply-edit-cancel">${esc(i18n.cancel)}</button>
            <button class="b3-button b3-button--text" data-action="reply-edit-save" data-key="${esc(reply.key)}">${esc(i18n.save)}</button>
        </div>`
            : `<div class="tc-reply-body">${target}${esc(reply.reply.text)}</div>`;
        return `<div class="tc-reply" data-key="${esc(reply.key)}">
    <div class="tc-card-head tc-reply-head">
        <span class="tc-item-who">
            ${this.avatarHtml(reply.reply.author)}
            <span class="tc-item-author">${esc(reply.reply.author)}</span>
            <span class="tc-item-time" title="${esc(fullTime(reply.reply.createdAt))}">${esc(relativeTime(reply.reply.createdAt, i18n))}</span>
            ${reply.reply.updatedAt ? `<span class="tc-item-edited">${esc(i18n.edited)}</span>` : ""}
        </span>
        <span class="tc-reply-actions">
            ${open ? `<button class="b3-button b3-button--small" data-action="reply" data-key="${esc(reply.key)}">${esc(i18n.reply)}</button>` : ""}
            ${mine && !editing
                ? `<button class="b3-button b3-button--small" data-action="reply-edit" data-key="${esc(reply.key)}">${esc(i18n.edit)}</button>`
                : ""}
            ${mine
                ? `<button class="b3-button b3-button--small" data-action="reply-delete" data-key="${esc(reply.key)}">${esc(i18n.delete)}</button>`
                : ""}
        </span>
    </div>
    ${body}
</div>`;
    }

    // One delegated listener per panel element: the inner HTML is rebuilt on every
    // render, so per-button listeners would be lost or duplicated.
    private wirePanel(element: HTMLElement) {
        if (element.dataset.tcWired === "1") {
            return;
        }
        element.dataset.tcWired = "1";
        element.addEventListener("click", (event) => {
            const plugin = currentPlugin();
            if (!plugin) {
                return;
            }
            const target = event.target as HTMLElement;
            const action = target.closest<HTMLElement>("[data-action]");
            if (action) {
                event.preventDefault();
                event.stopPropagation();
                void plugin.handleAction(action.dataset.action ?? "", action.dataset.key ?? "");
                return;
            }
            // Only the text jumps to the block: clicking into a textarea must keep
            // the caret there instead of opening the document and stealing focus.
            const item = target.closest<HTMLElement>(".tc-item");
            if (!item?.dataset.block || target.closest("textarea, input, button")) {
                return;
            }
            plugin.focusCard(item.dataset.key ?? "");
            void plugin.jumpToBlock(item.dataset.block);
        });
        element.addEventListener("keydown", (event) => {
            const plugin = currentPlugin();
            if (!plugin || (!event.ctrlKey && !event.metaKey) || event.key !== "Enter") {
                return;
            }
            const target = event.target as HTMLElement;
            if (target.classList.contains("tc-text")) {
                event.preventDefault();
                void plugin.saveCompose();
            } else if (target.classList.contains("tc-reply-text")) {
                event.preventDefault();
                void plugin.saveReply(target.closest<HTMLElement>(".tc-item")?.dataset.key ?? "");
            } else if (target.classList.contains("tc-edit-text")) {
                event.preventDefault();
                void plugin.saveEdit(target.closest<HTMLElement>(".tc-item")?.dataset.key ?? "");
            } else if (target.classList.contains("tc-reply-edit-text")) {
                event.preventDefault();
                void plugin.saveReplyEdit(target.closest<HTMLElement>(".tc-reply")?.dataset.key ?? "");
            }
        });
    }

    private async handleAction(action: string, key: string) {
        switch (action) {
            case "first":
                await this.jumpToFirst();
                return;
            case "author":
                this.authorEditing = true;
                await this.renderDock(false);
                this.focusSoon(".tc-author-input");
                return;
            case "author-cancel":
                this.authorEditing = false;
                await this.renderDock(false);
                return;
            case "author-save":
                this.saveAuthor();
                this.authorEditing = false;
                await this.renderDock(false);
                return;
            case "refresh":
                await this.renderDock();
                await this.refreshMarks();
                return;
            case "toggle-resolved":
                this.showResolved = !this.showResolved;
                await this.renderDock(false);
                return;
            case "compose-cancel":
                this.pending = null;
                await this.renderDock(false);
                this.scheduleMarks();
                return;
            case "compose-save":
                await this.saveCompose();
                return;
            case "jump": {
                const item = this.findComment(key);
                if (item) {
                    this.focusCard(key);
                    await this.jumpToBlock(item.blockId);
                }
                return;
            }
            case "reply": {
                // The target is either a comment or one of its replies.
                const comment = this.findComment(key);
                const answered = comment ? undefined : this.findReply(key);
                const blockId = comment?.blockId ?? answered?.blockId;
                const threadKey = comment ? comment.key : answered?.reply.parent ?? "";
                if (!blockId || !threadKey) {
                    return;
                }
                this.replying = {key, blockId};
                this.editing = null;
                this.editingReply = null;
                await this.renderDock(false);
                this.focusCard(threadKey);
                this.focusSoon(`.tc-item[data-key="${threadKey}"] .tc-reply-text`);
                return;
            }
            case "reply-clear":
                this.replying = null;
                await this.renderDock(false);
                this.focusCard(key);
                this.focusSoon(`.tc-item[data-key="${key}"] .tc-reply-text`);
                return;
            case "reply-edit": {
                const answered = this.findReply(key);
                this.editingReply = key;
                this.editing = null;
                this.replying = null;
                await this.renderDock(false);
                if (answered) {
                    this.focusCard(answered.reply.parent);
                }
                this.focusSoon(`.tc-reply[data-key="${key}"] .tc-reply-edit-text`);
                return;
            }
            case "reply-edit-cancel":
                this.editingReply = null;
                await this.renderDock(false);
                return;
            case "reply-edit-save":
                await this.saveReplyEdit(key);
                return;
            case "reply-cancel":
                this.replying = null;
                await this.renderDock(false);
                return;
            case "reply-save":
                await this.saveReply(key);
                return;
            case "reply-delete":
                await this.deleteReply(key);
                return;
            case "edit": {
                const item = this.findComment(key);
                if (!item) {
                    return;
                }
                this.editing = {key, blockId: item.blockId};
                this.replying = null;
                await this.renderDock(false);
                this.focusCard(key);
                this.focusSoon(".tc-edit-text");
                return;
            }
            case "edit-cancel":
                this.editing = null;
                await this.renderDock(false);
                return;
            case "edit-save":
                await this.saveEdit(key);
                return;
            case "resolve":
                await this.setResolution(key, true);
                return;
            case "unresolve":
                await this.setResolution(key, false);
                return;
            case "delete":
                await this.deleteComment(key);
                return;
            default:
                return;
        }
    }

    private findComment(key: string): StoredComment | undefined {
        return this.threads.find((item) => item.key === key);
    }

    private findReply(key: string): StoredReply | undefined {
        for (const item of this.threads) {
            const hit = item.replies.find((reply) => reply.key === key);
            if (hit) {
                return hit;
            }
        }
        return undefined;
    }

    private saveAuthor() {
        const value = this.panelElement()?.querySelector<HTMLInputElement>(".tc-author-input")?.value.trim() ?? "";
        if (value) {
            localStorage.setItem(AUTHOR_KEY, value);
            showMessage(t(this).saved);
        }
    }

    // Every write needs an identity: the author is a plain signature, not a login.
    private requireAuthor(): string | null {
        const author = readAuthor();
        if (author) {
            return author;
        }
        showMessage(t(this).authorRequired);
        this.authorEditing = true;
        void this.renderDock(false);
        return null;
    }

    private blockElement(blockId: string): HTMLElement | null {
        if (!blockId) {
            return null;
        }
        const scoped = this.activeEditor()?.wysiwyg?.element?.querySelector<HTMLElement>(`[data-node-id="${blockId}"]`);
        return scoped ?? document.querySelector<HTMLElement>(`.protyle-wysiwyg [data-node-id="${blockId}"]`);
    }

    private scrollContainer(): HTMLElement | null {
        const element = this.activeEditor()?.wysiwyg?.element;
        return element?.closest<HTMLElement>(".protyle-content") ?? document.querySelector<HTMLElement>(".protyle-content");
    }

    // The kernel's block table has no usable document order (every paragraph of a
    // document shares the same sort value), so the order comes from the document.
    private async ensureBlockOrder(rootId: string): Promise<void> {
        if (!rootId || this.orderRootId === rootId) {
            return;
        }
        const map = new Map<string, number>();
        try {
            const doc = await api<{content?: string}>("/api/filetree/getDoc", {
                id: rootId, mode: 0, size: 1048576, startID: "",
            });
            const content = doc?.content ?? "";
            const pattern = /data-node-id="([^"]+)"/g;
            let match = pattern.exec(content);
            let index = 0;
            while (match) {
                if (!map.has(match[1])) {
                    map.set(match[1], index);
                }
                index++;
                match = pattern.exec(content);
            }
        } catch (error) {
            console.warn("[extended-comments] cannot read the document order", error);
        }
        this.orderMap = map;
        this.orderRootId = map.size ? rootId : "";
    }

    private domOrder(): Map<string, number> {
        const map = new Map<string, number>();
        const root = this.activeEditor()?.wysiwyg?.element ?? document.querySelector<HTMLElement>(".protyle-wysiwyg");
        if (!root) {
            return map;
        }
        let index = 0;
        root.querySelectorAll<HTMLElement>("[data-node-id]").forEach((element) => {
            const id = element.getAttribute("data-node-id") ?? "";
            if (id && !map.has(id)) {
                map.set(id, index);
            }
            index++;
        });
        return map;
    }

    // Comments are listed where their text is, not where they were written.
    private orderedThreads(): StoredComment[] {
        const dom = this.domOrder();
        const rank = (item: StoredComment): number => {
            const fromDocument = this.orderMap.get(item.blockId);
            if (fromDocument !== undefined) {
                return fromDocument;
            }
            const fromDom = dom.get(item.blockId);
            return fromDom === undefined ? 1e9 : fromDom;
        };
        return this.threads.slice().sort((a, b) => rank(a) - rank(b) || a.comment.createdAt - b.comment.createdAt);
    }

    private markActiveCard(card: HTMLElement) {
        this.activeKey = card.dataset.key ?? "";
        if (this.activeCard === card) {
            return;
        }
        this.activeCard?.classList.remove("tc-item--active");
        this.activeCard = card;
        card.classList.add("tc-item--active");
    }

    private pinCard(card: HTMLElement, align: "top" | "nearest" = "top") {
        // Let the browser move whichever element really scrolls (the list, or the dock
        // body around it) instead of assuming that it is the list.
        card.scrollIntoView({block: align === "top" ? "start" : "nearest", behavior: "smooth"});
        this.markActiveCard(card);
    }

    private focusCard(key: string) {
        const card = this.panelElement()?.querySelector<HTMLElement>(`.tc-item[data-key="${key}"]`);
        if (card) {
            // Only scroll when the card is off screen: the caret decides, not the card.
            this.pinCard(card, "nearest");
        }
    }

    // Clicking a comment puts its text in view; if the document still has to render,
    // keep looking for the block instead of silently doing nothing.
    private async jumpToBlock(blockId: string) {
        if (!blockId) {
            return;
        }
        if (this.scrollToBlock(blockId)) {
            return;
        }
        const rootId = await this.rootIdForBlock(blockId);
        if (rootId) {
            await openTab({app: this.app, doc: {id: rootId}});
            this.scrollToBlockLater(blockId, 0);
        }
    }

    private scrollToBlock(blockId: string): boolean {
        const element = this.blockElement(blockId);
        if (!element) {
            return false;
        }
        element.scrollIntoView({block: "center", behavior: "smooth"});
        this.flashBlock(blockId);
        // The list follows the document, so let the next sync run.
        this.lastScrollTop = -1;
        return true;
    }

    private scrollToBlockLater(blockId: string, attempt: number) {
        if (attempt > 12) {
            return;
        }
        if (this.scrollToBlock(blockId)) {
            return;
        }
        window.setTimeout(() => this.scrollToBlockLater(blockId, attempt + 1), 200);
    }

    // Underlines are redrawn on every scroll frame, so the pulse lives in state and
    // is applied by drawMarks rather than to the elements that exist right now.
    private flashBlock(blockId: string) {
        this.flash = {blockId, until: Date.now() + 1600};
        this.scheduleMarks();
        window.setTimeout(() => {
            if (this.flash && Date.now() >= this.flash.until) {
                this.flash = undefined;
                this.scheduleMarks();
            }
        }, 1700);
    }

    private async jumpToFirst() {
        const ordered = this.orderedThreads();
        const visible = this.showResolved ? ordered : ordered.filter((item) => !item.resolution);
        const first = visible[0];
        if (!first) {
            showMessage(t(this).noComments);
            return;
        }
        await this.jumpToBlock(first.blockId);
        const card = this.panelElement()?.querySelector<HTMLElement>(`.tc-item[data-key="${first.key}"]`);
        if (card) {
            this.lastScrollTop = -1;
            this.pinCard(card);
        }
    }

    // Every change is one read-modify-write of the document store, followed by a
    // reload: no optimistic guessing, no waiting for an index to catch up.
    private async mutate(change: (store: Store) => void, hintBlockId?: string): Promise<boolean> {
        let rootId = this.activeRootId();
        if (!rootId && hintBlockId) {
            rootId = await this.rootIdForBlock(hintBlockId);
        }
        if (!rootId) {
            rootId = await this.rootIdFromVisibleBlock();
        }
        if (!rootId) {
            showMessage(t(this).openDocFirst);
            return false;
        }
        try {
            await mutateStore(rootId, change);
        } catch (error) {
            showMessage(t(this).saveFailed + ": " + (error as Error).message);
            return false;
        }
        await this.reloadThreads();
        await this.renderDock(false);
        return true;
    }

    private async saveCompose() {
        const element = this.panelElement();
        const pending = this.pending;
        if (!element || !pending) {
            return;
        }
        let author = readAuthor();
        const inline = element.querySelector<HTMLInputElement>(".tc-author-inline");
        if (inline) {
            author = inline.value.trim();
            if (author) {
                localStorage.setItem(AUTHOR_KEY, author);
            }
        }
        if (!author) {
            showMessage(t(this).authorRequired);
            this.focusSoon(".tc-author-inline");
            return;
        }
        const text = element.querySelector<HTMLTextAreaElement>(".tc-text")?.value.trim() ?? "";
        if (!text) {
            showMessage(t(this).commentRequired);
            this.focusSoon(".tc-text");
            return;
        }
        const key = newKey("c-");
        this.pending = null;
        const done = await this.mutate((store) => {
            store.comments[key] = {
                blockId: pending.blockId,
                author,
                text,
                quote: pending.quote,
                createdAt: Date.now(),
                replies: {},
            };
        }, pending.blockId);
        if (!done) {
            this.pending = pending;
            await this.renderDock(false);
            return;
        }
        showMessage(t(this).saved);
    }

    private async saveReply(commentKey: string) {
        const author = this.requireAuthor();
        const element = this.panelElement();
        const thread = this.findComment(commentKey);
        if (!author || !element || !thread) {
            return;
        }
        // The composer sits at the bottom of the thread; it answers a specific entry
        // only while that entry is still the reply target.
        const parent = commentKey;
        let replyTo = "";
        const target = this.replying?.key ?? "";
        if (target && target !== commentKey) {
            const answered = this.findReply(target);
            if (answered && answered.reply.parent === commentKey) {
                replyTo = answered.key;
            }
        }
        const text = this.replyField(element, commentKey)?.value.trim() ?? "";
        if (!text) {
            showMessage(t(this).commentRequired);
            this.focusSoon(`.tc-item[data-key="${commentKey}"] .tc-reply-text`);
            return;
        }
        const key = newKey("r-");
        const previous = this.replying;
        const box = this.replyField(element, commentKey);
        // The draft mechanism saves whatever is in the DOM, so the box is emptied
        // first: a sent reply must not come back into the composer.
        if (box) {
            box.value = "";
        }
        this.replying = null;
        const done = await this.mutate((store) => {
            const comment = store.comments[parent];
            if (!comment) {
                return;
            }
            comment.replies = comment.replies ?? {};
            comment.replies[key] = {parent, replyTo, author, text, createdAt: Date.now()};
        }, thread.blockId);
        if (!done) {
            this.replying = previous;
            await this.renderDock(false);
            // The send failed: give the text back instead of dropping it.
            const again = this.replyField(element, commentKey);
            if (again) {
                again.value = text;
            }
            return;
        }
        showMessage(t(this).saved);
    }

    private replyField(element: HTMLElement, commentKey: string): HTMLTextAreaElement | null {
        return element.querySelector<HTMLElement>(`.tc-item[data-key="${commentKey}"]`)
            ?.querySelector<HTMLTextAreaElement>(".tc-reply-text") ?? null;
    }

    private async saveReplyEdit(key: string) {
        const author = this.requireAuthor();
        const element = this.panelElement();
        const reply = this.findReply(key);
        if (!author || !element || !reply) {
            return;
        }
        if (reply.reply.author !== author) {
            showMessage(t(this).editDenied);
            this.editingReply = null;
            await this.renderDock(false);
            return;
        }
        const text = element.querySelector<HTMLElement>(`.tc-reply[data-key="${key}"]`)
            ?.querySelector<HTMLTextAreaElement>(".tc-reply-edit-text")?.value.trim() ?? "";
        if (!text) {
            showMessage(t(this).commentRequired);
            this.focusSoon(".tc-reply-edit-text");
            return;
        }
        const previous = this.editingReply;
        this.editingReply = null;
        const done = await this.mutate((store) => {
            const stored = store.comments[reply.reply.parent]?.replies?.[key];
            if (stored) {
                stored.text = text;
                stored.updatedAt = Date.now();
            }
        }, reply.blockId);
        if (!done) {
            // Keep the textarea (and its text) instead of dropping the edit.
            this.editingReply = previous;
            await this.renderDock(false);
            return;
        }
        showMessage(t(this).saved);
    }

    private async saveEdit(key: string) {
        const author = this.requireAuthor();
        const element = this.panelElement();
        const item = this.findComment(key);
        if (!author || !element || !item) {
            return;
        }
        if (item.comment.author !== author) {
            showMessage(t(this).editDenied);
            this.editing = null;
            await this.renderDock(false);
            return;
        }
        const text = element.querySelector<HTMLTextAreaElement>(".tc-edit-text")?.value.trim() ?? "";
        if (!text) {
            showMessage(t(this).commentRequired);
            this.focusSoon(".tc-edit-text");
            return;
        }
        const previous = this.editing;
        this.editing = null;
        const done = await this.mutate((store) => {
            const comment = store.comments[key];
            if (comment) {
                comment.text = text;
                comment.updatedAt = Date.now();
            }
        }, item.blockId);
        if (!done) {
            // Keep the textarea (and its text) instead of dropping the edit.
            this.editing = previous;
            await this.renderDock(false);
            return;
        }
        showMessage(t(this).saved);
    }

    private async setResolution(key: string, resolved: boolean) {
        const author = this.requireAuthor();
        if (!author || !this.findComment(key)) {
            return;
        }
        if (resolved) {
            this.replying = null;
            if (this.editing?.key === key) {
                this.editing = null;
            }
        }
        const done = await this.mutate((store) => {
            const comment = store.comments[key];
            if (!comment) {
                return;
            }
            if (resolved) {
                comment.resolution = {by: author, at: Date.now()};
            } else {
                delete comment.resolution;
            }
        }, this.findComment(key)?.blockId);
        if (done) {
            showMessage(resolved ? t(this).resolvedMsg : t(this).unresolvedMsg);
        }
    }

    private async deleteComment(key: string) {
        const item = this.findComment(key);
        if (!item) {
            return;
        }
        if (item.replies.length && !window.confirm(t(this).confirmDeleteComment)) {
            return;
        }
        if (this.editing?.key === key) {
            this.editing = null;
        }
        if (this.replying?.key === key) {
            this.replying = null;
        }
        const done = await this.mutate((store) => {
            delete store.comments[key];
        }, this.findComment(key)?.blockId);
        if (done) {
            showMessage(t(this).deleted);
        }
    }

    private async deleteReply(key: string) {
        const reply = this.findReply(key);
        if (!reply) {
            return;
        }
        // Replies can answer each other, so deleting one deletes its answers too.
        const thread = this.threads.find((entry) => entry.replies.some((child) => child.key === key));
        const doomed = thread ? this.replySubtree(thread.replies, key) : [key];
        // Deleting an answer takes its own answers with it, so warn before doing so.
        if (doomed.length > 1 && !window.confirm(t(this).confirmDeleteReply)) {
            return;
        }
        if (this.replying && doomed.indexOf(this.replying.key) >= 0) {
            this.replying = null;
        }
        if (this.editingReply && doomed.indexOf(this.editingReply) >= 0) {
            this.editingReply = null;
        }
        const parent = reply.reply.parent;
        const done = await this.mutate((store) => {
            const comment = store.comments[parent];
            if (!comment?.replies) {
                return;
            }
            for (const child of doomed) {
                delete comment.replies[child];
            }
        }, reply.blockId);
        if (done) {
            showMessage(t(this).deleted);
        }
    }

    private replySubtree(replies: StoredReply[], key: string): string[] {
        const keys = [key];
        for (const child of this.childReplies(replies, key)) {
            keys.push(...this.replySubtree(replies, child.key));
        }
        return keys;
    }
}
