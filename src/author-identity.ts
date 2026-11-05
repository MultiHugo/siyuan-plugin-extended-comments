/** Comment attribution, not a server authorization credential. */
export type CommentActor = {author: string; authorId?: string};
export type CommentIdentity = {
    mode: "manual" | "sciforge";
    state: "signed-in" | "signed-out" | "unavailable";
    actor?: CommentActor;
};
export type SciForgeCommentBridge = {version: number; read(): Promise<unknown>};

export function manualIdentity(author: string): CommentIdentity {
    const name = author.trim();
    return name ? {mode: "manual", state: "signed-in", actor: {author: name}}
        : {mode: "manual", state: "signed-out"};
}

export async function readCommentIdentity(bridge: SciForgeCommentBridge | undefined,
    manualAuthor: string): Promise<CommentIdentity> {
    if (!bridge) return manualIdentity(manualAuthor);
    try {
        if (bridge.version !== 1) throw new Error("Unsupported identity bridge");
        const value = await bridge.read();
        if (!value || typeof value !== "object") throw new Error("Invalid identity");
        const profile = value as Record<string, unknown>;
        if (profile.state === "signed-out") return {mode: "sciforge", state: "signed-out"};
        if (profile.state === "signed-in" && typeof profile.userId === "string" &&
            profile.userId.length > 0 && profile.userId.length <= 256 &&
            profile.userId.trim() === profile.userId && typeof profile.displayName === "string" &&
            profile.displayName.trim().length > 0 && profile.displayName.length <= 512) {
            return {mode: "sciforge", state: "signed-in",
                actor: {authorId: "sciforge:" + profile.userId, author: profile.displayName}};
        }
    } catch { /* A host failure must never revive a cached manual signature. */ }
    return {mode: "sciforge", state: "unavailable"};
}

export function ownsComment(entry: CommentActor | undefined, actor: CommentActor | undefined): boolean {
    if (!entry || !actor) return false;
    if (entry.authorId || actor.authorId) {
        return Boolean(entry.authorId && actor.authorId && entry.authorId === actor.authorId);
    }
    return entry.author === actor.author;
}

export function sameCommentActor(left: CommentActor | undefined, right: CommentActor | undefined): boolean {
    return left?.authorId === right?.authorId && left?.author === right?.author;
}
