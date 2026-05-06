/**
 * Per-player UI selection state — what piece they've picked, current rotation,
 * and chosen row/col. This is ephemeral, in-memory, and exists only to drive
 * the playfield UI between button clicks.
 */
export type Selection = {
  pieceIndex?: number;
  rotation: 0 | 1 | 2 | 3;
  row?: number;
  col?: number;
};

const selections = new Map<string, Selection>();

function key(matchId: number, userId: string): string {
  return `${matchId}:${userId}`;
}

export function getSelection(matchId: number, userId: string): Selection {
  const k = key(matchId, userId);
  let sel = selections.get(k);
  if (!sel) {
    sel = { rotation: 0 };
    selections.set(k, sel);
  }
  return sel;
}

export function setSelection(matchId: number, userId: string, partial: Partial<Selection>): Selection {
  const sel = getSelection(matchId, userId);
  Object.assign(sel, partial);
  return sel;
}

export function resetSelection(matchId: number, userId: string): Selection {
  const fresh: Selection = { rotation: 0 };
  selections.set(key(matchId, userId), fresh);
  return fresh;
}

export function clearSelection(matchId: number, userId: string): void {
  selections.delete(key(matchId, userId));
}
