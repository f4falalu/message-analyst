ALTER TABLE public.ai_providers ADD COLUMN IF NOT EXISTS fallback_models text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.processing_events ADD COLUMN IF NOT EXISTS model text;