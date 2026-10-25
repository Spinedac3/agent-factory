CREATE TABLE "program_versions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "program_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"program_id" integer NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"published_by" integer NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "programs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"code" varchar(60) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_id" integer NOT NULL,
	"draft" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_calls" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "run_calls_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"run_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"step" varchar(40) NOT NULL,
	"tool" varchar(64) NOT NULL,
	"args" jsonb NOT NULL,
	"ok" boolean NOT NULL,
	"error" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" integer NOT NULL,
	"version" integer NOT NULL,
	"owner_id" integer NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"reason" text,
	"text" text,
	"delivery" text,
	"counts" jsonb,
	"steps" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "program_versions" ADD CONSTRAINT "program_versions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_calls" ADD CONSTRAINT "run_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "program_versions_unique" ON "program_versions" USING btree ("program_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "programs_code_unique" ON "programs" USING btree ("code");--> statement-breakpoint
CREATE INDEX "programs_owner_idx" ON "programs" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "run_calls_run_idx" ON "run_calls" USING btree ("run_id","position");--> statement-breakpoint
CREATE INDEX "runs_program_idx" ON "runs" USING btree ("program_id","started_at");