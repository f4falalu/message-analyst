CREATE OR REPLACE FUNCTION public.claim_attachments(_import_id uuid, _limit integer)
RETURNS TABLE (id uuid, filename text, storage_path text, mime_type text, message_seq integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT a.id
    FROM public.attachments a
    WHERE a.import_id = _import_id AND a.ocr_status = 'pending'
    ORDER BY a.filename
    FOR UPDATE SKIP LOCKED
    LIMIT GREATEST(1, LEAST(50, _limit))
  )
  UPDATE public.attachments a
  SET ocr_status = 'processing'
  FROM picked
  WHERE a.id = picked.id
  RETURNING a.id, a.filename, a.storage_path, a.mime_type, a.message_seq;
END;
$$;

GRANT EXECUTE ON FUNCTION public.claim_attachments(uuid, integer) TO anon, authenticated, service_role;