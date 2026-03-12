import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { client, useConfig, useElementData, useElementColumns } from "@sigmacomputing/plugin";

// ─────────────────────────────────────────────────────────────────────────────
// EDITOR PANEL CONFIGURATION
//
// client.config.configureEditorPanel() tells Sigma what controls to show in
// the right-hand "Properties" panel when a user selects this plugin element.
//
// Each object in the array becomes one field in that panel:
//   type: "element" → a dropdown to pick a data source (table/chart)
//   type: "column"  → a dropdown to pick a column from the chosen element
//   type: "text"    → a free-text input (we use this for hex colour values)
//
// The `name` property is the key we later read from `useConfig()`.
// The `source` property on column fields links them to the element picker so
// Sigma knows which element's columns to list.
// ─────────────────────────────────────────────────────────────────────────────
client.config.configureEditorPanel([
  { name: "source",      type: "element", label: "Data Source" },

  // Dimension columns — each one becomes a level in the tree hierarchy.
  // Level 1 is the top (e.g. Region), Level 2 drills into it (e.g. Department), etc.
  // Users only need to fill in the levels they want; unused ones are ignored.
  { name: "level1", type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 1 (top)" },
  { name: "level2", type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 2" },
  { name: "level3", type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 3" },
  { name: "level4", type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 4" },
  { name: "level5", type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 5" },
  { name: "level6", type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 6" },

  // The numeric column whose values get summed at each node.
  { name: "valueColumn", type: "column", source: "source", allowedTypes: ["number","integer"], label: "Value Column" },

  // One hex colour input per depth level (root = depth 0, level1 = depth 1, …).
  // These default to a tasteful palette but the user can override any of them.
  { name: "color0", type: "text", label: "Root node colour (hex)", defaultValue: "#6366f1" },
  { name: "color1", type: "text", label: "Level 1 colour (hex)",   defaultValue: "#0ea5e9" },
  { name: "color2", type: "text", label: "Level 2 colour (hex)",   defaultValue: "#10b981" },
  { name: "color3", type: "text", label: "Level 3 colour (hex)",   defaultValue: "#f59e0b" },
  { name: "color4", type: "text", label: "Level 4 colour (hex)",   defaultValue: "#ec4899" },
  { name: "color5", type: "text", label: "Level 5 colour (hex)",   defaultValue: "#8b5cf6" },
  { name: "color6", type: "text", label: "Level 6 colour (hex)",   defaultValue: "#14b8a6" },
]);

// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT CONSTANTS
//
// These control the size and spacing of nodes on the canvas.
// Tweak these if you want nodes to be bigger, further apart, etc.
// ─────────────────────────────────────────────────────────────────────────────
const NODE_W     = 200;  // width of each node card in pixels
const NODE_H     = 80;   // height of each node card in pixels
const COL_GAP    = 110;  // horizontal gap between depth columns
const ROW_GAP    = 16;   // vertical gap between sibling nodes
const COL_HEADER = 28;   // space reserved at the top of each column for the label
const ANIM_MS    = 320;  // duration of enter/exit animations in milliseconds

// ─────────────────────────────────────────────────────────────────────────────
// COLOUR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Fallback palette used when the user hasn't entered a custom colour.
const DEFAULT_COLORS = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ec4899","#8b5cf6","#14b8a6"];

// Returns the colour for a given tree depth.
// Validates that the user-supplied value looks like a hex colour before using it,
// so a typo in the editor panel won't crash the UI.
function getColor(config, depth) {
  const raw = config?.[`color${depth}`];
  if (raw && /^#[0-9a-fA-F]{3,6}$/.test(raw.trim())) return raw.trim();
  return DEFAULT_COLORS[depth % DEFAULT_COLORS.length];
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Formats large numbers into human-readable shorthand (e.g. 1500000 → "1.5M").
function fmt(val) {
  if (val === null || val === undefined) return "";
  if (Math.abs(val) >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
  if (Math.abs(val) >= 1_000)     return (val / 1_000).toFixed(1) + "K";
  return Number(val).toLocaleString();
}

// Sigma internally identifies columns by a long opaque ID like
// "inode-5EphWHmhKYxtYVPrhK0KBw/TOTAL_SALES".
// useElementColumns() gives us a lookup map from those IDs to metadata objects
// that include the human-readable column name.
// This helper does the lookup and falls back to the raw ID if no match is found.
function resolveColName(columnId, columns) {
  if (!columnId || !columns) return columnId || "";
  return columns[columnId]?.name || columnId;
}

// Returns the display name for a given depth level:
//   depth 0 = the value column (used as the root node label)
//   depth 1 = Level 1 column name, depth 2 = Level 2 column name, etc.
function getLevelName(config, depth, columns) {
  if (depth === 0) return resolveColName(config?.valueColumn, columns);
  const keys = ["level1","level2","level3","level4","level5","level6"];
  return resolveColName(config?.[keys[depth - 1]], columns);
}

// ─────────────────────────────────────────────────────────────────────────────
// TREE CONSTRUCTION
//
// Sigma gives us data in a columnar format — each column is an array of values,
// one per row. We first convert that into an array of row objects, then build
// a nested tree by walking each row's values down the configured level columns.
//
// Example with levels [Region, Department] and value [Revenue]:
//   Row: { Region: "EMEA", Department: "Sales", Revenue: 100 }
//   → ROOT.value += 100
//   → ROOT → "EMEA".value += 100
//   → ROOT → "EMEA" → "Sales".value += 100
//
// Rows that share the same path (e.g. two EMEA/Sales rows) are automatically
// aggregated because we reuse the same node object for matching labels.
// ─────────────────────────────────────────────────────────────────────────────
function buildTree(rows, levelKeys, valueKey) {
  // ROOT is a virtual node that acts as the parent of all Level 1 nodes.
  const ROOT = { label: "Total", value: 0, childMap: new Map(), depth: 0, rowCount: 0 };

  rows.forEach((row) => {
    const val = parseFloat(row[valueKey]) || 0;
    ROOT.value += val;
    ROOT.rowCount += 1;

    let cursor = ROOT; // start at root and walk down with each level

    levelKeys.forEach((lk, di) => {
      const label = row[lk] != null && row[lk] !== "" ? String(row[lk]) : null;
      if (label === null) return; // stop if this row has no value for this level

      // Create the child node for this label if it doesn't already exist.
      // Using a Map keyed by label ensures duplicate labels get merged (aggregated).
      if (!cursor.childMap.has(label)) {
        cursor.childMap.set(label, {
          label,
          value: 0,
          childMap: new Map(),
          depth: di + 1, // depth increases with each level
          rowCount: 0,
        });
      }

      const child = cursor.childMap.get(label);
      child.value += val;      // accumulate value into this node
      child.rowCount += 1;
      cursor = child;          // move the cursor one level deeper
    });
  });

  // Convert the Map-based structure into a plain nested object tree.
  // Children at each level are sorted largest-to-smallest by value.
  function toNode(n) {
    const children = Array.from(n.childMap.values())
      .map(toNode)
      .sort((a, b) => b.value - a.value);
    return { label: n.label, value: n.value, depth: n.depth, rowCount: n.rowCount, children };
  }

  return toNode(ROOT);
}

// ─────────────────────────────────────────────────────────────────────────────
// VISIBLE NODE COLLECTION
//
// When a user collapses a node, its entire subtree should disappear.
// This function walks the tree starting from the root, but stops recursing
// into any node that is in the `collapsed` set — effectively pruning the
// subtree from the visible list without mutating the underlying data.
// ─────────────────────────────────────────────────────────────────────────────
function collectVisible(root, collapsed) {
  const result = [];

  function walk(node) {
    result.push(node); // always include this node itself

    // Only recurse into children if this node is NOT collapsed.
    // This is what makes the entire subtree disappear when you collapse a node.
    if (!collapsed.has(nodeKey(node))) {
      node.children.forEach(walk);
    }
  }

  walk(root);
  return result;
}

// Produces a stable string key for a node, used to identify it in Sets/Maps.
// We combine label + depth because the same label could appear at different levels.
function nodeKey(node) {
  return node.label + "§" + node.depth;
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYOUT COMPUTATION
//
// Assigns pixel (x, y) coordinates to every visible node and builds the list
// of curved SVG edges to draw between connected nodes.
//
// Layout logic:
//   - Nodes are grouped into columns by depth (depth 0 = leftmost column).
//   - Within each column, nodes are stacked vertically with ROW_GAP spacing.
//   - The x position of each column is depth × (NODE_W + COL_GAP).
//   - Edges are only drawn between a parent and children that are both visible
//     AND the parent is not collapsed.
// ─────────────────────────────────────────────────────────────────────────────
function computeLayout(visibleNodes, collapsed, config) {
  // Group nodes by depth to determine which column they sit in.
  const colMap = {};
  visibleNodes.forEach((n) => {
    if (!colMap[n.depth]) colMap[n.depth] = [];
    colMap[n.depth].push(n);
  });

  const depths = Object.keys(colMap).map(Number).sort((a, b) => a - b);
  const maxDepth = depths.length ? depths[depths.length - 1] : 0;

  // Assign x/y to each node based on its column and row position.
  depths.forEach((d) => {
    colMap[d].forEach((node, i) => {
      node._x = d * (NODE_W + COL_GAP);                 // horizontal position
      node._y = COL_HEADER + i * (NODE_H + ROW_GAP);    // vertical position
    });
  });

  // Total canvas dimensions — used to size the SVG overlay correctly.
  const totalW = (maxDepth + 1) * NODE_W + maxDepth * COL_GAP;
  const totalH = depths.length
    ? Math.max(...depths.map((d) => COL_HEADER + colMap[d].length * (NODE_H + ROW_GAP)))
    : COL_HEADER + NODE_H;

  // Build the list of edges (connector lines) to draw.
  // We use a Set of visible nodes for O(1) membership checks.
  const visSet = new Set(visibleNodes);
  const edges = [];

  visibleNodes.forEach((node) => {
    // Don't draw edges out of a collapsed node — its children are hidden.
    if (collapsed.has(nodeKey(node))) return;

    node.children.forEach((child) => {
      if (!visSet.has(child)) return; // child not visible, skip

      // Each edge is a cubic bezier curve.
      // The control point is horizontally centred between parent and child,
      // which gives the smooth S-curve look.
      const x1 = node._x + NODE_W, y1 = node._y + NODE_H / 2; // right edge of parent
      const x2 = child._x,         y2 = child._y + NODE_H / 2; // left edge of child
      edges.push({
        x1, y1, x2, y2,
        cx: (x1 + x2) / 2,                    // horizontal midpoint for bezier handles
        color: getColor(config, child.depth),  // colour matches the child's depth level
      });
    });
  });

  return { totalW, totalH, colMap, edges };
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATION STYLES
//
// We inject a <style> tag into the document head once at module load time.
// This defines the CSS keyframe animations used when nodes enter and exit.
//
// We check for an existing element first so hot-reloads during development
// don't keep appending duplicate style tags.
// ─────────────────────────────────────────────────────────────────────────────
const STYLE_ID = "decomp-anim-styles";
if (!document.getElementById(STYLE_ID)) {
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    /* Nodes slide in from the left and scale up with a slight spring overshoot */
    @keyframes nodeIn {
      from { opacity: 0; transform: scale(0.85) translateX(-12px); }
      to   { opacity: 1; transform: scale(1)    translateX(0); }
    }
    /* Nodes shrink and fade out when they're removed */
    @keyframes nodeOut {
      from { opacity: 1; transform: scale(1)    translateX(0); }
      to   { opacity: 0; transform: scale(0.85) translateX(-12px); }
    }
    /* Edges simply fade in */
    @keyframes edgeIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    /* CSS classes applied dynamically to trigger the animations */
    .node-enter { animation: nodeIn ${ANIM_MS}ms cubic-bezier(0.34,1.56,0.64,1) forwards; }
    .node-exit  { animation: nodeOut ${ANIM_MS * 0.7}ms ease-in forwards; pointer-events: none; }
    .edge-enter { animation: edgeIn ${ANIM_MS}ms ease forwards; }
  `;
  document.head.appendChild(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOLTIP
//
// A floating card that appears near the cursor when hovering a node.
// `position: fixed` is important here — the tooltip lives outside the
// transformed/zoomed canvas div, so it follows the real screen cursor position
// rather than being distorted by the zoom transform.
// ─────────────────────────────────────────────────────────────────────────────
function Tooltip({ node, totalValue, levelName, x, y }) {
  const pct = totalValue > 0 ? ((node.value / totalValue) * 100).toFixed(1) : "0.0";
  return (
    <div style={{
      position: "fixed", left: x + 14, top: y - 10,
      backgroundColor: "#fff", border: "1px solid #e2e8f0",
      borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
      padding: "10px 14px", fontSize: 12, zIndex: 1000,
      minWidth: 160, pointerEvents: "none", // don't let the tooltip interfere with mouse events
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
        {levelName}
      </div>
      <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", marginBottom: 8 }}>{node.label}</div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        {[
          ["Value",      fmt(node.value)],
          ["% of total", pct + "%"],
          ["Rows",       node.rowCount],
          ["Children",   node.children.length],
        ].map(([k, v]) => (
          <tr key={k}>
            <td style={{ color: "#64748b", paddingRight: 16, paddingBottom: 3 }}>{k}</td>
            <td style={{ fontWeight: 600, color: "#0f172a", textAlign: "right", paddingBottom: 3 }}>{v}</td>
          </tr>
        ))}
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATED NODES WRAPPER
//
// This component is responsible for tracking which nodes are entering
// (newly visible) and which are exiting (just removed from the visible set),
// so we can play the appropriate animation on each.
//
// How it works:
//   1. On each render we compare the current set of visible node keys against
//      the previous set (stored in a ref so it persists across renders).
//   2. Keys that are new → "entering" set → gets the node-enter CSS class.
//   3. Keys that disappeared → "exiting" set → gets the node-exit CSS class.
//      We keep exiting nodes rendered briefly (ANIM_MS ms) so the exit
//      animation can play before they're truly removed.
//   4. After the animation duration, we clear the exiting set.
//
// This uses the "render prop" pattern — it passes `{ entering, exiting }` to
// its children via a function, so the parent can use those sets when rendering
// individual NodeCard components.
// ─────────────────────────────────────────────────────────────────────────────
function AnimatedNodes({ visibleNodes, prevVisibleRef, children }) {
  const [exiting, setExiting] = useState(new Set());

  const prevKeys = prevVisibleRef.current;
  const curKeys  = new Set(visibleNodes.map(nodeKey));

  useEffect(() => {
    // Find nodes that were visible before but aren't now.
    const removed = new Set([...prevKeys].filter((k) => !curKeys.has(k)));
    if (removed.size === 0) return;

    setExiting(removed); // trigger exit animations

    // Clear exiting state after the animation finishes so removed nodes
    // are finally dropped from the DOM.
    const t = setTimeout(() => setExiting(new Set()), ANIM_MS);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleNodes]);

  // Keep the ref up to date so the next render has accurate "previous" state.
  useEffect(() => {
    prevVisibleRef.current = curKeys;
  });

  return children({
    exiting,
    entering: new Set([...curKeys].filter((k) => !prevKeys.has(k))),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NODE CARD
//
// Renders a single node as an absolutely-positioned card on the canvas.
// Position comes from _x and _y computed by computeLayout().
//
// The CSS `transition` on left/top means that when siblings reflow after a
// collapse/expand, existing nodes slide smoothly to their new positions
// rather than jumping.
// ─────────────────────────────────────────────────────────────────────────────
function NodeCard({ node, totalValue, levelName, color, collapsed, entering, exiting, onToggle, onHover, onLeave }) {
  const pct     = totalValue > 0 ? ((node.value / totalValue) * 100).toFixed(1) : "0.0";
  const barW    = Math.max(2, parseFloat(pct)); // minimum 2% so the bar is always visible
  const hasKids = node.children.length > 0;
  const isRoot  = node.depth === 0;
  const key     = nodeKey(node);

  return (
    <div
      data-node="1"  // used by the pan handler to ignore drag-starts on nodes
      className={entering.has(key) ? "node-enter" : exiting.has(key) ? "node-exit" : ""}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={hasKids ? onToggle : undefined} // only clickable if it has children
      style={{
        position: "absolute",
        left: node._x,
        top: node._y,
        width: NODE_W,
        height: NODE_H,
        backgroundColor: "#fff",
        // Root node gets a full border in its colour; child nodes get a subtle grey border
        border: `1px solid ${isRoot ? color : "#dde3ed"}`,
        borderLeft: `3px solid ${color}`, // always a strong left accent in the node's colour
        borderRadius: 8,
        padding: "8px 10px 8px 12px",
        boxSizing: "border-box",
        boxShadow: isRoot
          ? `0 0 0 3px ${color}22, 0 2px 8px rgba(0,0,0,0.08)` // subtle glow for root
          : "0 1px 4px rgba(0,0,0,0.06)",
        cursor: hasKids ? "pointer" : "default",
        userSelect: "none",
        // Smooth repositioning when siblings collapse/expand and this node reflows
        transition: `left ${ANIM_MS}ms cubic-bezier(0.4,0,0.2,1), top ${ANIM_MS}ms cubic-bezier(0.4,0,0.2,1)`,
      }}
    >
      {/* Small uppercase label showing which dimension this node belongs to (e.g. "REGION") */}
      <div style={{ fontSize: 9, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {levelName}
      </div>

      {/* The node's value label (e.g. "North America", "Sales") */}
      <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 4 }}>
        {node.label}
      </div>

      {/* Percentage + proportional bar showing share of parent's value */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color, minWidth: 38 }}>{pct}%</span>
        <div style={{ flex: 1, height: 3, backgroundColor: "#f1f5f9", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ width: `${barW}%`, height: "100%", backgroundColor: color, borderRadius: 2 }} />
        </div>
      </div>

      {/* Expand/collapse toggle badge — only rendered if this node has children */}
      {hasKids && (
        <div style={{
          position: "absolute",
          right: -10,           // half-overlaps the right edge of the card
          top: "50%",
          transform: "translateY(-50%)",
          width: 20, height: 20,
          borderRadius: "50%",
          backgroundColor: "#fff",
          border: `1.5px solid ${color}`,
          color,
          fontSize: 14, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center",
          lineHeight: 1, zIndex: 2,
          transition: `transform ${ANIM_MS * 0.5}ms ease`,
        }}>
          {collapsed ? "+" : "−"}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TREE CANVAS
//
// The main interactive surface. Manages:
//   - Which nodes are collapsed (Set of nodeKey strings)
//   - Tooltip visibility and position
//   - Pan state (pixel offset of the canvas origin)
//   - Zoom state (scale factor applied to the canvas)
//
// The entire tree is rendered inside a single absolutely-positioned div that
// has a CSS `transform: translate(...) scale(...)` applied. This means pan and
// zoom are handled purely in CSS — we don't need to recompute node positions
// when the user drags or scrolls, which keeps interactions smooth.
// ─────────────────────────────────────────────────────────────────────────────
function TreeCanvas({ root, config, columns }) {
  const [collapsed, setCollapsed] = useState(new Set()); // keys of collapsed nodes
  const [tooltip, setTooltip]     = useState(null);      // { node, x, y } or null
  const [pan, setPan]             = useState({ x: 60, y: 60 }); // canvas offset in px
  const [zoom, setZoom]           = useState(1);          // zoom scale factor

  const dragging    = useRef(false);       // true while the user is dragging the canvas
  const dragStart   = useRef(null);        // { x, y } of the drag origin
  const canvasRef   = useRef(null);        // ref to the outer container div (for wheel events)
  // Tracks which node keys were visible on the previous render, used by AnimatedNodes.
  const prevKeysRef = useRef(new Set([nodeKey(root)]));

  // Toggle a node between collapsed and expanded.
  // useCallback prevents this function from being recreated on every render,
  // which would cause unnecessary re-renders of child components.
  const toggleCollapse = useCallback((node) => {
    const key = nodeKey(node);
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  // Recompute visible nodes whenever the tree data or collapsed set changes.
  // useMemo caches the result so it only runs when its dependencies change.
  const visibleNodes = useMemo(() => collectVisible(root, collapsed), [root, collapsed]);

  // Recompute node positions and edges whenever the visible set changes.
  const { totalW, totalH, colMap, edges } = useMemo(
    () => computeLayout(visibleNodes, collapsed, config),
    [visibleNodes, collapsed, config]
  );

  // ── Pan (drag to move the canvas) ──────────────────────────────────────────
  // We record the initial cursor position on mousedown and update the pan
  // offset on every mousemove while dragging.
  const onMouseDown = useCallback((e) => {
    // Ignore clicks that originate on a node card (data-node attribute).
    // Those are handled by the node's own onClick for collapse/expand.
    if (e.target.closest("[data-node]")) return;
    dragging.current = true;
    // Store the offset between the cursor and the current pan position
    // so the canvas doesn't jump when dragging starts.
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  }, [pan]);

  const onMouseMove = useCallback((e) => {
    if (!dragging.current) return;
    setPan({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  }, []);

  const onMouseUp = useCallback(() => { dragging.current = false; }, []);

  // ── Zoom (scroll wheel) ────────────────────────────────────────────────────
  // We attach the wheel listener imperatively (not via JSX) so we can pass
  // `{ passive: false }`, which allows us to call e.preventDefault() and stop
  // the page from scrolling while the user zooms the canvas.
  const onWheel = useCallback((e) => {
    e.preventDefault();
    setZoom((z) => Math.min(2, Math.max(0.25, z - e.deltaY * 0.001)));
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel); // cleanup on unmount
  }, [onWheel]);

  // ── Breadcrumb ─────────────────────────────────────────────────────────────
  // Shows the active drill path at the top of the canvas (e.g. Revenue › Region › Segment).
  // We resolve column IDs to friendly names using the columns metadata.
  const breadcrumbLevels = useMemo(() => {
    const keys = ["level1","level2","level3","level4","level5","level6"];
    const active = [resolveColName(config?.valueColumn, columns)];
    keys.forEach((k) => { if (config?.[k]) active.push(resolveColName(config[k], columns)); });
    return active;
  }, [config, columns]);

  return (
    <div
      ref={canvasRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp} // stop dragging if cursor leaves the canvas
      style={{
        width: "100%", height: "100%", overflow: "hidden", position: "relative",
        cursor: "grab",
        // Dotted background pattern using a CSS radial-gradient
        backgroundImage: "radial-gradient(circle, #c8d3e0 1px, transparent 1px)",
        backgroundSize: "20px 20px",
        backgroundColor: "#f0f4f8",
      }}
    >
      {/* ── Breadcrumb pill (top-left) ───────────────────────────────────── */}
      <div style={{
        position: "absolute", top: 10, left: 14, zIndex: 10,
        display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#64748b",
        backgroundColor: "#fff", border: "1px solid #e2e8f0", borderRadius: 6, padding: "4px 10px",
      }}>
        {breadcrumbLevels.map((l, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span style={{ color: "#cbd5e1", margin: "0 2px" }}>›</span>}
            <span style={{ fontWeight: i === breadcrumbLevels.length - 1 ? 600 : 400 }}>{l}</span>
          </React.Fragment>
        ))}
      </div>

      {/* ── Node count badge (bottom-right) ──────────────────────────────── */}
      <div style={{
        position: "absolute", bottom: 14, right: 14, zIndex: 10,
        backgroundColor: "#fff", border: "1px solid #e2e8f0",
        borderRadius: 6, padding: "4px 10px", fontSize: 11, color: "#64748b", fontWeight: 500,
      }}>
        {visibleNodes.length} nodes
      </div>

      {/* ── Zoom +/− buttons (bottom-right, left of node count) ──────────── */}
      <div style={{ position: "absolute", bottom: 14, right: 100, zIndex: 10, display: "flex", flexDirection: "column", gap: 4 }}>
        {["+", "−"].map((label, i) => (
          <button key={i}
            onClick={() => setZoom((z) => Math.min(2, Math.max(0.25, z + (i === 0 ? 0.1 : -0.1))))}
            style={{
              width: 28, height: 28, borderRadius: 6, border: "1px solid #e2e8f0",
              backgroundColor: "#fff", color: "#475569", fontSize: 16,
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              fontWeight: 600, boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Pannable / zoomable layer ─────────────────────────────────────── */}
      {/* Everything inside this div moves and scales together via CSS transform.
          We size it to the computed canvas dimensions so the SVG overlay covers
          all nodes without clipping any edges. */}
      <div style={{
        position: "absolute",
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: "0 0", // zoom anchors to the top-left corner
        width: totalW,
        height: totalH,
      }}>
        {/* ── SVG edge layer ───────────────────────────────────────────────
            Rendered beneath the node cards. Each edge is a cubic bezier path
            defined by M (start), C (control points), and the end point.
            Using `overflow: visible` lets edges extend slightly outside the
            SVG bounds without being clipped. */}
        <svg style={{ position: "absolute", top: 0, left: 0, width: totalW, height: totalH, overflow: "visible", pointerEvents: "none" }}>
          {edges.map((e, i) => (
            <path
              key={`${e.x1}-${e.y1}-${e.x2}-${e.y2}`}
              className="edge-enter" // fade in when the edge first appears
              d={`M${e.x1},${e.y1} C${e.cx},${e.y1} ${e.cx},${e.y2} ${e.x2},${e.y2}`}
              fill="none"
              stroke={e.color}
              strokeWidth={1.5}
              strokeOpacity={0.4}
            />
          ))}
        </svg>

        {/* ── Column headers ───────────────────────────────────────────────
            Small uppercase labels at the top of each depth column showing
            the dimension name (e.g. "REGION", "SEGMENT"). */}
        {Object.keys(colMap).map(Number).map((depth) => (
          <div key={depth} style={{
            position: "absolute",
            left: depth * (NODE_W + COL_GAP),
            top: 0,
            width: NODE_W,
            height: COL_HEADER - 4,
            display: "flex", alignItems: "center",
            fontSize: 9, fontWeight: 700,
            color: getColor(config, depth),
            textTransform: "uppercase", letterSpacing: "0.07em",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {getLevelName(config, depth, columns)}
          </div>
        ))}

        {/* ── Node cards with enter/exit animations ────────────────────────
            AnimatedNodes computes which nodes are entering/exiting and passes
            those sets to its render-prop children so NodeCard can apply the
            correct CSS animation class. */}
        <AnimatedNodes visibleNodes={visibleNodes} prevVisibleRef={prevKeysRef}>
          {({ entering, exiting }) =>
            visibleNodes.map((node) => (
              <NodeCard
                key={nodeKey(node)}
                node={node}
                totalValue={root.value}
                levelName={getLevelName(config, node.depth, columns)}
                color={getColor(config, node.depth)}
                collapsed={collapsed.has(nodeKey(node))}
                entering={entering}
                exiting={exiting}
                onToggle={() => toggleCollapse(node)}
                onHover={(e) => setTooltip({ node, x: e.clientX, y: e.clientY })}
                onLeave={() => setTooltip(null)}
              />
            ))
          }
        </AnimatedNodes>
      </div>

      {/* ── Tooltip ──────────────────────────────────────────────────────────
          Rendered outside the transformed div so its position is in screen
          coordinates and doesn't get distorted by the zoom transform. */}
      {tooltip && (
        <Tooltip
          node={tooltip.node}
          totalValue={root.value}
          levelName={getLevelName(config, tooltip.node.depth, columns)}
          x={tooltip.x}
          y={tooltip.y}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PLACEHOLDER
//
// Shown in place of the tree when the plugin isn't fully configured yet.
// Mirrors the canvas background style so it doesn't look broken.
// ─────────────────────────────────────────────────────────────────────────────
function Placeholder({ message }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", height: "100%", color: "#94a3b8",
      textAlign: "center", gap: 12, fontSize: 13,
      backgroundImage: "radial-gradient(circle, #c8d3e0 1px, transparent 1px)",
      backgroundSize: "20px 20px", backgroundColor: "#f0f4f8",
    }}>
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        <rect x="4" y="20" width="14" height="10" rx="2" stroke="#cbd5e1" strokeWidth="1.5" fill="#fff"/>
        <rect x="30" y="10" width="14" height="10" rx="2" stroke="#cbd5e1" strokeWidth="1.5" fill="#fff"/>
        <rect x="30" y="28" width="14" height="10" rx="2" stroke="#cbd5e1" strokeWidth="1.5" fill="#fff"/>
        <path d="M18 25 C24 25 24 15 30 15" stroke="#cbd5e1" strokeWidth="1.5" fill="none"/>
        <path d="M18 25 C24 25 24 33 30 33" stroke="#cbd5e1" strokeWidth="1.5" fill="none"/>
      </svg>
      <p style={{ maxWidth: 280, backgroundColor: "#fff", padding: "8px 16px", borderRadius: 8, border: "1px solid #e2e8f0" }}>
        {message}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APP (ROOT COMPONENT)
//
// The entry point rendered by React. Responsible for:
//   1. Reading config and data from Sigma via hooks
//   2. Converting columnar data into row objects
//   3. Building the tree data structure
//   4. Rendering the appropriate UI (placeholder or tree canvas)
//
// useConfig()        → returns the current values of all editor panel fields
// useElementData()   → returns the raw column data from the selected element
// useElementColumns()→ returns column metadata (name, type) keyed by column ID
//
// All three hooks re-run automatically whenever the user changes a setting
// in the Sigma editor panel or the underlying data updates.
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const config      = useConfig();
  const elementData = useElementData(config?.source);
  const columns     = useElementColumns(config?.source);

  const tree = useMemo(() => {
    if (!elementData || !config?.level1 || !config?.valueColumn) return null;

    // Collect only the level column IDs that have been configured,
    // in order from level1 → level6.
    const levelKeys = ["level1","level2","level3","level4","level5","level6"]
      .map((k) => config[k])
      .filter(Boolean); // removes undefined entries for unconfigured levels

    const valueKey = config.valueColumn;

    // elementData is columnar: { [columnId]: [...values] }
    // Convert to an array of row objects so buildTree can process them.
    const len = (elementData[levelKeys[0]] ?? []).length;
    const rows = Array.from({ length: len }, (_, i) => {
      const row = { [valueKey]: elementData[valueKey]?.[i] ?? 0 };
      levelKeys.forEach((lk) => { row[lk] = elementData[lk]?.[i] ?? null; });
      return row;
    });

    return buildTree(rows, levelKeys, valueKey);
  }, [elementData, config]);

  const wrap = {
    width: "100vw", height: "100vh", overflow: "hidden",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  };

  // Guard clauses — show a helpful placeholder for each misconfigured state.
  if (!config?.source)
    return <div style={wrap}><Placeholder message="Select a Data Source in the editor panel." /></div>;
  if (!config?.level1 || !config?.valueColumn)
    return <div style={wrap}><Placeholder message="Add at least one Level column and a Value column in the editor panel." /></div>;
  if (!tree)
    return <div style={wrap}><Placeholder message="No data returned." /></div>;

  return (
    <div style={wrap}>
      <TreeCanvas root={tree} config={config} columns={columns} />
    </div>
  );
}
