CREATE TABLE "relay_web_push_subscriptions" (
  "id" varchar(64) PRIMARY KEY NOT NULL,
  "user_id" varchar(255) NOT NULL,
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "preferences_json" jsonb NOT NULL,
  "created_at" varchar(64) NOT NULL,
  "updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_web_push_subscriptions_endpoint"
  ON "relay_web_push_subscriptions" USING btree ("endpoint");
--> statement-breakpoint
CREATE INDEX "idx_relay_web_push_subscriptions_user"
  ON "relay_web_push_subscriptions" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "relay_web_push_subscription_states" (
  "subscription_id" varchar(64) NOT NULL,
  "environment_id" varchar(191) NOT NULL,
  "thread_id" varchar(191) NOT NULL,
  "phase" varchar(64) NOT NULL,
  "has_actionable_proposed_plan" boolean DEFAULT false NOT NULL,
  "updated_at" varchar(64) NOT NULL,
  CONSTRAINT "relay_web_push_subscription_states_subscription_id_environment_id_thread_id_pk"
    PRIMARY KEY("subscription_id", "environment_id", "thread_id")
);
--> statement-breakpoint
CREATE INDEX "idx_relay_web_push_subscription_states_subscription"
  ON "relay_web_push_subscription_states" USING btree ("subscription_id");
