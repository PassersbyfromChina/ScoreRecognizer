import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Region } from "../core/types";

type Mode = "select" | "draw-question" | "draw-name";

interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface RegionEditorProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  regions: Region[];
  selectedId: string | null;
  mode: Mode;
  onSelect: (id: string | null) => void;
  onAdd: (kind: "name" | "question", rect: RectPx) => void;
  onChangeRect: (id: string, rect: RectPx) => void;
}

type DragState =
  | { type: "draw"; start: { x: number; y: number }; current: { x: number; y: number } }
  | { type: "move"; id: string; start: { x: number; y: number }; origin: RectPx }
  | { type: "resize"; id: string; handle: "nw" | "ne" | "sw" | "se"; origin: RectPx; start: { x: number; y: number } }
  | null;

export function RegionEditor({
  imageUrl,
  imageWidth,
  imageHeight,
  regions,
  selectedId,
  mode,
  onSelect,
  onAdd,
  onChangeRect,
}: RegionEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const [hover, setHover] = useState<string | null>(null);

  const toImagePoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: ((clientX - rect.left) / rect.width) * imageWidth,
        y: ((clientY - rect.top) / rect.height) * imageHeight,
      };
    },
    [imageWidth, imageHeight],
  );

  const toUnit = useCallback((rect: RectPx): RectPx => {
    const long = Math.max(imageWidth, imageHeight);
    return { x: rect.x / long, y: rect.y / long, w: rect.w / long, h: rect.h / long };
  }, [imageWidth, imageHeight]);

  const toPx = useCallback((region: Region): RectPx => {
    const long = Math.max(imageWidth, imageHeight);
    return { x: region.x * long, y: region.y * long, w: region.w * long, h: region.h * long };
  }, [imageWidth, imageHeight]);

  function onPointerDown(e: ReactPointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    const p = toImagePoint(e.clientX, e.clientY);
    svgRef.current?.setPointerCapture(e.pointerId);

    if (mode !== "select") {
      setDrag({ type: "draw", start: p, current: p });
      return;
    }

    const target = e.target as SVGElement;
    const regionId = target.getAttribute("data-region-id");
    const handle = target.getAttribute("data-handle") as DragState extends { handle: infer H } ? H : never;

    if (regionId && handle) {
      const region = regions.find((r) => r.id === regionId);
      if (region) {
        setDrag({ type: "resize", id: regionId, handle: handle as "nw" | "ne" | "sw" | "se", origin: toPx(region), start: p });
        onSelect(regionId);
        return;
      }
    }
    if (regionId) {
      const region = regions.find((r) => r.id === regionId);
      if (region) {
        onSelect(regionId);
        setDrag({ type: "move", id: regionId, start: p, origin: toPx(region) });
        return;
      }
    }
    onSelect(null);
  }

  function onPointerMove(e: ReactPointerEvent<SVGSVGElement>) {
    if (!drag) return;
    const p = toImagePoint(e.clientX, e.clientY);
    if (drag.type === "draw") {
      setDrag({ ...drag, current: p });
      return;
    }
    if (drag.type === "move") {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      onChangeRect(drag.id, {
        x: drag.origin.x + dx,
        y: drag.origin.y + dy,
        w: drag.origin.w,
        h: drag.origin.h,
      });
      return;
    }
    if (drag.type === "resize") {
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      let { x, y, w, h } = drag.origin;
      if (drag.handle === "nw") { x += dx; y += dy; w -= dx; h -= dy; }
      else if (drag.handle === "ne") { y += dy; w += dx; h -= dy; }
      else if (drag.handle === "sw") { x += dx; w -= dx; h += dy; }
      else { w += dx; h += dy; }
      if (w < 4 || h < 4) return;
      onChangeRect(drag.id, { x, y, w, h });
    }
  }

  function onPointerUp(e: ReactPointerEvent<SVGSVGElement>) {
    if (!drag) return;
    svgRef.current?.releasePointerCapture(e.pointerId);
    if (drag.type === "draw") {
      const x = Math.min(drag.start.x, drag.current.x);
      const y = Math.min(drag.start.y, drag.current.y);
      const w = Math.abs(drag.current.x - drag.start.x);
      const h = Math.abs(drag.current.y - drag.start.y);
      if (w > imageWidth * 0.01 && h > imageHeight * 0.008) {
        onAdd(mode === "draw-name" ? "name" : "question", { x, y, w, h });
      }
    }
    setDrag(null);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setDrag(null);
        onSelect(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onSelect]);

  const long = Math.max(imageWidth, imageHeight);
  const stroke = long / 420;
  const handleSize = long / 75;
  const fontSize = long / 55;

  const draftRect = (() => {
    if (!drag || drag.type !== "draw") return null;
    const x = Math.min(drag.start.x, drag.current.x);
    const y = Math.min(drag.start.y, drag.current.y);
    return { x, y, w: Math.abs(drag.current.x - drag.start.x), h: Math.abs(drag.current.y - drag.start.y) };
  })();

  return (
    <div className="region-editor" style={{ position: "relative", userSelect: "none" }}>
      <img src={imageUrl} alt="答题卡样张" style={{ display: "block", width: "100%", height: "auto", borderRadius: 10 }} draggable={false} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${imageWidth} ${imageHeight}`}
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          cursor: mode === "select" ? "default" : "crosshair",
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        {regions.map((r) => {
          const px = toPx(r);
          const selected = r.id === selectedId;
          const isName = r.kind === "name";
          const color = isName ? "#2563eb" : "#e11d48";
          return (
            <g key={r.id} onPointerEnter={() => setHover(r.id)} onPointerLeave={() => setHover(null)}>
              <rect
                data-region-id={r.id}
                x={px.x}
                y={px.y}
                width={px.w}
                height={px.h}
                fill={selected ? `${color}22` : hover === r.id ? `${color}14` : "transparent"}
                stroke={color}
                strokeWidth={selected ? stroke * 1.8 : stroke}
                strokeDasharray={isName ? `${stroke * 4} ${stroke * 2}` : undefined}
                rx={stroke * 1.5}
                style={{ cursor: mode === "select" ? "move" : "crosshair" }}
              />
              <rect
                data-region-id={r.id}
                x={px.x}
                y={Math.max(0, px.y - fontSize * 1.5)}
                width={(isName ? 8 : String(r.questionNo ?? "").length + 1) * fontSize * 0.75}
                height={fontSize * 1.35}
                fill={color}
                rx={fontSize * 0.25}
                style={{ cursor: mode === "select" ? "move" : "crosshair" }}
              />
              <text
                data-region-id={r.id}
                x={px.x + fontSize * 0.35}
                y={Math.max(fontSize * 1.05, px.y - fontSize * 0.42)}
                fill="#fff"
                fontSize={fontSize}
                fontWeight={700}
                style={{ pointerEvents: "none" }}
              >
                {isName ? "姓名" : r.questionNo ?? "?"}
              </text>
              {selected &&
                (["nw", "ne", "sw", "se"] as const).map((h) => {
                  const hx = h === "nw" || h === "sw" ? px.x : px.x + px.w;
                  const hy = h === "nw" || h === "ne" ? px.y : px.y + px.h;
                  return (
                    <rect
                      key={h}
                      data-region-id={r.id}
                      data-handle={h}
                      x={hx - handleSize / 2}
                      y={hy - handleSize / 2}
                      width={handleSize}
                      height={handleSize}
                      fill="#fff"
                      stroke={color}
                      strokeWidth={stroke}
                      style={{ cursor: `${h}-resize` }}
                    />
                  );
                })}
            </g>
          );
        })}
        {draftRect && (
          <rect
            x={draftRect.x}
            y={draftRect.y}
            width={draftRect.w}
            height={draftRect.h}
            fill="#e11d4822"
            stroke="#e11d48"
            strokeWidth={stroke * 1.5}
            strokeDasharray={`${stroke * 4} ${stroke * 2}`}
            style={{ pointerEvents: "none" }}
          />
        )}
      </svg>
    </div>
  );
}

export type { Mode as RegionEditorMode };
export type { RectPx };
