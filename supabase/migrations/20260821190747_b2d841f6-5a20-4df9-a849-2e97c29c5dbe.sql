CREATE TABLE IF NOT EXISTS public.extraction_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  size_bytes bigint,
  raw_text text,
  extracted jsonb NOT NULL,
  model text,
  source text NOT NULL DEFAULT 'server',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.extraction_cache TO authenticated;
GRANT SELECT ON public.extraction_cache TO anon;
GRANT ALL ON public.extraction_cache TO service_role;

ALTER TABLE public.extraction_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "extraction cache readable" ON public.extraction_cache FOR SELECT USING (true);
CREATE POLICY "extraction cache writable" ON public.extraction_cache FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS extraction_cache_key_idx ON public.extraction_cache (content_key);