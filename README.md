# Extended Comments for SiYuan

Document comments for SiYuan, the way Lark / Feishu and Google Docs do it: **select text → Comment → discuss in the right panel**. The commented sentence keeps a yellow underline, and comments live inside the document, so they sync and share with it.

![preview](preview-0.7.0.png)

## What it does

- **Comment on any text**: select it → the floating toolbar's Comment button → type in the right dock (`Ctrl/Cmd + Enter` saves)
- **Replies to replies**: an answer shows "Reply @name"; ✕ retargets it back to the whole comment
- **Edit and delete both comments and replies**: only your own entries, edited ones are tagged; deleting a comment that has replies asks first
- **Resolve and hide**: finish a thread with "Resolve and hide", reopen it any time with "Unresolve" — a resolved thread closes its reply box
- **Click to jump**: click a card, the Locate button, or the quoted line → the document scrolls to that sentence and the underline pulses for 1.6 s; "First comment" jumps back to the top
- **Ordered by the document**: threads are listed by where their quoted text appears, not by when they were posted
- **Avatars and relative time**: coloured initial avatars; "just now / 12 min ago / Today 14:32 / Yesterday 09:05", with the exact time on hover
- **Clickable quotes**: the quoted line at the top of a card jumps to its text

![detail](preview-detail-0.7.0.png)

## Install and use

1. Marketplace → Plugins → search "Extended Comments" and download it; for a local build use Settings → Marketplace → Downloaded → enable (hard-refresh with `Ctrl+Shift+R` after an update)
2. Press "Name" in the panel once to set your display name (**stored in this browser only**, not an account)
3. Select text → Comment in the floating toolbar → write → save

## Where the data lives

Comments are one JSON value in the document block attribute `custom-comments`:

- **no new files, no change to the document text** — just an attribute on the block
- it travels with the document, so everyone who can open it sees the comments
- removing the plugin does not delete the data; enable it again and the comments come back

## Development

    npm install
    npm run build                  # emits dist/ and package.zip
    python scripts/make-assets.py  # regenerate icon-0.7.0.png / preview*.png

All logic is in `src/index.ts` (store, persistence, panel rendering, action dispatch), styles in `src/index.scss`, strings in `src/i18n/*.json`.

## License

MIT
