CREATE POLICY "wa archive own files select" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'wa-archive' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "wa archive own files insert" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'wa-archive' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "wa archive own files update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'wa-archive' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "wa archive own files delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'wa-archive' AND (storage.foldername(name))[1] = auth.uid()::text);