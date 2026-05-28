# SatScape Tactical Battle Mechanics

Monster encounters now open an 8x8 tactical arena inside the Discord embed.

## Turn Loop

1. The monster telegraphs its next intent.
2. The embed marks incoming hit tiles with `!`.
3. The player chooses one legal destination from the move menu.
4. The monster moves and attacks the telegraphed pattern.
5. The player attacks toward the monster with their equipped weapon.
6. If the monster reaches 0 HP, the world tile is cleared and loot pays out from the prize pool.

## Arena Symbols

```txt
P = player
M = monster after its telegraphed move
! = incoming monster attack
o = legal player destination
. = empty tile
```

Columns are labeled `A-H`; rows are labeled `1-8`, so destinations look like `D6`.

## Movement

Base battle movement is 1 tile per turn. Boots improve tactical movement, capped at 3 tiles:

- No boots or starter boots: 1 tile
- Mid-tier boots: 2 tiles
- High-tier boots: 3 tiles

The player selects a destination within Manhattan distance of their current tile. The menu labels whether that destination dodges the telegraph and whether the equipped weapon can hit from there.

## Weapons

The current shop weapons map to tactical attack shapes:

- No weapon: Training Dagger, 1 tile toward the monster
- Iron Shortsword: Longsword, 2 tiles in a line
- Tiger Talwar: Spear, 3 tiles in a line
- Scorpion Khopesh: Hammer, 2x2 impact
- Frostfang Axe: Arc cleave, 3 front tiles
- Maharaja Blade: Star burst, diagonal burst plus reach

Damage scales from the weapon's existing `power`, so old shop progression still matters.

## Monster Intents

Monsters choose deterministic patterns from their type, level, world tile, and turn number. Common patterns are:

- Line Strike: move, then attack a full row or column
- Raking Cone: move, then hit a cone
- Ground Slam: hold position, then hit adjacent tiles
- Dash Bite: move up to 2 tiles, then lunge forward

Monster hits remove sats through the existing closed-loop economy and send them to the prize pool.

## Economy And Quests

Victory still clears the monster tile, pays loot from the prize pool, and advances combat quests. Fleeing still costs the normal flee fee and leaves the monster tile uncleared.
