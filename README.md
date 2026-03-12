# Sigma Decomposition Tree v2

A custom Sigma Computing plugin that renders data as an interactive horizontal decomposition tree — with curved connectors, a pannable/zoomable canvas, hover tooltips, and collapsible branches.

Live URL: https://coderockride.github.io/sigma

---

## What it looks like

- A dotted canvas with a horizontal node-link layout — root on the left, children expanding right
- Curved bezier connectors between nodes, colour-coded by depth level
- Column type labels above each tier (e.g. REGION, SEGMENT, CATEGORY)
- Breadcrumb trail top-left showing the active drill path
- Node count badge bottom-right

---

## Interactions

| Action | How |
|---|---|
| **Collapse / expand** a branch | Click any node (or its +/− badge) |
| **Pan** the canvas | Click and drag the background |
| **Zoom** | Scroll wheel, or use the +/− buttons bottom-right |
| **Tooltip** | Hover any node to see value, % of total, row count, and child count |

---

## Editor panel configuration

| Field | Type | Description |
|---|---|---|
| **Data Source** | Element | The Sigma table or chart to read from |
| **Level 1** | Column | Top-level dimension (e.g. Region) |
| **Level 2** | Column | Second dimension (e.g. Segment) |
| **Level 3–6** | Column | Optional further drill-downs |
| **Value Column** | Numeric column | The measure to sum (e.g. Revenue) |
| **Chart Title** | Text | Optional — not currently rendered on canvas |

Add level columns in the order you want them to appear left to right. Unused levels can be left empty. Aggregation happens within each parent context, so "Sales" under "North America" and "Sales" under "EMEA" remain separate nodes.

---

## Local development

**Prerequisites:** Node.js 18+, a Sigma account with plugin developer permissions, and the Sigma Plugin Dev Playground registered by your org admin pointing to `http://localhost:3000`.

```bash
# Install dependencies
npm install

# Start dev server on port 3000
npm start
```

In Sigma: open any workbook → Edit → **+** → Plugins → **Sigma Plugin Dev Playground**.

---

## Deploying updates

```bash
npm run deploy
```

Builds the app and pushes to the `gh-pages` branch. The live URL updates within a minute or two.

---

## Registering in Sigma

Admin Portal → **Account** → **Custom Plugins** → **Add**

| Field | Value |
|---|---|
| Name | Decomposition Tree |
| Production URL | `https://coderockride.github.io/sigma-decomp-tree` |
| Development URL | `http://localhost:3000` |

---

## Project structure

```
decomptree/
├── public/
├── src/
│   ├── App.js        # All plugin logic, layout, and rendering
│   └── index.js      # React entry point
├── package.json
└── README.md
```

---

## How it works

The plugin uses Sigma's `useConfig()` and `useElementData()` hooks to pull live data from the workbook. Each row is walked down the configured level columns to build a nested path (e.g. `Europe → Enterprise → Software`). Rows sharing the same path prefix are summed together.

Layout is computed in two passes: first collecting all visible nodes into depth-based columns, then assigning x/y coordinates. Collapsed branches are excluded from layout so the canvas reflows cleanly. Curved SVG bezier paths are drawn between each parent and child using the midpoint as both control points, giving the smooth S-curve connectors.

---

## Dependencies

| Package | Role |
|---|---|
| `@sigmacomputing/plugin` | Sigma Plugin API (data & config hooks) |
| `react` / `react-dom` | UI framework |
| `react-scripts` | CRA build tooling |
