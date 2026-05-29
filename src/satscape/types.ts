export type PlayerState = "idle" | "combat" | "fainted";
export type Direction = "up" | "down" | "left" | "right";

export interface SatPlayerRow {
  discord_id: string;
  avatar_id: string;
  x_coord: number;
  y_coord: number;
  hunger: number; // displayed as "Stamina"
  display_max_hp: number; // legacy high-water mark — superseded by hp/max_hp, no longer written
  hp: number | null; // current HP: the at-risk slice of balance. NULL = derive min(balance, max_hp)
  max_hp: number; // HP-bar cap (default SAT.HP_MAX_DEFAULT; items may raise it)
  state: PlayerState;
  active: boolean;
  equipped_weapon: string | null;
  equipped_armor: string | null;
  equipped_accessory: string | null;
  equipped_boots: string | null;
  steps_per_move: number;
  last_move_at: string;
  created_at: string;
}

export interface CombatSessionRow {
  discord_id: string;
  monster_name: string;
  monster_level: number;
  monster_max_hp: number;
  monster_current_hp: number;
  monster_attack: number;
  reward_sats: number;
  enemy_x: number;
  enemy_y: number;
  player_battle_x: number;
  player_battle_y: number;
  monster_battle_x: number;
  monster_battle_y: number;
  battle_move_points: number;
  /** Comma-joined queued plan tokens: up|down|left|right|card-<id>|wait. Null/"" = empty. */
  battle_plan: string | null;
  selected_battle_weapon: string | null;
  /** JSON array of StatusEffect on the player (bleed/poison/stun etc). Null = none. */
  player_status: string | null;
  /** JSON array of StatusEffect on the monster. Null = none. */
  monster_status: string | null;
  turn_number: number;
  created_at: string;
}

/** A computed (non-persisted) entity sitting on a tile. */
export interface TileEntity {
  x: number;
  y: number;
  type: "chest" | "monster";
  data: Record<string, unknown>;
}

/** Another player visible within the viewport. */
export interface OtherPlayer {
  name: string;
  x: number;
  y: number;
  state: PlayerState;
}

/** Everything needed to render one frame for a player. */
export interface ViewModel {
  player: SatPlayerRow;
  hp: number; // current HP — the at-risk slice of balance (0..maxHp)
  maxHp: number; // HP-bar cap
  balance: number; // real withdrawable sats balance (HP + banked)
  entities: TileEntity[]; // active (non-cleared) entities within the viewport
  others: OtherPlayer[]; // other adventurers within the viewport
  combat: CombatSessionRow | null;
  ownedItemIds: string[]; // inventory ids used for combat weapon menus
  explored: Set<string>; // shared revealed tiles ("x,y") within the viewport (fog of war)
}
