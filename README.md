# Print Vault to PDF (Obsidian plugin)

Click the printer icon in the left ribbon. Every note in your vault is exported into one PDF, ready to print:

- Cover page, then a **table of contents with page numbers**
- Notes grouped into chapters **by folder** or **by tag** (or one alphabetical list), numbered like `3.12`
- Under each note title, a **Links to / Linked from** box listing the outgoing and incoming links, each with its page number, e.g. `2.4 Physics (p. 37)`
- `[[wikilinks]]` inside the note text also show a page reference, so you can follow them on paper
- Page numbers in the footer; PDF bookmarks for every chapter and note

## Install
Copy `manifest.json`, `main.js`, and `pdf-lib.min.js` into
`<your vault>/.obsidian/plugins/print-vault-pdf/`, then go to Settings → Community plugins, click the reload icon, and turn on **Print Vault to PDF**.

## Use
- Ribbon printer icon, or the command palette's **Print Vault to PDF: Export whole vault to PDF**
- Right-click a folder → **Print folder to PDF**
- PDFs are saved to `Exports/<vault name> - YYYY-MM-DD.pdf` and opened automatically

Settings let you choose the grouping (folder/tag, with an optional ordered list of tag chapters), sort order, excluded folders and tags, page size, font size, whether each note starts on a new page, and whether images are included.

Desktop only. Uses Chromium's built-in print engine in chunks of ~100 notes (Chromium can't print thousands of pages at once), reads where each note landed from each chunk's bookmarks, fills in the page numbers, prints again, and merges the chunks with [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT), which also stamps page numbers and adds bookmarks. A 1000+ note vault takes a few minutes, mostly for rendering notes and resizing images.
