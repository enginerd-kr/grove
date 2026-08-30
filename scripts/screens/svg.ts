/**
 * A drawn frame, turned into a picture of a terminal.
 *
 * The frames Ink writes are text and SGR escapes, which is everything a
 * terminal needs and nothing a README can show. This turns one into an SVG:
 * the same characters on the same grid, wearing the same colours, in a window
 * with a title bar — so what the docs show is what the program drew, not a
 * transcription of it.
 */

// Built from a char code so the escape byte never appears literally in source.
const ESC = String.fromCharCode(27);
/** SGR is the only escape a frame carries that means anything here. */
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");
/** Everything else Ink emits — cursor moves, screen clears — is not paint. */
const OTHER = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}[()][A-Za-z0-9]`, "g");

/** Hangul and its CJK neighbours take two cells to Latin's one. */
const WIDE = /[ᄀ-ᅟ⺀-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

function width(text: string): number {
  let cells = 0;
  for (const char of text) cells += WIDE.test(char) ? 2 : 1;

  return cells;
}

/**
 * The 16 ANSI slots, in a dark terminal's usual clothes.
 *
 * `theme.ts` spells every colour it wants by name — `cyan`, `gray`, `green`,
 * `yellow`, `red` — so unlike a hex-heavy app this table is the whole palette
 * the picture is painted from.
 */
// biome-ignore format: eight to a row is the table it is — the low half of the
// palette above the bright half of it.
const PALETTE = [
  "#3b4048", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#c6cad2",
  "#5c6370", "#ef8a94", "#b5df9b", "#f0d3a0", "#8ac6f5", "#d99ae8", "#7fd4de", "#eceff4",
];

/** The window the frame is drawn in, and the ink it defaults to. */
const CHROME = "#1c1e22";
const BORDER = "#2c2f36";
const SCREEN = "#141619";
const DEFAULT_FG = "#e4e6ea";

const CELL_W = 8.4;
const LINE_H = 19;
const FONT_SIZE = 14;
const BASELINE = 14;
const PAD_X = 18;
const PAD_Y = 14;
const TITLE_H = 30;

/**
 * The characters a terminal paints with rather than writes with.
 *
 * A block or a rule is not a letter. It is the cell, filled — and it only
 * means anything if it meets its neighbours exactly. A font cannot promise
 * that: the glyph is drawn inside an em box hung off the baseline, so at
 * `FONT_SIZE` in a `LINE_H` line it comes up five pixels short, and every row
 * boundary becomes a seam. The banner's logo arrived as three floating bars
 * with daylight between them, and the card's left rule as a dashed line.
 *
 * So they are drawn as geometry instead. The cell is what they are measured
 * against, and the cell is the one thing this file knows exactly.
 */

/** A rectangle inside one cell, in fractions of it: x, y, width, height. */
type Fill = readonly [number, number, number, number];

const UL: Fill = [0, 0, 0.5, 0.5];
const UR: Fill = [0.5, 0, 0.5, 0.5];
const LL: Fill = [0, 0.5, 0.5, 0.5];
const LR: Fill = [0.5, 0.5, 0.5, 0.5];

/** The block elements, as the parts of a cell each one covers. */
const BLOCKS: Readonly<Record<string, readonly Fill[]>> = {
  "▀": [[0, 0, 1, 0.5]],
  "▄": [[0, 0.5, 1, 0.5]],
  "█": [[0, 0, 1, 1]],
  "▌": [[0, 0, 0.5, 1]],
  "▐": [[0.5, 0, 0.5, 1]],
  "▖": [LL],
  "▗": [LR],
  "▘": [UL],
  "▝": [UR],
  "▙": [UL, LL, LR],
  "▚": [UL, LR],
  "▛": [UL, UR, LL],
  "▜": [UL, UR, LR],
  "▞": [UR, LL],
  "▟": [UR, LL, LR],
};

/**
 * How thick a light box-drawing line is, and how tight its rounded corner.
 *
 * Thin enough to read as a rule rather than a bar, and a radius because the
 * card asks for one — `borderStyle="round"` is what draws ╭╮╰╯, and a square
 * corner here would be the wrong border rendered accurately.
 */
const STROKE = 1.3;
const RADIUS = 3;

/**
 * One box-drawing character as the stroke it is, or `undefined` for anything
 * that is not one.
 *
 * Every arm runs from the middle of the cell to the edge it points at, so a
 * character meets whatever is in the next cell exactly on the boundary — which
 * is what makes a row of them one rule and a column of them one line.
 *
 * `cells` is how many of the same character sit here in a row. A divider is a
 * hundred `─` and is drawn as one segment: cheaper, and a single segment is
 * the only kind that cannot have a seam in it.
 */
function boxPath(char: string, x: number, y: number, cells: number): string | undefined {
  // Rounded to the two places the fills use. A coordinate carrying
  // `958.8000000000001` is float noise in a committed file that a re-shoot has
  // to reproduce byte for byte.
  const at = (value: number) => value.toFixed(2);

  const left = at(x);
  const right = at(x + cells * CELL_W);
  const top = at(y);
  const bottom = at(y + LINE_H);
  // The middle of the *first* cell: a run is one segment, but a corner is
  // always a single cell and pivots on its own middle.
  const cx = at(x + CELL_W / 2);
  const cy = at(y + LINE_H / 2);
  // Where the corner's arc leaves the arm it came up, and where it rejoins the
  // one it turns into.
  const above = at(y + LINE_H / 2 - RADIUS);
  const below = at(y + LINE_H / 2 + RADIUS);
  const rightOfCentre = at(x + CELL_W / 2 + RADIUS);
  const leftOfCentre = at(x + CELL_W / 2 - RADIUS);

  switch (char) {
    case "─":
      return `M${left} ${cy}H${right}`;
    case "│":
      return `M${cx} ${top}V${bottom}`;
    case "╭":
      return `M${cx} ${bottom}V${below}Q${cx} ${cy} ${rightOfCentre} ${cy}H${right}`;
    case "╮":
      return `M${cx} ${bottom}V${below}Q${cx} ${cy} ${leftOfCentre} ${cy}H${left}`;
    case "╰":
      return `M${cx} ${top}V${above}Q${cx} ${cy} ${rightOfCentre} ${cy}H${right}`;
    case "╯":
      return `M${cx} ${top}V${above}Q${cx} ${cy} ${leftOfCentre} ${cy}H${left}`;
    default:
      return undefined;
  }
}

/**
 * Painted shapes of one colour, gathered into one path each.
 *
 * One path rather than one per cell, and that is not only for the file size:
 * two rectangles that share an edge are antialiased separately and leave a
 * hairline of background between them, while two subpaths of the same path are
 * filled as the single region they add up to. The logo is nothing but shapes
 * sharing edges.
 */
type Ink = { readonly fill: string; readonly opacity: string };

const inkKey = ({ fill, opacity }: Ink): string => `${fill} ${opacity}`;

type Style = {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  inverse: boolean;
};

const blank = (): Style => ({ bold: false, dim: false, inverse: false });

/** One run of characters that share every attribute, and where it starts. */
type Run = {
  readonly column: number;
  readonly text: string;
  readonly style: Style;
};

/** The 256-colour cube, for the rare escape that reaches for it. */
function indexed(index: number): string {
  if (index < 16) return PALETTE[index] ?? DEFAULT_FG;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;

    return `rgb(${level},${level},${level})`;
  }

  const step = [0, 95, 135, 175, 215, 255];
  const n = index - 16;

  return `rgb(${step[Math.floor(n / 36) % 6]},${step[Math.floor(n / 6) % 6]},${step[n % 6]})`;
}

function extended(codes: readonly number[], at: number): { value?: string; next: number } {
  const kind = codes[at + 1];
  if (kind === 5) return { value: indexed(codes[at + 2] ?? 0), next: at + 3 };
  if (kind === 2) {
    const [r, g, b] = [codes[at + 2] ?? 0, codes[at + 3] ?? 0, codes[at + 4] ?? 0];

    return { value: `rgb(${r},${g},${b})`, next: at + 5 };
  }

  return { value: undefined, next: at + 1 };
}

function apply(style: Style, codes: readonly number[]): Style {
  const next = { ...style };

  for (let at = 0; at < codes.length; at++) {
    const code = codes[at] ?? 0;
    if (code === 0) Object.assign(next, blank());
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 27) next.inverse = false;
    else if (code === 39) next.fg = undefined;
    else if (code === 49) next.bg = undefined;
    else if (code >= 30 && code <= 37) next.fg = PALETTE[code - 30];
    else if (code >= 90 && code <= 97) next.fg = PALETTE[code - 90 + 8];
    else if (code >= 40 && code <= 47) next.bg = PALETTE[code - 40];
    else if (code >= 100 && code <= 107) next.bg = PALETTE[code - 100 + 8];
    else if (code === 38 || code === 48) {
      const { value, next: after } = extended(codes, at);
      if (code === 38) next.fg = value;
      else next.bg = value;
      at = after - 1;
    }
  }

  return next;
}

/** A frame split into lines of styled runs. */
function parse(frame: string): Run[][] {
  const lines: Run[][] = [];
  let style = blank();

  for (const raw of frame.replace(/\r/g, "").split("\n")) {
    const runs: Run[] = [];
    let column = 0;
    let at = 0;
    SGR.lastIndex = 0;

    for (let match = SGR.exec(raw); ; match = SGR.exec(raw)) {
      const upto = match ? match.index : raw.length;
      const text = raw.slice(at, upto).replace(OTHER, "");
      if (text) {
        runs.push({ column, text, style });
        column += width(text);
      }

      if (!match) break;

      style = apply(
        style,
        (match[1] ?? "").split(";").map((code) => Number(code) || 0),
      );
      at = SGR.lastIndex;
    }

    lines.push(runs);
  }

  return lines;
}

const escapeText = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type ShotOptions = {
  /** Columns the frame was drawn at — the picture's grid. */
  readonly columns: number;
  /** What the window's title bar says. */
  readonly title?: string;
};

/**
 * The frame as an SVG terminal window.
 *
 * Every run is placed at its own column and given an explicit `textLength`, so
 * the grid holds whatever monospace font the reader's machine falls back to —
 * a picture whose columns drift is a picture of nothing.
 */
export function toSvg(frame: string, { columns, title = "grove" }: ShotOptions): string {
  const lines = parse(frame);
  const w = Math.round(PAD_X * 2 + columns * CELL_W);
  const h = Math.round(TITLE_H + PAD_Y * 2 + lines.length * LINE_H);

  const rects: string[] = [];
  const texts: string[] = [];
  // Keyed by colour so that everything one ink paints is one path — see `Ink`.
  const filled = new Map<string, { ink: Ink; d: string[] }>();
  const stroked = new Map<string, { ink: Ink; d: string[] }>();

  const paint = (into: Map<string, { ink: Ink; d: string[] }>, ink: Ink, d: string) => {
    const open = into.get(inkKey(ink)) ?? { ink, d: [] };
    open.d.push(d);
    into.set(inkKey(ink), open);
  };

  lines.forEach((runs, row) => {
    const y = TITLE_H + PAD_Y + row * LINE_H;

    for (const { column, text, style } of runs) {
      const fg = style.inverse ? (style.bg ?? SCREEN) : (style.fg ?? DEFAULT_FG);
      const bg = style.inverse ? (style.fg ?? DEFAULT_FG) : style.bg;
      const x = PAD_X + column * CELL_W;

      if (bg !== undefined) {
        rects.push(
          `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(width(text) * CELL_W).toFixed(1)}" height="${LINE_H}" fill="${bg}"/>`,
        );
      }

      if (text.trim() === "") continue;

      const ink: Ink = { fill: fg, opacity: style.dim ? "0.6" : "1" };
      const weight = style.bold ? ' font-weight="600"' : "";
      const opacity = style.dim ? ' opacity="0.6"' : "";

      /**
       * The run, split where it stops being text.
       *
       * Letters keep their `<text>` and their `textLength`, which is what
       * holds the grid together under whatever font the reader falls back to.
       * Blocks and rules become geometry, because a font cannot make them meet
       * — see `BLOCKS` above. Both halves count cells the same way, so the two
       * kinds land in the same columns.
       */
      const chars = [...text];
      let cell = 0;
      let buffer = "";
      let bufferAt = 0;

      const flush = () => {
        if (buffer.trim() !== "") {
          texts.push(
            `<text x="${(x + bufferAt * CELL_W).toFixed(1)}" y="${(y + BASELINE).toFixed(1)}" fill="${fg}"${weight}${opacity}` +
              ` textLength="${(width(buffer) * CELL_W).toFixed(1)}" lengthAdjust="spacingAndGlyphs"` +
              ` xml:space="preserve">${escapeText(buffer)}</text>`,
          );
        }
        buffer = "";
      };

      for (let at = 0; at < chars.length; at += 1) {
        const char = chars[at] ?? "";
        const fills = BLOCKS[char];
        // How many of this same character sit here in a row, and how many
        // cells one shape covers. Only `─` is stretched: a divider is a
        // hundred of them and wants to be one segment rather than a hundred.
        // Everything else gets a copy per cell — a stretched `│` would be one
        // line where two were asked for.
        let span = 1;
        while (chars[at + span] === char) span += 1;
        const stretch = char === "─" ? span : 1;

        if (fills !== undefined) {
          flush();
          for (let copy = 0; copy < span; copy += 1) {
            for (const [fx, fy, fw, fh] of fills) {
              const left = x + (cell + copy + fx) * CELL_W;
              const top = y + fy * LINE_H;
              paint(
                filled,
                ink,
                `M${left.toFixed(2)} ${top.toFixed(2)}h${(fw * CELL_W).toFixed(2)}v${(fh * LINE_H).toFixed(2)}h${(-fw * CELL_W).toFixed(2)}z`,
              );
            }
          }
          cell += span;
          at += span - 1;
          continue;
        }

        // Built before anything is committed, so that "is this a rule" and
        // "where do its segments go" are the same question asked once.
        const rules: string[] = [];
        for (let copy = 0; copy < span; copy += stretch) {
          const line = boxPath(char, x + (cell + copy) * CELL_W, y, stretch);
          if (line === undefined) break;
          rules.push(line);
        }

        if (rules.length > 0) {
          flush();
          for (const rule of rules) paint(stroked, ink, rule);
          cell += span;
          at += span - 1;
          continue;
        }

        if (buffer === "") bufferAt = cell;
        buffer += char;
        cell += width(char);
      }

      flush();
    }
  });

  const paths = [
    ...[...filled.values()].map(
      ({ ink, d }) => `<path fill="${ink.fill}" opacity="${ink.opacity}" d="${d.join("")}"/>`,
    ),
    ...[...stroked.values()].map(
      ({ ink, d }) =>
        `<path fill="none" stroke="${ink.fill}" stroke-width="${STROKE}" opacity="${ink.opacity}" d="${d.join("")}"/>`,
    ),
  ];

  const lights = ["#ff5f57", "#febc2e", "#28c840"]
    .map(
      (fill, index) =>
        `<circle cx="${20 + index * 17}" cy="${TITLE_H / 2}" r="5.5" fill="${fill}"/>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="${FONT_SIZE}">
<rect width="${w}" height="${h}" rx="10" fill="${CHROME}" stroke="${BORDER}"/>
<rect x="1" y="${TITLE_H}" width="${w - 2}" height="${h - TITLE_H - 1}" fill="${SCREEN}"/>
${lights}
<text x="${w / 2}" y="${TITLE_H / 2 + 4}" fill="#8b8f98" font-size="12" text-anchor="middle">${escapeText(title)}</text>
${rects.join("\n")}
${paths.join("\n")}
${texts.join("\n")}
</svg>
`;
}
