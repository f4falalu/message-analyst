ALTER TABLE public.ai_providers
  ADD COLUMN IF NOT EXISTS run_location text NOT NULL DEFAULT 'server';

ALTER TABLE public.ai_providers
  DROP CONSTRAINT IF EXISTS ai_providers_run_location_check;

ALTER TABLE public.ai_providers
  ADD CONSTRAINT ai_providers_run_location_check
  CHECK (run_location IN ('server', 'browser'));