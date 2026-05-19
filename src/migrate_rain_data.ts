import { supabase } from "./db.js";

async function runMigration() {
  console.log("🚀 Starting rain stats database migration...");

  // 1. Fetch all existing drop claims with their drop creators and timestamps
  const { data: claims, error: claimsError } = await supabase
    .from("drop_claims")
    .select("amount_sats, claimed_at, drops!inner(creator_id, created_at)");

  if (claimsError) {
    console.error("❌ Failed to fetch drop claims:", claimsError.message);
    process.exit(1);
  }

  if (!claims || claims.length === 0) {
    console.log("ℹ️ No historical drop claims found to migrate.");
    process.exit(0);
  }

  console.log(`📊 Found ${claims.length} drop claims to process.`);

  // 2. Fetch existing rains to prevent duplicate migration if run multiple times
  const { data: existingRains, error: rainsError } = await supabase
    .from("rains")
    .select("sender_id, amount_sats, recipient_count, created_at");

  if (rainsError) {
    console.error("❌ Failed to fetch existing rains:", rainsError.message);
    process.exit(1);
  }

  // Create a unique key for each existing rain to deduplicate
  const existingKeys = new Set(
    (existingRains || []).map(
      (r) => `${r.sender_id}_${r.amount_sats}_${r.recipient_count}_${new Date(r.created_at).getTime()}`
    )
  );

  // 3. Prepare the new rains entries
  const rainsToInsert = claims
    .map((c: any) => {
      const senderId = c.drops.creator_id;
      const amount = c.amount_sats;
      const createdAt = c.claimed_at || c.drops.created_at;
      const createdTime = new Date(createdAt).getTime();

      return {
        sender_id: senderId,
        amount_sats: amount,
        recipient_count: 1,
        created_at: createdAt,
        _key: `${senderId}_${amount}_1_${createdTime}`
      };
    })
    // Filter out rows that are already in the rains table
    .filter((r) => !existingKeys.has(r._key));

  if (rainsToInsert.length === 0) {
    console.log("✨ All historical drop claims are already migrated. Nothing to do.");
    process.exit(0);
  }

  console.log(`📥 Migrating ${rainsToInsert.length} new entries into the 'rains' table...`);

  // 4. Batch insert into 'rains' in chunks of 100
  const chunkSize = 100;
  let insertedCount = 0;

  for (let i = 0; i < rainsToInsert.length; i += chunkSize) {
    const chunk = rainsToInsert.slice(i, i + chunkSize).map(({ _key, ...rest }) => rest);
    const { error: insertError } = await supabase.from("rains").insert(chunk);

    if (insertError) {
      console.error(`❌ Batch insert failed at index ${i}:`, insertError.message);
      process.exit(1);
    }
    insertedCount += chunk.length;
    console.log(`✅ Migrated ${insertedCount}/${rainsToInsert.length} entries...`);
  }

  console.log("🎉 Migration completed successfully!");
}

runMigration().catch((err) => {
  console.error("❌ Unexpected error during migration:", err);
  process.exit(1);
});
