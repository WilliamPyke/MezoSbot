# SatScape Tactical Battle Mechanics

Monster encounters replace the normal map image with an 8x8 tactical arena. Combat is
**plan-ahead**: you see the monster's next three attacks and queue your own three actions to
defeat it or dodge it.

## Turn Loop

1. The monster reveals its **next 3 strikes** as fixed tile-telegraphs (①②③), computed
   deterministically and painted on the board. They aim at your round-start position and **will**
   hit those tiles regardless of where you move — so the forecast is always honest.
2. You build a plan of up to **3 actions**. Each slot is a **Move** (one tile via the arrows), a
   **Strike** (your selected weapon), or a **Wait**. Queueing only updates the embed text/buttons —
   the board image stays put until you resolve.
3. Press **Resolve**. The two queues run interleaved, tick by tick. On each tick **you act first**,
   then the monster executes that tick's telegraphed strike:
   - A Strike hits the monster if it stands on your weapon's pattern tiles at that moment.
   - The monster's strike hits you only if you're standing on its marked tiles when it lands —
     so a Move on the same tick can dodge it, but that's a slot you didn't spend attacking.
4. After resolving, your plan clears and the monster telegraphs a fresh set of 3.
5. If the monster reaches 0 HP, the world tile is cleared and loot pays out from the prize pool.

The tension: dodging a telegraphed tile costs a slot you could have used to strike. Position well
and you can land multiple hits; play greedy and you eat the telegraph.

## Arena Colors

- 🔴 ① imminent strike (lands first), 🟠 ② next, 🟡 ③ later — fill fades with distance in the sequence
- Numbered badges (①②③) trace where the monster moves before each strike
- White/blue marker: you, at your round-start tile
- Monster sprite: the monster's current tile

## Movement

Movement is queued, not spent tile-by-tile. Each arrow press appends a one-tile step to your plan
(up to the 3-slot cap), and Undo pops the last queued action. Steps that would leave the arena or
land on the monster's tile are rejected. Boots no longer change movement range inside battle — the
3-slot plan is the budget.

## Weapons

The current shop weapons map to tactical attack shapes and can be selected during battle:

- No weapon: Training Dagger, 1 tile toward the monster
- Iron Shortsword: Longsword, 2 tiles in a line
- Tiger Talwar: Spear, 3 tiles in a line
- Scorpion Khopesh: Hammer, 2x2 impact
- Frostfang Axe: Arc cleave, 3 front tiles
- Maharaja Blade: Star burst, diagonal burst plus reach

A Strike uses your selected weapon's pattern, oriented toward the monster from wherever you stand
at that tick. Damage scales from the weapon's existing `power`, so old shop progression still
matters.

## Monster Intents

Monsters choose deterministic patterns from their type, level, world tile, turn number, and strike
index. The three telegraphed strikes are forward-simulated: the monster's position after strike k
is where strike k+1 begins. Common patterns are:

- Line Strike: move, then attack a full row or column
- Raking Cone: move, then hit a cone
- Ground Slam: hold position, then hit adjacent tiles
- Dash Bite: move up to 2 tiles, then lunge forward

Monster hits remove sats through the existing closed-loop economy and send them to the prize pool.

## Economy And Quests

Victory still clears the monster tile, pays loot from the prize pool, and advances combat quests.
Fleeing still costs the normal flee fee and leaves the monster tile uncleared.
