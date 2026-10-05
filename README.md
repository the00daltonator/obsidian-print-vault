# Print Vault to PDF (Obsidian plugin)

Click the printer icon in the left ribbon. Every note in your vault is exported into one PDF, ready to print:

- Cover page, then a **table of contents with page numbers**
- Notes grouped into chapters **by folder** or **by tag** (or one alphabetical list), numbered like `3.12`
- Under each note title, a **Links to / Linked from** box listing the outgoing and incoming links, each with its page number, e.g. `2.4 Physics (p. 37)`
- `[[wikilinks]]` inside the note text also show a page reference, so you can follow them on paper
- Running headers (chapter + note title) and page numbers in the footer

## Install
Copy `manifest.json`, `main.js`, and `paged.polyfill.min.js` into
`<your vault>/.obsidian/plugins/print-vault-pdf/`, then go to Settings → Community plugins, click the reload icon, and turn on **Print Vault to PDF**.

## Use
- Ribbon printer icon, or the command palette's **Print Vault to PDF: Export whole vault to PDF**
- Right-click a folder → **Print folder to PDF**
- PDFs are saved to `Exports/<vault name> - YYYY-MM-DD.pdf` and opened automatically

Settings let you choose the grouping (folder/tag, with an optional ordered list of tag chapters), sort order, excluded folders and tags, page size, font size, whether each note starts on a new page, and whether images are included.

Desktop only. A large vault (1000+ notes) can take a few minutes to paginate.
