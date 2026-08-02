CREATE TABLE public.name_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('facility','item')),
  pattern text NOT NULL,
  canonical text NOT NULL,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.name_mappings TO anon, authenticated;
GRANT ALL ON public.name_mappings TO service_role;

ALTER TABLE public.name_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY open_access ON public.name_mappings
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE TRIGGER name_mappings_updated_at
  BEFORE UPDATE ON public.name_mappings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE UNIQUE INDEX name_mappings_kind_pattern_key
  ON public.name_mappings (kind, lower(pattern));

ALTER TABLE public.request_records
  ADD COLUMN IF NOT EXISTS issues jsonb NOT NULL DEFAULT '[]'::jsonb;

DELETE FROM public.messages m
USING public.messages keep
WHERE m.import_id = keep.import_id
  AND m.seq = keep.seq
  AND m.ctid > keep.ctid;

DELETE FROM public.attachments a
USING public.attachments keep
WHERE a.import_id = keep.import_id
  AND a.filename = keep.filename
  AND a.ctid > keep.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS messages_import_seq_key
  ON public.messages (import_id, seq);

CREATE UNIQUE INDEX IF NOT EXISTS attachments_import_filename_key
  ON public.attachments (import_id, filename);