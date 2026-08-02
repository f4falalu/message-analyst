CREATE TABLE public.imports (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploading',
  total_files INTEGER NOT NULL DEFAULT 0,
  chat_parsed BOOLEAN NOT NULL DEFAULT false,
  message_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.contacts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  import_id UUID NOT NULL REFERENCES public.imports(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  display_name TEXT NOT NULL,
  phone TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (import_id, display_name)
);

CREATE TABLE public.messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  import_id UUID NOT NULL REFERENCES public.imports(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  seq INTEGER NOT NULL,
  sent_at TIMESTAMPTZ,
  sender TEXT,
  sender_phone TEXT,
  body TEXT,
  attachment_filename TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (import_id, seq)
);

CREATE TABLE public.attachments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  import_id UUID NOT NULL REFERENCES public.imports(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  message_seq INTEGER,
  ocr_status TEXT NOT NULL DEFAULT 'pending',
  ocr_error TEXT,
  raw_text TEXT,
  extracted JSONB,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (import_id, filename)
);

CREATE TABLE public.request_records (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  import_id UUID NOT NULL REFERENCES public.imports(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  facility_name TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  amount_paid NUMERIC(14,2),
  currency TEXT,
  request_date DATE,
  payment_date DATE,
  requester_name TEXT,
  requester_phone TEXT,
  status TEXT NOT NULL DEFAULT 'requested',
  confidence NUMERIC(3,2),
  needs_review BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.record_sources (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  record_id UUID NOT NULL REFERENCES public.request_records(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  kind TEXT NOT NULL,
  message_id UUID REFERENCES public.messages(id) ON DELETE CASCADE,
  attachment_id UUID REFERENCES public.attachments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_messages_import_seq ON public.messages(import_id, seq);
CREATE INDEX idx_messages_attachment ON public.messages(import_id, attachment_filename);
CREATE INDEX idx_attachments_import_status ON public.attachments(import_id, ocr_status);
CREATE INDEX idx_records_import ON public.request_records(import_id);
CREATE INDEX idx_record_sources_record ON public.record_sources(record_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.imports TO authenticated;
GRANT ALL ON public.imports TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;
GRANT ALL ON public.contacts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.attachments TO authenticated;
GRANT ALL ON public.attachments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.request_records TO authenticated;
GRANT ALL ON public.request_records TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.record_sources TO authenticated;
GRANT ALL ON public.record_sources TO service_role;

ALTER TABLE public.imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.request_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.record_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own imports" ON public.imports FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own contacts" ON public.contacts FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own messages" ON public.messages FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own attachments" ON public.attachments FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own records" ON public.request_records FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own record sources" ON public.record_sources FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER imports_updated_at BEFORE UPDATE ON public.imports FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER records_updated_at BEFORE UPDATE ON public.request_records FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();