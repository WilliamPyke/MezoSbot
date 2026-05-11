import { supabase, type QuestRow, type QuestTaskRow, type QuestRewardTierRow } from "../db.js";
import { roundSats } from "../format.js";

export type QuestTaskType =
  | "event_attendance"
  | "first_link_in_channel"
  | "onchain_vote"
  | "manual";

export type QuestDefinitionInput = {
  guildId: string;
  channelId: string;
  creatorId: string;
  title: string;
  description?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  metadata?: Record<string, unknown>;
  tasks: Array<{
    taskKey: string;
    type: QuestTaskType;
    title: string;
    description?: string | null;
    config?: Record<string, unknown>;
    sortOrder?: number;
  }>;
  rewardTiers: Array<{
    completedTaskCount: number;
    rewardSats: number;
  }>;
};

export type QuestCompletionResult = {
  ok: boolean;
  reason?: string;
  insertedCompletion?: boolean;
  completedTaskCount?: number;
  tierRewardSats?: number;
  previousPaidSats?: number;
  rewardDeltaSats?: number;
  totalPaidSats?: number;
};

export type QuestSnapshot = {
  quest: Pick<QuestRow, "id" | "title" | "description" | "status" | "max_reward_sats" | "starts_at" | "ends_at" | "metadata">;
  tasks: Array<Pick<QuestTaskRow, "id" | "task_key" | "type" | "title" | "description" | "config" | "sort_order" | "status">>;
  tiers: Array<Pick<QuestRewardTierRow, "completed_task_count" | "reward_sats">>;
};

export type QuestTaskDefinition = {
  type: QuestTaskType;
  label: string;
  validateConfig(config: Record<string, unknown>): string | null;
  renderRequirement(config: Record<string, unknown>): string;
};

const taskRegistry = new Map<QuestTaskType, QuestTaskDefinition>();

export function registerQuestTask(definition: QuestTaskDefinition): void {
  taskRegistry.set(definition.type, definition);
}

export function getQuestTaskDefinition(type: string): QuestTaskDefinition | null {
  return taskRegistry.get(type as QuestTaskType) ?? null;
}

export function listQuestTaskDefinitions(): QuestTaskDefinition[] {
  return [...taskRegistry.values()];
}

function assertValidTierConfig(tiers: QuestDefinitionInput["rewardTiers"], taskCount: number): void {
  if (tiers.length === 0) throw new Error("At least one reward tier is required");

  const seen = new Set<number>();
  let previousReward = -Infinity;

  for (const tier of tiers.sort((a, b) => a.completedTaskCount - b.completedTaskCount)) {
    if (!Number.isInteger(tier.completedTaskCount) || tier.completedTaskCount < 1) {
      throw new Error("Reward tiers must start at one or more completed tasks");
    }
    if (tier.completedTaskCount > taskCount) {
      throw new Error("Reward tier completed task count cannot exceed task count");
    }
    if (seen.has(tier.completedTaskCount)) {
      throw new Error("Duplicate reward tier task count");
    }
    seen.add(tier.completedTaskCount);

    const reward = roundSats(tier.rewardSats);
    if (reward <= 0) throw new Error("Reward tier sats must be greater than zero");
    if (reward < previousReward) throw new Error("Reward tiers must be non-decreasing");
    previousReward = reward;
  }
}

function validateQuestDefinition(input: QuestDefinitionInput): void {
  if (input.tasks.length === 0) throw new Error("At least one task is required");

  const taskKeys = new Set<string>();
  for (const task of input.tasks) {
    if (!task.taskKey || !/^[a-z0-9_-]{1,64}$/i.test(task.taskKey)) {
      throw new Error(`Invalid task key: ${task.taskKey}`);
    }
    if (taskKeys.has(task.taskKey)) throw new Error(`Duplicate task key: ${task.taskKey}`);
    taskKeys.add(task.taskKey);

    const definition = getQuestTaskDefinition(task.type);
    if (!definition) throw new Error(`Unsupported quest task type: ${task.type}`);
    const configError = definition.validateConfig(task.config ?? {});
    if (configError) throw new Error(`${task.taskKey}: ${configError}`);
  }

  assertValidTierConfig(input.rewardTiers, input.tasks.length);
}

export async function createQuestDefinition(input: QuestDefinitionInput): Promise<QuestSnapshot> {
  validateQuestDefinition(input);

  const maxReward = Math.max(...input.rewardTiers.map((tier) => roundSats(tier.rewardSats)));
  const { data: quest, error: questError } = await supabase
    .from("quests")
    .insert({
      guild_id: input.guildId,
      channel_id: input.channelId,
      creator_id: input.creatorId,
      title: input.title,
      description: input.description ?? null,
      max_reward_sats: maxReward,
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      metadata: input.metadata ?? {},
    })
    .select("id, title, description, status, max_reward_sats, starts_at, ends_at, metadata")
    .single();

  if (questError || !quest) throw questError ?? new Error("Quest insert failed");
  const questId = (quest as { id: number }).id;

  const taskRows = input.tasks.map((task, index) => ({
    quest_id: questId,
    task_key: task.taskKey,
    type: task.type,
    title: task.title,
    description: task.description ?? null,
    config: task.config ?? {},
    sort_order: task.sortOrder ?? index,
  }));

  const tierRows = input.rewardTiers.map((tier) => ({
    quest_id: questId,
    completed_task_count: tier.completedTaskCount,
    reward_sats: roundSats(tier.rewardSats),
  }));

  const [{ data: tasks, error: tasksError }, { data: tiers, error: tiersError }] = await Promise.all([
    supabase
      .from("quest_tasks")
      .insert(taskRows)
      .select("id, task_key, type, title, description, config, sort_order, status")
      .order("sort_order", { ascending: true }),
    supabase
      .from("quest_reward_tiers")
      .insert(tierRows)
      .select("completed_task_count, reward_sats")
      .order("completed_task_count", { ascending: true }),
  ]);

  if (tasksError) throw tasksError;
  if (tiersError) throw tiersError;

  return {
    quest: quest as QuestSnapshot["quest"],
    tasks: (tasks ?? []) as QuestSnapshot["tasks"],
    tiers: (tiers ?? []) as QuestSnapshot["tiers"],
  };
}

export async function getQuestSnapshot(questId: number): Promise<QuestSnapshot | null> {
  const { data, error } = await supabase
    .from("quests")
    .select(`
      id,
      title,
      description,
      status,
      max_reward_sats,
      starts_at,
      ends_at,
      metadata,
      quest_tasks (
        id,
        task_key,
        type,
        title,
        description,
        config,
        sort_order,
        status
      ),
      quest_reward_tiers (
        completed_task_count,
        reward_sats
      )
    `)
    .eq("id", questId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as unknown as QuestSnapshot["quest"] & {
    quest_tasks?: QuestSnapshot["tasks"];
    quest_reward_tiers?: QuestSnapshot["tiers"];
  };

  return {
    quest: {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      max_reward_sats: row.max_reward_sats,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      metadata: row.metadata,
    },
    tasks: [...(row.quest_tasks ?? [])].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
    tiers: [...(row.quest_reward_tiers ?? [])].sort((a, b) => a.completed_task_count - b.completed_task_count),
  };
}

export async function getActiveTasksByType<TConfig extends Record<string, unknown>>(
  guildId: string,
  type: QuestTaskType,
): Promise<Array<QuestTaskRow & { quest: Pick<QuestRow, "id" | "guild_id" | "creator_id" | "status" | "starts_at" | "ends_at">; config: TConfig }>> {
  const { data, error } = await supabase
    .from("quest_tasks")
    .select(`
      id,
      quest_id,
      task_key,
      type,
      title,
      description,
      config,
      sort_order,
      status,
      created_at,
      quest:quests!inner (
        id,
        guild_id,
        creator_id,
        status,
        starts_at,
        ends_at
      )
    `)
    .eq("type", type)
    .eq("status", "active")
    .eq("quest.guild_id", guildId)
    .eq("quest.status", "active");

  if (error) throw error;
  return (data ?? []) as unknown as Array<QuestTaskRow & { quest: Pick<QuestRow, "id" | "guild_id" | "creator_id" | "status" | "starts_at" | "ends_at">; config: TConfig }>;
}

export async function completeQuestTask(params: {
  questId: number;
  taskId: number;
  userId: string;
  proof?: Record<string, unknown>;
}): Promise<QuestCompletionResult> {
  const { data, error } = await supabase.rpc("complete_quest_task_and_pay_delta", {
    p_quest_id: params.questId,
    p_task_id: params.taskId,
    p_user_id: params.userId,
    p_proof: params.proof ?? {},
  });

  if (error) throw error;
  return data as QuestCompletionResult;
}

registerQuestTask({
  type: "event_attendance",
  label: "Event attendance",
  validateConfig(config) {
    if (typeof config.eventChannelId !== "string") return "eventChannelId is required";
    if (typeof config.minMinutes !== "number" || config.minMinutes < 1) return "minMinutes must be at least 1";
    return null;
  },
  renderRequirement(config) {
    return `Stay in <#${config.eventChannelId}> for ${config.minMinutes} minute${config.minMinutes === 1 ? "" : "s"}`;
  },
});

registerQuestTask({
  type: "first_link_in_channel",
  label: "First link in channel",
  validateConfig(config) {
    if (typeof config.targetChannelId !== "string") return "targetChannelId is required";
    if (typeof config.source !== "string") return "source is required";
    if (typeof config.refreshMinutes !== "number" || config.refreshMinutes < 1) return "refreshMinutes must be at least 1";
    return null;
  },
  renderRequirement(config) {
    return `Be first every ${config.refreshMinutes} min to post ${config.source} in <#${config.targetChannelId}>`;
  },
});

registerQuestTask({
  type: "onchain_vote",
  label: "On-chain vote",
  validateConfig(config) {
    if (typeof config.chainId !== "number") return "chainId is required";
    if (typeof config.proposalId !== "string") return "proposalId is required";
    return null;
  },
  renderRequirement(config) {
    return `Vote on proposal ${config.proposalId}`;
  },
});

registerQuestTask({
  type: "manual",
  label: "Manual completion",
  validateConfig() {
    return null;
  },
  renderRequirement(config) {
    return typeof config.label === "string" ? config.label : "Manual completion";
  },
});
