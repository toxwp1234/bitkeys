"use strict";
// ---------------------------------------------------------------------------
// Heat palettes for the keyspace map.
//
// A patch is coloured by HOW MANY keys the Bloom filter flagged in it. The count
// is compressed with log1p (see HEAT_FULL in app.js) into a position from 0 to 1,
// and that position is looked up here.
//
// TO ADD A PALETTE: append one entry. `colors` is a plain list of hex strings,
// dark/quiet first (a patch that flagged nothing) to loud last (a big haul). They
// are spaced evenly across the ramp, so ANY number of colours works — two is a
// straight fade, twelve is a fine gradient. Nothing else needs touching; the
// Theme menu builds itself from this list.
//
// Two things worth knowing when picking colours:
//   - The first colour is what most of the map looks like, since most patches
//     flag nothing. Keep it calm and dark enough to sit on the #0a0c10 stage.
//   - `grid` is the colour of the lattice and the keyspace border for this theme.
//     It is drawn at low alpha, so pick something from the bright end of the family
//     or it disappears. Optional — leave it out and the amber default is used.
//   - The pen square stays BTC amber in every theme; it is you, not the map. A
//     palette whose `grid` is also amber ("Ember", "Copper") will blur that line.
// ---------------------------------------------------------------------------

export const PALETTES = [
  {
    id: "deepsea",
    grid: "#f7931a",
    name: "Deep sea",
    note: "the default — cool to crimson, never touching the grid's amber",
    colors: ["#1f6f88", "#2f8f8a", "#4f9d7a", "#6f93c4", "#8a7fc9", "#a877c4", "#c47399", "#d4687f"],
  },
  {
    id: "ice",
    grid: "#7fe3f2",
    name: "Ice",
    note: "teal climbing into pale blue",
    colors: ["#125a6e", "#1a7f96", "#2aa3b8", "#46c2d4", "#74d8e4", "#a3e7ee", "#c9f2f5", "#e8fbfc"],
  },
  {
    id: "viridis",
    grid: "#cbe84a",
    name: "Viridis",
    note: "the perceptual classic: blue, teal, green, yellow",
    colors: ["#2a2a5e", "#3b528b", "#2c728e", "#21918c", "#28ae80", "#5ec962", "#addc30", "#fde725"],
  },
  {
    id: "magma",
    grid: "#f58c46",
    name: "Magma",
    note: "deep violet burning out to bone white",
    colors: ["#2d1a5c", "#4a1079", "#822681", "#b5367a", "#e05c5d", "#f58c46", "#fcc26d", "#fcfdbf"],
  },
  {
    id: "ultraviolet",
    grid: "#b06fe0",
    name: "Ultraviolet",
    note: "navy through violet into hot pink",
    colors: ["#232a63", "#373c94", "#5546b4", "#7a4fc4", "#a055c9", "#c45fc0", "#e070ab", "#f78fa7"],
  },
  {
    id: "toxic",
    grid: "#a8e34f",
    name: "Toxic",
    note: "forest green up to acid yellow",
    colors: ["#1a5228", "#1d6b2e", "#2d9440", "#4fb949", "#7fd44b", "#b0e756", "#d9f36b", "#f2fa8c"],
  },
  {
    id: "aurora",
    grid: "#6fd9a8",
    name: "Aurora",
    note: "teal and green folding into violet",
    colors: ["#10314f", "#14607a", "#19907f", "#3cbd86", "#8ed99a", "#d2ecb5", "#f3d9f0", "#cfa6ea"],
  },
  {
    id: "mono",
    grid: "#8d97a5",
    name: "Monochrome",
    note: "no hue at all — slate to white",
    colors: ["#3a4049", "#4e5560", "#636b78", "#7a8390", "#939ca8", "#b0b8c2", "#ced4db", "#eef2f6"],
  },
  {
    id: "copper",
    grid: "#d9a86f",
    name: "Copper",
    note: "bronze to cream — warm, and close to the grid's own colour",
    colors: ["#4a2f1d", "#5e3a22", "#85522c", "#a86c38", "#c48a4e", "#d9a86f", "#e9c79a", "#f6e3c8"],
  },
  {
    id: "ember",
    grid: "#ee9040",
    name: "Ember",
    note: "coal to flame — the loudest one, and it does share the pen's hue",
    colors: ["#3d2517", "#5c2a17", "#8c3a1c", "#b84f22", "#d96e2a", "#ee9040", "#f8b661", "#fddc93"],
  },
];

export const DEFAULT_PALETTE = "deepsea";
export const DEFAULT_GRID = "#f7931a";

// "#1f6f88" -> [31, 111, 136]
export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Turn a palette's colour list into the [position, rgb] stops the ramp lookup wants.
// Even spacing is the whole trick: it means a palette is just a list of colours.
export function rampOf(palette) {
  const c = palette.colors;
  if (c.length === 1) return [[0, hexToRgb(c[0])], [1, hexToRgb(c[0])]];
  return c.map((hex, i) => [i / (c.length - 1), hexToRgb(hex)]);
}

// "#f7931a" + .32 -> "rgba(247,147,26,0.32)"
export function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

export const paletteById = (id) => PALETTES.find((p) => p.id === id) || PALETTES[0];
