import React, { useMemo, useState, useRef, useEffect, useCallback } from "react";
import { client, useConfig, useElementData, useElementColumns } from "@sigmacomputing/plugin";

// ─── Editor panel ─────────────────────────────────────────────────────────────
client.config.configureEditorPanel([
  { name: "source",      type: "element", label: "Data Source" },
  { name: "level1",      type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 1 (top)" },
  { name: "level2",      type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 2" },
  { name: "level3",      type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 3" },
  { name: "level4",      type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 4" },
  { name: "level5",      type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 5" },
  { name: "level6",      type: "column", source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 6" },
  { name: "valueColumn", type: "column", source: "source", allowedTypes: ["number","integer"], label: "Value Column" },
  // Colour pickers per level (root + 6 levels)
  { name: "color0", type: "text", label: "Root node colour (hex)", defaultValue: "#6366f1" },
  { name: "color1", type: "text", label: "Level 1 colour (hex)",   defaultValue: "#0ea5e9" },
  { name: "color2", type: "text", label: "Level 2 colour (hex)",   defaultValue: "#10b981" },
  { name: "color3", type: "text", label: "Level 3 colour (hex)",   defaultValue: "#f59e0b" },
  { name: "color4", type: "text", label: "Level 4 colour (hex)",   defaultValue: "#ec4899" },
  { name: "color5", type: "text", label: "Level 5 colour (hex)",   defaultValue: "#8b5cf6" },
  { name: "color6", type: "text", label: "Level 6 colour (hex)",   defaultValue: "#14b8a6" },
]);

// ─── Constants ────────────────────────────────────────────────────────────────
const NODE_W    = 200;
const NODE_H    = 80;
const COL_GAP   = 110;
const ROW_GAP   = 16;
const COL_HEADER = 28;

const DEFAULT_COLORS = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ec4899","#8b5cf6","#14b8a6"];

function getColor(config, depth) {
  const raw = config?.[`color${depth}`];
  if (raw && /^#[0-9a-fA-F]{3,6}$/.test(raw.trim())) return raw.trim();
  return DEFAULT_COLORS[depth % DEFAULT_COLORS.length];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(val) {
  if (val === null || val === undefined) return "";
  if (Math.abs(val) >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
  if (Math.abs(val) >= 1_000)     return (val / 1_000).toFixed(1) + "K";
  return Number(val).toLocaleString();
}

// Resolve a column ID to its friendly display name using column metadata
function resolveColName(columnId, columns) {
  if (!columnId || !columns) return columnId || "";
  const col = columns[columnId];
  return col?.name || columnId;
}

function getLevelName(config, depth, columns) {
  if (depth === 0) return resolveColName(config?.valueColumn, columns);
  const keys = ["level1","level2","level3","level4","level5","level6"];
  return resolveColName(config?.[keys[depth - 1]], columns);
}

// ─── Build tree ───────────────────────────────────────────────────────────────
function buildTree(rows, levelKeys, valueKey) {
  const ROOT = { label: "Total", value: 0, childMap: new Map(), depth: 0, rowCount: 0 };

  rows.forEach((row) => {
    const val = parseFloat(row[valueKey]) || 0;
    ROOT.value += val;
    ROOT.rowCount += 1;
    let cursor = ROOT;
    levelKeys.forEach((lk, di) => {
      const label = row[lk] != null && row[lk] !== "" ? String(row[lk]) : null;
      if (label === null) return;
      if (!cursor.childMap.has(label)) {
        cursor.childMap.set(label, { label, value: 0, childMap: new Map(), depth: di + 1, rowCount: 0 });
      }
      const child = cursor.childMap.get(label);
      child.value += val;
      child.rowCount += 1;
      cursor = child;
    });
  });

  function toNode(n) {
    const children = Array.from(n.childMap.values())
      .map(toNode)
      .sort((a, b) => b.value - a.value);
    return { label: n.label, value: n.value, depth: n.depth, rowCount: n.rowCount, children };
  }
  return toNode(ROOT);
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function Tooltip({ node, totalValue, levelName, x, y }) {
  const pct = totalValue > 0 ? ((node.value / totalValue) * 100).toFixed(1) : "0.0";
  return (
    <div style={{
      position: "fixed", left: x + 14, top: y - 10,
      backgroundColor: "#fff", border: "1px solid #e2e8f0",
      borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
      padding: "10px 14px", fontSize: 12, zIndex: 1000,
      minWidth: 160, pointerEvents: "none",
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
        {levelName}
      </div>
      <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", marginBottom: 8 }}>{node.label}</div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        {[["Value", fmt(node.value)], ["% of total", pct + "%"], ["Rows", node.rowCount], ["Children", node.children.length]].map(([k, v]) => (
          <tr key={k}>
            <td style={{ color: "#64748b", paddingRight: 16, paddingBottom: 3 }}>{k}</td>
            <td style={{ fontWeight: 600, color: "#0f172a", textAlign: "right", paddingBottom: 3 }}>{v}</td>
          </tr>
        ))}
      </table>
    </div>
  );
}

// ─── Node card ────────────────────────────────────────────────────────────────
function NodeCard({ node, totalValue, levelName, color, collapsed, onToggle, onHover, onLeave }) {
  const pct     = totalValue > 0 ? ((node.value / totalValue) * 100).toFixed(1) : "0.0";
  const barW    = Math.max(2, parseFloat(pct));
  const hasKids = node.children.length > 0;
  const isRoot  = node.depth === 0;

  return (
    <div
      data-node="1"
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onClick={hasKids ? onToggle : undefined}
      style={{
        position: "absolute", left: node._x, top: node._y,
        width: NODE_W, height: NODE_H,
        backgroundColor: "#fff",
        border: `1px solid ${isRoot ? color : "#dde3ed"}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8, padding: "8px 10px 8px 12px",
        boxSizing: "border-box",
        boxShadow: isRoot
          ? `0 0 0 3px ${color}22, 0 2px 8px rgba(0,0,0,0.08)`
          : "0 1px 4px rgba(0,0,0,0.06)",
        cursor: hasKids ? "pointer" : "default",
        userSelect: "none",
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 700, color, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {levelName}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 4 }}>
        {node.label}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color, minWidth: 38 }}>{pct}%</span>
        <div style={{ flex: 1, height: 3, backgroundColor: "#f1f5f9", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ width: `${barW}%`, height: "100%", backgroundColor: color, borderRadius: 2 }} />
        </div>
      </div>
      {hasKids && (
        <div style={{
          position: "absolute", right: -10, top: "50%", transform: "translateY(-50%)",
          width: 20, height: 20, borderRadius: "50%",
          backgroundColor: "#fff", border: `1.5px solid ${color}`,
          color, fontSize: 14, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center",
          lineHeight: 1, zIndex: 2,
        }}>
          {collapsed ? "+" : "−"}
        </div>
      )}
    </div>
  );
}

// ─── Main canvas ──────────────────────────────────────────────────────────────
function TreeCanvas({ root, config, columns }) {
  const [collapsed, setCollapsed] = useState(new Set());
  const [tooltip, setTooltip]     = useState(null);
  const [pan, setPan]             = useState({ x: 60, y: 60 });
  const [zoom, setZoom]           = useState(1);
  const dragging  = useRef(false);
  const dragStart = useRef(null);
  const canvasRef = useRef(null);

  const toggleCollapse = useCallback((node) => {
    const key = node.label + "_" + node.depth;
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  // Collect visible nodes respecting collapsed state
  const visibleNodes = useMemo(() => {
    const result = [];
    function walk(node) {
      result.push(node);
      if (!collapsed.has(node.label + "_" + node.depth)) node.children.forEach(walk);
    }
    walk(root);
    return result;
  }, [root, collapsed]);

  // Layout
  const { totalW, totalH, colMap, edges } = useMemo(() => {
    const colMap = {};
    visibleNodes.forEach((n) => {
      if (!colMap[n.depth]) colMap[n.depth] = [];
      colMap[n.depth].push(n);
    });
    const depths = Object.keys(colMap).map(Number).sort((a, b) => a - b);
    const maxDepth = depths[depths.length - 1] ?? 0;

    depths.forEach((d) => {
      colMap[d].forEach((node, i) => {
        node._x = d * (NODE_W + COL_GAP);
        node._y = COL_HEADER + i * (NODE_H + ROW_GAP);
      });
    });

    const totalW = (maxDepth + 1) * NODE_W + maxDepth * COL_GAP;
    const totalH = Math.max(...depths.map((d) => COL_HEADER + colMap[d].length * (NODE_H + ROW_GAP)));

    const visSet = new Set(visibleNodes);
    const edges = [];
    visibleNodes.forEach((node) => {
      if (collapsed.has(node.label + "_" + node.depth)) return;
      node.children.forEach((child) => {
        if (!visSet.has(child)) return;
        const x1 = node._x + NODE_W, y1 = node._y + NODE_H / 2;
        const x2 = child._x,         y2 = child._y + NODE_H / 2;
        const cx = (x1 + x2) / 2;
        edges.push({ x1, y1, x2, y2, cx, color: getColor(config, child.depth) });
      });
    });

    return { totalW, totalH, colMap, edges };
  }, [visibleNodes, collapsed, config]);

  // Pan
  const onMouseDown = (e) => {
    if (e.target.closest("[data-node]")) return;
    dragging.current = true;
    dragStart.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };
  const onMouseMove = (e) => {
    if (!dragging.current) return;
    setPan({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  };
  const onMouseUp = () => { dragging.current = false; };

  // Zoom
  const onWheel = useCallback((e) => {
    e.preventDefault();
    setZoom((z) => Math.min(2, Math.max(0.25, z - e.deltaY * 0.001)));
  }, []);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  // Breadcrumb: resolve column IDs to friendly names
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
      onMouseLeave={onMouseUp}
      style={{
        width: "100%", height: "100%", overflow: "hidden", position: "relative",
        cursor: dragging.current ? "grabbing" : "grab",
        backgroundImage: "radial-gradient(circle, #c8d3e0 1px, transparent 1px)",
        backgroundSize: "20px 20px", backgroundColor: "#f0f4f8",
      }}
    >
      {/* Breadcrumb */}
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

      {/* Node count */}
      <div style={{
        position: "absolute", bottom: 14, right: 14, zIndex: 10,
        backgroundColor: "#fff", border: "1px solid #e2e8f0",
        borderRadius: 6, padding: "4px 10px", fontSize: 11, color: "#64748b", fontWeight: 500,
      }}>
        {visibleNodes.length} nodes
      </div>

      {/* Zoom buttons */}
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

      {/* Pannable / zoomable layer */}
      <div style={{
        position: "absolute",
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: "0 0",
        width: totalW, height: totalH,
      }}>
        {/* SVG edges */}
        <svg style={{ position: "absolute", top: 0, left: 0, width: totalW, height: totalH, overflow: "visible", pointerEvents: "none" }}>
          {edges.map((e, i) => (
            <path key={i}
              d={`M${e.x1},${e.y1} C${e.cx},${e.y1} ${e.cx},${e.y2} ${e.x2},${e.y2}`}
              fill="none" stroke={e.color} strokeWidth={1.5} strokeOpacity={0.4}
            />
          ))}
        </svg>

        {/* Column headers */}
        {Object.keys(colMap).map(Number).map((depth) => (
          <div key={depth} style={{
            position: "absolute",
            left: depth * (NODE_W + COL_GAP),
            top: 0, width: NODE_W, height: COL_HEADER - 4,
            display: "flex", alignItems: "center",
            fontSize: 9, fontWeight: 700,
            color: getColor(config, depth),
            textTransform: "uppercase", letterSpacing: "0.07em",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {getLevelName(config, depth, columns)}
          </div>
        ))}

        {/* Nodes */}
        {visibleNodes.map((node) => (
          <NodeCard
            key={node.label + "_" + node.depth}
            node={node}
            totalValue={root.value}
            levelName={getLevelName(config, node.depth, columns)}
            color={getColor(config, node.depth)}
            collapsed={collapsed.has(node.label + "_" + node.depth)}
            onToggle={() => toggleCollapse(node)}
            onHover={(e) => setTooltip({ node, x: e.clientX, y: e.clientY })}
            onLeave={() => setTooltip(null)}
          />
        ))}
      </div>

      {/* Tooltip */}
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

// ─── Placeholder ──────────────────────────────────────────────────────────────
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

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const config      = useConfig();
  const elementData = useElementData(config?.source);
  const columns     = useElementColumns(config?.source);

  const tree = useMemo(() => {
    if (!elementData || !config?.level1 || !config?.valueColumn) return null;
    const levelKeys = ["level1","level2","level3","level4","level5","level6"]
      .map((k) => config[k]).filter(Boolean);
    const valueKey = config.valueColumn;
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
