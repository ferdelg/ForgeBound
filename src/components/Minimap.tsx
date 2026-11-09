import { useEffect, useRef, useState } from "react";
import type { GameApi } from "../game/useGame";
import { BUILDINGS, MAP_H, MAP_W, UNDER_Y, groundAt, isUnderground, objAt } from "../game/map";
import { ORE_COLORS } from "../game/render";
import { roofColor } from "../game/village";
import * as storage from "../storage";

/** On-screen size of one tile at 1× zoom (CSS px). */
const SCALE = 3;
/** The radar's frame (CSS px): it always follows the hero, whatever the realm's size. */
const MW = 216;
const MH = 156;
/** Terrain is painted once at this many px per tile, so zooming in stays crisp. */
const BP = 16;

/** Radar zoom steps; ½ takes in most of the realm, 4 is up close. */
const ZOOMS = [0.5, 1, 1.5, 2, 3, 4];
const ZOOM_KEY = "forgebound-minimap-zoom";
const DEFAULT_ZOOM = 2;

function storedZoom(): number {
    try {
        const z = Number(storage.getItem(ZOOM_KEY));
        return ZOOMS.includes(z) ? z : DEFAULT_ZOOM;
    } catch {
        return DEFAULT_ZOOM;
    }
}

// Same stable per-tile noise idea as the world renderer
const hash = (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
};

/** Paints the static terrain: textured ground, shorelines, trees, rocks, fences and huts. */
function paintTerrain(): HTMLCanvasElement {
    const base = document.createElement("canvas");
    base.width = MAP_W * BP;
    base.height = MAP_H * BP;
    const b = base.getContext("2d")!;
    const isWater = (x: number, y: number) => groundAt(x, y) === "~";

    for (let y = 0; y < MAP_H; y++) {
        for (let x = 0; x < MAP_W; x++) {
            const g = groundAt(x, y);
            const h = hash(x, y);
            const px = x * BP, py = y * BP;
            if (g === "~") b.fillStyle = `hsl(205, 62%, ${30 + h * 5}%)`;
            else if (g === "#") b.fillStyle = `hsl(215, 8%, ${40 + h * 6}%)`;
            else if (g === ",") b.fillStyle = `hsl(28, 44%, ${33 + h * 6}%)`;
            else if (g === "_") b.fillStyle = `hsl(42, 58%, ${60 + h * 6}%)`;
            else if (g === "b") b.fillStyle = `hsl(25, 48%, ${34 + h * 4}%)`;
            else if (g === "m") b.fillStyle = `hsl(212, 10%, ${22 + h * 5}%)`;
            else if (g === "p") b.fillStyle = `hsl(28, 38%, ${32 + h * 4}%)`;
            else if (g === "q" || g === "d") b.fillStyle = `hsl(35, 6%, ${46 + h * 6}%)`;
            else if (g === "W") b.fillStyle = "#3a332c";
            else if (g === "k") b.fillStyle = `hsl(220, 8%, ${22 + h * 5}%)`;
            else if (g === "w") b.fillStyle = "#2a2c34";
            else if (g === " ") b.fillStyle = "#060608";
            else b.fillStyle = `hsl(${105 + h * 16}, ${38 + h * 10}%, ${27 + h * 5}%)`;
            b.fillRect(px, py, BP, BP);

            if (g === "." ) {
                // grass tufts
                b.fillStyle = `hsla(112, 50%, ${38 + h * 8}%, 0.55)`;
                for (let i = 0; i < 3; i++) {
                    const tx = px + ((h * 997 + i * 5.3) % 1) * BP, ty = py + ((h * 613 + i * 7.1) % 1) * BP;
                    b.fillRect(tx, ty, 1.5, 3);
                }
            } else if (g === "#") {
                b.strokeStyle = "rgba(0,0,0,0.18)";
                b.lineWidth = 1;
                b.strokeRect(px + 0.5, py + 0.5, BP - 1, BP - 1);
            } else if (g === "b") {
                b.fillStyle = "rgba(0,0,0,0.25)";
                for (let i = 1; i < 4; i++) b.fillRect(px + (i * BP) / 4, py, 1, BP);
            } else if (g === "~") {
                b.fillStyle = "rgba(255,255,255,0.08)";
                b.fillRect(px + h * 8, py + 4 + h * 6, 6, 1);
            } else if (g === "m") {
                // a shaded peak with a snow cap
                const pk = px + BP * (0.35 + h * 0.3);
                b.fillStyle = `hsl(212, 9%, ${29 + h * 5}%)`;
                b.beginPath(); b.moveTo(px - 2, py + BP); b.lineTo(pk, py + 2); b.lineTo(px + BP + 2, py + BP); b.fill();
                b.fillStyle = `hsl(212, 12%, ${22 + h * 4}%)`;
                b.beginPath(); b.moveTo(pk, py + 2); b.lineTo(px + BP + 2, py + BP); b.lineTo(pk + 2, py + BP); b.fill();
                b.fillStyle = "rgba(236,240,246,0.45)";
                b.beginPath(); b.moveTo(pk - 3, py + 7); b.lineTo(pk, py + 2); b.lineTo(pk + 3, py + 7); b.fill();
            }
        }
    }

    // pale foam where water meets land
    b.fillStyle = "rgba(220,236,240,0.35)";
    for (let y = 0; y < MAP_H; y++) {
        for (let x = 0; x < MAP_W; x++) {
            if (!isWater(x, y)) continue;
            const px = x * BP, py = y * BP;
            if (!isWater(x, y - 1)) b.fillRect(px, py, BP, 2);
            if (!isWater(x, y + 1)) b.fillRect(px, py + BP - 2, BP, 2);
            if (!isWater(x - 1, y)) b.fillRect(px, py, 2, BP);
            if (!isWater(x + 1, y)) b.fillRect(px + BP - 2, py, 2, BP);
        }
    }

    // objects that belong to the terrain (stations, NPCs and the like are live icons)
    for (let y = 0; y < MAP_H; y++) {
        for (let x = 0; x < MAP_W; x++) {
            const o = objAt(x, y);
            if (!o) continue;
            const cx = x * BP + BP / 2, cy = y * BP + BP / 2;
            const h = hash(x, y);
            if (o === "T" || o === "O") {
                const r = BP * (o === "O" ? 0.62 : 0.5);
                b.fillStyle = "rgba(0,0,0,0.3)";
                b.beginPath(); b.arc(cx + 2, cy + 2.5, r, 0, Math.PI * 2); b.fill();
                const leaf = b.createRadialGradient(cx - r * 0.35, cy - r * 0.35, 1, cx, cy, r);
                leaf.addColorStop(0, o === "O" ? "#4f9a3e" : "#5cae4c");
                leaf.addColorStop(1, o === "O" ? "#1d4416" : "#245220");
                b.fillStyle = leaf;
                b.beginPath(); b.arc(cx, cy, r, 0, Math.PI * 2); b.fill();
            } else if (ORE_COLORS[o]) {
                b.fillStyle = "#4a4d55";
                b.beginPath(); b.arc(cx, cy + 1, BP * 0.42, 0, Math.PI * 2); b.fill();
                b.fillStyle = "#6e727c";
                b.beginPath(); b.arc(cx - 1.5, cy - 0.5, BP * 0.32, 0, Math.PI * 2); b.fill();
                b.fillStyle = ORE_COLORS[o];
                b.beginPath(); b.arc(cx + 1.5, cy, BP * 0.16, 0, Math.PI * 2); b.fill();
            } else if (o === "=") {
                b.strokeStyle = "#8a6238";
                b.lineWidth = 2;
                b.beginPath();
                for (const [dx, dy] of [[1, 0], [0, 1]]) {
                    if (objAt(x + dx, y + dy) === "=") { b.moveTo(cx, cy); b.lineTo(cx + dx * BP, cy + dy * BP); }
                }
                b.stroke();
                b.fillStyle = "#5a3c20";
                b.fillRect(cx - 1.5, cy - 1.5, 3, 3);
            } else if (o === "H" || o === "c") {
                b.fillStyle = "rgba(0,0,0,0.3)";
                b.fillRect(cx - 5, cy - 3, 12, 11);
                b.fillStyle = o === "H" ? "#8a5a30" : "#a06a34";
                b.fillRect(cx - 6, cy - 5, 12, 10);
                b.fillStyle = o === "H" ? "#c99a5c" : "#c88a48";
                b.beginPath(); b.moveTo(cx - 7, cy - 4); b.lineTo(cx, cy - 9); b.lineTo(cx + 7, cy - 4); b.fill();
            } else if (o === "h") {
                b.fillStyle = "#d8b050";
                b.fillRect(cx - 5, cy - 4, 10, 8);
                b.fillStyle = "rgba(120,80,20,0.4)";
                b.fillRect(cx - 5, cy - 1, 10, 1);
            } else if (o === "V") {
                b.fillStyle = "#6a4a2a"; b.fillRect(cx - 0.5, cy - 7, 2, 14);
                b.fillStyle = "#c04030";
                b.beginPath(); b.moveTo(cx + 1, cy - 7); b.lineTo(cx + 7, cy - 4); b.lineTo(cx + 1, cy - 1); b.fill();
            } else if (o === "%") {
                for (let i = 0; i < 3; i++) {
                    b.fillStyle = ["#f06a8a", "#f0d050", "#9ad0ff"][(i + Math.floor(h * 3)) % 3];
                    b.beginPath(); b.arc(cx - 4 + i * 4, cy + ((i % 2) * 4 - 2), 1.6, 0, Math.PI * 2); b.fill();
                }
            } else if (o === "^") {
                b.fillStyle = "rgba(30,70,20,0.45)";
                b.beginPath(); b.arc(cx, cy, BP * 0.35, 0, Math.PI * 2); b.fill();
            } else if (o === "y") {
                b.fillStyle = "#9a988f";
                b.fillRect(cx - 2.5, cy - 4, 5, 7);
            } else if (o === "s" || o === "n" || o === "e") {
                b.fillStyle = o === "s" ? "#5a5a62" : "#6a4420";
                b.fillRect(cx - 6, cy - 3, 12, 6);
            } else if (o === "D") {
                b.fillStyle = "#6c6a64"; b.fillRect(cx - 8, cy - 6, 16, 12);
                b.fillStyle = "#0c0a08"; b.fillRect(cx - 3, cy - 2, 6, 8);
            }
        }
    }

    // Roofs, as the radar sees them from above; a soft ridge line along each
    for (const bd of BUILDINGS) {
        const x = bd.x0 * BP, y = bd.y0 * BP, w = (bd.x1 - bd.x0 + 1) * BP, h = (bd.y1 - bd.y0 + 1) * BP;
        b.fillStyle = "rgba(0,0,0,0.35)";
        b.fillRect(x + 3, y + 4, w, h);
        b.fillStyle = roofColor(bd);
        b.fillRect(x, y, w, h);
        b.fillStyle = "rgba(255,255,255,0.12)";
        b.fillRect(x, y, w, h * 0.45);
        b.fillStyle = "rgba(0,0,0,0.3)";
        b.fillRect(x, y + h * 0.45, w, 2);
    }
    return base;
}

type Glyph = "coin" | "bag" | "flame" | "anvil" | "star" | "fish" | "guide" | "gate";
interface MapIcon { x: number; y: number; glyph: Glyph; ring: string; fill: string }

/** Map icons for the places worth finding; fishing spots get one icon per stretch of water. */
function findIcons(): MapIcon[] {
    const icons: MapIcon[] = [];
    const add = (x: number, y: number, glyph: Glyph, fill: string, ring = "#1a140c") => icons.push({ x, y, glyph, fill, ring });
    for (let y = 0; y < MAP_H; y++) {
        for (let x = 0; x < MAP_W; x++) {
            const o = objAt(x, y);
            const near = (gl: Glyph, d: number) => icons.some((i) => i.glyph === gl && Math.abs(i.x - x) + Math.abs(i.y - y) < d);
            if (o === "B") { if (!near("coin", 8)) add(x + 3, y, "coin", "#e8c040"); }
            else if (o === "Z") add(x, y, "gate", "#7ad8ff", "#1a3a5a");
            else if (o === "Q") add(x, y, "guide", "#c8b080");
            else if (o === "M") add(x, y, "bag", "#b060c0");
            else if (o === "F") add(x, y, "flame", "#e07020");
            else if (o === "*") { if (!near("flame", 3)) add(x + 0.5, y + 0.5, "flame", "#d84a28"); }
            else if (o === "A") add(x, y, "anvil", "#8a929c");
            else if (o === "L") add(x, y, "star", "#e8e4f8", "#4a4670");
            else if (o === "P") add(x, y, "guide", "#5a88e0");
            else if ((o === "f" || o === "t") && !icons.some((i) => i.glyph === "fish" && Math.abs(i.x - x) + Math.abs(i.y - y) < 6)) {
                add(x, y, "fish", "#3aa0d0");
            }
        }
    }
    return icons;
}

function drawIcon(ctx: CanvasRenderingContext2D, ic: MapIcon, cx: number, cy: number, scale: number) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    cx = 0; cy = 0;
    const r = 5.5;
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath(); ctx.arc(cx + 0.6, cy + 0.9, r + 1, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ic.ring;
    ctx.beginPath(); ctx.arc(cx, cy, r + 0.9, 0, Math.PI * 2); ctx.fill();
    const grad = ctx.createRadialGradient(cx - 1.5, cy - 2, 0.5, cx, cy, r);
    grad.addColorStop(0, "rgba(255,255,255,0.55)");
    grad.addColorStop(0.35, ic.fill);
    grad.addColorStop(1, ic.fill);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = "#1a140c";
    ctx.strokeStyle = "#1a140c";
    ctx.lineWidth = 1;
    switch (ic.glyph) {
        case "coin":
            ctx.beginPath(); ctx.arc(cx, cy, 2.6, 0, Math.PI * 2); ctx.stroke();
            ctx.fillRect(cx - 0.5, cy - 1.6, 1, 3.2);
            break;
        case "bag":
            ctx.fillStyle = "#f4eee0";
            ctx.beginPath(); ctx.arc(cx, cy + 0.8, 2.6, 0, Math.PI * 2); ctx.fill();
            ctx.fillRect(cx - 1.2, cy - 2.8, 2.4, 1.8);
            break;
        case "flame":
            ctx.fillStyle = "#fff0b0";
            ctx.beginPath();
            ctx.moveTo(cx, cy - 3.4);
            ctx.quadraticCurveTo(cx + 3.2, cy + 0.2, cx, cy + 3);
            ctx.quadraticCurveTo(cx - 3.2, cy + 0.2, cx, cy - 3.4);
            ctx.fill();
            break;
        case "anvil":
            ctx.fillRect(cx - 3, cy - 1.8, 6, 1.8);
            ctx.fillRect(cx - 1, cy, 2, 1.6);
            ctx.fillRect(cx - 2.4, cy + 1.6, 4.8, 1.2);
            break;
        case "star":
            ctx.fillStyle = "#d8b25c";
            ctx.beginPath();
            for (let i = 0; i < 8; i++) {
                const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
                const rr = i % 2 === 0 ? 3.6 : 1.3;
                ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
            }
            ctx.fill();
            break;
        case "fish":
            ctx.fillStyle = "#e8f6ff";
            ctx.beginPath(); ctx.ellipse(cx - 0.6, cy, 2.6, 1.6, 0, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.moveTo(cx + 1.6, cy); ctx.lineTo(cx + 3.4, cy - 1.8); ctx.lineTo(cx + 3.4, cy + 1.8); ctx.fill();
            break;
        case "gate":
            ctx.strokeStyle = "#e8f8ff";
            ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.ellipse(cx, cy + 0.5, 3, 2, 0, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = "#e8f8ff";
            for (const dx of [-2.6, 0, 2.6]) ctx.fillRect(cx + dx - 0.6, cy - 3 + (dx === 0 ? -0.6 : 0.6), 1.2, 3);
            break;
        case "guide":
            ctx.fillStyle = "#f4eee0";
            ctx.font = "bold 8px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("?", cx, cy + 0.5);
            break;
    }
    ctx.restore();
}

/**
 * The hero's marker: an original gold arrowhead, pointing the way the hero
 * is facing. `ang` is in radians,
 * 0 = east.
 */
function drawHeroMarker(ctx: CanvasRenderingContext2D, cx: number, cy: number, ang: number, t: number) {
    const glow = 0.35 + 0.15 * Math.sin(t / 420);
    const halo = ctx.createRadialGradient(cx, cy, 1, cx, cy, 11);
    halo.addColorStop(0, `rgba(255,220,120,${glow})`);
    halo.addColorStop(1, "rgba(255,220,120,0)");
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, 11, 0, Math.PI * 2); ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(ang);
    // A pointed triangle with slightly concave sides and a gently curved-in
    // back edge, so it reads as an arrowhead rather than a cursor.
    const shape = () => {
        ctx.beginPath();
        ctx.moveTo(13, 0);                                 // tip, drawn out long so the heading reads at a glance
        ctx.quadraticCurveTo(3, -1.8, -5, -6);             // upper side
        ctx.quadraticCurveTo(-3, 0, -5, 6);                // back edge, curving in
        ctx.quadraticCurveTo(3, 1.8, 13, 0);               // lower side
        ctx.closePath();
    };
    // dark outline for contrast on any ground
    shape();
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = "rgba(20,12,4,0.9)";
    ctx.stroke();
    const gold = ctx.createLinearGradient(0, -6, 0, 6);
    gold.addColorStop(0, "#fff1b8");
    gold.addColorStop(0.45, "#e8c060");
    gold.addColorStop(1, "#9a6c1c");
    ctx.fillStyle = gold;
    shape();
    ctx.fill();
    // centre ridge
    ctx.strokeStyle = "rgba(255,250,220,0.8)";
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(10.5, 0); ctx.lineTo(-3.4, 0); ctx.stroke();
    ctx.restore();
}

export function Minimap({ api }: { api: GameApi }) {
    const ref = useRef<HTMLCanvasElement>(null);
    const [zoom, setZoomState] = useState(storedZoom);
    const zoomRef = useRef(zoom);
    // Top-left tile of the current view, shared with click-to-travel
    const viewRef = useRef({ ox: 0, oy: 0 });

    const setZoom = (z: number) => {
        zoomRef.current = z;
        setZoomState(z);
        try { storage.setItem(ZOOM_KEY, String(z)); } catch { /* ignore */ }
    };
    const step = (d: number) => {
        const i = ZOOMS.indexOf(zoomRef.current) + d;
        if (i >= 0 && i < ZOOMS.length) setZoom(ZOOMS[i]);
    };

    useEffect(() => {
        const base = paintTerrain();
        const icons = findIcons();
        const canvas = ref.current!;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvas.width = MW * dpr;
        canvas.height = MH * dpr;
        const ctx = canvas.getContext("2d")!;
        let raf = 0;
        // Facing, from the hero's last step; eased so the arrow turns rather than snaps
        const last = { x: -1, y: -1 };
        let ang = -Math.PI / 2, target = ang;

        const loop = (t: number) => {
            raf = requestAnimationFrame(loop);
            const g = api.gref.current;
            if (!g) return;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.clearRect(0, 0, MW, MH);

            // View window in tiles, centred on the hero and kept inside the
            // hero's own layer: the surface, or the crypt below it
            const z = zoomRef.current;
            const tp = SCALE * z; // CSS px per tile
            const vw = MW / tp, vh = MH / tp;
            const under = isUnderground(g.x, g.y);
            const top = under ? UNDER_Y : 0, bottom = under ? MAP_H : UNDER_Y;
            const ox = vw >= MAP_W ? (MAP_W - vw) / 2 : Math.max(0, Math.min(MAP_W - vw, g.x + 0.5 - vw / 2));
            const oy = vh >= bottom - top ? top + (bottom - top - vh) / 2 : Math.max(top, Math.min(bottom - vh, g.y + 0.5 - vh / 2));
            viewRef.current = { ox, oy };
            ctx.fillStyle = "#060608";
            ctx.fillRect(0, 0, MW, MH);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            // Only the hero's layer shows; the band beyond it stays dark
            const sy0 = Math.max(oy, top), sy1 = Math.min(oy + vh, bottom);
            const sx0 = Math.max(0, ox), sx1 = Math.min(MAP_W, ox + vw);
            ctx.drawImage(base, sx0 * BP, sy0 * BP, (sx1 - sx0) * BP, (sy1 - sy0) * BP,
                (sx0 - ox) * tp, (sy0 - oy) * tp, (sx1 - sx0) * tp, (sy1 - sy0) * tp);
            const sx = (x: number) => (x - ox + 0.5) * tp;
            const sy = (y: number) => (y - oy + 0.5) * tp;
            const inView = (x: number, y: number) => x >= ox - 1 && x <= ox + vw && y >= oy - 1 && y <= oy + vh && isUnderground(x, y) === under;

            // creatures: small outlined dots
            const dot = (x: number, y: number, color: string) => {
                if (!inView(x, y)) return;
                const r = Math.max(1.6, Math.min(3, tp * 0.28));
                ctx.fillStyle = "rgba(10,8,4,0.85)";
                ctx.beginPath(); ctx.arc(sx(x), sy(y), r + 0.8, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = color;
                ctx.beginPath(); ctx.arc(sx(x), sy(y), r, 0, Math.PI * 2); ctx.fill();
            };
            for (const c of g.cows) if (c.hp > 0) dot(c.x, c.y, "#f4f0e8");
            for (const ch of g.chickens ?? []) if (ch.hp > 0) dot(ch.x, ch.y, "#ffe14a");
            for (const f of g.foes ?? []) if (f.hp > 0) dot(f.x, f.y, f.foe === "restless" || f.foe === "warden" ? "#9fe8ff" : "#e05252");

            // Icons shrink when zoomed out so the square's cluster doesn't pile up
            const iconScale = Math.min(1, 0.5 + z * 0.22);
            for (const ic of icons) if (inView(ic.x, ic.y)) drawIcon(ctx, ic, sx(ic.x), sy(ic.y), iconScale);

            if (g.x !== last.x || g.y !== last.y) {
                if (last.x >= 0) target = Math.atan2(g.y - last.y, g.x - last.x);
                last.x = g.x; last.y = g.y;
            }
            let d = target - ang;
            d = Math.atan2(Math.sin(d), Math.cos(d));
            ang += d * 0.2;
            drawHeroMarker(ctx, sx(g.x), sy(g.y), ang, t);
        };
        raf = requestAnimationFrame(loop);
        return () => cancelAnimationFrame(raf);
    }, [api]);

    const onClick = (e: React.MouseEvent) => {
        const g = api.gref.current;
        const canvas = ref.current;
        if (!g || !canvas) return;
        const rect = canvas.getBoundingClientRect();
        const { ox, oy } = viewRef.current;
        const z = zoomRef.current;
        const tp = SCALE * z;
        const tx = Math.floor(ox + ((e.clientX - rect.left) / rect.width) * (MW / tp));
        const ty = Math.floor(oy + ((e.clientY - rect.top) / rect.height) * (MH / tp));
        api.handleWorldClick(tx, ty);
        api.bump();
    };

    return (
        <div className="pointer-events-auto relative select-none">
            <div
                className="relative overflow-hidden rounded-full border-2 border-[#b08a3e] shadow-[0_0_0_1px_#2a1e0c,0_0_0_4px_rgba(216,178,92,0.22),0_6px_22px_rgba(0,0,0,0.7)]"
                style={{ width: MW + 4, height: MH + 4 }}
            >
                <canvas
                    ref={ref}
                    onClick={onClick}
                    onWheel={(e) => step(e.deltaY < 0 ? 1 : -1)}
                    title="Click to travel · scroll to zoom"
                    className="block cursor-pointer"
                    style={{ width: MW, height: MH }}
                />
                {/* bevel: darkened rim and a soft top highlight, like glass over the map */}
                <div className="pointer-events-none absolute inset-0 rounded-full shadow-[inset_0_0_18px_rgba(0,0,0,0.75),inset_0_2px_0_rgba(255,236,180,0.18)]" />
                <span className="font-display absolute left-1/2 top-0.5 -translate-x-1/2 text-[9px] font-black text-[#f0c858] [text-shadow:0_1px_2px_#000]">
                    N
                </span>
            </div>
            <div className="mt-1 flex items-center justify-center gap-2">
                <ZoomButton label="−" title="Zoom the map out" disabled={zoom === ZOOMS[0]} onClick={() => step(-1)} />
                <span className="font-display text-[8px] font-bold tracking-[0.3em] text-[#8a7a52]">FORGEBOUND</span>
                <ZoomButton label="+" title="Zoom the map in" disabled={zoom === ZOOMS[ZOOMS.length - 1]} onClick={() => step(1)} />
            </div>
        </div>
    );
}

function ZoomButton({ label, title, disabled, onClick }: { label: string; title: string; disabled: boolean; onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            title={title}
            className="flex h-4 w-4 items-center justify-center rounded-sm border border-[#6a5420] bg-[#14100a]/90 text-[11px] font-bold leading-none text-[#f0c858] transition-colors hover:border-[#d8b25c] disabled:opacity-35"
        >
            {label}
        </button>
    );
}
