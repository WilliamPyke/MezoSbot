# SatScape Tactical Battle Mechanics

Monster encounters replace the normal map image with an 8x8 tactical arena. Combat is
**plan-ahead**: you see the monster's next three telegraphed acts and queue your own three actions,
with a live preview of exactly what will happen before you commit.

## Turn Loop

1. The monster reveals its **next 3 acts** (①②③). Crucially, **only one of the three is an
   attack** — the monster advances toward you before it and rests (recovers) after it. That gives
   you two safe ticks every round to reposition and strike. The single attack is painted red and
   aims at fixed tiles (honest telegraph: it hits those tiles whether or not you're still on them).
2. You build a plan of up to **3 actions**. Each slot is a **Move** (one tile via the arrows), a
   **Strike** in one of your default attack modes, or a **Wait**. As you queue, the board updates
   live: your planned path is drawn as a dashed yellow trail and your strike tiles glow blue.
3. Press **Resolve**. The two queues run interleaved, tick by tick. On each tick **you act first**,
   then the monster executes that tick's act:
   - A Strike hits the monster if it stands on your attack mode's tiles at that moment.
   - The monster only deals damage on its single attack tick, and only if you're standing on the
     marked tiles when it lands — so a Move on that tick dodges it.
4. After resolving, your plan clears and the monster telegraphs a fresh set of 3.
5. If the monster reaches 0 HP, the world tile is cleared and loot pays out from the prize pool.

## Attack Modes

Every player has three default attack shapes, independent of the equipped weapon. Pick one per
queued strike (you can mix them across your three slots):

- **🗡️ Line** — 3 tiles straight toward the monster (reach; good for poking before it closes in)
- **🔨 Slam** — all 8 tiles around you (hits a monster adjacent in any direction; great panic button)
- **🪓 Cleave** — a 3-tile arc directly in front (covers a monster that's slightly off-axis)

The equipped **weapon only sets the damage number** per strike — shop progression (`power`) still
matters, but the shape is your choice each time.

## Arena Colors

- 🔴 red tiles + outline: the monster's one incoming attack this round
- 🔵 blue tiles + outline: your queued strike(s) — where your blades will land
- 🟡 dashed yellow line + dots: your planned movement path; the solid marker is where you end up
- faded white dot: where you're standing now (when your plan moves you elsewhere)
- Numbered badges (①②③) on the monster: red = its attack tick, slate = advancing, dim = resting

## Movement

Movement is queued, not spent tile-by-tile. Each arrow press appends a one-tile step to your plan
(up to the 3-slot cap), and Undo pops the last queued action. Steps that would leave the arena or
land on the monster's tile are rejected. The 3-slot plan is the whole movement budget — dodging the
attack costs a slot you could have spent striking.

## Monster Intents

Monsters choose deterministic patterns from their type, level, world tile, and turn number, and the
three telegraphed acts are forward-simulated (the monster's position after act k is where act k+1
begins). The lone attack uses one of:

- Line Strike: move, then attack a full row or column
- Raking Cone: move, then hit a cone
- Ground Slam: hold position, then hit adjacent tiles
- Dash Bite: move up to 2 tiles, then lunge forward

The other two acts are an **Advance** (close distance toward you) and a **Rest** (recover, no
attack). Monster hits remove sats through the existing closed-loop economy and send them to the
prize pool.

## Economy And Quests

Victory still clears the monster tile, pays loot from the prize pool, and advances combat quests.
Fleeing still costs the normal flee fee and leaves the monster tile uncleared.
