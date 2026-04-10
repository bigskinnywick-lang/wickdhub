# WickdHub — Site Reference

Quick reference for Claude (or Adam) to add, update, or maintain content on the WickdHub site. Follow these conventions exactly to keep things consistent and avoid debugging.

---

## Locations

| What | Path |
|------|------|
| **Local repo (source of truth)** | `~/Documents/GitHub/wickdhub/` |
| **Live site** | [wickdhub.com](https://wickdhub.com) |
| **GitHub repo** | `bigskinnywick-lang/wickdhub` |
| **Hosting** | Cloudflare Pages — auto-deploys from GitHub on push |

> Single local clone at `~/Documents/GitHub/wickdhub/`. No secondbrain backup — removed April 10, 2026.

---

## Tech Stack

- **MkDocs** with **Material for MkDocs** theme
- **Python-based** — `mkdocs build` generates static HTML into `site/`
- **Cloudflare Pages** handles build + deploy automatically on push
- Build command: `mkdocs build`
- Output directory: `site`
- Python dependencies: `mkdocs>=1.6`, `mkdocs-material>=9.5`

---

## Project Structure

```
wickdhub/
├── mkdocs.yml              ← Site config + nav (edit this when adding pages)
├── requirements.txt        ← Python deps
├── docs/
│   ├── index.md            ← Homepage
│   ├── stylesheets/
│   │   └── custom.css      ← Full-width layout, iframe styles, nav styling
│   ├── assets/
│   │   └── images/
│   │       └── helmet.png  ← Logo + favicon
│   ├── outlines/
│   │   └── index.md
│   ├── trackers/
│   │   ├── index.md
│   │   ├── track2-weekly.md
│   │   ├── track1-weekly.md
│   │   ├── mcte-6week-plan.md
│   │   ├── assets/         ← HTML dashboards embedded via iframe
│   │   └── content/
│   │       ├── index.md
│   │       ├── *.md         ← Storyboards, capture guides
│   │       └── assets/      ← HTML files for content embeds
│   ├── research/
│   │   ├── index.md
│   │   ├── domain-hosting-research.md
│   │   └── assets/
│   │       └── domain-hosting-research.html
│   ├── summaries/
│   │   ├── index.md
│   │   ├── inform-source-summary.md
│   │   └── assets/
│   │       └── inform-source-summary.html
│   └── personal/
│       ├── index.md
│       ├── personal-tracker.md
│       ├── popos-install.md
│       └── assets/
│           ├── personal-tracker.html
│           └── popos-install-guide.html
└── site/                    ← Built output (don't edit, auto-generated)
```

---

## Known Gotcha: MkDocs File Paths in Iframes

MkDocs builds every markdown page into its own subfolder. For example:

```
Source:  docs/personal/popos-install.md
Built:   site/personal/popos-install/index.html
```

This means **relative paths inside the built page are one level deeper** than you'd expect from the source file's location. So when referencing an asset from a markdown file:

```
WRONG:  src="assets/my-file.html"        ← looks right in source, 404 on site
RIGHT:  src="../assets/my-file.html"      ← accounts for the build subfolder
```

This has bitten us before. Every existing embed page on the site uses `../assets/`. Always do the same.

---

## How to Add a New Page

### Pattern 1: Simple markdown page (text/tables/code only)

1. Create `docs/<section>/my-page.md`
2. Add to nav in `mkdocs.yml`

### Pattern 2: Interactive HTML embed (dashboards, trackers, guides)

This is the most common pattern on the site. Rich interactive HTML gets embedded via iframe inside a thin markdown wrapper.

**Step 1 — Place the HTML file:**
```
docs/<section>/assets/<filename>.html
```

**Step 2 — Create the markdown wrapper:**
```
docs/<section>/<filename>.md
```

With this content:

```markdown
# Page Title

One-line description of what this is.

<div class="iframe-wrap">
  <iframe src="../assets/<filename>.html" loading="lazy"></iframe>
</div>
```

**Important:** The `src` path uses `../assets/` (one level up) because MkDocs builds each page into its own subfolder (e.g. `popos-install.md` becomes `popos-install/index.html`). So from inside that subfolder, you need `../` to reach the `assets/` directory.

The `iframe-wrap` class in `custom.css` handles full-width layout, min-height (85vh), border-radius, and border removal. No inline styles needed.

**Step 3 — Add to nav in `mkdocs.yml`:**
```yaml
  - Section Name:
    - Overview: section/index.md
    - Display Name: section/my-page.md
```

**Step 4 — Update the section's `index.md`** if it has a manual link list (like the Guides landing page does).

---

## How to Add a New Section

1. Create the folder: `docs/<new-section>/`
2. Create `docs/<new-section>/index.md` with a heading and brief description
3. If it will have HTML embeds, create `docs/<new-section>/assets/`
4. Add the section to `nav:` in `mkdocs.yml`:
   ```yaml
   nav:
     # ... existing sections ...
     - New Section:
       - Overview: new-section/index.md
       - Page Name: new-section/page-name.md
   ```

---

## Naming Conventions

| Thing | Convention | Example |
|-------|-----------|---------|
| Folders | lowercase, hyphens | `docs/research/` |
| Markdown files | lowercase, hyphens | `popos-install.md` |
| HTML assets | lowercase, hyphens | `popos-install-guide.html` |
| Nav labels | Title Case | `Pop!_OS Install` |
| Section index files | Always `index.md` | `docs/guides/index.md` |
| Section overview label | Always `Overview` | `- Overview: guides/index.md` |

---

## Nav Structure (mkdocs.yml)

The current nav order is:

```yaml
nav:
  - Home: index.md
  - Outlines
  - Trackers (with Content sub-section)
  - Research
  - Summaries
  - Personal (personal tracker, guides, etc.)
```

Each section follows this pattern:
```yaml
  - Section Name:
    - Overview: section/index.md
    - Display Name: section/page.md
```

Sub-sections nest one level deeper (like Content under Trackers).

---

## Deploy Workflow

1. Make changes in `~/Documents/GitHub/wickdhub/`
2. Open **GitHub Desktop**
3. Review changes, write a commit message, commit
4. Click **Push** to origin
5. Cloudflare Pages auto-builds in ~30 seconds
6. Check [wickdhub.com](https://wickdhub.com) to verify

---

## Custom CSS Notes

`docs/stylesheets/custom.css` provides:

- **Full-width layout** — all content areas are `max-width: 100%`
- **iframe-wrap class** — standard iframe container: full width, 85vh min-height, 8px border-radius, no border
- **Sidebar styling** — section labels are uppercase purple (`#a78bfa`), sub-sections are blue (`#60a5fa`), active links get a left accent bar
- **Tab bar** — bold active tab, subtle letter-spacing

If you need to adjust iframe height for a specific page, you can add a page-level `<style>` block, but prefer the global class when possible.

---

## File Cleanup Convention

- **Before deleting anything**, ask Adam for permission — he'll usually grant it.
- **Uncertain files** — move to `~/Projects/Trash/` instead of deleting.
- **Trash retention** — files older than 30 days in the Trash folder are safe to delete.
- This applies project-wide, not just to WickdHub.

---

## Quick Checklist for Claude

When Adam asks to add something to WickdHub:

- [ ] Identify which section it belongs to (or if a new section is needed)
- [ ] Place HTML asset in `docs/<section>/assets/`
- [ ] Create markdown wrapper using `iframe-wrap` pattern
- [ ] Update `docs/<section>/index.md` if it has a link list
- [ ] Add to `nav:` in `mkdocs.yml`
- [ ] Ensure files are in the **local repo** (`~/Documents/GitHub/wickdhub/`)
- [ ] Remind Adam to commit + push via GitHub Desktop
