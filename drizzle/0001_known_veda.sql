CREATE TABLE "workflow_stage_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"from_stage" varchar(128) NOT NULL,
	"to_stage" varchar(128) NOT NULL,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_attempts" ADD COLUMN "error_category" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_attempts" ADD COLUMN "backoff_delay_ms" integer;--> statement-breakpoint
ALTER TABLE "workflow_stage_transitions" ADD CONSTRAINT "workflow_stage_transitions_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;