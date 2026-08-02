CREATE TABLE public.processing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES public.imports(id) ON DELETE CASCADE,
  user_id uuid,
  kind text NOT NULL DEFAULT 'ocr',
  status text NOT NULL DEFAULT 'running',
  concurrency integer NOT NULL DEFAULT 1,
  chunk_size integer NOT NULL DEFAULT 1,
  total_files integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  notes text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.processing_runs TO anon, authenticated;
GRANT ALL ON public.processing_runs TO service_role;
ALTER TABLE public.processing_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY open_access ON public.processing_runs FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE TABLE public.processing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.processing_runs(id) ON DELETE CASCADE,
  import_id uuid NOT NULL REFERENCES public.imports(id) ON DELETE CASCADE,
  attachment_id uuid REFERENCES public.attachments(id) ON DELETE SET NULL,
  filename text NOT NULL,
  outcome text NOT NULL,
  doc_type text,
  confidence numeric,
  field_confidence jsonb,
  duration_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.processing_events TO anon, authenticated;
GRANT ALL ON public.processing_events TO service_role;
ALTER TABLE public.processing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY open_access ON public.processing_events FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE INDEX processing_events_run_idx ON public.processing_events(run_id, created_at DESC);
CREATE INDEX processing_runs_import_idx ON public.processing_runs(import_id, started_at DESC);