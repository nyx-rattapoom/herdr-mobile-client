import { memo, useMemo, useState } from 'react';
import { PixelRatio, Text, View, type TextStyle, type ViewStyle } from 'react-native';

import type { Style } from '../live/ansi';
import { cellColors, type GridItem, type GridLine } from '../live/grid';

export const TERM_FG = '#e5e7eb';
export const TERM_BG = '#000';
const FONT = 'monospace';

/** Cell size in dp. `w` is measured from the font; `h` is the fixed row height. */
export type CellMetrics = {
  fontSize: number;
  w: number;
  h: number;
  line: number;
};

export function cellMetrics(fontSize: number, w = fontSize * 0.6): CellMetrics {
  return {
    fontSize,
    w,
    h: PixelRatio.roundToNearestPixel(fontSize * (4 / 3)),
    line: PixelRatio.roundToNearestPixel(Math.max(1, fontSize / 12)),
  };
}

const PROBE = 'M'.repeat(40);

/** Measures the monospace advance width once, from the laid-out width of a probe string. */
export function useCellMetrics(fontSize: number): {
  metrics: CellMetrics;
  probe: React.ReactNode;
} {
  const [w, setW] = useState<number | null>(null);
  const probe =
    w === null ? (
      <Text
        style={{ position: 'absolute', opacity: 0, fontFamily: FONT, fontSize }}
        numberOfLines={1}
        onTextLayout={(e) => {
          const lw = e.nativeEvent.lines[0]?.width;
          if (lw) setW(lw / PROBE.length);
        }}
      >
        {PROBE}
      </Text>
    ) : null;
  // One object per size: TermRow is memoized on it, and a list redraws every row when it changes.
  const metrics = useMemo(() => cellMetrics(fontSize, w ?? undefined), [fontSize, w]);
  return { metrics, probe };
}

function textStyle(s: Style, m: CellMetrics): TextStyle {
  const { fg } = cellColors(s, TERM_FG, TERM_BG);
  return {
    position: 'absolute',
    top: 0,
    height: m.h,
    fontFamily: FONT,
    fontSize: m.fontSize,
    lineHeight: m.h,
    includeFontPadding: false,
    textAlignVertical: 'center',
    color: fg,
    fontWeight: s.bold ? '700' : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecorationLine: s.underline ? 'underline' : undefined,
    opacity: s.dim ? 0.6 : undefined,
  };
}

const rect = (
  left: number,
  top: number,
  width: number,
  height: number,
  color: string,
  opacity?: number,
): ViewStyle => ({
  position: 'absolute',
  left,
  top,
  width,
  height,
  backgroundColor: color,
  opacity,
});

function renderItem(it: GridItem, m: CellMetrics, key: number): React.ReactNode {
  const x = it.col * m.w;
  const fg = cellColors(it.style, TERM_FG, TERM_BG).fg;
  const dim = it.style.dim ? 0.6 : undefined;
  switch (it.kind) {
    case 'text':
      // Slack of one cell so rounding never wraps or ellipsizes the run; the next item covers it.
      return (
        <Text
          key={key}
          numberOfLines={1}
          ellipsizeMode="clip"
          style={[textStyle(it.style, m), { left: x, width: (it.cells + 1) * m.w }]}
        >
          {it.text}
        </Text>
      );
    case 'glyph':
      // Centred on its cell(s); a fallback-font glyph wider than the cell may overflow, as in terminals.
      return (
        <Text
          key={key}
          numberOfLines={1}
          ellipsizeMode="clip"
          style={[textStyle(it.style, m), { left: x - m.w, width: (it.cells + 2) * m.w, textAlign: 'center' }]}
        >
          {it.text}
        </Text>
      );
    case 'rects':
      return it.rects.map((r, i) => (
        <View key={`${key}.${i}`} style={rect(x + r.x * m.w, r.y * m.h, r.w * m.w, r.h * m.h, fg, r.opacity ?? dim)} />
      ));
    case 'box': {
      const [up, right, down, left] = it.arms.map((a) => a * m.line);
      const cx = x + m.w / 2;
      const cy = m.h / 2;
      const out: React.ReactNode[] = [];
      if (it.cells > 1) {
        // A merged run of horizontal lines.
        out.push(<View key={`${key}h`} style={rect(x, cy - right / 2, it.cells * m.w, right, fg, dim)} />);
        return out;
      }
      const v = Math.max(left, right);
      const h = Math.max(up, down);
      if (up) out.push(<View key={`${key}u`} style={rect(cx - up / 2, 0, up, cy + v / 2, fg, dim)} />);
      if (down)
        out.push(<View key={`${key}d`} style={rect(cx - down / 2, cy - v / 2, down, m.h - cy + v / 2, fg, dim)} />);
      if (left) out.push(<View key={`${key}l`} style={rect(x, cy - left / 2, cx - x + h / 2, left, fg, dim)} />);
      if (right)
        out.push(
          <View key={`${key}r`} style={rect(cx - h / 2, cy - right / 2, x + m.w - cx + h / 2, right, fg, dim)} />,
        );
      return out;
    }
    case 'arc': {
      // A quarter of a rounded rectangle from the cell centre to the two edges it connects.
      const t = m.line;
      const cx = x + m.w / 2;
      const cy = m.h / 2;
      const toRight = it.arc === 'tl' || it.arc === 'bl';
      const toDown = it.arc === 'tl' || it.arc === 'tr';
      const left = toRight ? cx - t / 2 : x;
      const top = toDown ? cy - t / 2 : 0;
      const style: ViewStyle = {
        position: 'absolute',
        left,
        top,
        width: toRight ? x + m.w - left : cx + t / 2 - x,
        height: toDown ? m.h - top : cy + t / 2,
        borderColor: fg,
        opacity: dim,
        [toDown ? 'borderTopWidth' : 'borderBottomWidth']: t,
        [toRight ? 'borderLeftWidth' : 'borderRightWidth']: t,
        [`border${toDown ? 'Top' : 'Bottom'}${toRight ? 'Left' : 'Right'}Radius`]: Math.min(m.w, m.h) / 2,
      };
      return <View key={key} style={style} />;
    }
  }
}

/** One terminal row: full-cell backgrounds, then lines, blocks and text positioned by column. */
export const TermRow = memo(function TermRow({ g, m }: { g: GridLine; m: CellMetrics }) {
  return (
    <View style={{ height: m.h, width: g.cols * m.w }}>
      {g.bg.map((b, i) => (
        <View key={`bg${i}`} style={rect(b.col * m.w, 0, b.cells * m.w, m.h, b.color)} />
      ))}
      {g.items.map((it, i) => renderItem(it, m, i))}
    </View>
  );
});
