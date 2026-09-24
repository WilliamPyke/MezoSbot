import type { PieceDefinition, PieceCell } from "./types.js";

const n = (x: number, y: number): PieceCell => ({ x, y, kind: "normal" });

function def(
  id: string,
  label: string,
  cells: PieceCell[],
  opts: { allowRotation?: boolean; weight?: number } = {}
): PieceDefinition {
  return {
    id,
    label,
    cells,
    allowRotation: opts.allowRotation ?? false,
    weight: opts.weight ?? 1,
  };
}

export const PIECE_LIBRARY: PieceDefinition[] = [
  // Singletons
  def("single", "•", [n(0, 0)], { weight: 4 }),

  // 2-length lines
  def("h2", "── 2", [n(0, 0), n(1, 0)], { allowRotation: true, weight: 5 }),
  def("v2", "│ 2", [n(0, 0), n(0, 1)], { allowRotation: true, weight: 5 }),

  // 3-length lines
  def("h3", "── 3", [n(0, 0), n(1, 0), n(2, 0)], { allowRotation: true, weight: 4 }),
  def("v3", "│ 3", [n(0, 0), n(0, 1), n(0, 2)], { allowRotation: true, weight: 4 }),

  // 4-length lines
  def("h4", "── 4", [n(0, 0), n(1, 0), n(2, 0), n(3, 0)], { allowRotation: true, weight: 3 }),
  def("v4", "│ 4", [n(0, 0), n(0, 1), n(0, 2), n(0, 3)], { allowRotation: true, weight: 3 }),

  // 5-length lines
  def("h5", "── 5", [n(0, 0), n(1, 0), n(2, 0), n(3, 0), n(4, 0)], { allowRotation: true, weight: 2 }),
  def("v5", "│ 5", [n(0, 0), n(0, 1), n(0, 2), n(0, 3), n(0, 4)], { allowRotation: true, weight: 2 }),

  // 2x2 square
  def("sq2", "■ 2x2", [n(0, 0), n(1, 0), n(0, 1), n(1, 1)], { weight: 4 }),

  // 3x3 square
  def("sq3", "■ 3x3", [
    n(0, 0), n(1, 0), n(2, 0),
    n(0, 1), n(1, 1), n(2, 1),
    n(0, 2), n(1, 2), n(2, 2),
  ], { weight: 1 }),

  // L shapes (3-cell)
  def("l_sm_a", "L 3", [n(0, 0), n(0, 1), n(1, 1)], { allowRotation: true, weight: 3 }),
  def("l_sm_b", "L 3 mirror", [n(1, 0), n(1, 1), n(0, 1)], { allowRotation: true, weight: 3 }),

  // L shape (5-cell)
  def("l_5", "L 5", [
    n(0, 0), n(0, 1), n(0, 2),
    n(1, 2), n(2, 2),
  ], { allowRotation: true, weight: 2 }),

  def("j_5", "J 5", [
    n(2, 0), n(2, 1), n(2, 2),
    n(0, 2), n(1, 2),
  ], { allowRotation: true, weight: 2 }),

  // T shape
  def("t_4", "T 4", [
    n(0, 0), n(1, 0), n(2, 0),
    n(1, 1),
  ], { allowRotation: true, weight: 3 }),

  // S / Z shapes
  def("s_4", "S 4", [
    n(1, 0), n(2, 0),
    n(0, 1), n(1, 1),
  ], { allowRotation: true, weight: 3 }),

  def("z_4", "Z 4", [
    n(0, 0), n(1, 0),
    n(1, 1), n(2, 1),
  ], { allowRotation: true, weight: 3 }),

  // Plus
  def("plus_5", "+ 5", [
    n(1, 0),
    n(0, 1), n(1, 1), n(2, 1),
    n(1, 2),
  ], { weight: 2 }),

  // U shape
  def("u_5", "U 5", [
    n(0, 0), n(2, 0),
    n(0, 1), n(1, 1), n(2, 1),
  ], { allowRotation: true, weight: 2 }),

  // Diagonals
  def("diag_2", "↘ 2", [n(0, 0), n(1, 1)], { weight: 2 }),
  def("diag_3", "↘ 3", [n(0, 0), n(1, 1), n(2, 2)], { weight: 2 }),
  def("anti_diag_2", "↙ 2", [n(1, 0), n(0, 1)], { weight: 2 }),
  def("anti_diag_3", "↙ 3", [n(2, 0), n(1, 1), n(0, 2)], { weight: 2 }),

  // Disconnected
  def("pair_gap_h", "• •", [n(0, 0), n(2, 0)], { weight: 2 }),
  def("pair_gap_v", "• \\n •", [n(0, 0), n(0, 2)], { weight: 2 }),
  def("triple_gap", "• • •", [n(0, 0), n(2, 0), n(4, 0)], { allowRotation: true, weight: 1 }),

  // Sparse corners (3x3 bounding box, 3 corner cells)
  def("sparse_corner_3", "corners 3", [n(0, 0), n(2, 0), n(0, 2)], { allowRotation: true, weight: 1 }),
  def("sparse_corner_4", "corners 4", [n(0, 0), n(2, 0), n(0, 2), n(2, 2)], { weight: 1 }),

  // Offset pair
  def("offset_pair", "offset 2", [n(0, 0), n(2, 1)], { allowRotation: true, weight: 1 }),

  // Knight-step
  def("knight", "knight", [n(0, 0), n(1, 2)], { allowRotation: true, weight: 1 }),

  // Big L (corner)
  def("big_corner_5", "⌐ 5", [
    n(0, 0), n(1, 0), n(2, 0),
    n(0, 1),
    n(0, 2),
  ], { allowRotation: true, weight: 2 }),

  // Stair
  def("stair_4", "stair 4", [
    n(0, 0),
    n(0, 1), n(1, 1),
    n(1, 2),
  ], { allowRotation: true, weight: 2 }),

  // Long diagonal stair
  def("stair_6", "stair 6", [
    n(0, 0), n(1, 0),
    n(1, 1), n(2, 1),
    n(2, 2), n(3, 2),
  ], { allowRotation: true, weight: 1 }),

  // 1x1 ghost (very common)
  def("single_b", "• alt", [n(0, 0)], { weight: 3 }),

  // Domino vertical alt
  def("h2_alt", "── 2 alt", [n(0, 0), n(1, 0)], { weight: 2 }),
];

export const PIECE_BY_ID: Record<string, PieceDefinition> = Object.fromEntries(
  PIECE_LIBRARY.map((p) => [p.id, p])
);
