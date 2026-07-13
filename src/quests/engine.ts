import { supabase, type QuestRow, type QuestTaskRow, type QuestRewardTierRow } from "../db.js";
import { roundSats } from "../format.js";
import type { TokenSymbol } from "../tokens.js";

export type QuestTaskType =
  | "event_attendance"
  | "first_link_in_channel"
  | "onchain_vote"
  | "manual";

export type QuestDefinitionInput = {
  guildId: string;
  channelId: string;
  creatorId: string;
  token?: TokenSymbol;
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

export type QuestDraftInput = {
  guildId: string;
  channelId: string;
  creatorId: string;
  token?: TokenSymbol;
  title: string;
  description?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  metadata?: Record<string, unknown>;
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
  quest: Pick<QuestRow, "id" | "guild_id" | "channel_id" | "message_id" | "creator_id" | "title" | "description" | "status" | "token" | "max_reward_sats" | "starts_at" | "ends_at" | "metadata">;
  tasks: Array<Pick<QuestTaskRow, "id" | "task_key" | "type" | "title" | "description" | "config" | "sort_order" | "status">>;
  tiers: Array<Pick<QuestRewardTierRow, "completed_task_count" | "reward_sats">>;
};

export type ActiveQuestTask<TConfig extends Record<string, unknown> = Record<string, unknown>> =
  QuestTaskRow & {
    quest: Pick<QuestRow, "id" | "guild_id" | "channel_id" | "message_id" | "creator_id" | "title" | "description" | "status" | "token" | "max_reward_sats" | "starts_at" | "ends_at" | "metadata">;
    config: TConfig;
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
      token: input.token ?? "SATS",
      title: input.title,
      description: input.description ?? null,
      max_reward_sats: maxReward,
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      metadata: input.metadata ?? {},
    })
    .select("id, guild_id, channel_id, message_id, creator_id, title, description, status, token, max_reward_sats, starts_at, ends_at, metadata")
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
      guild_id,
      channel_id,
      message_id,
      creator_id,
      title,
      description,
      status,
      token,
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
      guild_id: row.guild_id,
      channel_id: row.channel_id,
      message_id: row.message_id,
      creator_id: row.creator_id,
      title: row.title,
      description: row.description,
      status: row.status,
      max_reward_sats: row.max_reward_sats,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      metadata: row.metadata,
      token: row.token,
    },
    tasks: [...(row.quest_tasks ?? [])].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
    tiers: [...(row.quest_reward_tiers ?? [])].sort((a, b) => a.completed_task_count - b.completed_task_count),
  };
}

export async function createQuestDraft(input: QuestDraftInput): Promise<QuestSnapshot> {
  assertValidTierConfig(input.rewardTiers, Math.max(...input.rewardTiers.map((tier) => tier.completedTaskCount)));

  const maxReward = Math.max(...input.rewardTiers.map((tier) => roundSats(tier.rewardSats)));
  const { data: quest, error: questError } = await supabase
    .from("quests")
    .insert({
      guild_id: input.guildId,
      channel_id: input.channelId,
      creator_id: input.creatorId,
      token: input.token ?? "SATS",
      title: input.title,
      description: input.description ?? null,
      status: "draft",
      max_reward_sats: maxReward,
      starts_at: input.startsAt ?? null,
      ends_at: input.endsAt ?? null,
      metadata: input.metadata ?? {},
    })
    .select("id, guild_id, channel_id, message_id, creator_id, title, description, status, token, max_reward_sats, starts_at, ends_at, metadata")
    .single();

  if (questError || !quest) throw questError ?? new Error("Quest draft insert failed");
  const questId = (quest as { id: number }).id;

  const tierRows = input.rewardTiers.map((tier) => ({
    quest_id: questId,
    completed_task_count: tier.completedTaskCount,
    reward_sats: roundSats(tier.rewardSats),
  }));

  const { data: tiers, error: tiersError } = await supabase
    .from("quest_reward_tiers")
    .insert(tierRows)
    .select("completed_task_count, reward_sats")
    .order("completed_task_count", { ascending: true });

  if (tiersError) throw tiersError;

  return {
    quest: quest as QuestSnapshot["quest"],
    tasks: [],
    tiers: (tiers ?? []) as QuestSnapshot["tiers"],
  };
}

export async function addQuestTask(input: {
  questId: number;
  creatorId: string;
  taskKey: string;
  type: QuestTaskType;
  title: string;
  description?: string | null;
  config?: Record<string, unknown>;
}): Promise<QuestSnapshot> {
  const definition = getQuestTaskDefinition(input.type);
  if (!definition) throw new Error(`Unsupported quest task type: ${input.type}`);

  const config = input.config ?? {};
  const configError = definition.validateConfig(config);
  if (configError) throw new Error(configError);

  const snapshot = await getQuestSnapshot(input.questId);
  if (!snapshot) throw new Error("Quest not found");
  if (snapshot.quest.creator_id !== input.creatorId) throw new Error("Only the quest creator can edit this quest");
  if (snapshot.quest.status !== "draft") throw new Error("Only draft quests can be edited");

  const sortOrder = snapshot.tasks.length;
  const { error } = await supabase
    .from("quest_tasks")
    .insert({
      quest_id: input.questId,
      task_key: input.taskKey,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      config,
      sort_order: sortOrder,
    });

  if (error) throw error;

  const updated = await getQuestSnapshot(input.questId);
  if (!updated) throw new Error("Quest not found after task insert");
  return updated;
}

export async function publishQuest(input: {
  questId: number;
  creatorId: string;
  messageId?: string | null;
}): Promise<QuestSnapshot> {
  const snapshot = await getQuestSnapshot(input.questId);
  if (!snapshot) throw new Error("Quest not found");
  if (snapshot.quest.creator_id !== input.creatorId) throw new Error("Only the quest creator can publish this quest");
  if (snapshot.quest.status !== "draft") throw new Error("Only draft quests can be published");
  if (snapshot.tasks.length === 0) throw new Error("Add at least one task before publishing");
  if (snapshot.tiers.length === 0) throw new Error("Add at least one reward tier before publishing");

  const maxTierCount = Math.max(...snapshot.tiers.map((tier) => tier.completed_task_count));
  if (maxTierCount > snapshot.tasks.length) {
    throw new Error("A reward tier requires more completed tasks than this quest has");
  }

  const { error } = await supabase
    .from("quests")
    .update({
      status: "active",
      message_id: input.messageId ?? snapshot.quest.message_id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.questId)
    .eq("creator_id", input.creatorId)
    .eq("status", "draft");

  if (error) throw error;

  const updated = await getQuestSnapshot(input.questId);
  if (!updated) throw new Error("Quest not found after publish");
  return updated;
}

export async function getActiveTasksByType<TConfig extends Record<string, unknown>>(
  guildId: string,
  type: QuestTaskType,
): Promise<Array<ActiveQuestTask<TConfig>>> {
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
        channel_id,
        message_id,
        creator_id,
        title,
        description,
        status,
        token,
        max_reward_sats,
        starts_at,
        ends_at,
        metadata
      )
    `)
    .eq("type", type)
    .eq("status", "active")
    .eq("quest.guild_id", guildId)
    .eq("quest.status", "active");

  if (error) throw error;
  return (data ?? []) as unknown as Array<ActiveQuestTask<TConfig>>;
}

export async function getAllActiveTasksByType<TConfig extends Record<string, unknown>>(
  type: QuestTaskType,
): Promise<Array<ActiveQuestTask<TConfig>>> {
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
        channel_id,
        message_id,
        creator_id,
        title,
        description,
        status,
        token,
        max_reward_sats,
        starts_at,
        ends_at,
        metadata
      )
    `)
    .eq("type", type)
    .eq("status", "active")
    .eq("quest.status", "active");

  if (error) throw error;
  return (data ?? []) as unknown as Array<ActiveQuestTask<TConfig>>;
}

export async function completeQuestTask(params: {
  questId: number;
  taskId: number;
  userId: string;
  proof?: Record<string, unknown>;
  rewardMultiplier?: number;
}): Promise<QuestCompletionResult> {
  const { data: quest } = await supabase.from("quests").select("token").eq("id", params.questId).maybeSingle();
  const token = (quest?.token ?? "SATS") as TokenSymbol;
  const { data, error } = await supabase.rpc(token === "SATS"
    ? "complete_quest_task_and_pay_delta"
    : "complete_quest_task_and_pay_delta_token", {
    p_quest_id: params.questId,
    p_task_id: params.taskId,
    p_user_id: params.userId,
    p_proof: params.proof ?? {},
    p_reward_multiplier: params.rewardMultiplier ?? 1,
  });

  if (error) throw error;
  return data as QuestCompletionResult;
}

export async function payRepeatableQuestTaskReward(params: {
  questId: number;
  taskId: number;
  userId: string;
  proof?: Record<string, unknown>;
  rewardMultiplier?: number;
}): Promise<QuestCompletionResult> {
  const { data: quest } = await supabase.from("quests").select("token").eq("id", params.questId).maybeSingle();
  const token = (quest?.token ?? "SATS") as TokenSymbol;
  const { data, error } = await supabase.rpc(token === "SATS"
    ? "pay_repeatable_quest_task_reward"
    : "pay_repeatable_quest_task_reward_token", {
    p_quest_id: params.questId,
    p_task_id: params.taskId,
    p_user_id: params.userId,
    p_proof: params.proof ?? {},
    p_reward_multiplier: params.rewardMultiplier ?? 1,
  });

  if (error) {
    const functionMissing = error.code === "PGRST202" || /pay_repeatable_quest_task_reward/i.test(error.message ?? "");
    if (!functionMissing) throw error;
    return payRepeatableQuestTaskRewardFallback(params);
  }
  return data as QuestCompletionResult;
}

async function payRepeatableQuestTaskRewardFallback(params: {
  questId: number;
  taskId: number;
  userId: string;
  proof?: Record<string, unknown>;
  rewardMultiplier?: number;
}): Promise<QuestCompletionResult> {
  const { data: quest, error: questError } = await supabase
    .from("quests")
    .select("id, creator_id, status, token, starts_at, ends_at")
    .eq("id", params.questId)
    .maybeSingle();
  if (questError) throw questError;
  if (!quest || quest.status !== "active") return { ok: false, reason: "quest_inactive" };

  const now = Date.now();
  if (quest.starts_at && now < Date.parse(quest.starts_at)) return { ok: false, reason: "quest_not_started" };
  if (quest.ends_at && now > Date.parse(quest.ends_at)) {
    await supabase
      .from("quests")
      .update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", params.questId);
    return { ok: false, reason: "quest_ended" };
  }

  const { data: task, error: taskError } = await supabase
    .from("quest_tasks")
    .select("id")
    .eq("id", params.taskId)
    .eq("quest_id", params.questId)
    .eq("status", "active")
    .maybeSingle();
  if (taskError) throw taskError;
  if (!task) return { ok: false, reason: "task_not_found" };

  const { data: tiers, error: tierError } = await supabase
    .from("quest_reward_tiers")
    .select("reward_sats")
    .eq("quest_id", params.questId)
    .lte("completed_task_count", 1);
  if (tierError) throw tierError;

  const rewardSats = Math.max(0, ...(tiers ?? []).map((tier) => roundSats(Number(tier.reward_sats))));
  const multiplier = params.rewardMultiplier === 2 ? 2 : 1;
  const payoutSats = roundSats(rewardSats * multiplier);
  if (payoutSats <= 0) return { ok: false, reason: "reward_not_configured" };

  const { data: rewardRow, error: rewardError } = await supabase
    .from("quest_user_rewards")
    .select("paid_sats")
    .eq("quest_id", params.questId)
    .eq("user_id", params.userId)
    .maybeSingle();
  if (rewardError) throw rewardError;

  const { data: repeatEvents, error: repeatError } = await supabase
    .from("quest_reward_events")
    .select("reward_delta_sats")
    .eq("quest_id", params.questId)
    .eq("user_id", params.userId)
    .eq("reason", "repeatable_task");
  if (repeatError) throw repeatError;

  const previousPaid = roundSats(
    Number(rewardRow?.paid_sats ?? 0) +
      (repeatEvents ?? []).reduce((sum, event) => sum + Number(event.reward_delta_sats ?? 0), 0),
  );

  await supabase.from("users").upsert([{ discord_id: quest.creator_id }, { discord_id: params.userId }], {
    onConflict: "discord_id",
    ignoreDuplicates: true,
  });

  const questToken = (quest.token ?? "SATS") as TokenSymbol;
  const { data: debited, error: debitError } = questToken === "SATS"
    ? await supabase.rpc("subtract_balance_if_sufficient", { p_discord_id: quest.creator_id, p_amount: payoutSats })
    : await supabase.rpc("subtract_token_balance_if_sufficient", {
      p_discord_id: quest.creator_id, p_token: questToken, p_amount: payoutSats,
    });
  if (debitError) throw debitError;
  if (!debited) {
    await supabase
      .from("quests")
      .update({ status: "exhausted", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", params.questId);
    return {
      ok: false,
      reason: "insufficient_creator_balance",
      insertedCompletion: false,
      completedTaskCount: 1,
      tierRewardSats: rewardSats,
      previousPaidSats: previousPaid,
      rewardDeltaSats: payoutSats,
    };
  }

  const { error: creditError } = questToken === "SATS"
    ? await supabase.rpc("add_balance", { p_discord_id: params.userId, p_amount: payoutSats })
    : await supabase.rpc("add_token_balance", {
      p_discord_id: params.userId, p_token: questToken, p_amount: payoutSats,
    });
  if (creditError) throw creditError;

  const totalPaid = roundSats(previousPaid + payoutSats);
  const { error: eventError } = await supabase
    .from("quest_reward_events")
    .insert({
      quest_id: params.questId,
      user_id: params.userId,
      reward_delta_sats: payoutSats,
      total_paid_sats: totalPaid,
      completed_task_count: 1,
      reason: "repeatable_task",
    });
  if (eventError) throw eventError;

  return {
    ok: true,
    insertedCompletion: false,
    completedTaskCount: 1,
    tierRewardSats: rewardSats,
    previousPaidSats: previousPaid,
    rewardDeltaSats: payoutSats,
    totalPaidSats: totalPaid,
  };
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
    if (config.source === "rotating_list") {
      if (!Array.isArray(config.linkList) || config.linkList.length === 0) {
        return "linkList must contain at least one URL";
      }
      if (!config.linkList.every((url) => typeof url === "string" && /^https?:\/\//i.test(url))) {
        return "linkList entries must be http(s) URLs";
      }
    }
    return null;
  },
  renderRequirement(config) {
    const channelRef = `<#${config.targetChannelId}>`;
    const refreshMinutes = typeof config.refreshMinutes === "number" ? config.refreshMinutes : 60;
    if (config.source === "rotating_list" && Array.isArray(config.linkList) && config.linkList.length > 0) {
      const list = config.linkList as string[];
      const rotationLine = list.length > 1
        ? `Rotates every ${refreshMinutes} min across ${list.length} links`
        : `Refresh every ${refreshMinutes} min`;
      return `Be first to post **the current link** in ${channelRef}\n${rotationLine}`;
    }
    if (config.source === "nearest_event" && typeof config.expectedEventUrl === "string") {
      return `Be first every ${refreshMinutes} min to post ${config.expectedEventUrl} in ${channelRef}`;
    }
    const source = config.source === "latest_tweet" ? "the latest admin feed link" : String(config.source);
    return `Be first every ${refreshMinutes} min to post ${source} in ${channelRef}`;
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
