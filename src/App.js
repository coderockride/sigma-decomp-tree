import React, { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { client, useConfig, useElementData } from "@sigmacomputing/plugin";

// ─── Editor panel ─────────────────────────────────────────────────────────────
client.config.configureEditorPanel([
  { name: "source",      type: "element", label: "Data Source" },
  { name: "level1",      type: "column",  source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 1 (top)" },
  { name: "level2",      type: "column",  source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 2" },
  { name: "level3",      type: "column",  source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 3" },
  { name: "level4",      type: "column",  source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 4" },
  { name: "level5",      type: "column",  source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 5" },
  { name: "level6",      type: "column",  source: "source", allowedTypes: ["text","datetime","number","boolean"], label: "Level 6" },
  { name: "valueColumn", type: "column",  source: "source", allowedTypes: ["number","integer"], label: "Value Column" },
  { name: "chartTitle",  type: "text",    label: "Chart Title", defaultValue: "Decomposition Tree" },
]);

// ─── Constants ────────────────────────────────────────────────────────────────
const NODE_W = 200;
const NODE_H = 80;
const COL_GAP = 120;
const ROW_GAP = 16;
const COL_HEADER = 28;

const COLORS = ["#6366f1","#0ea5e9","#10b981","#f59e0b","#ec4899","#8b5cf6"];
const colorAt = (d) => COLORS[d % COLORS.length];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(val) {
  if (val === null || val === undefined) return "";
  if (Math.abs(val) >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
  if (Math.abs(val) >= 1_000)     return (val / 1_000).toFixed(1) + "K";
  return Number(val).toLocaleString();
}

function getLevelName(config, depth) {
  // depth 0 = root (value column name), depth 1 = level1 label, etc.
  const keys = ["level1","level2","level3","level4","level5","level6"];
  if (depth === 0) return config.valueColumn || "Total";
  const key = keys[depth - 1];
  return config[key] || `Level ${depth}`;
}

// ─── Build tree from flat rows ────────────────────────────────────────────────
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

// ─── Layout: assign x/y to every node ────────────────────────────────────────
// Returns flat array of { node, x, y, col }
function layoutTree(root) {
  const cols = [];          // cols[depth] = array of laid-out nodes
  let colCount = 0;

  function collectCols(node) {
    const d = node.depth;
    if (!cols[d]) cols[d] = [];
    cols[d].push(node);
    colCount = Math.max(colCount, d + 1);
    node.children.forEach(collectCols);
  }
  collectCols(root);

  // Y positions per column: evenly spaced
  cols.forEach((col) => {
    const total = col.length * NODE_H + (col.length - 1) * ROW_GAP;
    col.forEach((node, i) => {
      node._y = i * (NODE_H + ROW_GAP) + COL_HEADER;
    });
    col._totalH = total + COL_HEADER;
  });

  // X positions: each column is offset by NODE_W + COL_GAP
  cols.forEach((col, d) => {
    col.forEach((node) => {
      node._x = d * (NODE_W + COL_GAP);
    });
  });

  const totalW = colCount * NODE_W + (colCount - 1) * COL_GAP;
  const totalH = Math.max(...cols.map((c) => c._totalH || 0));

  return { root, totalW, totalH, colCount, cols };
}

// ─── Build edges: connect each node to its children ──────────────────────────
function buildEdges(root) {
  const edges = [];
  function walk(node) {
    node.children.forEach((child) => {
      const x1 = node._x + NODE_W;
      const y1 = node._y + NODE_H / 2;
      const x2 = child._x;
      const y2 = child._y + NODE_H / 2;
      const cx = (x1 + x2) / 2;
      edges.push({ x1, y1, x2, y2, cx, color: colorAt(child.depth) });
      walk(child);
    });
  }
  walk(root);
  return edges;
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function Tooltip({ node, totalValue, levelName, x, y }) {
  const pct = totalValue > 0 ? ((node.value / totalValue) * 100).toFixed(1) : "0.0";
  return (
    <div style={{
      position: "fixed", left: x + 12, top: y - 10,
      backgroundColor: "#fff",
      border: "1px solid #e2e8f0",
      borderRadius: 8,
      boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
      padding: "10px 14px",
      fontSize: 12,
      zIndex: 1000,
      minWidth: 160,
      pointerEvents: "none",
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
        {levelName}
      </div>
      <div style={{ fontWeight: 700, fontSize: 14, color: "#0f172a", marginBottom: 8 }}>{node.label}</div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        {[
          ["Value", fmt(node.value)],
          ["% of total", pct + "%"],
          ["Rows", node.rowCount],
          ["Children", node.children.length],
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

// ─── Node card ────────────────────────────────────────────────────────────────
function NodeCard({ node, totalValue, levelName, collapsed, onToggle, onHover, onLeave }) {
  const color = colorAt(node.depth);
  const pct   = totalValue > 0 ? ((node.value / totalValue) * 100).toFixed(1) : "0.0";
  const barW  = Math.max(2, parseFloat(pct));
  const hasChildren = node.children.length > 0;
  const isRoot = node.depth === 0;

  return (
    <div
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      style={{
        position: "absolute",
        left: node._x,
        top: node._y,
        width: NODE_W,
        height: NODE_H,
        backgroundColor: "#fff",
        border: `1px solid ${isRoot ? color : "#dde3ed"}`,
        borderLeft: `3px solid ${color}`,
        borderRadius: 8,
        padding: "8px 10px 8px 12px",
        boxSizing: "border-box",
        boxShadow: isRoot
          ? `0 0 0 3px ${color}22, 0 2px 8px rgba(0,0,0,0.08)`
          : "0 1px 4px rgba(0,0,0,0.06)",
        cursor: hasChildren ? "pointer" : "default",
        userSelect: "none",
      }}
      onClick={hasChildren ? onToggle : undefined}
    >
      {/* Level label */}
      <div style={{ fontSize: 9, fontWeight: 700, color: color, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>
        {levelName}
      </div>
      {/* Main label */}
      <div style={{
        fontSize: 13, fontWeight: 600, color: "#0f172a",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        marginBottom: 4,
      }}>
        {node.label}
      </div>
      {/* Pct + bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: color, minWidth: 38 }}>{pct}%</span>
        <div style={{ flex: 1, height: 3, backgroundColor: "#f1f5f9", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ width: `${barW}%`, height: "100%", backgroundColor: color, borderRadius: 2 }} />
        </div>
      </div>
      {/* Toggle badge */}
      {hasChildren && (
        <div style={{
          position: "absolute", right: -10, top: "50%", transform: "translateY(-50%)",
          width: 20, height: 20, borderRadius: "50%",
          backgroundColor: "#fff", border: `1.5px solid ${color}`,
          color: color, fontSize: 14, fontWeight: 700,
          display: "flex", alignItems: "center", justifyContent: "center",
          lineHeight: 1, zIndex: 2,
        }}>
          {collapsed ? "+" : "−"}
        </div>
      )}
    </div>
  );
}

// ─── Column header ─────────────────────────────────────────────────────────────
function ColHeader({ col, depth, config, totalW }) {
  const color = colorAt(depth);
  const name  = getLevelName(config, depth);
  return (
    <div style={{
      position: "absolute",
      left: depth * (NODE_W + COL_GAP),
      top: 0,
      width: NODE_W,
      height: COL_HEADER - 4,
      display: "flex", alignItems: "center",
      fontSize: 10, fontWeight: 700,
      color: color,
      textTransform: "uppercase",
      letterSpacing: "0.07em",
    }}>
      {name}
    </div>
  );
}

// ─── Breadcrumb ───────────────────────────────────────────────────────────────
function Breadcrumb({ config, colCount }) {
  const keys = ["level1","level2","level3","level4","level5","level6"];
  const levels = [config.valueColumn || "Total"];
  keys.slice(0, colCount - 1).forEach((k) => { if (config[k]) levels.push(config[k]); });

  return (
    <div style={{
      position: "absolute", top: 10, left: 14,
      display: "flex", alignItems: "center", gap: 4,
      fontSize: 11, color: "#64748b",
      backgroundColor: "#fff",
      border: "1px solid #e2e8f0",
      borderRadius: 6,
      padding: "4px 10px",
    }}>
      {levels.map((l, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: "#cbd5e1", margin: "0 2px" }}>›</span>}
          <span style={{ fontWeight: i === levels.length - 1 ? 600 : 400 }}>{l}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ─── Main canvas ──────────────────────────────────────────────────────────────
function TreeCanvas({ root, config }) {
  const [collapsed, setCollapsed] = useState(new Set());
  const [tooltip, setTooltip]     = useState(null); // { node, x, y }
  const [pan, setPan]             = useState({ x: 60, y: 60 });
  const [zoom, setZoom]           = useState(1);
  const dragging = useRef(false);
  const dragStart = useRef(null);

  // Collect all visible nodes (respecting collapsed state)
  const visibleNodes = useMemo(() => {
    const result = [];
    function walk(node) {
      result.push(node);
      if (!collapsed.has(node.label + "_" + node.depth)) {
        node.children.forEach(walk);
      }
    }
    walk(root);
    return result;
  }, [root, collapsed]);

  // Layout visible nodes only
  const { totalW, totalH, colCount, cols, edges } = useMemo(() => {
    // Re-run layout on visible set
    const colMap = {};
    visibleNodes.forEach((n) => {
      if (!colMap[n.depth]) colMap[n.depth] = [];
      colMap[n.depth].push(n);
    });
    const depths = Object.keys(colMap).map(Number).sort((a,b)=>a-b);
    const maxDepth = depths[depths.length - 1] ?? 0;

    depths.forEach((d) => {
      colMap[d].forEach((node, i) => {
        node._x = d * (NODE_W + COL_GAP);
        node._y = COL_HEADER + i * (NODE_H + ROW_GAP);
      });
    });

    const totalW = (maxDepth + 1) * NODE_W + maxDepth * COL_GAP;
    const totalH = Math.max(...depths.map((d) => colMap[d].length * (NODE_H + ROW_GAP) + COL_HEADER));

    // Build edges only between visible parent->child
    const visSet = new Set(visibleNodes);
    const edges = [];
    visibleNodes.forEach((node) => {
      if (collapsed.has(node.label + "_" + node.depth)) return;
      node.children.forEach((child) => {
        if (!visSet.has(child)) return;
        const x1 = node._x + NODE_W;
        const y1 = node._y + NODE_H / 2;
        const x2 = child._x;
        const y2 = child._y + NODE_H / 2;
        const cx = (x1 + x2) / 2;
        edges.push({ x1, y1, x2, y2, cx, color: colorAt(child.depth) });
      });
    });

    return { totalW, totalH, colCount: maxDepth + 1, cols: colMap, edges };
  }, [visibleNodes, collapsed]);

  const toggleCollapse = useCallback((node) => {
    const key = node.label + "_" + node.depth;
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  // Pan via drag
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

  // Zoom via wheel
  const onWheel = (e) => {
    e.preventDefault();
    setZoom((z) => Math.min(2, Math.max(0.3, z - e.deltaY * 0.001)));
  };
  const canvasRef = useRef(null);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const nodeCount = visibleNodes.length;

  return (
    <div
      ref={canvasRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      style={{
        width: "100%", height: "100%",
        overflow: "hidden",
        position: "relative",
        cursor: dragging.current ? "grabbing" : "grab",
        // Dotted background
        backgroundImage: "radial-gradient(circle, #c8d3e0 1px, transparent 1px)",
        backgroundSize: "20px 20px",
        backgroundColor: "#f0f4f8",
      }}
    >
      {/* Breadcrumb */}
      <Breadcrumb config={config} colCount={colCount} />

      {/* Node count badge */}
      <div style={{
        position: "absolute", bottom: 14, right: 14,
        backgroundColor: "#fff", border: "1px solid #e2e8f0",
        borderRadius: 6, padding: "4px 10px",
        fontSize: 11, color: "#64748b", fontWeight: 500,
      }}>
        {nodeCount} nodes
      </div>

      {/* Zoom controls */}
      <div style={{
        position: "absolute", bottom: 14, right: 100,
        display: "flex", flexDirection: "column", gap: 4,
      }}>
        {["+", "−"].map((label, i) => (
          <button key={i} onClick={() => setZoom((z) => Math.min(2, Math.max(0.3, z + (i === 0 ? 0.1 : -0.1))))}
            style={{
              width: 28, height: 28, borderRadius: 6,
              border: "1px solid #e2e8f0", backgroundColor: "#fff",
              color: "#475569", fontSize: 16, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontWeight: 600, boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            }}>
            {label}
          </button>
        ))}
      </div>

      {/* Zoomable/pannable canvas */}
      <div style={{
        position: "absolute",
        transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        transformOrigin: "0 0",
        width: totalW,
        height: totalH,
      }}>
        {/* SVG edges */}
        <svg style={{ position: "absolute", top: 0, left: 0, width: totalW, height: totalH, overflow: "visible", pointerEvents: "none" }}>
          {edges.map((e, i) => (
            <path
              key={i}
              d={`M${e.x1},${e.y1} C${e.cx},${e.y1} ${e.cx},${e.y2} ${e.x2},${e.y2}`}
              fill="none"
              stroke={e.color}
              strokeWidth={1.5}
              strokeOpacity={0.35}
            />
          ))}
        </svg>

        {/* Column headers */}
        {Object.keys(cols).map(Number).map((depth) => (
          <ColHeader key={depth} depth={depth} config={config} colCount={colCount} />
        ))}

        {/* Nodes */}
        {visibleNodes.map((node) => (
          <div key={node.label + "_" + node.depth} data-node="1">
            <NodeCard
              node={node}
              totalValue={root.value}
              levelName={getLevelName(config, node.depth)}
              collapsed={collapsed.has(node.label + "_" + node.depth)}
              onToggle={() => toggleCollapse(node)}
              onHover={(e) => setTooltip({ node, x: e.clientX, y: e.clientY })}
              onLeave={() => setTooltip(null)}
            />
          </div>
        ))}
      </div>

      {/* Tooltip (rendered outside transform so it stays at cursor) */}
      {tooltip && (
        <Tooltip
          node={tooltip.node}
          totalValue={root.value}
          levelName={getLevelName(config, tooltip.node.depth)}
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

  const wrap = { width: "100vw", height: "100vh", overflow: "hidden", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" };

  if (!config?.source)
    return <div style={wrap}><Placeholder message="Select a Data Source in the editor panel." /></div>;
  if (!config?.level1 || !config?.valueColumn)
    return <div style={wrap}><Placeholder message="Add at least one Level column and a Value column in the editor panel." /></div>;
  if (!tree)
    return <div style={wrap}><Placeholder message="No data returned." /></div>;

  return (
    <div style={wrap}>
      <TreeCanvas root={tree} config={config} />
    </div>
  );
}
