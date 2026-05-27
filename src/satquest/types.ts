export type Biome = "town" | "jungle" | "desert" | "winter";
export type PlayerState = "idle" | "combat" | "fainted";
export type EntityType = "chest" | "monster" | "cleared";
export type Direction = "up" | "down" | "left" | "right";

export interface SatPlayerRow {
  discord_id: string;
  avatar_id: string;
  x_coord: number;
  y_coord: number;
  hunger: number;
  display_max_hp: number;
  state: PlayerState;
  active: boolean;
  last_move_at: string;
  created_at: string;
}

export interface WorldEntityRow {
  id: number;
  x: number;
  y: number;
  entity_type: EntityType;
  entity_data: Record<string, unknown>;
  created_at: string;
}

export interface CombatSessionRow {
  discord_id: string;
  monster_name: string;
  monster_max_hp: number;
  monster_current_hp: number;
  monster_attack: number;
  reward_sats: number;
  enemy_x: number;
  enemy_y: number;
  turn_number: number;
  created_at: string;
}

/** Everything needed to render one frame for a player. */
export interface ViewModel {
  player: SatPlayerRow;
  hp: number; // live balance_sats
  entities: WorldEntityRow[]; // active entities within the viewport
  combat: CombatSessionRow | null;
}
