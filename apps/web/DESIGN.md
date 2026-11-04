---
name: Phi
description: A local LaTeX workspace set like a mathematical reference handbook, where every compile problem is a numbered entry tied to its line.
colors:
  binding-cloth: "oklch(0.39 0.055 196)"
  binding-cloth-light-thread: "oklch(0.96 0.01 190)"
  cloth-rail-muted: "oklch(0.83 0.03 190)"
  cloth-rail-accent: "oklch(0.45 0.058 196)"
  cloth-rail-rule: "oklch(0.46 0.05 196)"
  cool-page: "oklch(0.951 0.004 165)"
  sheet-white: "oklch(0.987 0.002 165)"
  press-ink: "oklch(0.205 0.005 240)"
  margin-grey: "oklch(0.48 0.01 230)"
  hairline: "oklch(0.885 0.005 165)"
  field-line: "oklch(0.86 0.006 165)"
  pale-wash: "oklch(0.94 0.006 170)"
  cloth-wash: "oklch(0.925 0.014 190)"
  focus-teal: "oklch(0.5 0.07 196)"
  erratum-red: "oklch(0.52 0.19 28)"
  caution-ochre: "oklch(0.55 0.12 65)"
  syntax-command: "oklch(0.42 0.075 196)"
  syntax-math: "oklch(0.44 0.06 255)"
  syntax-punct: "oklch(0.55 0.01 230)"
  graphite-page: "oklch(0.17 0.006 200)"
  graphite-sheet: "oklch(0.205 0.007 200)"
  graphite-ink: "oklch(0.92 0.006 170)"
  graphite-rule: "oklch(0.3 0.008 200)"
  binding-cloth-dark: "oklch(0.27 0.04 196)"
  cloth-primary-dark: "oklch(0.66 0.075 190)"
  erratum-red-dark: "oklch(0.69 0.16 28)"
  caution-ochre-dark: "oklch(0.78 0.12 75)"
typography:
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: "20px"
    fontFeature: "tnum"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
    fontFeature: "tnum"
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "16px"
    fontFeature: "tnum"
  entry-number:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.65
    fontFeature: "tnum"
  source:
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  ref: "4px"
  sm: "3.6px"
  md: "4.8px"
  lg: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "24px"
  pane-head: "36px"
  bar: "44px"
components:
  button-primary:
    backgroundColor: "{colors.binding-cloth}"
    textColor: "{colors.binding-cloth-light-thread}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-ghost:
    textColor: "{colors.margin-grey}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "24px"
  button-ghost-hover:
    backgroundColor: "{colors.pale-wash}"
    textColor: "{colors.press-ink}"
  compile-bar:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.margin-grey}"
    typography: "{typography.label}"
    padding: "0 12px"
    height: "{spacing.bar}"
  file-rail:
    backgroundColor: "{colors.binding-cloth}"
    textColor: "{colors.binding-cloth-light-thread}"
    typography: "{typography.body}"
  file-rail-item-active:
    backgroundColor: "{colors.cloth-rail-accent}"
    textColor: "{colors.binding-cloth-light-thread}"
    rounded: "{rounded.md}"
    padding: "8px"
  pane-header:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.margin-grey}"
    typography: "{typography.label}"
    padding: "0 12px"
    height: "{spacing.pane-head}"
  entries-head:
    textColor: "{colors.press-ink}"
    typography: "{typography.body}"
    padding: "0 8px"
    height: "40px"
  entries-row:
    textColor: "{colors.press-ink}"
    typography: "{typography.body}"
    padding: "8px"
  entries-row-selected:
    backgroundColor: "{colors.pale-wash}"
  margin-ref-error:
    textColor: "{colors.erratum-red}"
    typography: "{typography.entry-number}"
    rounded: "{rounded.ref}"
    padding: "0 4px"
  margin-ref-warning:
    textColor: "{colors.caution-ochre}"
    typography: "{typography.entry-number}"
    rounded: "{rounded.ref}"
    padding: "0 4px"
  source-editor:
    backgroundColor: "{colors.sheet-white}"
    textColor: "{colors.press-ink}"
    typography: "{typography.source}"
---

# Design System: Phi

## Overview

**Creative North Star: "The Reference Handbook"**

The workspace is set like a mathematical reference handbook bound in blue-green cloth. Every compile problem becomes a numbered entry (E1, W1) that is cross-referenced to its source line the way an equation number is cross-referenced to its equation: the Entries table names the line, and the editor's right margin carries the same number in parentheses. The two point at each other, and one click on either lands on the other.

Density is that of a working tool for long sessions. Chrome is compact system sans at 12 to 14px; source is system mono at 13px. Pages are cool near-white in light mode and graphite in dark mode, separated by hairline rules, with one full-ink rule under every table head. Colour is spare on purpose: the binding cloth owns the file rail and the primary action, and red and ochre appear only when a build reports something. Nothing decorative competes with the document, so the PDF and the source stay the brightest, calmest things on screen.

Dark mode is a first-class rendering of the same handbook, not an inversion: the cloth deepens, the page goes to graphite, and the PDF sheet is dimmed slightly so a white page does not glare during long sessions.

**Key Characteristics:**
- Blue-green binding cloth on the file rail and the one primary button; nowhere else as a fill.
- Numbered, cross-referenced entries (E1, W1) instead of an anonymous problems list.
- Hairline rules everywhere, one full-ink rule under each table head.
- Red and ochre carry compile and save state only.
- Tabular figures throughout; system sans for chrome, system mono for source.
- Flat panes; depth only in transient overlays.

## Colors

A cool, nearly colourless paper-and-ink palette held together by one blue-green cloth, with two state colours that only speak when a build has something to say. All values are OKLCH and live in `src/styles/globals.css` (`:root` for light, `.dark` for dark); that file is the source of truth.

### Primary
- **Binding Cloth** (`--primary`, `--sidebar`): the deep blue-green of a handbook's cloth cover. It fills the file rail and the Compile button, colours the caret, and tints selection (22%), bracket matches (16%) and selection matches (10%). In dark mode the rail deepens to Binding Cloth Dark and the button lifts to Cloth Primary Dark so it still reads against graphite.
- **Light Thread** (`--primary-foreground`, `--sidebar-foreground`): the pale cloth-tinted white used for text on cloth.
- **Rail Muted / Rail Accent / Rail Rule** (`--sidebar-muted`, `--sidebar-accent`, `--sidebar-border`): secondary text on the rail (group label, per-file entry numbers), the active file's raised cloth, and the rule under the project name.

### Tertiary (state only)
- **Erratum Red** (`--destructive`): errors. Error entry numbers, margin refs, wavy underlines, the 7% line tint, error counts in captions, save conflicts and failed compiles.
- **Caution Ochre** (`--warning`, a project-specific token beyond the shadcn set): warnings. Warning entry numbers, margin refs, wavy underlines, the 8% line tint, the conflict banner icon.

### Neutral
- **Cool Page** (`--background`): the field behind the PDF and the app shell; faintly green-grey near-white.
- **Sheet White** (`--card`, `--popover`): the surfaces you read and type on: compile bar, editor, Entries pane, pane headers, Agent slot.
- **Press Ink** (`--foreground`): body text, table heads, the full-ink rule under every table head.
- **Margin Grey** (`--muted-foreground`): captions, locations, comments in source, inactive line numbers (at 70%).
- **Hairline** (`--border`) and **Field Line** (`--input`): pane dividers, row rules, input strokes.
- **Pale Wash / Cloth Wash** (`--muted`, `--accent`): hover and selected rows; the active editor line (accent at 55%).
- **Focus Teal** (`--ring`): every focus ring and outline.
- **Graphite Page / Graphite Sheet / Graphite Ink / Graphite Rule**: the dark-mode counterparts of the four neutrals above.

### Syntax
- **Command** (`--syntax-command`): control sequences, in a darker cut of the cloth hue so source feels bound to the same book.
- **Math** (`--syntax-math`): math atoms, numbers and strings, in a muted blue.
- **Punctuation** (`--syntax-punct`): braces and brackets, near the margin grey so structure recedes behind words.

### Named Rules
**The Cloth Rule.** The binding cloth fills exactly two things: the file rail and the primary action. Elsewhere it appears only as caret, focus and translucent selection tints.

**The State-Only Rule.** Erratum red and caution ochre appear only on compile or save state (entry numbers, margin refs, underlines, line tints, counts, conflict and failure notices). A count of zero is never coloured: "0 warnings" stays margin grey.

**The Measured Contrast Rule.** Every text/background pair in both themes meets WCAG AA; the tightest is light ochre on Sheet White at 4.84:1. New pairs must be measured, not assumed.

The shadcn `--chart-1..5` defaults are present in globals.css but unused; they are not part of this palette.

## Typography

**Chrome Font:** system sans (`ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`)
**Source Font:** system mono (`ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace`)

**Character:** The platform's own sans and mono, set small and even, so the interface reads like the apparatus of a book (running heads, captions, references) and leaves the voice to the document.

### Hierarchy
- **Title** (600, 14px): app name, project name on the rail, pane titles ("Entries"), "Build N" in the caption, the PDF file name.
- **Body** (400, 14px): table cells, file names, buttons (500), menu items.
- **Label** (400, 12px): build and save captions, pane-header metadata, kbd hints, file locations (in mono at 12px).
- **Entry Number** (600, 12px, tabular): "(E1)" in the margin and "E1" in the table and rail.
- **Source** (400, 13px, line-height 1.65): the editor. Comments italic in margin grey.

### Named Rules
**The Tabular Rule.** All figures are tabular (`font-variant-numeric: tabular-nums` on body). Build numbers, counts, line numbers and entry numbers must align like a handbook's index.

**The Two-Face Rule.** Sans for everything that is chrome, mono for everything that is source or a file path. No third face, no display face.

## Layout

Desktop is three resizable panes under a 44px compile bar: the cloth file rail (17% default, 180px minimum), the source column (45%) split vertically into editor (72%) over the docked Entries table (28%, 96px minimum), and the PDF pane (38%), followed by a fixed 44px Agent slot at the far right. Each pane opens with its own 36px header (tabs for the editor, title and build caption for Entries, file name, build and page count for the PDF). The rail header matches the bar at 44px.

Below 768px the layout collapses to one pane at a time, switched by a 36px line-tab strip (Source / PDF / Entries); the file rail becomes an offcanvas drawer (18rem) opened from a trigger in the compile bar, and the build duration in the caption gives way first so the save status stays visible.

Spacing is a tight 4px-based rhythm: 12px horizontal padding in bars and pane headers, 8px table cell padding, 24px around PDF pages. Panes meet edge to edge at hairline rules; there are no gutters or cards floating in space.

### Named Rules
**The Same-Page Rule.** A rebuild replaces the PDF without moving the reader: the scroll position is restored as a fraction of the document height.

## Elevation & Depth

The workspace is flat. Panes are separated by 1px hairline rules and by the step between Cool Page and Sheet White, not by shadow. Depth appears only on transient overlays (menus, tooltips, the mobile drawer), which use the shadcn primitives' own soft shadows; the CodeMirror tooltip matches them.

### Shadow Vocabulary
- **Overlay** (`box-shadow: 0 4px 12px -2px rgb(0 0 0 / 0.12)`): editor diagnostic tooltips, alongside the menu and sheet shadows from the shadcn primitives.

### Named Rules
**The Flat Pane Rule.** Nothing docked in the layout casts a shadow. If it stays on screen, it is separated by a rule.

## Shapes

Corners are small and mostly square in feeling: a 6px base radius (`--radius: 0.375rem`) on buttons, with 4.8px on small and icon buttons, 4px on margin references, and square corners on panes, tab strips and full-width banners. Rules are the dominant form: 1px hairlines between everything, and one 1px Press Ink rule under every table head. The only round shape is the 6px dot that marks an unsaved tab or an entry new in this build.

## Components

Built on shadcn/ui (base-nova style, Tailwind v4, lucide icons); the primitives in `src/components/ui/` are the library, and the project-specific character comes from tokens and the components below.

### Buttons
- **Shape:** gently squared (6px; 4.8px at small sizes).
- **Primary:** Binding Cloth fill, Light Thread text, 32px tall, 10px horizontal padding, icon at 16px. Used once per view: Compile in the bar, and Compile in the empty PDF pane.
- **Hover / Focus:** hover drops the fill to 80%; focus shows a 3px Focus Teal ring at 50%; pressed nudges down 1px.
- **Ghost:** transparent, Margin Grey text, Pale Wash on hover. Used for the log toggle, theme menu, tab close and Agent slot.
- **Outline / Destructive:** only inside the disk-conflict banner ("Reload from disk", "Overwrite with mine"); destructive is a 10% red wash with red text, not a solid red block.

### Compile Bar
A 44px Sheet White strip: app name, a vertical rule, Compile, then a 12px Margin Grey caption "Build N · time · counts · save state" (Build N in Press Ink semibold; non-zero counts semibold in their state colour). Right side: the ⌘S hint as kbd keys and the theme menu.

### File Rail (Navigation)
The cloth itself. Project name in title weight over a Rail Rule, a "Files" group label in Rail Muted, then the tree with lucide file and folder icons. The active file sits on Rail Accent with 4.8px corners. Files with entries carry their entry numbers right-aligned in Rail Muted semibold (up to three, then "+N").

### Entries Table (signature)
The handbook's index of problems. A 36px header with the title "Entries", the build caption and a ghost Log toggle. The table has three columns, "No." (56px), "Location" (224px, mono 12px Margin Grey, `file:line`, or "see log") and "Message", under a 40px head closed by a full Press Ink rule. Rows are hairline-ruled, Pale Wash on hover, and focusable; the selected row is Pale Wash and its number gets a 1px ring in its own colour. Empty and not-yet-compiled states keep the head and rule and show a single muted note row. The raw log opens below in mono 12px.

### Margin References (signature)
"(E1)" floated at the right end of the source line in entry-number type and the entry's state colour, with a transparent 1px border that shows Hairline on hover and turns currentColor when it is the active entry. The line carries a 7% red or 8% ochre tint, and the offending range a wavy underline offset 4px. Clicking a reference selects the matching table row; clicking a row lands on the line.

### Pane Headers and Tabs
36px Sheet White headers with hairline bottom rules. Editor file tabs and mobile pane tabs are shadcn line tabs: no fill, a 2px Press Ink underline on the active tab, a 6px Margin Grey dot for unsaved files.

### Alerts and Empty States
Full-width alerts sit flush (square corners, no side borders) at the top of the pane they concern: the disk conflict (ochre icon, outline + destructive actions) and save failure. Empty states (no file open, no PDF yet) are centred shadcn Empty blocks with one plain sentence and at most one primary action.

### PDF Pane
Cool Page field, pages inset 24px, header naming the file, the build it shows and the page count. In dark mode page canvases are dimmed to `brightness(0.9)`.

## Do's and Don'ts

### Do:
- **Do** number every compile problem (E1, W1) and show the same number in the table, the editor margin and the file rail.
- **Do** keep the binding cloth to the file rail and the single primary action per view.
- **Do** put a full Press Ink rule under every table head and hairlines everywhere else.
- **Do** keep all figures tabular and name the build ("Build N") wherever compile output is shown.
- **Do** separate docked panes with 1px rules and the Cool Page / Sheet White step, not shadows.
- **Do** measure any new text/background pair against WCAG AA in both themes.

### Don't:
- **Don't** use erratum red or caution ochre for anything other than compile or save state, and don't colour a zero count.
- **Don't** show compile problems as an anonymous list of red dots; every problem gets a number and a location (or "see log").
- **Don't** add a third typeface or a display face; chrome is system sans, source and paths are system mono.
- **Don't** give docked panes cards, rounded containers or drop shadows.
- **Don't** fill the primary action with anything but the cloth: no stock bright-green run button, no solid red button.
