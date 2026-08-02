-- Internal tool: no login. Open access for anon + authenticated.
DO $$
DECLARE t text; p record;
BEGIN
  FOREACH t IN ARRAY ARRAY['imports','contacts','messages','attachments','request_records','record_sources'] LOOP
    FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename=t LOOP
      EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, t);
    END LOOP;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "open_access" ON public.%I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;
END $$;

ALTER TABLE public.imports ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.contacts ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.messages ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.attachments ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.request_records ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.record_sources ALTER COLUMN user_id DROP NOT NULL;

DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname LIKE '%wa-archive%' LOOP
    EXECUTE format('DROP POLICY %I ON storage.objects', p.policyname);
  END LOOP;
END $$;

CREATE POLICY "wa-archive open access" ON storage.objects
  FOR ALL TO anon, authenticated
  USING (bucket_id = 'wa-archive') WITH CHECK (bucket_id = 'wa-archive');