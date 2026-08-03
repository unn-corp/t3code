ALTER TABLE "relay_web_push_subscriptions"
  ADD COLUMN "environment_id" varchar(191),
  ADD COLUMN "installation_id" varchar(128),
  ADD COLUMN "installation_secret_hash" text;
--> statement-breakpoint
CREATE INDEX "idx_relay_web_push_subscriptions_environment"
  ON "relay_web_push_subscriptions" USING btree ("environment_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_web_push_subscriptions_installation"
  ON "relay_web_push_subscriptions" USING btree ("installation_id");
