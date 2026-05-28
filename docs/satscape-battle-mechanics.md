# SatScape Tactical Battle Mechanics

Monster encounters replace the normal map image with an 8x8 tactical arena.

## Turn Loop

1. The monster telegraphs its next intent.
2. The battle image paints incoming monster danger in red.
3. The player moves with the arrow buttons. Green tiles show reachable movement.
4. The player chooses a weapon from the weapon menu. Blue tiles preview that weapon's attack.
5. Pressing Attack resolves the monster telegraph, then the player's selected weapon.
6. If the monster reaches 0 HP, the world tile is cleared and loot pays out from the prize pool.

## Arena Colors

- Green: reachable movement tiles
- Red: incoming monster attack
- Blue: current weapon attack preview
- White/blue marker: player
- Monster sprite: monster's telegraphed destination

## Movement

Base battle movement is 1 tile per turn. Boots improve tactical movement, capped at 3 tiles:

- No boots or starter boots: 1 tile
- Mid-tier boots: 2 tiles
- High-tier boots: 3 tiles

The player moves one tile per arrow press until their movement for the turn is spent. Attack ends the turn and refreshes movement for the next telegraph.

## Weapons

The current shop weapons map to tactical attack shapes and can be selected during battle:

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
