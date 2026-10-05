/* Print Vault to PDF — single-file Obsidian plugin (no build step). */
"use strict";

const obsidian = require("obsidian");
const { Plugin, PluginSettingTab, Setting, Notice, MarkdownRenderer, Component, TFolder, TFile, normalizePath, getAllTags, getLinkpath } = obsidian;

const DEFAULT_SETTINGS = {
  title: "",
  groupBy: "folder", // folder | tag | none
  tagOrder: "", // comma list; blank = each note's first tag
  sortBy: "name", // name | created | modified
  excludeFolders: "Templates, copilot, copilot-custom-prompts, Exports",
  excludeTags: "",
  pageSize: "Letter", // Letter | A4
  fontSize: 10.5,
  noteOnNewPage: false,
  showLinks: true,
  showTags: true,
  includeImages: true,
  outputFolder: "Exports",
  openAfterExport: true,
  keepHtml: false,
};

const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif" };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const splitList = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Fixed-width slot for a page reference; filled in after the first print pass.
const pgRef = (id, num) => `<span class="pg" data-t="${id}" data-n="${esc(num)}">(§${esc(num)})</span>`;

module.exports = class PrintVaultPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.busy = false;

    this.addRibbonIcon("printer", "Print vault to PDF", () => this.exportPdf());
    this.addCommand({ id: "export-vault", name: "Export whole vault to PDF", callback: () => this.exportPdf() });
    this.addCommand({
      id: "export-current-folder",
      name: "Export current note's folder to PDF",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || !f.parent) return false;
        if (!checking) this.exportPdf(f.parent);
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFolder)) return;
        menu.addItem((item) => item.setTitle("Print folder to PDF").setIcon("printer").onClick(() => this.exportPdf(file)));
      })
    );
    // ```print-vault``` code block → a dashboard card with an export button.
    this.registerMarkdownCodeBlockProcessor("print-vault", (source, el) => this.renderDashboard(el));

    // obsidian://print-vault?vault=<name>  — lets a desktop shortcut start an export.
    this.registerObsidianProtocolHandler("print-vault", () => this.exportPdf());
    this.addSettingTab(new PrintVaultSettingTab(this.app, this));
  }

  /** Appends a timestamped line to export-log.txt in the plugin folder (for troubleshooting). */
  log(msg) {
    try {
      const line = `${new Date().toISOString()}  ${msg}\n`;
      require("fs").appendFileSync(this.app.vault.adapter.getFullPath(normalizePath(this.manifest.dir + "/export-log.txt")), line);
    } catch (_) {}
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  renderDashboard(el) {
    const s = this.settings;
    const card = el.createDiv({ cls: "print-vault-card" });
    card.setAttribute("style", "border:1px solid var(--background-modifier-border);border-radius:10px;padding:16px 18px;background:var(--background-secondary);");
    card.createEl("div", { text: "🖨️ Print Vault to PDF" }).setAttribute("style", "font-size:1.2em;font-weight:600;margin-bottom:6px;");

    const count = this.collectNotes().length;
    const groupLabel = { folder: "by folder", tag: "by tag", none: "in one list" }[s.groupBy];
    card.createEl("div", { text: `${count} notes · grouped ${groupLabel} · ${s.pageSize} · saves to “${s.outputFolder || "/"}”` })
      .setAttribute("style", "color:var(--text-muted);font-size:.9em;margin-bottom:12px;");

    const row = card.createDiv();
    row.setAttribute("style", "display:flex;gap:8px;flex-wrap:wrap;align-items:center;");

    const go = row.createEl("button", { text: "Export to PDF", cls: "mod-cta" });
    go.onclick = () => this.exportPdf();

    const group = row.createEl("select", { cls: "dropdown" });
    for (const [v, label] of [["folder", "Group by folder"], ["tag", "Group by tag"], ["none", "No grouping"]]) {
      const o = group.createEl("option", { text: label, value: v });
      if (v === s.groupBy) o.selected = true;
    }
    group.onchange = async () => { s.groupBy = group.value; await this.saveSettings(); el.empty(); this.renderDashboard(el); };

    const opts = row.createEl("button", { text: "More options…" });
    opts.onclick = () => { this.app.setting.open(); this.app.setting.openTabById(this.manifest.id); };

    const open = row.createEl("button", { text: "Open exports folder" });
    open.onclick = async () => {
      const folder = normalizePath(s.outputFolder || "/");
      if (!(await this.app.vault.adapter.exists(folder))) { new Notice("No exports yet."); return; }
      require("electron").shell.openPath(this.app.vault.adapter.getFullPath(folder));
    };
  }

  // ---------- collect & organize ----------

  collectNotes(rootFolder) {
    const s = this.settings;
    const excludedFolders = splitList(s.excludeFolders).map((f) => normalizePath(f).toLowerCase());
    const excludedTags = splitList(s.excludeTags).map((t) => t.replace(/^#/, "").toLowerCase());
    const outDir = normalizePath(s.outputFolder || "").toLowerCase();

    return this.app.vault.getMarkdownFiles().filter((f) => {
      const p = f.path.toLowerCase();
      if (rootFolder && !rootFolder.isRoot() && !p.startsWith(rootFolder.path.toLowerCase() + "/")) return false;
      if (outDir && p.startsWith(outDir + "/")) return false;
      if (excludedFolders.some((ex) => p === ex || p.startsWith(ex + "/"))) return false;
      if (excludedTags.length) {
        const tags = this.tagsOf(f).map((t) => t.toLowerCase());
        if (tags.some((t) => excludedTags.some((ex) => t === ex || t.startsWith(ex + "/")))) return false;
      }
      return true;
    });
  }

  tagsOf(file) {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return [];
    return [...new Set((getAllTags(cache) || []).map((t) => t.replace(/^#/, "")))];
  }

  sortFiles(files) {
    const by = this.settings.sortBy;
    const cmp =
      by === "created" ? (a, b) => a.stat.ctime - b.stat.ctime :
      by === "modified" ? (a, b) => b.stat.mtime - a.stat.mtime :
      (a, b) => a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: "base" });
    return files.sort(cmp);
  }

  /** Returns [{ name, files: TFile[] }] in print order. */
  groupNotes(files) {
    const s = this.settings;
    const groups = new Map();
    const add = (key, f) => {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    };

    if (s.groupBy === "folder") {
      for (const f of files) add(f.parent && !f.parent.isRoot() ? f.parent.path : "", f);
      const keys = [...groups.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })));
      return keys.map((k) => ({ name: k === "" ? "Vault root" : k.split("/").join(" › "), files: this.sortFiles(groups.get(k)) }));
    }

    if (s.groupBy === "tag") {
      const order = splitList(s.tagOrder).map((t) => t.replace(/^#/, ""));
      for (const f of files) {
        const tags = this.tagsOf(f);
        let key = null;
        for (const want of order) {
          const hit = tags.find((t) => t.toLowerCase() === want.toLowerCase() || t.toLowerCase().startsWith(want.toLowerCase() + "/"));
          if (hit) { key = want; break; }
        }
        if (!key) key = order.length ? null : tags[0] || null;
        add(key, f);
      }
      const keys = [...groups.keys()].filter((k) => k !== null);
      if (order.length) keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      else keys.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      if (groups.has(null)) keys.push(null);
      return keys.map((k) => ({ name: k === null ? (order.length ? "Other notes" : "Untagged") : "#" + k, files: this.sortFiles(groups.get(k)) }));
    }

    return [{ name: "", files: this.sortFiles(files) }];
  }

  // ---------- render ----------

  async renderNote(file, ctx) {
    const raw = await this.app.vault.cachedRead(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const fmEnd = cache && cache.frontmatterPosition ? cache.frontmatterPosition.end.offset : 0;
    const body = raw.slice(fmEnd);

    const el = document.createElement("div");
    const comp = new Component();
    comp.load();
    try {
      await MarkdownRenderer.render(this.app, body, el, file.path, comp);
      await sleep(30); // let synchronous post-processors settle
      await this.fixupRendered(el, file, ctx);
    } catch (e) {
      console.error("print-vault-pdf: failed to render", file.path, e);
      el.innerHTML = `<p class="render-error">Could not render this note.</p><pre>${esc(body)}</pre>`;
    } finally {
      comp.unload();
    }
    return el.innerHTML;
  }

  async fixupRendered(el, file, ctx) {
    const { idByPath } = ctx;
    const mc = this.app.metadataCache;

    // Remove interactive chrome that makes no sense on paper.
    el.querySelectorAll(".copy-code-button, .edit-block-button, .collapse-indicator, .heading-collapse-indicator, button, input:not([type=checkbox])").forEach((n) => n.remove());
    el.querySelectorAll("input[type=checkbox]").forEach((cb) => (cb.checked ? cb.setAttribute("checked", "") : cb.removeAttribute("checked")));

    // Embeds: images → shrunken temp copies, notes → cross-reference.
    for (const span of Array.from(el.querySelectorAll(".internal-embed"))) {
      const src = span.getAttribute("src") || "";
      const target = mc.getFirstLinkpathDest(getLinkpath(src), file.path);
      if (target && IMAGE_EXT.includes(target.extension.toLowerCase())) {
        if (!this.settings.includeImages) { span.replaceWith(this.mkNote(`[image: ${target.name}]`)); continue; }
        const url = await this.printImage(this.app.vault.adapter.getFullPath(target.path), ctx);
        if (!url) { span.replaceWith(this.mkNote(`[image: ${target.name}]`)); continue; }
        const img = document.createElement("img");
        img.src = url;
        img.alt = span.getAttribute("alt") || target.basename;
        const w = (span.getAttribute("width") || "").trim();
        if (/^\d+$/.test(w)) img.style.width = Math.min(+w, 1000) + "px";
        span.replaceWith(img);
      } else if (target && idByPath.has(target.path)) {
        const a = document.createElement("a");
        a.className = "xref embed-ref";
        a.href = "#" + idByPath.get(target.path);
        a.textContent = "Embedded: " + target.basename;
        const p = document.createElement("p");
        p.appendChild(a);
        p.insertAdjacentHTML("beforeend", " " + pgRef(idByPath.get(target.path), ctx.numByPath.get(target.path)));
        span.replaceWith(p);
      } else {
        span.replaceWith(this.mkNote(`[embedded: ${target ? target.name : src}]`));
      }
    }

    // Remaining local images (markdown ![](x.png) syntax, rendered as app:// URLs).
    for (const img of Array.from(el.querySelectorAll("img"))) {
      const src = img.getAttribute("src") || "";
      if (src.startsWith("data:") || src.startsWith("file:") || ctx.ownUrls.has(src)) continue;
      if (!this.settings.includeImages) { img.replaceWith(this.mkNote("[image]")); continue; }
      if (/^https?:/i.test(src)) continue;
      let url = null;
      try { url = await this.printImage(decodeURIComponent(new URL(src).pathname), ctx); } catch (_) {}
      if (url) img.src = url;
      else img.replaceWith(this.mkNote("[image unavailable]"));
    }

    // Internal links → in-document references (page numbers added via CSS).
    for (const a of Array.from(el.querySelectorAll("a.internal-link"))) {
      const href = a.getAttribute("data-href") || a.getAttribute("href") || "";
      const target = mc.getFirstLinkpathDest(getLinkpath(href), file.path);
      if (target && idByPath.has(target.path)) {
        a.setAttribute("href", "#" + idByPath.get(target.path));
        a.className = "xref";
        a.insertAdjacentHTML("afterend", " " + pgRef(idByPath.get(target.path), ctx.numByPath.get(target.path)));
      } else {
        const span = document.createElement("span");
        span.className = "dead-link";
        span.textContent = a.textContent;
        a.replaceWith(span);
      }
      a.removeAttribute("target");
      a.removeAttribute("data-href");
    }

    // Tags in body: plain text.
    el.querySelectorAll("a.tag").forEach((a) => { const s = document.createElement("span"); s.className = "tag"; s.textContent = a.textContent; a.replaceWith(s); });

    // Strip ids that might clash with our anchors.
    el.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  }

  mkNote(text) {
    const s = document.createElement("span");
    s.className = "placeholder";
    s.textContent = text;
    return s;
  }

  /**
   * Shrinks an image to print resolution and writes it to the export's temp folder,
   * returning a file:// URL. One image is in memory at a time, so huge photo
   * libraries don't exhaust Obsidian's memory. Returns null if it can't be read.
   */
  async printImage(absPath, ctx) {
    if (ctx.imageCache.has(absPath)) return ctx.imageCache.get(absPath);
    const fs = require("fs"), path = require("path"), { pathToFileURL } = require("url");
    const ext = path.extname(absPath).slice(1).toLowerCase();
    let url = null;
    try {
      if (!fs.existsSync(absPath)) throw new Error("missing");
      if (ext === "svg" || ext === "gif") {
        url = pathToFileURL(absPath).href; // vector / animated: use as-is
      } else {
        const blob = new Blob([await fs.promises.readFile(absPath)], { type: MIME[ext] || "image/" + ext });
        const bmp = await createImageBitmap(blob);
        const maxPx = 1600;
        const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        const g = canvas.getContext("2d");
        g.fillStyle = "#fff";
        g.fillRect(0, 0, w, h);
        g.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
        const dest = path.join(ctx.tmpDir, `img${ctx.imageCache.size}.jpg`);
        await fs.promises.writeFile(dest, Buffer.from(await out.arrayBuffer()));
        url = pathToFileURL(dest).href;
      }
    } catch (e) {
      console.warn("print-vault-pdf: skipped image", absPath, e && e.message);
    }
    ctx.imageCache.set(absPath, url);
    if (url) ctx.ownUrls.add(url);
    return url;
  }

  linkList(label, paths, ctx) {
    const items = [...paths]
      .filter((p) => ctx.idByPath.has(p))
      .sort((a, b) => ctx.numByPath.get(a).localeCompare(ctx.numByPath.get(b), undefined, { numeric: true }))
      .map((p) => `<a class="xref" href="#${ctx.idByPath.get(p)}">${esc(ctx.numByPath.get(p))} ${esc(ctx.titleByPath.get(p))}</a> ${pgRef(ctx.idByPath.get(p), ctx.numByPath.get(p))}`);
    if (!items.length) return `<div class="links-row"><span class="links-label">${label}</span><span class="none">none</span></div>`;
    return `<div class="links-row"><span class="links-label">${label}</span>${items.join('<span class="sep"> · </span>')}</div>`;
  }

  /** Streams the printable HTML to htmlPath note by note (never holds the whole vault in memory). */
  async writeHtml(groups, title, progress, htmlPath, tmpDir) {
    const s = this.settings;
    const grouped = groups.length > 1 || groups[0].name !== "";
    const ctx = { idByPath: new Map(), numByPath: new Map(), titleByPath: new Map(), imageCache: new Map(), ownUrls: new Set(), tmpDir };
    const keyById = {}; // anchor id → normalized heading text, to find its page in the PDF bookmarks

    // Numbering + anchors first, so links can be resolved while rendering.
    let n = 0;
    groups.forEach((g, gi) => {
      g.id = "g" + gi;
      keyById[g.id] = normKey(`${gi + 1}${g.name}`);
      g.files.forEach((f, fi) => {
        ctx.idByPath.set(f.path, "n" + n++);
        ctx.numByPath.set(f.path, grouped ? `${gi + 1}.${fi + 1}` : `${fi + 1}`);
        ctx.titleByPath.set(f.path, f.basename);
        keyById["n" + (n - 1)] = normKey(ctx.numByPath.get(f.path) + f.basename);
      });
    });

    // Outgoing / incoming link maps restricted to exported notes.
    const out = new Map(), inc = new Map();
    const resolved = this.app.metadataCache.resolvedLinks;
    for (const src of ctx.idByPath.keys()) {
      for (const dst of Object.keys(resolved[src] || {})) {
        if (dst === src || !ctx.idByPath.has(dst)) continue;
        if (!out.has(src)) out.set(src, new Set());
        out.get(src).add(dst);
        if (!inc.has(dst)) inc.set(dst, new Set());
        inc.get(dst).add(src);
      }
    }

    // TOC
    const toc = [];
    toc.push('<section class="toc"><h1 class="toc-title">Contents</h1>');
    for (const [gi, g] of groups.entries()) {
      if (grouped) toc.push(`<div class="toc-group"><a class="toc-entry toc-chapter" href="#${g.id}"><span class="toc-num">${gi + 1}</span><span class="toc-text">${esc(g.name)}</span><span class="pg toc-pg" data-t="${g.id}"></span></a>`);
      toc.push('<ol class="toc-list">');
      for (const f of g.files) {
        toc.push(`<li><a class="toc-entry" href="#${ctx.idByPath.get(f.path)}"><span class="toc-num">${esc(ctx.numByPath.get(f.path))}</span><span class="toc-text">${esc(f.basename)}</span><span class="pg toc-pg" data-t="${ctx.idByPath.get(f.path)}"></span></a></li>`);
      }
      toc.push("</ol>");
      if (grouped) toc.push("</div>");
    }
    toc.push("</section>");

    const css = buildCss(s, grouped);
    const date = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    const total = ctx.idByPath.size;

    const items = [];   // children of <main>, in order: used to print in chunks
    const outline = []; // chapters → notes, for PDF bookmarks
    const fh = await require("fs").promises.open(htmlPath, "w");
    const write = (str) => fh.write(str + "\n");
    try {
    await write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${css}</style>
<script>
window.__fill = function (pages) {
  document.querySelectorAll(".pg").forEach(function (el) {
    var p = pages[el.dataset.t], toc = el.classList.contains("toc-pg");
    el.textContent = p ? (toc ? String(p) : "(p. " + p + ")") : (toc ? "" : "(§" + el.dataset.n + ")");
  });
  return true;
};
// Show only one slice of the document (chunk -1 = cover + contents) so each print stays small.
window.__show = function (from, to) {
  var front = from < 0;
  document.querySelectorAll("body > section").forEach(function (el) { el.style.display = front ? "" : "none"; });
  var kids = document.querySelector("main").children;
  for (var i = 0; i < kids.length; i++) kids[i].style.display = !front && i >= from && i < to ? "" : "none";
  return true;
};
<\/script>
</head><body>
<section class="cover">
  <h1>${esc(title)}</h1>
  <p class="cover-sub">${total} notes${grouped ? ` · ${groups.length} ${s.groupBy === "tag" ? "tag groups" : "folders"}` : ""}</p>
  <p class="cover-date">Exported ${esc(date)}</p>
</section>`);
    await write(toc.join("\n"));
    await write("<main>");

    // Body
    let done = 0;
    for (const [gi, g] of groups.entries()) {
      if (grouped) {
        await write(`<div class="chapter-head"><h1 class="chapter-title" id="${g.id}"><span class="chapter-num">${gi + 1}</span>${esc(g.name)}</h1><p class="chapter-count">${g.files.length} note${g.files.length === 1 ? "" : "s"}</p></div>`);
        items.push({ chapter: true, id: g.id, notes: g.files.length, bytes: 0 });
        outline.push({ id: g.id, title: `${gi + 1}  ${g.name}`, children: [] });
      }
      for (const f of g.files) {
        const id = ctx.idByPath.get(f.path);
        const html = await this.renderNote(f, ctx);
        const meta = [];
        meta.push(`<span class="meta-path">${esc(f.path)}</span>`);
        if (s.showTags) {
          const tags = this.tagsOf(f);
          if (tags.length) meta.push(`<span class="meta-tags">${tags.map((t) => "#" + esc(t)).join(" ")}</span>`);
        }
        const links = s.showLinks
          ? `<div class="links">${this.linkList("Links to", out.get(f.path) || [], ctx)}${this.linkList("Linked from", inc.get(f.path) || [], ctx)}</div>`
          : "";
        const article =
          `<article class="note${s.noteOnNewPage ? " new-page" : ""}" id="${id}">` +
            `<h2 class="note-title"><span class="note-num">${esc(ctx.numByPath.get(f.path))}</span>${esc(f.basename)}</h2>` +
            `<div class="note-meta">${meta.join("")}</div>` +
            links +
            `<div class="note-body">${html}</div>` +
          `</article>`;
        await write(article);
        items.push({ chapter: false, id, bytes: article.length });
        const entry = { id, title: `${ctx.numByPath.get(f.path)}  ${f.basename}` };
        if (grouped) outline[outline.length - 1].children.push(entry);
        else outline.push(entry);
        done++;
        if (done % 10 === 0 || done === total) progress(`Rendering notes… ${done}/${total}`);
        await sleep(done % 20 === 0 ? 16 : 0); // let Obsidian repaint between notes
      }
    }
    await write("</main></body></html>");
    } finally {
      await fh.close();
    }
    return { keyById, items, outline };
  }

  // ---------- PDF ----------

  async exportPdf(rootFolder) {
    if (this.busy) { new Notice("Print Vault: an export is already running."); return; }
    this.busy = true;
    // Progress shows in a notice and in the status bar (the notice can be clicked away).
    const notice = new Notice("Print Vault: preparing…", 0);
    const status = this.addStatusBarItem();
    status.setText("🖨️ Print Vault: preparing…");
    let lastLogged = "";
    const progress = (msg) => {
      notice.setMessage("Print Vault: " + msg);
      status.setText("🖨️ " + msg);
      const kind = msg.replace(/[\d/]+/g, "#");
      if (kind !== lastLogged || /(\d+)\/\1/.test(msg)) { this.log(msg); lastLogged = kind; }
    };
    let failed = false;
    try { require("fs").writeFileSync(this.app.vault.adapter.getFullPath(normalizePath(this.manifest.dir + "/export-log.txt")), ""); } catch (_) {}
    this.log(`Export started: Obsidian ${obsidian.apiVersion || "?"}, Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, settings ${JSON.stringify(this.settings)}`);
    let tmpDir = null;

    try {
      const files = this.collectNotes(rootFolder);
      if (!files.length) throw new Error("No notes to export (check your excluded folders/tags).");
      const groups = this.groupNotes(files);
      const scopeName = rootFolder && !rootFolder.isRoot() ? rootFolder.name : this.app.vault.getName();
      const title = this.settings.title.trim() || scopeName;

      const os = require("os"), path = require("path"), fs = require("fs");
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "print-vault-"));
      const tmpHtml = path.join(tmpDir, "export.html");
      this.log(`${files.length} notes in ${groups.length} groups; temp folder ${tmpDir}`);
      const layout = await this.writeHtml(groups, title, progress, tmpHtml, tmpDir);
      this.log(`HTML written: ${(fs.statSync(tmpHtml).size / 1048576).toFixed(1)} MB, ${fs.readdirSync(tmpDir).length - 1} images`);

      const pdf = await this.printHtmlToPdf(tmpHtml, layout, tmpDir, progress);

      const stamp = new Date().toISOString().slice(0, 10);
      const folder = normalizePath(this.settings.outputFolder || "/");
      if (folder !== "/" && !(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
      const base = `${scopeName.replace(/[\\/:*?"<>|]/g, "-")} - ${stamp}`;
      const outPath = normalizePath(`${folder === "/" ? "" : folder + "/"}${base}.pdf`);
      const fullOut = this.app.vault.adapter.getFullPath(outPath);
      await fs.promises.writeFile(fullOut, pdf);
      this.log(`Saved ${outPath} (${(pdf.length / 1048576).toFixed(1)} MB)`);
      if (this.settings.keepHtml) await fs.promises.copyFile(tmpHtml, fullOut.replace(/\.pdf$/, ".html"));

      notice.hide();
      new Notice(`Print Vault: saved ${outPath} (${files.length} notes).`, 8000);
      if (this.settings.openAfterExport) {
        const full = this.app.vault.adapter.getFullPath ? this.app.vault.adapter.getFullPath(outPath) : null;
        if (full) require("electron").shell.openPath(full);
      }
    } catch (e) {
      failed = true;
      console.error("print-vault-pdf", e);
      this.log("FAILED: " + (e && e.stack ? e.stack : e));
      notice.hide();
      // Stays until clicked.
      new Notice("Print Vault failed: " + (e && e.message ? e.message : e) + "\n\nDetails: .obsidian/plugins/print-vault-pdf/export-log.txt", 0);
    } finally {
      // Keep temp files after a failure so the problem can be reproduced.
      if (tmpDir && !failed) require("fs").promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      status.remove();
      this.busy = false;
    }
  }

  /**
   * Prints with Chromium's native engine. Chromium can't print thousands of
   * pages in one go ("Printing failed"), so the document is printed in chunks
   * of ~100 notes by hiding everything else, then merged with pdf-lib.
   * Pass 1 learns where every heading lands (from each chunk's PDF bookmarks);
   * the page numbers are written into fixed-width slots, and pass 2 prints
   * the final chunks. Page numbers and bookmarks are added after merging.
   */
  async printHtmlToPdf(htmlPath, layout, tmpDir, progress) {
    const fs = require("fs"), path = require("path");
    const electron = require("electron");
    const remote = electron.remote || (() => { try { return require("@electron/remote"); } catch (_) { return null; } })();
    const { keyById, items, outline } = layout;
    const pdfOpts = { printBackground: true, preferCSSPageSize: true, generateDocumentOutline: true };

    // Chunk plan over <main>'s children. Chunk -1 is the cover + contents.
    const MAX_NOTES = 100, MAX_BYTES = 12 * 1024 * 1024;
    const chunks = [[-1, -1]];
    let start = 0, notes = 0, bytes = 0;
    items.forEach((it, i) => {
      const full = notes >= MAX_NOTES || bytes >= MAX_BYTES || (it.chapter && notes >= 30 && notes + it.notes > MAX_NOTES);
      if (i > start && full) { chunks.push([start, i]); start = i; notes = 0; bytes = 0; }
      if (!it.chapter) notes++;
      bytes += it.bytes;
    });
    if (start < items.length) chunks.push([start, items.length]);
    this.log(`Printing in ${chunks.length} chunks`);

    let page;
    this.log(`Printing with ${remote && remote.BrowserWindow ? "hidden window" : "webview"}`);
    if (remote && remote.BrowserWindow) {
      const win = new remote.BrowserWindow({ show: false, width: 1000, height: 1300, paintWhenInitiallyHidden: true, webPreferences: { javascript: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
      page = {
        load: () => win.loadFile(htmlPath),
        exec: (js) => win.webContents.executeJavaScript(js),
        print: () => win.webContents.printToPDF(pdfOpts),
        close: () => win.destroy(),
      };
    } else {
      const wv = document.createElement("webview");
      wv.setAttribute("style", "position:fixed;left:-20000px;top:0;width:1000px;height:1300px;");
      document.body.appendChild(wv);
      page = {
        load: () => new Promise((res, rej) => {
          wv.addEventListener("did-finish-load", res, { once: true });
          wv.addEventListener("did-fail-load", (e) => rej(new Error("Could not load export page: " + e.errorDescription)), { once: true });
          wv.setAttribute("src", require("url").pathToFileURL(htmlPath).href);
        }),
        exec: (js) => wv.executeJavaScript(js),
        print: () => wv.printToPDF(pdfOpts),
        close: () => wv.remove(),
      };
    }

    const printChunk = async (k) => {
      const [from, to] = chunks[k];
      await page.exec(`window.__show(${from}, ${to})`);
      await sleep(50);
      const t0 = Date.now();
      const data = Buffer.from(await page.print());
      const info = pdfHeadingPages(data);
      this.log(`  chunk ${k + 1}/${chunks.length}: ${info ? info.pageCount : "?"} pages, ${(data.length / 1048576).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      return { data, info };
    };

    let files = [];
    let pages = {};
    try {
      progress("Loading pages for printing…");
      await page.load();
      await page.exec("document.fonts ? document.fonts.ready.then(() => true) : true");
      await page.exec(`Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }))).then(() => true)`);

      // Pass 1: where does every heading land?
      const counts = [];
      let offset = 0, located = true;
      for (let k = 0; k < chunks.length; k++) {
        progress(`Laying out pages… part ${k + 1}/${chunks.length}`);
        const { info } = await printChunk(k);
        if (!info) { located = false; counts.push(0); continue; }
        counts.push(info.pageCount);
        for (const [id, key] of Object.entries(keyById)) {
          if (pages[id] == null && info.headings.has(key)) pages[id] = offset + info.headings.get(key);
        }
        offset += info.pageCount;
      }
      this.log(`Pass 1: ${offset} pages; located ${Object.keys(pages).length}/${Object.keys(keyById).length} headings${located ? "" : " (some chunks unreadable)"}`);
      await page.exec(`window.__fill(${JSON.stringify(pages)})`);

      // Pass 2: final print with page numbers filled in.
      for (let k = 0; k < chunks.length; k++) {
        progress(`Printing with page numbers… part ${k + 1}/${chunks.length}`);
        const { data, info } = await printChunk(k);
        if (info && counts[k] && info.pageCount !== counts[k]) this.log(`  warning: chunk ${k + 1} changed from ${counts[k]} to ${info.pageCount} pages`);
        const f = path.join(tmpDir, `chunk-${k}.pdf`);
        await fs.promises.writeFile(f, data);
        files.push(f);
      }
    } finally {
      page.close();
    }

    progress("Combining into one PDF…");
    return await this.mergePdfs(files, outline, pages, progress);
  }

  async loadPdfLib() {
    if (this.PDFLib) return this.PDFLib;
    const code = await this.app.vault.adapter.read(normalizePath(this.manifest.dir + "/pdf-lib.min.js"));
    const mod = { exports: {} };
    new Function("exports", "module", code)(mod.exports, mod);
    return (this.PDFLib = mod.exports);
  }

  /** Concatenates chunk PDFs, stamps page numbers (not on the cover), and adds chapter/note bookmarks. */
  async mergePdfs(files, outline, pages, progress) {
    const fs = require("fs");
    const { PDFDocument, StandardFonts, rgb, PDFName, PDFHexString, PDFNumber } = await this.loadPdfLib();
    const doc = await PDFDocument.create();
    for (let k = 0; k < files.length; k++) {
      progress(`Combining into one PDF… part ${k + 1}/${files.length}`);
      const src = await PDFDocument.load(await fs.promises.readFile(files[k]), { updateMetadata: false });
      const copied = await doc.copyPages(src, src.getPageIndices());
      copied.forEach((pg) => doc.addPage(pg));
      await sleep(0);
    }

    progress("Adding page numbers…");
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const all = doc.getPages();
    all.forEach((pg, i) => {
      if (i === 0) return; // cover
      const label = String(i + 1);
      const { width } = pg.getSize();
      pg.drawText(label, { x: (width - font.widthOfTextAtSize(label, 9)) / 2, y: 30, size: 9, font, color: rgb(0.33, 0.33, 0.33) });
    });

    // Bookmarks: chapters → notes, pointing at the pages found in pass 1.
    try {
      const ctx = doc.context;
      const refs = all.map((pg) => pg.ref);
      const build = (list, parentRef) => {
        const usable = list.filter((e) => pages[e.id] && refs[pages[e.id] - 1]);
        const own = usable.map(() => ctx.nextRef());
        usable.forEach((e, i) => {
          const dict = ctx.obj({});
          dict.set(PDFName.of("Title"), PDFHexString.fromText(e.title));
          dict.set(PDFName.of("Parent"), parentRef);
          dict.set(PDFName.of("Dest"), ctx.obj([refs[pages[e.id] - 1], PDFName.of("Fit")]));
          if (i > 0) dict.set(PDFName.of("Prev"), own[i - 1]);
          if (i < usable.length - 1) dict.set(PDFName.of("Next"), own[i + 1]);
          if (e.children && e.children.length) {
            const kids = build(e.children, own[i]);
            if (kids) {
              dict.set(PDFName.of("First"), kids.first);
              dict.set(PDFName.of("Last"), kids.last);
              dict.set(PDFName.of("Count"), PDFNumber.of(-kids.count)); // collapsed
            }
          }
          ctx.assign(own[i], dict);
        });
        return own.length ? { first: own[0], last: own[own.length - 1], count: own.length } : null;
      };
      const rootRef = ctx.nextRef();
      const top = build(outline, rootRef);
      if (top) {
        ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: PDFNumber.of(top.count) }));
        doc.catalog.set(PDFName.of("Outlines"), rootRef);
      }
    } catch (e) {
      this.log("Could not add bookmarks: " + e);
    }

    progress("Saving PDF…");
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  }
};

/**
 * Reads the bookmarks Chromium writes for each heading (generateDocumentOutline)
 * and returns Map(normalizedTitle → 1-based page number). Returns null if the
 * PDF can't be parsed; callers then fall back to note numbers.
 */
function pdfHeadingPages(data) {
  // → { pageCount, headings: Map(normalizedTitle → page) } or null
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const latin1 = (a, b) => {
    let s = "";
    for (let i = a; i < b; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(b, i + 0x8000)));
    return s;
  };
  try {
    const tail = latin1(Math.max(0, u8.length - 4096), u8.length);
    let m, xrefOff = -1;
    const sx = /startxref\s+(\d+)/g;
    while ((m = sx.exec(tail))) xrefOff = +m[1];
    if (xrefOff < 0) return null;
    const xref = latin1(xrefOff, u8.length);
    if (!xref.startsWith("xref")) return null;
    const offsets = new Map();
    const lines = xref.split(/\r\n|\r|\n/);
    let i = 1;
    while (i < lines.length && !lines[i].startsWith("trailer")) {
      const sub = lines[i].trim().split(/\s+/);
      if (sub.length === 2) {
        const start = +sub[0], count = +sub[1];
        for (let k = 0; k < count; k++) {
          const e = (lines[i + 1 + k] || "").trim().split(/\s+/);
          if (e[2] === "n") offsets.set(start + k, +e[0]);
        }
        i += count + 1;
      } else i++;
    }
    const rootM = /\/Root\s+(\d+)\s+\d+\s+R/.exec(xref);
    if (!rootM) return null;

    const getObj = (n) => {
      const off = offsets.get(n);
      if (off == null) return "";
      for (let win = 4096; win <= 1 << 20; win *= 4) {
        const s = latin1(off, Math.min(u8.length, off + win));
        const end = s.indexOf("endobj");
        if (end >= 0) { const st = s.indexOf("stream"); return st >= 0 && st < end ? s.slice(0, st) : s.slice(0, end); }
      }
      return "";
    };
    const ref = (obj, key) => { const r = new RegExp("/" + key + "\\s+(\\d+)\\s+\\d+\\s+R").exec(obj); return r ? +r[1] : null; };

    // Page object number → page index.
    const pageNum = new Map();
    const walk = (n, seen) => {
      if (seen.has(n)) return;
      seen.add(n);
      const o = getObj(n);
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(o);
      if (/\/Type\s*\/Pages\b/.test(o) && kids) {
        for (const k of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(+k[1], seen);
      } else pageNum.set(n, pageNum.size + 1);
    };
    const catalog = getObj(+rootM[1]);
    walk(ref(catalog, "Pages"), new Set());

    const decodeTitle = (o) => {
      const at = o.search(/\/Title\s*[(<]/);
      if (at < 0) return "";
      let j = o.indexOf(o.slice(at).match(/[(<]/)[0], at);
      const bytes = [];
      if (o[j] === "<") {
        const hex = o.slice(j + 1, o.indexOf(">", j)).replace(/\s+/g, "");
        for (let h = 0; h + 1 < hex.length; h += 2) bytes.push(parseInt(hex.substr(h, 2), 16));
      } else {
        let depth = 0;
        for (j++; j < o.length; j++) {
          const c = o[j];
          if (c === "\\") {
            const nx = o[++j];
            const esc = { n: 10, r: 13, t: 9, b: 8, f: 12 }[nx];
            if (esc != null) bytes.push(esc);
            else if (/[0-7]/.test(nx)) { let oct = nx; while (oct.length < 3 && /[0-7]/.test(o[j + 1])) oct += o[++j]; bytes.push(parseInt(oct, 8)); }
            else if (nx === "\r" || nx === "\n") { /* line continuation */ }
            else bytes.push(nx.charCodeAt(0));
          } else if (c === "(") { depth++; bytes.push(40); }
          else if (c === ")") { if (depth-- === 0) break; bytes.push(41); }
          else bytes.push(c.charCodeAt(0));
        }
      }
      const b = Uint8Array.from(bytes);
      if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
      return String.fromCharCode.apply(null, b);
    };

    const result = new Map();
    const first = ref(getObj(ref(catalog, "Outlines")), "First");
    const stack = first != null ? [first] : [];
    const seen = new Set();
    while (stack.length) {
      let n = stack.pop();
      while (n != null && !seen.has(n)) {
        seen.add(n);
        const o = getObj(n);
        const dest = /\/(?:Dest|D)\s*\[\s*(\d+)\s+\d+\s+R/.exec(o);
        const key = normKey(decodeTitle(o));
        if (dest && key && !result.has(key) && pageNum.has(+dest[1])) result.set(key, pageNum.get(+dest[1]));
        const child = ref(o, "First");
        if (child != null) stack.push(child);
        n = ref(o, "Next");
      }
    }
    return { pageCount: pageNum.size, headings: result };
  } catch (e) {
    console.warn("print-vault-pdf: could not read PDF outline", e);
    return null;
  }
}

function normKey(s) {
  return String(s).replace(/\s+/g, "").toLowerCase();
}

function buildCss(s, grouped) {
  const size = s.pageSize === "A4" ? "A4" : "Letter";
  return `
@page { size: ${size}; margin: 0.7in 0.7in 0.8in 0.7in; }

html { font-size: ${Number(s.fontSize) || 10.5}pt; }
body { margin: 0; font-family: Georgia, "Iowan Old Style", "Times New Roman", serif; line-height: 1.45; color: #111; background: #fff; }
a { color: inherit; text-decoration: none; }

/* cover */
.cover { break-after: page; height: 8.5in; display: flex; flex-direction: column; justify-content: center; text-align: center; }
.cover h1 { font-size: 2.8rem; margin: 0 0 .4em; letter-spacing: -.01em; }
.cover-sub, .cover-date { color: #555; margin: .2em 0; font-size: 1.1rem; }

/* table of contents */
.toc { break-after: page; }
.toc-title { font-size: 1.8rem; margin: 0 0 1em; }
.toc-group { margin-bottom: .6em; break-inside: auto; }
.toc-list { list-style: none; margin: 0; padding: 0 0 0 ${grouped ? "1.6em" : "0"}; }
.toc-list li { margin: 0; }
.toc-entry { display: flex; align-items: baseline; gap: .5em; padding: .08em 0; }
.toc-entry .toc-text { flex: 0 1 auto; overflow: hidden; }
.toc-pg { flex: 0 0 auto; margin-left: auto; padding-left: .5em; min-width: 2.5em; text-align: right; font-variant-numeric: tabular-nums; }
.toc-num { color: #666; min-width: 2.6em; font-variant-numeric: tabular-nums; }
.toc-chapter { font-weight: bold; font-size: 1.05rem; margin-top: .5em; border-bottom: 1px solid #ccc; }

/* chapters & notes */
.chapter-head { break-before: page; }
.chapter-title { font-size: 1.9rem; margin: 0 0 1em; padding-bottom: .3em; border-bottom: 2px solid #111; }
.chapter-num { display: inline-block; min-width: 1.6em; color: #888; }
.chapter-count { font-size: .85rem; color: #777; margin: -.8em 0 1.2em; }
.note { margin: 0 0 1.4em; padding-bottom: 1em; border-bottom: 1px solid #ddd; }
.note.new-page { break-before: page; }
.note-title { font-size: 1.35rem; margin: 0 0 .15em; break-after: avoid; }
.note-num { color: #888; font-weight: normal; margin-right: .5em; font-size: .9em; }
.note-meta { font-size: .78rem; color: #777; margin-bottom: .5em; display: flex; gap: 1em; flex-wrap: wrap; }
.links { font-size: .8rem; background: #f4f4f4; border-left: 3px solid #999; padding: .35em .6em; margin: .4em 0 .8em; break-inside: avoid; }
.links-row { margin: .1em 0; }
.links-label { font-weight: bold; margin-right: .5em; }
.links .none { color: #999; font-style: italic; }
a.xref { border-bottom: 1px dotted #888; }
.pg:not(.toc-pg) { display: inline-block; min-width: 4.6em; color: #666; font-size: .85em; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dead-link { color: #555; font-style: italic; }
.placeholder { color: #888; font-style: italic; font-size: .9em; }
.render-error { color: #a00; }

/* note body */
.note-body h1 { font-size: 1.25rem; } .note-body h2 { font-size: 1.15rem; } .note-body h3 { font-size: 1.05rem; }
.note-body h4, .note-body h5, .note-body h6 { font-size: 1rem; }
.note-body h1, .note-body h2, .note-body h3, .note-body h4 { break-after: avoid; margin: 1em 0 .3em; }
.note-body p { margin: .4em 0; orphans: 3; widows: 3; }
.note-body img { max-width: 100%; max-height: 7in; height: auto; break-inside: avoid; }
.note-body pre { background: #f6f6f6; border: 1px solid #e2e2e2; padding: .5em .7em; white-space: pre-wrap; word-wrap: break-word; font-size: .82rem; }
.note-body code { font-family: Menlo, Consolas, monospace; font-size: .88em; background: #f2f2f2; padding: 0 .2em; }
.note-body pre code { background: none; padding: 0; }
.note-body blockquote { border-left: 3px solid #bbb; margin: .6em 0; padding: .1em .9em; color: #333; }
.note-body table { border-collapse: collapse; margin: .6em 0; font-size: .9rem; max-width: 100%; }
.note-body th, .note-body td { border: 1px solid #bbb; padding: .25em .5em; vertical-align: top; }
.note-body th { background: #eee; }
.note-body tr { break-inside: avoid; }
.note-body ul, .note-body ol { padding-left: 1.5em; margin: .3em 0; }
.note-body li.task-list-item { list-style: none; margin-left: -1.3em; }
.note-body input[type=checkbox] { margin-right: .4em; }
.note-body hr { border: 0; border-top: 1px solid #ccc; margin: 1em 0; }
.note-body .tag, .meta-tags { color: #555; }
.note-body .callout { border: 1px solid #ccc; border-left: 4px solid #666; padding: .4em .8em; margin: .6em 0; background: #fafafa; break-inside: avoid; }
.note-body .callout-title { font-weight: bold; display: flex; gap: .4em; }
.note-body .callout-icon svg { width: 1em; height: 1em; }
.note-body .callout.is-collapsed .callout-content { display: block !important; }
.note-body .frontmatter, .note-body .frontmatter-container, .note-body .mod-header { display: none; }
.note-body .footnotes { font-size: .85rem; border-top: 1px solid #ddd; margin-top: 1em; }
.note-body svg { max-width: 100%; }
`;
}

class PrintVaultSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    new Setting(containerEl).setName("Export now").setDesc("Same as the printer icon in the ribbon.")
      .addButton((b) => b.setButtonText("Export vault to PDF").setCta().onClick(() => this.plugin.exportPdf()));

    new Setting(containerEl).setName("Organization").setHeading();
    new Setting(containerEl).setName("Group notes by").setDesc("Each group becomes a chapter in the table of contents.")
      .addDropdown((d) => d.addOptions({ folder: "Folder", tag: "Tag", none: "Nothing (one alphabetical list)" }).setValue(s.groupBy)
        .onChange(async (v) => { s.groupBy = v; await save(); this.display(); }));
    if (s.groupBy === "tag") {
      new Setting(containerEl).setName("Tag chapters (in order)")
        .setDesc("Comma-separated, e.g. school, work, ideas. A note goes in the first listed tag it has; the rest go in “Other notes”. Leave blank to use each note's first tag.")
        .addText((t) => t.setPlaceholder("school, work, ideas").setValue(s.tagOrder).onChange(async (v) => { s.tagOrder = v; await save(); }));
    }
    new Setting(containerEl).setName("Sort notes within a group")
      .addDropdown((d) => d.addOptions({ name: "By name", created: "By created date (oldest first)", modified: "By modified date (newest first)" }).setValue(s.sortBy)
        .onChange(async (v) => { s.sortBy = v; await save(); }));
    new Setting(containerEl).setName("Exclude folders").setDesc("Comma-separated folder paths (subfolders are excluded too).")
      .addTextArea((t) => t.setValue(s.excludeFolders).onChange(async (v) => { s.excludeFolders = v; await save(); }));
    new Setting(containerEl).setName("Exclude tags").setDesc("Comma-separated; notes with any of these tags are skipped.")
      .addText((t) => t.setPlaceholder("private, draft").setValue(s.excludeTags).onChange(async (v) => { s.excludeTags = v; await save(); }));

    new Setting(containerEl).setName("Content").setHeading();
    new Setting(containerEl).setName("Show incoming & outgoing links").setDesc("Adds a “Links to / Linked from” box under each note title, with page numbers.")
      .addToggle((t) => t.setValue(s.showLinks).onChange(async (v) => { s.showLinks = v; await save(); }));
    new Setting(containerEl).setName("Show tags under note titles")
      .addToggle((t) => t.setValue(s.showTags).onChange(async (v) => { s.showTags = v; await save(); }));
    new Setting(containerEl).setName("Include images")
      .addToggle((t) => t.setValue(s.includeImages).onChange(async (v) => { s.includeImages = v; await save(); }));

    new Setting(containerEl).setName("Layout").setHeading();
    new Setting(containerEl).setName("Document title").setDesc("Blank = vault (or folder) name.")
      .addText((t) => t.setValue(s.title).onChange(async (v) => { s.title = v; await save(); }));
    new Setting(containerEl).setName("Page size")
      .addDropdown((d) => d.addOptions({ Letter: "US Letter", A4: "A4" }).setValue(s.pageSize).onChange(async (v) => { s.pageSize = v; await save(); }));
    new Setting(containerEl).setName("Font size (pt)")
      .addSlider((sl) => sl.setLimits(8, 14, 0.5).setValue(s.fontSize).setDynamicTooltip().onChange(async (v) => { s.fontSize = v; await save(); }));
    new Setting(containerEl).setName("Start each note on a new page").setDesc("Off saves paper; chapters always start on a new page.")
      .addToggle((t) => t.setValue(s.noteOnNewPage).onChange(async (v) => { s.noteOnNewPage = v; await save(); }));

    new Setting(containerEl).setName("Output").setHeading();
    new Setting(containerEl).setName("Save PDFs to folder").setDesc("Inside your vault. This folder is never included in exports.")
      .addText((t) => t.setValue(s.outputFolder).onChange(async (v) => { s.outputFolder = v; await save(); }));
    new Setting(containerEl).setName("Open PDF when done")
      .addToggle((t) => t.setValue(s.openAfterExport).onChange(async (v) => { s.openAfterExport = v; await save(); }));
    new Setting(containerEl).setName("Also save the HTML").setDesc("Useful for debugging or printing from a browser.")
      .addToggle((t) => t.setValue(s.keepHtml).onChange(async (v) => { s.keepHtml = v; await save(); }));
  }
}
